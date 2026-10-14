/**
 * Dev 模式 mock 数据（fixtures）：覆盖面板全部九视图的 GET/POST 路由。
 *
 * 定位：仅 Vite dev server 中间件使用（见 api.ts），不进入生产构建、
 * 不接触任何真实数据库。D2 的 codex/web 上线后，dev 代理改指真实服务，
 * 本文件即告退役。数据形态严格对齐 src/routes.ts 的响应结构。
 * @module codex-engram/ui/mock/fixtures
 */

import type { EngramScope } from '../../../../src/types.ts'

/** 面板列表/详情共用的记忆行（对齐 routes.ts 的 MemoryRow 视图）。 */
export interface MockMemoryRow {
  readonly id: string
  readonly scope: EngramScope
  readonly kind: string
  readonly content: string
  readonly importance: number
  readonly confidence: number
  readonly status: 'active' | 'archived' | 'forgotten'
  readonly outcome?: 'success' | 'failure'
  readonly createdAt: number
  readonly accessCount: number
  readonly sourceSessionId: string | null
  readonly sourceRound: number | null
  readonly slot?: { readonly room: string; readonly index: number }
}

const NOW = Date.now()
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 用户库（私人宫殿）10 条。 */
const USER_MEMORIES: MockMemoryRow[] = [
  {
    id: 'm1', scope: 'user', kind: 'fact',
    content: 'Codex CLI hooks 特性已 stable；SessionStart matcher 必须含 compact|fork，缺了上下文压缩后不再注入',
    importance: 0.9, confidence: 0.95, status: 'active',
    createdAt: NOW - 2 * DAY, accessCount: 12, sourceSessionId: null, sourceRound: null,
    slot: { room: '事实厅', index: 1 },
  },
  {
    id: 'm2', scope: 'user', kind: 'preference',
    content: '用户偏好紧凑极简 UI：圆角 4-6px、紧 padding、小间距、视觉层次分明',
    importance: 0.8, confidence: 0.9, status: 'active',
    createdAt: NOW - 5 * DAY, accessCount: 7, sourceSessionId: 's-20261009-am', sourceRound: 3,
    slot: { room: '偏好阁', index: 1 },
  },
  {
    id: 'm3', scope: 'user', kind: 'decision',
    content: 'D 阶段决策：原版 React UI 整体移植至 codex/ui，CSS 主题令牌走兼容层，不重绘管理页',
    importance: 0.95, confidence: 0.9, status: 'active',
    createdAt: NOW - 6 * HOUR, accessCount: 3, sourceSessionId: 's-20261014-am', sourceRound: 1,
    slot: { room: '决策堂', index: 1 },
  },
  {
    id: 'm4', scope: 'user', kind: 'episode',
    content: '2026-10-14 完成 hooks 三事件真机差分验证：本项目 6/4/4 vs 对照 5/3/3，三事件均触发',
    importance: 0.7, confidence: 0.85, status: 'active',
    createdAt: NOW - 3 * DAY, accessCount: 5, sourceSessionId: 's-20261014-am', sourceRound: 2,
    slot: { room: '往事廊', index: 1 },
  },
  {
    id: 'm5', scope: 'user', kind: 'skill',
    content: '本机跑测试用 node node_modules/vitest/vitest.mjs run（.bin shim 非 JS 不可直执）',
    importance: 0.75, confidence: 0.9, status: 'active',
    createdAt: NOW - 8 * DAY, accessCount: 9, sourceSessionId: 's-20261006-pm', sourceRound: 4,
    slot: { room: '技法坊', index: 1 },
  },
  {
    id: 'm6', scope: 'user', kind: 'fact',
    content: '检索为 FTS5 + 向量混合；嵌入 lazy 模式加载失败自动降级纯关键词，不阻塞读写',
    importance: 0.85, confidence: 0.9, status: 'active',
    createdAt: NOW - 9 * DAY, accessCount: 6, sourceSessionId: null, sourceRound: null,
    slot: { room: '事实厅', index: 2 },
  },
  {
    id: 'm7', scope: 'user', kind: 'fact',
    content: '旧结论：codex exec 不需要重定向 stdin（已被真机挂起实践推翻，归展厅陈列）',
    importance: 0.5, confidence: 0.8, status: 'archived',
    createdAt: NOW - 20 * DAY, accessCount: 4, sourceSessionId: null, sourceRound: null,
  },
  {
    id: 'm8', scope: 'user', kind: 'preference',
    content: '写作要求客观简洁、去除 AI 味填充语；代码注释简洁非字面意义',
    importance: 0.8, confidence: 0.95, status: 'active',
    createdAt: NOW - 4 * DAY, accessCount: 8, sourceSessionId: null, sourceRound: null,
    slot: { room: '偏好阁', index: 2 },
  },
  {
    id: 'm9', scope: 'user', kind: 'episode',
    content: '确立摄取幂等键 turnKey = JSON.stringify({s,t})；不要改成 sessionId#turnId 拼接',
    importance: 0.8, confidence: 0.9, status: 'active',
    createdAt: NOW - 26 * HOUR, accessCount: 4, sourceSessionId: 's-20261013-pm', sourceRound: 2,
    slot: { room: '往事廊', index: 2 },
  },
  {
    id: 'm10', scope: 'user', kind: 'fact',
    content: '曾经以为 pnpm 符号链接在本机可遍历（已闭馆，留作考古）',
    importance: 0.4, confidence: 0.7, status: 'forgotten',
    createdAt: NOW - 30 * DAY, accessCount: 2, sourceSessionId: null, sourceRound: null,
  },
]

/** 项目库（当前工作区）6 条。 */
const PROJECT_MEMORIES: MockMemoryRow[] = [
  {
    id: 'p1', scope: 'project', kind: 'decision',
    content: 'codex/ui 用 Vite 编译，直接复用 EngramSection 与 CorridorMap，不复制面板代码',
    importance: 0.95, confidence: 0.95, status: 'active',
    createdAt: NOW - 5 * HOUR, accessCount: 3, sourceSessionId: 's-20261014-am', sourceRound: 1,
    slot: { room: '决策堂', index: 2 },
  },
  {
    id: 'p2', scope: 'project', kind: 'fact',
    content: 'codex/web 将用 Node 原生 HTTP 同时提供静态 UI 与 /api/engram/*，仅绑定 127.0.0.1',
    importance: 0.9, confidence: 0.9, status: 'active',
    createdAt: NOW - 4 * HOUR, accessCount: 2, sourceSessionId: null, sourceRound: null,
    slot: { room: '事实厅', index: 3 },
  },
  {
    id: 'p3', scope: 'project', kind: 'fact',
    content: 'MCP 与 Web 共享同一 Engram Runtime，不建第二套数据库、不重写存储引擎',
    importance: 0.9, confidence: 0.95, status: 'active',
    createdAt: NOW - 7 * DAY, accessCount: 6, sourceSessionId: null, sourceRound: null,
    slot: { room: '事实厅', index: 4 },
  },
  {
    id: 'p4', scope: 'project', kind: 'episode',
    content: '并发实测：WAL + busy_timeout + BEGIN IMMEDIATE，4 进程 × 8 条稳定全部落库',
    importance: 0.8, confidence: 0.9, status: 'active',
    createdAt: NOW - 10 * DAY, accessCount: 5, sourceSessionId: 's-20261004-pm', sourceRound: 2,
    slot: { room: '往事廊', index: 3 },
  },
  {
    id: 'p5', scope: 'project', kind: 'preference',
    content: '插件名必须叫 codex-engram（避开第三方 engram 的陈旧 hooks.state 残留）',
    importance: 0.85, confidence: 0.9, status: 'active',
    createdAt: NOW - 12 * DAY, accessCount: 4, sourceSessionId: null, sourceRound: null,
    slot: { room: '偏好阁', index: 3 },
  },
  {
    id: 'p6', scope: 'project', kind: 'skill',
    content: '构建 codex 侧产物用 node node_modules/tsdown/dist/run.mjs --config codex/tsdown.config.ts',
    importance: 0.7, confidence: 0.9, status: 'active',
    createdAt: NOW - 14 * DAY, accessCount: 7, sourceSessionId: null, sourceRound: null,
    slot: { room: '技法坊', index: 2 },
  },
]

/** 关系边（from → to，type）。 */
export interface MockEdge {
  readonly from: string
  readonly to: string
  readonly type: 'related' | 'supersedes' | 'contradicts' | 'refines' | 'supports'
}

const EDGES: MockEdge[] = [
  { from: 'm1', to: 'm7', type: 'supersedes' },
  { from: 'm3', to: 'm2', type: 'related' },
  { from: 'm3', to: 'p1', type: 'related' },
  { from: 'p1', to: 'p2', type: 'related' },
  { from: 'p2', to: 'p3', type: 'related' },
  { from: 'p4', to: 'p3', type: 'supports' },
  { from: 'm6', to: 'm9', type: 'related' },
  { from: 'm8', to: 'm2', type: 'related' },
]

/** 操作日志（两库合并，时间倒序由路由负责）。 */
export interface MockOp {
  readonly at: number
  readonly op: string
  readonly targetId: string
  readonly detail: string | null
  readonly scope: EngramScope
}

const OPS: MockOp[] = [
  { at: NOW - 30 * 60_000, op: 'write', targetId: 'm3', detail: '{"kind":"decision","scope":"user"}', scope: 'user' },
  { at: NOW - 42 * 60_000, op: 'write', targetId: 'p1', detail: '{"kind":"decision","scope":"project"}', scope: 'project' },
  { at: NOW - 2 * HOUR, op: 'ingest-request', targetId: 'm9', detail: '{"round":2,"userText":"把幂等键结论记住，别再改拼接式","mode":"auto"}', scope: 'user' },
  { at: NOW - 2 * HOUR - 60_000, op: 'ingest-done', targetId: 'm9', detail: '{"round":2}', scope: 'user' },
  { at: NOW - 5 * HOUR, op: 'write-merge', targetId: 'm2', detail: '{"into":"m2","similarity":0.93}', scope: 'user' },
  { at: NOW - 7 * HOUR, op: 'update', targetId: 'm6', detail: '{"kind":"fact"}', scope: 'user' },
  { at: NOW - 9 * HOUR, op: 'search-rewrite-request', targetId: 'm1', detail: '{"query":"hooks matcher","queries":["hooks matcher","SessionStart compact"]}', scope: 'user' },
  { at: NOW - 11 * HOUR, op: 'review-answer', targetId: 'm4', detail: '{"grade":4,"nextIntervalDays":6}', scope: 'user' },
  { at: NOW - 20 * HOUR, op: 'consolidation', targetId: 'm7', detail: '{"scope":"user","archived":2,"merged":1,"skipped":4}', scope: 'user' },
  { at: NOW - 22 * HOUR, op: 'compress-request', targetId: 'm1', detail: '{"count":2}', scope: 'user' },
  { at: NOW - 26 * HOUR, op: 'slot-backfill', targetId: 'm5', detail: '{"assigned":9}', scope: 'user' },
  { at: NOW - 28 * HOUR, op: 'room-open', targetId: 'p6', detail: '{"room":"技法坊"}', scope: 'project' },
  { at: NOW - 30 * HOUR, op: 'forget', targetId: 'm10', detail: null, scope: 'user' },
  { at: NOW - 32 * HOUR, op: 'profile-edit', targetId: 'profile', detail: '{"action":"edit","fromVersion":1,"toVersion":2,"chars":312}', scope: 'user' },
  { at: NOW - 34 * HOUR, op: 'assess', targetId: 'm1', detail: '{"batchId":"b-20261014-1","sufficient":true,"refs":["m1","m9"]}', scope: 'user' },
  { at: NOW - 3 * DAY, op: 'restore', targetId: 'm7', detail: null, scope: 'user' },
]

/** 信念（observations）。 */
export interface MockBelief {
  readonly id: string
  readonly scope: EngramScope
  readonly belief: string
  readonly status: 'active' | 'stale' | 'refuted'
  readonly sourceIds: readonly string[]
  readonly proofCount: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastValidatedAt: number
}

const BELIEFS: MockBelief[] = [
  {
    id: 'o1', scope: 'user', belief: 'hooks 三事件在真机均可触发，差分法是可以拿去汇报的取证手段',
    status: 'active', sourceIds: ['m1', 'm4'], proofCount: 2,
    createdAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY, lastValidatedAt: NOW - 2 * DAY,
  },
  {
    id: 'o2', scope: 'project', belief: 'Vite 8 的 tsx 转换走 oxc，读 tsconfig react-jsx 即自动 runtime，无需 plugin-react',
    status: 'stale', sourceIds: ['p1', 'p2'], proofCount: 2,
    createdAt: NOW - 6 * DAY, updatedAt: NOW - 4 * DAY, lastValidatedAt: NOW - 4 * DAY,
  },
  {
    id: 'o3', scope: 'user', belief: 'pnpm 符号链接在本机可遍历',
    status: 'refuted', sourceIds: ['m10'], proofCount: 1,
    createdAt: NOW - 30 * DAY, updatedAt: NOW - 8 * DAY, lastValidatedAt: NOW - 8 * DAY,
  },
]

/** 实体词典。 */
export interface MockEntity {
  readonly id: string
  readonly name: string
  readonly kind: 'person' | 'project' | 'tool' | 'concept' | 'other'
  readonly aliases: readonly string[]
  readonly memoryCount: number
}

const ENTITIES: MockEntity[] = [
  { id: 'e1', name: '用户', kind: 'person', aliases: ['ZHQ'], memoryCount: 4 },
  { id: 'e2', name: 'codex-engram', kind: 'project', aliases: ['本仓库'], memoryCount: 6 },
  { id: 'e3', name: 'Codex CLI', kind: 'tool', aliases: ['codex'], memoryCount: 3 },
  { id: 'e4', name: '幂等键', kind: 'concept', aliases: ['turnKey'], memoryCount: 2 },
]

/** 实体事实链（e2）。 */
const FACTS = [
  { id: 'f1', content: 'codex-engram 处于 feature/codex-support 分支', validAt: NOW - 12 * DAY, invalidAt: NOW - 5 * DAY, replacedBy: 'f2' },
  { id: 'f2', content: 'D 阶段任务书已下达：移植原版 React 可视化界面', validAt: NOW - 5 * DAY, invalidAt: null, replacedBy: null },
]

/** 画像 curated block。 */
const PROFILE_VERSIONS = [
  { version: 2, content: '偏好紧凑极简 UI；中文交流；先给结构大纲再实施；修改后附变更日志摘要表。', source: 'edit', at: NOW - 32 * HOUR },
  { version: 1, content: '偏好紧凑极简 UI；中文交流。', source: 'edit', at: NOW - 9 * DAY },
]

/** 往事时间线（按会话分组）。 */
const EPISODE_GROUPS = [
  {
    sessionId: 's-20261014-am',
    summary: '上午完成 hooks 真机差分取证，并确立 D 阶段移植决策',
    startedAt: NOW - 8 * HOUR,
    endedAt: NOW - 5 * HOUR,
    episodes: ['m3', 'm4'],
  },
  {
    sessionId: 's-20261013-pm',
    summary: '午后排查 Windows 中文路径与 PowerShell 输出捕获陷阱',
    startedAt: NOW - 30 * HOUR,
    endedAt: NOW - 26 * HOUR,
    episodes: ['m9'],
  },
]

/** 今日待回忆（review-due）。 */
const DUE_IDS = ['m4', 'm8', 'p1']

/** 全部记忆（含全部状态）——routes 的 storeFor 语义按 scope 分流。 */
export function allMemories(): MockMemoryRow[] {
  return [...USER_MEMORIES, ...PROJECT_MEMORIES]
}

/** 可变状态：POST 操作（update/forget/restore）在副本上生效，刷新页面即重置。 */
const liveRows: MockMemoryRow[] = allMemories().map(row => ({ ...row }))

/** 取某 scope 的当前记忆行（可变副本）。 */
export function rowsOfScope(scope: EngramScope): MockMemoryRow[] {
  return liveRows.filter(row => row.scope === scope)
}

/** 按 id 取行（可变副本引用）。 */
export function findRow(id: string): MockMemoryRow | undefined {
  return liveRows.find(row => row.id === id)
}

export function edgesOf(): readonly MockEdge[] {
  return EDGES
}

export function opsOf(): readonly MockOp[] {
  return OPS
}

export function beliefsOf(): readonly MockBelief[] {
  return BELIEFS
}

export function entitiesOf(): readonly MockEntity[] {
  return ENTITIES
}

export function factsOf(): typeof FACTS {
  return FACTS
}

export function profileVersionsOf(): typeof PROFILE_VERSIONS {
  return PROFILE_VERSIONS
}

export function episodeGroupsOf(): typeof EPISODE_GROUPS {
  return EPISODE_GROUPS
}

export function dueIdsOf(): readonly string[] {
  return DUE_IDS
}

/** workspaces 路由的返回（进程默认库 = 第一项）。 */
export const WORKSPACES_VIEW = {
  items: [
    {
      dbName: 'project-16f2a1a22fb6baf61a01d208.db',
      title: 'codex-engram',
      path: 'F:\\开源项目\\codex-engram',
      kind: 'workspace' as const,
      source: 'origin' as const,
      workspaceId: 'ws-codex-engram',
      exists: true,
      memories: 6,
    },
    {
      dbName: 'project-ed4de125e4c544d4f306f6ef.db',
      title: '数据管理 UI',
      path: 'D:\\dev\\data-management-ui',
      kind: 'workspace' as const,
      source: 'origin' as const,
      workspaceId: 'ws-data-ui',
      exists: true,
      memories: 42,
    },
    {
      dbName: 'project-9f8e7d6c5b4a392877665544.db',
      title: null,
      path: null,
      kind: 'session' as const,
      source: 'cwd' as const,
      workspaceId: null,
      exists: false,
      memories: null,
    },
  ],
  processDefault: {
    dbName: 'project-16f2a1a22fb6baf61a01d208.db',
    path: 'F:\\开源项目\\codex-engram',
    title: 'codex-engram',
  },
}

/** 房间计数（stats 的 byKind）。 */
const BY_KIND: Record<'user' | 'project', Record<string, number>> = {
  user: { fact: 4, preference: 2, decision: 1, episode: 2, skill: 1 },
  project: { decision: 1, fact: 2, episode: 1, preference: 1, skill: 1 },
}

/** stats 路由：两库合并 parts。 */
export function statsView(): unknown {
  return {
    parts: [
      {
        scope: 'user',
        stats: {
          total: 10, active: 8, archived: 1, forgotten: 1, redacted: 1,
          signalRatio: 0.78, byKind: BY_KIND.user,
        },
      },
      {
        scope: 'project',
        stats: {
          total: 6, active: 6, archived: 0, forgotten: 0, redacted: 0,
          signalRatio: 0.72, byKind: BY_KIND.project,
        },
      },
    ],
  }
}

/** telemetry 路由：近 7 天聚合。 */
export function telemetryView(): unknown {
  return {
    windowDays: 7,
    counts: {
      writes: 23, forgets: 3, ingestRequests: 41,
      ingestDones: 38, distillRequests: 2, consolidations: 5,
    },
  }
}

/** health 路由：五维评分。 */
export function healthView(): unknown {
  return {
    overall: 82,
    parts: [
      { scope: 'user', score: 86, signal: 0.78, activeRatio: 0.8, edgeCount: 5, redacted: 1, archivedRatio: 0.2 },
      { scope: 'project', score: 78, signal: 0.72, activeRatio: 0.83, edgeCount: 3, redacted: 0, archivedRatio: 0.17 },
    ],
    evaluatedAt: NOW - 12 * 60_000,
  }
}
