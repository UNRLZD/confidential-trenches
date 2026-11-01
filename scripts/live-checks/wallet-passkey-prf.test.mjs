// node --test scripts/live-checks/wallet-passkey-prf.test.mjs: the live check's verdict on its recorded answers, with
// no browser and no network. good: a real run on the browser harness (SIGN_HOST's real name mapped to its build under
// its own _headers), which passes. bad: the same run on a planted page whose no-PRF branch signs in with a random seed
// without notice (the brief's recorded bad answer), which fails. Round 2's recorded reds: badC6a2fbe, the page as it was
// at c6a2fbe (Sign out shown in a frame, two tabs writing two seeds, no cross-tab sign out, no code_saved false), and
// badNoGuard, a planted page without the "seed already stored" guard (a second tab runs a ceremony). Round 3's: badC46a6fc,
// the page at c46a6fc (Sign out taken by a press with no real input; Sign out drawn for a seed whose 12 words are the only
// copy and not saved). Round 4's: bad23f373f, the page at 23f373f (Sign out armed by a pointer move: a moving press and
// Tab then Enter within 500 ms of the page shown sign out, a finger's tap with drift signs out in the same tap, a still
// tap never signs out), and badNoListeners, a planted page without the guard's pageshow, focus and visibilitychange
// listeners (a press right after each signs out). Round 5's: bad265ad22, the page at 265ad22 (a burst's second click
// within 500 ms of the first and a repeated Enter sign out). Records made before round 4 hold no guard or phone steps
// (prf.protect, phone), records made before the trigger steps (bad23f373f and older) hold no prf.triggers, and records
// made before round 5 hold no prf.burst or prf.repeat: those steps' lines are BAD on them for that reason, checked as
// such below. Card wallet-typed-words: good re-recorded with the no-PRF run's backup, Saved and typed-words steps;
// bad18cd57a, the page at 18cd57a (no-PRF Create stores nothing and opens no backup; no typed words), fails on those five
// lines only; bad3fd742b, the card's page at 3fd742b (Saved without the activation guard), fails on the early Saved
// press only. Every record before it fails those four lines for that reason (its no-PRF Create was right then), checked
// as such below.
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

const BAD = (rec) => bad(rec).map((l) => l.split(" (")[0]);
// card wallet-typed-words' steps: a record made before it fails each (the no-PRF Create then opened no backup)
const TW = [
  "BAD no-prf: Create passkey stores a random seed and opens the backup screen with its 12 words",
  "BAD no-prf: a press on Saved within 500 ms of it drawn does nothing",
  "BAD no-prf: Saved signs in as the same account with code_saved true and Sign out drawn",
  "BAD no-prf: typed words that fail the checksum show Invalid code and store nothing",
  "BAD no-prf: the typed 12 words of A.8's seed sign in as its T_0 with code_saved true",
];
// a record made before wallet-typed-words: its five lines are all BAD, and the rest is returned
function beforeTW(rec) {
  assert.equal(rec.noPrf.typed, undefined);
  const lines = BAD(rec);
  for (const l of TW) assert.ok(lines.includes(l), l);
  return lines.filter((l) => !TW.includes(l));
}
// round 5's steps, which records made before round 5 do not hold
const R5 = [
  "BAD prf: a burst's second click, past 500 ms from Sign out drawn and within 500 ms of the first, does nothing",
  "BAD prf: a repeated Enter on a focused Sign out does nothing",
];
// a record made before round 5: its round 5 lines are both BAD (not recorded), and the rest is returned
function beforeR5(rec) {
  assert.equal(rec.prf.burst, undefined);
  assert.equal(rec.prf.repeat, undefined);
  const lines = beforeTW(rec);
  for (const l of R5) assert.ok(lines.includes(l), l);
  return lines.filter((l) => !R5.includes(l));
}
// round 4's steps, which records made before round 4 do not hold
const TRIGGERS = ["visibilitychange", "pageshow", "focus"].map((k) => `BAD prf: a press within 500 ms after ${k} does nothing`);
// a record made before the trigger steps: their lines are all BAD (not recorded), and the rest is returned
function beforeTriggers(rec) {
  assert.equal(rec.prf.triggers, undefined);
  const lines = beforeR5(rec);
  for (const l of TRIGGERS) assert.ok(lines.includes(l), l);
  return lines.filter((l) => !TRIGGERS.includes(l));
}
const R4 = [
  "BAD prf: a mouse press within 500 ms of Sign out shown does nothing",
  "BAD prf: Tab then Enter within 500 ms of Sign out shown does nothing",
  "BAD phone: Create passkey signs in by a tap",
  "BAD phone: a tap within 500 ms of Sign out shown does nothing",
  "BAD phone: a still tap after 500 ms signs out",
];
// an old record's own lines: its round 4 lines are all BAD (not recorded), and the rest is returned
function beforeR4(rec) {
  assert.equal(rec.prf.protect, undefined);
  assert.equal(rec.phone, undefined);
  const lines = beforeTriggers(rec);
  for (const l of R4) assert.ok(lines.includes(l), l);
  return lines.filter((l) => !R4.includes(l));
}

test("the recorded bad answer (no PRF falls back to a random seed without notice) fails on that line", () => {
  const r = judge(answers.bad);
  assert.equal(r.pass, false);
  assert.deepEqual(beforeR4(answers.bad), []);
  // its no-PRF Create signed in on a random seed with no backup screen: the create line, which beforeTW asserts BAD
  assert.equal(answers.bad.noPrf.create.state, "signed-in");
  assert.equal(answers.bad.noPrf.create.seed, true);
});

test("card wallet-typed-words' recorded red (the page at 18cd57a) fails on its five no-PRF lines only", () => {
  const r = answers.bad18cd57a;
  assert.equal(judge(r).pass, false);
  assert.deepEqual(BAD(r), TW);
  // Create with no PRF stored nothing and stayed on the no-PRF notice; there was no Recovery code to type into
  assert.deepEqual([r.noPrf.create.state, r.noPrf.create.seed, r.noPrf.create.words], ["no-prf", false, 0]);
  assert.equal(r.noPrf.invalid.noInput, true);
  assert.equal(r.noPrf.typed.noInput, true);
});

test("card wallet-typed-words' red at 3fd742b (Saved with no activation guard) fails on the early Saved press only", () => {
  const r = answers.bad3fd742b;
  assert.deepEqual(BAD(r), ["BAD no-prf: a press on Saved within 500 ms of it drawn does nothing"]);
  // the press reached Saved inside the window and marked the words saved
  assert.ok(r.noPrf.savedEarly.withinMs < 500 && r.noPrf.savedEarly.pressOn === "saved");
  assert.deepEqual([r.noPrf.savedEarly.after.state, r.noPrf.savedEarly.after.codeSaved], ["signed-in", "true"]);
});

test("round 2's recorded reds fail on their own lines", () => {
  assert.deepEqual(beforeR4(answers.badC6a2fbe), [
    "BAD prf create: the seed record says code_saved false, the Backup dot shows",
    "BAD prf reload: the seed record says code_saved false, the Backup dot shows",
    "BAD prf signin: the seed record says code_saved false, the Backup dot shows",
    "BAD prf: Sign out in one tab shows signed out in the other",
    "BAD prf: framed by APP_HOST the page shows no sign-in or sign-out control",
    "BAD prf: two tabs that create at once end on one account, the one stored",
    "BAD no-prf: a seed whose 12 words are the only copy and not saved shows no Sign out",
  ]);
  assert.equal(answers.badC6a2fbe.prf.framed.buttons, 1, "c6a2fbe showed Sign out inside APP_HOST's frame");
  // round 3: c46a6fc's Sign out took a press with no real input (and signed out), and was drawn for a seed whose 12
  // words are the only copy
  assert.deepEqual(beforeR4(answers.badC46a6fc), ["BAD no-prf: a seed whose 12 words are the only copy and not saved shows no Sign out"]);
  assert.equal(answers.badC46a6fc.prf.unarmed.after.state, "signed-out", "c46a6fc signed out on a press with no prior input");
  assert.equal(answers.badC46a6fc.noPrf.backupGate.signoutButtons, 1);
  assert.deepEqual(beforeR4(answers.badNoGuard), ["BAD prf: Create in a second tab with a seed already stored runs no ceremony and keeps the seed"]);
  assert.equal(answers.badNoGuard.prf.guard.credentials, 1, "the guardless page ran a ceremony in the second tab");
});

test("round 4's recorded red (the page at 23f373f) fails on each guard step and on the still tap", () => {
  const r = answers.bad23f373f;
  assert.deepEqual(beforeTriggers(r), [
    "BAD prf: a mouse press within 500 ms of Sign out shown does nothing",
    "BAD prf: Tab then Enter within 500 ms of Sign out shown does nothing",
    "BAD phone: a tap within 500 ms of Sign out shown does nothing",
    "BAD phone: a still tap after 500 ms signs out",
  ]);
  // each early press landed inside the window and signed out; the still tap after it did nothing
  for (const t of [r.prf.protect.mouse, r.prf.protect.enter, r.phone.tap]) {
    assert.ok(t.withinMs < 500, `${t.withinMs}`);
    assert.equal(t.after.state, "signed-out");
  }
  assert.ok(r.phone.still.withinMs >= 500);
  assert.equal(r.phone.still.after.state, "signed-in");
});

test("the planted page without the guard's pageshow, focus and visibilitychange listeners fails on each trigger only", () => {
  const r = answers.badNoListeners;
  assert.deepEqual(beforeR5(r), TRIGGERS);
  for (const k of ["visibilitychange", "pageshow", "focus"]) {
    const t = r.prf.triggers[k];
    assert.ok(t.withinMs < 500 && t.sinceDrawMs >= 500 && t.pressOn === "signout", k);
    assert.equal(t.after.state, "signed-out", k);
  }
});

test("round 5's recorded red (the page at 265ad22) fails on the burst and the repeated Enter only", () => {
  const r = answers.bad265ad22;
  assert.deepEqual(beforeTW(r), R5);
  // the burst's second click came past 500 ms from the draw and within 500 ms of the first, and signed out
  assert.ok(r.prf.burst.firstMs < 500 && r.prf.burst.secondMs >= 500 && r.prf.burst.gapMs < 500, JSON.stringify(r.prf.burst));
  assert.equal(r.prf.burst.after.state, "signed-out");
  // the repeated Enter came with no other input in the 500 ms before it, past the draw window, and signed out
  assert.equal(r.prf.repeat.repeat, true);
  assert.ok(r.prf.repeat.sinceDrawMs >= 500 && (r.prf.repeat.sincePrevMs === null || r.prf.repeat.sincePrevMs >= 500));
  assert.equal(r.prf.repeat.after.state, "signed-out");
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
    ["no-PRF shown as an error", (r) => (r.noPrf.create.state = "error")],
    ["no-PRF Create that stores no seed", (r) => (r.noPrf.create.seed = false)],
    ["no-PRF Create that signs in without the backup screen", (r) => (r.noPrf.create.state = "signed-in")],
    ["no-PRF Create that stays on the no-PRF notice", (r) => (r.noPrf.create = { state: "no-prf", account: null, seed: false })],
    ["a new no-PRF seed already marked saved", (r) => (r.noPrf.create.codeSaved = "true")],
    ["a backup screen with 11 words drawn", (r) => (r.noPrf.create.words = 11)],
    ["a backup screen with no account", (r) => (r.noPrf.create.account = null)],
    ["a no-PRF seed stored in the clear", (r) => (r.noPrf.create.seedWrapped = false)],
    ["an early Saved press that marks the words saved", (r) => (r.noPrf.savedEarly.after = { ...r.noPrf.savedEarly.after, state: "signed-in", codeSaved: "true" })],
    ["an early Saved press that came after the window", (r) => (r.noPrf.savedEarly.withinMs = 500)],
    ["an early Saved press that missed Saved", (r) => (r.noPrf.savedEarly.pressOn = "BODY")],
    ["no early Saved press", (r) => delete r.noPrf.savedEarly],
    ["Saved that leaves code_saved false", (r) => (r.noPrf.saved.codeSaved = "false")],
    ["Saved on another account", (r) => (r.noPrf.saved.account = "00".repeat(32))],
    ["Saved with no Sign out drawn", (r) => (r.noPrf.saved.signoutButtons = 0)],
    ["the 12 words still drawn after Saved", (r) => (r.noPrf.saved.words = 12)],
    ["no Saved step", (r) => delete r.noPrf.saved],
    ["words that fail the checksum and store a seed", (r) => (r.noPrf.invalid.seed = true)],
    ["words that fail the checksum and sign in", (r) => (r.noPrf.invalid.state = "signed-in")],
    ["typed words on another account", (r) => (r.noPrf.typed.account = "11".repeat(32))],
    ["typed words checked against no account", (r) => (r.noPrf.typed.expected = null)],
    ["typed words stored with code_saved false", (r) => (r.noPrf.typed.codeSaved = "false")],
    ["typed words stored in the clear", (r) => (r.noPrf.typed.seedWrapped = false)],
    ["no typed-words step", (r) => delete r.noPrf.typed],
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
    ["a mouse press in the window that signs out", (r) => (r.prf.protect.mouse.after = { state: "signed-out", account: null })],
    ["a mouse press that came after the window", (r) => (r.prf.protect.mouse.withinMs = 500)],
    ["no mouse press made", (r) => (r.prf.protect.mouse.pressed = false)],
    ["Enter in the window that signs out", (r) => (r.prf.protect.enter.after = { state: "signed-out", account: null })],
    ["Enter that came after the window", (r) => (r.prf.protect.enter.withinMs = 650)],
    ["a tap in the window that signs out", (r) => (r.phone.tap.after = { state: "signed-out", account: null })],
    ["a tap that came after the window", (r) => (r.phone.tap.withinMs = 501)],
    ["a still tap that does nothing", (r) => (r.phone.still.after = { ...r.phone.still.after, state: "signed-in" })],
    ["a still tap that keeps the store", (r) => (r.phone.still.after.db = true)],
    ["a still tap made inside the window", (r) => (r.phone.still.withinMs = 300)],
    ["a mouse press that missed Sign out", (r) => (r.prf.protect.mouse.pressOn = "BODY")],
    ["Enter that never reached Sign out", (r) => (r.prf.protect.enter.pressOn = "BODY")],
    ["a tap that missed Sign out", (r) => (r.phone.tap.pressOn = null)],
    ["a still tap that missed Sign out", (r) => (r.phone.still.pressOn = "MAIN")],
    ["a press after visibilitychange that signs out", (r) => (r.prf.triggers.visibilitychange.after = { state: "signed-out", account: null })],
    ["a press after pageshow that signs out", (r) => (r.prf.triggers.pageshow.after = { state: "signed-out", account: null })],
    ["a press after focus that signs out", (r) => (r.prf.triggers.focus.after = { state: "signed-out", account: null })],
    ["a press that came after the focus window", (r) => (r.prf.triggers.focus.withinMs = 520)],
    ["a trigger with Sign out drawn inside the window", (r) => (r.prf.triggers.pageshow.sinceDrawMs = 120)],
    ["a press after a trigger that missed Sign out", (r) => (r.prf.triggers.visibilitychange.pressOn = "BODY")],
    ["no trigger steps", (r) => delete r.prf.triggers],
    ["a burst's second click that signs out", (r) => (r.prf.burst.after = { state: "signed-out", account: null })],
    ["a burst whose second click came 500 ms or more after the first", (r) => (r.prf.burst.gapMs = 500)],
    ["a burst whose second click came inside the drawn window", (r) => (r.prf.burst.secondMs = 499)],
    ["a burst whose first click came past the drawn window", (r) => (r.prf.burst.firstMs = 500)],
    ["a burst of one click", (r) => (r.prf.burst.presses = 1)],
    ["a burst that missed Sign out", (r) => (r.prf.burst.pressOn = "BODY")],
    ["no burst step", (r) => delete r.prf.burst],
    ["a repeated Enter that signs out", (r) => (r.prf.repeat.after = { state: "signed-out", account: null })],
    ["an Enter that was not a repeat", (r) => (r.prf.repeat.repeat = false)],
    ["a repeated Enter within 500 ms of the input before", (r) => (r.prf.repeat.sincePrevMs = 300)],
    ["a repeated Enter inside the drawn window", (r) => (r.prf.repeat.sinceDrawMs = 200)],
    ["a repeated Enter that missed Sign out", (r) => (r.prf.repeat.pressOn = "BODY")],
    ["no repeated Enter step", (r) => delete r.prf.repeat],
    ["no phone sign-in", (r) => (r.phone.create = { state: "error", account: null })],
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
