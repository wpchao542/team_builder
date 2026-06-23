const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeSpec,
  harnessCandidates,
  validateHarnessDecision,
  normalizeDecisionAliases,
  nextMockHarnessDecision,
  harnessDecisionTool,
  HARNESS_DECISION_TOOL,
  buildTeamGlobalSkill,
  harnessRoundThinking,
  harnessDecisionThinking,
  extractSkillModules,
  formatSkillModuleOutline,
  computeSkillGlobalBase,
  normalizeBaseConfig,
  baseConfigEnv,
  detectConfirmationRequest,
  normalizeBlueprint,
  staffTeam,
  providerForModel,
  resolveModelSelection,
  stableModelId,
  codexModelArg,
  ollamaModelArg,
  codexEventData,
  detectWritePermissionRequest,
  isAffirmativeAnswer,
  applyConfigEnv,
  modelSupportsManagedTools,
  detectPseudoToolCallArtifacts,
  stripPseudoToolCallArtifacts,
  looksLikeCodexProcessText,
  buildBattleReport,
  injectTeamConventions,
  staleDownstreamMembers,
  orchestratorUserInputsFromEvents,
  mergeConversations,
  grantedRealTools,
  ensureMemberToolGrants,
  memberNeedsShell,
  requiredBinariesFor,
  applyTeamEvolution,
  extractArtifactPaths,
} = require("../server");

function branchSpec() {
  return {
    team_name: "分支测试",
    agents: [
      { id: "step-1", name: "步骤一", role: "准备输入", system_prompt: "准备输入", depends_on: [] },
      { id: "step-2", name: "步骤二", role: "输出路由参数", system_prompt: "输出路由参数", depends_on: ["step-1"] },
      { id: "step-3", name: "步骤三", role: "处理参数 1", system_prompt: "处理参数 1", depends_on: ["step-2"] },
      { id: "step-4", name: "步骤四", role: "处理参数 2", system_prompt: "处理参数 2", depends_on: ["step-2"] },
    ],
  };
}

test("旧团队配置统一归一为 Harness 执行", () => {
  const spec = normalizeSpec({ ...branchSpec(), orchestration: "dag" }, { preserveGraph: true });
  assert.equal(spec.orchestration, "harness");
});

test("默认授权：每个成员都补齐 read/write/shell（含纯创意，便于按需安装依赖）", () => {
  const m = { id: "x", name: "策划", role: "构思创意点子", system_prompt: "你只负责头脑风暴", tools: [] };
  const granted = grantedRealTools(m);
  assert.ok(granted.includes("read_file") && granted.includes("write_file"));
  assert.ok(granted.includes("shell")); // 每个成员都给 shell（安装依赖需要）
});

test("edit_file 精确替换、唯一匹配校验、新串特殊字符安全", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { TOOL_REGISTRY } = require("../server");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ats-edit-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha hello\nbeta hello\ngamma");
  // 不唯一 → 报错
  const dup = await TOOL_REGISTRY.edit_file.run({ path: "a.txt", old_string: "hello", new_string: "hi" }, { baseDir: dir });
  assert.equal(dup.ok, false);
  assert.match(dup.content, /不唯一|出现 2 次/);
  // 唯一替换 + new_string 含 $ 不被当正则
  const ok = await TOOL_REGISTRY.edit_file.run({ path: "a.txt", old_string: "alpha hello", new_string: "X $1 Y" }, { baseDir: dir });
  assert.equal(ok.ok, true);
  assert.match(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), /X \$1 Y/);
  // replace_all
  await TOOL_REGISTRY.edit_file.run({ path: "a.txt", old_string: "hello", new_string: "HI", replace_all: true }, { baseDir: dir });
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8").includes("hello"), false);
  // 找不到 → 报错
  const miss = await TOOL_REGISTRY.edit_file.run({ path: "a.txt", old_string: "不存在", new_string: "x" }, { baseDir: dir });
  assert.equal(miss.ok, false);
});

test("确定性映射：角色/提示词提到命令/ffmpeg 就补 shell", () => {
  assert.equal(memberNeedsShell({ role: "用 ffmpeg 合成视频", system_prompt: "" }), true);
  assert.equal(memberNeedsShell({ role: "渲帧", system_prompt: "用 puppeteer 逐帧渲染" }), true);
  assert.equal(memberNeedsShell({ role: "写文案", system_prompt: "只写口播稿" }), false);
  const m = { id: "r", name: "渲帧工兵", role: "用 ffmpeg 合成", system_prompt: "", tools: [] };
  assert.ok(grantedRealTools(m).includes("shell"));
});

test("ensureMemberToolGrants 把推断授权持久化进 member.tools", () => {
  const spec = { agents: [{ id: "a", role: "用 curl 调接口", system_prompt: "", tools: [] }] };
  ensureMemberToolGrants(spec);
  assert.ok(spec.agents[0].tools.includes("shell"));
  assert.ok(spec.agents[0].tools.includes("write_file"));
});

test("requiredBinariesFor 从 skill/提示词里识别要用的二进制", () => {
  const spec = { agents: [{ role: "用 ffmpeg 合成、curl 配音", system_prompt: "再用 whisper 对时" }] };
  const bins = requiredBinariesFor(spec);
  assert.ok(bins.includes("ffmpeg") && bins.includes("curl") && bins.includes("whisper"));
  assert.equal(bins.includes("magick"), false);
});

test("从成员产出里抽产物文件路径（给将军当指针）", () => {
  const out = "已完成。封面见 ![封面](cover_16x9.png)，视频 [成片](output-final.mp4)，口播稿写入 口播稿.md。参考 https://x.com/a 不算产物。";
  const files = extractArtifactPaths(out);
  assert.ok(files.includes("cover_16x9.png"));
  assert.ok(files.includes("output-final.mp4"));
  assert.ok(files.includes("口播稿.md"));
  assert.equal(files.some((f) => /^https?:/.test(f)), false); // 外链不算产物
});

test("团队进化：改成员契约 + 新建成员 + 全局演进记录，并重建全局 Skill", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true }); // 无 id → 不落盘
  const r = applyTeamEvolution(spec, {
    by: "将军",
    member_edits: [{ member_id: "step-1", system_prompt: "新契约X：只做一件事" }],
    new_members: [{ name: "新援", role: "支援", system_prompt: "我是新援，负责补位" }],
    note: "全员遵守新规则Z",
  });
  assert.ok(r.changes.length >= 3);
  assert.equal(spec.agents.find((a) => a.id === "step-1").system_prompt, "新契约X：只做一件事");
  assert.ok(spec.agents.some((a) => a.name === "新援"));
  assert.equal(spec.evolved, true);
  assert.match(spec.global_skill, /新契约X：只做一件事/); // 全局 skill 重建后含改后的成员契约
  assert.match(spec.global_skill, /全员遵守新规则Z/);       // 含演进记录
  // 无改动则不动
  const r2 = applyTeamEvolution(spec, { member_edits: [], new_members: [], summary: "", note: "" });
  assert.equal(r2.changes.length, 0);
});

test("normalizeSpec 保留团队 id（记忆/上下文按 id 隔离，防串台）", () => {
  const spec = normalizeSpec({ id: "team-abc", ...branchSpec() }, { preserveGraph: true });
  assert.equal(spec.id, "team-abc");
  const noId = normalizeSpec(branchSpec(), { preserveGraph: true });
  assert.equal("id" in noId, false); // 没 id 的不硬塞
});

test("调度成员时自动补齐它已产出的 DAG 依赖作为输入", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const member = spec.agents.find((a) => a.id === "step-3"); // depends_on step-2
  // 即使将军没在 upstream_ids 里写 step-2，只要它已产出，也要喂给成员
  const out = require("../server").buildHarnessMemberInput("任务", member, [], { "step-2": "路由结果X" }, "做你那步", "", {});
  assert.match(out, /step-2/);
  assert.match(out, /路由结果X/);
});

test("生成团队时把全局约定幂等注入每个成员", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  injectTeamConventions(spec);
  for (const a of spec.agents) assert.match(a.system_prompt, /团队全局约定/);
  const before = spec.agents.map((a) => a.system_prompt);
  injectTeamConventions(spec); // 再注入一次不应重复
  assert.deepEqual(spec.agents.map((a) => a.system_prompt), before);
});

test("上游晚于下游更新时标记下游为可能过时", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const outputs = { "step-1": "a", "step-2": "b", "step-3": "c" };
  // step-3 在 seq=3 产出，其上游 step-2 在 seq=4 又被重做 → step-3 过时
  const producedAt = { "step-1": 1, "step-2": 4, "step-3": 3 };
  const stale = staleDownstreamMembers(spec, outputs, producedAt);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].member_id, "step-3");
  assert.deepEqual(stale[0].updated_upstreams, ["step-2"]);
  // 若 step-2 未晚于 step-3，则无过时
  assert.equal(staleDownstreamMembers(spec, outputs, { "step-1": 1, "step-2": 2, "step-3": 3 }).length, 0);
});

test("用户对将军说的话按 msg_id 去重抽取并并入会话记忆", () => {
  const rec = {
    runId: "r1", endedAt: Date.now(),
    events: [
      { type: "user_msg", id: "__orchestrator__", msg_id: "m1", text: "先停吧", status: "processing" },
      { type: "user_msg", id: "__orchestrator__", msg_id: "m1", text: "先停吧", status: "processed" }, // 同一条
      { type: "user_msg", id: "step-2", msg_id: "m2", text: "改一下", status: "done" }, // 发给成员，不计入主控
    ],
  };
  const inputs = orchestratorUserInputsFromEvents(rec);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].text, "先停吧");
  const merged = mergeConversations([{ runId: "r0", text: "旧的" }], inputs);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, "先停吧"); // 新的在前
});

test("Harness 可调度任意成员，且只接收已完成成员的结果", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const outputs = { "step-1": "ready" };
  const candidates = harnessCandidates(spec, outputs);
  assert.deepEqual(candidates.map((item) => item.id), ["step-1", "step-2", "step-3", "step-4"]);

  const valid = validateHarnessDecision(spec, {
    action: "dispatch",
    member_id: "step-3",
    upstream_ids: ["step-1"],
    instruction: "主控决定跨过展示层级，直接执行步骤三",
  }, outputs);
  assert.equal(valid.ok, true);

  const invalid = validateHarnessDecision(spec, {
    action: "dispatch",
    member_id: "step-3",
    upstream_ids: ["step-2"],
    instruction: "使用尚未完成的结果",
  }, outputs);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /尚未完成/);
});

test("模型把动作字段嵌套进 {action,dispatch:{...}} 时能摊平并通过校验", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  // 真实事故：claude-code/opus 返回 { action:"dispatch", dispatch:{ member_id, instruction } }
  const nested = normalizeDecisionAliases({
    action: "dispatch",
    dispatch: { member_id: "step-1", instruction: "执行 Step 0 改写文章" },
  });
  assert.equal(nested.member_id, "step-1");
  assert.equal(nested.instruction, "执行 Step 0 改写文章");
  const checked = validateHarnessDecision(spec, nested, {});
  assert.equal(checked.ok, true);
  assert.equal(checked.member.id, "step-1");

  // 并行的嵌套数组形态：{ action:"dispatch_parallel", dispatch_parallel:[...] }
  const par = normalizeDecisionAliases({
    action: "dispatch_parallel",
    dispatch_parallel: [
      { member_id: "step-3", upstream_ids: ["step-2"], instruction: "并行 A" },
      { member_id: "step-4", upstream_ids: ["step-2"], instruction: "并行 B" },
    ],
  });
  assert.equal(par.parallel_calls.length, 2);
  const pchecked = validateHarnessDecision(spec, par, { "step-1": "x", "step-2": "y" });
  assert.equal(pchecked.ok, true);
});

test("Harness 支持独立成员并行执行和并行返工", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const outputs = { "step-2": "route ready", "step-3": "第一次结果不合格", "step-4": "第一次结果不合格" };
  const calls = { "step-3": 1, "step-4": 1 };
  const checked = validateHarnessDecision(spec, {
    action: "dispatch_parallel",
    parallel_calls: [
      {
        member_id: "step-3",
        upstream_ids: ["step-2"],
        instruction: "修正参数 1 分支的结果",
        reason: "第一次结果不符合验收标准",
      },
      {
        member_id: "step-4",
        upstream_ids: ["step-2"],
        instruction: "修正参数 2 分支的结果",
        reason: "第一次结果不符合验收标准",
      },
    ],
  }, outputs, calls);

  assert.equal(checked.ok, true);
  assert.equal(checked.action, "dispatch_parallel");
  assert.deepEqual(checked.calls.map((call) => call.member.id), ["step-3", "step-4"]);
});

test("Harness 不允许未完成全部成员时提前结束", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const checked = validateHarnessDecision(spec, {
    action: "finish",
    member_id: "",
    upstream_ids: [],
    instruction: "",
    reason: "局部结果已经够用",
    parallel_calls: [],
    final_member_id: "step-2",
    final_answer: "",
    question: "",
  }, { "step-1": "ready", "step-2": "route" });
  assert.equal(checked.ok, false);
  assert.match(checked.error, /默认要求跑完所有成员|未完成/);
});

test("Harness 用户在场操盘(userSteering)时允许将军提前收尾", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const decision = {
    action: "finish",
    member_id: "",
    upstream_ids: [],
    instruction: "",
    reason: "用户要求先停",
    parallel_calls: [],
    final_member_id: "step-2",
    final_answer: "已按用户要求在当前进度收尾",
    question: "",
  };
  // 没操盘：默认规则拒绝
  assert.equal(validateHarnessDecision(spec, decision, { "step-1": "ready", "step-2": "route" }).ok, false);
  // 用户操盘：默认规则让位，放行
  const steered = validateHarnessDecision(spec, decision, { "step-1": "ready", "step-2": "route" }, {}, { userSteering: true });
  assert.equal(steered.ok, true);
  assert.equal(steered.action, "finish");
});

test("Harness finish 必须由将军给出最终总结", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const outputs = {
    "step-1": "ready",
    "step-2": "route",
    "step-3": "branch 1",
    "step-4": "branch 2",
  };
  const missingSummary = validateHarnessDecision(spec, {
    action: "finish",
    member_id: "",
    upstream_ids: [],
    instruction: "",
    reason: "成员结果已齐",
    parallel_calls: [],
    final_member_id: "step-4",
    final_answer: "",
    question: "",
  }, outputs);
  assert.equal(missingSummary.ok, false);
  assert.match(missingSummary.error, /final_answer/);

  const withSummary = validateHarnessDecision(spec, {
    action: "finish",
    member_id: "",
    upstream_ids: [],
    instruction: "",
    reason: "成员结果已齐",
    parallel_calls: [],
    final_member_id: "step-4",
    final_answer: "将军综合四个步骤后的最终交付。",
    question: "",
  }, outputs);
  assert.equal(withSummary.ok, true);
  assert.equal(withSummary.finalAnswer, "将军综合四个步骤后的最终交付。");
});

test("将军调度通过 runHarness 终止工具提交决策", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const tool = harnessDecisionTool(spec);
  assert.equal(tool.name, HARNESS_DECISION_TOOL);
  assert.match(tool.description, /提交将军本轮唯一调度动作/);
  assert.equal(tool.schema.type, "object");
  assert.deepEqual(tool.schema.properties.action.enum, ["dispatch", "dispatch_parallel", "finish", "ask_user"]);
});

test("连续对话续跑允许将军围绕追加输入局部收尾", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const checked = validateHarnessDecision(spec, {
    action: "finish",
    member_id: "",
    upstream_ids: [],
    instruction: "",
    reason: "用户只是追问上一轮结论",
    parallel_calls: [],
    final_member_id: "",
    final_answer: "已结合历史记录回答用户追加问题。",
    question: "",
  }, {}, {}, { allowPartialFinish: true });
  assert.equal(checked.ok, true);
  assert.equal(checked.finalAnswer, "已结合历史记录回答用户追加问题。");
});

test("同一并行批次不能重复调用同一成员", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const repeated = {
    member_id: "step-3",
    upstream_ids: [],
    instruction: "执行",
    reason: "",
  };
  const checked = validateHarnessDecision(spec, {
    action: "dispatch_parallel",
    parallel_calls: [repeated, repeated],
  }, {});
  assert.equal(checked.ok, false);
  assert.match(checked.error, /不能重复调用/);
});

test("演示 Harness 会并行启动多个独立根成员", () => {
  const spec = normalizeSpec({
    team_name: "并行测试",
    agents: [
      { id: "research", name: "调研", role: "调研", system_prompt: "调研", depends_on: [] },
      { id: "design", name: "设计", role: "设计", system_prompt: "设计", depends_on: [] },
      { id: "merge", name: "汇总", role: "汇总", system_prompt: "汇总", depends_on: ["research", "design"] },
    ],
  }, { preserveGraph: true });
  const decision = nextMockHarnessDecision(spec, {}, {}, "");
  assert.equal(decision.action, "dispatch_parallel");
  assert.deepEqual(decision.parallel_calls.map((call) => call.member_id), ["research", "design"]);
});

test("Harness 将军会生成可见调度思考摘要", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const round = harnessRoundThinking(spec, { "step-1": "ready" }, { "step-1": 1 }, 1, "", []);
  // 主控不再喂“已完成/可调度”固定脚手架：只据用户输入与成员已产出结果决定下一步。
  assert.match(round, /产出|结果|下一步/);

  const checked = validateHarnessDecision(spec, {
    action: "dispatch",
    member_id: "step-2",
    upstream_ids: ["step-1"],
    instruction: "继续处理路由参数",
    reason: "步骤一已经完成",
  }, { "step-1": "ready" });
  assert.equal(checked.ok, true);
  const decision = harnessDecisionThinking(checked);
  assert.match(decision, /派出「步骤二」/);
  assert.match(decision, /步骤一已经完成/);
});

test("普通团队的全局 Skill 包含全部成员执行契约", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  assert.match(spec.global_skill, /准备输入/);
  assert.match(spec.global_skill, /输出路由参数/);
  assert.match(spec.global_skill, /处理参数 1/);
  assert.match(spec.global_skill, /处理参数 2/);
  assert.equal(spec.global_skill, buildTeamGlobalSkill(spec));
});

test("成员危险标只保留点将模型返回的结构化判断", () => {
  const spec = normalizeSpec({
    team_name: "风险测试",
    agents: [
      { id: "writer", name: "主笔", role: "生成稿件", system_prompt: "生成稿件，不删除任何文件", depends_on: [] },
      {
        id: "cleaner",
        name: "清障校尉",
        role: "清理旧产物",
        system_prompt: "按授权清理旧目录中的废弃文件",
        depends_on: ["writer"],
        risk: {
          level: "danger",
          summary: "会删除旧产物文件",
          operations: ["删除旧目录中的废弃文件"],
        },
      },
    ],
  }, { preserveGraph: true });
  assert.equal(spec.agents.find((agent) => agent.id === "writer").risk.level, "none");
  assert.deepEqual(spec.agents.find((agent) => agent.id === "cleaner").risk, {
    level: "danger",
    summary: "会删除旧产物文件",
    operations: ["删除旧目录中的废弃文件"],
  });
  assert.match(spec.global_skill, /危险标记：会删除旧产物文件/);
});

test("战损报表聚合团队与成员 token 和作战时长", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const rec = {
    runId: "run-report",
    status: "done",
    startedAt: 1000,
    endedAt: 7000,
    spec,
    events: [
      { type: "run_start", ts: 1000 },
      { type: "agent_metric", id: "__orchestrator__", ts: 1300, started_at: 1100, ended_at: 1300, usage: { input_tokens: 10, output_tokens: 5 } },
      { type: "member_call", to: "step-1", call_index: 1, instruction: "准备", ts: 1400 },
      { type: "agent_start", id: "step-1", call_index: 1, ts: 1500 },
      { type: "agent_metric", id: "step-1", call_index: 1, ts: 2500, started_at: 1600, ended_at: 2500, usage: { prompt_tokens: 20, completion_tokens: 30 } },
      { type: "agent_done", id: "step-1", call_index: 1, ts: 3000, usage: { input_tokens: 20, output_tokens: 30 }, result: "ready" },
      { type: "run_done", ts: 7000 },
    ],
  };
  const report = buildBattleReport(rec);
  assert.equal(report.duration_ms, 6000);
  assert.equal(report.usage.total_tokens, 65);
  const member = report.members.find((item) => item.id === "step-1");
  assert.equal(member.duration_ms, 1500);
  assert.equal(member.usage.total_tokens, 50);
  assert.equal(member.steps[0].instruction, "准备");
});

test("团队共用 Skill：拆分时把不属于任何成员的全局部分逐字提取出来", () => {
  const content = [
    "# 总则", "整体风格：极简。Design Tokens 必须照搬：--bg:#000。",
    "## Step 0：改写", "改写规则正文。",
    "## Step 1：渲染", "渲染规则正文。",
    "## 附录·共用注意事项", "全员都要注意的事。",
  ].join("\n");
  const sources = [{ name: "SKILL.md", content }];
  const modules = extractSkillModules(sources);
  // 假设只有 step-0 / step-1 被分给成员，其余（总则前导 + 附录）应进团队共用
  const assigned = new Set(modules.filter((m) => /Step\s*0|Step\s*1/i.test(m.title)).map((m) => m.id));
  const base = computeSkillGlobalBase(sources, modules, assigned);
  assert.match(base, /整体风格：极简/);          // 前导全局规则进了共用
  assert.match(base, /Design Tokens 必须照搬/);   // 关键全局约定没丢
  assert.doesNotMatch(base, /改写规则正文/);       // 已分给成员的步骤不重复进共用

  // normalizeSpec 要把 skill_global_base 原样保留
  const spec = normalizeSpec({ ...branchSpec(), skill_global_base: base }, { preserveGraph: true });
  assert.equal(spec.skill_global_base, base);
});

test("团队基础配置：归一 + 注入环境变量 + 写进全局 Skill", () => {
  const raw = [
    { key: "TARGET_RES", value: "1920x1080", desc: "分辨率" },
    { key: "VOICE_ID", value: "", desc: "音色（待定）" },
    { key: "TARGET_RES", value: "重复应被去重" },
  ];
  const norm = normalizeBaseConfig(raw);
  assert.equal(norm.length, 2);                        // 去重
  assert.equal(norm[0].value, "1920x1080");
  const env = baseConfigEnv(norm);
  assert.equal(env.TARGET_RES, "1920x1080");
  assert.ok(!("VOICE_ID" in env));                     // 空值不注入环境变量

  const spec = normalizeSpec({ ...branchSpec(), base_config: raw }, { preserveGraph: true });
  assert.equal(spec.base_config.length, 2);
  assert.match(spec.global_skill, /团队基础配置/);
  assert.match(spec.global_skill, /TARGET_RES = 1920x1080/);
});

test("导入团队的全局 Skill 保留全部原始文件原文", () => {
  const raw = {
    ...branchSpec(),
    skill_sources: [
      { name: "alpha/SKILL.md", content: "ALPHA_ORIGINAL_CONTENT" },
      { name: "beta/rules.md", content: "BETA_ORIGINAL_CONTENT" },
    ],
  };
  const spec = normalizeSpec(raw, { preserveGraph: true });
  assert.match(spec.global_skill, /ALPHA_ORIGINAL_CONTENT/);
  assert.match(spec.global_skill, /BETA_ORIGINAL_CONTENT/);
  assert.match(spec.global_skill, /全部成员定义/);
});

test("导入 skill 会按独立功能模块生成模块纲要而不是行号", () => {
  const modules = extractSkillModules([{
    name: "course-html/SKILL.md",
    content: [
      "# Course HTML",
      "",
      "## 功能模块：文章改写",
      "把输入文章改写成 article.md。",
      "",
      "### Step 1：生成画面脚本",
      "产出 scenes.json。",
      "",
      "#### 参数说明",
      "这是模块内部说明，不应成为按行切片。",
    ].join("\n"),
  }]);
  const titles = modules.map((m) => m.title);
  assert.ok(titles.includes("功能模块：文章改写"));
  assert.ok(titles.includes("Step 1：生成画面脚本"));
  const outline = formatSkillModuleOutline(modules);
  assert.match(outline, /course-html\/SKILL\.md \/ 功能模块：文章改写/);
  assert.doesNotMatch(outline, /第\s*\d+\s*行|line\s+\d+/i);
});

test("导入成员会保留负责的功能模块引用并写入全局 Skill", () => {
  const spec = normalizeSpec({
    team_name: "模块导入",
    skill_sources: [{ name: "SKILL.md", content: "## 功能模块：脚本\n原文" }],
    agents: [
      {
        id: "script",
        name: "脚本参军",
        role: "负责脚本模块",
        system_prompt: "只负责脚本模块，遵守团队全局 Skill。",
        module_refs: ["skill-md-功能模块-脚本"],
        depends_on: [],
      },
    ],
  }, { preserveGraph: true });
  assert.deepEqual(spec.agents[0].module_refs, ["skill-md-功能模块-脚本"]);
  assert.match(spec.global_skill, /功能模块：skill-md-功能模块-脚本/);
});

test("导入 skill 若模型返回空依赖，会按成员顺序补 DAG 展示链路", () => {
  const spec = normalizeSpec({
    team_name: "导入空图",
    skill_sources: [{ name: "SKILL.md", content: "A\nB\nC\n" }],
    agents: [
      { id: "late", name: "后段", role: "后段", system_prompt: "后段", depends_on: [] },
      { id: "early", name: "前段", role: "前段", system_prompt: "前段", depends_on: [] },
      { id: "mid", name: "中段", role: "中段", system_prompt: "中段", depends_on: [] },
    ],
  }, { preserveGraph: true });
  const deps = Object.fromEntries(spec.agents.map((agent) => [agent.id, agent.depends_on]));
  assert.deepEqual(deps.late, []);
  assert.deepEqual(deps.early, ["late"]);
  assert.deepEqual(deps.mid, ["early"]);
});

test("已有导入依赖不会被 DAG 兜底覆盖", () => {
  const spec = normalizeSpec({
    team_name: "已有图",
    skill_sources: [{ name: "SKILL.md", content: "A\nB\n" }],
    agents: [
      { id: "a", name: "A", role: "A", system_prompt: "A", depends_on: ["b"] },
      { id: "b", name: "B", role: "B", system_prompt: "B", depends_on: [] },
    ],
  }, { preserveGraph: true });
  assert.deepEqual(spec.agents.find((agent) => agent.id === "a").depends_on, ["b"]);
});

test("蓝图归一会过滤非法工具、保留任务验收标准与平台推荐", () => {
  const bp = normalizeBlueprint({
    goal: "做一条短视频",
    tasks: [
      { title: "写口播稿", detail: "产出口播稿.md", acceptance: "有完整逐字稿" },
      { title: "", detail: "" },
    ],
    tools_needed: [
      { tool: "write_file", why: "写稿" },
      { tool: "telepathy", why: "非法工具" },
    ],
    external_platforms: [
      { capability: "配音", recommended: "ElevenLabs", alternatives: ["MiniMax 语音"], why: "质量高", needs_credential: true, env_key: "ELEVENLABS_API_KEY" },
    ],
    open_questions: [{ question: "目标平台？", why: "影响产出形态" }, { question: "" }],
  });
  assert.equal(bp.tasks.length, 1);
  assert.equal(bp.tasks[0].acceptance, "有完整逐字稿");
  assert.deepEqual(bp.tools_needed.map((t) => t.tool), ["write_file"]);
  assert.equal(bp.external_platforms[0].recommended, "ElevenLabs");
  assert.equal(bp.open_questions.length, 1);
});

test("点兵会把确认蓝图写进团队，并把平台 env_key 落进 secrets", async () => {
  const blueprint = {
    goal: "演示目标",
    tasks: [{ title: "T1", detail: "做事", acceptance: "做对" }],
    tools_needed: [{ tool: "write_file", why: "写文件" }],
    external_platforms: [
      { capability: "配音", recommended: "ElevenLabs", alternatives: [], why: "好", needs_credential: true, env_key: "ELEVENLABS_API_KEY", value: "sk-should-move-to-secrets" },
    ],
    open_questions: [],
  };
  const spec = await staffTeam(blueprint, "演示", "", null);
  assert.ok(Array.isArray(spec.agents) && spec.agents.length >= 1);
  assert.equal(spec.secrets.ELEVENLABS_API_KEY, "sk-should-move-to-secrets");
  // 蓝图随团队保存，但真实 key 不留在 blueprint 里
  assert.equal(spec.blueprint.goal, "演示目标");
  assert.equal("value" in spec.blueprint.external_platforms[0], false);
  // 全局 Skill 注入了蓝图任务与验收标准，供 Harness 主控调度验收
  assert.match(spec.global_skill, /作战蓝图/);
  assert.match(spec.global_skill, /做对/);
});

test("演示 Harness 必须完成全部团队步骤", () => {
  const spec = normalizeSpec(branchSpec(), { preserveGraph: true });
  const outputs = {};
  const calls = {};
  const visited = [];
  let last = "";

  for (let round = 0; round < 8; round++) {
    const decision = nextMockHarnessDecision(spec, outputs, calls, last);
    if (decision.action === "finish") break;
    const batch = decision.action === "dispatch_parallel" ? decision.parallel_calls : [decision];
    for (const call of batch) {
      visited.push(call.member_id);
      outputs[call.member_id] = `output:${call.member_id}`;
      calls[call.member_id] = 1;
      last = call.member_id;
    }
  }

  assert.deepEqual(new Set(visited), new Set(["step-1", "step-2", "step-3", "step-4"]));
});

test("成员明确要求确认时会识别确认点，普通说明不会误暂停", () => {
  assert.equal(
    detectConfirmationRequest("口播稿原文如下。\n\n需要用户确认：请确认这版口播稿，确认后再进入配音。"),
    "需要用户确认：请确认这版口播稿，确认后再进入配音。"
  );
  assert.equal(
    detectConfirmationRequest("无需用户确认，完成后直接进入下一步。"),
    ""
  );
  assert.equal(
    detectConfirmationRequest("（确认后的新增输出）已收到用户确认，现在继续执行剩余交付。"),
    ""
  );
  assert.equal(
    detectConfirmationRequest("先完整输出草稿。\n<ask_user>是否采用当前标题？</ask_user>"),
    "是否采用当前标题？"
  );
});

test("Codex 订阅模型 ID 会路由到 Codex CLI 并正确提取模型名", () => {
  const ollamaQwenId = stableModelId("ollama", "qwen3.6");
  const bailianQwenId = stableModelId("bailian", "qwen3.6");
  assert.equal(providerForModel("codex"), "codex-cli");
  assert.equal(providerForModel("codex:gpt-5.5"), "codex-cli");
  assert.equal(providerForModel("codex-cli:gpt-5.4"), "codex-cli");
  assert.equal(providerForModel("openai-codex/gpt-5.5"), "codex-cli");
  assert.equal(providerForModel("glm-5.1:cloud", "ollama"), "ollama");
  assert.equal(providerForModel("qwen3.6", "ollama"), "ollama");
  assert.equal(providerForModel("qwen3.6", "bailian"), "bailian");
  assert.equal(providerForModel(ollamaQwenId, "bailian"), "ollama");
  assert.equal(providerForModel(bailianQwenId, "ollama"), "bailian");
  assert.equal(providerForModel("bailian:qwen-max"), "bailian");
  assert.deepEqual(
    (({ provider, model }) => ({ provider, model }))(resolveModelSelection(ollamaQwenId, "bailian")),
    { provider: "ollama", model: "qwen3.6" }
  );
  assert.equal(codexModelArg("codex:gpt-5.5"), "gpt-5.5");
  assert.equal(codexModelArg("openai-codex/gpt-5.4"), "gpt-5.4");
  assert.equal(ollamaModelArg(ollamaQwenId), "qwen3.6");
});

test("config.json 的空默认模型会覆盖启动环境里的旧 DEFAULT_MODEL", () => {
  const env = { DEFAULT_MODEL: "claude-code:opus", OLLAMA_MODEL: "minimax-m3:cloud" };
  applyConfigEnv({ DEFAULT_MODEL: "", OLLAMA_MODEL: "glm-5.1:cloud", ENABLE_CLAUDE_CODE: "1" }, env);
  assert.equal(env.DEFAULT_MODEL, "");
  assert.equal(env.OLLAMA_MODEL, "glm-5.1:cloud");
  assert.equal(env.ENABLE_CLAUDE_CODE, "1");
});

test("MiniMax 伪工具调用会被识别并清理", () => {
  // 新原则：shell/CLI 一律本机执行，ollama 模型（含 minimax）都走本地工具循环，不再兜底到 codex 沙箱；
  // 模型若吐伪 tool_call，由 runHarness 的防护识别并清理/停下。
  assert.equal(modelSupportsManagedTools("ollama", "minimax-m3:cloud"), true);
  assert.equal(modelSupportsManagedTools("ollama", "glm-5.1:cloud"), true);
  const noisy = "先输出 article.md。]<|minimax|><tool_call>\n]<|minimax|><tool_call>\n";
  assert.equal(detectPseudoToolCallArtifacts(noisy), true);
  assert.equal(stripPseudoToolCallArtifacts(noisy), "先输出 article.md。");
});

test("Codex JSONL 事件会保留最终原文并映射工具状态", () => {
  assert.deepEqual(
    codexEventData({ type: "item.completed", item: { type: "agent_message", text: "原始输出" } }),
    { kind: "message", text: "原始输出" }
  );
  assert.equal(looksLikeCodexProcessText("我会先读取本地 skill，确认 Step 0 的约束。"), true);
  assert.equal(looksLikeCodexProcessText("最终文件已生成：article.md"), false);
  assert.deepEqual(
    codexEventData({ type: "item.started", item: { type: "command_execution", command: "pwd" } }),
    { kind: "tool_call", tool: "shell", input: { command: "pwd" } }
  );
  assert.equal(
    codexEventData({ type: "turn.failed", error: { message: "真实错误" } }).text,
    "真实错误"
  );
});

test("CLI 成员遇到工作目录写入限制时会触发授权识别", () => {
  assert.match(
    detectWritePermissionRequest("受工作目录权限限制，我无法写入 runs/demo/稿件.md。"),
    /无法写入/
  );
  assert.match(
    detectWritePermissionRequest("The workspace is read-only, so I am not allowed to create the file."),
    /read-only/
  );
  assert.equal(detectWritePermissionRequest("无需确认，直接输出最终文案。"), "");
  assert.equal(isAffirmativeAnswer("授权"), true);
  assert.equal(isAffirmativeAnswer("不要"), false);
});
