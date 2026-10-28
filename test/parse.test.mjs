import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { hashText, parseTranscript, readTranscriptFile } from "../src/parse.mjs";

const claude = (id, name, input) =>
  JSON.stringify({
    type: "assistant",
    sessionId: "s1",
    cwd: "/repo",
    timestamp: "2026-10-28T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });

const result = (id, content, isError = false) =>
  JSON.stringify({
    type: "user",
    sessionId: "s1",
    cwd: "/repo",
    timestamp: "2026-10-28T10:00:01.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] },
  });

test("parses Claude Code events and attaches results", () => {
  const text = [
    claude("t1", "Read", { file_path: "src/a.ts" }),
    result("t1", "export const a = 1"),
    claude("t2", "Bash", { command: "npm test" }),
    result("t2", "1 test failed", true),
    claude("t3", "Edit", { file_path: "src/a.ts", old_string: "1", new_string: "2" }),
    result("t3", "updated"),
  ].join("\n");

  const parsed = parseTranscript(text, { file: "s1.jsonl" });
  assert.equal(parsed.format, "claude-code");
  assert.equal(parsed.cwd, "/repo");
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[0].kind, "read");
  assert.equal(parsed.events[0].path, "src/a.ts");
  assert.equal(parsed.events[0].resultText, "export const a = 1");
  assert.ok(parsed.events[0].resultHash);
  assert.equal(parsed.events[1].kind, "command");
  assert.equal(parsed.events[1].isError, true);
  assert.deepEqual(parsed.events[2].edit, { old: "1", next: "2", content: "" });
});

test("marks reads that already limit their output", () => {
  const text = [
    claude("t1", "Read", { file_path: "src/a.ts" }),
    result("t1", "a"),
    claude("t2", "Read", { file_path: "src/a.ts", offset: 10, limit: 20 }),
    result("t2", "b"),
    claude("t3", "Bash", { command: "npm test | tail -20" }),
    result("t3", "c"),
    claude("t4", "Bash", { command: "npm test" }),
    result("t4", "d"),
  ].join("\n");

  const parsed = parseTranscript(text);
  assert.deepEqual(
    parsed.events.map((event) => event.bounded),
    [false, true, true, false],
  );
});

test("parses Codex rollout items, including .zst files", () => {
  const lines = [
    JSON.stringify({ timestamp: "2026-07-22T01:44:36.658Z", type: "session_meta", payload: { cwd: "C:\\repo" } }),
    JSON.stringify({
      timestamp: "2026-07-22T01:44:40.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"npm test"}', call_id: "call_1" },
    }),
    JSON.stringify({
      timestamp: "2026-07-22T01:44:41.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_text", text: "2 tests failed" }],
      },
    }),
  ].join("\n");

  const parsed = parseTranscript(lines, { file: "rollout.jsonl" });
  assert.equal(parsed.format, "codex");
  assert.equal(parsed.cwd, "C:\\repo");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].kind, "command");
  assert.equal(parsed.events[0].command, "npm test");
  assert.equal(parsed.events[0].resultText, "2 tests failed");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxdiet-"));
  const plain = path.join(dir, "rollout.jsonl.zst");
  if (typeof zlib.zstdCompressSync === "function") {
    fs.writeFileSync(plain, zlib.zstdCompressSync(Buffer.from(lines, "utf8")));
    assert.equal(readTranscriptFile(plain), lines);
  }
  const raw = path.join(dir, "plain.jsonl");
  fs.writeFileSync(raw, lines);
  assert.equal(readTranscriptFile(raw), lines);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parses OpenAI-style tool_calls", () => {
  const text = [
    JSON.stringify({
      role: "assistant",
      tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' } }],
    }),
    JSON.stringify({ role: "tool", tool_call_id: "c1", content: "hello" }),
  ].join("\n");

  const parsed = parseTranscript(text);
  assert.equal(parsed.format, "openai");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].kind, "read");
  assert.equal(parsed.events[0].path, "src/a.ts");
});

test("parses generic {tool,input,result} lines", () => {
  const text = JSON.stringify({ tool: "Bash", input: { command: "ls" }, result: "a\nb" });
  const parsed = parseTranscript(text);
  assert.equal(parsed.format, "generic");
  assert.equal(parsed.events[0].kind, "command");
  assert.equal(parsed.events[0].resultText, "a\nb");
});

test("counts compactions as epochs and skips unparseable lines", () => {
  const text = [
    claude("t1", "Read", { file_path: "src/a.ts" }),
    result("t1", "a"),
    "not json at all",
    JSON.stringify({ type: "compacted", payload: {} }),
    claude("t2", "Read", { file_path: "src/a.ts" }),
    result("t2", "a"),
  ].join("\n");

  const parsed = parseTranscript(text);
  assert.equal(parsed.epoch, 1);
  assert.deepEqual(
    parsed.events.map((event) => event.epoch),
    [0, 1],
  );
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /line 3/);
});

test("hashText is stable", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
});
