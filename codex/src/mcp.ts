/**
 * Codex MCP Server（stdio）：把六个 `engram_*` 工具挂到官方 MCP SDK 上。
 *
 * 设计纪律：
 * 1. **stdout 是 JSON-RPC 通道**——本文件把 `console.log` 收编到 stderr，任何日志、依赖告警、
 *    迁移提示都不得污染 stdout（否则客户端解析失败、连接直接失效）。
 * 2. **快速启动**：进程启动不打开数据库、不加载嵌入模型、不调用任何 LLM；Runtime 与工具定义
 *    在首次工具调用时才创建（懒加载）。模型下载与辅助 LLM 调用属后续阶段，不进 MCP 启动流程。
 * 3. **项目作用域逐调用解析**：MCP 进程 cwd 不可信（见 project-context.ts），
 *    可信来源为「工具参数 projectRoot → ENGRAM_PROJECT_ROOT → MCP roots/list」。
 * 4. 退出前 `await runtime.close()`：Windows 上不关句柄会锁住 .db 文件。
 * @module codex-engram/mcp
 */

import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { PROJECT_ROOT_ENV } from './project-context.ts'
import { resolveCodexDbDir } from './paths.ts'
import { openCodexRuntime } from './runtime.ts'
import type { CodexRuntime } from './runtime.ts'
import { createCodexTools } from './tools.ts'

/** 嵌入模式环境变量：默认 off（MCP 不下载模型、不起网络）；设 `lazy` 才按需加载本地嵌入。 */
const EMBEDDING_ENV = 'ENGRAM_EMBEDDING'

/** 服务器标识（客户端展示与日志归因）。 */
const SERVER_NAME = 'codex-engram'
const SERVER_VERSION = '0.1.0'

/** 客户端 roots 查询超时（毫秒）：客户端不响应时不能让工具调用一直挂着。 */
const ROOTS_TIMEOUT_MS = 2000

/** node:sqlite 要求 Node ≥ 22.19（package.json engines 同口径）。 */
const MIN_NODE = [22, 19] as const

/**
 * 启动 stdio MCP 服务。
 * @param env - 进程环境（测试可注入）。
 * @param transport - 传输层；缺省 stdio（测试可注入内存传输）。
 * @returns 句柄：`close()` 关闭传输与数据库连接。
 */
export async function startMcpServer(
  env: NodeJS.ProcessEnv = process.env,
  transport: Transport = new StdioServerTransport(),
): Promise<{ close: () => Promise<void> }> {
  // stdout 只允许 JSON-RPC：把 console.log 收编到 stderr（防御任何依赖的意外 stdout 输出）。
  const originalLog = console.log
  console.log = (...args: unknown[]): void => {
    console.error(...args)
  }
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    console.error(`[codex-engram] 警告：当前 Node ${process.versions.node} 低于 ${MIN_NODE.join('.')}，node:sqlite 可能不可用；请用 Node ${MIN_NODE.join('.')}+ / 24+ 启动 Codex。`)
  }
  console.error(`[codex-engram] MCP 启动（node ${process.versions.node}，pid ${String(process.pid)}）；数据库在首次工具调用时按需打开。`)

  // Runtime 懒加载：启动期不碰数据库、不加载嵌入模型。
  let runtimePromise: Promise<CodexRuntime> | undefined
  const getRuntime = (): Promise<CodexRuntime> => {
    runtimePromise ??= openCodexRuntime({
      // 数据目录由进程环境决定（`CODEX_ENGRAM_DIR` > `<CODEX_HOME>/engram`）；显式传参便于测试注入。
      dbDir: resolveCodexDbDir(env),
      // cwd 仅作「未显式给 projectRoot」时的缺省标识；工具层对项目作用域强制要求上下文，
      // 因此这里不会把插件目录当项目库使用。
      cwd: env[PROJECT_ROOT_ENV] ?? process.cwd(),
      embedding: env[EMBEDDING_ENV] === 'lazy' ? 'lazy' : 'off',
      ...(env.HF_ENDPOINT === undefined ? {} : { hfEndpoint: env.HF_ENDPOINT }),
    }).catch((error: unknown) => {
      // 打开失败不缓存坏句柄：下次调用可重试（例如目录权限修复后）。
      runtimePromise = undefined
      throw error
    })
    return runtimePromise
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
    instructions: [
      'codex-engram 提供跨会话长期记忆：engram_save 保存、engram_search 检索、engram_list 盘点、',
      'engram_get 读取全文、engram_update 修正（取代链）、engram_forget 软删除。',
      `项目级记忆需要项目上下文：调用时传 projectRoot=当前工作区绝对路径（或由宿主配置 ${PROJECT_ROOT_ENV}）。`,
      '无法确定项目时项目级操作会被拒绝——与具体项目无关的偏好请用 scope="user"。',
    ].join(''),
  })

  /** 客户端 roots（`roots/list`）：可信工作区信息的第三条来源；逐调用查询，不缓存以免串项目。 */
  const clientRoots = async (): Promise<readonly string[]> => {
    const capabilities = server.server.getClientCapabilities()
    if (capabilities?.roots === undefined) return []
    try {
      const result = await Promise.race([
        server.server.listRoots(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => { reject(new Error('roots/list 超时')) }, ROOTS_TIMEOUT_MS).unref()
        }),
      ])
      const roots: string[] = []
      for (const root of result.roots) {
        if (typeof root.uri !== 'string') continue
        try {
          roots.push(fileURLToPath(root.uri))
        } catch {
          // 非 file:// URI（如 https）不是本地工作区，忽略。
        }
      }
      if (roots.length > 0) console.error(`[codex-engram] 客户端 roots：${roots.join('、')}`)
      return roots
    } catch (error) {
      console.error('[codex-engram] roots/list 不可用，项目上下文回退到 ENGRAM_PROJECT_ROOT：', error instanceof Error ? error.message : error)
      return []
    }
  }

  /** 工具执行时才解析 Runtime（handler 内 await），避免启动期打开数据库。 */
  let runtime: CodexRuntime | undefined
  const tools = createCodexTools({
    runtime: () => {
      if (runtime === undefined) throw new Error('codex-engram: runtime 尚未就绪（应在执行工具前 await getRuntime()）')
      return runtime
    },
    env,
    clientRoots,
    pluginRoot: fileURLToPath(new URL('..', import.meta.url)),
  })
  for (const tool of tools) {
    server.registerTool(tool.name, {
      title: tool.annotations.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: {
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        idempotentHint: tool.annotations.idempotentHint,
        openWorldHint: tool.annotations.openWorldHint,
      },
    }, async (args: unknown) => {
      runtime ??= await getRuntime()
      return await tool.handler((args ?? {}) as Record<string, unknown>)
    })
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    try {
      await transport.close()
    } catch {
      // 传输已断开时的关闭失败无补救动作。
    }
    try {
      if (runtime !== undefined) await runtime.close()
    } catch (error) {
      console.error('[codex-engram] 关闭运行时失败：', error instanceof Error ? error.message : error)
    }
    console.log = originalLog
  }
  const exitAfterClose = (reason: string): void => {
    console.error(`[codex-engram] 退出（${reason}）。`)
    void close().then(() => { process.exit(0) }, () => { process.exit(0) })
  }

  transport.onclose = () => { exitAfterClose('连接关闭') }
  process.on('SIGINT', () => { exitAfterClose('SIGINT') })
  process.on('SIGTERM', () => { exitAfterClose('SIGTERM') })
  process.on('unhandledRejection', reason => {
    // 协议通道不能因未处理拒绝而中断：落 stderr，继续服务。
    console.error('[codex-engram] 未处理的 Promise 拒绝：', reason)
  })

  await server.connect(transport)
  console.error('[codex-engram] MCP 已连接（stdio）。')
  return { close }
}

// 直接执行（`node dist/mcp.js`）时启动服务；被测试 import 时不自动启动。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startMcpServer()
}
