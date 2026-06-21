# 点将台 / AgentTeam Studio —— 架构

## 一句话

**Harness 是动词（怎么跑），Agent 是名词（谁在跑）。**
项目里只有**一套** agentic 引擎 `runHarness`；军师（点将）、将军（主控）、成员（子 agent）
都是「装好不同提示词/工具/模型/记忆，跑在这套引擎里的 agent」。自主性来自 harness，不来自模型。

---

## 架构图

```
╔══════════════════════════════════════════════════════════════════════════╗
║                     runHarness ── 唯一引擎（动词：怎么跑）                    ║
║  一份代码，所有 agent 共用。把「只会吐文本的模型」变成「能自主干活的 agent」 ║
║                                                                            ║
║   for turn in 0..MAX_TURNS:                                                ║
║     ① 取你实时插话(pullUserMessages) → 塞进对话，优先响应                    ║
║     ② 模型这一轮：思考(thinking流) + 可能的 tool_calls                       ║
║     ③ 有 terminalTool？ → 收到即「最终交付」，返回结构化结果，结束循环         ║
║     ④ 有普通工具？ → 逐个执行 → tool_result 回灌 → 继续循环                   ║
║     ⑤ ask_user → 发 checkpoint，停下等你（HITL）                            ║
║     ⑥ 无工具(纯文本)？ → 收尾 / 或撞到确认点(detectConfirmation)暂停          ║
║     ⑦ provider 适配：anthropic/ollama/百炼 走真循环；codex/claude-code 委托  ║
╚══════════════════════════════════════════════════════════════════════════╝
        ▲ 同一个引擎被「装」上不同的(提示词+工具集+模型+记忆) = 不同 Agent
        │
        │  Agent = 名词：谁在跑 ＝ harness ＋ 角色配置
        │
   ┌────┴─────────────────────────────────────────────────────────────────┐
   │                                                                        │
   │   出征前一步                          出征：将军(harness) 调度 成员(harness)
   │                                                                        │
┌──┴──────────────┐              ┌────────────────────────────────────────┴────┐
│  军师（点将）     │   蓝图        │            将军（主控 / orchestrator）          │
│ = harness +     │ ──────────▶  │  = harness + 工具[submit_harness_decision]     │
│ 工具:           │   组队        │  每轮看「你的输入 + 成员已产出结果」→ 决定下一步: │
│  ask_user       │              │     dispatch(派谁) / parallel / finish / ask_user│
│  submit_blueprint│             │  ★它的「工具」本质 = 调度成员                    │
│ 职责: 想清楚需求 │              └───────┬──────────────────────┬────────────────┘
│  + 追问 + 出蓝图 │                派活 │   ▲ 只回传【最终结果】  │ 派活
└─────────────────┘                     ▼   │                    ▼
                              ┌──────────────┴───┐      ┌──────────────────┐
                              │   成员A（子agent） │      │   成员B（子agent） │
                              │ = harness + 工具:  │      │ = harness + 工具: │
                              │  shell/write/read  │      │  shell/write/read │
                              │  + ask_user        │      │  + ask_user       │
                              │ 独立上下文+私有记忆 │      │ 独立上下文+私有记忆 │
                              └────────────────────┘      └──────────────────┘
```

---

## 谁包含谁（嵌套 / 递归）

```
runHarness  ⊃  将军          将军 = 跑在 harness 里的一个 agent
将军        ⊃  成员A/B…       将军的工具就是"派成员"，成员被它调起
runHarness  ⊃  成员A/B…       每个成员自己又是一圈独立的 harness 循环
```

⇒ 是「harness 套 agent，agent(将军) 又套 agent(成员)，成员还是 harness」的**递归结构**：
`harness ⊃ 将军 ⊃ 成员 ⊃ (成员的 harness)`

三句话：
1. **harness 包含 agent** —— agent 就是「装好提示词/工具/模型/记忆的一次 harness 运行」。
2. **将军(agent) 包含成员(agent)** —— 将军的工具不是 shell，而是「派成员」，成员被它调起。
3. **成员本身又是一个 harness** —— 所以是递归。

> 类比 Claude Code：`runHarness ≈ Claude Code 本体那层 agent 循环`；将军 ≈ 主 agent；
> 成员 ≈ 它派出去的子 agent（Task）；军师(点将) ≈ 开工前先规划。

---

## 三种 Agent 一览

| Agent | 工具集 | 职责 | 入口 |
|---|---|---|---|
| **军师（点将）** | `ask_user` + `submit_blueprint` | 把一句话需求想清楚、必要时追问，交结构化「作战蓝图」 | `designBlueprint` → `runHarness`（terminalTool=`submit_blueprint`） |
| **将军（主控）** | `submit_harness_decision`（=调度动作） | 每轮据「用户输入 + 成员已产出结果」决定 DAG 下一步：dispatch / parallel / finish / ask_user | `runHarnessPlannerDecision` → `runHarness`（terminalTool=`submit_harness_decision`） |
| **成员（子 agent）** | 授予的 `shell` / `write_file` / `read_file` + `ask_user` | 干自己那一步、产出交付物 | `runAgentCore` → `runHarness` |

---

## 记忆 / 上下文隔离（仿 Claude Code 子 agent）

| | 存什么 | 谁能看 | 路径 |
|---|---|---|---|
| **主控记忆** | 出征历史(runs) + summary + 成员**最终结果**(agentOutputs) | 将军 | `memory/<team>.json` |
| **成员私有记忆** | 该成员自己的 io 历史 + 你跟它的对话 + 要点 | **只有它自己** | `memory/<team>/members/<id>.json` |

隔离规则：
- ✗ 将军看不到成员内部过程/对话，只看最终结果。
- ✗ 你发给某成员的话不回传将军；中途插话也不回传。
- 各带各的：将军决策只带主控记忆；成员执行只带它自己的私有记忆。
- 只在**续聊 / 历史再出征**时读记忆；全新出征不读（但出征结束**总会写**两套记忆）。

---

## 关键函数索引（server.js）

- `runHarness({id, system, input, toolDefs, model, eff, send, ctx, opts})` —— 引擎本体；`opts.terminalTool` = 结构化提交模式。
- `modelTurn(...)` —— 把 anthropic / ollama / 百炼 的单轮归一成 `{content, toolCalls, usage}`。
- `designBlueprint` —— 军师；`runHarness` + `ask_user` + `submit_blueprint`。
- `runHarnessPlannerDecision` / `harnessDecisionTool` —— 将军每轮决策；`runHarness` + `submit_harness_decision`。
- `runTeam` —— 出征主循环：驱动将军逐轮决策、派发成员、处理你的中途插话与停止指令。
- `runAgentCore(agent, userContent, send, ctx)` —— 跑单个成员（也是 `runHarness`）。
- `pullUserMessages` / `enqueueInject` / `drainInbox` —— 用户实时插话注入通道（`/api/inject`）。
- 记忆：`readTeamMemory`/`writeTeamMemory`（主控）、`readMemberMemory`/`writeMemberMemory`/`formatMemberMemoryForPrompt`（成员私有）、`updateTeamMemoryFromRunRecord`/`writeMemberMemoriesFromRunRecord`（出征结束落盘）。

---

## 附录：三层 System Prompt 原文

> 点将/将军的提示词是**固定**的（在 server.js 里）；成员**没有**固定提示词——它的 system 就是军师当场为它量身生成的 `agent.system_prompt`（+ 导入 skill 时逐字拼接的原文）。

### A. 点将（军师）—— 两段，固定

**A-1 出蓝图 `BLUEPRINT_SYSTEM`（server.js:577）**（跑 harness 时末尾追加："先用 ask_user 追问，想清楚后必须调用 submit_blueprint 交结构化蓝图"）

```
你是「点将台」的首席方案架构师。用户只给一句话，但你不能直接拉一堆人来写文章
——你要先像 Claude 接到任务时那样，把这件事想清楚并讲给用户听，再去组队。

你的产物是一份【作战蓝图】，必须包含：
1. goal：把用户这句话还原成清晰、可执行的目标（补全隐含意图，但不要擅自扩大范围）。
2. tasks：拆成 2~7 个具体任务，写明先后/并行；每个任务写 title、detail、acceptance（验收标准）。
   任务要落到真实产出（文件、图、音频、视频、数据、代码），不要"写一篇文章"这种空话。
3. tools_needed：真正需要的执行工具（shell/write_file/read_file），每条说明为什么、用在哪。
4. external_platforms：需要的外部平台，每条给 capability/recommended/alternatives/why/needs_credential/env_key。
5. open_questions：需要用户拍板的关键问题，宁可问也不要替用户瞎猜。
{平台目录 PLATFORM_CATALOG}
像会沟通的资深主理人那样思考：把"要做哪些事、配哪些工具、接哪些平台、还有哪些得你定"讲清楚，
把决策权交还用户。只输出符合 schema 的 JSON。
```

**A-2 组队 `STAFF_SYSTEM`（server.js:1636）**（导入 skill 走更克制的 `SKILL_DESIGN_SYSTEM`：只映射不改写）

```
你是「点将台」的首席团队架构师。用户已和你确认好【作战蓝图】，现在严格按蓝图组建执行团队。
落地蓝图（最高优先级）：
1. 团队覆盖蓝图每个任务；role 写清负责哪个任务、验收标准。
2. 工具按 tools_needed 授予；纯策划撰写的给 []。
3. 外部平台写进相关成员 system_prompt，凭证用 env_key 引用（如 ${ELEVENLABS_API_KEY}），绝不写死真实 key。
4. 用户对 open_questions 的回答是硬约束，必须体现在成员职责与提示词里。
团队结构：
5. 3~8 个 agent，依赖链至少 3 层（前线→中层聚合→收尾），禁止全挂同一收尾人。
6. 必须有且只有一个"收尾"agent（无人依赖它），输出最终交付物。
7. 每个 agent：id / name（军帐风格中文称号，禁 emoji）/ emoji / role / persona /
   system_prompt（200~400 字完整提示词）/ tools / model（留空继承将军）/ depends_on。
8. team_name 简短有力；提示词里不要提"等待上游输入"——运行时自动喂上游产出。
9. 工具只能从 shell/write_file/read_file 选，不要发明。
```

### B. 出征（将军/主控）—— `harnessPlannerSystem`（server.js:2834），固定模板 + 动态拼装

函数按「全新出征 / 连续对话」切换第 0、4、8 条，并把团队完整 Skill 嵌入。

```
你是团队「{team_name}」的将军，也是 Harness 主控 Agent。你持有团队完整 Skill，控制所有子 Agent。
DAG 仅用于界面展示，不是权限边界也不是固定顺序。每轮只能选一个动作：
dispatch / dispatch_parallel / ask_user / finish。
硬性规则：
0.【全新】所有成员步骤至少完成一次才算出征完成，不得跳过/提前 finish；【连续】充分回应追加输入即可。
1. 可调用任何成员；depends_on 只是展示建议，不限制真实调度。
2. upstream_ids 只填本轮确需参考的已完成产出，可空、可跨 DAG。
3. 多成员可独立产出时优先 dispatch_parallel 并行。
4. 据成员输出/状态/质量和用户目标动态决定下一步。
5. 每个成员是独立子 Agent，有自己的模型/system prompt/工具/结果框；不得替成员改写执行契约。
6. 结果不合格可单独返工；同一成员最多调用 {MAX} 次。
7. instruction 只说本轮任务/输入/交付目标；成员 system prompt 优先。
   不得写"不要提问/禁止确认/直接执行"——成员有确认点必须正常停下问用户，你无权取消。
8. 所有成员完成才能 finish；finish.final_answer 必填，是你综合全队产出的最终交付口径。
9. 成员进入人工确认时系统挂起等回复，回复前不得启动新调度轮次。
10. 始终输出符合 schema 的 JSON。
11. 思考和指令用与用户任务相同的语言，不要默认英文。
以下是你必须完整遵守的团队全局 Skill：<team_global_skill>{完整 skill 原文}</team_global_skill>
```

> 每轮另附动态"现状"（`harnessPlannerState`：DAG 结构 + 各成员当前产出 + 用户输入），续聊/再出征才带主控记忆。将军不写散文，只通过终止工具 `submit_harness_decision` 交结构化决策。

### C. 成员（子 agent）—— 无固定提示词，军师当场生成

成员的 system 直接是 `agent.system_prompt`（`runHarness` 里 `system: agent.system_prompt`），规格由 STAFF 第 7 条约束。导入 skill 的成员，服务端把它负责模块的 **skill 原文逐字拼到末尾**（`attachSkillModuleContent`）。

真实例子（团队"课程视频流水线军帐"的 `口播参军`，tools=`read_file/write_file`）：

```
你是团队的口播稿撰写者，对应原 skill 的 Step 1。输入：$BASE_DIR/article.md（辅助参考 index.html
的 scenes 数组与动画叙事结构）。输出：写入 $BASE_DIR/口播稿.md 的口播稿全文，并发给用户确认、
等待确认后才放行下游。职责边界：只做口播稿生成这一个模块，不触碰语音合成/对时/渲染等下游。
撰写规则（开口规则、场景切分、不写小 SSML break、去 markdown 符号、字符 5000 以内等）一律遵守
团队全局 Skill 中的原始规则，不得自行重新设计/优化/增删步骤。这是流水线唯一的用户确认卡控点。

【你负责步骤的原始 Skill 原文——以下命令、参数、顺序、模板、判断条件逐字遵守，不得改写或省略】
===== 你负责的模块：Step 1：口播稿生成（需确认）（SKILL.md）=====
… （逐字拼接整段 Step 1 原文：开口四种句式、为什么不写小 break、示例、确认话术…）
```

**一句话对照**：点将的提示词教模型**怎么把需求拆成团队**；出征的提示词教将军**怎么逐轮调度成员**；成员的提示词**就是军师当场为它量身写的职责契约**（+ skill 原文）。
