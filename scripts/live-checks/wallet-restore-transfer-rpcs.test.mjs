// node --test scripts/live-checks/wallet-restore-transfer-rpcs.test.mjs: card wallet-restore-transfer-rpcs's live
// check, replayed. wallet-restore-transfer-rpcs.answers.json holds a real run on the four networks' Transfer pairs
// (good: the Base Sepolia W's USDC read on base-sepolia.gateway.tenderly.co and base-testnet.api.pocket.network alike,
// each provider's refusals past its cap among the answers, and the newest 100,000, 50,000 and 10,000 blocks read on
// Robinhood, Base and Robinhood testnet, every call through the device's own client) and the same answers with every
// Transfer log of the Base Sepolia W taken out (bad). The wallet's own read runs on the replay: good passes, bad
// fails, its USDC not listed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JOBS, USDC, check, replayer, spoil } from "./wallet-restore-transfer-rpcs.mjs";

const A = JSON.parse(readFileSync(new URL("./wallet-restore-transfer-rpcs.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes: every network's pair reads its W alike, and the Base Sepolia W lists the USDC it bought", async () => {
  // the pagers met each provider's real cap: Tenderly's "invalid params", thirdweb's -32005 naming its 1,000 blocks and
  // daybreak's 2,000; Robinhood's own caps at 30,000, above the pager's 10,000 (EVM_LOG_PAGE_BLOCKS), so never met
  const refused = new Set(A.good.filter((e) => e.method === "eth_getLogs" && e.error).map((e) => new URL(e.url).host));
  for (const h of ["base.gateway.tenderly.co", "8453.rpc.thirdweb.com", "robinhood.daybreak-rpc.network"]) assert.ok(refused.has(h), `${h}: ${[...refused].join(", ")}`);
  const r = await check(replayer(A.good), { wait: false });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, JOBS.length);
  assert.match(r.lines[0], new RegExp(`^base-sepolia: base-sepolia\\.gateway\\.tenderly\\.co and base-testnet\\.api\\.pocket\\.network read W 0x809286a1bf1585b1eeeefcc7a7f3508158fd078e from block 54553944 to \\d+ alike: .*${USDC}`));
  // each network read over at least the review's span: Base 50,000 blocks, Robinhood 100,000, Robinhood testnet 10,000
  for (const [i, [n, span]] of [["base", 50_000], ["robinhood", 100_000], ["robinhood-testnet", 10_000]].entries()) {
    const m = new RegExp(`^${n}: .* from block (\\d+) to (\\d+) alike`).exec(r.lines[i + 1]);
    assert.ok(m && Number(m[2]) - Number(m[1]) >= span, r.lines[i + 1]);
  }
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
