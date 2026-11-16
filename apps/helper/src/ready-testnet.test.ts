// node --test src/ready-testnet.test.ts (card helper-ready-never-waits-on-a-testnet-pool): the helper's ready never
// waits on a test network. On 16 Nov 13:4xZ the host's environment held a robinhood-testnet pool; its providers refused
// every state read (dRPC: eth_call -32601; PublicNode: 403 archive), its start check refused after its 90 s bound, and
// the new helper of a redeploy was never ready (poolsChecked held ready on it; main exits 2 on its refusal).
// Card helper-mainnet-pools-only: the helper now loads no test pool at all, so those lines load nothing.
// Every provider is a stub of fetch that refuses every call. Test keys only: fixed bytes and sha256 of a label; no key
// here holds or moves anything.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { evmPoolVenues } from "@blindfill/kit";
import { base58 } from "./bind/checks.ts";
import { evmPoolSendersFromEnv } from "./pool/evm.ts";
import { solanaPoolSendersFromEnv } from "./pool/solana.ts";
import { poolsChecked, readyGate } from "./server.ts";

const KEY = "0x" + "11".repeat(32);
const FEE_PAYER = ((seed) => base58(Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)])))(new Uint8Array(createHash("sha256").update("helper-ready-testnet/FP").digest()));
const PROGRAM = base58(ed25519.getPublicKey(new Uint8Array(createHash("sha256").update("helper-ready-testnet/PROGRAM").digest())));

test("card helper-mainnet-pools-only: an environment holding every test network's pool lines (Base Sepolia, Robinhood testnet, Solana devnet) loads no pool, calls no provider, and leaves ready true", async (t) => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "the method eth_call does not exist/is not available" } }), { status: 400, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = real));
  const kit = evmPoolVenues() as Record<string, { pool?: string } | undefined>;
  // the lines by their names, as the host's environment held them (no table of the helper's names them now)
  const env: Record<string, string> = {
    POOL_EVM_ADDRESS_BASE_SEPOLIA: kit["base-sepolia"]?.pool ?? "0x" + "ab".repeat(20),
    POOL_EVM_SENDER_KEY_BASE_SEPOLIA: KEY,
    POOL_EVM_ADDRESS_ROBINHOOD_TESTNET: kit["robinhood-testnet"]?.pool ?? "0x" + "ab".repeat(20),
    POOL_EVM_SENDER_KEY_ROBINHOOD_TESTNET: KEY,
    POOL_SOLANA_PROGRAM_DEVNET: PROGRAM,
    POOL_SOLANA_FEE_PAYER_KEY_DEVNET: FEE_PAYER,
    POOL_SOLANA_FEE_DEVNET: "1300000",
    POOL_SOLANA_RPCS_DEVNET: "https://a.devnet.example,https://b.devnet.example",
  };
  // the main's own readers (server.ts main)
  const [pools, evmPools] = [solanaPoolSendersFromEnv(env), evmPoolSendersFromEnv(env)];
  assert.deepEqual([pools.size, evmPools.size], [0, 0]);
  const refused: string[] = [];
  const lines: string[] = [];
  const { ready, warmed } = readyGate(Promise.resolve(), poolsChecked(pools, evmPools, (e) => void refused.push(e.message), 10, (l) => void lines.push(l)));
  await Promise.race([warmed, new Promise((ok) => setTimeout(ok, 3_000).unref())]);
  assert.equal(ready(), true);
  assert.deepEqual([refused, lines, calls], [[], [], 0]);
});

test("card helper-ready-never-waits-on-a-testnet-pool: a mainnet pool's refusal still refuses the start, and a mainnet pool's check still holds ready; a pool that names no network is held as a mainnet one", async () => {
  const refused: string[] = [];
  const never = new Promise<void>(() => {});
  const holds = readyGate(Promise.resolve(), poolsChecked(new Map([["s", { cluster: "mainnet", ready: never }]]), new Map([["t", { network: "robinhood-testnet", ready: () => Promise.resolve() }]]), () => {}, 10, () => {}));
  const stub = readyGate(Promise.resolve(), poolsChecked(new Map(), new Map([["e", { ready: () => never }]]), () => {}, 10, () => {}));
  const gate = poolsChecked(new Map(), new Map([["e", { network: "base", ready: () => Promise.reject(new Error("two chains")) }], ["t", { network: "base-sepolia", ready: () => Promise.reject(new Error("down")) }]]), (e) => void refused.push(e.message), 10, () => {});
  await assert.rejects(gate, /two chains/);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(refused, ["two chains"]);
  assert.deepEqual([holds.ready(), stub.ready()], [false, false]);
});
