import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { mockEngramApi } from './src/mock/api.ts'

/**
 * codex/ui 构建配置（Vite）。
 *
 * - root 固定为本目录，入口 index.html；
 * - base './'：产物相对路径，D2 的 Node HTTP 服务可按任意前缀挂载；
 * - tsx 的 JSX 转换走仓库 tsconfig 的 react-jsx（Vite 读 tsconfig 映射为
 *   oxc automatic runtime），无需 @vitejs/plugin-react、无需 esbuild.jsx 覆写；
 * - 数据源二选一（显式开关，不默认 Mock）：
 *     ENGRAM_UI_MOCK=1      → dev server 挂 mock API（D1 渲染基线，不触真实数据库）；
 *     缺省                  → /api 与 /auth 代理到真实 WebAPI（默认 127.0.0.1:3928，
 *                             可用 ENGRAM_WEB_ORIGIN 覆盖）。
 *   代理模式**不跳过安全层**：浏览器 Cookie / Origin / Host 经代理原样转发，
 *   令牌仍须经 /auth 换取会话（同源生效，导出下载链接同样携带 Cookie）；
 * - 仅监听 127.0.0.1（与 codex/web 的绑定策略一致）。
 */
const useMock = process.env.ENGRAM_UI_MOCK === '1'
const webOrigin = process.env.ENGRAM_WEB_ORIGIN ?? 'http://127.0.0.1:3928'
const proxyTargets = {
  '/api': { target: webOrigin, changeOrigin: false },
  '/auth': { target: webOrigin, changeOrigin: false },
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: useMock ? [mockEngramApi()] : [],
  server: {
    host: '127.0.0.1',
    port: 3927,
    strictPort: true,
    ...(useMock ? {} : { proxy: proxyTargets }),
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    ...(useMock ? {} : { proxy: proxyTargets }),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
})
