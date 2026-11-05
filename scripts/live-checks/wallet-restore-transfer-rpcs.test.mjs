// node --test scripts/live-checks/wallet-restore-transfer-rpcs.test.mjs: card wallet-restore-transfer-rpcs's live
// check, replayed. wallet-restore-transfer-rpcs.answers.json holds a real run on the four networks' Transfer pairs
// (good: the Base Sepolia W's USDC read on base-sepolia.gateway.tenderly.co and base-testnet.api.pocket.network alike,
// each provider's refusals past its cap among the answers, and the newest 2,000 blocks read on Base, Robinhood and
// Robinhood testnet) and the same answers with every Transfer log of the Base Sepolia W taken out (bad). The wallet's
// own read runs on the replay: good passes, bad fails, its USDC not listed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JOBS, USDC, check, replayer, spoil } from "./wallet-restore-transfer-rpcs.mjs";

const A = JSON.parse(readFileSync(new URL("./wallet-restore-transfer-rpcs.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes: every network's pair reads its W alike, and the Base Sepolia W lists the USDC it bought", async () => {
  // the pagers met real caps in words the old pager did not read (Tenderly's "invalid params", Pocket's "too complex")
  const refused = new Set(A.good.filter((e) => e.method === "eth_getLogs" && e.error).map((e) => new URL(e.url).host));
  assert.ok(refused.has("base.gateway.tenderly.co") && refused.has("base-testnet.api.pocket.network"), [...refused].join(", "));
  const r = await check(replayer(A.good), { wait: false });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, JOBS.length);
  assert.match(r.lines[0], new RegExp(`^base-sepolia: base-sepolia\\.gateway\\.tenderly\\.co and base-testnet\\.api\\.pocket\\.network read W 0x809286a1bf1585b1eeeefcc7a7f3508158fd078e from block 54553944 to \\d+ alike: .*${USDC}`));
  for (const [i, n] of ["base", "robinhood", "robinhood-testnet"].entries()) assert.ok(r.lines[i + 1].startsWith(`${n}: `), r.lines[i + 1]);
});

test("the recorded bad run (the Base Sepolia W's Transfer logs taken out) fails, its USDC not listed, and is the good run but that", async () => {
  assert.deepEqual(A.bad, spoil(A.good));
  const changed = A.bad.filter((e, i) => JSON.stringify(e) !== JSON.stringify(A.good[i]));
  assert.ok(changed.length >= 1 && changed.every((e) => e.network === "base-sepolia" && e.method === "eth_getLogs" && e.result.length === 0));
  const r = await check(replayer(A.bad), { wait: false });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], new RegExp(`^base-sepolia: W 0x809286a1bf1585b1eeeefcc7a7f3508158fd078e lists no token, not ${USDC}$`));
});

test("a replay whose Base Sepolia pair refuses every page, one block too (dRPC's code 19 there), fails: never a pass on a W unread", async () => {
  const refusing = A.good.map((e) => (e.network === "base-sepolia" && e.method === "eth_getLogs" ? { network: e.network, url: e.url, method: e.method, params: e.params, error: "RPC error 19: Temporary internal error. Please retry" } : e));
  const r = await check(replayer(refusing), { wait: false });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^base-sepolia: /);
  assert.doesNotMatch(r.lines[0], /alike/);
});
