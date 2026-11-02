/// <reference types="node" />
// The Solana trade joined (markets paper §6.1 M1.1-M1.3, T1.3, LD1; wallet paper §2.3): a wallet not armed by the
// device's own withdrawal is refused before anything is read or built for it; the floors come from the device's own
// E(A); the blockhash is read at finalized on both providers; a tx unknown at the send's deadline is read again on both
// providers and is a fill or a failure only when both agree. Fake endpoints only: nothing here reaches a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  finishSolanaSet,
  readSolanaBlockhashBoth,
  solanaSignedWire,
  rereadSolanaSignature,
  runSolanaTrade,
  settleSolanaSet,
  solanaRebuildSlippage,
  solanaRouteFloor,
  solanaSetFloors,
  solanaAta,
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
      return { expectedOut: 1_000_000n, expectedOuts: q.amounts.map((a) => (1_000_000n * a) / q.amount) };
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

test("the blockhash is read at finalized on both providers, and the older read is used", async () => {
  const a = reads(2_000);
  const b = reads(1_990);
  const bh = await readSolanaBlockhashBoth([a, b]);
  assert.equal(bh.slot, 1_990);
  assert.equal(bh.lastValidBlockHeight, 2_140);
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

test("a landed status without its err field is no answer: it stays unknown, never a fill", async () => {
  const noErr = { slot: 4, confirmations: null, confirmationStatus: "confirmed" };
  assert.equal((await rereadSolanaSignature([status(noErr), status(noErr)], SIG)).state, "unknown");
  assert.equal((await rereadSolanaSignature([status({ ...noErr, err: undefined }), status(ok)], SIG)).state, "unknown");
});

// ---- the signature: RFC 8032 section 7.1 test 1's published key (never a wallet of anyone's)
const SK = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const PK = base58.encode(ed25519.getPublicKey(SK));
const MSG = Uint8Array.from([0x80, 1, 2, 3, 4, 5]);
const WIRE = Uint8Array.from([1, ...new Uint8Array(64), ...MSG]);

test("the signer's answer goes into the slot only when it verifies against the wallet's key", async () => {
  const wire = await solanaSignedWire({ sign: async (w, m) => { assert.equal(w, PK); return ed25519.sign(m, SK); } }, PK, { wire: WIRE, message: MSG });
  assert.ok(ed25519.verify(wire.subarray(1, 65), MSG, base58.decode(PK)));
  assert.deepEqual(wire.subarray(65), MSG);
  const other = hexToBytes("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
  await assert.rejects(solanaSignedWire({ sign: async (_, m) => ed25519.sign(m, other) }, PK, { wire: WIRE, message: MSG }), /does not verify/);
  await assert.rejects(solanaSignedWire({ sign: async (_, m) => ed25519.sign(Uint8Array.from([...m, 0]), SK) }, PK, { wire: WIRE, message: MSG }), /does not verify/);
  await assert.rejects(solanaSignedWire({ sign: async () => new Uint8Array(63) }, PK, { wire: WIRE, message: MSG }), /does not verify/);
  await assert.rejects(solanaSignedWire({}, PK, { wire: WIRE, message: MSG }), /no signer/);
  const dry = await solanaSignedWire({ dry: true, sign: async () => assert.fail("dry never signs") }, PK, { wire: WIRE, message: MSG });
  assert.equal(dry.length, WIRE.length);
});

// ---- after the send
type Acct = { owner: string; lamports: number; data: [string, string] } | null;
const T = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const tokenAcc = (amount: bigint, owner = W1): Acct => {
  const d = new Uint8Array(165);
  d.set(base58.decode(TOKEN), 0);
  d.set(base58.decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  return { owner: T, lamports: 2_039_280, data: [Buffer.from(d).toString("base64"), "base64"] };
};
// A provider for finishSolanaSet: signature statuses, and every account read answering `acc(key)`.
function after(statusOf: (sig: string) => unknown, acc: (key: string) => Acct | Error = () => null) {
  return provider((c) => {
    if (c.method === "getSignatureStatuses") return { context: { slot: 9 }, value: (c.params[0] as string[]).map(statusOf) };
    if (c.method === "getMultipleAccounts") {
      const keys = c.params[0] as string[];
      const v = keys.map(acc);
      const e = v.find((x) => x instanceof Error);
      return e ?? { context: { slot: 9 }, value: v };
    }
    if (c.method === "getLatestBlockhash") return blockhashAnswer(9, 9);
    return new Error(`unexpected ${c.method}`);
  });
}
const rec = (w: string) => ({ wallet: w, amount: 5n, expectedOut: 10n, minOut: 9n }) as Parameters<typeof finishSolanaSet>[1][number];
const tx = (n: number, state: string) => ({ signature: base58.encode(new Uint8Array(64).fill(n)), state }) as unknown as SolanaTxOutcome;
const sellReq = { side: "sell" as const, token: TOKEN, slippageBps: 100, legs: [] };
const fdeps = (a: SolanaRpc, b: SolanaRpc) => ({ ...deps(), providers: [a, b] as const, dry: false });

test("after the send: an unknown none filled gives no stage, never not_landed, and no teardown behind it", async () => {
  const r = [rec(W1)];
  const a = after(() => ok);
  const b = after(() => null);
  assert.equal(await finishSolanaSet(sellReq, r, [tx(1, "unknown")], fdeps(a, b), T), null);
  assert.equal(r[0]?.teardown, undefined);
  assert.ok(a.calls.every((c) => c.method === "getSignatureStatuses"));
});

test("after the send: the stage from both providers' word", async () => {
  const a = after(() => ok);
  const b = after(() => ok);
  assert.equal(await finishSolanaSet({ ...sellReq, side: "buy" }, [rec(W1), rec(W2)], [tx(1, "filled"), tx(2, "expired")], fdeps(a, b), T), "part_filled");
  assert.equal(await finishSolanaSet({ ...sellReq, side: "buy" }, [rec(W1), rec(W2)], [tx(1, "failed"), tx(2, "expired")], fdeps(a, b), T), "not_landed");
  assert.equal(await finishSolanaSet({ ...sellReq, side: "buy" }, [rec(W1)], [tx(1, "unknown")], fdeps(a, b), T), "filled");
});

test("after a filled sell, the teardown runs only on a token account both providers read empty", async () => {
  const r = [rec(W1), rec(W2), rec(W3)];
  const atas = new Map([W1, W2, W3].map((w) => [solanaAta(w, TOKEN, T), w]));
  const a = after(() => ok, (k) => (atas.has(k) ? tokenAcc(0n, atas.get(k)) : null));
  const b = after(() => ok, (k) => (atas.has(k) ? tokenAcc(k === solanaAta(W2, TOKEN, T) ? 1n : 0n, atas.get(k)) : null));
  assert.equal(await finishSolanaSet(sellReq, r, [tx(1, "filled"), tx(2, "filled"), tx(3, "failed")], fdeps(a, b), T), "part_filled");
  // W1's empty account goes to the teardown's own reads and checks (here its simulation has no answer, so it is refused
  // at the checks, after the empty read); W2's is not torn down; W3 did not fill.
  assert.ok(r[0]?.teardown && !/still holds/.test(r[0].teardown.refused ?? ""), String(r[0]?.teardown?.refused));
  assert.equal(r[0]?.teardown?.verdict.plan?.close.length, 1);
  assert.match(r[1]?.teardown?.refused ?? "", /still holds tokens/);
  assert.equal(r[2]?.teardown, undefined);
});

test("a filled sell keeps its record when the read after it fails: the failure is on rec.teardown, nothing throws", async () => {
  const r = [rec(W1)];
  const a = after(() => ok, () => new Error("HTTP 429"));
  const b = after(() => ok, (k) => (k === solanaAta(W1, TOKEN, T) ? tokenAcc(0n) : null));
  assert.equal(await finishSolanaSet(sellReq, r, [tx(1, "filled")], fdeps(a, b), T), "filled");
  assert.equal(r[0]?.outcome?.state, "filled");
  assert.match(r[0]?.teardown?.refused ?? "", /429/);
});
