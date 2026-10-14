/**
 * C 阶段摄取链路的集成验收：对齐《Codex Hooks 自动记忆接入指南》§8 的测试矩阵中
 * 可离线覆盖的六项——
 * ① 首轮 Hook 并发；② 连续多轮同一事实不重复堆积；③ 重复触发 Stop 只摄取一次；
 * ④ 进程被强杀后 pending 可恢复；⑤ 上下文压缩（compact）后关键记忆重新注入；
 * ⑥ 敏感内容不进记忆库、不进诊断日志。
 * 另含内容指纹与召回复述剔除的纯函数用例。
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HookInput } from '../codex/src/hook-events.ts'
import { runHook } from '../codex/src/hooks.ts'
import { contentFingerprint, filterRecalledRestatements, recordTurnInput } from '../codex/src/ingest-queue.ts'
import { openCodexRuntime } from '../codex/src/runtime.ts'
import type { CodexRuntime } from '../codex/src/runtime.ts'

const runtimes: CodexRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async runtime => runtime.close()))
})

/** 造一个仓库目录（带 origin，项目库按 origin 哈希命名）。 */
async function makeRepo(origin: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-ingest-repo-'))
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${origin}\n`)
  return dir
}

async function setup(): Promise<{
  readonly runtime: CodexRuntime
  readonly run: (input: HookInput) => ReturnType<typeof runHook>
}> {
  const runtime = await openCodexRuntime({ dbDir: await mkdtemp(join(tmpdir(), 'codex-ingest-')), embedding: 'off' })
  runtimes.push(runtime)
  return {
    runtime,
    run: input => runHook(input.event, input, { runtime: async () => runtime }),
  }
}

/** 构造事件输入（只填测试关心的字段）。 */
function event(kind: HookInput['event'], fields: Partial<HookInput> = {}): HookInput {
  return {
    event: kind,
    sessionId: 'sess-1',
    turnId: null,
    cwd: null,
    prompt: null,
    lastAssistantMessage: null,
    source: null,
    stopHookActive: false,
    ...fields,
  }
}

/** 解析注入输出里的 additionalContext。 */
function contextOf(stdout: string): string {
  return (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } })
    .hookSpecificOutput?.additionalContext ?? ''
}

/** 列出某项目库里的全部正文。 */
async function contentsOf(runtime: CodexRuntime, repo: string): Promise<readonly string[]> {
  return (await runtime.list({ scope: 'project', projectRoot: repo })).records.map(record => record.content)
}

describe('内容指纹与召回复述剔除（纯函数）', () => {
  it('排版差异归一为同一指纹，语义不同的文本指纹不同', () => {
    expect(contentFingerprint('本项目用 pnpm 管理依赖。')).toBe(contentFingerprint('本项目用 pnpm  管理依赖'))
    expect(contentFingerprint('本项目用 pnpm 管理依赖')).toBe(contentFingerprint('本项目用PNPM管理依赖'))
    expect(contentFingerprint('本项目用 pnpm 管理依赖')).not.toBe(contentFingerprint('本项目用 npm 管理依赖'))
  })

  it('剔除召回复述，但不误伤用户显式要求记住的候选', () => {
    const injected = [contentFingerprint('既有记忆：本项目用 pnpm')]
    const candidates = [
      { content: '既有记忆：本项目用 pnpm。', kind: 'fact' as const, explicit: false },
      { content: '既有记忆：本项目用 pnpm', kind: 'fact' as const, explicit: true },
      { content: '一条全新的事实', kind: 'fact' as const, explicit: false },
    ]
    const { kept, excluded } = filterRecalledRestatements(candidates, injected)
    expect(excluded).toBe(1)
    expect(kept).toHaveLength(2)
    expect(kept.every(candidate => candidate.content !== '既有记忆：本项目用 pnpm。')).toBe(true)
  })
})

describe('① 首轮 Hook 并发', () => {
  it('SessionStart 与多个 UserPromptSubmit 并发触发：不重复初始化、不重复写入', async () => {
    const repo = await makeRepo('git@github.com:acme/alpha.git')
    const { run, runtime } = await setup()
    const submit = event('UserPromptSubmit', {
      cwd: repo, sessionId: 's1', turnId: 't1', prompt: '记住：并发首轮也只应写入一条',
    })

    const outcomes = await Promise.all([
      run(event('SessionStart', { cwd: repo, sessionId: 's1', source: 'startup' })),
      run(submit),
      run(submit),
      run(submit),
    ])

    // 输出始终合法：要么空，要么是合法 JSON
    for (const outcome of outcomes) {
      expect(outcome.stdout === '' || typeof JSON.parse(outcome.stdout) === 'object').toBe(true)
    }
    expect(await contentsOf(runtime, repo)).toHaveLength(1)
    expect((await contentsOf(runtime, repo))[0]).toContain('并发首轮也只应写入一条')
  })
})

describe('② 连续多轮对话', () => {
  it('同一事实在不同轮次重复出现时只入库一条（内容级去重）', async () => {
    const repo = await makeRepo('git@github.com:acme/alpha.git')
    const { run, runtime } = await setup()

    await run(event('UserPromptSubmit', { cwd: repo, sessionId: 's1', turnId: 't1', prompt: '记住：本项目用 pnpm 管理依赖' }))
    const second = await run(event('UserPromptSubmit', { cwd: repo, sessionId: 's1', turnId: 't2', prompt: '记住：本项目用 pnpm 管理依赖。' }))
    const third = await run(event('UserPromptSubmit', { cwd: repo, sessionId: 's1', turnId: 't3', prompt: '记住：本项目用 pnpm 管理依赖' }))

    expect(await contentsOf(runtime, repo)).toHaveLength(1)
    expect(second.notes.join(' ')).toContain('跳过重复内容')
    expect(third.notes.join(' ')).toContain('跳过重复内容')
  })
})

describe('③ 重复触发 Stop', () => {
  it('同一回合重复触发 Stop 只摄取一次', async () => {
    const repo = await makeRepo('git@github.com:acme/alpha.git')
    const { run, runtime } = await setup()
    const store = await runtime.openScope('project', repo)
    // 模拟 UserPromptSubmit 只留下暂存、尚未处理（处理器尚未跑）
    await recordTurnInput(store, { sessionId: 's1', turnId: 't1', cwd: repo, at: 1, prompt: '记住：只应摄取一次的事实', injected: [] })

    const first = await run(event('Stop', { cwd: repo, sessionId: 's1', turnId: 't1', lastAssistantMessage: '好的' }))
    const second = await run(event('Stop', { cwd: repo, sessionId: 's1', turnId: 't1', lastAssistantMessage: '好的' }))

    expect(first.stdout).toBe('{}')
    expect(second.stdout).toBe('{}')
    expect(await contentsOf(runtime, repo)).toHaveLength(1)
  })
})

describe('④ 强行终止进程后的恢复', () => {
  it('上一会话遗留的未完成摄取任务会被下一次 UserPromptSubmit 排空', async () => {
    const repo = await makeRepo('git@github.com:acme/alpha.git')
    const { run, runtime } = await setup()
    const store = await runtime.openScope('project', repo)
    // 模拟上一会话在 Stop 之前被强杀：暂存已落库，但没有 done 标记
    await recordTurnInput(store, {
      sessionId: 'dead-session', turnId: 't9', cwd: repo, at: 1, prompt: '记住：崩溃前留下的项目约定', injected: [],
    })
    expect(await contentsOf(runtime, repo)).toHaveLength(0)

    const outcome = await run(event('UserPromptSubmit', { cwd: repo, sessionId: 'new-session', turnId: 't1', prompt: '随便问一句' }))
    expect(outcome.notes.join(' ')).toContain('排空历史遗留摄取任务')
    expect(await contentsOf(runtime, repo)).toEqual(['崩溃前留下的项目约定'])
  })
})

describe('⑤ 上下文压缩与恢复', () => {
  it('source=compact 后关键记忆仍会重新注入（不永久标记「已注入」）', async () => {
    const repo = await makeRepo('git@github.com:acme/alpha.git')
    const { run, runtime } = await setup()
    await runtime.save({ content: '本项目提交前必须先跑 pnpm typecheck', kind: 'decision', scope: 'project', projectRoot: repo })

    const compact = await run(event('SessionStart', { cwd: repo, source: 'compact' }))
    expect(contextOf(compact.stdout)).toContain('pnpm typecheck')
    expect(contextOf(compact.stdout)).toContain('上下文已压缩')
    expect(compact.notes.join(' ')).toContain('source=compact')

    // 之后的普通会话依然注入（没有「本会话已注入过」的永久短路）
    const again = await run(event('SessionStart', { cwd: repo, source: 'startup' }))
    expect(contextOf(again.stdout)).toContain('pnpm typecheck')
  })
})

describe('⑥ 敏感内容', () => {
  it('密钥与口令不入记忆库、不入诊断日志', async () => {
    const repo = await makeRepo('git@github.com:acme/alpha.git')
    const { run, runtime } = await setup()
    const apiKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
    const outcome = await run(event('UserPromptSubmit', {
      cwd: repo, sessionId: 's1', turnId: 't1',
      prompt: `记住：部署用的密钥是 ${apiKey}，密码是 hunter2pass`,
    }))

    const stored = (await contentsOf(runtime, repo)).join('\n')
    expect(stored).not.toContain(apiKey)
    expect(stored).toContain('[REDACTED:api-key]')
    // 诊断日志同样不得回显原文
    expect(outcome.notes.join(' ')).not.toContain(apiKey)
    expect(outcome.notes.join(' ')).not.toContain('hunter2pass')
  })
})
