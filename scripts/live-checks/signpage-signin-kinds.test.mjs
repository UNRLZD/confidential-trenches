// node --test scripts/live-checks/signpage-signin-kinds.test.mjs: the live check's verdict on its recorded answers, with
// no browser and no network. good: a real run of this card's page on the browser harness (SIGN_HOST's and APP_HOST's
// real names mapped to it, SIGN_HOST's build under its own _headers), which passes. bad: the same run on main 89cd22c's
// page, which has no signout, backup.open or wallet choices. badSeedBeforeChoice: a planted page whose wallet way makes a
// seed before it draws the two choices (the brief's recorded bad). badFramable: this card's page served without
// frame-ancestors 'none', so SIGN_HOST loads in a frame (its framed branch still answers not_allowed). badFramedSignout:
// badFramable edited so the framed page answers signout and draws Sign out (the brief's other recorded bad; edited, not a
// run). Each bad fails on its own lines only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./signpage-signin-kinds.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "signpage-signin-kinds.answers.json"), "utf8"));
const BAD = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0]);

const FRAMED = "BAD prf: a signout sent to SIGN_HOST in a frame is refused, the frame never loads a sign-out";
const NO_SEED = "BAD wallet: no wallet request and no seed before the choice";
const EXISTING = "BAD wallet: I already have one draws Use passkey and Recovery code, no wallet request, no seed";

test("the recorded good answer passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  assert.equal(answers.good.mode, "harness");
});

test("main 89cd22c's page fails: no backup.open, no signout page, no wallet choices", () => {
  const r = judge(answers.bad);
  assert.equal(r.pass, false);
  assert.deepEqual(BAD(answers.bad), [
    "BAD prf: backup.open draws the 12 words of the account in the top window",
    "BAD prf: Cancel on the backup goes back to the app signed in, the words gone",
    "BAD prf: signout opens the sign-out page top-level only",
    "BAD prf: Sign out deletes the store and goes back to the app signed out",
    "BAD no-prf: signout with the words not saved draws the backup first, no Sign out",
    "BAD no-prf: Saved goes on to the sign-out page",
    "BAD no-prf: Sign out then deletes the store",
    "BAD wallet: signin.open {way: wallet} on an empty store draws the two choices",
    NO_SEED,
    EXISTING,
  ]);
});

test("a wallet sign-in that makes a seed before the choice fails", () => {
  assert.equal(judge(answers.badSeedBeforeChoice).pass, false);
  assert.deepEqual(BAD(answers.badSeedBeforeChoice), [NO_SEED, EXISTING]);
  assert.equal(answers.badSeedBeforeChoice.wallet.choose.seed, true);
});

test("a SIGN_HOST that loads in a frame fails, even when its framed branch refuses", () => {
  assert.deepEqual(BAD(answers.badFramable), [FRAMED]);
  assert.equal(answers.badFramable.prf.framed.answer.error.code, "not_allowed");
});

test("a sign-out from inside a frame fails", () => {
  assert.deepEqual(BAD(answers.badFramedSignout), [FRAMED]);
});

test("a step that never ran is BAD, never ok", () => {
  const rec = structuredClone(answers.good);
  delete rec.prf.framed;
  delete rec.wallet.choose;
  assert.deepEqual(BAD(rec), [
    "BAD prf: a signout sent to SIGN_HOST in a frame is refused, the frame never loads a sign-out",
    "BAD wallet: signin.open {way: wallet} on an empty store draws the two choices",
    NO_SEED,
  ]);
});
