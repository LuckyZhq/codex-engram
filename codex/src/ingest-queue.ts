/**
 * Codex 侧摄取队列：把「一轮对话」变成一条**可恢复**的摄取任务。
 *
 * 状态流转（对齐接入指南 §5；短命 hook 进程内以「暂存记录 + done 标记」表示）：
 *
 * ```
 * UserPromptSubmit  暂存本轮输入（op=ingest-input）
 *        ↓
 *   处理器消费（进程内 processing）
 *        ├─ 成功 → 写 ingest-done + 清除暂存
 *        └─ 失败 → 写 ingest-pending，保留暂存记录，下次 Hook 调用重试
 * ```
 *
 * 三层幂等（抑制重复与回声室）：
 * 1. **轮次级**：`(session_id, turn_id)` → `ingest-done`，同一轮重复触发只摄取一次；
 * 2. **内容级**：入库正文的归一化指纹 → `ingest-seen`，跨轮次同一事实不重复入库
 *    （`embedding: 'off'` 时 `decideWrite` 拿不到向量、四态形同全 accept，
 *    内容指纹是唯一可靠的内容级去重手段）；
 * 3. **召回复述级**：本轮已注入记忆的指纹从候选中剔除（显式要求记住的候选除外）。
 *
 * op 命名与 DSH 共用（`src/ingest/keys.ts`）：两个宿主指向同一 `dbDir` 时语义一致，
 * 但**两宿主的摄取机制各自独立**——DSH 以数字轮次编码键，Codex 以字符串 `turn_id`。
 * @module codex-engram/ingest-queue
 */

import { createHash } from 'node:crypto'
import { INGEST_DONE_OP, INGEST_PENDING_OP } from '../../src/ingest/keys.ts'
import { redactSecrets } from '../../src/security/redact.ts'
import { sanitizeProtocolText } from '../../src/security/sanitize.ts'
import type { EngramStore } from '../../src/store/interface.ts'
import type { EngramKind } from '../../src/types.ts'
import { extractExplicitMemories } from './hook-events.ts'
import type { IngestMode } from './hook-events.ts'
import type { CodexRuntime, CodexScope } from './runtime.ts'

/** 暂存本轮输入的 op（处理器消费后立即清除，故该 op 的行数始终很少）。 */
export const INGEST_INPUT_OP = 'ingest-input'

/** 内容指纹已见集合的 op（跨轮次内容级精确去重）。 */
export const INGEST_SEEN_OP = 'ingest-seen'

/** 自动摄取候选的初始置信度（低置信写入，检索命中后被强化）。 */
const INGEST_CONFIDENCE = 0.3

/** 诊断里回显正文的截断长度（回显前一律经 redactSecrets）。 */
const NOTE_EXCERPT = 30

/**
 * 轮次幂等键：`(session_id, turn_id)` 的确定性 JSON 编码。
 * 字段顺序固定，保证同一轮多次调用得到逐字节相同的键（`op_log` 靠 detail 精确匹配）。
 * @param sessionId - 会话 id。
 * @param turnId - 回合 id（Codex 为字符串；缺失时归一为 `null`）。
 */
export function turnKey(sessionId: string, turnId: string | null): string {
  return JSON.stringify({ s: sessionId, t: turnId })
}

/**
 * 归一化正文（去空白、标点、零宽字符，统一小写）：
 * 同一事实的不同排版得到同一指纹。
 * @param text - 待归一正文。
 */
export function normalizeForFingerprint(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * 内容指纹（sha256 前 24 位十六进制）。
 * 在 `embedding: 'off'` 下替代向量近邻，做内容级精确去重与召回复述识别。
 * @param text - 正文（清洗后）。
 */
export function contentFingerprint(text: string): string {
  return createHash('sha256').update(normalizeForFingerprint(text)).digest('hex').slice(0, 24)
}

/** 待摄取的一条候选。 */
export interface IngestCandidate {
  readonly content: string
  readonly kind: EngramKind
  /** true = 用户在输入里明确要求记住（不参与召回复述剔除）。 */
  readonly explicit: boolean
}

/**
 * 剔除「本轮已注入记忆的复述」：显式要求记住的候选不受剔除（用户指令优先）。
 * @param candidates - 本题候选。
 * @param injectedFingerprints - 本轮注入过的记忆指纹。
 */
export function filterRecalledRestatements(
  candidates: readonly IngestCandidate[],
  injectedFingerprints: readonly string[],
): { readonly kept: readonly IngestCandidate[]; readonly excluded: number } {
  if (injectedFingerprints.length === 0) return { kept: candidates, excluded: 0 }
  const injected = new Set(injectedFingerprints)
  const kept = candidates.filter(candidate => candidate.explicit || !injected.has(contentFingerprint(candidate.content)))
  return { kept, excluded: candidates.length - kept.length }
}

/** 本轮输入暂存记录（持久在 `op_log` 的 `ingest-input` 行里）。 */
export interface TurnInputRecord {
  readonly sessionId: string
  readonly turnId: string | null
  /** 会话 cwd（仅在提交时无法解析成项目根的情况下才可能带 cwd 落到用户库）。 */
  readonly cwd: string | null
  readonly at: number
  /** 用户输入摘录（已脱敏、已截断）。 */
  readonly prompt: string
  /** 本轮注入过的记忆指纹（auto 档提取时据此剔除召回复述）。 */
  readonly injected: readonly string[]
}

/** 暂存记录 + 它在 `op_log` 里的原始 detail（清除时必须原样回写）。 */
export interface TurnInputEntry {
  readonly detail: string
  readonly record: TurnInputRecord
}

/** 从 detail 解析暂存记录；形状不符返回 undefined（非本插件写入的行一律忽略）。 */
function parseTurnInput(detail: string): TurnInputRecord | undefined {
  try {
    const parsed = JSON.parse(detail) as Partial<TurnInputRecord>
    if (typeof parsed.sessionId !== 'string' || typeof parsed.prompt !== 'string') return undefined
    return {
      sessionId: parsed.sessionId,
      turnId: typeof parsed.turnId === 'string' ? parsed.turnId : null,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
      at: typeof parsed.at === 'number' ? parsed.at : 0,
      prompt: parsed.prompt,
      injected: Array.isArray(parsed.injected)
        ? parsed.injected.filter((item): item is string => typeof item === 'string')
        : [],
    }
  } catch {
    return undefined
  }
}

/**
 * 暂存本轮输入（UserPromptSubmit 调用）。同步落库，不依赖后台完成——
 * 这是「强行终止进程后仍可恢复」的前提。
 * @param store - 该轮的目标分库。
 * @param record - 本轮输入记录（prompt 应由调用方先行脱敏截断）。
 */
export async function recordTurnInput(store: EngramStore, record: TurnInputRecord): Promise<void> {
  await store.audit(INGEST_INPUT_OP, record.sessionId, JSON.stringify(record))
}

/**
 * 列出分库中全部未处理的暂存记录（含此前会话遗留的）。
 * @param store - 目标分库。
 * @returns 暂存条目（带原始 detail，供清除用）。
 */
export async function listTurnInputs(store: EngramStore): Promise<readonly TurnInputEntry[]> {
  const details = await store.listAuditDetails(INGEST_INPUT_OP)
  const entries: TurnInputEntry[] = []
  for (const detail of details) {
    const record = parseTurnInput(detail)
    if (record !== undefined) entries.push({ detail, record })
  }
  return entries
}

/**
 * 定位某一轮的暂存记录。
 * @param store - 目标分库。
 * @param sessionId - 会话 id。
 * @param turnId - 回合 id（null 表示匹配任意回合，取最新一条）。
 */
export async function findTurnInput(
  store: EngramStore,
  sessionId: string,
  turnId: string | null,
): Promise<TurnInputEntry | undefined> {
  const entries = await listTurnInputs(store)
  const mine = entries.filter(entry => entry.record.sessionId === sessionId)
  if (mine.length === 0) return undefined
  if (turnId === null) {
    // 无法定位具体回合：取最近一条，避免把所有同会话记录一起消费掉。
    return mine.reduce((latest, entry) => (entry.record.at >= latest.record.at ? entry : latest))
  }
  return mine.find(entry => entry.record.turnId === turnId)
}

/** 写入候选的结果计数。 */
interface WriteCandidatesResult {
  readonly written: number
  readonly duplicates: number
  readonly failed: number
}

/**
 * 写入一组候选：逐条脱敏 + 内容级去重 + 落库。
 * 只要有一条失败就返回 `failed > 0`，由调用方决定保留暂存待重试。
 */
async function writeCandidates(
  runtime: CodexRuntime,
  store: EngramStore,
  options: {
    readonly scope: CodexScope
    readonly projectRoot?: string
    readonly sessionId: string
    readonly candidates: readonly IngestCandidate[]
    readonly notes: string[]
  },
): Promise<WriteCandidatesResult> {
  let written = 0
  let duplicates = 0
  let failed = 0
  for (const candidate of options.candidates) {
    // 入库前协议剥离 + 密钥脱敏（与 engram_save 同一防线）。
    const content = redactSecrets(sanitizeProtocolText(candidate.content))
    if (content.trim() === '') continue
    const fingerprint = contentFingerprint(content)
    if (await store.hasAudit(INGEST_SEEN_OP, fingerprint)) {
      duplicates += 1
      options.notes.push(`跳过重复内容（跨轮同事实已入库）：${redactSecrets(content).slice(0, NOTE_EXCERPT)}…`)
      continue
    }
    try {
      const saved = await runtime.save({
        content,
        kind: candidate.kind,
        scope: options.scope,
        ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
        sessionId: options.sessionId,
        confidence: INGEST_CONFIDENCE,
      })
      await store.audit(INGEST_SEEN_OP, options.sessionId, fingerprint)
      options.notes.push(`摄取落库（${options.scope}/${saved.record.kind}）：${redactSecrets(content).slice(0, NOTE_EXCERPT)}…`)
      written += 1
    } catch (error) {
      failed += 1
      options.notes.push(`摄取写入失败（保留暂存待重试）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { written, duplicates, failed }
}

/** 处理一轮的结果。 */
export interface ProcessTurnResult {
  readonly found: boolean
  readonly written: number
  readonly duplicates: number
  readonly excluded: number
  readonly failed: number
  readonly done: boolean
}

/** `processTurnInput` 的参数。 */
export interface ProcessTurnOptions {
  readonly runtime: CodexRuntime
  readonly store: EngramStore
  readonly scope: CodexScope
  readonly projectRoot?: string
  readonly entry: TurnInputEntry
  readonly ingest: IngestMode
  /** true = 本轮没有项目上下文，写到了用户库（有实际写入时补一条告警）。 */
  readonly scopeIsFallback?: boolean
  /** Stop 提供的助手最终回复；`auto` 档提取用，未配置提取模型时不落库。 */
  readonly assistantMessage?: string | null
  readonly notes: string[]
}

/**
 * 处理一条暂存记录：提取 → 剔除召回复述 → 去重 → 落库 → 置 done。
 *
 * 失败时保留暂存并写 `ingest-pending`，下次 Hook 调用重试（已写入的条目靠内容指纹跳过，不会重复）。
 * 同一分库的处理在本进程内**串行**执行：首轮多个 Hook 事件可能并发触发，
 * 串行化可避免「检查指纹 → 写入」之间被并发插入而写出重复条目。
 * （跨进程并发由 SQLite 的 WAL + `BEGIN IMMEDIATE` 兜底；两个独立 Hook 进程各只处理自己那一轮。）
 * @param options - 处理参数。
 */
export async function processTurnInput(options: ProcessTurnOptions): Promise<ProcessTurnResult> {
  return serializePerStore(options.store, () => processTurnInputUnsafe(options))
}

/** 进程内串行化链：同一分库的摄取处理排队执行，前序失败不阻断后续。 */
const processingChains = new WeakMap<EngramStore, Promise<unknown>>()

function serializePerStore<T>(store: EngramStore, task: () => Promise<T>): Promise<T> {
  const previous = processingChains.get(store) ?? Promise.resolve()
  const next = previous.then(task, task)
  processingChains.set(store, next.catch(() => undefined))
  return next
}

async function processTurnInputUnsafe(options: ProcessTurnOptions): Promise<ProcessTurnResult> {
  const { runtime, store, scope, projectRoot, entry, ingest, notes } = options
  const { sessionId, turnId } = entry.record
  const doneKey = turnKey(sessionId, turnId)

  if (await store.hasAudit(INGEST_DONE_OP, doneKey)) {
    await store.clearAudit(INGEST_INPUT_OP, entry.detail)
    await store.clearAudit(INGEST_PENDING_OP, doneKey)
    notes.push(`第 ${turnId ?? '?'} 轮此前已摄取，清理暂存（幂等）`)
    return { found: true, written: 0, duplicates: 0, excluded: 0, failed: 0, done: true }
  }

  if (ingest === 'off') {
    await store.clearAudit(INGEST_INPUT_OP, entry.detail)
    return { found: true, written: 0, duplicates: 0, excluded: 0, failed: 0, done: true }
  }

  const candidates: IngestCandidate[] = extractExplicitMemories(entry.record.prompt)
    .map(memory => ({ content: memory.content, kind: memory.kind, explicit: true }))
  if (ingest === 'auto') {
    const hasReply = (options.assistantMessage ?? '').trim() !== ''
    notes.push(hasReply
      ? 'ingest=auto 尚未配置提取模型，本轮按 explicit 提取（助手回复仅用于将来提取，未落库）'
      : 'ingest=auto 尚未配置提取模型，本轮按 explicit 提取')
  }

  const { kept, excluded } = filterRecalledRestatements(candidates, entry.record.injected)
  if (excluded > 0) notes.push(`剔除 ${String(excluded)} 条召回复述（本轮已注入过的记忆）`)

  const { written, duplicates, failed } = await writeCandidates(runtime, store, {
    scope,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    sessionId,
    candidates: kept,
    notes,
  })
  if (written > 0 && options.scopeIsFallback === true) {
    notes.push('无项目上下文，摄取内容改记入用户库')
  }

  if (failed > 0) {
    if (!(await store.hasAudit(INGEST_PENDING_OP, doneKey))) {
      await store.audit(INGEST_PENDING_OP, sessionId, doneKey)
    }
    notes.push(`本轮 ${String(failed)} 条写入失败，已记 pending 待下次重试`)
    return { found: true, written, duplicates, excluded, failed, done: false }
  }

  await store.audit(INGEST_DONE_OP, sessionId, doneKey)
  await store.clearAudit(INGEST_INPUT_OP, entry.detail)
  await store.clearAudit(INGEST_PENDING_OP, doneKey)
  return { found: true, written, duplicates, excluded, failed, done: true }
}

/**
 * 排空分库里遗留的摄取任务（跨会话恢复：上次进程被强杀留下的暂存记录）。
 *
 * 只在**该分库内部**消费——暂存记录写在它自己那一轮的目标分库里，
 * 所以跨项目不会串库；另一个项目里遗留的任务要等下次在那个项目里开会话时才排空。
 * @param options - 排空参数。
 */
export async function drainTurnInputs(options: {
  readonly runtime: CodexRuntime
  readonly store: EngramStore
  readonly scope: CodexScope
  readonly projectRoot?: string
  readonly ingest: IngestMode
  /** 跳过正在即时处理的那一轮。 */
  readonly skip?: (record: TurnInputRecord) => boolean
  readonly notes: string[]
}): Promise<{ readonly drained: number; readonly written: number }> {
  const { runtime, store, scope, projectRoot, ingest, notes } = options
  let drained = 0
  let written = 0
  for (const entry of await listTurnInputs(store)) {
    if (options.skip?.(entry.record) === true) continue
    const result = await processTurnInput({
      runtime, store, scope,
      ...(projectRoot === undefined ? {} : { projectRoot }),
      entry, ingest, notes,
    })
    if (!result.found) continue
    drained += 1
    written += result.written
  }
  return { drained, written }
}

/**
 * 清理孤儿 pending 标记：对应轮次已有 done 标记（或暂存记录已消失）时，
 * pending 已无意义，直接出队。避免 `op_log` 里累积永不消费的 pending 行。
 * @param store - 目标分库。
 * @returns 清理条数。
 */
export async function clearResolvedPending(store: EngramStore): Promise<number> {
  const pendings = await store.listAuditDetails(INGEST_PENDING_OP)
  let cleared = 0
  for (const detail of pendings) {
    if (!(await store.hasAudit(INGEST_DONE_OP, detail))) continue
    await store.clearAudit(INGEST_PENDING_OP, detail)
    cleared += 1
  }
  return cleared
}
