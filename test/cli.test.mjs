import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, main, parseArgs } from "../src/cli.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fat = path.join(here, "fixtures", "fat-session.jsonl");
const lean = path.join(here, "fixtures", "lean-session.jsonl");

function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { log: (line) => out.push(line), error: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("scans a fat session and reports classes", () => {
  const { code, out } = run(["scan", fat]);
  assert.equal(code, EXIT_CODES.OK);
  assert.match(out, /ctxdiet 0\.1\.0/);
  assert.match(out, /claude-code/);
  assert.match(out, /by class/);
  assert.match(out, /file-dump/);
  assert.match(out, /avoidable/);
});

test("--json is machine readable", () => {
  const { code, out } = run(["scan", fat, "--json"]);
  assert.equal(code, EXIT_CODES.OK);
  const payload = JSON.parse(out);
  assert.equal(payload.total.sessions, 1);
  assert.equal(payload.total.fatCalls, 5);
  assert.ok(payload.total.fatShare > 0.9);
  assert.equal(payload.threshold, 8000);
});

test("--max-tokens fails when the avoidable estimate is over the limit", () => {
  const low = run(["scan", fat, "--max-tokens", "1"]);
  assert.equal(low.code, EXIT_CODES.FAILED);
  assert.match(low.err, /--max-tokens/);

  const high = run(["scan", fat, "--max-tokens", "100000"]);
  assert.equal(high.code, EXIT_CODES.OK);
});

test("--rules appends a pasteable AGENTS.md block", () => {
  const { code, out } = run(["scan", fat, "--rules"]);
  assert.equal(code, EXIT_CODES.OK);
  assert.match(out, /## 工具输出纪律/);
  assert.match(out, /grep -n/);
});

test("a high threshold produces a clean pass", () => {
  const { code, out } = run(["scan", fat, "--threshold", "1000000"]);
  assert.equal(code, EXIT_CODES.OK);
  assert.match(out, /no output above 1\.0M chars/);
});

test("scans a directory of transcripts", () => {
  const { code, out } = run(["scan", path.join(here, "fixtures"), "--json"]);
  assert.equal(code, EXIT_CODES.OK);
  const payload = JSON.parse(out);
  assert.equal(payload.total.sessions, 2);
  assert.equal(payload.total.fatCalls, 5);
});

test("a lean session passes without findings", () => {
  const { code, out } = run(["scan", lean]);
  assert.equal(code, EXIT_CODES.OK);
  assert.match(out, /no output above/);
});

test("missing path and empty transcripts fail with exit 1", () => {
  const missing = run(["scan", path.join(here, "fixtures", "nope.jsonl")]);
  assert.equal(missing.code, EXIT_CODES.FAILED);
  assert.match(missing.err, /找不到路径/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxdiet-cli-"));
  const empty = path.join(dir, "empty.jsonl");
  fs.writeFileSync(empty, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }));
  const none = run(["scan", empty]);
  assert.equal(none.code, EXIT_CODES.FAILED);
  assert.match(none.err, /没有识别出工具调用/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("bad usage exits 2", () => {
  for (const argv of [["bogus"], ["scan"], ["scan", fat, "--nope"], ["scan", fat, "--top", "zero"], ["scan", fat, "--max-tokens"]]) {
    const { code } = run(argv);
    assert.equal(code, EXIT_CODES.USAGE, `expected usage error for ${JSON.stringify(argv)}`);
  }
  const help = run(["--help"]);
  assert.equal(help.code, EXIT_CODES.OK);
  assert.match(help.out, /ctxdiet 0\.1\.0/);
});

test("parseArgs accepts --key=value", () => {
  const { command, target, options } = parseArgs(["scan", "x.jsonl", "--threshold=5000", "--json"]);
  assert.equal(command, "scan");
  assert.equal(target, "x.jsonl");
  assert.equal(options.threshold, "5000");
  assert.equal(options.json, true);
});
