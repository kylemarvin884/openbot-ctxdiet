// Transcript parsing for ctxdiet.
//
// Four shapes are supported, all line-delimited JSON:
//   1. Claude Code   {type, sessionId, message:{content:[{type:"tool_use",id,name,input}]}}
//                    results arrive later as {message:{content:[{type:"tool_result",tool_use_id}]}}
//   2. Codex CLI     {type:"response_item", payload:{type:"function_call", name, arguments, call_id}}
//                    results as {payload:{type:"function_call_output", call_id, output:[...]}}
//   3. OpenAI style  {role, tool_calls:[{id, function:{name, arguments}}]}
//   4. Generic line  {tool, input, result}
//
// The parser never guesses content: a line that is not JSON is skipped with a
// warning, and every event keeps the source line number so the report can point
// at it. ctxdiet only measures output it actually saw.
//
// Context compaction increments an epoch counter, so the report can say how many
// times the window had to be rebuilt. `bounded` marks calls that already limited
// their output (Read with offset/limit, `| tail`, `Select-Object -First`); those
// are never reported as fixable.

import fs from "node:fs";
import zlib from "node:zlib";

const READ_TOOLS = new Set([
  "read",
  "readfile",
  "readfiles",
  "readtextfile",
  "view",
  "openfile",
  "fileread",
  "filesystemread",
  "filesystemreadfile",
]);

const WRITE_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "strreplace",
  "strreplaceeditor",
  "applypatch",
  "applydiff",
  "createfile",
  "writefile",
  "replacefile",
]);

// Codex names its shell tool exec_command / shell_command; both carry a command string.
const COMMAND_TOOLS = new Set([
  "bash",
  "shell",
  "exec",
  "runcommand",
  "terminal",
  "powershell",
  "execcommand",
  "shellcommand",
]);

const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "file",
  "filename",
  "fileName",
  "target_file",
  "targetFile",
  "notebook_path",
  "notebookPath",
  "absolute_path",
  "absolutePath",
];

/** FNV-1a, 32 bit. Stable across runs and platforms; good enough to compare outputs. */
export function hashText(value) {
  const text = String(value ?? "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Read a transcript file, transparently handling Codex's `.jsonl.zst`.
 * zstd support landed in Node 22.15; older runtimes get a clear error instead
 * of a half-parsed session.
 * @param {string} file
 * @returns {string}
 */
export function readTranscriptFile(file) {
  const buffer = fs.readFileSync(file);
  if (!String(file).toLowerCase().endsWith(".zst")) return buffer.toString("utf8");
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error(`需要 Node >= 22.15 才能解压 .zst：${file}（当前 ${process.version}）`);
  }
  return zlib.zstdDecompressSync(buffer).toString("utf8");
}

/**
 * @typedef {Object} Event
 * @property {number} index
 * @property {number} line
 * @property {string|null} at
 * @property {number} epoch       compaction generation; comparisons never cross epochs
 * @property {"read"|"write"|"command"|"other"} kind
 * @property {string} tool
 * @property {string|null} path
 * @property {string|null} command
 * @property {string|null} id
 * @property {boolean} isError
 * @property {string} resultText
 * @property {string} resultHash
 * @property {{old:string,next:string,content:string}|null} edit
 */

/**
 * @param {string} text
 * @param {{ file?: string }} [meta]
 * @returns {{ file: string, format: string, cwd: string|null, epoch: number, events: Event[], warnings: string[], lines: number, parsedLines: number }}
 */
export function parseTranscript(text, { file = "" } = {}) {
  const lines = String(text).split(/\r?\n/);
  const events = [];
  const results = new Map();
  const warnings = [];
  let cwd = null;
  let format = "unknown";
  let parsedLines = 0;
  let epoch = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      warnings.push(`line ${index + 1}: not valid JSON, skipped`);
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    parsedLines += 1;
    if (!cwd) cwd = firstCwd(obj);
    const at = toIso(firstTimestamp(obj));

    if (isCompaction(obj)) {
      epoch += 1;
      continue;
    }

    for (const result of resultBlocks(obj)) {
      if (result.id) results.set(result.id, result);
    }

    const calls = callBlocks(obj);
    if (calls.length === 0) continue;

    if (obj.type === "response_item") format = format === "unknown" ? "codex" : format;
    else if (obj.sessionId && obj.message) format = format === "unknown" ? "claude-code" : format;
    else if (Array.isArray(obj.tool_calls) || (obj.role && obj.message !== undefined)) {
      format = format === "unknown" ? "openai" : format;
    } else if (typeof obj.tool === "string" || typeof obj.tool_name === "string") {
      format = format === "unknown" ? "generic" : format;
    }

    for (const call of calls) {
      const input = asObject(call.input);
      const tool = String(call.name ?? "");
      const kind = classifyTool(tool, input);
      let command = extractCommand(input);
      // Codex `exec` wraps a script instead of a shell string. The script text
      // is still a stable identity, so it can be compared like a command.
      if (!command && kind === "command" && typeof call.input === "string" && call.input.trim()) {
        command = call.input.trim();
      }
      events.push({
        index: events.length,
        line: index + 1,
        at,
        epoch,
        kind,
        tool,
        path: extractPath(input),
        command,
        bounded: isBounded(kind, input, command),
        id: call.id ?? null,
        isError: Boolean(obj.is_error ?? obj.isError),
        resultText: typeof obj.result === "string" ? obj.result : "",
        resultHash: typeof obj.result === "string" && obj.result ? hashText(normalizeOutput(obj.result)) : "",
        edit: kind === "write" ? extractEdit(input) : null,
      });
    }
  }

  for (const event of events) {
    const result = event.id ? results.get(event.id) : null;
    if (!result) continue;
    event.isError = result.isError;
    event.resultText = result.text;
    event.resultHash = result.text ? hashText(normalizeOutput(result.text)) : "";
  }

  return { file, format, cwd, epoch, events, warnings, lines: lines.length, parsedLines };
}

export function normalizeToolName(name) {
  return String(name)
    .toLowerCase()
    .split(/__|\.|\//)
    .pop()
    .replace(/[^a-z0-9]/g, "");
}

export function classifyTool(name, input) {
  const normalized = normalizeToolName(name);
  const action = String(input?.command ?? "").toLowerCase();
  if (READ_TOOLS.has(normalized)) return "read";
  // The older editor tool reads when command is "view".
  if ((normalized === "strreplaceeditor" || normalized === "edit") && action === "view") return "read";
  if (WRITE_TOOLS.has(normalized)) return "write";
  if (COMMAND_TOOLS.has(normalized)) return "command";
  return "other";
}

function extractPath(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractCommand(input) {
  if (!input || typeof input !== "object") return null;
  const value = input.command ?? input.cmd ?? input.script ?? input.input;
  if (typeof value === "string" && value.trim()) return value.trim();
  // Codex shell calls sometimes carry argv arrays.
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
    return value.join(" ");
  }
  return null;
}

const BOUNDED_COMMAND =
  /\|\s*(?:head|tail)\b|\bhead\s+-\d|\btail\s+-n?\s*\d|select-object\s+-first|--max-count\b|--head\b|--oneline\b|--name-only\b|--stat\b|--shortstat\b|\bsed\s+-n\b|--limit\b|\bgrep\s+-[a-z]*c\b/i;

const BOUNDED_INPUT_KEYS = ["offset", "limit", "start_line", "end_line", "max_lines", "num_lines"];

/** True when the call already limited its own output. Those are never reported as fixable. */
function isBounded(kind, input, command) {
  if (kind === "read") {
    return BOUNDED_INPUT_KEYS.some((key) => {
      const value = input?.[key];
      return value !== undefined && value !== null && value !== "";
    });
  }
  if (kind === "command") return BOUNDED_COMMAND.test(String(command ?? ""));
  return false;
}

function extractEdit(input) {
  const old = typeof input.old_string === "string" ? input.old_string : "";
  const next = typeof input.new_string === "string" ? input.new_string : "";
  const content = typeof input.content === "string" ? input.content : "";
  return { old, next, content };
}

export function normalizeOutput(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function isCompaction(obj) {
  if (obj.type === "compacted") return true;
  if (obj.isCompactSummary === true) return true;
  if (typeof obj.subtype === "string" && obj.subtype.toLowerCase().includes("compact")) return true;
  return false;
}

function callBlocks(obj) {
  const calls = [];
  const payload = obj.type === "response_item" && obj.payload && typeof obj.payload === "object" ? obj.payload : null;
  if (payload) {
    if (payload.type === "function_call") {
      calls.push({ id: payload.call_id ?? payload.id ?? null, name: payload.name, input: payload.arguments });
    }
    if (payload.type === "custom_tool_call") {
      calls.push({ id: payload.call_id ?? payload.id ?? null, name: payload.name, input: payload.input });
    }
  }

  const message = obj.message && typeof obj.message === "object" ? obj.message : obj;

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && part.type === "tool_use" && part.name) {
        calls.push({ id: part.id ?? part.tool_use_id ?? null, name: part.name, input: part.input });
      }
    }
  }

  for (const group of [message.tool_calls, message === obj ? null : obj.tool_calls]) {
    if (!Array.isArray(group)) continue;
    for (const call of group) {
      if (!call || typeof call !== "object") continue;
      const name = call.function?.name ?? call.name ?? call.tool;
      const input = call.function?.arguments ?? call.arguments ?? call.input;
      if (name) calls.push({ id: call.id ?? call.tool_call_id ?? null, name, input });
    }
  }

  if (typeof obj.tool === "string") {
    calls.push({ id: obj.id ?? null, name: obj.tool, input: obj.input ?? obj.args });
  }
  if (typeof obj.tool_name === "string") {
    calls.push({ id: obj.id ?? null, name: obj.tool_name, input: obj.tool_input ?? obj.input ?? obj.args });
  }

  return calls;
}

function resultBlocks(obj) {
  const blocks = [];
  const payload = obj.type === "response_item" && obj.payload && typeof obj.payload === "object" ? obj.payload : null;
  if (payload && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
    blocks.push({
      id: payload.call_id ?? payload.id ?? null,
      isError: payload.status === "failed" || payload.status === "error",
      text: outputText(payload.output),
    });
  }

  const message = obj.message && typeof obj.message === "object" ? obj.message : obj;
  const parts = Array.isArray(message.content) ? message.content : [];

  for (const part of parts) {
    if (!part || part.type !== "tool_result") continue;
    blocks.push({
      id: part.tool_use_id ?? part.id ?? part.tool_call_id ?? null,
      isError: Boolean(part.is_error ?? part.isError),
      text: resultText(part.content, obj.toolUseResult),
    });
  }
  return blocks;
}

function outputText(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return output && typeof output === "object" ? JSON.stringify(output) : "";
  return output
    .map((item) => (typeof item === "string" ? item : typeof item?.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function resultText(content, toolUseResult) {
  const parts = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item.text === "string") parts.push(item.text);
    }
  }
  if (typeof toolUseResult === "string") parts.push(toolUseResult);
  else if (toolUseResult && typeof toolUseResult === "object") {
    if (typeof toolUseResult.error === "string") parts.push(toolUseResult.error);
    if (typeof toolUseResult.stdout === "string") parts.push(toolUseResult.stdout);
    if (typeof toolUseResult.stderr === "string") parts.push(toolUseResult.stderr);
  }
  return parts.join("\n");
}

function asObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function firstTimestamp(obj) {
  const candidates = [obj.timestamp, obj.ts, obj.time, obj.created_at, obj.createdAt, obj.message?.timestamp];
  return candidates.find((value) => value !== undefined && value !== null) ?? null;
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function firstCwd(obj) {
  const candidates = [obj.cwd, obj.project?.cwd, obj.message?.cwd, obj.payload?.cwd];
  const value = candidates.find((item) => typeof item === "string" && item.trim());
  return value ? value.trim() : null;
}
