/**
 * Codex 侧配置：与 DSH 的 `src/config.ts` 同源但去掉了 schemastery 依赖
 * （宿主插件配置面由 cordis.yml 校验，Codex 侧没有该服务），默认值同样只在本文件落地。
 * @module codex-engram/config
 */

import { join } from 'node:path'
import { resolveCodexDbDir } from './paths.ts'

/** 旧库（v0.4 cwd-hex 命名）迁移策略：与 DSH 的 `src/config.ts` 同义。
 *  此处本地声明而非 import——DSH 侧那一份所在的模块链依赖 schemastery，
 *  Codex 侧必须与 `@deepseek-ai/*` 零耦合。 */
export type LegacyMigrationPolicy = 'eager' | 'conservative'

/** 嵌入模式：off 纯关键词检索；lazy 首次读写时才加载本地模型（失败自动降级为 off 行为）。 */
export type CodexEmbeddingMode = 'off' | 'lazy'

/** Codex Runtime 入参（全部可选）。 */
export interface CodexEngramConfig {
  /** 两个 SQLite 分库的根目录；默认 `$CODEX_HOME/engram`（见 paths.ts）。 */
  dbDir?: string
  /** 项目库归属的工作目录（git origin 归一化哈希分库）；默认 `process.cwd()`。 */
  cwd?: string
  /** 嵌入模式；默认 lazy。 */
  embedding?: CodexEmbeddingMode
  /** 嵌入模型缓存目录；默认 `<dbDir>/models`。 */
  modelCacheDir?: string
  /** 模型下载端点（网络受限环境配镜像，如 https://hf-mirror.com）。 */
  hfEndpoint?: string
  /** 写入时自动排桩并登记巡游路线；默认 true。 */
  autoSlot?: boolean
  /** 新记忆进入 SM-2 复习调度；默认 true。 */
  reviewScheduling?: boolean
  /** 首次打开分库时幂等补齐存量排桩；默认 true。 */
  backfillSlots?: boolean
  /**
   * SQLite 日志模式：默认 'wal'（MCP Server 与 Hooks 是不同进程，需要读写并行与稳定的写锁等待）；
   * 'delete' 显式回落旧模式。WAL 写入库头持久生效，之后任何宿主打开该库都在 WAL 下。
   */
  journalMode?: 'wal' | 'delete'
  /** 写锁等待毫秒数（PRAGMA busy_timeout）；默认 5000，0 = 不等待（并发写直接失败）。 */
  busyTimeoutMs?: number
  /**
   * 写事务起始语句：默认 'immediate'（BEGIN IMMEDIATE，先取写锁再读改，多进程并发写才不丢）；
   * 'deferred' = 引擎默认 BEGIN（多进程并发写下会 "database is locked"）。
   */
  writeTransactions?: 'deferred' | 'immediate'
  /** 旧库（v0.4 cwd-hex 命名）迁移策略；默认 eager。 */
  legacyMigration?: LegacyMigrationPolicy
  /** 检索排序 recency 因子权重；默认 0.2。 */
  rankRecencyWeight?: number
  /** 检索排序 proof 因子权重；默认 0.1。 */
  rankProofWeight?: number
  /** 衰减窗口天数（recency 因子的分母）；默认 30。 */
  decayAfterDays?: number
  /** 允许把 dbDir 指向 DSH 记忆目录（默认 false：拒绝，避免污染 `~/.dsh/engram`）。 */
  allowDshDir?: boolean
}

/** 解析后的配置（默认值已落地，实现不再判空）。 */
export interface ResolvedCodexConfig {
  readonly dbDir: string
  readonly cwd: string
  readonly embedding: CodexEmbeddingMode
  readonly modelCacheDir: string
  readonly hfEndpoint: string | undefined
  readonly autoSlot: boolean
  readonly reviewScheduling: boolean
  readonly backfillSlots: boolean
  readonly journalMode: 'wal' | 'delete'
  readonly busyTimeoutMs: number
  readonly writeTransactions: 'deferred' | 'immediate'
  readonly legacyMigration: LegacyMigrationPolicy
  readonly rankRecencyWeight: number
  readonly rankProofWeight: number
  readonly decayAfterDays: number
  readonly allowDshDir: boolean
}

/** 合法键集合（未知键 loud 失败，避免拼写错误静默生效）。 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'dbDir', 'cwd', 'embedding', 'modelCacheDir', 'hfEndpoint', 'autoSlot', 'reviewScheduling',
  'backfillSlots', 'legacyMigration', 'rankRecencyWeight', 'rankProofWeight', 'decayAfterDays', 'allowDshDir',
  'journalMode', 'busyTimeoutMs',
])

/** 取值范围校验（与 DSH 侧 resolveConfig 同口径）。 */
function checkRange(name: string, value: unknown, min: number, max: number, integer: boolean): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new Error(`codex-engram: ${name} must be ${integer ? 'an integer' : 'a number'} in [${String(min)}, ${String(max)}]`)
  }
}

/**
 * 落地默认值并校验。
 * @param config - 调用方入参。
 * @returns 完整解析配置。
 * @throws 未知键、枚举非法、数值越界时抛错（loud 失败，不静默兜底）。
 */
export function resolveCodexConfig(config: CodexEngramConfig = {}): ResolvedCodexConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`codex-engram: unknown config key "${key}"`)
  }
  if (config.embedding !== undefined && config.embedding !== 'off' && config.embedding !== 'lazy') {
    throw new Error(`codex-engram: embedding must be one of off|lazy, got "${String(config.embedding)}"`)
  }
  if (config.legacyMigration !== undefined && config.legacyMigration !== 'eager' && config.legacyMigration !== 'conservative') {
    throw new Error('codex-engram: legacyMigration must be one of eager|conservative')
  }
  for (const [name, value] of [
    ['rankRecencyWeight', config.rankRecencyWeight], ['rankProofWeight', config.rankProofWeight],
  ] as const) {
    if (value !== undefined) checkRange(name, value, 0, 2, false)
  }
  if (config.decayAfterDays !== undefined) checkRange('decayAfterDays', config.decayAfterDays, 1, 3650, true)
  if (config.journalMode !== undefined && config.journalMode !== 'wal' && config.journalMode !== 'delete') {
    throw new Error(`codex-engram: journalMode must be one of wal|delete, got "${String(config.journalMode)}"`)
  }
  if (config.busyTimeoutMs !== undefined) checkRange('busyTimeoutMs', config.busyTimeoutMs, 0, 60_000, true)
  if (config.writeTransactions !== undefined && config.writeTransactions !== 'deferred' && config.writeTransactions !== 'immediate') {
    throw new Error(`codex-engram: writeTransactions must be one of deferred|immediate, got "${String(config.writeTransactions)}"`)
  }
  const dbDir = config.dbDir ?? resolveCodexDbDir()
  return {
    dbDir,
    cwd: config.cwd ?? process.cwd(),
    embedding: config.embedding ?? 'lazy',
    modelCacheDir: config.modelCacheDir ?? join(dbDir, 'models'),
    hfEndpoint: config.hfEndpoint,
    autoSlot: config.autoSlot ?? true,
    reviewScheduling: config.reviewScheduling ?? true,
    backfillSlots: config.backfillSlots ?? true,
    journalMode: config.journalMode ?? 'wal',
    busyTimeoutMs: config.busyTimeoutMs ?? 5000,
    writeTransactions: config.writeTransactions ?? 'immediate',
    legacyMigration: config.legacyMigration ?? 'eager',
    rankRecencyWeight: config.rankRecencyWeight ?? 0.2,
    rankProofWeight: config.rankProofWeight ?? 0.1,
    decayAfterDays: config.decayAfterDays ?? 30,
    allowDshDir: config.allowDshDir ?? false,
  }
}
