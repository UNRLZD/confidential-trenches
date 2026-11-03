// node --test scripts/live-checks/signpage-solana-trade.test.mjs: the live check replays recorded answers
// (signpage-solana-trade.answers.json). bad: SIGN_HOST as read on 2 Nov, serving release-1 with no Solana host in its
// connect-src and no trade kind: FAIL, with each missing host and the missing kind named. Planted on it: a served
// /app.js that is not the pinned one, and a run tx that one RPC reads with an error: FAIL. good: recorded once the CSP
// change and this card are deployed and the owner's run has landed (todo until then).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TRADE_HOSTS, judge } from "./signpage-solana-trade.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-solana-trade.answers.json", import.meta.url), "utf8"));
const BAD = ANSWERS.bad;

test("recorded bad answer: SIGN_HOST without the Solana hosts or the trade kind: FAIL", () => {
  const v = judge(BAD);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    ...TRADE_HOSTS.slice(1).map((h) => `BAD connect-src lacks ${h}`),
    "BAD the served /app.js holds no trade kind (no_ready_set)",
    "BAD the served /app.js holds no trade kind (over_held)",
  ]);
});

test("planted: a served /app.js that is not the pinned one, and a run tx with an error on one RPC: FAIL", () => {
  const v = judge({ ...BAD, app: { ...BAD.app, sha384: "sha384-other" }, txs: [{ signature: "sig", reads: [{ err: null, confirmationStatus: "finalized" }, { err: { InstructionError: [2, { Custom: 6001 }] }, confirmationStatus: "finalized" }] }] });
  assert.ok(v.lines.includes("BAD the served /app.js is not the one index.html pins"));
  assert.ok(v.lines.includes("BAD tx sig did not land with no error on both RPCs"));
});

test.todo("recorded good answer: the deployed trade kind, the trade's hosts in connect-src and the owner's run txs landed on two RPCs: PASS");
