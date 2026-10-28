#!/usr/bin/env node
// ctxdiet CLI: scan a transcript file or a directory of transcripts.
//
// Exit codes: 0 = ok, 1 = --max-tokens exceeded or unreadable input, 2 = usage.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_THRESHOLD, analyzeSessions } from "./diet.mjs";
import { parseTranscript, readTranscriptFile } from "./parse.mjs";
import { formatReport, formatRules } from "./report.mjs";

export const EXIT_CODES = Object.freeze({
  OK: 0,
  FAILED: 1,
  USAGE: 2,
});

const COMMANDS = new Map([
  ["scan", "统计一个 transcript 文件或目录里的工具输出占用"],
  ["help", "输出用法、分类和退出码"],
]);

export class CliError extends Error {
  constructor(message, { code = "E_USAGE", exitCode = EXIT_CODES.USAGE } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const OPTIONS = new Set(["help", "json", "rules", "top", "threshold", "max-tokens"]);

/**
 * @param {string[]} argv
 * @returns {{ command: string, target: string|null, options: Record<string, string|boolean> }}
 */
export function parseArgs(argv = []) {
  const [first, ...rest] = argv;
  if (!first || first === "-h" || first === "--help") {
    return { command: "help", target: null, options: {} };
  }
  if (first.startsWith("-")) throw new CliError(`未知选项：${first}`);
  if (!COMMANDS.has(first)) throw new CliError(`未知命令：${first}`);

  let target = null;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "-h" || token === "--help") {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      if (target !== null) throw new CliError(`多余的参数：${token}`);
      target = token;
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    const key = equals === -1 ? body : body.slice(0, equals);
    if (!OPTIONS.has(key)) throw new CliError(`未知选项：--${key}`);
    if (Object.hasOwn(options, key)) throw new CliError(`选项重复：--${key}`);
    if (key === "help" || key === "json" || key === "rules") {
      if (equals !== -1) throw new CliError(`--${key} 不接受值`);
      options[key] = true;
      continue;
    }
    if (equals !== -1) {
      options[key] = body.slice(equals + 1);
      continue;
    }
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) throw new CliError(`选项 --${key} 缺少值`);
    options[key] = next;
    index += 1;
  }

  return { command: first, target, options };
}

/** Resolve a path into a list of transcript files. */
export function collectFiles(target) {
  if (!target) throw new CliError("用法：ctxdiet scan <transcript.jsonl|directory>");
  const resolved = path.resolve(target);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new CliError(`找不到路径：${target}`, { code: "E_NOT_FOUND", exitCode: EXIT_CODES.FAILED });
  }

  if (stat.isFile()) return [resolved];

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (entry.isFile() && isTranscript(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(resolved);
  files.sort();
  if (files.length === 0) {
    throw new CliError(`目录里没有 .jsonl / .jsonl.zst 文件：${target}`, { code: "E_EMPTY", exitCode: EXIT_CODES.FAILED });
  }
  return files;
}

function isTranscript(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(".jsonl") || lower.endsWith(".jsonl.zst") || lower.endsWith(".zst");
}

/**
 * @param {{ target: string, options: Record<string, string|boolean> }} input
 */
export function scan({ target, options = {} }) {
  const threshold = options.threshold === undefined ? DEFAULT_THRESHOLD : parsePositive(options.threshold, "--threshold");
  const top = options.top === undefined ? 8 : parsePositive(options.top, "--top");

  const files = collectFiles(target);
  const parsed = files.map((file) => parseTranscript(readTranscriptFile(file), { file }));

  const withCalls = parsed.filter((session) => session.events.length > 0);
  if (withCalls.length === 0) {
    throw new CliError(
      `${files.length} 个文件里没有识别出工具调用（支持 Claude Code / Codex / OpenAI / 通用 JSONL）`,
      { code: "E_NO_CALLS", exitCode: EXIT_CODES.FAILED },
    );
  }

  const analysis = analyzeSessions(withCalls, { threshold, top });
  return { analysis, threshold, top };
}

function parsePositive(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new CliError(`${flag} 需要正数`);
  return Math.round(number);
}

/**
 * @param {string[]} argv
 * @param {{ log: (line: string) => void, error: (line: string) => void }} io
 * @returns {number}
 */
export function main(argv = process.argv.slice(2), io = console) {
  try {
    const { command, target, options } = parseArgs(argv);
    if (command === "help" || options.help) {
      io.log(helpText());
      return EXIT_CODES.OK;
    }

    const { analysis, threshold, top } = scan({ target, options });

    if (options.json) {
      io.log(JSON.stringify(toJson(analysis, threshold), null, 2));
    } else {
      io.log(formatReport(analysis, { threshold, top }));
      if (options.rules) {
        io.log("");
        io.log(formatRules(analysis, { threshold }));
      }
    }

    if (options["max-tokens"] !== undefined) {
      const limit = parsePositive(options["max-tokens"], "--max-tokens");
      if (analysis.total.avoidableTokens > limit) {
        if (!options.json) {
          io.error(`avoidable ~${analysis.total.avoidableTokens} tokens > --max-tokens ${limit}`);
        }
        return EXIT_CODES.FAILED;
      }
    }
    return EXIT_CODES.OK;
  } catch (error) {
    const known = error instanceof CliError;
    io.error(`ctxdiet: ${known ? error.message : `内部错误：${error.message}`}`);
    if (!known) io.error("带命令和输出提 issue：https://github.com/kylemarvin884/openbot-ctxdiet/issues");
    return known ? error.exitCode : EXIT_CODES.FAILED;
  }
}

function toJson(analysis, threshold) {
  return {
    threshold,
    sessions: analysis.sessions.map((session) => ({
      file: session.file,
      format: session.format,
      compacted: session.compacted,
      calls: session.calls,
      totalChars: session.totalChars,
      fatCalls: session.fatCalls,
      fatChars: session.fatChars,
      fatShare: Number(session.fatShare.toFixed(4)),
      classes: session.classes,
      top: session.top,
      repeats: session.repeats,
      warnings: session.warnings,
    })),
    total: {
      sessions: analysis.total.sessions,
      calls: analysis.total.calls,
      totalChars: analysis.total.totalChars,
      totalTokens: analysis.total.totalTokens,
      fatCalls: analysis.total.fatCalls,
      fatChars: analysis.total.fatChars,
      fatShare: Number(analysis.total.fatShare.toFixed(4)),
      fatCallShare: Number(analysis.total.fatCallShare.toFixed(4)),
      avoidableTokens: analysis.total.avoidableTokens,
      classes: analysis.total.classes,
    },
  };
}

function helpText() {
  return [
    "ctxdiet 0.1.0 — 找出吃掉 agent 上下文的工具输出",
    "",
    "用法",
    "  ctxdiet scan <transcript.jsonl|directory> [options]",
    "",
    "选项",
    "  --json                 输出机器可读 JSON",
    "  --rules                追加一段可粘进 AGENTS.md 的规则",
    "  --threshold <chars>    多长的输出算 fat（默认 8000）",
    "  --max-tokens <n>       可避免 token 超过该值时 exit 1",
    "  --top <n>              最多列出 n 条（默认 8）",
    "  --help                 输出本帮助",
    "",
    "分类",
    "  file-dump     Read 整读大文件（没有 offset/limit）",
    "  cat-dump      cat / Get-Content 整文件",
    "  tree-dump     ls -R / find / git ls-files 全量列举",
    "  log-dump      测试、构建、编译日志整段",
    "  json-dump     大 JSON 原文",
    "  duplicate     同一份输出第二次取回",
    "",
    "退出码",
    "  0  正常",
    "  1  --max-tokens 超限，或输入不可读 / 没有工具调用",
    "  2  命令或参数错误",
    "",
    "支持格式：Claude Code JSONL、Codex rollout（含 .jsonl.zst）、OpenAI 风格、通用 {tool,input,result}",
  ].join("\n");
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exitCode = main();
}
