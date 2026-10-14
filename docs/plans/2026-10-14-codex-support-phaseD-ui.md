# D 阶段：原版 React 可视化界面移植至 Codex（phase D）

> 2026-10-14。目标：保留原版 UI（结构/布局/配色/图标/动效/交互 + 九视图导航），
> 不重绘管理页。架构：React + Vite + Node 原生 HTTP + 共享 Engram Runtime + SQLite。
> 本文件 = 依赖分析 + 修改计划 + D1 实施记录。D2/D3/D4 在后续追加。

## 1. 代码依赖分析（审查结论）

### 1.1 DSH 宿主依赖清单（移植时需替换/消除的部分）

| 依赖 | 位置 | 性质 | 移植处理 |
|---|---|---|---|
| `PropsLocale<'engram'>`（t 席位） | EngramPanel.tsx 导入 `@deepseek-ai/dsh-client-ui-slots` | type-only，运行时不涉及 | `codex/ui/src/host.ts` 用同源词典本地合成 t（签名 `(key, params?) => string` 与宿主席位一致） |
| `WorkspacesLike` / `SessionsLike` | EngramPanel 可选 props | 运行时服务（跟随 GUI 工作区） | 不传。面板支持缺席：项目宫殿经下拉手动选择，「跟随」回落服务端默认库 |
| `--dsw-alias-*` 主题令牌（13 个） | panel.module.css 只消费不定义 | 宿主 CSS 注入 | `codex/ui/src/theme-compat.css` 补齐浅/深两套值（来源：harness `ui-theme/src/styles/design-platform.css`） |
| `ctx.slots` / `ctx.locale` 注册 | src/client/index.ts | 插件装配 | 不需要——独立入口直接挂载 `EngramSection` |
| `/api/engram/*` 回环路由 | src/routes.ts | host webServer 承载 | D2 由 `codex/web`（Node 原生 HTTP）复刻同名接口 |

### 1.2 API 接口清单（面板实际调用，来自 routes.ts 核对）

GET：`workspaces`、`stats`、`list`、`search-test`、`review`、`review-due`、`export`、`mirror`、
`health`、`corridor`、`telemetry`、`activity`、`tour-proposal`、`refurb`、`profile-block`、
`episode-timeline`、`entities`、`entity`、`facts`、`observations`、`observation-evidence`、
`models`、`history-backfill`(+`/status`)、`jev-config`、`jev-observations`。
POST：`update`、`forget`、`restore`、`review-answer`、`consolidate`、`jev-config`、`jev-test`、
`history-backfill/start`、`history-backfill/cancel`。

### 1.3 主题变量清单（theme-compat.css 的 13 个令牌）

`--dsw-alias-{bg-base, bg-layer-1, label-primary, label-secondary, label-tertiary,
label-primary-foreground, border-l1, border-l2, fill-tsp-secondary, brand-primary,
state-success-primary, state-warn-primary, state-error-primary}`。
浅色品牌色为近黑 `#0f1115`、深色反转为近白 `#f9fafb`（DSH 单色品牌，amber→rose 渐变是插件自身签名）。
`fill-tsp-secondary` 在 harness 仓库无定义（宿主运行时注入），取同族近似值并注释注明。

### 1.4 可直接复用的组件清单（原样 import，零改动）

| 文件 | 行数 | 宿主依赖 | 结论 |
|---|---|---|---|
| `src/client/EngramPanel.tsx`（EngramSection） | 3111 | 仅 type-only t 席位 | 直接复用（入口组件） |
| `src/client/CorridorMap.tsx` | 401 | 无 | 直接复用 |
| `src/client/locales.ts`（zh/en/EngramKey/KIND_KEY） | 993 | 无 | 直接复用（host.ts 合成 t 的数据源） |
| `src/client/Toast.tsx` | 102 | 无 | 直接复用 |
| `src/client/UiStorage.ts` | 59 | 无 | 直接复用 |
| `src/client/panel.module.css` | 627 | 消费 13 令牌 | 原样复用 + 兼容层补令牌 |
| `src/client/index.ts` | 53 | cordis 装配 | 不复用（插件注册入口，Codex 不需要） |

`src/client/` 原文件零修改。

## 2. 文件修改计划（D1 实际落地）

新增（全部在 `codex/ui/`，符合「适配代码集中在 codex/ui 与 codex/web」）：

| 文件 | 作用 |
|---|---|
| `codex/ui/index.html` | Vite 入口；内联脚本首帧落 data-theme 防闪跳 |
| `codex/ui/vite.config.ts` | root=codex/ui；base './'; dev 挂 mock API；仅听 127.0.0.1 |
| `codex/ui/src/main.tsx` | React 入口（StrictMode + createRoot） |
| `codex/ui/src/App.tsx` | 最小宿主 chrome（品牌 + 主题切换）+ 挂载 EngramSection |
| `codex/ui/src/theme.ts` | auto/light/dark 三态管理 + localStorage + 系统主题监听 |
| `codex/ui/src/theme-compat.css` | 13 令牌浅/深两套 + 页面基底 + 外框样式 |
| `codex/ui/src/host.ts` | t 席位本地合成（浏览器语言探测） |
| `codex/ui/src/mock/fixtures.ts` | dev mock 数据（对齐 routes.ts 响应结构） |
| `codex/ui/src/mock/api.ts` | dev mock 中间件（仅 configureServer，不进生产构建） |
| `codex/ui/scripts/verify-render.mjs` | 浏览器验收脚本（49 项断言） |

修改：`package.json`（+3 脚本 dev:ui/build:ui/preview:ui；devDeps +react/react-dom 18.3.1）、
`pnpm-lock.yaml`、`.gitignore`（忽略 dist 与 .verify）。

## 3. D1 实施结果（2026-10-14 实测）

- 构建：`pnpm build:ui` → 23 模块，JS 260KB / CSS 56KB，371ms。
- typecheck：`tsc --noEmit` 总数维持既有 109（全部为未 link-peers 的 `@deepseek-ai/*`
  既有环境问题），`codex/` 目录零错误。
- 测试回归：vitest 294 通过；12 文件加载失败 + 2 断言失败均为既有环境/平台问题
  （未 link-peers；Windows 路径转义与 0600 权限语义），与本次改动无关。
- 浏览器验收（`node codex/ui/scripts/verify-render.mjs`，系统 Chrome，dev server + mock）：
  **49/49 通过**。覆盖：九视图渲染、13 令牌解析、color-mix 产物取色、八视图数据加载、
  详情抽屉/编辑表单、封门→已闭馆→重开软删语义、走廊节点/边/图例、拖拽位移 >40px、
  节点点击开抽屉、项目切换不串库、中/EN 切换、深浅色翻转（#fff ↔ #232324）。
  截图：`codex/ui/.verify/d1-{today-light,today-dark,library,corridor}.png`。
- 已知边界：preview（生产构建）下 mock 不生效，数据区走降级文案——符合预期，
  D2 真实 API 上线后即消；dev 模式无 React Fast Refresh（组件改动整页刷新），
  未引 @vitejs/plugin-react（tsconfig react-jsx 已保证 automatic runtime）。

## 4. 后续阶段入口

- D2：`codex/web`（Node 原生 HTTP）按 1.2 清单复刻接口，共享 `openCodexRuntime`；
  dev 代理从 mock 切真实服务；仅绑 127.0.0.1 + 访问令牌。
- D3：逐功能对齐验证（MCP 写入 → UI 可见 → UI 修改 → MCP 可读）。
- D4：启动/打开/停止命令（默认不开机自启，不影响 MCP/Hooks）。

## 5. DSH 残留缺口审计（2026-10-14 20:55，D2 前置）

**耦合面总检**：`codex/` 全目录对 `@deepseek-ai/*` 零运行时引用（仅注释）；
codex 引用的 11 个 src 共享模块传递依赖全部干净（types/config 为 type-only 引用，构建期擦除）。

**唯一脏链**：`src/ingest/hook.ts:12` value import `../llm/client.ts` → `@deepseek-ai/dsh-llm` + `cordis`。
Codex 侧已用零依赖的 `src/ingest/keys.ts` 隔离（hooks 只 import keys.ts，实测零引用 hook.ts/llm）。
该链拖住的功能：auto 档 LLM 摄取提取、历史回填（`src/ingest/history.ts` 经 hook.ts 被拖住）。

**UI 35 接口的 D2 可复用性**：

| 类别 | 模块 | 结论 |
|---|---|---|
| 干净可直接复用 | refurb / tour-proposal / telemetry-aggregate / mirror-markdown / consolidation-run（仅 dep vec.ts）/ jev-runtime + jev-client（原生 fetch）+ jev-observe（内存环 50 条） | 直接 import |
| 需在 web 侧重实现 | health（routes.ts 内联公式：store.stats + exportAll 边数，5 维加权）、workspaces（dbDir 扫描 project-*.db + projectIdentity 解析，只读 git config）、models（Codex 无 provider 注册表 → 明确反馈不支持） | 新写 |
| 不可复用 | history-backfill（脏链 + 需 LLM 提取模型，按约束须显式配置，不假设 Codex 凭据） | 明确反馈 |
| 作用域缺口 | `shared`：Codex Runtime 仅 user/project，UI「共享」宫格必须显式报错，禁止假成功 | 边界处理 |

**其他未移植项**：MCP 工具面仅 6 个（save/search/list/get/update/forget），DSH 侧还有
restore/report/review/audit_forgotten/profile_edit/distill/examine（UI 走 web API 不受影响，
但 Agent 侧功能不对等）；摄取期实体/事实/会话摘要抽取与信念巩固（store 原语齐全，
codex runtime.save 无调用方——DSH 在 ingest 管线做，auto 档设计时一并决策）。
