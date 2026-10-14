/**
 * 摄取幂等键与 op_log 命名：DSH 与 Codex 两个宿主共用的**零依赖**常量模块。
 *
 * 为什么单独成文件：Codex 侧要与 DSH 复用同一套 `op_log` 幂等机制（同名 op + 同一套
 * 键编码），但 `src/ingest/hook.ts` 依赖宿主 LLM 客户端（`@deepseek-ai/*`），
 * Codex 侧禁止引入。把纯常量与键编解码抽到这里，两侧即可共用一份语义而不耦合宿主。
 *
 * 两个宿主指向同一 `dbDir` 时，同名 op 的语义一致（`ingest-done` / `ingest-pending`）。
 * @module @kenz1117/dsh-engram/ingest/keys
 */

/** op_log 幂等键 op：该 `(sessionId, turn)` 已完成摄取。 */
export const INGEST_DONE_OP = 'ingest-done'

/** op_log pending 键 op：末轮摄取失败/超时，待下次会话重放补做。 */
export const INGEST_PENDING_OP = 'ingest-pending'

/** 末轮摄取的超时（fire-and-forget 观察器，进程退出可能打断，必须限时）。 */
export const FINAL_INGEST_TIMEOUT_MS = 5000

/** 幂等键编码：`${sessionId}#${turn}`（turn 为数字轮次）。 */
export function encodeTurnKey(sessionId: string, turn: number): string {
  return `${sessionId}#${turn}`
}

/** 幂等键解码；损坏的键返回 undefined（调用方直接出队）。 */
export function decodeTurnKey(detail: string): { sessionId: string; turn: number } | undefined {
  const sep = detail.lastIndexOf('#')
  if (sep <= 0) return undefined
  const turn = Number(detail.slice(sep + 1))
  if (!Number.isInteger(turn) || turn < 0) return undefined
  return { sessionId: detail.slice(0, sep), turn }
}
