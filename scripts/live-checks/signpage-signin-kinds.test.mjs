// node --test scripts/live-checks/signpage-signin-kinds.test.mjs: the live check's verdict on its recorded answers, with
// no browser and no network. Every record but liveGood is a real run on the browser harness (SIGN_HOST's and APP_HOST's real names
// mapped to it, SIGN_HOST's build under its own _headers and the APP_HOST stand-in under the terminal's), but the two
// marked edited. good: this tree's page on the harness with the step where the frame takes the signed-in state
// (pools included), which passes; liveGood: the deployed SIGN_HOST at release-9 framing the deployed terminal, whose
// own kit client is ready on that state, which passes, and edited from it, the step's bads (the client down or never
// settled, a state the kit refuses, no pools, no state). Each bad fails on its own lines only:
// - bad: the card's page at efacb58, before the recheck's Lows (an open sent during a resync refused; Cancel stuck on
//   the error page when the stored seed cannot be read);
// - badDcad6c9: the card's page at dcad6c9, before the review fixes (Create passkey offered after I already have one,
//   and a tab loaded signed out refusing backup.open after another tab's sign-in);
// - badMain: main 89cd22c's page (no signout, backup.open or wallet choices);
// - badSeedBeforeChoice: a planted page whose wallet way makes a seed before it draws the two choices (the brief's bad);
// - badFramable: the page served without frame-ancestors 'none' (SIGN_HOST loads in a frame; the brief's other bad);
// - badM1a, badM3b: the review's mutants (signin.open taken with a seed stored; no activation-guard restart at all);
// - badFrameSrc (edited): the frame never loaded but no frame-ancestors refusal was read, as dcad6c9's check ran under
//   APP_HOST's frame-src 'none'; badLoadedReported (edited): SIGN_HOST loaded though a refusal was reported;
//   badPressNeverLanded (edited): the early click never landed, which the old check read as ok.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, watch } from "./signpage-signin-kinds.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "signpage-signin-kinds.answers.json"), "utf8"));
const BAD_ALL = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
// The terminal-takes-the-state step came after most bads were recorded: a record with no prf.app step was recorded
// before it, and is read on its other lines (the step's own bads are below, and a good with the step deleted is BAD).
const APP = "prf: the terminal in the frame takes the signed-in state with pools";
const BAD = (rec) => BAD_ALL(rec).filter((l) => l !== APP || Object.hasOwn(rec.prf ?? {}, "app"));

const FRAMED = "prf: a signout sent to SIGN_HOST in a frame is refused, the frame never loads a sign-out";
const AGAIN = "prf: signin.open sent signed in is refused, the seed kept";
const EARLY = "prf: a press on Sign out within 500 ms of the page opening does nothing";
const SO_PAGE = "prf: signout opens the sign-out page top-level only";
const CHOICES = "wallet: signin.open {way: wallet} on an empty store draws the two choices";
const NO_SEED = "wallet: no wallet request and no seed before the choice";
const EXISTING = "wallet: I already have one draws Use passkey and Recovery code, no wallet request, no seed";
const NO_CREATE = "wallet: Use passkey there with no PRF makes nothing and offers the passkey and the 12 words, never Create passkey";
const TWO_TABS = "two tabs: a backup.open sent while tab A reads tab B's new seed waits for the read and is taken";
const BROKEN = "broken store: Cancel goes back to the app when the stored seed cannot be read";

test("the recorded good answer passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  assert.equal(answers.good.mode, "harness");
  assert.ok(answers.good.prf.framed.refusals >= 1);
  assert.ok(Array.isArray(answers.good.prf.app.state.pools));
});

test("the recorded live answer on release-9 passes: the deployed terminal's client is ready on a state with pools", () => {
  const r = judge(answers.liveGood);
  assert.equal(r.pass, true, r.lines.join("\n"));
  assert.equal(answers.liveGood.mode, "live");
  assert.equal(answers.liveGood.prf.app.signpage, "ready");
  assert.ok(r.lines.includes(`ok  ${APP} (APP_HOST's client ready, signed_in true, pools ${answers.liveGood.prf.app.state.pools.length}, the kit takes it)`));
});

test("the terminal's step fails on a client down, a state the kit refuses, no pools, or no state (edited from the live good)", () => {
  const cases = {
    "the terminal's client went down": (a) => (a.prf.app.signpage = "down"),
    "the terminal's client never settled": (a) => (a.prf.app.signpage = null),
    "a key the kit does not know": (a) => (a.prf.app.state.extra = 1),
    "a pool the kit refuses": (a) => (a.prf.app.state.pools = [{ chain: "solana", asset: "ETH", balance: "1" }]),
    "no pools": (a) => delete a.prf.app.state.pools,
    "signed out": (a) => (a.prf.app.state.signed_in = false),
    "no state": (a) => (a.prf.app.state = null),
    "no frame": (a) => (a.prf.app = { noFrame: true }),
  };
  for (const [name, change] of Object.entries(cases)) {
    const a = structuredClone(answers.liveGood);
    change(a);
    assert.deepEqual(BAD(a), [APP], name);
  }
  // a harness record never stands in for the live client: the same record named live with no client read fails
  const h = structuredClone(answers.good);
  h.mode = "live";
  delete h.prf.app.signpage;
  assert.deepEqual(BAD(h), [APP]);
});

test("the card's page before the recheck's Lows fails: an open refused during a resync, Cancel stuck on a broken store", () => {
  assert.deepEqual(BAD(answers.bad), [TWO_TABS, BROKEN]);
  assert.equal(answers.bad.twoTabs.heldAtSend, true);
  assert.equal(answers.bad.twoTabs.backup.answer.error.code, "not_allowed");
});

test("the card's page before the review fixes fails: Create passkey after I already have one, a stale tab", () => {
  assert.deepEqual(BAD(answers.badDcad6c9), [NO_CREATE, TWO_TABS]);
});

test("an early press that never landed is BAD, never ok", () => {
  assert.deepEqual(BAD(answers.badPressNeverLanded), [EARLY]);
  assert.ok(answers.good.prf.signout.early.pressLanded && answers.good.prf.signout.early.pressMs < 500);
});

test("main 89cd22c's page fails: no backup.open, no signout page, no wallet choices", () => {
  assert.deepEqual(BAD(answers.badMain), [
    "prf: backup.open draws the 12 words of the account in the top window",
    "prf: Cancel on the backup goes back to the app signed in, the words gone",
    SO_PAGE,
    EARLY,
    "prf: Sign out deletes the store and goes back to the app signed out",
    "no-prf: signout with the words not saved draws the backup first, no Sign out",
    "no-prf: Saved goes on to the sign-out page",
    "no-prf: Sign out then deletes the store",
    CHOICES,
    NO_SEED,
    EXISTING,
    NO_CREATE,
    TWO_TABS,
  ]);
});

test("a wallet sign-in that makes a seed before the choice fails", () => {
  assert.deepEqual(BAD(answers.badSeedBeforeChoice), [NO_SEED, EXISTING, NO_CREATE]);
  assert.equal(answers.badSeedBeforeChoice.wallet.choose.seed, true);
});

test("a sign-out from inside a frame fails: SIGN_HOST loaded in a frame, a refusal never read, or both", () => {
  assert.deepEqual(BAD(answers.badFramable), [FRAMED]);
  assert.equal(answers.badFramable.prf.framed.loaded, true);
  assert.deepEqual(BAD(answers.badFrameSrc), [FRAMED]);
  assert.deepEqual([answers.badFrameSrc.prf.framed.loaded, answers.badFrameSrc.prf.framed.refusals], [false, 0]);
  assert.deepEqual(BAD(answers.badLoadedReported), [FRAMED]);
  assert.deepEqual([answers.badLoadedReported.prf.framed.loaded, answers.badLoadedReported.prf.framed.refusals], [true, 1]);
});

test("the review's mutants fail: signin.open taken signed in, and no guard restart", () => {
  assert.deepEqual(BAD(answers.badM1a), [AGAIN]);
  assert.deepEqual(BAD(answers.badM3b), [SO_PAGE, EARLY]);
});

test("a step that never ran is BAD, never ok, and a missing error list is BAD", () => {
  const rec = structuredClone(answers.good);
  delete rec.prf.framed;
  delete rec.prf.again;
  delete rec.prf.signout.early;
  delete rec.wallet.existingUse;
  delete rec.twoTabs;
  delete rec.broken;
  delete rec.prf.app;
  assert.deepEqual(BAD_ALL(rec), [APP, AGAIN, FRAMED, EARLY, NO_CREATE, TWO_TABS, BROKEN]);
  const none = structuredClone(answers.good);
  delete none.errors;
  assert.deepEqual(BAD(none), ["no page error or CSP violation"]);
});

test("planted on the good answer: a recorded 429 names its resource's origin and path in the BAD line, and an error with no location still fails (card live-console-url)", () => {
  const text = "Failed to load resource: the server responded with a status of 429 ()";
  const hooks = {};
  const kept = [];
  watch({ on: (ev, f) => (hooks[ev] = f) }, kept);
  const msg = (t, location) => ({ type: () => "error", text: () => t, location: () => location });
  hooks.console(msg(text, { url: "https://api.confidential.unrealized.trade/v1/relay/status?id=abc" }));
  hooks.console({ type: () => "warning", text: () => "a warning", location: () => ({ url: "https://x.example/" }) });
  hooks.console(msg("Uncaught boom", undefined));
  hooks.pageerror(new Error("boom"));
  assert.deepEqual(kept, [`console: ${text} (https://api.confidential.unrealized.trade/v1/relay/status)`, "console: Uncaught boom", "pageerror: boom"]);
  for (const [line, want] of [
    [kept[0], `console: ${text} (https://api.confidential.unrealized.trade/v1/relay/status)`],
    [kept[1], "console: Uncaught boom"],
    [kept[2], "pageerror: boom"],
  ]) {
    const rec = structuredClone(answers.good);
    rec.errors.push(line);
    const r = judge(rec);
    assert.equal(r.pass, false);
    assert.ok(r.lines.some((l) => l === `BAD no page error or CSP violation (1): ${want}`), r.lines.join("\n"));
    assert.ok(!r.lines.some((l) => l.includes("id=abc")), "no query in a line");
  }
});
