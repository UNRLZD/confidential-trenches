// node --test packages/kit/test/prover/build.test.mjs: prover-worker.js is the pinned snarkjs build byte for byte, then
// the worker's own code with the kit's setup-file pins and prover-thread.js's pin; it loads no other script and makes
// no worker but the pinned thread file; prover-thread.js is snarkjs's own thread code byte for byte; a snarkjs build or
// thread code with one byte changed is refused. The worker in a real browser: chromium.e2e.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildProverThread,
  buildProverWorker,
  HEADER,
  PROVER_THREAD_FILE,
  proverThreadSource,
  proverWorkerSource,
  snarkjsBuildPath,
  SNARKJS_BUILD,
  SNARKJS_THREAD,
  THREAD_HEADER,
  threadCode,
} from "../../src/prover/build.mjs";
import { ZK_SETUP_FILES } from "../../src/zk/setup-files.ts";

test("prover-worker.js = GPL header + pinned snarkjs.min.js + worker.js with the kit's pins", () => {
  const out = mkdtempSync(join(tmpdir(), "kit-prover-"));
  const r = buildProverWorker(out);
  const file = readFileSync(r.file);
  assert.equal(r.bytes, file.length);
  assert.equal(r.sha256, createHash("sha256").update(file).digest("hex"));
  const head = HEADER.map((l) => `// ${l}\n`).join("");
  assert.equal(file.subarray(0, head.length).toString(), head);
  assert.match(head, /^\/\/ SPDX-License-Identifier: GPL-3\.0-or-later\n/);
  assert.match(head, /Copyright 2018 0KIMS association/);
  const nl = head.length - 1;
  const sj = file.subarray(nl + 1, nl + 1 + SNARKJS_BUILD.bytes);
  assert.equal(createHash("sha256").update(sj).digest("hex"), SNARKJS_BUILD.sha256);
  const body = file.subarray(nl + 1 + SNARKJS_BUILD.bytes).toString();
  const pins = JSON.parse(body.match(/const PINS = (\{.*?\});/)[1]);
  assert.deepEqual(Object.keys(pins).sort(), Object.keys(ZK_SETUP_FILES).sort());
  for (const [name, p] of Object.entries(ZK_SETUP_FILES)) assert.deepEqual(pins[name], { bytes: p.bytes, sha256: p.sha256 });
  assert.ok(!body.includes("/*@PINS@*/"));
  // the thread file's path (its bytes rest on the deploy gate's compare and the live check's pin read)
  assert.deepEqual(JSON.parse(body.match(/const THREAD = (\{.*?\});/)[1]), { path: `/${PROVER_THREAD_FILE}` });
  assert.ok(!body.includes("/*@THREAD@*/"));
  // no script loaded at run time, no eval; the one worker it makes is the pinned thread file, never snarkjs's own
  const code = body.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  for (const bad of [/importScripts\s*\(/, /new\s+(Shared)?Worker\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /\bimport\s*\(/])
    assert.doesNotMatch(code, bad);
  assert.deepEqual(code.match(/new\s+\w*Worker\s*\([^)]*\)/g), ['new NativeWorker(threadURL, { name: "prover-thread" })']);
  assert.match(code, /fullProve\(m\.input, c\.wasm, c\.zkey, undefined, undefined, \{ singleThread: !threaded \}\)/);
});

test("prover-thread.js = GPL header + snarkjs's own thread code, byte for byte", () => {
  const out = mkdtempSync(join(tmpdir(), "kit-prover-"));
  const r = buildProverThread(out);
  const file = readFileSync(r.file);
  assert.equal(r.sha256, createHash("sha256").update(file).digest("hex"));
  const head = THREAD_HEADER.map((l) => `// ${l}\n`).join("");
  assert.equal(file.subarray(0, head.length).toString(), head);
  assert.match(head, /^\/\/ SPDX-License-Identifier: GPL-3\.0-or-later\n/);
  const code = file.subarray(head.length);
  assert.equal(code.length, SNARKJS_THREAD.bytes);
  assert.equal(createHash("sha256").update(code).digest("hex"), SNARKJS_THREAD.sha256);
  // exactly the text snarkjs.min.js turns into its thread workers' blob: URL (both copies in the bundle)
  const sj = readFileSync(snarkjsBuildPath(), "utf8");
  const lits = [...sj.matchAll(/const (\w+)='(\(function thread\(self\) \{.*?\}\)\(self\))';/gs)];
  assert.equal(lits.length, 2);
  for (const [, , lit] of lits) assert.equal(lit.replaceAll("\\n", "\n"), code.toString());
  assert.match(code.toString(), /^\(function thread\(self\) \{\n/);
  assert.doesNotMatch(code.toString(), /importScripts|\bfetch\b|XMLHttpRequest|\beval\b|Function\(|Worker|WebSocket/);
});

test("thread code that is not the pinned one is refused", () => {
  const sj = readFileSync(snarkjsBuildPath());
  const at = sj.indexOf("const MAXMEM = 32767;");
  const one = Buffer.from(sj);
  one[at + 6] ^= 1; // the first copy changed
  assert.throws(() => threadCode(one), /two different thread codes/);
  const both = Buffer.from(one);
  const second = sj.indexOf("const MAXMEM = 32767;", at + 1);
  both[second + 6] ^= 1;
  assert.throws(() => threadCode(both), /thread code sha256 [0-9a-f]{64}, pinned 81680ca6/);
  assert.throws(() => threadCode(Buffer.from("var x=1;")), /holds no thread code/);
  assert.equal(threadCode(sj).length, SNARKJS_THREAD.bytes);
});

test("a snarkjs.min.js with one byte changed is refused", () => {
  const sj = readFileSync(snarkjsBuildPath());
  sj[1000] ^= 1;
  const f = join(mkdtempSync(join(tmpdir(), "kit-prover-")), "snarkjs.min.js");
  writeFileSync(f, sj);
  assert.throws(() => proverWorkerSource({ snarkjsPath: f }), /snarkjs\.min\.js sha256 [0-9a-f]{64}, pinned 3bf5b512/);
  writeFileSync(f, sj.subarray(1));
  assert.throws(() => proverWorkerSource({ snarkjsPath: f }), /snarkjs\.min\.js is 710895 B, pinned 710896 B/);
});
