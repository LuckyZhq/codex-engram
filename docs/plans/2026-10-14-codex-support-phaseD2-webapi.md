# D2 阶段：独立 WebAPI 实施方案（phase D 续）

> 2026-10-14。目标：`codex/web`（Node 原生 HTTP）复刻面板 35 接口，与 MCP/Hooks **并列**
> 共享 CodexRuntime 与 SQLite，形成完整数据闭环；不引 Express/Fastify/ORM。
> 本文件 = 实施方案 + 实施记录。D1 记录见 `2026-10-14-codex-support-phaseD-ui.md`。

## 1. 架构决策

**MCP/Hooks 与 WebAPI 是并列入口**，共享业务运行时（`openCodexRuntime`）与持久化层，
互不调用。保留既有 Codex 接入成果，不另建一套记忆业务逻辑。

```
Codex MCP / Hooks ┐
                  ├─→ 共享 Engram Runtime ─→ SQLite（WAL · BEGIN IMMEDIATE）
React 九视图 ─→ Node WebAPI ┘
```

## 2. 代码审查发现的关键问题（设计 WebAPI 的前置约束）

| # | 问题 | D2 处理 |
|---|---|---|
| 1 | 项目库选择器（dbName）不能反推工作目录；WebAPI 进程 cwd 无意义 | Runtime 增加 `openExistingProjectDb(dbName)`（严格模式 + 必须存在 + 复用连接缓存）；`projectRoot` 与 `projectDbName` 两条口径并存，都不成立时拒绝，**不回落进程 cwd** |
| 2 | 面板导出/镜像走 `<a href>` 直链，无法带 Authorization 头 | 启动令牌一次性换取 **HttpOnly + SameSite=Strict 会话 Cookie**；普通 API 与下载链接同源自动携带，面板网络代码零改动 |
| 3 | `src/routes.ts` 的 `review-due` / `review-answer` 各有重复分支（前分支已返回，后分支不可达，两版返回结构不同） | 以**面板调用方与实际可达分支**为契约基准，不复制重复代码 |
| 4 | Mock 的辅助模型/历史回填/Jev 裁决 ≠ Codex 真实能力 | `shared` 作用域、历史回填、Jev 明确 501/空态；**不返回假成功** |

## 3. 文件结构

```
codex/
├── web/
│   ├── server.ts       # HTTP 生命周期：监听/守卫链/静态 UI/令牌交换/优雅关闭
│   ├── api.ts          # 35 接口请求分发（路由表驱动，D2.1→D2.3 逐阶段落地）
│   ├── projects.ts     # 项目库发现与选择（dbName 选择器 / projectRoot 双口径）
│   └── auth.ts         # 令牌、会话、Origin/Host/peer 校验、64 KiB body
├── ui/
│   ├── src/App.tsx     # + 会话初始化（useSessionGate / SessionGate）
│   ├── src/session.tsx # 401 探针 → 令牌录入浮层 → /auth 换取
│   └── vite.config.ts  # ENGRAM_UI_MOCK=1 显式开 mock；否则代理真实 WebAPI
└── tsdown.config.ts    # + web 入口 → dist/web.js
tests/codex-web-api.spec.ts
codex/scripts/smoke-web.mjs
```

## 4. API 契约与安全基线

- 路由**不重命名**：继续 `/api/engram/*`（面板已在用）。35 接口按兼容性分三期：
  D2.1 `session/workspaces/stats/list`；D2.2 核心查询；D2.3 写操作与导出。
  已知未落地 → **501**；未知路由 → **404**；方法不符 → **405**。
- 项目选择器契约：GET 走 `?project=<dbName>`，POST 走 body.project（面板契约）。
  `project-<24位hex>.db` 模式外一律 400（含路径穿越）；格式合法但库不存在 → **404 `unknown project`**
  （面板据此自愈：清失效选择回跟随态）。
- 守卫链：方法白名单 → 回环 peer/Host → 认证（Bearer 或会话 Cookie）→
  POST 额外 Origin 回环 + Content-Type JSON + **64 KiB 按字节** body 上限。
- 监听 `127.0.0.1:3928`；Vite 保留 `3927`；**开发代理不跳过安全层**
  （Cookie/Origin/Host 经代理原样转发，令牌仍经 `/auth` 换取）。
- 错误映射：400 参数 / 401 未认证 / 403 来源 / 404 不存在·unknown project /
  405 方法 / 409 冲突 / 413·415 body / 501 未实现 / 500 不泄露堆栈。

## 5. 实施顺序与验收

### D2.1 — 服务骨架、认证、项目定位（本次落地）

新增：`codex/web/{server,api,projects,auth}.ts`、`codex/ui/src/session.tsx`、
`tests/codex-web-api.spec.ts`、`codex/scripts/smoke-web.mjs`；
修改：`codex/src/runtime.ts`（+`openExistingProjectDb`、+`PROJECT_DB_NAME_PATTERN`）、
`codex/tsdown.config.ts`（+web 入口）、`codex/ui/vite.config.ts`（mock 显式化 + 代理）、
`codex/ui/src/App.tsx`（会话门）、`codex/ui/src/mock/api.ts`（+session 路由）、`package.json`（+smoke:web/start:web）。

**实测结果（2026-10-14）**：

- vitest `tests/codex-web-api.spec.ts` **19/19 通过**；codex 六件套合计 **76/76**；
  全量回归 312 通过（新增前 294），失败项均为既有环境问题（未 link-peers 的
  `@deepseek-ai/*`、Windows 0600 权限语义、并行负载超时），与本次改动无关。
- `tsc --noEmit`：`codex/` 零错误；总数 109 = D1 基线。
- `pnpm bundle:codex` → `dist/web.js` 31.47 kB（+runtime 共享 chunk）。
- `pnpm build:ui` → 24 模块，JS 261 kB / CSS 57 kB。
- `node codex/scripts/smoke-web.mjs`（真实子进程 + 真实构建产物）**全部通过**：
  认证 401/302/Cookie、空库空结构、**Hooks 写 → WebAPI 读跨入口闭环**、
  未知/非法选择器、501/404/405、静态分发与令牌页、信号退出。
- D1 渲染基线回归：`ENGRAM_UI_MOCK=1` + `verify-render.mjs` **51/51 通过**
  （脚本与 D1 提交逐字节一致；49→51 为循环内断言计数差异）。
- **Vite 代理 → 真实 WebAPI 实测**：无 Cookie 401（安全层不跳过）→
  `/auth?token=` 302 + HttpOnly Cookie → 带 Cookie 200 → 错令牌 403。

已知边界（按计划留待后续阶段）：telemetry/health/corridor 等查询路由 D2.1 返回 501；
写操作与导出 D2.3；backup/restore-backup 不在面板 35 接口内，另行处理。

### D2.2 — 核心查询接口（2026-10-14 落地）

stats/list 之外的查询：review、review-due、search-test、entities、entity、facts、
observations、observation-evidence、episode-timeline、corridor、telemetry、health、
tour-proposal、refurb、profile-block、activity。DTO 以 `src/routes.ts` 实际可达分支为基准。
遥测聚合**只聚合 user/project**（不沿用三库默认吞掉 shared）。

**实施记录**：

- 全部 16 个路由在本文件 `api.ts` 落地（路由表 status `d21 → d22`），只修改
  `codex/web/api.ts` + 测试/冒烟；未动 Runtime、projects、server。
- 复用既有实现：`store.review/dueReviews/search/recentOps/getMany/listEntities/
  entityDetail/factsOfEntity/listObservations/episodeTimeline/exportAll/
  getProfileBlock/listProfileBlockVersions`；
  `src/telemetry/aggregate.ts`（遥测聚合）、`src/tour-proposal.ts`（入殿导航）、
  `src/refurb.ts`（翻新建议）三个纯函数模块零改动直接 import。
- 读路径统一 `openStoreForRead()`：库不存在返回**接口契约空结构**（列表类空数组 /
  review·entity 单条目语义 404 / telemetry 空计数 / health `overall:0`），不建空库。
- 项目定位全部经 `ProjectRegistry.resolve()`；合并视图（search-test all / activity /
  telemetry·health 无 scope）对「无选择器且无默认根」的项目段**容错跳过**——
  Codex 不回落 WebAPI 进程 cwd（DSH 的进程目录兜底在 Codex 侧是红线），
  显式单 scope 仍严格 404（与 list/stats 同口径）。
- 两处按**面板消费结构**修正的 DSH 既有偏差（均已在代码注释标注）：
  ① `episode-timeline` around 模式返回扁平 `{anchor, neighbors}`（DSH 多包一层
  `around` 键，与面板 `EpisodeAroundView` 不符，原版邻近扩展会崩）；
  ② `facts` 的 `includeInvalid` 放行 `1/0`（DSH 的 toBoolean 不认 `'1'`，
  面板实际发 `includeInvalid=1`，原版全链视图拿不到失效事实）。
- 500 错误泄露修正：未知异常响应统一 `internal error`，完整信息（含堆栈）只落
  服务端 `console.error`。
- 测试：`tests/codex-web-api.spec.ts` 19 → **34 断言**（新增 15 个：16 路由逐个
  真实数据核验 + 空库空结构 + 项目切换同步 + 500 不泄露单测）；
  `smoke-web.mjs` ⑦b 新增 16 接口真实数据冒烟（501 探测改用 D2.3 的 export）。

**实测结果（2026-10-14）**：

- `tsc --noEmit`：`codex/` 与 `tests/codex-*` 零错误；总数 109 = D1 基线
  （既有失败均为未 link-peers 的 `@deepseek-ai/*` 环境问题）。
- vitest：`tests/codex-web-api.spec.ts` **34/34**；codex 六件套合计 **91/91**
  （D1 基线 76 = 57 + 19，其中 web-api 19 → 34）。
- `pnpm bundle:codex` → `dist/web.js` 58.34 kB（D2.1 为 31.47 kB）；
  `pnpm build:ui` → 24 模块，JS 261 kB / CSS 57 kB（UI 零改动）。
- `node codex/scripts/smoke-web.mjs`（真实子进程 + 构建产物）**全部通过**：
  含 ⑦b 十六接口真实 SQLite 冒烟与 shared 501。
- `smoke.mjs`（MCP）与 `smoke-hooks.mjs`（Hooks 8 步）**全部通过**（无回归）。
- D1 渲染基线回归：mock dev + `verify-render.mjs` **51/51 通过**。
- **隔离测试库 + 真实 WebAPI 浏览器验收**（一次性脚本，已清理）：临时库种子数据
  覆盖九视图全部数据源，dist 构建起服务于 3928、Vite 代理模式 3927、系统 Chrome
  驱动——认证门（未认证 401 → /auth 换 Cookie → 面板加载）、今日速览
  （stats/telemetry/health/tour-proposal/profile-block）、陈展 + review 详情抽屉、
  走廊图谱（节点/边）+ 召回测试台（命中与命中原委）、往事分组 + 会话摘要 + 邻近
  扩展、实体详情 + 事实版本链（生效/已失效）、信念 + 证据链回溯、活动日志、
  私人/项目作用域隔离（不串库）、全页面无 4xx/5xx——**30/30 通过**。

### D2.3 — 写操作、导出、功能边界（2026-10-15 落地）

**接口契约**（与 DSH `src/routes.ts` 实际可达分支一致，面板零改动）：

| 接口 | 请求 | 成功响应 | 说明 |
|---|---|---|---|
| `POST update` | `id, scope, project?, content, kind?, importance?` | `{ record, superseded }` | 取代式修改：新条目 active、旧条目归档、建 supersedes 边 |
| `POST forget` | `id, scope, project?`；可选 `reason/affects/stillUseful` | `{ record }` | 软删；三问齐全走 `forgetWithTombstone`（审计），全不给走普通 forget，**半填 400** |
| `POST restore` | `id, scope, project?` | `{ record }` | 恢复 archived/forgotten |
| `POST review-answer` | `id, scope, project?, grade(0-5 整数)` | `{ id, review }` | 直接调 `store.scheduleReview`，不复制 SM-2 公式 |
| `POST consolidate` | `scope, project?, candidates[]` 或 `full:true` | `{ archived, merged, skipped, tookMs, scope, mode }` | 两种模式互斥且必须显式二选一 |
| `GET export` | `scope, project?, format=markdown\|json` | 附件下载 | 只读数据库，不落盘 |
| `GET mirror` | `scope, project?` | 生成报告 JSON | 写服务端文件树（保留面板 `<a href>` 直链契约） |

**关键决策**：

1. **写操作走 Runtime，不复制业务逻辑。** 给 `CodexScopeTarget` 增加
   `projectDbName`（与 `projectRoot` **互斥**，同时给 loud 拒绝），Runtime 内部新增
   `openTargetForWrite/openTargetForRead` 统一三种定位口径；`update/forget/restore/
   save/list/search/get` 全部走这套判据。这样 WebAPI 不必复制 Runtime 的脱敏、
   向量重算、取代链与墓志铭校验（复制就会漂移）。WebAPI 侧用 `projects.ts` 新增的
   `locatorOf(target)` 把解析结果转成 Runtime 定位参数——**读与写共用同一套定位判据**。
2. **整理分两种模式，且必须显式指定**（`src/consolidation/run.ts` 新增 `mode`，默认
   `full` → DSH 宿主行为不变）。`partial` = 局部合并：跳过全库归档、只动候选集合内部、
   无向量时按**完整正文**去重（原「前 60 字相同」不足以保证语义相同）。
   WebAPI 缺 `candidates` 且无 `full` → **400**（不静默触发全库整理）。
3. **局部合并的候选校验**：上限 50 条，逐条确认属于目标库（跨库 id → 404，不代劳）。
   同库并发整理 → **409**（进程内执行标记 + `try/finally` 释放）。
4. **导出路径隔离**：`<dbDir>/palaces/<scope>/<项目库标识>/<导出批次 id>`，
   export id 由服务端生成（`newExportId`，时间戳 + 随机段），不接受请求传入的路径。
   目录 0o700 / 文件 0o600；镜像目录在数据目录下、不在 `ui/dist` 内 → 静态路由天然不可达。
5. 500 错误泄露修正与「未认证写 401 无副作用」在 D2.2 已落地（本次复核未再发现泄露点）。

**顺带修复的三个既有缺陷**（`src/consolidation/run.ts`，均有回归测试）：

| 问题 | 修复 |
|---|---|
| 传 `mergeCandidateIds` 时归档阶段仍扫全库 | `partial` 模式整段跳过阶段 1；`full` 保持原行为 |
| 向量模式只给种子算向量 → 非种子永远无法参与比较 | 按桶内全量计算向量；`full` 限定模式仍只以种子为锚点 |
| 无向量分支写入失败也 `merged += 1` | 计数移到提交成功之后（失败只计 `skipped`） |

**实施记录**：

- 新增 `codex/web/exports.ts`（导出路径/权限/响应装配）；`api.ts` 路由表 `pending → d23`；
  `runtime.ts`（`projectDbName` 定位）、`projects.ts`（`locatorOf`）、`consolidation/run.ts`
  （`mode` + 三处修复）均为**增量修改**，未改 Schema、未改 `projects.resolve` 契约、
  `server.ts` 零改动。
- 面板仅一处最小修复：`runBatch` 按 `allSettled` 的实际结果反馈
  （新增 `batchDone` / `batchPartialFailed` 两个 i18n 键），**不重绘视觉结构**。
- 测试：`tests/codex-web-api.spec.ts` 34 → **43 断言**（新增 9 个：取代链与脱敏、
  写操作定位边界、墓志铭、SM-2 + 重启可读、整理模式校验、局部不归档、并发 409、
  导出解析、镜像隔离）；`tests/consolidation.spec.ts` 3 → **7**（新增局部合并两条、
  计数修复、完整正文去重）。
- `smoke-web.mjs` ⑦ 的 501 探测改用 `models`（export 已落地），新增 **⑦c D2.3 写操作
  与导出**（真实子进程 + 构建产物）：update → review-answer → forget（含墓志铭半填
  拒绝）→ restore → consolidate 模式校验 → shared/未知项目 → export md/json → mirror
  落盘与「不改写 SQLite」。

**实测结果（2026-10-15）**：

- `tsc --noEmit`：总数 **109 = D2.2 基线**；`codex/` 与 `src/consolidation` 零错误
  （既有失败均为未 link-peers 的 `@deepseek-ai/*` 环境问题）。
- vitest：`tests/codex-web-api.spec.ts` **43/43**；codex 六件套合计 **100/100**
  （D2.2 为 91）；`tests/consolidation.spec.ts` **7/7**。
- `pnpm bundle:codex` → `dist/web.js` 84.56 kB（D2.2 为 58.34 kB）。
- `node codex/scripts/smoke-web.mjs`（真实子进程 + 构建产物）**全部通过**。

### D2.4 — 真实环境集成与回归（待实施）

Vite 默认代理真实 WebAPI（本次已接线）；隔离临时库集成测试 + 浏览器验收；
MCP/Hooks/WebAPI 并发无丢写；命令行开浏览器/停服务/端口冲突留给 D4。

## 6. 命令约定

```bash
pnpm bundle:codex                              # MCP / Hooks / WebAPI 构建
pnpm build:ui                                  # React UI
node codex/dist/web.js                         # 启动独立 WebAPI（打印访问令牌）
ENGRAM_UI_MOCK=1 pnpm dev:ui                   # 开发态显式开 mock（D1 渲染基线）
pnpm dev:ui                                    # 开发态代理真实 WebAPI（默认）
node codex/scripts/smoke-web.mjs               # WebAPI 冒烟（真实进程）
```

环境变量：`ENGRAM_WEB_HOST` / `ENGRAM_WEB_PORT`（默认 3928）/ `ENGRAM_WEB_TOKEN`（缺省随机）/
`ENGRAM_PROJECT_ROOT`（默认项目根，workspaces 的 processDefault 与无选择器落点）/
`ENGRAM_UI_MOCK` / `ENGRAM_WEB_ORIGIN`（dev 代理目标）。
