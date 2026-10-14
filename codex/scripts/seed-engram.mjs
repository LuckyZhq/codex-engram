#!/usr/bin/env node
/**
 * 为 hooks 性能基准预置规模数据（不碰真实 Codex 存储）。
 *
 * 用法：node --experimental-strip-types codex/scripts/seed-engram.mjs <dbDir> <count> [repoRoot]
 *   dbDir    目标 Engram 数据目录（基准用临时目录）
 *   count    预置条数（用户库；给了 repoRoot 时项目库同样预置）
 *   repoRoot 可选的项目根（模拟「库已有一定规模」的项目库）
 */

import { openCodexRuntime } from '../src/runtime.ts'

const [, , dbDir, countArg, repoRoot] = process.argv
if (dbDir === undefined) {
  console.error('用法: seed-engram.mjs <dbDir> <count> [repoRoot]')
  process.exit(2)
}
const count = Number(countArg ?? '200')
if (!Number.isInteger(count) || count <= 0) {
  console.error(`count 必须是正整数，收到 ${String(countArg)}`)
  process.exit(2)
}

const runtime = await openCodexRuntime({ dbDir, embedding: 'off' })
for (let i = 0; i < count; i++) {
  await runtime.save({
    content: `预置用户记忆 ${i}：跨项目通用的第 ${i} 条偏好与背景信息，用于性能基准的规模模拟。`,
    kind: 'fact',
    scope: 'user',
  })
  if (repoRoot !== undefined) {
    await runtime.save({
      content: `预置项目记忆 ${i}：项目构件 ${i} 的部署端口与提交前检查流程说明。`,
      kind: 'fact',
      scope: 'project',
      projectRoot: repoRoot,
    })
  }
}
console.log(`已预置 ${count} 条用户记忆${repoRoot === undefined ? '' : ` + ${count} 条项目记忆`} → ${dbDir}`)
await runtime.close()
