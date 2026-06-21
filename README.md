# 点将台 · AgentTeam Studio

> 用一句话，点出一支会自己干活的 AI agent 团队，然后让它们出征。

点将台是一个**自主多 agent 系统**：你用自然语言描述一个目标，「军师」帮你把需求想清楚并组建一支分工明确的团队；点击「出征」，由「将军」（主控）动态调度各「成员」（子 agent）协作，直到产出最终交付物。三者——军师、将军、成员——都跑在同一套 **harness 引擎**上（类似 Claude Code 的 agent 循环）。

零数据库、零框架：一个 Node.js 进程 + 前端单文件，数据落本地 JSON。`node server.js` 即可运行。

---

## 特性

- **一句话组队（点将）**：军师先追问关键问题、产出「作战蓝图」，再按蓝图组建 3~8 人团队，分层协作（前线产出 → 中层聚合 → 收尾整合）。
- **自主调度（出征）**：将军每轮根据「用户输入 + 各成员产出」决定下一步——派谁、并行、问用户、还是收尾；DAG 只是展示，不是固定顺序。
- **统一 harness 引擎**：军师 / 将军 / 成员共用一套 provider-aware 的 agentic 工具循环（思考 → 调工具 → 回灌 → 迭代）。
- **多模型 / 多 provider**：Anthropic API、本地 Ollama、阿里百炼，以及 Claude Code / Codex CLI（自带 harness 的黑盒）。将军与每个成员都可独立选模型。
- **真执行工具**：`shell`、`read_file`、`write_file`、`edit_file`（精确改）、`list_dir`、`web_fetch`，外加自动可用的 `ask_user`（人工确认）和 `update_skill`（成员自我进化）。shell/CLI 始终在本机执行。
- **记忆与上下文**：主控记忆（出征历史 + 成员最终结果）与成员私有记忆（各自 io + 对话）相互独立，仅在「续聊 / 历史再出征」时加载；上下文超预算时自动压缩并回写记忆。
- **实时对话**：出征中随时给将军或成员发消息；对**已完成/空闲**成员说话会**即时并行**把它叫起来回应，不打断正在跑的其它成员。
- **停战**：一键硬终止正在进行的出征（中断在跑的模型调用与 shell，并解开等待中的确认）。
- **团队自我进化 → 再战**：对话中将军可改成员契约 / 新建成员 / 追加全局规则，成员可改写自己并回写全局 Skill；进化过的团队，历史记录再跑就是「⚔ 再战」。
- **富文本交付**：成员输出框直接渲染 Markdown、图片、音视频、`.html` 内联预览、Mermaid 流程图、KaTeX 公式。
- **断点/重启续上**：出征记录持续落盘；服务器重启后自动续上中断的团队。
- **导入 skill 组队**：把一套调试好的 skill（文件/文件夹/粘贴）丢进来，自动拆成团队成员与依赖图，原文逐字保真。

---

## 快速开始

需要 Node.js 18+（用到内置 `fetch` / `AbortController`）。

```bash
git clone https://github.com/wpchao542/team_builder.git
cd team_builder
npm install

# 配置：复制模板并填入你的 key
cp config.example.json config.json
#   编辑 config.json，至少配一个模型 provider 的凭证（见下）

npm start          # 启动 → http://localhost:7860
```

不想配 key、只想看交互，可以跑演示模式（假数据，不调任何 API）：

```bash
npm run mock       # MOCK=1 node server.js
```

---

## 配置（config.json）

复制 `config.example.json` 为 `config.json`，按需填写。启动时这些键会注入 `process.env`，shell 工具里可直接用（如 `$ELEVENLABS_API_KEY`）；已存在的系统环境变量优先，不会被覆盖。

| 键 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` | 用 Anthropic API 时填 |
| `MODEL` | Anthropic 模型，如 `claude-opus-4-8` |
| `OLLAMA_HOST_URL` / `OLLAMA_MODEL` | 用本地 / Ollama 云模型时填，如 `minimax-m3:cloud` |
| `DASHSCOPE_API_KEY` / `BAILIAN_MODEL` | 用阿里百炼时填 |
| `ENABLE_CLAUDE_CODE` / `CLAUDE_BIN` | 用本机 Claude Code CLI（订阅登录）时开 |
| `ENABLE_CODEX_CLI` / `CODEX_BIN` / `CODEX_MODEL` | 用本机 Codex CLI 时开 |
| `DEFAULT_MODEL` | 系统默认模型（界面可改并写回 config.json） |
| `ALLOW_TOOLS` | 真执行总开关，默认开（设 `0` 才关） |
| `TOOL_TIMEOUT_MS` | 单条 shell 命令超时，默认 600000（10 分钟，渲染/合成耗时） |

> ⚠️ `config.json` 含密钥，已在 `.gitignore` 里，**不要提交**。
> 业务平台凭证（如某团队要用的 `ELEVENLABS_API_KEY`）由用户在团队上配置，运行时按需注入到该团队工具的环境，**不写死在代码里**。

---

## 怎么用

1. **点将**：在首页输入一句话目标（可附带导入的 skill）→ 军师追问 → 产出蓝图 → 组建团队。
2. **点兵**：检查 / 微调成员（角色、模型、工具、依赖），保存团队。
3. **出征**：填任务 → 点「出征」→ 将军开始调度，成员的思考与产出实时显示。
4. **对话**：点开任意将军 / 成员的思考框，随时插话；对已完成成员说话即时响应。
5. **停战 / 续聊 / 再战**：随时停战；出征结束后继续对话（续聊）；进化过 skill 的团队历史项再跑即「再战」。

---

## 架构一图

```
runHarness（唯一引擎：怎么跑）
  ├── 军师（点将）   = harness + [ask_user, submit_blueprint]      → 作战蓝图
  ├── 将军（主控）   = harness + [submit_harness_decision, update_team]
  │                    每轮据「用户输入 + 各成员产出要点」决定 dispatch / 并行 / ask_user / finish
  └── 成员（子agent）= harness + [真执行工具 + ask_user + update_skill] → 交付物
```

- **harness 是动词（怎么跑）**，**agent 是名词（谁在跑）**；三者同引擎、递归嵌套（将军的「工具」就是调成员，成员本身又是一圈 harness）。
- **隔离（仿 Claude Code 子 agent）**：将军和每个成员各有独立上下文 + 独立记忆；将军只看成员的**最终结果要点 + 产物文件路径**，看不到成员内部过程。

详见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)（含完整架构图、嵌套关系、三层 system prompt 原文、关键函数索引）。

---

## 数据与持久化

无数据库。本地 JSON 文件 + 内存 Map：

| 数据 | 位置 | 是否入库 |
|---|---|---|
| 团队 | `teams/<id>.json` | ❌ 用户数据 |
| 出征运行记录（spec + 全部事件） | `runs/<runId>/record.json` | ❌ 用户数据 |
| 主控记忆 / 成员私有记忆 | `memory/<teamId>.json` / `memory/<teamId>/members/<id>.json` | ❌ 用户数据 |
| 配置 | `config.json` | ❌ 含密钥 |
| 运行时状态（活跃出征 / 插话队列 / 待确认） | 内存 Map | 进程内，靠 record.json 重启续上 |

---

## 开发

```bash
npm test        # MOCK=1 node --test，跑 test/harness.test.js（纯函数单测）
npm run mock    # 演示模式，不调真实 API
```

后端核心都在 `server.js`（单文件 HTTP 服务，无框架）；前端在 `public/index.html`（单文件）。

---

## 许可

[MIT](./LICENSE)
