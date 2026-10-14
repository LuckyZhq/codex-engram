/**
 * `/api/engram/*` 请求分发：轻量协议转换层，不含业务逻辑。
 *
 * 契约基准是**面板实际调用方**（src/client/EngramPanel.tsx 的 api() 出口）与 DSH
 * src/routes.ts 的**实际可达分支**——不重新命名路由、不复制 DSH 的重复分支
 * （review-due / review-answer 在 routes.ts 各有两遍，前面的已返回，后面的不可达）。
 *
 * D2 分期（本文件是唯一需要逐阶段扩充的文件）：
 * - D2.1（已落地）：session / workspaces / stats / list——认证、项目定位与最小读路径；
 * - D2.2：核心查询（review、search-test、entities、facts、observations、episode-timeline、
 *   corridor、telemetry、health、tour-proposal、refurb、profile-block、activity…）；
 * - D2.3：写操作与导出（update/forget/restore/review-answer/consolidate、export/mirror）。
 * 已知但未落地的路由一律 501（明确不可用），不返回假成功；未知路由 404。
 * @module codex-engram/web/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { EngramError } from '../../src/types.ts'
import type { EngramKind, EngramStatus } from '../../src/types.ts'
import type { CodexRuntime, CodexScope } from '../src/runtime.ts'
import { InvalidSelectorError, UnknownProjectError } from './projects.ts'
import type { ProjectRegistry } from './projects.ts'

/** Codex Runtime 不支持的作用域（DSH 的 shared 未开放）：显式 501，不假成功。 */
export class ScopeNotSupportedError extends Error {
  constructor(scope: string) {
    super(`scope "${scope}" 不属于 Codex Runtime 支持范围（仅 user / project）`)
    this.name = 'ScopeNotSupportedError'
  }
}

/** 分发依赖（server.ts 装配后传入）。 */
export interface WebApiDeps {
  readonly runtime: CodexRuntime
  readonly projects: ProjectRegistry
}

/** 路由状态：d21 = D2.1 已落地；pending = 已知路由、后续阶段落地。 */
interface RouteEntry {
  readonly methods: readonly ('GET' | 'POST')[]
  readonly status: 'd21' | 'pending'
}

/**
 * 面板 35 接口 + 本层会话探测接口的路由表。
 * 与 docs/plans/2026-10-14-codex-support-phaseD-ui.md §1.2 的清单一一对应；
 * backup / restore-backup 两个 DSH 管理接口不在面板 35 接口内，D2 不收录。
 */
const ROUTES: Readonly<Record<string, RouteEntry>> = {
  session: { methods: ['GET'], status: 'd21' },
  workspaces: { methods: ['GET'], status: 'd21' },
  stats: { methods: ['GET'], status: 'd21' },
  list: { methods: ['GET'], status: 'd21' },
  review: { methods: ['GET'], status: 'pending' },
  'review-due': { methods: ['GET'], status: 'pending' },
  'search-test': { methods: ['GET'], status: 'pending' },
  health: { methods: ['GET'], status: 'pending' },
  corridor: { methods: ['GET'], status: 'pending' },
  telemetry: { methods: ['GET'], status: 'pending' },
  activity: { methods: ['GET'], status: 'pending' },
  'tour-proposal': { methods: ['GET'], status: 'pending' },
  refurb: { methods: ['GET'], status: 'pending' },
  'profile-block': { methods: ['GET'], status: 'pending' },
  'episode-timeline': { methods: ['GET'], status: 'pending' },
  entities: { methods: ['GET'], status: 'pending' },
  entity: { methods: ['GET'], status: 'pending' },
  facts: { methods: ['GET'], status: 'pending' },
  observations: { methods: ['GET'], status: 'pending' },
  'observation-evidence': { methods: ['GET'], status: 'pending' },
  export: { methods: ['GET'], status: 'pending' },
  mirror: { methods: ['GET'], status: 'pending' },
  models: { methods: ['GET'], status: 'pending' },
  'history-backfill': { methods: ['GET'], status: 'pending' },
  'history-backfill/status': { methods: ['GET'], status: 'pending' },
  'jev-config': { methods: ['GET', 'POST'], status: 'pending' },
  'jev-observations': { methods: ['GET'], status: 'pending' },
  'jev-test': { methods: ['POST'], status: 'pending' },
  'history-backfill/start': { methods: ['POST'], status: 'pending' },
  'history-backfill/cancel': { methods: ['POST'], status: 'pending' },
  update: { methods: ['POST'], status: 'pending' },
  forget: { methods: ['POST'], status: 'pending' },
  restore: { methods: ['POST'], status: 'pending' },
  'review-answer': { methods: ['POST'], status: 'pending' },
  consolidate: { methods: ['POST'], status: 'pending' },
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 收敛 scope：仅 user/project；shared 显式抛错（501），缺省 user（与 DSH 同口径）。 */
function codexScopeOf(raw: string | null, fallback: CodexScope): CodexScope {
  if (raw === 'user' || raw === 'project') return raw
  if (raw === 'shared') throw new ScopeNotSupportedError('shared')
  return fallback
}

/** 宽松取数：数字与数字字符串都接受，其余 undefined。 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 项目选择器：GET 走 query，POST 走 body（面板契约：写操作经 body.project 传选择器）。 */
function selectorOf(searchParams: URLSearchParams, body: Record<string, unknown> | undefined): string | undefined {
  if (body !== undefined) {
    const raw = body['project']
    if (typeof raw === 'string' && raw !== '') return raw
    return undefined
  }
  const raw = searchParams.get('project')
  return raw === null || raw === '' ? undefined : raw
}

// ---------- D2.1 已落地路由 ----------

/** 会话探测：面板挂载时的初始化探针（401 时弹令牌输入；mock/开发态由 vite 中间件应答）。 */
function handleSession(res: ServerResponse, deps: WebApiDeps): void {
  json(res, 200, { authenticated: true, mode: 'codex', dbDir: deps.runtime.dbDir })
}

/** 项目宫格清单（扫描 + 配置合并；不建空库，不虚构归属）。 */
async function handleWorkspaces(res: ServerResponse, deps: WebApiDeps): Promise<void> {
  json(res, 200, await deps.projects.list())
}

/** 各作用域统计：只返回请求的作用域段（面板按 scope 取自己那段；库不存在 = 空 parts）。 */
async function handleStats(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const target = await deps.projects.resolve(scope, selectorOf(url.searchParams, undefined))
  const store = await deps.projects.openStoreForRead(target)
  const parts = store === undefined ? [] : [{ scope, stats: await store.stats() }]
  json(res, 200, { parts })
}

/** 管理列表：与 DSH list 路由同参数（scope/status/kind/q/redacted/sort/limit/offset）。 */
async function handleList(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const target = await deps.projects.resolve(scope, selectorOf(url.searchParams, undefined))
  const store = await deps.projects.openStoreForRead(target)
  if (store === undefined) {
    // 库不存在：返回合法空结构，不建空库（与 MCP/Hooks 只读口径一致）。
    json(res, 200, { records: [], total: 0 })
    return
  }
  const status = url.searchParams.get('status')
  const kind = url.searchParams.get('kind')
  const q = url.searchParams.get('q')
  const redacted = url.searchParams.get('redacted')
  const limit = Math.min(100, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 20))
  const offset = Math.max(0, toNumber(url.searchParams.get('offset')) ?? 0)
  const sort = url.searchParams.get('sort')
  json(res, 200, await store.list({
    scope,
    ...(status !== null && status !== '' && status !== 'all' ? { status: status as EngramStatus } : {}),
    ...(kind !== null && kind !== '' && kind !== 'all' ? { kind: kind as EngramKind } : {}),
    ...(q !== null && q !== '' ? { q } : {}),
    ...(redacted === 'true' || redacted === 'false' ? { redacted: redacted === 'true' } : {}),
    ...(sort === 'tour' ? { sort: 'tour' as const } : {}),
    limit,
    offset,
  }))
}

/**
 * 分发一个 `/api/engram/*` 请求（调用方已完成认证与回环守卫）。
 * @param route - `/api/engram/` 之后的路径（不含 query）。
 * @param _body - POST 请求的已解析 JSON body（server.ts 守卫链统一读取与校验；
 *   64 KiB 上限与 JSON 合法性属传输信封，在此前置，路由层直接消费）。
 *   D2.1 无已落地的 POST 路由，故暂不消费；D2.3 写路由起启用。
 */
export async function handleEngramApi(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  url: URL,
  deps: WebApiDeps,
  _body?: Record<string, unknown>,
): Promise<void> {
  const method = req.method ?? 'GET'
  const entry = ROUTES[route]
  if (entry === undefined) {
    json(res, 404, { error: 'unknown route' })
    return
  }
  if (!entry.methods.includes(method as 'GET' | 'POST')) {
    json(res, 405, { error: `method ${method} not allowed for ${route}` })
    return
  }
  if (entry.status === 'pending') {
    // 已知路由、后续阶段落地：明确不可用，不返回假数据（models 不伪造 provider、
    // history-backfill 不假装能跑、jev-* 不假成功）。
    json(res, 501, { error: `not implemented yet: ${route}（Codex WebAPI 后续阶段落地）` })
    return
  }
  try {
    switch (route) {
      case 'session':
        handleSession(res, deps)
        return
      case 'workspaces':
        await handleWorkspaces(res, deps)
        return
      case 'stats':
        await handleStats(res, url, deps)
        return
      case 'list':
        await handleList(res, url, deps)
        return
      default:
        json(res, 404, { error: 'unknown route' })
    }
  } catch (error) {
    // 错误映射：未知项目 404（面板自愈靠 `unknown project` 精确组合）；选择器非法 400；
    // 作用域不支持 501；存储层 NOT_FOUND 404；其余输入类错误 400；未知 500（不泄露堆栈）。
    if (error instanceof UnknownProjectError) {
      json(res, 404, { error: 'unknown project' })
      return
    }
    if (error instanceof InvalidSelectorError) {
      json(res, 400, { error: error.message })
      return
    }
    if (error instanceof ScopeNotSupportedError) {
      json(res, 501, { error: error.message })
      return
    }
    if (error instanceof EngramError) {
      const notFound = error.code === 'NOT_FOUND' || error.code === 'UNKNOWN_PROJECT'
      json(res, notFound ? 404 : 400, { error: error.message })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[codex-engram] web api 内部错误（${route}）：`, message)
    json(res, 500, { error: message })
  }
}
