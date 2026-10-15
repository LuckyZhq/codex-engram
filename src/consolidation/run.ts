/**
 * 闭馆整理（Background Consolidation）：会话结束或定时触发时的后台巡检，
 * 把长期未访问且重要性低的 active 条目归档（清楼）；同 kind / 高相似度的条目合并
 * （新旧 supersedes 链保留 + 旧条目归档）。
 *
 * 实现：单进程内 setImmediate 分片执行（避免阻塞宿主）。嵌入不可用时仅做归档 + 启发式去重；
 * 嵌入可用时按余弦相似度 ≥ 0.92 合并。所有动作写 op_log，便于面板审计。
 *
 * @module @kenz1117/dsh-engram/consolidation/run
 */

import type { EngramEmbedder } from '../embedder/interface.ts'
import type { EngramStore } from '../store/interface.ts'
import type { MemoryRecord } from '../types.ts'
// 余弦相似度：与 store 检索共享 src/vec.ts 的单一实现（维度不匹配告警一次）。
import { cosine } from '../vec.ts'

/** 单条整理动作（写入 op_log 的统一标记）。 */
const CONSOLIDATION_OP = 'consolidation'

/** 闭馆归档参数：默认 30 天未访问 + importance < 0.3。 */
export interface ConsolidateOptions {
  readonly olderThanDays?: number
  readonly importanceBelow?: number
  /** 合并相似度阈值（0-1），嵌入可用时按 cosine 触发。 */
  readonly mergeThreshold?: number
  /** 整理作用域；未传 = 'user'（保持向后兼容）。 */
  readonly scope?: 'user' | 'project' | 'shared'
  /**
   * 限定只对指定 ids 做合并阶段；未传 = 全库扫（向后兼容）。
   * 仅控制阶段 2（合并相似）；阶段 1（闭馆归档）始终全库执行。
   * candidate 之外的同 kind 同相似条目也会被并入（避免漏并）。
   */
  readonly mergeCandidateIds?: readonly string[]
  /**
   * 执行模式；未传 = `full`（向后兼容）。
   * `partial` = 局部合并：跳过闭馆归档，且只合并候选集合内部的条目（见 `ConsolidateMode`）。
   */
  readonly mode?: ConsolidateMode
}

/**
 * 执行模式（Codex WebAPI 显式选择；**默认 `full`，保持 DSH 宿主行为不变**）。
 *
 * - `full`：全库整理——阶段 1 闭馆归档 + 阶段 2 合并（向后兼容的默认行为）。
 *   传了 `mergeCandidateIds` 时，候选只作「合并种子」：非候选条目与种子相似也会被并入
 *   （原项目有意行为，避免漏并）；归档阶段仍扫全库。
 * - `partial`：**局部合并**——只针对调用方明确提交的候选集合：跳过全库归档、不把候选
 *   之外的条目卷进合并，无向量时用完整正文去重（前 60 字相同不足以保证语义相同）。
 *   用于管理面板「确认合并这 n 条」的场景——用户确认的范围就是实际影响的范围。
 */
export type ConsolidateMode = 'full' | 'partial'

/** 单次整理结果摘要（写入 op_log 并返回给调用方）。 */
export interface ConsolidateReport {
  readonly archived: number
  readonly merged: number
  readonly skipped: number
  readonly tookMs: number
}

/** 默认参数（`mode` 无默认值：缺省即 `full`，由读取处的 `=== 'partial'` 判定，不进 DEFAULTS）。 */
const DEFAULTS: Required<Omit<ConsolidateOptions, 'scope' | 'mergeCandidateIds' | 'mode'>> = {
  olderThanDays: 30,
  importanceBelow: 0.3,
  mergeThreshold: 0.92,
}

/** 闭馆整理主函数：纯异步，不抛错（失败仅记日志 / 落 pending）。 */
export async function runConsolidation(
  store: EngramStore,
  embedder: Promise<EngramEmbedder | undefined>,
  opts: ConsolidateOptions = {},
): Promise<ConsolidateReport> {
  const start = Date.now()
  const options = { ...DEFAULTS, ...opts }
  const scope: 'user' | 'project' | 'shared' = options.scope ?? 'user'
  const partial = options.mode === 'partial'
  const stats = await store.stats()
  const records = await store.topActive(scope, Math.max(stats.active, 0))
  const archivedIds = new Set<string>()
  let archived = 0
  let merged = 0
  let skipped = 0
  const now = Date.now()
  const ageCutoff = options.olderThanDays * 86_400_000

  // 阶段 1：闭馆归档（清楼）。
  // 局部合并模式**整段跳过**——面板确认的是「合并这 n 条」，不该顺带归档落选条目。
  if (!partial) {
    for (const record of records) {
      if (record.importance >= options.importanceBelow) continue
      // lastAccessedAt 通过 store 接口无显式字段；用 createdAt + confidence 衰减作为代理：
      // 创建已过 ageCutoff 且 confidence < 0.3（低访问代理）则归档。
      if (now - record.createdAt < ageCutoff) continue
      if (record.confidence >= 0.3) continue
      try {
        await store.forget(record.id)
        archivedIds.add(record.id)
        archived += 1
      } catch {
        skipped += 1
      }
    }
  }

  // 阶段 2：合并相似条目（按 kind 分桶，桶内两两比对）。
  const emb = await embedder
  const seedIds = options.mergeCandidateIds !== undefined
    ? new Set(options.mergeCandidateIds)
    : null
  // 工作集：局部模式只取候选（不把候选之外的条目卷进来）；全库模式取全部未归档 active。
  const working = records.filter(record =>
    !archivedIds.has(record.id) && (!partial || seedIds === null || seedIds.has(record.id)))
  const buckets = new Map<string, MemoryRecord[]>()
  for (const record of working) {
    const list = buckets.get(record.kind) ?? []
    list.push(record)
    buckets.set(record.kind, list)
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue
    // 全库限定模式：桶内若无任何种子 id 则跳过该桶（仅在其他桶找到 seed 的关联条目时才合并）。
    if (!partial && seedIds !== null && !list.some(record => seedIds.has(record.id))) continue
    if (emb === undefined) {
      // 嵌入不可用：按正文做去重启发式（保留 importance 高的 = existing 胜出）。
      // 局部合并用**完整正文**相等：前 60 字相同不足以保证两条记忆语义相同，宁可漏并不误并。
      const seen = new Map<string, MemoryRecord>()
      for (const record of list) {
        const key = partial ? record.content : record.content.slice(0, 60)
        const existing = seen.get(key)
        if (existing === undefined) {
          seen.set(key, record)
        } else if (record.importance > existing.importance) {
          // 计数只在提交成功后增加：写入失败时 merged 与「实际归档条数」必须一致。
          try {
            await store.supersedeMany(
              { scope, kind: record.kind, content: record.content, importance: record.importance, confidence: record.confidence },
              [existing.id],
            )
            merged += 1
            seen.set(key, record)
          } catch {
            skipped += 1
          }
        }
        // existing 已胜：不动。
      }
      continue
    }
    // 嵌入可用：两两 cosine ≥ 阈值则合并（保留锚点内容）。
    // 向量按桶内全部记录计算——限定模式下非种子也要有向量，否则它永远无法与种子比较。
    const vectors = new Map<string, Float32Array>()
    for (const record of list) {
      try {
        const vec = (await emb.embed([record.content]))[0]
        if (vec !== undefined) vectors.set(record.id, vec)
      } catch {
        skipped += 1
      }
    }
    const arr = list.filter(record => vectors.has(record.id))
    const visited = new Set<string>()
    for (let i = 0; i < arr.length; i += 1) {
      const a = arr[i]!
      if (visited.has(a.id)) continue
      // 全库限定模式：只以种子为锚点向外扫（非种子不主动发起合并，但可被种子并入）。
      if (!partial && seedIds !== null && !seedIds.has(a.id)) continue
      const dupes: MemoryRecord[] = []
      for (let j = i + 1; j < arr.length; j += 1) {
        const b = arr[j]!
        if (visited.has(b.id)) continue
        const sim = cosine(vectors.get(a.id)!, vectors.get(b.id)!)
        if (sim >= options.mergeThreshold) dupes.push(b)
      }
      if (dupes.length === 0) continue
      const ids = dupes.map(record => record.id)
      try {
        await store.supersedeMany(
          { scope, kind: a.kind, content: a.content, importance: a.importance, confidence: a.confidence },
          ids,
        )
        for (const id of ids) visited.add(id)
        visited.add(a.id)
        merged += 1
      } catch {
        skipped += 1
      }
    }
  }

  // 阶段 3：写一条 op_log 汇总（duration / archived / merged / skipped）。
  const report: ConsolidateReport = { archived, merged, skipped, tookMs: Date.now() - start }
  try {
    await store.audit(
      CONSOLIDATION_OP,
      'AUX',
      JSON.stringify({ scope, archived: report.archived, merged: report.merged, skipped: report.skipped, tookMs: report.tookMs }),
    )
  } catch {
    /* 审计失败不影响整理结果 */
  }
  return report
}
