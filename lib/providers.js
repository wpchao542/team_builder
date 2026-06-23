// 模型 provider 运行时：状态 + 模型注册表 + 各 provider 的 IO（anthropic/ollama/百炼/claude-code/codex）。
// 函数整体从 server.js 原样迁出，行为不变；可变状态作为本模块 let，并通过 module.exports 的
// getter/setter 暴露给 server.js（读写实时同步），保证"系统默认 provider 运行时可改"的语义不变。

const fs = require("fs");
const path = require("path");
const os = require("os");
const { clip, normalizeUsage } = require("./util");
const { extractJson } = require("./skills");

const MOCK = process.env.MOCK === "1";

let ANTHROPIC_MODEL = process.env.MODEL || "claude-opus-4-8";
let OLLAMA_HOST = process.env.OLLAMA_HOST_URL || "http://localhost:11434";
let OLLAMA_MODEL = process.env.OLLAMA_MODEL || "minimax-m3:cloud";
let CODEX_MODEL = process.env.CODEX_MODEL || "";
let DEFAULT_MODEL = process.env.DEFAULT_MODEL || null;
let CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
let claudeCliAvailable = false;
let ENABLE_CLAUDE_CODE = process.env.ENABLE_CLAUDE_CODE === "1";
let CODEX_BIN = process.env.CODEX_BIN || "codex";
let codexCliAvailable = false;
let codexCliLoggedIn = false;
let ENABLE_CODEX_CLI = process.env.ENABLE_CODEX_CLI === "1";
const configuredProvider = String(process.env.PROVIDER || "").toLowerCase();
let provider = MOCK ? "mock" : (normalizeProviderName(configuredProvider) || null);
let anthropicClient = null;
let ollamaReady = false;

function normalizeProviderName(raw) {
  const p = String(raw || "").toLowerCase();
  if (["codex", "openai-codex"].includes(p)) return "codex-cli";
  if (["anthropic", "ollama", "codex-cli", "claude-code", "bailian", "mock"].includes(p)) return p;
  return "";
}

function stableModelId(providerName, modelName) {
  const p = normalizeProviderName(providerName) || String(providerName || "model").toLowerCase();
  const m = String(modelName || "").trim();
  const json = JSON.stringify({ p, m });
  return "m_" + Buffer.from(json, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeModelId(id) {
  const raw = String(id || "").trim();
  if (!raw.startsWith("m_")) return null;
  try {
    const b64 = raw.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const obj = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    const p = normalizeProviderName(obj.p);
    const m = String(obj.m || "").trim();
    return p ? { provider: p, model: m } : null;
  } catch {
    return null;
  }
}

function makeModelEntry(providerName, modelName, opts = {}) {
  const p = normalizeProviderName(providerName) || String(providerName || "").toLowerCase();
  const model = String(modelName || "").trim();
  const id = opts.id || stableModelId(p, model);
  return {
    id,
    provider: p,
    model,
    label: opts.label || model || opts.name || p,
    name: opts.name || opts.label || model || p,
    badge: opts.badge || "",
    badgeCls: opts.badgeCls || "",
    desc: opts.desc || "",
  };
}

function addModelEntry(entries, seen, providerName, modelName, opts = {}) {
  const entry = makeModelEntry(providerName, modelName, opts);
  const key = `${entry.provider}\0${entry.model}`;
  if (seen.has(key)) return null;
  seen.add(key);
  entries.push(entry);
  return entry;
}

function legacyModelRoute(raw, baseProvider = provider) {
  const value = String(raw || "").trim();
  const lower = value.toLowerCase();
  const fallback = normalizeProviderName(baseProvider) || "ollama";
  if (!value) return null;
  if (lower.startsWith("claude-code:") || lower.startsWith("cc:")) {
    return { provider: "claude-code", model: value.slice(value.indexOf(":") + 1).trim() };
  }
  if (lower === "claude-code" || lower === "cc") return { provider: "claude-code", model: "" };
  if (lower === "codex" || lower === "codex-cli" || lower === "openai-codex") {
    return { provider: "codex-cli", model: CODEX_MODEL || "" };
  }
  if (lower.startsWith("codex:") || lower.startsWith("codex-cli:") || lower.startsWith("openai-codex:")) {
    return { provider: "codex-cli", model: value.slice(value.indexOf(":") + 1).trim() };
  }
  if (lower.startsWith("openai-codex/")) {
    return { provider: "codex-cli", model: value.slice(value.indexOf("/") + 1).trim() };
  }
  if (lower.startsWith("bailian:") || lower.startsWith("dashscope:")) {
    return { provider: "bailian", model: value.slice(value.indexOf(":") + 1).trim() };
  }
  if (lower.startsWith("ollama:")) {
    return { provider: "ollama", model: value.slice(value.indexOf(":") + 1).trim() };
  }
  if (lower.startsWith("claude") || lower.includes("anthropic")) {
    return { provider: "anthropic", model: value };
  }
  return { provider: fallback, model: value };
}

function currentModelRegistry() {
  const entries = [];
  const seen = new Set();
  const add = (p, m, opts) => addModelEntry(entries, seen, p, m, opts);
  const anthropicAvailable = !!anthropicClient || provider === "anthropic";
  const ccEnabled = claudeCliAvailable && ENABLE_CLAUDE_CODE;
  const codexEnabled = codexCliAvailable && codexCliLoggedIn && ENABLE_CODEX_CLI;
  if (ccEnabled) {
    add("claude-code", "opus", { label: "Claude Code Opus", badge: "订阅", badgeCls: "sub", desc: "Claude Code 订阅 · 自主工具强 · 思考原文不回传" });
    add("claude-code", "sonnet", { label: "Claude Code Sonnet", badge: "订阅", badgeCls: "sub", desc: "Claude Code 订阅 · 自主工具强 · 思考原文不回传" });
  }
  if (codexEnabled) {
    add("codex-cli", CODEX_MODEL || "", { label: CODEX_MODEL || "Codex 默认模型", badge: "订阅", badgeCls: "sub", desc: "Codex（ChatGPT 订阅）· 自主能力强 · 思考原文不回传" });
  }
  if (anthropicAvailable) {
    add("anthropic", ANTHROPIC_MODEL, { badge: "API", badgeCls: "api", desc: "Anthropic API · 思考可见（需 API key）" });
    add("anthropic", "claude-opus-4-8", { badge: "API", badgeCls: "api", desc: "Anthropic API · 思考可见（需 API key）" });
    add("anthropic", "claude-sonnet-4-6", { badge: "API", badgeCls: "api", desc: "Anthropic API · 思考可见（需 API key）" });
    add("anthropic", "claude-haiku-4-5-20251001", { badge: "API", badgeCls: "api", desc: "Anthropic API · 思考可见（需 API key）" });
  }
  if (process.env.DASHSCOPE_API_KEY) {
    add("bailian", process.env.BAILIAN_MODEL || "qwen-max", { badge: "百炼", badgeCls: "bl", desc: "阿里百炼 · 推理模型思考可见（需 DashScope key）" });
    add("bailian", "qwen-plus", { badge: "百炼", badgeCls: "bl", desc: "阿里百炼 · 推理模型思考可见（需 DashScope key）" });
  }
  add("ollama", OLLAMA_MODEL, {
    badge: String(OLLAMA_MODEL).endsWith(":cloud") ? "Ollama Cloud" : "Ollama",
    badgeCls: "api",
    desc: String(OLLAMA_MODEL).endsWith(":cloud")
      ? "Ollama 云端模型 · 需要 Ollama 订阅/账号权限"
      : "本地 Ollama · 推理模型思考过程可见",
  });
  return entries;
}

function resolveModelSelection(selection, baseProvider = provider) {
  const raw = String(selection || "").trim();
  const registry = currentModelRegistry();
  if (raw) {
    const byId = registry.find((entry) => entry.id === raw);
    if (byId) return byId;
    const decoded = decodeModelId(raw);
    if (decoded) return makeModelEntry(decoded.provider, decoded.model, { desc: "模型 id 还原项" });
    const legacy = legacyModelRoute(raw, baseProvider);
    if (legacy) {
      const id = stableModelId(legacy.provider, legacy.model);
      return registry.find((entry) => entry.id === id) ||
        makeModelEntry(legacy.provider, legacy.model, {
          badge: legacy.provider === "bailian" ? "百炼" : legacy.provider === "ollama" ? "Ollama" : "",
          badgeCls: legacy.provider === "bailian" ? "bl" : legacy.provider === "ollama" ? "api" : "",
          desc: "旧配置兼容项",
        });
    }
  }
  return systemDefaultModelEntry(baseProvider);
}

function systemDefaultModelEntry(p = provider) {
  if (DEFAULT_MODEL) return resolveModelSelection(DEFAULT_MODEL, p);
  const np = normalizeProviderName(p) || "ollama";
  if (np === "anthropic") return makeModelEntry("anthropic", ANTHROPIC_MODEL, { badge: "API", badgeCls: "api" });
  if (np === "ollama") return makeModelEntry("ollama", OLLAMA_MODEL, { badge: String(OLLAMA_MODEL).endsWith(":cloud") ? "Ollama Cloud" : "Ollama", badgeCls: "api" });
  if (np === "codex-cli") return makeModelEntry("codex-cli", CODEX_MODEL || "", { label: CODEX_MODEL || "Codex 默认模型", badge: "订阅", badgeCls: "sub" });
  if (np === "bailian") return makeModelEntry("bailian", process.env.BAILIAN_MODEL || "qwen-plus", { badge: "百炼", badgeCls: "bl" });
  if (np === "claude-code") return makeModelEntry("claude-code", "opus", { label: "Claude Code Opus", badge: "订阅", badgeCls: "sub" });
  return makeModelEntry("mock", "mock", { label: "演示模型" });
}

// 系统默认模型 id（无 agent 级覆盖时用它）。展示名从 /api/meta 的 models 里按 id 取。
function systemDefaultModel(p = provider) {
  return systemDefaultModelEntry(p).id;
}

function providerForModel(model, baseProvider = provider) {
  return resolveModelSelection(model, baseProvider).provider;
}

// 从 "bailian:qwen-max" / "dashscope:qwen-plus" 取出真实模型名；裸 "qwen-max" 原样返回
function bailianModelArg(model) {
  const m = String(model || "");
  const byId = currentModelRegistry().find((entry) => entry.id === m);
  if (byId) return byId.model;
  const decoded = decodeModelId(m);
  if (decoded) return decoded.model;
  const i = m.indexOf(":");
  return (m.startsWith("bailian:") || m.startsWith("dashscope:")) && i >= 0 ? m.slice(i + 1).trim() : m;
}

// 从 "ollama:qwen3:8b" 取出真实 Ollama 模型名；裸模型名原样返回
function ollamaModelArg(model) {
  const m = String(model || "").trim();
  const byId = currentModelRegistry().find((entry) => entry.id === m);
  if (byId) return byId.model;
  const decoded = decodeModelId(m);
  if (decoded) return decoded.model;
  return m.toLowerCase().startsWith("ollama:") ? m.slice(m.indexOf(":") + 1).trim() : m;
}

// 从 "claude-code:opus" / "cc:sonnet" 里取出给 CLI 的 --model 别名；裸 "claude-code" 则用默认
function ccModelArg(model) {
  const m = String(model || "");
  const byId = currentModelRegistry().find((entry) => entry.id === m);
  if (byId) return byId.model;
  const decoded = decodeModelId(m);
  if (decoded) return decoded.model;
  const i = m.indexOf(":");
  if (i >= 0) return m.slice(i + 1).trim();
  return /^(opus|sonnet|haiku)$/i.test(m.trim()) ? m.trim() : "";
}

// codex / codex:gpt-* / openai-codex/gpt-* → 传给 codex exec --model 的真实模型名。
function codexModelArg(model) {
  const m = String(model || "").trim();
  const byId = currentModelRegistry().find((entry) => entry.id === m);
  if (byId) return byId.model || CODEX_MODEL;
  const decoded = decodeModelId(m);
  if (decoded) return decoded.model || CODEX_MODEL;
  if (!m || ["codex", "codex-cli", "openai-codex"].includes(m.toLowerCase())) return CODEX_MODEL;
  const colon = m.indexOf(":");
  if (colon >= 0) return m.slice(colon + 1).trim();
  const slash = m.indexOf("/");
  return slash >= 0 ? m.slice(slash + 1).trim() : m;
}

async function ollamaAlive() {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

// 探测本机是否装了 claude CLI（用于 claude-code provider）。逐个候选路径试，找到就把 CLAUDE_BIN 定到它，
// 避免后台进程 PATH 不含 ~/.local/bin 时探测不到。
function checkClaudeCli() {
  const home = process.env.HOME || "";
  const candidates = [CLAUDE_BIN, `${home}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude"]
    .filter((v, i, a) => v && a.indexOf(v) === i);
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return resolve(false);
      const bin = candidates[i++];
      try {
        const cp = require("child_process").spawn(bin, ["--version"], { stdio: "ignore" });
        cp.on("error", tryNext);
        cp.on("close", (code) => { if (code === 0) { CLAUDE_BIN = bin; resolve(true); } else tryNext(); });
      } catch { tryNext(); }
    };
    tryNext();
  });
}

function checkCodexCli() {
  const home = process.env.HOME || "";
  const candidates = [CODEX_BIN, `${home}/.local/bin/codex`, "/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex"]
    .filter((v, i, a) => v && a.indexOf(v) === i);
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return resolve(false);
      const bin = candidates[i++];
      try {
        const cp = require("child_process").spawn(bin, ["--version"], { stdio: "ignore" });
        cp.on("error", tryNext);
        cp.on("close", (code) => { if (code === 0) { CODEX_BIN = bin; resolve(true); } else tryNext(); });
      } catch { tryNext(); }
    };
    tryNext();
  });
}

function checkCodexLogin() {
  if (!codexCliAvailable) return Promise.resolve(false);
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    let cp;
    try { cp = require("child_process").spawn(CODEX_BIN, ["login", "status"], { env }); }
    catch { resolve(false); return; }
    let output = "";
    cp.stdout.on("data", (d) => { output += d; });
    cp.stderr.on("data", (d) => { output += d; });
    cp.on("error", () => resolve(false));
    cp.on("close", (code) => resolve(code === 0 && /logged in|chatgpt/i.test(output)));
  });
}

async function initProvider() {
  if (provider === "mock") return;
  // 不管系统默认是谁，能备好的客户端都备好——混合架构里某个 agent 可能单独指定另一家的模型
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    const Anthropic = require("@anthropic-ai/sdk");
    anthropicClient = new Anthropic();
  }
  claudeCliAvailable = await checkClaudeCli();
  codexCliAvailable = await checkCodexCli();
  codexCliLoggedIn = await checkCodexLogin();
  ollamaReady = await ollamaAlive();
  if (!provider) {
    if (anthropicClient) provider = "anthropic";
    else if (ollamaReady) provider = "ollama";
    else if (ENABLE_CODEX_CLI && codexCliAvailable && codexCliLoggedIn) provider = "codex-cli";
    else if (process.env.DASHSCOPE_API_KEY) provider = "bailian";
    else {
      console.error(
        "\n[点将台] 没有可用的模型来源。请选择一种：\n" +
          "  1. 在 config.json 或 .env 配 ANTHROPIC_API_KEY=sk-ant-...\n" +
          "  2. 执行 codex login，并在配置中心启用 Codex ChatGPT 订阅\n" +
          "  3. 启动本地 Ollama（默认连 " + OLLAMA_HOST + "，模型 " + OLLAMA_MODEL + "）\n" +
          "  4. 演示模式: MOCK=1 node server.js\n"
      );
      process.exit(1);
    }
  }
  if (provider === "anthropic" && !anthropicClient) {
    console.error("\n[点将台] PROVIDER=anthropic 但没配 ANTHROPIC_API_KEY（config.json / .env / env 均可）。\n");
    process.exit(1);
  }
  if (provider === "ollama" && !ollamaReady) {
    console.error(`\n[点将台] 连不上 Ollama（${OLLAMA_HOST}），先执行 ollama serve 或检查 OLLAMA_HOST_URL。\n`);
    process.exit(1);
  }
  if (provider === "codex-cli" && (!codexCliAvailable || !codexCliLoggedIn)) {
    console.error("\n[点将台] PROVIDER=codex-cli，但未检测到可用的 Codex ChatGPT 登录态。请先执行 codex login。\n");
    process.exit(1);
  }
  if (provider === "bailian" && !process.env.DASHSCOPE_API_KEY) {
    console.error("\n[点将台] PROVIDER=bailian，但没配 DASHSCOPE_API_KEY（config.json / .env / env 均可）。\n");
    process.exit(1);
  }
}

function ollamaErrorText(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const obj = JSON.parse(text);
    if (typeof obj?.error === "string") return obj.error;
    if (obj?.error) return JSON.stringify(obj.error);
  } catch {}
  return text;
}

function isOllamaSubscriptionError(text) {
  return /requires a subscription|upgrade for access|ollama\.com\/upgrade/i.test(String(text || ""));
}

function formatOllamaError(raw, model) {
  const text = ollamaErrorText(raw);
  if (isOllamaSubscriptionError(text)) {
    return `Ollama Cloud 模型「${model || OLLAMA_MODEL}」需要 Ollama 订阅或当前账号没有访问权限。\n原始错误：${text}`;
  }
  return text;
}

// messages 给了就用它（多轮工具循环用），否则用 system+user 拼一轮。tools 给了就开函数调用，返回 toolCalls。
async function ollamaChat({ system, user, schema, onDelta, onThinking, model, think, messages, tools, signal }) {
  // 想看思考时默认开 think（推理模型才会把 thinking 单独流出来，如 minimax-m3）
  const wantThink = think !== undefined ? think : !!onThinking;
  const msgs = Array.isArray(messages) ? messages : [{ role: "system", content: system }, { role: "user", content: user }];
  const effectiveModel = ollamaModelArg(model) || OLLAMA_MODEL;
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: effectiveModel,
      stream: true,
      ...(wantThink ? { think: true } : {}),
      ...(schema ? { format: schema } : {}),
      ...(tools && tools.length ? { tools } : {}),
      messages: msgs,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).trim();
    // 模型不支持 thinking 时 ollama 会报错：去掉 think 重试一次
    if (wantThink && /think/i.test(detail) && !isOllamaSubscriptionError(detail)) {
      return ollamaChat({ system, user, schema, onDelta, onThinking, model, think: false, messages, tools, signal });
    }
    throw new Error(formatOllamaError(detail, effectiveModel) || `Ollama HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", thinking = "";
  const toolCalls = [];
  let usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const chunk = JSON.parse(line);
      if (chunk.error) throw new Error(formatOllamaError(typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error, null, 2), effectiveModel));
      const th = chunk.message?.thinking || "";
      if (th) { thinking += th; if (onThinking) onThinking(th); }
      const delta = chunk.message?.content || "";
      if (delta) { content += delta; if (onDelta) onDelta(delta); }
      const tcs = chunk.message?.tool_calls;
      if (Array.isArray(tcs)) for (const tc of tcs) {
        const fn = tc.function || {};
        let args = fn.arguments;
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        toolCalls.push({ id: tc.id || `call_${toolCalls.length}`, name: fn.name, args: args || {} });
      }
      if (chunk.done || chunk.prompt_eval_count != null || chunk.eval_count != null) {
        usage = normalizeUsage({
          prompt_eval_count: chunk.prompt_eval_count,
          eval_count: chunk.eval_count,
          total: chunk.prompt_eval_count != null || chunk.eval_count != null
            ? (Number(chunk.prompt_eval_count || 0) + Number(chunk.eval_count || 0))
            : undefined,
        }) || usage;
      }
    }
  }
  return { content, thinking, toolCalls, usage };
}

// 阿里百炼 / DashScope：OpenAI 兼容的 /chat/completions，SSE 流式
// 思考型模型（qwen3 / qwq / deepseek-r1）把推理放在 delta.reasoning_content，需要 enable_thinking 打开
async function bailianChat({ system, user, model, onDelta, onThinking, jsonMode, think, messages, tools, signal }) {
  const base = process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const key = process.env.DASHSCOPE_API_KEY || "";
  const wantThink = think !== undefined ? think : !!onThinking;
  const msgs = Array.isArray(messages) ? messages : [{ role: "system", content: system }, { role: "user", content: user }];
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal,
    body: JSON.stringify({
      model: bailianModelArg(model) || process.env.BAILIAN_MODEL || "qwen-plus",
      stream: true,
      ...(wantThink ? { enable_thinking: true } : {}),
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      ...(tools && tools.length ? { tools } : {}),
      stream_options: { include_usage: true },
      messages: msgs,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).trim();
    // 模型不支持思考（或思考与 json 模式不可同时开）时，去掉 enable_thinking 重试一次
    if (wantThink && /think/i.test(detail)) {
      return bailianChat({ system, user, model, onDelta, onThinking, jsonMode, think: false, messages, tools });
    }
    throw new Error(detail || `百炼 HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", thinking = "";
  const tcAccum = []; // OpenAI 流式 tool_calls 按 index 分片累积 arguments
  let usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data);
        usage = normalizeUsage(obj.usage) || usage;
        const delta = obj.choices?.[0]?.delta || {};
        const th = delta.reasoning_content || "";
        if (th) { thinking += th; if (onThinking) onThinking(th); }
        const d = delta.content || "";
        if (d) { content += d; if (onDelta) onDelta(d); }
        if (Array.isArray(delta.tool_calls)) for (const tc of delta.tool_calls) {
          const i = tc.index ?? tcAccum.length;
          tcAccum[i] = tcAccum[i] || { id: "", name: "", argStr: "" };
          if (tc.id) tcAccum[i].id = tc.id;
          if (tc.function?.name) tcAccum[i].name = tc.function.name;
          if (tc.function?.arguments) tcAccum[i].argStr += tc.function.arguments;
        }
      } catch {}
    }
  }
  const toolCalls = tcAccum.filter(Boolean).map((t, i) => {
    let args = {};
    try { args = t.argStr ? JSON.parse(t.argStr) : {}; } catch { args = {}; }
    return { id: t.id || `call_${i}`, name: t.name, args };
  });
  return { content, thinking, toolCalls, usage };
}

// 用 claude-code CLI 跑一次性出文本（设计阶段用，走订阅）。传 onThinking 时用 stream-json 实时吐思考。
function claudeCodeOnce(system, user, modelArg, onThinking) {
  return new Promise((resolve, reject) => {
    const streaming = typeof onThinking === "function";
    const args = ["-p", "--output-format", streaming ? "stream-json" : "json"];
    if (streaming) args.push("--verbose");
    if (modelArg) args.push("--model", modelArg);
    // 用 --system-prompt 替换（而非 append）默认编码助手提示，否则模型不会老实只输出 JSON
    if (system) args.push("--system-prompt", system);
    args.push("--disallowedTools", "Bash Edit Write NotebookEdit Read Task WebSearch WebFetch"); // 设计阶段纯产出，别动工具
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
    let cp;
    try { cp = require("child_process").spawn(CLAUDE_BIN, args, { env }); }
    catch (e) { reject(e); return; }
    let out = "", err = "", settled = false, streamResult = "", streamBuf = "", streamErr = false;
    cp.stdout.on("data", (d) => {
      out += d;
      if (!streaming) return;
      streamBuf += d;
      let nl;
      while ((nl = streamBuf.indexOf("\n")) >= 0) {
        const line = streamBuf.slice(0, nl).trim(); streamBuf = streamBuf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "assistant" && ev.message?.content) {
          for (const b of ev.message.content) {
            if (b.type === "thinking" && (b.thinking || b.text)) { try { onThinking(b.thinking || b.text); } catch {} }
          }
        } else if (ev.type === "result") {
          if (typeof ev.result === "string") streamResult = ev.result;
          if (ev.is_error) streamErr = true;
        }
      }
    });
    cp.stderr.on("data", (d) => (err += d));
    cp.on("error", (e) => { if (settled) return; settled = true; reject(new Error(`无法启动 Claude Code CLI：${e.message}`)); });
    cp.on("close", (code) => {
      if (settled) return;
      settled = true;
      let resultText, isErr;
      if (streaming) { resultText = streamResult; isErr = streamErr; }
      else {
        let payload = null;
        try { payload = JSON.parse(out); } catch { try { payload = extractJson(out); } catch {} }
        resultText = (payload && typeof payload.result === "string") ? payload.result : out;
        isErr = payload?.is_error === true || payload?.type === "error";
      }
      const detail = String(resultText || err || "").trim();
      if (code !== 0 || isErr) { reject(new Error(detail || `Claude Code exited with code ${code}`)); return; }
      if (!detail) { reject(new Error("(empty response)")); return; }
      resolve(detail);
    });
    cp.stdin.write(user); cp.stdin.end();
  });
}

function codexPrompt(system, user, allowTools) {
  return `# 执行身份与最高优先级规则

${system || "严格完成用户任务。"}

# 工具边界

${allowTools
    ? "可使用完成任务所必需的命令和文件操作：默认在当前工作目录内进行，必要时也可写到任务指定的路径（含绝对路径）；遵守上面的工具授权与交付约束。"
    : "本轮禁止调用 shell、修改文件或使用其他工具，只能直接生成回答。"}

# 本轮任务

${user}`;
}

function codexEventData(ev) {
  const item = ev?.item || {};
  if ((ev?.type === "item.completed" || ev?.type === "item.updated") && item.type === "agent_message") {
    return { kind: "message", text: String(item.text || "") };
  }
  if ((ev?.type === "item.completed" || ev?.type === "item.updated") && item.type === "reasoning") {
    return { kind: "thinking", text: String(item.text || item.summary || "") };
  }
  if (ev?.type === "item.started" && item.type === "command_execution") {
    return { kind: "tool_call", tool: "shell", input: { command: item.command || "" } };
  }
  if (ev?.type === "item.completed" && item.type === "command_execution") {
    return {
      kind: "tool_result",
      tool: "shell",
      ok: item.status === "completed" && (item.exit_code == null || item.exit_code === 0),
      summary: String(item.aggregated_output || item.output || ""),
    };
  }
  if (ev?.type === "item.started" && (item.type === "mcp_tool_call" || item.type === "tool_call")) {
    return { kind: "tool_call", tool: item.tool || item.name || item.server || "tool", input: item.arguments || item.input || {} };
  }
  if (ev?.type === "item.completed" && (item.type === "mcp_tool_call" || item.type === "tool_call")) {
    return {
      kind: "tool_result",
      tool: item.tool || item.name || item.server || "tool",
      ok: item.status !== "failed",
      summary: String(item.result || item.output || item.error || ""),
    };
  }
  if (ev?.type === "error" || ev?.type === "turn.failed") {
    return { kind: "error", text: String(ev.message || ev.error?.message || ev.error || "") };
  }
  return null;
}

function looksLikeCodexProcessText(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  return /(?:我会|我先|我现在|现在先|先确认|先读取|先尝试|接下来|正在|尝试|需要授权|权限|Operation not permitted|Permission denied|not permitted|无法写入|不能写入|工作目录|sandbox|read-?only)/i.test(raw);
}

function codexOutputSchema(schema) {
  if (Array.isArray(schema)) return schema.map(codexOutputSchema);
  if (!schema || typeof schema !== "object") return schema;
  const normalized = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, codexOutputSchema(value)])
  );
  if (normalized.type === "object" && normalized.properties && typeof normalized.properties === "object") {
    normalized.additionalProperties = false;
    normalized.required = Object.keys(normalized.properties);
  }
  return normalized;
}

function codexExecOnce({
  system,
  user,
  schema,
  modelArg,
  onThinking,
  onEvent,
  cwd,
  sandbox = "danger-full-access",
  allowTools = false,
  secrets = {},
}) {
  return new Promise((resolve, reject) => {
    let workDir = cwd || process.cwd();
    try {
      if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
    } catch {
      workDir = process.cwd();
    }

    const args = [
      "-a", "never",
      "exec",
      "--json",
      "--color", "never",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--ignore-user-config",
      "--sandbox", sandbox,
      "-C", workDir,
    ];
    // 兼容保留：如果未来显式传 workspace-write，仍打开网络；当前点将台的 Codex 调用统一走 danger-full-access。
    if (sandbox === "workspace-write") args.push("-c", "sandbox_workspace_write.network_access=true");
    if (modelArg) args.push("--model", modelArg);

    let schemaDir = "";
    if (schema) {
      schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-codex-"));
      const schemaPath = path.join(schemaDir, "output-schema.json");
      fs.writeFileSync(schemaPath, JSON.stringify(codexOutputSchema(schema)));
      args.push("--output-schema", schemaPath);
    }
    args.push("-");

    const env = { ...process.env, ...secrets };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;

    let cp;
    try { cp = require("child_process").spawn(CODEX_BIN, args, { cwd: workDir, env }); }
    catch (e) {
      if (schemaDir) fs.rmSync(schemaDir, { recursive: true, force: true });
      reject(new Error(`无法启动 Codex CLI：${e.message}`));
      return;
    }

    let buf = "", stderr = "", finalText = "", eventError = "", settled = false;
    const handleLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      const data = codexEventData(ev);
      if (!data) return;
      if (data.kind === "message" && data.text) finalText = data.text;
      else if (data.kind === "thinking" && data.text && onThinking) {
        try { onThinking(data.text); } catch {}
      } else if (data.kind === "error" && data.text) eventError = data.text;
      if (onEvent) {
        try { onEvent(data); } catch {}
      }
    };

    cp.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    cp.stderr.on("data", (d) => { stderr += d; });
    cp.on("error", (e) => {
      if (settled) return;
      settled = true;
      if (schemaDir) fs.rmSync(schemaDir, { recursive: true, force: true });
      reject(new Error(`无法启动 Codex CLI：${e.message}`));
    });
    cp.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (buf.trim()) handleLine(buf);
      if (schemaDir) fs.rmSync(schemaDir, { recursive: true, force: true });
      const detail = String(finalText || eventError || stderr || "").trim();
      if (code !== 0) {
        reject(new Error(detail || `Codex CLI exited with code ${code}`));
        return;
      }
      if (!finalText.trim()) {
        reject(new Error(detail || "(empty response)"));
        return;
      }
      resolve(finalText);
    });
    cp.stdin.write(codexPrompt(system, user, allowTools));
    cp.stdin.end();
  });
}

// 单轮模型调用，归一成 { content, toolCalls:[{id,name,args}], usage, anthRaw }
async function modelTurn({ eff, model, system, messages, toolDefs, onThinking, onDelta, signal }) {
  if (eff === "anthropic") {
    const stream = anthropicClient.messages.stream({
      model, max_tokens: 64000, thinking: { type: "adaptive" }, system, messages,
      tools: toolDefs.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
    }, signal ? { signal } : undefined);
    if (onDelta) stream.on("text", onDelta);
    if (onThinking) stream.on("thinking", onThinking);
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("模型拒绝了本次请求。");
    const content = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const toolCalls = msg.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
    return { content, toolCalls, usage: msg.usage, anthRaw: msg.content };
  }
  const chat = eff === "bailian" ? bailianChat : ollamaChat;
  const fnTools = toolDefs.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
  const { content, toolCalls, usage } = await chat({ messages, tools: fnTools, model, onThinking, onDelta, signal });
  return { content: content || "", toolCalls: toolCalls || [], usage };
}

module.exports = { normalizeProviderName, stableModelId, decodeModelId, makeModelEntry, addModelEntry, legacyModelRoute, currentModelRegistry, resolveModelSelection, systemDefaultModelEntry, systemDefaultModel, providerForModel, bailianModelArg, ollamaModelArg, ccModelArg, codexModelArg, ollamaAlive, checkClaudeCli, checkCodexCli, checkCodexLogin, initProvider, ollamaErrorText, isOllamaSubscriptionError, formatOllamaError, ollamaChat, bailianChat, claudeCodeOnce, codexPrompt, codexEventData, looksLikeCodexProcessText, codexOutputSchema, codexExecOnce, modelTurn };
Object.defineProperties(module.exports, {
  provider: { get: () => provider, set: (x) => { provider = x; }, enumerable: true },
  anthropicClient: { get: () => anthropicClient, set: (x) => { anthropicClient = x; }, enumerable: true },
  ollamaReady: { get: () => ollamaReady, set: (x) => { ollamaReady = x; }, enumerable: true },
  claudeCliAvailable: { get: () => claudeCliAvailable, set: (x) => { claudeCliAvailable = x; }, enumerable: true },
  codexCliAvailable: { get: () => codexCliAvailable, set: (x) => { codexCliAvailable = x; }, enumerable: true },
  codexCliLoggedIn: { get: () => codexCliLoggedIn, set: (x) => { codexCliLoggedIn = x; }, enumerable: true },
  ANTHROPIC_MODEL: { get: () => ANTHROPIC_MODEL, set: (x) => { ANTHROPIC_MODEL = x; }, enumerable: true },
  OLLAMA_HOST: { get: () => OLLAMA_HOST, set: (x) => { OLLAMA_HOST = x; }, enumerable: true },
  OLLAMA_MODEL: { get: () => OLLAMA_MODEL, set: (x) => { OLLAMA_MODEL = x; }, enumerable: true },
  CODEX_MODEL: { get: () => CODEX_MODEL, set: (x) => { CODEX_MODEL = x; }, enumerable: true },
  CLAUDE_BIN: { get: () => CLAUDE_BIN, set: (x) => { CLAUDE_BIN = x; }, enumerable: true },
  CODEX_BIN: { get: () => CODEX_BIN, set: (x) => { CODEX_BIN = x; }, enumerable: true },
  ENABLE_CLAUDE_CODE: { get: () => ENABLE_CLAUDE_CODE, set: (x) => { ENABLE_CLAUDE_CODE = x; }, enumerable: true },
  ENABLE_CODEX_CLI: { get: () => ENABLE_CODEX_CLI, set: (x) => { ENABLE_CODEX_CLI = x; }, enumerable: true },
  DEFAULT_MODEL: { get: () => DEFAULT_MODEL, set: (x) => { DEFAULT_MODEL = x; }, enumerable: true },
});
