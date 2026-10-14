/**
 * 独立宿主适配层：把 DSH 渲染器注入的 locale「t」席位于本地合成。
 *
 * 原版 EngramPanel 的 PropsLocale<NS> 只要一个 (key, params?) => string 的 t
 * （宿主 locale 服务合成）；Codex 没有宿主 locale 服务，这里直接用同源词典
 * （src/client/locales.ts 的 zh/en）按相同 {param} 插值规则本地合成，
 * 与面板内部 makeT 的行为逐字节一致——未知键回退键名、缺参保留占位符。
 *
 * 面板挂载后会以 hostT('scopeUser') 探测词典语言来决定默认语言，
 * 因此这里按浏览器语言传对应词典的 t。
 * @module codex-engram/ui/host
 */

import { en, zh, type EngramKey } from '../../../src/client/locales.ts'

/** 与面板内部 T 同构的翻译函数（宿主 t 席位的窄签名）。 */
export type PanelT = (key: EngramKey, params?: Record<string, unknown>) => string

/** 探测初始语言：浏览器偏好中文 → zh，否则 en。 */
export function detectLang(): 'zh' | 'en' {
  try {
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

/** 按词典合成 t：{param} 插值；未知键回退键名本身；缺参保留原始占位符。 */
export function buildT(lang: 'zh' | 'en'): PanelT {
  const dict = lang === 'zh' ? zh : en
  return (key, params) => (dict[key] ?? String(key)).replace(/\{(\w+)\}/g, (raw: string, name: string) => {
    const value = params?.[name]
    return value === undefined ? raw : String(value)
  })
}
