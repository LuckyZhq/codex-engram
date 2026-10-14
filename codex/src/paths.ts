/**
 * Codex 侧数据目录解析：与 DSH 的 `~/.dsh/engram` 完全隔离，本模块从不读写 DSH 目录。
 * 优先级：`CODEX_ENGRAM_DIR`（整体覆盖）> `<CODEX_HOME>/engram` > `~/.codex/engram`。
 * @module codex-engram/paths
 */

import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** 记忆根目录覆盖变量（绝对路径或 `~` 开头）。 */
export const ENGRAM_DIR_ENV = 'CODEX_ENGRAM_DIR'
/** Codex 家目录变量（Codex CLI 认这个变量；缺省 `~/.codex`）。 */
export const CODEX_HOME_ENV = 'CODEX_HOME'

/** 展开 `~` / `~/` 前缀；其余原样返回（相对路径由调用方 resolve）。 */
export function expandHome(value: string, home: string = homedir()): string {
  const trimmed = value.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return trimmed
}

/**
 * Codex 记忆根目录。
 * @param env - 环境变量表（测试可注入）。
 * @param home - 家目录（测试可注入）。
 * @returns 绝对路径的根目录；不校验存在性。
 */
export function resolveCodexDbDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env[ENGRAM_DIR_ENV]
  if (override !== undefined && override.trim() !== '') return resolve(expandHome(override, home))
  const codexHome = env[CODEX_HOME_ENV]
  const base = codexHome !== undefined && codexHome.trim() !== ''
    ? resolve(expandHome(codexHome, home))
    : join(home, '.codex')
  return join(base, 'engram')
}

/** DSH 记忆根目录：仅用于隔离校验与迁移提示，本包从不写入该目录。 */
export function dshDbDir(home: string = homedir()): string {
  return join(home, '.dsh', 'engram')
}

/** 比较键：去尾分隔符 + Windows 上折叠大小写（同一目录的不同写法要判等）。 */
function compareKey(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * `child` 是否等于 `parent` 或位于其内。
 * @param parent - 期望的父目录。
 * @param child - 待判定路径。
 */
export function isInsideDir(parent: string, child: string): boolean {
  const root = compareKey(parent)
  const target = compareKey(child)
  return target === root || target.startsWith(root + sep)
}
