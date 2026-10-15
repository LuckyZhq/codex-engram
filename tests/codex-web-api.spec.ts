import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCodexRuntime } from '../codex/src/runtime.ts'
import type { CodexRuntime } from '../codex/src/runtime.ts'
import { createWebServer } from '../codex/web/server.ts'
import type { WebServer } from '../codex/web/server.ts'
import { handleEngramApi } from '../codex/web/api.ts'
import {
  InvalidSelectorError, UnknownProjectError, createProjectRegistry, scanProjectDbs,
} from '../codex/web/projects.ts'
import type { ProjectRegistry } from '../codex/web/projects.ts'
import { cookieValue, readJsonBody } from '../codex/web/auth.ts'

/** 固定测试令牌（生产由进程随机生成；测试需要可预测值）。 */
const TEST_TOKEN = 'test-token-abc123'

const servers: WebServer[] = []
const runtimes: CodexRuntime[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    try { await server.close() } catch { /* 已关闭的句柄重复关闭无意义 */ }
  }))
  await Promise.all(runtimes.splice(0).map(async runtime => {
    try { await runtime.close() } catch { /* 同上 */ }
  }))
})

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** 造一个仓库目录（带 origin；无 origin 时走 cwd 兜底标识）。 */
async function makeRepo(originUrl: string): Promise<string> {
  const dir = await tempDir('codex-web-repo-')
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "origin"]',
    `\turl = ${originUrl}`,
  ].join('\n'))
  return dir
}

/** 启动测试服务（临时 dbDir + 临时端口 + 固定令牌）。 */
async function startServer(options: {
  readonly dbDir: string
  readonly projectRoot?: string
  readonly uiDir?: string
}): Promise<{ server: WebServer; runtime: CodexRuntime; base: string }> {
  const runtime = await openCodexRuntime({ dbDir: options.dbDir, embedding: 'off' })
  runtimes.push(runtime)
  const server = createWebServer({
    runtime,
    port: 0,
    token: TEST_TOKEN,
    log: () => { /* 测试静默 */ },
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    ...(options.uiDir === undefined ? {} : { uiDir: options.uiDir }),
  })
  servers.push(server)
  await server.start()
  return { server, runtime, base: `http://127.0.0.1:${String(server.address().port)}` }
}

/** Bearer 认证头（绕过 Cookie 的 API 直连路径）。 */
function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TEST_TOKEN}` }
}

/** 造一个最小 UI 静态目录（index.html + 一个 assets 文件 + 目录外机密文件）。 */
async function makeUiDir(): Promise<{ uiDir: string; secret: string }> {
  const root = await tempDir('codex-web-ui-')
  const uiDir = join(root, 'ui')
  await mkdir(join(uiDir, 'assets'), { recursive: true })
  await writeFile(join(uiDir, 'index.html'), '<!DOCTYPE html><title>engram-ui</title><body>UI-OK</body>')
  await writeFile(join(uiDir, 'assets', 'app.js'), 'console.log("app")')
  const secret = join(root, 'secret.txt')
  await writeFile(secret, 'TOP-SECRET')
  return { uiDir, secret }
}

describe('codex/web — 认证与请求防护', () => {
  it('未认证请求一律 401（API 与静态资源都不放行）', async () => {
    const dbDir = await tempDir('codex-web-auth-')
    const { base } = await startServer({ dbDir })
    const api = await fetch(`${base}/api/engram/workspaces`)
    expect(api.status).toBe(401)
    expect((await api.json()).error).toBe('unauthorized')

    const write = await fetch(`${base}/api/engram/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x', content: 'y' }),
    })
    expect(write.status).toBe(401)

    const asset = await fetch(`${base}/assets/app.js`)
    expect(asset.status).toBe(401)

  })

  it('Bearer 令牌可直连 API；会话 Cookie 经 /auth 一次性换取', async () => {
    const dbDir = await tempDir('codex-web-auth-')
    const { base } = await startServer({ dbDir })

    // Bearer 通道
    const direct = await fetch(`${base}/api/engram/session`, { headers: bearer() })
    expect(direct.status).toBe(200)
    expect((await direct.json()).authenticated).toBe(true)

    // 错误令牌 → 403，不换会话
    const wrong = await fetch(`${base}/auth?token=nope`, { redirect: 'manual' })
    expect(wrong.status).toBe(403)

    // 正确令牌 → 302 + HttpOnly/SameSite=Strict Cookie
    const ok = await fetch(`${base}/auth?token=${TEST_TOKEN}`, { redirect: 'manual' })
    expect(ok.status).toBe(302)
    const setCookie = ok.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('engram_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    const sessionId = /engram_session=([^;]+)/.exec(setCookie)?.[1] ?? ''

    // Cookie 通道：API 与「直接下载链接」同源生效
    const viaCookie = await fetch(`${base}/api/engram/workspaces`, {
      headers: { cookie: `engram_session=${sessionId}` },
    })
    expect(viaCookie.status).toBe(200)

    // 伪造/过期会话 → 401
    const forged = await fetch(`${base}/api/engram/workspaces`, {
      headers: { cookie: 'engram_session=forged-session-id' },
    })
    expect(forged.status).toBe(401)

  })

  it('恶意 Host 与非回环 Origin 被拒绝（403）', async () => {
    const dbDir = await tempDir('codex-web-auth-')
    const { server } = await startServer({ dbDir })
    const port = server.address().port

    // fetch 禁止覆盖 Host 头（forbidden header），恶意 Host 用 node:http 直发。
    const badHost = await new Promise<number>((resolvePromise, rejectPromise) => {
      const req = httpRequest({
        host: '127.0.0.1', port, path: '/api/engram/workspaces', method: 'GET',
        headers: { host: '127.0.0.1.evil.example.com', authorization: `Bearer ${TEST_TOKEN}` },
      }, res => {
        res.resume()
        res.on('end', () => { resolvePromise(res.statusCode ?? 0) })
      })
      req.on('error', rejectPromise)
      req.end()
    })
    expect(badHost).toBe(403)

    const badOrigin = await fetch(`http://127.0.0.1:${String(port)}/api/engram/update`, {
      method: 'POST',
      headers: { ...bearer(), origin: 'http://evil.example.com', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(badOrigin.status).toBe(403)

  })

  it('POST 信封：坏 JSON 400、超大 body 413、错误 Content-Type 415', async () => {
    const dbDir = await tempDir('codex-web-auth-')
    const { base } = await startServer({ dbDir })

    const badJson = await fetch(`${base}/api/engram/update`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(badJson.status).toBe(400)

    const huge = await fetch(`${base}/api/engram/update`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(70_000) }),
    })
    expect(huge.status).toBe(413)

    const wrongType = await fetch(`${base}/api/engram/update`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(wrongType.status).toBe(415)

  })

  it('方法白名单：仅 GET/POST，其余 405', async () => {
    const dbDir = await tempDir('codex-web-auth-')
    const { base } = await startServer({ dbDir })
    const put = await fetch(`${base}/api/engram/workspaces`, { method: 'PUT', headers: bearer() })
    expect(put.status).toBe(405)
    // 已知路由 + 错误方法 → 405（与未知路由的 404 区分）
    const postGetRoute = await fetch(`${base}/api/engram/workspaces`, {
      method: 'POST', headers: { ...bearer(), 'content-type': 'application/json' }, body: '{}',
    })
    expect(postGetRoute.status).toBe(405)

  })
})

describe('codex/web — 项目定位与数据隔离', () => {
  it('两个项目库经选择器切换：数据、计数互不串库', async () => {
    const dbDir = await tempDir('codex-web-scope-')
    const repoA = await makeRepo('git@github.com:acme/alpha.git')
    const repoB = await makeRepo('git@github.com:acme/beta.git')
    const { runtime, base } = await startServer({ dbDir })

    await runtime.save({ content: 'Alpha 约定一', kind: 'decision', projectRoot: repoA })
    await runtime.save({ content: 'Alpha 约定二', kind: 'fact', projectRoot: repoA })
    await runtime.save({ content: 'Beta 约定一', kind: 'fact', projectRoot: repoB })
    const dbA = runtime.scopeDbName('project', repoA)
    const dbB = runtime.scopeDbName('project', repoB)
    expect(dbA).not.toBe(dbB)

    const listA = await (await fetch(`${base}/api/engram/list?scope=project&project=${dbA}`, { headers: bearer() })).json()
    expect(listA.total).toBe(2)
    expect(listA.records.map((r: { content: string }) => r.content)).toContain('Alpha 约定一')

    const listB = await (await fetch(`${base}/api/engram/list?scope=project&project=${dbB}`, { headers: bearer() })).json()
    expect(listB.total).toBe(1)
    expect(listB.records[0].content).toBe('Beta 约定一')

    // stats 同样按选择器走：A 库 total=2，B 库 total=1
    const statsA = await (await fetch(`${base}/api/engram/stats?scope=project&project=${dbA}`, { headers: bearer() })).json()
    expect(statsA.parts).toEqual([{ scope: 'project', stats: expect.objectContaining({ total: 2, active: 2 }) }])
    const statsB = await (await fetch(`${base}/api/engram/stats?scope=project&project=${dbB}`, { headers: bearer() })).json()
    expect(statsB.parts[0].stats.total).toBe(1)

    // 用户库与项目库隔离：user 写入不出现在任一项目库
    await runtime.save({ content: '通用偏好', kind: 'preference', scope: 'user' })
    const listUser = await (await fetch(`${base}/api/engram/list?scope=user`, { headers: bearer() })).json()
    expect(listUser.total).toBe(1)
    const listAAgain = await (await fetch(`${base}/api/engram/list?scope=project&project=${dbA}`, { headers: bearer() })).json()
    expect(listAAgain.total).toBe(2)

  })

  it('未知项目选择器 → 404 unknown project（面板自愈依赖的精确组合）', async () => {
    const dbDir = await tempDir('codex-web-scope-')
    const { base } = await startServer({ dbDir })
    const missing = `project-${'f'.repeat(24)}.db`
    const res = await fetch(`${base}/api/engram/list?scope=project&project=${missing}`, { headers: bearer() })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('unknown project')

    const stats = await fetch(`${base}/api/engram/stats?scope=project&project=${missing}`, { headers: bearer() })
    expect(stats.status).toBe(404)

  })

  it('非法选择器被拒绝（400）：不接受路径拼装与穿越', async () => {
    const dbDir = await tempDir('codex-web-scope-')
    const { base } = await startServer({ dbDir })
    for (const selector of ['user.db', '../../etc/passwd', 'project-xyz.db', 'PROJECT-ABCDEF1234567890ABCDEF12.db']) {
      const res = await fetch(`${base}/api/engram/list?scope=project&project=${encodeURIComponent(selector)}`, { headers: bearer() })
      expect(res.status, `selector=${selector}`).toBe(400)
    }

  })

  it('空库返回合法空结构，且不凭空创建数据库文件', async () => {
    const dbDir = await tempDir('codex-web-empty-')
    const { base } = await startServer({ dbDir })

    const list = await fetch(`${base}/api/engram/list?scope=user`, { headers: bearer() })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ records: [], total: 0 })

    const stats = await fetch(`${base}/api/engram/stats?scope=user`, { headers: bearer() })
    expect(stats.status).toBe(200)
    expect((await stats.json()).parts).toEqual([])

    const workspaces = await fetch(`${base}/api/engram/workspaces`, { headers: bearer() })
    expect((await workspaces.json()).items).toEqual([])

    // 读路径不建库：user.db 与任何项目库都不应出现
    expect(existsSync(join(dbDir, 'user.db'))).toBe(false)
    expect(scanProjectDbs(dbDir)).toEqual([])

  })

  it('workspaces 清单：扫描到的库只展示文件名；配置的项目根可归属', async () => {
    const dbDir = await tempDir('codex-web-ws-')
    const repoA = await makeRepo('git@github.com:acme/alpha.git')
    const repoB = await makeRepo('git@github.com:acme/beta.git')
    const { runtime, base } = await startServer({ dbDir, projectRoot: repoA })
    await runtime.save({ content: 'Alpha 约定', kind: 'decision', projectRoot: repoA })
    await runtime.save({ content: 'Beta 约定', kind: 'fact', projectRoot: repoB })

    const view = await (await fetch(`${base}/api/engram/workspaces`, { headers: bearer() })).json()
    const dbA = runtime.scopeDbName('project', repoA)
    const dbB = runtime.scopeDbName('project', repoB)

    // 配置根：可归属路径、kind=workspace、source=origin
    const itemA = view.items.find((item: { dbName: string }) => item.dbName === dbA)
    expect(itemA).toMatchObject({ kind: 'workspace', path: repoA, source: 'origin', exists: true, memories: 1 })
    // 扫描到的其它库：不虚构路径/来源，标记未注册（kind=session）
    const itemB = view.items.find((item: { dbName: string }) => item.dbName === dbB)
    expect(itemB).toMatchObject({ kind: 'session', path: null, title: null, exists: true, memories: 1 })
    expect(itemB.source).toBeUndefined()
    expect(itemB.workspaceId).toBeNull()

    // processDefault = 配置根（面板「跟随」态落点）
    expect(view.processDefault).toMatchObject({ dbName: dbA, path: repoA })

    // 无选择器的项目作用域请求 → 解析到默认项目根（不回落进程 cwd）
    const follow = await (await fetch(`${base}/api/engram/list?scope=project`, { headers: bearer() })).json()
    expect(follow.total).toBe(1)
    expect(follow.records[0].content).toBe('Alpha 约定')

  })

  it('无默认项目根时，项目作用域请求被拒绝（不静默回落）', async () => {
    const dbDir = await tempDir('codex-web-ws-')
    const repoA = await makeRepo('git@github.com:acme/alpha.git')
    const { runtime, base } = await startServer({ dbDir })
    await runtime.save({ content: 'Alpha 约定', kind: 'decision', projectRoot: repoA })

    const res = await fetch(`${base}/api/engram/list?scope=project`, { headers: bearer() })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('unknown project')

    // workspaces 的 processDefault 为 null（跟随态无落点，面板要求手动选择）
    const view = await (await fetch(`${base}/api/engram/workspaces`, { headers: bearer() })).json()
    expect(view.processDefault).toBeNull()

  })
})

describe('codex/web — 路由状态与静态分发', () => {
  it('已知未落地路由 501、未知路由 404、shared 作用域 501', async () => {
    const dbDir = await tempDir('codex-web-route-')
    const { base } = await startServer({ dbDir })

    // D2.2 已实装 telemetry 等 16 个查询路由；501 探测改用 D2.3 的 export（写操作与导出阶段）。
    const pending = await fetch(`${base}/api/engram/export`, { headers: bearer() })
    expect(pending.status).toBe(501)
    expect((await pending.json()).error).toContain('not implemented yet')

    const unknown = await fetch(`${base}/api/engram/no-such-route`, { headers: bearer() })
    expect(unknown.status).toBe(404)

    const shared = await fetch(`${base}/api/engram/list?scope=shared`, { headers: bearer() })
    expect(shared.status).toBe(501)
    expect((await shared.json()).error).toContain('shared')

  })

  it('静态 UI：认证后按 MIME 分发；未认证 HTML 回落令牌页', async () => {
    const dbDir = await tempDir('codex-web-static-')
    const { uiDir } = await makeUiDir()
    const { base } = await startServer({ dbDir, uiDir })

    const index = await fetch(`${base}/`, { headers: bearer() })
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(await index.text()).toContain('UI-OK')

    const asset = await fetch(`${base}/assets/app.js`, { headers: bearer() })
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')

    // 路径穿越：目录外机密文件不可达（%2e%2e 编码穿过 fetch 的 URL 归一化）
    const escape = await fetch(`${base}/%2e%2e/secret.txt`, { headers: bearer() })
    expect(escape.status).toBe(404)
    expect(await escape.text()).not.toContain('TOP-SECRET')
    const escapeDeep = await fetch(`${base}/assets/%2e%2e/%2e%2e/secret.txt`, { headers: bearer() })
    expect(escapeDeep.status).toBe(404)

    // 无扩展名未知路径回落 index.html（SPA 友好）
    const spa = await fetch(`${base}/some/unknown/route`, { headers: bearer() })
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('UI-OK')

    // 未认证：HTML 导航回落令牌录入页，其余 401
    const gate = await fetch(`${base}/`)
    expect(gate.status).toBe(200)
    expect(await gate.text()).toContain('访问令牌')
    const assetNoAuth = await fetch(`${base}/assets/app.js`)
    expect(assetNoAuth.status).toBe(401)

  })

  it('服务重启后数据持久、句柄正常释放', async () => {
    const dbDir = await tempDir('codex-web-restart-')
    const repoA = await makeRepo('git@github.com:acme/alpha.git')

    const first = await startServer({ dbDir })
    await first.runtime.save({ content: '重启后仍可见', kind: 'decision', projectRoot: repoA })
    const dbA = first.runtime.scopeDbName('project', repoA)
    const before = await (await fetch(`${first.base}/api/engram/list?scope=project&project=${dbA}`, { headers: bearer() })).json()
    expect(before.total).toBe(1)
    await first.server.close()

    const second = await startServer({ dbDir })
    const after = await (await fetch(`${second.base}/api/engram/list?scope=project&project=${dbA}`, { headers: bearer() })).json()
    expect(after.total).toBe(1)
    expect(after.records[0].content).toBe('重启后仍可见')
  })
})

describe('codex/web — 单元：body 限制、Cookie 解析、分库扫描', () => {
  it('readJsonBody：按字节计 64 KiB 上限；坏 JSON 与非对象均判 invalid', async () => {
    const asReq = (chunks: readonly (string | Buffer)[]): IncomingMessage =>
      Readable.from(chunks) as unknown as IncomingMessage

    const ok = await readJsonBody(asReq([Buffer.from('{"a":1}')]))
    expect(ok).toEqual({ ok: true, value: { a: 1 } })
    const empty = await readJsonBody(asReq([]))
    expect(empty).toEqual({ ok: true, value: {} })
    const invalid = await readJsonBody(asReq([Buffer.from('[1,2]')]))
    expect(invalid).toEqual({ ok: false, reason: 'invalid' })

    // 65_536 字节整（合法 JSON）放行；65_537 字节超限——按字节不按字符
    const pad = 'x'.repeat(65_536 - 8)
    const exact = await readJsonBody(asReq([Buffer.from('{"p":"' + pad + '"}')]))
    expect(exact.ok).toBe(true)
    const over = await readJsonBody(asReq([Buffer.from('{"p":"' + 'x'.repeat(65_537) + '"}')]))
    expect(over).toEqual({ ok: false, reason: 'too_large' })
  })

  it('cookieValue：正确解析与缺失处理', () => {
    expect(cookieValue('a=1; engram_session=xyz; b=2', 'engram_session')).toBe('xyz')
    expect(cookieValue('a=1', 'engram_session')).toBeUndefined()
    expect(cookieValue(undefined, 'engram_session')).toBeUndefined()
    expect(cookieValue('', 'engram_session')).toBeUndefined()
  })

  it('scanProjectDbs：只认严格分库命名，排序确定', async () => {
    const dbDir = await tempDir('codex-web-scan-')
    await writeFile(join(dbDir, 'user.db'), '')
    await writeFile(join(dbDir, `project-${'a'.repeat(24)}.db`), '')
    await writeFile(join(dbDir, `project-${'b'.repeat(24)}.db`), '')
    await writeFile(join(dbDir, 'project-short.db'), '')
    await writeFile(join(dbDir, 'project-ZZZZ.db'), '')
    await writeFile(join(dbDir, 'notes.txt'), '')
    expect(scanProjectDbs(dbDir)).toEqual([`project-${'a'.repeat(24)}.db`, `project-${'b'.repeat(24)}.db`])
  })

  it('runtime.openExistingProjectDb：非法名抛 INVALID_PROJECT_DB、缺库抛 UNKNOWN_PROJECT、存在则精确打开', async () => {
    const dbDir = await tempDir('codex-web-open-')
    const repoA = await makeRepo('git@github.com:acme/alpha.git')
    const runtime = await openCodexRuntime({ dbDir, embedding: 'off' })
    runtimes.push(runtime)

    await expect(runtime.openExistingProjectDb('user.db')).rejects.toMatchObject({ code: 'INVALID_PROJECT_DB' })
    await expect(runtime.openExistingProjectDb('../../etc/passwd')).rejects.toMatchObject({ code: 'INVALID_PROJECT_DB' })
    await expect(runtime.openExistingProjectDb(`project-${'f'.repeat(24)}.db`)).rejects.toMatchObject({ code: 'UNKNOWN_PROJECT' })

    await runtime.save({ content: '打开我', kind: 'fact', projectRoot: repoA })
    const dbA = runtime.scopeDbName('project', repoA)
    const store = await runtime.openExistingProjectDb(dbA)
    expect((await store.get((await store.list({ scope: 'project', limit: 10, offset: 0 })).records[0]!.id))?.content).toBe('打开我')
    // 同一分库在实例内复用同一连接
    expect(await runtime.openExistingProjectDb(dbA)).toBe(store)
  })

  it('projects.resolve：无默认根且无选择器 → UnknownProjectError；选择器非法 → InvalidSelectorError', async () => {
    const dbDir = await tempDir('codex-web-resolve-')
    const repoA = await makeRepo('git@github.com:acme/alpha.git')
    const runtime = await openCodexRuntime({ dbDir, embedding: 'off' })
    runtimes.push(runtime)

    const bare = createProjectRegistry({ runtime })
    await expect(bare.resolve('project')).rejects.toBeInstanceOf(UnknownProjectError)
    await expect(bare.resolve('project', 'user.db')).rejects.toBeInstanceOf(InvalidSelectorError)
    await expect(bare.resolve('project', `project-${'f'.repeat(24)}.db`)).rejects.toBeInstanceOf(UnknownProjectError)

    const rooted = createProjectRegistry({ runtime, projectRoot: repoA })
    const target = await rooted.resolve('project')
    expect(target).toMatchObject({ scope: 'project', projectRoot: repoA, dbName: runtime.scopeDbName('project', repoA) })
    const userTarget = await rooted.resolve('user')
    expect(userTarget).toEqual({ scope: 'user', dbName: 'user.db' })
  })
})

describe('codex/web — D2.2 核心查询（真实 SQLite，无 Mock）', () => {
  it('空库：查询路由全部返回合法空结构，且读路径不建库', async () => {
    const dbDir = await tempDir('codex-web-d22-empty-')
    const { base } = await startServer({ dbDir })
    const get = async (path: string): Promise<unknown> =>
      (await fetch(`${base}/api/engram/${path}`, { headers: bearer() })).json()

    expect(await get('review-due?scope=user')).toEqual({ scope: 'user', items: [] })
    expect(await get('search-test?q=anything&scope=all')).toEqual({ degraded: true, hits: [] })
    expect(await get('activity?limit=50')).toEqual({ operations: [] })
    expect(await get('profile-block?scope=user')).toEqual({ scope: 'user', block: null, versions: [] })
    expect(await get('entities?scope=user')).toEqual({ scope: 'user', items: [], total: 0 })
    expect(await get('facts?scope=user&entityId=x')).toEqual({ scope: 'user', items: [], total: 0 })
    expect(await get('observations?scope=user')).toEqual({ scope: 'user', items: [], total: 0 })
    expect(await get('observation-evidence?scope=user&ids=a,b')).toEqual({ scope: 'user', items: [] })
    expect(await get('episode-timeline?scope=user')).toEqual({ groups: [] })
    expect(await get('corridor?scope=user')).toEqual({ scope: 'user', nodes: [], edges: [] })
    expect(await get('telemetry?days=7')).toMatchObject({ counts: { writes: 0 }, scopes: [] })
    expect(await get('health')).toEqual({ overall: 0, parts: [], evaluatedAt: expect.any(Number) })
    expect(await get('tour-proposal?scope=user')).toMatchObject({ scope: 'empty', empty: true, activeCount: 0, suggestedStops: [] })
    expect(await get('refurb?scope=user')).toEqual({ scope: 'user', count: 0, suggestions: [] })

    // review / entity 是单条目语义：库不存在 → 404（不是空结构，也不建库）
    expect((await fetch(`${base}/api/engram/review?scope=user&id=x`, { headers: bearer() })).status).toBe(404)
    expect((await fetch(`${base}/api/engram/entity?scope=user&id=x`, { headers: bearer() })).status).toBe(404)

    // 读路径不建库：user.db 与任何项目库都不应出现
    expect(existsSync(join(dbDir, 'user.db'))).toBe(false)
    expect(scanProjectDbs(dbDir)).toEqual([])
  })

  it('review：详情/修订链/操作日志取自真实库；缺 id 400、未知 id 404', async () => {
    const dbDir = await tempDir('codex-web-d22-review-')
    const { runtime, base } = await startServer({ dbDir })
    const saved = await runtime.save({ content: '约定：提交前先跑 typecheck', kind: 'decision', scope: 'user' })
    const revised = await runtime.update({ id: saved.record.id, content: '约定：提交前先跑 typecheck 与单测', scope: 'user' })

    const view = await (await fetch(`${base}/api/engram/review?scope=user&id=${encodeURIComponent(revised.id)}`, { headers: bearer() })).json()
    expect(view.record.content).toContain('typecheck 与单测')
    expect(view.supersedes).toContain(saved.record.id)
    expect(view.operations.map((op: { op: string }) => op.op)).toContain('update')

    // 旧条目视角：状态归档 + 被谁取代 + superseded 审计行 + 修订快照均可回溯
    //（修订快照挂在被取代的旧条目上——内容不变性审计）
    const oldView = await (await fetch(`${base}/api/engram/review?scope=user&id=${encodeURIComponent(saved.record.id)}`, { headers: bearer() })).json()
    expect(oldView.record.status).toBe('archived')
    expect(oldView.supersededBy).toContain(revised.id)
    expect(oldView.operations.map((op: { op: string }) => op.op)).toContain('superseded')
    expect(oldView.revisions.length).toBeGreaterThanOrEqual(1)
    expect(oldView.revisions[0].content).toContain('提交前先跑 typecheck')

    const noId = await fetch(`${base}/api/engram/review?scope=user`, { headers: bearer() })
    expect(noId.status).toBe(400)
    const missing = await fetch(`${base}/api/engram/review?scope=user&id=nope`, { headers: bearer() })
    expect(missing.status).toBe(404)
  })

  it('review-due：到期队列只给线索（无正文），逾期天数来自真实调度', async () => {
    const dbDir = await tempDir('codex-web-d22-due-')
    const { runtime, base } = await startServer({ dbDir })
    const store = await runtime.openScope('user')
    const due = await store.write({ scope: 'user', kind: 'fact', content: '明天要复习的秘密内容', initialReviewAt: Date.now() - 2 * 86_400_000 })
    await store.write({ scope: 'user', kind: 'fact', content: '还没到期的条目', initialReviewAt: Date.now() + 5 * 86_400_000 })

    const body = await (await fetch(`${base}/api/engram/review-due?scope=user`, { headers: bearer() })).json()
    expect(body.scope).toBe('user')
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe(due.id)
    expect(body.items[0].overdueDays).toBeGreaterThanOrEqual(2)
    expect(body.items[0].reps).toBe(0)
    expect(body.items[0].nextReviewAt).toBeLessThan(Date.now())
    // 检索练习：线索视图不给正文
    expect(JSON.stringify(body)).not.toContain('秘密内容')
  })

  it('search-test：真实检索——分数/命中原委/降级标注；q 必填、shared 501', async () => {
    const dbDir = await tempDir('codex-web-d22-bench-')
    const repoA = await makeRepo('git@github.com:acme/alpha.git')
    const { runtime, base } = await startServer({ dbDir })
    await runtime.save({ content: '编译产物在 dist 目录', kind: 'fact', scope: 'user' })
    await runtime.save({ content: 'Alpha 项目用 pnpm 构建', kind: 'fact', projectRoot: repoA })
    const dbA = runtime.scopeDbName('project', repoA)

    // 合并视图（面板 forceProject 语义：带选择器时项目段参与）
    const bench = await (await fetch(`${base}/api/engram/search-test?q=pnpm&scope=all&project=${dbA}`, { headers: bearer() })).json()
    expect(bench.degraded).toBe(true) // Codex 默认 embedding:'off' → 语义道缺失，如实标注降级
    expect(bench.hits).toHaveLength(1)
    expect(bench.hits[0]).toMatchObject({ scope: 'project', kind: 'fact', via: 'fts' })
    expect(bench.hits[0].score).toBeGreaterThan(0)
    expect(bench.hits[0].content).toContain('pnpm')

    // 单 scope 严格：user 库检索不到项目库内容（项目隔离）
    const userOnly = await (await fetch(`${base}/api/engram/search-test?q=pnpm&scope=user`, { headers: bearer() })).json()
    expect(userOnly.hits).toHaveLength(0)

    const noQ = await fetch(`${base}/api/engram/search-test?scope=user`, { headers: bearer() })
    expect(noQ.status).toBe(400)
    const shared = await fetch(`${base}/api/engram/search-test?q=pnpm&scope=shared`, { headers: bearer() })
    expect(shared.status).toBe(501)
  })

  it('activity：合并两库 op_log（带 scope 标签），项目段跟随选择器', async () => {
    const dbDir = await tempDir('codex-web-d22-activity-')
    const repoA = await makeRepo('git@github.com:acme/alpha.git')
    const { runtime, base } = await startServer({ dbDir })
    await runtime.save({ content: '用户侧偏好：深色模式', kind: 'preference', scope: 'user' })
    await runtime.save({ content: 'Alpha 约定', kind: 'decision', projectRoot: repoA })
    const dbA = runtime.scopeDbName('project', repoA)

    // 无选择器：项目段跳过（Codex 不回落进程 cwd）——不报错，也不虚构项目操作
    const noSelector = await (await fetch(`${base}/api/engram/activity?limit=50`, { headers: bearer() })).json()
    expect(noSelector.operations.every((op: { scope: string }) => op.scope === 'user')).toBe(true)
    expect(noSelector.operations.some((op: { op: string }) => op.op === 'write')).toBe(true)

    // 带选择器：两库合并、时间倒序
    const merged = await (await fetch(`${base}/api/engram/activity?limit=50&project=${dbA}`, { headers: bearer() })).json()
    expect(merged.operations.some((op: { scope: string }) => op.scope === 'project')).toBe(true)
    const times = merged.operations.map((op: { at: number }) => op.at)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('profile-block：当前态 + 版本链（新→旧）；未创建时 block 为 null', async () => {
    const dbDir = await tempDir('codex-web-d22-profile-')
    const { runtime, base } = await startServer({ dbDir })
    const empty = await (await fetch(`${base}/api/engram/profile-block?scope=user`, { headers: bearer() })).json()
    expect(empty).toMatchObject({ scope: 'user', block: null, versions: [] })

    const store = await runtime.openScope('user')
    await store.saveProfileBlock('user', undefined, '第一版画像', 'edit')
    await store.saveProfileBlock('user', 1, '第二版画像', 'edit')
    const view = await (await fetch(`${base}/api/engram/profile-block?scope=user`, { headers: bearer() })).json()
    expect(view.block).toMatchObject({ content: '第二版画像', version: 2 })
    expect(view.versions.map((v: { version: number }) => v.version)).toEqual([2, 1])
    expect(view.versions[0]).toMatchObject({ source: 'edit', content: '第二版画像' })
  })

  it('entities/entity/facts：实体词典、详情与事实版本链（含 asOf 时点回看）', async () => {
    const dbDir = await tempDir('codex-web-d22-entity-')
    const { runtime, base } = await startServer({ dbDir })
    const store = await runtime.openScope('user')
    const node = await store.write({ scope: 'user', kind: 'fact', content: '张三负责编译系统' })
    const [entity] = await store.resolveEntities([{ name: '张三', kind: 'person', aliases: ['老张'] }])
    await store.linkNodeEntities(node.id, [entity!.id])
    const day = 86_400_000
    const [oldFact] = await store.writeFacts([{ entityId: entity!.id, content: '张三在 A 组', validAt: Date.now() - 2 * day }])
    const [freshFact] = await store.writeFacts([{ entityId: entity!.id, content: '张三调到 B 组', validAt: Date.now() - day, replaces: oldFact!.id }])

    const list = await (await fetch(`${base}/api/engram/entities?scope=user`, { headers: bearer() })).json()
    expect(list.total).toBe(1)
    expect(list.items[0].entity).toMatchObject({ name: '张三', kind: 'person', aliases: ['老张'] })
    expect(list.items[0].memoryCount).toBe(1)

    const detail = await (await fetch(`${base}/api/engram/entity?scope=user&id=${encodeURIComponent(entity!.id)}`, { headers: bearer() })).json()
    expect(detail.entity.name).toBe('张三')
    expect(detail.memories.map((m: { content: string }) => m.content)).toEqual(['张三负责编译系统'])

    // 全链：新事实有效、旧事实软失效并回指 replacedBy（版本链可回溯）
    const chain = await (await fetch(`${base}/api/engram/facts?scope=user&entityId=${encodeURIComponent(entity!.id)}&includeInvalid=1`, { headers: bearer() })).json()
    expect(chain.total).toBe(2)
    expect(chain.items[0]).toMatchObject({ content: '张三调到 B 组', invalidAt: null })
    expect(chain.items[1]).toMatchObject({ content: '张三在 A 组', replacedBy: freshFact!.id })
    expect(chain.items[1].invalidAt).not.toBeNull()

    // asOf 时点回看：只看「张三在 A 组」仍有效的时刻
    const asOf = await (await fetch(`${base}/api/engram/facts?scope=user&entityId=${encodeURIComponent(entity!.id)}&asOf=${Date.now() - 3 * day / 2}`, { headers: bearer() })).json()
    expect(asOf.items).toHaveLength(1)
    expect(asOf.items[0].content).toBe('张三在 A 组')

    const noEntityId = await fetch(`${base}/api/engram/facts?scope=user`, { headers: bearer() })
    expect(noEntityId.status).toBe(400)
    const unknownEntity = await fetch(`${base}/api/engram/entity?scope=user&id=nope`, { headers: bearer() })
    expect(unknownEntity.status).toBe(404)
  })

  it('observations / observation-evidence：信念列表（状态筛选）与证据链回溯', async () => {
    const dbDir = await tempDir('codex-web-d22-belief-')
    const { runtime, base } = await startServer({ dbDir })
    // 空态
    const empty = await (await fetch(`${base}/api/engram/observations?scope=user`, { headers: bearer() })).json()
    expect(empty).toEqual({ scope: 'user', items: [], total: 0 })

    const store = await runtime.openScope('user')
    const n1 = await store.write({ scope: 'user', kind: 'fact', content: '证据一：构建要三分钟' })
    const n2 = await store.write({ scope: 'user', kind: 'fact', content: '证据二：测试要两分钟' })
    const obs = await store.createObservation({ scope: 'user', belief: 'CI 全流程约五分钟', sourceIds: [n1.id, n2.id] })
    const stale = await store.createObservation({ scope: 'user', belief: '待复核的信念', sourceIds: [n1.id] })
    await store.markObservationStale(stale.id)

    const all = await (await fetch(`${base}/api/engram/observations?scope=user`, { headers: bearer() })).json()
    expect(all.total).toBe(2)
    const ci = all.items.find((row: { id: string }) => row.id === obs.id)
    expect(ci).toMatchObject({ belief: 'CI 全流程约五分钟', status: 'active', proofCount: 2 })
    expect(ci.sourceIds).toEqual([n1.id, n2.id])

    const staleOnly = await (await fetch(`${base}/api/engram/observations?scope=user&status=stale`, { headers: bearer() })).json()
    expect(staleOnly.total).toBe(1)
    expect(staleOnly.items[0].id).toBe(stale.id)

    // 证据链：sourceIds → 原始记忆行（只读回查）
    const evidence = await (await fetch(`${base}/api/engram/observation-evidence?scope=user&ids=${encodeURIComponent(`${n1.id},${n2.id}`)}`, { headers: bearer() })).json()
    expect(evidence.items.map((r: { content: string }) => r.content).sort()).toEqual(['证据一：构建要三分钟', '证据二：测试要两分钟'])

    const noIds = await fetch(`${base}/api/engram/observation-evidence?scope=user`, { headers: bearer() })
    expect(noIds.status).toBe(400)
  })

  it('episode-timeline：分组模式（组头摘要）与邻近扩展；锚点不存在 404', async () => {
    const dbDir = await tempDir('codex-web-d22-episode-')
    const { runtime, base } = await startServer({ dbDir })
    // 空库先查一次：合法空结构 + 不建库
    const empty = await (await fetch(`${base}/api/engram/episode-timeline?scope=user`, { headers: bearer() })).json()
    expect(empty).toEqual({ groups: [] })
    expect(existsSync(join(dbDir, 'user.db'))).toBe(false)

    const store = await runtime.openScope('user')
    const e1 = await store.write({ scope: 'user', kind: 'episode', content: '第一天：立项', sourceSessionId: 'sess-1' })
    const e2 = await store.write({ scope: 'user', kind: 'episode', content: '第一天：评审', sourceSessionId: 'sess-1' })
    await store.write({ scope: 'user', kind: 'episode', content: '第二天：开发', sourceSessionId: 'sess-2' })
    await store.setSessionSummary('sess-1', '立项与评审')

    const groups = await (await fetch(`${base}/api/engram/episode-timeline?scope=user`, { headers: bearer() })).json()
    expect(groups.groups).toHaveLength(2)
    const g1 = groups.groups.find((g: { sessionId: string }) => g.sessionId === 'sess-1')
    expect(g1.summary).toBe('立项与评审')
    expect(g1.episodes.map((e: { content: string }) => e.content)).toEqual(['第一天：立项', '第一天：评审'])
    expect(g1.startedAt).toBeLessThanOrEqual(g1.endedAt)
    // 无摘要的组不带 summary 键（面板据此显示「摘要缺失」）
    const g2 = groups.groups.find((g: { sessionId: string }) => g.sessionId === 'sess-2')
    expect(g2.summary).toBeUndefined()

    // 邻近扩展：锚点 ±60 分钟窗口内的情景邻居（排除锚点自身）
    const around = await (await fetch(`${base}/api/engram/episode-timeline?scope=user&around=${encodeURIComponent(e1.id)}`, { headers: bearer() })).json()
    expect(around.anchor.id).toBe(e1.id)
    expect(around.neighbors.map((n: { id: string }) => n.id)).toContain(e2.id)
    expect(around.neighbors.map((n: { id: string }) => n.id)).not.toContain(e1.id)

    const missing = await fetch(`${base}/api/engram/episode-timeline?scope=user&around=nope`, { headers: bearer() })
    expect(missing.status).toBe(404)
  })

  it('corridor：节点/边来自真实库，status 过滤生效；项目切换图谱同步', async () => {
    const dbDir = await tempDir('codex-web-d22-corridor-')
    const repoA = await makeRepo('git@github.com:acme/alpha.git')
    const repoB = await makeRepo('git@github.com:acme/beta.git')
    const { runtime, base } = await startServer({ dbDir })
    const a1 = await runtime.save({ content: 'Alpha 约定一', kind: 'decision', projectRoot: repoA })
    const a2 = await runtime.save({ content: 'Alpha 约定二', kind: 'fact', projectRoot: repoA })
    await runtime.save({ content: 'Beta 约定', kind: 'fact', projectRoot: repoB })
    const storeA = await runtime.openScope('project', repoA)
    await storeA.linkEdge(a2.record.id, a1.record.id, 'related')
    const dbA = runtime.scopeDbName('project', repoA)
    const dbB = runtime.scopeDbName('project', repoB)

    const graphA = await (await fetch(`${base}/api/engram/corridor?scope=project&project=${dbA}&status=active,archived`, { headers: bearer() })).json()
    expect(graphA.nodes).toHaveLength(2)
    expect(graphA.edges).toHaveLength(1)
    expect(graphA.edges[0]).toMatchObject({ from: a2.record.id, to: a1.record.id, type: 'related' })
    expect(graphA.nodes.map((n: { content: string }) => n.content).sort()).toEqual(['Alpha 约定一', 'Alpha 约定二'])
    expect(graphA.nodes.every((n: { title: string; importance: number }) => typeof n.title === 'string' && n.importance >= 0)).toBe(true)

    // status 过滤（与 DSH 同口径：active 恒包含，显式追加 archived/forgotten）：
    // 修正一条后旧条目转 archived——默认只画 active，显式加 archived 才可见。
    await runtime.update({ id: a2.record.id, content: 'Alpha 约定二（修订）', projectRoot: repoA })
    const activeOnly = await (await fetch(`${base}/api/engram/corridor?scope=project&project=${dbA}`, { headers: bearer() })).json()
    expect(activeOnly.nodes.map((n: { content: string }) => n.content).sort()).toEqual(['Alpha 约定一', 'Alpha 约定二（修订）'])
    expect(activeOnly.edges).toHaveLength(0) // 旧条目（边的一端）已不在 active 子图
    const withArchived = await (await fetch(`${base}/api/engram/corridor?scope=project&project=${dbA}&status=active,archived`, { headers: bearer() })).json()
    expect(withArchived.nodes).toHaveLength(3)
    expect(withArchived.nodes.map((n: { status: string }) => n.status).sort()).toEqual(['active', 'active', 'archived'])
    expect(withArchived.edges).toHaveLength(2) // 旧 related 边 + update 产生的 supersedes 边
    expect(withArchived.edges.map((e: { type: string }) => e.type).sort()).toEqual(['related', 'supersedes'])

    // 切换项目：图谱同步换成 B 库（无 A 的节点/边）
    const graphB = await (await fetch(`${base}/api/engram/corridor?scope=project&project=${dbB}`, { headers: bearer() })).json()
    expect(graphB.nodes).toHaveLength(1)
    expect(graphB.nodes[0].content).toBe('Beta 约定')
    expect(graphB.edges).toHaveLength(0)
  })

  it('telemetry：近 N 天计数来自 op_log；只聚合 user/project；shared 501', async () => {
    const dbDir = await tempDir('codex-web-d22-tele-')
    const repoA = await makeRepo('git@github.com:acme/alpha.git')
    const { runtime, base } = await startServer({ dbDir })
    await runtime.save({ content: '用户库写入', kind: 'fact', scope: 'user' })
    await runtime.save({ content: 'Alpha 写入', kind: 'fact', projectRoot: repoA })
    const dbA = runtime.scopeDbName('project', repoA)

    // 合并（无 scope）：无选择器时项目段跳过（不回落进程 cwd），只聚合 user
    const mergedNoSel = await (await fetch(`${base}/api/engram/telemetry?days=7`, { headers: bearer() })).json()
    expect(mergedNoSel.counts.writes).toBe(1)
    expect(mergedNoSel.scopes.map((s: { scope: string }) => s.scope)).toEqual(['user'])

    // 带选择器的合并：两库都聚合
    const merged = await (await fetch(`${base}/api/engram/telemetry?days=7&project=${dbA}`, { headers: bearer() })).json()
    expect(merged.counts.writes).toBe(2)
    expect(merged.scopes.map((s: { scope: string }) => s.scope).sort()).toEqual(['project', 'user'])

    const userOnly = await (await fetch(`${base}/api/engram/telemetry?days=7&scope=user`, { headers: bearer() })).json()
    expect(userOnly.counts.writes).toBe(1)
    expect(userOnly.scopes).toEqual([{ scope: 'user', active: 1, total: 1, signalRatio: 1 }])

    const projOnly = await (await fetch(`${base}/api/engram/telemetry?days=7&scope=project&project=${dbA}`, { headers: bearer() })).json()
    expect(projOnly.counts.writes).toBe(1)
    expect(projOnly.scopes).toEqual([{ scope: 'project', active: 1, total: 1, signalRatio: 1 }])

    // 项目段无选择器 → 404（不静默回落、不返回空数据假装成功）
    const noSelector = await fetch(`${base}/api/engram/telemetry?days=7&scope=project`, { headers: bearer() })
    expect(noSelector.status).toBe(404)

    const shared = await fetch(`${base}/api/engram/telemetry?days=7&scope=shared`, { headers: bearer() })
    expect(shared.status).toBe(501)
  })

  it('health：五维评分取自真实 stats（1 条 active = 76 分公式核验）', async () => {
    const dbDir = await tempDir('codex-web-d22-health-')
    const repoA = await makeRepo('git@github.com:acme/alpha.git')
    const { runtime, base } = await startServer({ dbDir, projectRoot: repoA })

    // 空态：两库都不存在 → parts 空、overall 0
    const empty = await (await fetch(`${base}/api/engram/health`, { headers: bearer() })).json()
    expect(empty.parts).toEqual([])
    expect(empty.overall).toBe(0)

    await runtime.save({ content: 'Alpha 约定', kind: 'decision', projectRoot: repoA })
    const view = await (await fetch(`${base}/api/engram/health?scope=project`, { headers: bearer() })).json()
    expect(view.parts).toHaveLength(1)
    expect(view.parts[0].scope).toBe('project')
    // 1 active / 0 archived / 0 edges / 0 redacted：
    // 40（信噪比 1.0）+ 25×(1−0.15/0.85)（活跃率）+ 0（走廊密度）+ 10（无涂改）+ 5（衰减覆盖一半）= 75.59 → 76
    expect(view.parts[0].score).toBe(76)
    expect(view.parts[0]).toMatchObject({ signal: 1, activeRatio: 1, edgeCount: 0, redacted: 0, archivedRatio: 0 })
    expect(typeof view.evaluatedAt).toBe('number')

    // 合并视图：配置了默认项目根 → 两库各一段
    const merged = await (await fetch(`${base}/api/engram/health`, { headers: bearer() })).json()
    expect(merged.parts.map((p: { scope: string }) => p.scope)).toEqual(['project'])
    expect(merged.overall).toBe(76)
  })

  it('tour-proposal：空宫殿引导 + active 记忆开场建议（≤5 站，focusKind 优先）', async () => {
    const dbDir = await tempDir('codex-web-d22-tour-')
    const { runtime, base } = await startServer({ dbDir })
    const empty = await (await fetch(`${base}/api/engram/tour-proposal?scope=user`, { headers: bearer() })).json()
    expect(empty).toMatchObject({ scope: 'empty', empty: true, activeCount: 0, suggestedStops: [] })
    expect(empty.greeting).toContain('宫殿尚空')

    await runtime.save({ content: '最重要的决策', kind: 'decision', scope: 'user', importance: 0.9 })
    for (let i = 0; i < 6; i += 1) {
      await runtime.save({ content: `普通约定 ${i}`, kind: 'fact', scope: 'user', importance: 0.1 })
    }
    const view = await (await fetch(`${base}/api/engram/tour-proposal?scope=user`, { headers: bearer() })).json()
    expect(view).toMatchObject({ scope: 'user', empty: false, activeCount: 7 })
    expect(view.suggestedStops).toHaveLength(5)
    expect(view.suggestedStops[0]).toMatchObject({ kind: 'decision', content: '最重要的决策' })

    const focused = await (await fetch(`${base}/api/engram/tour-proposal?scope=user&focusKind=fact`, { headers: bearer() })).json()
    expect(focused.suggestedStops.every((s: { kind: string }) => s.kind === 'fact')).toBe(true)
  })

  it('refurb：小库早退（无建议）；门牌纪律等规则给出 review 建议', async () => {
    const dbDir = await tempDir('codex-web-d22-refurb-')
    const { runtime, base } = await startServer({ dbDir })
    // 少于 minActive(8)：样本太少，早退不出建议
    await runtime.save({ content: '唯一条目', kind: 'fact', scope: 'user' })
    const small = await (await fetch(`${base}/api/engram/refurb?scope=user`, { headers: bearer() })).json()
    expect(small).toEqual({ scope: 'user', count: 0, suggestions: [] })

    for (let i = 0; i < 9; i += 1) {
      await runtime.save({ content: `未挂门牌的条目 ${i}`, kind: 'fact', scope: 'user', importance: 0.8 })
    }
    const view = await (await fetch(`${base}/api/engram/refurb?scope=user`, { headers: bearer() })).json()
    expect(view.count).toBeGreaterThanOrEqual(1)
    expect(view.suggestions.every((s: { action: string; primaryId: string; confidence: number }) =>
      ['merge', 'demote', 'review', 'split'].includes(s.action) && typeof s.primaryId === 'string' && s.confidence > 0)).toBe(true)
    // 规则 3（重要性 ≥0.7 且从未访问）与规则 5（未挂门牌）都命中
    expect(view.suggestions.some((s: { action: string; reason: string }) => s.action === 'review')).toBe(true)
  })

  it('未知异常统一 500 internal error（内部细节只落服务端日志）', async () => {
    const sent: { status: number; body: string } = { status: 0, body: '' }
    const res = {
      writeHead: (status: number) => { sent.status = status },
      end: (body?: string) => { sent.body = body ?? '' },
    } as unknown as ServerResponse
    const req = { method: 'GET' } as unknown as IncomingMessage
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const deps = {
        runtime: {} as CodexRuntime,
        projects: {
          resolve: () => { throw new Error('内部细节：D:\\secret\\path 不应外泄') },
        } as unknown as ProjectRegistry,
      }
      await handleEngramApi(req, res, 'list', new URL('http://127.0.0.1/api/engram/list?scope=user'), deps)
      expect(sent.status).toBe(500)
      expect(JSON.parse(sent.body)).toEqual({ error: 'internal error' })
      expect(sent.body).not.toContain('secret')
      // 具体信息记录在服务端
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})
