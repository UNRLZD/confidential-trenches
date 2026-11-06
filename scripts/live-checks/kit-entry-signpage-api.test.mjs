// node --test scripts/live-checks/kit-entry-signpage-api.test.mjs: the live check replays recorded reads
// (kit-entry-signpage-api.answers.json). "good" is the card's branch, read with --root before it merges: PASS. The bad
// answers are that recording with one planted fault each (an exports map with "./internal", a kind list without
// withdraw.open, an event outside the handshake names, an order record with a `bytes` field, one with 4 variants, one
// with a trigger field missing): FAIL. "main_kickoff" is GitHub's
// main at the kickoff commit, read live, where index.ts is still the empty stub: FAIL.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check } from "./kit-entry-signpage-api.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "kit-entry-signpage-api.answers.json"), "utf8"));
const PKG = "packages/kit/package.json";
const MESSAGES = "packages/kit/src/signpage/messages.ts";
const RECORD = "packages/kit/src/orders/record.ts";

const replay = (files) => async (p) => files[p] ?? { status: 404, body: "" };
// the recording with one file's body changed; the change must hit, so a stale recording cannot pass a bad case
function planted(p, from, to) {
  const files = structuredClone(ANSWERS.good.files);
  assert.ok(files[p].body.includes(from), `${p} holds ${JSON.stringify(from)}`);
  files[p].body = files[p].body.replace(from, to);
  return replay(files);
}

test("recorded good answer: the branch's exports, kinds, events and order record: PASS", async () => {
  const r = await check({ read: replay(ANSWERS.good.files) });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines[0], "ok  exports keys [., ./core, ./package.json]; pointing at src/; no build fields");
  assert.equal(r.lines[1], "ok  the kinds: SIGNPAGE_KINDS is the twenty-three; SignpageParams is the twenty-three; SignpageResults is the twenty-three");
  assert.equal(r.lines[2], "ok  the events [ready, state, progress] are handshake names only");
  assert.equal(r.lines[3], "ok  the order record: OrderRecord has the twelve fields; ORDER_RECORD_FIELDS is the twelve");
  assert.equal(r.lines[4], "ok  variants holds 1, 2, 3 signed variants");
  assert.equal(r.lines[5], "ok  OrderTrigger is H5.1's trigger");
  // the entry, its messages and the order record first, then every file index.ts re-exports since
  assert.match(r.lines[6], /read packages\/kit\/src\/index\.ts, packages\/kit\/src\/signpage\/messages\.ts, packages\/kit\/src\/orders\/record\.ts(, packages\/kit\/src\/[\w/-]+\.ts)*$/);
});

test('recorded bad answer: an exports map with "./internal": FAIL', async () => {
  const r = await check({ read: planted(PKG, '"./package.json": "./package.json"', '"./package.json": "./package.json",\n    "./internal": "./src/internal.ts"') });
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines[0], /^BAD exports keys \[\., \.\/core, \.\/package\.json, \.\/internal\] \(want /);
});

test("recorded bad answer: a kind list without withdraw.open: FAIL", async () => {
  const r = await check({ read: planted(MESSAGES, '\n  "withdraw.open",\n', "\n") });
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines[1], /^BAD the kinds: SIGNPAGE_KINDS missing withdraw\.open; SignpageParams is the twenty-three/);
});

test("recorded bad answer: an event outside the handshake names: FAIL", async () => {
  const r = await check({ read: planted(MESSAGES, '["ready", "state", "progress"]', '["ready", "state", "progress", "down"]') });
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines[2], /^BAD the events \[ready, state, progress, down\] hold a name outside/);
});

test("recorded bad answer: an order record with a `bytes` field: FAIL", async () => {
  const r = await check({ read: planted(RECORD, "  trigger: OrderTrigger;\n", "  trigger: OrderTrigger;\n  bytes: string;\n") });
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines[3], /^BAD the order record: OrderRecord extra bytes; ORDER_RECORD_FIELDS is the twelve/);
});

test("recorded bad answer: an order record with 4 variants: FAIL", async () => {
  const r = await check({ read: planted(RECORD, "| [string, string, string];", "| [string, string, string] | [string, string, string, string];") });
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.equal(r.lines[4], "BAD variants holds 1, 2, 3, 4 signed variants (want 1, 2, 3)");
});

test("recorded bad answer: variants as an unbounded list: FAIL", async () => {
  const r = await check({ read: planted(RECORD, "variants: [string] | [string, string] | [string, string, string];", "variants: string[];") });
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.equal(r.lines[4], "BAD variants is not a tuple of strings (want 1, 2, 3)");
});

test("recorded bad answer: a trigger without its direction: FAIL", async () => {
  const r = await check({ read: planted(RECORD, '  direction: "lte" | "gte";\n', "") });
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines[5], /^BAD OrderTrigger missing direction/);
});

test("recorded answer of GitHub main at the kickoff commit, the empty stub: FAIL", async () => {
  assert.match(ANSWERS.main_kickoff.source, /GitHub UNRLZD\/confidential-trenches main at 88f2d3e/);
  const r = await check({ read: replay(ANSWERS.main_kickoff.files) });
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines[1], /^BAD the kinds: SIGNPAGE_KINDS not found/);
  assert.match(r.lines[3], /^BAD the order record: OrderRecord not found/);
});

test("the CLI on a tree with no kit is an error, exit 2", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "kit-entry-signpage-api.mjs"), "--root", HERE], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /live-check kit-entry-signpage-api: ERROR: packages\/kit\/package\.json: HTTP 404/);
});
