// Analysis for ctxdiet: attribute tool output to classes, find the calls that
// dominate the context window, and say what to bound next time.
//
// Every number here is an upper bound measured on one input: the transcript.
// No model is called, no price table is applied, nothing is uploaded.

export const DEFAULT_THRESHOLD = 8000; // chars, roughly 2k tokens at chars/4

export const CLASSES = [
  {
    id: "duplicate",
    title: "重复输出",
    advice: "同一份输出不要第二次整段取回：记住结论，或写进文件再引用。",
  },
  {
    id: "file-dump",
    title: "整文件读取",
    advice: "先 grep -n 定位符号，再用 offset/limit 读 ±40 行；不要整读大文件。",
  },
  {
    id: "log-dump",
    title: "日志整段",
    advice: "只取尾部 40 行或换 --reporter=dot；把汇总数字带回，不要贴全文。",
  },
  {
    id: "cat-dump",
    title: "cat/Get-Content 整文件",
    advice: "命令里就限制输出：head/tail/Select-Object -First，或直接 grep。",
  },
  {
    id: "tree-dump",
    title: "目录全量列举",
    advice: "限制深度，排除 node_modules / dist / .git 后再列。",
  },
  {
    id: "json-dump",
    title: "大 JSON 原文",
    advice: "用 jq 只取需要的字段，不要 cat 整份 JSON。",
  },
  {
    id: "command-dump",
    title: "大段命令输出",
    advice: "在命令侧截断，或先要汇总数字，再决定看哪一段。",
  },
];

const CLASS_BY_ID = new Map(CLASSES.map((item) => [item.id, item]));

const TREE_COMMAND = /\b(ls|dir|tree|find|git\s+ls-files|git\s+status)\b/i;
const CAT_COMMAND = /\b(cat|type|get-content|gc|bat|more|less)\b/i;
const LOG_HINT = /\b(FAIL|FAILED|failed|passing|passes|tests?|error|warning|build|compile)\b/i;

/** Cost of one event in characters, as it lands in the context window. */
export function outputChars(event) {
  return String(event?.resultText ?? "").length;
}

export function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

/**
 * Classify one event. Returns null when the call is small or already bounded.
 * @param {object} event
 * @param {number} threshold
 */
export function classify(event, threshold = DEFAULT_THRESHOLD) {
  const chars = outputChars(event);
  if (chars === 0 || chars < threshold) return null;
  if (event.bounded) return null;

  if (event.kind === "read") return "file-dump";

  if (event.kind === "command") {
    const text = String(event.command ?? "");
    const lines = String(event.resultText).split("\n").length;
    if (TREE_COMMAND.test(text) && /(-r\b|-R\b|\/s\b|--recursive|node_modules)/.test(text)) return "tree-dump";
    if (CAT_COMMAND.test(text) && !/[|><;]|&&/.test(text)) return "cat-dump";
    const trimmed = String(event.resultText).trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      return "json-dump";
    }
    if (lines >= 300 || (lines >= 80 && LOG_HINT.test(event.resultText))) return "log-dump";
    return "command-dump";
  }

  return "command-dump";
}

function targetOf(event) {
  if (event.path) return String(event.path).replace(/\\/g, "/");
  if (event.command) {
    const text = String(event.command).replace(/\s+/g, " ").trim();
    return text.length > 72 ? `${text.slice(0, 71)}…` : text;
  }
  return event.tool || "(unknown)";
}

function brief(event) {
  if (event.path) return String(event.path).replace(/\\/g, "/");
  if (event.command) return String(event.command).replace(/\s+/g, " ").trim();
  return String(event.tool ?? "");
}

/**
 * @param {ReturnType<import("./parse.mjs").parseTranscript>} parsed
 * @param {{ threshold?: number, top?: number }} [options]
 */
export function analyzeSession(parsed, { threshold = DEFAULT_THRESHOLD, top = 8 } = {}) {
  const events = parsed.events;
  const seen = new Map();
  const fat = [];

  for (const event of events) {
    const chars = outputChars(event);
    if (chars === 0) continue;
    const hash = event.resultHash;
    const key = hash ? `${hash}:${chars}` : null;
    const duplicate = Boolean(key) && seen.has(key) && chars >= threshold;
    const firstLine = key ? seen.get(key) : undefined;
    if (key && !seen.has(key)) seen.set(key, event.line);

    const klass = duplicate ? "duplicate" : classify(event, threshold);
    if (!klass) continue;
    fat.push({
      line: event.line,
      tool: event.tool,
      kind: event.kind,
      klass,
      chars,
      tokens: estimateTokens(chars),
      target: targetOf(event),
      brief: brief(event),
      duplicateOf: duplicate ? firstLine : null,
    });
  }

  const totalChars = events.reduce((sum, event) => sum + outputChars(event), 0);
  const fatChars = fat.reduce((sum, item) => sum + item.chars, 0);
  const fatCalls = fat.length;

  const classes = CLASSES.map((meta) => {
    const items = fat.filter((item) => item.klass === meta.id);
    const chars = items.reduce((sum, item) => sum + item.chars, 0);
    return {
      id: meta.id,
      title: meta.title,
      advice: meta.advice,
      calls: items.length,
      chars,
      share: totalChars === 0 ? 0 : chars / totalChars,
    };
  })
    .filter((item) => item.calls > 0)
    .sort((a, b) => b.chars - a.chars);

  const repeats = [];
  const byTarget = new Map();
  for (const item of fat) {
    const key = `${item.klass}|${item.target}`;
    if (!byTarget.has(key)) byTarget.set(key, { target: item.target, klass: item.klass, calls: 0, chars: 0, lines: [] });
    const group = byTarget.get(key);
    group.calls += 1;
    group.chars += item.chars;
    group.lines.push(item.line);
  }
  for (const group of byTarget.values()) {
    if (group.calls >= 2) repeats.push(group);
  }
  repeats.sort((a, b) => b.chars - a.chars);

  return {
    file: parsed.file,
    format: parsed.format,
    compacted: parsed.epoch,
    calls: events.length,
    totalChars,
    totalTokens: estimateTokens(totalChars),
    fatCalls,
    fatChars,
    fatShare: totalChars === 0 ? 0 : fatChars / totalChars,
    avoidableChars: fatChars,
    avoidableTokens: estimateTokens(fatChars),
    classes,
    top: [...fat].sort((a, b) => b.chars - a.chars).slice(0, top),
    repeats: repeats.slice(0, top),
    warnings: parsed.warnings,
  };
}

/**
 * @param {Array<ReturnType<import("./parse.mjs").parseTranscript>>} parsedSessions
 * @param {{ threshold?: number, top?: number }} [options]
 */
export function analyzeSessions(parsedSessions, options = {}) {
  const sessions = parsedSessions.map((parsed) => analyzeSession(parsed, options));
  const total = {
    sessions: sessions.length,
    calls: sessions.reduce((sum, item) => sum + item.calls, 0),
    totalChars: sessions.reduce((sum, item) => sum + item.totalChars, 0),
    fatCalls: sessions.reduce((sum, item) => sum + item.fatCalls, 0),
    fatChars: sessions.reduce((sum, item) => sum + item.fatChars, 0),
    avoidableChars: sessions.reduce((sum, item) => sum + item.avoidableChars, 0),
    warnings: sessions.flatMap((item) => item.warnings.map((warning) => `${item.file}: ${warning}`)),
  };
  total.totalTokens = estimateTokens(total.totalChars);
  total.fatShare = total.totalChars === 0 ? 0 : total.fatChars / total.totalChars;
  total.avoidableTokens = estimateTokens(total.avoidableChars);
  total.fatCallShare = total.calls === 0 ? 0 : total.fatCalls / total.calls;

  total.classes = CLASSES.map((meta) => {
    const items = sessions.map((session) => session.classes.find((item) => item.id === meta.id)).filter(Boolean);
    const chars = items.reduce((sum, item) => sum + item.chars, 0);
    return {
      id: meta.id,
      title: meta.title,
      advice: meta.advice,
      calls: items.reduce((sum, item) => sum + item.calls, 0),
      chars,
      share: total.totalChars === 0 ? 0 : chars / total.totalChars,
    };
  })
    .filter((item) => item.calls > 0)
    .sort((a, b) => b.chars - a.chars);

  const top = sessions
    .flatMap((session) => session.top.map((item) => ({ ...item, file: session.file })))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, options.top ?? 8);

  return { sessions, total, top, classMeta: CLASS_BY_ID };
}
