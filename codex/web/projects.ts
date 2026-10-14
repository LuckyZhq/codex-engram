/**
 * 项目库发现与选择：WebAPI「项目」作用域的定位层。
 *
 * 两条打开口径（与 Runtime 接口对应，都不允许悄悄回落到进程 cwd）：
 * 1. **选择器口径**（UI 实际使用）：`project=<dbName>`。dbName 必须匹配
 *    `project-<24位hex>.db` 且文件在 dbDir 内已存在——从经过验证的现有清单里选，
 *    不拼路径、不建空库。未知选择器 → UnknownProjectError（HTTP 404 unknown project，
 *    面板据此自愈：清掉失效的固定选择回到跟随态）。
 * 2. **项目根口径**（API/测试使用）：`projectRoot=<绝对路径>`，经 project-context.ts
 *    同一套校验（存在/目录/不在数据目录内），再走 git origin 归一化定位分库；
 *    写操作允许按需建库（与 MCP/Hooks 一致），读操作不建。
 *
 * `GET /workspaces` 的清单语义：扫描 dbDir 下的现有项目库 + 合并显式配置的项目根。
 * 无法归属的库只展示文件名（title/path 为 null，标记为未注册），不虚构路径、来源或工作区 ID。
 * @module codex-engram/web/projects
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EngramStore } from '../../src/store/interface.ts'
import { PROJECT_DB_NAME_PATTERN } from '../src/runtime.ts'
import type { CodexRuntime, CodexScope } from '../src/runtime.ts'
import { normalizeProjectRoot } from '../src/project-context.ts'

/** 未知/失效的项目选择器（路由统一映射 404 + `unknown project`，面板靠这个精确组合自愈）。 */
export class UnknownProjectError extends Error {
  constructor(selector: string) {
    super(`unknown project: ${selector}`)
    this.name = 'UnknownProjectError'
  }
}

/** 非法选择器（不匹配分库命名模式——可能是路径穿越企图，400 拒绝）。 */
export class InvalidSelectorError extends Error {
  constructor(selector: string) {
    super(`invalid project selector: ${selector}`)
    this.name = 'InvalidSelectorError'
  }
}

/** 项目宫格行（对齐面板 EngramProjectItem；source 仅归属已知时给出，不虚构）。 */
export interface ProjectPalaceItem {
  readonly dbName: string
  /** 展示标题；无法归属时为 null（面板回退 dbName 短写）。 */
  readonly title: string | null
  /** 归属工作目录；无法归属时为 null。 */
  readonly path: string | null
  /** workspace = 显式配置的项目根；session = 只从数据目录扫到（未注册）。 */
  readonly kind: 'workspace' | 'session'
  /** 标识来源（git origin / cwd 兜底）；无法归属时省略。 */
  readonly source?: 'origin' | 'cwd'
  /** Codex 无宿主工作区注册表，恒为 null。 */
  readonly workspaceId: null
  readonly exists: boolean
  /** active 记忆条数；库不存在或读取失败为 null。 */
  readonly memories: number | null
}

/** `GET /workspaces` 返回（processDefault = 配置的默认项目根；缺席时 null）。 */
export interface WorkspacesView {
  readonly items: readonly ProjectPalaceItem[]
  readonly processDefault: { readonly dbName: string; readonly path: string; readonly title: string } | null
}

/** 解析后的作用域目标：user 库、按选择器打开的项目库、或按项目根定位的项目库。 */
export interface ProjectTarget {
  readonly scope: CodexScope
  readonly dbName: string
  /** 按根定位时给出（写操作可建库）；缺省 = 按选择器（必须已存在）。 */
  readonly projectRoot?: string
}

export interface ProjectRegistryOptions {
  readonly runtime: CodexRuntime
  /**
   * 显式配置的默认项目根（ENGRAM_PROJECT_ROOT / CLI）。用途：workspaces 的
   * processDefault（面板「跟随」态落点）与无选择器时的项目作用域解析。
   * 缺省 = 无默认项目：跟随态无落点，项目作用域请求必须带选择器或 projectRoot。
   */
  readonly projectRoot?: string
}

export interface ProjectRegistry {
  readonly dbDir: string
  /** 显式配置的默认项目根（归一化后）；未配置为 undefined。 */
  readonly defaultRoot: string | undefined
  /** 项目宫格清单（扫描 + 配置合并；不建空库）。 */
  list(): Promise<WorkspacesView>
  /**
   * 解析作用域目标。
   * @throws UnknownProjectError 选择器格式合法但库不存在 / 无选择器且无默认项目根（404）。
   * @throws InvalidSelectorError 选择器不匹配分库命名模式（400）。
   */
  resolve(scope: CodexScope, selector?: string): Promise<ProjectTarget>
  /** 打开目标库（写路径：按根定位时允许建库）。 */
  openStore(target: ProjectTarget): Promise<EngramStore>
  /** 打开目标库（读路径：库不存在返回 undefined，不建空库）。 */
  openStoreForRead(target: ProjectTarget): Promise<EngramStore | undefined>
}

/** 路径末段（Windows/POSIX 分隔符都认）。 */
function lastSegment(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  const at = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return at < 0 ? normalized : normalized.slice(at + 1)
}

/** 扫描 dbDir 下的项目分库文件名（严格模式；排序确定，便于测试与展示稳定）。 */
export function scanProjectDbs(dbDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dbDir)
  } catch {
    return []
  }
  return entries.filter(name => PROJECT_DB_NAME_PATTERN.test(name)).sort()
}

/** 创建项目库注册表。 */
export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  const { runtime } = options
  // 默认项目根在启动时一次性校验（loud 失败：配置错误不应拖到请求期才暴露）。
  const defaultRoot = options.projectRoot === undefined || options.projectRoot.trim() === ''
    ? undefined
    : normalizeProjectRoot(options.projectRoot, { dataDir: runtime.dbDir }).root

  const resolve = async (scope: CodexScope, selector?: string): Promise<ProjectTarget> => {
    if (scope === 'user') return { scope: 'user', dbName: 'user.db' }
    if (selector === undefined || selector === '') {
      // 无选择器：只有显式配置的默认项目根可用；绝不回落到进程 cwd 或「第一个库」。
      if (defaultRoot !== undefined) {
        return { scope: 'project', dbName: runtime.scopeDbName('project', defaultRoot), projectRoot: defaultRoot }
      }
      throw new UnknownProjectError('')
    }
    if (!PROJECT_DB_NAME_PATTERN.test(selector)) throw new InvalidSelectorError(selector)
    if (!existsSync(join(runtime.dbDir, selector))) throw new UnknownProjectError(selector)
    return { scope: 'project', dbName: selector }
  }

  const openStore = async (target: ProjectTarget): Promise<EngramStore> => {
    if (target.scope === 'user') return runtime.openScope('user')
    return target.projectRoot === undefined
      ? runtime.openExistingProjectDb(target.dbName)
      : runtime.openScope('project', target.projectRoot)
  }

  const openStoreForRead = async (target: ProjectTarget): Promise<EngramStore | undefined> => {
    if (target.scope === 'user') {
      return runtime.scopeExists('user') ? runtime.openScope('user') : undefined
    }
    if (target.projectRoot !== undefined) {
      return runtime.scopeExists('project', target.projectRoot)
        ? runtime.openScope('project', target.projectRoot)
        : undefined
    }
    // 选择器口径：resolve 已确认存在；竞态删除由 openExistingProjectDb loud 抛出（→404）。
    return runtime.openExistingProjectDb(target.dbName)
  }

  const list = async (): Promise<WorkspacesView> => {
    const items: ProjectPalaceItem[] = []
    const claimed = new Set<string>()

    // 显式配置的默认项目根：唯一能归属路径的项（kind=workspace，无「未注册」标记）。
    if (defaultRoot !== undefined) {
      const identity = runtime.projectIdentity(defaultRoot)
      claimed.add(identity.dbName)
      const exists = runtime.scopeExists('project', defaultRoot)
      let memories: number | null = null
      if (exists) {
        try {
          memories = (await (await runtime.openScope('project', defaultRoot)).stats()).active
        } catch {
          memories = null
        }
      }
      items.push({
        dbName: identity.dbName,
        title: lastSegment(defaultRoot),
        path: defaultRoot,
        kind: 'workspace',
        source: identity.source,
        workspaceId: null,
        exists,
        memories,
      })
    }

    // 数据目录扫描到的其余项目库：只展示文件名，不虚构归属。
    for (const dbName of scanProjectDbs(runtime.dbDir)) {
      if (claimed.has(dbName)) continue
      let memories: number | null = null
      try {
        memories = (await (await runtime.openExistingProjectDb(dbName)).stats()).active
      } catch {
        memories = null
      }
      items.push({
        dbName,
        title: null,
        path: null,
        kind: 'session',
        workspaceId: null,
        exists: true,
        memories,
      })
    }

    return {
      items,
      processDefault: defaultRoot === undefined
        ? null
        : { dbName: runtime.scopeDbName('project', defaultRoot), path: defaultRoot, title: lastSegment(defaultRoot) },
    }
  }

  return { dbDir: runtime.dbDir, defaultRoot, list, resolve, openStore, openStoreForRead }
}
