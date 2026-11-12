// node --test scripts/live-checks/evm-pools-on-mainnet.test.mjs: card evm-pools-on-mainnet's live check, replayed.
// evm-pools-on-mainnet.answers.json holds a real run (2026-11-11 from this Mac):
//   - sign.good: this card's SIGN_HOST build (scripts/signpage-built.mjs), both mainnet pins in its bundle; sign.bad:
//     SIGN_HOST as served before its deploy (release b19f7723), no EVM pin at all;
//   - chain.good: both pins on two RPCs each (deploy receipt, code, the fee recipient's empty code) and the deployed
//     helper's fee answer naming each pin's fee recipient; chain.bad: the same pins with each chain's sell sender typed as
//     the fee recipient, which the helper's fee answer does not name.
// The good answers pass, the bad ones fail, and so do the good answers under a pin moved by one field; a provider that
// answers nothing makes the chain's run INCONCLUSIVE, never PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { replayer } from "./evm-pool-pins.mjs";
import { checkChain, judge, PINS, TYPED, verdictOfBoth } from "./evm-pools-on-mainnet.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;

const A = JSON.parse(readFileSync(new URL("./evm-pools-on-mainnet.answers.json", import.meta.url), "utf8"));
const opts = { epochMs: A.epochMs };

test("the recorded good answers pass: the build's bundle pins both mainnet pools, and each pin is the chain's and the helper's", async () => {
  const s = judge(A.sign.good);
  assert.equal(s.ok, true, s.lines.join("\n"));
  const c = await checkChain(replayer(A.chain.good), opts);
  assert.equal(c.verdict, "PASS", c.lines.join("\n"));
  assert.equal(c.lines.length, 18);
  assert.ok(c.lines.every((l) => l.startsWith("ok  ")), c.lines.join("\n"));
  assert.equal(verdictOfBoth(s, c), "PASS");
});

test("the recorded bad SIGN_HOST answer fails: a bundle with no mainnet EVM pin", async () => {
  const s = judge(A.sign.bad);
  assert.equal(s.ok, false);
  assert.deepEqual(s.lines.filter((l) => l.startsWith("BAD")), ["BAD the bundle pins 0 pools on base, not one", "BAD the bundle pins 0 pools on robinhood, not one"]);
  assert.equal(verdictOfBoth(s, await checkChain(replayer(A.chain.good), opts)), "FAIL");
});

test("the recorded bad chain answer fails: a typed fee recipient the helper does not name", async () => {
  const c = await checkChain(replayer(A.chain.bad), { ...opts, pins: TYPED });
  assert.equal(c.verdict, "FAIL");
  const fails = c.lines.filter((l) => l.startsWith("FAIL"));
  assert.equal(fails.length, 2, c.lines.join("\n"));
  for (const l of fails) assert.match(l, /the helper's fee answer \(HTTP 200\)/);
  assert.equal(verdictOfBoth(judge(A.sign.good), c), "FAIL");
});

test("the good answers under a pin moved by one field fail, in the bundle and on the chain", async () => {
  for (const [field, value] of [["pool", "0x" + "1".repeat(40)], ["feeRecipient", "0x" + "2".repeat(40)], ["fromBlock", String(BigInt(PINS.base.fromBlock) + 1n)]]) {
    const pins = { ...PINS, base: { ...PINS.base, [field]: value } };
    assert.equal(judge(A.sign.good, pins).ok, false, `bundle, ${field}`);
    // a moved pool asks reads the recording never made: a no-answer, so not PASS either way
    const c = await checkChain(replayer(A.chain.good), { ...opts, pins });
    assert.notEqual(c.verdict, "PASS", `chain, ${field}: ${c.lines.join("\n")}`);
    if (field !== "pool") assert.equal(c.verdict, "FAIL", `chain, ${field}`);
  }
  // a bundle that also pins a testnet pool fails
  const extra = { ...A.sign.good, pins: [...A.sign.good.pins, { network: "base-sepolia", pool: "0x" + "3".repeat(40), feeRecipient: "0x" + "4".repeat(40), fromBlock: "1" }] };
  assert.equal(judge(extra).ok, false);
});

test("a provider that answers nothing makes the chain's run INCONCLUSIVE, never PASS", async () => {
  const quietHost = "base-rpc.publicnode.com";
  const c = await checkChain(replayer(A.chain.good.filter((e) => !String(e.url).includes(quietHost))), opts);
  assert.equal(c.verdict, "INCONCLUSIVE", c.lines.join("\n"));
});
