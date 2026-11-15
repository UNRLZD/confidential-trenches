// node --test scripts/live-checks/buy-shows-every-step.test.mjs: the live check's verdict replays recorded answers
// (buy-shows-every-step.answers.json), each facts() over a tree's index.html and app.js:
//   good: this card's branch, built with packages/signpage/scripts/build-app.mjs --out: the index pins the bundle, and
//         the bundle writes the [ct-trace] lines of a move, its follow and the tap: PASS;
//   bad:  SIGN_HOST as served on 15 Nov 2026 before the card (release 153, no trace): FAIL on every mark.
// Planted from the minified code the build writes: each mark broken alone FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { facts, judge, SAYS } from "./buy-shows-every-step.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "buy-shows-every-step.answers.json"), "utf8"));
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: the branch's build: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST before the card: FAIL on every mark", () => {
  const r = judge(ANSWERS.bad);
  for (const k of Object.keys(SAYS)) fails(r, new RegExp(`^BAD ${k}:`));
});

test("planted on the good answer: each mark alone, and the index's pin", () => {
  for (const k of Object.keys(SAYS)) fails(judge({ ...ANSWERS.good, [k]: false }), new RegExp(`^BAD ${k}:`));
  fails(judge({ ...ANSWERS.good, sha384: ANSWERS.bad.sha384 }), /not the one index\.html pins/);
  fails(judge({ ...ANSWERS.good, index: "<html></html>" }), /pins no \/app\.js/);
});

// the minified code as this card's build writes it (packages/signpage/scripts/build-app.mjs at the branch)
const TRACE =
  "var CK=`[ct-trace]`,wK=/^[A-Za-z0-9._:/-]{1,160}$/,TK=/^[A-Za-z_]{1,40}$/,EK={tx:wK,address:wK,quote:wK,move:wK,status:TK,stage:TK,amount:/^\\d{1,40}(?:\\.\\d{1,30})?$/,error:null},DK=/\\d{30,}|[0-9a-fA-F]{64,}|[1-9A-HJ-NP-Za-km-z]{80,}/g;try{kK(`${CK} ${JSON.stringify(l)}`)}catch{}";
const MOVE =
  "try{b(`proof_start`);let t=await Efe({});b(`proof_done`);g=y(T);b(`relay_sent`)}finally{};let n=s===null?`withdraw_failed`:`withdraw_${s.kind}`;let f={...r,stage:`in_transit`,txs:l,...c(IK(t,null,`vault_payout`,{stage:s.kind,...d}))}";
const FOLLOW =
  "l||i(`status`,{address:e.address,status:o});(a=!0,i(`intents`,{address:e.address,status:o.status}));o||i(`arrived`,{address:e.u,amount:y.toString()});i(`pool_deposit`,{address:e.u,amount:a.toString(),stage:o});i(`follow`,{stage:`round_failed`,error:OK(e)})";
const TAP = "c(`move`,{move:p,stage:`tap_unread`,error:`the read of what one tap spends did not answer by the wait's end`});c(`move`,{stage:r?`ready`:`wait_over`})";
const all = (o = {}) => facts("", [o.trace ?? TRACE, o.move ?? MOVE, o.follow ?? FOLLOW, o.tap ?? TAP].join(";"));

test("facts() reads each mark from the minified code as the build writes it, and misses each when it is broken", () => {
  assert.deepEqual(Object.fromEntries(Object.keys(SAYS).map((k) => [k, all()[k]])), { trace: true, move: true, follow: true, tap: true });
  const broken = {
    trace: [
      // no tag, or the line not the tag and one JSON object
      { trace: TRACE.replace("`[ct-trace]`", "`[trace]`") },
      { trace: TRACE.replace("`${CK} ${JSON.stringify(l)}`", "`${CK} ${l}`") },
      // a field with no shape of its own (a free-text field beside the error), or the error no longer the only one
      { trace: TRACE.replace("move:wK,", "move:null,") },
      { trace: TRACE.replace("error:null}", "error:wK}") },
      // the error's secret-sized runs left in
      { trace: TRACE.replace("|[0-9a-fA-F]{64,}", "") },
    ],
    move: [
      { move: MOVE.replace("b(`proof_start`);", "") },
      { move: MOVE.replace("b(`relay_sent`)", "") },
      { move: MOVE.replace("`vault_payout`", "`payout`") },
      // a failed move with no why
      { move: MOVE.replace("`withdraw_failed`:`withdraw_${s.kind}`", "void 0:void 0") },
    ],
    follow: [
      { follow: FOLLOW.replace("i(`status`,{address:e.address,status:o});", "") },
      { follow: FOLLOW.replace("i(`arrived`,", "i(`landed`,") },
      { follow: FOLLOW.replace("i(`pool_deposit`,", "i(`deposit`,") },
      { follow: FOLLOW.replace(";i(`follow`,{stage:`round_failed`,error:OK(e)})", "") },
    ],
    tap: [
      { tap: TAP.replace("`tap_unread`", "`unread`") },
      { tap: TAP.replace("did not answer by the wait's end", "failed") },
      { tap: TAP.replace("`wait_over`", "`over`") },
    ],
  };
  for (const [k, list] of Object.entries(broken)) {
    for (const o of list) {
      const f = all(o);
      assert.equal(f[k], false, `${k} misses: ${JSON.stringify(o)}`);
      fails(judge({ ...ANSWERS.good, ...f, index: ANSWERS.good.index, sha384: ANSWERS.good.sha384 }), new RegExp(`^BAD ${k}:`));
    }
  }
});
