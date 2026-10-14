#!/usr/bin/env node
/**
 * hooks.json 的统一入口：`node <插件目录>/hooks/runner.mjs <EventName>`
 * 事件 JSON 从 stdin 进，结果 JSON 从 stdout 出。
 *
 * 为什么要有这一层薄壳：
 * - 插件目录用**自身位置**推导（`import.meta.url`），不依赖 `${PLUGIN_ROOT}` 在 `command` 里展开
 *   （规范只保证它在 MCP stdio 的 args/env/cwd 里展开，`command` 不保证）；
 * - 构建产物缺失时以退出码 0 静默跳过，绝不让钩子把会话卡住。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(pluginRoot, 'dist', 'hooks.js')

if (!existsSync(entry)) {
  console.error(`[codex-engram] 缺少构建产物 ${entry}；请先执行 pnpm bundle:codex（本次钩子已跳过，不影响会话）`)
  process.exit(0)
}

const { runHookCli } = await import(pathToFileURL(entry).href)
process.exit(await runHookCli(process.argv[2]))
