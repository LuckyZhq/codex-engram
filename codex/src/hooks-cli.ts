/**
 * Hook 命令行入口：Codex 把事件 JSON 写进进程 stdin，本入口把结果写进 stdout。
 *
 * 铁律（违反其一都会让钩子静默失效或污染协议）：
 * 1. **stdout 只允许合法 JSON 或空**——日志一律 `console.error`；
 * 2. **任何失败都以退出码 0 收场**：钩子是宿主链路上的旁挂件，不能因为记忆库的问题让会话可用性受损；
 * 3. **退出前关闭数据库句柄**（Windows 上不关会锁住 .db 文件），且**按需打开**（无事可做的事件不碰数据库）。
 * @module codex-engram/hooks-cli
 */

import { pathToFileURL } from 'node:url'
import { DEFAULT_HOOKS_CONFIG, runHook } from './hooks.ts'
import type { HooksConfig, IngestMode } from './hooks.ts'
import { parseHookInput } from './hook-events.ts'
import { resolveCodexDbDir } from './paths.ts'
import { openCodexRuntime } from './runtime.ts'
import type { CodexRuntime } from './runtime.ts'

/** 摄取档位环境变量（off|explicit|auto）。 */
const INGEST_ENV = 'ENGRAM_INGEST'
/** 注入开关环境变量（`off` 关闭注入，只做摄取）。 */
const INJECT_ENV = 'ENGRAM_INJECT'
/** 嵌入模式环境变量（hooks 关键路径默认 off：不下载模型、不联网）。 */
const EMBEDDING_ENV = 'ENGRAM_EMBEDDING'

/** 读尽 stdin。 */
async function readStdin(): Promise<string> {
  const chunks: string[] = []
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) chunks.push(String(chunk))
  return chunks.join('')
}

/** 从环境变量解析 hook 配置（非法值告警并回落默认）。 */
export function resolveHooksConfig(env: NodeJS.ProcessEnv): HooksConfig {
  const raw = env[INGEST_ENV]?.trim().toLowerCase()
  let ingest: IngestMode = DEFAULT_HOOKS_CONFIG.ingest
  if (raw === 'off' || raw === 'explicit' || raw === 'auto') {
    ingest = raw
  } else if (raw !== undefined && raw !== '') {
    console.error(`[codex-engram] 忽略非法 ${INGEST_ENV}="${raw}"（应为 off|explicit|auto）`)
  }
  return {
    ...DEFAULT_HOOKS_CONFIG,
    ingest,
    ...(env[INJECT_ENV] === 'off' ? { inject: false } : {}),
  }
}

/**
 * 执行一次 hook CLI 调用。
 * @param eventArg - 命令行传入的事件名（hooks.json 的 `runner.mjs SessionStart`）；缺省取 stdin 里的 hook_event_name。
 * @param env - 进程环境（测试可注入）。
 * @param stdinText - stdin 内容（测试可注入；缺省从真实 stdin 读）。
 * @returns 进程退出码（恒为 0，除非 stdout 写入本身失败）。
 */
export async function runHookCli(
  eventArg?: string,
  env: NodeJS.ProcessEnv = process.env,
  stdinText?: string,
): Promise<number> {
  // stdout 纯净守卫：任何依赖的 console.log 都被收编到 stderr。
  const originalLog = console.log
  console.log = (...args: unknown[]): void => { console.error(...args) }
  let runtime: CodexRuntime | undefined
  try {
    const raw = stdinText ?? await readStdin()
    const input = parseHookInput(raw, eventArg)
    if (input === undefined) {
      console.error('[codex-engram] 无法解析 hook 输入（事件名缺失或 JSON 非法），本次不做任何事')
      return 0
    }
    // 按需打开：真正需要读写的事件才创建 Runtime（Stop 在 stop_hook_active 时完全不碰数据库）。
    let runtimePromise: Promise<CodexRuntime> | undefined
    const getRuntime = (): Promise<CodexRuntime> => {
      runtimePromise ??= openCodexRuntime({
        dbDir: resolveCodexDbDir(env),
        cwd: input.cwd ?? process.cwd(),
        embedding: env[EMBEDDING_ENV] === 'lazy' ? 'lazy' : 'off',
        ...(env.HF_ENDPOINT === undefined ? {} : { hfEndpoint: env.HF_ENDPOINT }),
      }).then(created => {
        runtime = created
        return created
      })
      return runtimePromise
    }
    const outcome = await runHook(input.event, input, { runtime: getRuntime, config: resolveHooksConfig(env) })
    for (const note of outcome.notes) console.error(`[codex-engram] ${input.event}: ${note}`)
    if (outcome.stdout !== '') process.stdout.write(outcome.stdout)
  } catch (error) {
    // 兜底：绝不让钩子把会话搞崩。
    console.error('[codex-engram] hook 异常（已忽略）：', error instanceof Error ? error.message : error)
  } finally {
    try {
      if (runtime !== undefined) await runtime.close()
    } catch (error) {
      console.error('[codex-engram] 关闭数据库失败：', error instanceof Error ? error.message : error)
    }
    console.log = originalLog
  }
  return 0
}

// 直接执行时启动（`node dist/hooks.js SessionStart`）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runHookCli(process.argv[2]))
}
