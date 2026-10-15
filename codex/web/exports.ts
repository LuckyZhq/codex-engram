/**
 * 导出与镜像：输出路径隔离、文件权限与响应装配（D2.3-C）。
 *
 * 三条边界：
 * 1. **路径隔离**：镜像目录三层区分 `<dbDir>/palaces/<scope>/<项目库标识>/<导出批次 id>`。
 *    导出 id 由服务端生成（`newExportId`），**不接受请求传入的路径或目录名**——
 *    同一秒的多次导出、不同项目库的导出互不覆盖。
 * 2. **文件权限**：镜像含用户偏好、工作资料与历史记忆，目录 0o700、文件 0o600
 *    （`writeMirror` 已按此写入；Windows 忽略权限位，靠目录位置隔离）。
 *    导出目录在数据目录下、不在 `ui/dist` 内，**静态资源路由天然不可达**。
 * 3. **无副作用边界**：markdown / json 导出只读数据库，不落盘；mirror 虽然是 GET，
 *    但会写服务端文件系统（保留面板 `<a href>` 直链兼容性的既有契约），
 *    且**绝不修改 SQLite 记忆记录**。
 * @module codex-engram/web/exports
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { ExportData } from '../../src/types.ts'
import type { CodexScope } from '../src/runtime.ts'

/** 镜像输出根目录名（数据目录下，与库文件同级）。 */
const PALACES_DIR = 'palaces'

/** 库不存在的空导出（导出接口返回合法空结构，不建空库）。 */
export function emptyExport(now: number = Date.now()): ExportData {
  return { exportedAt: now, records: [], edges: [] }
}

/**
 * 导出批次 id：**时间戳 + 随机段**。
 * 只用时间戳不够（同一秒导出会互相覆盖），只用随机段不便于人肉按时间浏览目录。
 */
export function newExportId(now: number = Date.now()): string {
  const stamp = new Date(now).toISOString().replaceAll(':', '-').slice(0, 19)
  return `${stamp}-${randomUUID().slice(0, 8)}`
}

/**
 * 镜像输出目录：`<dbDir>/palaces/<scope>/<项目库标识>/<导出批次 id>`。
 * user 库没有「项目库标识」这一段（它自己就是唯一标识），故目录少一层。
 */
export function palaceDir(dbDir: string, scope: CodexScope, dbName: string, exportId: string): string {
  const leaf = scope === 'user' ? 'user' : dbName.replace(/\.db$/, '')
  return join(dbDir, PALACES_DIR, scope, leaf, exportId)
}

/** 建私有目录（0o700，逐层递归）；供镜像写入前调用，保证中间层也不外泄。 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

/** Markdown 导出正文（与 DSH routes.ts 同结构，便于两边的导出文件互相对比）。 */
function renderMarkdown(scope: CodexScope, data: ExportData): string {
  return [
    `# codex-engram 导出（${scope}）`,
    '',
    ...data.records.map(record =>
      `- [${record.status}/${record.kind}] ${record.content}（id=${record.id}，importance ${record.importance}）`),
    '',
    '## 关系边',
    ...data.edges.map(edge => `- ${edge.from} --${edge.type}--> ${edge.to}`),
    '',
  ].join('\n')
}

/**
 * 发导出响应（`<a href>` 直链下载，Cookie 认证随请求自动携带）。
 * 名字与 DSH 一致：`engram-<scope>-<ISO 时间戳>.<ext>`。
 */
export function sendExport(
  res: ServerResponse,
  format: 'markdown' | 'json',
  scope: CodexScope,
  data: ExportData,
): void {
  const stamp = new Date(data.exportedAt).toISOString().replaceAll(':', '-')
  res.writeHead(200, {
    'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="engram-${scope}-${stamp}.${format}"`,
  })
  res.end(format === 'json' ? JSON.stringify(data, null, 2) : renderMarkdown(scope, data))
}
