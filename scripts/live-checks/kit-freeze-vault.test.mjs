// node --test scripts/live-checks/kit-freeze-vault.test.mjs: the live check replays recorded answers
// (kit-freeze-vault.answers.json). The good answer is shapes.ts and vault-v1.json as the card merges them: PASS. Each
// bad answer is the good one with one exact edit: FAIL. One more bad answer is made here from the first edit: the
// swapped context order with vectors that the swapped code made itself, so the two files agree with each other and
// only the check's own encoders catch them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, checkFiles, keccak256, load, read } from "./kit-freeze-vault.mjs";

process.removeAllListeners("warning"); // stripTypeScriptTypes is marked experimental
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "kit-freeze-vault.answers.json"), "utf8"));
const GOOD = A.good.main;
const edited = (b) => ({ ...GOOD, [b.file]: GOOD[b.file].replace(b.from, b.to) });
const bad = (name) => A.bad.find((b) => b.name === name);

// keccak-256 of 200 'a's (two 136-byte blocks), by OpenSSL 3.5.9's keccak-256 (Homebrew Node 24.22.1, 2026-11-01)
const A200 = "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d";

test("the check's Keccak-256: Keccak's published answers for '' and 'abc', OpenSSL's for 200 'a's", () => {
  const hex = (s) => Buffer.from(keccak256(Buffer.from(s))).toString("hex");
  assert.equal(hex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(hex("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(hex("a".repeat(200)), A200);
});

test("each bad edit applies to exactly one place in the good answer", () => {
  assert.equal(A.bad.length, 5);
  for (const b of A.bad) assert.equal(GOOD[b.file].split(b.from).length - 1, 1, b.name);
});

test("recorded good answer: PASS, every line ok", async () => {
  const r = await check({ refs: ["main"], files: { main: GOOD } });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(r.lines.map((l) => l.slice(0, 10)), Array(6).fill("main: ok  "));
  assert.match(r.lines[1], /exactly two fields: DEPOSIT_MESSAGE_FIELDS \["precommitment","depositor"\], depositMessage\(\) writes \["precommitment","depositor"\]$/);
  assert.match(r.lines[2], /U ft_transfer_call on TOKEN; R ft_transfer_call on TOKEN; V ft_transfer_call on TOKEN; shapes that sign an ft_withdraw: none$/);
  assert.match(r.lines[5], /8 scope, 10 label and 32 context vectors recompute/);
});

test("recorded bad answer, recipient and fee_recipient swapped in the context order: FAIL", async () => {
  const r = await checkFiles(edited(bad("recipient and fee_recipient swapped in the context order")));
  assert.equal(r.ok, false);
  assert.match(r.lines[4], /^BAD the context order in shapes\.ts: \["processor","fee_recipient","register_deposit","recipient"/);
  assert.match(r.lines[5], /^BAD .*context 1: shapes\.ts makes other bytes/);
});

test("bad answer, the swapped order with vectors the swapped code made itself: FAIL on the check's own bytes", async () => {
  const files = edited(bad("recipient and fee_recipient swapped in the context order"));
  const S = await load(files.shapes);
  const keccak = (b) => Buffer.from(keccak256(b));
  const V = JSON.parse(files.vectors);
  for (const v of V.context) {
    const n = Object.fromEntries(Object.entries(v.input).map(([k, x]) => [k, /^(register_deposit|relay_fee|refund_precommitment|deadline_ms)$/.test(k) ? BigInt(x) : x]));
    const pre = S.contextPreimage(n, BigInt(v.scope));
    v.preimage_hex = Buffer.from(pre).toString("hex");
    v.keccak_hex = keccak(pre).toString("hex");
    v.context = S.fieldOf(keccak(pre)).toString();
  }
  const r = await checkFiles({ ...files, vectors: JSON.stringify(V) });
  assert.equal(r.ok, false);
  assert.match(r.lines[5], /^BAD .*context 1 does not recompute/);
});

test("recorded bad answer, a third deposit-message field: FAIL", async () => {
  const r = await checkFiles(edited(bad("a third deposit-message field")));
  assert.equal(r.ok, false);
  assert.match(r.lines[1], /^BAD the deposit message has exactly two fields: DEPOSIT_MESSAGE_FIELDS \["precommitment","depositor","refund_to"\]/);
});

test("recorded bad answers, ft_withdraw named as R's or V's carrier: FAIL", async () => {
  for (const [name, id] of [["ft_withdraw named as R's carrier", "R"], ["ft_withdraw named as V's carrier", "V"]]) {
    const r = await checkFiles(edited(bad(name)));
    assert.equal(r.ok, false, name);
    assert.match(r.lines[2], new RegExp(`^BAD the carrier: .*${id} ft_withdraw on intents\\.near; .*shapes that sign an ft_withdraw: DEPOSIT_SIGNERS$`), name);
  }
});

test("recorded bad answer, a setup-file sha256 changed: FAIL", async () => {
  const r = await checkFiles(edited(bad("a setup-file sha256 changed")));
  assert.equal(r.ok, false);
  assert.match(r.lines[3], /^BAD the six setup-file sha256 values equal vault\.md 2\.6; differ: trusted-setup\/final-keys\/withdraw\.zkey$/);
});

test("main good but the tag bad: FAIL; a shapes.ts that imports another module: FAIL", async () => {
  const r = await check({ refs: ["main", "kit-v1"], files: { main: GOOD, "kit-v1": edited(bad("a third deposit-message field")) } });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("kit-v1: BAD the deposit message")));
  const i = await checkFiles({ ...GOOD, shapes: `import { x } from "./x.ts";\n${GOOD.shapes}` });
  assert.equal(i.ok, false);
  assert.match(i.lines[0], /^BAD shapes\.ts loads as one module: shapes\.ts imports another module$/);
});

test("read() asks GitHub for the two files at the ref and refuses a missing one", async () => {
  const asked = [];
  const ok = await read("main", async (url) => (asked.push(url), { ok: true, status: 200, text: async () => "x" }));
  assert.deepEqual(asked, [
    "https://raw.githubusercontent.com/UNRLZD/confidential-trenches/main/packages/kit/src/vault/shapes.ts",
    "https://raw.githubusercontent.com/UNRLZD/confidential-trenches/main/packages/kit/test/vectors/vault-v1.json",
  ]);
  assert.deepEqual(ok, { shapes: "x", vectors: "x" });
  await assert.rejects(read("kit-v1", async () => ({ ok: false, status: 404, text: async () => "" })), /HTTP 404/);
});
