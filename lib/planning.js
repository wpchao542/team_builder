// 将军（Harness 主控）的纯决策层：候选/校验/schema/mock/思考文案。
// 纯函数，不依赖运行时可变状态（不读记忆、不解析 provider、不用 clip）。

const { ORCH_ID, HARNESS_MAX_MEMBER_CALLS, HARNESS_MAX_PARALLEL, HARNESS_DECISION_TOOL, HARNESS_UPDATE_TEAM_TOOL } = require("./constants");

// Kahn 拓扑分层：返回 [[agent,...], [agent,...]] 的"梯队"，同梯队并行执行
function topoWaves(agents) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  for (const a of agents) {
    for (const d of a.depends_on) {
      if (!byId.has(d)) throw new Error(`agent "${a.id}" 依赖了不存在的 "${d}"`);
    }
  }
  const indeg = new Map(agents.map((a) => [a.id, a.depends_on.length]));
  const waves = [];
  let remaining = agents.length;
  while (remaining > 0) {
    const wave = agents.filter((a) => indeg.get(a.id) === 0);
    if (wave.length === 0) throw new Error("团队依赖关系存在循环，无法执行。");
    for (const a of wave) indeg.set(a.id, -1);
    for (const a of agents) {
      if (indeg.get(a.id) <= -1) continue;
      const hit = a.depends_on.filter((d) => wave.some((w) => w.id === d)).length;
      if (hit) indeg.set(a.id, indeg.get(a.id) - hit);
    }
    waves.push(wave);
    remaining -= wave.length;
  }
  return waves;
}

function hasHarnessOutput(outputs, id) {
  return Object.prototype.hasOwnProperty.call(outputs, id);
}

// 所有成员都由 Harness 主控直接调度；DAG 只提供结构与状态展示提示。
function harnessCandidates(spec, outputs, callCounts = {}) {
  return spec.agents
    .filter((agent) => (callCounts[agent.id] || 0) < HARNESS_MAX_MEMBER_CALLS)
    .map((agent) => {
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        tools: agent.tools || [],
        dag_upstreams: agent.depends_on,
        completed_dag_upstreams: agent.depends_on.filter((id) => hasHarnessOutput(outputs, id)),
        completed: hasHarnessOutput(outputs, agent.id),
        calls: callCounts[agent.id] || 0,
      };
    });
}

function missingHarnessMembers(spec, outputs) {
  return (spec.agents || []).filter((agent) => !hasHarnessOutput(outputs, agent.id));
}

function harnessMemberRef(agent) {
  if (!agent) return null;
  return { id: agent.id, name: agent.name || agent.id, emoji: agent.emoji || "" };
}

function harnessMemberRefs(agents) {
  return (agents || []).map(harnessMemberRef).filter(Boolean);
}

function completedHarnessMembers(spec, outputs) {
  return (spec.agents || []).filter((agent) => hasHarnessOutput(outputs, agent.id));
}

function validateHarnessCall(spec, call, outputs, callCounts = {}, options = {}) {
  const deferToUser = !!options.deferToUser;
  let memberId = String(call?.member_id || "").trim();
  // 兜底：模型有时把成员“名字”而非 id 填进 member_id —— 按名字解析回 id。
  if (memberId && !spec.agents.some((a) => a.id === memberId)) {
    const byName = spec.agents.find((a) => a.name === memberId);
    if (byName) { memberId = byName.id; call.member_id = byName.id; }
  }
  const member = spec.agents.find((agent) => agent.id === memberId);
  if (!member) {
    if (!memberId) return { ok: false, error: `这次 dispatch 没有给出 member_id（成员 id 为空）。请从团队成员列表里选一个真实存在的成员 id 填进 member_id 再 dispatch；不要留空。` };
    return { ok: false, error: `团队中不存在成员 "${memberId}"。请从团队成员列表里选一个真实的成员 id。` };
  }
  if (!deferToUser && (callCounts[memberId] || 0) >= HARNESS_MAX_MEMBER_CALLS) {
    return { ok: false, error: `成员 "${memberId}" 默认最多调用 ${HARNESS_MAX_MEMBER_CALLS} 次。若是用户要求再让它跑/返工，可继续；否则请换其他未完成成员，或用 ask_user 与用户确认是否还要重复调用它。` };
  }
  const upstreamIds = [...new Set(Array.isArray(call?.upstream_ids) ? call.upstream_ids.map(String) : [])];
  for (const upstreamId of upstreamIds) {
    if (upstreamId === memberId) return { ok: false, error: `成员 "${memberId}" 不能把自己的旧结果作为本轮上游。` };
    if (!spec.agents.some((agent) => agent.id === upstreamId)) {
      return { ok: false, error: `团队中不存在上游成员 "${upstreamId}"。` };
    }
    if (!hasHarnessOutput(outputs, upstreamId)) {
      return { ok: false, error: `上游 "${upstreamId}" 尚未完成。` };
    }
  }
  const instruction = String(call?.instruction || "").trim();
  if (!instruction) return { ok: false, error: `dispatch "${memberId}" 缺少 instruction。` };
  return {
    ok: true,
    member,
    upstreamIds,
    instruction,
    reason: String(call?.reason || "").trim(),
  };
}

// 容忍模型未严格遵守 schema 字段名（如 minimax 返回 target_member_id / ask_user_question 等同义变体）
function normalizeDecisionAliases(decision) {
  if (!decision || typeof decision !== "object") return decision;
  const alias = (to, ...froms) => { if (decision[to] == null || decision[to] === "") for (const f of froms) if (decision[f] != null && decision[f] !== "") { decision[to] = decision[f]; break; } };
  alias("member_id", "target_member_id", "memberId", "agent_id", "member");
  alias("question", "ask_user_question", "user_question");
  alias("final_member_id", "finish_final_member_id", "final_member", "finalMemberId");
  alias("final_answer", "finish_final_answer", "finalAnswer");
  alias("parallel_calls", "parallelCalls", "calls");
  if (Array.isArray(decision.parallel_calls)) {
    for (const c of decision.parallel_calls) {
      if (c && typeof c === "object" && (c.member_id == null || c.member_id === "")) {
        c.member_id = c.target_member_id || c.memberId || c.agent_id || c.member || c.member_id;
      }
    }
  }
  return decision;
}

function validateHarnessDecision(spec, decision, outputs, callCounts = {}, options = {}) {
  const allowPartialFinish = !!options.allowPartialFinish;
  const userSteering = !!options.userSteering;
  // 总规矩：用户在场操盘（本轮有实时指令）或已允许提前收尾时，团队的“策略性硬规则”
  //（必须跑完所有成员 / 调用次数上限）让位于用户指令；结构性正确性（合法成员、必填字段）仍校验。
  const deferToUser = allowPartialFinish || userSteering;
  if (!decision || typeof decision !== "object") return { ok: false, error: "调度结果不是对象。" };
  if (decision.action === "ask_user") {
    const question = String(decision.question || "").trim();
    return question ? { ok: true, action: "ask_user", question } : { ok: false, error: "ask_user 缺少 question。" };
  }
  if (decision.action === "finish") {
    if (!deferToUser && Object.keys(outputs).length === 0) return { ok: false, error: "还没有执行任何成员，默认不结束。若这是用户要求的，请在确认用户意图后再 finish；拿不准就用 ask_user 让用户拍板。" };
    const missing = deferToUser ? [] : missingHarnessMembers(spec, outputs);
    if (!deferToUser && missing.length) {
      return {
        ok: false,
        error: `默认要求跑完所有成员才收尾，当前未完成：${missing.map((agent) => agent.name || agent.id).join("、")}。若用户没有要求停止，请改为 dispatch（或 dispatch_parallel）继续推进这些成员；若用户已要求停止/提前收尾，或你判断该破例，按用户指令 finish；拿不准就用 ask_user 把"是否现在收尾"交给用户决定。`,
      };
    }
    const finalMemberId = String(decision.final_member_id || "").trim();
    if (finalMemberId && !hasHarnessOutput(outputs, finalMemberId)) {
      return { ok: false, error: `final_member_id "${finalMemberId}" 尚未执行。` };
    }
    const finalAnswer = String(decision.final_answer || "").trim();
    if (!finalAnswer) return { ok: false, error: "finish 必须提供 final_answer，作为将军对全队产出的最终总结与交付。" };
    return { ok: true, action: "finish", finalMemberId, finalAnswer };
  }
  if (decision.action === "dispatch_parallel") {
    const rawCalls = Array.isArray(decision.parallel_calls) ? decision.parallel_calls : [];
    if (rawCalls.length < 2) return { ok: false, error: "dispatch_parallel 至少需要两个成员。" };
    if (rawCalls.length > HARNESS_MAX_PARALLEL) {
      return { ok: false, error: `单个并行批次最多 ${HARNESS_MAX_PARALLEL} 个成员。` };
    }
    const seen = new Set();
    const calls = [];
    for (const rawCall of rawCalls) {
      const checked = validateHarnessCall(spec, rawCall, outputs, callCounts, { deferToUser });
      if (!checked.ok) return checked;
      if (seen.has(checked.member.id)) {
        return { ok: false, error: `同一并行批次不能重复调用成员 "${checked.member.id}"。` };
      }
      seen.add(checked.member.id);
      calls.push(checked);
    }
    return { ok: true, action: "dispatch_parallel", calls };
  }
  if (decision.action !== "dispatch") return { ok: false, error: `未知 action：${String(decision.action)}` };
  const call = validateHarnessCall(spec, decision, outputs, callCounts, { deferToUser });
  if (!call.ok) return call;
  return {
    ...call,
    action: "dispatch",
  };
}

function harnessDecisionSchema(spec) {
  const ids = spec.agents.map((agent) => agent.id);
  const callSchema = {
    type: "object",
    additionalProperties: false,
    required: ["member_id", "upstream_ids", "instruction", "reason"],
    properties: {
      member_id: { type: "string", enum: ids },
      upstream_ids: { type: "array", items: { type: "string", enum: ids } },
      instruction: { type: "string" },
      reason: { type: "string" },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "member_id", "upstream_ids", "instruction", "reason", "parallel_calls", "final_member_id", "final_answer", "question"],
    properties: {
      action: { type: "string", enum: ["dispatch", "dispatch_parallel", "finish", "ask_user"] },
      member_id: { type: "string", enum: ["", ...ids] },
      upstream_ids: { type: "array", items: { type: "string", enum: ids } },
      instruction: { type: "string" },
      reason: { type: "string" },
      parallel_calls: {
        type: "array",
        minItems: 0,
        maxItems: HARNESS_MAX_PARALLEL,
        items: callSchema,
      },
      final_member_id: { type: "string", enum: ["", ...ids] },
      final_answer: { type: "string" },
      question: { type: "string" },
    },
  };
}

// 找出"上游比下游更晚产出"的成员——它们的输入在自己跑完后被更新过，产出可能已过时。
function staleDownstreamMembers(spec, outputs, producedAt = {}) {
  const depMap = new Map((spec.agents || []).map((a) => [a.id, Array.isArray(a.depends_on) ? a.depends_on : []]));
  const ancestorsOf = (id, seen = new Set()) => {
    for (const up of depMap.get(id) || []) {
      if (seen.has(up)) continue;
      seen.add(up);
      ancestorsOf(up, seen);
    }
    return seen;
  };
  const stale = [];
  for (const a of spec.agents || []) {
    if (!hasHarnessOutput(outputs, a.id)) continue;
    const myAt = producedAt[a.id] || 0;
    const newer = [...ancestorsOf(a.id)].filter((up) => hasHarnessOutput(outputs, up) && (producedAt[up] || 0) > myAt);
    if (newer.length) stale.push({ member_id: a.id, name: a.name, updated_upstreams: newer });
  }
  return stale;
}

// 从成员产出文本里抽出"产物文件路径"（markdown 链接/图片/媒体 + 裸文件名.扩展名），给将军当指针用。
function extractArtifactPaths(text) {
  const s = String(text || "");
  const found = new Set();
  for (const m of s.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) found.add(m[1]);
  for (const m of s.matchAll(/(?:^|[\s`"'(（])([\w./一-龥-]+\.(?:html?|md|mp3|mp4|wav|m4a|mov|webm|png|jpe?g|gif|svg|webp|json|js|css|py|sh|srt|txt|pdf|csv|xml|yaml|yml))(?=[\s`"')）.,，。、!！?？:：]|$)/gi)) found.add(m[1]);
  return [...found].filter((p) => !/^https?:/i.test(p) && p.length < 200).slice(0, 15);
}

function harnessDecisionTool(spec) {
  return {
    name: HARNESS_DECISION_TOOL,
    description: "提交将军本轮唯一调度动作。必须通过这个工具提交 dispatch / dispatch_parallel / ask_user / finish，不要用普通文本回答。",
    schema: harnessDecisionSchema(spec),
    run: () => ({ ok: true, content: "已提交将军调度决策" }),
  };
}

function updateTeamTool(spec) {
  const ids = (spec.agents || []).map((a) => a.id);
  return {
    name: HARNESS_UPDATE_TEAM_TOOL,
    description: "让团队【长期进化】（不是一次性产出）。当用户的反馈意味着团队的做法/分工要固化改变时调用：可改成员的执行契约(member_edits)、新建成员(new_members)、改团队目标(summary)、追加全员遵守的全局补充规则(note)。系统会自动重建全局 Skill 并保存团队。改完后你仍要正常提交本轮调度决策（通常接着派受影响的成员去重做）。一次性的小调整不要用它。",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        member_edits: {
          type: "array",
          description: "要改写执行契约的现有成员",
          items: {
            type: "object", additionalProperties: false, required: ["member_id", "system_prompt"],
            properties: { member_id: { type: "string", enum: ids }, system_prompt: { type: "string", description: "该成员新的完整执行契约" } },
          },
        },
        new_members: {
          type: "array",
          description: "要新建的成员（按需）",
          items: {
            type: "object", additionalProperties: false, required: ["name", "role", "system_prompt"],
            properties: { name: { type: "string" }, role: { type: "string" }, system_prompt: { type: "string" }, depends_on: { type: "array", items: { type: "string" } } },
          },
        },
        summary: { type: "string", description: "可选：新的团队目标/简介" },
        note: { type: "string", description: "可选：要全员长期遵守的全局补充规则（追加进全局 Skill 演进记录）" },
      },
      required: ["member_edits", "new_members", "summary", "note"],
    },
    run: (args, toolCtx) => {
      const r = applyTeamEvolution(toolCtx.spec, { by: "将军", member_edits: args.member_edits, new_members: args.new_members, summary: args.summary, note: args.note });
      if (!r.changes.length) return { ok: false, content: "没有有效改动。" };
      toolCtx.send?.({ type: "skill_evolved", by: ORCH_ID, changes: r.changes, saved: !!r.saved });
      return { ok: true, content: `团队已进化：${r.changes.join("、")}${r.saved ? "，已保存。" : "。"}现在请继续提交本轮调度决策（如让受影响成员重做）。` };
    },
  };
}

function nextMockHarnessDecision(spec, outputs, callCounts, lastMemberId, options = {}) {
  if (options.allowPartialFinish) {
    const target = options.target && spec.agents.find((agent) => agent.id === options.target);
    if (target && !hasHarnessOutput(outputs, target.id) && (callCounts[target.id] || 0) < HARNESS_MAX_MEMBER_CALLS) {
      return {
        action: "dispatch", member_id: target.id, upstream_ids: [],
        instruction: "根据用户在思考对话框里的追加输入继续处理这一轮对话。",
        reason: "连续对话指向该成员，演示模式优先让目标成员接续。",
        parallel_calls: [], final_member_id: "", final_answer: "", question: "",
      };
    }
    const doneIds = Object.keys(outputs);
    const finalId = doneIds[doneIds.length - 1] || "";
    return {
      action: "finish", member_id: "", upstream_ids: [], instruction: "",
      reason: "连续对话追加输入已处理，可以局部完成。",
      final_member_id: finalId,
      final_answer: finalId
        ? `演示模式：将军已结合「${spec.agents.find((agent) => agent.id === finalId)?.name || finalId}」的最新输出完成续聊回应。\n\n${outputs[finalId]}`
        : "演示模式：已收到用户追加输入，并由将军完成续聊回应。",
      parallel_calls: [], question: "",
    };
  }
  const remaining = spec.agents.filter((agent) => !hasHarnessOutput(outputs, agent.id));
  if (remaining.length) {
    const ready = remaining.filter((agent) => agent.depends_on.every((id) => hasHarnessOutput(outputs, id)));
    const picks = ready.length ? ready : remaining;
    if (picks.length > 1) return {
      action: "dispatch_parallel", member_id: "", upstream_ids: [], instruction: "", reason: "",
      parallel_calls: picks.slice(0, HARNESS_MAX_PARALLEL).map((agent) => ({
        member_id: agent.id,
        upstream_ids: agent.depends_on.filter((id) => hasHarnessOutput(outputs, id)),
        instruction: `完成团队步骤：${agent.role}`,
        reason: "团队必须完成所有成员步骤，当前成员已可调度。",
      })),
      final_member_id: "", final_answer: "", question: "",
    };
    const next = picks[0];
    return {
      action: "dispatch", member_id: next.id,
      upstream_ids: next.depends_on.filter((id) => hasHarnessOutput(outputs, id)),
      instruction: `完成团队步骤：${next.role}`, reason: "团队必须完成所有成员步骤，继续调度未完成成员。",
      parallel_calls: [], final_member_id: "", final_answer: "", question: "",
    };
  }
  return {
    action: "finish", member_id: "", upstream_ids: [], instruction: "",
    reason: "团队所有成员步骤均已完成。", final_member_id: lastMemberId || spec.agents[spec.agents.length - 1]?.id || "",
    parallel_calls: [],
    final_answer: hasHarnessOutput(outputs, lastMemberId)
      ? `演示运行完成。将军已综合全队产出，最终交付如下：\n\n${outputs[lastMemberId]}`
      : "演示运行完成。",
    question: "",
  };
}

function sendHarnessThinking(send, text) {
  const body = String(text || "").trim();
  if (!body) return;
  send({ type: "agent_thinking", id: ORCH_ID, text: body + "\n\n" });
}

// 把将军模型【自己写的】调度理由作为它的思考输出（不是系统模板文案）。
// 当模型本身不流式吐 thinking 时，至少把它对每步选择的 reason 呈现出来。
function harnessModelReasoning(decision) {
  if (!decision) return "";
  if (decision.action === "dispatch") {
    return String(decision.reason || decision.instruction || "").trim();
  }
  if (decision.action === "dispatch_parallel") {
    return (decision.calls || [])
      .map((c) => String(c.reason || c.instruction || "").trim())
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function harnessRoundThinking(spec, outputs, callCounts, round, validationError, userDirectives = []) {
  const completed = (spec.agents || [])
    .filter((agent) => hasHarnessOutput(outputs, agent.id))
    .map((agent) => agent.name || agent.id);
  const candidates = harnessCandidates(spec, outputs, callCounts)
    .map((agent) => agent.name || agent.id);
  const lines = [
    `第 ${Number(round || 0) + 1} 轮：将军读取用户输入与各成员已产出的结果，判断 DAG 下一步该让谁干、还是收尾。`,
    `已完成：${completed.length ? completed.join("、") : "暂无"}`,
    `可调度：${candidates.length ? candidates.join("、") : "暂无"}`,
  ];
  if (validationError) lines.push("上一步调度被拒绝，本轮据原因修正。");
  if (userDirectives.length) lines.push(`收到用户实时指令：${userDirectives.slice(-3).join("；")}`);
  return lines.join("\n");
}

function harnessDecisionThinking(decision) {
  if (!decision || !decision.action) return "";
  if (decision.action === "dispatch") {
    return [
      `决策：派出「${decision.member?.name || decision.member_id}」。`,
      `任务：${decision.instruction || "按成员职责执行本轮任务"}`,
      decision.reason ? `原因：${decision.reason}` : "",
    ].filter(Boolean).join("\n");
  }
  if (decision.action === "dispatch_parallel") {
    const calls = decision.calls || [];
    return [
      `决策：并行派出 ${calls.length} 名成员。`,
      calls.map((call, i) => `${i + 1}. ${call.member?.name || call.member_id}：${call.instruction || "按职责执行"}${call.reason ? `（${call.reason}）` : ""}`).join("\n"),
    ].join("\n");
  }
  if (decision.action === "ask_user") {
    return `决策：需要用户介入确认。\n问题：${decision.question || ""}`;
  }
  if (decision.action === "finish") {
    return decision.finalMemberId
      ? `决策：交付已经完成，由将军综合全队产出；主要参考「${decision.finalMemberId}」的结果形成最终总结。`
      : "决策：交付已经完成，由将军汇总最终答案。";
  }
  return `决策：${decision.action}`;
}

module.exports = {
  topoWaves, hasHarnessOutput, harnessCandidates, missingHarnessMembers, harnessMemberRef, harnessMemberRefs, completedHarnessMembers, validateHarnessCall, normalizeDecisionAliases, validateHarnessDecision, harnessDecisionSchema, harnessDecisionTool, updateTeamTool, staleDownstreamMembers, extractArtifactPaths, nextMockHarnessDecision, sendHarnessThinking, harnessModelReasoning, harnessRoundThinking, harnessDecisionThinking,
};
