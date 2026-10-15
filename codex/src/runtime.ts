/**
 * Codex Runtime：宿主无关的 SQLite 记忆引擎装配层。
 *
 * 复用 DSH 侧同一套存储实现（`src/store/sqlite.ts` + `src/project/identity.ts` +
 * `src/security/*` + `src/write-disposition.ts`），只替换宿主专属部分：
 * 配置面（无 schemastery）、数据目录（`$CODEX_HOME/engram`）、辅助 LLM 调用（后续阶段接入）。
 * 数据库 schema、迁移机制、分库命名与作用域语义保持与 DSH 完全一致——同一份库文件
 * 两个宿主都能打开，不会产生格式分叉。
 *
 * 项目作用域有三种解析口径（互斥，同时给会 loud 拒绝）：
 * - 默认口径（`projectRoot` 缺省）：用配置里的 `cwd`——hook 链路拿得到会话 cwd，走这条。
 * - 显式口径（每次调用传 `projectRoot`）：MCP 进程的 cwd 是插件安装目录而非工作区，
 *   因此项目作用域必须逐调用解析（见 `codex/src/project-context.ts` 的可信来源与校验）。
 * - 选择器口径（传 `projectDbName`）：WebAPI 只有面板给的 dbName，拿不到工作目录，
 *   按已存在的库精确定位（复用 `openExistingProjectDb`，不建空库）。
 * @module codex-engram/runtime
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createLocalEmbedder } from '../../src/embedder/local.ts'
import type { EngramEmbedder } from '../../src/embedder/interface.ts'
import { migrateProjectDb, migrationWarning, resolveProjectIdentity } from '../../src/project/identity.ts'
import type { ProjectIdentity } from '../../src/project/identity.ts'
import { redactSecrets } from '../../src/security/redact.ts'
import { sanitizeProtocolText } from '../../src/security/sanitize.ts'
import type { EngramStore } from '../../src/store/interface.ts'
import { openEngramStore } from '../../src/store/sqlite.ts'
import type { RankBoostOptions, StoreAutomation, StoreConcurrencyOptions } from '../../src/store/sqlite.ts'
import { EngramError, asMemoryId } from '../../src/types.ts'
import type {
  EngramKind, EngramStatus, ForgettingTombstone, ImageryLabel, ListResult, MemoryRecord,
  SearchHit, SearchResult, StoreStats,
} from '../../src/types.ts'
import { applyMerge, decideWrite } from '../../src/write-disposition.ts'
import { resolveCodexConfig } from './config.ts'
import type { CodexEngramConfig, ResolvedCodexConfig } from './config.ts'
import { dshDbDir, isInsideDir } from './paths.ts'

/** Codex 侧可用的作用域：user 私人库、project 当前项目库（DSH 的 shared 暂未开放）。 */
export type CodexScope = 'user' | 'project'

/** 全部作用域，按「先私人后项目」固定顺序（检索合并与统计遍历共用）。 */
export const CODEX_SCOPES: readonly CodexScope[] = ['user', 'project']

/** 用户库文件名（与 DSH 同名：同一目录下两个宿主指向同一份数据）。 */
const USER_DB_NAME = 'user.db'

/**
 * 项目分库文件名模式（与 `src/project/identity.ts` 的 `project-<sha256前24位>.db` 同构）。
 * WebAPI 的项目发现、选择器校验、路径穿越防护共用这一个判据——不接受任何路径拼装。
 */
export const PROJECT_DB_NAME_PATTERN = /^project-[0-9a-f]{24}\.db$/

/** 作用域目标：作用域 + 项目定位（项目根与项目库选择器二选一，来源与校验由调用方负责）。 */
export interface CodexScopeTarget {
  /** 目标作用域；缺省 = 由方法自定（save/list 默认 project，get/forget/restore 自动定位）。 */
  readonly scope?: CodexScope
  /**
   * 项目根（绝对路径）。缺省 = 用运行时配置的 cwd。
   * 同一仓库的不同 worktree 经 git origin 归一化后会落到同一个分库（原项目有意行为）。
   */
  readonly projectRoot?: string
  /**
   * 项目库文件名选择器（`project-<24位hex>.db`）——WebAPI 写操作的定位口径：
   * 面板只有 dbName，拿不到工作目录。与 `projectRoot` **互斥**（同时给 = 定位有歧义，loud 拒绝）；
   * 只按已存在的库精确定位（复用 `openExistingProjectDb`，不建空库、不接受路径拼装）。
   *
   * MCP/Hooks 不传此字段，行为与旧版完全一致。
   */
  readonly projectDbName?: string
}

/** 写入请求。 */
export interface CodexSaveInput extends CodexScopeTarget {
  /** 记忆正文（一句话完整表达）。 */
  readonly content: string
  readonly kind: EngramKind
  /** 重要性 0-1；缺省由存储层取 0.5。 */
  readonly importance?: number
  /** 置信度 0-1；缺省由存储层取默认。 */
  readonly confidence?: number
  /** 来源会话 id（摄入/工具链路写入，显式保存传 null）。 */
  readonly sessionId?: string | null
  /** 来源轮次（与 sessionId 配套，供后续 Stop hook 归因）。 */
  readonly round?: number
  /** 来源事件序号。 */
  readonly seq?: number
  /** 门牌铭牌（4-30 字，唯一 · 差异化 · 带日期锚点）。 */
  readonly placard?: string
}

/** 写入结果：四态处置结果（drop 不会出现——空内容在入口即抛错）。 */
export interface CodexSaveResult {
  readonly record: MemoryRecord
  readonly disposition: 'accept' | 'merge' | 'defer'
  /** merge 时被并入的既有条目 id。 */
  readonly mergedInto?: string
  /** merge/defer 时的最近邻相似度。 */
  readonly similarity?: number
  /** defer 时并存的矛盾候选 id（调用方裁决后可用 update 归并）。 */
  readonly contradictions?: readonly string[]
  /** true = 嵌入不可用，本条仅参与关键词检索。 */
  readonly degraded: boolean
}

/** 检索请求。 */
export interface CodexSearchInput extends CodexScopeTarget {
  readonly query: string
  /** 检索范围；缺省 = user + project（库文件不存在的作用域自动跳过）。 */
  readonly scopes?: readonly CodexScope[]
  /** 返回条数上限；缺省 8。 */
  readonly limit?: number
  /** 房间路由：只在指定房间内检索（如「决策堂」）。 */
  readonly rooms?: readonly string[]
}

/** 检索结果：degraded=true 表示嵌入不可用/加载失败，仅关键词道参与排序。 */
export interface CodexSearchResult {
  readonly hits: readonly SearchHit[]
  readonly degraded: boolean
}

/** 管理列表请求（含全部状态，供管理面板/CLI 用）。 */
export interface CodexListInput extends CodexScopeTarget {
  readonly status?: EngramStatus
  readonly kind?: EngramKind
  /** content 子串匹配。 */
  readonly q?: string
  /** 分页；缺省 limit 20 / offset 0。 */
  readonly limit?: number
  readonly offset?: number
  /** 'tour' = 按固定巡游路线桩位顺序。 */
  readonly sort?: 'tour'
}

/** 修正请求：写入新条目并把旧条目标记为被取代（supersedes 链保留，可审计）。 */
export interface CodexUpdateInput extends CodexScopeTarget {
  readonly id: string
  readonly content: string
  /** 缺省继承旧条目。 */
  readonly kind?: EngramKind
  readonly importance?: number
  /** 门牌铭牌（替换旧条目门牌）。 */
  readonly placard?: string
}

/** 遗忘请求：软删（可恢复）；提供墓志铭时写入 op_log 供日后考古。 */
export interface CodexForgetOptions extends CodexScopeTarget {
  /** 闭馆三问答案（reason / affects / stillUseful 三项均需非空）。 */
  readonly tombstone?: ForgettingTombstone
}

/** 各作用域统计 + 运行期上下文（管理面板与诊断共用）。 */
export interface CodexRuntimeStats {
  readonly parts: readonly { readonly scope: CodexScope; readonly stats: StoreStats }[]
  readonly dbDir: string
  readonly cwd: string
  readonly projectDbName: string
}

/** Codex 记忆运行时：一个进程内实例按库文件名复用连接（同库多 worktree 只开一条）。 */
export interface CodexRuntime {
  readonly config: ResolvedCodexConfig
  readonly dbDir: string
  readonly cwd: string
  /** 默认项目标识（配置 cwd 解析；`projectRoot` 缺省时使用）。 */
  readonly identity: ProjectIdentity
  /** 默认项目库文件名（`project-<hash>.db`）。 */
  readonly projectDbName: string
  /** 作用域 + 项目根 → 库文件名。 */
  scopeDbName(scope: CodexScope, projectRoot?: string): string
  /** 作用域 + 项目根 → 库文件是否已存在（不存在时只读操作不为它建空库）。 */
  scopeExists(scope: CodexScope, projectRoot?: string): boolean
  /** 解析任意项目根的标识（只读 `<root>/.git/config`，无写入、不起子进程）。 */
  projectIdentity(projectRoot: string): ProjectIdentity
  /** 打开（必要时创建）一个分库；同一分库在实例内只打开一次。 */
  openScope(scope: CodexScope, projectRoot?: string): Promise<EngramStore>
  /**
   * 按已存在的分库文件名精确打开（WebAPI 项目选择器路径）：
   * 严格校验 `project-<24位hex>.db` 且文件必须已存在，复用同一连接缓存、WAL 与事务配置。
   * 不建空库、不接受路径拼装——与「项目路径已知走 projectRoot」互为补充，两者都不成立时
   * 调用方必须拒绝，不得悄悄回落到其他库。
   */
  openExistingProjectDb(dbName: string): Promise<EngramStore>
  /** 嵌入器（lazy 模式首次调用时加载；不可用返回 undefined，检索降级为纯关键词）。 */
  ensureEmbedder(): Promise<EngramEmbedder | undefined>
  save(input: CodexSaveInput): Promise<CodexSaveResult>
  search(input: CodexSearchInput): Promise<CodexSearchResult>
  get(id: string, options?: CodexScopeTarget): Promise<MemoryRecord | undefined>
  list(input: CodexListInput): Promise<ListResult>
  update(input: CodexUpdateInput): Promise<MemoryRecord>
  forget(id: string, options?: CodexForgetOptions): Promise<MemoryRecord>
  restore(id: string, options?: CodexScopeTarget): Promise<MemoryRecord>
  stats(projectRoot?: string): Promise<CodexRuntimeStats>
  /** 关闭全部分库句柄（Windows 上不关会锁住 .db 文件，进程退出前必须 await）。 */
  close(): Promise<void>
}

/** 门牌参数收敛：非空字符串转 ImageryLabel（感官/情绪维度留空，与 DSH 的 engram_save 同口径）。 */
function placardOf(raw: string | undefined): ImageryLabel | undefined {
  if (raw === undefined) return undefined
  const caption = raw.trim()
  if (caption === '') return undefined
  return { caption, sensoryTags: [], emotionalValence: 0, provisional: false }
}

/** 闭馆三问校验：三项均需非空，否则拒绝（保证日后可考古）。 */
function tombstoneOf(raw: ForgettingTombstone): ForgettingTombstone {
  const reason = raw.reason.trim()
  const affects = raw.affects.trim()
  const stillUseful = raw.stillUseful.trim()
  if (reason === '' || affects === '' || stillUseful === '') {
    throw new EngramError('TOMBSTONE_INCOMPLETE', 'codex-engram: 闭馆三问（reason / affects / stillUseful）都必须填写，方便日后考古')
  }
  return { reason, affects, stillUseful }
}

/**
 * 打开 Codex 记忆运行时。
 * @param config - 可选配置；缺省使用 `$CODEX_HOME/engram` 与当前进程 cwd。
 * @returns 就绪的运行时（分库懒打开——只有真正读写到的作用域才会建库文件）。
 * @throws EngramError(code=DSH_DIR_GUARD) dbDir 落在 `~/.dsh/engram` 内且未显式放行。
 * @throws 配置非法（未知键/枚举/越界）时抛普通 Error。
 */
export async function openCodexRuntime(config: CodexEngramConfig = {}): Promise<CodexRuntime> {
  const resolved = resolveCodexConfig(config)
  if (!resolved.allowDshDir && isInsideDir(dshDbDir(), resolved.dbDir)) {
    throw new EngramError('DSH_DIR_GUARD', `codex-engram: 拒绝使用 DSH 记忆目录 ${resolved.dbDir}（两个宿主必须各有独立数据目录，DSH 原始数据不受影响）。确有需要请显式传 allowDshDir: true`)
  }
  mkdirSync(resolved.dbDir, { recursive: true, mode: 0o700 })

  /** 项目标识缓存：root（原样字符串）→ 标识。只读 git config，无副作用，可在进程内安全复用。 */
  const identities = new Map<string, ProjectIdentity>()
  const identityOf = (projectRoot: string): ProjectIdentity => {
    const cached = identities.get(projectRoot)
    if (cached !== undefined) return cached
    const next = resolveProjectIdentity(projectRoot)
    identities.set(projectRoot, next)
    return next
  }
  const defaultIdentity = identityOf(resolved.cwd)

  /** 旧库（v0.4 cwd-hex 命名）迁移：按分库名去重，每个库只做一次并告警一次。 */
  const migrated = new Set<string>()
  const ensureMigrated = (identity: ProjectIdentity): void => {
    if (migrated.has(identity.dbName)) return
    migrated.add(identity.dbName)
    const warning = migrationWarning(
      resolved.dbDir, identity, migrateProjectDb(resolved.dbDir, identity, resolved.legacyMigration),
    )
    if (warning !== undefined) console.warn(warning)
  }
  ensureMigrated(defaultIdentity)

  const rankBoost: RankBoostOptions = {
    recencyWeight: resolved.rankRecencyWeight,
    proofWeight: resolved.rankProofWeight,
    decayAfterDays: resolved.decayAfterDays,
  }
  const automation: StoreAutomation = {
    autoSlot: resolved.autoSlot,
    reviewScheduling: resolved.reviewScheduling,
  }
  // 并发：MCP Server 与 Hooks 是不同进程，会同时打开同一分库。
  // 实测（tests/codex-concurrency.spec.ts）：默认配置（无 PRAGMA + 延迟事务）下多进程并发写会直接
  // 抛 "database is locked"（丢写，且 busy_timeout 对「读事务升级为写」这一情形不生效）；
  // WAL + busy_timeout + BEGIN IMMEDIATE 后 4 进程 × 8 条稳定全部落库。
  const concurrency: StoreConcurrencyOptions = {
    journalMode: resolved.journalMode,
    busyTimeoutMs: resolved.busyTimeoutMs,
    writeTransactions: resolved.writeTransactions,
  }

  /** 作用域 → 项目标识（user 无标识；project 用显式 root 或默认 cwd）。 */
  const identityFor = (scope: CodexScope, projectRoot?: string): ProjectIdentity | undefined =>
    scope === 'user' ? undefined : projectRoot === undefined ? defaultIdentity : identityOf(projectRoot)
  const dbNameOf = (scope: CodexScope, projectRoot?: string): string =>
    identityFor(scope, projectRoot)?.dbName ?? USER_DB_NAME
  const dbPathOf = (scope: CodexScope, projectRoot?: string): string => join(resolved.dbDir, dbNameOf(scope, projectRoot))
  const scopeExists = (scope: CodexScope, projectRoot?: string): boolean => existsSync(dbPathOf(scope, projectRoot))

  /** 分库懒打开：按库文件名缓存连接（同库多 worktree 共用一条连接）。 */
  const stores = new Map<string, Promise<EngramStore>>()
  const openDb = (dbName: string): Promise<EngramStore> => {
    const existing = stores.get(dbName)
    if (existing !== undefined) return existing
    const path = join(resolved.dbDir, dbName)
    const created = openEngramStore(path, rankBoost, automation, concurrency)
      .then(async store => {
        // 存量排桩：首次打开时幂等补齐（slot_room 为空的 active 条目按 kind 分房、创建时间定序）。
        // 失败不污染缓存句柄——排桩是增强路径，不影响读写本身。
        if (resolved.backfillSlots) {
          try {
            const assigned = await store.backfillSlots(room => {
              console.warn(`[codex-engram] 房间已满，自动开新房「${room}」（可在管理面板翻新清单中人工拆分/命名）`)
            })
            if (assigned > 0) console.warn(`[codex-engram] 存量记忆排桩完成：${String(assigned)} 条已钉入宫殿（${path}）`)
          } catch (error) {
            console.warn('[codex-engram] 存量排桩失败（跳过）：', error)
          }
        }
        return store
      })
    stores.set(dbName, created)
    return created
  }

  const openScope = async (scope: CodexScope, projectRoot?: string): Promise<EngramStore> => {
    const identity = identityFor(scope, projectRoot)
    if (identity !== undefined) ensureMigrated(identity)
    return openDb(dbNameOf(scope, projectRoot))
  }

  /**
   * 按分库文件名精确打开：只接受严格模式且已存在的项目库（UI 选择器给的就是 dbName，
   * 不是路径）。校验失败 loud 抛错——非法名可能是路径穿越企图，缺库说明选择器已失效
   * （工作区被删/改名），两种都不允许静默兜底。
   */
  const openExistingProjectDb = async (dbName: string): Promise<EngramStore> => {
    if (!PROJECT_DB_NAME_PATTERN.test(dbName)) {
      throw new EngramError('INVALID_PROJECT_DB', `codex-engram: 非法项目库文件名 ${dbName}（必须匹配 project-<24位hex>.db，且不是路径）`)
    }
    if (!existsSync(join(resolved.dbDir, dbName))) {
      throw new EngramError('UNKNOWN_PROJECT', `codex-engram: 项目库 ${dbName} 不存在（不会自动创建空库）`)
    }
    return openDb(dbName)
  }

  /** 项目库选择器是否指向已存在的库（只读判定，无副作用；读路径用它避免误建空库）。 */
  const hasProjectDb = (dbName: string): boolean =>
    PROJECT_DB_NAME_PATTERN.test(dbName) && existsSync(join(resolved.dbDir, dbName));

  /** 定位口径互斥校验：同时给 projectRoot 与 projectDbName 说明调用方定位逻辑有歧义。 */
  const checkLocator = (options: CodexScopeTarget): void => {
    if (options.projectRoot !== undefined && options.projectDbName !== undefined) {
      throw new EngramError('INVALID_SCOPE_TARGET', 'codex-engram: projectRoot 与 projectDbName 互斥，一次只能用一个口径定位项目库')
    }
    if (options.projectDbName !== undefined && options.scope === 'user') {
      throw new EngramError('INVALID_SCOPE_TARGET', `codex-engram: user 作用域不接受项目库选择器（${options.projectDbName}）`)
    }
  }

  /**
   * 作用域目标 → 分库句柄（**写口径**：按需建库）。
   * 给 `projectDbName` 时只定位已存在的库（不存在 loud 抛错，不建空库）；
   * 其余走 `openScope`（projectRoot / 配置 cwd），与 MCP/Hooks 一致。
   */
  const openTargetForWrite = async (scope: CodexScope, options: CodexScopeTarget): Promise<EngramStore> => {
    checkLocator(options)
    return options.projectDbName === undefined
      ? openScope(scope, options.projectRoot)
      : openExistingProjectDb(options.projectDbName)
  }

  /**
   * 作用域目标 → 分库句柄（**读口径**：库不存在返回 undefined，不建空库）。
   * 与 `openTargetForWrite` 同一套定位规则，区别只在缺库时的处理。
   */
  const openTargetForRead = async (scope: CodexScope, options: CodexScopeTarget): Promise<EngramStore | undefined> => {
    checkLocator(options)
    if (options.projectDbName === undefined) return readScope(scope, options.projectRoot)
    return hasProjectDb(options.projectDbName) ? openExistingProjectDb(options.projectDbName) : undefined
  }

  /** 只读口径：库文件不存在时返回 undefined——查询不给一次性 cwd 建空库。 */
  const readScope = async (scope: CodexScope, projectRoot?: string): Promise<EngramStore | undefined> =>
    scopeExists(scope, projectRoot) ? openScope(scope, projectRoot) : undefined

  // 嵌入器：lazy 模式下首次需要时才加载；加载失败降级为纯关键词（不阻塞任何读写）。
  let embedderPromise: Promise<EngramEmbedder | undefined> | undefined
  const ensureEmbedder = (): Promise<EngramEmbedder | undefined> => {
    if (resolved.embedding === 'off') return Promise.resolve(undefined)
    embedderPromise ??= createLocalEmbedder(resolved.modelCacheDir, resolved.hfEndpoint).catch((error: unknown) => {
      console.warn('[codex-engram] 嵌入器不可用，检索降级为纯关键词模式：', error)
      return undefined
    })
    return embedderPromise
  }

  /** 算向量：嵌入不可用或计算失败返回 undefined（调用方按降级处理，不中断写入）。 */
  const embedTexts = async (texts: readonly string[]): Promise<readonly Float32Array[] | undefined> => {
    const embedder = await ensureEmbedder()
    if (embedder === undefined) return undefined
    try {
      return await embedder.embed(texts)
    } catch (error) {
      console.warn('[codex-engram] 嵌入计算失败，本条按无向量处理：', error)
      return undefined
    }
  }

  /** 按 id 定位条目（先 user 后指定/默认项目库；不存在的库跳过）。 */
  const locate = async (
    id: string, options: CodexScopeTarget = {},
  ): Promise<{ scope: CodexScope; record: MemoryRecord } | undefined> => {
    const memoryId = asMemoryId(id)
    const scopes: readonly CodexScope[] = options.scope === undefined ? CODEX_SCOPES : [options.scope]
    for (const scope of scopes) {
      const store = await readScope(scope, options.projectRoot)
      if (store === undefined) continue
      const record = await store.get(memoryId)
      if (record !== undefined) return { scope, record }
    }
    return undefined
  }

  /**
   * 定位并要求存在（修正/遗忘/恢复路径用）：给显式定位（作用域或项目库选择器）时
   * **只在该库内找**——面板选定项目后，别的库里同 id 的条目不会被代劳恢复/删除。
   */
  const requireStore = async (id: string, options: CodexScopeTarget): Promise<EngramStore> => {
    if (options.scope !== undefined || options.projectDbName !== undefined) {
      const scope = options.scope ?? 'project'
      const store = await openTargetForRead(scope, options)
      if (store !== undefined && await store.get(asMemoryId(id)) !== undefined) return store
      const where = options.projectDbName === undefined ? `${scope} 库` : options.projectDbName
      throw new EngramError('NOT_FOUND', `codex-engram: 条目 ${id} 不存在于 ${where}（用 engram_list/engram_search 确认 id 与 scope）`)
    }
    const found = await locate(id, options)
    if (found === undefined) {
      throw new EngramError('NOT_FOUND', `codex-engram: 条目 ${id} 不存在于可访问的 Codex 记忆库（用 engram_list/engram_search 确认 id 与 scope）`)
    }
    return openScope(found.scope, options.projectRoot)
  }

  /** 内容清洗：剥离协议标签 + 密钥脱敏（与 DSH 的 engram_save/engram_update 同一防线）。 */
  const cleanContent = (raw: string, where: string): string => {
    const content = redactSecrets(sanitizeProtocolText(raw))
    if (content.trim() === '') {
      throw new EngramError('EMPTY_CONTENT', `codex-engram: ${where} 清洗后内容为空（原文只含协议标签或密钥）`)
    }
    return content
  }

  const save = async (input: CodexSaveInput): Promise<CodexSaveResult> => {
    const content = cleanContent(input.content, 'engram_save')
    const scope = input.scope ?? 'project'
    const store = await openTargetForWrite(scope, input)
    const vectors = await embedTexts([content.trim()])
    const embedding = vectors?.[0]
    const degraded = embedding === undefined
    const imagery = placardOf(input.placard)
    // 四态处置：复述并入既有条目；疑似矛盾落库并建 contradicts 边待裁决；其余原样写入。
    const decision = await decideWrite(store, input.kind, embedding)
    if (decision.disposition === 'merge') {
      const record = await applyMerge(store, decision, content)
      return { record, disposition: 'merge', mergedInto: decision.into.id, similarity: decision.similarity, degraded }
    }
    const record = await store.write({
      scope,
      kind: input.kind,
      content,
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      sourceSessionId: input.sessionId ?? null,
      ...(input.round === undefined ? {} : { sourceRound: input.round }),
      ...(input.seq === undefined ? {} : { sourceSeq: input.seq }),
      ...(embedding === undefined ? {} : { embedding }),
      ...(imagery === undefined ? {} : { imagery }),
    })
    if (decision.disposition === 'defer') {
      // 疑似矛盾/修正：落库 + 与高相似邻居建 contradicts 边，交调用方/用户裁决。
      const contradictions = embedding === undefined ? [] : await store.findContradictions(embedding)
      for (const candidate of contradictions) await store.linkEdge(record.id, candidate.id, 'contradicts')
      return {
        record,
        disposition: 'defer',
        similarity: decision.similarity,
        contradictions: contradictions.map(candidate => String(candidate.id)),
        degraded,
      }
    }
    return { record, disposition: 'accept', degraded }
  }

  const search = async (input: CodexSearchInput): Promise<CodexSearchResult> => {
    const limit = input.limit ?? 8
    const scopes = input.scopes ?? CODEX_SCOPES
    const vectors = await embedTexts([input.query])
    const vector = vectors?.[0]
    const perScope = await Promise.all(scopes.map(async (scope) => {
      const store = await openTargetForRead(scope, input)
      if (store === undefined) return undefined
      return store.search({
        text: input.query,
        scopes: [scope],
        limit,
        ...(input.rooms === undefined ? {} : { rooms: input.rooms }),
      }, vector)
    }))
    const present = perScope.filter((result): result is SearchResult => result !== undefined)
    const hits = present
      .flatMap(result => result.hits)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
    return { hits, degraded: vector === undefined || present.some(result => result.degraded) }
  }

  const runtime: CodexRuntime = {
    config: resolved,
    dbDir: resolved.dbDir,
    cwd: resolved.cwd,
    identity: defaultIdentity,
    projectDbName: defaultIdentity.dbName,
    scopeDbName: dbNameOf,
    scopeExists,
    projectIdentity: identityOf,
    openScope,
    openExistingProjectDb,
    ensureEmbedder,
    save,
    search,
    async get(id, options = {}) {
      if (options.scope !== undefined || options.projectDbName !== undefined) {
        const store = await openTargetForRead(options.scope ?? 'project', options)
        return store === undefined ? undefined : store.get(asMemoryId(id))
      }
      return (await locate(id, options))?.record
    },
    async list(input) {
      const scope = input.scope ?? 'project'
      const store = await openTargetForRead(scope, input)
      if (store === undefined) return { records: [], total: 0 }
      return store.list({
        scope,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.q === undefined ? {} : { q: input.q }),
        ...(input.sort === undefined ? {} : { sort: input.sort }),
        limit: input.limit ?? 20,
        offset: input.offset ?? 0,
      })
    },
    async update(input) {
      const content = cleanContent(input.content, 'engram_update')
      const store = await requireStore(input.id, input)
      const old = await store.get(asMemoryId(input.id))
      if (old === undefined) {
        throw new EngramError('NOT_FOUND', `codex-engram: 条目 ${input.id} 在目标库中不可读（可能被并发清除）`)
      }
      const vectors = await embedTexts([content.trim()])
      const embedding = vectors?.[0]
      const imagery = placardOf(input.placard)
      return store.update({
        id: asMemoryId(input.id),
        scope: old.scope,
        kind: input.kind ?? old.kind,
        content,
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        ...(embedding === undefined ? {} : { embedding }),
        ...(imagery === undefined ? {} : { imagery }),
      })
    },
    async forget(id, options = {}) {
      const store = await requireStore(id, options)
      const tombstone = options.tombstone
      return tombstone === undefined
        ? store.forget(asMemoryId(id))
        : store.forgetWithTombstone(asMemoryId(id), tombstoneOf(tombstone))
    },
    async restore(id, options = {}) {
      const store = await requireStore(id, options)
      return store.restore(asMemoryId(id))
    },
    async stats(projectRoot) {
      const parts: { scope: CodexScope; stats: StoreStats }[] = []
      for (const scope of CODEX_SCOPES) {
        const store = await readScope(scope, projectRoot)
        if (store === undefined) continue
        parts.push({ scope, stats: await store.stats() })
      }
      return {
        parts,
        dbDir: resolved.dbDir,
        cwd: resolved.cwd,
        projectDbName: identityFor('project', projectRoot)?.dbName ?? defaultIdentity.dbName,
      }
    },
    async close() {
      const pending = [...stores.values()]
      stores.clear()
      await Promise.allSettled(pending.map(async entry => {
        try {
          await (await entry).close()
        } catch {
          // 关闭失败无补救动作（连接会随进程退出释放）。
        }
      }))
    },
  }
  return runtime
}
