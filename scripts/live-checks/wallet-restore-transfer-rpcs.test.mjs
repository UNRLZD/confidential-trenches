// node --test scripts/live-checks/wallet-restore-transfer-rpcs.test.mjs: card wallet-restore-transfer-rpcs's live
// check, replayed. wallet-restore-transfer-rpcs.answers.json holds a real run on the four networks' Transfer lists
// (5 Nov 17:43Z, card evm-transfer-rpc-spares; each list read as a pair with a spare, thirdweb's the spare and out for
// the day then) (good: the Base Sepolia W's USDC read on base-sepolia.gateway.tenderly.co and base-testnet.api.pocket.network alike,
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
  // the pagers met each provider's real cap: Tenderly's "invalid params", daybreak's 2,000 blocks, dRPC's code 35 and
  // Pocket's "too complex/large"; Robinhood's own caps at 30,000, above the pager's 10,000 (EVM_LOG_PAGE_BLOCKS), so never met
  const refused = new Set(A.good.filter((e) => e.method === "eth_getLogs" && e.error).map((e) => new URL(e.url).host));
  for (const h of ["base.gateway.tenderly.co", "robinhood.daybreak-rpc.network", "robinhood-testnet.drpc.org", "base-testnet.api.pocket.network"]) assert.ok(refused.has(h), `${h}: ${[...refused].join(", ")}`);
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

test("a replay whose Base Sepolia seat is out for hours (thirdweb's HTTP 429, Retry-After 26,741 s, on every call) passes on the list's spare: the out provider swapped at its first call, never a wait (card evm-transfer-rpc-spares)", async () => {
  const OUT = "https://base-testnet.api.pocket.network", SPARE = "https://84532.rpc.thirdweb.com";
  // the spare answers what the out provider answered in the real run; the out provider answers only the quota's 429
  const planted = A.good.flatMap((e) => (e.url === OUT ? [{ ...e, url: SPARE }, { network: e.network, url: OUT, method: e.method, params: e.params, error: "HTTP 429 (http_429, 1 try at base-testnet.api.pocket.network)", name: "SolanaRpcTransportError", afterMs: 26_741_000 }] : [e]));
  let outAsked = 0;
  const replay = replayer(planted);
  const r = await check((network, url, method, params) => (url === OUT && outAsked++, replay(network, url, method, params)), { wait: true });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], new RegExp(`^base-sepolia: base-sepolia\\.gateway\\.tenderly\\.co and 84532\\.rpc\\.thirdweb\\.com read W .* alike: .*${USDC}.*; swapped out base-testnet\\.api\\.pocket\\.network$`));
  assert.equal(outAsked, 1);
});
