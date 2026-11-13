// node --test scripts/live-checks/sign-out-stops-the-pages-reads.test.mjs: the live check replays its recorded runs
// (sign-out-stops-the-pages-reads.answers.json), each written by its own --record on the harness at Chrome 157, phone:
//   good: this card's build: PASS, every sign out a new top document whose new frame answers signed out;
//   bad: release 125's build (main c32f749c6, the signing page served before this card): FAIL, no sign out reloads the
//     page and the pinned hosts are asked after one.
// Then cases planted on the good run, one end state undone each.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, SIGN_OUT_LINES } from "./sign-out-stops-the-pages-reads.mjs";
import { PINNED_HOSTS } from "./signpage-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "sign-out-stops-the-pages-reads.answers.json"), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const badLine = (rec, start) => {
  const r = judge(rec);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith(`BAD ${start}`)), `${start}\n${r.lines.join("\n")}`);
};

test("recorded good answer: this card's build, every sign out reloads the page and nothing names the account that went: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, SIGN_OUT_LINES.length + 1);
  for (const p of SIGN_OUT_LINES) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${p}`)), `${p}\n${r.lines.join("\n")}`);
});

test("recorded bad answer: release 125's build signs out with no reload and asks the pinned hosts after it: FAIL", () => {
  assert.match(ANSWERS.bad.source, /from rel125-site$/);
  badLine(ANSWERS.bad, "Sign out in this tab, by its own Sign out button: the top window reloads and its new frame answers exactly signed out (signout answered pending, signed-out, no new document");
  badLine(ANSWERS.bad, "Sign out in another tab: the top window reloads and its new frame answers exactly signed out (signed-out, no new document");
  badLine(ANSWERS.bad, "signed out, no request goes past SIGN_HOST and APP_HOST; signed in, only to a pinned pool's host the page's own connect-src names (5 signed out");
});

test("planted on the good answer: another engine, no reload, a pinned read after a sign out, or one naming the words' account: FAIL", () => {
  const g = ANSWERS.good;
  const st = g.steps;
  let r = clone(g);
  r.engine = "firefox";
  badLine(r, "the run is Chromium's");
  r = clone(g);
  r.steps.passkeyOut.doc = null;
  badLine(r, "Sign out in this tab, by its own Sign out button");
  r = clone(g);
  r.steps.passkeyOut2.doc = null;
  badLine(r, "the second passkey account's Sign out in this tab");
  // a run recorded with no `by` on the words' sign out (the shell check before this card) has none of the reload lines
  r = clone(g);
  delete r.steps.wordsOut.by;
  badLine(r, "Sign out in another tab: the top window reloads and its new frame answers exactly signed out (no such line");
  // a pinned read after the words' sign out, before the second account lands
  const read = g.requests.find((x) => PINNED_HOSTS.includes(x.host) && x.t >= st.words.t && x.t < st.wordsOut.t);
  assert.ok(read, "the good run read a pinned host while the words' account was signed in");
  r = clone(g);
  r.requests.push({ ...clone(read), t: st.wordsOut.doc + 1 });
  badLine(r, "signed out, no request goes past SIGN_HOST and APP_HOST");
  // a name only the words' account's reads carried, read again in the second account's window
  const named = { ...clone(read), rpc: [{ method: "getMultipleAccounts", params: [["8RhWX5yPkPQF1tDmDjTzxWXRzR1E5zXWGdpAi7Q6RFCR"], { encoding: "base64", commitment: "confirmed" }] }] };
  r = clone(g);
  r.requests.push({ ...named, t: st.words.t + 1 }, { ...named, t: st.created2.t + 1 });
  badLine(r, "after the words' account signs out and a second account lands, no request names the words' account (1 of its addresses and ids");
});

// release 128 (card signing-layer-says-when-it-closes, kit 1.13): the signout open answers { pending: true, closes: true }.
// closes: this tree's build on the harness, release128: the live page (13 Nov, Chrome 156, phone), each by its own
// --record: PASS. Planted on closes: the signout answered closes false, or with another key: FAIL.
test("recorded runs on release 128's answers (the harness at this tree, the live page): PASS, the signout answered pending with closes", () => {
  for (const k of ["closes", "release128"]) {
    const r = judge(ANSWERS[k]);
    assert.equal(r.ok, true, `${k}\n${r.lines.join("\n")}`);
    const so = ANSWERS[k].messages.find((m) => m.data?.id === ANSWERS[k].steps.passkeyOut.openId)?.data;
    assert.deepEqual(so?.result, { pending: true, closes: true }, k);
  }
  assert.match(ANSWERS.release128.source, /^live https:\/\/confidential\.unrealized\.trade$/);
  for (const result of [{ pending: true, closes: false }, { pending: true, closes: true, extra: 1 }]) {
    for (const step of ["passkeyOut", "passkeyOut2"]) {
      const r = clone(ANSWERS.closes);
      r.messages.find((m) => m.data?.id === r.steps[step].openId).data.result = result;
      badLine(r, step === "passkeyOut" ? "Sign out in this tab, by its own Sign out button" : "the second passkey account's Sign out in this tab");
    }
  }
});
