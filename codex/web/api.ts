/**
 * `/api/engram/*` 请求分发：轻量协议转换层，不含业务逻辑。
 *
 * 契约基准是**面板实际调用方**（src/client/EngramPanel.tsx 的 api() 出口）与 DSH
 * src/routes.ts 的**实际可达分支**——不重新命名路由、不复制 DSH 的重复分支
 * （review-due / review-answer 在 routes.ts 各有两遍，前面的已返回，后面的不可达）。
 *
 * D2 分期（本文件是唯一需要逐阶段扩充的文件）：
 * - D2.1（已落地）：session / workspaces / stats / list——认证、项目定位与最小读路径；
 * - D2.2（已落地）：核心查询 16 接口（review、review-due、search-test、activity、
 *   profile-block、entities、entity、facts、observations、observation-evidence、
 *   episode-timeline、corridor、telemetry、health、tour-proposal、refurb）——
 *   全部读真实 SQLite，复用 Store 既有方法与 src/ 侧纯函数（遥测聚合/入殿导航/翻新建议）；
 * - D2.3：写操作与导出（update/forget/restore/review-answer/consolidate、export/mirror）。
 * 已知但未落地的路由一律 501（明确不可用），不返回假成功；未知路由 404。
 * @module codex-engram/web/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { EngramError, asEntityId, asMemoryId } from '../../src/types.ts'
import type { EngramEntityKind, EngramKind, EngramStatus, ObservationStatus, StoreStats } from '../../src/types.ts'
import type { EngramStore } from '../../src/store/interface.ts'
import { aggregateTelemetry } from '../../src/telemetry/aggregate.ts'
import { buildTourProposal } from '../../src/tour-proposal.ts'
import { DEFAULT_REFURB_OPTIONS, gatherRefurbSuggestions } from '../../src/refurb.ts'
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

/** 路由状态：d21 = D2.1 已落地；d22 = D2.2 已落地；pending = 已知路由、后续阶段落地。 */
interface RouteEntry {
  readonly methods: readonly ('GET' | 'POST')[]
  readonly status: 'd21' | 'd22' | 'pending'
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
  review: { methods: ['GET'], status: 'd22' },
  'review-due': { methods: ['GET'], status: 'd22' },
  'search-test': { methods: ['GET'], status: 'd22' },
  health: { methods: ['GET'], status: 'd22' },
  corridor: { methods: ['GET'], status: 'd22' },
  telemetry: { methods: ['GET'], status: 'd22' },
  activity: { methods: ['GET'], status: 'd22' },
  'tour-proposal': { methods: ['GET'], status: 'd22' },
  refurb: { methods: ['GET'], status: 'd22' },
  'profile-block': { methods: ['GET'], status: 'd22' },
  'episode-timeline': { methods: ['GET'], status: 'd22' },
  entities: { methods: ['GET'], status: 'd22' },
  entity: { methods: ['GET'], status: 'd22' },
  facts: { methods: ['GET'], status: 'd22' },
  observations: { methods: ['GET'], status: 'd22' },
  'observation-evidence': { methods: ['GET'], status: 'd22' },
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

/**
 * 宽松取开关：true/false/1/0 都接受。
 * 面板 facts 查询实际发 `includeInvalid=1`——DSH 的 toBoolean 不认 '1'（静默回落
 * false，全链视图拿不到失效事实）；以面板消费结构为准，这里放行 1/0。
 */
function toFlag(value: unknown): boolean | undefined {
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
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

/**
 * 只读打开：经 ProjectRegistry.resolve() 定位目标库，再按读口径打开。
 * 库不存在返回 undefined（不建空库）；选择器非法/失效由 resolve 抛错（400/404）。
 */
async function openRead(
  deps: WebApiDeps,
  scope: CodexScope,
  selector: string | undefined,
): Promise<EngramStore | undefined> {
  const target = await deps.projects.resolve(scope, selector)
  return deps.projects.openStoreForRead(target)
}

/**
 * 合并视图（search-test 的 all、activity、telemetry/health 不带 scope）的容错打开：
 * 无选择器且无默认项目根时跳过项目库——Codex 不回落 WebAPI 进程 cwd（DSH 的
 * 「进程目录兜底」在 Codex 侧是红线），其余解析错误照常传播（选择器失效仍 404）。
 */
async function openReadForMerged(
  deps: WebApiDeps,
  scope: CodexScope,
  selector: string | undefined,
): Promise<EngramStore | undefined> {
  if (scope === 'project' && (selector === undefined || selector === '') && deps.projects.defaultRoot === undefined) {
    return undefined
  }
  return openRead(deps, scope, selector)
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

// ---------- D2.2-A：基础查询与检索 ----------

/** review：审计视图（详情 + 修订链 + 关系 + 操作日志），store.review() 原样返回。 */
async function handleReview(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const id = url.searchParams.get('id')
  if (id === null || id === '') { json(res, 400, { error: 'id required' }); return }
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  const view = store === undefined ? undefined : await store.review(asMemoryId(id))
  if (view === undefined) { json(res, 404, { error: `未找到条目 ${id}` }); return }
  json(res, 200, view)
}

/** review-due：今日待回忆队列——只给坐标/门牌线索不给正文（检索练习；DTO 取 routes.ts 可达分支）。 */
async function handleReviewDue(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const limit = Math.min(50, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 20))
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  if (store === undefined) { json(res, 200, { scope, items: [] }); return }
  const now = Date.now()
  const due = await store.dueReviews(now, limit)
  json(res, 200, {
    scope,
    items: due.map(record => ({
      id: record.id,
      kind: record.kind,
      ...(record.slot === undefined ? {} : { slot: record.slot }),
      caption: record.imagery?.caption ?? null,
      nextReviewAt: record.review?.nextReviewAt ?? null,
      overdueDays: record.review?.nextReviewAt === null || record.review?.nextReviewAt === undefined
        ? 0
        : Math.max(0, Math.floor((now - record.review.nextReviewAt) / 86_400_000)),
      reps: record.review?.reps ?? 0,
    })),
  })
}

/** search-test：召回测试台——跑真实检索（含命中强化），核对召回质量与命中原委。 */
async function handleSearchTest(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const q = url.searchParams.get('q')
  if (q === null || q.trim() === '') { json(res, 400, { error: 'q required' }); return }
  const scopeParam = url.searchParams.get('scope')
  // 'all'/缺省 = user + project 两库合并（与 DSH 同口径；Codex 无 shared）。
  const merged = scopeParam === 'all' || scopeParam === null || scopeParam === ''
  const scopes: readonly CodexScope[] = merged ? ['user', 'project'] : [codexScopeOf(scopeParam, 'user')]
  const kind = url.searchParams.get('kind')
  const limit = Math.min(20, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 10))
  const selector = selectorOf(url.searchParams, undefined)
  // 嵌入不可用（Codex 默认 embedding:'off'）→ 无查询向量，检索降级纯关键词（degraded 如实标注）。
  const embedder = await deps.runtime.ensureEmbedder()
  const vector = embedder === undefined ? undefined : (await embedder.embed([q.trim()]))[0]
  const results = await Promise.all(scopes.map(async scope => {
    // 显式单 scope 严格解析（选择器失效 404，与 list/stats 同口径）；合并视图缺项目库时跳过该库。
    const store = merged
      ? await openReadForMerged(deps, scope, selector)
      : await openRead(deps, scope, selector)
    return store === undefined ? undefined : await store.search({ text: q, scopes: [scope], limit }, vector)
  }))
  const present = results.filter((result): result is NonNullable<typeof result> => result !== undefined)
  // 空库（无库可检）也要如实标注降级：否则「0 命中」会被误读成检索无误。
  const degraded = vector === undefined || present.some(result => result.degraded)
  let hits = present.flatMap(result => result.hits)
  if (kind !== null && kind !== '' && kind !== 'all') hits = hits.filter(hit => hit.record.kind === kind)
  json(res, 200, {
    degraded,
    hits: hits.map(hit => ({
      id: hit.record.id,
      score: hit.score,
      via: hit.via,
      ...(hit.viaEdge === undefined ? {} : { viaEdge: hit.viaEdge }),
      scope: hit.record.scope,
      kind: hit.record.kind,
      status: hit.record.status,
      content: hit.record.content,
      createdAt: hit.record.createdAt,
    })),
  })
}

/** activity：最近活动——合并 user/project 两库 op_log 倒序（摄取/检索改写/条目操作全貌）。 */
async function handleActivity(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const limit = Math.min(50, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 20))
  const selector = selectorOf(url.searchParams, undefined)
  const merged = (await Promise.all((['user', 'project'] as const).map(async scope => {
    const store = await openReadForMerged(deps, scope, selector)
    const ops = store === undefined ? [] : await store.recentOps(limit)
    return ops.map(op => ({ ...op, scope }))
  }))).flat().sort((a, b) => b.at - a.at).slice(0, limit)
  json(res, 200, { operations: merged })
}

/** profile-block：画像 curated block 审计视图——当前态 + 版本历史（新→旧，最多 20 条）。 */
async function handleProfileBlock(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  if (store === undefined) { json(res, 200, { scope, block: null, versions: [] }); return }
  const block = await store.getProfileBlock(scope)
  const versions = await store.listProfileBlockVersions(scope, 20)
  json(res, 200, { scope, block: block ?? null, versions })
}

// ---------- D2.2-B：结构化记忆查询 ----------

/** entities：实体词典列表（含每实体关联 active 记忆数）；实体跟随来源记忆所在 scope 分库。 */
async function handleEntities(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const kind = url.searchParams.get('kind')
  const q = url.searchParams.get('q')
  const limit = Math.min(200, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 50))
  const offset = Math.max(0, toNumber(url.searchParams.get('offset')) ?? 0)
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  if (store === undefined) { json(res, 200, { scope, items: [], total: 0 }); return }
  const result = await store.listEntities({
    ...(kind !== null && kind !== '' && kind !== 'all' ? { kind: kind as EngramEntityKind } : {}),
    ...(q !== null && q !== '' ? { q } : {}),
    limit,
    offset,
  })
  json(res, 200, { scope, ...result })
}

/** entity：实体详情——实体记录 + 最近关联 active 记忆（创建时间倒序）。 */
async function handleEntity(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const id = url.searchParams.get('id')
  if (id === null || id === '') { json(res, 400, { error: 'id required' }); return }
  const limit = Math.min(100, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 20))
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  const detail = store === undefined ? undefined : await store.entityDetail(asEntityId(id), limit)
  if (detail === undefined) { json(res, 404, { error: `未找到实体 ${id}` }); return }
  json(res, 200, detail)
}

/** facts：实体事实链——asOf 时点回看 / includeInvalid 展开全链（软失效，历史链保留）。 */
async function handleFacts(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const id = url.searchParams.get('entityId')
  if (id === null || id === '') { json(res, 400, { error: 'entityId required' }); return }
  const asOf = toNumber(url.searchParams.get('asOf'))
  const includeInvalid = toFlag(url.searchParams.get('includeInvalid')) ?? false
  const limit = Math.min(200, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 50))
  const offset = Math.max(0, toNumber(url.searchParams.get('offset')) ?? 0)
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  if (store === undefined) { json(res, 200, { scope, items: [], total: 0 }); return }
  const result = await store.factsOfEntity({
    entityId: asEntityId(id),
    ...(asOf === undefined ? {} : { asOf }),
    ...(includeInvalid ? { includeInvalid: true } : {}),
    limit,
    offset,
  })
  json(res, 200, { scope, ...result })
}

/** observations：巩固信念列表（面板信念页）；status 缺省全部；按证据数降序（store 默认排序）。 */
async function handleObservations(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const status = url.searchParams.get('status')
  const limit = Math.min(200, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 100))
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  if (store === undefined) { json(res, 200, { scope, items: [], total: 0 }); return }
  const items = await store.listObservations({
    ...(status !== null && status !== '' && status !== 'all' ? { status: status as ObservationStatus } : {}),
    limit,
  })
  json(res, 200, { scope, items, total: items.length })
}

/** observation-evidence：信念证据链回查——sourceIds → 原始记忆行（只读，含已归档，证据必须可回溯）。 */
async function handleObservationEvidence(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const ids = (url.searchParams.get('ids') ?? '')
    .split(',').map(part => part.trim()).filter(part => part !== '').slice(0, 50)
  if (ids.length === 0) { json(res, 400, { error: 'ids required' }); return }
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  const items = store === undefined ? [] : await store.getMany(ids.map(asMemoryId))
  json(res, 200, { scope, items })
}

/** episode-timeline：情景时间线——按日期范围/来源会话分组；around 非空时切换为邻近扩展。 */
async function handleEpisodeTimeline(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const since = toNumber(url.searchParams.get('since'))
  const until = toNumber(url.searchParams.get('until'))
  const sessionId = url.searchParams.get('sessionId') ?? undefined
  const around = url.searchParams.get('around') ?? undefined
  const windowMinutes = Math.min(24 * 60, Math.max(1, toNumber(url.searchParams.get('windowMinutes')) ?? 60))
  const limit = Math.min(200, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 100))
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  if (around !== undefined && around !== '') {
    // 邻近扩展：锚点在该库不存在时 loud 失败（→404）；库不存在同理。
    if (store === undefined) { json(res, 404, { error: `未找到条目 ${around}` }); return }
    const result = await store.episodeTimeline({ scopes: [scope], around: asMemoryId(around), proximityMs: windowMinutes * 60_000, limit })
    const view = result.around!
    // 扁平结构 { anchor, neighbors }：面板 EpisodeAroundView 直接消费 d.anchor/d.neighbors。
    // （DSH routes.ts 在此多包一层 around 键，与面板类型不符——按面板消费结构为准。）
    json(res, 200, {
      anchor: {
        id: view.anchor.id, kind: view.anchor.kind, content: view.anchor.content, createdAt: view.anchor.createdAt,
      },
      neighbors: view.neighbors.map(record => ({
        id: record.id, kind: record.kind, content: record.content, createdAt: record.createdAt,
      })),
    })
    return
  }
  if (store === undefined) { json(res, 200, { groups: [] }); return }
  const result = await store.episodeTimeline({
    scopes: [scope],
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
    limit,
  })
  json(res, 200, {
    groups: result.groups.map(group => ({
      sessionId: group.sessionId,
      ...(group.summary === undefined ? {} : { summary: group.summary }),
      startedAt: group.startedAt,
      endedAt: group.endedAt,
      episodes: group.episodes.map(record => ({
        id: record.id, kind: record.kind, content: record.content, createdAt: record.createdAt,
      })),
    })),
  })
}

// ---------- D2.2-C：分析与可视化查询 ----------

/**
 * 健康评分（Memory Prize scorecard，公式与 DSH routes.ts 一致）：
 *   - 信噪比 (0-40)：signalRatio 线性
 *   - 活跃率 (0-25)：active/total 逼近目标活跃率 0.85（Codex 无 shared，恒取 user/project 档）
 *   - 走廊密度 (0-15)：edges/active，封顶 0.5
 *   - 涂改率惩罚 (0-10)：redacted 占比反向
 *   - 衰减覆盖 (0-10)：archived/total 落入 [0.15, 0.45] 满分
 * 走廊密度用 stats.edges（= exportAll().edges.length 的全量边计数，同一口径、免全表导出）。
 */
function healthPart(scope: CodexScope, s: StoreStats): {
  readonly scope: CodexScope
  readonly score: number
  readonly signal: number
  readonly activeRatio: number
  readonly edgeCount: number
  readonly redacted: number
  readonly archivedRatio: number
} {
  const total = Math.max(s.total, 1)
  const signal = s.signalRatio
  const activeRatio = s.active / total
  const corridorRatio = Math.min(0.5, s.edges / Math.max(s.active, 1)) / 0.5
  const redactedPenalty = Math.max(0, 1 - s.redacted / total)
  const archivedRatio = s.archived / total
  const decayLow = 0.15
  const decayHigh = 0.45
  const decayWindow = 0.3
  const decayCoverage = archivedRatio >= decayLow && archivedRatio <= decayHigh
    ? 1
    : Math.max(0, 1 - Math.min(Math.abs(archivedRatio - decayLow), Math.abs(archivedRatio - decayHigh)) / decayWindow)
  const score = Math.round(
    signal * 40
    + (1 - Math.abs(activeRatio - 0.85) / 0.85) * 25
    + corridorRatio * 15
    + redactedPenalty * 10
    + decayCoverage * 10,
  )
  return { scope, score: Math.min(100, Math.max(0, score)), signal, activeRatio, edgeCount: s.edges, redacted: s.redacted, archivedRatio }
}

/** health：健康评分（5 维 0-100）；scope 限定单库，缺省 user+project 合并（Codex 无 shared）。 */
async function handleHealth(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const rawScope = url.searchParams.get('scope')
  const scopes: readonly CodexScope[] = rawScope === 'user' || rawScope === 'project' ? [rawScope] : ['user', 'project']
  const selector = selectorOf(url.searchParams, undefined)
  const parts = (await Promise.all(scopes.map(async scope => {
    // 显式单库严格解析（选择器失效 404）；合并视图缺项目库时跳过该段。
    const store = scopes.length === 1
      ? await openRead(deps, scope, selector)
      : await openReadForMerged(deps, scope, selector)
    return store === undefined ? undefined : healthPart(scope, await store.stats())
  }))).filter((part): part is NonNullable<typeof part> => part !== undefined)
  const overall = parts.length === 0
    ? 0
    : Math.round(parts.reduce((sum, part) => sum + part.score, 0) / parts.length)
  json(res, 200, { overall, parts, evaluatedAt: Date.now() })
}

/** corridor：走廊图——节点 = 记忆（按房间分簇），边 = related/supersedes/contradicts/refines/supports。 */
async function handleCorridor(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const includeStatuses = new Set(['active'])
  const rawStatus = url.searchParams.get('status')
  if (rawStatus !== null && rawStatus !== '' && rawStatus !== 'all') {
    for (const s of rawStatus.split(',')) {
      if (s === 'active' || s === 'archived' || s === 'forgotten') includeStatuses.add(s)
    }
  }
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  if (store === undefined) { json(res, 200, { scope, nodes: [], edges: [] }); return }
  const data = await store.exportAll()
  const nodes = data.records
    .filter(r => includeStatuses.has(r.status))
    .map(r => ({
      id: r.id,
      scope: r.scope,
      kind: r.kind,
      status: r.status,
      importance: r.importance,
      confidence: r.confidence,
      title: r.content.length > 40 ? `${r.content.slice(0, 40)}…` : r.content,
      content: r.content,
    }))
  const allowedIds = new Set(nodes.map(n => n.id))
  const edges = data.edges
    .filter(e => allowedIds.has(e.from) && allowedIds.has(e.to))
    .map(e => ({ id: `${e.from}-${e.to}-${e.type}`, from: e.from, to: e.to, type: e.type }))
  json(res, 200, { scope, nodes, edges })
}

/**
 * telemetry：宫殿遥测——本地聚合 op_log 近 N 天指标（复用 src/telemetry/aggregate.ts）。
 * **只聚合 user/project**：Codex Runtime 无 shared 库，显式 scope=shared 走 501，
 * 合并视图也绝不把 shared 放进聚合列表（不触发不存在的库）。
 */
async function handleTelemetry(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const windowDays = Math.min(90, Math.max(1, toNumber(url.searchParams.get('days')) ?? 7))
  const rawScope = url.searchParams.get('scope')
  const scopeFilter: 'user' | 'project' | undefined =
    rawScope === 'user' ? 'user' : rawScope === 'project' ? 'project' : undefined
  if (rawScope === 'shared') throw new ScopeNotSupportedError('shared')
  const selector = selectorOf(url.searchParams, undefined)
  if (scopeFilter !== undefined) {
    // 显式 scope 严格解析：选择器缺失/失效在这里就 404（与 list/stats 同口径），
    // 不进聚合函数的静默跳过分支；解析通过但库不存在 → 聚合跳过该段（空结构）。
    await deps.projects.resolve(scopeFilter, selector)
  }
  const openForTelemetry = async (scope: 'user' | 'project' | 'shared'): Promise<EngramStore> => {
    if (scope === 'shared') throw new ScopeNotSupportedError('shared')
    const store = await openReadForMerged(deps, scope, selector)
    if (store === undefined) throw new Error(`engram store unavailable: ${scope}`)
    return store
  }
  json(res, 200, await aggregateTelemetry(openForTelemetry, windowDays, scopeFilter))
}

/** tour-proposal：入殿导航——基于当前 scope 的 active 记忆给开场建议（suggestedStops ≤ 5）。 */
async function handleTourProposal(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  const records = store === undefined
    ? []
    : (await store.list({ scope, status: 'active', limit: 200, offset: 0 })).records
  const focusKind = url.searchParams.get('focusKind')
  const proposal = buildTourProposal(scope, records, focusKind ?? undefined)
  json(res, 200, {
    scope: proposal.empty ? 'empty' : scope,
    greeting: proposal.greeting,
    activeCount: proposal.activeCount,
    empty: proposal.empty,
    suggestedStops: proposal.suggestedStops.map(record => ({
      id: record.id,
      kind: record.kind,
      content: record.content,
      importance: record.importance,
      confidence: record.confidence,
    })),
  })
}

/** refurb：翻新清单——扫描当前 scope 的 active 条目，按规则生成 merge/demote/review/split 建议。 */
async function handleRefurb(res: ServerResponse, url: URL, deps: WebApiDeps): Promise<void> {
  const scope = codexScopeOf(url.searchParams.get('scope'), 'user')
  const store = await openRead(deps, scope, selectorOf(url.searchParams, undefined))
  const records = store === undefined
    ? []
    : (await store.list({ scope, status: 'active', limit: 500, offset: 0 })).records
  const suggestions = gatherRefurbSuggestions(records, DEFAULT_REFURB_OPTIONS)
  json(res, 200, {
    scope,
    count: suggestions.length,
    suggestions: suggestions.map(suggestion => ({
      action: suggestion.action,
      primaryId: suggestion.primaryId,
      candidates: [...suggestion.candidates],
      scope: suggestion.scope,
      reason: suggestion.reason,
      confidence: suggestion.confidence,
    })),
  })
}

/**
 * 分发一个 `/api/engram/*` 请求（调用方已完成认证与回环守卫）。
 * @param route - `/api/engram/` 之后的路径（不含 query）。
 * @param _body - POST 请求的已解析 JSON body（server.ts 守卫链统一读取与校验；
 *   64 KiB 上限与 JSON 合法性属传输信封，在此前置，路由层直接消费）。
 *   D2.2 无已落地的 POST 路由，故暂不消费；D2.3 写路由起启用。
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
      // ---------- D2.2 ----------
      case 'review':
        await handleReview(res, url, deps)
        return
      case 'review-due':
        await handleReviewDue(res, url, deps)
        return
      case 'search-test':
        await handleSearchTest(res, url, deps)
        return
      case 'activity':
        await handleActivity(res, url, deps)
        return
      case 'profile-block':
        await handleProfileBlock(res, url, deps)
        return
      case 'entities':
        await handleEntities(res, url, deps)
        return
      case 'entity':
        await handleEntity(res, url, deps)
        return
      case 'facts':
        await handleFacts(res, url, deps)
        return
      case 'observations':
        await handleObservations(res, url, deps)
        return
      case 'observation-evidence':
        await handleObservationEvidence(res, url, deps)
        return
      case 'episode-timeline':
        await handleEpisodeTimeline(res, url, deps)
        return
      case 'corridor':
        await handleCorridor(res, url, deps)
        return
      case 'telemetry':
        await handleTelemetry(res, url, deps)
        return
      case 'health':
        await handleHealth(res, url, deps)
        return
      case 'tour-proposal':
        await handleTourProposal(res, url, deps)
        return
      case 'refurb':
        await handleRefurb(res, url, deps)
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
    // 未知异常：响应只给固定文案（路径/堆栈/内部细节不外泄），完整信息落服务端日志。
    console.error(`[codex-engram] web api 内部错误（${route}）：`, error)
    json(res, 500, { error: 'internal error' })
  }
}
