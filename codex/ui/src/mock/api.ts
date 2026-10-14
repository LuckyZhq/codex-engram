/**
 * Dev 模式 mock API（Vite 中间件）：在开发服务器上应答 /api/engram/*，
 * 让 D1 阶段不依赖 codex/web 即可在浏览器里验证完整九视图与交互。
 *
 * 边界（重要）：
 * - 只实现 configureServer——仅 dev server 挂载，绝不进入生产构建；
 * - 全部数据来自 fixtures.ts 的内存副本，不碰真实 SQLite；
 * - 响应结构对齐 src/routes.ts；D2 真实服务上线后本中间件即退役。
 * @module codex-engram/ui/mock/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'
import {
  beliefsOf, dueIdsOf, edgesOf, entitiesOf, episodeGroupsOf, factsOf, findRow,
  healthView, opsOf, profileVersionsOf, rowsOfScope, statsView, telemetryView,
  WORKSPACES_VIEW,
} from './fixtures.ts'

/** 读 JSON body（上限 64 KiB，与 host 路由同口径）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let body = ''
  for await (const chunk of req) {
    body += String(chunk)
    if (body.length > 65_536) return null
  }
  try {
    const parsed: unknown = JSON.parse(body === '' ? '{}' : body)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 面板 recall bench 的命中行。 */
interface MockHit {
  readonly id: string
  readonly score: number
  readonly via: 'fts' | 'vec' | 'both'
  readonly scope: string
  readonly kind: string
  readonly status: string
  readonly content: string
  readonly createdAt: number
}

/** review 视图：记录 + 关系 + 修订史 + 操作时间线。 */
function reviewView(id: string): unknown {
  const row = findRow(id)
  if (row === undefined) return undefined
  const edges = edgesOf()
  const supersedes = edges.filter(e => e.from === id && e.type === 'supersedes').map(e => e.to)
  const supersededBy = edges.filter(e => e.to === id && e.type === 'supersedes').map(e => e.from)
  const contradicts = edges.filter(e => (e.from === id || e.to === id) && e.type === 'contradicts')
    .map(e => (e.from === id ? e.to : e.from))
  const related = edges.filter(e => (e.from === id || e.to === id) && e.type !== 'supersedes' && e.type !== 'contradicts')
    .map(e => (e.from === id ? e.to : e.from))
  const operations = opsOf()
    .filter(op => op.targetId === id)
    .map(op => ({ at: op.at, op: op.op, detail: op.detail }))
  return {
    record: row,
    ...(supersededBy.length > 0 ? { supersededBy } : {}),
    ...(supersedes.length > 0 ? { supersedes } : {}),
    ...(contradicts.length > 0 ? { contradicts } : {}),
    ...(related.length > 0 ? { related } : {}),
    revisions: row.status === 'archived'
      ? [{ content: '（旧铭牌快照）' + row.content, kind: row.kind, importance: row.importance, supersededAt: row.createdAt + 3600_000 }]
      : [],
    operations,
  }
}

/** 路由处理器：返回 true = 已应答；false = 交还后续中间件。 */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = url.pathname.replace(/^\/api\/engram\/?/, '')
  const query = url.searchParams
  const method = req.method ?? 'GET'

  // ---------- GET ----------
  if (method === 'GET' && route === 'workspaces') {
    json(res, 200, WORKSPACES_VIEW)
    return true
  }
  if (method === 'GET' && route === 'stats') {
    json(res, 200, statsView())
    return true
  }
  if (method === 'GET' && route === 'telemetry') {
    json(res, 200, telemetryView())
    return true
  }
  if (method === 'GET' && route === 'health') {
    json(res, 200, healthView())
    return true
  }
  if (method === 'GET' && route === 'list') {
    const scope = query.get('scope') === 'project' ? 'project' : 'user'
    const status = query.get('status')
    const kind = query.get('kind')
    const q = query.get('q') ?? ''
    const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 20) || 20))
    const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0)
    const sort = query.get('sort')
    let rows = rowsOfScope(scope)
    if (status !== null && status !== '' && status !== 'all') rows = rows.filter(r => r.status === status)
    if (kind !== null && kind !== '' && kind !== 'all') rows = rows.filter(r => r.kind === kind)
    if (q !== '') rows = rows.filter(r => r.content.includes(q))
    rows = [...rows].sort((a, b) => {
      if (sort === 'tour') return (a.slot?.index ?? 999) - (b.slot?.index ?? 999)
      return b.createdAt - a.createdAt
    })
    json(res, 200, { records: rows.slice(offset, offset + limit), total: rows.length })
    return true
  }
  if (method === 'GET' && route === 'search-test') {
    const q = (query.get('q') ?? '').trim()
    if (q === '') { json(res, 400, { error: 'q required' }); return true }
    const scopeParam = query.get('scope')
    const scopes = scopeParam === 'all' || scopeParam === null || scopeParam === '' ? ['user', 'project'] : [scopeParam]
    const limit = Math.min(20, Math.max(1, Number(query.get('limit') ?? 10) || 10))
    const hits: MockHit[] = []
    for (const scope of scopes) {
      for (const row of rowsOfScope(scope === 'project' ? 'project' : 'user')) {
        if (!row.content.includes(q)) continue
        const score = 0.6 + 0.3 * row.confidence + 0.1 * row.importance
        hits.push({
          id: row.id, score: Number(score.toFixed(4)),
          via: row.confidence > 0.85 ? 'both' : 'fts',
          scope: row.scope, kind: row.kind, status: row.status,
          content: row.content, createdAt: row.createdAt,
        })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    json(res, 200, { degraded: false, hits: hits.slice(0, limit) })
    return true
  }
  if (method === 'GET' && route === 'review') {
    const id = query.get('id')
    if (id === null || id === '') { json(res, 400, { error: 'id required' }); return true }
    const view = reviewView(id)
    if (view === undefined) { json(res, 404, { error: `未找到条目 ${id}` }); return true }
    json(res, 200, view)
    return true
  }
  if (method === 'GET' && route === 'review-due') {
    const items = dueIdsOf().map(id => {
      const row = findRow(id)
      return {
        id,
        kind: row?.kind ?? 'fact',
        ...(row?.slot === undefined ? {} : { slot: row.slot }),
        caption: null,
        nextReviewAt: Date.now() - 2 * 86_400_000,
        overdueDays: 2,
        reps: 3,
      }
    })
    json(res, 200, { scope: 'user', items })
    return true
  }
  if (method === 'GET' && route === 'corridor') {
    const scope = query.get('scope') === 'project' ? 'project' : 'user'
    const statuses = new Set(['active', 'archived'])
    const rawStatus = query.get('status')
    if (rawStatus !== null && rawStatus !== '' && rawStatus !== 'all') {
      statuses.clear()
      for (const s of rawStatus.split(',')) statuses.add(s)
    }
    const nodes = rowsOfScope(scope)
      .filter(r => statuses.has(r.status))
      .map(r => ({
        id: r.id, scope: r.scope, kind: r.kind, status: r.status,
        importance: r.importance, confidence: r.confidence,
        title: r.content.length > 40 ? `${r.content.slice(0, 40)}…` : r.content,
        content: r.content,
      }))
    const allowed = new Set(nodes.map(n => n.id))
    const edges = edgesOf()
      .filter(e => allowed.has(e.from) && allowed.has(e.to))
      .map(e => ({ id: `${e.from}-${e.to}-${e.type}`, from: e.from, to: e.to, type: e.type }))
    json(res, 200, { scope, nodes, edges })
    return true
  }
  if (method === 'GET' && route === 'activity') {
    const limit = Math.min(50, Math.max(1, Number(query.get('limit') ?? 20) || 20))
    const merged = [...opsOf()].sort((a, b) => b.at - a.at).slice(0, limit)
    json(res, 200, { operations: merged })
    return true
  }
  if (method === 'GET' && route === 'tour-proposal') {
    const scope = query.get('scope') === 'project' ? 'project' : 'user'
    const stops = rowsOfScope(scope).filter(r => r.status === 'active').slice(0, 4)
    json(res, 200, {
      scope,
      greeting: stops.length > 0
        ? `宫殿${scope === 'user' ? '私人' : '项目'}侧当前开放 ${stops.length} 间房，建议从地标最亮的开始参观。`
        : '宫殿尚空，建议先放第一段记忆（调用 engram_save）',
      activeCount: stops.length,
      empty: stops.length === 0,
      suggestedStops: stops.map(r => ({
        id: r.id, kind: r.kind, content: r.content,
        importance: r.importance, confidence: r.confidence,
      })),
    })
    return true
  }
  if (method === 'GET' && route === 'refurb') {
    json(res, 200, {
      scope: 'user',
      count: 2,
      suggestions: [
        {
          action: 'demote', primaryId: 'm7', candidates: [], scope: 'user',
          reason: '连续 30 天未被参观且已被 m1 替代，建议降级为展厅陈列',
          confidence: 0.82,
        },
        {
          action: 'merge', primaryId: 'm2', candidates: ['m8'], scope: 'user',
          reason: '两条偏好表述高度相似（UI 紧凑极简 / 写作简洁去 AI 味），可蒸馏为一条高层规律',
          confidence: 0.74,
        },
      ],
    })
    return true
  }
  if (method === 'GET' && route === 'profile-block') {
    const versions = profileVersionsOf().map(v => ({ ...v }))
    const current = versions[0]
    json(res, 200, {
      scope: 'user',
      block: current === undefined ? null : { content: current.content, version: current.version, updatedAt: current.at },
      versions,
    })
    return true
  }
  if (method === 'GET' && route === 'episode-timeline') {
    const around = query.get('around')
    const groups = episodeGroupsOf()
    if (around !== null && around !== '') {
      const row = findRow(around)
      json(res, 200, {
        around: {
          anchor: row === undefined ? null : {
            id: row.id, kind: row.kind, content: row.content, createdAt: row.createdAt,
          },
          neighbors: groups
            .flatMap(g => g.episodes)
            .filter(id => id !== around)
            .slice(0, 3)
            .map(id => {
              const r = findRow(id)
              return r === undefined ? null : {
                id: r.id, kind: r.kind, content: r.content, createdAt: r.createdAt,
              }
            })
            .filter((x): x is NonNullable<typeof x> => x !== null),
        },
      })
      return true
    }
    json(res, 200, {
      groups: groups.map(g => ({
        sessionId: g.sessionId,
        summary: g.summary,
        startedAt: g.startedAt,
        endedAt: g.endedAt,
        episodes: g.episodes.map(id => {
          const r = findRow(id)
          return r === undefined ? null : {
            id: r?.id, kind: r.kind, content: r.content, createdAt: r.createdAt,
          }
        }).filter((x): x is NonNullable<typeof x> => x !== null),
      })),
    })
    return true
  }
  if (method === 'GET' && route === 'entities') {
    const kind = query.get('kind')
    const q = query.get('q') ?? ''
    let items = entitiesOf()
    if (kind !== null && kind !== '' && kind !== 'all') items = items.filter(e => e.kind === kind)
    if (q !== '') items = items.filter(e => e.name.includes(q) || e.aliases.some(a => a.includes(q)))
    json(res, 200, {
      scope: 'user',
      items: items.map(e => ({
        entity: { id: e.id, name: e.name, kind: e.kind, aliases: e.aliases },
        memoryCount: e.memoryCount,
      })),
      total: items.length,
    })
    return true
  }
  if (method === 'GET' && route === 'entity') {
    const id = query.get('id')
    const entity = entitiesOf().find(e => e.id === id)
    if (entity === undefined) { json(res, 404, { error: `未找到实体 ${id}` }); return true }
    json(res, 200, {
      entity: { id: entity.id, name: entity.name, kind: entity.kind, aliases: entity.aliases },
      memories: rowsOfScope('user').filter(r => r.content.includes(entity.name)).slice(0, 5),
    })
    return true
  }
  if (method === 'GET' && route === 'facts') {
    json(res, 200, { scope: 'user', items: factsOf(), total: factsOf().length })
    return true
  }
  if (method === 'GET' && route === 'observations') {
    const status = query.get('status')
    let items = beliefsOf()
    if (status !== null && status !== '' && status !== 'all') items = items.filter(b => b.status === status)
    json(res, 200, { scope: 'user', items, total: items.length })
    return true
  }
  if (method === 'GET' && route === 'observation-evidence') {
    const ids = (query.get('ids') ?? '').split(',').map(s => s.trim()).filter(s => s !== '').slice(0, 50)
    const items = ids.map(id => findRow(id)).filter((x): x is NonNullable<typeof x> => x !== undefined)
    json(res, 200, { scope: 'user', items })
    return true
  }
  if (method === 'GET' && route === 'models') {
    json(res, 200, {
      providers: [{
        id: 'deepseek', name: 'DeepSeek',
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ],
      }],
      failures: [],
    })
    return true
  }
  if (method === 'GET' && route === 'history-backfill') {
    json(res, 200, {
      defaults: {
        days: 7, maxTurnsPerSession: 20, maxTotalTurns: 200,
        includeSubagents: false, includeSeeded: false, includeNoCwd: false,
      },
      estimate: {
        rules: {
          days: 7, maxTurnsPerSession: 20, maxTotalTurns: 200,
          includeSubagents: false, includeSeeded: false, includeNoCwd: false,
        },
        candidates: 12, eligibleTurns: 180, pendingTurns: 42, alreadyIngested: 138,
        skipped: { subagent: 3, seeded: 1, noCwd: 5, tooOld: 20, unreadable: 0 },
        truncated: false,
      },
    })
    return true
  }
  if (method === 'GET' && route === 'history-backfill/status') {
    json(res, 200, {
      progress: {
        state: 'done', sessionsTotal: 12, sessionsDone: 12,
        turnsPlanned: 42, turnsDone: 42, memoriesWritten: 17,
        turnsSkipped: 20, turnsFailed: 2,
        skipReasons: { 'low-activity': 12, chitchat: 5, 'already-ingested': 3 },
      },
      failures: [{ sessionId: 's-20261010-xx', turn: 4, reason: '模型不可用' }],
    })
    return true
  }
  if (method === 'GET' && route === 'jev-config') {
    json(res, 200, {
      enabled: false, apiKeySet: false, apiKeyMask: null,
      baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', timeoutMs: 3000,
      deferMergeAbove: 0.92, deferAcceptBelow: 0.55, contradictMinProbability: 0.8,
    })
    return true
  }
  if (method === 'GET' && route === 'jev-observations') {
    json(res, 200, {
      items: [
        { at: Date.now() - 20 * 60_000, site: 'band', question: '同一记忆？', answered: true, probability: 0.94, elapsedMs: 812, error: undefined, verdict: 'merge' },
        { at: Date.now() - 50 * 60_000, site: 'contradiction', question: '互为矛盾？', answered: false, probability: undefined, elapsedMs: 3000, error: 'timeout', verdict: 'fallback' },
      ],
    })
    return true
  }
  if (method === 'GET' && (route === 'export' || route === 'mirror')) {
    const scope = query.get('scope') === 'project' ? 'project' : 'user'
    const rows = rowsOfScope(scope)
    if (route === 'mirror') {
      json(res, 200, { scope, written: rows.length, dir: `<dbDir>/palaces/${scope}`, memoryCount: rows.length, edgeCount: 0 })
      return true
    }
    const format = query.get('format') === 'json' ? 'json' : 'markdown'
    const body = format === 'json'
      ? JSON.stringify({ records: rows, edges: [] }, null, 2)
      : [
          `# dsh-engram 导出（${scope}）· mock`,
          '',
          ...rows.map(r => `- [${r.status}/${r.kind}] ${r.content}（id=${r.id}，importance ${r.importance}）`),
        ].join('\n')
    res.writeHead(200, {
      'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="engram-${scope}.${format}"`,
    })
    res.end(body)
    return true
  }

  // ---------- POST ----------
  if (method === 'POST' && (route === 'update' || route === 'forget' || route === 'restore')) {
    const body = await readJsonBody(req)
    const id = typeof body?.id === 'string' ? body.id : ''
    const row = findRow(id)
    if (row === undefined) { json(res, 404, { error: `未找到条目 ${id}` }); return true }
    if (route === 'update') {
      const content = typeof body?.content === 'string' ? body.content : ''
      if (content.trim() === '') { json(res, 400, { error: 'content required' }); return true }
      Object.assign(row, {
        content,
        ...(typeof body?.kind === 'string' ? { kind: body.kind } : {}),
        ...(typeof body?.importance === 'number' ? { importance: body.importance } : {}),
      })
    } else if (route === 'forget') {
      Object.assign(row, { status: 'forgotten' })
    } else {
      Object.assign(row, { status: 'active' })
    }
    json(res, 200, { record: row })
    return true
  }
  if (method === 'POST' && route === 'consolidate') {
    json(res, 200, { scope: 'user', archived: 2, merged: 1, skipped: 4 })
    return true
  }
  if (method === 'POST' && route === 'review-answer') {
    const body = await readJsonBody(req)
    const id = typeof body?.id === 'string' ? body.id : ''
    const row = findRow(id)
    if (row === undefined) { json(res, 404, { error: `未找到条目 ${id}` }); return true }
    json(res, 200, { id: row.id, review: { nextReviewAt: Date.now() + 6 * 86_400_000, reps: 4, intervalDays: 6 } })
    return true
  }
  if (method === 'POST' && route === 'jev-config') {
    const body = await readJsonBody(req)
    json(res, 200, {
      ok: true,
      view: {
        enabled: body?.enabled === true,
        apiKeySet: typeof body?.apiKey === 'string' ? body.apiKey !== '' : false,
        apiKeyMask: typeof body?.apiKey === 'string' && body.apiKey !== '' ? 'sk-…****' : null,
        baseUrl: typeof body?.baseUrl === 'string' ? body.baseUrl : 'https://api.deepseek.com',
        model: typeof body?.model === 'string' ? body.model : 'deepseek-chat',
        timeoutMs: typeof body?.timeoutMs === 'number' ? body.timeoutMs : 3000,
        deferMergeAbove: 0.92, deferAcceptBelow: 0.55, contradictMinProbability: 0.8,
      },
    })
    return true
  }
  if (method === 'POST' && route === 'jev-test') {
    json(res, 200, { ok: true, elapsedMs: 812, probability: 0.97, error: undefined })
    return true
  }
  if (method === 'POST' && route === 'history-backfill/start') {
    json(res, 200, {
      ok: true,
      status: {
        progress: {
          state: 'running', sessionsTotal: 12, sessionsDone: 0,
          turnsPlanned: 42, turnsDone: 0, memoriesWritten: 0,
          turnsSkipped: 0, turnsFailed: 0, skipReasons: {},
        },
        failures: [],
      },
    })
    return true
  }
  if (method === 'POST' && route === 'history-backfill/cancel') {
    json(res, 200, {
      ok: true,
      status: {
        progress: {
          state: 'cancelled', sessionsTotal: 12, sessionsDone: 3,
          turnsPlanned: 42, turnsDone: 11, memoriesWritten: 5,
          turnsSkipped: 4, turnsFailed: 1, skipReasons: { 'low-activity': 3 },
        },
        failures: [],
      },
    })
    return true
  }

  json(res, 404, { error: 'unknown route' })
  return true
}

/**
 * mock API 插件：仅 dev server 生效（configureServer），生产构建不含本文件。
 * 未命中 /api/engram/* 的请求原样交还后续中间件（静态资源等）。
 */
export function mockEngramApi(): Plugin {
  return {
    name: 'codex-engram:mock-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0] ?? ''
        if (!path.startsWith('/api/engram')) {
          next()
          return
        }
        try {
          await handle(req, res)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          json(res, 500, { error: message })
        }
      })
      server.config.logger.info('  [codex-engram] mock API 已挂载：/api/engram/*（仅 dev，不触真实数据库）')
    },
  }
}
