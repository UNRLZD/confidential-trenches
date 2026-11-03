// The testnet build's pool pins and providers (card signpage-pool-flow): with __SIGN_NETWORK__ "testnet", as
// scripts/build-app.mjs sets it for that build, SOL_POOLS pins the devnet pool of contracts/pool-solana's deployment
// record and the helper's devnet fee payer, the page asks two devnet RPCs for Solana and the testnet pins' two RPCs for
// Base Sepolia and Robinhood testnet, and a pool buy on the pinned devnet pool reaches the flow. Another chain (no EVM
// pool pinned), a page with no flow, or the mainnet tables are refused. Its own file: the network is read once, at
// import, so this process runs as the testnet build does (test/pool-network.test.ts runs the mainnet one).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { SOL_POOLS, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPoolDeps } = await import("../src/pool-testnet.ts");
type Ask = import("../src/rules/pool.ts").PoolAsk;

const RECORD = JSON.parse(readFileSync(new URL("../../../scripts/live-checks/pool-sol-deploy.devnet.json", import.meta.url), "utf8")) as { cluster: string; program_id: string; pool: string };
// GET https://api.confidential.unrealized.trade/v1/pool/fee?cluster=devnet&pool=D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef,
// read 3 Nov 21:07Z: fee_payer 9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb (the helper's devnet key, which the new pool keeps)
const FEE_PAYER = "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb";
const SOL_TOKEN = "So11111111111111111111111111111111111111112";
const EVM_TOKEN = "0xF111111111111111111111111111111111111111";
const ctx = { id: "r1", sha: "00", progress: () => {} };
const buy = (chain: string) => ({ chain, token: chain === "solana" ? SOL_TOKEN : EVM_TOKEN, amount: "0.01", slippage_bps: 100 });

test("the testnet build pins the devnet pool of the deployment record and the helper's devnet fee payer; no mainnet pool", () => {
  assert.equal(POOL_TESTNET, true);
  assert.equal(RECORD.cluster, "devnet");
  assert.deepEqual({ ...SOL_POOLS.devnet }, { program: RECORD.program_id, feePayer: FEE_PAYER });
  assert.equal(solanaPoolOf(SOL_POOLS.devnet!.program).pool, RECORD.pool, "the record's pool is the program's pool account");
  assert.equal(SOL_POOLS.mainnet, undefined);
  assert.ok(Object.isFrozen(SOL_POOLS) && Object.isFrozen(SOL_POOLS.devnet));
});

test("the testnet build's providers: two devnet RPCs, and each EVM testnet's two from its pins", () => {
  const deps = testnetPoolDeps();
  const urls = (c: "solana" | "base" | "robinhood") => deps.rpcs(c)!.map((r) => (r as unknown as { url: string }).url);
  assert.deepEqual(urls("solana"), ["https://api.devnet.solana.com/", "https://solana-devnet.api.onfinality.io/public"]);
  assert.deepEqual(urls("base"), ["https://sepolia.base.org/", "https://base-sepolia-rpc.publicnode.com/"]);
  assert.deepEqual(urls("robinhood"), ["https://rpc.testnet.chain.robinhood.com/", "https://robinhood-sepolia-rpc.publicnode.com/"]);
  for (const c of ["solana", "base", "robinhood"] as const) assert.notEqual(new URL(TESTNET_RPCS[c][0]).host, new URL(TESTNET_RPCS[c][1]).host, `${c}: two operators`);
});

test("a pool buy on the pinned devnet pool reaches the flow; another chain, no flow, or the mainnet pins are refused", async () => {
  const asks: Ask[] = [];
  const flow = (ask: Ask) => (asks.push(ask), { error: "busy" as const });
  const k = poolKinds(testnetPoolDeps(flow));
  assert.deepEqual(k["pool.buy"](buy("solana"), ctx), { error: "busy" }, "the flow's answer");
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0], { kind: "pool.buy", chain: "solana", token: SOL_TOKEN, amount: 10_000_000n, slippageBps: 100, decimals: 9 });
  // no EVM pool is pinned in the testnet build (EVM_POOLS is empty): Base Sepolia and Robinhood testnet are refused
  for (const chain of ["base", "robinhood"]) assert.deepEqual(k["pool.buy"](buy(chain), ctx), { error: "not_allowed" }, chain);
  assert.equal(asks.length, 1);
  // a testnet page with no flow
  assert.deepEqual(poolKinds(testnetPoolDeps())["pool.buy"](buy("solana"), ctx), { error: "not_allowed" });
  // the mainnet table: nothing pinned
  assert.deepEqual(poolKinds({ ...testnetPoolDeps(flow), pinned: (c) => c === "solana" && SOL_POOLS.mainnet !== undefined })["pool.buy"](buy("solana"), ctx), { error: "not_allowed" });
  assert.equal(asks.length, 1);
});
