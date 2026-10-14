/**
 * React 入口（Codex 独立运行版）：挂载 App 到 #root。
 * @module codex-engram/ui/main
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

const container = document.getElementById('root')
if (container === null) throw new Error('codex-engram/ui: #root container missing')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
