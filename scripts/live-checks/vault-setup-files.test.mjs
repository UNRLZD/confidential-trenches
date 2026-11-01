// node --test scripts/live-checks/vault-setup-files.test.mjs: the live check's verdict replays recorded runs
// (vault-setup-files.answers.json), each read on 2026-11-01 by vault-setup-files.mjs --base --record from a local Node
// server of a tree, before the card merged (the read of GitHub at main lands after the merge):
//   good:       card/vault-setup-files's tree, its six files fetched from privacy-pools-core c312dcd: PASS;
//   badOneByte: the same files with one byte of withdraw.zkey changed (offset 1,000,000, xor 0x01), same size: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, LICENCES, PINS, SOURCE_COMMIT } from "./vault-setup-files.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "vault-setup-files.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec.reads[0]);
  return judge(rec);
};

test("recorded good answer: the six files, the licence texts, the NOTICE and the kit's constants equal the pins: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const [name, bytes] of [...PINS, ...LICENCES]) assert.ok(r.lines.some((l) => l.startsWith("ok ") && l.includes(` ${name}: ${bytes} B, sha256 `)), name);
  assert.ok(r.lines.some((l) => /^ok  .* kit constants: the six sizes and hashes and the source commit equal the pins$/.test(l)));
});

test("recorded bad answer: one byte of withdraw.zkey changed, same size: FAIL on its sha256 only", () => {
  const r = judge(ANSWERS.badOneByte);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.equal(b.length, 1, b.join("\n"));
  assert.match(b[0], /withdraw\.zkey: sha256 [0-9a-f]{64}, pinned 2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677$/);
});

test("planted on the good answer: a missing file, a wrong size, a NOTICE without GPL-3.0, a constants hash that differs: FAIL", () => {
  let r = mut((t) => (t.files = t.files.filter((f) => f.name !== "commitment.vkey")));
  assert.ok(bad(r.lines).some((l) => /commitment\.vkey: not served \(not read\)$/.test(l)));
  r = mut((t) => (t.files.find((f) => f.name === "withdraw.wasm").status = 404));
  assert.ok(bad(r.lines).some((l) => /withdraw\.wasm: not served \(HTTP 404\)$/.test(l)));
  r = mut((t) => (t.files.find((f) => f.name === "commitment.zkey").bytes = 901232));
  assert.ok(bad(r.lines).some((l) => /commitment\.zkey: 901232 B, pinned 901233 B$/.test(l)));
  r = mut((t) => (t.notice.text = t.notice.text.replaceAll("GPL-3.0", "MIT")));
  assert.ok(bad(r.lines).some((l) => /NOTICE: missing GPL-3\.0, LGPL-3\.0$/.test(l)));
  r = mut((t) => (t.constants.text = t.constants.text.replace("36cda22791de", "36cda22791df")));
  assert.ok(bad(r.lines).some((l) => /kit constants: withdraw\.wasm 2607967 B 36cda22791df/.test(l)));
  r = mut((t) => (t.constants.text = t.constants.text.replace(SOURCE_COMMIT, "0".repeat(40))));
  assert.ok(bad(r.lines).some((l) => /kit constants: source commit differs$/.test(l)));
  r = mut((t) => (t.constants = { status: 404, text: null }));
  assert.ok(bad(r.lines).some((l) => /kit constants: not served \(HTTP 404\)$/.test(l)));
  assert.equal(judge({ reads: [] }).ok, false);
});
