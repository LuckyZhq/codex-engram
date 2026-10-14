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
 * - mock API 插件仅实现 configureServer——只在 dev server 挂载，
 *   不进入生产构建；D2 真实服务上线后改配 proxy 即切真数据；
 * - 仅监听 127.0.0.1（与 codex/web 的绑定策略一致）。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [mockEngramApi()],
  server: {
    host: '127.0.0.1',
    port: 3927,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
})
