// node --test scripts/live-checks/kit-freeze-vault.test.mjs: the live check replays recorded answers
// (kit-freeze-vault.answers.json, each file an array of its lines). The good answer is shapes.ts and vault-v1.json as
// the card merges them: PASS. Each bad answer is the good one with one exact edit: FAIL. One more bad answer is made
// here from the first edit: the swapped context order with vectors that the swapped code made itself, so the two files
// agree with each other and only the check's own encoders catch them. Last, files that try to escape the sandbox,
// stop it early or forge its verdict: FAIL, with nothing written; and a file that refuses to load when it sees any
// variable of this process's: PASS, since the child gets an empty environment. Pins per ref: the tag kit-v1's files as
// GitHub serves them (good["kit-v1"]) PASS on kit-v1's own pins, main's on the new ones, and each FAILS on the other's.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, checkFiles, fromLines, keccak256, load, MOVED_SINCE_KIT_V1, PINNED, pinsFor, R01_CALL, read } from "./kit-freeze-vault.mjs";

process.removeAllListeners("warning"); // stripTypeScriptTypes is marked experimental
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "kit-freeze-vault.answers.json"), "utf8"));
const GOOD = fromLines(A.good).main;
const edited = (b) => ({ ...GOOD, [b.file]: GOOD[b.file].replace(b.from, b.to) });
const bad = (name) => {
  const b = A.bad.find((x) => x.name === name);
  assert.ok(b, name);
  return b;
};

// keccak-256 of 200 'a's (two 136-byte blocks), by OpenSSL 3.5.9's keccak-256 (Homebrew Node 24.22.1, 2026-11-01)
const A200 = "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d";

test("the check's Keccak-256: Keccak's published answers for '' and 'abc', OpenSSL's for 200 'a's", () => {
  const hex = (s) => Buffer.from(keccak256(Buffer.from(s))).toString("hex");
  assert.equal(hex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(hex("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(hex("a".repeat(200)), A200);
});

test("each bad edit applies to exactly one place in the good answer", () => {
  assert.equal(A.bad.length, 19);
  for (const b of A.bad) assert.equal(GOOD[b.file].split(b.from).length - 1, 1, b.name);
});

test("recorded good answer: PASS, every line ok", async () => {
  const r = await check({ refs: ["main"], files: { main: GOOD } });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(r.lines.map((l) => l.slice(0, 10)), Array(4).fill("main: ok  "));
  assert.match(r.lines[1], /25 data exports equal the paper's values$/);
  assert.match(r.lines[2], /every function behaves as the paper says$/);
  assert.match(r.lines[3], /8 scope, 10 label and 32 context vectors recompute/);
});

// each recorded bad answer, the line it fails on and what that line names
const CASES = [
  ["recipient and fee_recipient swapped in the context order", 1, /differ: VAULT_CONTEXT_FIELDS/],
  ["a third deposit-message field", 1, /differ: VAULT_DEPOSIT_MESSAGE_FIELDS/],
  ["ft_withdraw named as R's carrier", 1, /differ: VAULT_DEPOSIT_SIGNERS/],
  ["ft_withdraw named as V's carrier", 1, /differ: VAULT_DEPOSIT_SIGNERS/],
  ["vaultContextInput reads recipient from fee_recipient", 3, /vaultContextInput reads the request to other bytes/],
  ["vaultFieldOf reads the digest little-endian", 2, /not: vaultFieldOf reads big-endian, mod p/],
  ["MAX_RELAY_FEE_BPS 500", 1, /differ: VAULT_CONSTANTS/],
  ["carrier gas 100 Tgas", 1, /differ: VAULT_DEPOSIT_CARRIER, VAULT_DEPOSIT_SIGNERS/],
  ["carrier deposit 0 yocto", 1, /differ: VAULT_DEPOSIT_CARRIER, VAULT_DEPOSIT_SIGNERS/],
  ["TOKEN changed", 1, /differ: VAULT_CONSTANTS/],
  ["the 389-byte reserve dropped from the withdraw attachment", 2, /not: vaultWithdrawYocto/],
  ["the backstop multiplier changed", 2, /not: vaultRelayFeeWithinBackstop/],
  ["an event field dropped", 1, /differ: VAULT_EVENTS/],
  // the file changes a builtin to hide its own edit: the child only reports, this process compares
  ["a third deposit-message field, with Array.prototype.every always true", 1, /differ: VAULT_DEPOSIT_MESSAGE_FIELDS/],
  ["a third deposit-message field, with JSON.stringify hiding it", 1, /differ: VAULT_DEPOSIT_MESSAGE_FIELDS/],
  ["a third deposit-message field, with Object.prototype.toJSON hiding it", 1, /differ: VAULT_DEPOSIT_MESSAGE_FIELDS/],
  ["the depositor check loosened to upper case", 2, /not: vaultDepositMessage refuses a depositor not lowercase 64-hex/],
  ["a third deposit-message field, with process.stdout._write stripping it from the report", 1, /differ: VAULT_DEPOSIT_MESSAGE_FIELDS/],
  ["a line printed on load", 0, /the sandboxed child gave one report \(printed 2 line\(s\)/],
];
for (const [name, line, why] of CASES) {
  test(`recorded bad answer, ${name}: FAIL`, async () => {
    const r = await checkFiles(edited(bad(name)));
    assert.equal(r.ok, false, r.lines.join("\n"));
    assert.match(r.lines[line], /^BAD /);
    assert.match(r.lines[line], why);
  });
}

test("bad answer, the swapped order with vectors the swapped code made itself: FAIL on the check's own bytes", async () => {
  const files = edited(bad("recipient and fee_recipient swapped in the context order"));
  const S = await load(files.shapes);
  const keccak = (b) => Buffer.from(keccak256(b));
  const V = JSON.parse(files.vectors);
  for (const v of V.context) {
    const n = Object.fromEntries(Object.entries(v.input).map(([k, x]) => [k, /^(register_deposit|relay_fee|refund_precommitment|deadline_ms)$/.test(k) ? BigInt(x) : x]));
    const pre = S.vaultContextPreimage(n, BigInt(v.scope));
    v.preimage_hex = Buffer.from(pre).toString("hex");
    v.keccak_hex = keccak(pre).toString("hex");
    v.context = S.vaultFieldOf(keccak(pre)).toString();
  }
  const r = await checkFiles({ ...files, vectors: JSON.stringify(V) });
  assert.equal(r.ok, false);
  assert.match(r.lines[3], /^BAD .*context 1 does not recompute/);
});

test("pins per ref: kit-v1 PASSES on its own frozen values and main on the new ones; each read against the other's pins FAILS", async () => {
  const TAG = fromLines(A.good)["kit-v1"];
  const r = await check({ refs: ["main", "kit-v1"], files: { main: GOOD, "kit-v1": TAG } });
  assert.equal(r.ok, true, r.lines.filter((l) => / BAD /.test(l)).join("\n"));
  // main's files held to kit-v1's pins: on_payout's two results, P = 0 written and the 710 and 475 B are gone (A-01,
  // R-01, card vault-refund-precommit-reserve)
  const mainAsTag = await checkFiles(GOOD, "kit-v1");
  assert.equal(mainAsTag.ok, false);
  assert.ok(mainAsTag.lines.some((l) => /^BAD .*differ: VAULT_WITHDRAW, VAULT_ON_PAYOUT, VAULT_RAGEQUIT$/.test(l)), mainAsTag.lines.join("\n"));
  assert.ok(mainAsTag.lines.some((l) => /^BAD .*not: .*vaultWithdrawYocto; vaultRagequitYocto/.test(l)), mainAsTag.lines.join("\n"));
  assert.ok(mainAsTag.lines.some((l) => /^BAD .*vaultDepositMessage writes 0, as kit-v1 froze it/.test(l)), mainAsTag.lines.join("\n"));
  // kit-v1's files held to main's pins
  const tagAsMain = await checkFiles(TAG, "main");
  assert.equal(tagAsMain.ok, false);
  assert.ok(tagAsMain.lines.some((l) => /^BAD .*differ: VAULT_WITHDRAW, VAULT_ON_PAYOUT, VAULT_RAGEQUIT$/.test(l)), tagAsMain.lines.join("\n"));
  assert.ok(tagAsMain.lines.some((l) => /^BAD .*not: .*vaultWithdrawYocto; vaultRagequitYocto/.test(l)), tagAsMain.lines.join("\n"));
  assert.ok(tagAsMain.lines.some((l) => new RegExp(`^BAD .*${R01_CALL.replace(/[()]/g, "\\$&")}`).test(l)), tagAsMain.lines.join("\n"));
  // every moved pin names its review item or card, and kit-v1's pins differ from main's only there
  for (const m of Object.values(MOVED_SINCE_KIT_V1)) assert.ok(/^[A-Z]-\d\d$/.test(m.review ?? "") || /^[a-z0-9-]+$/.test(m.card ?? ""), JSON.stringify(m));
  assert.deepEqual(Object.keys(pinsFor("kit-v1")).filter((k) => JSON.stringify(pinsFor("kit-v1")[k]) !== JSON.stringify(PINNED[k])), Object.keys(MOVED_SINCE_KIT_V1));
});

test("main good but the tag bad: FAIL; a shapes.ts with a static import: FAIL", async () => {
  const r = await check({ refs: ["main", "kit-v1"], files: { main: GOOD, "kit-v1": edited(bad("a third deposit-message field")) } });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("kit-v1: BAD ")));
  const i = await checkFiles({ ...GOOD, shapes: `import { x } from "./x.ts";\n${GOOD.shapes}` });
  assert.equal(i.ok, false);
  assert.match(i.lines[0], /^BAD shapes\.ts loads as one module: shapes\.ts imports another module$/);
});

test("the sandbox: a file write, a child process, an early exit(0) and a forged PASS all FAIL, and nothing is written", async () => {
  const out = path.join(tmpdir(), `kfv-escape-${process.pid}`);
  rmSync(out, { force: true });
  const tries = [
    `const fs = process.getBuiltinModule("node:fs"); fs.writeFileSync(${JSON.stringify(out)}, "x");`,
    `const os = await import("node:os"); process.getBuiltinModule("node:child_process").execSync("true");`,
    `process.exit(0);`,
    `console.log("PASS"); process.stdout.write("deadbeef PASS\\n"); process.exit(0);`,
  ];
  for (const t of tries) {
    const r = await checkFiles({ ...GOOD, shapes: `${GOOD.shapes}\n${t}\n` });
    assert.equal(r.ok, false, t);
    assert.ok(r.lines.some((l) => l.startsWith("BAD ")), `${t}\n${r.lines.join("\n")}`);
  }
  assert.equal(existsSync(out), false);
});

test("the child sees no variable of this process's: a file that refuses to load when it sees one PASSES", async () => {
  // this process holds a variable the child must not see; only names are counted, no value is ever printed
  process.env.KFV_PROBE = "visible";
  try {
    const refuse = `const seenNames = Object.keys(process.env).filter((n) => n !== "__CF_USER_TEXT_ENCODING");
if (seenNames.length) throw new Error("sees " + seenNames.length + " variable(s)");`;
    const r = await checkFiles({ ...GOOD, shapes: `${GOOD.shapes}\n${refuse}\n` });
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.match(r.lines[0], /in a child that sees 0 environment variable\(s\) of this process's$/);
  } finally {
    delete process.env.KFV_PROBE;
  }
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
