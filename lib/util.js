// 通用小工具。纯函数，无依赖。

const MAX_TOOL_OUTPUT = 24000; // 回灌给模型的输出上限（字符）

// 截断超长字符串并标注原长度
function clip(s, n = MAX_TOOL_OUTPUT) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + `\n…[输出过长，已截断，共 ${s.length} 字符]` : s;
}

// ---------- token 用量归一/累加（纯函数，给运行存储与 harness 共用）----------
function finiteTokenNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const baseInput = finiteTokenNumber(
    raw.input_tokens ?? raw.prompt_tokens ?? raw.promptTokens ?? raw.prompt_eval_count ?? raw.promptEvalCount
  );
  // Anthropic 提示词缓存命中/写入的输入单列在这两个字段，不计进 input_tokens；
  // 并进来才是真实处理的输入量（关掉缓存时两项为 0/缺省，结果不变）。
  const cacheRead = finiteTokenNumber(raw.cache_read_input_tokens ?? raw.cacheReadInputTokens);
  const cacheCreate = finiteTokenNumber(raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens);
  const input = (baseInput != null || cacheRead != null || cacheCreate != null)
    ? (baseInput || 0) + (cacheRead || 0) + (cacheCreate || 0)
    : null;
  const output = finiteTokenNumber(
    raw.output_tokens ?? raw.completion_tokens ?? raw.completionTokens ?? raw.eval_count ?? raw.evalCount
  );
  const totalRaw = finiteTokenNumber(raw.total_tokens ?? raw.totalTokens ?? raw.total);
  const total = totalRaw != null ? totalRaw : (input != null || output != null ? (input || 0) + (output || 0) : null);
  if (input == null && output == null && total == null) return null;
  return { input_tokens: input, output_tokens: output, total_tokens: total };
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

module.exports = { clip, MAX_TOOL_OUTPUT, finiteTokenNumber, normalizeUsage, addUsageTotals };
