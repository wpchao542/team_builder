let spec = null;
let META = { tools_enabled: false, tools: [] };
const openEditors = new Set();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let redesignThinkingWanted = false;

function normalizeMemberIcon(agent) {
  const name = String(agent?.name || "").trim();
  const match = name.match(/^\s*((?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic})*)+)\s*/u);
  if (match?.[1]) {
    agent.emoji = match[1].trim();
    agent.name = name.slice(match[0].length).trim() || "未命名成员";
  }
  if (!agent.emoji) agent.emoji = "🤖";
}

function outputIcon() {
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/></svg>';
}

function outputUrl(raw) {
  const value = String(raw || "").trim().replace(/^<|>$/g, "");
  if (!value || /^javascript:/i.test(value)) return "#";
  if (/^(https?:|mailto:|blob:|data:image\/|#)/i.test(value) || value.startsWith("/runs/")) return value;
  if (!runWorkDir) return value.startsWith("/") ? "#" : value;
  const work = String(runWorkDir).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = value.replace(/\\/g, "/");
  let rel = normalized;
  if (normalized.startsWith(work + "/")) rel = normalized.slice(work.length + 1);
  else if (normalized.startsWith("/")) return "#";
  const parts = rel.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return "#";
  const runId = work.split("/").pop();
  return `/runs/${encodeURIComponent(runId)}/${parts.map(encodeURIComponent).join("/")}`;
}

function inlineMarkdown(source) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let text = String(source || "");
  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
  // LaTeX 公式：$$...$$ / \[...\] 显示式，\(...\) 行内式。不支持裸 $...$（会和 $BASE_DIR、shell 变量、价格冲突）。
  text = text.replace(/\$\$([^\n]+?)\$\$/g, (_, tex) => hold(`<span class="math" data-display="1" data-tex="${encodeURIComponent(tex)}"></span>`));
  text = text.replace(/\\\[([^\n]+?)\\\]/g, (_, tex) => hold(`<span class="math" data-display="1" data-tex="${encodeURIComponent(tex)}"></span>`));
  text = text.replace(/\\\(([^\n]+?)\\\)/g, (_, tex) => hold(`<span class="math" data-display="0" data-tex="${encodeURIComponent(tex)}"></span>`));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
    const src = outputUrl(url);
    return hold(src === "#" ? esc(alt) : `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">`);
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
    const href = outputUrl(url);
    if (href === "#") return esc(label);
    const clean = href.split(/[?#]/)[0].toLowerCase();
    if (/\.(mp4|webm|mov)$/.test(clean)) return hold(`<video controls preload="metadata" src="${esc(href)}"></video>`);
    if (/\.(mp3|wav|m4a|ogg)$/.test(clean)) return hold(`<audio controls preload="metadata" src="${esc(href)}"></audio>`);
    if (/\.(svg|webp|gif|png|jpe?g)$/.test(clean)) return hold(`<img src="${esc(href)}" alt="${esc(label)}" loading="lazy">`);
    if (/\.html?$/.test(clean)) return hold(`<span class="embed-html"><iframe src="${esc(href)}" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe><a class="embed-open" href="${esc(href)}" target="_blank" rel="noopener noreferrer">↗ 新窗口打开 ${esc(label)}</a></span>`);
    return hold(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`);
  });
  text = esc(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)] || "");
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((v) => v.trim());
}

function renderMarkdown(raw) {
  const lines = String(raw || "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const code = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      if (fence[1] === "mermaid") html.push(`<div class="mermaid-block" data-src="${encodeURIComponent(code.join("\n"))}"></div>`);
      else html.push(`<pre><code${fence[1] ? ` class="language-${esc(fence[1])}"` : ""}>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (i + 1 < lines.length && line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const heads = tableCells(line); const rows = []; i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(tableCells(lines[i++]));
      html.push(`<table><thead><tr>${heads.map((v) => `<th>${inlineMarkdown(v)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${heads.map((_, n) => `<td>${inlineMarkdown(r[n] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { const n = heading[1].length; html.push(`<h${n}>${inlineMarkdown(heading[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { html.push("<hr>"); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const parts = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) parts.push(lines[i++].replace(/^\s*>\s?/, ""));
      html.push(`<blockquote>${parts.map(inlineMarkdown).join("<br>")}</blockquote>`); continue;
    }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const tag = ordered ? "ol" : "ul", items = [];
      const re = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/;
      while (i < lines.length) { const m = lines[i].match(re); if (!m) break; items.push(m[1]); i++; }
      html.push(`<${tag}>${items.map((v) => `<li>${inlineMarkdown(v)}</li>`).join("")}</${tag}>`); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s+|^```|^\s*>|^\s*[-+*]\s+|^\s*\d+[.)]\s+/.test(lines[i])) paragraph.push(lines[i++]);
    html.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
  }
  return `<div class="md-render">${html.join("")}</div>`;
}

// ---- mermaid 流程图 + KaTeX 公式：按需懒加载 CDN，失败则降级显示原文 ----
let _mermaidP = null, _katexP = null;
function loadMermaid() {
  if (_mermaidP) return _mermaidP;
  _mermaidP = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    s.onload = () => { try { window.mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" }); } catch {} res(window.mermaid); };
    s.onerror = () => rej(new Error("mermaid CDN 加载失败"));
    document.head.appendChild(s);
  });
  return _mermaidP;
}
function loadKatex() {
  if (_katexP) return _katexP;
  _katexP = new Promise((res, rej) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css"; document.head.appendChild(css);
    const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
    s.onload = () => res(window.katex); s.onerror = () => rej(new Error("katex CDN 加载失败"));
    document.head.appendChild(s);
  });
  return _katexP;
}
// 在 innerHTML 落地后调用：把 .math 渲成公式、.mermaid-block 渲成图。CDN 挂了就降级成原文。
async function enhanceRichContent(root) {
  if (!root) return;
  const maths = root.querySelectorAll(".math[data-tex]:not([data-rendered])");
  if (maths.length) {
    loadKatex().then((katex) => {
      maths.forEach((el) => {
        el.setAttribute("data-rendered", "1");
        const tex = decodeURIComponent(el.dataset.tex || "");
        try { katex.render(tex, el, { displayMode: el.dataset.display === "1", throwOnError: false }); }
        catch { el.textContent = tex; }
      });
    }).catch(() => maths.forEach((el) => { el.setAttribute("data-rendered", "1"); el.textContent = decodeURIComponent(el.dataset.tex || ""); }));
  }
  const blocks = root.querySelectorAll(".mermaid-block[data-src]:not([data-rendered])");
  if (blocks.length) {
    loadMermaid().then(async (mermaid) => {
      for (const el of blocks) {
        el.setAttribute("data-rendered", "1");
        const src = decodeURIComponent(el.dataset.src || "");
        try { const { svg } = await mermaid.render("mmd-" + Math.random().toString(36).slice(2), src); el.innerHTML = svg; }
        catch { el.innerHTML = `<pre><code>${esc(src)}</code></pre>`; }
      }
    }).catch(() => blocks.forEach((el) => { el.setAttribute("data-rendered", "1"); el.innerHTML = `<pre><code>${esc(decodeURIComponent(el.dataset.src || ""))}</code></pre>`; }));
  }
}

function renderOutput(el, raw) {
  if (!el) return;
  el.dataset.raw = String(raw || "");
  el.innerHTML = renderMarkdown(raw);
  enhanceRichContent(el);
}

function renderOriginalHistoryInto(el, memberId) {
  if (!el) return;
  const calls = memberOutputHistory[memberId] || [];
  const entries = [];
  for (const call of calls) {
    const segments = call.segments?.length ? call.segments : (call.live ? [call.live] : []);
    segments.forEach((raw, segmentIndex) => {
      entries.push({
        raw: String(raw || ""),
        label: `第 ${call.callIndex} 次出战 · 原文${segments.length > 1 ? ` ${segmentIndex + 1}` : ""}`,
      });
    });
  }
  if (!entries.length && runOutputs[memberId]) {
    entries.push({ raw: String(runOutputs[memberId]), label: "本轮输出原文" });
  }
  el.dataset.raw = entries.map((entry) => entry.raw).join("\n\n");
  el.innerHTML = entries.length
    ? entries.map((entry) => `<section class="original-segment"><div class="original-label">${esc(entry.label)}</div>${renderMarkdown(entry.raw)}</section>`).join("")
    : renderMarkdown("（尚未输出正文）");
  enhanceRichContent(el);
}

function renderMemberOriginals(memberId) {
  const out = $(`out-${memberId}`);
  const shell = $(`outshell-${memberId}`);
  renderOriginalHistoryInto(out, memberId);
  if (shell && (memberOutputHistory[memberId]?.some((call) => call.live || call.segments?.length))) shell.classList.add("show");
}

function openOutputModal(targetId, title) {
  const source = $(targetId);
  if (!source) return;
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `<div class="modal output-modal">
    <div class="modal-head"><h3>${esc(title || "成员交付")}</h3><button class="x" data-close>✕</button></div>
    <div class="modal-body" id="output-modal-body"></div>
  </div>`;
  document.body.appendChild(mask);
  const memberId = targetId.startsWith("out-") ? targetId.slice(4) : "";
  if (memberId && memberOutputHistory[memberId]?.length) renderOriginalHistoryInto(mask.querySelector("#output-modal-body"), memberId);
  else renderOutput(mask.querySelector("#output-modal-body"), source.dataset.raw || "");
  const close = () => mask.remove();
  mask.addEventListener("click", (e) => { if (e.target === mask || e.target.dataset.close !== undefined) close(); });
}
function openTextModal(title, raw) {
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `<div class="modal output-modal">
    <div class="modal-head"><h3>${esc(title || "详情")}</h3><button class="x" data-close>✕</button></div>
    <div class="modal-body" id="text-modal-body"></div>
  </div>`;
  document.body.appendChild(mask);
  renderOutput(mask.querySelector("#text-modal-body"), raw || "（无内容）");
  const close = () => mask.remove();
  mask.addEventListener("click", (e) => { if (e.target === mask || e.target.dataset.close !== undefined) close(); });
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-expand-output]");
  if (btn) openOutputModal(btn.dataset.expandOutput, btn.dataset.outputTitle);
});

let errHideTimer = null;
function showError(msg) {
  const e = $("error");
  if (errHideTimer) { clearTimeout(errHideTimer); errHideTimer = null; }
  if (!msg) { e.style.display = "none"; e.innerHTML = ""; return; }
  e.textContent = String(msg);
  e.style.display = "block";
  e.title = "点击关闭";
  e.onclick = () => showError("");
  errHideTimer = setTimeout(() => showError(""), 6000); // 顶部提示，6 秒后自动消失，点击也可关
}

/* ============ 已保存团队 ============ */
let cachedTeamList = [];
let allTeamCursor = 0;
const ALL_TEAM_BATCH = 9;
let activeSpecSource = "team"; // team=已拥有团队；run=执行历史快照，不能写回「所有团队」
let currentRunStatus = "";
let attachedRunReplayOnly = false;
let streamReplaying = false; // 正在回放历史事件（含运行中重连时的历史段）→ 瞬显不打字机；收到 replay_done 后才转实时
let currentRunErrorText = "";
let historyRenameEditing = false;
let currentDangerOps = [];
let battleDashboardRunId = "";
let finalMetaState = { deliveryMember: null, missingMembers: [], usage: null, usageReady: false };

function setRunError(text = "") {
  currentRunErrorText = String(text || "");
  const btn = $("run-error-link");
  if (!btn) return;
  btn.classList.toggle("show", !!currentRunErrorText);
  btn.onclick = currentRunErrorText ? () => openTextModal("报错信息", currentRunErrorText) : null;
}
function clearHistorySelection() {
  document.querySelectorAll(".rs-run.active").forEach((el) => el.classList.remove("active"));
}
// 立刻把侧栏选中高亮移到指定运行项（运行中的记录其流会一直开着，不能等 loadRunsSidebar 才更新高亮）
function highlightActiveRun(runId) {
  clearHistorySelection();
  if (!runId) return;
  const el = document.querySelector(`.rs-run[data-run="${CSS.escape(runId)}"]`);
  if (el) {
    el.classList.add("active");
    // 若所在分组是折叠的，展开它，确保选中可见
    const grp = el.closest("details.rs-team");
    if (grp && !grp.open) grp.open = true;
  }
}
function setBattleDashboardActive(active) {
  $("battle-dashboard-link")?.classList.toggle("active", !!active);
}
function hideBattleDashboard() {
  const board = $("battle-dashboard");
  if (board) board.style.display = "none";
  setBattleDashboardActive(false);
}
function dedupeDangerOps(list = []) {
  const seen = new Set();
  return list.filter((op) => {
    const key = `${op.source}|${op.title}|${op.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function renderDangerChip() {
  const chip = $("danger-chip");
  if (!chip) return;
  currentDangerOps = [];
  chip.classList.remove("show");
  chip.onclick = null;
}
function refreshTaskDanger() {
  renderDangerChip();
}
function resetRuntimeDanger() {
  renderDangerChip();
}
function openDangerDetails() {
  if (!currentDangerOps.length) return;
  const body = currentDangerOps.map((op, i) =>
    `${i + 1}. ${op.title}\n来源：${op.source}\n${op.detail}`
  ).join("\n\n");
  openTextModal("危险操作", body);
}

function memberRisk(a = {}) {
  const raw = a.risk && typeof a.risk === "object" && !Array.isArray(a.risk) ? a.risk : {};
  const operations = Array.isArray(raw.operations)
    ? raw.operations.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 5)
    : [];
  const summary = String(raw.summary || "").trim();
  return String(raw.level || "").toLowerCase() === "danger" && (summary || operations.length)
    ? { summary: summary || operations[0] || "包含高危操作", operations }
    : null;
}
function memberRiskButton(a = {}) {
  return memberRisk(a)
    ? `<button type="button" class="member-risk" data-member-risk="${esc(a.id)}" title="查看具体危险操作">危险</button>`
    : "";
}
function openMemberRisk(id) {
  const a = spec?.agents?.find((x) => x.id === id);
  const risk = a ? memberRisk(a) : null;
  if (!a || !risk) return;
  const ops = risk.operations.length
    ? "\n\n具体危险操作：\n" + risk.operations.map((op, i) => `${i + 1}. ${op}`).join("\n")
    : "";
  openTextModal("危险操作", `成员：${a.name}\n危险：${risk.summary}${ops}`);
}

function createdTimeFromId(id) {
  const raw = String(id || "");
  if (!/^t[a-z0-9]+$/.test(raw)) return 0;
  const n = parseInt(raw.slice(1), 36);
  return Number.isFinite(n) && n > 946684800000 && n < 4102444800000 ? n : 0;
}
function teamTimeValue(t) {
  const created = Date.parse(t.created_at || "") || createdTimeFromId(t.id);
  const updated = Date.parse(t.updated_at || "");
  return created || updated || 0;
}
function formatTeamTime(t) {
  const ms = teamTimeValue(t);
  if (!ms) return "时间未知";
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}
function sortedTeams(list) {
  return [...(list || [])].sort((a, b) => teamTimeValue(b) - teamTimeValue(a));
}
function teamOriginLabel(origin = {}) {
  const mode = String(origin.mode || "").toLowerCase();
  if (mode === "mixed") return "文字点将 + Skill 导入";
  if (mode === "skill") return "Skill 导入";
  if (mode === "text") return "文字点将";
  return "来源未知";
}
function teamOriginDetail(t = {}) {
  const origin = t.origin || {};
  const paths = Array.isArray(origin.skill_paths) ? origin.skill_paths.filter(Boolean) : [];
  const text = String(origin.text || "").trim();
  const lines = [`来源：${teamOriginLabel(origin)}`];
  if (paths.length) {
    lines.push("", "Skill 路径：", ...paths.map((p) => `- ${p}`));
  }
  if (text) {
    lines.push("", "文字输入：", text);
  }
  if (!paths.length && !text) {
    lines.push("", "这个团队是较早创建的记录，暂时没有保存来源详情。");
  }
  return lines.join("\n");
}
function teamMemberIconsHtml(t = {}) {
  const agents = Array.isArray(t.dag) ? t.dag.map((a, i) => ({
    id: String(a.id || `agent-${i + 1}`),
    name: String(a.name || a.id || `agent-${i + 1}`),
    emoji: String(a.emoji || "🤖"),
  })) : [];
  if (!agents.length) return "";
  return `<span class="team-member-icons" aria-label="团队成员">` + agents.map((a) =>
    `<span class="team-member-icon" data-tip="${esc(a.name)}" data-tip-kind="member" aria-label="${esc(a.name)}">${esc(a.emoji || "🤖")}</span>`
  ).join("") + `</span>`;
}
function teamCardHtml(t, mode = "team") {
  const agentCount = Number(t.agents || (Array.isArray(t.dag) ? t.dag.length : 0) || 0);
  const status = mode === "history" ? "成功" : `${agentCount} 名成员`;
  const name = t.team_name || "未命名团队";
  const memberIconsHtml = teamMemberIconsHtml(t);
  return `<div class="team-card${memberIconsHtml ? " has-members" : ""}" role="button" tabindex="0" data-open-team="${esc(t.id)}" aria-label="打开团队 ${esc(name)}">
    <span class="team-avatar">${esc(t.emoji || "⚔")}</span>
    <span class="team-card-main">
      <span class="team-origin-wrap">
        <span class="team-card-name" data-tip="${esc(teamOriginDetail(t))}" data-tip-kind="origin">${esc(name)}</span>
      </span>
      <span class="team-card-meta">${esc(formatTeamTime(t))} · ${esc(agentCount)} 人</span>
      <span class="team-card-status">${mode === "history" ? "● 执行状态" : "● 团队状态"} · ${esc(status)}</span>
    </span>
    ${memberIconsHtml}
    <button type="button" class="team-del" data-del-team="${esc(t.id)}" title="删除团队" aria-label="删除团队 ${esc(name)}">×</button>
  </div>`;
}
function historyItemHtml(t) {
  return `<button class="history-item" data-open-team="${esc(t.id)}" title="${esc(t.team_name || "未命名团队")}">
    <span class="history-icon">${esc(t.emoji || "⚔")}</span>
    <span>
      <span class="history-name">${esc(t.team_name || "未命名团队")}</span>
      <span class="history-meta">${esc(formatTeamTime(t))} · 成功 · ${esc(t.agents || 0)}人</span>
    </span>
  </button>`;
}
async function openTeamById(id) {
  const seq = ++openRunSeq;
  if (runAbort) { runAbort.abort(); runAbort = null; }
  clearHistorySelection();
  const t = await (await fetch("/api/teams/" + id, { cache: "no-store" })).json();
  if (seq !== openRunSeq) return;
  if (t.error) return showError(t.error);
  resetRunState(); // 切团队前清空运行态，避免与上一个团队串台
  spec = t;
  activeSpecSource = "team";
  renderTeam();
  markSaved("已载入");
}
async function deleteTeamById(id) {
  if (!confirm("删除这个团队？")) return;
  await fetch("/api/teams/" + id, { method: "DELETE" });
  // 删的是当前正在展示的团队：清空并收起团队页，避免页面停在已删团队
  if (spec && spec.id === id) {
    clearTimeout(saveTimer); // 防止 stale spec 被防抖 autoSave 又写回磁盘
    spec = null;
    $("team").style.display = "none";
    $("final").style.display = "none";
    hideBlueprint();
  }
  await loadTeamList();
}
function renderTeamListPanels(reset = true) {
  const bar = $("saved-bar");
  const all = $("saved-chips");
  const count = $("all-teams-count");
  const tip = $("team-load-tip");
  const teams = sortedTeams(cachedTeamList);
  if (bar) bar.style.display = "block";
  // #history-list 现在是「出征运行记录」，由 loadRunsSidebar 维护，不再塞团队
  if (reset) {
    allTeamCursor = 0;
    if (all) all.innerHTML = "";
  }
  const next = teams.slice(allTeamCursor, allTeamCursor + ALL_TEAM_BATCH);
  if (all && !teams.length) all.innerHTML = '<div class="team-empty">暂无团队</div>';
  else if (all && next.length) all.insertAdjacentHTML("beforeend", next.map((t) => teamCardHtml(t)).join(""));
  allTeamCursor += next.length;
  if (count) count.textContent = `${teams.length} 支团队 · 新前老后`;
  if (tip) tip.textContent = allTeamCursor < teams.length ? "继续向下滚动加载更多" : (teams.length ? "已显示全部团队" : "");
}
async function loadTeamList() {
  try {
    cachedTeamList = sortedTeams(await (await fetch("/api/teams", { cache: "no-store" })).json());
    renderTeamListPanels(true);
  } catch {}
}
function scheduleRunsSidebarLoad() {
  const body = $("history-list");
  if (body && !body.querySelector(".rs-team,.rs-run")) body.innerHTML = '<div class="rs-empty">历史记录加载中…</div>';
  setTimeout(loadRunsSidebar, 0);
  setTimeout(loadRunsSidebar, 350);
  setTimeout(loadRunsSidebar, 1200);
}
function bootInitialLists() {
  loadTeamList();
  const history = $("history-list");
  if (history) history.innerHTML = '<div class="rs-empty">历史记录加载中…</div>';
  // 等整段脚本完成初始化后再拉历史；再补拉一次，避免首次打开偶发空白。
  scheduleRunsSidebarLoad();
}
bootInitialLists();
$("history-refresh")?.addEventListener("click", () => loadRunsSidebar());
window.addEventListener("pageshow", () => scheduleRunsSidebarLoad());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleRunsSidebarLoad();
});
$("saved-chips")?.addEventListener("scroll", (e) => {
  const el = e.currentTarget;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) renderTeamListPanels(false);
});
document.addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del-team]");
  if (del) {
    e.preventDefault();
    e.stopPropagation();
    await deleteTeamById(del.dataset.delTeam);
    return;
  }
  const card = e.target.closest("[data-open-team]");
  if (card) await openTeamById(card.dataset.openTeam);
});
document.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  if (e.target.closest("[data-del-team]")) return;
  const card = e.target.closest(".team-card[data-open-team]");
  if (!card) return;
  e.preventDefault();
  await openTeamById(card.dataset.openTeam);
});

let activeTeamTipAnchor = null;
let teamTipTimer = null;
let teamTipHideTimer = null;
let lastTeamTipPoint = { x: 0, y: 0 };
let activeTeamTipPayload = null;
const TEAM_TIP_DELAY = 300;
function ensureTeamHoverTip() {
  let tip = document.getElementById("team-hover-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "team-hover-tip";
    tip.className = "team-hover-tip";
    document.body.appendChild(tip);
    tip.addEventListener("mouseenter", () => clearTeamTipHideTimer());
    tip.addEventListener("mouseleave", () => hideTeamHoverTip());
  }
  return tip;
}
function clearTeamTipTimer() {
  if (teamTipTimer) {
    clearTimeout(teamTipTimer);
    teamTipTimer = null;
  }
}
function clearTeamTipHideTimer() {
  if (teamTipHideTimer) {
    clearTimeout(teamTipHideTimer);
    teamTipHideTimer = null;
  }
}
function pointFromEvent(e, anchor) {
  if (e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY) && (e.clientX || e.clientY)) {
    return { x: e.clientX, y: e.clientY };
  }
  const r = anchor.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function placeTeamHoverTipAt(point, tip) {
  const margin = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = point.x - tw / 2;
  let top = point.y - th - 12;
  if (top < margin) top = point.y + 18;
  left = Math.max(margin, Math.min(left, vw - tw - margin));
  top = Math.max(margin, Math.min(top, vh - th - margin));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}
function hoverPayloadFromAnchor(anchor, payload = null) {
  if (payload) return payload;
  const text = anchor?.dataset?.tip || "";
  return { text, kind: anchor?.dataset?.tipKind || "origin" };
}
function showTeamHoverTip(anchor, point = lastTeamTipPoint, payload = activeTeamTipPayload) {
  payload = hoverPayloadFromAnchor(anchor, payload);
  const hasHtml = payload.html != null && String(payload.html).trim();
  const text = String(payload.text || "");
  if (!hasHtml && !text.trim()) return;
  const kind = payload.kind || "origin";
  const tip = ensureTeamHoverTip();
  activeTeamTipAnchor = anchor;
  if (hasHtml) tip.innerHTML = String(payload.html);
  else tip.textContent = text;
  tip.className = `team-hover-tip show ${kind}`;
  tip.style.left = "-9999px";
  tip.style.top = "-9999px";
  requestAnimationFrame(() => {
    if (activeTeamTipAnchor === anchor) placeTeamHoverTipAt(point, tip);
  });
}
function hideTeamHoverTip(anchor = null) {
  if (anchor && activeTeamTipAnchor !== anchor) return;
  clearTeamTipTimer();
  clearTeamTipHideTimer();
  activeTeamTipAnchor = null;
  activeTeamTipPayload = null;
  const tip = document.getElementById("team-hover-tip");
  if (tip) tip.className = "team-hover-tip";
}
function scheduleHideTeamHoverTip(anchor = null) {
  const tip = document.getElementById("team-hover-tip");
  if (!tip?.classList.contains("show")) {
    hideTeamHoverTip(anchor);
    return;
  }
  if (anchor && activeTeamTipAnchor !== anchor) return;
  clearTeamTipHideTimer();
  teamTipHideTimer = setTimeout(() => hideTeamHoverTip(anchor), 300);
}
function scheduleTeamHoverTip(anchor, e = null, payload = null) {
  clearTeamTipTimer();
  clearTeamTipHideTimer();
  activeTeamTipAnchor = anchor;
  activeTeamTipPayload = hoverPayloadFromAnchor(anchor, payload);
  lastTeamTipPoint = pointFromEvent(e, anchor);
  teamTipTimer = setTimeout(() => {
    teamTipTimer = null;
    if (activeTeamTipAnchor === anchor) showTeamHoverTip(anchor, lastTeamTipPoint, activeTeamTipPayload);
  }, TEAM_TIP_DELAY);
}
function moveTeamHoverTip(anchor, e) {
  if (!anchor || activeTeamTipAnchor !== anchor) return;
  const tip = document.getElementById("team-hover-tip");
  if (tip?.classList.contains("show")) return;
  lastTeamTipPoint = pointFromEvent(e, anchor);
}
function leaveTeamHoverTip(anchor, relatedTarget = null) {
  if (!anchor) return;
  if (relatedTarget && anchor.contains(relatedTarget)) return;
  const tip = document.getElementById("team-hover-tip");
  if (tip && relatedTarget && tip.contains(relatedTarget)) return;
  scheduleHideTeamHoverTip(anchor);
}
document.addEventListener("mouseover", (e) => {
  const anchor = e.target.closest("[data-tip]");
  if (anchor) scheduleTeamHoverTip(anchor, e);
});
document.addEventListener("mousemove", (e) => {
  const anchor = e.target.closest("[data-tip]");
  moveTeamHoverTip(anchor, e);
});
document.addEventListener("mouseout", (e) => {
  const anchor = e.target.closest("[data-tip]");
  leaveTeamHoverTip(anchor, e.relatedTarget);
});
document.addEventListener("focusin", (e) => {
  const anchor = e.target.closest("[data-tip]");
  if (anchor) scheduleTeamHoverTip(anchor, null);
});
document.addEventListener("focusout", (e) => {
  const anchor = e.target.closest("[data-tip]");
  if (anchor) hideTeamHoverTip(anchor);
});
window.addEventListener("resize", () => hideTeamHoverTip());
document.addEventListener("scroll", (e) => {
  const tip = document.getElementById("team-hover-tip");
  if (tip && (e.target === tip || tip.contains(e.target))) return;
  hideTeamHoverTip();
}, true);

const toolLabel = (n) => (META.tools.find((t) => t.name === n)?.label) || n;
const modelEntries = () => Array.isArray(META.models) ? META.models : [];
const modelById = (id) => modelEntries().find((m) => m.id === id);
const modelIds = () => modelEntries().map((m) => m.id);
function defaultModelLabel() {
  return META.default_model_label || modelById(META.default_model)?.label || META.default_model || "系统模型";
}
function providerName(p) {
  return ({ "ollama": "Ollama", "bailian": "百炼", "anthropic": "Anthropic", "codex-cli": "Codex", "claude-code": "Claude Code", "mock": "演示" })[p] || p || "";
}
function modelOptionText(entry) {
  if (!entry) return "";
  const same = modelEntries().filter((m) => m.label === entry.label);
  return same.length > 1 ? `${entry.label} · ${providerName(entry.provider)}` : entry.label;
}
// 成员"继承默认"时实际拿到的模型 = 团队主模型 || 系统默认
const teamDefaultModel = () => (spec && spec.main_model) || META.default_model || "系统模型";
const teamDefaultModelLabel = () => spec && spec.main_model ? modelDescriptor(spec.main_model).name : defaultModelLabel();
const explicitMemberModelCount = () => spec ? spec.agents.filter((a) => a.model).length : 0;
function syncInheritedMemberModels(prevMain, prevInherited) {
  if (!spec) return 0;
  let n = 0;
  for (const a of spec.agents) {
    // 老团队常把“继承将军模型”落成了和将军相同的显式值；切将军时应恢复成继承。
    if (a.model && (a.model === prevMain || a.model === prevInherited)) {
      a.model = "";
      n++;
    }
  }
  return n;
}
// 模型下拉选项 HTML：第一项是"系统默认"，其余是候选；selected 命中当前值
function modelOptions(current, defaultLabel) {
  const opts = [`<option value="">${esc(defaultLabel || "默认·" + defaultModelLabel())}</option>`];
  for (const entry of modelEntries()) {
    opts.push(`<option value="${esc(entry.id)}"${entry.id === current ? " selected" : ""}>${esc(modelOptionText(entry))}</option>`);
  }
  // 当前值若是候选外的自定义模型，也补一个选项
  if (current && !modelById(current)) opts.splice(1, 0, `<option value="${esc(current)}" selected>${esc(modelDescriptor(current).name)}</option>`);
  return opts.join("");
}
// 军师模型自定义弹层：每行 图标+名称+标签+描述；底层仍写隐藏的 #design-model（取值逻辑不变）
function modelDescriptor(id) {
  if (!id) return { name: "默认（系统模型）", desc: "用配置中心设的系统默认：" + defaultModelLabel() };
  const entry = modelById(id);
  if (entry) return {
    name: entry.label || entry.name || id,
    badge: entry.badge || providerName(entry.provider),
    badgeCls: entry.badgeCls || "",
    desc: entry.desc || `${providerName(entry.provider)} · ${entry.model || "默认模型"}`,
  };
  const m = id.toLowerCase();
  if (m.startsWith("claude-code") || m.startsWith("cc:")) return { name: id, badge: "订阅", badgeCls: "sub", desc: "Claude Code 订阅 · 自主工具强 · 思考原文不回传" };
  if (m === "codex" || m.startsWith("codex") || m.startsWith("openai-codex")) return { name: id, badge: "订阅", badgeCls: "sub", desc: "Codex（ChatGPT 订阅）· 自主能力强 · 思考原文不回传" };
  if (m.startsWith("claude") || m.includes("anthropic")) return { name: id, badge: "API", badgeCls: "api", desc: "Anthropic API · 思考可见（需 API key）" };
  if (m.startsWith("bailian:") || m.startsWith("dashscope:")) return { name: id, badge: "百炼", badgeCls: "bl", desc: "阿里百炼 · 推理模型思考可见（需 DashScope key）" };
  if (m.startsWith("ollama:")) return { name: id, badge: m.endsWith(":cloud") ? "Ollama Cloud" : "Ollama", badgeCls: "api", desc: "Ollama 模型 · 显式走 Ollama 协议" };
  if ((META.provider || "").toLowerCase() === "bailian") return { name: id, badge: "百炼", badgeCls: "bl", desc: "裸模型名跟随当前 provider：阿里百炼" };
  if (m.endsWith(":cloud")) return { name: id, badge: "Ollama Cloud", badgeCls: "api", desc: "Ollama 云端模型 · 需要 Ollama 订阅/账号权限；无权限会返回 upgrade 错误" };
  return { name: id, badge: "可见思考", badgeCls: "think", desc: "本地 Ollama · 推理模型思考过程可见" };
}
function updateMpCurrent() {
  const cur = $("design-model")?.value || "";
  const el = $("mp-current");
  if (el) el.textContent = cur ? modelDescriptor(cur).name : ("默认·" + defaultModelLabel());
}
function renderModelPop() {
  const pop = $("mp-pop"); if (!pop) return;
  const cur = $("design-model")?.value || "";
  pop.innerHTML = `<div class="mp-title">军师模型偏好</div>` + ["", ...modelIds()].map((id) => {
    const d = modelDescriptor(id);
    return `<div class="mp-item${id === cur ? " sel" : ""}" data-val="${esc(id)}">
      <span class="mp-ico">📊</span>
      <span class="mp-main"><span class="mp-name">${esc(d.name)}${d.badge ? ` <span class="mp-badge ${d.badgeCls || ""}">${esc(d.badge)}</span>` : ""}</span>
      <span class="mp-desc">${esc(d.desc)}</span></span>
      ${id === cur ? '<span class="mp-check">✓</span>' : ""}</div>`;
  }).join("");
  pop.querySelectorAll(".mp-item").forEach((el) => el.addEventListener("click", () => {
    const dm = $("design-model");
    if (dm) { dm.value = el.dataset.val; dm.dispatchEvent(new Event("change")); }
    updateMpCurrent();
    pop.hidden = true;
  }));
}
$("mp-trigger")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("mp-pop"); if (!pop) return;
  if (pop.hidden) renderModelPop();
  pop.hidden = !pop.hidden;
});
document.addEventListener("click", (e) => {
  const pop = $("mp-pop");
  if (pop && !pop.hidden && !$("design-model-wrap")?.contains(e.target)) pop.hidden = true;
});
async function loadMeta() {
  try { META = await (await fetch("/api/meta", { cache: "no-store" })).json(); } catch {}
  // 编辑器里的模型输入框共用的候选
  let dl = $("model-suggestions");
  if (!dl) { dl = document.createElement("datalist"); dl.id = "model-suggestions"; document.body.appendChild(dl); }
  dl.innerHTML = modelEntries().map((m) => `<option value="${esc(m.id)}" label="${esc(modelOptionText(m))}">`).join("");
  // 点将（军师/架构师）模型选择器：记住你的显式选择；若该模型已不可用则回落到系统默认（避免残留失效值）
  const dm = $("design-model");
  if (dm) {
    let saved = localStorage.getItem("designModel") || "";
    if (saved && !modelById(saved)) saved = ""; // 失效自愈
    dm.innerHTML = modelOptions(saved, "默认·" + defaultModelLabel());
    dm.value = saved;
    dm.classList.toggle("custom", !!saved);
    updateMpCurrent();
  }
  if (spec) renderAll();
}
loadMeta();
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "design-model") {
    e.target.classList.toggle("custom", !!e.target.value); // 仅本次会话临时切换，不持久化
    updateMpCurrent();
  }
});
try { localStorage.removeItem("designModel"); } catch {} // 清掉历史遗留的军师模型，避免一直默认成旧选择

/* ============ 配置中心 ============ */
$("btn-config")?.addEventListener("click", openConfig);
document.querySelectorAll("[data-open-config]").forEach((el) => el.addEventListener("click", openConfig));

// 侧栏折叠 / 展开
function setSidebar(collapsed) {
  const shell = document.querySelector(".app-shell");
  shell?.classList.toggle("sidebar-collapsed", collapsed);
  const re = $("side-reopen");
  if (re) {
    re.textContent = "◰";
    re.title = "展开侧栏";
    re.setAttribute("aria-label", "展开侧栏");
    re.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
  if (!collapsed) scheduleRunsSidebarLoad();
}
$("side-collapse")?.addEventListener("click", () => setSidebar(true));
$("side-reopen")?.addEventListener("click", () => setSidebar(!document.querySelector(".app-shell")?.classList.contains("sidebar-collapsed")));
setSidebar(false);

// 侧栏左右拖拽调宽：最小宽度 = 初始宽度 260px，最大不超过半屏；记住上次宽度。
(function setupSidebarResize() {
  const shell = document.querySelector(".app-shell");
  const handle = $("side-resizer");
  if (!shell || !handle) return;
  const MIN = 260; // 初始化宽度即最小宽度
  const maxW = () => Math.max(MIN, Math.round(window.innerWidth * 0.5));
  const apply = (w) => shell.style.setProperty("--side-w-expanded", Math.max(MIN, Math.min(maxW(), w)) + "px");
  const saved = parseInt(localStorage.getItem("sideW") || "", 10);
  if (saved && saved > MIN) apply(saved);
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.classList.add("dragging");
    shell.classList.add("side-resizing");
    try { handle.setPointerCapture(e.pointerId); } catch {}
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("pointermove", (e) => { if (dragging) apply(e.clientX); });
  window.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    shell.classList.remove("side-resizing");
    document.body.style.userSelect = "";
    const w = parseInt(getComputedStyle(shell).getPropertyValue("--side-w-expanded"), 10) || MIN;
    localStorage.setItem("sideW", String(w));
  });
})();
async function openConfig() {
  let data;
  try { data = await (await fetch("/api/config", { cache: "no-store" })).json(); }
  catch (e) { return showError("打开配置中心失败：" + e.message); }
  const field = (f) => {
    const v = esc(data.values[f.key] || "");
    const input = f.secret
      ? `<div class="with-eye"><input type="password" data-cfg="${esc(f.key)}" value="${v}"><button type="button" class="eye" data-eye>👁</button></div>`
      : `<input type="text" data-cfg="${esc(f.key)}" value="${v}">`;
    return `<div class="cfg-field"><label>${esc(f.label)} <span class="hint">— ${esc(f.hint)}</span></label>${input}</div>`;
  };
  const sections = (data.groups || []).map((g) => {
    let note = g.note ? `<div class="cfg-note">${esc(g.note)}</div>` : "";
    if (g.group === "claude-code") note += `<div class="cfg-note">${data.claude_cli ? "✅ 已检测到 claude CLI（订阅可用）" : "⚠ 未检测到 claude CLI——请在终端先 `claude login`"}</div>`;
    if (g.group === "codex-cli") {
      const status = !data.codex_cli
        ? "⚠ 未检测到 Codex CLI，请先安装并执行 `codex login`"
        : data.codex_login
          ? "✅ 已检测到 Codex CLI，ChatGPT 订阅登录有效"
          : "⚠ 已检测到 Codex CLI，但尚未登录，请先执行 `codex login`";
      note += `<div class="cfg-note">${status}</div>`;
    }
    return `<div class="cfg-group"><div class="cfg-group-h">${esc(g.label)}</div>${note}${g.fields.map(field).join("")}</div>`;
  }).join("");
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>⚙ 配置中心 · 系统配置</h3><button class="x" data-close>✕</button></div>
    <div class="modal-body"><div class="modal-path">📄 ${esc(data.config_path)}　·　用户级凭证（如 ElevenLabs key）不在此处</div>${sections}</div>
    <div class="modal-foot"><button class="btn" data-save>保存并生效</button><button class="btn ghost" data-close>关闭</button><span class="msg" id="cfg-msg"></span></div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener("click", (e) => { if (e.target === mask || e.target.dataset.close !== undefined) close(); });
  mask.querySelectorAll("[data-eye]").forEach((b) => b.addEventListener("click", () => {
    const inp = b.previousElementSibling; inp.type = inp.type === "password" ? "text" : "password";
  }));
  mask.querySelector("[data-save]").addEventListener("click", async () => {
    const config = {};
    mask.querySelectorAll("[data-cfg]").forEach((el) => { config[el.dataset.cfg] = el.value.trim(); });
    const msg = mask.querySelector("#cfg-msg"); msg.textContent = "保存中…";
    try {
      const r = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "保存失败");
      await loadMeta();           // 刷新默认模型 / 候选 / 真执行可用性，所有"默认·X"标签随之更新
      msg.textContent = `✓ 已生效（默认模型 ${d.default_model}，provider ${d.provider}${d.tools_enabled ? "，真执行已开" : ""}）`;
      setTimeout(close, 1400);
    } catch (e) { msg.textContent = "⚠ " + e.message; }
  });
  document.addEventListener("keydown", function esc2(ev) { if (ev.key === "Escape") { close(); document.removeEventListener("keydown", esc2); } });
}

/* ============ 团队凭证（用户级，绑团队） ============ */
$("btn-secrets").addEventListener("click", openTeamSecrets);
function updateSecretsCount() {
  const el = $("secrets-count");
  if (el) el.textContent = (spec && spec.secrets && Object.keys(spec.secrets).length) ? `(${Object.keys(spec.secrets).length})` : "";
}
function openTeamSecrets() {
  if (!spec) return;
  spec.secrets = spec.secrets || {};
  const rowHtml = (k = "", v = "") =>
    `<div class="cfg-field secret-row"><div class="with-eye">` +
    `<input class="sk-key" placeholder="键名 如 ELEVENLABS_API_KEY" value="${esc(k)}">` +
    `<input type="password" class="sk-val" placeholder="值" value="${esc(v)}">` +
    `<button type="button" class="eye" data-eye>👁</button><button type="button" class="eye sk-del" title="删除">✕</button></div></div>`;
  const ents = Object.entries(spec.secrets);
  const rows = ents.length ? ents.map(([k, v]) => rowHtml(k, v)).join("") : rowHtml();
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>🔑 团队凭证 · ${esc(spec.team_name)}</h3><button class="x" data-close>✕</button></div>
    <div class="modal-body"><div class="cfg-note">用户级凭证，绑定本团队。出征时注入到该团队工具 / Claude Code / Codex CLI 的运行环境（如 ELEVENLABS_API_KEY 给配音用）。只存在团队里，不进系统配置、不随导出。</div><div id="sk-rows">${rows}</div><button class="btn ghost" id="sk-add" style="font-size:12px">＋ 添加一条</button></div>
    <div class="modal-foot"><button class="btn" data-save>保存</button><button class="btn ghost" data-close>关闭</button><span class="msg" id="sk-msg"></span></div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener("click", (e) => { if (e.target === mask || e.target.dataset.close !== undefined) close(); });
  const bind = (root) => {
    root.querySelectorAll("[data-eye]").forEach((b) => { if (b.__b) return; b.__b = 1; b.addEventListener("click", () => { const v = b.parentElement.querySelector(".sk-val"); v.type = v.type === "password" ? "text" : "password"; }); });
    root.querySelectorAll(".sk-del").forEach((b) => { if (b.__d) return; b.__d = 1; b.addEventListener("click", () => b.closest(".secret-row").remove()); });
  };
  bind(mask);
  mask.querySelector("#sk-add").addEventListener("click", () => {
    const c = document.createElement("div"); c.innerHTML = rowHtml();
    $("sk-rows").appendChild(c.firstElementChild); bind($("sk-rows"));
  });
  mask.querySelector("[data-save]").addEventListener("click", () => {
    const sec = {};
    mask.querySelectorAll(".secret-row").forEach((r) => { const k = r.querySelector(".sk-key").value.trim(); const v = r.querySelector(".sk-val").value; if (k) sec[k] = v; });
    spec.secrets = sec; autoSave(); updateSecretsCount();
    mask.querySelector("#sk-msg").textContent = "✓ 已保存"; setTimeout(close, 800);
  });
  document.addEventListener("keydown", function e2(ev) { if (ev.key === "Escape") { close(); document.removeEventListener("keydown", e2); } });
}

let saveTimer = null;
function autoSave(immediate = false) {
  if (!spec) return;
  if (activeSpecSource === "run") {
    const el = $("save-state");
    if (el) el.textContent = "历史记录临时设置，本次再出征/续聊会使用";
    return;
  }
  $("save-state").textContent = "保存中…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const r = await fetch("/api/teams", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "保存失败");
      spec.id = d.id;
      markSaved();
      loadTeamList();
    } catch (e) { $("save-state").textContent = "⚠ " + e.message; }
  }, immediate ? 0 : 800);
}
function markSaved(word = "已保存") {
  const t = new Date();
  $("save-state").textContent = `✓ ${word} ${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}`;
}

/* ============ 点将 ============ */
async function runDesign(payload, lastTask) {
  showError("");
  const btn = $("btn-design");
  const oldBtnHtml = btn.innerHTML;
  btn.disabled = true;
  $("design-hint").innerHTML = '军师思考中… <span class="err-more" id="design-think-link">点击看思考</span>';
  resetThink("__design__");
  const link = $("design-think-link"); if (link) link.onclick = () => openThink("__design__");
  const shouldShowThink = redesignThinkingWanted || ($("team")?.style.display !== "none" && !!spec);
  if (shouldShowThink) openThink("__design__");
  try {
    const r = await fetch("/api/design", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: $("design-model")?.value || "", ...payload }),
    });
    if (!r.body) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "生成失败"); }
    const reader = r.body.getReader(); const dec = new TextDecoder();
    let buf = "", finalSpec = null, errMsg = null;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "agent_thinking") pushThink("__design__", ev.text);
        else if (ev.type === "design_done") finalSpec = ev.spec;
        else if (ev.type === "error") errMsg = ev.message;
      }
    }
    if (errMsg) throw new Error(errMsg);
    if (!finalSpec || !Array.isArray(finalSpec.agents) || !finalSpec.agents.length) throw new Error("没有生成有效的团队，请重试。");
    finalSpec.agents.forEach((a) => { if (!Array.isArray(a.depends_on)) a.depends_on = []; });
    finalSpec.last_task = lastTask || "";
    finalSpec.origin = finalSpec.origin || localTeamOriginFromPayload(payload, lastTask);
    resetRunState();
    spec = finalSpec;
    activeSpecSource = "team";
    clearHistorySelection();
    renderTeam();
    autoSave(true);
    clearImportedSkillCache();
    redesignThinkingWanted = false;
  } catch (e) { showError(e.message); }
  finally { btn.disabled = false; btn.innerHTML = oldBtnHtml || "↑"; $("design-hint").textContent = ""; }
}
$("btn-design").addEventListener("click", () => {
  const description = $("desc").value.trim();
  // JSON/skill 与输入框内容结合：两者作为整体生成；输入框空则只用导入的 skill
  if (importedSkills.length) {
    return runDesign({ skills: importedSkillPayload(), description }, description || "（由导入的 skill 生成）");
  }
  if (!description) return showError("先写一句话描述你想要的团队，或导入 skill。");
  // 一句话路径：先勘察出作战蓝图，确认后再点兵（不再一句话直接生成成员）
  runBlueprint(description);
});

/* ============ 作战蓝图（勘察 → 确认 → 点兵） ============ */
let currentBlueprint = null;     // 当前蓝图（含用户在面板里的选择）
let blueprintDesc = "";          // 生成该蓝图的那句话
function hideBlueprint() { $("blueprint").style.display = "none"; currentBlueprint = null; }

// 点将/点兵阶段的 SSE 事件：思考流 + 军师 ask_user 追问（用同一个思考对话框弹窗）
function handleDesignEvent(ev) {
  if (ev.type === "agent_thinking") { pushThink("__design__", ev.text); return; }
  if (ev.type === "ask_user") {
    const askId = ev.agent || ev.id;
    if (pendingAsk[askId] && pendingAsk[askId].qid === ev.qid) return;
    if (ev.qid && resolvedAskQids.has(ev.qid)) {
      addAskToChat(askId, { qid: ev.qid, question: ev.question });
      markThinkable(askId);
      return;
    }
    pendingAsk[askId] = { qid: ev.qid, question: ev.question };
    addAskToChat(askId, pendingAsk[askId]);
    openThink(askId, { requiresAction: true });
    return;
  }
  if (ev.type === "ask_resolved") {
    if (ev.qid) resolvedAskQids.add(ev.qid);
    delete pendingAsk[ev.agent || ev.id];
    refreshAskReopen();
    return;
  }
}

async function runBlueprint(description) {
  showError("");
  hideBlueprint();
  const btn = $("btn-design");
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>军师正在勘察…';
  $("design-hint").innerHTML = '军师勘察中… <span class="err-more" id="design-think-link">点击看思考</span>';
  resetThink("__design__");
  $("design-think-link").onclick = () => openThink("__design__");
  const shouldShowThink = redesignThinkingWanted || ($("team")?.style.display !== "none" && !!spec);
  if (shouldShowThink) openThink("__design__");
  try {
    const blueprint = await streamSSE("/api/blueprint",
      { model: $("design-model")?.value || "", description },
      handleDesignEvent,
      (ev) => ev.type === "blueprint_done" ? ev.blueprint : null);
    if (!blueprint) throw new Error("没有生成有效的蓝图，请重试。");
    blueprintDesc = description;
    renderBlueprint(blueprint);
    redesignThinkingWanted = false;
  } catch (e) { showError(e.message); }
  finally { btn.disabled = false; btn.textContent = "↑"; $("design-hint").textContent = ""; }
}

// 通用 SSE 读取：onEvent 处理每条事件；pick 返回非 null 即为最终结果；error 事件抛出
async function streamSSE(url, body, onEvent, pick) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.body) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "请求失败"); }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "", result = null, errMsg = null;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!line.startsWith("data: ")) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "error") { errMsg = ev.message; continue; }
      onEvent && onEvent(ev);
      const got = pick && pick(ev);
      if (got != null) result = got;
    }
  }
  if (errMsg) throw new Error(errMsg);
  return result;
}

function renderBlueprint(bp) {
  currentBlueprint = bp;
  const body = $("bp-body");
  const tasks = (bp.tasks || []).map((t, i) => `
    <div class="bp-task">
      <div class="tt">${i + 1}. ${esc(t.title)}</div>
      ${t.detail ? `<div class="td">${esc(t.detail)}</div>` : ""}
      ${t.acceptance ? `<div class="ta"><b>验收</b>：${esc(t.acceptance)}</div>` : ""}
    </div>`).join("");
  const tools = (bp.tools_needed || []).length
    ? (bp.tools_needed).map((t) => `<span class="bp-tool">🛠 ${esc(toolLabel(t.tool))}<span class="why">· ${esc(t.why)}</span></span>`).join("")
    : `<span class="bp-empty">这件事靠成员自身就能完成，无需真执行工具。</span>`;
  const plats = (bp.external_platforms || []).length
    ? bp.external_platforms.map((p, i) => {
        const opts = [...new Set([p.recommended, ...(p.alternatives || [])].filter(Boolean))];
        const sel = `<select data-plat="${i}">${opts.map((o) => `<option${o === p.recommended ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
        const keyRow = p.needs_credential && p.env_key
          ? `<div class="keyrow"><label>${esc(p.env_key)}</label><input type="password" data-key="${i}" placeholder="粘贴凭证（出征时注入，仅存本团队）"></div>`
          : "";
        return `<div class="bp-plat">
          <div class="cap">能力：<b>${esc(p.capability)}</b></div>
          <div class="pick">建议接入：${sel}${p.needs_credential ? ' <span class="why">需要凭证</span>' : ' <span class="why">无需凭证</span>'}</div>
          ${p.why ? `<div class="why">为什么推荐：${esc(p.why)}</div>` : ""}
          ${keyRow}
        </div>`;
      }).join("")
    : `<span class="bp-empty">纯靠模型即可完成，本方案不需要外部平台。</span>`;
  const qs = (bp.open_questions || []).length
    ? bp.open_questions.map((q, i) => `
      <div class="bp-q">
        <div class="q">❓ ${esc(q.question)}</div>
        ${q.why ? `<div class="qw">${esc(q.why)}</div>` : ""}
        <textarea data-q="${i}" placeholder="你的决定 / 补充（影响成员怎么干）">${esc(q.answer || "")}</textarea>
      </div>`).join("")
    : `<span class="bp-empty">没有需要你拍板的问题，方案已经明确。</span>`;
  body.innerHTML = `
    <div class="bp-goal">🎯 ${esc(bp.goal || blueprintDesc)}</div>
    <div class="bp-sec"><div class="bp-t">这句话其实要做这些事</div>${tasks}</div>
    <div class="bp-sec"><div class="bp-t">需要配置的工具</div>${tools}</div>
    <div class="bp-sec"><div class="bp-t">建议调用的外部平台</div>${plats}</div>
    <div class="bp-sec"><div class="bp-t">还需要你拍板</div>${qs}</div>`;
  $("blueprint").style.display = "block";
  $("bp-hint").textContent = "";
  $("blueprint").scrollIntoView({ behavior: "smooth", block: "start" });
}

// 收集用户在面板里的选择，回填进蓝图
function collectBlueprint() {
  const bp = JSON.parse(JSON.stringify(currentBlueprint));
  $("bp-body").querySelectorAll("select[data-plat]").forEach((el) => {
    const p = bp.external_platforms[+el.dataset.plat]; if (p) p.recommended = el.value;
  });
  $("bp-body").querySelectorAll("input[data-key]").forEach((el) => {
    const p = bp.external_platforms[+el.dataset.key]; if (p && el.value.trim()) p.value = el.value.trim();
  });
  $("bp-body").querySelectorAll("textarea[data-q]").forEach((el) => {
    const q = bp.open_questions[+el.dataset.q]; if (q) q.answer = el.value.trim();
  });
  return bp;
}

$("bp-cancel").addEventListener("click", () => { hideBlueprint(); $("desc").focus(); window.scrollTo({ top: 0, behavior: "smooth" }); });
$("bp-think-link").addEventListener("click", () => openThink("__design__"));
$("bp-confirm").addEventListener("click", async () => {
  const bp = collectBlueprint();
  const btn = $("bp-confirm");
  const oldBtnText = btn.textContent;
  btn.disabled = true;
  $("bp-hint").innerHTML = '军师按蓝图组队中… <span class="err-more" id="bp-think-link2">点击看思考</span>';
  resetThink("__design__");
  $("bp-think-link2").onclick = () => openThink("__design__");
  if (thinkOpenId === "__design__") renderThinkChat();
  try {
    const finalSpec = await streamSSE("/api/staff",
      { model: $("design-model")?.value || "", description: blueprintDesc, blueprint: bp },
      handleDesignEvent,
      (ev) => ev.type === "design_done" ? ev.spec : null);
    if (!finalSpec || !Array.isArray(finalSpec.agents) || !finalSpec.agents.length) throw new Error("没有生成有效的团队，请重试。");
    finalSpec.agents.forEach((a) => { if (!Array.isArray(a.depends_on)) a.depends_on = []; });
    finalSpec.last_task = blueprintDesc || "";
    finalSpec.origin = finalSpec.origin || localTeamOriginFromPayload({ description: blueprintDesc, skills: [] }, blueprintDesc);
    resetRunState();
    spec = finalSpec;
    activeSpecSource = "team";
    clearHistorySelection();
    hideBlueprint();
    $("team").style.display = "";
    renderTeam();
    autoSave(true);
    clearImportedSkillCache();
  } catch (e) { showError(e.message); $("bp-hint").textContent = ""; }
  finally { btn.disabled = false; btn.textContent = oldBtnText || "确认蓝图，开始点兵 →"; }
});

/* ============ 导入 Skill（保存后在外面可见，点将时与输入框内容合并） ============ */
// 文件/粘贴项：{kind, name, content}；文件夹项：{kind:"folder", name, files:[{name, content}]}
let importedSkills = [];
function importedSkillStats(item) {
  if (item.kind === "folder") {
    return {
      chars: item.files.reduce((n, f) => n + f.content.length, 0),
      files: item.files.length,
    };
  }
  return { chars: item.content.length, files: 1 };
}
function importedSkillPayload() {
  return importedSkills.flatMap((item) =>
    item.kind === "folder" ? item.files : [{ name: item.name, content: item.content }]
  );
}
function cleanOriginInputText(text = "") {
  const value = String(text || "").trim();
  return value === "（由导入的 skill 生成）" ? "" : value;
}
function localTeamOriginFromPayload(payload = {}, fallbackText = "") {
  const skills = Array.isArray(payload.skills) ? payload.skills : [];
  const skillPaths = [...new Set(skills.map((s) => String(s?.name || "").trim()).filter(Boolean))];
  const text = cleanOriginInputText(payload.description || fallbackText || "");
  if (!skillPaths.length && !text) return null;
  return {
    source: "design_input",
    mode: skillPaths.length && text ? "mixed" : (skillPaths.length ? "skill" : "text"),
    text,
    skill_paths: skillPaths,
    skill_count: skills.length || skillPaths.length,
  };
}
function clearImportedSkillCache() {
  importedSkills = [];
  renderImportedSkills();
}
function renderImportedSkills() {
  const host = $("imported-skills");
  if (!host) return;
  if (!importedSkills.length) { host.innerHTML = ""; return; }
  const fileCount = importedSkills.reduce((n, item) => n + importedSkillStats(item).files, 0);
  host.innerHTML = `<div class="imp-head">📥 已导入 ${importedSkills.length} 项，共 ${fileCount} 个文本文件（点将时与上方输入框内容一起生成）<button class="imp-clear" id="imp-clear">清除</button></div>`
    + importedSkills.map((item) => {
      const stat = importedSkillStats(item);
      return `<span class="imp-chip">${esc(item.name)} · ${item.kind === "folder" ? `${stat.files}个文件 · ` : ""}${stat.chars}字</span>`;
    }).join("");
  $("imp-clear").addEventListener("click", clearImportedSkillCache);
}
$("btn-import-skill").addEventListener("click", openSkillImport);
document.querySelectorAll("[data-open-skill-import]").forEach((el) => el.addEventListener("click", openSkillImport));
function openSkillImport() {
  let imported = [...importedSkills]; // 在已有基础上继续加
  let skipped = 0;
  const TEXT_RE = /\.(md|markdown|txt|js|mjs|cjs|jsx|ts|tsx|py|json|jsonc|html?|css|scss|sh|bash|zsh|yml|yaml|xml|svg|toml|ini|env|csv|tsv)$/i;
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>📥 导入 Skill</h3><button class="x" data-close>✕</button></div>
    <div class="modal-body">
      <div class="cfg-note">把外部平台的 skill（单个或多个）粘贴 / 选文件 / 选整个文件夹导入。军师只负责<b>按 skill 内部独立功能模块拆分成员与依赖</b>；完整原始 skill 会保存在团队全局 Skill 中，成员提示词只写职责边界和负责模块。<b>不按行切分、不重写、不优化、不修改命令、参数、顺序、模板和判断条件。</b></div>
      <div class="cfg-field"><label>粘贴文本（一段一个 skill）</label><textarea id="sk-paste" style="min-height:110px"></textarea></div>
      <div class="cfg-field"><label>或选择文件（可多选）</label>
        <div class="folder-picker">
          <label class="btn ghost pick-folder" for="sk-files">选择文件</label>
          <span class="folder-names" id="sk-files-names">未选择文件</span>
          <input type="file" id="sk-files" multiple>
        </div>
      </div>
      <div class="cfg-field"><label>或导入整个 skill 文件夹（文本文件全收）</label>
        <div class="folder-picker">
          <label class="btn ghost pick-folder" for="sk-folder">选择文件夹</label>
          <span class="folder-names" id="sk-folder-names">未选择文件夹</span>
          <input type="file" id="sk-folder" webkitdirectory multiple>
        </div>
      </div>
      <div id="sk-list" class="cfg-note"></div>
    </div>
    <div class="modal-foot"><button class="btn" data-save>保存</button><button class="btn ghost" data-close>关闭</button><span class="msg" id="sk-imsg"></span></div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener("click", (e) => { if (e.target === mask || e.target.dataset.close !== undefined) close(); });
  const listEl = mask.querySelector("#sk-list");
  const refreshFolderNames = () => {
    const folders = imported.filter((item) => item.kind === "folder");
    const host = mask.querySelector("#sk-folder-names");
    host.innerHTML = folders.length
      ? folders.map((item) => `<span class="folder-pill" title="${esc(item.name)}">${esc(item.name)}</span>`).join("")
      : "未选择文件夹";
  };
  const refreshFileNames = () => {
    const files = imported.filter((item) => item.kind !== "folder");
    const host = mask.querySelector("#sk-files-names");
    if (host) host.innerHTML = files.length
      ? files.map((item) => `<span class="folder-pill" title="${esc(item.name)}">${esc(item.name)}</span>`).join("")
      : "未选择文件";
  };
  const refresh = () => {
    refreshFolderNames();
    refreshFileNames();
    listEl.innerHTML = (imported.length ? "待保存：" + imported.map((item) => {
      const stat = importedSkillStats(item);
      return `${esc(item.name)}(${item.kind === "folder" ? `${stat.files}个文件，` : ""}${stat.chars}字)`;
    }).join("、") : "")
      + (skipped ? `　·　跳过 ${skipped} 个非文本文件` : "");
  };
  refresh();
  const addFiles = async (fileList, useRelPath) => {
    if (!useRelPath) {
      for (const f of fileList) {
        try { imported.push({ kind: "file", name: f.name, content: await f.text() }); } catch { skipped++; }
      }
      refresh();
      return;
    }
    const folders = new Map();
    for (const f of fileList) {
      const rel = f.webkitRelativePath || f.name;
      if (!TEXT_RE.test(rel)) { skipped++; continue; }
      const parts = rel.split("/").filter(Boolean);
      const folderName = parts.length > 1 ? parts[0] : "所选文件夹";
      if (!folders.has(folderName)) folders.set(folderName, []);
      try { folders.get(folderName).push({ name: rel, content: await f.text() }); } catch { skipped++; }
    }
    for (const [name, files] of folders) {
      if (!files.length) continue;
      const item = { kind: "folder", name, files };
      const existing = imported.findIndex((x) => x.kind === "folder" && x.name === name);
      if (existing >= 0) imported[existing] = item;
      else imported.push(item);
    }
    refresh();
  };
  mask.querySelector("#sk-files").addEventListener("change", (e) => addFiles(e.target.files, false));
  mask.querySelector("#sk-folder").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    await addFiles(files, true);
    e.target.value = ""; // 允许继续选择更多文件夹，也允许重新选择同一个文件夹
  });
  mask.querySelector("[data-save]").addEventListener("click", () => {
    const paste = mask.querySelector("#sk-paste").value.trim();
    if (paste) imported.push({ kind: "paste", name: "粘贴内容", content: paste });
    importedSkills = imported;        // 保存到外部状态
    renderImportedSkills();           // 在点将界面显示
    close();                          // 关闭窗口
  });
  document.addEventListener("keydown", function e3(ev) { if (ev.key === "Escape") { close(); document.removeEventListener("keydown", e3); } });
}

/* ============ 拓扑分层 ============ */
function topoWaves(agents) {
  const indeg = new Map(agents.map((a) => [a.id, a.depends_on.filter((d) => agents.some((x) => x.id === d)).length]));
  const waves = []; let left = agents.length;
  while (left > 0) {
    const wave = agents.filter((a) => indeg.get(a.id) === 0);
    if (!wave.length) return null; // 有环
    wave.forEach((a) => indeg.set(a.id, -1));
    agents.forEach((a) => {
      if (indeg.get(a.id) < 0) return;
      const hit = a.depends_on.filter((d) => wave.some((w) => w.id === d)).length;
      if (hit) indeg.set(a.id, indeg.get(a.id) - hit);
    });
    waves.push(wave); left -= wave.length;
  }
  return waves;
}

/* ============ 渲染 ============ */
function renderTeam() {
  $("team-emoji").textContent = spec.emoji || "⚔";
  $("team-name").textContent = spec.team_name;
  $("team-summary").textContent = spec.summary;
  hideBattleDashboard();
  updateSecretsCount();
  if (!$("task").value || spec.last_task) $("task").value = spec.last_task || "";
  refreshTaskDanger();
  $("final").style.display = "none";
  renderAll();
  refreshRunButtonLabel();
  $("team").style.display = "block";
  $("team").scrollIntoView({ behavior: "smooth" });
}
// 出征按钮文案：全新/团队 → 出征；历史记录 → 再出征；历史记录且团队被对话进化过 → ⚔ 再战
function refreshRunButtonLabel() {
  const btn = $("btn-run");
  if (!btn || runActive) return;
  const isHistory = activeSpecSource === "run" && currentRunStatus && currentRunStatus !== "running";
  btn.textContent = isHistory ? (spec?.evolved ? "⚔ 再战" : "↻ 再出征") : "出 征";
}

let lastWaves = null;
function renderAll() {
  spec.agents.forEach(normalizeMemberIcon);
  const waves = topoWaves(spec.agents);
  if (!waves) { showError("DAG 展示关系出现循环，请检查成员的「展示上游」设置。"); return; }
  showError("");
  lastWaves = waves;
  renderMembers(waves);
  reapplyRunOutputs(); // 重渲染后把已存的运行/历史产出重新贴回卡片，避免切模型等重渲染把成员输出抹掉
  // 先渲染右栏，再做左右动态对齐
  requestAnimationFrame(balanceColumns);
}

// 把内存里已存的成员产出重新渲染到卡片上（renderMembers 会重建空卡片，这里据 state 还原，保证历史/运行态产出不丢）
function reapplyRunOutputs() {
  const ids = new Set([...Object.keys(memberOutputHistory || {}), ...Object.keys(runOutputs || {})]);
  for (const id of ids) {
    if (id === ORCH_ID) continue;
    if ($(`out-${id}`)) renderMemberOriginals(id);
  }
}

/* ===== 左右动态对齐 =====
   方向一（右长左短）：作战室行高在 96~176 间伸缩去贴右栏；
   方向二（左长右短）：成员网格拉伸（minHeight + 等分行高）补齐到左栏高度。 */
function balancedRowH(waveCount) {
  const right = document.querySelector(".right-col")?.offsetHeight || 0;
  const head = $("left-head")?.offsetHeight || 0;
  const run = $("runcard")?.offsetHeight || 0;
  const avail = right - head - run - 32 /*列间 gap*/ - 36 /*board 上下留白*/;
  return Math.max(96, Math.min(176, Math.floor(avail / Math.max(1, waveCount))));
}
function balanceColumns() {
  if (!lastWaves) return;
  const m = $("members");
  if (m) { m.style.minHeight = ""; m.classList.remove("fill"); }
  renderBoard(lastWaves, balancedRowH(lastWaves.length));
  requestAnimationFrame(() => {
    if (!m) return;
    const left = document.querySelector(".left-col")?.offsetHeight || 0;
    const right = document.querySelector(".right-col")?.offsetHeight || 0;
    if (right < left - 8) {
      m.style.minHeight = (m.offsetHeight + (left - right)) + "px";
      m.classList.add("fill");
    }
  });
}

/* —— 作战室：纵向层级（上 = 前线，下 = 收尾） —— */
let nodePos = {};
let boardW = 440, boardH = 0;
// 运行时 DAG：出征中按将军的实际路由画连线（成员仍全部显示），结束/重开团队恢复初始 DAG
let runtimeMode = false;
const runtimeEdges = new Set(); // "from->to"
// 当前该画哪些连线：运行时=实际观察到的路由；否则=初始 depends_on
function edgePairs() {
  if (runtimeMode) return [...runtimeEdges].map((s) => s.split("->"));
  return spec.agents.flatMap((a) => (a.depends_on || []).map((d) => [d, a.id]));
}
function buildEdgeSvg() {
  let svg = `<svg viewBox="0 0 ${boardW} ${boardH}" preserveAspectRatio="none">`;
  for (const [d, id] of edgePairs()) {
    const from = nodePos[d], to = nodePos[id];
    if (!from || !to) continue;
    const dy = Math.max(24, (to.y - from.y) * 0.4);
    svg += `<path class="edge" id="edge-${esc(d)}-${esc(id)}" d="M ${from.x} ${from.y + 26} C ${from.x} ${from.y + 26 + dy}, ${to.x} ${to.y - 26 - dy}, ${to.x} ${to.y - 26}"/>`;
  }
  return svg + "</svg>";
}
// 只换连线层，保留节点/悬浮卡，避免重绘整块打断动画与气泡
function refreshBoardEdges() {
  const old = $("board")?.querySelector("svg");
  if (old) old.outerHTML = buildEdgeSvg();
}
function renderBoard(waves, rowH = 128) {
  const board = $("board");
  const W = board.clientWidth || 440;
  const H = waves.length * rowH + 36;
  board.style.height = H + "px";
  boardW = W; boardH = H;
  nodePos = {};
  waves.forEach((wave, wi) => {
    const colW = W / wave.length;
    wave.forEach((a, ci) => {
      nodePos[a.id] = { x: colW * ci + colW / 2, y: rowH * wi + rowH / 2 + 10 };
    });
  });

  let svg = buildEdgeSvg();

  let nodes = "";
  waves.forEach((wave, wi) => {
    const tag = wi === 0 ? "前线" : (wi === waves.length - 1 && waves.length > 1 ? "收尾" : `第 ${wi + 1} 层`);
    nodes += `<div class="wave-tag" style="top:${wi * rowH + 8}px">${tag}</div>`;
  });
  // 名字按所在层级上色（前线/中层/收尾各一色），一眼区分梯队
  const sid = sinkId();
  const palette = ["#7ab8ff", "#ed9a4d", "#6fd08c", "#d88bd8", "#7fd0c0"];
  const layerColor = {};
  waves.forEach((wave, wi) => wave.forEach((a) => { layerColor[a.id] = a.id === sid ? "#c3b0ff" : palette[wi % palette.length]; }));
  for (const a of spec.agents) {
    const p = nodePos[a.id];
    const st = agentState[a.id] || "";
    nodes += `
    <div class="node ${st}" id="node-${esc(a.id)}" style="left:${p.x}px;top:${p.y - 25}px" data-jump="${esc(a.id)}">
      <div class="bubble" id="bubble-${esc(a.id)}"></div>
      <div class="avatar">${esc(a.emoji || "🤖")}</div>
      <div class="node-name" style="color:${layerColor[a.id] || "var(--dim)"}">${esc(a.name)}</div>
    </div>`;
  }
  board.innerHTML = svg + nodes;
  const agentById = new Map(spec.agents.map((a) => [a.id, a]));
  board.querySelectorAll("[data-jump]").forEach((n) => {
    n.addEventListener("click", () => $(`agent-${n.dataset.jump}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    n.addEventListener("mouseenter", (e) => {
      const agent = agentById.get(n.dataset.jump);
      if (agent) scheduleTeamHoverTip(n, e, { html: memberDetailHtml(agent), kind: "dag" });
    });
    n.addEventListener("mousemove", (e) => moveTeamHoverTip(n, e));
    n.addEventListener("mouseleave", (e) => leaveTeamHoverTip(n, e.relatedTarget));
  });
}
window.addEventListener("resize", () => { if (spec) renderAll(); });

function showDagDetail(id) {
  const agent = spec?.agents?.find((a) => a.id === id);
  const node = $(`node-${id}`);
  if (agent && node) scheduleTeamHoverTip(node, null, { html: memberDetailHtml(agent), kind: "dag" });
}
function hideDagDetail() {
  hideTeamHoverTip();
}

// 主 agent = 收尾统筹者（没有任何人依赖它的那个）
function sinkId() {
  const depended = new Set(spec.agents.flatMap((a) => a.depends_on));
  const sinks = spec.agents.filter((a) => !depended.has(a.id));
  return sinks.length ? sinks[sinks.length - 1].id : spec.agents[spec.agents.length - 1]?.id;
}

function memberDetailHtml(a) {
  const nameOf = (id) => spec.agents.find((x) => x.id === id)?.name || id;
  return `
    <div class="dag-hover-title"><span class="emoji">${esc(a.emoji || "🤖")}</span><span>${esc(a.name)}</span></div>
    ${a.persona ? `<div class="hp-persona">${esc(a.persona)}</div>` : ""}
    <div class="hp-sec">DAG 展示上游 ← ${a.depends_on.length ? a.depends_on.map((d) => esc(nameOf(d))).join(" · ") : "（无展示上游）"}</div>
    <div class="hp-sec" style="margin-top:9px">工具</div>
    <div class="hp-prompt">${(a.tools && a.tools.length) ? a.tools.map((t) => esc(toolLabel(t))).join(" · ") : "无（纯文本产出）"}</div>
    <div class="hp-sec" style="margin-top:9px">职责提示词</div>
    <div class="hp-prompt">${esc(a.system_prompt)}</div>`;
}

/* —— 右栏成员卡片（可编辑） —— */
function renderMembers(waves) {
  const host = $("members");
  // 成员栏标题动态化：跟着当前团队走，不再写死"产出实时直播"
  const head = $("members-head-t");
  if (head) head.textContent = spec
    ? `${spec.emoji || "⚔"} ${spec.team_name} · ${spec.agents.length} 名成员 · 最终交付`
    : "TEAM MEMBERS";
  const sid = sinkId();
  let html = "";
  waves.forEach((wave, wi) => {
    for (const a of wave) {
      // DAG 终点只是 Harness 可选择的收尾节点，不再冒充团队主 Agent。
      const tag = a.id === sid ? ["sink", "终点候选"]
        : wi === 0 ? ["front", "前线"] : ["", `子 · L${wi + 1}`];
      html += memberCard(a, tag);
    }
  });
  host.innerHTML = html;

  // 将军使用 Harness 主控模型，也是成员未单独指定时继承的基准模型。
  const tmm = $("team-main-model");
  if (tmm) {
    const overrideCount = explicitMemberModelCount();
    const inheritNote = overrideCount
      ? `${overrideCount} 名成员单独指定模型，不继承将军`
      : "全局调度团队；成员未单独指定时也继承它";
    tmm.innerHTML = `<span class="tmm-label">👑 将军</span><select class="model-sel${spec.main_model ? " custom" : ""}" id="team-main-sel">${modelOptions(spec.main_model || "", "默认·" + defaultModelLabel())}</select><span class="tmm-note">${esc(inheritNote)}</span>`;
    $("team-main-sel").addEventListener("change", (e) => {
      const prevMain = spec.main_model || "";
      const prevInherited = teamDefaultModel();
      spec.main_model = e.target.value;
      const synced = syncInheritedMemberModels(prevMain, prevInherited);
      autoSave();
      renderAll(); // 重渲染：所有"继承默认"的成员卡片标签随团队主模型更新
      if (synced) markSaved(`已切换模型，${synced} 名成员改为继承将军`);
    });
  }

  // 事件绑定
  host.querySelectorAll("[data-f]").forEach((el) => {
    const onFieldChange = () => {
      const a = spec.agents.find((x) => x.id === el.dataset.id);
      if (!a) return;
      a[el.dataset.f] = el.value;
      if (el.dataset.f === "name") {
        const card = $(`agent-${a.id}`)?.querySelector(".agent-name");
        const node = $(`node-${a.id}`)?.querySelector(".node-name");
        if (card) card.textContent = el.value;
        if (node) node.textContent = el.value;
      }
      if (el.dataset.f === "role") {
        const r = $(`agent-${a.id}`)?.querySelector(".agent-role");
        if (r) r.textContent = el.value;
      }
      if (el.dataset.f === "model") {
        // 同步卡片上的快速下拉（自定义模型不在候选里则补一个 option）
        const sel = $(`agent-${a.id}`)?.querySelector(".model-sel");
        if (sel) {
          if (el.value && !Array.from(sel.options).some((o) => o.value === el.value))
            sel.add(new Option(el.value, el.value));
          sel.value = el.value;
          sel.classList.toggle("custom", !!el.value);
        }
      }
      autoSave();
    };
    el.addEventListener("input", onFieldChange);
    el.addEventListener("change", onFieldChange);
  });
  host.querySelectorAll("[data-dep]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const a = spec.agents.find((x) => x.id === cb.dataset.id);
      if (!a) return;
      const set = new Set(a.depends_on);
      cb.checked ? set.add(cb.dataset.dep) : set.delete(cb.dataset.dep);
      a.depends_on = [...set];
      renderAll(); autoSave();
    });
  });
  host.querySelectorAll("[data-tool]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const a = spec.agents.find((x) => x.id === cb.dataset.id);
      if (!a) return;
      const set = new Set(a.tools || []);
      cb.checked ? set.add(cb.dataset.tool) : set.delete(cb.dataset.tool);
      a.tools = [...set];
      renderAll(); autoSave();
    });
  });
  host.querySelectorAll("[data-model-pick]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const a = spec.agents.find((x) => x.id === sel.dataset.id);
      if (!a) return;
      a.model = sel.value;
      sel.classList.toggle("custom", !!sel.value);
      // 同步编辑器里的模型输入框（若开着）
      const inp = $(`agent-${a.id}`)?.querySelector('[data-f="model"]');
      if (inp) inp.value = sel.value;
      autoSave();
    });
  });
  host.querySelectorAll("[data-member-risk]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMemberRisk(b.dataset.memberRisk);
    });
  });
  host.querySelectorAll("[data-del-member]").forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.dataset.delMember;
      if (!confirm("移除该成员？")) return;
      spec.agents = spec.agents.filter((x) => x.id !== id);
      spec.agents.forEach((x) => (x.depends_on = x.depends_on.filter((d) => d !== id)));
      openEditors.delete(id);
      renderAll(); autoSave();
    });
  });
  host.querySelectorAll("details.editor").forEach((d) => {
    d.addEventListener("toggle", () => {
      d.open ? openEditors.add(d.dataset.id) : openEditors.delete(d.dataset.id);
      $(`agent-${d.dataset.id}`)?.classList.toggle("editing", d.open);
      requestAnimationFrame(balanceColumns);
    });
  });
  host.querySelectorAll("[data-edit]").forEach((b) => {
    b.addEventListener("click", () => {
      const det = host.querySelector(`details.editor[data-id="${b.dataset.edit}"]`);
      if (det) det.open = !det.open;
    });
  });
  host.querySelectorAll("[data-done]").forEach((b) => {
    b.addEventListener("click", () => {
      const det = host.querySelector(`details.editor[data-id="${b.dataset.done}"]`);
      if (det) det.open = false;
    });
  });
  host.querySelectorAll("[data-aiedit]").forEach((b) => {
    b.addEventListener("click", () => aiEditMember(b.dataset.aiedit));
  });
}

// 对话式改成员：用该成员当前选择的模型，按指令改写它（名字/emoji/role/persona/system_prompt/tools）
async function aiEditMember(id) {
  const a = spec.agents.find((x) => x.id === id);
  const inp = $(`agent-${id}`)?.querySelector(".ai-edit-input");
  const msg = $(`aimsg-${id}`);
  if (!a || !inp) return;
  const instruction = inp.value.trim();
  if (!instruction) { if (msg) msg.textContent = "⚠ 先写一句修改要求"; return; }
  if (msg) msg.textContent = "🧠 用本成员模型修改中…";
  try {
    const r = await fetch("/api/edit-member", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: a, instruction, team_main_model: spec.main_model || "" }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "修改失败");
    const f = d.fields || {};
    ["name", "emoji", "role", "persona", "system_prompt"].forEach((k) => { if (f[k] != null) a[k] = String(f[k]); });
    if (Array.isArray(f.tools)) a.tools = f.tools.filter((t) => ["shell", "write_file", "read_file"].includes(t));
    inp.value = "";
    renderAll(); autoSave();
    const det = $(`agent-${id}`)?.querySelector("details.editor"); if (det) det.open = true;
    const m2 = $(`aimsg-${id}`); if (m2) m2.textContent = "✓ 已改（" + (d.model || "") + "）：" + (f._changed || "见上方字段");
  } catch (e) { if ($(`aimsg-${id}`)) $(`aimsg-${id}`).textContent = "⚠ " + e.message; }
}

// Esc 关闭当前打开的编辑窗
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = document.querySelector("details.editor[open]");
  if (open) { open.open = false; e.stopPropagation(); }
});

function memberCard(a, tag = ["", ""]) {
  const others = spec.agents.filter((x) => x.id !== a.id);
  const editing = openEditors.has(a.id);
  return `
  <div class="agent${editing ? " editing" : ""}" id="agent-${esc(a.id)}">
    <div class="agent-top">
      <span class="emoji">${esc(a.emoji || "🤖")}</span>
      <div style="min-width:0"><div class="agent-name">${esc(a.name)}</div></div>
      <span class="wave-chip ${tag[0]}">${tag[1]}</span>
      ${memberRiskButton(a)}
      <span class="status" id="status-${esc(a.id)}">待命</span>
      <button class="edit-btn" data-edit="${esc(a.id)}" title="编辑成员">✎</button>
    </div>
    <div class="agent-role">${esc(a.role)}</div>
    <div class="meta-row">
      <label class="model-pick" title="该成员用的模型（留默认=继承将军模型），可独立切换">🧠 <select class="model-sel${a.model ? " custom" : ""}" data-model-pick data-id="${esc(a.id)}">${modelOptions(a.model, "默认·" + teamDefaultModelLabel())}</select></label>
      <span class="actual-model" id="actual-model-${esc(a.id)}" style="display:none"></span>
      ${(a.tools && a.tools.length) ? `<span class="tool-sep">🛠</span>${a.tools.map((t) => `<span class="tool-chip">${esc(toolLabel(t))}</span>`).join("")}${!META.tools_enabled ? `<span class="tool-off" title="服务端未开启真执行（ALLOW_TOOLS=1）或不可用 Claude">未启用</span>` : ""}` : ""}
    </div>
    <details class="editor" data-id="${esc(a.id)}" ${editing ? "open" : ""}>
      <summary></summary>
      <div class="ed-grid">
        <label>名字</label><input type="text" data-f="name" data-id="${esc(a.id)}" value="${esc(a.name)}">
        <label>emoji</label><input type="text" data-f="emoji" data-id="${esc(a.id)}" value="${esc(a.emoji || "")}" style="width:90px">
        <label>角色</label><input type="text" data-f="role" data-id="${esc(a.id)}" value="${esc(a.role)}">
        <label>职责<br>提示词</label><textarea data-f="system_prompt" data-id="${esc(a.id)}">${esc(a.system_prompt)}</textarea>
        <label>模型</label>
        <select data-f="model" data-id="${esc(a.id)}">${modelOptions(a.model || "", "默认·" + teamDefaultModelLabel())}</select>
        <label>工具<br><span class="lbl-sub">真执行</span></label>
        <div class="dep-checks full">${META.tools.map((t) =>
          `<label title="${esc(t.hint)}"><input type="checkbox" data-tool="${esc(t.name)}" data-id="${esc(a.id)}" ${(a.tools || []).includes(t.name) ? "checked" : ""}>${esc(t.label)}</label>`).join("")}
          ${META.tools_enabled ? "" : '<span style="color:var(--faint);font-size:11.5px">服务端未开启真执行——以 <code>ALLOW_TOOLS=1 npm start</code> 启动后工具才会真正执行</span>'}
        </div>
        <label>DAG<br>展示上游</label>
        <div class="dep-checks full">${others.map((o) =>
          `<label><input type="checkbox" data-dep="${esc(o.id)}" data-id="${esc(a.id)}" ${a.depends_on.includes(o.id) ? "checked" : ""}>${esc(o.name)}</label>`).join("") || '<span style="color:var(--faint);font-size:12px">暂无其他成员</span>'}
        </div>
        <label>对话改<br><span class="lbl-sub">用本成员模型</span></label>
        <div class="dep-checks full">
          <div class="ai-edit-row"><input type="text" class="ai-edit-input" data-id="${esc(a.id)}" placeholder="例如：口播规则再严格点 / 加一个验证步骤 / 换个更活泼的性格"><button class="btn ghost ai-edit-go" data-aiedit="${esc(a.id)}">AI 改</button></div>
          <div class="ai-edit-msg" id="aimsg-${esc(a.id)}"></div>
        </div>
        <div class="ed-foot"><button class="btn danger" data-del-member="${esc(a.id)}">移除成员</button><button class="btn ghost" data-done="${esc(a.id)}">完成 ✓</button></div>
      </div>
    </details>
    <div class="output-shell" id="outshell-${esc(a.id)}">
      <div class="output" id="out-${esc(a.id)}"></div>
      <button class="output-expand" data-expand-output="out-${esc(a.id)}" data-output-title="${esc(a.name)} · 最终结果" title="放大查看" aria-label="放大查看">${outputIcon()}</button>
    </div>
  </div>`;
}

$("add-member").addEventListener("click", () => {
  if (!spec) return;
  let n = spec.agents.length + 1, id;
  do { id = "member-" + n++; } while (spec.agents.some((a) => a.id === id));
  spec.agents.push({ id, name: "新兵", emoji: "🤖", role: "（填写这位成员的职责）", persona: "",
    system_prompt: "你是团队新兵。请根据角色职责高质量完成工作，直接输出交付物。", depends_on: [], tools: [], model: "",
    risk: { level: "none", summary: "", operations: [] } });
  openEditors.add(id);
  renderAll(); autoSave();
  $(`agent-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
});

/* ============ 出征 ============ */
let runActive = false; // 团队是否正在出征（用于状态一致性：未结束则按钮恒“出征中”、将军恒“将军思考中”）
let currentRunId = null; // 本次出征的 runId（用于运行中给 agent 插话）
const userMsgs = {};   // id -> [{ msgId, text, status:"queued"|"read"|"failed"|"stored" }] 用户插话会话记录
let agentState = {};
let runOutputs = {};
let memberOutputHistory = {};
let finalCandidateOrder = [];
let chargeAudioCtx = null;
const AUTO_FOCUS_IDLE_MS = 10000;
let lastUserInteractionAt = Date.now();
let autoFocusTimer = null;
let queuedAutoFocus = null;
function noteUserInteraction() {
  lastUserInteractionAt = Date.now();
}
["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "input"].forEach((eventName) => {
  window.addEventListener(eventName, noteUserInteraction, { capture: true, passive: true });
});
function requestIdleAutoFocus(target, options = {}) {
  const el = typeof target === "string" ? $(target) : target;
  if (!el) return;
  queuedAutoFocus = { el, options: { behavior: "smooth", block: "center", ...options } };
  const wait = Math.max(0, AUTO_FOCUS_IDLE_MS - (Date.now() - lastUserInteractionAt));
  if (autoFocusTimer) clearTimeout(autoFocusTimer);
  autoFocusTimer = setTimeout(() => {
    autoFocusTimer = null;
    if (!queuedAutoFocus) return;
    const idleFor = Date.now() - lastUserInteractionAt;
    if (idleFor < AUTO_FOCUS_IDLE_MS) {
      requestIdleAutoFocus(queuedAutoFocus.el, queuedAutoFocus.options);
      return;
    }
    const { el: targetEl, options: scrollOptions } = queuedAutoFocus;
    queuedAutoFocus = null;
    targetEl.scrollIntoView(scrollOptions);
  }, wait);
}
function playChargeSfx() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    chargeAudioCtx = chargeAudioCtx || new AudioCtx();
    const ctx = chargeAudioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const t0 = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.exponentialRampToValueAtTime(0.42, t0 + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.2);
    // 总线压一道，霸气但不爆音
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.25;
    master.connect(comp).connect(ctx.destination);

    // 厚号角：两支微失谐锯齿 + 低通 → 像铜管而非刺耳锯齿；可上行滑音
    const horn = (offset, f1, f2, dur, gain) => {
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass"; filt.frequency.setValueAtTime(1300, t0 + offset);
      filt.frequency.exponentialRampToValueAtTime(2600, t0 + offset + dur * 0.5);
      filt.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + offset);
      g.gain.exponentialRampToValueAtTime(gain, t0 + offset + 0.05);
      g.gain.setValueAtTime(gain, t0 + offset + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + dur);
      filt.connect(g).connect(master);
      [-7, 7].forEach((cents) => {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth"; osc.detune.value = cents;
        osc.frequency.setValueAtTime(f1, t0 + offset);
        osc.frequency.exponentialRampToValueAtTime(f2, t0 + offset + dur);
        osc.connect(filt);
        osc.start(t0 + offset); osc.stop(t0 + offset + dur + 0.05);
      });
      // 低八度垫底，更厚重
      const sub = ctx.createOscillator(); const sg = ctx.createGain();
      sub.type = "triangle"; sub.frequency.setValueAtTime(f1 / 2, t0 + offset);
      sub.frequency.exponentialRampToValueAtTime(f2 / 2, t0 + offset + dur);
      sg.gain.setValueAtTime(0.0001, t0 + offset);
      sg.gain.exponentialRampToValueAtTime(gain * 0.7, t0 + offset + 0.05);
      sg.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + dur);
      sub.connect(sg).connect(master);
      sub.start(t0 + offset); sub.stop(t0 + offset + dur + 0.05);
    };

    // 战鼓重击：低频砰 + 一丝噪声拍头
    const drum = (offset, freq, gain, dur = 0.16) => {
      const osc = ctx.createOscillator(); const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq * 2.2, t0 + offset);
      osc.frequency.exponentialRampToValueAtTime(freq, t0 + offset + 0.05);
      g.gain.setValueAtTime(gain, t0 + offset);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + dur);
      osc.connect(g).connect(master);
      osc.start(t0 + offset); osc.stop(t0 + offset + dur + 0.02);
      const nb = ctx.createBufferSource();
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
      const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      nb.buffer = buf; const ng = ctx.createGain(); ng.gain.value = gain * 0.5;
      nb.connect(ng).connect(master); nb.start(t0 + offset);
    };

    // 开场一记重锤
    drum(0, 60, 0.95, 0.32);
    // 号角上行齐鸣（低八度，雄浑），最后落在持续的高音
    horn(0.08, 110, 165, 0.5, 0.3);   // A2 → E3
    horn(0.40, 165, 220, 0.5, 0.3);   // E3 → A3
    horn(0.78, 220, 330, 1.05, 0.34); // A3 → E4，拖长收尾
    // 加速战鼓，推到收尾的总攻
    [0.1, 0.30, 0.48, 0.62, 0.74, 0.84, 0.92].forEach((off, i, a) => drum(off, 55, 0.4 + 0.55 * (i / (a.length - 1)), 0.14));
    drum(1.0, 48, 1.0, 0.4); // 总攻定音
  } catch {}
}
$("btn-run").addEventListener("click", async () => {
  const task = $("task").value.trim();
  if (!task || !spec) return;
  resetRuntimeDanger();
  playChargeSfx();
  spec.last_task = task; autoSave();
  const btn = $("btn-run");
  runActive = true;
  setStopButton(true);
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>出征中…';
  $("final").style.display = "none";
  stopAllMemberOutputTypers();
  stopAllOutputStreams();
  agentState = {};
  runOutputs = {};
  memberOutputHistory = {};
  finalCandidateOrder = [];
  setRunError("");
  renderAll();
  resetThink(ORCH_ID);
  setOrchestratorStatus("将军思考中", "running", true);
  for (const a of spec.agents) {
    setStatus(a.id, "待命", "");
    const out = $(`out-${a.id}`);
    const shell = $(`outshell-${a.id}`);
    const actual = $(`actual-model-${a.id}`);
    if (actual) { actual.style.display = "none"; actual.textContent = ""; actual.title = ""; }
    if (shell) shell.classList.remove("show");
    if (out) { out.textContent = ""; out.dataset.raw = ""; }
  }

  try {
    // 普通团队出征创建新 run；历史记录再次出征则覆盖更新原 run，不新增历史条目。
    const fromHistory = activeSpecSource === "run" && currentRunId && currentRunStatus !== "running";
    const r = fromHistory
      ? await fetch(`/api/runs/${currentRunId}/rerun`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task, spec }),
        })
      : await fetch("/api/run", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spec, task }),
        });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.run_id) throw new Error(d.error || "运行失败");
    currentRunId = d.run_id;
    currentRunStatus = "running";
    attachedRunReplayOnly = false;
    loadRunsSidebar();
    attachRun(d.run_id, { replayOnly: false }); // 不 await：事件流持续到运行结束；按钮状态由 run_start/run_done/error 驱动
  } catch (e) {
    showError(e.message);
    runActive = false;
    btn.disabled = false; btn.textContent = "出 征";
  }
});

// 「停战」按钮：可见性跟 runActive 走；点击硬终止当前出征
function setStopButton(show) {
  const b = $("btn-stop");
  if (!b) return;
  b.style.display = show ? "" : "none";
  if (show) { b.disabled = false; b.textContent = "⛔ 停战"; }
}
$("btn-stop")?.addEventListener("click", async () => {
  if (!currentRunId) return;
  const b = $("btn-stop");
  b.disabled = true; b.textContent = "停战中…";
  try {
    const r = await fetch(`/api/runs/${currentRunId}/stop`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { showError(d.error || "停战失败"); b.disabled = false; b.textContent = "⛔ 停战"; return; }
    // 终止结果由 run_stopped 事件驱动收尾；这里只把按钮置灰等回执
  } catch (e) { showError(e.message); b.disabled = false; b.textContent = "⛔ 停战"; }
});

// attach 到某次运行的事件流：先回放已有事件，运行中则继续实时推送。
// 用 AbortController，切团队/重连时只断开本地连接，服务端运行不受影响。
let runAbort = null;
let openRunSeq = 0;
async function attachRun(runId, opts = {}) {
  if (runAbort) { runAbort.abort(); runAbort = null; }
  attachedRunReplayOnly = !!opts.replayOnly;
  // liveOnly（续聊增量）：不清屏、不整段回放，只接新一轮事件并实时追加到现有对话 → 不闪屏、消息不丢、输出不接到旧的后面。
  streamReplaying = !opts.liveOnly;
  const openSeq = Number(opts.openSeq || 0);
  const ac = new AbortController();
  runAbort = ac;
  try {
    const r = await fetch(`/api/runs/${runId}/stream${opts.liveOnly ? "?live=1" : ""}`, { signal: ac.signal, cache: "no-store" });
    if (!r.ok) throw new Error("无法连接运行流");
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) {
      if (openSeq && openSeq !== openRunSeq) { ac.abort(); return; }
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 2);
        if (!line.startsWith("data: ")) continue;
        if (openSeq && openSeq !== openRunSeq) return;
        try { handleEvent(JSON.parse(line.slice(6))); } catch {}
      }
    }
  } catch (e) {
    if (e.name !== "AbortError" && (!openSeq || openSeq === openRunSeq)) showError(e.message);
  } finally {
    if (runAbort === ac) runAbort = null;
    if (!openSeq || openSeq === openRunSeq) loadRunsSidebar();
  }
}

// 打开某次运行（运行中=重连续看，历史=回放）：先按记录里的 spec 渲染团队，再 attach 回放/实时
async function openRun(runId) {
  const seq = ++openRunSeq;
  if (runAbort) { runAbort.abort(); runAbort = null; }
  try {
    const rec = await (await fetch(`/api/runs/${runId}`, { cache: "no-store" })).json();
    if (seq !== openRunSeq) return;
    if (rec.error || !rec.spec) throw new Error(rec.error || "运行记录不完整");
    resetRunState();
    if (seq !== openRunSeq) return;
    rememberResolvedAsks(rec.events || []);
    spec = rec.spec;
    activeSpecSource = "run";
    currentRunId = runId;
    currentRunStatus = rec.status || "";
    attachedRunReplayOnly = currentRunStatus !== "running";
    highlightActiveRun(runId); // 立刻高亮选中（尤其运行中的记录，其流常开，等不到 loadRunsSidebar）
    $("blueprint") && hideBlueprint();
    $("team").style.display = "";
    renderTeam();
    $("task").value = rec.task || spec.last_task || "";
    resetRuntimeDanger();
    window.scrollTo({ top: 0, behavior: "smooth" });
    attachRun(runId, { replayOnly: currentRunStatus !== "running", openSeq: seq }); // /stream 会先回放全部事件，运行中再转实时
  } catch (e) {
    if (seq === openRunSeq) showError(e.message);
  }
}

async function rerunRun(runId) {
  try {
    const payload = activeSpecSource === "run" && currentRunId === runId && spec ? { spec } : {};
    const r = await fetch(`/api/runs/${runId}/rerun`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.run_id) throw new Error(d.error || "重新出征失败");
    await loadRunsSidebar();
    await openRun(d.run_id);
  } catch (e) { showError(e.message); }
}

function fmtRunTime(ts) {
  if (!ts) return "";
  const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function runStatusLabel(s) {
  return s === "running" ? "运行中" : s === "done" ? "成功" : s === "failed" ? "失败"
       : s === "interrupted" ? "已中断" : s === "stopped" ? "已停战" : s;
}
function runGroupKey(team) { return "runGroupOpen:" + String(team || "未命名团队"); }
function isRunGroupOpen(team, runs) {
  if ((runs || []).some((r) => r.status === "running")) return true; // 有运行中 → 展开
  // 含当前正在查看的运行记录 → 展开（保证选中可见）
  if (currentRunId && (runs || []).some((r) => r.run_id === currentRunId)) return true;
  // 其它分组默认折叠，只有用户手动展开过(saved==="1")才保持展开 → 页面打开时只展开"有运行中"的目录
  return localStorage.getItem(runGroupKey(team)) === "1";
}
function runDisplayTitle(r) {
  return (r.title || r.task || "未命名记录").trim();
}
async function saveRunTitle(runId, title) {
  try {
    const r = await fetch(`/api/runs/${runId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || "改名失败");
    await loadRunsSidebar();
  } catch (e) { showError(e.message); }
}
function beginRenameRun(el) {
  if (!el || el.dataset.editing === "1") return;
  el.dataset.editing = "1";
  historyRenameEditing = true;
  const runId = el.dataset.renameRun;
  const oldTitle = el.dataset.runTitle || el.textContent || "";
  const input = document.createElement("input");
  input.className = "rs-title-input";
  input.value = oldTitle;
  input.setAttribute("aria-label", "执行记录名称");
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const nextTitle = input.value.trim();
    historyRenameEditing = false;
    if (save && nextTitle !== oldTitle) await saveRunTitle(runId, nextTitle);
    else await loadRunsSidebar();
  };
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}
async function loadRunsSidebar() {
  const body = $("history-list"); if (!body) return;
  if (historyRenameEditing) return;
  let list = [];
  try { list = await (await fetch("/api/runs", { cache: "no-store" })).json(); }
  catch (e) { console.error("[runs] load failed", e); body.innerHTML = '<div class="rs-empty">历史记录加载失败，点“刷新”重试</div>'; return; }
  if (!Array.isArray(list)) { body.innerHTML = '<div class="rs-empty">历史记录格式异常，点“刷新”重试</div>'; return; }
  const groups = {};
  for (const r of list) (groups[r.team_name] = groups[r.team_name] || []).push(r);
  const item = (r) => `<div class="rs-run ${esc(r.status)}${r.run_id === currentRunId ? " active" : ""}" data-run="${esc(r.run_id)}">
      <span class="rs-dot ${esc(r.status)}"></span>
      <span class="rs-main"><span class="rs-title" data-rename-run="${esc(r.run_id)}" data-run-title="${esc(runDisplayTitle(r))}" aria-label="双击改名">${esc(runDisplayTitle(r))}</span><span class="rs-meta">${fmtRunTime(r.started_at)}</span></span>
      <span class="rs-stat ${esc(r.status)}">${runStatusLabel(r.status)}</span>
    </div>`;
  const teams = Object.keys(groups);
  body.innerHTML = teams.length ? teams.map((team) => {
    const rs = groups[team];
    const running = rs.filter((r) => r.status === "running");
    const hist = rs.filter((r) => r.status !== "running");
    return `<details class="rs-team" data-run-group="${esc(team)}" ${isRunGroupOpen(team, rs) ? "open" : ""}>
      <summary class="rs-team-name"><span class="rs-fold">›</span>${esc(rs[0].emoji || "⚔")} ${esc(team)}</summary>
      ${running.length ? `<div class="rs-sub">运行中</div>${running.map(item).join("")}` : ""}
      ${hist.length ? `<div class="rs-sub">历史</div>${hist.slice(0, 20).map(item).join("")}` : ""}
    </details>`;
  }).join("") : '<div class="rs-empty">还没有出征记录</div>';
  body.querySelectorAll("[data-rename-run]").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); };
    el.ondblclick = (e) => { e.preventDefault(); e.stopPropagation(); beginRenameRun(el); };
  });
  body.querySelectorAll("[data-run]").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest("[data-rename-run], .rs-title-input")) return;
      openRun(el.dataset.run);
    };
  });
  body.querySelectorAll("[data-run-group]").forEach((el) => {
    el.addEventListener("toggle", () => localStorage.setItem(runGroupKey(el.dataset.runGroup), el.open ? "1" : "0"));
  });
}

function setStatus(id, text, cls) {
  const el = $(`status-${id}`);
  if (el) { el.textContent = text; el.className = "status" + (cls ? " " + cls : ""); }
  const card = $(`agent-${id}`);
  if (card) card.className = "agent" + (cls === "running" ? " running" : cls === "done" ? " done" : "");
}
function setNode(id, state) {
  agentState[id] = state;
  const node = $(`node-${id}`);
  if (node) node.className = "node" + (state ? " " + state : "");
}
function bubble(id, html, show = true) {
  const b = $(`bubble-${id}`);
  if (!b) return;
  b.innerHTML = html;
  b.classList.toggle("show", show);
}
function flyDoc(fromId, toId, delay = 0) {
  const path = $(`edge-${fromId}-${toId}`);
  const board = $("board");
  if (!path || !board) return;
  path.classList.add("active");
  setTimeout(() => {
    const len = path.getTotalLength();
    const el = document.createElement("div");
    el.className = "fly"; el.textContent = "📄";
    board.appendChild(el);
    const t0 = performance.now(), dur = 900;
    (function step(now) {
      const t = Math.min(1, (now - t0) / dur);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const p = path.getPointAtLength(ease * len);
      el.style.left = p.x - 7 + "px"; el.style.top = p.y - 9 + "px";
      el.style.opacity = t > 0.85 ? String((1 - t) / 0.15) : "1";
      if (t < 1) requestAnimationFrame(step);
      else { el.remove(); path.classList.remove("active"); }
    })(t0);
  }, delay);
}

let runWorkDir = null;
const ORCH_ID = "__orchestrator__";
const activeRouteInputs = {};

/* ============ 思考过程 / 人工确认（毛玻璃弹窗） ============ */
const thinkBuf = {};   // id -> 累计思考文本（兼容旧逻辑）
const thinkMessages = {}; // id -> 聊天式思考/确认时间线
const pendingAsk = {}; // id -> {qid, question}
const pendingUserNote = {}; // id -> 用户在无待确认时输入的暂存指令（下次该 agent 请求确认时预填）
const outputStreamEntries = {}; // `${id}:${callIndex}` -> 正在流式刷新的输出气泡
const chatTypingFrames = {}; // id -> requestAnimationFrame，单个思考框只保留一个打字机泵
const autoThinkShown = {};
const resolvedAskQids = new Set();
const THINK_TYPE_MIN = 1;
const THINK_TYPE_MAX = 8;
let thinkOpenId = null;
let thinkSpeechRecognition = null;
function setOrchestratorStatus(text = "将军待命", cls = "", show = true) {
  const st = $("orchestrator-status");
  if (!st) return;
  st.textContent = text;
  st.className = "status orch-status" + (show ? " show" : "") + (cls ? " " + cls : "");
  if (st.dataset.bound !== "1") {
    st.dataset.bound = "1";
    st.addEventListener("click", () => openThink(ORCH_ID));
  }
  st.title = "点击查看将军思考过程";
}
function agentNameOf(id) {
  if (id === ORCH_ID) return "将军";
  if (id === "__design__") return "军师（点将）";
  return (spec && spec.agents.find((a) => a.id === id)?.name) || id;
}
function agentAvatarOf(id) {
  if (id === ORCH_ID || id === "__design__") return "将";
  return (spec && spec.agents.find((a) => a.id === id)?.emoji) || "兵";
}
function userAvatarOf() {
  return "我";
}
function userMessageTag(status) {
  if (status === "done" || status === "processed") return '<br><span class="chat-tag ok">已处理</span>';
  if (status === "processing" || status === "read") return '<br><span class="chat-tag work">处理中…</span>';
  if (status === "failed") return '<br><span class="chat-tag err">发送失败</span>';
  if (status === "stored") return '<br><span class="chat-tag wait">已暂存</span>';
  return '<br><span class="chat-tag wait">排队中…</span>';
}
function chatLog(id) {
  return thinkMessages[id] || (thinkMessages[id] = []);
}
function resetThink(id) {
  stopThinkMessageTyping(id);
  thinkBuf[id] = "";
  thinkMessages[id] = [];
}
function pushChatEntry(id, entry) {
  const stored = { at: Date.now(), ...entry };
  chatLog(id).push(stored);
  return stored;
}
function hasAskChatEntry(id, qid) {
  if (!qid) return false;
  return chatLog(id).some((entry) => entry.kind === "ask" && entry.qid === qid);
}
function addAskToChat(id, ask) {
  if (!ask || hasAskChatEntry(id, ask.qid)) return;
  const note = pendingUserNote[id] ? `\n\n已带入你之前暂存的意见：\n${pendingUserNote[id]}` : "";
  pushChatEntry(id, {
    side: "model",
    kind: "ask",
    qid: ask.qid,
    text: `需要你确认后继续：\n${ask.question || "请确认是否继续。"}${note}`,
  });
  // 不再重复贴「待确认 · 当前输出原文」——待确认的内容上面思考/输出里已经发过了，无需再发一遍。
}
function rememberResolvedAsks(events = []) {
  resolvedAskQids.clear();
  for (const ev of events || []) {
    if (ev?.type === "ask_resolved" && ev.qid) resolvedAskQids.add(ev.qid);
  }
}
function originalHistoryHtmlFor(id) {
  if (id === ORCH_ID) return renderMarkdown(runOutputs[id] || "（将军正在等待你的决定）");
  const el = document.createElement("div");
  renderOriginalHistoryInto(el, id);
  return el.innerHTML;
}
function chatMessageHtml(side, { id, speakerId = "", text = "", html = "", kind = "", tag = "", streaming = false } = {}) {
  const isUser = side === "user";
  const modelId = speakerId || id;
  const name = isUser ? "你" : agentNameOf(modelId);
  const avatar = isUser ? userAvatarOf() : agentAvatarOf(modelId);
  const isOutput = (` ${kind} `).includes(" output ");
  const body = html || (isOutput ? renderMarkdown(text || "（正在输出…）") : esc(text || ""));
  const liveTag = streaming ? '<span class="stream-caret"></span>' : "";
  return `<div class="chat-row ${isUser ? "user" : "model"}">
    ${isUser ? "" : `<div class="chat-avatar model">${esc(avatar)}</div>`}
    <div class="chat-stack">
      <div class="chat-name">${esc(name)}</div>
      <div class="chat-bubble ${esc(kind)}">${body}${tag || ""}${liveTag}</div>
    </div>
    ${isUser ? `<div class="chat-avatar user">${esc(avatar)}</div>` : ""}
  </div>`;
}
function outputStreamKey(id, callIndex) {
  return `${id}:${callIndex || "main"}`;
}
function nextTypeChunk(queue = "") {
  const len = String(queue || "").length;
  if (len <= 0) return 0;
  return Math.max(THINK_TYPE_MIN, Math.min(THINK_TYPE_MAX, Math.ceil(len / 120)));
}
function applyQueuedType(entry) {
  const n = nextTypeChunk(entry.queue || "");
  if (!n) return false;
  entry.text = (entry.text || "") + entry.queue.slice(0, n);
  entry.queue = entry.queue.slice(n);
  return true;
}
function finalizeTypedEntry(entry) {
  let changed = false;
  if (String(entry.kind || "").includes("thinking") && entry.streaming && !entry.queue) {
    entry.kind = "thinking";
    entry.streaming = false;
    changed = true;
  }
  if (String(entry.kind || "").includes("output") && entry.finalizeWhenTyped && !entry.queue) {
    entry.kind = "output";
    entry.streaming = false;
    entry.finalizeWhenTyped = false;
    if (entry.outputKey) delete outputStreamEntries[entry.outputKey];
    changed = true;
  }
  return changed;
}
function scheduleChatTyping(id) {
  if (!id || chatTypingFrames[id]) return;
  const tick = () => {
    chatTypingFrames[id] = null;
    let changed = false;
    let hasMore = false;
    for (const entry of chatLog(id)) {
      if (entry.queue) {
        changed = applyQueuedType(entry) || changed;
        if (entry.queue) hasMore = true;
      }
      changed = finalizeTypedEntry(entry) || changed;
    }
    if (thinkOpenId === id && changed) renderThinkChat();
    if (hasMore) {
      chatTypingFrames[id] = requestAnimationFrame(tick);
    }
  };
  chatTypingFrames[id] = requestAnimationFrame(tick);
}
function scheduleThinkTyping(id, entry) {
  if (!entry) return;
  scheduleChatTyping(id);
}
function cancelChatTyping(id = "") {
  const ids = id ? [id] : Object.keys(chatTypingFrames);
  ids.forEach((key) => {
    if (chatTypingFrames[key]) cancelAnimationFrame(chatTypingFrames[key]);
    delete chatTypingFrames[key];
  });
}
function stopThinkMessageTyping(id = "") {
  cancelChatTyping(id);
  const ids = id ? [id] : Object.keys(thinkMessages);
  for (const key of ids) {
    for (const entry of thinkMessages[key] || []) {
      if (!String(entry.kind || "").includes("thinking")) continue;
      if (entry.queue) entry.text = (entry.text || "") + entry.queue;
      entry.queue = "";
      entry.kind = "thinking";
      entry.streaming = false;
    }
  }
}
function scheduleOutputTyping(id, callIndex, entry) {
  if (!entry) return;
  entry.outputKey = outputStreamKey(id, callIndex);
  scheduleChatTyping(id);
}
function clearOutputStream(id, callIndex) {
  const key = outputStreamKey(id, callIndex);
  const entry = outputStreamEntries[key];
  if (entry) {
    entry.queue = "";
    entry.streaming = false;
    entry.finalizeWhenTyped = false;
  }
  delete outputStreamEntries[key];
}
function stopAllOutputStreams() {
  for (const key of Object.keys(outputStreamEntries)) {
    const entry = outputStreamEntries[key];
    if (entry) {
      if (entry.queue) entry.text = (entry.text || "") + entry.queue;
      entry.queue = "";
      entry.kind = "output";
      entry.streaming = false;
    }
    delete outputStreamEntries[key];
  }
  if (thinkOpenId) renderThinkChat();
}
function pushOutputDelta(id, text, callIndex) {
  const delta = String(text || "");
  if (!delta) return;
  const key = outputStreamKey(id, callIndex);
  let entry = outputStreamEntries[key];
  if (!entry || !chatLog(id).includes(entry) || !entry.streaming) {
    entry = pushChatEntry(id, { side: "model", kind: "output streaming", text: "", queue: "", streaming: true, outputKey: key });
    outputStreamEntries[key] = entry;
  }
  entry.outputKey = key;
  if (attachedRunReplayOnly || streamReplaying) { // 历史回放/重连历史段：直接落定，不打字
    entry.text = (entry.text || "") + (entry.queue || "") + delta;
    entry.queue = "";
    entry.kind = "output";
    entry.streaming = false;
    if (thinkOpenId === id && !streamReplaying) renderThinkChat();
    return;
  }
  entry.queue = (entry.queue || "") + delta;
  markThinkable(id);
  scheduleOutputTyping(id, callIndex, entry);
}
function finishOutputStream(id, finalText = "", callIndex) {
  const key = outputStreamKey(id, callIndex);
  let entry = outputStreamEntries[key];
  const final = String(finalText || "");
  if (!entry && final) {
    entry = pushChatEntry(id, { side: "model", kind: "output streaming", text: "", queue: final, streaming: true, outputKey: key });
    outputStreamEntries[key] = entry;
  }
  if (entry) entry.outputKey = key;
  if (entry) {
    if (final) {
      const visible = String(entry.text || "") + String(entry.queue || "");
      if (!visible.trim()) entry.queue = final;
      else if (final.startsWith(visible)) entry.queue = String(entry.queue || "") + final.slice(visible.length);
    }
    entry.finalizeWhenTyped = true;
    scheduleOutputTyping(id, callIndex, entry);
    markThinkable(id);
  }
}
function pushThink(id, text) {
  if (!text) return;
  thinkBuf[id] = (thinkBuf[id] || "") + text;
  const replay = attachedRunReplayOnly || streamReplaying; // 历史回放/重连历史段：直接落定，不走打字机（避免重开思考框逐字重敲 + 重连时历史涌进打字机队列）
  // 连续的思考 delta 追加到「当前思考气泡」，不要每个 delta 新建一条（否则几个字就换一条）。
  // 只有遇到别的条目（输出/用户消息/确认）后，下一段思考才另起一个气泡。
  const log = chatLog(id);
  const last = log[log.length - 1];
  let entry;
  // 关键：打字机追平后 finalizeTypedEntry 会把 kind 由 "thinking streaming" 改成 "thinking"。
  // 只要最后一条仍是“思考类”（没被别的条目打断），就追加并重新打开它，绝不因 delta 间隙新建气泡。
  if (last && String(last.kind || "").includes("thinking")) {
    if (replay) { last.text = (last.text || "") + (last.queue || "") + text; last.queue = ""; last.kind = "thinking"; last.streaming = false; }
    else { last.queue = (last.queue || "") + text; last.kind = "thinking streaming"; last.streaming = true; }
    entry = last;
  } else {
    entry = replay
      ? pushChatEntry(id, { side: "model", kind: "thinking", text, queue: "", streaming: false })
      : pushChatEntry(id, { side: "model", kind: "thinking streaming", text: "", queue: text, streaming: true });
  }
  markThinkable(id);
  if (replay) { if (thinkOpenId === id && !streamReplaying) renderThinkChat(); } // 重连历史段不逐条重渲染，replay_done 时统一渲染一次
  else { scheduleThinkTyping(id, entry); if (id === ORCH_ID) setOrchestratorStatus("将军思考中", "running", true); }
  // 思考默认不显示，只在用户点开或 HITL 时弹；打开后保持到用户手动关闭。
}
function markThinkable(id) {
  if (id === ORCH_ID) {
    const st = $("orchestrator-status");
    if (st) {
      st.classList.add("thinkable", "show");
      st.title = "点击查看将军思考过程";
    }
    return;
  }
  // 让成员状态显示可点开思考。
  const st = $(`status-${id}`);
  if (st && st.dataset.thinkable !== "1") {
    st.dataset.thinkable = "1";
    st.classList.add("thinkable");
    st.title = "点击查看思考过程";
    st.addEventListener("click", () => openThink(id));
  }
}
function clearThinkFade() {
  // Automatic thinking-dialog fade was removed; old callers intentionally do nothing.
}
function speechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}
function updateThinkVoiceUi(active, hint = "") {
  const btn = $("think-voice");
  if (btn) {
    btn.classList.toggle("listening", !!active);
    btn.textContent = active ? "■" : "🎙";
    btn.title = active ? "停止语音输入" : "语音输入";
  }
  const h = $("think-hint");
  if (h && hint) h.textContent = hint;
}
function buildDialogRunTask(id, text) {
  const base = $("task")?.value?.trim() || spec?.last_task || "";
  return `${base || "连续对话"}\n\n# 用户在${agentNameOf(id)}思考对话框输入\n${text}\n\n请将这条输入作为最高优先级，结合当前团队 Skill 与已有上下文继续思考和执行。`;
}
async function sendDialogMessage(id, text, entry) {
  if (currentRunId) {
    const r = await fetch("/api/inject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: currentRunId, agentId: id, text, spec: activeSpecSource === "run" ? spec : undefined }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || "发送失败");
    if (d.msg_id) entry.msgId = d.msg_id;
    const nextRunId = d.continued_run_id || (d.run_id && d.run_id !== currentRunId ? d.run_id : "");
    if (nextRunId) {
      currentRunId = nextRunId;
      runActive = true;
      // 续聊用【增量】方式接流：不清屏、不整段回放，只把这一轮的新事件实时追加到当前对话里。
      // 这样你刚发的消息不会消失、不闪屏，将军这轮的回复也是接在你这条消息后面、而不是堆到旧输出里。
      const runBtn = $("btn-run");
      if (runBtn) { runBtn.disabled = true; runBtn.innerHTML = '<span class="spin"></span>出征中…'; }
      $("final").style.display = "none";
      loadRunsSidebar();
      attachRun(nextRunId, { liveOnly: true });
      return "已转入续聊出征";
    }
    return "已发送，等待模型读取";
  }
  if (!spec) throw new Error("当前没有可继续对话的团队");
  const task = buildDialogRunTask(id, text);
  const r = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec, task, dialog_agent_id: id, dialog_text: text }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.run_id) throw new Error(d.error || "启动续聊失败");
  if (d.msg_id) entry.msgId = d.msg_id;
  currentRunId = d.run_id;
  runActive = true;
  const runBtn = $("btn-run");
  if (runBtn) { runBtn.disabled = true; runBtn.innerHTML = '<span class="spin"></span>出征中…'; }
  $("final").style.display = "none";
  await loadRunsSidebar();
  attachRun(d.run_id);
  return "已开始续聊出征";
}
function appendThinkVoiceText(text) {
  const input = $("think-input");
  if (!input || !text) return;
  const clean = String(text).trim();
  if (!clean) return;
  const prefix = input.value && !/[\s，。！？；：,.!?;:]$/.test(input.value) ? " " : "";
  input.value += prefix + clean;
  input.focus();
  clearThinkFade();
}
function stopThinkVoice(hint = "语音输入已停止") {
  if (!thinkSpeechRecognition) {
    updateThinkVoiceUi(false, hint);
    return;
  }
  const rec = thinkSpeechRecognition;
  thinkSpeechRecognition = null;
  rec.onend = null;
  try { rec.stop(); } catch {}
  updateThinkVoiceUi(false, hint);
}
function toggleThinkVoice() {
  const input = $("think-input");
  if (!input) return;
  if (thinkSpeechRecognition) {
    stopThinkVoice();
    return;
  }
  const Ctor = speechRecognitionCtor();
  if (!Ctor) {
    updateThinkVoiceUi(false, "当前浏览器不支持语音输入，请用 Chrome / Edge 试试");
    return;
  }
  const rec = new Ctor();
  thinkSpeechRecognition = rec;
  rec.lang = "zh-CN";
  rec.interimResults = true;
  rec.continuous = true;
  rec.maxAlternatives = 1;
  rec.onstart = () => updateThinkVoiceUi(true, "正在听，你可以直接说话");
  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0]?.transcript || "";
      if (event.results[i].isFinal) appendThinkVoiceText(transcript);
      else interim += transcript;
    }
    updateThinkVoiceUi(true, interim ? `识别中：${interim}` : "正在听，你可以继续说");
  };
  rec.onerror = (event) => {
    const name = event.error || "unknown";
    thinkSpeechRecognition = null;
    rec.onend = null;
    updateThinkVoiceUi(false, name === "not-allowed" ? "麦克风权限被拒绝，请在浏览器里允许麦克风" : `语音输入中断：${name}`);
  };
  rec.onend = () => {
    if (thinkSpeechRecognition === rec) thinkSpeechRecognition = null;
    updateThinkVoiceUi(false, "语音输入已停止");
  };
  try { rec.start(); }
  catch (error) {
    thinkSpeechRecognition = null;
    updateThinkVoiceUi(false, "语音输入启动失败：" + error.message);
  }
}
function openThink(id, opts = {}) {
  thinkOpenId = id;
  let mask = $("think-mask");
  if (!mask) {
    mask = document.createElement("div"); mask.id = "think-mask"; mask.className = "think-mask"; document.body.appendChild(mask);
    ["pointerdown", "keydown", "wheel", "touchstart", "pointermove"].forEach((eventName) => {
      mask.addEventListener(eventName, () => {
        if (!pendingAsk[thinkOpenId]) clearThinkFade();
      }, { passive: true });
    });
    // 滚动按鼠标所在区域定向：页脚/输入框 → 交给原生(textarea 自己滚)；思考流上 → 原生滚动(overscroll:contain 已防穿透)；
    // 头部/留白等其它区域 → 代理滚动思考流，并阻止穿透到背后页面。
    mask.addEventListener("wheel", (e) => {
      const chat = mask.querySelector(".think-chat");
      if (!chat || e.target.closest(".think-foot") || e.target.closest(".think-chat")) return;
      chat.scrollTop += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }
  clearThinkFade();
  mask.style.display = "flex";
  mask.onclick = (e) => { if (e.target === mask && !pendingAsk[id]) closeThink(); };
  renderThinkModal();
  refreshAskReopen();
}
function closeThink() {
  stopThinkVoice("");
  clearThinkFade();
  thinkOpenId = null;
  const m = $("think-mask"); if (m) m.style.display = "none";
  refreshAskReopen();
}
// 待确认弹窗若被手动关闭，用一个常驻小入口保证还能回去回答
function refreshAskReopen() {
  const pendId = Object.keys(pendingAsk)[0];
  let chip = $("ask-reopen");
  if (!pendId || thinkOpenId) { if (chip) chip.remove(); return; }
  if (!chip) {
    chip = document.createElement("button"); chip.id = "ask-reopen"; chip.className = "ask-reopen";
    document.body.appendChild(chip);
  }
  chip.textContent = `❓ ${agentNameOf(pendId)} 待你确认`;
  chip.onclick = () => openThink(pendId);
}
function renderThinkModal() {
  const id = thinkOpenId, m = $("think-mask"); if (!m || !id) return;
  const ask = pendingAsk[id];
  m.innerHTML = `<div class="think-box">
    <div class="think-head"><span>${esc(agentAvatarOf(id))} ${esc(agentNameOf(id))} · ${ask ? "等待你确认" : "思考对话"}</span><button class="think-x" id="think-x">✕</button></div>
    <div class="think-chat" id="think-chat"></div>
    <div class="think-foot">
      <textarea id="think-input" placeholder="${ask ? "在这里确认或填写修改意见…（回车发送）" : "和它说点什么 / 发指令（回车发送，Shift+Enter 换行）"}"></textarea>
      <div class="think-foot-row"><button class="btn" id="think-send">${ask ? "确认并继续" : "发送"}</button><button class="voice-btn" id="think-voice" type="button" title="语音输入">🎙</button><span class="think-hint" id="think-hint"></span></div>
    </div>
  </div>`;
  $("think-x").onclick = closeThink;
  $("think-voice").onclick = toggleThinkVoice;
  updateThinkVoiceUi(!!thinkSpeechRecognition);
  renderThinkChat();
  const input = $("think-input");
  if (input && pendingUserNote[id]) input.value = pendingUserNote[id];
  const submit = async () => {
    const val = ($("think-input").value || "").trim();
    if (pendingAsk[id]) {
      const ans = val || "确认，可以继续";
      const askQid = pendingAsk[id].qid;
      const list = userMsgs[id] || (userMsgs[id] = []);
      const entry = pushChatEntry(id, { side: "user", msgId: "answer-" + Date.now(), text: ans, status: "queued" });
      list.push(entry);
      $("think-input").value = "";
      renderThinkChat();
      $("think-send").disabled = true; $("think-send").textContent = "继续中…";
      try {
        const response = await fetch("/api/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ qid: askQid, answer: ans }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || "确认提交失败，请重试");
        entry.status = "read";
        if (askQid) resolvedAskQids.add(askQid);
        delete pendingAsk[id]; delete pendingUserNote[id];
        const nextId = Object.keys(pendingAsk)[0];
        if (nextId) openThink(nextId, { requiresAction: true });
        else {
          refreshAskReopen();
          renderThinkModal();
          const hint = $("think-hint"); if (hint) hint.textContent = "已确认，继续执行中";
        }
      } catch (error) {
        entry.status = "failed";
        renderThinkChat();
        $("think-send").disabled = false; $("think-send").textContent = "确认并继续";
        showError(error.message);
      }
      return;
    }
    if (!val) return;
    // 任意状态都允许连续对话：运行中则注入当前 run；已结束/失败则基于历史记忆自动开续聊 run。
    const list = userMsgs[id] || (userMsgs[id] = []);
    const entry = pushChatEntry(id, { side: "user", msgId: "local-" + Date.now(), text: val, status: "queued" });
    list.push(entry);
    $("think-input").value = "";
    renderThinkChat();
    clearThinkFade();
    $("think-send").disabled = true; $("think-send").textContent = "发送中…";
    try {
      const hintText = await sendDialogMessage(id, val, entry);
      const hint = $("think-hint"); if (hint) hint.textContent = hintText;
      renderThinkChat();
    } catch (error) {
      entry.status = "failed";
      renderThinkChat();
      showError(error.message);
    } finally {
      if ($("think-send")) { $("think-send").disabled = false; $("think-send").textContent = "发送"; }
    }
  };
  $("think-send").onclick = submit;
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; input.dataset.composing = "1"; });
  input.addEventListener("compositionend", () => {
    composing = false;
    input.dataset.composing = "";
    input.dataset.justComposed = "1";
    setTimeout(() => { if (input) input.dataset.justComposed = ""; }, 80);
  });
  input.addEventListener("keydown", (e) => {
    clearThinkFade();
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.isComposing || composing || input.dataset.composing === "1" || e.keyCode === 229) return;
      if (input.dataset.justComposed === "1") {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      submit();
    } // 回车发送，Shift+Enter 换行；中文输入法选字回车不会误发送
  });
  input.addEventListener("input", () => clearThinkFade());
  setTimeout(() => $("think-input")?.focus(), 50);
}
function renderThinkChat() {
  const box = $("think-chat"); if (!box || !thinkOpenId) return;
  const id = thinkOpenId;
  const ask = pendingAsk[id];
  if (ask) addAskToChat(id, ask);
  const messages = [];
  const log = chatLog(id);
  const loggedUserMsgIds = new Set();
  const thinking = agentState[id] === "running" || (id === ORCH_ID && runActive);
  if (!log.length) {
    messages.push(chatMessageHtml("model", {
      id,
      html: thinking ? '思考中<span class="dots"></span>' : "",
      text: thinking ? "" : "（暂无思考输出）",
    }));
  }
  for (const entry of log) {
    if (entry.side === "user") {
      if (entry.msgId) loggedUserMsgIds.add(entry.msgId);
      messages.push(chatMessageHtml("user", {
        text: entry.text || "",
        tag: userMessageTag(entry.status),
      }));
    } else {
      messages.push(chatMessageHtml("model", {
        id: entry.speakerId || id,
        text: entry.text || "",
        html: entry.html || "",
        kind: entry.kind || "",
        streaming: !!entry.streaming && !!entry.queue, // 还有待打字内容才显光标；打完即停
      }));
    }
  }
  const list = userMsgs[id] || [];
  for (const msg of list) {
    if (msg.msgId && loggedUserMsgIds.has(msg.msgId)) continue;
    messages.push(chatMessageHtml("user", {
      text: msg.text || "",
      tag: userMessageTag(msg.status),
    }));
  }
  box.innerHTML = messages.join("");
  enhanceRichContent(box);
  box.scrollTop = box.scrollHeight;
}
// 兼容旧调用名：思考正文、确认问题和用户插话现在都渲染到同一个聊天流。
function renderThinkConvo() { renderThinkChat(); }
function renderThinkBody() { renderThinkChat(); }
// 切换团队 / 新点将时清空所有按 agent id 存的运行态，避免不同团队之间思考、产出、插话串台
function resetRunState() {
  // 先断开正在 attach 的运行事件流（历史回放/实时），否则旧流的事件会继续灌进新视图 → 串台。
  if (runAbort) { runAbort.abort(); runAbort = null; }
  closeThink();
  stopThinkMessageTyping();
  stopAllMemberOutputTypers();
  stopAllOutputStreams();
  currentDangerOps = [];
  renderDangerChip();
  [thinkBuf, thinkMessages, runOutputs, memberOutputHistory, userMsgs, pendingAsk, pendingUserNote, outputStreamEntries, autoThinkShown, agentState].forEach((o) => {
    for (const k in o) delete o[k];
  });
  resolvedAskQids.clear();
  currentRunId = null;
  currentRunStatus = "";
  attachedRunReplayOnly = false;
  streamReplaying = false;
  runActive = false;
  setStopButton(false);
  finalCandidateOrder = [];
  finalMetaState = { deliveryMember: null, missingMembers: [], usage: null, usageReady: false };
  setRunError("");
  runtimeMode = false;       // 恢复初始 DAG（重开团队显示静态连线）
  runtimeEdges.clear();
  runWorkDir = null;         // 清掉上一次运行的产物目录引用
  Object.keys(activeRouteInputs).forEach((k) => delete activeRouteInputs[k]); // 清掉上一次的 DAG 路由
  const chip = $("ask-reopen"); if (chip) chip.remove();
  // 清掉上一次运行/历史的残留视图：最终交付卡、将军运行状态、出征按钮
  const finalCard = $("final"); if (finalCard) finalCard.style.display = "none";
  const finalMeta = $("final-meta"); if (finalMeta) finalMeta.innerHTML = "";
  renderBattleReport(null);
  setOrchestratorStatus("将军待命", "", false);
  const runBtn = $("btn-run"); if (runBtn) { runBtn.disabled = false; runBtn.textContent = "出 征"; }
}

function outputCall(id, callIndex, create = true) {
  const index = Number(callIndex) || ((memberOutputHistory[id]?.length || 0) + 1);
  if (!memberOutputHistory[id]) memberOutputHistory[id] = [];
  let call = memberOutputHistory[id].find((item) => item.callIndex === index);
  if (!call && create) {
    call = { callIndex: index, live: "", segments: [], queue: "", rawSegments: [], typingTimer: null };
    memberOutputHistory[id].push(call);
  }
  return call;
}
function stopAllMemberOutputTypers() {
  for (const calls of Object.values(memberOutputHistory)) {
    for (const call of calls || []) {
      if (call.typingTimer) clearInterval(call.typingTimer);
      call.typingTimer = null;
      if (call.queue) {
        call.live = (call.live || "") + call.queue;
        call.queue = "";
      }
    }
  }
}
function enqueueMemberDelta(id, callIndex, text) {
  const call = outputCall(id, callIndex);
  const delta = String(text || "");
  if (!delta) return call;
  call.live = (call.live || "") + delta;
  renderMemberOriginals(id);
  return call;
}
function finalizeMemberOutput(id, callIndex, segments) {
  const call = outputCall(id, callIndex);
  call.rawSegments = (segments || []).map(String);
  call.finalSegments = call.rawSegments.slice();
  call.segments = call.finalSegments.slice();
  call.live = "";
  call.queue = "";
  call.finalizeWhenTyped = false;
  renderMemberOriginals(id);
}
function noteFinalCandidate(id) {
  if (!id || id === ORCH_ID || !(spec?.agents || []).some((agent) => agent.id === id)) return;
  finalCandidateOrder = finalCandidateOrder.filter((item) => item !== id);
  finalCandidateOrder.push(id);
}
function memberRefById(id) {
  if (!id) return null;
  if (id === ORCH_ID) return { id: ORCH_ID, name: "将军", emoji: "将" };
  const agent = (spec?.agents || []).find((item) => item.id === id);
  return agent ? { id: agent.id, name: agent.name || agent.id, emoji: agent.emoji || "" } : null;
}
function normalizeMemberRef(item) {
  if (!item) return null;
  if (typeof item === "string") return memberRefById(item) || { id: item, name: item, emoji: "" };
  const id = String(item.id || item.member_id || "").trim();
  const known = memberRefById(id);
  return {
    id: id || known?.id || "",
    name: item.name || known?.name || id || "未知成员",
    emoji: item.emoji || known?.emoji || "",
  };
}
function normalizeMemberRefs(items) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const ref = normalizeMemberRef(item);
    if (!ref || !ref.id || seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}
function completedMemberIdsFromView() {
  const done = new Set(finalCandidateOrder);
  for (const [id, state] of Object.entries(agentState || {})) {
    if (state === "done") done.add(id);
  }
  return done;
}
function missingMembersFromView(meta = {}) {
  const supplied = meta.missing_members || meta.missingMembers;
  if (Array.isArray(supplied)) return normalizeMemberRefs(supplied);
  const done = completedMemberIdsFromView();
  return (spec?.agents || [])
    .filter((agent) => !done.has(agent.id))
    .map((agent) => memberRefById(agent.id))
    .filter(Boolean);
}
function deliveryMemberFromMeta(finalId, meta = {}) {
  const direct = normalizeMemberRef(meta.final_member || meta.finalMember);
  if (direct?.id) return direct;
  const finalMemberId = meta.final_member_id || meta.finalMemberId;
  const byFinalMember = finalMemberId ? memberRefById(finalMemberId) : null;
  if (byFinalMember) return byFinalMember;
  const byFinalId = finalId && finalId !== ORCH_ID ? memberRefById(finalId) : null;
  if (byFinalId) return byFinalId;
  const fallbackId = [...finalCandidateOrder].reverse().find((id) => memberRefById(id));
  return memberRefById(fallbackId) || memberRefById(ORCH_ID);
}
function memberRefLabel(ref) {
  return `${ref?.emoji ? `${ref.emoji} ` : ""}${ref?.name || ref?.id || "未知成员"}`;
}
function renderFinalMeta(next = {}) {
  const el = $("final-meta");
  if (!el) return;
  finalMetaState = { ...finalMetaState, ...next };
  const { deliveryMember = null, missingMembers = [], usage = null, usageReady = false, usageHasUnknown = false } = finalMetaState;
  const missing = normalizeMemberRefs(missingMembers);
  const missingText = missing.length
    ? missing.map((item) => esc(memberRefLabel(item))).join("、")
    : "无";
  const rows = [
    `<span class="final-pill">交付成员：<b>${esc(memberRefLabel(deliveryMember || memberRefById(ORCH_ID)))}</b></span>`,
    `<span class="final-pill ${missing.length ? "warn" : "ok"}">未完成成员：<b>${missingText}</b></span>`,
  ];
  if (usageReady) rows.push(`<span class="final-pill">总 Token：<b>${esc(fmtBattleTokens(usage, usageHasUnknown))}</b></span>`);
  el.innerHTML = rows.join("");
}
function resolveFinalDelivery(finalId, meta = {}) {
  const memberIds = new Set((spec?.agents || []).map((agent) => agent.id));
  const deliveryMember = deliveryMemberFromMeta(finalId, meta);
  const missingMembers = missingMembersFromView(meta);
  if (finalId === ORCH_ID && runOutputs[ORCH_ID]) {
    return { id: ORCH_ID, by: "将军", text: runOutputs[ORCH_ID] || "", deliveryMember, missingMembers };
  }
  const direct = finalId && memberIds.has(finalId) ? finalId : "";
  const fallback = [...finalCandidateOrder].reverse().find((id) => memberIds.has(id) && runOutputs[id]);
  const id = direct || fallback || "";
  const agent = id ? spec.agents.find((item) => item.id === id) : null;
  return {
    id,
    by: agent ? (agent.name || id) : "最终结果",
    text: id ? (runOutputs[id] || "") : "",
    deliveryMember,
    missingMembers,
  };
}
function showFinalDelivery({ by = "最终结果", text = "", status = "done", deliveryMember = null, missingMembers = [] } = {}) {
  $("final-by").textContent = `${status === "failed" ? "失败" : status === "stopped" ? "已停战" : "出品"} · ${by}` + (runWorkDir ? `　📁 产物目录：${runWorkDir}` : "");
  finalMetaState = { deliveryMember: null, missingMembers: [], usage: null, usageReady: false };
  renderFinalMeta({ deliveryMember, missingMembers, usage: null, usageReady: false });
  renderOutput($("final-text"), text || "（无文本结果）");
  $("final").style.display = "block";
  setTimeout(balanceColumns, 350);
  requestIdleAutoFocus($("final"), { block: "start" });
}

function fmtBattleDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "--";
  const total = Math.round(n / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function fmtBattleTokens(usage, hasUnknown = false) {
  const totalRaw = usage?.total_tokens;
  const total = Number(totalRaw);
  if (totalRaw == null || !Number.isFinite(total)) return "未回传";
  const inputRaw = usage?.input_tokens;
  const outputRaw = usage?.output_tokens;
  const input = Number(inputRaw);
  const output = Number(outputRaw);
  const parts = [];
  if (inputRaw != null && Number.isFinite(input)) parts.push(`入 ${input.toLocaleString()}`);
  if (outputRaw != null && Number.isFinite(output)) parts.push(`出 ${output.toLocaleString()}`);
  // 有步骤未回传 token 时，已统计的只是下限，用 ≥ 标明（如 claude-code/codex 订阅模型不回传用量）
  const prefix = hasUnknown ? "≥ " : "";
  return `${prefix}${total.toLocaleString()} tokens${parts.length ? `（${parts.join(" / ")}）` : ""}`;
}
function battleStepTitle(step) {
  const base = step.title || `第 ${step.index || step.call_index || 1} 步`;
  const model = [step.provider, step.model].filter(Boolean).join(" · ");
  return model ? `${base} · ${model}` : base;
}
function battleStepSub(step) {
  const lines = [];
  if (step.instruction) lines.push(`任务：${step.instruction}`);
  if (step.reason) lines.push(`原因：${step.reason}`);
  if (Array.isArray(step.upstream_ids) && step.upstream_ids.length) lines.push(`输入：${step.upstream_ids.join("、")}`);
  if (step.result_chars != null) lines.push(`输出字符：${Number(step.result_chars).toLocaleString()}`);
  if (step.error) lines.push(`报错：${step.error}`);
  return lines.join("\n");
}
function renderBattleReport(report) {
  const card = $("battle-report");
  if (!card) return;
  const empty = $("battle-detail-empty");
  if (!report || !Array.isArray(report.members)) {
    card.style.display = "none";
    if (empty) empty.style.display = "";
    return;
  }
  const members = report.members.filter((m) => Array.isArray(m.steps) && m.steps.length);
  if (!members.length && !report.duration_ms) {
    card.style.display = "none";
    if (empty) empty.style.display = "";
    return;
  }
  if (empty) empty.style.display = "none";
  $("battle-total-tokens").textContent = fmtBattleTokens(report.usage, report.unknown_token_steps > 0);
  $("battle-total-duration").textContent = fmtBattleDuration(report.duration_ms);
  // 将军的"步"=调度轮次，成员的"步"=执行次，单位不同，分开统计避免混淆
  const orchRow = members.find((m) => m.is_orchestrator);
  const memberRows = members.filter((m) => !m.is_orchestrator);
  const orchRounds = orchRow ? orchRow.steps.length : 0;
  const execCount = memberRows.reduce((n, m) => n + (m.steps?.length || 0), 0);
  $("battle-total-steps").textContent = `${memberRows.length} 名成员 · 将军调度 ${orchRounds} 轮 · 成员执行 ${execCount} 次`;
  $("battle-meta").textContent = report.unknown_token_steps
    ? `${report.unknown_token_steps} 步模型未回传 token`
    : "token 已按模型回传统计";
  $("battle-members").innerHTML = members.map((m) => `
    <details class="battle-member">
      <summary>
        <span class="battle-name">${esc(m.emoji || "🤖")} ${esc(m.name || m.id)}</span>
        <span class="battle-pill">${fmtBattleTokens(m.usage, m.unknown_token_steps > 0)}</span>
        <span class="battle-pill">${fmtBattleDuration(m.duration_ms)}</span>
        <span class="battle-pill">${m.is_orchestrator ? `${m.steps.length} 轮调度` : `${m.steps.length} 次执行`}</span>
      </summary>
      <div class="battle-steps">
        ${m.steps.map((step) => `
          <div class="battle-step">
            <div>
              <div class="battle-step-title">${esc(battleStepTitle(step))}</div>
              ${battleStepSub(step) ? `<div class="battle-step-sub">${esc(battleStepSub(step))}</div>` : ""}
            </div>
            <span class="battle-pill">${fmtBattleTokens(step.usage)}</span>
            <span class="battle-pill">${fmtBattleDuration(step.duration_ms)}</span>
          </div>
        `).join("")}
      </div>
    </details>
  `).join("");
  card.style.display = "block";
}
function applyFinalBattleUsage(report) {
  if (!$("final") || $("final").style.display === "none") return;
  renderFinalMeta({ usage: report?.usage || null, usageReady: true, usageHasUnknown: report?.unknown_token_steps > 0 });
}
function battleRunDisplayName(row) {
  return runDisplayTitle(row) || row.team_name || "未命名记录";
}
function renderBattleDashboardList(list, selectedId) {
  const box = $("battle-run-list");
  if (!box) return;
  if (!Array.isArray(list) || !list.length) {
    box.innerHTML = '<div class="battle-detail-empty">还没有可统计的出征记录。</div>';
    return;
  }
  box.innerHTML = list.map((row) => `
    <button type="button" class="battle-run-item${row.run_id === selectedId ? " active" : ""}" data-battle-run="${esc(row.run_id)}">
      <span class="battle-run-title">${esc(row.emoji || "⚔")} ${esc(battleRunDisplayName(row))}</span>
      <span class="battle-run-meta">${esc(row.team_name || "无名团队")} · ${esc(fmtRunTime(row.started_at))} · ${esc(runStatusLabel(row.status))}</span>
      <span class="battle-run-cost">${esc(fmtBattleTokens(row.usage, row.unknown_token_steps > 0))} · ${esc(fmtBattleDuration(row.duration_ms))}</span>
    </button>
  `).join("");
  box.querySelectorAll("[data-battle-run]").forEach((el) => {
    el.addEventListener("click", () => {
      battleDashboardRunId = el.dataset.battleRun || "";
      renderBattleDashboardList(list, battleDashboardRunId);
      loadBattleReport(battleDashboardRunId, { dashboard: true });
    });
  });
}
async function loadBattleDashboard(preferredRunId = "") {
  const listBox = $("battle-run-list");
  const empty = $("battle-detail-empty");
  if (listBox) listBox.innerHTML = '<div class="battle-detail-empty">正在读取战损记录…</div>';
  if (empty) { empty.textContent = "选择左侧一条出征记录查看分层消耗。"; empty.style.display = ""; }
  renderBattleReport(null);
  try {
    const list = await (await fetch("/api/battle-reports", { cache: "no-store" })).json();
    if (!Array.isArray(list)) throw new Error("战损记录格式异常");
    const selected = list.find((row) => row.run_id === preferredRunId)?.run_id || list[0]?.run_id || "";
    battleDashboardRunId = selected;
    renderBattleDashboardList(list, selected);
    if (selected) await loadBattleReport(selected, { dashboard: true });
    else if (empty) empty.textContent = "还没有可统计的出征记录。";
  } catch (e) {
    if (listBox) listBox.innerHTML = '<div class="battle-detail-empty">战损看板加载失败，点击刷新重试。</div>';
    showError(e.message || "战损看板加载失败");
  }
}
function openBattleDashboard(runId = "") {
  const board = $("battle-dashboard");
  if (!board) return;
  hideBlueprint();
  board.style.display = "block";
  setBattleDashboardActive(true);
  loadBattleDashboard(runId || battleDashboardRunId || currentRunId || "");
  board.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function loadBattleReport(runId = currentRunId, opts = {}) {
  if (!runId) return null;
  try {
    const report = await (await fetch(`/api/runs/${runId}/report`, { cache: "no-store" })).json();
    if (report.error) return null;
    if (opts.finalMeta) applyFinalBattleUsage(report);
    if (opts.dashboard) renderBattleReport(report);
    return report;
  } catch {}
  return null;
}
$("battle-dashboard-link")?.addEventListener("click", () => openBattleDashboard());
$("battle-dashboard-refresh")?.addEventListener("click", () => loadBattleDashboard(battleDashboardRunId));

function handleEvent(ev) {
  if (ev.type === "replay_done") { // 历史回放段结束 → 之后的事件才走实时打字机
    streamReplaying = false;
    if (thinkOpenId) renderThinkChat();
    return;
  }
  if (ev.type === "skill_evolved") { // 团队被对话进化（改成员/新建成员/改全局 skill）
    if (spec) spec.evolved = true;
    const who = ev.by === ORCH_ID ? "将军" : (agentNameOf(ev.by) || "成员");
    bubble(ev.by, `🧬 团队已进化：${esc((ev.changes || []).join("、") || "更新 Skill")}`);
    setTimeout(() => bubble(ev.by, "", false), 6000);
    if (!streamReplaying && currentRunId) {
      // 拉取最新 spec（可能新增了成员/改了契约），刷新团队视图；产出由 reapplyRunOutputs 还原
      fetch(`/api/runs/${currentRunId}`, { cache: "no-store" }).then((r) => r.json()).then((rec) => {
        if (rec && rec.spec) { spec = rec.spec; spec.evolved = true; renderAll(); refreshRunButtonLabel(); }
      }).catch(() => {});
    }
    return;
  }
  if (ev.type === "run_start") {
    // 回放历史时（含被恢复/续聊的多段出征，会有多个 run_start）绝不清空已累积的思考/产出——
    // 否则后面的 run_start 会把前面段的历史思考全擦掉。只更新元信息，保留全部历史。
    if (streamReplaying) {
      runWorkDir = ev.work_dir || runWorkDir;
      currentRunId = ev.run_id || currentRunId;
      runActive = !attachedRunReplayOnly;
      setStopButton(runActive); // 重连到运行中的团队也要能停战
      runtimeMode = true;
      markThinkable(ORCH_ID);
      return;
    }
    const keepId = ev.continuation && thinkOpenId ? thinkOpenId : "";
    const keepThinkLog = keepId ? (thinkMessages[keepId] || []).slice() : null;
    const keepUserLog = keepId ? (userMsgs[keepId] || []).slice() : null;
    stopAllMemberOutputTypers();
    stopAllOutputStreams();
    resetRuntimeDanger();
    runWorkDir = ev.work_dir || null;
    Object.keys(activeRouteInputs).forEach((id) => delete activeRouteInputs[id]);
    Object.keys(pendingAsk).forEach((id) => delete pendingAsk[id]);
    Object.keys(autoThinkShown).forEach((id) => delete autoThinkShown[id]);
    Object.keys(thinkMessages).forEach((id) => delete thinkMessages[id]);
    Object.keys(thinkBuf).forEach((id) => delete thinkBuf[id]);
    refreshAskReopen();
    runActive = !attachedRunReplayOnly;
    setStopButton(runActive);
    currentRunId = ev.run_id || null;
    const runBtn = $("btn-run");
    if (runBtn && !attachedRunReplayOnly) { runBtn.disabled = true; runBtn.innerHTML = '<span class="spin"></span>出征中…'; }
    $("final").style.display = "none";
    if ($("final-meta")) $("final-meta").innerHTML = "";
    renderBattleReport(null);
    setRunError("");
    Object.keys(userMsgs).forEach((id) => delete userMsgs[id]);
    if (keepId) {
      thinkMessages[keepId] = keepThinkLog || [];
      userMsgs[keepId] = keepUserLog || [];
    }
    finalCandidateOrder = [];
    // 运行时 DAG：清空连线，从空白开始按将军实际路由逐步画出（成员仍全部显示）
    runtimeMode = true;
    runtimeEdges.clear();
    refreshBoardEdges();
    runOutputs[ORCH_ID] = "";
    if (keepId !== ORCH_ID) resetThink(ORCH_ID);
    else thinkBuf[ORCH_ID] = "";
    setOrchestratorStatus("将军思考中", "running", true);
    markThinkable(ORCH_ID);
    return;
  }
  if (ev.type === "member_call") {
    activeRouteInputs[ev.to] = Array.isArray(ev.upstream_ids) ? ev.upstream_ids : [];
    requestIdleAutoFocus($(`agent-${ev.to}`), { block: "center" });
    return;
  }
  if (ev.type === "ask_user") {
    const askId = ev.agent || ev.id;
    if (pendingAsk[askId] && pendingAsk[askId].qid === ev.qid) return;
    if ((ev.qid && resolvedAskQids.has(ev.qid)) || attachedRunReplayOnly) {
      addAskToChat(askId, { qid: ev.qid, question: ev.question });
      markThinkable(askId);
      return;
    }
    pendingAsk[askId] = { qid: ev.qid, question: ev.question };
    addAskToChat(askId, pendingAsk[askId]);
    const waitingText = ev.kind === "permission" ? "待你授权" : "待你确认";
    if (askId && askId !== ORCH_ID) setStatus(askId, waitingText, "waiting");
    // 出征未结束：按钮保持“出征中”，待确认状态通过对话框 + 成员状态体现，不改按钮文案。
    openThink(askId, { requiresAction: true });
    return;
  }
  if (ev.type === "ask_resolved") {
    const resolvedId = ev.agent || ev.id;
    if (ev.qid) resolvedAskQids.add(ev.qid);
    delete pendingAsk[resolvedId];
    if (resolvedId && resolvedId !== ORCH_ID) setStatus(resolvedId, "继续执行", "running");
    refreshAskReopen();
    return;
  }
  if (ev.type === "user_msg") { // 用户插话状态推进：processing=处理中，done=已处理
    const st = ev.status === "done" || ev.status === "processed" ? "done" : "processing";
    // 直接在 chatLog 里找/建用户条目——保证用户消息按【时间顺序】穿插在思考之间，而不是全堆到最底下。
    const log = chatLog(ev.id);
    const hit = log.find((m) => m.side === "user" && m.msgId === ev.msg_id)
      || log.find((m) => m.side === "user" && (m.status === "queued" || m.status === "processing") && (m.text || "") === (ev.text || ""));
    if (hit) { hit.msgId = ev.msg_id; if (!(hit.status === "done" && st === "processing")) hit.status = st; }
    else { pushChatEntry(ev.id, { side: "user", msgId: ev.msg_id, text: ev.text || "", status: st }); }
    if (thinkOpenId === ev.id) renderThinkChat();
    return;
  }
  if (ev.type === "agent_thinking") { pushThink(ev.id, ev.text); return; }
  if (ev.id === ORCH_ID) {
    // 出征期间将军状态始终“将军思考中”，保持团队状态一致；仅最终交付时转“已完成”。
    if (ev.type === "agent_start") {
      clearOutputStream(ORCH_ID, ev.call_index);
      setOrchestratorStatus("将军思考中", "running", true);
      markThinkable(ORCH_ID);
    } else if (ev.type === "agent_model") {
      setOrchestratorStatus("将军思考中", "running", true);
    } else if (ev.type === "agent_delta") {
      runOutputs[ORCH_ID] = (runOutputs[ORCH_ID] || "") + ev.text;
      pushOutputDelta(ORCH_ID, ev.text, ev.call_index);
      setOrchestratorStatus("将军思考中", "running", true);
    } else if (ev.type === "agent_done" && ev.result != null) {
      finishOutputStream(ORCH_ID, ev.result, ev.call_index);
      runOutputs[ORCH_ID] = String(ev.result);
    }
    return;
  }
  if (ev.type === "agent_model") {
    const sel = $(`agent-${ev.id}`)?.querySelector(".model-sel");
    const fallbackText = ev.fallback_from ? `；工具兜底自 ${ev.fallback_from.model || ""}` : "";
    if (sel) sel.title = "本次运行实际用：" + ev.model + (ev.provider ? " (" + ev.provider + ")" : "") + fallbackText;
    const actual = $(`actual-model-${ev.id}`);
    if (actual) {
      actual.textContent = "本次 " + (ev.model || "系统模型") + (ev.fallback_from ? " · 工具兜底" : "");
      actual.title = "本次运行实际 provider：" + (ev.provider || "未知") + fallbackText;
      actual.style.display = "inline-flex";
    }
  } else if (ev.type === "agent_notice") {
    bubble(ev.id, "⚠ " + esc(ev.text || "运行提示"));
  } else if (ev.type === "tool_call") {
    bubble(ev.id, "🛠 调用 " + esc(toolLabel(ev.tool)));
  } else if (ev.type === "tool_result") {
    bubble(ev.id, `${ev.ok ? "✓" : "✗"} ${esc(toolLabel(ev.tool))}`);
  } else if (ev.type === "agent_start") {
    setStatus(ev.id, "思考中", "running");
    setNode(ev.id, "running");
    thinkBuf[ev.id] = "";
    clearOutputStream(ev.id, ev.call_index);
    delete autoThinkShown[ev.id];
    markThinkable(ev.id);
    bubble(ev.id, '思考中<span class="dots"></span>');
    const call = outputCall(ev.id, ev.call_index);
    if (call.typingTimer) clearInterval(call.typingTimer);
    call.live = "";
    call.segments = [];
    call.queue = "";
    call.rawSegments = [];
    call.finalSegments = [];
    call.finalizeWhenTyped = false;
    call.typingTimer = null;
    runOutputs[ev.id] = "";
    renderMemberOriginals(ev.id);
    const a = spec.agents.find((x) => x.id === ev.id);
    const routedInputs = Object.prototype.hasOwnProperty.call(activeRouteInputs, ev.id)
      ? activeRouteInputs[ev.id]
      : (a?.depends_on || []);
    // 运行时 DAG：把本轮实际路由的连线加进图里（如 3→5），再沿新连线放交接动画
    if (runtimeMode) {
      routedInputs.forEach((dep) => runtimeEdges.add(`${dep}->${ev.id}`));
      refreshBoardEdges();
    }
    routedInputs.forEach((dep, i) => flyDoc(dep, ev.id, i * 220));
    delete activeRouteInputs[ev.id];
  } else if (ev.type === "agent_delta") {
    enqueueMemberDelta(ev.id, ev.call_index, ev.text);
    runOutputs[ev.id] = (runOutputs[ev.id] || "") + ev.text;
    pushOutputDelta(ev.id, ev.text, ev.call_index);
    const tail = runOutputs[ev.id].replace(/\s+/g, " ").trim().slice(-26);
    if (tail) bubble(ev.id, "💬 …" + esc(tail));
  } else if (ev.type === "agent_checkpoint") {
    const call = outputCall(ev.id, ev.call_index);
    const raw = String(ev.result || "");
    if (raw && call.rawSegments[call.rawSegments.length - 1] !== raw) call.rawSegments.push(raw);
    runOutputs[ev.id] = call.rawSegments.join("\n\n");
    finishOutputStream(ev.id, raw, ev.call_index);
    finalizeMemberOutput(ev.id, ev.call_index, call.rawSegments);
  } else if (ev.type === "agent_done") {
    setStatus(ev.id, "已完成", "done");
    setNode(ev.id, "done");
    // 该成员完成 → 它「处理中」的用户插话翻成「已处理」（覆盖运行中插话路径）
    (userMsgs[ev.id] || []).forEach((m) => { if (m.status === "processing") m.status = "done"; });
    if (thinkOpenId === ev.id) renderThinkChat();
    const call = outputCall(ev.id, ev.call_index);
    const finalSegments = Array.isArray(ev.original_segments) && ev.original_segments.length
      ? ev.original_segments.map(String)
      : [String(ev.result || "")];
    call.rawSegments = finalSegments;
    if (ev.result != null) runOutputs[ev.id] = String(ev.result);
    noteFinalCandidate(ev.id);
    finishOutputStream(ev.id, ev.result, ev.call_index);
    finalizeMemberOutput(ev.id, ev.call_index, finalSegments);
    bubble(ev.id, "✅ 搞定，交付！");
    setTimeout(() => bubble(ev.id, "", false), 2400);
  } else if (ev.type === "run_stopped") {
    // 用户手动停战：收尾、标记已停战，留痕给下次打开看
    stopAllOutputStreams();
    runActive = false;
    setStopButton(false);
    currentRunStatus = "stopped";
    setOrchestratorStatus("已停战", "", true);
    const runBtn = $("btn-run");
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = "出 征"; }
    const delivery = resolveFinalDelivery(ev.final_id, ev);
    showFinalDelivery({
      by: delivery.by,
      text: delivery.text || "⛔ 本次出征已被用户手动停战。",
      status: "stopped",
      deliveryMember: delivery.deliveryMember,
      missingMembers: delivery.missingMembers,
    });
    loadRunsSidebar();
    loadBattleReport(currentRunId, { finalMeta: true });
  } else if (ev.type === "run_done") {
    stopAllOutputStreams();
    runActive = false;
    setStopButton(false);
    currentRunStatus = "done";
    setOrchestratorStatus("将军已完成", "done", true);
    const runBtn = $("btn-run");
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = "出 征"; }
    const isOrch = ev.final_id === ORCH_ID;
    if (!isOrch) { bubble(ev.final_id, "🏆 最终交付完成"); setTimeout(() => bubble(ev.final_id, "", false), 5000); }
    const delivery = resolveFinalDelivery(ev.final_id, ev);
    showFinalDelivery({
      by: delivery.by,
      text: delivery.text,
      deliveryMember: delivery.deliveryMember,
      missingMembers: delivery.missingMembers,
    });
    loadBattleReport(currentRunId, { finalMeta: true });
  } else if (ev.type === "error") {
    // 成员/运行报错：结束“思考中”，按钮回“出征”，保持团队状态一致。
    stopAllOutputStreams();
    runActive = false;
    setStopButton(false);
    currentRunStatus = "failed";
    setRunError(ev.message || "未知错误");
    setOrchestratorStatus("将军已停止", "", true);
    const runBtn = $("btn-run");
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = "出 征"; }
    if (ev.id && ev.id !== ORCH_ID) setStatus(ev.id, "出错", "");
    const delivery = resolveFinalDelivery("", ev);
    showFinalDelivery({
      by: delivery.by,
      text: delivery.text,
      status: "failed",
      deliveryMember: delivery.deliveryMember,
      missingMembers: delivery.missingMembers,
    });
    loadBattleReport(currentRunId, { finalMeta: true });
  }
}

/* ============ 其他按钮 ============ */
$("btn-export").addEventListener("click", () => {
  if (!spec) return;
  const { secrets, ...safe } = spec; // 导出不带团队凭证
  const blob = new Blob([JSON.stringify(safe, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${spec.team_name || "team"}.json`;
  a.click();
});
$("btn-redesign").addEventListener("click", () => {
  // 不关闭当前团队，只回到顶部输入框；下一次点将会保留当前页面并自动打开军师思考。
  redesignThinkingWanted = true;
  $("design-hint").innerHTML = '重新点将准备好了：当前团队会先保留。下一次点将将自动打开军师思考。';
  $("desc").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
});
$("btn-copy").addEventListener("click", () => {
  navigator.clipboard.writeText($("final-text").dataset.raw || $("final-text").textContent).then(() => {
    $("btn-copy").textContent = "已复制 ✓";
    setTimeout(() => ($("btn-copy").textContent = "复制全文"), 1500);
  });
});
