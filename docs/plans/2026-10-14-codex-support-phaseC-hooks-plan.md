# codex-engram · C 阶段（Hooks 接入与测试）前置清单

日期：2026-10-14
分支：`feature/codex-support`
前置：[Phase 1 存储适配](./2026-10-14-codex-support-phase1.md) · [B 阶段 MCP](./2026-10-14-codex-support-phaseB-mcp.md)

---

## 0. 结论先行

**需要**把 hooks 装进真实 Codex 才能验证「真的触发了」，但**不需要**走插件安装流程（`plugin.json` + `codex plugin add` 属 E 阶段）。
C 阶段的推荐路径是：**先把 runner 的离线 harness 测通（不需要 Codex），再把三条 hook 加进本仓库的项目级 `.codex/hooks.json` 做真机验证。**
离线部分可以像 B 阶段一样做到全自动化；真机部分每改一次 hook 定义都要重新信任一次。

---

## 1. 本机宿主实测事实（本次核查，非文档推测）

| 事实 | 证据 | 对 C 阶段的意义 |
| --- | --- | --- |
| Hooks 特性**已启用** | `codex features list` → `hooks  stable  true`（`plugin_hooks` 已 removed，功能合并进 `hooks`） | 不需要改 `config.toml` 的 `[features]`，直接加钩子即可 |
| Codex 版本 | `codex-cli 0.162.0-alpha.2`，可执行文件 `C:\Users\ZHQ\AppData\Local\OpenAI\Codex\bin\9691020b546a15b2\codex.exe`（不在 PATH；升级后 hash 目录会变） | 所有 CLI 操作要用绝对路径；建议先 `codex --version` 复核 |
| 本仓库已被 Codex 信任 | `~/.codex/config.toml` → `[projects.'F:\开源项目\codex-engram'] trust_level = "trusted"` | **项目级 hooks 可以直接加载**，不用再走项目信任确认 |
| `~/.codex/hooks.json` 已有 6 类钩子在跑 | 内含 agentmemory（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PreCompact/Stop）、i-have-adhd、code-review-graph | 全局注册会与它叠加执行 → **双注入风险**，C 阶段优先用项目级 |
| 已存在同名第三方插件 `engram` | `[marketplaces.engram] source = github.com/Gentleman-Programming/engram.git`；其 `hooks.state."engram@engram:..."` 记录仍在但 **全部 `enabled = false`**，插件缓存目录已空（已卸载） | 与本项目**无关**，但提醒：插件名必须用 `codex-engram`，避免继承这些陈旧信任记录 |
| Hook 信任按定义哈希记录 | `[hooks.state.'<文件>:<事件>:<序>:0'] trusted_hash = "sha256:…"` + `enabled` | **任何命令改动 = 哈希变化 = 需重新信任**，这是 C 阶段迭代最常见的坑 |
| Windows 上 hooks 确实可用 | 现有 hooks 命令形态 `node "C:\...\script.mjs"`（绝对路径 + 引号） | Windows 写法已有先例；注意含空格路径要加引号，官方另有 `commandWindows` 覆盖字段 |

---

## 2. 你需要做什么（真机部分）

### 2.1 落地位置三选一

| 路径 | 文件 | 影响面 | 适用 |
| --- | --- | --- | --- |
| **A. 项目级（C 阶段推荐）** | `<repo>/.codex/hooks.json` | 只在 `F:\开源项目\codex-engram` 里开的会话生效；不碰你的全局配置与 agentmemory | 开发调试、可随时删除 |
| B. 全局 | `~/.codex/hooks.json` | 所有会话生效；需与现有 6 类钩子合并（会叠加执行） | 验证「换到别的项目也能自动召回」时用 |
| C. 插件内置 | `plugin.json` 的 `extensions.com.openai.hooks` | 需 `codex plugin add` 安装 + 信任；插件名 `codex-engram` | E 阶段打包时做，不要在 C 阶段混进来 |

### 2.2 信任流程（每改一次钩子都要做一遍）

1. 写好 hooks.json；
2. 在 Codex TUI 里执行 `/hooks`，逐条审阅命令后**信任**（信任结果按定义哈希写进 `config.toml` 的 `[hooks.state…]`）；
3. 非交互式单次绕过（仅调试用）：`codex exec --dangerously-bypass-hook-trust …`；
4. 改了命令内容（哪怕只换路径）→ 哈希变化 → 必须重新信任，否则该钩子被**静默跳过**（表现为「什么都没发生」，不报错）。

### 2.3 三会话真机验收（C 阶段完成标准）

| 场景 | 动作 | 期望 |
| --- | --- | --- |
| 自动召回 | 在项目 A 会话里问一个此前存过的项目约定 | `UserPromptSubmit` 注入相关记忆；模型回答用上了它（可在 Codex 的 hook 日志/`engram_list` 交叉确认） |
| 显式记住 | 会话里说「记住：…」（`explicit` 模式） | `Stop` 触发摄取 → 该条进入项目库（`engram_list` / Web 面板可见） |
| 自动摄取（可选） | 开启 `auto` 模式对话若干轮 | 从实际对话提取长期信息落库，且**不把普通聊天全文存成记忆** |
| 隔离 | 换另一个已信任项目做同样提问 | 不返回项目 A 的私有约定 |
| 旁路 | 会话开始 | `SessionStart` 注入少量重要长期记忆（画像/高重要度条目） |

### 2.4 Windows 注意事项（C 阶段实测点）

- hook 命令以**会话 cwd** 运行，插件文件必须用绝对路径（或 `commandWindows` 指定）；
- 10s 超时内不要做模型下载（嵌入保持 `off`）；
- **stdout 必须纯净**：SessionStart/UserPromptSubmit 只能输出 `hookSpecificOutput.additionalContext` 的 JSON，Stop 只能输出合法 JSON；日志一律 stderr；
- 三条 hook 各起一个进程 → 每次会话有 3 次进程启动开销，runner 必须快速启动（不打开数据库、不加载模型，与 MCP 同纪律）。

---

## 3. 我这边会做什么（离线可全自动验证的部分）

| 产出 | 内容 | 离线可测 |
| --- | --- | --- |
| `codex/hooks/runner.mjs` | 读 stdin JSON → 按 `hook_event_name` 分发 → 输出契约 JSON；自身用 `import.meta.url` 定位插件根 | ✅ 直接喂事件 JSON，断言 stdout |
| `codex/src/hook-events.ts` | 事件解析（`session_id`/`turn_id`/`cwd`/`prompt`/`last_assistant_message`）与输出构造 | ✅ vitest |
| 注入侧 | 复用 `render.ts` 的裁剪 + `renderMemoryPacket` 协议包裹；`cwd` 作为项目上下文（hook 的 cwd 是**会话** cwd，属可信来源，无需 `projectRoot`） | ✅ 假 store 断言注入文本 |
| 摄取侧 | `UserPromptSubmit` 把用户请求按 `session_id`/`turn_id` 存进 `op_log`（跨进程幂等键）；`Stop` 取 `last_assistant_message` 配对后交给提取器；`off / explicit / auto` 三档 | ✅ 假 LLM 适配器；`auto` 用桩模型即可全自动 |
| 冒烟脚本 | 类似 `codex/scripts/smoke.mjs`：喂 3 个真实事件 JSON，断言注入与摄取落库 | ✅ 一条命令 |
| 真机脚本（可选） | 生成/合并 `<repo>/.codex/hooks.json`（先备份，绝不覆盖既有内容），打印待信任项与验证步骤 | — |

**不假设**：不解析 Codex 会话内部格式（只用 `last_assistant_message`）；不把 Codex 登录凭据当 LLM API 用（`auto` 必须显式配置提取模型）。

---

## 4. 需要你拍板的三件事

1. **落地位置**：项目级 `<repo>/.codex/hooks.json`（推荐，可随时整目录删除）还是全局 `~/.codex/hooks.json`（需备份现有 6 类钩子后合并）？
2. **摄取模式**：先只做 `explicit`（"记住：…" 才落库，零外部依赖）还是一并做 `auto`（需要你提供可用的提取模型：OpenAI 兼容 `base_url` + `api_key` + `model`）？
3. **是否要我代跑真机**：我可以生成 hook 文件并给出待信任清单，但 `/hooks` 里的**信任动作与真实会话**必须你来做（交互式 TUI）；如果需要端到端自动化，可用 `codex exec --dangerously-bypass-hook-trust` 跑一轮（会消耗你的模型额度）。

另外：你现在 `~/.codex/hooks.json` 里的 agentmemory 钩子会与本插件**同时注入记忆**。C 阶段建议用项目级落地并临时禁用 agentmemory 的那几条（在 `[hooks.state…]` 里 `enabled = false`）以便观察单一来源效果——这件事需要你确认，我不会擅自动你的既有钩子。

---

## 5. 实施记录（2026-10-14，按「项目级 + explicit」决策落地）

### 5.1 已交付代码

| 文件 | 职责 |
| --- | --- |
| `codex/src/hook-events.ts` | 事件契约：stdin JSON 解析（`session_id`/`turn_id`/`cwd`/`prompt`/`last_assistant_message`/`source`/`stop_hook_active`）、`additionalContext` JSON 构造、「记住」标记提取（含偏好识别，最多 3 条，正文 ≤400 字） |
| `codex/src/hooks.ts` | 三事件分发：SessionStart 注入（画像 + 用户库/项目库高重要度条目，预算 900 字）、UserPromptSubmit（先检索注入 → 再写显式记忆，避免把刚存的又注入回去；pending 落 op_log）、Stop（清理 pending，`stop_hook_active` 时完全不碰库） |
| `codex/src/hooks-cli.ts` | CLI 入口：stdin→stdout、`console.log` 收编到 stderr、**按需打开数据库**、失败一律退出码 0、退出前关句柄 |
| `codex/hooks/runner.mjs` | hooks.json 引用的薄壳：用**自身位置**推导插件根（不依赖 `${PLUGIN_ROOT}` 展开），产物缺失时静默跳过 |
| `.codex/hooks.json` | 项目级注册（三条事件，绝对路径，timeout 10s，带 statusMessage） |
| `codex/scripts/smoke-hooks.mjs` | 真实进程冒烟：7 组场景 20 项断言 |
| `codex/tsdown.config.ts` | 双产物：`dist/mcp.js` + `dist/hooks.js`（共享 chunk 也在 dist 内，发布时整目录带走即可） |

### 5.2 测试结果

| 命令 | 结果 |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run tests/codex-hooks.spec.ts` | **18 passed**（事件解析 / 标记提取 / 三事件分发 / 幂等 / 隔离 / CLI 端到端 stdout 纯净） |
| 四个 codex 测试文件合计 | **49 passed**（runtime 11 + mcp 17 + hooks 18 + concurrency 3） |
| `node codex/scripts/smoke-hooks.mjs` | **全部通过 ✅**（7 组场景，走真实 `hooks/runner.mjs` 子进程） |

关键验收项对应的用例：普通聊天**不落库**（explicit 核心）、「记住：…」落项目库且同轮重复触发不重复写、
相关提问注入 `<engram_memory_context>` 且另一项目不命中、SessionStart 注入本项目记忆、Stop 无输出且清理 pending、
非法输入静默退出（stdout 始终只有合法 JSON 或空）。

### 5.3 你还需要做的一步：信任

Codex 只运行「已被信任」的钩子，且信任按**定义哈希**记录。加好 `.codex/hooks.json` 后：

1. 在 `F:\开源项目\codex-engram` 目录下的 Codex 会话里执行 `/hooks`；
2. 逐条审阅 `engram` 的三条命令并信任；
3. 之后改任何命令文本（含路径）都要重新信任，否则该钩子被**静默跳过**。

> ⚠️ 关于「已手动禁用 agentmemory」：核查发现**只禁用了插件来源的那几条**
> （`agentmemory@agentmemory:hooks/hooks.codex.json:*` 全部 `enabled = false` ✓），
> 但 `~/.codex/hooks.json` 里**同名的用户级条目仍是启用状态**（`config.toml` 里这些段没有 `enabled = false`，
> 默认即启用）：`user_prompt_submit:0:0`（agentmemory prompt-submit）、`pre_tool_use:0:0`、
> `pre_compact:0:0`、`post_tool_use:1:0`。它们仍会在每个会话注入 agentmemory 的记忆。
> 要彻底单一来源，需要给这几个 `[hooks.state.'C:\Users\ZHQ\.codex\hooks.json:…']` 段补 `enabled = false`，
> 或把 `~/.codex/hooks.json` 里对应的命令组删掉（后者不需要重新信任，前者也不需要）。
> 这一步会改动你的真实配置，我按约定没有代做。

### 5.4 待接续（不在 C 阶段）

- `auto` 档的对话提取：需要显式配置提取模型（OpenAI 兼容 base_url/api_key/model）后接进 `Stop`；
  pending 队列（op_log 的 `hook-turn-request`）已经按 `session_id`/`turn_id` 存好，接上模型即可复用。
- `SessionEnd`/`PreCompact` 事件、`commandWindows` 覆盖、插件内置 hooks（E 阶段）。
