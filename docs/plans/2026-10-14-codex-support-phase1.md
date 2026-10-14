# codex-engram · Phase 1：既有代码审查与核心存储适配

日期：2026-10-14
分支：`feature/codex-support`
本阶段产出：`codex/src/{paths,config,runtime}.ts` + `tests/codex-runtime.spec.ts`（11 项验收测试全绿）

---

## 0. 结论摘要

1. **存储与安全内核与宿主完全解耦**。`src/store/`、`src/project/identity.ts`、`src/security/`、
   `src/write-disposition.ts`、`src/palace/`、`src/review/`、`src/imagery/`、`src/embedder/`
   的依赖闭包只有 `node:*` 与 `@huggingface/transformers`，**零 `@deepseek-ai/*` 引用**，可原样复用。
2. 宿主耦合只集中在 **5 个文件**：`src/index.ts`（cordis apply）、`src/tools/create.ts`（dsh-tools）、
   `src/routes.ts`（dsh-host-webserver）、`src/llm/client.ts`（dsh-llm）、`src/client/*`（DSH 客户端插槽）。
   Codex 侧不必碰它们，只需新增适配层。
3. **本阶段任务 A 已完成**：独立 Codex Runtime 支持用户级 / 项目级记忆库的打开、保存、检索、
   修改、软删除、恢复与统计；默认数据目录 `$CODEX_HOME/engram`，与 `~/.dsh/engram` 物理隔离，
   并加了硬护栏拒绝误指向 DSH 目录。
4. **环境结论**：Node v22.22.2 + `node:sqlite`（DatabaseSync）可用，满足 `engines: ^22.19 || >=24`；
   本机 Codex Desktop 已安装（`~/.codex/`），`hooks.json` 已在 Windows 上真实运行（见 §5）；
   仓库 `node_modules` 的 pnpm 符号链接在本会话 shell 中不可解析，已改用 hoisted 布局修复（见 §5.3）。

---

## 1. 现有代码三分类

### 1.1 可直接复用（宿主无关，零改动）

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `src/store/sqlite.ts` | node:sqlite 实现：节点/边/op_log/FTS5（unicode61 + 中文 2-gram 预切词）、schema v12 单调迁移、RRF 混合检索、SM-2 调度、门牌评分 | `node:*` + 仓库内纯模块 |
| `src/store/interface.ts` | `EngramStore` 接口（一个 scope 一个实例） | 纯类型 |
| `src/types.ts` | 记忆记录 / 边 / 查询 / `EngramError` 词汇表 | 纯 |
| `src/project/identity.ts` | git origin 归一化 → sha256 短哈希分库名；cwd 兜底；旧库 rename 迁移 + sidecar | `node:crypto/fs/path`，**不起子进程** |
| `src/project/registry.ts` | 项目宫殿清单（输入是 `WorkspaceRef[]`） | 纯 |
| `src/security/redact.ts` | 密钥/手机号/身份证脱敏 | 纯 |
| `src/security/sanitize.ts` | 协议标签剥离 + 记忆包框定 | 纯 |
| `src/write-disposition.ts` | 写入四态 ACCEPT/MERGE/DROP/DEFER + 并入强化 | `types` + `store/interface` + 纯 `jev/observe` |
| `src/palace/slots.ts`、`src/review/sm2.ts`、`src/imagery/score.ts`、`src/vec.ts`、`src/token.ts` | 排桩、SM-2、门牌评分、余弦、token 估算 | 纯 |
| `src/embedder/{interface,local}.ts` | transformers.js 本地嵌入（bge-small-zh-v1.5, q8） | `@huggingface/transformers` |
| `src/page.ts` | 自包含单文件 HTML 管理页（内联 CSS/JS，无 import） | 纯字符串 |
| `src/ingest/hook.ts` 的纯函数段 | 提取提示词、`parseEntityMentions`、幂等键（`op_log` + `hasAudit`） | 提示词与解析可原样搬 |

### 1.2 只需增加适配器

| 模块 | 耦合点 | Codex 侧做法 |
| --- | --- | --- |
| `src/config.ts` | `@deepseek-ai/schemastery` 校验面 + 默认 `dbDir` | 已实现 `codex/src/config.ts`：同默认值、同取值域校验，去掉 schemastery（本地声明 `LegacyMigrationPolicy`，避免牵入 DSH 类型链） |
| `src/llm/client.ts` | `ctx.llm.stream` + `BlockAssembler` | 后续任务 3：保留入参签名 `{route, system, userText, maxTokens, purpose, signal}` → `string`，实现换成显式配置的 OpenAI 兼容 HTTP 调用 |
| `src/index.ts` 的画像渲染 | `renderProfileWithCurated` / `renderProfileDetailed` 落在顶层 import dsh-llm 的文件里 | 抽取同款渲染到 `codex/src/inject.ts`（只依赖 `estimateTokens`），不改原文件 |
| `src/ingest/hook.ts` 的编排 | `SessionEventLike`（DSH 事件流形状） | 任务 3：换成 hooks 输入（`UserPromptSubmit.prompt` / `Stop.last_assistant_message`），提示词与结构化解析复用 |
| `src/ingest/history.ts` | `HistoryLogSource` | 后续：Codex 会话日志来源另配；Phase 1 不做 |
| `src/routes.ts` | cordis `webServer` 插件形态 | 任务 4：`PAGE_HTML` 直接复用，`/api/engram/*` 用 `node:http` 重写（路由处理逻辑参照 routes.ts） |

### 1.3 必须替换（DSH 专属）

| 模块 | 原因 | Codex 侧替代 |
| --- | --- | --- |
| `src/index.ts` `apply(ctx, config)` | cordis 插件入口：`ctx.tools.register` / `ctx.on('agent/pre-step')` / `ctx.inject(['webServer'])` / `ctx.effect` | MCP tools + Hooks（任务 2/3） |
| `src/tools/create.ts` | `defineTool` / `@deepseek-ai/dsh-tools` / `ToolRunContext` | MCP SDK 工具定义（任务 2：先 6 个工具） |
| `src/client/*`（React 面板） | DSH ui-slots / locale / settings 插槽 + 宿主工作区服务 | Phase 1 不复用（用独立 Web 页） |
| `package.json` 的 `dsh.bundle` / `dsh.client`、`cordis.patch.yml` | DSH 打包约定 | `plugin.json` + `mcp.json` + `hooks/hooks.json`（任务 5） |

---

## 2. 宿主边界

```
Codex 侧新增（本阶段起）            DSH 侧原样保留
┌──────────────────────────┐        ┌───────────────────────────────┐
│ codex/src/runtime.ts     │        │ src/index.ts  (cordis apply)   │
│   ├ codex/src/config.ts  │        │ src/tools/create.ts (18 tools) │
│   ├ codex/src/paths.ts   │        │ src/routes.ts  + src/client/*  │
│   └ hooks / mcp (任务2/3)│        └───────────────────────────────┘
└───────────┬──────────────┘                    │
            │  共用同一套内核（不改动）          │
            ▼                                    ▼
   src/store/sqlite.ts · src/project/identity.ts · src/security/* ·
   src/write-disposition.ts · src/palace · src/review · src/imagery · src/embedder
                          │
                          ▼
   $CODEX_HOME/engram/{user.db, project-<hash>.db}      ~/.dsh/engram/{...}
                 （默认隔离；库文件格式一致，可人工搬迁）
```

关键点：**两边打开的是同一种库文件**（同名、同 schema、同迁移），差异只在「谁来打开、放在哪个目录」。

---

## 3. 关键架构决策

| # | 决策 | 理由 |
| --- | --- | --- |
| 1 | 数据目录 `$CODEX_HOME/engram`，`CODEX_ENGRAM_DIR` 可覆盖 | Codex CLI 认 `CODEX_HOME`（缺省 `~/.codex`）；hook 与 MCP 是**两个独立进程**，需要一个双方都能独立推导的稳定路径，不能用客户端运行时注入的 `${PLUGIN_DATA}` |
| 2 | 硬护栏：`dbDir` 落在 `~/.dsh/engram` 内直接拒绝（`allowDshDir` 可放行） | 落实「不修改原始 DSH 数据」的约束，防止环境变量误配把两个宿主写进同一目录 |
| 3 | 不新增 schema、不写自己的迁移 | `SCHEMA_VERSION=12` 与 `MIGRATIONS` 原样复用；两个宿主对同一库文件的读法必须一致 |
| 4 | Codex 侧只暴露 `user` / `project` | DSH 的 `shared` 语义（跨 agent 公开可读）在 Codex 侧没有对应物，先不开放，避免歧义 |
| 5 | 嵌入 `lazy` + 失败降级为纯关键词 | 首次下载模型可能耗时且需网络（Codex 沙箱默认拒绝网络）；Hook 关键路径（10s 超时）应显式 `embedding: 'off'`，向量只留给 MCP 的 save/search |
| 6 | MCP 走 stdio，无常驻 HTTP | 与规范一致（`type: "stdio"`），进程随 Codex 按需启动 |
| 7 | Web 管理页按需启动，复用 `PAGE_HTML` | 不移植 React 宿主与国际化插槽；页面已把用户内容全部走 DOM API（无 innerHTML 拼接） |
| 8 | 不引入 Docker / Redis / 向量库 | 向量存 `nodes.embedding` BLOB，检索在进程内算余弦；与「最小基础设施」约束一致 |
| 9 | `auto` 摄取必须有显式提取模型配置 | Codex 的登录凭据是订阅态凭据，不能假设可直连独立 LLM API；默认 `off`/`explicit` |

---

## 4. 任务 A：核心存储适配（已实现）

### 4.1 新增文件

| 文件 | 内容 |
| --- | --- |
| `codex/src/paths.ts` | `resolveCodexDbDir`（`CODEX_ENGRAM_DIR` > `<CODEX_HOME>/engram` > `~/.codex/engram`）、`expandHome`、`dshDbDir`、`isInsideDir`（Windows 大小写/分隔符归一） |
| `codex/src/config.ts` | `resolveCodexConfig`：未知键 loud 失败、枚举与数值域校验、默认值单点落地；与 `src/config.ts` 同默认值（排桩/复习调度/排序 boost/衰减窗口） |
| `codex/src/runtime.ts` | `openCodexRuntime(config)` → `CodexRuntime`：分库懒打开与缓存、嵌入器懒加载、四态写入、跨库检索合并、id 自动定位、软删/恢复、统计、`close()` |
| `tests/codex-runtime.spec.ts` | 11 项验收测试 |

`tsconfig.json` 的 `include` 追加 `"codex"`（类型检查覆盖新目录；`vitest.config.ts` 的 `tests/**/*.spec.ts` 已覆盖新测试，无需改动）。

### 4.2 Runtime API

```ts
openScope(scope)            // 'user' → user.db；'project' → project-<hash>.db（必要时创建）
ensureEmbedder()            // 懒加载本地嵌入；不可用返回 undefined（检索降级）
save({content, kind, scope?, importance?, confidence?, sessionId?, round?, seq?, placard?})
search({query, scopes?, limit?, rooms?})   // 跨库合并，按 RRF 分排序；库不存在的作用域跳过
get(id, scope?)             // 不给 scope 时先 user 后 project 自动定位
list({scope, status?, kind?, q?, limit?, offset?, sort?})
update({id, content, scope?, kind?, importance?, placard?})   // 旧条目归档 + supersedes 边
forget(id, {scope?, tombstone?})   // 软删；带闭馆三问时写 op_log 墓志铭
restore(id, scope?)
stats()                     // 各作用域统计 + dbDir/cwd/projectDbName
close()                     // 必须 await（Windows 上不关句柄会锁住 .db 文件）
```

行为与 DSH 对齐的细节：写入前 `sanitizeProtocolText` + `redactSecrets`；四态处置（复述并入
既有条目、疑似矛盾落库并建 `contradicts` 边）；只读路径不给一次性 cwd 建空库；
首次打开幂等补齐存量排桩（失败不污染句柄）。

### 4.3 验收证据

```
node node_modules/vitest/vitest.mjs run tests/codex-runtime.spec.ts
→ Test Files  1 passed (1)      Tests  11 passed (11)      6.54s
```

覆盖：写入→检索→按 id 读取（默认 project 库、`degraded` 标记）、脱敏与空内容拒绝、
user/project 分库隔离且查询不建空库、修正取代链（旧条目 archived + `supersededBy`）、
软删后不再命中且 `restore` 复原、墓志铭闭馆 + 三问缺项 loud 失败、不存在 id 的 loud 失败、
**关闭后重开数据不丢**、项目库按 git origin 归一化哈希命名（同仓库跨实例共享、跨仓库隔离）、
默认目录与 `~/.dsh/engram` 不重叠、拒绝误指向 DSH 目录。

类型检查：`tsc --noEmit` 在 `codex/**` 与 `tests/codex-runtime.spec.ts` 上**零错误**；
其余报错全部来自未链接的 `@deepseek-ai/*` peer（既有环境状态，非本次改动引入）。

---

## 5. 环境核查（Windows + Node + Codex）

### 5.1 满足项

- **Node**：`node -v` → `v22.22.2`；`node:sqlite` 的 `DatabaseSync` 可用（带 `ExperimentalWarning`，
  无需 `--experimental-sqlite`）；符合 `engines: ^22.19.0 || >=24.0.0`。
- **Codex**：本机已安装 Codex Desktop（`C:\Users\ZHQ\.codex\` 含 `config.toml`、`hooks.json`、
  `plugins/`、`marketplaces.*`）；`codex` CLI 未加入当前 shell 的 PATH，脚本化验证需用绝对路径。
- **Hook 在 Windows 上确实可用**：本机 `~/.codex/hooks.json` 已在运行 `SessionStart` /
  `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `PreCompact` / `Stop`，命令形态为
  `node "<绝对路径>.mjs"`（进程收到 stdin JSON，事件含 `session_id` / `turn_id` / `cwd` /
  `prompt` / `last_assistant_message`）。这直接验证了任务 3 的可行性。
- **官方格式与用户给定样例一致**：`plugin.json`（`$schema` + `name` 必需，客户端专属配置进
  `extensions.com.openai`，如 `"hooks": "./hooks/hooks.json"`）与根目录 `mcp.json`
  （`mcpServers.*` 必填 `type: "stdio"`），与任务书中的示例配置吻合。

### 5.2 需要在任务 3/5 实测的风险点

| 风险 | 说明与对策 |
| --- | --- |
| `${PLUGIN_ROOT}` 展开范围 | 规范只保证在 **stdio 的 `args` / `env` 值 / `cwd`** 中单次展开，**`command` 不展开**。因此 `hooks.json` 里 `"command": "node ${PLUGIN_ROOT}/hooks/runner.mjs ..."` 不可假定成立。对策：命令里只用相对/hook 自身位置（runner 用 `import.meta.url` 自定位），或使用 Codex 的 `commandWindows` 覆盖项；本机现有 hook 用的是绝对路径，也是可行退路 |
| Hook 工作目录 | Hook 命令以**会话 cwd** 运行（可能是子目录），不能用会话相对路径定位插件文件 |
| Hook 信任 | Hook 按「定义哈希」记录信任，改动 hook 定义后需在 `/hooks` 重新信任；首次安装后不会静默生效 |
| 沙箱与网络 | 插件 MCP 服务在 Codex 沙箱内运行，默认**禁止网络**：首次下载嵌入模型会失败 → 保持 `embedding` 降级路径，或让用户在 `config.toml` 放开 `network_access` / 预先放好模型缓存 |
| 插件根目录外写入 | 规范要求插件声明的路径落在插件根内（`${PLUGIN_DATA}` 才是可写数据目录）。本设计把库放在 `$CODEX_HOME/engram`（进程运行时写入、非清单声明路径），与其它本地 MCP 服务的惯例一致；若沙箱 `writable_roots` 收紧，需在文档中给出 `CODEX_ENGRAM_DIR` 指向 `${PLUGIN_DATA}` 的替代配置 |
| 已有同类插件 | 本机已装第三方 `@agentmemory/agentmemory`（hook 形态，走 `D:\Tools\Agent\agentmemory-shim`，另有本地 HTTP 服务）。安装 codex-engram 后会出现**两套记忆注入**，需在文档里说明共存/择一 |
| Windows 路径与进程 | 安装路径含空格时命令必须带引号；Hook 超时 10s 内不要做模型下载；MCP 进程退出前 `await runtime.close()` 以免锁库 |

### 5.3 本会话发现并处理的环境问题

`node_modules` 顶层链接完全缺失、且 pnpm 的符号链接布局在本会话 shell 中不可解析
（Node 创建目录符号链接后 `realpathSync` 报 `UNKNOWN`，即链接对象存在但无法遍历）→
`vitest` 无法启动。处理：清空 `node_modules` 后以 **hoisted 布局**重装
（`corepack pnpm install --node-linker=hoisted --offline --ignore-scripts`，包全部来自本地 pnpm store，
无网络下载）。之后 `node node_modules/vitest/vitest.mjs run` 可用（`pnpm <script>` 因 linker
与 `.modules.yaml` 记录不一致会触发自动 install，直接调 `node node_modules/vitest/vitest.mjs` 即可）。
如需恢复 pnpm 默认（isolated）布局，请在**自带终端**里删除 `node_modules` 后重跑 `pnpm install` 验证；
若同样失败，则把 `node-linker=hoisted` 写进 `.npmrc` 作为本机方案。

全量套件基线（本次实测）：`Test Files 12 failed | 19 passed | 1 skipped`，
`Tests 3 failed | 248 passed | 1 skipped`。失败构成：
① 需要 `@deepseek-ai/*` 的文件无法加载（本次未运行 `scripts/link-peers.mjs`，且该脚本依赖的
符号链接在本机同样不可用）；
② `tests/migration-policy.spec.ts` 2 项既有失败——断言用**原始路径**去匹配 sidecar 里
`JSON.stringify` 后的**转义路径**（`C:\\Users\\...`），属 Windows 平台既存问题，与本次改动无关。

---

## 6. 后续任务实施要点（预留）

| 任务 | 复用 | 新增 | 主要风险 |
| --- | --- | --- | --- |
| 2 · MCP Server（stdio，6 工具） | `CodexRuntime` 全部方法；`store/interface` 类型 | `codex/src/mcp.ts`（`@modelcontextprotocol/sdk`，`engram_*` 六个工具，工具名与 DSH 保持一致以便提示词互通）、构建产物 `codex/dist/mcp.js` | SDK 依赖入库；schema 与 DSH 工具描述保持同义；进程退出前 `close()` |
| 3 · Hooks（SessionStart / UserPromptSubmit / Stop） | 画像渲染逻辑、`redactSecrets`、`encodeMemoryPacket`、`decideWrite`、`hasAudit` 幂等键 | `codex/hooks/runner.mjs`（读 stdin JSON → 分发事件）、`codex/src/inject.ts`、`codex/src/extract.ts`（LLM 适配器 + `off/explicit/auto` 三档） | `${PLUGIN_ROOT}` 展开与 Windows 引号；Stop 只能拿到 `last_assistant_message`，需用 `UserPromptSubmit` 存请求 + `session_id`/`turn_id` 关联；`auto` 档必须显式配置模型 |
| 4 · 可视化管理 | `src/page.ts` 的 `PAGE_HTML`、`runtime.list/search/update/forget/restore/stats` | `codex/src/server.ts`（`node:http`，实现页面实际调用的 `/api/engram/{stats,list,review,update,forget,restore,export}`）+ `codex/bin/engram-ui.mjs` 启动器 | 端口占用与仅监听 127.0.0.1；导出接口复用 `store.exportAll()` |
| 5 · 打包为 Codex Plugin | 上述全部产物 | `codex/plugin.json`（`extensions.com.openai.hooks`）、`codex/mcp.json`、`codex/hooks/hooks.json`、构建脚本产出约定路径 `dist/mcp.js` | hook 信任流程；`commandWindows`；安装路径含空格；`node` 需在 Codex 进程 PATH 中可见 |
