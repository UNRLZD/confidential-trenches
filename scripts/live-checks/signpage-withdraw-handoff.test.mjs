// node --test scripts/live-checks/signpage-withdraw-handoff.test.mjs: the live check replays its recorded answers
// (signpage-withdraw-handoff.answers.json). The check reads SIGN_HOST only (card live-checks-read-mainnet-only): the
// recordings' fee fields, read on the testnet release, are no longer judged (mainnet's fee is relayer-withdraw-fee's).
// good: this card's SIGN_HOST build as committed (the check's --local: its index.html, public/app.js and
// public/_headers), a real recording: PASS. bad: SIGN_HOST as served before this card (release-64),
// whose bundle has no withdraw form fee read, a real recording: FAIL. Planted (made) on the good one: a testnet RPC in
// SIGN_HOST's connect-src, an /app.js its index.html does not pin, a bundle carrying the testnet relayer's ids (a
// testnet build served as SIGN_HOST): each FAIL, named. badFeeAboveCap and badRelayer differ from good only in the
// testnet fee read, which this check no longer makes: they PASS here. The literals the check judges by are the wallet's own (the child's --consts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { child, judge, MAINNET_PAIR, RELAYER, TESTNET_HOSTS } from "./signpage-withdraw-handoff.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-withdraw-handoff.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's build, no testnet RPC in the CSP, no testnet relayer in the bundle: PASS", () => {
  const v = judge(A.good);
  assert.deepEqual(v.lines, []);
  assert.equal(v.ok, true);
  const { fee, feeMax, feeError, ...bundle } = A.good;
  assert.equal(judge(bundle).ok, true, "the bundle half alone is the whole answer now");
  // good_live: SIGN_HOST as served on 16 Nov, read by the check as it is now (a real run, --record)
  assert.deepEqual(judge(A.good_live).lines, []);
  assert.deepEqual(Object.keys(A.good_live), ["at", "csp", "html", "appSha384", "app"]);
});

test("recorded bad answer: SIGN_HOST before this card (release-64): FAIL, the missing fee read named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["BAD SIGN_HOST's /app.js carries no withdraw form fee read: the build is before this card"]);
});

test("planted bad answers (made): a testnet RPC in the CSP, an unpinned /app.js, the testnet relayer in the bundle: each FAIL", () => {
  const one = (k, re) => {
    const v = judge(A[k]);
    assert.equal(v.ok, false, k);
    assert.equal(v.lines.length, 1, `${k}: ${v.lines.join(" | ")}`);
    assert.match(v.lines[0], re, k);
  };
  one("badTestnetCsp", /names the testnet RPC https:\/\/test\.rpc\.fastnear\.com/);
  one("badPin", /is not the one its index.html pins/);
  one("badTestnetRelayer", /carries the testnet withdrawal relayer's ids/);
  for (const k of ["badFeeAboveCap", "badRelayer"]) assert.equal(judge(A[k]).ok, true, `${k}: a testnet fee read, no longer this check's`);
});

test("the check judges by the wallet's own release values (the child's --consts, no network)", () => {
  const c = child(["--consts"]);
  assert.deepEqual(c.relayer, RELAYER);
  assert.deepEqual(c.testnetHosts, TESTNET_HOSTS);
  assert.deepEqual(c.mainnetPair, MAINNET_PAIR);
  assert.equal(c.feeUrl, "https://ct-api.unrealized.trade/v1/withdraw/fee");
});
