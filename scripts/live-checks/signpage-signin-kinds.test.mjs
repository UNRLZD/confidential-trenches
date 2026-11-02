// node --test scripts/live-checks/signpage-signin-kinds.test.mjs: the live check's verdict on its recorded answers, with
// no browser and no network. Every record is a real run on the browser harness (SIGN_HOST's and APP_HOST's real names
// mapped to it, SIGN_HOST's build under its own _headers and the APP_HOST stand-in under the terminal's), but the two
// marked edited. good: this card's page at 8fe32cc, which passes. Each bad fails on its own lines only:
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
import { judge } from "./signpage-signin-kinds.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "signpage-signin-kinds.answers.json"), "utf8"));
const BAD = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));

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
  assert.deepEqual(BAD(rec), [AGAIN, FRAMED, EARLY, NO_CREATE, TWO_TABS, BROKEN]);
  const none = structuredClone(answers.good);
  delete none.errors;
  assert.deepEqual(BAD(none), ["no page error or CSP violation"]);
});
