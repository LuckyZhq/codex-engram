/**
 * MCP 工具输出渲染：把记忆记录压成**有限字符**的可读行，正文摘要与总量双预算。
 *
 * 两条纪律：
 * 1. 工具输出不直接把数据库对象丢给模型——检索/列表返回摘要行（正文截断），只有
 *    `engram_get` 返回指定条目的详细内容；
 * 2. 记忆正文是不可信历史文本，最终由 `renderMemoryPacket` 包协议标签（见 security/sanitize），
 *    本模块只负责字段裁剪与预算，不负责协议包裹。
 * @module codex-engram/render
 */

import { RECALL_TOTAL_CHARS, fitWithinBudget, truncateItem } from '../../src/retrieve/budget.ts'
import type { MemoryRecord, SearchHit } from '../../src/types.ts'

/** 检索返回条数：缺省 5（省 token），上限 20。 */
export const SEARCH_DEFAULT_LIMIT = 5
/** 检索返回条数上限。 */
export const SEARCH_MAX_LIMIT = 20
/** 列表分页：缺省 20，上限 100（列表不做语义排序，靠分页控制体量）。 */
export const LIST_DEFAULT_LIMIT = 20
/** 列表分页上限。 */
export const LIST_MAX_LIMIT = 100
/** 检索/列表行内正文摘要上限（字符）。 */
export const SUMMARY_CHARS = 240
/** 单条记忆正文写入上限；超过请拆成多条（拒绝而非静默截断）。 */
export const SAVE_CONTENT_MAX_CHARS = 2000
/** `engram_get` 返回的正文上限（超出截断并提示）。 */
export const GET_CONTENT_MAX_CHARS = 4000

/** 截断为摘要（超长加省略号）。 */
export function truncateSummary(text: string, maxChars: number = SUMMARY_CHARS): string {
  return truncateItem(text, maxChars)
}

/** 日期短格式（YYYY-MM-DD）。 */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** 桩位标注（未排桩为空串）。 */
function slotOf(record: MemoryRecord): string {
  return record.slot === undefined ? '' : ` ${record.slot.room}#${String(record.slot.index)}`
}

/**
 * 检索命中 → 行（带 id、作用域/种类、桩位、刻入日期、正文摘要、检索分与命中道）。
 * @param hits - 已按相关性排序的命中。
 * @param limit - 展示上限。
 * @returns 行数组与丢弃计数（总字符预算内装填，保持相关性顺序）。
 */
export function renderSearchLines(
  hits: readonly SearchHit[],
  limit: number,
): { readonly lines: readonly string[]; readonly dropped: number } {
  const candidates = hits.slice(0, limit).map((hit, index) => {
    const via = hit.via === 'both' ? '关键词+语义' : hit.via === 'vec' ? '语义' : '关键词'
    const edge = hit.viaEdge === undefined ? '' : `（经 ${hit.viaEdge.type} 关联自 ${String(hit.viaEdge.from)}）`
    const score = Number.isFinite(hit.score) ? hit.score.toFixed(3) : '0'
    return `${String(index + 1)}. [${hit.record.scope}/${hit.record.kind}]${slotOf(hit.record)} 刻于 ${dayOf(hit.record.createdAt)} ${truncateSummary(hit.record.content)}（id=${String(hit.record.id)}, 相关度=${score}, 命中=${via}）${edge}`
  })
  const { kept, dropped } = fitWithinBudget(candidates, line => line.length, RECALL_TOTAL_CHARS)
  return { lines: kept, dropped }
}

/**
 * 列表记录 → 行（含状态与置信度；管理视图用）。
 * @param records - 分页记录。
 */
export function renderListLines(records: readonly MemoryRecord[]): { readonly lines: readonly string[]; readonly dropped: number } {
  const candidates = records.map((record, index) =>
    `${String(index + 1)}. [${record.scope}/${record.kind}/${record.status}]${slotOf(record)} 刻于 ${dayOf(record.createdAt)} 重要=${record.importance.toFixed(2)} 置信=${record.confidence.toFixed(2)} ${truncateSummary(record.content)}（id=${String(record.id)}）`,
  )
  const { kept, dropped } = fitWithinBudget(candidates, line => line.length, RECALL_TOTAL_CHARS)
  return { lines: kept, dropped }
}

/**
 * 单条记忆详情（`engram_get` 用）：完整元数据 + 正文（超上限截断）。
 * @param record - 目标条目。
 * @returns 多行文本。
 */
export function renderRecordDetail(record: MemoryRecord): string {
  const lines = [
    `id: ${String(record.id)}`,
    `作用域: ${record.scope} · 种类: ${record.kind} · 状态: ${record.status}`,
    `重要性: ${record.importance.toFixed(2)} · 置信度: ${record.confidence.toFixed(2)} · 访问次数: ${String(record.accessCount)}`,
    `创建: ${new Date(record.createdAt).toISOString()} · 最近访问: ${new Date(record.lastAccessedAt).toISOString()}`,
    `来源会话: ${record.sourceSessionId ?? '（显式保存）'}${record.sourceRound === null ? '' : ` 第 ${String(record.sourceRound)} 轮`}`,
  ]
  if (record.slot !== undefined) lines.push(`桩位: ${record.slot.room}#${String(record.slot.index)}`)
  if (record.imagery?.caption != null) lines.push(`门牌: ${record.imagery.caption}`)
  if (record.review !== undefined) {
    lines.push(`复习排期: ${record.review.nextReviewAt === null ? '未排期' : new Date(record.review.nextReviewAt).toISOString()} · 间隔 ${String(record.review.intervalDays)} 天 · 连对 ${String(record.review.reps)} 次`)
  }
  const body = record.content.length <= GET_CONTENT_MAX_CHARS
    ? record.content
    : `${record.content.slice(0, GET_CONTENT_MAX_CHARS)}\n…（正文共 ${String(record.content.length)} 字，已截断；完整内容见 Web 管理页或 engram_export）`
  lines.push('', '正文:', body)
  return lines.join('\n')
}

/** 记录的结构化摘要（structuredContent 里的 records[]，正文同样截断）。 */
export function recordSummary(record: MemoryRecord): Record<string, unknown> {
  return {
    id: String(record.id),
    scope: record.scope,
    kind: record.kind,
    status: record.status,
    importance: record.importance,
    confidence: record.confidence,
    createdAt: record.createdAt,
    accessCount: record.accessCount,
    summary: truncateSummary(record.content),
    ...(record.slot === undefined ? {} : { slot: { room: record.slot.room, index: record.slot.index } }),
  }
}
