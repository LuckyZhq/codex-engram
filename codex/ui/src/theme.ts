/**
 * 主题模式管理（Codex 独立宿主）：auto / light / dark 三态，
 * 持久化在 localStorage（与面板 UiStorage 同一命名空间家族），
 * auto 跟随系统 prefers-color-scheme 且实时响应系统切换。
 *
 * 落点：<html data-theme="light|dark">，由 theme-compat.css 两个块分别取值。
 * index.html 的内联脚本承担首帧防闪跳，与本模块规则保持一致。
 * @module codex-engram/ui/theme
 */

/** 主题模式：auto = 跟随系统。 */
export type ThemeMode = 'auto' | 'light' | 'dark'

/** 面板 UiStorage 的命名空间是 dsh-engram.ui.*，主题键沿用同族避免前缀分裂。 */
const STORAGE_KEY = 'dsh-engram.ui.theme'

const MODES: readonly ThemeMode[] = ['auto', 'light', 'dark']

/** 读取持久化模式；非法值回落 auto。 */
export function loadThemeMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return MODES.find(mode => mode === raw) ?? 'auto'
  } catch {
    return 'auto'
  }
}

/** 写回持久化模式；存储失败静默（主题本身不依赖写回成功）。 */
export function saveThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* 隐私模式 / 存储禁用：仅本次会话生效 */
  }
}

/** 模式 → 实际生效的明暗（auto 时问系统）。 */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'auto') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 把模式应用到 document：落 data-theme 属性（CSS 兼容层的开关）。 */
export function applyTheme(mode: ThemeMode): 'light' | 'dark' {
  const resolved = resolveTheme(mode)
  document.documentElement.dataset.theme = resolved
  return resolved
}

/** 系统主题变化监听（auto 模式下实时切换）；返回退订函数。 */
export function onSystemThemeChange(listener: () => void): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', listener)
  return () => { query.removeEventListener('change', listener) }
}

/** 循环切换：auto → light → dark → auto。 */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  const index = MODES.indexOf(mode)
  return MODES[(index + 1) % MODES.length]!
}
