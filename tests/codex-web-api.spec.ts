import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { openCodexRuntime } from '../codex/src/runtime.ts'
import type { CodexRuntime } from '../codex/src/runtime.ts'
import { createWebServer } from '../codex/web/server.ts'
import type { WebServer } from '../codex/web/server.ts'
import {
  InvalidSelectorError, UnknownProjectError, createProjectRegistry, scanProjectDbs,
} from '../codex/web/projects.ts'
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

    const pending = await fetch(`${base}/api/engram/telemetry`, { headers: bearer() })
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
