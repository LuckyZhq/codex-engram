#!/usr/bin/env node
/**
 * Hooks 性能基准：按 Codex 的方式（真实子进程 + stdin JSON + stdout 读取）测量
 * 三个事件的**端到端**耗时，并扣除 Node 进程启动基线后给出**净耗时**。
 *
 * 为什么拆两栏：每个 hook 事件都是一次全新的 `node runner.mjs` 进程，本机 Node 冷启动基线
 * 约 270ms——这是宿主调用方式决定的固定开销，不是插件的成本。接入指南 §6 的
 * 「SessionStart ≤500ms / UserPromptSubmit ≤500ms / Stop ≤200ms」衡量的是**插件自身工作量**，
 * 因此预算判在净耗时上；总耗时同时打印，供判断真实体感。
 *
 * 分两档测量：冷启动（空库）与有规模（预置 N 条记忆 + 项目库）。
 *
 * 用法：
 *   node codex/scripts/bench-hooks.mjs [--iterations=20] [--seed=200] [--data-dir=<目录>]
 * 退出码：净耗时全部达标 0，否则 1（阈值可用 --budget-session/--budget-prompt/--budget-stop 覆盖）。
 *
 * 不依赖 Codex、不联网、不动真实数据（数据目录默认临时目录）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RUNNER = join(PLUGIN_ROOT, 'hooks', 'runner.mjs')
const DIST = join(PLUGIN_ROOT, 'dist', 'hooks.js')
const SEED = join(PLUGIN_ROOT, 'scripts', 'seed-engram.mjs')

const args = process.argv.slice(2)
const numberArg = (name, fallback) => {
  const hit = args.find(arg => arg.startsWith(`--${name}=`))
  return hit === undefined ? fallback : Number(hit.slice(name.length + 3))
}
const iterations = numberArg('iterations', 20)
const seedCount = numberArg('seed', 200)
const budget = {
  SessionStart: numberArg('budget-session', 500),
  UserPromptSubmit: numberArg('budget-prompt', 500),
  Stop: numberArg('budget-stop', 200),
}

/** 造一个临时 git 仓库（项目库按 origin 哈希分库）。 */
async function makeRepo(origin) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-bench-repo-'))
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${origin}\n`)
  return dir
}

/** 跑一次钩子子进程，返回耗时与输出。 */
function invoke(argv, event, payload, env) {
  return new Promise(resolvePromise => {
    const started = performance.now()
    const child = spawn(process.execPath, [...argv, event], {
      env: { ...process.env, ENGRAM_EMBEDDING: 'off', ENGRAM_INGEST: 'explicit', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('exit', code => resolvePromise({ code, ms: performance.now() - started, stdout, stderr }))
    child.stdin.end(JSON.stringify({ hook_event_name: event, ...payload }))
  })
}

/** 分位数（线性插值）。 */
function percentile(sorted, q) {
  if (sorted.length === 0) return 0
  const position = (sorted.length - 1) * q
  const low = Math.floor(position)
  const high = Math.ceil(position)
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

/** 预置规模数据。 */
function seed(dataDir, repo) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, ['--experimental-strip-types', SEED, dataDir, String(seedCount), repo], { stdio: 'inherit' })
    child.on('exit', code => resolvePromise(code))
  })
}

/** 测量 Node 进程启动基线（空脚本），用于把「宿主固定开销」从插件耗时里剔除。 */
async function measureBaseline(times = 8) {
  const samples = []
  for (let i = 0; i < times; i++) {
    const started = performance.now()
    await new Promise(resolvePromise => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
      child.on('exit', () => resolvePromise())
    })
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return percentile(samples, 0.5)
}

/** 测量一轮：每个事件 iterations 次，返回净耗时超预算的项。 */
async function measure(label, dataDir, repo, baselineMs) {
  const env = { CODEX_ENGRAM_DIR: dataDir }
  const events = {
    SessionStart: { session_id: 'bench', cwd: repo, source: 'startup' },
    UserPromptSubmit: { session_id: 'bench', turn_id: 't-bench', cwd: repo, prompt: '提交前要跑什么检查？' },
    Stop: { session_id: 'bench', turn_id: 't-bench', cwd: repo, last_assistant_message: '先跑 pnpm typecheck。' },
  }
  console.log(`\n▶ ${label}（每事件 ${iterations} 次，数据目录 ${dataDir}）`)
  const failures = []
  for (const [event, payload] of Object.entries(events)) {
    const samples = []
    for (let i = 0; i < iterations; i++) {
      // 每轮换一个 turn_id，避免命中幂等短路而测不到真实工作量。
      const run = await invoke([RUNNER], event, { ...payload, turn_id: `${payload.turn_id ?? 't'}-${i}` }, env)
      if (run.code !== 0) failures.push(`${event} 退出码 ${run.code}`)
      samples.push(run.ms)
    }
    samples.sort((a, b) => a - b)
    const p50 = percentile(samples, 0.5)
    const p95 = percentile(samples, 0.95)
    const netP50 = Math.max(0, p50 - baselineMs)
    const netP95 = Math.max(0, p95 - baselineMs)
    const limit = budget[event]
    const ok = netP95 <= limit
    console.log(`   ${ok ? '✓' : '✗'} ${event.padEnd(17)} 净 p50=${netP50.toFixed(0)}ms 净 p95=${netP95.toFixed(0)}ms（预算 p95≤${limit}ms）｜总 p50=${p50.toFixed(0)}ms 总 p95=${p95.toFixed(0)}ms`)
    if (!ok) failures.push(`${event} 净 p95=${netP95.toFixed(0)}ms 超出预算 ${limit}ms`)
  }
  return failures
}

if (!existsSync(DIST)) {
  console.error(`缺少构建产物 ${DIST}；请先执行 pnpm bundle:codex（基准测的就是真实链路）`)
  process.exit(2)
}

const givenDataDir = args.find(arg => arg.startsWith('--data-dir='))?.slice('--data-dir='.length)
console.log('codex-engram Hooks 性能基准')
console.log(`  入口    : ${RUNNER}`)
console.log(`  迭代次数: ${iterations}／事件`)

const failures = []

// 基线：Node 进程启动开销（宿主固定成本，不是插件工作量）
const baselineMs = await measureBaseline()
console.log(`  Node 启动基线: p50=${baselineMs.toFixed(0)}ms（已从下表净耗时中扣除）`)

// 档一：冷启动（全新空库）
const coldRepo = await makeRepo('git@github.com:bench/cold.git')
const coldDir = givenDataDir === undefined ? mkdtempSync(join(tmpdir(), 'engram-bench-cold-')) : resolve(givenDataDir)
failures.push(...await measure('档一 · 冷启动（空库）', coldDir, coldRepo, baselineMs))

// 档二：有规模（预置记忆 + 项目库）
const warmRepo = await makeRepo('git@github.com:bench/warm.git')
const warmDir = mkdtempSync(join(tmpdir(), 'engram-bench-warm-'))
console.log(`\n▶ 预置规模数据：${seedCount} 条记忆／库`)
const seedCode = await seed(warmDir, warmRepo)
if (seedCode !== 0) failures.push(`预置数据失败（退出码 ${seedCode}）`)
failures.push(...await measure(`档二 · 有规模（每库 ${seedCount} 条）`, warmDir, warmRepo, baselineMs))

console.log(`\n${failures.length === 0 ? '净耗时全部达标 ✅' : `未达标 ${String(failures.length)} 项 ❌`}`)
for (const item of failures) console.log(`  - ${item}`)
process.exit(failures.length === 0 ? 0 : 1)
