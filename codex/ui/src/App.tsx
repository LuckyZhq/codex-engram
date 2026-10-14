/**
 * Codex 独立应用外壳：最小宿主 chrome（品牌 + 主题切换）+ 原版记忆宫殿面板。
 *
 * 面板本体是 src/client/EngramPanel.tsx 的 EngramSection 原样复用——
 * 不复制、不重写。宿主差异全部收编在本文件与 theme-compat.css：
 * - t 席位：host.ts 本地合成（DSH 宿主 locale 服务的替身）；
 * - 主题：theme.ts 管理 auto/light/dark，theme-compat.css 提供 --dsw-alias-* 令牌；
 * - 工作区/会话服务：不传（面板支持缺席，项目宫殿经下拉手动选择，
 *   「跟随」态回落服务端默认库——独立部署下的合理语义）。
 * @module codex-engram/ui/App
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { EngramSection } from '../../../src/client/EngramPanel.tsx'
import { buildT, detectLang } from './host.ts'
import {
  applyTheme, loadThemeMode, nextThemeMode, onSystemThemeChange, saveThemeMode,
  type ThemeMode,
} from './theme.ts'
import './theme-compat.css'

/** 主题图标（与面板 Icon 同风格：24 viewBox / stroke 1.75 / currentColor）。 */
const THEME_ICON: Record<'auto' | 'light' | 'dark', ReactElement> = {
  auto: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4" />
    </svg>
  ),
  light: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20.4 14.2A8.4 8.4 0 1 1 9.8 3.6a6.6 6.6 0 0 0 10.6 10.6z" />
    </svg>
  ),
}

/** 主题按钮的文案（不进面板词典——这是宿主 chrome，不是面板文案）。 */
const THEME_LABEL: Record<ThemeMode, string> = {
  auto: '跟随系统',
  light: '浅色',
  dark: '深色',
}

/** 应用根组件。 */
export default function App(): ReactElement {
  const [mode, setMode] = useState<ThemeMode>(loadThemeMode)
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => applyTheme(loadThemeMode()))

  // 模式变化：落盘 + 应用。
  useEffect(() => {
    saveThemeMode(mode)
    setResolved(applyTheme(mode))
  }, [mode])

  // auto 模式下实时跟随系统主题切换。
  useEffect(() => {
    if (mode !== 'auto') return
    return onSystemThemeChange(() => { setResolved(applyTheme(mode)) })
  }, [mode])

  const cycleTheme = useCallback(() => { setMode(current => nextThemeMode(current)) }, [])

  // t 席位：浏览器语言决定默认词典；面板内的「中 | EN」段控可再覆盖。
  const t = useMemo(() => buildT(detectLang()), [])

  return (
    <div className="appShell">
      <header className="appTopBar">
        <span className="appBrand">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 2 L14.5 9 L22 9.5 L16 14.5 L18 22 L12 17.5 L6 22 L8 14.5 L2 9.5 L9.5 9 Z" />
          </svg>
          记忆宫殿 · Codex
        </span>
        <button type="button" className="appThemeToggle"
          title={`主题：${THEME_LABEL[mode]}（点击切换）`}
          aria-label={`主题：${THEME_LABEL[mode]}（点击切换）`}
          data-resolved={resolved}
          onClick={cycleTheme}>
          {THEME_ICON[mode]}
          {THEME_LABEL[mode]}
        </button>
      </header>
      <main className="appMain">
        <EngramSection t={t} />
      </main>
    </div>
  )
}
