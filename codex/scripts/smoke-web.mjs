#!/usr/bin/env node
/**
 * WebAPI 冒烟测试：以**真实子进程**启动 `node codex/dist/web.js`（未构建则走源码），
 * 用 HTTP 走完「认证 → 项目定位 → 数据闭环 → 边界拒绝」全链路。
 *
 * 覆盖：
 *   ① 未认证请求 401（API 与静态资源都不放行）
 *   ② 令牌交换：错误令牌 403；正确令牌 302 + HttpOnly/SameSite=Strict Cookie
 *   ③ Cookie / Bearer 双通道认证
 *   ④ 空库 workspaces 合法空结构
 *   ⑤ Hooks（另一个真实进程）写入 → WebAPI 读取（跨入口数据闭环）
 *   ⑥ 未知项目选择器 404 unknown project；非法选择器 400（路径穿越拒绝）
 *   ⑦ 未落地路由 501；未知路由 404；非 GET/POST 405
 *   ⑧ 静态 UI：未认证回落令牌页 / 认证后按 MIME 分发
 *   ⑨ SIGTERM 优雅退出（句柄释放）
 *
 * 不依赖浏览器、不联网、不动真实数据（数据目录默认临时目录）。
 * 用法：
 *   node codex/scripts/smoke-web.mjs [--data-dir=<目录>] [--port=<端口>]
 * 退出码：全部通过 0；任一断言失败 1。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const WEB_DIST = join(PLUGIN_ROOT, 'dist', 'web.js')
const WEB_SRC = join(PLUGIN_ROOT, 'web', 'server.ts')
const HOOKS_RUNNER = join(PLUGIN_ROOT, 'hooks', 'runner.mjs')
const HOOKS_DIST = join(PLUGIN_ROOT, 'dist', 'hooks.js')
const HOOKS_SRC = join(PLUGIN_ROOT, 'src', 'hooks-cli.ts')
const UI_DIST = join(PLUGIN_ROOT, 'ui', 'dist')

const args = process.argv.slice(2)
const dataDir = resolve(args.find(arg => arg.startsWith('--data-dir='))?.slice('--data-dir='.length)
  ?? process.env.CODEX_ENGRAM_DIR
  ?? mkdtempSync(join(tmpdir(), 'codex-engram-web-smoke-')))
const fixedPort = args.find(arg => arg.startsWith('--port='))?.slice('--port='.length)
const TOKEN = 'smoke-web-token'

const failures = []
let step = 0

function title(text) {
  step += 1
  console.log(`\n[${String(step)}] ${text}`)
}

function check(label, ok, detail) {
  console.log(`    ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `：${detail}`}`)
  if (!ok) failures.push(label)
}

/** 取一个空闲端口（先占后放，交给子进程）。 */
function freePort() {
  return new Promise(resolvePromise => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => { resolvePromise(port) })
    })
  })
}

/** 造一个临时 git 仓库（项目库按 origin 哈希分库）。 */
async function makeRepo(origin, label) {
  const dir = mkdtempSync(join(tmpdir(), `engram-web-smoke-${label}-`))
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${origin}\n`)
  return dir
}

const port = fixedPort === undefined ? await freePort() : Number(fixedPort)
const base = `http://127.0.0.1:${String(port)}`
const repo = await makeRepo('git@github.com:smoke/web-smoke.git', 'alpha')

console.log('codex-engram WebAPI 冒烟测试')
console.log(`  数据目录 : ${dataDir}`)
console.log(`  项目根   : ${repo}`)
console.log(`  入口     : ${existsSync(WEB_DIST) ? WEB_DIST : `${WEB_SRC}（未构建，走源码）`}`)

// ---------- 启动服务 ----------
const useWebDist = existsSync(WEB_DIST)
const web = spawn(process.execPath, useWebDist ? [WEB_DIST] : ['--experimental-strip-types', WEB_SRC], {
  env: {
    ...process.env,
    CODEX_ENGRAM_DIR: dataDir,
    ENGRAM_WEB_PORT: String(port),
    ENGRAM_WEB_TOKEN: TOKEN,
    ENGRAM_EMBEDDING: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let webStdout = ''
let webStderr = ''
web.stdout.on('data', chunk => { webStdout += String(chunk) })
web.stderr.on('data', chunk => { webStderr += String(chunk) })

/** 等服务就绪（/api/engram/session 有响应即可，401 也是就绪）。 */
async function waitReady(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/engram/session`, { signal: AbortSignal.timeout(1000) })
      return true
    } catch {
      await new Promise(r => { setTimeout(r, 200) })
    }
  }
  return false
}

const ready = await waitReady()
check('服务在超时前就绪', ready, ready ? undefined : webStderr.slice(-400))
if (!ready) {
  console.error(webStderr)
  process.exit(1)
}

/** 带 Cookie 的 fetch（cookie 来自 /auth 交换）。 */
function withCookie(cookie) {
  return { cookie }
}

// ---------- ① 未认证 ----------
title('① 未认证请求一律 401')
const anon = await fetch(`${base}/api/engram/workspaces`)
check('API 未认证 401', anon.status === 401)
const anonAsset = await fetch(`${base}/assets/app.js`)
check('静态资源未认证 401', anonAsset.status === 401)

// ---------- ② 令牌交换 ----------
title('② 令牌交换（/auth）')
const wrong = await fetch(`${base}/auth?token=not-the-token`, { redirect: 'manual' })
check('错误令牌 403', wrong.status === 403)
const ok = await fetch(`${base}/auth?token=${TOKEN}`, { redirect: 'manual' })
check('正确令牌 302 回面板', ok.status === 302 && (ok.headers.get('location') ?? '') === '/')
const setCookie = ok.headers.get('set-cookie') ?? ''
check('Set-Cookie 含 HttpOnly + SameSite=Strict', setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'), setCookie)
const sessionId = /engram_session=([^;]+)/.exec(setCookie)?.[1] ?? ''
check('会话 id 非空', sessionId !== '')

// ---------- ③ 双通道认证 ----------
title('③ Cookie / Bearer 双通道')
const viaCookie = await fetch(`${base}/api/engram/session`, { headers: withCookie(`engram_session=${sessionId}`) })
check('Cookie 通道 200 且 authenticated', viaCookie.status === 200 && (await viaCookie.json()).authenticated === true)
const viaBearer = await fetch(`${base}/api/engram/session`, { headers: { authorization: `Bearer ${TOKEN}` } })
check('Bearer 通道 200', viaBearer.status === 200)
const forged = await fetch(`${base}/api/engram/session`, { headers: withCookie('engram_session=forged') })
check('伪造会话 401', forged.status === 401)

// ---------- ④ 空库清单 ----------
title('④ 空库 workspaces')
const empty = await (await fetch(`${base}/api/engram/workspaces`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
check('items 为空数组', Array.isArray(empty.items) && empty.items.length === 0)
check('processDefault 为 null（未配置默认项目根）', empty.processDefault === null)

// ---------- ⑤ Hooks 写入 → WebAPI 读取 ----------
title('⑤ 跨入口数据闭环（Hooks 写 → WebAPI 读）')
const useHooksDist = existsSync(HOOKS_DIST)
const hook = await new Promise(resolvePromise => {
  const child = spawn(process.execPath, useHooksDist ? [HOOKS_RUNNER, 'UserPromptSubmit'] : ['--experimental-strip-types', HOOKS_SRC, 'UserPromptSubmit'], {
    env: { ...process.env, CODEX_ENGRAM_DIR: dataDir, ENGRAM_EMBEDDING: 'off', ENGRAM_INGEST: 'explicit' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.on('exit', code => resolvePromise({ code, stdout, stderr }))
  child.stdin.end(JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'web-smoke-session', turn_id: 't1', cwd: repo,
    prompt: '记住：本项目提交前必须先跑 pnpm typecheck',
  }))
})
check('Hooks 进程退出码 0', hook.code === 0)

const ws = await (await fetch(`${base}/api/engram/workspaces`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
check('workspaces 出现 1 个项目库', ws.items.length === 1, JSON.stringify(ws.items.map(i => i.dbName)))
const item = ws.items[0]
check('扫描到的库标记未注册（kind=session，不虚构路径）', item.kind === 'session' && item.path === null && item.exists === true)
check('记忆计数 = 1', item.memories === 1)

const listed = await (await fetch(`${base}/api/engram/list?scope=project&project=${encodeURIComponent(item.dbName)}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
check('WebAPI 读到 Hooks 写入的记忆', listed.total === 1 && listed.records[0].content.includes('pnpm typecheck'))

// ---------- ⑥ 选择器边界 ----------
title('⑥ 项目选择器边界')
const unknown = await fetch(`${base}/api/engram/list?scope=project&project=project-${'f'.repeat(24)}.db`, { headers: { authorization: `Bearer ${TOKEN}` } })
check('未知选择器 404 unknown project', unknown.status === 404 && (await unknown.json()).error === 'unknown project')
const traversal = await fetch(`${base}/api/engram/list?scope=project&project=${encodeURIComponent('../../etc/passwd')}`, { headers: { authorization: `Bearer ${TOKEN}` } })
check('路径穿越选择器 400', traversal.status === 400)

// ---------- ⑦ 路由状态 ----------
title('⑦ 路由状态')
const pending = await fetch(`${base}/api/engram/telemetry`, { headers: { authorization: `Bearer ${TOKEN}` } })
check('未落地路由 501（不假成功）', pending.status === 501)
const noRoute = await fetch(`${base}/api/engram/no-such-route`, { headers: { authorization: `Bearer ${TOKEN}` } })
check('未知路由 404', noRoute.status === 404)
const put = await fetch(`${base}/api/engram/workspaces`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` } })
check('非 GET/POST 405', put.status === 405)

// ---------- ⑧ 静态 UI ----------
title('⑧ 静态 UI 分发')
const gate = await fetch(`${base}/`)
check('未认证访问回落令牌录入页', gate.status === 200 && (await gate.text()).includes('访问令牌'))
if (existsSync(UI_DIST)) {
  const index = await fetch(`${base}/`, { headers: withCookie(`engram_session=${sessionId}`) })
  check('认证后返回 UI 首页', index.status === 200 && (index.headers.get('content-type') ?? '').includes('text/html'))
} else {
  const index = await fetch(`${base}/`, { headers: withCookie(`engram_session=${sessionId}`) })
  check('UI 未构建时给出构建指引（503）', index.status === 503 && (await index.text()).includes('build:ui'))
}

// ---------- ⑨ 优雅退出 ----------
title('⑨ 信号退出')
const exitInfo = await new Promise(resolvePromise => {
  web.on('exit', (code, signal) => { resolvePromise({ code, signal }) })
  web.kill('SIGTERM')
  setTimeout(() => { resolvePromise({ code: null, signal: 'timeout' }) }, 8000)
})
if (process.platform === 'win32') {
  // Windows 上 child.kill('SIGTERM') 走 TerminateProcess（libuv 既定行为，子进程处理器被绕过），
  //  graceful close（runtime.close 释放句柄）由 tests/codex-web-api.spec.ts 的「重启后数据持久」覆盖；
  //  这里只验证进程确实退出、端口随后可重新绑定。
  check('SIGTERM 后进程退出（Windows 硬杀语义）', exitInfo.signal !== 'timeout', JSON.stringify(exitInfo))
  const rebind = await new Promise(resolvePromise => {
    const server = createServer()
    server.once('error', () => { resolvePromise(false) })
    server.listen(port, '127.0.0.1', () => { server.close(() => { resolvePromise(true) }) })
  })
  check('退出后端口释放（可重新绑定）', rebind === true)
} else {
  check('SIGTERM 后退出码 0（优雅关闭）', exitInfo.code === 0, JSON.stringify(exitInfo))
}

console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${String(failures.length)} 项：${failures.join('；')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
