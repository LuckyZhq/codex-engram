import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openCodexRuntime } from '../codex/src/runtime.ts'
import type { CodexRuntime } from '../codex/src/runtime.ts'
import { dshDbDir, isInsideDir, resolveCodexDbDir } from '../codex/src/paths.ts'
import { asMemoryId } from '../src/types.ts'

/** 全部测试用 embedding='off'：不下载模型、检索走纯关键词道（决定论、无需网络）。 */
const runtimes: CodexRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async runtime => runtime.close()))
})

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codex-engram-'))
}

async function openIn(dir: string, options: { cwd?: string } = {}): Promise<CodexRuntime> {
  const runtime = await openCodexRuntime({
    dbDir: dir,
    embedding: 'off',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  })
  runtimes.push(runtime)
  return runtime
}

/** 造一个带 origin 的普通仓库目录（项目库命名走 git origin 归一化哈希）。 */
async function makeRepo(originUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-engram-repo-'))
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "origin"]',
    `\turl = ${originUrl}`,
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  ].join('\n'))
  return dir
}

describe('CodexRuntime — 数据目录', () => {
  it('默认目录落在 Codex 侧，与 ~/.dsh/engram 不重叠', () => {
    const home = join(tmpdir(), 'codex-home-probe')
    expect(resolveCodexDbDir({}, home)).toBe(join(home, '.codex', 'engram'))
    expect(resolveCodexDbDir({ CODEX_HOME: join(home, 'codex-home') }, home)).toBe(join(home, 'codex-home', 'engram'))
    expect(resolveCodexDbDir({ CODEX_ENGRAM_DIR: '~/engram-alt' }, home)).toBe(join(home, 'engram-alt'))
    expect(isInsideDir(dshDbDir(home), resolveCodexDbDir({}, home))).toBe(false)
    expect(isInsideDir(dshDbDir(home), join(dshDbDir(home), 'user.db'))).toBe(true)
  })

  it('拒绝把 dbDir 指向 DSH 记忆目录（默认 hard fail，不写任何文件）', async () => {
    const probe = join(dshDbDir(), 'codex-probe-should-not-exist')
    await expect(openCodexRuntime({ dbDir: probe, embedding: 'off' })).rejects.toThrow(/拒绝使用 DSH 记忆目录/)
    expect(existsSync(probe)).toBe(false)
  })
})

describe('CodexRuntime — 保存与检索', () => {
  it('save 后可按关键词检索并按 id 读取（默认落 project 库）', async () => {
    const dir = await tempDir()
    const runtime = await openIn(dir)
    const saved = await runtime.save({ content: '本项目使用 pnpm 管理依赖', kind: 'decision' })
    expect(saved.disposition).toBe('accept')
    expect(saved.record.status).toBe('active')
    expect(saved.record.scope).toBe('project')
    expect(saved.record.sourceSessionId).toBeNull()

    const found = await runtime.search({ query: 'pnpm' })
    expect(found.degraded).toBe(true) // embedding='off'：只有关键词道参与
    expect(found.hits.map(hit => String(hit.record.id))).toContain(String(saved.record.id))

    const fetched = await runtime.get(saved.record.id) // 不给 scope：自动定位
    expect(fetched?.content).toBe('本项目使用 pnpm 管理依赖')
    expect(await runtime.get('00000000-0000-0000-0000-000000000000')).toBeUndefined()
  })

  it('入库前脱敏；清洗后为空则拒绝', async () => {
    const dir = await tempDir()
    const runtime = await openIn(dir)
    const saved = await runtime.save({ content: 'API 密钥 sk-abcdefghijklmnopqrstuvwx 已失效', kind: 'fact' })
    expect(saved.record.content).toContain('[REDACTED:api-key]')
    await expect(runtime.save({ content: '   ', kind: 'fact' })).rejects.toThrow(/清洗后内容为空/)
  })

  it('user 与 project 分属两个库；查询不给未使用的作用域建空库', async () => {
    const dir = await tempDir()
    const runtime = await openIn(dir)
    await runtime.save({ content: '用户偏好简体中文回复', kind: 'preference', scope: 'user' })
    expect((await runtime.list({ scope: 'user' })).total).toBe(1)
    expect((await runtime.list({ scope: 'project' })).total).toBe(0)
    expect(existsSync(join(dir, runtime.projectDbName))).toBe(false)
    expect(runtime.projectDbName).not.toBe('user.db')

    await runtime.save({ content: '项目约定：提交前跑 typecheck', kind: 'fact', scope: 'project' })
    expect(existsSync(join(dir, runtime.projectDbName))).toBe(true)
    // 默认检索跨两库合并
    expect((await runtime.search({ query: '简体中文' })).hits).toHaveLength(1)
    expect((await runtime.search({ query: 'typecheck' })).hits).toHaveLength(1)
    expect((await runtime.search({ query: 'typecheck', scopes: ['user'] })).hits).toHaveLength(0)
  })

  it('修正走取代链：旧条目归档，新条目生效', async () => {
    const dir = await tempDir()
    const runtime = await openIn(dir)
    const old = await runtime.save({ content: '部署端口是 3000', kind: 'fact' })
    const updated = await runtime.update({ id: old.record.id, content: '部署端口是 4000', kind: 'fact' })
    expect(updated.content).toBe('部署端口是 4000')
    expect(String(updated.id)).not.toBe(String(old.record.id))
    expect((await runtime.get(old.record.id, { scope: 'project' }))?.status).toBe('archived')

    const store = await runtime.openScope('project')
    const view = await store.review(asMemoryId(old.record.id))
    expect(view?.supersededBy.map(String)).toContain(String(updated.id))

    const hits = await runtime.search({ query: '部署端口' })
    expect(hits.hits.every(hit => hit.record.status === 'active')).toBe(true)
    expect(hits.hits.map(hit => String(hit.record.id))).toContain(String(updated.id))
  })
})

describe('CodexRuntime — 软删除与恢复', () => {
  it('forget 软删后不再被检索命中，restore 复原', async () => {
    const dir = await tempDir()
    const runtime = await openIn(dir)
    const saved = await runtime.save({ content: '临时记忆：评审会改到周五下午', kind: 'episode' })
    const forgotten = await runtime.forget(saved.record.id)
    expect(forgotten.status).toBe('forgotten')
    expect((await runtime.get(saved.record.id))?.status).toBe('forgotten')
    expect((await runtime.search({ query: '评审会改到周五' })).hits).toHaveLength(0)
    // 管理列表仍可看到（含全部状态）
    expect((await runtime.list({ scope: 'project', status: 'forgotten' })).total).toBe(1)

    const restored = await runtime.restore(saved.record.id)
    expect(restored.status).toBe('active')
    expect((await runtime.search({ query: '评审会改到周五' })).hits.map(hit => String(hit.record.id)))
      .toContain(String(saved.record.id))
  })

  it('带墓志铭的闭馆写入审计；三问缺项 loud 失败', async () => {
    const dir = await tempDir()
    const runtime = await openIn(dir)
    const saved = await runtime.save({ content: '旧约定：用 yarn 安装依赖', kind: 'decision' })
    await expect(runtime.forget(saved.record.id, {
      tombstone: { reason: '', affects: '依赖安装流程', stillUseful: '历史决策可考古' },
    })).rejects.toThrow(/闭馆三问/)

    await runtime.forget(saved.record.id, {
      tombstone: { reason: '已被 pnpm 取代', affects: '依赖安装流程', stillUseful: '历史决策可考古' },
    })
    const store = await runtime.openScope('project')
    const tombs = await store.listForgottenWithTombs(10)
    expect(tombs).toHaveLength(1)
    expect(tombs[0]?.tombstone?.reason).toBe('已被 pnpm 取代')
  })

  it('forget/update/restore 对不存在的 id loud 失败', async () => {
    const dir = await tempDir()
    const runtime = await openIn(dir)
    await expect(runtime.forget('11111111-1111-1111-1111-111111111111')).rejects.toThrow(/不存在于可访问的 Codex 记忆库/)
    await expect(runtime.update({ id: '11111111-1111-1111-1111-111111111111', content: 'x', kind: 'fact' }))
      .rejects.toThrow(/不存在于可访问的 Codex 记忆库/)
  })
})

describe('CodexRuntime — 持久化与项目隔离', () => {
  it('关闭后重开（模拟进程重启）数据仍在', async () => {
    const dir = await tempDir()
    const first = await openIn(dir)
    const saved = await first.save({ content: '重启后仍应可召回的记忆', kind: 'fact', importance: 0.9 })
    await first.close()

    const second = await openIn(dir)
    const fetched = await second.get(saved.record.id)
    expect(fetched?.content).toBe('重启后仍应可召回的记忆')
    expect(fetched?.importance).toBeCloseTo(0.9, 5)
    const stats = await second.stats()
    expect(stats.parts).toHaveLength(1)
    expect(stats.parts[0]?.scope).toBe('project')
    expect(stats.parts[0]?.stats.active).toBe(1)
  })

  it('项目库按 git origin 归一化哈希命名：同仓库共享、跨仓库隔离', async () => {
    const dir = await tempDir()
    const repoA = await makeRepo('git@github.com:acme/alpha.git')
    const repoB = await makeRepo('https://github.com/acme/beta.git')

    const a1 = await openIn(dir, { cwd: repoA })
    expect(a1.identity.source).toBe('origin')
    await a1.save({ content: 'alpha 仓库的构建脚本在 scripts/build.sh', kind: 'fact', scope: 'project' })
    await a1.close()

    // 同一 origin 的不同写法 → 同一个库（归一化等价类）
    const a2 = await openIn(dir, { cwd: await makeRepo('https://github.com/acme/alpha') })
    expect(a2.projectDbName).toBe(a1.projectDbName)
    expect((await a2.list({ scope: 'project' })).total).toBe(1)
    expect((await a2.search({ query: '构建脚本' })).hits).toHaveLength(1)

    const b = await openIn(dir, { cwd: repoB })
    expect(b.projectDbName).not.toBe(a1.projectDbName)
    expect((await b.list({ scope: 'project' })).total).toBe(0)
    expect((await b.search({ query: '构建脚本' })).hits).toHaveLength(0)
  })
})
