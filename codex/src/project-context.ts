/**
 * 项目上下文解析：**可信来源 + 严格校验**，MCP 进程的 cwd 一律不作为项目依据。
 *
 * 为什么不能用 `process.cwd()`：MCP Server 的工作目录是插件安装目录（如
 * `~/.codex/plugins/codex-engram`），而当前对话操作的仓库在别处。若按进程 cwd 解析项目库，
 * 所有项目会共用同一个 `project-<hash>.db`，造成跨项目记忆串库——本文件是这条红线的唯一实现。
 *
 * 可信来源优先级（全部经过同一套校验）：
 * 1. 工具调用显式传入的 `projectRoot`（逐调用解析，不缓存——模型可能在不同调用里问不同项目）；
 * 2. 环境变量 `ENGRAM_PROJECT_ROOT`（由宿主配置显式提供）；
 * 3. MCP 客户端提供的 workspace roots（`roots/list`，逐调用查询，不做跨调用缓存）。
 *
 * 校验规则：非空、绝对路径、存在且是目录、不在记忆数据目录内；随后向上找到最近的 git 仓库根
 * （`.git` 目录或 worktree/submodule 的 `.git` 文件），保证「仓库子目录」也落到同一个项目库。
 * 全部来源都拿不到项目时返回 undefined——调用方必须**拒绝**项目级读写并明确报错，
 * 不允许静默降级到用户级库。
 * @module codex-engram/project-context
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { resolveProjectIdentity } from '../../src/project/identity.ts'
import type { ProjectIdentity } from '../../src/project/identity.ts'
import { EngramError } from '../../src/types.ts'
import { isInsideDir } from './paths.ts'

/** 宿主显式配置项目根的环境变量（MCP 注册时通过 env 传入；可信来源之一）。 */
export const PROJECT_ROOT_ENV = 'ENGRAM_PROJECT_ROOT'

/** 项目上下文来源（写进工具输出，便于排查串库问题）。 */
export type ProjectContextSource = 'argument' | 'env' | 'client-roots'

/** 已解析并校验的项目上下文。 */
export interface ProjectContext {
  /** 归一化后的项目根（绝对路径，已 realpath）。 */
  readonly root: string
  /** 项目标识（git origin 归一化哈希，或 cwd 兜底哈希）。 */
  readonly identity: ProjectIdentity
  /** 来源：显式参数 / 环境变量 / 客户端 roots。 */
  readonly source: ProjectContextSource
  /** 是否落在 git 仓库内；false = 走 cwd 哈希兜底（隔离强度较弱，仅靠目录路径区分）。 */
  readonly gitBacked: boolean
}

/** 项目上下文解析依赖。 */
export interface ProjectContextDeps {
  /** 工具调用显式传入的项目根。 */
  readonly projectRoot?: string
  /** 环境变量表（测试可注入）。 */
  readonly env: NodeJS.ProcessEnv
  /** MCP 客户端提供的 workspace roots（返回绝对路径）；undefined = 客户端不支持。 */
  readonly clientRoots?: () => Promise<readonly string[]>
  /** 记忆数据目录：项目根落在其中一律拒绝（防把库目录当项目）。 */
  readonly dataDir: string
  /** 额外拒绝的根（如插件安装目录）。 */
  readonly rejectRoots?: readonly string[]
}

/** 向上查找 git 仓库根的最大层数（防御异常深的目录树）。 */
const MAX_ANCESTOR_DEPTH = 64

/** 去掉 Windows `\\?\` 长路径前缀（UNC 形式单独还原），便于路径比较与展示。 */
function stripWindowsPrefix(path: string): string {
  if (!path.startsWith('\\\\?\\')) return path
  return path.startsWith('\\\\?\\UNC\\') ? `\\\\${path.slice(8)}` : path.slice(4)
}

/** 目录是否含 `.git`（目录 = 普通仓库；文件 = worktree/submodule）。 */
function looksLikeRepoRoot(dir: string): boolean {
  try {
    return existsSync(join(dir, '.git'))
  } catch {
    return false
  }
}

/**
 * 归一化并校验项目根。
 * @returns 归一化后的根与是否 git-backed。
 * @throws EngramError(code=PROJECT_ROOT_INVALID) 相对路径 / 不存在 / 非目录 / 落在拒绝名单内。
 */
export function normalizeProjectRoot(raw: string, deps: Pick<ProjectContextDeps, 'dataDir' | 'rejectRoots'>): { root: string; gitBacked: boolean } {
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new EngramError('PROJECT_ROOT_INVALID', 'projectRoot 不能为空字符串')
  }
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    throw new EngramError('PROJECT_ROOT_INVALID', `projectRoot 不支持 ~ 简写，请传绝对路径：${trimmed}`)
  }
  if (!isAbsolute(trimmed)) {
    throw new EngramError('PROJECT_ROOT_INVALID', `projectRoot 必须是绝对路径（收到相对路径 ${trimmed}）`)
  }
  let stat
  try {
    stat = statSync(trimmed)
  } catch {
    throw new EngramError('PROJECT_ROOT_INVALID', `projectRoot 不存在或不可访问：${trimmed}`)
  }
  if (!stat.isDirectory()) {
    throw new EngramError('PROJECT_ROOT_INVALID', `projectRoot 不是目录：${trimmed}`)
  }
  let resolvedPath = resolve(trimmed)
  try {
    resolvedPath = stripWindowsPrefix(realpathSync(resolvedPath))
  } catch {
    // realpath 失败（权限/网络盘）：保留 resolve 结果，后续校验照常执行。
  }
  for (const rejected of [deps.dataDir, ...(deps.rejectRoots ?? [])]) {
    if (isInsideDir(rejected, resolvedPath)) {
      throw new EngramError('PROJECT_ROOT_INVALID', `projectRoot 不能指向 Engram 自身目录：${resolvedPath}`)
    }
  }
  // 向上找最近的 git 仓库根：子目录调用与仓库根落到同一个项目库（避免同一仓库被切成多个库）。
  let candidate = resolvedPath
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (looksLikeRepoRoot(candidate)) return { root: candidate, gitBacked: true }
    const parent = dirname(candidate)
    if (parent === candidate || parent === '' || parent === `${candidate}${sep}`) break
    candidate = parent
  }
  return { root: resolvedPath, gitBacked: false }
}

/** 由已校验的根构造项目上下文。 */
function contextOf(root: string, gitBacked: boolean, source: ProjectContextSource): ProjectContext {
  return { root, identity: resolveProjectIdentity(root), source, gitBacked }
}

/**
 * 解析项目上下文（按优先级尝试三个可信来源）。
 * @returns 项目上下文；全部来源都不可用时返回 undefined（调用方必须拒绝项目级操作）。
 * @throws EngramError(code=PROJECT_ROOT_INVALID) 显式参数或环境变量给了非法路径（loud 失败，
 *   不静默跳过——否则会误落到另一个项目库）。客户端 roots 里的非法路径只告警跳过。
 */
export async function resolveProjectContext(deps: ProjectContextDeps): Promise<ProjectContext | undefined> {
  const explicit = deps.projectRoot
  if (explicit !== undefined && explicit.trim() !== '') {
    const { root, gitBacked } = normalizeProjectRoot(explicit, deps)
    return contextOf(root, gitBacked, 'argument')
  }
  const fromEnv = deps.env[PROJECT_ROOT_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const { root, gitBacked } = normalizeProjectRoot(fromEnv, deps)
    return contextOf(root, gitBacked, 'env')
  }
  if (deps.clientRoots !== undefined) {
    for (const candidate of await deps.clientRoots()) {
      try {
        const { root, gitBacked } = normalizeProjectRoot(candidate, deps)
        return contextOf(root, gitBacked, 'client-roots')
      } catch (error) {
        console.warn(`[codex-engram] 忽略客户端 roots 中的无效项 ${candidate}：`, error instanceof Error ? error.message : error)
      }
    }
  }
  return undefined
}

/** 项目级操作缺少项目上下文时的统一报错文案（可执行指令，便于模型自我纠正）。 */
export const PROJECT_CONTEXT_REQUIRED_MESSAGE = [
  'codex-engram: 无法确定当前项目，已拒绝项目级操作（不会静默写入用户级库）。',
  `请任选其一：① 传 projectRoot=<当前工作区的绝对路径>；② 由宿主设置 ${PROJECT_ROOT_ENV}；`,
  '③ 若这条记忆与项目无关（通用偏好/事实），改用 scope="user"。',
].join('')

/** 要求项目上下文存在；缺失时抛 EngramError(code=PROJECT_CONTEXT_REQUIRED)。 */
export function requireProjectContext(context: ProjectContext | undefined): ProjectContext {
  if (context === undefined) {
    throw new EngramError('PROJECT_CONTEXT_REQUIRED', PROJECT_CONTEXT_REQUIRED_MESSAGE)
  }
  return context
}
