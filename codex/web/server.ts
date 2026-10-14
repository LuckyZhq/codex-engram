/**
 * Codex Engram WebAPI 服务：Node 原生 HTTP，不引 Express/Fastify/ORM。
 *
 * 职责边界：
 * - 本文件只负责 HTTP 生命周期：监听（仅 127.0.0.1）、请求守卫链、静态 UI 分发、
 *   `/auth` 令牌交换、优雅关闭；
 * - `/api/engram/*` 的业务分发在 api.ts，项目定位在 projects.ts，安全策略在 auth.ts；
 * - 数据全部经共享 CodexRuntime（与 MCP/Hooks 同一套存储内核，WAL + BEGIN IMMEDIATE），
 *   WebAPI 是并列入口，不互相调用。
 *
 * 请求守卫链（对 /api/engram/* 与静态资源一致执行）：
 *   方法 ∈ {GET, POST} → peer/Host 回环 → 认证（Bearer 或会话 Cookie）→
 *   POST 额外 Origin 回环 + Content-Type JSON + 64 KiB body 上限。
 * 开发模式（Vite 代理）不跳过任何一层：代理把浏览器 Cookie/Origin/Host 原样转发，
 * 令牌经 `/auth`（一并代理）换取后同源生效。
 * @module codex-engram/web/server
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { CodexRuntime } from '../src/runtime.ts'
import {
  createAuthManager, isLoopbackHost, isLoopbackOrigin, isLoopbackPeer,
  readJsonBody, sessionCookie,
} from './auth.ts'
import type { AuthManager } from './auth.ts'
import { handleEngramApi } from './api.ts'
import { createProjectRegistry } from './projects.ts'
import type { ProjectRegistry } from './projects.ts'

/** 默认监听地址与端口（Vite 开发端口 3927 之外，互不冲突）。 */
export const DEFAULT_WEB_HOST = '127.0.0.1'
export const DEFAULT_WEB_PORT = 3928

/** UI 构建产物目录（`pnpm build:ui` 的输出；dist 与源码树的相对位置一致，均为 `../ui/dist`）。 */
function defaultUiDir(): string {
  return fileURLToPath(new URL('../ui/dist', import.meta.url))
}

export interface WebServerOptions {
  readonly runtime: CodexRuntime
  /** 显式配置的默认项目根（ENGRAM_PROJECT_ROOT / CLI --project-root）。 */
  readonly projectRoot?: string
  readonly host?: string
  readonly port?: number
  /** 固定启动令牌（ENGRAM_WEB_TOKEN）；缺省随机生成并打印。 */
  readonly token?: string
  /** UI 静态目录；缺省 `<codex>/ui/dist`。 */
  readonly uiDir?: string
  /** 日志出口（测试可注入）；缺省 console。 */
  readonly log?: (message: string) => void
}

export interface WebServer {
  readonly httpServer: Server
  readonly auth: AuthManager
  readonly projects: ProjectRegistry
  readonly port: number
  /** 实际监听地址与端口（port=0 时由系统分配）。 */
  address(): { host: string; port: number }
  start(): Promise<void>
  close(): Promise<void>
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 令牌录入页（未认证访问 HTML 时的着陆页：一次性换取会话 Cookie）。 */
function tokenPage(message: string | null): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Codex Engram · 访问令牌</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0f1115; color: #f9fafb;
    font: 14px/1.6 "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
  form { width: 340px; padding: 28px 32px; border: 1px solid #2a2e37; border-radius: 10px; background: #171a21; }
  h1 { margin: 0 0 4px; font-size: 17px; }
  p { margin: 0 0 18px; color: #9aa3b2; font-size: 12.5px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 11px; margin-bottom: 12px;
    border: 1px solid #2a2e37; border-radius: 6px; background: #0f1115; color: #f9fafb; }
  button { width: 100%; padding: 9px 11px; border: 0; border-radius: 6px; cursor: pointer;
    background: #f9fafb; color: #0f1115; font-weight: 600; }
  .err { color: #f87171; font-size: 12.5px; margin-bottom: 12px; }
</style>
</head>
<body>
<form method="get" action="/auth">
  <h1>Codex Engram</h1>
  <p>本地记忆宫殿管理面板。请输入启动时打印的访问令牌（仅本机可见）。</p>
  ${message === null ? '' : `<div class="err">${message}</div>`}
  <input name="token" type="password" placeholder="访问令牌" autocomplete="off" autofocus />
  <button type="submit">进入</button>
</form>
</body>
</html>`
}

/** 未构建 UI 时的说明页（不猜路径、不静默 404）。 */
function missingUiPage(uiDir: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>Codex Engram</title></head>
<body style="font: 14px/1.7 system-ui; padding: 48px; background: #0f1115; color: #f9fafb;">
  <h1 style="font-size: 17px;">UI 尚未构建</h1>
  <p>未找到界面构建产物：<code>${uiDir}</code></p>
  <p>先在仓库根目录执行 <code>pnpm build:ui</code>，再刷新本页。</p>
</body>
</html>`
}

/** 静态文件解析：限定在 uiDir 内（路径穿越防护），只发普通文件。 */
function resolveStaticFile(uiDir: string, requestPath: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return undefined
  }
  if (decoded.includes('\0')) return undefined
  const root = resolve(uiDir)
  const target = resolve(join(root, normalize(decoded)))
  if (target !== root && !target.startsWith(root + sep)) return undefined
  if (!existsSync(target) || !statSync(target).isFile()) return undefined
  return target
}

/** HTML 导航请求判定（决定未认证时回令牌页还是 401 JSON）。 */
function wantsHtml(requestPath: string): boolean {
  if (requestPath === '/' || requestPath === '') return true
  const ext = extname(requestPath).toLowerCase()
  return ext === '' || ext === '.html'
}

/** 创建 WebAPI 服务（未启动；调用方 await start()）。 */
export function createWebServer(options: WebServerOptions): WebServer {
  const runtime: CodexRuntime = options.runtime
  const log = options.log ?? ((message: string) => { console.log(message) })
  const host = options.host ?? DEFAULT_WEB_HOST
  const port = options.port ?? DEFAULT_WEB_PORT
  const uiDir = options.uiDir ?? defaultUiDir()
  const auth = createAuthManager({ ...(options.token === undefined ? {} : { token: options.token }) })
  const projects = createProjectRegistry({ runtime, ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }) })

  /** 令牌交换：一次性换取 HttpOnly 会话 Cookie，随后 302 回面板。 */
  const handleAuthExchange = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const presented = url.searchParams.get('token') ?? ''
    const sessionId = auth.exchange(presented)
    if (sessionId === undefined) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      res.end(tokenPage('令牌不正确，请重新输入（以启动时打印的为准）。'))
      return
    }
    res.writeHead(302, {
      location: '/',
      'set-cookie': sessionCookie(sessionId, 12 * 60 * 60),
    })
    res.end()
  }

  /** 静态资源分发（认证门之后）。 */
  const serveStatic = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const requestPath = url.pathname
    if (!existsSync(uiDir)) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
      res.end(missingUiPage(uiDir))
      return
    }
    const file = resolveStaticFile(uiDir, requestPath === '/' ? '/index.html' : requestPath)
    if (file === undefined) {
      // 无扩展名的未知路径回落到 index.html（SPA 友好）；其余 404。
      if (wantsHtml(requestPath)) {
        const index = resolveStaticFile(uiDir, '/index.html')
        if (index !== undefined) {
          res.writeHead(200, { 'content-type': MIME_TYPES['.html']! })
          res.end(readFileSync(index))
          return
        }
      }
      json(res, 404, { error: 'not found' })
      return
    }
    const type = MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type })
    res.end(readFileSync(file))
  }

  const httpServer = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', `http://${host}:${String(port)}`)
      const requestPath = url.pathname

      // 方法白名单（仅 GET/POST；其余 405——本地管理面不需要 PUT/DELETE/HEAD）。
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { error: `method ${req.method ?? 'unknown'} not allowed` })
        return
      }
      // 回环 peer + Host（防 DNS rebinding）。静态资源与 API 一致执行。
      if (!isLoopbackPeer(req) || !isLoopbackHost(req)) {
        json(res, 403, { error: 'forbidden: loopback only' })
        return
      }

      // 令牌交换端点（认证的入口，自身不需要认证）。
      if (requestPath === '/auth') {
        handleAuthExchange(req, res, url)
        return
      }

      if (requestPath.startsWith('/api/engram')) {
        // API：认证 → 写操作 Origin/Content-Type 守卫 → body 信封（64 KiB + JSON）→ 分发。
        if (auth.authenticate(req) === undefined) {
          json(res, 401, { error: 'unauthorized' })
          return
        }
        let body: Record<string, unknown> | undefined
        if (req.method === 'POST') {
          if (!isLoopbackOrigin(req.headers.origin)) {
            json(res, 403, { error: 'forbidden: loopback origin only' })
            return
          }
          if (!(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
            json(res, 415, { error: 'unsupported content-type' })
            return
          }
          // 传输信封校验前置：超限 413、坏 JSON 400——与路由是否实现无关。
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            json(res, parsed.reason === 'too_large' ? 413 : 400, {
              error: parsed.reason === 'too_large' ? 'request body too large' : 'invalid json body',
            })
            return
          }
          body = parsed.value
        }
        const route = requestPath === '/api/engram' ? '' : requestPath.slice('/api/engram/'.length)
        await handleEngramApi(req, res, route, url, { runtime, projects }, body)
        return
      }

      // 静态 UI：认证门（HTML 导航回令牌页，其余 401）。
      if (auth.authenticate(req) === undefined) {
        if (wantsHtml(requestPath)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(tokenPage(null))
          return
        }
        json(res, 401, { error: 'unauthorized' })
        return
      }
      serveStatic(req, res, url)
    })().catch((error: unknown) => {
      // 兜底：守卫链之外的意外（如 URL 解析失败）不挂住连接。
      console.error('[codex-engram] web 请求处理失败：', error instanceof Error ? error.message : error)
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
      else res.end()
    })
  })

  let listening: Promise<void> | undefined
  return {
    httpServer,
    auth,
    projects,
    port,
    address() {
      const address = httpServer.address()
      if (address === null || typeof address === 'string') return { host, port }
      return { host: address.address, port: address.port }
    },
    start() {
      listening ??= new Promise<void>((resolvePromise, rejectPromise) => {
        httpServer.once('error', rejectPromise)
        httpServer.listen(port, host, () => {
          const actual = httpServer.address()
          const bound = typeof actual === 'object' && actual !== null ? actual.port : port
          log(`[codex-engram] WebAPI 监听 http://${host}:${String(bound)}/（数据目录 ${runtime.dbDir}）`)
          resolvePromise()
        })
      })
      return listening
    },
    async close() {
      httpServer.closeAllConnections?.()
      await new Promise<void>((resolvePromise, rejectPromise) => {
        httpServer.close(error => { error === undefined ? resolvePromise() : rejectPromise(error) })
      })
      await runtime.close()
    },
  }
}

/** 从环境/CLI 收敛 WebAPI 配置（ENGRAM_WEB_HOST / ENGRAM_WEB_PORT / ENGRAM_WEB_TOKEN / ENGRAM_PROJECT_ROOT）。 */
export function webConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  host: string
  port: number
  token?: string
  projectRoot?: string
} {
  const port = Number(env['ENGRAM_WEB_PORT'] ?? DEFAULT_WEB_PORT)
  return {
    host: env['ENGRAM_WEB_HOST'] ?? DEFAULT_WEB_HOST,
    port: Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : DEFAULT_WEB_PORT,
    ...(env['ENGRAM_WEB_TOKEN'] === undefined || env['ENGRAM_WEB_TOKEN'] === '' ? {} : { token: env['ENGRAM_WEB_TOKEN'] }),
    ...(env['ENGRAM_PROJECT_ROOT'] === undefined || env['ENGRAM_PROJECT_ROOT'] === '' ? {} : { projectRoot: env['ENGRAM_PROJECT_ROOT'] }),
  }
}

/** 直接执行（`node dist/web.js`）时启动服务；被测试 import 时不自动启动。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = webConfigFromEnv()
  const { openCodexRuntime } = await import('../src/runtime.ts')
  const runtime = await openCodexRuntime({
    ...(process.env['CODEX_ENGRAM_DIR'] === undefined || process.env['CODEX_ENGRAM_DIR'] === ''
      ? {}
      : { dbDir: process.env['CODEX_ENGRAM_DIR'] }),
    ...(env.projectRoot === undefined ? {} : { cwd: env.projectRoot }),
    embedding: 'off',
  })
  const server = createWebServer({ runtime, ...env })
  try {
    await server.start()
  } catch (error) {
    console.error(`[codex-engram] WebAPI 启动失败（${env.host}:${String(env.port)}）：`, error instanceof Error ? error.message : error)
    process.exit(1)
  }
  const { port: actualPort } = server.address()
  console.log('')
  console.log('  Codex Engram WebAPI 已启动')
  console.log(`  地址：  http://${env.host}:${String(actualPort)}/`)
  console.log(`  令牌：  ${server.auth.token}`)
  console.log('  （令牌仅本进程有效；浏览器首次打开时输入一次即可换取会话 Cookie）')
  console.log('')
  const shutdown = (): void => {
    void server.close().then(() => { process.exit(0) }, () => { process.exit(0) })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
