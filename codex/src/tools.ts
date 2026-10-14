/**
 * MCP 六工具的实现：参数校验 → **项目作用域路由** → 调用 `CodexRuntime` → 输出裁剪。
 *
 * 本模块只做适配，不复制记忆引擎：所有读写都经 `CodexRuntime`（其背后是原项目
 * `EngramStore`），因此 `search` 的命中强化、`update` 的取代链、`forget` 的软删语义
 * 与 DSH 插件、Web 管理页完全一致。
 *
 * 工具契约（与 DSH 侧 engram_* 同名，便于提示词互通）：
 * `engram_save` / `engram_search` / `engram_list` / `engram_get` / `engram_update` / `engram_forget`
 * @module codex-engram/tools
 */

import { z } from 'zod'
import type { EngramKind, EngramScope, EngramStatus } from '../../src/types.ts'
import { EngramError } from '../../src/types.ts'
import { renderMemoryPacket } from '../../src/security/sanitize.ts'
import {
  GET_CONTENT_MAX_CHARS, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, SAVE_CONTENT_MAX_CHARS,
  SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, recordSummary, renderListLines, renderRecordDetail, renderSearchLines,
} from './render.ts'
import {
  PROJECT_CONTEXT_REQUIRED_MESSAGE, PROJECT_ROOT_ENV, requireProjectContext, resolveProjectContext,
} from './project-context.ts'
import type { ProjectContext } from './project-context.ts'
import type { CodexRuntime, CodexScope } from './runtime.ts'

/** 工具依赖。 */
export interface CodexToolDeps {
  /** 运行时读取器（**函数而非实例**）：MCP 启动期不创建 Runtime，首次工具调用才实例化。 */
  readonly runtime: () => CodexRuntime
  /** 进程环境（读 `ENGRAM_PROJECT_ROOT`）。 */
  readonly env: NodeJS.ProcessEnv
  /** MCP 客户端提供的 workspace roots（`roots/list`）；undefined = 客户端未声明 roots 能力。 */
  readonly clientRoots?: () => Promise<readonly string[]>
  /** 插件安装目录（拒绝把它当项目根）。 */
  readonly pluginRoot?: string
}

/** 工具返回值（对齐 MCP CallToolResult 的可用子集）。
 *  索引签名是 SDK 回调契约的一部分（CallToolResult 形如 `{[x: string]: unknown; content: …}`），
 *  缺失它 TS 会拒绝把本结果交给 `registerTool`。 */
export interface CodexToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** 记忆记录的作用域 → Codex 侧作用域（DSH 的 shared 在 Codex 侧不开放：一律按项目库处理）。 */
function codexScopeOf(scope: EngramScope): CodexScope {
  return scope === 'user' ? 'user' : 'project'
}

/** 工具注解（照实描述副作用：检索会强化记忆，故不是只读）。 */
export interface CodexToolAnnotations {
  readonly title: string
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  readonly openWorldHint: boolean
}

/** 一条工具定义。 */
export interface CodexToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, z.ZodType>
  readonly outputSchema: Record<string, z.ZodType>
  readonly annotations: CodexToolAnnotations
  readonly handler: (args: Record<string, unknown>) => Promise<CodexToolResult>
}

const KINDS = ['fact', 'preference', 'decision', 'episode', 'skill'] as const
const SCOPES = ['user', 'project'] as const
const STATUSES = ['active', 'archived', 'forgotten'] as const

/** 文本结果（成功）。 */
function textResult(text: string, structuredContent: Record<string, unknown>): CodexToolResult {
  return { content: [{ type: 'text', text }], structuredContent }
}

/** 错误结果：机器可读 code + 可执行提示（模型据此自我纠正）。 */
function errorResult(code: string, message: string): CodexToolResult {
  return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true }
}

/** 把异常映射成协议内的工具失败（不把栈丢给模型；未预期错误落 stderr 便于排查）。 */
async function runTool(name: string, body: () => Promise<CodexToolResult>): Promise<CodexToolResult> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof EngramError) return errorResult(error.code, error.message)
    console.error(`[codex-engram] ${name} 未预期失败：`, error)
    const message = error instanceof Error ? error.message : String(error)
    return errorResult('INTERNAL_ERROR', `${name} 内部错误：${message}`)
  }
}

/**
 * 构造六个工具定义。
 * @param deps - 运行时与项目上下文来源。
 */
export function createCodexTools(deps: CodexToolDeps): readonly CodexToolDefinition[] {
  /** 取运行时（handler 内调用，保证按需初始化）。 */
  const rt = (): CodexRuntime => deps.runtime()

  /** 项目上下文解析入参（含拒绝名单：数据目录与插件目录）。 */
  const contextDeps = (projectRoot?: string) => ({
    env: deps.env,
    dataDir: rt().dbDir,
    ...(deps.pluginRoot === undefined ? {} : { rejectRoots: [deps.pluginRoot] }),
    ...(deps.clientRoots === undefined ? {} : { clientRoots: deps.clientRoots }),
    ...(projectRoot === undefined || projectRoot.trim() === '' ? {} : { projectRoot }),
  })

  /** 尽力解析项目上下文（读工具用）：拿不到返回 undefined，不抛错。 */
  const tryContext = async (projectRoot?: string): Promise<ProjectContext | undefined> =>
    resolveProjectContext(contextDeps(projectRoot))

  /** 要求项目上下文（写工具用）：拿不到则 loud 失败。 */
  const needContext = async (projectRoot?: string): Promise<ProjectContext> =>
    requireProjectContext(await resolveProjectContext(contextDeps(projectRoot)))

  /** 项目上下文的一行说明（写进输出，便于排查串库）。 */
  const contextNote = (context: ProjectContext): string =>
    `项目根 ${context.root}（${context.identity.source === 'origin' ? 'git origin 归一化' : 'cwd 兜底'}分库 ${context.identity.dbName}，来源 ${context.source}${context.gitBacked ? '' : '，非 git 仓库：隔离强度较弱'}）`

  const save: CodexToolDefinition = {
    name: 'engram_save',
    description: [
      '保存一条长期记忆（跨会话可用）。kind：fact 事实 / preference 偏好 / decision 决策 / episode 经历 / skill 方法。',
      'scope="project"（默认）写入当前项目库：必须能确定项目——请传 projectRoot=当前工作区根目录（或由宿主配置 ',
      `${PROJECT_ROOT_ENV}）；无法确定项目时本工具会拒绝写入，不会静默写进用户库。`,
      'scope="user" 写全局用户库，用于与具体项目无关的偏好与通用事实。内容一句话完整表达，不要存聊天记录原文。',
    ].join(''),
    inputSchema: {
      content: z.string().min(1).max(SAVE_CONTENT_MAX_CHARS).describe('记忆正文（一句话完整表达，≤2000 字）'),
      kind: z.enum(KINDS).describe('记忆种类'),
      scope: z.enum(SCOPES).optional().describe('作用域，默认 project（仅当前项目）；user 为全局'),
      projectRoot: z.string().optional().describe('当前工作区根目录绝对路径（scope=project 时必需，除非宿主已配置 ENGRAM_PROJECT_ROOT）'),
      importance: z.number().min(0).max(1).optional().describe('重要性 0-1，默认 0.5'),
      placard: z.string().max(60).optional().describe('门牌铭牌（可选，4-30 字，唯一且带日期锚点）'),
    },
    outputSchema: {
      id: z.string(),
      kind: z.string(),
      scope: z.string(),
      disposition: z.enum(['accept', 'merge', 'defer']),
      degraded: z.boolean(),
      dbName: z.string(),
      projectRoot: z.string().optional(),
      mergedInto: z.string().optional(),
      message: z.string(),
    },
    annotations: { title: '保存记忆', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (args) => runTool('engram_save', async () => {
      const content = args.content as string
      // 长度红线在 handler 内再兜一次（不只依赖 SDK 的 schema 校验）：超长记忆既费 token 又难召回。
      if (content.length > SAVE_CONTENT_MAX_CHARS) {
        throw new EngramError('SAVE_CONTENT_TOO_LONG', `正文 ${String(content.length)} 字超过上限 ${String(SAVE_CONTENT_MAX_CHARS)} 字：请拆成多条更聚焦的记忆。`)
      }
      const kind = args.kind as EngramKind
      const scope = (args.scope as CodexScope | undefined) ?? 'project'
      const projectRootArg = args.projectRoot as string | undefined
      const context = scope === 'project' ? await needContext(projectRootArg) : undefined
      const result = await rt().save({
        content,
        kind,
        scope,
        ...(context === undefined ? {} : { projectRoot: context.root }),
        ...(args.importance === undefined ? {} : { importance: args.importance as number }),
        ...(args.placard === undefined ? {} : { placard: args.placard as string }),
      })
      const dbName = rt().scopeDbName(scope, context?.root)
      const where = context === undefined ? '用户库（全局）' : contextNote(context)
      const message = result.disposition === 'merge'
        ? `与既有记忆高度重复（相似度 ${(result.similarity ?? 0).toFixed(2)}），已并入 ${String(result.mergedInto)} 并强化其置信度，未新建条目。若这是修正而非复述，请用 engram_update。`
        : result.disposition === 'defer'
          ? `已保存 ${String(result.record.id)}。注意：与既有记忆高度相似（可能是修正或矛盾）：${(result.contradictions ?? []).map(id => `id=${id}`).join('、')}。若为修正请用 engram_update 归并。`
          : `已保存记忆 ${String(result.record.id)}（kind=${result.record.kind}, scope=${result.record.scope}）。后续会话可用 engram_search 召回。`
      const degradedNote = result.degraded ? '\n（嵌入不可用：本条仅参与关键词检索）' : ''
      const structured = {
        id: String(result.record.id),
        kind: result.record.kind,
        scope: result.record.scope,
        disposition: result.disposition,
        degraded: result.degraded,
        dbName,
        ...(context === undefined ? {} : { projectRoot: context.root }),
        ...(result.mergedInto === undefined ? {} : { mergedInto: String(result.mergedInto) }),
        message,
      }
      return textResult(`${message}\n写入 ${where}${degradedNote}`, structured)
    }),
  }

  const search: CodexToolDefinition = {
    name: 'engram_search',
    description: [
      '检索长期记忆（关键词 + 语义混合）。scope 默认 all（用户库 + 当前项目库），limit 默认 5、上限 20。',
      '要检索项目库需要项目上下文：传 projectRoot，或由宿主配置 ',
      `${PROJECT_ROOT_ENV}；缺失时只检索用户库并在结果里标注跳过项目库（不会猜）。`,
      '注意：命中的记忆会被强化（访问次数/置信度上升），本工具不是只读操作。',
    ].join(''),
    inputSchema: {
      query: z.string().min(1).max(500).describe('检索文本'),
      scope: z.enum(['user', 'project', 'all']).optional().describe('检索范围，默认 all'),
      projectRoot: z.string().optional().describe('当前工作区根目录绝对路径（检索项目库时需要）'),
      limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional().describe(`返回条数，默认 ${String(SEARCH_DEFAULT_LIMIT)}，上限 ${String(SEARCH_MAX_LIMIT)}`),
      room: z.string().optional().describe('房间路由（可选）：只在指定房间内检索，如「决策堂」'),
    },
    outputSchema: {
      degraded: z.boolean(),
      count: z.number(),
      scopesSearched: z.array(z.string()),
      projectScopeSkipped: z.boolean(),
      projectRoot: z.string().optional(),
      hits: z.array(z.object({
        id: z.string(),
        scope: z.string(),
        kind: z.string(),
        score: z.number(),
        via: z.string(),
        summary: z.string(),
      })),
      message: z.string(),
    },
    // readOnlyHint=false：命中强化会写库（访问次数/置信度），如实声明副作用。
    annotations: { title: '检索记忆', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (args) => runTool('engram_search', async () => {
      const query = args.query as string
      const scope = (args.scope as 'user' | 'project' | 'all' | undefined) ?? 'all'
      const limit = Math.min((args.limit as number | undefined) ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT)
      const projectRootArg = args.projectRoot as string | undefined
      const context = scope === 'user' ? undefined : await tryContext(projectRootArg)
      if (scope === 'project' && context === undefined) {
        throw new EngramError('PROJECT_CONTEXT_REQUIRED', PROJECT_CONTEXT_REQUIRED_MESSAGE)
      }
      const scopes: readonly CodexScope[] = scope === 'user'
        ? ['user']
        : context === undefined ? ['user'] : ['user', 'project']
      const result = await rt().search({
        query,
        scopes,
        limit,
        ...(context === undefined ? {} : { projectRoot: context.root }),
        ...(args.room === undefined ? {} : { rooms: [args.room as string] }),
      })
      const { lines, dropped } = renderSearchLines(result.hits, limit)
      const projectScopeSkipped = scope !== 'user' && context === undefined
      const notes = [
        result.degraded ? '（嵌入不可用，仅关键词检索）' : '',
        args.room === undefined ? '' : `（房间路由：${String(args.room)}）`,
        projectScopeSkipped ? `（未检索项目库：无法确定当前项目，请传 projectRoot 或配置 ${PROJECT_ROOT_ENV}）` : '',
        context === undefined ? '' : `（项目库：${context.root}）`,
        dropped > 0 ? `（另有 ${String(dropped)} 条超出输出预算未展示）` : '',
      ].filter(note => note !== '')
      const body = `${notes.length === 0 ? '' : `${notes.join('\n')}\n`}${lines.length === 0 ? '没有找到相关记忆。' : lines.join('\n')}`
      const structured = {
        degraded: result.degraded,
        count: result.hits.length,
        scopesSearched: scopes.map(String),
        projectScopeSkipped,
        ...(context === undefined ? {} : { projectRoot: context.root }),
        hits: result.hits.map(hit => ({
          id: String(hit.record.id),
          scope: hit.record.scope,
          kind: hit.record.kind,
          score: Number.isFinite(hit.score) ? Number(hit.score.toFixed(4)) : 0,
          via: hit.via,
          summary: recordSummary(hit.record).summary as string,
        })),
        message: result.hits.length === 0 ? '无命中' : `命中 ${String(result.hits.length)} 条`,
      }
      // 记忆正文是不可信历史文本：包协议标签后再交给模型（当前请求 = 检索词本身）。
      return textResult(renderMemoryPacket(body, 'tool_search', query), structured)
    }),
  }

  const list: CodexToolDefinition = {
    name: 'engram_list',
    description: [
      '分页列出记忆（含已归档/已遗忘状态，按创建时间倒序）。scope 默认 project（需要项目上下文：传 projectRoot 或配置 ',
      `${PROJECT_ROOT_ENV}），可用 status/kind/q 过滤，limit 默认 ${String(LIST_DEFAULT_LIMIT)}、上限 ${String(LIST_MAX_LIMIT)}。`,
      '用于盘点与找 id，不做语义排序；按内容找记忆请用 engram_search。',
    ].join(''),
    inputSchema: {
      scope: z.enum(SCOPES).optional().describe('作用域，默认 project'),
      projectRoot: z.string().optional().describe('当前工作区根目录绝对路径（scope=project 时需要）'),
      status: z.enum(STATUSES).optional().describe('状态过滤：active / archived / forgotten'),
      kind: z.enum(KINDS).optional().describe('种类过滤'),
      q: z.string().max(200).optional().describe('内容子串过滤'),
      limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional().describe(`每页条数，默认 ${String(LIST_DEFAULT_LIMIT)}`),
      offset: z.number().int().min(0).optional().describe('分页偏移，默认 0'),
    },
    outputSchema: {
      scope: z.string(),
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      projectRoot: z.string().optional(),
      records: z.array(z.object({
        id: z.string(),
        scope: z.string(),
        kind: z.string(),
        status: z.string(),
        importance: z.number(),
        confidence: z.number(),
        createdAt: z.number(),
        accessCount: z.number(),
        summary: z.string(),
        slot: z.object({ room: z.string(), index: z.number() }).optional(),
      })),
      message: z.string(),
    },
    annotations: { title: '列出记忆', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (args) => runTool('engram_list', async () => {
      const scope = (args.scope as CodexScope | undefined) ?? 'project'
      const projectRootArg = args.projectRoot as string | undefined
      const context = scope === 'project' ? await needContext(projectRootArg) : undefined
      const limit = Math.min((args.limit as number | undefined) ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT)
      const offset = (args.offset as number | undefined) ?? 0
      const result = await rt().list({
        scope,
        limit,
        offset,
        ...(context === undefined ? {} : { projectRoot: context.root }),
        ...(args.status === undefined ? {} : { status: args.status as EngramStatus }),
        ...(args.kind === undefined ? {} : { kind: args.kind as EngramKind }),
        ...(args.q === undefined ? {} : { q: args.q as string }),
      })
      const { lines, dropped } = renderListLines(result.records)
      const head = `共 ${String(result.total)} 条（本页 ${String(result.records.length)} 条，offset=${String(offset)}）${context === undefined ? '· 用户库' : `· 项目库 ${context.root}`}`
      const note = dropped > 0 ? `\n（另有 ${String(dropped)} 条超出输出预算未展示：降低 limit 或翻页）` : ''
      const body = `${head}\n${lines.length === 0 ? '没有符合条件的记忆。' : lines.join('\n')}${note}`
      const structured = {
        scope,
        total: result.total,
        limit,
        offset,
        ...(context === undefined ? {} : { projectRoot: context.root }),
        records: result.records.map(recordSummary),
        message: `返回 ${String(result.records.length)}/${String(result.total)} 条`,
      }
      return textResult(renderMemoryPacket(body, 'tool_review', `engram_list scope=${scope} offset=${String(offset)}`), structured)
    }),
  }

  const get: CodexToolDefinition = {
    name: 'engram_get',
    description: '按 id 精确读取一条记忆的完整正文与元数据（重要性/置信度/状态/桩位/复习排期）。id 来自 engram_search 或 engram_list。需要读项目库时传 projectRoot；不给 scope 时先在用户库找，再在项目库找。',
    inputSchema: {
      id: z.string().min(1).describe('记忆 id（engram_search/engram_list 输出的 id=…）'),
      scope: z.enum(SCOPES).optional().describe('作用域；缺省自动定位（先 user 后 project）'),
      projectRoot: z.string().optional().describe('当前工作区根目录绝对路径（读取项目库时需要）'),
    },
    outputSchema: {
      id: z.string(),
      scope: z.string(),
      kind: z.string(),
      status: z.string(),
      content: z.string(),
      importance: z.number(),
      confidence: z.number(),
      accessCount: z.number(),
      dbName: z.string(),
      metadata: z.record(z.string(), z.unknown()),
    },
    annotations: { title: '读取记忆', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (args) => runTool('engram_get', async () => {
      const id = args.id as string
      const scope = args.scope as CodexScope | undefined
      const projectRootArg = args.projectRoot as string | undefined
      const context = scope === 'user' ? undefined : await tryContext(projectRootArg)
      if (scope === 'project' && context === undefined) {
        throw new EngramError('PROJECT_CONTEXT_REQUIRED', PROJECT_CONTEXT_REQUIRED_MESSAGE)
      }
      // 不给 scope：有项目上下文时先在项目库找，再在用户库找；无上下文时只找用户库。
      const lookup = scope !== undefined
        ? { scope, ...(context === undefined ? {} : { projectRoot: context.root }) }
        : context === undefined ? { scope: 'user' as CodexScope } : { projectRoot: context.root }
      const record = await rt().get(id, lookup)
      if (record === undefined) {
        throw new EngramError('NOT_FOUND', `条目 ${id} 不存在于${scope === undefined ? '可访问的' : `${scope} `}记忆库（用 engram_search/engram_list 确认 id 与 scope）`)
      }
      const body = renderRecordDetail(record)
      const structured = {
        id: String(record.id),
        scope: record.scope,
        kind: record.kind,
        status: record.status,
        content: record.content.length <= GET_CONTENT_MAX_CHARS ? record.content : record.content.slice(0, GET_CONTENT_MAX_CHARS),
        importance: record.importance,
        confidence: record.confidence,
        accessCount: record.accessCount,
        dbName: rt().scopeDbName(codexScopeOf(record.scope), context?.root),
        metadata: {
          createdAt: record.createdAt,
          lastAccessedAt: record.lastAccessedAt,
          sourceSessionId: record.sourceSessionId ?? null,
          sourceRound: record.sourceRound ?? null,
          slot: record.slot === undefined ? null : { room: record.slot.room, index: record.slot.index },
          placard: record.imagery?.caption ?? null,
          outcome: record.outcome ?? null,
        },
      }
      return textResult(renderMemoryPacket(body, 'tool_review', `engram_get id=${id}`), structured)
    }),
  }

  const update: CodexToolDefinition = {
    name: 'engram_update',
    description: '修正一条记忆：写入修正后的新条目并把旧条目归档（取代链保留，可审计）。返回新 id 与被取代的旧 id。id 来自 engram_search/engram_list；项目库需要 projectRoot 或 ENGRAM_PROJECT_ROOT。',
    inputSchema: {
      id: z.string().min(1).describe('要修正的旧条目 id'),
      content: z.string().min(1).max(SAVE_CONTENT_MAX_CHARS).describe('修正后的正文（≤2000 字）'),
      scope: z.enum(SCOPES).optional().describe('旧条目作用域，默认 project'),
      projectRoot: z.string().optional().describe('当前工作区根目录绝对路径（项目库需要）'),
      kind: z.enum(KINDS).optional().describe('种类，缺省继承旧条目'),
      importance: z.number().min(0).max(1).optional().describe('重要性 0-1，缺省继承旧条目'),
      placard: z.string().max(60).optional().describe('门牌铭牌（可选，替换旧门牌）'),
    },
    outputSchema: {
      id: z.string(),
      superseded: z.string(),
      kind: z.string(),
      scope: z.string(),
      dbName: z.string(),
      projectRoot: z.string().optional(),
      message: z.string(),
    },
    annotations: { title: '修正记忆', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async (args) => runTool('engram_update', async () => {
      const id = args.id as string
      const content = args.content as string
      if (content.length > SAVE_CONTENT_MAX_CHARS) {
        throw new EngramError('SAVE_CONTENT_TOO_LONG', `正文 ${String(content.length)} 字超过上限 ${String(SAVE_CONTENT_MAX_CHARS)} 字：请拆成多条更聚焦的记忆。`)
      }
      const scope = (args.scope as CodexScope | undefined) ?? 'project'
      const projectRootArg = args.projectRoot as string | undefined
      const context = scope === 'project' ? await needContext(projectRootArg) : undefined
      const record = await rt().update({
        id,
        content,
        scope,
        ...(context === undefined ? {} : { projectRoot: context.root }),
        ...(args.kind === undefined ? {} : { kind: args.kind as EngramKind }),
        ...(args.importance === undefined ? {} : { importance: args.importance as number }),
        ...(args.placard === undefined ? {} : { placard: args.placard as string }),
      })
      const message = `已写入修正记忆 ${String(record.id)}；旧条目 ${id} 已归档并建立取代链。`
      return textResult(message, {
        id: String(record.id),
        superseded: id,
        kind: record.kind,
        scope: record.scope,
        dbName: rt().scopeDbName(scope, context?.root),
        ...(context === undefined ? {} : { projectRoot: context.root }),
        message,
      })
    }),
  }

  const forget: CodexToolDefinition = {
    name: 'engram_forget',
    description: `遗忘一条记忆（软删除，可恢复；不是物理删除）。可选留下墓志铭三问 reason/affects/stillUseful——要么都填、要么都不填，填了就记入审计日志便于日后考古。id 来自 engram_search/engram_list；项目库需要 projectRoot 或 ${PROJECT_ROOT_ENV}。`,
    inputSchema: {
      id: z.string().min(1).describe('条目 id'),
      scope: z.enum(SCOPES).optional().describe('条目作用域，默认 project'),
      projectRoot: z.string().optional().describe('当前工作区根目录绝对路径（项目库需要）'),
      reason: z.string().max(500).optional().describe('墓志铭·为什么关（被取代/过期/与现实不符/隐私等）'),
      affects: z.string().max(500).optional().describe('墓志铭·影响谁（条目/人/项目；不适用填空串）'),
      stillUseful: z.string().max(500).optional().describe('墓志铭·还有用吗（留给未来的线索）'),
    },
    outputSchema: {
      id: z.string(),
      status: z.string(),
      scope: z.string(),
      dbName: z.string(),
      projectRoot: z.string().optional(),
      tombstone: z.boolean(),
      message: z.string(),
    },
    annotations: { title: '遗忘记忆', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (args) => runTool('engram_forget', async () => {
      const id = args.id as string
      const scope = (args.scope as CodexScope | undefined) ?? 'project'
      const projectRootArg = args.projectRoot as string | undefined
      const context = scope === 'project' ? await needContext(projectRootArg) : undefined
      const parts = { reason: args.reason, affects: args.affects, stillUseful: args.stillUseful }
      const given = Object.values(parts).filter(value => typeof value === 'string' && value.trim() !== '')
      if (given.length > 0 && given.length < 3) {
        const missing = Object.entries(parts).filter(([, value]) => typeof value !== 'string' || value.trim() === '').map(([key]) => key)
        throw new EngramError('TOMBSTONE_INCOMPLETE', `墓志铭三问要么都填要么都不填；缺：${missing.join('、')}`)
      }
      const record = await rt().forget(id, {
        scope,
        ...(context === undefined ? {} : { projectRoot: context.root }),
        ...(given.length === 3
          ? { tombstone: { reason: parts.reason as string, affects: parts.affects as string, stillUseful: parts.stillUseful as string } }
          : {}),
      })
      const message = `记忆 ${String(record.id)} 已遗忘（软删，可用 engram_list status=forgotten 找到并恢复）。${given.length === 3 ? '墓志铭已记入审计日志。' : ''}`
      return textResult(message, {
        id: String(record.id),
        status: record.status,
        scope: record.scope,
        dbName: rt().scopeDbName(scope, context?.root),
        ...(context === undefined ? {} : { projectRoot: context.root }),
        tombstone: given.length === 3,
        message,
      })
    }),
  }

  return [save, search, list, get, update, forget]
}
