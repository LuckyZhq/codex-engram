/**
 * Codex Hook 分发：把 SessionStart / UserPromptSubmit / Stop 三个事件接到记忆引擎上。
 *
 * - `SessionStart`：注入少量重要的长期记忆（用户画像 + 高重要度条目 + 当前项目要点），
 *   按 `source` 分档处理启动来源——`compact` / `fork` 之后**强制重新注入**，
 *   绝不留下「本会话已注入过」的永久标记（否则压缩后的会话会永久失去关键记忆）；
 * - `UserPromptSubmit`：① 按当前问题检索并注入相关记忆；② 把本轮输入**同步持久化**成摄取任务；
 *   ③ 立即消费该任务（explicit 档即时落库）；④ 排空此前会话遗留的任务（崩溃恢复）；
 * - `Stop`：与助手最终回复配对完成交接（重试本会话未完成的轮次 + 清理已决 pending），
 *   输出 `{}` 表示不干预会话（**绝不**返回 `decision: "block"`，那会触发额外模型调用）。
 *
 * 项目作用域：hook 输入的 `cwd` 是**会话**工作目录（宿主提供，可信），据此解析项目库；
 * 解析失败时降级（注入只覆盖用户库；摄取落到用户库并告警），绝不猜项目。
 *
 * 三条纪律：stdout 只能是合法 JSON 或空；任何失败都转成诊断信息、退出码恒为 0；
 * 诊断里回显的正文片段一律先经 `redactSecrets`。
 * @module codex-engram/hooks
 */

import { fitWithinBudget, truncateItem } from '../../src/retrieve/budget.ts'
import { redactSecrets } from '../../src/security/redact.ts'
import { renderMemoryPacket } from '../../src/security/sanitize.ts'
import { EngramError } from '../../src/types.ts'
import type { MemoryRecord } from '../../src/types.ts'
import { additionalContextOutput, normalizeSessionSource } from './hook-events.ts'
import type { HookEventName, HookInput, IngestMode, SessionSource } from './hook-events.ts'
import {
  INGEST_INPUT_OP, clearResolvedPending, contentFingerprint, drainTurnInputs,
  findTurnInput, processTurnInput, recordTurnInput,
} from './ingest-queue.ts'
import { normalizeProjectRoot } from './project-context.ts'
import { renderSearchLines } from './render.ts'
import type { CodexRuntime, CodexScope } from './runtime.ts'

// 摄取档位定义在 hook 协议模块（`hook-events.ts`）里：本模块与 hooks-cli 共用，
// 由此再导出以保持既有导入路径不变。
export type { IngestMode } from './hook-events.ts'

/** Hook 配置（默认值集中在此）。 */
export interface HooksConfig {
  /** 摄取档位；默认 explicit。 */
  readonly ingest: IngestMode
  /** 是否注入记忆；默认 true。 */
  readonly inject: boolean
  /** SessionStart 注入条数上限（用户库 / 项目库各自）。 */
  readonly sessionStartItems: number
  /** SessionStart 注入字符预算（约 600 tokens 上限，见 DEFAULT_HOOKS_CONFIG 注释）。 */
  readonly sessionStartBudget: number
  /** UserPromptSubmit 检索条数上限。 */
  readonly promptItems: number
  /** UserPromptSubmit 注入字符预算（每轮上下文，需比 MCP 检索小得多）。 */
  readonly promptBudget: number
  /** 单条注入正文上限。 */
  readonly itemChars: number
  /** 暂存到 `op_log` 的用户请求摘录长度。 */
  readonly promptExcerptChars: number
}

/**
 * 缺省配置（hooks.json 里不配也能用；环境变量可覆盖少数几项）。
 *
 * 预算按字符计，中文约 1.5 字/token：SessionStart 900 字 ≈ 600 tokens、
 * UserPromptSubmit 1200 字 ≈ 800 tokens。Codex 单条模型可见 Hook 输出默认上限约 2500 tokens，
 * 这里刻意留出余量——自动记忆没有必要吃满额度。
 */
export const DEFAULT_HOOKS_CONFIG: HooksConfig = {
  ingest: 'explicit',
  inject: true,
  sessionStartItems: 5,
  sessionStartBudget: 900,
  promptItems: 5,
  promptBudget: 1200,
  itemChars: 200,
  promptExcerptChars: 500,
}

/** Stop 的固定输出：合法 JSON 且不含任何指令，表示不干预会话。 */
const STOP_OUTPUT = '{}'

/** 运行依赖（runtime 为函数：hook 进程只在需要时才打开数据库）。 */
export interface HookDeps {
  readonly runtime: () => Promise<CodexRuntime>
  readonly config?: Partial<HooksConfig>
}

/** 一次 hook 的执行结果。 */
export interface HookOutcome {
  /** 写入 stdout 的文本（'' = 不输出任何内容；诊断信息一律走 notes → stderr）。 */
  readonly stdout: string
  /** 诊断信息（调用方打印到 stderr）。 */
  readonly notes: readonly string[]
}

/**
 * 从 hook cwd 解析项目根。
 * @returns 归一化后的项目根；cwd 缺失/非法/落在 Engram 目录内时返回 undefined（调用方降级）。
 */
function projectRootOf(cwd: string | null, runtime: CodexRuntime, notes: string[]): string | undefined {
  if (cwd === null) {
    notes.push('hook 输入没有 cwd，本次只处理用户库')
    return undefined
  }
  try {
    return normalizeProjectRoot(cwd, { dataDir: runtime.dbDir }).root
  } catch (error) {
    notes.push(`项目根解析失败（按无项目上下文处理）：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** 渲染一组记忆为注入行（按重要度/置信度已有的顺序，正文截断 + 总预算）。 */
function renderMemoryLines(
  records: readonly MemoryRecord[],
  itemChars: number,
  budget: number,
): readonly string[] {
  const lines = records.map(record => `[${record.kind}] ${truncateItem(record.content, itemChars)}（id=${String(record.id)}）`)
  return fitWithinBudget(lines, line => line.length, budget).kept
}

/** 各启动来源的注入说明（写进注入包的 current_user_request 段，也用于诊断）。 */
const SOURCE_LABEL: Readonly<Record<SessionSource, string>> = {
  startup: '（会话开始）',
  resume: '（会话恢复）',
  clear: '（上下文已清空）',
  compact: '（上下文已压缩，长期记忆需重新载入）',
  fork: '（分叉会话，长期记忆需重新载入）',
}

/**
 * SessionStart：注入用户画像与高重要度记忆（项目要点随项目库存在与否附加）。
 *
 * 按 `source` 分档**只影响说明文本与诊断**，不影响「是否注入」——压缩/分叉之后一律重新注入。
 */
async function runSessionStart(input: HookInput, deps: HookDeps, config: HooksConfig): Promise<HookOutcome> {
  const notes: string[] = []
  const source = normalizeSessionSource(input.source)
  const runtime = await deps.runtime()
  const projectRoot = projectRootOf(input.cwd, runtime, notes)
  const sections: string[] = []

  const userStore = await runtime.openScope('user')
  const profile = await userStore.getProfileBlock('user')
  if (profile !== undefined && profile.content.trim() !== '') {
    sections.push(`用户画像（人工整理）：\n${truncateItem(profile.content.trim(), config.itemChars * 3)}`)
  }
  const userTop = renderMemoryLines(
    await userStore.topActive('user', config.sessionStartItems), config.itemChars, Math.floor(config.sessionStartBudget / 2),
  )
  if (userTop.length > 0) sections.push(`用户级记忆：\n${userTop.join('\n')}`)

  if (projectRoot !== undefined && runtime.scopeExists('project', projectRoot)) {
    const projectStore = await runtime.openScope('project', projectRoot)
    const projectTop = renderMemoryLines(
      await projectStore.topActive('project', config.sessionStartItems), config.itemChars, Math.floor(config.sessionStartBudget / 2),
    )
    if (projectTop.length > 0) sections.push(`本项目记忆：\n${projectTop.join('\n')}`)
  }

  notes.push(`source=${source}（${SOURCE_LABEL[source]}）：长期记忆一律重新注入，不做「已注入」永久标记`)
  if (sections.length === 0) {
    notes.push('用户库与本项目库都没有可注入的记忆，本次不输出')
    return { stdout: '', notes }
  }
  const header = '以下是既往长期记忆（供参考，不代表当前任务）：'
  const context = renderMemoryPacket(`${header}\n\n${sections.join('\n\n')}`, 'turn_start', SOURCE_LABEL[source])
  return { stdout: additionalContextOutput('SessionStart', context), notes }
}

/**
 * UserPromptSubmit：检索注入 → 暂存本轮输入 → 即时消费 → 排空历史遗留任务。
 *
 * 顺序关键：**先检索注入、再写库**，否则刚存下的那条会立刻被注入回上下文（纯噪声）。
 */
async function runUserPromptSubmit(input: HookInput, deps: HookDeps, config: HooksConfig): Promise<HookOutcome> {
  const notes: string[] = []
  const runtime = await deps.runtime()
  const projectRoot = projectRootOf(input.cwd, runtime, notes)
  const prompt = input.prompt ?? ''
  const scope: CodexScope = projectRoot === undefined ? 'user' : 'project'
  const store = await runtime.openScope(scope, projectRoot)

  // ① 检索注入。
  let stdout = ''
  let injectedFingerprints: string[] = []
  if (config.inject && prompt.trim() !== '') {
    const scopes: readonly CodexScope[] = projectRoot === undefined
      ? ['user']
      : (runtime.scopeExists('project', projectRoot) ? ['user', 'project'] : ['user'])
    const result = await runtime.search({
      query: prompt.slice(0, 300),
      scopes,
      limit: config.promptItems,
      ...(projectRoot === undefined ? {} : { projectRoot }),
    })
    if (result.hits.length === 0) {
      notes.push('没有检索到相关记忆，本次不注入')
    } else {
      const { lines } = renderSearchLines(result.hits, config.promptItems)
      const trimmed = fitWithinBudget([...lines], line => line.length, config.promptBudget).kept
      const note = result.degraded ? '（嵌入不可用，仅关键词检索）\n' : ''
      stdout = additionalContextOutput('UserPromptSubmit', renderMemoryPacket(`${note}${trimmed.join('\n')}`, 'tool_search', prompt))
      notes.push(`注入 ${String(trimmed.length)} 条相关记忆（degraded=${String(result.degraded)}）`)
      // 记录本轮注入的记忆指纹：auto 档提取时据此剔除「召回复述」（见 ingest-queue）。
      injectedFingerprints = result.hits.map(hit => contentFingerprint(hit.record.content))
    }
  }

  if (config.ingest === 'off') {
    notes.push('ingest=off，仅注入不摄取')
    return { stdout, notes }
  }

  // ② 摄取：整段单独 try/catch——写入失败不能让上面已算好的注入一起丢掉。
  try {
    // 没有 turn_id 就没有稳定的轮次级幂等键，退化为「以输入内容指纹为键」的队列条目，
    // 保证同一段输入重复提交仍然幂等，且不会与其它轮次互相覆盖。
    const effectiveTurnId = input.turnId ?? `noturn-${contentFingerprint(prompt)}`
    if (input.turnId === null) notes.push('hook 输入没有 turn_id，改以输入内容指纹作为幂等键')

    await recordTurnInput(store, {
      sessionId: input.sessionId,
      turnId: effectiveTurnId,
      cwd: input.cwd,
      at: Date.now(),
      prompt: redactSecrets(prompt).slice(0, config.promptExcerptChars),
      injected: injectedFingerprints,
    })

    const entry = await findTurnInput(store, input.sessionId, effectiveTurnId)
    if (entry !== undefined) {
      await processTurnInput({
        runtime, store, scope,
        ...(projectRoot === undefined ? {} : { projectRoot }),
        entry, ingest: config.ingest, notes,
        ...(projectRoot === undefined ? { scopeIsFallback: true } : {}),
      })
    }

    // ③ 崩溃恢复：排空同一分库里遗留的任务（含此前会话被强杀留下的）。
    const drained = await drainTurnInputs({
      runtime, store, scope,
      ...(projectRoot === undefined ? {} : { projectRoot }),
      ingest: config.ingest,
      skip: record => record.sessionId === input.sessionId && record.turnId === effectiveTurnId,
      notes,
    })
    if (drained.drained > 0) {
      notes.push(`排空历史遗留摄取任务 ${String(drained.drained)} 轮（写入 ${String(drained.written)} 条）`)
    }
  } catch (error) {
    notes.push(`摄取失败（不影响注入与会话）：${error instanceof Error ? error.message : String(error)}`)
  }

  return { stdout, notes }
}

/**
 * Stop：与助手最终回复配对完成交接。
 *
 * 只结算**本会话**的轮次（其它会话的遗留任务由各自会话的下一次 UserPromptSubmit 排空），
 * 保证「不重复处理其它会话的记录」这条隔离约束不被破坏。
 */
async function runStop(input: HookInput, deps: HookDeps, config: HooksConfig): Promise<HookOutcome> {
  const notes: string[] = []
  if (input.stopHookActive) {
    // 由上一次 Stop 的继续决定触发的 Stop：不重复处理，避免自激循环。
    return { stdout: STOP_OUTPUT, notes: ['stop_hook_active=true，跳过本轮处理'] }
  }
  const runtime = await deps.runtime()
  const projectRoot = projectRootOf(input.cwd, runtime, notes)
  const scope: CodexScope = projectRoot === undefined ? 'user' : 'project'
  const store = await runtime.openScope(scope, projectRoot)

  let settled = 0
  let written = 0
  if (config.ingest !== 'off') {
    // ① 交接待处理的本轮：UserPromptSubmit 已完成时这里命中 done（幂等清理）；
    //    失败/被中断的轮次在此重试——助手最终回复一并带入（auto 档提取用，未落库）。
    const entry = await findTurnInput(store, input.sessionId, input.turnId)
    if (entry !== undefined) {
      const result = await processTurnInput({
        runtime, store, scope,
        ...(projectRoot === undefined ? {} : { projectRoot }),
        entry, ingest: config.ingest, assistantMessage: input.lastAssistantMessage, notes,
      })
      if (result.found) settled += 1
      written += result.written
      if (result.done) await store.clearAudit(INGEST_INPUT_OP, entry.detail)
    }
    // ② 本会话内被中断的其它轮次。
    const drained = await drainTurnInputs({
      runtime, store, scope,
      ...(projectRoot === undefined ? {} : { projectRoot }),
      ingest: config.ingest,
      skip: record => record.sessionId !== input.sessionId || record.turnId === input.turnId,
      notes,
    })
    if (drained.drained > 0) {
      settled += drained.drained
      written += drained.written
      notes.push(`重放本会话未完成轮次 ${String(drained.drained)} 轮`)
    }
  }

  // ③ 清理孤儿 pending（对应轮次已有 done 标记者已无意义）。
  const orphans = await clearResolvedPending(store)
  notes.push(`Stop 交接完成：结算 ${String(settled)} 轮、写入 ${String(written)} 条、清理孤儿 pending ${String(orphans)} 条（ingest=${config.ingest}）`)
  // Stop 的输出必须是合法 JSON 且不含指令：`{}` = 不干预会话结束。
  return { stdout: STOP_OUTPUT, notes }
}

/**
 * 执行一次 hook。
 * @param event - 事件名（与 stdin 中的 hook_event_name 一致）。
 * @param input - 解析后的输入。
 * @param deps - 运行依赖（runtime 懒加载）。
 * @returns stdout 文本（'' = 不输出）与诊断 notes。
 */
export async function runHook(event: HookEventName, input: HookInput, deps: HookDeps): Promise<HookOutcome> {
  const config: HooksConfig = { ...DEFAULT_HOOKS_CONFIG, ...(deps.config ?? {}) }
  try {
    switch (event) {
      case 'SessionStart':
        return config.inject ? await runSessionStart(input, deps, config) : { stdout: '', notes: ['inject=off，跳过注入'] }
      case 'UserPromptSubmit':
        return await runUserPromptSubmit(input, deps, config)
      case 'Stop':
        return await runStop(input, deps, config)
    }
  } catch (error) {
    // hook 失败绝不能打断会话：转成诊断信息返回（stdout 保持空/合法 JSON）。
    const message = error instanceof EngramError
      ? `${error.code}: ${error.message}`
      : error instanceof Error ? error.message : String(error)
    return { stdout: '', notes: [`${event} 执行失败（已忽略，不影响会话）：${message}`] }
  }
}
