import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_THRESHOLD, analyzeSession, analyzeSessions, classify, estimateTokens } from "../src/diet.mjs";
import { parseTranscript, readTranscriptFile, hashText, normalizeOutput } from "../src/parse.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function event(overrides) {
  const base = {
    index: 0,
    line: 1,
    at: null,
    epoch: 0,
    kind: "command",
    tool: "Bash",
    path: null,
    command: "node script.mjs",
    bounded: false,
    id: null,
    isError: false,
    resultText: "",
    resultHash: "",
    edit: null,
    ...overrides,
  };
  if (!base.resultHash && base.resultText) base.resultHash = hashText(normalizeOutput(base.resultText));
  return base;
}

const big = (char = "x", size = DEFAULT_THRESHOLD) => char.repeat(size);

test("classifies unbounded reads, logs, trees, cats and json", () => {
  assert.equal(classify(event({ kind: "read", path: "a.ts", resultText: big("a", 9000) })), "file-dump");
  assert.equal(classify(event({ kind: "read", path: "a.ts", bounded: true, resultText: big("a", 9000) })), null);
  assert.equal(classify(event({ command: "npm test", resultText: big("l", 9000) })), "command-dump");
  assert.equal(
    classify(event({ command: "npm test", resultText: Array.from({ length: 400 }, (_, i) => `ok ${i} - cart total case with a long label`).join("\n") })),
    "log-dump",
  );
  assert.equal(classify(event({ command: "ls -R src", resultText: big("t", 9000) })), "tree-dump");
  assert.equal(classify(event({ command: "cat package.json", resultText: big("c", 9000) })), "cat-dump");
  assert.equal(
    classify(event({ command: "curl -s localhost:3000/api", resultText: `{"rows":[${`"x",`.repeat(4000)}"end"]}` })),
    "json-dump",
  );
  assert.equal(classify(event({ command: "echo hi", resultText: "hi" })), null);
});

test("bounded commands are never fat", () => {
  assert.equal(classify(event({ command: "npm test | tail -20", bounded: true, resultText: big("l", 20000) })), null);
});

test("duplicate outputs are caught above the threshold only", () => {
  const first = event({ index: 0, line: 1, resultText: big("d", 3000) });
  const second = event({ index: 1, line: 2, resultText: big("d", 3000) });
  const small = [event({ index: 0, line: 1, resultText: "x".repeat(800) }), event({ index: 1, line: 2, resultText: "x".repeat(800) })];

  const parsed = {
    file: "session.jsonl",
    format: "claude-code",
    epoch: 0,
    warnings: [],
    events: [first, second],
  };

  const result = analyzeSession(parsed, { threshold: 1000 });
  assert.equal(result.classes.find((item) => item.id === "duplicate").calls, 1);

  // Same shape below the threshold: nothing is reported.
  const tiny = analyzeSession({ ...parsed, events: small }, { threshold: 1000 });
  assert.equal(tiny.fatCalls, 0);
});

test("analyzeSession reports shares, repeats and the top call", () => {
  const events = [
    event({ index: 0, line: 1, kind: "read", path: "src/app.tsx", resultText: big("a", 30000) }),
    event({ index: 1, line: 3, command: "npm test", resultText: big("l", 10000) }),
    event({ index: 2, line: 5, kind: "read", path: "src/app.tsx", resultText: big("b", 30000) }),
    event({ index: 3, line: 7, command: "echo ok", resultText: "ok" }),
  ];
  const parsed = { file: "s.jsonl", format: "claude-code", epoch: 0, warnings: [], events };
  const result = analyzeSession(parsed);

  assert.equal(result.calls, 4);
  assert.equal(result.fatCalls, 3);
  assert.equal(result.totalChars, 30000 + 10000 + 30000 + 2);
  assert.equal(result.fatChars, 70000);
  assert.ok(result.fatShare > 0.99);
  assert.equal(result.top[0].chars, 30000);
  assert.equal(result.repeats[0].target, "src/app.tsx");
  assert.equal(result.repeats[0].calls, 2);
  assert.equal(estimateTokens(result.totalChars), Math.ceil(result.totalChars / 4));
});

test("analyzeSessions aggregates classes and tolerates an empty session", () => {
  const one = {
    file: "a.jsonl",
    format: "claude-code",
    epoch: 0,
    warnings: [],
    events: [event({ index: 0, kind: "read", path: "x.ts", resultText: big("a", 12000) })],
  };
  const two = {
    file: "b.jsonl",
    format: "codex",
    epoch: 2,
    warnings: ["line 2: not valid JSON, skipped"],
    events: [event({ index: 0, command: "ls -R", resultText: big("t", 12000) })],
  };

  const analysis = analyzeSessions([one, two]);
  assert.equal(analysis.total.sessions, 2);
  assert.equal(analysis.total.calls, 2);
  assert.equal(analysis.total.fatCalls, 2);
  assert.equal(analysis.total.warnings.length, 1);
  assert.deepEqual(
    analysis.total.classes.map((item) => item.id).sort(),
    ["file-dump", "tree-dump"],
  );
});

test("the fixture fat session has five fat calls out of seven", () => {
  const file = path.join(here, "fixtures", "fat-session.jsonl");
  const parsed = parseTranscript(readTranscriptFile(file), { file });
  const analysis = analyzeSessions([parsed]);

  assert.equal(analysis.total.calls, 7);
  assert.equal(analysis.total.fatCalls, 5);
  assert.ok(analysis.total.fatShare > 0.9);
  const ids = analysis.total.classes.map((item) => item.id);
  for (const expected of ["file-dump", "log-dump", "tree-dump", "cat-dump", "duplicate"]) {
    assert.ok(ids.includes(expected), `missing class ${expected}`);
  }
});

test("the lean fixture has no fat calls", () => {
  const file = path.join(here, "fixtures", "lean-session.jsonl");
  const parsed = parseTranscript(readTranscriptFile(file), { file });
  const analysis = analyzeSessions([parsed]);
  assert.ok(analysis.total.calls > 0);
  assert.equal(analysis.total.fatCalls, 0);
});
