// node --test scripts/live-checks/relayer-withdraw-fee.test.mjs: the live check replays recorded runs
// (relayer-withdraw-fee.answers.json). good: apps/helper at this card's commit on a Mac, its fee route quoting mainnet
// and testnet from FastNEAR and dRPC, and the check's own device reads on the same pairs: PASS. bad: the same run with
// the mainnet fee given as a rate ("0.0005", what a percentage relayer would answer): FAIL. Made from the good run:
// another relayer, a fee over the device's fee_max, a closed window, a missing field, another token quoted: each FAIL.
// The check's copy of the device's fee_max is held to the device's own figures (wallet src/withdraw/feemax.ts
// withdrawFeeMax, read 2026-11-02 at these inputs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deviceFeeMax, judge, OTHER, read, relayerArg, TOKENS } from "./relayer-withdraw-fee.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "relayer-withdraw-fee.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const withBody = (run, network, f) => ({ ...run, reads: run.reads.map((x) => (x.asked === TOKENS[network] ? { ...x, body: JSON.stringify(f(JSON.parse(x.body))) } : x)) });

test("recorded good run: both networks quoted in the kit's shape, from the release's relayer, at or under the device's fee_max: PASS", () => {
  const r = judge(A.good, A.good.relayer);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const n of ["mainnet", "testnet"]) assert.ok(r.lines.some((l) => l.startsWith(`ok  [${n}] relay_fee `) && l.includes("<= the device's fee_max")), n);
});

test("recorded bad run: the mainnet fee given as a rate (\"0.0005\"): FAIL", () => {
  const r = judge(A.bad_rate, A.bad_rate.relayer);
  assert.equal(r.ok, false);
  assert.ok(bad(r).includes('BAD [mainnet] relay_fee "0.0005": an absolute amount in base units, a u128 decimal'), bad(r).join("\n"));
});

test("made from the good run: another relayer, a fee over fee_max, a closed window, a missing field, another token quoted, no relayer given: each FAIL", () => {
  const g = A.good;
  assert.equal(judge(withBody(g, "mainnet", (b) => ({ ...b, fee_recipient: "thief.near" })), g.relayer).ok, false);
  const max = deviceFeeMax(Object.fromEntries(Object.entries(g.device.testnet).filter(([k]) => k !== "height").map(([k, v]) => [k, BigInt(v)])));
  assert.equal(judge(withBody(g, "testnet", (b) => ({ ...b, relay_fee: (max + 1n).toString() })), g.relayer).ok, false);
  assert.equal(judge(withBody(g, "testnet", (b) => ({ ...b, relay_fee: max.toString() })), g.relayer).ok, true, "a fee at fee_max is the device's to take");
  assert.equal(judge(withBody(g, "mainnet", (b) => ({ ...b, valid_until_block: Number(g.device.mainnet.height) - 1 })), g.relayer).ok, false);
  assert.equal(judge(withBody(g, "mainnet", ({ g_w, ...b }) => b), g.relayer).ok, false);
  assert.equal(judge({ ...g, reads: g.reads.map((x) => (x.asked === OTHER ? { ...x, status: 200 } : x)) }, g.relayer).ok, false);
  assert.equal(judge(g, { mainnet: null, testnet: g.relayer.testnet }).ok, false);
  assert.equal(judge({ ...g, device: { ...g.device, testnet: { error: "finals more than 30 apart" } } }, g.relayer).ok, false);
});

test("the check's copy of the device's fee_max equals the device's figures", () => {
  const at = (gasPrice, poolToken, poolNear, registerDeposit) => deviceFeeMax({ gasPrice, poolToken, poolNear, registerDeposit });
  assert.equal(at(100_000_000n, 1_023_068_829_135n, 247_370_119_496_778_966_130_420_997_292n, 1_250_000_000_000_000_000_000n), 438_172n);
  assert.equal(at(10_000_000_000n, 250_000_000_000n, 5_000_000_000_000_000_000_000_000_000n, 0n), 344_972_500n);
  assert.equal(at(123_456_789n, 50_000_000_000_000n, 10n ** 30n, 1_250_000_000_000_000_000_000n), 6_102_439n);
  assert.deepEqual(relayerArg("a.near,b.near"), { relayer_account: "a.near", fee_recipient: "b.near" });
  assert.deepEqual(relayerArg("a.near"), { relayer_account: "a.near", fee_recipient: "a.near" });
});

test("read() asks the three tokens with Origin APP_HOST (replayed helper; device reads stubbed down)", async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/v1/withdraw/fee") {
      asked.push(u.searchParams.get("token"));
      assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
      const r = A.good.reads.find((x) => x.asked === u.searchParams.get("token"));
      return new Response(r.body, { status: r.status, headers: r.headers });
    }
    throw new Error("no RPC in this test");
  };
  const run = await read("https://ct-api.unrealized.trade", fetchFn);
  assert.deepEqual(asked, [TOKENS.mainnet, TOKENS.testnet, OTHER]);
  assert.ok(run.device.mainnet.error && run.device.testnet.error);
  assert.equal(judge(run, A.good.relayer).ok, false, "no device reads, no pass");
});
