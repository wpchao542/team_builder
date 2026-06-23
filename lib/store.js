// 持久化与运行存储：团队 / 记忆 / 出征记录（落本地 JSON）＋ 内存 runs Map。
// 仅依赖 fs/path/crypto + 纯工具(clip) + 纯函数(skills)；不碰 provider/harness 等运行时状态。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { clip, finiteTokenNumber, normalizeUsage, addUsageTotals } = require("./util");
const { ORCH_ID } = require("./constants");
const { normalizeSpec, inferTeamOrigin } = require("./skills");

// 数据目录锚定到项目根（本文件在 lib/ 下）
const ROOT = path.join(__dirname, "..");
const TEAMS_DIR = path.join(ROOT, "teams");
const RUNS_DIR = path.join(ROOT, "runs");
const MEMORIES_DIR = path.join(ROOT, "memory");
if (!fs.existsSync(TEAMS_DIR)) fs.mkdirSync(TEAMS_DIR);
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR);
if (!fs.existsSync(MEMORIES_DIR)) fs.mkdirSync(MEMORIES_DIR);
const runs = new Map(); // runId -> 运行记录（内存权威，落盘到 runs/<id>/record.json）

function safeMemoryId(specOrId) {
  if (typeof specOrId === "string") {
    const safe = specOrId.replace(/[^a-z0-9-]/g, "");
    return safe || "team-" + crypto.createHash("sha1").update(specOrId).digest("hex").slice(0, 10);
  }
  const spec = specOrId || {};
  // 记忆按【出征实例】隔离：运行时把 mem_scope 设为本次出征线的 runId，不同出征互不读写；
  // 同一出征的续聊/再战复用同一 runId（startRun 传 opts.runId=old.runId）→ 共享同一记忆线。
  // 没有 mem_scope（如脱离出征的直接调用）才退回团队级 id。
  const raw = spec.mem_scope || spec.id || `${spec.team_name || "team"}:${spec.global_skill || ""}`;
  const safe = String(raw).replace(/[^a-z0-9-]/g, "");
  return safe || "team-" + crypto.createHash("sha1").update(String(raw)).digest("hex").slice(0, 10);
}

function teamMemoryPath(specOrId) {
  return path.join(MEMORIES_DIR, safeMemoryId(specOrId) + ".json");
}

function emptyTeamMemory(spec) {
  return {
    version: 1,
    teamId: spec?.id || "",
    teamName: spec?.team_name || "无名战队",
    emoji: spec?.emoji || "⚔",
    summary: "",
    facts: [],
    agentOutputs: {},
    conversations: [], // 用户在历次出征中对将军说过的话（续聊/再出征时回灌给将军）
    runs: [],
    updatedAt: null,
  };
}

// 从一次运行的事件里抽出"用户对将军说的话"（user_msg 事件，按 msg_id 去重）。
function orchestratorUserInputsFromEvents(rec) {
  const seen = new Set();
  const out = [];
  const at = new Date(rec?.endedAt || Date.now()).toISOString();
  for (const ev of rec?.events || []) {
    if (ev.type !== "user_msg") continue;
    if (ev.id !== ORCH_ID) continue; // 发给成员的话进各自的成员记忆，不进主控
    const key = ev.msg_id || ev.text;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const text = String(ev.text || "").trim();
    if (text) out.push({ at, runId: rec.runId, text: clip(text, 600) });
  }
  return out;
}

function mergeConversations(prev, additions, max = 60) {
  const list = Array.isArray(prev) ? [...prev] : [];
  for (const a of additions) {
    if (!list.some((x) => x.runId === a.runId && x.text === a.text)) list.unshift(a);
  }
  return list.slice(0, max);
}

function readTeamMemory(spec) {
  try {
    const p = teamMemoryPath(spec);
    if (fs.existsSync(p)) return { ...emptyTeamMemory(spec), ...JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch {}
  return emptyTeamMemory(spec);
}

function writeTeamMemory(spec, memory) {
  const next = { ...emptyTeamMemory(spec), ...(memory || {}), updatedAt: new Date().toISOString() };
  fs.writeFileSync(teamMemoryPath(spec), JSON.stringify(next, null, 2));
  return next;
}

// ---------- 成员私有记忆（仿 Claude Code 子 agent：各自独立，主控永不看）----------
function memberMemoryPath(spec, agentId) {
  const aid = String(agentId || "").replace(/[^a-zA-Z0-9_-]/g, "") || "member";
  return path.join(MEMORIES_DIR, safeMemoryId(spec), "members", aid + ".json");
}

function emptyMemberMemory(spec, agentId) {
  const a = (spec?.agents || []).find((x) => x.id === agentId);
  return { version: 1, teamId: spec?.id || "", agentId, agentName: a?.name || agentId, summary: "", io: [], conversations: [], updatedAt: null };
}

function readMemberMemory(spec, agentId) {
  try {
    const p = memberMemoryPath(spec, agentId);
    if (fs.existsSync(p)) return { ...emptyMemberMemory(spec, agentId), ...JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch {}
  return emptyMemberMemory(spec, agentId);
}

function writeMemberMemory(spec, agentId, mem) {
  const p = memberMemoryPath(spec, agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const next = { ...emptyMemberMemory(spec, agentId), ...(mem || {}), updatedAt: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

// 喂给成员的“它自己的记忆”文本（只含它自己的历史 IO 与你跟它的对话，不含别人、不含主控）
function formatMemberMemoryForPrompt(mem) {
  if (!mem || (!mem.io?.length && !mem.conversations?.length && !mem.summary)) return "";
  const io = (mem.io || []).slice(-4).map((x, i) =>
    `${i + 1}. [${x.at || ""}] 指令：${clip(x.instruction || "", 300)}\n   产出：${clip(x.output || "", 800)}`).join("\n");
  const convo = (mem.conversations || []).slice(-6).map((c) => `· 你说：${clip(c.userText || "", 200)}${c.reply ? `\n  它答：${clip(c.reply, 300)}` : ""}`).join("\n");
  return `# 你（本成员）自己的记忆（仅你自己的历史，主控看不到）\n` +
    (mem.summary ? `要点：${mem.summary}\n` : "") +
    (io ? `\n近期被调用的输入/产出：\n${io}\n` : "") +
    (convo ? `\n你与用户的直接对话：\n${convo}\n` : "");
}

function runAgentOutputsFromEvents(rec) {
  const agentIds = new Set((rec.spec?.agents || []).map((agent) => agent.id));
  const out = {};
  for (const ev of rec.events || []) {
    if (ev.type === "agent_done" && agentIds.has(ev.id)) out[ev.id] = String(ev.result || "");
  }
  return out;
}

function runCompletedMemberIds(rec) {
  return Object.keys(runAgentOutputsFromEvents(rec));
}

function runCompletedMemberRefs(rec) {
  const done = new Set(runCompletedMemberIds(rec));
  return harnessMemberRefs((rec.spec?.agents || []).filter((agent) => done.has(agent.id)));
}

function runMissingMembersFromEvents(rec) {
  const done = new Set(runCompletedMemberIds(rec));
  return (rec.spec?.agents || []).filter((agent) => !done.has(agent.id));
}

function updateTeamMemoryFromRunRecord(rec) {
  if (!rec?.spec) return null;
  const memory = readTeamMemory(rec.spec);
  const outputs = runAgentOutputsFromEvents(rec);
  const completedIds = Object.keys(outputs);
  const errors = (rec.events || []).filter((ev) => ev.type === "error").map((ev) => ev.message || "未知错误");
  for (const [id, output] of Object.entries(outputs)) {
    const agent = rec.spec.agents.find((item) => item.id === id);
    memory.agentOutputs[id] = {
      agentId: id,
      agentName: agent?.name || id,
      updatedAt: new Date().toISOString(),
      lastRunId: rec.runId,
      output: clip(output, 4000),
    };
  }
  const item = {
    runId: rec.runId,
    sourceRunId: rec.sourceRunId || "",
    status: rec.status,
    task: rec.task,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    completedMembers: completedIds,
    missingMembers: runMissingMembersFromEvents(rec).map((agent) => agent.id),
    errors,
  };
  memory.runs = [item, ...(memory.runs || []).filter((run) => run.runId !== rec.runId)].slice(0, 30);
  const fact = `${new Date(rec.endedAt || Date.now()).toISOString()} · ${rec.status} · ${rec.task || ""} · 完成 ${completedIds.length}/${rec.spec.agents.length}`;
  memory.facts = [fact, ...(memory.facts || []).filter((x) => x !== fact)].slice(0, 80);
  memory.summary = `最近一次出征：${rec.status}，完成 ${completedIds.length}/${rec.spec.agents.length} 个步骤。`;
  memory.conversations = mergeConversations(memory.conversations, orchestratorUserInputsFromEvents(rec)); // 用户对将军说过的话
  writeMemberMemoriesFromRunRecord(rec); // 各成员的私有记忆（io + 与用户对话），主控记忆里不含
  return writeTeamMemory(rec.spec, memory);
}

// 从一次运行重建“各成员私有记忆”：它收到的指令/产出 + 你跟它的直接对话。主控记忆不含这些。
function writeMemberMemoriesFromRunRecord(rec) {
  if (!rec?.spec?.agents) return;
  const at = new Date(rec.endedAt || Date.now()).toISOString();
  const lastInstr = {}, userConvos = {};
  for (const ev of rec.events || []) {
    if (ev.type === "member_call" && ev.to) {
      lastInstr[ev.to] = ev.instruction || "";
      if (/用户直接给该成员发了消息/.test(ev.reason || "")) (userConvos[ev.to] = userConvos[ev.to] || []).push(ev.instruction || "");
    }
  }
  const outputs = runAgentOutputsFromEvents(rec);
  for (const agent of rec.spec.agents) {
    const id = agent.id;
    const produced = outputs[id];
    const convos = userConvos[id] || [];
    if (produced == null && !convos.length) continue; // 本次没动过的成员不写
    const mem = readMemberMemory(rec.spec, id);
    if (produced != null) {
      mem.io = [{ at, runId: rec.runId, instruction: clip(lastInstr[id] || "", 500), output: clip(produced, 2000) }, ...(mem.io || [])].slice(0, 20);
      mem.summary = `最近一次产出：${clip(produced, 80)}`;
    }
    for (const userText of convos) {
      mem.conversations = [{ at, userText: clip(userText, 400), reply: clip(produced || "", 600) }, ...(mem.conversations || [])].slice(0, 40);
    }
    writeMemberMemory(rec.spec, id, mem);
  }
}

function memorySnapshotForContinuation(old, spec) {
  const memory = readTeamMemory(spec);
  if (!memory.agentOutputs || typeof memory.agentOutputs !== "object") memory.agentOutputs = {};
  if (!Array.isArray(memory.runs)) memory.runs = [];
  const outputs = runAgentOutputsFromEvents(old);
  const completedIds = Object.keys(outputs);
  for (const [id, output] of Object.entries(outputs)) {
    const agent = (spec.agents || []).find((item) => item.id === id);
    memory.agentOutputs[id] = {
      agentId: id,
      agentName: agent?.name || id,
      updatedAt: new Date(old.endedAt || Date.now()).toISOString(),
      lastRunId: old.runId,
      output: clip(output, 4000),
    };
  }
  const errors = (old.events || []).filter((ev) => ev.type === "error").map((ev) => ev.message || "未知错误");
  const item = {
    runId: old.runId,
    sourceRunId: old.sourceRunId || "",
    status: old.status,
    task: old.task,
    startedAt: old.startedAt,
    endedAt: old.endedAt,
    completedMembers: completedIds,
    missingMembers: runMissingMembersFromEvents({ ...old, spec }).map((agent) => agent.id),
    errors,
  };
  memory.runs = [item, ...(memory.runs || []).filter((run) => run.runId !== old.runId)].slice(0, 30);
  memory.summary = `连续对话基于上一次出征：${old.status}，完成 ${completedIds.length}/${(spec.agents || []).length} 个步骤。`;
  memory.conversations = mergeConversations(memory.conversations, orchestratorUserInputsFromEvents(old)); // 带上历史里用户对将军说过的话
  return memory;
}

function buildContinuationTask(old, spec, target, text) {
  // 精简：原始任务、各成员产出、运行状态都已作为【上下文/记忆 + "各成员当前产出"】内部带给将军，
  // 这里不再重复罗列——只把用户这次的追加输入交给它，接着上一次继续即可（加载是内部的事）。
  return `# 连续对话（接着上一次出征继续）
用户在${agentLabelForDirective(spec, target)}的对话框追加输入：
${String(text || "").trim()}

上一次的原始任务、各成员产出与运行状态都已作为上下文/记忆载入（见下方"各成员当前产出"与团队记忆），不必重新罗列或复述。请把用户这条追加输入作为最高优先级，接着上一次继续：需要某成员返工/接续就调度它，只需直接回答就汇总回应。`;
}

function runRecordPath(runId) { return path.join(RUNS_DIR, String(runId).replace(/[^a-zA-Z0-9_-]/g, ""), "record.json"); }

function persistRun(rec) {
  try {
    const p = runRecordPath(rec.runId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      runId: rec.runId, teamId: rec.teamId, teamName: rec.teamName, emoji: rec.emoji,
      task: rec.task, title: rec.title || "", startedAt: rec.startedAt, endedAt: rec.endedAt, status: rec.status,
      sourceRunId: rec.sourceRunId || "", memorySnapshot: rec.memorySnapshot || null,
      continuation: rec.continuation || null,
      spec: rec.spec, events: rec.events,
    }));
  } catch {}
}

function schedulePersistRun(rec) {
  if (!rec || rec.persistTimer || rec.status !== "running") return;
  rec.persistTimer = setTimeout(() => {
    rec.persistTimer = null;
    persistRun(rec);
  }, 1000);
  if (typeof rec.persistTimer.unref === "function") rec.persistTimer.unref();
}

function persistRunNow(rec) {
  if (rec?.persistTimer) {
    clearTimeout(rec.persistTimer);
    rec.persistTimer = null;
  }
  persistRun(rec);
}

function runBroadcast(rec, ev) {
  const event = { ...(ev || {}), ts: ev?.ts || Date.now() };
  rec.events.push(event);
  for (const sub of rec.subscribers) { try { sub(event); } catch {} }
  if (event.type === "run_done") { rec.status = "done"; rec.endedAt = event.ts; persistRunNow(rec); }
  else if (event.type === "run_stopped") { rec.status = "stopped"; rec.endedAt = event.ts; persistRunNow(rec); } // 用户手动停战
  else if (event.type === "error") { rec.status = "failed"; rec.endedAt = event.ts; persistRunNow(rec); }
  else schedulePersistRun(rec);
}

function runSummary(rec, stale) {
  return {
    run_id: rec.runId, team_id: rec.teamId, team_name: rec.teamName, emoji: rec.emoji,
    task: rec.task, title: rec.title || "", started_at: rec.startedAt, ended_at: rec.endedAt,
    status: stale && rec.status === "running" ? "interrupted" : rec.status,
    source_run_id: rec.sourceRunId || "",
  };
}

// 列出全部运行（内存中的运行中 + 磁盘历史），内存优先
function listRuns() {
  const out = new Map();
  try {
    for (const dir of fs.readdirSync(RUNS_DIR)) {
      const p = path.join(RUNS_DIR, dir, "record.json");
      if (!fs.existsSync(p)) continue;
      try { const rec = JSON.parse(fs.readFileSync(p, "utf8")); out.set(rec.runId, runSummary(rec, true)); } catch {}
    }
  } catch {}
  for (const rec of runs.values()) out.set(rec.runId, runSummary(rec, false)); // 内存权威
  return [...out.values()].sort((a, b) => b.started_at - a.started_at);
}

function getRunRecord(runId) {
  if (runs.has(runId)) return runs.get(runId);
  try { const rec = JSON.parse(fs.readFileSync(runRecordPath(runId), "utf8")); if (rec.status === "running") rec.status = "interrupted"; return rec; }
  catch { return null; }
}

function usageKnown(usage) {
  const u = normalizeUsage(usage);
  return !!u && (u.total_tokens != null || u.input_tokens != null || u.output_tokens != null);
}

function durationBetween(start, end) {
  const s = Number(start);
  const e = Number(end);
  return Number.isFinite(s) && Number.isFinite(e) && e >= s ? Math.round(e - s) : null;
}

function eventTime(ev, fallback = null) {
  const ts = Number(ev?.ts ?? ev?.ended_at ?? ev?.started_at ?? fallback);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function buildBattleReport(rec) {
  const spec = rec?.spec || {};
  const agentById = new Map((spec.agents || []).map((agent) => [agent.id, agent]));
  const members = new Map();
  const ensureMember = (id) => {
    const key = id || "unknown";
    if (!members.has(key)) {
      const agent = agentById.get(key);
      const isOrchestrator = key === ORCH_ID;
      members.set(key, {
        id: key,
        name: isOrchestrator ? "将军" : (agent?.name || key),
        emoji: isOrchestrator ? "将" : (agent?.emoji || "🤖"),
        role: isOrchestrator ? "团队主控调度" : (agent?.role || ""),
        is_orchestrator: isOrchestrator,
        usage: null,
        duration_ms: 0,
        unknown_token_steps: 0,
        steps: [],
      });
    }
    return members.get(key);
  };
  ensureMember(ORCH_ID);
  for (const agent of spec.agents || []) ensureMember(agent.id);

  const callMeta = new Map();
  const active = new Map();
  const activeById = new Map();
  const modelById = new Map();
  let orchMetricCount = 0;
  const fallbackCallCount = new Map();
  const keyFor = (id, callIndex) => `${id || "unknown"}:${callIndex || 0}`;
  const nextFallbackCall = (id) => {
    const n = (fallbackCallCount.get(id) || 0) + 1;
    fallbackCallCount.set(id, n);
    return n;
  };
  const finishStep = (step, endTs, doneUsage = null, doneEvent = null) => {
    if (!step || step.finished) return;
    step.finished = true;
    step.ended_at = endTs || step.ended_at || null;
    step.duration_ms = durationBetween(step.started_at, step.ended_at);
    const usage = normalizeUsage(doneUsage) || normalizeUsage(step.metric_usage);
    step.usage = usage;
    delete step.metric_usage;
    if (doneEvent?.result != null) step.result_chars = String(doneEvent.result || "").length;
    const member = ensureMember(step.id);
    step.index = member.steps.length + 1;
    member.steps.push(step);
    member.duration_ms += Number(step.duration_ms || 0);
    member.usage = addUsageTotals(member.usage, usage);
    if (!usageKnown(usage)) member.unknown_token_steps++;
  };

  for (const ev of rec?.events || []) {
    const ts = eventTime(ev, rec.startedAt);
    if (ev.type === "member_call") {
      callMeta.set(keyFor(ev.to, ev.call_index), {
        instruction: String(ev.instruction || ""),
        reason: String(ev.reason || ""),
        upstream_ids: Array.isArray(ev.upstream_ids) ? ev.upstream_ids : [],
        parallel: !!ev.parallel,
        batch_id: ev.batch_id || "",
        started_at: ts,
      });
      continue;
    }
    if (ev.type === "agent_model") {
      modelById.set(ev.id, { model: ev.model || "", provider: ev.provider || "" });
      const currentKey = activeById.get(ev.id);
      if (currentKey && active.has(currentKey)) {
        active.get(currentKey).model = ev.model || "";
        active.get(currentKey).provider = ev.provider || "";
      }
      continue;
    }
    if (ev.type === "agent_start") {
      if (ev.id === ORCH_ID) continue;
      const callIndex = Number(ev.call_index) || nextFallbackCall(ev.id);
      const key = keyFor(ev.id, callIndex);
      const meta = callMeta.get(key) || {};
      const model = modelById.get(ev.id) || {};
      const step = {
        id: ev.id,
        call_index: callIndex,
        title: callIndex > 1 ? `第 ${callIndex} 次调用` : "第 1 次调用",
        instruction: meta.instruction || "",
        reason: meta.reason || "",
        upstream_ids: meta.upstream_ids || [],
        parallel: !!meta.parallel,
        batch_id: meta.batch_id || "",
        started_at: ts || meta.started_at || null,
        ended_at: null,
        duration_ms: null,
        usage: null,
        metric_usage: null,
        model: model.model || "",
        provider: model.provider || "",
      };
      active.set(key, step);
      activeById.set(ev.id, key);
      continue;
    }
    if (ev.type === "agent_metric") {
      const usage = normalizeUsage(ev.usage);
      const durationMs = durationBetween(ev.started_at, ev.ended_at) ?? finiteTokenNumber(ev.duration_ms);
      if (ev.id === ORCH_ID) {
        const member = ensureMember(ORCH_ID);
        const step = {
          id: ORCH_ID,
          index: ++orchMetricCount,
          call_index: orchMetricCount,
          title: `第 ${orchMetricCount} 次调度`,
          instruction: "",
          reason: "",
          upstream_ids: [],
          parallel: false,
          batch_id: "",
          started_at: eventTime({ ts: ev.started_at }, ts),
          ended_at: eventTime({ ts: ev.ended_at }, ts),
          duration_ms: durationMs,
          usage,
          model: ev.model || "",
          provider: ev.provider || "",
        };
        member.steps.push(step);
        member.duration_ms += Number(durationMs || 0);
        member.usage = addUsageTotals(member.usage, usage);
        if (!usageKnown(usage)) member.unknown_token_steps++;
      } else {
        const key = activeById.get(ev.id) || keyFor(ev.id, ev.call_index);
        const step = active.get(key);
        if (step) {
          step.metric_usage = addUsageTotals(step.metric_usage, usage);
          step.model = step.model || ev.model || "";
          step.provider = step.provider || ev.provider || "";
        } else {
          const member = ensureMember(ev.id);
          const metricStep = {
            id: ev.id,
            index: member.steps.length + 1,
            call_index: Number(ev.call_index) || member.steps.length + 1,
            title: `第 ${member.steps.length + 1} 次模型调用`,
            instruction: "",
            reason: "",
            upstream_ids: [],
            parallel: false,
            batch_id: "",
            started_at: eventTime({ ts: ev.started_at }, ts),
            ended_at: eventTime({ ts: ev.ended_at }, ts),
            duration_ms: durationMs,
            usage,
            model: ev.model || "",
            provider: ev.provider || "",
          };
          member.steps.push(metricStep);
          member.duration_ms += Number(durationMs || 0);
          member.usage = addUsageTotals(member.usage, usage);
          if (!usageKnown(usage)) member.unknown_token_steps++;
        }
      }
      continue;
    }
    if (ev.type === "agent_done") {
      if (ev.id === ORCH_ID) continue;
      const key = activeById.get(ev.id) || keyFor(ev.id, ev.call_index);
      const step = active.get(key);
      if (step) {
        finishStep(step, ts, ev.usage, ev);
        active.delete(key);
        activeById.delete(ev.id);
      }
      continue;
    }
    if (ev.type === "error" && ev.id && ev.id !== ORCH_ID) {
      const key = activeById.get(ev.id);
      if (key && active.has(key)) {
        active.get(key).error = ev.message || "执行失败";
        finishStep(active.get(key), ts, null, ev);
        active.delete(key);
        activeById.delete(ev.id);
      }
    }
  }

  const lastTs = rec.endedAt || eventTime((rec.events || [])[rec.events?.length - 1], Date.now()) || Date.now();
  for (const [key, step] of active.entries()) {
    finishStep(step, lastTs, step.metric_usage, null);
    active.delete(key);
  }

  const orderedMembers = [ensureMember(ORCH_ID), ...(spec.agents || []).map((agent) => ensureMember(agent.id))]
    .filter((member) => member.steps.length || member.is_orchestrator);
  const totalUsage = orderedMembers.reduce((sum, member) => addUsageTotals(sum, member.usage), null);
  const startedAt = rec.startedAt || eventTime((rec.events || []).find((ev) => ev.type === "run_start"));
  const endedAt = rec.endedAt || (rec.status === "running" ? Date.now() : eventTime((rec.events || [])[rec.events?.length - 1], startedAt));
  return {
    run_id: rec.runId,
    status: rec.status,
    started_at: startedAt || null,
    ended_at: endedAt || null,
    duration_ms: durationBetween(startedAt, endedAt),
    usage: totalUsage,
    token_known: usageKnown(totalUsage),
    unknown_token_steps: orderedMembers.reduce((n, member) => n + (member.unknown_token_steps || 0), 0),
    members: orderedMembers.map((member) => ({
      ...member,
      duration_ms: Math.round(member.duration_ms || 0),
      token_known: usageKnown(member.usage),
      steps: member.steps.map((step, i) => ({
        ...step,
        index: i + 1,
        token_known: usageKnown(step.usage),
      })),
    })),
  };
}

function battleReportSummary(row) {
  const rec = getRunRecord(row.run_id);
  const report = rec ? buildBattleReport(rec) : null;
  const members = Array.isArray(report?.members) ? report.members : [];
  return {
    ...row,
    duration_ms: report?.duration_ms ?? null,
    usage: report?.usage || null,
    token_known: !!report?.token_known,
    unknown_token_steps: report?.unknown_token_steps || 0,
    member_count: members.filter((member) => !member.is_orchestrator).length,
    step_count: members.reduce((n, member) => n + (member.steps?.length || 0), 0),
  };
}

function teamPath(id) {
  const safe = String(id).replace(/[^a-z0-9-]/g, "");
  if (!safe) throw new Error("无效的团队 id");
  return path.join(TEAMS_DIR, safe + ".json");
}

// 按 id 读“当前保存的团队”最新 spec（含用户切过的模型/结构编辑）；不存在返回 null。
function readTeamSpecById(id) {
  try {
    const p = teamPath(id);
    if (!fs.existsSync(p)) return null;
    const saved = JSON.parse(fs.readFileSync(p, "utf8"));
    const s = normalizeSpec(saved);
    s.id = saved.id || id;
    return s;
  } catch { return null; }
}

function createdAtFromTeamId(id) {
  const raw = String(id || "");
  if (!/^t[a-z0-9]+$/.test(raw)) return null;
  const n = parseInt(raw.slice(1), 36);
  return Number.isFinite(n) && n > 946684800000 && n < 4102444800000 ? new Date(n).toISOString() : null;
}

function teamListFingerprint(t) {
  if (t?.global_skill_integrity?.sha256) return `global:${t.global_skill_integrity.sha256}`;
  if (t?.skill_integrity?.sha256) return `skill:${t.skill_integrity.sha256}`;
  const agents = Array.isArray(t?.agents) ? t.agents.map((a) => ({
    name: a.name || "",
    role: a.role || "",
    system_prompt: a.system_prompt || "",
    tools: a.tools || [],
  })) : [];
  return crypto.createHash("sha1").update(JSON.stringify({
    team_name: t?.team_name || "",
    agents,
  })).digest("hex");
}

function teamDagForList(t) {
  const agents = Array.isArray(t?.agents) ? t.agents : [];
  const ids = new Set(agents.map((a, i) => String(a?.id || `agent-${i + 1}`)));
  return agents.slice(0, 24).map((a, i) => {
    const id = String(a?.id || `agent-${i + 1}`);
    return {
      id,
      name: String(a?.name || id),
      emoji: String(a?.emoji || "🤖"),
      depends_on: Array.isArray(a?.depends_on)
        ? uniqueNonEmptyStrings(a.depends_on).filter((d) => ids.has(d)).slice(0, 8)
        : [],
    };
  });
}

function listTeams() {
  const byFingerprint = new Map();
  for (const f of fs.readdirSync(TEAMS_DIR)
    .filter((f) => f.endsWith(".json"))
  ) {
    const item = (() => {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, f), "utf8"));
        if (t.runId || t.run_id || t.sourceRunId || t.source_run_id) return null;
        if (!Array.isArray(t.agents) || !t.agents.length) return null;
        const id = f.slice(0, -5);
        return {
          id,
          team_name: t.team_name,
          emoji: t.emoji,
          agents: (t.agents || []).length,
          created_at: t.created_at || createdAtFromTeamId(t.id || id),
          updated_at: t.updated_at || null,
          origin: inferTeamOrigin(t),
          dag: teamDagForList(t),
          fingerprint: teamListFingerprint(t),
        };
      } catch { return null; }
    })();
    if (!item) continue;
    const old = byFingerprint.get(item.fingerprint);
    const itemTime = Date.parse(item.updated_at || item.created_at || "") || 0;
    const oldTime = old ? (Date.parse(old.updated_at || old.created_at || "") || 0) : -1;
    if (!old || itemTime >= oldTime) byFingerprint.set(item.fingerprint, item);
  }
  return [...byFingerprint.values()]
    .map(({ fingerprint, ...item }) => item)
    .sort((a, b) => (b.created_at || b.updated_at || "").localeCompare(a.created_at || a.updated_at || ""));
}

function saveTeam(spec) {
  const existingId = spec.id && /^[a-z0-9-]+$/.test(spec.id) ? spec.id : "";
  let existing = null;
  if (existingId) {
    const p = teamPath(existingId);
    if (fs.existsSync(p)) {
      try { existing = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    }
  }
  const norm = normalizeSpec(spec);
  norm.id = existingId || "t" + Date.now().toString(36);
  norm.created_at = spec.created_at || existing?.created_at || new Date().toISOString();
  norm.updated_at = new Date().toISOString();
  fs.writeFileSync(teamPath(norm.id), JSON.stringify(norm, null, 2));
  return norm;
}

module.exports = {
  TEAMS_DIR, RUNS_DIR, MEMORIES_DIR, runs,
  safeMemoryId, teamMemoryPath, emptyTeamMemory, orchestratorUserInputsFromEvents, mergeConversations, readTeamMemory, writeTeamMemory, memberMemoryPath, emptyMemberMemory, readMemberMemory, writeMemberMemory, formatMemberMemoryForPrompt, runAgentOutputsFromEvents, runCompletedMemberIds, runCompletedMemberRefs, runMissingMembersFromEvents, updateTeamMemoryFromRunRecord, writeMemberMemoriesFromRunRecord, memorySnapshotForContinuation, buildContinuationTask, runRecordPath, persistRun, schedulePersistRun, persistRunNow, runBroadcast, runSummary, listRuns, getRunRecord, usageKnown, durationBetween, eventTime, buildBattleReport, battleReportSummary, teamPath, readTeamSpecById, createdAtFromTeamId, teamListFingerprint, teamDagForList, listTeams, saveTeam,
};
