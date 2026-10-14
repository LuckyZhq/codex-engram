/**
 * 会话初始化：WebAPI 认证门在浏览器侧的对应物。
 *
 * 面板挂载前先探测 `GET /api/engram/session`：
 * - 200 → 已认证（Cookie 或 Bearer 已就位），正常渲染面板；
 * - 401 → 未认证，展示令牌录入浮层；提交后跳转 `/auth?token=…`，
 *   服务端换取 HttpOnly 会话 Cookie 并 302 回本页，随后面板自动就绪；
 * - 其它（404/网络错误/500）→ 视为「无认证层」（dev mock 等场景），照常渲染面板，
 *   由面板自身的降级文案处理数据缺失。
 *
 * 这样 dev 代理模式与生产 dist 模式走同一条认证链，不因开发模式跳过安全层。
 * @module codex-engram/ui/session
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

/** 会话探测状态。 */
export type SessionState = 'checking' | 'ready' | 'unauthorized'

/** 探测一次会话；返回是否需要录入令牌。 */
async function probeSession(): Promise<SessionState> {
  try {
    const response = await fetch('/api/engram/session', { headers: { accept: 'application/json' } })
    if (response.status === 401) return 'unauthorized'
    return 'ready'
  } catch {
    // 网络错误（服务未启动/代理未配）：不阻塞面板，按无认证层处理。
    return 'ready'
  }
}

/** 会话门：挂载时探测，暴露状态与令牌提交动作。 */
export function useSessionGate(): { state: SessionState; submitToken: (token: string) => void } {
  const [state, setState] = useState<SessionState>('checking')
  useEffect(() => {
    let cancelled = false
    void probeSession().then(next => { if (!cancelled) setState(next) })
    return () => { cancelled = true }
  }, [])
  const submitToken = useCallback((token: string) => {
    // 整页跳转：/auth 由服务端换 Cookie 并 302 回 `/`，刷新后探针即通过。
    window.location.assign(`/auth?token=${encodeURIComponent(token)}`)
  }, [])
  return { state, submitToken }
}

/** 令牌录入浮层（未认证时的唯一可见内容；样式随宿主 chrome，紧凑风）。 */
export function SessionGate({ onSubmit }: { onSubmit: (token: string) => void }): ReactElement {
  const [token, setToken] = useState('')
  return (
    <div className="appSessionGate">
      <form
        className="appSessionCard"
        onSubmit={event => {
          event.preventDefault()
          if (token.trim() !== '') onSubmit(token.trim())
        }}>
        <span className="appSessionBrand">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 2 L14.5 9 L22 9.5 L16 14.5 L18 22 L12 17.5 L6 22 L8 14.5 L2 9.5 L9.5 9 Z" />
          </svg>
          记忆宫殿 · Codex
        </span>
        <p className="appSessionHint">请输入 WebAPI 启动时打印的访问令牌（仅本机可见，换取一次即可）。</p>
        <input
          className="appSessionInput"
          type="password"
          value={token}
          autoFocus
          placeholder="访问令牌"
          autoComplete="off"
          onChange={event => { setToken(event.target.value) }}
        />
        <button className="appSessionSubmit" type="submit" disabled={token.trim() === ''}>进入</button>
      </form>
    </div>
  )
}
