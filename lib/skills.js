// 团队配置 / skill 原文 / 蓝图 的归一与拆分——纯函数，不依赖运行时可变状态。
// 只用到 crypto、path 与共享常量 REAL_TOOL_NAMES。

const crypto = require("crypto");
const path = require("path");
const { REAL_TOOL_NAMES } = require("./constants");

function normalizeBlueprint(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    goal: String(raw.goal || ""),
    tasks: (Array.isArray(raw.tasks) ? raw.tasks : []).map((t) => ({
      title: String(t?.title || ""),
      detail: String(t?.detail || ""),
      acceptance: String(t?.acceptance || ""),
    })).filter((t) => t.title || t.detail),
    tools_needed: (Array.isArray(raw.tools_needed) ? raw.tools_needed : []).map((t) => ({
      tool: String(t?.tool || ""),
      why: String(t?.why || ""),
    })).filter((t) => REAL_TOOL_NAMES.includes(t.tool)),
    external_platforms: (Array.isArray(raw.external_platforms) ? raw.external_platforms : []).map((p) => ({
      capability: String(p?.capability || ""),
      recommended: String(p?.recommended || ""),
      alternatives: (Array.isArray(p?.alternatives) ? p.alternatives : []).map(String),
      why: String(p?.why || ""),
      needs_credential: !!p?.needs_credential,
      env_key: String(p?.env_key || ""),
    })).filter((p) => p.capability || p.recommended),
    open_questions: (Array.isArray(raw.open_questions) ? raw.open_questions : []).map((q) => ({
      question: String(q?.question || ""),
      why: String(q?.why || ""),
      answer: String(q?.answer || ""), // 用户在蓝图面板里的拍板（点兵时作为硬约束）
    })).filter((q) => q.question),
  };
}

function mockBlueprint(description) {
  return normalizeBlueprint({
    goal: `（演示）${description || "完成用户描述的目标"}`,
    tasks: [
      { title: "拆解与策划", detail: "明确产出形态、受众与结构", acceptance: "有一份可执行的内容大纲" },
      { title: "生产与产出", detail: "按大纲产出真实文件 / 素材", acceptance: "产物存在且符合大纲要求" },
      { title: "整合与收尾", detail: "整合为最终交付物并自检", acceptance: "最终交付物完整可用" },
    ],
    tools_needed: [{ tool: "write_file", why: "演示：把产物写入工作目录" }],
    external_platforms: [
      { capability: "配音 / TTS", recommended: "ElevenLabs", alternatives: ["MiniMax 语音"], why: "演示项：质量高、多语种", needs_credential: true, env_key: "ELEVENLABS_API_KEY" },
    ],
    open_questions: [{ question: "目标平台 / 风格偏好是什么？", why: "影响产出形态与配音风格" }],
  });
}

// 模型偶尔会包围栏、夹带思考文字、或在 JSON 前后加说明——平衡括号扫描提取所有候选对象
function extractJson(text) {
  if (!text || !text.trim()) throw new Error("模型返回了空内容。");
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const candidates = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inStr = false, escNext = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escNext) { escNext = false; continue; }
      if (c === "\\") { escNext = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { candidates.push(text.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  candidates.sort((a, b) => b.length - a.length); // 大的优先（团队配置通常是最大那块）
  for (const c of candidates) {
    if (!c.includes('"agents"')) continue;
    try { return JSON.parse(c); } catch {}
  }
  for (const c of candidates) { try { return JSON.parse(c); } catch {} }
  throw new Error("模型返回的内容不是合法 JSON。");
}

// 兼容模型/CLI 偶尔多包一层 team/spec/result/data，或把 agents 命名成 members。
// 返回原对象是为了让后续校验给出统一错误，而不是在这里吞掉真实响应。
function unwrapTeamSpec(raw) {
  let cur = raw;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof cur === "string") {
      try { cur = extractJson(cur); } catch { return cur; }
    }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return cur;
    if (Array.isArray(cur.agents)) return cur;
    if (cur.agents && typeof cur.agents === "object" && !Array.isArray(cur.agents)) {
      return {
        ...cur,
        agents: Object.entries(cur.agents).map(([id, agent]) =>
          agent && typeof agent === "object" ? { id, ...agent } : { id, role: String(agent || "") }
        ),
      };
    }
    for (const key of ["members", "team_members", "teamMembers", "nodes"]) {
      if (Array.isArray(cur[key])) return { ...cur, agents: cur[key] };
    }
    const key = ["team", "spec", "result", "data", "output"]
      .find((k) => cur[k] && (typeof cur[k] === "object" || typeof cur[k] === "string"));
    if (!key) return cur;
    cur = cur[key];
  }
  return cur;
}

// 取出字符串开头的 emoji（含变体选择符 / 肤色 / ZWJ 组合），返回 {emoji, rest}
function splitLeadingEmoji(s) {
  const m = String(s || "").match(/^\s*((?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic})*)+)\s*/u);
  if (m && m[1]) return { emoji: m[1].trim(), rest: String(s).slice(m[0].length).trim() };
  return { emoji: "", rest: String(s || "").trim() };
}

function normalizeSkillSources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => s && typeof s === "object" && s.content != null)
    .map((s, i) => ({ name: String(s.name || `skill-${i + 1}.md`), content: String(s.content) }));
}

function skillSourcesDigest(sources) {
  const hash = crypto.createHash("sha256");
  for (const source of normalizeSkillSources(sources)) {
    hash.update(source.name, "utf8");
    hash.update("\0");
    hash.update(source.content, "utf8");
    hash.update("\xff");
  }
  return hash.digest("hex");
}

function uniqueNonEmptyStrings(list = []) {
  return [...new Set((Array.isArray(list) ? list : [])
    .map((x) => String(x || "").trim())
    .filter(Boolean))];
}

function cleanOriginText(text = "") {
  const value = String(text || "").trim();
  return value === "（由导入的 skill 生成）" ? "" : value;
}

function buildTeamOrigin(description = "", skills = []) {
  const text = cleanOriginText(description);
  const skillSources = normalizeSkillSources(skills);
  const skillPaths = uniqueNonEmptyStrings(skillSources.map((s) => s.name));
  if (!text && !skillPaths.length) return null;
  return {
    source: "design_input",
    mode: skillPaths.length && text ? "mixed" : (skillPaths.length ? "skill" : "text"),
    text,
    skill_paths: skillPaths,
    skill_count: skillSources.length || skillPaths.length,
  };
}

function normalizeTeamOrigin(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const text = cleanOriginText(raw.text || raw.description || raw.prompt || raw.input || "");
  const skillPaths = uniqueNonEmptyStrings(raw.skill_paths || raw.skillPaths || raw.paths || raw.files);
  const rawCount = Number(raw.skill_count ?? raw.skillCount ?? skillPaths.length);
  const skillCount = Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : skillPaths.length;
  if (!text && !skillPaths.length && !skillCount) return null;
  let mode = String(raw.mode || raw.type || "").toLowerCase();
  if (!["text", "skill", "mixed", "unknown"].includes(mode)) {
    mode = skillPaths.length && text ? "mixed" : (skillPaths.length || skillCount ? "skill" : "text");
  }
  if (mode === "text" && skillPaths.length) mode = text ? "mixed" : "skill";
  if (mode === "skill" && text) mode = skillPaths.length || skillCount ? "mixed" : "text";
  if (mode === "unknown") mode = skillPaths.length && text ? "mixed" : (skillPaths.length || skillCount ? "skill" : "text");
  return {
    source: String(raw.source || raw.source_type || "").trim(),
    mode,
    text,
    skill_paths: skillPaths,
    skill_count: Math.max(skillCount, skillPaths.length),
  };
}

function inferTeamOrigin(raw) {
  const saved = normalizeTeamOrigin(raw?.origin || raw?.source_meta || raw?.creation_source);
  const fallback = buildTeamOrigin("", raw?.skill_sources || []);
  if (!saved) return fallback;
  const skillPaths = saved.skill_paths.length ? saved.skill_paths : (fallback?.skill_paths || []);
  const lastTaskText = cleanOriginText(raw?.last_task || "");
  const textLooksLikeLastTask = saved.text && lastTaskText && saved.text === lastTaskText;
  const text = saved.source === "design_input" || !textLooksLikeLastTask ? saved.text : "";
  const skillCount = Math.max(saved.skill_count || 0, fallback?.skill_count || 0, skillPaths.length);
  if (!text && !skillPaths.length && !skillCount) return null;
  let mode = saved.mode;
  if (skillPaths.length && text) mode = "mixed";
  else if (skillPaths.length || skillCount) mode = "skill";
  else if (text) mode = "text";
  return { source: saved.source || "", mode, text, skill_paths: skillPaths, skill_count: skillCount };
}

function cleanModuleTitle(title) {
  return String(title || "")
    .replace(/^[\s#*-]+/, "")
    .replace(/\s*\{#.*?\}\s*$/, "")
    .trim();
}

function slugifyModuleId(file, title, index) {
  const base = `${file}-${title}`.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || `module-${index + 1}`).slice(0, 80);
}

function isExplicitSkillModuleTitle(title) {
  const t = cleanModuleTitle(title);
  return /^(?:step\s*[0-9a-z]+|步骤\s*[0-9一二三四五六七八九十零]*|阶段\s*[0-9一二三四五六七八九十零]*|模块\s*[0-9一二三四五六七八九十零]*|功能模块)(?:$|[\s：:.)、-])/i.test(t);
}

function isSupplementalSkillModuleTitle(title) {
  const t = cleanModuleTitle(title);
  if (!t) return false;
  if (isExplicitSkillModuleTitle(t)) return true;
  if (/^(?:\d+[a-z]?[.)、]|[一二三四五六七八九十]+[、.])/.test(t)) return false;
  if (/(?:注意事项|常见问题|目录结构|参数|验证|自查|范例|示例|参考片段|design\s*tokens|字体|排版|模板|关键变更|输出文件|改写目标|改写允许|不能动|风格定位|start_time|描边|位置|应该\s*[<>=]|demo_)/i.test(t)) return false;
  return /(?:执行流程|生成|合成|渲染|下载|提交|构造|改写|拆分|切分|对时|配音|字幕|封面|复盘|确认|口播|画面|视频|音频|生产笔记|prompt)/i.test(t);
}

function extractSkillModules(sources) {
  const modules = [];
  const seen = new Set();
  const pushModule = (source, title, level, start) => {
    const cleaned = cleanModuleTitle(title);
    if (!cleaned) return null;
    const seed = slugifyModuleId(source.name, cleaned, modules.length);
    let id = seed, n = 2;
    while (seen.has(id)) id = `${seed}-${n++}`;
    seen.add(id);
    const mod = { id, file: source.name, title: cleaned, level, start: start || 0, body: "" };
    modules.push(mod);
    return mod;
  };
  for (const source of normalizeSkillSources(sources)) {
    const content = String(source.content || "");
    const headings = [];
    const re = /^(#{1,4})\s+(.+?)\s*$/gm;
    let m;
    while ((m = re.exec(content))) {
      const level = m[1].length;
      const title = cleanModuleTitle(m[2]);
      if (!title) continue;
      headings.push({ level, title, index: m.index });
    }
    if (!headings.length) {
      const sectionRe = /^\s*(?:[-*]\s*)?((?:step|步骤|阶段|模块|功能|流程)\s*[0-9a-z一二三四五六七八九十零]*\s*[：:.)、-]\s*[^\n]{2,120})\s*$/gmi;
      while ((m = sectionRe.exec(content))) {
        const title = cleanModuleTitle(m[1]);
        if (title) headings.push({ level: 3, title, index: m.index });
      }
    }
    const explicit = headings.filter((h) => isExplicitSkillModuleTitle(h.title));
    const supplemental = headings.filter((h) => h.level <= 2 && isSupplementalSkillModuleTitle(h.title));
    const selected = explicit.length >= 2
      ? explicit
      : [...explicit, ...supplemental.filter((h) => !explicit.some((e) => e.title === h.title))];
    let usable = selected.length ? selected.slice(0, 40) : [];
    if (!usable.length) {
      const mod = pushModule(source, path.basename(source.name), 1, 0);
      if (mod) mod.body = content.trim();
      continue;
    }
    // 按文档顺序排序，便于把每个模块的 verbatim 正文切出来（本标题处 → 下一标题处）
    usable = usable.slice().sort((a, b) => a.index - b.index);
    const fileMods = [];
    for (const h of usable) { const mod = pushModule(source, h.title, h.level, h.index); if (mod) fileMods.push(mod); }
    for (let i = 0; i < fileMods.length; i++) {
      const s = fileMods[i].start;
      const e = i + 1 < fileMods.length ? fileMods[i + 1].start : content.length;
      fileMods[i].body = content.slice(s, e).trim();
    }
  }
  return modules;
}

// 按成员的 module_refs，把它负责模块的原始 skill 原文逐字拼进 system_prompt（模型只做映射，服务端保真拼接）
function attachSkillModuleContent(team, modules) {
  const byId = new Map(modules.map((m) => [m.id, m]));
  for (const agent of team.agents || []) {
    const refs = (Array.isArray(agent.module_refs) ? agent.module_refs : []).map(String).filter((r) => byId.has(r));
    if (!refs.length) continue;
    const blocks = refs.map((r) => { const mo = byId.get(r); return `===== 你负责的模块：${mo.title}（${mo.file}）=====\n${mo.body}`; });
    agent.system_prompt = `${String(agent.system_prompt || "").trim()}\n\n【你负责步骤的原始 Skill 原文——以下命令、参数、顺序、模板、判断条件逐字遵守，不得改写或省略】\n\n${blocks.join("\n\n")}`;
  }
  return team;
}

function formatSkillModuleOutline(modules) {
  if (!modules.length) return "（未识别到 Markdown 标题；请按 skill 的语义功能模块自行拆分）";
  return modules.map((m, i) =>
    `${i + 1}. [${m.id}] ${m.file} / ${m.title}`
  ).join("\n");
}

// 拆分时确定团队共用 Skill：skill 原文里【不属于任何单一成员】的部分——
// 前导（第一个模块之前的整体目标/风格/Design Tokens/目录约定等）+ 没被任何成员认领的模块。
// 逐字保真，调度时随每个成员一起下发，相当于让每人都握有 Claude Code 那样的全局契约。
function computeSkillGlobalBase(skillSources, modules, assignedIds) {
  const sources = normalizeSkillSources(skillSources);
  const assigned = assignedIds instanceof Set ? assignedIds : new Set((assignedIds || []).map(String));
  const byFile = new Map();
  for (const m of modules || []) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file).push(m);
  }
  const parts = [];
  for (const src of sources) {
    const content = String(src.content || "");
    const fileMods = (byFile.get(src.name) || []).slice().sort((a, b) => a.start - b.start);
    if (!fileMods.length) { if (content.trim()) parts.push({ file: src.name, text: content.trim() }); continue; }
    const chunks = [];
    if (fileMods[0].start > 0) chunks.push(content.slice(0, fileMods[0].start)); // 前导
    for (let i = 0; i < fileMods.length; i++) {
      if (assigned.has(String(fileMods[i].id))) continue; // 已分给某成员的模块不算共用
      const s = fileMods[i].start;
      const e = i + 1 < fileMods.length ? fileMods[i + 1].start : content.length;
      chunks.push(content.slice(s, e)); // 没人认领的模块 → 共用
    }
    const text = chunks.join("\n").trim();
    if (text) parts.push({ file: src.name, text });
  }
  if (!parts.length) return "";
  return parts.map((p) => `===== 团队共用 Skill（来自 ${p.file}，不属于任何单一成员，全员逐字遵守）=====\n${p.text}`).join("\n\n");
}

function buildTeamGlobalSkill(spec) {
  const sources = normalizeSkillSources(spec.skill_sources);
  const originalSkills = sources.length
    ? `# 原始 Skill 文件（完整原文）\n\n${sources.map((source) =>
        `===== ORIGINAL SKILL FILE: ${source.name} =====\n${source.content}`
      ).join("\n\n")}`
    : "# 原始 Skill 文件\n\n本团队由点将生成，以下成员完整定义共同构成团队 Skill。";
  const members = (spec.agents || []).map((agent, index) =>
    `## 成员 ${index + 1}：${agent.name}（${agent.id}）

- 图标：${agent.emoji || ""}
- 角色：${agent.role || ""}
- 人设：${agent.persona || ""}
- 功能模块：${(agent.module_refs || []).join("、") || "未显式标注"}
- 独立模型：${agent.model || "继承将军模型"}
- 独立工具：${(agent.tools || []).join("、") || "无"}
- 危险标记：${agent.risk?.level === "danger" ? `${agent.risk.summary || "包含高危操作"}${agent.risk.operations?.length ? `（${agent.risk.operations.join("；")}）` : ""}` : "无"}
- DAG 展示上游：${(agent.depends_on || []).join("、") || "无"}

### 成员执行契约

${agent.system_prompt || ""}`
  ).join("\n\n");
  const bp = spec.blueprint;
  const blueprintBlock = bp && (bp.tasks?.length || bp.goal)
    ? `\n## 作战蓝图（与用户确认过，主控按此调度与验收）\n\n目标：${bp.goal || spec.summary || ""}\n\n### 任务与验收标准\n${
        (bp.tasks || []).map((t, i) => `${i + 1}. ${t.title}：${t.detail}\n   - 验收：${t.acceptance || "（未给出，主控按目标自判）"}`).join("\n")
      }${
        (bp.external_platforms || []).length
          ? `\n\n### 已确认的外部平台\n${bp.external_platforms.map((p) => `- ${p.capability} → ${p.recommended}${p.env_key ? `（凭证：${p.env_key}）` : ""}`).join("\n")}`
          : ""
      }\n`
    : "";
  const evoBlock = (spec.evolution_log || []).length
    ? `\n## 团队演进记录（对话中沉淀的全局补充规则，全员遵守，优先级高于上面的原始定义）\n${spec.evolution_log.map((e) => `- [${e.at}]${e.by ? ` ${e.by}：` : " "}${e.note}`).join("\n")}\n`
    : "";
  const baseCfg = Array.isArray(spec.base_config) ? spec.base_config : [];
  const baseConfigBlock = baseCfg.length
    ? `\n## 团队基础配置（2+ 成员共用变量，全队统一取值；运行时同名环境变量已注入，shell 里用 $KEY 取，不要各自另造）\n${baseCfg.map((c) => `- ${c.key} = ${c.value !== "" && c.value != null ? c.value : "（待填）"}${c.desc ? `　// ${c.desc}` : ""}`).join("\n")}\n`
    : "";
  return `# 团队全局 Skill：${spec.team_name || "无名战队"}

## 团队目标

${spec.summary || ""}
${baseConfigBlock}${blueprintBlock}${evoBlock}
${originalSkills}

# 全部成员定义

${members}

# 主控职责

团队主 Agent 必须完整理解以上 Skill 与所有成员能力，负责决定调用哪个成员、提供哪些已完成产出、是否返工、是否询问用户以及何时完成。成员独立运行、独立使用其被授予的工具并独立提交结果。DAG 仅用于展示团队结构和实时作战状态，不是调度权限或固定执行顺序。`;
}

function inferAgentRole(agent, name) {
  const explicit = String(agent.role || agent.title || agent.description || "").trim();
  if (explicit && !["完成分内工作", "完成任务", "执行任务"].includes(explicit)) return explicit;
  const prompt = String(agent.system_prompt || agent.prompt || "").trim();
  const match = prompt.match(/(?:你(?:主要)?负责|职责(?:是|：)|负责的是|负责)\s*([^。\n]{2,100})/);
  let role = match?.[1] || prompt.split(/\n+/).find((line) => line.trim()) || "";
  role = role.replace(/^[：:，,\s]+|[。；;，,\s]+$/g, "").trim();
  if (role.length > 72) role = role.slice(0, 72) + "…";
  return role || `${name}：执行所负责阶段并交付原始 skill 规定的产物`;
}

function normalizeAgentRisk(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const level = String(r.level || "").toLowerCase() === "danger" ? "danger" : "none";
  const operations = Array.isArray(r.operations)
    ? r.operations.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 5)
    : [];
  const summary = String(r.summary || "").trim();
  if (level !== "danger" || (!summary && !operations.length)) {
    return { level: "none", summary: "", operations: [] };
  }
  return {
    level: "danger",
    summary: summary || operations[0],
    operations,
  };
}

// 模型（尤其非 Claude）可能漏字段、id 不规范、依赖指向不存在的人——这里统一整形兜底
function normalizeSpec(raw, options = {}) {
  raw = unwrapTeamSpec(raw);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error("模型没有返回有效的团队配置，请重试或换个描述。");
  }
  const skillSources = normalizeSkillSources(raw.skill_sources);
  const preserveGraph = options.preserveGraph === true || skillSources.length > 0;
  const graph = raw.graph && typeof raw.graph === "object" && !Array.isArray(raw.graph) ? raw.graph : {};
  const idMap = new Map(); // 原始 id -> 规范化 id
  const used = new Set();
  const agents = raw.agents.map((a, i) => {
    a = a && typeof a === "object" ? a : {};
    let id = String(a.id || a.name || `agent-${i + 1}`).toLowerCase().trim()
      .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || `agent-${i + 1}`;
    let uid = id, n = 2;
    while (used.has(uid)) uid = `${id}-${n++}`;
    used.add(uid);
    if (a.id != null) idMap.set(String(a.id), uid);
    if (a.name != null) idMap.set(String(a.name), uid); // 有的模型在 depends_on 里写名字而不是 id
    // 名字里若带了开头 emoji（模型常把角色 emoji 放进 name），把它提出来当唯一图标、并从名字里去掉，避免"🤖 📝 名字"两个图标
    let nm = String(a.name || uid);
    let em = String(a.emoji || "");
    const led = splitLeadingEmoji(nm);
    if (led.emoji) { em = led.emoji; nm = led.rest || `军士${i + 1}`; }
    if (!em) em = "🤖";
    const role = inferAgentRole(a, nm);
    return {
      id: uid,
      name: nm,
      emoji: em,
      role,
      persona: String(a.persona || ""),
      system_prompt: String(a.system_prompt || a.prompt || `你是「${nm}」，职责：${role}。请严格按原始要求完成并直接输出交付物。`),
      tools: Array.isArray(a.tools) ? [...new Set(a.tools.map(String))].filter((t) => REAL_TOOL_NAMES.includes(t)) : [],
      model: a.model ? String(a.model) : "",
      risk: normalizeAgentRisk(a.risk),
      module_refs: Array.isArray(a.module_refs) ? [...new Set(a.module_refs.map(String).filter(Boolean))] : [],
      _raw_deps: Array.isArray(a.depends_on)
        ? a.depends_on.map(String)
        : (Array.isArray(graph[a.id]?.depends_on) ? graph[a.id].depends_on.map(String) : []),
    };
  });
  for (const a of agents) {
    a.depends_on = [...new Set(a._raw_deps.map((d) => idMap.get(d) || d))]
      .filter((d) => d !== a.id && used.has(d));
    delete a._raw_deps;
  }
  // 模型偶尔返回一盘散沙（完全没有依赖）：DAG 至少要能展示作战关系。
  // 这里只按成员顺序补展示链路，不拆解或改写原始 skill；Harness 调度仍可动态决定真实执行路径。
  if (agents.length > 1 && agents.every((a) => a.depends_on.length === 0)) {
    for (let i = 1; i < agents.length; i++) agents[i].depends_on = [agents[i - 1].id];
    console.error("[normalize] 模型没有给出任何依赖关系，已按成员顺序补充 DAG 展示链路。");
  }
  const normalized = {
    // 保留团队稳定 id（记忆/上下文按它隔离，避免不同团队同名时哈希撞车→串台）
    ...(raw.id != null && String(raw.id).trim() ? { id: String(raw.id) } : {}),
    team_name: String(raw.team_name || "无名战队"),
    emoji: String(raw.emoji || "⚔"),
    summary: String(raw.summary || raw.description || ""),
    last_task: raw.last_task ? String(raw.last_task) : "",
    main_model: raw.main_model ? String(raw.main_model) : "", // 将军使用的 Harness 主控模型；成员不指定时也继承它
    orchestration: "harness", // 旧配置兼容字段：执行统一由 Harness 主控，DAG 仅用于结构与状态展示
    ...(raw.global_skill ? { global_skill: String(raw.global_skill) } : {}),
    // 团队级凭证（用户级，绑在团队上）：运行时注入到该团队工具的环境，如 ELEVENLABS_API_KEY 给配音用。
    // 接受两种形态：对象 {KEY:val} 或数组 [{key,value}]（军师导入 skill 时用数组提取）。
    secrets: toSecretsObject(raw.secrets),
    agents,
  };
  const origin = inferTeamOrigin(raw);
  if (origin) normalized.origin = origin;
  if (raw.blueprint && typeof raw.blueprint === "object") normalized.blueprint = normalizeBlueprint(raw.blueprint);
  if (skillSources.length) {
    normalized.skill_sources = skillSources;
    normalized.skill_integrity = {
      mode: "verbatim-v1",
      files: skillSources.length,
      sha256: skillSourcesDigest(skillSources),
    };
  }
  // 团队基础配置（2+ 成员共用变量）：在重建 global_skill 之前带过来，让全局 Skill 含基础配置
  const baseConfig = normalizeBaseConfig(raw.base_config);
  if (baseConfig.length) normalized.base_config = baseConfig;
  // 团队共用 Skill（拆分时确定的、不属于任何成员的全局部分）：保留，调度时下发给每个成员
  if (raw.skill_global_base && String(raw.skill_global_base).trim()) normalized.skill_global_base = String(raw.skill_global_base);
  // 团队进化标记/演进记录要在重建 global_skill 之前带过来，否则 buildTeamGlobalSkill 会丢掉演进记录
  if (Array.isArray(raw.evolution_log) && raw.evolution_log.length) normalized.evolution_log = raw.evolution_log.slice(-30);
  if (raw.evolved) normalized.evolved = true;
  normalized.global_skill = buildTeamGlobalSkill(normalized);
  normalized.global_skill_integrity = {
    mode: "derived-full-v1",
    sha256: crypto.createHash("sha256").update(normalized.global_skill, "utf8").digest("hex"),
  };
  return normalized;
}

// 把 secrets 归一成 {KEY: value} 对象（支持对象 / [{key,value}] 数组两种输入）
function toSecretsObject(raw) {
  if (Array.isArray(raw)) {
    const o = {};
    for (const e of raw) { if (e && e.key) o[String(e.key)] = String(e.value != null ? e.value : ""); }
    return o;
  }
  if (raw && typeof raw === "object") {
    return Object.fromEntries(Object.entries(raw)
      .filter(([k, v]) => k && v != null && typeof v !== "object")
      .map(([k, v]) => [String(k), String(v)]));
  }
  return {};
}

// 团队基础配置：2+ 成员共用的非密钥变量。归一成 [{key,value,desc}]（支持数组或 {KEY:val} 对象）。
function normalizeBaseConfig(raw) {
  const out = [];
  const seen = new Set();
  const push = (key, value, desc) => {
    const k = String(key == null ? "" : key).trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ key: k, value: String(value == null ? "" : value), desc: String(desc == null ? "" : desc).trim() });
  };
  if (Array.isArray(raw)) {
    for (const e of raw) { if (e && typeof e === "object") push(e.key ?? e.name, e.value ?? e.val ?? "", e.desc ?? e.description ?? e.note ?? ""); }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === "object") push(k, v.value ?? v.val ?? "", v.desc ?? v.description ?? "");
      else push(k, v, "");
    }
  }
  return out;
}

// 取可注入为环境变量的基础配置（只取已填值的），与 secrets 一起注入 shell 环境
function baseConfigEnv(baseConfig) {
  const o = {};
  for (const c of (Array.isArray(baseConfig) ? baseConfig : [])) {
    if (c && c.key && c.value !== "" && c.value != null) o[String(c.key)] = String(c.value);
  }
  return o;
}

module.exports = {
  extractJson, unwrapTeamSpec, splitLeadingEmoji, normalizeSkillSources, skillSourcesDigest, uniqueNonEmptyStrings, cleanOriginText, buildTeamOrigin, normalizeTeamOrigin, inferTeamOrigin, cleanModuleTitle, slugifyModuleId, isExplicitSkillModuleTitle, isSupplementalSkillModuleTitle, extractSkillModules, attachSkillModuleContent, formatSkillModuleOutline, buildTeamGlobalSkill, inferAgentRole, normalizeAgentRisk, normalizeSpec, toSecretsObject, normalizeBaseConfig, baseConfigEnv, computeSkillGlobalBase, normalizeBlueprint, mockBlueprint,
};
