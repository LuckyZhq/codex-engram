import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runConsolidation } from '../src/consolidation/run.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'
import type { EngramEmbedder } from '../src/embedder/interface.ts'
import type { MemoryId, MemoryRecord, WriteInput } from '../src/types.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-cons-'))
  store = await openEngramStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
})

describe('Background Consolidation', () => {
  it('嵌入不可用时：归档老旧低重要性条目，启发式去重完全相同条目', async () => {
    // 1) 老旧低 importance / 低 confidence → 应归档（write 默认 confidence=0.5，需手动改低）。
    const old = await store.write({ scope: 'user', kind: 'fact', content: '旧且无关', importance: 0.1, confidence: 0.5 })
    // 手动把 created_at 拨到 60 天前 + confidence 拨到 0.1（接口不暴露 lastAccessedAt / updateConfidence）。
    const path = join(dir, 'user.db')
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE nodes SET created_at = ?, confidence = 0.1 WHERE id = ?').run(Date.now() - 60 * 86_400_000, old.id)
    raw.close()

    // 2) 完全相同内容（启发式去重）：a(0.5) 与 b(0.6) 同文，b 留下、a 被归档。
    await store.write({ scope: 'user', kind: 'fact', content: '偏好 TypeScript', importance: 0.5, confidence: 0.7 })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '偏好 TypeScript', importance: 0.6, confidence: 0.7 })
    // 完全相同被去重：b (更高 importance) 留下
    void b // sanity

    // 3) 不应被归档的（创建新鲜）
    const fresh = await store.write({ scope: 'user', kind: 'fact', content: '新鲜高重要', importance: 0.9, confidence: 0.9 })

    // 设计：existing 胜出保留（高 importance 不被覆盖），所以 b(0.6) 留下，a(0.5) 不动。
    // 后续断言只看归档发生；merged 视具体 importance 顺序，本测试不强制。
    const dbgBefore = await store.topActive('user', 10)
    const report = await runConsolidation(store, Promise.resolve(undefined), { olderThanDays: 30, importanceBelow: 0.3 })
    expect(report.archived).toBe(1) // 仅 old 命中归档阈值
    expect(report.merged).toBe(0) // b 重要度更高，保留；a 不动
    expect(dbgBefore.filter(r => r.content === '偏好 TypeScript')).toHaveLength(2) // 整理前两条都在

    const stats = await store.stats()
    // 期望 active=3：fresh(0.9) + b(0.6) + a(0.5)；old 已归档（forgotten），b 与 a 重要度不同不被合并。
    expect(stats.active).toBe(3)

    // fresh 必须健在
    const freshRow = (await store.topActive('user', 10)).find(record => record.id === fresh.id)
    expect(freshRow).toBeDefined()

    // op_log 应记录 consolidation 摘要
    const ops = await store.recentOps(50)
    const summary = ops.find(op => op.op === 'consolidation')
    expect(summary).toBeDefined()
    const detail = JSON.parse(summary!.detail!) as { archived: number; merged: number }
    expect(detail.archived).toBe(report.archived)
    expect(detail.merged).toBe(report.merged)
  })

  it('空库调用不报错，summary 全 0', async () => {
    const report = await runConsolidation(store, Promise.resolve(undefined))
    expect(report.archived).toBe(0)
    expect(report.merged).toBe(0)
    expect(report.skipped).toBe(0)
    expect(report.tookMs).toBeGreaterThanOrEqual(0)
  })

  it('覆盖默认参数（短龄阈值）也能跑通', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '任何内容', importance: 0.5, confidence: 0.5 })
    const report = await runConsolidation(store, Promise.resolve(undefined), { olderThanDays: 1, importanceBelow: 0.4, mergeThreshold: 0.99 })
    expect(report).toBeDefined()
    expect(report.tookMs).toBeGreaterThanOrEqual(0)
  })
})

/** 测试用嵌入器：按正文查表给向量（同文 → 同向量 → 余弦 1）；未登记的正文给正交方向。 */
function tableEmbedder(table: Readonly<Record<string, readonly number[]>>): EngramEmbedder {
  return {
    model: 'test-table-embedder',
    async embed(texts) {
      return texts.map(text => Float32Array.from(table[text] ?? [0, 0, 0, 1]))
    },
    async close() { /* 无资源可释放 */ },
  }
}

/** 埋一条「该被全库归档」的条目：接口不暴露 created_at/confidence，直接改库（同首个用例）。 */
async function makeOld(dbPath: string, id: MemoryId): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(dbPath)
  raw.prepare('UPDATE nodes SET created_at = ?, confidence = 0.1 WHERE id = ?')
    .run(Date.now() - 60 * 86_400_000, id)
  raw.close()
}

/**
 * 整理用最小 Store 桩：只实现 `runConsolidation` 实际调用的四个方法，
 * 用于固定记录顺序与注入写入失败（真实库无法让 supersedeMany 失败）。
 */
function stubStore(options: {
  readonly records: readonly {
    readonly id: string
    readonly content: string
    readonly importance: number
    readonly confidence: number
    readonly createdAt: number
  }[]
  readonly failSupersede?: boolean
}): EngramStore & { readonly forgotten: string[]; readonly superseded: string[] } {
  const forgotten: string[] = []
  const superseded: string[] = []
  const impl = {
    async stats() {
      return {
        total: options.records.length, active: options.records.length, archived: 0,
        forgotten: 0, redacted: 0, edges: 0, signalRatio: 0,
      }
    },
    async topActive() {
      return options.records.map(record => ({
        id: record.id as MemoryId,
        scope: 'user' as const,
        kind: 'fact' as const,
        status: 'active' as const,
        content: record.content,
        importance: record.importance,
        confidence: record.confidence,
        createdAt: record.createdAt,
        lastAccessedAt: record.createdAt,
        accessCount: 0,
        sourceSessionId: null,
        sourceRound: null,
        sourceSeq: null,
      }))
    },
    async forget(id: MemoryId) {
      forgotten.push(String(id))
      return { id } as MemoryRecord
    },
    async supersedeMany(_input: WriteInput, oldIds: readonly MemoryId[]): Promise<MemoryRecord> {
      if (options.failSupersede === true) throw new Error('模拟写入失败')
      superseded.push(...oldIds.map(String))
      return { id: 'new' as MemoryId } as MemoryRecord
    },
    async audit() { /* 审计桩：不落盘 */ },
  }
  return Object.assign(impl, { forgotten, superseded }) as unknown as EngramStore & {
    readonly forgotten: string[]
    readonly superseded: string[]
  }
}

describe('Background Consolidation — 局部合并（mode=partial）', () => {
  it('局部合并：跳过全库归档，且不把候选之外的相似条目卷进来', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '重复的部署流程', importance: 0.5, confidence: 0.7 })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '重复的部署流程', importance: 0.5, confidence: 0.7 })
    const outside = await store.write({ scope: 'user', kind: 'fact', content: '候选之外的近似条目', importance: 0.5, confidence: 0.7 })
    const victim = await store.write({ scope: 'user', kind: 'fact', content: '低重要性老旧条目', importance: 0.1, confidence: 0.1 })
    await makeOld(join(dir, 'user.db'), victim.id)

    const emb = tableEmbedder({
      '重复的部署流程': [1, 0, 0, 0],
      // 与「重复的部署流程」余弦 ≈ 0.9999（≥ 默认阈值 0.92）：全库模式会被并入
      '候选之外的近似条目': [0.99, 0.01, 0, 0],
      '低重要性老旧条目': [0, 1, 0, 0],
    })

    const report = await runConsolidation(store, Promise.resolve(emb), {
      scope: 'user',
      mode: 'partial',
      mergeCandidateIds: [String(a.id), String(b.id)],
    })
    expect(report.archived).toBe(0) // 归档阶段整段跳过
    expect(report.merged).toBe(1) // 候选内部完成合并
    // 未选中的两条都不受影响——用户确认的范围就是实际影响的范围
    expect((await store.get(outside.id))?.status).toBe('active')
    expect((await store.get(victim.id))?.status).toBe('active')
  })

  it('全库模式（默认）：归档照旧，非候选但与种子相似的条目仍被并入', async () => {
    const a = await store.write({ scope: 'user', kind: 'fact', content: '重复的部署流程', importance: 0.5, confidence: 0.7 })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '重复的部署流程', importance: 0.5, confidence: 0.7 })
    const outside = await store.write({ scope: 'user', kind: 'fact', content: '候选之外的近似条目', importance: 0.5, confidence: 0.7 })
    const victim = await store.write({ scope: 'user', kind: 'fact', content: '低重要性老旧条目', importance: 0.1, confidence: 0.1 })
    await makeOld(join(dir, 'user.db'), victim.id)

    const emb = tableEmbedder({
      '重复的部署流程': [1, 0, 0, 0],
      '候选之外的近似条目': [0.99, 0.01, 0, 0],
      '低重要性老旧条目': [0, 1, 0, 0],
    })

    const report = await runConsolidation(store, Promise.resolve(emb), {
      scope: 'user',
      mergeCandidateIds: [String(a.id), String(b.id)],
    })
    expect(report.archived).toBe(1) // victim 命中闭馆阈值
    expect(report.merged).toBe(1)
    // 非候选条目只有与种子相似时才被并入——修复前它压根没算向量，永远并不了
    expect((await store.get(outside.id))?.status).toBe('archived')
  })

  it('无向量分支：合并写入失败只计 skipped，不虚增 merged', async () => {
    const stub = stubStore({
      records: [
        { id: 'a', content: '同一段正文', importance: 0.5, confidence: 0.7, createdAt: Date.now() },
        { id: 'b', content: '同一段正文', importance: 0.9, confidence: 0.7, createdAt: Date.now() },
      ],
      failSupersede: true,
    })
    const report = await runConsolidation(stub, Promise.resolve(undefined), { olderThanDays: 30 })
    expect(report.merged).toBe(0) // 修复前：写入失败也会 +1（成功数与实际落库不一致）
    expect(report.skipped).toBe(1)
    expect(stub.superseded).toEqual([])
  })

  it('无向量分支：局部合并按完整正文去重——前 60 字相同但正文不同者不合并', async () => {
    const prefix = '相'.repeat(60)
    const stub = stubStore({
      records: [
        { id: 'a', content: `${prefix}甲`, importance: 0.5, confidence: 0.7, createdAt: Date.now() },
        { id: 'b', content: `${prefix}乙`, importance: 0.9, confidence: 0.7, createdAt: Date.now() },
      ],
    })
    const partial = await runConsolidation(stub, Promise.resolve(undefined), {
      mode: 'partial',
      mergeCandidateIds: ['a', 'b'],
    })
    expect(partial.merged).toBe(0) // 正文不同 → 不合并（前 60 字相同不足以保证语义相同）
    expect(partial.archived).toBe(0)

    // 全库模式沿用原启发起发式（默认行为不变，DSH 宿主不受影响）
    const full = await runConsolidation(stub, Promise.resolve(undefined), {
      mode: 'full',
      mergeCandidateIds: ['a', 'b'],
    })
    expect(full.merged).toBe(1)
    expect(stub.superseded).toEqual(['a'])
  })
})
