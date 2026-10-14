/**
 * WebAPI 本地安全层：启动令牌 → 一次性换取 HttpOnly 会话 Cookie；回环 peer/Host/Origin 三重校验。
 *
 * 为什么不是「所有请求带 Authorization Header」：原版面板的导出/镜像走 HTML `<a href>`
 * 直接下载链接，浏览器不会给导航请求附自定义头。令牌只在首次访问时换取会话 Cookie，
 * 之后普通 API 与下载链接都在同源下自动携带，面板网络代码零改动。
 *
 * 防线（与 DSH routes.ts 的 guardLoopback/guardWrite 同口径，Codex 侧独立实现）：
 * 1. peer 必须回环（127/8、::1、IPv4-mapped IPv6）——服务只绑 127.0.0.1，双保险；
 * 2. Host 头必须是回环字面量（防 DNS rebinding：`127.0.0.1.attacker.com`）；
 * 3. 写操作额外校验 Origin 回环（防跨站表单/fetch）；
 * 4. JSON 请求体上限 64 KiB（按字节计，防坏/恶意 body 拖住 handler）；
 * 5. 方法仅放行 GET/POST，其余 405。
 * @module codex-engram/web/auth
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/** 会话 Cookie 名（HttpOnly + SameSite=Strict + Path=/）。 */
export const SESSION_COOKIE = 'engram_session'
/** 会话有效期：本地管理面板用，12 小时足够长又不至于永久有效。 */
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000
/** JSON 请求体上限（字节）。 */
export const MAX_JSON_BODY_BYTES = 64 * 1024
/** 会话数上限（本地单用户服务；防 Cookie 泛滥）。 */
const MAX_SESSIONS = 64

/** 已签发会话（进程内有效，不落盘——重启即全部失效，符合本地工具语义）。 */
interface Session {
  readonly createdAt: number
}

export interface AuthManager {
  /** 启动令牌（进程启动时生成或由 ENGRAM_WEB_TOKEN 指定；只在本进程内有效）。 */
  readonly token: string
  /**
   * 请求是否已认证：`Authorization: Bearer <token>` 或有效会话 Cookie 二者其一。
   * @returns 认证通过的会话概念；未认证返回 undefined。
   */
  authenticate(req: IncomingMessage): { readonly via: 'bearer' | 'cookie' } | undefined
  /**
   * 用启动令牌一次性换取会话。
   * @param rawToken - 用户提供的令牌（URL query / 表单）。
   * @returns 会话 id（写入 Cookie 的值）；令牌不匹配返回 undefined。
   */
  exchange(rawToken: string): string | undefined
  /** 销毁会话（登出/轮换）。 */
  revoke(sessionId: string): void
}

export interface AuthManagerOptions {
  /** 固定令牌（ENGRAM_WEB_TOKEN）；缺省 = 进程启动时随机生成。 */
  readonly token?: string
  /** 会话有效期毫秒数；缺省 12 小时。 */
  readonly ttlMs?: number
  /** 当前时刻（测试可注入）。 */
  readonly now?: () => number
}

/** 生成随机令牌（256 bit，base64url——URL 安全，可直接放 query）。 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 定长比较（防时序侧信道；长度不一致直接 false，不进比较）。 */
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 从 Cookie 头取指定键值（手写解析，不引依赖）。 */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header === '') return undefined
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

/** 创建认证管理器。 */
export function createAuthManager(options: AuthManagerOptions = {}): AuthManager {
  const token = options.token ?? generateToken()
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS
  const now = options.now ?? Date.now
  const sessions = new Map<string, Session>()

  /** 过期清理（每次认证时顺带做；本地服务调用频率低，无需定时器）。 */
  const prune = (): void => {
    const moment = now()
    for (const [id, session] of sessions) {
      if (moment - session.createdAt > ttlMs) sessions.delete(id)
    }
  }

  return {
    token,
    authenticate(req) {
      prune()
      const auth = req.headers.authorization
      if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
        const presented = auth.slice('Bearer '.length).trim()
        if (presented !== '' && safeEqual(presented, token)) return { via: 'bearer' }
      }
      const sessionId = cookieValue(req.headers.cookie, SESSION_COOKIE)
      if (sessionId !== undefined && sessions.has(sessionId)) return { via: 'cookie' }
      return undefined
    },
    exchange(rawToken) {
      if (rawToken === '' || !safeEqual(rawToken, token)) return undefined
      prune()
      // 会话数打满时先踢最旧的（本地单用户，不会走到；防御性上限）。
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
        if (oldest !== undefined) sessions.delete(oldest[0])
      }
      const id = randomBytes(32).toString('base64url')
      sessions.set(id, { createdAt: now() })
      return id
    },
    revoke(sessionId) {
      sessions.delete(sessionId)
    },
  }
}

/** 会话 Cookie 的 Set-Cookie 值（HttpOnly + SameSite=Strict + Path=/；本地 HTTP 无 Secure）。 */
export function sessionCookie(sessionId: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(maxAgeSeconds)}`
}

/** 回环 peer：IPv4 127/8、IPv6 ::1、IPv4-mapped IPv6。 */
export function isLoopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address === undefined) return false
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** Host 头必须为回环字面量（防 DNS rebinding）。缺失按放行（HTTP/1.1 要求 Host，HTTP/1.0 可能没有）。 */
export function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || host === '') return true
  const name = host.split(':')[0]
  return name === 'localhost' || name === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name ?? '')
}

/** Origin 必须回环（防跨站请求）。缺失视为放行——下载链接/地址栏导航不带 Origin，由 Cookie 兜底。 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  } catch {
    return false
  }
}

/** JSON body 读取结果：ok = 解析成功；too_large = 超限（413）；invalid = 坏 JSON/非对象（400）。 */
export type JsonBodyResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'too_large' | 'invalid' }

/** 读取并解析 JSON body（按字节计上限；空 body 视为 `{}`）。 */
export async function readJsonBody(req: IncomingMessage): Promise<JsonBodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return { ok: false, reason: 'too_large' }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return { ok: true, value: {} }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'invalid' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
