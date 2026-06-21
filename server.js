// 点将台 (AgentTeam Studio)
// 用一句话生成一个 agent 团队，并真正把团队跑起来。
// 启动: ANTHROPIC_API_KEY=sk-... node server.js
// 演示: MOCK=1 node server.js  (不调用 API，用假数据演示完整流程)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = process.env.PORT || 7860;
const MOCK = process.env.MOCK === "1";
const CONFIG_RUNTIME_KEYS = [
  "DEFAULT_MODEL", "PROVIDER", "MODEL",
  "OLLAMA_MODEL", "OLLAMA_HOST_URL",
  "CODEX_MODEL", "CODEX_BIN", "ENABLE_CODEX_CLI",
  "CLAUDE_BIN", "ENABLE_CLAUDE_CODE",
  "BAILIAN_MODEL", "BAILIAN_BASE_URL",
  "ALLOW_TOOLS", "TOOL_TIMEOUT_MS",
];

loadDotEnv();
loadConfig(); // config.json：统一存放各种 key 与模型配置（会注入 process.env，shell 工具的 curl 也能用）
// 这些都用 let：配置中心保存后可在运行时重新派生（它们都在调用时读取，改了立即生效）
let ANTHROPIC_MODEL = process.env.MODEL || "claude-opus-4-8";
let OLLAMA_HOST = process.env.OLLAMA_HOST_URL || "http://localhost:11434";
let OLLAMA_MODEL = process.env.OLLAMA_MODEL || "minimax-m3:cloud";
let CODEX_MODEL = process.env.CODEX_MODEL || "";

// 运行时可改的系统默认模型（null = 用启动时按 provider 推断的）。界面可改并写回 config.json。
let DEFAULT_MODEL = process.env.DEFAULT_MODEL || null;
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
let CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
let claudeCliAvailable = false;
let ENABLE_CLAUDE_CODE = process.env.ENABLE_CLAUDE_CODE === "1"; // 需在配置中心显式启用，模型下拉才显示 claude-code:*
let CODEX_BIN = process.env.CODEX_BIN || "codex";
let codexCliAvailable = false;
let codexCliLoggedIn = false;
let ENABLE_CODEX_CLI = process.env.ENABLE_CODEX_CLI === "1";

// provider: anthropic | ollama | bailian | codex-cli | mock —— 这是「系统默认」provider；agent 可用 model 字段单独覆盖（混合架构）
// 优先级：MOCK=1 > 显式 PROVIDER > 有 ANTHROPIC_API_KEY 走 Claude > 本地 Ollama 在线就用它
const configuredProvider = String(process.env.PROVIDER || "").toLowerCase();
let provider = MOCK
  ? "mock"
  : (normalizeProviderName(configuredProvider) || null);
let anthropicClient = null; // 只要配了 key 就备好，供 agent 级 claude 模型用（即便系统默认是 ollama）
let ollamaReady = false;

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

// 极简 .env 解析，不引依赖
function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function applyConfigEnv(flat, target = process.env) {
  for (const [k, v] of Object.entries(flat || {})) {
    if (v != null && typeof v !== "object" && !target[k]) target[k] = String(v);
  }
  // 这些运行时模型/路由键以 config.json 为准；即使配置中心里留空，也要清掉启动器注入的旧值。
  for (const k of CONFIG_RUNTIME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(flat || {}, k)) target[k] = String(flat[k] ?? "");
  }
  return target;
}

// config.json：统一存放各种 key / 模型配置。扁平对象（或 {env:{...}}），值注入 process.env（不覆盖已存在的）。
// 这样工具的 shell（curl 调 ElevenLabs 等）能直接用 $ELEVENLABS_API_KEY，模型也能从这里配 MODEL/OLLAMA_MODEL/ANTHROPIC_API_KEY。
function loadConfig() {
  const p = path.join(__dirname, "config.json");
  if (!fs.existsSync(p)) return;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { console.error("[config] config.json 解析失败：" + e.message); return; }
  const flat = cfg && typeof cfg === "object" ? (cfg.env && typeof cfg.env === "object" ? cfg.env : cfg) : {};
  applyConfigEnv(flat, process.env);
}

const CONFIG_PATH = path.join(__dirname, "config.json");
function readConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) || {}; } catch { return {}; }
}
// 配置中心保存：把传入的键合并进 config.json（保留 _说明 等其余键），写盘，并在运行时即时生效
async function saveAndApplyConfig(patch) {
  const cfg = readConfigFile();
  const bag = cfg.env && typeof cfg.env === "object" ? cfg.env : cfg;
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null) continue;
    bag[k] = String(v);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  // 注入 process.env（覆盖；shell 工具下次调用即读到新值），再重新派生运行时设置
  for (const [k, v] of Object.entries(bag)) {
    if (v != null && typeof v !== "object") process.env[k] = String(v);
  }
  ANTHROPIC_MODEL = process.env.MODEL || "claude-opus-4-8";
  OLLAMA_HOST = process.env.OLLAMA_HOST_URL || "http://localhost:11434";
  OLLAMA_MODEL = process.env.OLLAMA_MODEL || "minimax-m3:cloud";
  CODEX_MODEL = process.env.CODEX_MODEL || "";
  ALLOW_TOOLS = process.env.ALLOW_TOOLS !== "0"; // 默认开启本地真执行（用户要求 shell/CLI 始终本地执行）；设 ALLOW_TOOLS=0 才关
  TOOL_TIMEOUT = Number(process.env.TOOL_TIMEOUT_MS || 600000);
  DEFAULT_MODEL = process.env.DEFAULT_MODEL || null;
  ENABLE_CLAUDE_CODE = process.env.ENABLE_CLAUDE_CODE === "1";
  ENABLE_CODEX_CLI = process.env.ENABLE_CODEX_CLI === "1";
  CLAUDE_BIN = process.env.CLAUDE_BIN || CLAUDE_BIN || "claude";
  CODEX_BIN = process.env.CODEX_BIN || CODEX_BIN || "codex";
  // 重建 Anthropic client（key 新增→可用 Claude；key 清空→停用）
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    if (!anthropicClient) { const Anthropic = require("@anthropic-ai/sdk"); anthropicClient = new Anthropic(); }
  } else anthropicClient = null;
  // 重新确定系统默认 provider + 重新探测 claude CLI（启用 claude-code 后即时可用）
  claudeCliAvailable = await checkClaudeCli();
  codexCliAvailable = await checkCodexCli();
  codexCliLoggedIn = await checkCodexLogin();
  ollamaReady = await ollamaAlive();
  const forced = normalizeProviderName(process.env.PROVIDER);
  if (["anthropic", "ollama", "codex-cli", "bailian"].includes(forced)) provider = forced;
  else if (provider !== "mock") {
    provider = anthropicClient
      ? "anthropic"
      : ollamaReady
        ? "ollama"
        : (ENABLE_CODEX_CLI && codexCliAvailable && codexCliLoggedIn) ? "codex-cli"
          : process.env.DASHSCOPE_API_KEY ? "bailian" : provider;
  }
}
// 配置中心 = 系统级配置，按 provider 分组（用户级凭证如 ElevenLabs key 不放这里）。
const CONFIG_GROUPS = [
  { group: "general", label: "系统 / 通用", fields: [
    { key: "PROVIDER", label: "系统默认 provider", hint: "留空=自动探测；anthropic / codex-cli / ollama / bailian" },
    { key: "DEFAULT_MODEL", label: "系统默认模型", hint: "建议留空或使用页面模型选择器写入的模型 id；旧式裸模型名仍兼容，留空=按 provider 推断" },
    { key: "ALLOW_TOOLS", label: "开启真执行(API 工具)", hint: "填 1 开启 Anthropic 工具；Claude Code / Codex CLI 使用各自原生工具" },
    { key: "TOOL_TIMEOUT_MS", label: "单条命令超时(ms)", hint: "默认 600000（10 分钟）" },
  ] },
  { group: "anthropic", label: "Anthropic · 裸 API（按 token 计费）", fields: [
    { key: "ANTHROPIC_API_KEY", label: "API Key", secret: true, hint: "用 claude-* 走 API 时必填；填了立即可用，无需重启" },
    { key: "MODEL", label: "默认 Claude 模型", hint: "如 claude-opus-4-8" },
  ] },
  { group: "claude-code", label: "Claude Code · 走订阅（零 API 计费）", note: "用本机 `claude login` 的订阅登录态，无需 key（在终端跑过 `claude` 登录即可）。页面选择器会用模型 id 绑定到 Claude Code。", fields: [
    { key: "ENABLE_CLAUDE_CODE", label: "启用", hint: "填 1 启用后，模型下拉里才会出现 claude-code:opus / cc:sonnet（走订阅）；留空=不显示" },
  ] },
  { group: "codex-cli", label: "Codex · ChatGPT 订阅令牌", note: "复用本机 `codex login` 的 ChatGPT OAuth 登录态，由 Codex CLI 自动刷新令牌；系统不复制、不保存 auth.json 中的令牌。页面选择器会用模型 id 绑定到 Codex。", fields: [
    { key: "ENABLE_CODEX_CLI", label: "启用", hint: "填 1 后在模型选择器显示 Codex 订阅模型" },
    { key: "CODEX_MODEL", label: "默认模型", hint: "可留空使用 CLI 内置默认；也可填 gpt-5.5 等 Codex 可用模型" },
    { key: "CODEX_BIN", label: "Codex CLI", hint: "默认 codex；仅在命令不在 PATH 时填写绝对路径" },
  ] },
  { group: "bailian", label: "阿里百炼 / DashScope（OpenAI 兼容）", note: "用百炼的 OpenAI 兼容协议。页面选择器会用模型 id 绑定到百炼 provider。", fields: [
    { key: "DASHSCOPE_API_KEY", label: "API Key", secret: true, hint: "百炼 DashScope key（sk-...）；填了模型下拉才出现 bailian:*" },
    { key: "BAILIAN_MODEL", label: "默认模型", hint: "如 qwen-max / qwen-plus / qwen-turbo" },
    { key: "BAILIAN_BASE_URL", label: "Base URL", hint: "默认 https://dashscope.aliyuncs.com/compatible-mode/v1" },
  ] },
  { group: "ollama", label: "Ollama · 本地/云端", fields: [
    { key: "OLLAMA_MODEL", label: "默认模型", hint: "如 minimax-m3:cloud" },
    { key: "OLLAMA_HOST_URL", label: "地址", hint: "默认 http://localhost:11434" },
  ] },
];
const CONFIG_KEYS = CONFIG_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

// ---------- 团队设计 ----------

const DESIGN_SYSTEM = `你是「点将台」的首席团队架构师。用户用自然语言描述一个目标或任务，你为它组建一支 AI agent 团队。

要求：
1. 设计 3~8 个 agent，各有清晰分工，避免职责重叠。
2. 团队用一张有向无环图展示建议协作结构：每个 agent 的 depends_on 列出通常会给它提供产出的同事（用对方的 id）。没有建议上游就留空数组。DAG 用于界面层级与作战状态展示，运行时由团队主 Agent 动态控制成员。
3. **团队要有真实的层级结构**：像一家公司——前线成员产出原料，中层（小组长/主笔/统稿人等）聚合自己负责的几条线再向上交付，最后才到收尾人。依赖链路至少 3 层（前线 → 中层 → 收尾）。**禁止所有成员都直接挂在同一个收尾人身上**（那是星形，不是团队）。
4. 必须有且只有一个"收尾" agent（没有任何人依赖它），负责整合直接下属的产出，输出最终交付物。
5. 每个 agent：
   - id: 小写英文标识（字母数字连字符）
   - name: 优先使用贴合职责的军队或军帐风格中文称号，如斥候、参军、校尉、主簿、先锋、军需官、督军等；要易懂、不浮夸，只能写名字文字，禁止包含 emoji、图标或装饰符号
   - emoji: 一个代表性 emoji，是界面显示的唯一成员图标；名字旁想用的图标必须只写在这里
   - role: 职位/职责一句话
   - persona: 性格与做事风格，1~2 句
   - system_prompt: 这个 agent 的完整系统提示词，200~400 字。要包含：身份与专长、性格与表达风格、具体职责、对输出的明确要求（结构、深度、格式）。写得让它能独立胜任工作。
   - tools: 该成员可调用的真执行工具名数组（见下）。纯创意/策划/写作成员留空数组 []；只有需要真正动手产出文件或跑命令行的成员才授予工具。
   - model: 留空字符串 ""（默认继承将军模型）。将军与每个成员子 Agent 都可以使用不同模型，但默认不要乱填，交给用户在界面上按需调。
   - risk: 由你在点将阶段判断该成员职责是否包含高危操作。不要靠关键词机械判断，要理解成员真实职责、system_prompt 与工具权限：
     * level: "none" 或 "danger"
     * summary: level 为 danger 时用一句话说明危险点；否则空字符串
     * operations: level 为 danger 时列出 1~5 条具体危险操作（如删除文件、销毁资源、清空数据、覆盖生产文件等）；否则 []
     只有成员职责明确包含删除、销毁、清空、覆盖不可恢复数据/文件/资源等真实破坏性动作时才标 danger；普通读取、写新文件、生成稿件、渲染、分析不要标。
6. team_name 简短有力，summary 用一段话说明团队如何分层协作完成该任务。
7. system_prompt 里不要提到"等待上游输入"之类的流程细节——运行时会自动把上游产出交给它。
8. 可授予的工具目录（只能从这里选，不要发明新工具）：
   - "shell"：执行 shell 命令（curl 调 ElevenLabs 配音、ffmpeg 合成/倍速视频、whisper 对时、puppeteer 渲帧、dreamina CLI 出图，或经 mcporter 调 MCP）
   - "write_file"：把内容写入工作目录的文件（如口播稿.md、cover.html、渲染脚本）
   - "read_file"：读取工作目录里的文件
   原则：能"真出片/真出图/真写文件"的执行型成员才给工具；负责构思、文案、策划的成员给 []。给了 shell 的成员通常也一并给 write_file 和 read_file。`;

const TEAM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["team_name", "emoji", "summary", "agents"],
  properties: {
    team_name: { type: "string" },
    emoji: { type: "string" },
    summary: { type: "string" },
    agents: {
      type: "array",
      minItems: 3,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "emoji", "role", "persona", "system_prompt", "depends_on", "risk"],
        properties: {
          id: { type: "string", description: "小写英文标识" },
          name: { type: "string", description: "优先使用贴合职责、易懂的军队或军帐风格纯文字成员名，禁止包含 emoji、图标或装饰符号" },
          emoji: { type: "string", description: "恰好一个代表性 emoji，作为该成员唯一显示图标" },
          role: { type: "string" },
          persona: { type: "string" },
          system_prompt: { type: "string" },
          depends_on: { type: "array", items: { type: "string" } },
          tools: {
            type: "array",
            description: "该成员可调用的真执行工具名（来自固定目录），不需要执行就留空数组",
            items: { type: "string", enum: ["shell", "write_file", "read_file"] },
          },
          model: {
            type: "string",
            description: "该成员单独使用的模型 id（如 claude-opus-4-8 / minimax-m3:cloud）。留空字符串则用系统默认模型。",
          },
          risk: {
            type: "object",
            additionalProperties: false,
            required: ["level", "summary", "operations"],
            description: "点将模型对该成员危险程度的结构化判断；只在真实职责包含删除/销毁/清空/覆盖不可恢复资源时标 danger。",
            properties: {
              level: { type: "string", enum: ["none", "danger"] },
              summary: { type: "string" },
              operations: { type: "array", items: { type: "string" }, maxItems: 5 },
            },
          },
        },
      },
    },
    secrets: {
      type: "array",
      description: "团队级凭证：仅在导入 skill 时，把 skill 原文里真实出现的 API key/凭证提取到这里（普通点将留空数组）。",
      items: {
        type: "object", additionalProperties: false, required: ["key", "value"],
        properties: { key: { type: "string", description: "环境变量名，如 ELEVENLABS_API_KEY" }, value: { type: "string", description: "凭证值" } },
      },
    },
  },
};

// ========== 作战蓝图（勘察阶段）：先把一句话想清楚，再组队 ==========
// 像 Claude 接到任务那样：先讲清要做哪些事、配哪些工具、接哪些平台、还有哪些得用户拍板，再去点兵。
const PLATFORM_CATALOG = `# 可选外部平台目录（推荐时优先从这里选，并讲清理由；这件事纯靠模型就能完成、不需要外部平台时给空数组）
- 配音 / TTS：ElevenLabs（多语种、音色克隆，质量高，需 ELEVENLABS_API_KEY）｜MiniMax 语音（中文自然，需 DASHSCOPE_API_KEY）｜OpenAI TTS
- 文生图 / 出图：即梦 Dreamina（中文海报、分镜强）｜可灵 Kling｜Stable Diffusion（本地）
- 文生视频 / 对口型：可灵 Kling｜Runway｜即梦
- 视频合成 / 剪辑：ffmpeg（本地，走 shell）｜剪映草稿
- 语音转写 / 对时：Whisper（本地，走 shell）
- 渲染 / 截帧：Puppeteer（本地 headless Chrome，走 shell）
- 网络检索 / 资料：Web 搜索｜官方文档抓取
- 代码 / 部署：本地 shell｜GitHub
- 已接入的 MCP 工具：经 mcporter 调用对应 MCP server`;

const BLUEPRINT_SYSTEM = `你是「点将台」的首席方案架构师。用户只给一句话，但你不能直接拉一堆人来写文章——你要先像 Claude 接到任务时那样，把这件事想清楚并讲给用户听，再去组队。

你的产物是一份【作战蓝图】，必须包含：
1. goal：把用户这句话还原成清晰、可执行的目标（补全隐含意图，但不要擅自扩大范围）。
2. tasks：把目标拆成 2~7 个具体任务，写明先后或并行关系。每个任务写 title、detail（具体做什么、产出什么真实产物）、acceptance（验收标准：怎样算这步做对了）。任务要落到真实产出（文件、图、音频、视频、数据、代码等），不要"写一篇文章"这种空话。
3. tools_needed：完成这些任务真正需要的执行工具（shell / write_file / read_file），每条说明为什么需要、用在哪个任务。纯靠模型构思就能完成的别硬塞工具。
4. external_platforms：需要调用的外部平台 / 服务。每条给出 capability（要解决什么）、recommended（你最推荐哪个）、alternatives（其他可选）、why（为什么推荐它）、needs_credential（是否需要凭证）、env_key（需要凭证时给出环境变量名，否则空字符串）。从下面目录里选并讲清理由；纯靠模型自身就能完成、不需要外部平台时给空数组。
5. open_questions：你需要用户拍板或补充才能继续的关键问题（风格偏好、目标平台、是否已有素材、时长 / 预算等）。每条给 question 和 why（为什么这个问题会影响方案）。宁可问，也不要替用户瞎猜。

${PLATFORM_CATALOG}

像一个会沟通的资深主理人那样思考：先把"这句话其实要做哪些事、要配哪些工具、建议接哪些平台、还有哪些得你定"讲清楚，把决策权交还给用户。只输出符合 schema 的 JSON。`;

const BLUEPRINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "tasks", "tools_needed", "external_platforms", "open_questions"],
  properties: {
    goal: { type: "string", description: "把用户一句话还原成的清晰可执行目标" },
    tasks: {
      type: "array", minItems: 1, maxItems: 9,
      items: {
        type: "object", additionalProperties: false,
        required: ["title", "detail", "acceptance"],
        properties: {
          title: { type: "string" },
          detail: { type: "string", description: "这一步具体做什么、产出什么真实产物" },
          acceptance: { type: "string", description: "验收标准：怎样算这步做对了" },
        },
      },
    },
    tools_needed: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["tool", "why"],
        properties: {
          tool: { type: "string", enum: ["shell", "write_file", "read_file"] },
          why: { type: "string", description: "为什么需要、用在哪个任务" },
        },
      },
    },
    external_platforms: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["capability", "recommended", "alternatives", "why", "needs_credential", "env_key"],
        properties: {
          capability: { type: "string", description: "要解决什么能力（如配音、出图、渲帧）" },
          recommended: { type: "string", description: "最推荐的那个平台" },
          alternatives: { type: "array", items: { type: "string" } },
          why: { type: "string", description: "为什么推荐它" },
          needs_credential: { type: "boolean" },
          env_key: { type: "string", description: "需要凭证时的环境变量名，否则空字符串" },
        },
      },
    },
    open_questions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["question", "why"],
        properties: {
          question: { type: "string" },
          why: { type: "string", description: "为什么这个问题会影响方案" },
        },
      },
    },
  },
};

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

async function designBlueprint(description, designModel, send) {
  if (provider === "mock") return mockBlueprint(description);
  const { eff, model } = resolveDesign(designModel);
  // 走统一 harness 引擎的 provider（anthropic/ollama/百炼）：军师作为 agent——可先 ask_user 追问，
  // 想清楚后调用 submit_blueprint 交结构化蓝图。CLI(claude-code/codex) 仍走一次性 designRaw。
  if (eff === "anthropic" || eff === "ollama" || eff === "bailian") {
    const toolDefs = [
      { name: "ask_user", description: TOOL_REGISTRY.ask_user.spec.description, schema: TOOL_REGISTRY.ask_user.spec.input_schema, run: TOOL_REGISTRY.ask_user.run },
      { name: "submit_blueprint", description: "想清楚后调用它提交最终作战蓝图（结构化）。这是交付动作，调用即结束勘察。", schema: BLUEPRINT_SCHEMA, run: () => ({ ok: true, content: "已提交蓝图" }) },
    ];
    const out = await runHarness({
      id: "__design__",
      system: `${BLUEPRINT_SYSTEM}\n\n你是一个 agent：信息不足时先用 ask_user 向用户追问关键问题；想清楚后必须调用 submit_blueprint 交付结构化蓝图，不要只用普通文字回答。`,
      input: `用户的一句话需求：\n\n${description}`,
      toolDefs, model, eff, send,
      ctx: { runId: `design-${Date.now().toString(36)}`, send },
      opts: { terminalTool: "submit_blueprint", maxTurns: 12 },
    });
    if (out && out.__final) return normalizeBlueprint(out.__final);
    // 引擎没走到 submit_blueprint（模型只回文本）→ 退回一次性结构化输出兜底，保证拿到蓝图
  }
  const raw = await designRaw({
    system: BLUEPRINT_SYSTEM,
    user: `用户的一句话需求：\n\n${description}\n\n请先输出一份作战蓝图（现在不要组建团队、不要输出成员）。`,
    schema: BLUEPRINT_SCHEMA, eff, model, send, purpose: "勘察蓝图",
  });
  return normalizeBlueprint(raw);
}

// ---------- Ollama 调用（原生 /api/chat，NDJSON 流式） ----------

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
  return `# 团队全局 Skill：${spec.team_name || "无名战队"}

## 团队目标

${spec.summary || ""}
${blueprintBlock}${evoBlock}
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
    ? "只可在当前工作目录内使用完成任务所必需的命令和文件操作，并遵守上面的工具授权与交付约束。"
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

// 军师（点将）模型路由：传了用它，没传用系统默认。模型对应的 provider 不可用时【直接报错阻断】，不静默回退。
function resolveDesign(designModel) {
  const selected = resolveModelSelection(designModel || systemDefaultModel());
  const eff = selected.provider;
  const model = selected.model;
  const name = selected.label || model || selected.id;
  if (eff === "anthropic" && !anthropicClient) throw new Error(`军师模型「${name}」走 Anthropic API，但未配置 ANTHROPIC_API_KEY（配置中心 → Anthropic）。`);
  if (eff === "claude-code" && !claudeCliAvailable) throw new Error(`军师模型「${name}」需要本机 claude CLI（订阅登录），但未检测到。请先在终端执行 claude login。`);
  if (eff === "codex-cli" && !codexCliAvailable) throw new Error(`军师模型「${name}」需要本机 Codex CLI，但未检测到。请先安装 Codex CLI。`);
  if (eff === "codex-cli" && !codexCliLoggedIn) throw new Error(`军师模型「${name}」需要 Codex ChatGPT 订阅登录态。请先在终端执行 codex login。`);
  if (eff === "bailian" && !process.env.DASHSCOPE_API_KEY) throw new Error(`军师模型「${name}」走阿里百炼，但未配置 DASHSCOPE_API_KEY（配置中心 → 阿里百炼）。`);
  if (eff === "ollama" && !ollamaReady) throw new Error(`军师模型「${name}」走 Ollama，但连不上 Ollama（${OLLAMA_HOST}）。`);
  return { eff, model, model_id: selected.id, model_label: name };
}

// 统一的"出 JSON"调用：ollama(structured) / claude-code(spawn) / anthropic(API)
// send 可选：传了则把模型的思考过程实时推给前端。
async function designRaw({ system, user, schema, eff, model, maxTokens, send, thinkId = "__design__", purpose = "点将" }) {
  console.log(`[${purpose}] 模型 → provider=${eff} model=${model}`);
  // 统一语言要求：思考过程跟随用户输入语言，不写死语种、不分模型（放 system 与 user 末尾双重强调）
  const langRule = "语言要求：默认全程用中文进行思考（thinking）和输出，禁止默认用英文思考或输出；只有当用户明确要求其他语言时才改用该语言。";
  system = `${system}\n\n${langRule}`;
  user = `${user}\n\n${langRule}`;
  const onThink = send ? (t) => send({ type: "agent_thinking", id: thinkId, text: t }) : null;
  if (eff === "ollama") {
    let lastRaw = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { content, thinking } = await ollamaChat({ system, user: user + "\n\n只输出符合要求的 JSON 对象，不要任何其他文字。", schema, model, onThinking: onThink });
      try { try { return extractJson(content); } catch { return extractJson(thinking); } }
      catch {
        lastRaw = content || thinking || "(empty response)";
        try { fs.writeFileSync(`/tmp/dianjiang-design-raw-${attempt}.txt`, `--CONTENT--\n${content}\n--THINKING--\n${thinking}`); } catch {}
      }
    }
    throw new Error(lastRaw);
  }
  if (eff === "claude-code") {
    const out = await claudeCodeOnce(system, user + "\n\n只输出一个符合要求的 JSON 对象：不要任何解释、不要代码围栏、不要使用任何工具。", ccModelArg(model), onThink);
    try { fs.writeFileSync("/tmp/dianjiang-cc-raw.txt", String(out)); } catch {}
    try { return extractJson(out); } catch { throw new Error(String(out || "(empty response)")); }
  }
  if (eff === "codex-cli") {
    const out = await codexExecOnce({
      system,
      user: user + "\n\n只输出一个符合要求的 JSON 对象：不要解释、不要代码围栏、不要使用工具。",
      schema,
      modelArg: codexModelArg(model),
      onThinking: onThink,
      onEvent: (event) => {
        if (event?.kind === "message" && looksLikeCodexProcessText(event.text) && onThink) {
          onThink(String(event.text).trim() + "\n\n");
        }
      },
      sandbox: "danger-full-access",
      allowTools: false,
    });
    try { fs.writeFileSync("/tmp/dianjiang-codex-raw.txt", String(out)); } catch {}
    try { return extractJson(out); } catch { throw new Error(String(out || "(empty response)")); }
  }
  if (eff === "bailian") {
    const { content } = await bailianChat({ system, user: user + "\n\n只输出一个符合要求的 JSON 对象，不要任何其他文字。", model, jsonMode: true });
    try { return extractJson(content); } catch { throw new Error(content || "(empty response)"); }
  }
  const stream = anthropicClient.messages.stream({
    model, max_tokens: maxTokens || 16000, thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema } },
    system, messages: [{ role: "user", content: user }],
  });
  if (onThink) stream.on("thinking", onThink);
  const msg = await stream.finalMessage();
  const text = msg.content.find((b) => b.type === "text")?.text;
  if (msg.stop_reason === "refusal") throw new Error(text || "(refusal)");
  if (!text) throw new Error("(empty response)");
  try { return extractJson(text); } catch { throw new Error(text); }
}

// 把“团队全局约定”写进每个成员的 system_prompt（仅生成团队时调用，幂等）：
// 全体成员都该知道的事——统一工作目录/产物存放、命名与路径回报、依赖引用、语言跟随。
const TEAM_CONVENTION_MARKER = "【团队全局约定";
function injectTeamConventions(spec) {
  if (!spec || !Array.isArray(spec.agents)) return spec;
  const goal = String(spec.summary || spec.team_name || "").trim();
  const block = `\n\n${TEAM_CONVENTION_MARKER}（全体成员共同遵守，系统统一注入）】\n` +
    (goal ? `- 团队目标：${goal}\n` : "") +
    `- 所有文件类产物统一存到本次出征的工作目录（= 环境变量 $BASE_DIR，运行时会把具体路径告诉你），不要散落到别处；skill 原文里若写了 ~/Documents/... 之类绝对输出路径，一律改到 $BASE_DIR 下同名文件。文件命名清晰、稳定、可被下游按名引用。\n` +
    `- 交付时在结果里明确写出你产出的文件名 / 相对路径，方便将军与下游成员定位。\n` +
    `- 需要别人的产物时，用将军在“本轮上游产出”里给你的内容，不要凭空假设路径。\n` +
    `- 执行中发现缺命令行依赖（如 ffmpeg / whisper / 某 CLI）时，先用 ask_user 问用户是否安装；用户同意后再用 shell（brew / npm / pip）安装，然后继续；用户不同意或装不上就说明影响，别假装完成。\n` +
    `- 交付物会渲染成富文本：可用 Markdown（表格/代码/列表等），并用 \`![](相对路径.png)\` 或 \`[标题](文件.mp4/.mp3/.html)\` 把图片/音视频/网页产物引用出来，让用户在结果框里直接看到/播放。\n` +
    `- 思考与交付默认用中文，除非用户明确要求其他语言。`;
  for (const a of spec.agents) {
    const sp = String(a.system_prompt || "");
    if (sp.includes(TEAM_CONVENTION_MARKER)) continue; // 幂等：已注入则跳过
    a.system_prompt = sp.trim() + block;
  }
  return spec;
}

async function designTeam(description, designModel, send) {
  if (provider === "mock") return mockTeam(description);
  const { eff, model } = resolveDesign(designModel);
  const raw = await designRaw({ system: DESIGN_SYSTEM, user: `请为以下需求组建一支 agent 团队：\n\n${description}`, schema: TEAM_SCHEMA, eff, model, send });
  try { return injectTeamConventions(ensureMemberToolGrants(normalizeSpec(raw))); }
  catch { throw new Error(typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)); }
}

// ========== 点兵阶段：用户确认蓝图后，按蓝图组建执行团队 ==========
const STAFF_SYSTEM = `你是「点将台」的首席团队架构师。用户已经和你一起把一份【作战蓝图】确认好了——目标、任务清单（含验收标准）、要用的工具、要接的外部平台，以及用户对若干关键问题的拍板。现在请严格按这份已确认的蓝图组建执行团队。

落地蓝图（最高优先级）：
1. 团队必须覆盖蓝图里的每一个任务：每个任务至少由一名成员负责，成员的 role 要写清它负责蓝图里的哪个任务、对应的验收标准是什么。不要新增蓝图之外的工作，也不要漏掉任务。
2. 工具按蓝图 tools_needed 授予——只有真正要跑命令 / 读写文件 / 调外部平台的成员才给 shell / write_file / read_file；纯策划、撰写的成员给 []。
3. 用户已确认的外部平台要写进相关成员的 system_prompt：写明用哪个平台、怎么调；凭证由系统通过环境变量注入，提示词里只引用 env_key 名（如 \${ELEVENLABS_API_KEY}），绝不要写死真实 key。
4. 用户对 open_questions 的回答是硬约束，必须体现在对应成员的职责与提示词里。

团队结构要求：
5. 设计 3~8 个 agent，各有清晰分工，避免职责重叠；团队要有真实层级（前线产出 → 中层聚合 → 收尾整合），依赖链至少 3 层，禁止所有人都直接挂在同一个收尾人身上。
6. 必须有且只有一个"收尾"agent（没有任何人依赖它），整合直接下属产出，输出最终交付物。
7. 每个 agent：id（小写英文）；name（优先使用贴合职责、易懂的军队或军帐风格中文称号，如斥候、参军、校尉、主簿、先锋、军需官、督军等，禁止含 emoji / 图标）；emoji（一个代表性 emoji，界面唯一图标）；role（一句话职责，点明负责的蓝图任务）；persona（性格风格 1~2 句）；system_prompt（200~400 字完整系统提示词：身份专长、性格、具体职责、对输出结构 / 深度 / 格式的明确要求，并落实其负责任务的验收标准）；tools（真执行工具名数组，纯创意成员留 []）；model（留空字符串继承将军模型）。depends_on 列出通常给它供料的同事 id，没有就留空数组。
8. team_name 简短有力，summary 一段话说明团队如何分层协作完成蓝图目标。system_prompt 里不要提"等待上游输入"之类流程细节——运行时会自动把上游产出交给它。
9. 工具目录只能从这三个选，不要发明：shell（跑命令，如 curl 调配音、ffmpeg 合成、puppeteer 渲帧）、write_file（写产物文件）、read_file（读工作目录文件）；给了 shell 的成员通常一并给 write_file 和 read_file。`;

async function staffTeam(rawBlueprint, description, designModel, send) {
  const blueprint = normalizeBlueprint(rawBlueprint);
  // 用户在面板里填的 key 值（normalizeBlueprint 会丢弃 value，这里从原始入参按 env_key 取回）
  const keyByEnv = new Map();
  for (const p of (rawBlueprint?.external_platforms || [])) {
    if (p?.env_key && p?.value) keyByEnv.set(String(p.env_key), String(p.value));
  }
  let spec;
  if (provider === "mock") {
    spec = mockTeam(description || blueprint.goal || "");
  } else {
    const { eff, model } = resolveDesign(designModel);
    const raw = await designRaw({
      system: STAFF_SYSTEM,
      user: `# 用户的一句话\n${description || "(见蓝图目标)"}\n\n# 已和用户确认的作战蓝图（JSON）\n${JSON.stringify(blueprint, null, 2)}\n\n请据此组建执行团队，确保每个任务都有成员负责。`,
      schema: TEAM_SCHEMA, eff, model, send, purpose: "点兵组队",
    });
    try { spec = normalizeSpec(raw); }
    catch { throw new Error(typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)); }
  }
  // 用户确认要凭证的平台 env_key 落进团队 secrets（值可能已由用户在面板里填好）
  const secrets = { ...spec.secrets };
  for (const p of blueprint.external_platforms || []) {
    if (p.needs_credential && p.env_key && !(p.env_key in secrets)) secrets[p.env_key] = keyByEnv.get(p.env_key) || "";
  }
  spec.secrets = secrets;
  // 蓝图只随团队配置走，真实 key 已落进 secrets，不在 spec.blueprint 里留 value
  spec.blueprint = blueprint;
  ensureMemberToolGrants(spec); // 默认授权 + 确定性补 shell（在 global_skill 之前）
  injectTeamConventions(spec); // 全局约定注入每个成员（在 global_skill 之前，让将军的全局 Skill 也含此约定）
  spec.global_skill = buildTeamGlobalSkill(spec);
  spec.global_skill_integrity = {
    mode: "derived-full-v1",
    sha256: crypto.createHash("sha256").update(spec.global_skill, "utf8").digest("hex"),
  };
  return spec;
}

// 导入 skill 点将：军师只做团队范式拆分；完整原始 skill 保留在团队全局 Skill 中。
const SKILL_DESIGN_SYSTEM = `你是「点将台」的团队拆分员。用户给你一套【已经调试好、测试通过的 skill】（一个或多个）。你的权限仅限于把原流程映射成团队成员和依赖图，不得重新设计、优化、改写或补充 skill 的功能。

怎么做：
1. 拆分单位是 skill 原文里的【独立功能模块】，不是行号、不是段落长度、不是任意切片。通读整套 skill 和“功能模块纲要”，识别原文中已经存在的阶段、角色、并行关系、确认点、输入输出和交接顺序。
2. 每个成员必须负责一个或多个完整功能模块，并在 module_refs 中填写这些模块 id。紧密耦合、不可独立交付的模块可以合并给同一成员；一个不可拆的原子模块不能拆成多个成员；不要创造原文没有的新功能模块。
3. 团队结构必须语义映射这些原始模块，不能为了团队好看而新增、删除、合并、调序或改造任何步骤。若原流程本来有多个并行终点，不要强行添加新的收尾步骤。
4. name / emoji / persona 可以做团队化包装；name 优先使用贴合职责、易懂的军队或军帐风格称号，如斥候、参军、校尉、主簿、先锋、军需官、督军等；role 必须明确写出该成员负责的原始功能模块和交付物，禁止留空，禁止写“完成分内工作”“执行任务”等空话。
5. system_prompt 写该成员在团队中的职责边界、输入、输出和交付标准，但不得重新发明原 skill 的功能；需要引用原始规则时用“遵守团队全局 Skill 中的原始规则”表达，不要切分、摘抄或改写原文。
6. depends_on 表示 DAG 展示上游：按原 skill 的实际模块顺序、并行关系和交付关系填写；如果不确定，保持模块顺序即可，不要编造不存在的强依赖。
7. tools：需要真正跑命令行 / 读写文件的成员才给 shell / write_file / read_file，纯策划/撰写给 []。
8. risk：由你在拆分阶段判断该成员职责是否包含高危操作。不要靠关键词机械判断，要理解成员真实职责、原始 skill 语义与工具权限。只有成员职责明确包含删除、销毁、清空、覆盖不可恢复数据/文件/资源等真实破坏性动作时才标 {level:"danger"}，并在 summary / operations 中简要说明；普通读取、写新文件、生成稿件、渲染、分析不要标。
9. 凭证提取：如果 skill 原文里出现了 API key / 凭证（如 sk- 开头的 key、xi-api-key、各种 *_API_KEY、token 等），把它们提取到团队顶层的 secrets 数组，每条 {key: 环境变量名（如 ELEVENLABS_API_KEY）, value: 真实值}。只提取 skill 里真实出现的，不要编造；没有就给空数组。
10. team_name 与 summary：summary 提炼这套 skill 是做什么的、最终交付什么。
11. 成员图标规则：name 只能是纯文字名字，禁止包含 emoji、图标或装饰符号；emoji 字段填写恰好一个代表性 emoji，作为界面显示的唯一成员图标。军队风格只用于称谓包装，不得改变原始 skill 的任何功能、步骤或执行要求。
12. 原文忠实性是最高规则：用户附加说明只能补充本次团队命名或分工偏好，不得覆盖、修改或“优化”原 skill。

总之：你只画组织结构，不碰生产配方。`;

const SKILL_TEAM_SCHEMA = JSON.parse(JSON.stringify(TEAM_SCHEMA));
SKILL_TEAM_SCHEMA.properties.agents.minItems = 1;
SKILL_TEAM_SCHEMA.properties.agents.maxItems = 24;
SKILL_TEAM_SCHEMA.properties.agents.items.required = [
  ...new Set([...SKILL_TEAM_SCHEMA.properties.agents.items.required, "module_refs"]),
];
SKILL_TEAM_SCHEMA.properties.agents.items.properties.module_refs = {
  type: "array",
  minItems: 1,
  description: "该成员负责的独立功能模块 id，必须来自用户提供的功能模块纲要；不要填行号或自造 id。",
  items: { type: "string" },
};
SKILL_TEAM_SCHEMA.properties.agents.items.properties.role.description =
  "明确的原始功能模块职责和交付物；禁止空话，禁止写完成分内工作";
SKILL_TEAM_SCHEMA.properties.agents.items.properties.system_prompt.description =
  "写清成员职责边界、输入、输出与交付标准；必须遵守团队全局 Skill 中完整原文，不要切分、摘抄或改写原始 skill。";

async function designFromSkills(skills, description, designModel, send) {
  const skillSources = normalizeSkillSources(skills);
  if (!skillSources.length) throw new Error("没有读到可导入的 skill 文本。");
  if (provider === "mock") {
    const team = mockTeam("（导入 skill 演示）");
    team.skill_sources = skillSources;
    return ensureMemberToolGrants(normalizeSpec(team, { preserveGraph: true }));
  }
  const { eff, model } = resolveDesign(designModel);
  const modules = extractSkillModules(skillSources);
  const moduleOutline = formatSkillModuleOutline(modules);
  const content = skillSources.map((source) =>
    `===== ORIGINAL SKILL FILE: ${source.name} =====\n${source.content}`
  ).join("\n\n");
  const user =
    `下面是一套已经调试测试好的 skill（共 ${skillSources.length} 个文本文件）。你只负责按原始 skill 的独立功能模块做成员拆分、职责边界和依赖关系；原始 skill 会完整保留在团队全局 Skill 中。` +
    (description ? `\n\n用户的额外要求（不得改变原 skill 功能）：${description}` : "") +
    `\n\n# 功能模块纲要（按这些独立模块拆成员，不按行号、不按段落长度）\n${moduleOutline}` +
    `\n\n要求：每个成员的 module_refs 必须引用上面纲要中的模块 id；一个成员可以负责多个紧密关联模块，但不能拆散一个不可独立交付的模块。` +
    `\n\n# 完整原始 Skill（只读执行契约，禁止重写，禁止修改命令、参数、顺序、模板或判断条件）\n\n${content}`;
  let lastRaw;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryHint = attempt === 1 ? "" : "\n\n上一次结果无法归一成团队配置。请输出符合 schema 的完整团队 JSON，不要附加解释。";
    const raw = await designRaw({ system: SKILL_DESIGN_SYSTEM, user: user + retryHint, schema: SKILL_TEAM_SCHEMA, eff, model, maxTokens: 24000, send });
    lastRaw = raw;
    const team = unwrapTeamSpec(raw);
    if (team && Array.isArray(team.agents) && team.agents.length) {
      try {
        team.skill_sources = skillSources;
        attachSkillModuleContent(team, modules); // 把成员负责模块的原始 skill 原文逐字拼进其 system_prompt
        return ensureMemberToolGrants(normalizeSpec(team, { preserveGraph: true }));
      } catch (e) {
        try { fs.writeFileSync(`/tmp/dianjiang-skill-invalid-${attempt}.json`, JSON.stringify({ error: e.message, raw }, null, 2)); } catch {}
      }
    }
    try { fs.writeFileSync(`/tmp/dianjiang-skill-invalid-${attempt}.json`, JSON.stringify(raw, null, 2)); } catch {}
  }
  throw new Error(typeof lastRaw === "string" ? lastRaw : JSON.stringify(lastRaw, null, 2));
}

// ---------- 对话式改成员（用该成员当前的模型） ----------
const EDIT_AGENT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "emoji", "role", "persona", "system_prompt", "tools", "_changed"],
  properties: {
    name: { type: "string" }, emoji: { type: "string" }, role: { type: "string" },
    persona: { type: "string" }, system_prompt: { type: "string" },
    tools: { type: "array", items: { type: "string", enum: ["shell", "write_file", "read_file"] } },
    _changed: { type: "string", description: "一句话说明这次改了哪些地方" },
  },
};
// 用成员当前选择的模型，按用户指令改写该成员的设定；只回改后的字段（不动 id/depends_on/model/lines）
async function editAgentViaChat(agent, instruction, teamMainModel) {
  const { eff, model } = resolveDesign(agent.model || teamMainModel || ""); // 不可用会抛错阻断
  const cur = {
    name: agent.name, emoji: agent.emoji, role: agent.role,
    persona: agent.persona, system_prompt: agent.system_prompt, tools: agent.tools || [],
  };
  const system = `你在帮用户修改一个 AI 团队成员的设定。根据「当前配置」和「修改要求」，输出修改后的完整成员 JSON：只改用户要求改的字段，其余字段保持原值原样。tools 仅可用 shell / write_file / read_file。_changed 用一句话说明改了什么。`;
  const user = `当前配置：\n${JSON.stringify(cur, null, 2)}\n\n修改要求：${instruction}`;
  const raw = await designRaw({ system, user, schema: EDIT_AGENT_SCHEMA, eff, model });
  return { fields: raw, model };
}

// ---------- 工具：让 agent 真执行（CLI / 文件 / 经 mcporter 调 MCP） ----------

const { exec } = require("child_process");
// 真执行总开关：默认【开启】（用户要求 shell/CLI 始终本地执行）；设 ALLOW_TOOLS=0 才关。let：配置中心可改。
let ALLOW_TOOLS = process.env.ALLOW_TOOLS !== "0";
let TOOL_TIMEOUT = Number(process.env.TOOL_TIMEOUT_MS || 600000); // 单条命令上限，默认 10min（渲帧/合成耗时）
const MAX_TOOL_OUTPUT = 24000; // 回灌给模型的输出上限（字符）

function clip(s, n = MAX_TOOL_OUTPUT) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + `\n…[输出过长，已截断，共 ${s.length} 字符]` : s;
}

// 工具目录：name -> { spec(Anthropic 工具定义), run(input, ctx) }
const TOOL_REGISTRY = {
  shell: {
    label: "Shell / CLI",
    hint: "跑命令行：ElevenLabs(curl)、ffmpeg、Whisper、Puppeteer、dreamina CLI，或经 mcporter 调 MCP",
    spec: {
      name: "shell",
      description:
        "在工作目录里执行一条 shell 命令并返回 stdout/stderr。用于：调用 ElevenLabs(curl) 合成语音、ffmpeg 合成/倍速视频、whisper 对时、puppeteer 逐帧渲染、dreamina CLI 出图，或通过 mcporter 调用 MCP 服务。命令在该成员的工作目录下执行，可用相对路径。",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的完整 shell 命令" },
          cwd: { type: "string", description: "可选，相对工作目录的子目录" },
        },
        required: ["command"],
      },
    },
    run: ({ command, cwd }, ctx) =>
      new Promise((resolve) => {
        const wd = cwd ? path.resolve(ctx.baseDir, cwd) : ctx.baseDir;
        const sig = ctx.abortSignal;
        let aborted = false, killTimer = null;
        // 把 BASE_DIR 指向本次工作目录：skill 里大量用 `cd "$BASE_DIR"` / `$BASE_DIR/xxx`，不注入就解析成空、写错地方。
        const child = exec(command, { cwd: wd, timeout: TOOL_TIMEOUT, maxBuffer: 64 * 1024 * 1024, shell: "/bin/bash", env: { ...process.env, BASE_DIR: ctx.baseDir || wd, ...(ctx.secrets || {}) } },
          (err, stdout, stderr) => {
            if (killTimer) clearTimeout(killTimer);
            if (sig) { try { sig.removeEventListener("abort", onAbort); } catch {} }
            if (aborted) { resolve({ ok: false, content: "命令已被用户打断（停战/插话），进程已终止。" }); return; }
            const out = [stdout && `[stdout]\n${stdout}`, stderr && `[stderr]\n${stderr}`].filter(Boolean).join("\n");
            if (err) resolve({ ok: false, content: clip(`命令失败（exit ${err.code ?? "?"}${err.killed ? "，超时被杀" : ""}）：\n${out || err.message}`) });
            else resolve({ ok: true, content: clip(out || "(命令执行成功，无输出)") });
          });
        function onAbort() { aborted = true; try { child.kill("SIGTERM"); } catch {} killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500); }
        if (sig) { if (sig.aborted) onAbort(); else sig.addEventListener("abort", onAbort, { once: true }); }
      }),
  },
  write_file: {
    label: "写文件",
    hint: "把内容写入工作目录的文件（口播稿.md / cover.html / 脚本等）",
    spec: {
      name: "write_file",
      description: "把文本内容写入工作目录下的文件（自动创建父目录）。用于产出口播稿.md、cover.html、渲染脚本、生产笔记等。",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作目录的文件路径" },
          content: { type: "string", description: "文件内容" },
        },
        required: ["path", "content"],
      },
    },
    run: ({ path: p, content }, ctx) => {
      try {
        const fp = path.resolve(ctx.baseDir, p);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, String(content ?? ""));
        return Promise.resolve({ ok: true, content: `已写入 ${p}（${Buffer.byteLength(String(content ?? ""))} 字节）` });
      } catch (e) { return Promise.resolve({ ok: false, content: `写入失败：${e.message}` }); }
    },
  },
  read_file: {
    label: "读文件",
    hint: "读取工作目录里的文件内容",
    spec: {
      name: "read_file",
      description: "读取工作目录下某个文件的文本内容。",
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "相对工作目录的文件路径" } },
        required: ["path"],
      },
    },
    run: ({ path: p }, ctx) => {
      try { return Promise.resolve({ ok: true, content: clip(fs.readFileSync(path.resolve(ctx.baseDir, p), "utf8")) }); }
      catch (e) { return Promise.resolve({ ok: false, content: `读取失败：${e.message}` }); }
    },
  },
  edit_file: {
    label: "改文件",
    hint: "把文件里的一段旧文本精确替换成新文本（不重写整篇，省 token、少出错）",
    spec: {
      name: "edit_file",
      description: "对工作目录下【已存在】的文件做精确替换：把 old_string 原样替换成 new_string，不重写整篇。old_string 必须与文件内容完全一致且唯一出现（否则报错，请把它写得更长来唯一定位）。用于迭代修改大文件（如只调 index.html 的某一段）。replace_all=true 时替换所有匹配。新建文件请用 write_file。",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作目录的文件路径" },
          old_string: { type: "string", description: "要被替换的原文（需与文件内容完全一致）" },
          new_string: { type: "string", description: "替换成的新内容" },
          replace_all: { type: "boolean", description: "是否替换所有匹配（默认 false，要求唯一匹配）" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    run: ({ path: p, old_string, new_string, replace_all }, ctx) => {
      try {
        const fp = path.resolve(ctx.baseDir, p);
        const oldS = String(old_string ?? "");
        if (!oldS) return Promise.resolve({ ok: false, content: "edit_file 的 old_string 不能为空；新建文件请用 write_file。" });
        const orig = fs.readFileSync(fp, "utf8");
        const count = orig.split(oldS).length - 1;
        if (count === 0) return Promise.resolve({ ok: false, content: `没找到要替换的内容（old_string 未在 ${p} 中出现）。请先 read_file 确认原文。` });
        if (count > 1 && !replace_all) return Promise.resolve({ ok: false, content: `old_string 在 ${p} 中出现 ${count} 次，不唯一。把它写得更长以唯一定位，或设 replace_all=true。` });
        const next = replace_all ? orig.split(oldS).join(String(new_string ?? "")) : orig.replace(oldS, () => String(new_string ?? ""));
        fs.writeFileSync(fp, next);
        return Promise.resolve({ ok: true, content: `已修改 ${p}（替换 ${replace_all ? count : 1} 处）` });
      } catch (e) { return Promise.resolve({ ok: false, content: `修改失败：${e.message}` }); }
    },
  },
  list_dir: {
    label: "列目录",
    hint: "列出工作目录里的文件（看上游成员产出了什么、在哪）",
    spec: {
      name: "list_dir",
      description: "列出工作目录（或其子目录）下的文件和子目录，含大小，用于了解当前有哪些产物、上游成员产出了什么文件。",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "可选，相对工作目录的子目录；默认列工作目录根" },
          depth: { type: "number", description: "可选，递归深度，默认 2，最大 6" },
        },
      },
    },
    run: ({ path: p, depth }, ctx) => {
      try {
        const root = p ? path.resolve(ctx.baseDir, p) : ctx.baseDir;
        if (!fs.existsSync(root)) return Promise.resolve({ ok: false, content: `目录不存在：${p || "."}` });
        const maxDepth = Math.max(1, Math.min(6, Number(depth) || 2));
        const lines = [];
        const walk = (dir, d) => {
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
          for (const e of entries) {
            if (e.name.startsWith(".")) continue;
            const full = path.join(dir, e.name);
            const rel = path.relative(ctx.baseDir, full);
            if (e.isDirectory()) {
              lines.push(`📁 ${rel}/`);
              if (d < maxDepth) walk(full, d + 1);
            } else {
              let sz = 0; try { sz = fs.statSync(full).size; } catch {}
              lines.push(`📄 ${rel}  (${sz} B)`);
            }
          }
        };
        walk(root, 1);
        return Promise.resolve({ ok: true, content: clip(lines.length ? lines.join("\n") : "(空目录)") });
      } catch (e) { return Promise.resolve({ ok: false, content: `列目录失败：${e.message}` }); }
    },
  },
  web_fetch: {
    label: "抓网页",
    hint: "抓取一个 URL 的内容（在线文档 / 参考资料 / 接口返回）",
    spec: {
      name: "web_fetch",
      description: "抓取一个 http(s) URL 的内容并返回文本（HTML 会粗略转成正文）。用于读在线文档、参考资料、接口返回。只读 GET，不提交表单/不改远端。",
      input_schema: {
        type: "object",
        properties: { url: { type: "string", description: "要抓取的完整 http(s) 链接" } },
        required: ["url"],
      },
    },
    run: async ({ url }) => {
      try {
        const u = String(url || "").trim();
        if (!/^https?:\/\//i.test(u)) return { ok: false, content: "url 必须是 http(s) 链接。" };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        let r;
        try { r = await fetch(u, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (AgentTeamStudio)" } }); }
        finally { clearTimeout(timer); }
        const ct = r.headers.get("content-type") || "";
        let body = await r.text();
        if (/html/i.test(ct)) {
          body = body
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
        }
        return { ok: r.ok, content: clip(`[HTTP ${r.status}] ${u}\n\n${body}`) };
      } catch (e) { return { ok: false, content: `抓取失败：${e.message}` }; }
    },
  },
  // 人工确认：需要用户拍板/补充时，弹窗问用户并挂起等待回答（HITL）。自动可用，不需在 agent.tools 里勾。
  ask_user: {
    label: "问用户",
    hint: "需要人确认或补充信息时，弹窗问用户并等待回答",
    spec: {
      name: "ask_user",
      description: "当你需要用户确认某个决定、或需要用户补充信息才能继续时，调用它向用户提问并【等待】用户回答；用户的回答会作为结果返回给你，然后你再继续。",
      input_schema: {
        type: "object",
        properties: { question: { type: "string", description: "要问用户的问题（清楚说明你需要确认/补充什么）" } },
        required: ["question"],
      },
    },
    run: ({ question }, ctx) => askUser(ctx, question),
  },
  // 成员自我进化：当用户的反馈意味着【你的职责/做法要长期改变】（不是一次性调整）时，用它改写自己的执行契约，
  // 系统会自动把改动回写进团队全局 Skill 并保存。一次性的小调整不要用它，直接照做即可。自动可用，不需在 tools 里勾。
  update_skill: {
    label: "改自己/技能",
    hint: "把对你职责/做法的长期改进固化进自己的执行契约，并回写全局 Skill",
    spec: {
      name: "update_skill",
      description: "当用户的反馈意味着你的职责或做法应当【长期固化】（而非一次性调整）时调用：用 system_prompt 给出你新的完整执行契约（在原有基础上吸收这次改进，保留仍有效的部分），系统会替换你的契约、自动重建团队全局 Skill 并保存。可选 note 写一句这次改了什么、为什么。只做一次性小调整时不要调用它。",
      input_schema: {
        type: "object",
        properties: {
          system_prompt: { type: "string", description: "你新的、完整的执行契约（整篇，吸收本次长期改进）" },
          note: { type: "string", description: "可选：一句话说明这次固化了什么、为什么" },
        },
        required: ["system_prompt"],
      },
    },
    run: ({ system_prompt, note }, ctx) => {
      if (!ctx.spec || !ctx.currentAgentId) return Promise.resolve({ ok: false, content: "当前环境无法更新技能。" });
      const me = (ctx.spec.agents || []).find((a) => a.id === ctx.currentAgentId);
      const r = applyTeamEvolution(ctx.spec, { by: me?.name || ctx.currentAgentId, member_edits: [{ member_id: ctx.currentAgentId, system_prompt }], note });
      if (!r.changes.length) return Promise.resolve({ ok: false, content: "没有有效改动（system_prompt 为空？）。" });
      ctx.send?.({ type: "skill_evolved", by: ctx.currentAgentId, changes: r.changes, saved: !!r.saved });
      return Promise.resolve({ ok: true, content: `已更新你的执行契约并回写全局 Skill（${r.changes.join("、")}）${r.saved ? "，团队已保存。" : "。"}` });
    },
  },
};

const TOOL_NAMES = Object.keys(TOOL_REGISTRY);
// 工具目录里把"真执行"工具暴露给前端勾选/路由；ask_user 是自动可用的交互工具，不计入
const REAL_TOOL_NAMES = ["shell", "write_file", "read_file", "edit_file", "list_dir", "web_fetch"];

// ---------- 工具授予策略（组合拳之一：默认授权 + 确定性映射）----------
// 每个成员默认就补上这些基础工具（读/写/精确改/列目录/抓网页），避免"我没有 xx 工具"这类常见失败。
const BASE_GRANT_TOOLS = ["read_file", "write_file", "edit_file", "list_dir", "web_fetch"];
// 角色/系统提示里出现这些信号 → 该成员需要 shell（跑命令/装依赖/调 CLI/渲染合成等）。
function memberNeedsShell(member) {
  if ((member.tools || []).includes("shell")) return true;
  const text = `${member.role || ""} ${member.system_prompt || ""}`.toLowerCase();
  return /\bshell\b|命令行|跑命令|执行命令|脚本|ffmpeg|ffprobe|curl|wget|puppeteer|whisper|渲帧|渲染|合成|倍速|烧录|字幕|配音|tts|出图|mkdir|brew|npm |npx|pip|\bgit\b|\bcli\b|mcporter|安装依赖|install/.test(text);
}
// 成员最终授予的【真执行工具】（不含 ask_user）：声明的 ∪ 基础读写 ∪ shell。
// 每个成员都给 shell：既能跑命令，也能在用户同意后自行安装缺失的依赖（安装本身需要 shell）。
function grantedRealTools(member) {
  const set = new Set((member?.tools || []).filter((t) => TOOL_REGISTRY[t] && t !== "ask_user"));
  for (const t of BASE_GRANT_TOOLS) set.add(t);
  set.add("shell");
  return [...set].filter((t) => TOOL_REGISTRY[t]);
}
// 生成团队时把推断出的授权持久化到 member.tools（让 UI / spec 反映真实授权；运行时也会兜底）。
function ensureMemberToolGrants(spec) {
  if (!spec || !Array.isArray(spec.agents)) return spec;
  for (const a of spec.agents) a.tools = grantedRealTools(a);
  return spec;
}

// ---------- 依赖预检（组合拳之三：出征前 which 一遍要用的二进制，缺的先暴露）----------
const KNOWN_BINARIES = ["ffmpeg", "ffprobe", "curl", "wget", "whisper", "node", "python3", "python", "pip3", "pip", "npm", "npx", "git", "convert", "magick", "mcporter", "yt-dlp", "sox", "pandoc", "jq"];
function requiredBinariesFor(spec) {
  const text = [
    spec.global_skill || "",
    ...(spec.agents || []).map((a) => `${a.role || ""} ${a.system_prompt || ""}`),
    ...((spec.skill_sources || []).map((s) => s.content || "")),
  ].join("\n").toLowerCase();
  return [...new Set(KNOWN_BINARIES.filter((b) => new RegExp(`(^|[^a-z0-9_./-])${b}([^a-z0-9_-]|$)`).test(text)))];
}
function whichBinary(bin, baseDir) {
  return new Promise((resolve) => {
    exec(`command -v ${bin}`, { cwd: baseDir, timeout: 8000, shell: "/bin/bash", env: process.env }, (err, stdout) =>
      resolve(!err && String(stdout || "").trim().length > 0));
  });
}
// 出征前预检：缺失的二进制 + 有工具但模型不会原生 tool_call 的成员。返回 { missing, toolModelWarnings }。
async function preflightDependencies(spec, baseDir, mainModel) {
  const missing = [];
  if (ALLOW_TOOLS) {
    for (const b of requiredBinariesFor(spec)) {
      if (!(await whichBinary(b, baseDir))) missing.push(b);
    }
  }
  const toolModelWarnings = [];
  for (const a of spec.agents || []) {
    if (!grantedRealTools(a).length) continue;
    const run = resolveAgentRunForTools(a, mainModel || "");
    if (run.unsupportedTools) toolModelWarnings.push(`${a.name || a.id}（模型 ${run.model} 不会返回原生工具调用，无法真正执行工具）`);
  }
  return { missing, toolModelWarnings };
}

// ---------- 运行中「用户插话」注入通道（像聊天一样把消息带给运行中的 agent）----------
const runInbox = new Map(); // runId -> [{ target, text, msgId }]
let injectSeq = 0;
function enqueueInject(runId, target, text) {
  const msgId = `${runId}-m${++injectSeq}`;
  const box = runInbox.get(runId) || [];
  box.push({ target: target || "__any__", text: String(text || ""), msgId });
  runInbox.set(runId, box);
  return msgId;
}
// 取出发给某个目标（agentId / ORCH_ID）的全部排队消息（同时取走广播 __any__）。
function drainInbox(runId, target) {
  const box = runInbox.get(runId);
  if (!box || !box.length) return [];
  const mine = [], rest = [];
  for (const m of box) ((m.target === target || m.target === "__any__") ? mine : rest).push(m);
  runInbox.set(runId, rest);
  return mine;
}
function agentLabelForDirective(spec, target) {
  if (!target || target === "__any__" || target === ORCH_ID) return "将军";
  const agent = (spec?.agents || []).find((item) => item.id === target);
  return agent ? `成员「${agent.name || agent.id}」` : `成员「${target}」`;
}
function normalizeConversationTarget(spec, target) {
  const raw = String(target || "");
  if (!raw || raw === "__any__" || raw === ORCH_ID) return ORCH_ID;
  return (spec?.agents || []).some((agent) => agent.id === raw) ? raw : ORCH_ID;
}
function formatInjectedDirective(spec, target, text) {
  return `用户在${agentLabelForDirective(spec, target)}的思考对话框追加输入：\n${String(text || "").trim()}`;
}
// 将军每一轮也会读取所有尚未被成员消费的插话。这样即使成员已完成，
// 用户给成员补充的话也会由主控接住，并决定是否返工/接续/直接收尾。
function drainInboxForHarness(runId, spec) {
  const box = runInbox.get(runId);
  if (!box || !box.length) return [];
  const agentIds = new Set((spec?.agents || []).map((agent) => agent.id));
  const mine = [], rest = [];
  for (const m of box) {
    if (m.target === ORCH_ID || m.target === "__any__" || agentIds.has(m.target)) mine.push(m);
    else rest.push(m);
  }
  runInbox.set(runId, rest);
  return mine;
}
// 只取「发给将军/广播」的消息（成员消息留给：并发 pump 处理空闲成员、运行中成员自己 pull）。
function drainOrchMsgs(runId) {
  const box = runInbox.get(runId);
  if (!box || !box.length) return [];
  const take = [], keep = [];
  for (const m of box) { (m.target === ORCH_ID || m.target === "__any__" ? take : keep).push(m); }
  runInbox.set(runId, keep);
  return take;
}
// 只取「发给【当前空闲】成员」的消息（运行中成员的留给它自己 pull，将军/广播的留给主循环）。
function takeIdleMemberMsgs(runId, spec, running) {
  const box = runInbox.get(runId);
  if (!box || !box.length) return [];
  const memberIds = new Set((spec?.agents || []).map((a) => a.id));
  const take = [], keep = [];
  for (const m of box) { (m.target && memberIds.has(m.target) && !running.has(m.target) ? take : keep).push(m); }
  runInbox.set(runId, keep);
  return take;
}
// 用户直接对某成员说话时，喂给该成员的输入：带上它之前的产出与用户原话，要求必须回应。
function buildUserMessageToMemberInput(task, member, priorOutput, text, ctx = {}) {
  let msg = `# 团队总任务\n${task}\n\n# 你（${member.name}）之前的产出\n${priorOutput || "(还没有产出)"}\n\n`;
  // 跟成员直接连续对话时，带上【它自己】的私有记忆（io + 你跟它的历史对话）。
  // 只在续聊/再出征(ctx.teamMemory 存在=本次会读记忆)时带，和正常调度路径一致。
  if (ctx.teamMemory && ctx.spec) {
    const mm = formatMemberMemoryForPrompt(readMemberMemory(ctx.spec, member.id));
    if (mm) msg += `${mm}\n`;
  }
  msg += `# 用户现在直接对你说\n${text}\n\n` +
    `请直接回应用户：若要你修改/重做，就据此更新并输出最新的完整交付物；若是提问，就回答。` +
    `无论你之前是否已完成，都必须给出回应，不要沉默。`;
  return msg;
}
// 取出发给某成员的插话并回执“已处理”，返回纯文本数组（供注入到该成员的消息流）。
function pullUserMessages(ctx, agentId) {
  const msgs = (ctx && ctx.runId) ? drainInbox(ctx.runId, agentId) : [];
  for (const m of msgs) ctx.send?.({ type: "user_msg", id: agentId, msg_id: m.msgId, text: m.text, status: "processing" });
  return msgs.map((m) => m.text);
}

// ---------- 人工确认（HITL）通道 ----------
const pendingAnswers = new Map(); // qid -> resolve
let askSeq = 0;
function askUser(ctx, question) {
  if (!ctx || !ctx.send || !ctx.runId) return Promise.resolve({ ok: false, content: "（当前环境不支持向用户提问）" });
  // qid 必须跨重启/续聊全局唯一：askSeq 重启会归零，加时间戳避免新 ask 撞上旧的已解决 qid（否则前端把新确认当成已解决→不弹框→卡死）。
  const qid = `${ctx.runId}-q${Date.now().toString(36)}${(++askSeq).toString(36)}`;
  const agent = ctx.currentAgentId || null;
  ctx.send({ type: "ask_user", qid, agent, question: String(question || ""), kind: ctx.askKind || "confirmation" });
  return new Promise((resolve) => {
    pendingAnswers.set(qid, (answer) => {
      const rawAnswer = String(answer || "");
      ctx.send({ type: "ask_resolved", qid, agent, answer: rawAnswer, kind: ctx.askKind || "confirmation" });
      resolve({ ok: true, answer: rawAnswer, content: `用户回答：${rawAnswer}` });
    });
  });
}

// 非 Anthropic 成员没有原生 ask_user 工具。它们在确认点明确写出“需要用户确认：...”
// 后由服务端识别并挂起；原文不做改写，确认回复只用于启动下一段续跑。
function detectConfirmationRequest(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const explicit = raw.match(/<ask_user>\s*([\s\S]*?)\s*<\/ask_user>/i);
  if (explicit?.[1]?.trim()) return clip(explicit[1].trim(), 600);

  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(-12);
  const negative = /(?:无需|无须|不需要|不用|不必).{0,12}(?:确认|回复|选择|决定|批准|审核)/;
  // 只认“明确的确认请求”（需要/请/等待 用户 确认/回复/批准），不再把模型随口的“是否继续？”当确认点，
  // 否则话痨模型每步都问一遍 → 疯狂弹确认。技能里真正的确认点会写“需要用户确认：…”或用 <ask_user>。
  const patterns = [
    /(?:需要|等待|烦请|请用户|请您|请你)\s*(?:用户)?.{0,40}(?:确认|回复|批准|审核|拍板|定夺)/,
    /请确认(?!.{0,4}(?:无误|收到))/,
  ];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^\s*(?:[-*#>]+\s*|\d+[.)]\s*)/, "");
    if (!negative.test(line) && patterns.some((pattern) => pattern.test(line))) return clip(line, 600);
  }
  return "";
}

function detectWritePermissionRequest(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const patterns = [
    /(?:工作目录|workspace|sandbox|沙箱).{0,80}(?:只读|read-?only|权限|permission).{0,80}(?:无法|不能|未能|not allowed|denied|failed).{0,80}(?:写入|修改|创建|write|edit|create|modify)/i,
    /(?:无法|不能|未能|not allowed|permission denied|operation not permitted).{0,80}(?:写入|修改|创建|write|edit|create|modify).{0,80}(?:工作目录|workspace|sandbox|沙箱|file|directory|文件|目录)/i,
    /(?:需要|请|必须).{0,80}(?:授权|允许|grant|permission).{0,80}(?:写入|修改|创建|write|edit|create|modify)/i,
    /(?:read-?only sandbox|只读沙箱|只读模式|workspace-write)/i,
  ];
  if (!patterns.some((pattern) => pattern.test(raw))) return "";
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(-10);
  return clip(lines.find((line) => patterns.some((pattern) => pattern.test(line))) || raw, 600);
}

function isAffirmativeAnswer(answer) {
  const text = String(answer || "").trim();
  return /^(?:y|yes|ok|okay|sure|true|1)\b/i.test(text) ||
    /^(?:授权|同意|允许|可以|确认|继续|好的|好|行|是|对|没问题)(?:\s|$|[，。,.!！])/i.test(text);
}

function buildConfirmationResumeInput(previousOutput, answer) {
  return `# 人工确认已返回

你上一段已经输出的内容会由系统按原文保留，禁止重写、摘要、润色或重复：

<previous_original_output>
${String(previousOutput || "")}
</previous_original_output>

# 用户确认 / 回复
${String(answer || "确认，可以继续")}

请严格从刚才的确认点之后继续执行，只输出后续新增内容。若原始执行契约还有新的确认点，再明确提出并停下等待；不要越过确认点。`;
}

function buildWritePermissionResumeInput(previousOutput, answer, baseDir) {
  return `# 写入权限已由用户授权

你上一段已经输出的内容会由系统按原文保留，禁止重写、摘要、润色或重复：

<previous_original_output>
${String(previousOutput || "")}
</previous_original_output>

# 用户授权 / 回复
${String(answer || "授权写入")}

# 当前授权范围
用户已临时授权你在本次成员调用中写入工作目录：\`${baseDir || "当前工作目录"}\`。
请从刚才因为权限受限而未完成的写入点继续执行，只输出后续新增内容；如果需要产出文件，请直接写入工作目录，并在最终结果里说明文件路径。`;
}

// ---------- 团队执行 ----------

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

function buildAgentInput(task, agent, outputs, ctx = {}) {
  let msg = `# 团队总任务\n${task}\n\n# 你的职责\n${agent.role}\n`;
  if (agent.depends_on.length > 0) {
    msg += `\n# 上游同事已完成的工作\n`;
    for (const dep of agent.depends_on) {
      msg += `\n<colleague id="${dep}">\n${outputs[dep] || "(无输出)"}\n</colleague>\n`;
    }
  }
  const run = resolveAgentRunForTools(agent, ctx.mainModel);
  const granted = ((ALLOW_TOOLS && ["anthropic", "ollama", "bailian"].includes(run.eff)) || ["claude-code", "codex-cli"].includes(run.eff))
    ? grantedRealTools(agent)
    : [];
  if (granted.length && ctx.baseDir) {
    msg += `\n# 你的工具与工作目录\n你被授予了这些可真正执行的工具：${granted.join("、")}。`;
    msg += `\n工作目录是 \`${ctx.baseDir}\`（shell 命令默认在此执行，文件读写也相对于它）。需要真正产出文件/调用命令时就调用工具去做，别只在文字里描述；做完在交付物里说明产物路径。`;
  }
  msg += `\n请基于以上信息完成你职责范围内的工作，直接输出你的交付物。`;
  msg += `\n若执行契约要求用户确认，必须在确认点停下：先完整输出当前待确认的原文，再调用 ask_user；若当前模型没有 ask_user 工具，则在末尾明确写“需要用户确认：具体问题”，等待系统取得回复后再继续。不得擅自越过确认点。`;
  return msg;
}

// 解析某个 agent 实际用的 provider + model（混合架构核心）
// 优先级：成员自己的 model > 团队主模型(teamMainModel，调度/基准) > 系统默认模型
function resolveAgentRun(agent, teamMainModel) {
  if (provider === "mock") return { eff: "mock", model: "mock" };
  const selected = resolveModelSelection(agent.model || teamMainModel || systemDefaultModel());
  const model = selected.model;
  const eff = selected.provider;
  // 不静默兜底：选的模型那条 provider 不可用就直接报错，让本次执行失败
  const who = agent.name || agent.id;
  const name = selected.label || model || selected.id;
  if (eff === "anthropic" && !anthropicClient) throw new Error(`成员「${who}」的模型「${name}」走 Anthropic API，但未配置 ANTHROPIC_API_KEY。`);
  if (eff === "claude-code" && !claudeCliAvailable) throw new Error(`成员「${who}」的模型「${name}」需要 claude CLI（订阅登录），但未检测到。`);
  if (eff === "codex-cli" && !codexCliAvailable) throw new Error(`成员「${who}」的模型「${name}」需要 Codex CLI，但未检测到。`);
  if (eff === "codex-cli" && !codexCliLoggedIn) throw new Error(`成员「${who}」的模型「${name}」需要 Codex ChatGPT 订阅登录态，请先执行 codex login。`);
  if (eff === "bailian" && !process.env.DASHSCOPE_API_KEY) throw new Error(`成员「${who}」的模型「${name}」走阿里百炼，但未配置 DASHSCOPE_API_KEY。`);
  if (eff === "ollama" && !ollamaReady) throw new Error(`成员「${who}」的模型「${name}」走 Ollama，但连不上 Ollama（${OLLAMA_HOST}）。`);
  return { eff, model, model_id: selected.id, model_label: name };
}

function ollamaModelSupportsManagedTools(model) {
  // 原则：shell/CLI 一律在本机执行、用本地网络（不分模型）。所以 ollama 成员一律走我们本地的工具循环，
  // 不再因 minimax 偶尔不规范就兜底到 codex 沙箱——模型不返回原生 tool_calls 时，由 runHarness 的伪
  // tool_call 防护干净停下并提示，而不是把执行挪到沙箱里。
  return true;
}

function modelSupportsManagedTools(eff, model) {
  if (eff === "mock") return true;
  if (eff === "claude-code" || eff === "codex-cli" || eff === "anthropic" || eff === "bailian") return true;
  if (eff === "ollama") return ollamaModelSupportsManagedTools(model);
  return false;
}

function toolCapableFallbackRun(current) {
  const currentKey = `${current.eff}:${current.model}`;
  const candidates = [];
  if (ENABLE_CODEX_CLI && codexCliAvailable && codexCliLoggedIn) {
    candidates.push({ eff: "codex-cli", model: CODEX_MODEL || "" });
  }
  if (ENABLE_CLAUDE_CODE && claudeCliAvailable) {
    candidates.push({ eff: "claude-code", model: "opus" });
  }
  if (anthropicClient) {
    candidates.push({ eff: "anthropic", model: ANTHROPIC_MODEL });
  }
  if (process.env.DASHSCOPE_API_KEY) {
    candidates.push({ eff: "bailian", model: process.env.BAILIAN_MODEL || "qwen-max" });
  }
  return candidates.find((c) => `${c.eff}:${c.model}` !== currentKey && modelSupportsManagedTools(c.eff, c.model)) || null;
}

function resolveAgentRunForTools(agent, teamMainModel) {
  const current = resolveAgentRun(agent, teamMainModel);
  const needsTools = grantedRealTools(agent).length > 0;
  if (!needsTools || modelSupportsManagedTools(current.eff, current.model)) return { ...current, fallback: false };
  const fallback = toolCapableFallbackRun(current);
  if (!fallback) return { ...current, fallback: false, unsupportedTools: true };
  return {
    ...fallback,
    fallback: true,
    fallback_from: current,
    fallback_reason: `模型「${current.model}」不会返回可执行的原生工具调用，已切换到工具执行模型。`,
  };
}

function detectPseudoToolCallArtifacts(text) {
  const raw = String(text || "");
  if (!raw) return false;
  return /<\s*tool_call\s*>|<\|?minimax\|?>|<\/\s*tool_call\s*>|\btool_calls?\b/i.test(raw) &&
    /<\s*tool_call\s*>|<\|?minimax\|?>/i.test(raw);
}

function stripPseudoToolCallArtifacts(text) {
  return String(text || "")
    .replace(/\]?\s*<\|?minimax\|?>\s*<\s*tool_call\s*>/gi, "")
    .replace(/<\s*\/?\s*tool_call\s*>/gi, "")
    .replace(/(?:<\|?minimax\|?>\s*)+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// claude-code provider：spawn `claude -p`，走订阅（不计 API）、用 Claude Code 原生全套工具。
// 解析 stream-json：assistant(content blocks) 流式产出 + result 收尾。返回最终文本。
function runClaudeCode(agent, userContent, send, ctx = {}, modelArg = "", options = {}) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];
    if (modelArg) args.push("--model", modelArg);
    // 确保工作目录存在（claude 的 cwd 指向不存在目录会 spawn 失败）
    let cwd = ctx.baseDir;
    try { if (cwd && !fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true }); } catch { cwd = process.cwd(); }
    if (!cwd) cwd = process.cwd();
    if (cwd) args.push("--add-dir", cwd);
    if (agent.system_prompt) args.push("--append-system-prompt", agent.system_prompt);
    // 没被授予工具的成员限制为只读；非交互式 claude -p 的确认统一交给服务端通道。
    const disallowedTools = ["AskUserQuestion"];
    const allowTools = options.forceTools || !!(agent.tools && agent.tools.length);
    if (!allowTools) disallowedTools.push("Bash", "Edit", "Write", "NotebookEdit");
    args.push("--disallowedTools", disallowedTools.join(" "));
    const env = { ...process.env, ...(ctx.secrets || {}) }; // 注入团队级凭证（ElevenLabs 等）
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; // 强制走订阅，而非 API 计费
    let cp;
    try { cp = require("child_process").spawn(CLAUDE_BIN, args, { cwd, env }); }
    catch (e) { resolve(`无法启动 claude CLI：${e.message}`); return; }
    let buf = "", finalText = "", stderr = "", streamed = false;
    cp.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "assistant" && ev.message?.content) {
          for (const b of ev.message.content) {
            // 统一逻辑：只如实转发模型真正吐出的思考；没吐就没有（前端显示通用占位）。
            if (b.type === "thinking" && (b.thinking || b.text)) send({ type: "agent_thinking", id: agent.id, text: b.thinking || b.text });
            else if (b.type === "text" && b.text) { send({ type: "agent_delta", id: agent.id, text: b.text }); streamed = true; }
            else if (b.type === "tool_use") send({ type: "tool_call", id: agent.id, tool: b.name, input: b.input });
          }
        } else if (ev.type === "user" && ev.message?.content) {
          for (const b of ev.message.content) {
            if (b.type === "tool_result") {
              const t = Array.isArray(b.content) ? b.content.map((x) => x.text || "").join("") : String(b.content || "");
              send({ type: "tool_result", id: agent.id, tool: "", ok: !b.is_error, summary: clip(t, 300) });
            }
          }
        } else if (ev.type === "result") {
          finalText = ev.result || finalText;
        }
      }
    });
    cp.stderr.on("data", (d) => { stderr += d; });
    cp.on("error", (e) => resolve(`无法启动 claude CLI：${e.message}（确认已 claude login，且 PATH 里有 claude）`));
    cp.on("close", (code) => {
      if (code !== 0 && !finalText) finalText = `claude-code 退出码 ${code}：${clip(stderr, 400)}`;
      // 若全程没流式出文本（如只有 result），把最终结果补发一次，保证 UI 有产出
      if (!streamed && finalText) send({ type: "agent_delta", id: agent.id, text: finalText });
      resolve(finalText);
    });
    cp.stdin.write(userContent); cp.stdin.end();
  });
}

function runCodex(agent, userContent, send, ctx = {}, modelArg = "", options = {}) {
  const allowTools = options.forceTools || !!(agent.tools && agent.tools.length);
  return codexExecOnce({
    system: agent.system_prompt,
    user: userContent,
    modelArg,
    cwd: ctx.baseDir,
    sandbox: "danger-full-access",
    allowTools,
    secrets: ctx.secrets || {},
    onThinking: (text) => send({ type: "agent_thinking", id: agent.id, text }),
    onEvent: (event) => {
      if (event.kind === "message" && event.text) {
        if (looksLikeCodexProcessText(event.text)) send({ type: "agent_thinking", id: agent.id, text: event.text + "\n\n" });
      } else if (event.kind === "tool_call") {
        send({ type: "tool_call", id: agent.id, tool: event.tool, input: event.input });
      } else if (event.kind === "tool_result") {
        send({ type: "tool_result", id: agent.id, tool: event.tool, ok: event.ok, summary: clip(event.summary, 400) });
      }
    },
  });
}

// 跑一个成员的核心循环：给定现成的 user 消息内容，处理 mock / ollama / CLI / anthropic(工具循环)。
// Anthropic 风格 spec（{name,description,input_schema}）→ OpenAI / ollama 的 function tool 格式
function toFunctionTools(specs) {
  return specs.map((s) => ({
    type: "function",
    function: { name: s.name, description: s.description, parameters: s.input_schema },
  }));
}
// 把一回合的 tool_calls 回写成「带工具调用的 assistant 消息」（ollama 与百炼/OpenAI 格式略不同）
function assistantToolMsg(eff, content, norm) {
  if (eff === "bailian") {
    return {
      role: "assistant", content: content || "",
      tool_calls: norm.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args || {}) } })),
    };
  }
  return { role: "assistant", content: content || "", tool_calls: norm.map((t) => ({ function: { name: t.name, arguments: t.args || {} } })) };
}
function toolResultMsg(eff, tc, content) {
  if (eff === "bailian") return { role: "tool", tool_call_id: tc.id, content: String(content ?? "") };
  return { role: "tool", tool_name: tc.name, content: String(content ?? "") }; // ollama 用 role:tool
}

function finiteTokenNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = finiteTokenNumber(
    raw.input_tokens ?? raw.prompt_tokens ?? raw.promptTokens ?? raw.prompt_eval_count ?? raw.promptEvalCount
  );
  const output = finiteTokenNumber(
    raw.output_tokens ?? raw.completion_tokens ?? raw.completionTokens ?? raw.eval_count ?? raw.evalCount
  );
  const totalRaw = finiteTokenNumber(raw.total_tokens ?? raw.totalTokens ?? raw.total);
  const total = totalRaw != null ? totalRaw : (input != null || output != null ? (input || 0) + (output || 0) : null);
  if (input == null && output == null && total == null) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
  };
}

function addUsageTotals(a, b) {
  const left = normalizeUsage(a);
  const right = normalizeUsage(b);
  if (!left) return right;
  if (!right) return left;
  const add = (x, y) => x == null && y == null ? null : (x || 0) + (y || 0);
  return {
    input_tokens: add(left.input_tokens, right.input_tokens),
    output_tokens: add(left.output_tokens, right.output_tokens),
    total_tokens: add(left.total_tokens, right.total_tokens),
  };
}

// ========== 统一 harness 引擎 ==========
// 一个 provider-aware 的 agentic 工具循环，anthropic / ollama / 百炼 共用同一套循环。
// CLI(claude-code/codex)是自带 harness 的黑盒，不走这里（在 runAgentCore 里委托）。

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

// 所有走 harness 的模型调用统一注入：默认用中文（含思考过程 thinking 与交付内容），除非用户明确要求其他语言。
const HARNESS_LANG_DIRECTIVE = "\n\n# 输出语言（最高优先级）\n默认全程用中文：思考过程（thinking）和最终交付内容都必须用中文，禁止默认用英文思考或输出。只有当用户明确要求用其他语言时，才改用用户指定的语言。";

async function runCliTerminalHarness({ id, system, input, toolDefs, model, eff, send, ctx, opts = {} }) {
  const tool = toolDefs.find((t) => t.name === opts.terminalTool);
  if (!tool) throw new Error(`runHarness terminalTool "${opts.terminalTool}" 未在 toolDefs 中声明。`);
  system = `${system}${HARNESS_LANG_DIRECTIVE}`; // CLI 终止工具模式也统一中文
  const submitRule = `# 提交方式

你现在运行在统一 runHarness 底座中。本轮必须等同于调用工具 \`${tool.name}\`，只提交该工具参数对应的 JSON 对象。
不要输出解释、Markdown、代码围栏或普通文本。`;
  const onThinking = (text) => send && send({ type: "agent_thinking", id, text });
  const startedAt = Date.now();
  let raw;
  if (eff === "codex-cli") {
    raw = await codexExecOnce({
      system,
      user: `${input}\n\n${submitRule}`,
      schema: tool.schema,
      modelArg: codexModelArg(model),
      onThinking,
      onEvent: (event) => {
        if (event?.kind === "message" && looksLikeCodexProcessText(event.text) && onThinking) {
          onThinking(String(event.text).trim() + "\n\n");
        }
      },
      cwd: ctx?.baseDir,
      sandbox: "danger-full-access",
      allowTools: false,
      secrets: ctx?.secrets || {},
    });
  } else if (eff === "claude-code") {
    raw = await claudeCodeOnce(system, `${input}\n\n${submitRule}`, ccModelArg(model), onThinking);
  } else {
    throw new Error(`runHarness 暂不支持 provider "${eff}" 的 CLI 终止工具模式。`);
  }
  const endedAt = Date.now();
  if (send) {
    send({
      type: "agent_metric",
      id,
      provider: eff,
      model,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Math.max(0, endedAt - startedAt),
      usage: null,
    });
  }
  try { return { __final: extractJson(raw) }; }
  catch { throw new Error(String(raw || "(empty response)")); }
}

// ---------- 上下文压缩（仿 Claude Code compaction）----------
// 累计上下文超过字符预算时，把"初始输入之后"的多轮对话/工具历史用模型压成一份摘要，
// 重建为 system + （原始任务 + 摘要）一条消息，让 agent 无缝接续；同时回写到记忆。
const HARNESS_CONTEXT_CHARS = Number(process.env.HARNESS_CONTEXT_CHARS || 140000); // ≈ token*3.5 的粗略字符预算
function messagesChars(messages) {
  let n = 0;
  for (const m of messages || []) n += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content || "").length;
  return n;
}
async function summarizeForCompaction({ eff, model, toSummarize, taskHint }) {
  const sys = `你是上下文压缩器。把下面这段多轮对话 / 工具执行历史压缩成一份结构化摘要，供同一个 agent 无缝接续工作。必须保留：当前目标与进度、已做出的关键决定与结论、已产出的文件名 / 路径与关键数据、尚未完成或待确认的事项、最近一次工具调用的结果要点。丢弃寒暄与冗余推理。默认用中文给出摘要正文（除非原文明显是用户要求的其他语言），不要加“以下是摘要”之类的话。`;
  const userMsg = { role: "user", content: `# 待压缩历史${taskHint ? `（任务：${clip(taskHint, 200)}）` : ""}\n${clip(toSummarize, 60000)}` };
  const messages = eff === "anthropic" ? [userMsg] : [{ role: "system", content: sys }, userMsg];
  const res = await modelTurn({ eff, model, system: sys, messages, toolDefs: [] });
  return String(res.content || "").trim();
}
function recordCompactionToMemory(ctx, id, summary) {
  if (!ctx || !ctx.spec || !summary) return; // 点将(__design__)等无 spec 的场景不写
  const entry = { at: new Date().toISOString(), summary: clip(summary, 4000) };
  if (id === ORCH_ID) {
    const mem = readTeamMemory(ctx.spec);
    mem.compactions = [entry, ...(mem.compactions || [])].slice(0, 5);
    writeTeamMemory(ctx.spec, mem);
  } else {
    const mem = readMemberMemory(ctx.spec, id);
    mem.summary = clip(summary, 200);
    mem.compactions = [entry, ...(mem.compactions || [])].slice(0, 5);
    writeMemberMemory(ctx.spec, id, mem);
  }
}
async function maybeCompactHarnessMessages({ messages, isAnth, system, input, id, eff, model, send, ctx }) {
  const headCount = isAnth ? 1 : 2; // 保留 system(非anth) + 初始输入；其后的累计内容才压缩
  if (messages.length <= headCount + 3) return false;       // 太短不压
  if (messagesChars(messages) < HARNESS_CONTEXT_CHARS) return false;
  const body = messages.slice(headCount);
  const bodyText = body.map((m) => `【${m.role}】${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n\n");
  send && send({ type: "agent_thinking", id, text: "\n⚙ 上下文较长，正在把早期对话压缩成摘要（保留目标、已产出与最近进展）…\n" });
  let summary = "";
  try { summary = await summarizeForCompaction({ eff, model, toSummarize: bodyText, taskHint: input }); } catch {}
  if (!summary) { send && send({ type: "agent_thinking", id, text: "（压缩失败，保留原上下文继续）\n" }); return false; }
  const combined = { role: "user", content: `${input}\n\n# 上文已压缩为摘要（之前的多轮对话与工具执行浓缩如下，请据此无缝接续，不要重复已完成的步骤）\n${summary}` };
  messages.length = 0;
  if (!isAnth) messages.push({ role: "system", content: system });
  messages.push(combined);
  send && send({ type: "agent_thinking", id, text: "✓ 上下文已压缩并回写记忆。\n" });
  try { recordCompactionToMemory(ctx, id, summary); } catch {}
  return true;
}

// 统一循环：思考→（要工具就执行回灌）→迭代，直到模型不再要工具收尾；命中确认点(detectConfirmationRequest)暂停问人。
// opts.terminalTool: 若设，模型调用该工具即视为「最终交付」，返回其 args（用于点将/将军调度等结构化提交）。
async function runHarness({ id, system, input, toolDefs, model, eff, send, ctx, opts = {} }) {
  if ((eff === "codex-cli" || eff === "claude-code") && opts.terminalTool) {
    return runCliTerminalHarness({ id, system, input, toolDefs, model, eff, send, ctx, opts });
  }
  if (eff === "codex-cli" || eff === "claude-code") {
    throw new Error(`runHarness 对 ${eff} 仅支持 terminalTool 结构化提交模式。`);
  }
  system = `${system}${HARNESS_LANG_DIRECTIVE}`; // 统一注入：默认中文（思考+交付），除非用户要求其他语言
  const actx = { ...ctx, currentAgentId: id };
  const isAnth = eff === "anthropic";
  const messages = isAnth ? [{ role: "user", content: input }] : [{ role: "system", content: system }, { role: "user", content: input }];
  const originalSegments = [];
  let lastUsage;
  let totalUsage = null;
  const MAX_TURNS = opts.maxTurns || 24;
  const suppressFinalEvents = !!opts.suppressFinalEvents;
  const rec = ctx && ctx.runId ? runs.get(ctx.runId) : null;
  // 被中断（用户发消息 / 停战）后怎么办：停战→stop；有发给本 agent 的消息→带上它继续（立即响应）；
  // 结构化提交(将军/点将)→再跑一轮据最新状态重提；普通成员遇到"不是给它的消息"→让出，把控制权交回将军。
  const handleInterrupt = () => {
    if (rec?.abort) return { stop: true };
    const mine = pullUserMessages(actx, id);
    if (mine.length) { for (const t of mine) messages.push({ role: "user", content: `用户实时指令（优先响应，立即据此调整）：${t}` }); return { continue: true }; }
    if (opts.terminalTool) return { continue: true };
    return { yield: true };
  };
  let curAborter = null, aborterEntry = null; // 本轮的 AbortController + 带 agentId 标签的登记项（供定向中断）
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (rec?.abort) break; // 用户停战
    await maybeCompactHarnessMessages({ messages, isAnth, system, input, id, eff, model, send, ctx }); // 上下文超预算则压缩并回写记忆
    for (const t of pullUserMessages(actx, id)) messages.push({ role: "user", content: `用户实时指令（优先响应）：${t}` });
    const turnStartedAt = Date.now();
    curAborter = new AbortController();
    aborterEntry = { ac: curAborter, agentId: id };
    rec?.aborters?.add(aborterEntry);
    actx.abortSignal = curAborter.signal; // 让工具(shell)能感知中断、杀掉子进程
    let res;
    try {
      res = await modelTurn({
        eff, model, system, messages, toolDefs, signal: curAborter.signal,
        onThinking: (d) => send && send({ type: "agent_thinking", id, text: d }),
        onDelta: isAnth && !suppressFinalEvents ? ((d) => send && send({ type: "agent_delta", id, text: d })) : null, // 非 anthropic 缓冲后一次性发，避免伪 tool_call 刷屏
      });
    } catch (e) {
      rec?.aborters?.delete(aborterEntry);
      if (curAborter.signal.aborted) { // 被用户消息/停战打断在"思考"阶段
        const h = handleInterrupt();
        if (h.continue) continue;
        // stop 或 yield：返回已产出部分
        const result = originalSegments.join("\n\n");
        if (!suppressFinalEvents) send && send({ type: "agent_done", id, usage: totalUsage || lastUsage, result, original_segments: originalSegments.length ? originalSegments : [result] });
        return result;
      }
      throw e;
    }
    const turnEndedAt = Date.now();
    lastUsage = res.usage || lastUsage;
    totalUsage = addUsageTotals(totalUsage, res.usage);
    if (send) {
      send({
        type: "agent_metric",
        id,
        turn: turn + 1,
        provider: eff,
        model,
        started_at: turnStartedAt,
        ended_at: turnEndedAt,
        duration_ms: Math.max(0, turnEndedAt - turnStartedAt),
        usage: normalizeUsage(res.usage),
      });
    }
    const hadPseudo = !isAnth && detectPseudoToolCallArtifacts(res.content);
    const cleanContent = isAnth ? res.content : stripPseudoToolCallArtifacts(res.content);
    const norm = (res.toolCalls || []).filter((t) => t && t.name);
    if (!norm.length && hadPseudo) {
      rec?.aborters?.delete(aborterEntry);
      const result = `成员「${id}」的模型「${model}」没有返回系统可执行的原生 tool_calls，而是输出了伪工具标记，已停止以避免死循环。` + (cleanContent ? `\n\n${cleanContent}` : "");
      if (!suppressFinalEvents) {
        send && send({ type: "agent_delta", id, text: result });
        send && send({ type: "agent_done", id, usage: totalUsage || lastUsage, result, original_segments: [result] });
      }
      return result;
    }
    if (norm.length) {
      // 终止工具：直接交结构化结果（点将用）
      if (opts.terminalTool) {
        const fin = norm.find((t) => t.name === opts.terminalTool);
        if (fin) return { __final: fin.args || {} };
      }
      if (cleanContent) originalSegments.push(cleanContent);
      if (isAnth) messages.push({ role: "assistant", content: res.anthRaw });
      else messages.push(assistantToolMsg(eff, cleanContent, norm));
      const anthResults = [];
      for (const tc of norm) {
        if (tc.name === "ask_user" && cleanContent) send && send({ type: "agent_checkpoint", id, result: cleanContent, checkpoint: originalSegments.length });
        if (tc.name !== "ask_user") send && send({ type: "tool_call", id, tool: tc.name, input: tc.args });
        let r;
        const toolDef = toolDefs.find((t) => t.name === tc.name); // 优先用本次传入的 toolDef.run（含将军 update_team 等自定义工具）
        try { r = toolDef?.run ? await toolDef.run(tc.args || {}, actx) : (TOOL_REGISTRY[tc.name] ? await TOOL_REGISTRY[tc.name].run(tc.args || {}, actx) : { ok: false, content: `未知工具 ${tc.name}` }); }
        catch (e) { r = { ok: false, content: `工具执行异常：${e.message}` }; }
        if (tc.name !== "ask_user") send && send({ type: "tool_result", id, tool: tc.name, ok: r.ok, summary: clip(r.content, 400) });
        if (isAnth) anthResults.push({ type: "tool_result", tool_use_id: tc.id, content: r.content, is_error: !r.ok });
        else messages.push(toolResultMsg(eff, tc, r.content));
      }
      if (isAnth) messages.push({ role: "user", content: anthResults });
      rec?.aborters?.delete(aborterEntry);
      if (curAborter.signal.aborted) { // 工具执行期间被用户消息/停战打断
        const h = handleInterrupt();
        if (!h.continue) {
          const result = originalSegments.join("\n\n");
          if (!suppressFinalEvents) send && send({ type: "agent_done", id, usage: totalUsage || lastUsage, result, original_segments: originalSegments.length ? originalSegments : [result] });
          return result;
        }
      }
      continue;
    }
    rec?.aborters?.delete(aborterEntry);
    // 无工具调用：文本收尾或确认点
    if (cleanContent) originalSegments.push(cleanContent);
    if (!isAnth && cleanContent && !suppressFinalEvents) send && send({ type: "agent_delta", id, text: cleanContent });
    const question = opts.disableConfirmationDetection ? "" : detectConfirmationRequest(cleanContent);
    if (!question) {
      const result = originalSegments.join("\n\n");
      if (!suppressFinalEvents) {
        send && send({ type: "agent_done", id, usage: totalUsage || lastUsage, result, original_segments: originalSegments.length ? originalSegments : [result] });
      }
      return result;
    }
    if (!suppressFinalEvents) send && send({ type: "agent_checkpoint", id, result: cleanContent, checkpoint: originalSegments.length });
    const answer = await askUser(actx, question);
    messages.push({ role: "assistant", content: cleanContent });
    messages.push({ role: "user", content: buildConfirmationResumeInput(cleanContent, answer.answer) });
  }
  const result = originalSegments.join("\n\n");
  if (!suppressFinalEvents) {
    send && send({ type: "agent_done", id, usage: totalUsage || lastUsage, result, original_segments: originalSegments.length ? originalSegments : [result] });
  }
  return result;
}

async function runAgentCore(agent, userContent, send, ctx = {}) {
  send({ type: "agent_start", id: agent.id });
  // 该成员开跑前，带上用户在它对话框里发过的实时插话
  const earlyMsgs = pullUserMessages({ ...ctx, send }, agent.id);
  if (earlyMsgs.length) userContent += "\n\n# 用户实时指令（优先响应）\n" + earlyMsgs.join("\n");
  if (provider === "mock") {
    const originalSegments = [];
    let prompt = userContent;
    for (let checkpoint = 0; checkpoint < 8; checkpoint++) {
      const text = await mockAgentRun(agent, send, prompt);
      originalSegments.push(text);
      const question = detectConfirmationRequest(text);
      if (!question) {
        const result = originalSegments.join("\n\n");
        send({ type: "agent_done", id: agent.id, result, original_segments: originalSegments });
        return result;
      }
      send({ type: "agent_checkpoint", id: agent.id, result: text, checkpoint: checkpoint + 1 });
      const answer = await askUser({ ...ctx, currentAgentId: agent.id }, question);
      prompt = buildConfirmationResumeInput(text, answer.answer);
    }
    throw new Error(`成员「${agent.name}」连续确认次数过多，已停止执行。`);
  }
  const resolved = resolveAgentRunForTools(agent, ctx.mainModel);
  const { eff, model } = resolved;
  send({
    type: "agent_model",
    id: agent.id,
    model,
    provider: eff,
    fallback_from: resolved.fallback_from || null,
    fallback_reason: resolved.fallback_reason || "",
  });
  if (resolved.fallback) {
    send({
      type: "agent_notice",
      id: agent.id,
      level: "warn",
      text: `${resolved.fallback_reason} 原模型：${resolved.fallback_from.model}（${resolved.fallback_from.eff}），实际执行：${model}（${eff}）。`,
    });
  }
  if (resolved.unsupportedTools) {
    const result = `成员「${agent.name}」需要使用工具（${(agent.tools || []).join("、")}），但当前模型「${model}」不会返回系统可执行的原生工具调用，且当前没有可用的 Codex / Claude Code / Anthropic 工具执行模型兜底。已停止本轮，避免伪 <tool_call> 死循环。请把该成员或将军模型切到 codex / claude-code，或取消该成员工具后再试。`;
    send({ type: "agent_delta", id: agent.id, text: result });
    send({ type: "agent_done", id: agent.id, result, original_segments: [result] });
    return result;
  }

  // API 工具在 Anthropic / Ollama / 百炼路径 + 真执行开关下可用；claude-code / codex CLI 用各自原生工具。
  const granted = ALLOW_TOOLS && (eff === "anthropic" || eff === "ollama" || eff === "bailian")
    ? grantedRealTools(agent)
    : [];
  // anthropic / ollama / 百炼：统一走 harness 引擎（自主工具循环 + 确认点 + 插话）
  if (eff === "anthropic" || eff === "ollama" || eff === "bailian") {
    const toolDefs = [TOOL_REGISTRY.ask_user, TOOL_REGISTRY.update_skill, ...granted.map((t) => TOOL_REGISTRY[t])]
      .map((t) => ({ name: t.spec.name, description: t.spec.description, schema: t.spec.input_schema, run: t.run }));
    return runHarness({ id: agent.id, system: agent.system_prompt, input: userContent, toolDefs, model, eff, send, ctx });
  }
  // claude-code / codex：自带 harness 的 CLI 黑盒，委托执行（含写权限 HITL、确认点续跑）
  if (eff === "claude-code" || eff === "codex-cli") {
    const originalSegments = [];
    let prompt = userContent;
    let writeAuthorized = false;
    let fullAccessAuthorized = eff === "codex-cli";
    for (let checkpoint = 0; checkpoint < 8; checkpoint++) {
      let content;
      if (eff === "claude-code") {
        content = await runClaudeCode(agent, prompt, send, ctx, ccModelArg(model), { forceTools: writeAuthorized });
      } else if (eff === "codex-cli") {
        content = await runCodex(agent, prompt, send, ctx, codexModelArg(model), { forceTools: writeAuthorized, fullAccess: fullAccessAuthorized });
      } else {
        const chat = eff === "bailian" ? bailianChat : ollamaChat;
        ({ content } = await chat({
          system: agent.system_prompt,
          user: prompt,
          model,
          onDelta: (delta) => send({ type: "agent_delta", id: agent.id, text: delta }),
          onThinking: (delta) => send({ type: "agent_thinking", id: agent.id, text: delta }),
        }));
      }
      if (eff === "ollama" || eff === "bailian") {
        const hadPseudoTool = detectPseudoToolCallArtifacts(content);
        content = stripPseudoToolCallArtifacts(content);
        if (hadPseudoTool) {
          const result = `成员「${agent.name}」的模型「${model}」输出了伪工具调用标记，但本轮没有产生系统可执行的原生 tool_calls。系统已清理该噪声并停止继续重试，避免死循环。` +
            (content ? `\n\n模型保留下来的文本：\n${content}` : "");
          send({ type: "agent_done", id: agent.id, result, original_segments: [result] });
          return result;
        }
      }
      originalSegments.push(content);
      const permissionSignal = !fullAccessAuthorized && (eff === "claude-code" || eff === "codex-cli")
        ? detectWritePermissionRequest(content)
        : "";
      if (permissionSignal) {
        send({ type: "agent_checkpoint", id: agent.id, result: content, checkpoint: checkpoint + 1 });
        const answer = await askUser(
          { ...ctx, currentAgentId: agent.id, askKind: "permission" },
          `成员「${agent.name}」尝试写入工作目录，但当前没有写入授权。\n\n模型原话：${permissionSignal}\n\n是否临时授权该成员本次调用写入工作目录并重试？回复“授权”或“可以”即可继续；回复其他内容则保留当前输出，不再重试写入。`
        );
        if (isAffirmativeAnswer(answer.answer)) {
          writeAuthorized = true;
          fullAccessAuthorized = eff === "codex-cli";
          prompt = buildWritePermissionResumeInput(content, answer.answer, ctx.baseDir);
          continue;
        }
        const result = originalSegments.join("\n\n");
        send({ type: "agent_done", id: agent.id, result, original_segments: originalSegments });
        return result;
      }
      const question = detectConfirmationRequest(content);
      if (!question) {
        const result = originalSegments.join("\n\n");
        send({ type: "agent_done", id: agent.id, result, original_segments: originalSegments });
        return result;
      }
      send({ type: "agent_checkpoint", id: agent.id, result: content, checkpoint: checkpoint + 1 });
      const answer = await askUser({ ...ctx, currentAgentId: agent.id }, question);
      prompt = buildConfirmationResumeInput(content, answer.answer);
    }
    throw new Error(`成员「${agent.name}」连续确认次数过多，已停止执行。`);
  }

  // anthropic / ollama / 百炼 已在上面走 runHarness 返回，claude-code / codex 已在 CLI 块返回。
  // 走到这里说明 provider 解析异常，直接报错（不应发生）。
  throw new Error(`无法为成员「${agent.name}」解析可用执行 provider（eff=${eff}）。`);
}

const ORCH_ID = "__orchestrator__";

const HARNESS_MAX_ROUNDS = 48;
const HARNESS_MAX_MEMBER_CALLS = 3;
const HARNESS_MAX_PARALLEL = 8;

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

function buildHarnessMemberInput(task, member, upstreamIds, outputs, instruction, reason, ctx = {}) {
  let msg =
    `# 团队总任务\n${task}\n\n` +
    `# 将军本轮指令\n${instruction}\n\n` +
    `# 你的职责边界\n${member.role}\n`;
  if (reason) msg += `\n# 主控选择这条路线的原因\n${reason}\n`;
  // 成员只带【它自己】的私有记忆（仿 Claude Code 子 agent 隔离），不灌整个团队记忆、不含别的成员、不含主控。
  // 只在续聊/再出征(ctx.teamMemory 存在=本次会读记忆)时带。
  if (ctx.teamMemory && ctx.spec) {
    const mm = formatMemberMemoryForPrompt(readMemberMemory(ctx.spec, member.id));
    if (mm) msg += `\n${mm}\n`;
  }
  // 导入 skill 的旧团队成员没有模块映射(module_refs 空)：运行时把原始 skill 全文喂给它，
  // 让它能照着原文里的命令/参数/curl 执行（新导入已把各自模块原文拼进 system_prompt，不再重复注入）。
  if (Array.isArray(ctx.skillSources) && ctx.skillSources.length && !(Array.isArray(member.module_refs) && member.module_refs.length)) {
    msg += `\n# 团队原始 Skill 全文（你那一步的命令、参数、顺序、模板以此为准，逐字遵守，不得改写）\n` +
      ctx.skillSources.map((s) => `===== ${s.name} =====\n${s.content}`).join("\n\n") + "\n";
  }
  // 把该节点真正需要的输入都给它：将军选的 upstream_ids ＋ 它在 DAG 上声明依赖且已有产出的同事（自动补齐，避免漏喂）。
  const deps = (member.depends_on || []).filter((d) => outputs[d] != null && String(outputs[d]).trim());
  const feedIds = [...new Set([...(upstreamIds || []), ...deps])];
  if (feedIds.length) {
    msg += "\n# 你的输入：上游成员产出（据此开展本轮工作，不要重复它们已做的事）\n";
    for (const id of feedIds) msg += `\n<colleague id="${id}">\n${outputs[id] || "(无输出)"}\n</colleague>\n`;
  }
  const run = resolveAgentRunForTools(member, ctx.mainModel);
  const granted = ((ALLOW_TOOLS && ["anthropic", "ollama", "bailian"].includes(run.eff)) || ["claude-code", "codex-cli"].includes(run.eff))
    ? grantedRealTools(member)
    : [];
  if (granted.length && ctx.baseDir) {
    msg += `\n# 你的工具与工作目录\n你被授予了这些可真正执行的工具：${granted.join("、")}。`;
    msg += `\n工作目录（即 \`$BASE_DIR\`）= \`${ctx.baseDir}\`：shell 默认在此执行、环境变量 $BASE_DIR 已指向它；write_file/read_file 用相对路径即相对于它。`;
    msg += `\n**所有产物必须落在这个目录里**：skill 原文里若写了 \`~/Documents/...\` 之类的绝对输出路径，一律改写到 \`$BASE_DIR\` 下的同名文件（命令、参数、模板其余部分照旧不变），保证全部产物都在执行目录、下游能按相对名找到。做完在交付物里说明产物的相对路径。`;
  }
  msg += "\n严格保持你的 system prompt 中定义的原始功能与交付标准，只执行本轮被分配的工作，直接输出最终交付物。";
  msg += "\n# 交付物的富文本格式（结果框会按这些直接渲染，善用它让交付更直观）\n" +
    "你的最终交付会渲染成富文本，请用以下格式，让产物直接可看：\n" +
    "- Markdown：标题、列表、表格、`代码块`、引用、加粗/斜体都支持。\n" +
    "- 图片：`![说明](相对路径.png)`（png/jpg/jpeg/gif/webp/svg 会内联显示）。\n" +
    "- 视频：`[标题](output-final.mp4)`（mp4/webm/mov 会内嵌可播放的播放器）。\n" +
    "- 音频：`[标题](audio.mp3)`（mp3/wav/m4a/ogg 会内嵌音频条）。\n" +
    "- 网页：`[标题](index.html)`（.html 会内嵌 iframe 预览 + 新窗口打开按钮）。\n" +
    "- 流程图/架构图：用 ```mermaid 代码块（flowchart / sequenceDiagram 等），会渲染成图。\n" +
    "- 数学公式：行内用 \\(...\\)，独立成行用 $$...$$ 或 \\[...\\]（KaTeX 渲染）；不要用裸 $...$（会和 $BASE_DIR、shell 变量冲突）。\n" +
    "- 链接里的路径用【相对工作目录】的路径（如 `index.html`、`frames-subs/cover.png`），系统会自动解析到产物；不要写绝对路径或 file://。\n" +
    "凡是你产出了图片/音频/视频/网页文件，最后都用上面的 markdown 把它引用出来，让用户在结果框里直接看到/播放，而不是只写一句「已生成 xxx」。";
  msg += "\n思考过程（thinking）和最终交付都默认用中文，除非用户明确要求其他语言；禁止默认用英文思考或输出。";
  msg += "\n若执行契约要求用户确认，必须在确认点停下：先完整输出当前待确认的原文，再调用 ask_user；若当前模型没有 ask_user 工具，则在末尾明确写“需要用户确认：具体问题”，等待系统取得回复后再继续。不得擅自越过确认点。";
  return msg;
}

function harnessPlannerSystem(spec, options = {}) {
  const continuation = !!options.continuation;
  const completionRule = continuation
    ? "0. 连续对话模式：本次是基于历史出征的追加输入，不要求重新覆盖所有成员。完成标准是充分回应用户追加输入；必要时调度相关成员返工/接续，也可以由你直接汇总回答。"
    : "0. 默认完成标准（让位于用户意图）：默认所有成员步骤都至少完成一次才算出征完成，不要因为局部目标看似达成就提前 finish。但用户若表达了停止/收尾/转向的意图，按最高原则以用户为准。";
  const finishRule = continuation
    ? "8. 连续对话可以在用户追加输入已被充分处理后 finish；finish.final_answer 必填，作为你（将军）对历史与本轮产出的最终总结/回复。若主要依据某位成员结果，可同时填写 final_member_id 作为来源引用。"
    : "8. 默认所有成员步骤完成后才 finish（用户要求提前收尾时按最高原则）。finish.final_answer 必填，作为你（将军）综合全队成员产出后的最终总结与交付口径；成员原文仍保留在成员输出框，不要只返回 final_member_id。若主要依据某位成员结果，可同时填写 final_member_id 作为来源引用。final_answer 会渲染成富文本：可用 Markdown，并用 `![](相对路径)` / `[标题](文件.mp4/.mp3/.html)` 把最终产物（视频/音频/封面图/网页）引用出来，让用户在交付框里直接看到/播放。";
  const routingRule = continuation
    ? "4. 根据历史产出、成员状态和用户追加输入动态决定下一步；如果用户是在某个成员对话框里补充，优先判断是否需要派该成员返工/接续。"
    : "4. 根据成员输出中的参数、状态、质量和用户目标动态决定下一步；默认应覆盖团队全部成员步骤，已完成成员可按需返工、未完成成员继续调度——除非用户意图要求改变这一计划。";
  return `你是团队「${spec.team_name}」的将军，也是 Harness 主控 Agent。你持有团队完整 Skill，负责理解全局目标并控制所有子 Agent。

DAG 仅用于界面展示团队结构和实时作战状态，不是权限边界，也不是固定执行顺序。每轮只能选择一个动作：
- dispatch：选择一个成员独立执行；
- dispatch_parallel：把相互独立的工作同时派给多个成员；
- ask_user：确实缺少用户决策时提问；
- finish：交付物已经完成时结束。

【最高原则 · 用户意图优先（高于下面一切默认规则）】
你只干两件事：① 读懂上下文（各成员产出、DAG、运行记录）动态调度；② 读懂用户的实时指令，决定下一步。
- 用户的意图由你自己判读：要不要停、要不要换方向、要不要让某成员返工、是不是接受当前结果——都由你理解用户原话得出，系统不会替你预判，也没有关键词规则替你判定。
- 下面的“默认团队规则”都只是默认值。当你判读出的用户意图与任何默认规则（例如“必须跑完所有成员才收尾”“同一成员调用次数上限”）冲突时：以用户意图为准。
- 若这个冲突让你拿不准该不该破例（用户意图不够明确、或破例代价大），不要自作主张、也不要拿规则去拒绝用户——用 ask_user 把这个选择原样抛给用户，等他确认后再动。
- 绝不能用任何默认规则去无视、拖延或顶回用户的指令。

默认团队规则（均为默认值，遇用户意图冲突时按上面最高原则让位 / 改用 ask_user 确认）：
${completionRule}
1. 你可以按完整 Skill 和当前任务调用任何成员；depends_on 只是 DAG 展示建议，不限制真实调度。
2. upstream_ids 只填本轮确实需要交给成员参考的已完成成员产出，可以为空，也可以跨越 DAG 展示关系。
3. 当多个成员当前不互相依赖、可以独立产出时，优先用 dispatch_parallel 并行；同一批成员只能引用批次开始前已经完成的结果。
${routingRule}
5. 每个成员是独立子 Agent，拥有自己的模型、system prompt、工具与独立结果框；不得替成员改写其执行契约。
6. 成员结果不合格时可以单独返工，也可以把相互独立的返工放入同一 dispatch_parallel 批次；同一成员最多调用 ${HARNESS_MAX_MEMBER_CALLS} 次。
7. instruction 只说明本轮任务、输入和交付目标；完整 Skill 与成员 system prompt 的规则优先。不得在 instruction 里写“不要提问/禁止向任何对象提问/直接执行不要确认”之类的话——成员若执行契约里有确认点，必须让它在确认点正常停下问用户，你无权替它取消确认。
${finishRule}
9. 任一成员进入人工确认时，系统会挂起该成员并等待用户回复；在回复返回前不得启动新的调度轮次。确认前后的成员原文必须完整保留，不得用总结替换。
10. 始终输出符合 schema 的 JSON。未使用字段填空字符串、空数组；仅 dispatch_parallel 填 parallel_calls。
11. 思考过程和指令默认全程用中文，禁止默认用英文；只有用户明确要求其他语言时才改用该语言。

以下是你必须完整遵守的团队全局 Skill：

<team_global_skill>
${spec.global_skill || buildTeamGlobalSkill(spec)}
</team_global_skill>`;
}

function formatTeamMemoryForPrompt(memory) {
  if (!memory || typeof memory !== "object") return "（暂无团队记忆）";
  // 喂给将军的是“记得起大概”的精简记忆，不是全文（成员产出全文在各自输出框；这里只要摘要，避免每轮一大坨）。
  const view = {
    updated_at: memory.updatedAt || null,
    summary: memory.summary || "",
    facts: Array.isArray(memory.facts) ? memory.facts.slice(-8) : [],
    user_inputs_history: Array.isArray(memory.conversations) ? memory.conversations.slice(0, 8).map((c) => clip(c.text || "", 120)) : [],
    recent_runs: Array.isArray(memory.runs) ? memory.runs.slice(-3) : [],
    agent_outputs: Object.fromEntries(Object.entries(memory.agentOutputs || {}).map(([id, o]) => [id, { name: o.agentName || id, gist: clip(o.output || "", 400) }])),
  };
  return clip(JSON.stringify(view, null, 2), 6000);
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

function harnessPlannerState(spec, task, outputs, callCounts, history, validationError, userDirectives = [], teamMemory = null, producedAt = {}) {
  // 主控只做一件事：根据“用户输入”或“成员已产出的结果”，决定 DAG 里的下一步。
  // 只给它团队结构 + 各成员当前产出 + 用户输入，不再喂“可调度/已调度”等固定脚手架。
  const dag = spec.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    depends_on: agent.depends_on,
    tools: agent.tools || [],
  }));
  // 回传给将军的是【结构化要点 + 产物文件路径】，不是全文——它做调度判断够用了，全文在成员输出框/文件里，下游要用照样拿全文。
  const produced = Object.fromEntries(
    Object.entries(outputs).map(([id, output]) => {
      const agent = spec.agents.find((a) => a.id === id);
      const files = extractArtifactPaths(output);
      return [id, { member: agent?.name || id, summary: clip(output || "(无输出)", 600), ...(files.length ? { artifacts: files } : {}) }];
    })
  );
  const recentHistory = history.slice(-6).map((item) => ({
    action: item.action,
    member_id: item.member_id,
    result: item.result ? clip(item.result, 800) : undefined,
  }));
  const stale = staleDownstreamMembers(spec, outputs, producedAt);
  const staleBlock = stale.length
    ? `\n# ⚠ 产出可能过时的下游成员（它们的上游在它们跑完之后又被更新了）\n${JSON.stringify(stale, null, 2)}\n判断准则：如果这些下游成员的产出依赖上游里【被更新的那部分】，通常需要带上新的上游产出重新 dispatch 它们；如果上游这次的改动不影响它们已交付的内容，可以不返工、继续推进或收尾。拿不准就基于成员产出内容判断，必要时 ask_user。\n`
    : "";
  const memoryBlock = teamMemory ? `\n# 团队记忆（仅历史再出征/连续对话时带入）\n${formatTeamMemoryForPrompt(teamMemory)}\n` : "";
  return `# 用户任务
${task}

# 团队成员与 DAG 结构（你据此决定下一步该让谁干、按依赖关系推进）
${JSON.stringify(dag, null, 2)}

# 各成员当前产出（要点摘要 + 产物文件路径；出现=已产出，没出现=还没产出。全文在成员输出框里，需要细看可让它再说明，但调度判断看这些就够）
${JSON.stringify(produced, null, 2)}

# 最近运行记录
${JSON.stringify(recentHistory, null, 2)}
${staleBlock}${memoryBlock}${validationError ? `\n# 上一轮调度被拒绝\n${validationError}\n请据此修正后重新决策。` : ""}
${userDirectives.length ? `\n# 用户运行中实时指令（最高优先级，必须立即响应；要求停止/收尾就据此 finish）\n${userDirectives.map((d, i) => `${i + 1}. ${d}`).join("\n")}` : ""}

请只根据“用户任务/实时指令”和“成员已产出的结果”，决定 DAG 里的下一步：派哪个成员、给它哪些已产出结果作为输入，或在目标达成时收尾。`;
}

const HARNESS_DECISION_TOOL = "submit_harness_decision";

function harnessDecisionTool(spec) {
  return {
    name: HARNESS_DECISION_TOOL,
    description: "提交将军本轮唯一调度动作。必须通过这个工具提交 dispatch / dispatch_parallel / ask_user / finish，不要用普通文本回答。",
    schema: harnessDecisionSchema(spec),
    run: () => ({ ok: true, content: "已提交将军调度决策" }),
  };
}
// 将军的团队进化工具（非终止）：当用户的反馈意味着团队该【长期改变】时调用——改成员契约/新建成员/改目标/追加全局规则。
const HARNESS_UPDATE_TEAM_TOOL = "update_team";
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

async function runHarnessPlannerDecision({ spec, task, outputs, callCounts, history, validationError, userDirectives, teamMemory, continuation, producedAt, planner, send, ctx }) {
  const tool = harnessDecisionTool(spec);
  const evoTool = updateTeamTool(spec);
  const system = `${harnessPlannerSystem(spec, { continuation })}

# 思考要简洁（重要）
像跟用户正常对话那样，简短地想清楚"这一步该干嘛"就行：直接依据【用户最新输入 + 各成员当前产出】判断下一步，**不要长篇复述或重新分析历史、不要把已知状态再罗列一遍、不要反复 "let me reconsider / actually..."**。一两句到位，然后立刻提交决策。

# runHarness 提交规则
本轮可以先（按需）调用 \`${evoTool.name}\` 让团队长期进化，然后【必须】通过 \`${tool.name}\` 提交本轮唯一调度动作。不要直接输出普通文本，不要把思考内容当作交付结果。`;
  const input = `${harnessPlannerState(spec, task, outputs, callCounts, history, validationError, userDirectives, teamMemory, producedAt)}

# 本轮要求
若用户反馈意味着团队该长期改变，先调用 \`${evoTool.name}\`；最后调用 \`${tool.name}\` 提交唯一调度动作。`;
  const out = await runHarness({
    id: ORCH_ID,
    system,
    input,
    toolDefs: [tool, evoTool],
    model: planner.model,
    eff: planner.eff,
    send,
    ctx,
    opts: {
      terminalTool: tool.name,
      maxTurns: 4,
      suppressFinalEvents: true,
      disableConfirmationDetection: true,
    },
  });
  if (out && out.__final) return out.__final;
  throw new Error(`将军没有通过 ${tool.name} 提交有效调度。模型返回：${String(out || "(empty response)")}`);
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

async function runTeam(spec, task, send, runId, opts = {}) {
  const waves = topoWaves(spec.agents); // 校验 DAG 无环，同时继续供前端绘图。
  const outputs = { ...(opts.resumeOutputs || {}) };       // 服务器恢复时预置已完成成员产出，不重跑
  const callCounts = { ...(opts.resumeCallCounts || {}) };
  const history = [];
  const continuation = opts.continuation || null;
  const allowPartialFinish = !!continuation; // 连续对话模式默认允许提前收尾；用户中途操盘由 userSteering 触发让位
  const mainModel = spec.main_model || "";
  if (!runId) runId = `${spec.id || "team"}-${Date.now().toString(36)}`;
  const baseDir = path.join(RUNS_DIR, runId);
  const willUseTools = spec.agents.some((agent) => (agent.tools || []).length);
  const usesClaudeCode = provider !== "mock" && spec.agents.some(
    (agent) => providerForModel(agent.model || mainModel || systemDefaultModel()) === "claude-code"
  );
  const usesCodexCli = provider !== "mock" && spec.agents.some(
    (agent) => providerForModel(agent.model || mainModel || systemDefaultModel()) === "codex-cli"
  );
  const harnessIsClaudeCode = provider !== "mock" &&
    providerForModel(mainModel || systemDefaultModel()) === "claude-code";
  const harnessIsCodexCli = provider !== "mock" &&
    providerForModel(mainModel || systemDefaultModel()) === "codex-cli";
  const needDir = provider !== "mock" && (willUseTools || usesClaudeCode || usesCodexCli || harnessIsClaudeCode || harnessIsCodexCli);
  if (needDir) fs.mkdirSync(baseDir, { recursive: true });
  const ctx = { baseDir, mainModel, secrets: spec.secrets || {}, send, runId, spec, teamMemory: opts.memorySnapshot || null, skillSources: normalizeSkillSources(spec.skill_sources) };

  send({
    type: "run_start",
    mode: "harness",
    run_id: runId,
    waves: waves.map((wave) => wave.map((agent) => agent.id)),
    agents: spec.agents.map((agent) => agent.id),
    orchestrator: ORCH_ID,
    work_dir: needDir ? baseDir : null,
    continuation,
  });
  send({ type: "agent_start", id: ORCH_ID });

  let planner = null;
  if (provider === "mock") {
    send({ type: "agent_model", id: ORCH_ID, model: "mock-harness", provider: "mock" });
    send({ type: "agent_delta", id: ORCH_ID, text: "将军已接管执行并持有完整团队 Skill，DAG 仅展示作战状态。\n" });
  } else {
    const resolved = resolveAgentRun({ id: ORCH_ID, name: "将军", model: mainModel }, "");
    planner = resolved;
    send({ type: "agent_model", id: ORCH_ID, model: resolved.model, provider: resolved.eff });
  }
  // 不再发系统固定开场白——将军思考框只呈现模型自己的真实思考（与成员一致）。

  let validationError = "";
  let invalidStreak = 0;
  let lastMemberId = "";
  let userDirectives = []; // 本轮要交给将军的【待处理】实时指令；将军一旦据此做出实质决策(派活/收尾)就清空，避免反复重派造成死循环
  let userHasSteered = false; // 用户是否在本次出征里操过盘（粘性，仅用于 deferToUser，让团队规则给用户让位）
  const producedAt = {}; // 成员id -> 最近一次产出的序号；用来判断"上游晚于下游更新→下游可能已过时需返工"
  let produceSeq = 0;
  for (const mid of Object.keys(outputs)) producedAt[mid] = ++produceSeq; // 恢复时已完成成员视为已产出
  // 不做出征前依赖预检——依赖缺不缺、装不装，运行中成员真碰到了再用 ask_user 问用户、按用户要求办即可。

  // —— 并发「实时对话」：用户给【当前空闲/已完成】的成员发消息时，立刻并行把它叫起来回应，
  //    不打断正在跑的成员、也不等本轮结束。运行中成员的消息由它自己 pull 处理；发给将军的进 userDirectives。
  const running = new Set();   // 当前正在执行的成员 id（主轮派的 + pump 并发起的）
  const liveTasks = new Set(); // 并发响应任务，运行结束前要等它们跑完
  let pumpStop = false;
  async function respondMemberToUser(tm, msg) {
    const callIndex = (callCounts[tm.id] || 0) + 1;
    send({ type: "member_call", from: ORCH_ID, to: tm.id, call_index: callIndex, upstream_ids: [], instruction: msg.text, reason: "用户直接给该成员发了消息，要求其回应/调整", parallel: false });
    send({ type: "user_msg", id: tm.id, msg_id: msg.msgId, text: msg.text, status: "processing" });
    const memberSend = (event) => send({ ...event, call_index: callIndex });
    let out;
    try { out = await runAgentCore(tm, buildUserMessageToMemberInput(task, tm, outputs[tm.id], msg.text, ctx), memberSend, ctx); }
    catch (e) { out = `成员「${tm.name}」回应用户消息失败：${e.message}`; send({ type: "agent_done", id: tm.id, result: out, call_index: callIndex }); }
    outputs[tm.id] = out;
    callCounts[tm.id] = callIndex;
    producedAt[tm.id] = ++produceSeq;
    history.push({ action: "member_rerun", member_id: tm.id, result: out });
    send({ type: "user_msg", id: tm.id, msg_id: msg.msgId, text: msg.text, status: "done" });
    userHasSteered = true;
    userDirectives.push(`成员「${tm.name}」刚根据用户消息重新执行完毕，已更新其交付结果。请基于该结果判断是否需要让下游成员重跑或调整后续。`);
  }
  function pumpIdleChat() {
    for (const msg of takeIdleMemberMsgs(runId, spec, running)) {
      const tm = spec.agents.find((a) => a.id === msg.target);
      if (!tm) continue;
      running.add(tm.id);
      const p = respondMemberToUser(tm, msg).catch(() => {}).finally(() => { running.delete(tm.id); liveTasks.delete(p); });
      liveTasks.add(p);
    }
  }
  (async () => { while (!pumpStop) { if (!runs.get(runId)?.abort) pumpIdleChat(); await new Promise((r) => setTimeout(r, 150)); } })();

  try {
  for (let round = 0; round < HARNESS_MAX_ROUNDS; round++) {
    // 用户点了「停战」：硬终止。成员会在各自当前步骤结束后停下，这里直接收尾、标记 stopped。
    if (runs.get(runId)?.abort) {
      const done = completedHarnessMembers(spec, outputs).length;
      const result = `⛔ 本次出征已被用户手动停战。已完成 ${done}/${spec.agents.length} 个成员，其余未执行。`;
      send({ type: "agent_done", id: ORCH_ID, result });
      send({
        type: "run_stopped",
        final_id: ORCH_ID,
        reason: "用户手动停战",
        completed_members: harnessMemberRefs(completedHarnessMembers(spec, outputs)),
        missing_members: harnessMemberRefs(missingHarnessMembers(spec, outputs)),
      });
      return;
    }
    pumpIdleChat(); // 即时兜底再 pump 一次（空闲成员消息并发响应）
    // 只处理发给将军/广播的实时插话（成员消息已由并发 pump / 成员自身处理）。
    for (const msg of drainOrchMsgs(runId)) {
      // 不硬编码判读“停/改/继续”——把用户原话原样作为最高优先级指令交给将军，由它自己理解意图决定下一步。
      userHasSteered = true;
      userDirectives.push(formatInjectedDirective(spec, ORCH_ID, msg.text));
      send({ type: "user_msg", id: ORCH_ID, msg_id: msg.msgId, text: msg.text, status: "processed" });
    }
    // 用户已在本次出征中操过盘 = 团队“策略性硬规则”让位于将军对用户意图的判读（见 harnessPlannerSystem 最高原则）。
    const userSteering = userHasSteered;
    // 不再发"第N轮/已完成/可调度"模板摘要——将军思考框只呈现它【真实的流式思考】+ 决策结论，
    // 与成员思考框一致：输出由输入驱动，没有轮次脚手架。
    let decision;
    try {
      decision = provider === "mock"
        ? nextMockHarnessDecision(spec, outputs, callCounts, lastMemberId, { allowPartialFinish, target: continuation?.target })
        : await runHarnessPlannerDecision({
            spec,
            task,
            outputs,
            callCounts,
            history,
            validationError,
            userDirectives,
            teamMemory: ctx.teamMemory,
            continuation,
            producedAt,
            planner,
            send,
            ctx,
          });
    } catch (e) {
      if (runs.get(runId)?.abort) continue; // 停战正好打断了将军决策 → 回顶部按 stopped 收尾，不算失败
      throw e;
    }
    decision = normalizeDecisionAliases(decision); // 容忍模型自创字段名（如 minimax 返回 target_member_id）
    const checked = validateHarnessDecision(spec, decision, outputs, callCounts, { allowPartialFinish, userSteering });
    if (!checked.ok) {
      // 不向思考框发系统文案；错误作为约束在下一轮 harnessPlannerState 里回灌给将军自行修正。
      validationError = `${checked.error}\n模型返回：${JSON.stringify(decision, null, 2)}`;
      if (++invalidStreak >= 5) throw new Error(`将军连续 ${invalidStreak} 次给出无法执行的调度，已停止以避免死循环。\n最后一次原因：\n${validationError}`);
      continue;
    }
    validationError = "";
    // 将军已据当前这批实时指令做出有效决策 → 清空它们，避免下一轮把同一条"加宽/判断下游"再当成"必须立即响应"反复重派（死循环根因）。
    // 新的用户消息会在下一轮 round 顶部重新 drain 进来。userHasSteered 仍粘着，deferToUser 不受影响。
    userDirectives = [];
    // 注意：invalidStreak 只在真正派活(dispatch)后重置（见下方）。ask_user / 反复 finish 不重置，
    // 否则「拒绝 finish → ask_user → 再拒绝」会无限绕过上面的兜底。

    if (checked.action === "ask_user") {
      const answer = await askUser({ ...ctx, currentAgentId: ORCH_ID }, checked.question);
      history.push({ action: "ask_user", question: checked.question, result: answer.content });
      continue;
    }
    if (checked.action === "finish") {
      const result = checked.finalAnswer;
      const finalMember = (spec.agents || []).find((agent) => agent.id === checked.finalMemberId);
      send({ type: "agent_done", id: ORCH_ID, result: result || "(无最终结果)" });
      send({
        type: "run_done",
        final_id: ORCH_ID,
        final_member_id: checked.finalMemberId || "",
        final_member: harnessMemberRef(finalMember),
        completed_members: harnessMemberRefs(completedHarnessMembers(spec, outputs)),
        missing_members: harnessMemberRefs(missingHarnessMembers(spec, outputs)),
      });
      return;
    }

    const calls = checked.action === "dispatch_parallel" ? checked.calls : [checked];
    sendHarnessThinking(send, harnessModelReasoning(checked)); // 呈现将军模型自己写的调度理由（非系统模板）
    const batchId = calls.length > 1 ? `${runId}-b${round + 1}` : "";
    const batchOutputs = { ...outputs };
    const results = await Promise.all(calls.map(async ({ member, upstreamIds, instruction, reason }) => {
      // 该成员正被并发的实时对话占用 → 不重复派，沿用其当前产出
      if (running.has(member.id)) return { member, upstreamIds, instruction, reason, output: outputs[member.id] || "(并发对话进行中)" };
      running.add(member.id);
      const callIndex = (callCounts[member.id] || 0) + 1;
      const memberSend = (event) => send({ ...event, call_index: callIndex });
      send({
        type: "member_call",
        from: ORCH_ID,
        to: member.id,
        call_index: callIndex,
        upstream_ids: upstreamIds,
        instruction,
        reason,
        parallel: calls.length > 1,
        batch_id: batchId || null,
      });
      let output;
      try {
        output = await runAgentCore(
          member,
          buildHarnessMemberInput(task, member, upstreamIds, batchOutputs, instruction, reason, ctx),
          memberSend,
          ctx
        );
      } catch (e) {
        const err = new Error(`成员「${member.name}」执行失败：${e.message}`);
        err.agentId = member.id;
        throw err;
      } finally {
        running.delete(member.id);
      }
      return { member, upstreamIds, instruction, reason, output: output || "(无输出)" };
    }));

    for (const result of results) {
      outputs[result.member.id] = result.output;
      callCounts[result.member.id] = (callCounts[result.member.id] || 0) + 1;
      producedAt[result.member.id] = ++produceSeq; // 记录该成员最新产出序号
      history.push({
        action: calls.length > 1 ? "dispatch_parallel" : "dispatch",
        batch_id: batchId || undefined,
        member_id: result.member.id,
        upstream_ids: result.upstreamIds,
        instruction: result.instruction,
        reason: result.reason,
        result: result.output,
      });
    }
    lastMemberId = results[results.length - 1]?.member.id || lastMemberId;
    invalidStreak = 0; // 真正派活=有进展，重置无效调度计数
  }
  throw new Error(`将军超过最多 ${HARNESS_MAX_ROUNDS} 轮仍未结束。`);
  } finally {
    pumpStop = true;
    pumpIdleChat(); // 收尾前再 pump 一次，捡漏最后一刻到的成员消息
    if (liveTasks.size) await Promise.allSettled([...liveTasks]); // 等并发的实时对话跑完再结束
  }
}

// ---------- 演示模式假数据 ----------

function mockTeam(description) {
  return {
    team_name: "演示小队",
    emoji: "🎭",
    summary: `这是演示模式（未调用 API）。针对「${description.slice(0, 30)}…」组建了一支三人小队：调研员先收集素材，写手据此成稿，主编最后整合定稿。`,
    agents: [
      { id: "researcher", name: "斥候校尉", emoji: "🔍", role: "调研员：收集任务相关的关键信息", persona: "好奇心重，凡事先查三遍。", system_prompt: "你是资深调研员斥候校尉……（演示模式占位提示词）", depends_on: [] },
      { id: "writer", name: "文书参军", emoji: "✍️", role: "写手：把调研结果写成初稿", persona: "下笔快，结构感强。", system_prompt: "你是写手文书参军……（演示模式占位提示词）", depends_on: ["researcher"] },
      { id: "editor", name: "中军主簿", emoji: "🧐", role: "主编：整合所有产出，输出最终交付物", persona: "挑剔但讲道理。", system_prompt: "你是主编中军主簿……（演示模式占位提示词）", depends_on: ["writer"] },
    ],
  };
}

function mockAgentRun(agent, send, userContent = "") {
  const think = `（演示·思考）先看一下任务要求……\n我负责的是「${agent.role}」。\n打算这样推进：第一步梳理输入，第二步产出结果，第三步交接。\n（真实模式下这里是模型的实时思考流）`;
  const needsConfirmation = /(?:需要|等待|必须).{0,16}(?:用户)?确认/.test(`${agent.role}\n${agent.system_prompt || ""}`);
  const resumed = /# 人工确认已返回/.test(userContent);
  const text = resumed
    ? `（演示输出·确认后续）已收到用户确认。${agent.name}从确认点继续执行，完成剩余交付。`
    : `（演示输出）我是${agent.name}，正在执行：${agent.role}。\n\n这里是流式输出的演示文本，真实模式下会是 Claude 的实际产出。\n- 要点一\n- 要点二\n- 要点三\n\n${needsConfirmation ? "需要用户确认：请确认以上内容，确认后我再继续后续步骤。" : "完毕，交给下一位同事。"}`;
  return new Promise((resolve) => {
    let ti = 0;
    const tt = setInterval(() => {
      const c = think.slice(ti, ti + 8); ti += 8;
      if (c) send({ type: "agent_thinking", id: agent.id, text: c });
      if (ti >= think.length) {
        clearInterval(tt);
        let i = 0;
        const timer = setInterval(() => {
          const chunk = text.slice(i, i + 6); i += 6;
          if (chunk) send({ type: "agent_delta", id: agent.id, text: chunk });
          if (i >= text.length) { clearInterval(timer); resolve(text); }
        }, 30);
      }
    }, 25);
  });
}

// ---------- HTTP 服务 ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

// ---------- 团队持久化 ----------

const TEAMS_DIR = path.join(__dirname, "teams");
if (!fs.existsSync(TEAMS_DIR)) fs.mkdirSync(TEAMS_DIR);
const RUNS_DIR = path.join(__dirname, "runs");
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR);
const MEMORIES_DIR = path.join(__dirname, "memory");
if (!fs.existsSync(MEMORIES_DIR)) fs.mkdirSync(MEMORIES_DIR);

function safeMemoryId(specOrId) {
  if (typeof specOrId === "string") {
    const safe = specOrId.replace(/[^a-z0-9-]/g, "");
    return safe || "team-" + crypto.createHash("sha1").update(specOrId).digest("hex").slice(0, 10);
  }
  const spec = specOrId || {};
  const raw = spec.id || `${spec.team_name || "team"}:${spec.global_skill || ""}`;
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

// ---------- 运行记录 / 运行中并发 store（出征与请求解耦：可断开/重连，多团队同时跑）----------
const runs = new Map(); // runId -> { runId, teamId, teamName, emoji, task, startedAt, endedAt, status, spec, events:[], subscribers:Set }
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
function startRun(spec, task, opts = {}) {
  const runId = opts.runId || `${spec.id || "team"}-${Date.now().toString(36)}`;
  // 只有「历史再出征」(显式传 memorySnapshot) 和「连续对话」(continuation) 才读记忆；全新出征不读。
  const memorySnapshot = opts.memorySnapshot || (opts.continuation ? readTeamMemory(spec) : null);
  const old = opts.runId ? getRunRecord(opts.runId) : null;
  const rec = {
    runId, teamId: spec.id || "", teamName: spec.team_name || "无名战队", emoji: spec.emoji || "⚔",
    task, title: opts.title || old?.title || "", startedAt: Date.now(), endedAt: null, status: "running",
    sourceRunId: opts.sourceRunId || "", memorySnapshot,
    continuation: opts.continuation || null,
    spec, events: Array.isArray(opts.resumeEvents) ? [...opts.resumeEvents] : [], subscribers: new Set(),
    aborters: new Set(), // 正在执行的模型调用/工具的 AbortController：用户一发消息就中断它们，立即响应
    liveFrom: Array.isArray(opts.resumeEvents) ? opts.resumeEvents.length : 0, // 续聊增量起点：?live=1 只回放这之后的新事件
  };
  runs.set(runId, rec);
  if (Array.isArray(opts.initialInjections) && opts.initialInjections.length) {
    rec.initialMsgIds = opts.initialInjections.map((item) => enqueueInject(runId, item.target || ORCH_ID, item.text || ""));
  }
  persistRun(rec);
  (async () => {
    try { await runTeam(spec, task, (ev) => runBroadcast(rec, ev), runId, { memorySnapshot, continuation: rec.continuation, resumeOutputs: opts.resumeOutputs, resumeCallCounts: opts.resumeCallCounts }); }
    catch (e) {
      const ev = {
        type: "error",
        message: e.message,
        completed_members: runCompletedMemberRefs(rec),
        missing_members: harnessMemberRefs(runMissingMembersFromEvents(rec)),
      };
      if (e.agentId) ev.id = e.agentId;
      runBroadcast(rec, ev);
    }
    finally {
      if (rec.status === "running") {
        runBroadcast(rec, {
          type: "error",
          message: "运行结束但团队未完成所有步骤，已按失败记录。",
          completed_members: runCompletedMemberRefs(rec),
          missing_members: harnessMemberRefs(runMissingMembersFromEvents(rec)),
        });
      }
      updateTeamMemoryFromRunRecord(rec);
      runInbox.delete(runId);
      persistRunNow(rec);
    }
  })();
  return rec;
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

// 对话中让团队自我进化：改成员契约 / 新建成员 / 改团队目标 / 追加全局补充规则；
// 改完重建全局 Skill（自动反映成员契约 + 演进记录），标记 evolved，并持久化到保存的团队。
function applyTeamEvolution(spec, { by, member_edits, new_members, summary, note } = {}) {
  if (!spec || !Array.isArray(spec.agents)) return { changes: [], saved: null };
  const changes = [];
  for (const e of member_edits || []) {
    const a = spec.agents.find((x) => x.id === e.member_id || x.name === e.member_id);
    if (!a) continue;
    if (typeof e.system_prompt === "string" && e.system_prompt.trim()) { a.system_prompt = e.system_prompt.trim(); changes.push(`改写成员「${a.name}」的执行契约`); }
    if (typeof e.role === "string" && e.role.trim()) a.role = e.role.trim();
    if (Array.isArray(e.tools)) a.tools = e.tools.filter((t) => TOOL_REGISTRY[t]);
    if (Array.isArray(e.depends_on)) a.depends_on = e.depends_on;
  }
  for (const m of new_members || []) {
    if (!m || !m.name) continue;
    let id = String(m.id || m.name).toLowerCase().replace(/[^a-z0-9_-]/g, "") || ("m" + Date.now().toString(36));
    while (spec.agents.some((x) => x.id === id)) id += "-2";
    spec.agents.push({
      id, name: m.name, emoji: m.emoji || "🤖", role: m.role || "", persona: m.persona || "",
      system_prompt: m.system_prompt || "", tools: Array.isArray(m.tools) ? m.tools.filter((t) => TOOL_REGISTRY[t]) : [],
      depends_on: Array.isArray(m.depends_on) ? m.depends_on.filter((d) => spec.agents.some((x) => x.id === d)) : [], model: m.model || "",
    });
    changes.push(`新建成员「${m.name}」`);
  }
  if (typeof summary === "string" && summary.trim()) { spec.summary = summary.trim(); changes.push("更新团队目标"); }
  if (typeof note === "string" && note.trim()) {
    spec.evolution_log = [...(spec.evolution_log || []), { at: new Date().toISOString().slice(0, 16).replace("T", " "), by: by || "", note: note.trim() }].slice(-30);
    changes.push("追加全局 Skill 演进规则");
  }
  if (!changes.length) return { changes: [], saved: null };
  ensureMemberToolGrants(spec);
  spec.global_skill = buildTeamGlobalSkill(spec); // 重建：自动反映成员契约 + 演进记录
  spec.evolved = true;
  let saved = null;
  try { if (spec.id && /^[a-z0-9-]+$/.test(spec.id)) saved = saveTeam(spec); } catch {}
  return { changes, saved };
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".ogg": "audio/ogg", ".pdf": "application/pdf", ".json": "application/json", ".md": "text/markdown",
  ".txt": "text/plain",
};

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method === "POST" && req.url === "/api/design") {
      const { description, model, skills } = await readBody(req);
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      try {
        let spec;
        if (Array.isArray(skills) && skills.length) {
          spec = await designFromSkills(skills, (description || "").trim(), model || "", send);
        } else {
          if (!description?.trim()) throw new Error("请先描述你想要的团队。");
          spec = await designTeam(description.trim(), model || "", send);
        }
        if (model) spec.main_model = model; // 新团队的默认模型 = 军师模型（成员留默认即继承）
        const origin = buildTeamOrigin((description || "").trim(), Array.isArray(skills) ? skills : []);
        if (origin) spec.origin = origin;
        send({ type: "design_done", spec });
      } catch (e) {
        send({ type: "error", message: e.message });
      }
      res.end();
      return;
    }

    // 勘察：一句话 → 作战蓝图（先想清楚再组队）
    if (req.method === "POST" && req.url === "/api/blueprint") {
      const { description, model } = await readBody(req);
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      try {
        if (!description?.trim()) throw new Error("请先描述你想要的目标。");
        const blueprint = await designBlueprint(description.trim(), model || "", send);
        send({ type: "blueprint_done", blueprint });
      } catch (e) {
        send({ type: "error", message: e.message });
      }
      res.end();
      return;
    }

    // 点兵：用户确认蓝图 → 组建执行团队
    if (req.method === "POST" && req.url === "/api/staff") {
      const { blueprint, description, model } = await readBody(req);
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      try {
        if (!blueprint || typeof blueprint !== "object") throw new Error("缺少已确认的作战蓝图。");
        const spec = await staffTeam(blueprint, (description || "").trim(), model || "", send);
        if (model) spec.main_model = model;
        const origin = buildTeamOrigin((description || "").trim(), []);
        if (origin) spec.origin = origin;
        send({ type: "design_done", spec });
      } catch (e) {
        send({ type: "error", message: e.message });
      }
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/api/answer") {
      const { qid, answer } = await readBody(req);
      const resolve = pendingAnswers.get(qid);
      if (resolve) { pendingAnswers.delete(qid); resolve(answer); }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: !!resolve }));
      return;
    }

    // 运行中给将军/成员插话：消息入队，agent 在下一轮思考时取出带进 prompt 并回执
    if (req.method === "POST" && req.url === "/api/inject") {
      const { runId, agentId, text, spec: bodySpec } = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      if (!runId || !text?.trim()) { res.end(JSON.stringify({ ok: false, error: "缺少 runId 或内容" })); return; }
      const active = runs.get(runId);
      if (active && active.status === "running") {
        const target = normalizeConversationTarget(active.spec, agentId);
        const msgId = enqueueInject(runId, target, text.trim());
        // 普通消息【不打断】任何正在跑的活：发给将军/运行中成员的，等它们各自到边界自然处理；
        // 发给【空闲/已完成】成员的，由并发 pump 立刻把它单独叫起来回应（唯一的"立即"路径）。停战才硬中断。
        res.end(JSON.stringify({ ok: true, msg_id: msgId, run_id: runId }));
        return;
      }
      const old = getRunRecord(runId);
      if (!old || !old.spec) {
        res.end(JSON.stringify({ ok: false, error: "运行记录不存在，无法继续对话" }));
        return;
      }
      const spec = bodySpec && typeof bodySpec === "object" ? normalizeSpec(bodySpec) : normalizeSpec(old.spec);
      const content = text.trim();
      const target = normalizeConversationTarget(spec, agentId);
      const continuation = { sourceRunId: old.runId, target, text: content };
      const task = buildContinuationTask(old, spec, target, content);
      const memorySnapshot = memorySnapshotForContinuation(old, spec);
      // 续聊要带上「上一次已完成成员的产出」：① 将军能看到各成员现有结果；② 调度下游时把上游产出作为输入交给它。
      const priorOutputs = runAgentOutputsFromEvents(old);
      const priorCallCounts = {};
      for (const id of Object.keys(priorOutputs)) priorCallCounts[id] = 1;
      const rec = startRun(spec, task, {
        runId: old.runId,
        title: old.title || "",
        sourceRunId: old.sourceRunId || "",
        memorySnapshot,
        continuation,
        // 保留上一次的成员产出事件（前端可见、记录连续），但去掉运行级终止事件，避免续聊时 UI 误判"已结束"。
        resumeEvents: (old.events || []).filter((e) => e.type !== "run_done" && e.type !== "error" && !(e.type === "agent_done" && e.id === ORCH_ID)),
        resumeOutputs: priorOutputs,          // 预置上一次成员产出 → 将军可见、下游可取用
        resumeCallCounts: priorCallCounts,
        initialInjections: [{ target, text: content }],
      });
      res.end(JSON.stringify({
        ok: true,
        msg_id: rec.initialMsgIds?.[0] || "",
        run_id: rec.runId,
        continued_run_id: rec.runId,
        source_run_id: old.runId,
      }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/edit-member") {
      const { agent, instruction, team_main_model } = await readBody(req);
      if (!agent || !instruction?.trim()) throw new Error("缺少成员或修改要求。");
      const { fields, model } = await editAgentViaChat(agent, instruction.trim(), team_main_model || "");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, fields, model }));
      return;
    }

    // 出征：创建一次独立运行（与本请求解耦），立即返回 runId；前端再 attach 到事件流。
    if (req.method === "POST" && req.url === "/api/run") {
      const body = await readBody(req);
      const spec = normalizeSpec(body.spec); // 二次兜底：前端编辑/导入过的配置也整形一遍
      const task = body.task;
      if (!task?.trim()) throw new Error("缺少任务描述。");
      const dialogText = String(body.dialog_text || "").trim();
      const dialogTarget = normalizeConversationTarget(spec, body.dialog_agent_id);
      const opts = dialogText
        ? {
            continuation: { sourceRunId: "", target: dialogTarget, text: dialogText },
            initialInjections: [{ target: dialogTarget, text: dialogText }],
          }
        : {};
      const rec = startRun(spec, task.trim(), opts);
      return json(200, { ok: true, run_id: rec.runId, msg_id: rec.initialMsgIds?.[0] || "" });
    }

    // 列出全部运行（运行中 + 历史），前端左侧边栏用
    if (req.method === "GET" && req.url === "/api/runs") {
      return json(200, listRuns());
    }

    if (req.method === "GET" && req.url === "/api/battle-reports") {
      return json(200, listRuns().map(battleReportSummary));
    }

    // attach 到某次运行的事件流：先回放已有事件，运行中则继续推送实时事件（断开不影响运行）
    const streamMatch = req.method === "GET" && req.url.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/stream(?:\?(.*))?$/);
    if (streamMatch) {
      const rec = runs.get(streamMatch[1]);
      const disk = !rec ? getRunRecord(streamMatch[1]) : null;
      if (!rec && !disk) { res.writeHead(404); res.end("run not found"); return; }
      // live=1：续聊增量模式——只回放【本次续聊新产生】的事件（从 rec.liveFrom 起），不重放整段历史。
      const liveOnly = /(^|&)live=1(&|$)/.test(streamMatch[2] || "");
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const events = rec ? rec.events : (disk.events || []);
      const start = (liveOnly && rec) ? (rec.liveFrom || 0) : 0;
      for (const ev of events.slice(start)) send(ev);  // 回放（live 模式只回放续聊段）
      send({ type: "replay_done" });                 // 历史回放结束标记：之后才是实时事件（前端据此区分"瞬显历史"与"打字机实时"）
      if (rec && rec.status === "running") {          // 运行中 → 订阅实时
        rec.subscribers.add(send);
        req.on("close", () => rec.subscribers.delete(send));
      } else {
        res.end();                                    // 已结束/历史 → 回放完即结束
      }
      return;
    }

    // 停战：硬终止正在进行的出征
    const stopMatch = req.method === "POST" && req.url.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/stop$/);
    if (stopMatch) {
      const rec = runs.get(stopMatch[1]);
      if (!rec || rec.status !== "running") return json(409, { error: "该运行不在进行中（可能已结束）" });
      rec.abort = true;
      rec.aborters?.forEach((o) => { try { o.ac.abort(); } catch {} }); // 立即打断正在执行的模型/shell
      // 关键：若将军/成员正卡在 ask_user 等你回答，await 永不返回 → 停战也卡住。这里把本次运行所有待回答的 ask 直接放行，
      // 让被阻塞的 await 解开 → 循环回到顶部命中 abort → 干净收尾为 stopped。
      for (const [qid, resolve] of pendingAnswers) {
        if (qid.startsWith(rec.runId + "-q")) { pendingAnswers.delete(qid); try { resolve("[用户已停战，终止本次出征]"); } catch {} }
      }
      runBroadcast(rec, { type: "agent_thinking", id: ORCH_ID, text: "\n⛔ 收到停战指令，正在终止本次出征…\n" });
      return json(200, { ok: true, run_id: rec.runId });
    }

    // 取某次运行的完整记录（含 spec + 事件），历史回放用
    const rerunMatch = req.method === "POST" && req.url.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/rerun$/);
    if (rerunMatch) {
      const old = getRunRecord(rerunMatch[1]);
      if (!old || !old.spec) return json(404, { error: "运行记录不存在或不完整" });
      const active = runs.get(old.runId);
      if (active && active.status === "running") return json(409, { error: "这条记录正在运行中" });
      const body = await readBody(req).catch(() => ({}));
      const task = String(body.task || old.task || "").trim();
      if (!task) return json(400, { error: "缺少可重跑的任务描述" });
      // 历史再出征：优先用前端当前历史页 spec（含临时切过的模型/结构），
      // 其次用「当前团队的最新设置」，团队已删或旧记录未绑定团队则回退旧记录 spec。
      const spec = body.spec && typeof body.spec === "object"
        ? normalizeSpec(body.spec)
        : ((old.teamId && readTeamSpecById(old.teamId)) || normalizeSpec(old.spec));
      const memorySnapshot = old.memorySnapshot || readTeamMemory(spec);
      const rec = startRun(spec, task, { runId: old.runId, title: old.title || "", sourceRunId: old.sourceRunId || "", memorySnapshot });
      return json(200, { ok: true, run_id: rec.runId, updated_run_id: old.runId });
    }

    const patchRunMatch = req.method === "PATCH" && req.url.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)$/);
    if (patchRunMatch) {
      const rec = getRunRecord(patchRunMatch[1]);
      if (!rec) return json(404, { error: "运行记录不存在" });
      const body = await readBody(req).catch(() => ({}));
      const title = String(body.title || "").trim().slice(0, 80);
      rec.title = title;
      const active = runs.get(rec.runId);
      if (active) active.title = title;
      persistRunNow(active || rec);
      return json(200, { ok: true, run_id: rec.runId, title });
    }

    const reportMatch = req.method === "GET" && req.url.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/report$/);
    if (reportMatch) {
      const rec = getRunRecord(reportMatch[1]);
      if (!rec) return json(404, { error: "运行记录不存在" });
      return json(200, buildBattleReport(rec));
    }

    const recMatch = req.method === "GET" && req.url.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)$/);
    if (recMatch) {
      const rec = getRunRecord(recMatch[1]);
      if (!rec) { res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "运行记录不存在" })); return; }
      return json(200, {
        run_id: rec.runId, team_id: rec.teamId, team_name: rec.teamName, emoji: rec.emoji,
        task: rec.task, title: rec.title || "", started_at: rec.startedAt, ended_at: rec.endedAt, status: rec.status,
        source_run_id: rec.sourceRunId || "", memory_snapshot: rec.memorySnapshot || null,
        continuation: rec.continuation || null,
        spec: rec.spec, events: rec.events || [],
        battle_report: buildBattleReport(rec),
      });
    }

    if (req.method === "GET" && req.url === "/api/meta") {
      // 混合架构下"能不能真执行"取决于能否走 Anthropic：系统默认是 anthropic，或备好了 client（agent 可单独指定 claude 模型）
      const anthropicAvailable = !!anthropicClient || provider === "anthropic";
      const ccEnabled = claudeCliAvailable && ENABLE_CLAUDE_CODE; // 仅在配置中心启用后才算"已配置"
      const codexEnabled = codexCliAvailable && codexCliLoggedIn && ENABLE_CODEX_CLI;
      const models = currentModelRegistry();
      const defaultEntry = systemDefaultModelEntry(provider);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        tools_enabled: (ALLOW_TOOLS && anthropicAvailable) || ccEnabled || codexEnabled,
        provider,
        default_model: defaultEntry.id,
        default_model_label: defaultEntry.label,
        default_model_provider: defaultEntry.provider,
        anthropic_available: anthropicAvailable,
        claude_cli: ccEnabled,
        codex_cli: codexCliAvailable,
        codex_login: codexCliLoggedIn,
        codex_enabled: codexEnabled,
        models,
        model_suggestions: models.map((entry) => entry.id),
        tools: REAL_TOOL_NAMES.map((n) => ({ name: n, label: TOOL_REGISTRY[n].label, hint: TOOL_REGISTRY[n].hint })),
      }));
      return;
    }

    if (req.method === "GET" && req.url === "/api/config") {
      const bag = (() => { const c = readConfigFile(); return c.env && typeof c.env === "object" ? c.env : c; })();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        groups: CONFIG_GROUPS,
        values: Object.fromEntries(CONFIG_KEYS.map((k) => [k, bag[k] != null ? String(bag[k]) : ""])),
        config_path: CONFIG_PATH,
        claude_cli: claudeCliAvailable,
        codex_cli: codexCliAvailable,
        codex_login: codexCliLoggedIn,
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/config") {
      const body = await readBody(req);
      await saveAndApplyConfig(body.config || body || {});
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      const cliToolsEnabled =
        (claudeCliAvailable && ENABLE_CLAUDE_CODE) ||
        (codexCliAvailable && codexCliLoggedIn && ENABLE_CODEX_CLI);
      const defaultEntry = systemDefaultModelEntry(provider);
      res.end(JSON.stringify({ ok: true, provider, default_model: defaultEntry.id, default_model_label: defaultEntry.label,
        anthropic_available: !!anthropicClient, tools_enabled: (ALLOW_TOOLS && !!anthropicClient) || cliToolsEnabled }));
      return;
    }

    // 团队增删查改
    const tm = req.url.match(/^\/api\/teams(?:\/([a-z0-9-]+))?$/);
    if (tm) {
      if (req.method === "GET" && !tm[1]) return json(200, listTeams());
      if (req.method === "GET" && tm[1]) {
        const p = teamPath(tm[1]);
        if (!fs.existsSync(p)) return json(404, { error: "团队不存在" });
        const saved = JSON.parse(fs.readFileSync(p, "utf8"));
        return json(200, {
          ...normalizeSpec(saved),
          id: saved.id || tm[1],
          updated_at: saved.updated_at || null,
        });
      }
      if (req.method === "POST" && !tm[1]) {
        const body = await readBody(req);
        return json(200, saveTeam(body.spec || body));
      }
      if (req.method === "DELETE" && tm[1]) {
        const p = teamPath(tm[1]);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return json(200, { ok: true });
      }
      return json(405, { error: "不支持的方法" });
    }

    // 运行产物：供成员最终结果里的 Markdown 图片 / 音视频链接直接预览。
    const artifact = req.method === "GET" && req.url.match(/^\/runs\/([a-zA-Z0-9-]+)\/(.+?)(?:\?.*)?$/);
    if (artifact) {
      const root = path.resolve(RUNS_DIR, artifact[1]);
      let rel;
      try { rel = decodeURIComponent(artifact[2]); }
      catch { res.writeHead(400); res.end("Bad path"); return; }
      const fp = path.resolve(root, rel);
      if (!fp.startsWith(root + path.sep) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
        res.writeHead(404); res.end("Not Found"); return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(fp).pipe(res);
      return;
    }

    // 静态文件
    let file = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const fp = path.join(__dirname, "public", path.normalize(file));
    if (!fp.startsWith(path.join(__dirname, "public")) || !fs.existsSync(fp)) {
      res.writeHead(404); res.end("Not Found"); return;
    }
    res.writeHead(200, {
      "Content-Type": (MIME[path.extname(fp)] || "application/octet-stream") + "; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(fs.readFileSync(fp));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// 服务器重启后，把"上次还在跑、被中断"的出征自动续上：预置已完成成员的产出，不重跑，
// 由将军接着把剩下没完成的成员推完。faithfully 保留原 runId / 事件 / 记忆模式。
const RESUME_MAX_AGE_MS = Number(process.env.RESUME_MAX_AGE_MS || 2 * 3600 * 1000); // 只续上最近 2 小时内被中断的出征
function resumeInterruptedRuns() {
  if (provider === "mock") return;
  let names;
  try { names = fs.readdirSync(RUNS_DIR); } catch { return; }
  let resumed = 0;
  for (const name of names) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, name, "record.json"), "utf8")); } catch { continue; }
    if (!rec || rec.status !== "running" || !rec.spec || !Array.isArray(rec.spec.agents) || runs.has(rec.runId)) continue;
    const outputs = runAgentOutputsFromEvents(rec);
    const done = Object.keys(outputs).length;
    const total = rec.spec.agents.length;
    if (done >= total) { // 其实已全部完成，只是没来得及收尾——标记完成，不重跑
      rec.status = "done"; rec.endedAt = rec.endedAt || Date.now();
      try { persistRun(rec); } catch {}
      continue;
    }
    if (Date.now() - (rec.startedAt || 0) > RESUME_MAX_AGE_MS) { // 太久远的中断不自动续，标记为中断
      rec.status = "interrupted"; rec.endedAt = rec.endedAt || Date.now();
      try { persistRun(rec); } catch {}
      console.log(`  ⏭ 跳过过旧的中断出征 ${rec.runId}（${rec.teamName}），标记为 interrupted。`);
      continue;
    }
    const callCounts = {};
    for (const id of Object.keys(outputs)) callCounts[id] = 1;
    try {
      console.log(`  ↻ 续上中断的出征 ${rec.runId}（${rec.teamName}）：已完成 ${done}/${total}，继续剩余成员…`);
      startRun(rec.spec, rec.task, {
        runId: rec.runId,
        title: rec.title || "",
        sourceRunId: rec.sourceRunId || "",
        continuation: rec.continuation || null,
        memorySnapshot: rec.memorySnapshot || null,
        resumeEvents: rec.events || [],
        resumeOutputs: outputs,
        resumeCallCounts: callCounts,
      });
      resumed++;
    } catch (e) { console.log(`  ✗ 续上 ${rec.runId} 失败：${e.message}`); }
  }
  if (resumed) console.log(`  ↻ 已自动续上 ${resumed} 个被中断的出征。`);
}

if (require.main === module) {
  initProvider().then(() => {
    const tag =
      provider === "mock" ? "演示模式" :
      provider === "ollama" ? `Ollama · ${OLLAMA_MODEL}` :
      provider === "codex-cli" ? `Codex · ${CODEX_MODEL || "CLI 默认模型"}` :
      `Claude · ${ANTHROPIC_MODEL}`;
    server.listen(PORT, () => {
      console.log(`\n  ⚔️  点将台已就绪 → http://localhost:${PORT}  (${tag})\n`);
      resumeInterruptedRuns(); // 续上服务器重启前还在跑的团队
    });
  });
}

module.exports = {
  TOOL_REGISTRY, normalizeSpec, topoWaves, buildAgentInput,
  normalizeSkillSources, skillSourcesDigest, extractSkillModules, formatSkillModuleOutline,
  harnessCandidates, validateHarnessDecision, nextMockHarnessDecision,
  buildHarnessMemberInput, harnessDecisionSchema, harnessDecisionTool, HARNESS_DECISION_TOOL, buildTeamGlobalSkill,
  harnessRoundThinking, harnessDecisionThinking,
  injectTeamConventions, staleDownstreamMembers, orchestratorUserInputsFromEvents, mergeConversations, messagesChars, extractArtifactPaths,
  grantedRealTools, ensureMemberToolGrants, memberNeedsShell, requiredBinariesFor,
  applyTeamEvolution,
  detectConfirmationRequest, normalizeBlueprint, mockBlueprint, staffTeam,
  providerForModel, resolveModelSelection, stableModelId, codexModelArg, ollamaModelArg, codexEventData,
  detectWritePermissionRequest, isAffirmativeAnswer, applyConfigEnv,
  modelSupportsManagedTools, detectPseudoToolCallArtifacts, stripPseudoToolCallArtifacts,
  looksLikeCodexProcessText, normalizeUsage, buildBattleReport,
};
