/// <reference types="node" />
// The Solana trade joined (markets paper §6.1 M1.1-M1.3, T1.3, LD1; wallet paper §2.3): a wallet not armed by the
// device's own withdrawal is refused before anything is read or built for it; the floors come from the device's own
// E(A); the blockhash is read at finalized on both providers; a tx unknown at the send's deadline is read again on both
// providers and is a fill or a failure only when both agree. Fake endpoints only: nothing here reaches a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import {
  readSolanaBlockhashBoth,
  rereadSolanaSignature,
  runSolanaTrade,
  settleSolanaSet,
  solanaRebuildSlippage,
  solanaRouteFloor,
  solanaSetFloors,
  type SolanaRpc,
  type SolanaTradeDeps,
  type SolanaTxOutcome,
} from "../src/index.ts";

const key = (n: number) => base58.encode(new Uint8Array(32).fill(n));
const TOKEN = key(9);
const W1 = key(1);
const W2 = key(2);
const W3 = key(3);

type Call = { method: string; params: readonly unknown[] };
function provider(answer: (c: Call) => unknown): SolanaRpc & { calls: Call[] } {
  const calls: Call[] = [];
  const rpc = (async (method: string, params: readonly unknown[]) => {
    calls.push({ method, params });
    const a = answer({ method, params });
    if (a instanceof Error) throw a;
    return a;
  }) as SolanaRpc & { calls: Call[] };
  rpc.calls = calls;
  return rpc;
}
const blockhashAnswer = (slot: number, n: number) => ({ context: { slot }, value: { blockhash: key(n), lastValidBlockHeight: slot + 150 } });
const tokenMint = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: 1_461_600, data: [Buffer.alloc(82).toString("base64"), "base64"], executable: false, rentEpoch: 0 };
// A provider that answers the reads before the build: the blockhash and the mint.
const reads = (slot: number) =>
  provider((c) => {
    if (c.method === "getLatestBlockhash") return blockhashAnswer(slot, slot % 200);
    if (c.method === "getMultipleAccounts") return { context: { slot }, value: (c.params[0] as string[]).map(() => tokenMint) };
    return new Error(`unexpected ${c.method}`);
  });

function deps(over: Partial<SolanaTradeDeps> & { fetched?: string[]; refs?: unknown[] } = {}): SolanaTradeDeps {
  const fetched = over.fetched ?? [];
  const refs = over.refs ?? [];
  return {
    helper: "https://helper.example",
    providers: [reads(1_000), reads(1_001)],
    reference: async (q) => {
      refs.push(q);
      return 1_000_000n;
    },
    paths: [],
    dry: true,
    fetch: async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({ error: "down" }), { status: 503 });
    },
    ...over,
  };
}

test("a wallet not armed by the device's own withdrawal is refused before anything is read, built or signed", async () => {
  const fetched: string[] = [];
  const refs: unknown[] = [];
  const d = deps({ fetched, refs, sign: async () => assert.fail("never signed") });
  const r = await runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 500, legs: [{ wallet: W1, amount: 10_000_000n, arm: { own: false } }, { wallet: W2, amount: 10_000_000n, arm: { own: false } }] }, { ...d, dry: false });
  assert.deepEqual(fetched, []);
  assert.deepEqual(refs, []);
  for (const p of d.providers) assert.equal((p as unknown as { calls: Call[] }).calls.length, 0);
  assert.equal(r.legs.length, 2);
  for (const l of r.legs) {
    assert.match(l.refused ?? "", /not armed by this device's own withdrawal/);
    assert.equal(l.signature, undefined);
  }
});

test("in a mixed set, only the legs armed by the device's own withdrawal are built, and the floors are over their size alone", async () => {
  const fetched: string[] = [];
  const refs: { amount: bigint }[] = [];
  const r = await runSolanaTrade(
    { side: "buy", token: TOKEN, slippageBps: 500, legs: [{ wallet: W1, amount: 30_000_000n, arm: { own: true } }, { wallet: W2, amount: 50_000_000n, arm: { own: false } }, { wallet: W3, amount: 10_000_000n, arm: { own: true } }] },
    deps({ fetched, refs: refs as unknown[] }),
  );
  assert.deepEqual(refs.map((q) => q.amount), [40_000_000n]);
  assert.ok(fetched.length >= 2);
  assert.ok(fetched.every((u) => !u.includes(W2)), "W2 is never sent to the helper");
  assert.ok(fetched.some((u) => u.includes(W1)) && fetched.some((u) => u.includes(W3)));
  assert.match(r.legs[1]?.refused ?? "", /not armed/);
  // E(A) = 1,000,000 for A = 40,000,000: E_1 = 750,000, E_3 = 250,000; at 5 %: 712,500 and 237,500.
  assert.deepEqual([r.legs[0]?.expectedOut, r.legs[0]?.minOut, r.legs[2]?.expectedOut, r.legs[2]?.minOut], [750_000n, 712_500n, 250_000n, 237_500n]);
  // The helper is down: both own legs are refused at the build, nothing is signed.
  assert.match(r.legs[0]?.refused ?? "", /build upstream/);
  assert.equal(r.legs[0]?.signature, undefined);
});

test("no reference pool, no build: every leg is refused", async () => {
  const fetched: string[] = [];
  const r = await runSolanaTrade({ side: "sell", token: TOKEN, slippageBps: 100, legs: [{ wallet: W1, amount: 5n, arm: { own: true } }] }, deps({ fetched, reference: async () => null }));
  assert.deepEqual(fetched, []);
  assert.match(r.legs[0]?.refused ?? "", /no reference pool/);
});

test("the request is checked before anything is read", async () => {
  const leg = { wallet: W1, amount: 1n, arm: { own: true } };
  await assert.rejects(runSolanaTrade({ side: "buy", token: "x", slippageBps: 1, legs: [leg] }, deps()), /address/);
  await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 10_000, legs: [leg] }, deps()), /slippage/);
  await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 1, legs: [leg, leg] }, deps()), /twice/);
  await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 1, legs: [{ ...leg, amount: 0n }] }, deps()), /u64/);
  await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 1, legs: [leg] }, { ...deps(), dry: false }), /no signer/);
});

test("the blockhash is read at finalized on both providers: the older read's hash, with the higher lastValidBlockHeight", async () => {
  const a = reads(2_000);
  const b = reads(1_990);
  const bh = await readSolanaBlockhashBoth([a, b]);
  assert.equal(bh.slot, 1_990);
  assert.equal(bh.blockhash, key(1_990 % 200));
  assert.equal(bh.lastValidBlockHeight, 2_150, "the higher of the two: one provider's lowered answer never shortens the window the signer records");
  for (const p of [a, b]) assert.deepEqual(p.calls.map((c) => [c.method, c.params]), [["getLatestBlockhash", [{ commitment: "finalized" }]]]);
  await assert.rejects(readSolanaBlockhashBoth([a, provider(() => new Error("down"))]));
});

test("T1.3's floors: E_k = floor(E(A) a_k / A), minOut_k = floor(E_k (1 - s))", () => {
  assert.deepEqual(solanaSetFloors(1_000_001n, [1n, 1n, 1n], 300), [
    { expectedOut: 333_333n, minOut: 323_333n },
    { expectedOut: 333_333n, minOut: 323_333n },
    { expectedOut: 333_333n, minOut: 323_333n },
  ]);
  assert.throws(() => solanaSetFloors(0n, [1n], 1));
  assert.throws(() => solanaSetFloors(1n, [0n], 1));
  assert.throws(() => solanaSetFloors(1n, [1n], 10_000));
});

test("the rebuild slippage puts the route's floor on or above minOut, and a route quoting no more than minOut is refused", () => {
  let seed = 7n;
  const rnd = (max: bigint) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n), (seed % max) + 1n);
  for (let i = 0; i < 2_000; i++) {
    const quotedOut = rnd(10n ** 15n);
    const minOut = rnd(quotedOut);
    const s = solanaRebuildSlippage(quotedOut, minOut);
    if (minOut >= quotedOut) assert.equal(s, null);
    else {
      assert.ok(s !== null && s >= 0 && s < 10_000);
      assert.ok(solanaRouteFloor({ quotedOut, slippageBps: s }) >= minOut, `${quotedOut} ${minOut} ${s}`);
    }
  }
  assert.equal(solanaRebuildSlippage(100n, 100n), null);
  assert.equal(solanaRebuildSlippage(100n, 101n), null);
});

// ---- the unknown at the deadline
const status = (s: unknown) => provider((c) => (c.method === "getSignatureStatuses" ? (s instanceof Error ? s : { context: { slot: 5 }, value: [s] }) : new Error("unexpected")));
const ok = { slot: 4, confirmations: null, err: null, confirmationStatus: "confirmed" };
const fin = { ...ok, confirmationStatus: "finalized" };
const bad = { ...ok, err: { InstructionError: [3, { Custom: 6001 }] } };
const proc = { ...ok, confirmationStatus: "processed" };
const SIG = base58.encode(new Uint8Array(64).fill(4));
const unknownTx: SolanaTxOutcome = { signature: SIG, state: "unknown" } as unknown as SolanaTxOutcome;

test("a tx unknown at the deadline is read again on both providers with the history search, and is filled only when both say so", async () => {
  const a = status(ok);
  const b = status(fin);
  const [s] = await settleSolanaSet([a, b], [unknownTx]);
  assert.equal(s?.state, "filled");
  for (const p of [a, b]) assert.deepEqual(p.calls.map((c) => c.params), [[[SIG], { searchTransactionHistory: true }]]);
});

test("an unknown that one provider does not see, sees only at processed, or cannot read stays unknown: never a fill, never dead", async () => {
  for (const [x, y] of [[ok, null], [null, ok], [ok, proc], [ok, new Error("down")], [null, null], [ok, bad]] as const) {
    const [s] = await settleSolanaSet([status(x), status(y)], [unknownTx]);
    assert.equal(s?.state, "unknown", JSON.stringify([x, y]));
  }
});

test("an unknown both providers read as landed with an error is failed", async () => {
  assert.equal((await rereadSolanaSignature([status(bad), status(bad)], SIG)).state, "failed");
});

test("a tx the send already settled is not read again", async () => {
  const a = status(ok);
  const b = status(ok);
  const settled = await settleSolanaSet([a, b], [{ signature: SIG, state: "filled" } as unknown as SolanaTxOutcome, { signature: SIG, state: "expired" } as unknown as SolanaTxOutcome]);
  assert.deepEqual(settled.map((s) => s.state), ["filled", "expired"]);
  assert.equal(a.calls.length + b.calls.length, 0);
});
