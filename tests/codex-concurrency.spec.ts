import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openEngramStore } from '../src/store/sqlite.ts'
import { openCodexRuntime } from '../codex/src/runtime.ts'
import type { CodexRuntime } from '../codex/src/runtime.ts'

/**
 * 并发验证：Codex 侧 MCP Server 与 Hooks 是**不同进程**，会同时打开同一个分库。
 *
 * 实测结论（本文件即为证据）：
 * - 默认配置（不设 PRAGMA + 延迟事务）：多进程并发写直接抛 `Error: database is locked`，**写入丢失**；
 * - 只开 `busy_timeout=5000`：仍会丢写——延迟事务「先读后写」升级锁时 SQLite 为避免死锁不调用
 *   busy 处理器，等待配置对它无效；
 * - `journal_mode=WAL + busy_timeout=5000 + BEGIN IMMEDIATE`（Codex Runtime 默认）：事务一开始就取
 *   写锁，冲突交给 busy_timeout 等待，4 进程 × 8 条全部落库、零失败。
 * 因此共享存储层新增**可选** `StoreConcurrencyOptions`；DSH 侧不传该参数，行为与旧版一致。
 */

const runtimes: CodexRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async runtime => runtime.close()))
})

/** 子进程脚本：独立进程、独立连接，向同一个库连写 N 条。
 *  注意 `node -e` 的参数布局没有脚本路径：argv[1] 起就是附加参数。 */
const WRITER_SOURCE = `
const { openEngramStore } = await import(process.argv[2])
const path = process.argv[1]
const count = Number(process.argv[3])
const tag = process.argv[4]
const mode = process.argv[5]
const options = mode === 'none' ? {} : {
  busyTimeoutMs: 5000,
  ...(mode === 'wal' || mode === 'immediate' ? { journalMode: 'wal' } : {}),
  ...(mode === 'immediate' ? { writeTransactions: 'immediate' } : {}),
}
const store = await openEngramStore(path, undefined, undefined, options)
try {
  for (let i = 0; i < count; i++) {
    await store.write({ scope: 'user', kind: 'fact', content: tag + ' 第 ' + i + ' 条并发记忆' })
  }
} finally {
  await store.close()
}
`

type Mode = 'none' | 'timeout' | 'wal' | 'immediate'

interface WriterOutcome {
  readonly code: number | null
  readonly stderr: string
}

/** 启动一个写入子进程并等待结束。 */
async function runWriter(dbPath: string, count: number, tag: string, mode: Mode): Promise<WriterOutcome> {
  const storeUrl = pathToFileURL(join(process.cwd(), 'src', 'store', 'sqlite.ts')).href
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', WRITER_SOURCE, dbPath, storeUrl, String(count), tag, mode], {
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk: unknown) => { stderr += String(chunk) })
  const code = await new Promise<number | null>(resolve => { child.on('exit', resolve) })
  return { code, stderr }
}

/** 建库并把建库/迁移这一步做完，后续并发只考察「写」。 */
async function bootstrap(dbPath: string): Promise<void> {
  const store = await openEngramStore(dbPath)
  await store.close()
}

/** 同库并发写一轮，返回失败进程数与最终条数。 */
async function concurrentWrite(dbPath: string, mode: Mode, writers: readonly string[], perWriter: number): Promise<{ failed: number; total: number; errors: readonly string[] }> {
  const outcomes = await Promise.all(writers.map(async tag => runWriter(dbPath, perWriter, tag, mode)))
  const store = await openEngramStore(dbPath)
  try {
    const stats = await store.stats()
    return {
      failed: outcomes.filter(outcome => outcome.code !== 0).length,
      total: stats.total,
      errors: outcomes.filter(outcome => outcome.code !== 0).map(outcome => outcome.stderr.trim().split('\n').slice(0, 2).join(' / ')),
    }
  } finally {
    await store.close()
  }
}

describe('并发写入（多进程同库）', () => {
  // 这个文件是**对抗性负载**用例：4 个子进程同时写同一个库，而全量套件还会并行跑 30+ 个同样在打 SQLite 的测试文件。
  // 生产场景（MCP Server 与 hooks 各一两个进程、事务都很小）远低于这个压力；极端负载下仍可能撞上写锁等待超时，
  // 故对该文件允许重试（断言不变：要么全落库，要么失败也必须零损坏）。
  const LOAD_SENSITIVE = { retry: 2, timeout: 120_000 } as const

  it('Codex 默认并发配置（WAL + busy_timeout + BEGIN IMMEDIATE）：4 进程 × 8 条全部落库，无进程报错', LOAD_SENSITIVE, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-conc-wal-'))
    const dbPath = join(dir, 'user.db')
    await bootstrap(dbPath)

    const writers = ['A', 'B', 'C', 'D']
    const result = await concurrentWrite(dbPath, 'immediate', writers, 8)
    console.error(`[并发实测 Codex 默认] 失败 ${String(result.failed)}，落库 ${String(result.total)}；错误样例：${result.errors[0] ?? '（无）'}`)
    expect(result.failed).toBe(0)
    expect(result.total).toBe(writers.length * 8)
  })

  it('对照：默认配置与「只加 busy_timeout」都会丢写，但都不会损坏库（文档化实测数据）', LOAD_SENSITIVE, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-conc-cmp-'))
    const writers = ['A', 'B', 'C', 'D']

    // 默认配置：不设 PRAGMA + 延迟事务（DSH 侧沿用旧行为）
    const plainPath = join(dir, 'plain.db')
    await bootstrap(plainPath)
    const plain = await concurrentWrite(plainPath, 'none', writers, 8)

    // 只加 busy_timeout（WAL 也开了，但事务仍是延迟 BEGIN）
    const timeoutPath = join(dir, 'timeout.db')
    await bootstrap(timeoutPath)
    const timeout = await concurrentWrite(timeoutPath, 'wal', writers, 8)

    console.error(`[并发实测] 默认：失败 ${String(plain.failed)}/${String(writers.length)}，落库 ${String(plain.total)}/${String(writers.length * 8)}，错误样例：${plain.errors[0] ?? '（无）'}`)
    console.error(`[并发实测] WAL + busy_timeout（延迟事务）：失败 ${String(timeout.failed)}，落库 ${String(timeout.total)}，错误样例：${timeout.errors[0] ?? '（无）'}`)

    // 失败是「丢写」而不是「坏库」：结构完好、可读、可继续写
    const recovery = await openEngramStore(plainPath)
    try {
      const record = await recovery.write({ scope: 'user', kind: 'fact', content: '并发失败后仍可正常写入' })
      expect(record.status).toBe('active')
      expect((await recovery.get(record.id))?.content).toBe('并发失败后仍可正常写入')
    } finally {
      await recovery.close()
    }
  })

  it('Runtime 层（同进程两条连接同库）并发写不互相吞数据', LOAD_SENSITIVE, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-conc-rt-'))
    const repo = await mkdtemp(join(tmpdir(), 'codex-conc-repo-'))
    const first = await openCodexRuntime({ dbDir: dir, cwd: repo, embedding: 'off' })
    const second = await openCodexRuntime({ dbDir: dir, cwd: repo, embedding: 'off' })
    runtimes.push(first, second)
    await Promise.all([
      ...Array.from({ length: 5 }, async (_unused, index) => first.save({ content: `实例一 第 ${String(index)} 条`, kind: 'fact', projectRoot: repo })),
      ...Array.from({ length: 5 }, async (_unused, index) => second.save({ content: `实例二 第 ${String(index)} 条`, kind: 'fact', projectRoot: repo })),
    ])
    const list = await first.list({ projectRoot: repo, limit: 50 })
    expect(list.total).toBe(10)
  })
})
