/**
 * Codex Hook 事件契约：stdin JSON 的解析、stdout JSON 的构造、以及「明确要求记住」的标记提取。
 *
 * 三条纪律：
 * 1. **只用官方事件里的稳定字段**（`session_id` / `turn_id` / `cwd` / `prompt` / `last_assistant_message`），
 *    绝不解析 Codex 会话内部格式（`transcript_path` 只记录不使用）；
 * 2. `cwd` 是**会话**工作目录（宿主给的，可信）——hooks 侧据此解析项目库，不需要 MCP 那种 `projectRoot` 参数；
 * 3. 输出必须是合法 JSON（`hookSpecificOutput.additionalContext`），或干脆不输出；日志一律 stderr。
 * @module codex-engram/hook-events
 */

/** 本阶段接入的三个 hook 事件。 */
export type HookEventName = 'SessionStart' | 'UserPromptSubmit' | 'Stop'

/**
 * 摄取档位：`off` 不写；`explicit` 只写用户明确要求记住的内容（纯规则、零外部依赖）；
 * `auto` 再从对话提取（**必须显式配置可调用的提取模型**，未配置时按 explicit 处理并告警）。
 */
export type IngestMode = 'off' | 'explicit' | 'auto'

/** 解析后的 hook 输入（缺失字段一律归一为 null/''，调用方不必判 undefined）。 */
export interface HookInput {
  readonly event: HookEventName
  readonly sessionId: string
  readonly turnId: string | null
  /** 会话工作目录（可信项目上下文来源）。 */
  readonly cwd: string | null
  /** UserPromptSubmit：用户本轮输入。 */
  readonly prompt: string | null
  /** Stop：本轮最后一条助手回复（**可能不完整**，不作为完整对话依据）。 */
  readonly lastAssistantMessage: string | null
  /** SessionStart：startup / resume / clear / compact。 */
  readonly source: string | null
  /** Stop：true = 本次 Stop 由上一次 Stop 的继续决定触发（防自激循环）。 */
  readonly stopHookActive: boolean
}

/** 明确要求记住的一条候选。 */
export interface ExplicitMemory {
  readonly content: string
  readonly kind: 'fact' | 'preference'
}

/** 会话启动来源（Codex `SessionStart` 的 `source` 字段）。 */
export type SessionSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork'

/**
 * 归一 `source` 字段；未知值回落到 `startup`。
 *
 * 归一后**一律重新注入**长期记忆（不做「本会话已注入过」的永久标记）：
 * `compact`（上下文压缩）与 `fork`（分叉）会丢掉此前的注入结果，
 * 若按「已注入」短路，压缩后的会话将永久失去记忆。
 * @param raw - stdin 里的 `source` 原值。
 * @returns 归一后的来源；未知/缺失为 `startup`。
 */
export function normalizeSessionSource(raw: string | null): SessionSource {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'resume': return 'resume'
    case 'clear': return 'clear'
    case 'compact': return 'compact'
    case 'fork': return 'fork'
    default: return 'startup'
  }
}

/** 事件名归一化（大小写/别名容错）；未知事件返回 undefined。 */
export function normalizeEventName(raw: string | undefined): HookEventName | undefined {
  if (raw === undefined) return undefined
  const key = raw.trim().toLowerCase()
  if (key === 'sessionstart' || key === 'session_start') return 'SessionStart'
  if (key === 'userpromptsubmit' || key === 'user_prompt_submit') return 'UserPromptSubmit'
  if (key === 'stop') return 'Stop'
  return undefined
}

/** 取字符串字段（非字符串/空串归一为 null）。 */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 解析 hook stdin 文本。
 * @param raw - stdin 全文（JSON）。
 * @param fallbackEvent - 命令行传入的事件名（hooks.json 里 `runner.mjs SessionStart`）；与 stdin 冲突时以命令行优先。
 * @returns 归一化输入；JSON 非法或事件名无法确定时返回 undefined（调用方应静默退出，不打断会话）。
 */
export function parseHookInput(raw: string, fallbackEvent?: string): HookInput | undefined {
  let parsed: unknown
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const data = parsed as Record<string, unknown>
  const event = normalizeEventName(fallbackEvent) ?? normalizeEventName(str(data['hook_event_name']) ?? undefined)
  if (event === undefined) return undefined
  return {
    event,
    sessionId: str(data['session_id']) ?? 'unknown-session',
    turnId: str(data['turn_id']),
    cwd: str(data['cwd']),
    prompt: str(data['prompt']),
    lastAssistantMessage: str(data['last_assistant_message']),
    source: str(data['source']),
    stopHookActive: data['stop_hook_active'] === true,
  }
}

/**
 * 构造 additionalContext 输出（SessionStart / UserPromptSubmit 的注入通道）。
 * @param event - 事件名（写进 hookSpecificOutput.hookEventName）。
 * @param context - 注入正文（调用方已包 `<engram_memory_context>` 协议标签）。
 */
export function additionalContextOutput(event: HookEventName, context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: context,
    },
  })
}

/** 「记住」标记：中英文常见说法。 */
const EXPLICIT_MARKERS: readonly RegExp[] = [
  /(?:请|帮我|麻烦)?记(?:住|一下|下来|下来吧)[:：，,、\s]*/,
  /记录一下[:：，,、\s]*/,
  /别忘了[:：，,、\s]*/,
  /remember\s*(?:that)?\s*[:：]?\s*/i,
]

/** 偏好类线索词：命中则把显式记忆归为 preference 而不是 fact。 */
const PREFERENCE_HINTS: readonly RegExp[] = [/偏好/, /喜欢/, /习惯/, /不喜欢/, /讨厌/, /以后都/, /默认(?:用|走|按)/]

/** 单条显式记忆正文上限（超出截断，防止一句话吞掉整段对话）。 */
const EXPLICIT_MAX_CHARS = 400

/** 单轮最多提取的显式记忆条数（防误伤：一段话里出现多个「记住」时只取前几条）。 */
const EXPLICIT_MAX_ITEMS = 3

/**
 * 从用户输入里提取「明确要求记住」的内容（explicit 模式的唯一入口，纯规则、不需要模型）。
 *
 * 只认带标记的**同一行**内容：普通聊天不会被误存（这是 explicit 档的核心验收点）。
 * @param prompt - 用户本轮输入。
 * @returns 去重后的候选（最多 EXPLICIT_MAX_ITEMS 条）。
 */
export function extractExplicitMemories(prompt: string | null): readonly ExplicitMemory[] {
  if (prompt === null) return []
  const found: ExplicitMemory[] = []
  const seen = new Set<string>()
  for (const line of prompt.split('\n')) {
    const match = EXPLICIT_MARKERS
      .map(marker => marker.exec(line))
      .filter((hit): hit is RegExpExecArray => hit !== null)
      .sort((left, right) => left.index - right.index)[0]
    if (match === undefined) continue
    const content = line.slice(match.index + match[0].length).replace(/^[\s:：，,、。;；-]+/, '').trim()
    if (content.length < 4) continue
    const trimmed = content.length > EXPLICIT_MAX_CHARS ? content.slice(0, EXPLICIT_MAX_CHARS) : content
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    found.push({
      content: trimmed,
      kind: PREFERENCE_HINTS.some(hint => hint.test(trimmed)) ? 'preference' : 'fact',
    })
    if (found.length >= EXPLICIT_MAX_ITEMS) break
  }
  return found
}
