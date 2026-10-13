/**
 * 向量相似度共享实现：store 检索与巩固聚类共用一份，替代历史上的两处复制。
 * @module @kenz1117/dsh-engram/vec
 */

/** 维度不匹配告警只发一次（模块级标记）；上游单一嵌入模型下维度恒等，永不触发。 */
let warnedDimensionMismatch = false

/**
 * 余弦相似度；任一向量零范数时返回 0。
 * 嵌入器当前为单一硬编码模型，维度恒等；一旦嵌入器可配置且两向量维度不同，
 * 逐维截断比较会产出「看起来像相似度的数」——这里响亮告警一次（不抛错，
 * 检索照常降级），供换模型时第一时间发现存量向量与新模型维度不一致。
 * @param a - 向量 A。
 * @param b - 向量 B。
 * @returns 余弦相似度，范围约 [-1, 1]；零范数输入返回 0。
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length && !warnedDimensionMismatch) {
    warnedDimensionMismatch = true
    console.warn(`[dsh-engram] cosine dimension mismatch (${String(a.length)} vs ${String(b.length)}): mixed embedder models? retrieval quality is degraded`)
  }
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
