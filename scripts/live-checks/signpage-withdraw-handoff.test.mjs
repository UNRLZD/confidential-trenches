// node --test scripts/live-checks/signpage-withdraw-handoff.test.mjs: the live check replays its recorded answers
// (signpage-withdraw-handoff.answers.json). good: this card's SIGN_HOST build as committed (the check's --local: its
// index.html, public/app.js and public/_headers) with the form's fee read run live on the testnet release (the
// deployed helper's quote, the device's own fee_max): PASS. bad: SIGN_HOST as served before this card (release-63),
// whose bundle names no release withdrawal relayer: FAIL. Planted on the good one: a relay_fee above the device's
// fee_max, an answer naming another fee recipient, a testnet RPC in SIGN_HOST's connect-src, an /app.js its
// index.html does not pin: each FAIL, named. The literals the check judges by are the wallet's own (the child's --consts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { child, judge, MAINNET_PAIR, RELAYER, TESTNET_HOSTS } from "./signpage-withdraw-handoff.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-withdraw-handoff.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's build, the helper's testnet quote at or below the device's fee_max: PASS", () => {
  const v = judge(A.good);
  assert.deepEqual(v.lines, []);
  assert.equal(v.ok, true);
  assert.equal(A.good.fee.relayer_account, RELAYER.relayer_account);
  assert.ok(BigInt(A.good.fee.relay_fee) <= BigInt(A.good.feeMax));
});

test("recorded bad answer: SIGN_HOST before this card (release-63): FAIL, the missing relayer named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["BAD SIGN_HOST's /app.js carries no release withdrawal relayer: the build is before this card"]);
});

test("planted bad answers: a fee above the cap, another fee recipient, a testnet RPC in the CSP, an unpinned /app.js: each FAIL", () => {
  const one = (k, re) => {
    const v = judge(A[k]);
    assert.equal(v.ok, false, k);
    assert.equal(v.lines.length, 1, `${k}: ${v.lines.join(" | ")}`);
    assert.match(v.lines[0], re, k);
  };
  one("badFeeAboveCap", /above the device's fee_max/);
  one("badRelayer", /not the release's/);
  one("badTestnetCsp", /names the testnet RPC https:\/\/test\.rpc\.fastnear\.com/);
  one("badPin", /is not the one its index.html pins/);
});

test("the check judges by the wallet's own release values (the child's --consts, no network)", () => {
  const c = child(["--consts"]);
  assert.deepEqual(c.relayer, RELAYER);
  assert.deepEqual(c.testnetHosts, TESTNET_HOSTS);
  assert.deepEqual(c.mainnetPair, MAINNET_PAIR);
  assert.equal(c.feeUrl, "https://api.confidential.unrealized.trade/v1/withdraw/fee");
});
