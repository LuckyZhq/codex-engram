import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

// Codex 侧构建：三个**自包含**产物——
// - dist/mcp.js   MCP Server（`node ${PLUGIN_ROOT}/dist/mcp.js`）
// - dist/hooks.js Hook 分发（由 hooks/runner.mjs 按自身位置加载）
// - dist/web.js   WebAPI + 静态 UI 服务（`node dist/web.js`，仅绑 127.0.0.1）
// 为什么不让 @modelcontextprotocol/sdk 走外置依赖：插件目录里没有 node_modules，
// 外置依赖会直接 MODULE_NOT_FOUND。只保留 node: 内置模块外置。
export default defineConfig({
  entry: {
    mcp: fileURLToPath(new URL('./src/mcp.ts', import.meta.url)),
    hooks: fileURLToPath(new URL('./src/hooks-cli.ts', import.meta.url)),
    web: fileURLToPath(new URL('./web/server.ts', import.meta.url)),
  },
  outDir: fileURLToPath(new URL('./dist', import.meta.url)),
  format: 'esm',
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: false,
  sourcemap: false,
  clean: true,
  deps: { alwaysBundle: [/^zod/, /^@modelcontextprotocol\//], onlyBundle: false },
})
