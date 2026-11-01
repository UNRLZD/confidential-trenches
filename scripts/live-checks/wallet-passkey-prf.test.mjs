// node --test scripts/live-checks/wallet-passkey-prf.test.mjs: the live check's verdict on its recorded answers, with
// no browser and no network. good: a real run on the browser harness (SIGN_HOST's real name mapped to its build under
// its own _headers), which passes. bad: the same run on a planted page whose no-PRF branch signs in with a random seed
// without notice (the brief's recorded bad answer), which fails. Round 2's recorded reds: badC6a2fbe, the page as it was
// at c6a2fbe (Sign out shown in a frame, two tabs writing two seeds, no cross-tab sign out, no code_saved false), and
// badNoGuard, a planted page without the "seed already stored" guard (a second tab runs a ceremony). Round 3's: badC46a6fc,
// the page at c46a6fc (Sign out taken by a press with no real input; Sign out drawn for a seed whose 12 words are the only
// copy and not saved).
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { accountOfEntropy, entropyOfPrf, judge, SIGN_HOST } from "./wallet-passkey-prf.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "wallet-passkey-prf.answers.json"), "utf8"));
const clone = (x) => structuredClone(x);
const bad = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  assert.equal(answers.good.prf.credentials[0].rpId, SIGN_HOST);
});

test("the recorded bad answer (no PRF falls back to a random seed without notice) fails on that line only", () => {
  const r = judge(answers.bad);
  assert.equal(r.pass, false);
  assert.deepEqual(bad(answers.bad).map((l) => l.split(" (")[0]), ["BAD no-prf: Create passkey opens the no-PRF path"]);
});

const BAD = (rec) => bad(rec).map((l) => l.split(" (")[0]);

test("round 2's recorded reds fail on their own lines", () => {
  assert.deepEqual(BAD(answers.badC6a2fbe), [
    "BAD prf create: the seed record says code_saved false, the Backup dot shows",
    "BAD prf reload: the seed record says code_saved false, the Backup dot shows",
    "BAD prf signin: the seed record says code_saved false, the Backup dot shows",
    "BAD prf: Sign out in one tab shows signed out in the other",
    "BAD prf: framed by APP_HOST the page shows no sign-in or sign-out control",
    "BAD prf: two tabs that create at once end on one account, the one stored",
    "BAD prf: Sign out ignores a press before any real input, and arms on a pointer move",
    "BAD no-prf: a seed whose 12 words are the only copy and not saved shows no Sign out",
  ]);
  assert.equal(answers.badC6a2fbe.prf.framed.buttons, 1, "c6a2fbe showed Sign out inside APP_HOST's frame");
  // round 3: c46a6fc's Sign out took a press with no real input (and signed out), and was drawn for a seed whose 12
  // words are the only copy
  assert.deepEqual(BAD(answers.badC46a6fc), [
    "BAD prf: Sign out ignores a press before any real input, and arms on a pointer move",
    "BAD no-prf: a seed whose 12 words are the only copy and not saved shows no Sign out",
  ]);
  assert.equal(answers.badC46a6fc.prf.unarmed.after.state, "signed-out", "c46a6fc signed out on a press with no prior input");
  assert.equal(answers.badC46a6fc.noPrf.backupGate.signoutButtons, 1);
  assert.deepEqual(BAD(answers.badNoGuard), ["BAD prf: Create in a second tab with a seed already stored runs no ceremony and keeps the seed"]);
  assert.equal(answers.badNoGuard.prf.guard.credentials, 1, "the guardless page ran a ceremony in the second tab");
});

test("each broken step fails the check", () => {
  const g = answers.good;
  const A = g.prf.steps.create.account;
  const cases = [
    ["a passkey on the parent domain", (r) => (r.prf.credentials = [{ rpId: "confidential.unrealized.trade" }])],
    ["two passkeys", (r) => r.prf.credentials.push({ rpId: SIGN_HOST })],
    ["another account after sign-in", (r) => (r.prf.steps.signin.account = "00".repeat(32))],
    ["a reload that asks again or loses the account", (r) => (r.prf.steps.reload = { state: "signed-out", account: null })],
    ["sign out that keeps the store", (r) => (r.prf.steps.signout.db = true)],
    ["an account that is not T_0 of the PRF output", (r) => (r.prf.expected = "11".repeat(32))],
    ["no PRF output read back", (r) => (r.prf.prfOk = false)],
    ["no-PRF with a seed stored but no account shown", (r) => (r.noPrf.create = { state: "no-prf", account: null, seed: true })],
    ["no-PRF shown as an error", (r) => (r.noPrf.create.state = "error")],
    ["an extractable K_wrap", (r) => (r.prf.steps.create.kWrap.extractable = true)],
    ["no K_wrap", (r) => (r.prf.steps.signin.kWrap = null)],
    ["a seed record stored in the clear", (r) => (r.prf.steps.reload.seedWrapped = false)],
    ["something in localStorage", (r) => (r.prf.steps.signin.localStorage = 1)],
    ["Sign out shown in APP_HOST's frame", (r) => (r.prf.framed.buttons = 1)],
    ["a frame that never loaded", (r) => (r.prf.framed = { framed: null, state: null, buttons: 0, actions: 0 })],
    ["a second tab that ran a ceremony", (r) => (r.prf.guard.credentials = 1)],
    ["a second tab that replaced the seed", (r) => (r.prf.guard.ivAfter = "00".repeat(12))],
    ["two tabs on two accounts", (r) => (r.prf.race.b.account = "22".repeat(32))],
    ["the other tab still signed in after sign out", (r) => (r.prf.crossTab = { state: "signed-in", account: A })],
    ["code_saved true on a new PRF seed", (r) => (r.prf.steps.create.codeSaved = "true")],
    ["Sign out enabled before any real input", (r) => (r.prf.unarmed.disabled = false)],
    ["Sign out taken by a press before any real input", (r) => (r.prf.unarmed.after = { state: "signed-out", account: null })],
    ["Sign out still disabled after a pointer move", (r) => (r.prf.unarmed.disabledAfterMove = true)],
    ["Sign out drawn for a seed whose 12 words are the only copy", (r) => (r.noPrf.backupGate.signoutButtons = 1)],
    ["the planted no-backup seed not shown", (r) => (r.noPrf.backupGate.state = "error")],
    ["a CSP violation", (r) => r.errors.push("console: Refused to load the script")],
    ["an empty record", (r) => Object.keys(r).forEach((k) => delete r[k])],
  ];
  for (const [name, edit] of cases) {
    const r = clone(g);
    edit(r);
    assert.equal(judge(r).pass, false, name);
  }
  assert.match(A, /^[0-9a-f]{64}$/);
});

test("the check's own derivation gives A.8's T_0 for its seed, and wallet.md:47's entropy for a PRF output", () => {
  // A.8's seed is 16 zero bytes: "abandon" eleven times and "about" (BIP-39 list indices 0 and 3)
  const list = Object.assign(new Array(2048).fill("x"), { 0: "abandon", 3: "about" });
  const a8 = JSON.parse(readFileSync(path.join(HERE, "../../packages/wallet/test/vectors/a8.json"), "utf8"));
  const t0 = a8.ids.find((x) => x.name === "T_0");
  assert.equal(accountOfEntropy(Buffer.alloc(16), list), t0.id);
  // HKDF-SHA256(prf, salt "confidential-trenches/v1", info "wallet/entropy", 16): RFC 5869 by HMAC written out here
  const prf = Buffer.alloc(32, 0x11);
  const prk = createHmac("sha256", "confidential-trenches/v1").update(prf).digest();
  const okm = createHmac("sha256", prk).update(Buffer.concat([Buffer.from("wallet/entropy"), Buffer.of(1)])).digest().subarray(0, 16);
  assert.equal(entropyOfPrf(prf).toString("hex"), okm.toString("hex"));
});
