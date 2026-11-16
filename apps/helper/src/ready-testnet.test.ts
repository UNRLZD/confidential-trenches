// node --test src/ready-testnet.test.ts (card helper-ready-never-waits-on-a-testnet-pool): the helper's ready never
// waits on a test network. On 16 Nov 13:4xZ the host's environment held a robinhood-testnet pool; its providers refused
// every state read (dRPC: eth_call -32601; PublicNode: 403 archive), its start check refused after its 90 s bound, and
// the new helper of a redeploy was never ready (poolsChecked held ready on it; main exits 2 on its refusal).
// Every provider is a stub of fetch that refuses every call. Test keys only: fixed bytes and sha256 of a label; no key
// here holds or moves anything.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { evmPoolVenues } from "@blindfill/kit";
import { base58 } from "./bind/checks.ts";
import { POOL_EVM_ENV } from "./pool/evm.ts";
import { POOL_SOLANA_ENV } from "./pool/solana.ts";
import { poolsChecked, poolsFromEnv, readyGate } from "./server.ts";

const KEY = "0x" + "11".repeat(32);
const FEE_PAYER = ((seed) => base58(Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)])))(new Uint8Array(createHash("sha256").update("helper-ready-testnet/FP").digest()));
const PROGRAM = base58(ed25519.getPublicKey(new Uint8Array(createHash("sha256").update("helper-ready-testnet/PROGRAM").digest())));

test("card helper-ready-never-waits-on-a-testnet-pool: every test network's pool (Base Sepolia, Robinhood testnet, Solana devnet) on providers that refuse every call leaves ready true; the start is never refused, and each EVM test pool's refusal is one line", async (t) => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
    calls++;
    const id = ((): unknown => {
      try {
        return (JSON.parse(String(init?.body)) as { id?: unknown }).id ?? null;
      } catch {
        return null;
      }
    })();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "the method eth_call does not exist/is not available" } }), { status: 400, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = real));
  const kit = evmPoolVenues();
  const env: Record<string, string> = {};
  for (const n of ["base-sepolia", "robinhood-testnet"] as const) {
    const [address, key] = POOL_EVM_ENV[n];
    Object.assign(env, { [address]: kit[n].pool!, [key]: KEY });
  }
  const [program, feePayer, fee, urls] = POOL_SOLANA_ENV.devnet;
  Object.assign(env, { [program]: PROGRAM, [feePayer]: FEE_PAYER, [fee]: "1300000", [urls]: "https://a.devnet.example,https://b.devnet.example" });
  // the main's own composition: every pool the environment sets loads (the live checks still read the test ones)
  const { pools, evmPools } = poolsFromEnv(env);
  assert.deepEqual([pools.size, evmPools.size], [1, 2]);
  // each EVM check as the main runs it, its waits passing on the next turn so it reaches its 90 s bound at once
  const quick = () => new Promise<void>((go) => setImmediate(go));
  const evm = new Map([...evmPools].map(([k, s]) => [k, { network: s.network, ready: () => s.ready(quick) }]));
  const refused: string[] = [];
  const lines: string[] = [];
  const { ready, warmed } = readyGate(Promise.resolve(), poolsChecked(pools, evm, (e) => void refused.push(e.message), 10, (l) => void lines.push(l)));
  await Promise.race([warmed, new Promise((ok) => setTimeout(ok, 3_000).unref())]);
  assert.equal(ready(), true, "ready held by a test network's pool");
  for (let i = 0; i < 20_000 && lines.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(refused, [], "a test network's refusal refused the start (main: exit 2)");
  assert.deepEqual(lines.map((l) => /^test network pool down \((evm [a-z-]+)\), ready never waits on it: POOL_EVM_RPCS_[A-Z_]+: the fee's state/.exec(l)?.[1]).sort(), ["evm base-sepolia", "evm robinhood-testnet"], lines.join("\n"));
  assert.ok(calls > 0, "the test pools' checks ran");
  for (const l of lines) assert.ok(!l.includes(KEY.slice(2)), `a key in: ${l}`);
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
