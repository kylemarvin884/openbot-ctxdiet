// Rendering for ctxdiet: a terminal report and an AGENTS.md snippet.

import { CLASSES, DEFAULT_THRESHOLD } from "./diet.mjs";

export function truncate(value, width) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export function percent(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

export function formatCount(value) {
  if (value < 1000) return String(value);
  if (value < 1000000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

/**
 * @param {ReturnType<import("./diet.mjs").analyzeSessions>} analysis
 * @param {{ version?: string, threshold?: number, top?: number }} [options]
 */
export function formatReport(analysis, { version = "0.1.0", threshold = DEFAULT_THRESHOLD, top = 8 } = {}) {
  const { total, sessions } = analysis;
  const lines = [];

  lines.push(`ctxdiet ${version}`);
  if (sessions.length === 1) {
    const [session] = sessions;
    const compacted = session.compacted > 0 ? `  |  compacted ${session.compacted}x` : "";
    lines.push(`session  ${session.file || "(stdin)"}  (${session.format})${compacted}`);
  } else {
    lines.push(`sessions ${sessions.length}  |  compacted ${sessions.reduce((sum, item) => sum + item.compacted, 0)}x`);
  }

  lines.push(
    `calls    ${formatCount(total.calls)}  |  tool output ${formatCount(total.totalChars)} chars (~${formatCount(
      total.totalTokens,
    )} tokens, estimate)`,
  );
  lines.push(
    `fat      ${formatCount(total.fatCalls)} calls (${percent(total.fatCallShare)}) produced ${percent(
      total.fatShare,
    )} of the output  |  fat = >${formatCount(threshold)} chars, no bound`,
  );
  lines.push("");

  if (total.fatCalls === 0) {
    lines.push(`no output above ${formatCount(threshold)} chars was found without a bound (this is a pass, not proof of efficiency)`);
    lines.push("");
    return lines.join("\n");
  }

  lines.push("by class");
  for (const item of total.classes) {
    lines.push(
      `  ${item.id.padEnd(12)} ${String(item.calls).padStart(5)} calls  ${formatCount(item.chars).padStart(6)} chars  ${percent(
        item.share,
      ).padStart(4)}  ${item.title}`,
    );
    lines.push(`      → ${truncate(item.advice, 100)}`);
  }
  lines.push("");

  if (analysis.top.length > 0) {
    lines.push("top calls");
    analysis.top.slice(0, top).forEach((item, index) => {
      const where = sessions.length > 1 ? `${shortFile(item.file)} ` : "";
      lines.push(
        `  ${String(index + 1).padStart(2)}  ${formatCount(item.chars).padStart(6)} chars  ${item.klass.padEnd(12)} ${
          where || ""
        }${truncate(item.brief, 52)}  line ${item.line}`,
      );
    });
    lines.push("");
  }

  const repeats = sessions
    .flatMap((session) => session.repeats.map((item) => ({ ...item, file: session.file })))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 5);
  if (repeats.length > 0) {
    lines.push("repeated targets");
    for (const item of repeats) {
      lines.push(`  ${truncate(item.target, 48)}  ${item.calls} calls  ${formatCount(item.chars)} chars`);
    }
    lines.push("");
  }

  lines.push(
    `avoidable ${percent(total.fatShare)} of tool output is an upper bound: it assumes every fat call had a bounded alternative.`,
  );
  lines.push(`tokens    ~${formatCount(total.avoidableTokens)} tokens would not have been sent (chars/4 estimate).`);
  lines.push("");

  if (total.warnings.length > 0) {
    lines.push(`warnings ${total.warnings.length}`);
    for (const warning of total.warnings.slice(0, 3)) lines.push(`  ${truncate(warning, 100)}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** @param {ReturnType<import("./diet.mjs").analyzeSessions>} analysis */
export function formatRules(analysis, { threshold = DEFAULT_THRESHOLD } = {}) {
  const { total } = analysis;
  const present = new Set(total.classes.map((item) => item.id));
  const lines = [];

  lines.push("## 工具输出纪律（ctxdiet 根据最近的 transcript 生成）");
  lines.push("");
  if (total.fatCalls === 0) {
    lines.push(`- 最近 ${total.sessions} 个会话里没有超过 ${formatCount(threshold)} 字符的未限界输出，保持现状。`);
    return lines.join("\n");
  }

  lines.push(
    `- 最近 ${total.sessions} 个会话里，${percent(total.fatCallShare)} 的调用产生了 ${percent(
      total.fatShare,
    )} 的工具输出。单次输出控制在 ~${formatCount(threshold)} 字符以内。`,
  );

  for (const meta of CLASSES) {
    if (!present.has(meta.id)) continue;
    if (meta.id === "duplicate") {
      lines.push("- 同一份输出不要取第二次：先记结论，需要复用时写进文件再引用。");
      continue;
    }
    lines.push(`- ${meta.advice}`);
  }

  const worst = total.classes[0];
  if (worst) {
    lines.push("");
    lines.push(`最大来源是 ${worst.title}（${worst.calls} 次，${formatCount(worst.chars)} 字符），先修这一类。`);
  }
  return lines.join("\n");
}

function shortFile(file) {
  const posix = String(file ?? "").replace(/\\/g, "/");
  return posix.split("/").pop() || posix;
}
