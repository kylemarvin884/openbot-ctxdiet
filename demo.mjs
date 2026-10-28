#!/usr/bin/env node
// Reproducible demo: no network, no API key, no real user data.
//
//   fat-session.jsonl   7 tool calls, 5 of them dump something big
//   lean-session.jsonl  4 tool calls, all bounded or small
//
// Run: node demo.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeSessions } from "./src/diet.mjs";
import { parseTranscript, readTranscriptFile } from "./src/parse.mjs";
import { formatReport, formatRules } from "./src/report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "test", "fixtures");

function scan(name) {
  const file = path.join(fixtures, name);
  const parsed = parseTranscript(readTranscriptFile(file), { file: path.join("test", "fixtures", name) });
  return analyzeSessions([parsed]);
}

const fat = scan("fat-session.jsonl");
console.log(formatReport(fat, { top: 5 }));
console.log(formatRules(fat));
console.log("");

const lean = scan("lean-session.jsonl");
console.log(
  `lean-session.jsonl: ${lean.total.calls} calls, ${lean.total.fatCalls} fat (${Math.round(
    lean.total.fatShare * 100,
  )}% of output)`,
);
