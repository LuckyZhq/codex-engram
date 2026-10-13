#!/usr/bin/env node
/**
 * prepare 的构建兜底：lib/ 缺失时现场构建。
 *
 * 场景：从 GitHub 源码快捷安装（dsh plugin add github:...）会以源码形态执行 prepare，
 * 此时没有构建产物，宿主以 "no entry point" 失败而非提示构建——这里补上自动构建。
 * 开发仓（clone + pnpm install）通常已有 lib/ 或随后手动构建，仅在缺失时才付构建成本。
 * 跨平台：经 node 执行 pnpm（Windows 下 pnpm 是 .cmd，shell 默认解析）。
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../lib/index.js', import.meta.url))
if (existsSync(entry)) {
  console.log('[prepare] lib/index.js present, skipping build')
} else {
  console.log('[prepare] lib/index.js missing — building (pnpm run bundle)...')
  execSync('pnpm run bundle', { stdio: 'inherit', cwd: fileURLToPath(new URL('..', import.meta.url)) })
  if (!existsSync(entry)) {
    console.error('[prepare] build finished but lib/index.js is still missing — check the bundle output above')
    process.exitCode = 1
  }
}
