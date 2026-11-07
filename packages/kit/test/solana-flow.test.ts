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
  solanaPacedRpc,
  solanaSameProvider,
  type SolanaRpc,
  type SolanaTradeDeps,
  type SolanaTxOutcome,
} from "../src/index.ts";

const key = (n: number) => base58.encode(new Uint8Array(32).fill(n));
const TOKEN = key(9);
const W1 = key(1);
const W2 = key(2);
const W3 = key(3);
// Every Solana wallet of the user: the set's and others the trade never names.
const WALLETS = [W1, W2, W3, key(4)];

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
  const r = await runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 500, wallets: WALLETS, legs: [{ wallet: W1, amount: 10_000_000n, arm: { own: false } }, { wallet: W2, amount: 10_000_000n, arm: { own: false } }] }, { ...d, dry: false });
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
  const r = await runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 500, wallets: WALLETS, legs: [{ wallet: W1, amount: 30_000_000n, arm: { own: true } }, { wallet: W2, amount: 50_000_000n, arm: { own: false } }, { wallet: W3, amount: 10_000_000n, arm: { own: true } }] },
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

test("no reference pool: every leg is refused; its build, out with the first reads (card solana-quote-under-1s), is dropped and nothing signed", async () => {
  const fetched: string[] = [];
  const r = await runSolanaTrade({ side: "sell", token: TOKEN, slippageBps: 100, wallets: WALLETS, legs: [{ wallet: W1, amount: 5n, arm: { own: true } }] }, deps({ fetched, reference: async () => null }));
  assert.ok(fetched.length <= 1, `${fetched.length} builds`);
  assert.match(r.legs[0]?.refused ?? "", /no reference pool/);
  assert.equal(r.legs[0]?.verdict, undefined);
  assert.equal(r.legs[0]?.signature, undefined);
});

test("the request is checked before anything is read", async () => {
  const leg = { wallet: W1, amount: 1n, arm: { own: true } };
  await assert.rejects(runSolanaTrade({ side: "buy", token: "x", slippageBps: 1, wallets: WALLETS, legs: [leg] }, deps()), /address/);
  await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 10_000, wallets: WALLETS, legs: [leg] }, deps()), /slippage/);
  await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 1, wallets: WALLETS, legs: [leg, leg] }, deps()), /twice/);
  await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 1, wallets: WALLETS, legs: [{ ...leg, amount: 0n }] }, deps()), /u64/);
  await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 1, wallets: WALLETS, legs: [leg] }, { ...deps(), dry: false }), /no signer/);
  // the user's wallets: a list of addresses that holds every leg's wallet
  await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 1, wallets: [W2], legs: [leg] }, deps()), /not in the user's wallets/);
  await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 1, wallets: undefined as unknown as string[], legs: [leg] }, deps()), /user's wallet addresses/);
  await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 1, wallets: [W1, "x"], legs: [leg] }, deps()), /user's wallet addresses/);
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
  const wire = await solanaSignedWire({ sign: async (w, m) => { assert.equal(w, PK); return ed25519.sign(m, SK); } }, PK, { lastValidBlockHeight: 1_000, wire: WIRE, message: MSG });
  assert.ok(ed25519.verify(wire.subarray(1, 65), MSG, base58.decode(PK)));
  assert.deepEqual(wire.subarray(65), MSG);
  const other = hexToBytes("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
  await assert.rejects(solanaSignedWire({ sign: async (_, m) => ed25519.sign(m, other) }, PK, { lastValidBlockHeight: 1_000, wire: WIRE, message: MSG }), /does not verify/);
  await assert.rejects(solanaSignedWire({ sign: async (_, m) => ed25519.sign(Uint8Array.from([...m, 0]), SK) }, PK, { lastValidBlockHeight: 1_000, wire: WIRE, message: MSG }), /does not verify/);
  await assert.rejects(solanaSignedWire({ sign: async () => new Uint8Array(63) }, PK, { lastValidBlockHeight: 1_000, wire: WIRE, message: MSG }), /does not verify/);
  await assert.rejects(solanaSignedWire({}, PK, { lastValidBlockHeight: 1_000, wire: WIRE, message: MSG }), /no signer/);
  const dry = await solanaSignedWire({ dry: true, sign: async () => assert.fail("dry never signs") }, PK, { lastValidBlockHeight: 1_000, wire: WIRE, message: MSG });
  assert.equal(dry.length, WIRE.length);
});

test("the message signed is the checked wire's own message: any other is refused before the signer is asked", async () => {
  const never = { sign: async () => assert.fail("never signed") };
  const other = Uint8Array.from([0x80, 1, 2, 3, 4, 6]);
  await assert.rejects(solanaSignedWire(never, PK, { lastValidBlockHeight: 1_000, wire: WIRE, message: other }), /not the checked wire's message/);
  await assert.rejects(solanaSignedWire(never, PK, { lastValidBlockHeight: 1_000, wire: WIRE, message: MSG.subarray(1) }), /not the checked wire's message/);
  await assert.rejects(solanaSignedWire(never, PK, { lastValidBlockHeight: 1_000, wire: Uint8Array.from([2, ...new Uint8Array(128), ...MSG]), message: MSG }), /not the checked wire's message/);
  // two signature slots, the length and the message otherwise right: only the first byte refuses it
  await assert.rejects(solanaSignedWire(never, PK, { lastValidBlockHeight: 1_000, wire: Uint8Array.from([2, ...new Uint8Array(64), ...MSG]), message: MSG }), /not the checked wire's message/);
  await assert.rejects(solanaSignedWire({ dry: true }, PK, { lastValidBlockHeight: 1_000, wire: WIRE, message: other }), /not the checked wire's message/);
});

test("the signer is handed the lastValidBlockHeight of the very tx it signs, and a tx without one is never signed", async () => {
  const MSG2 = Uint8Array.from([0x80, 9, 8, 7]);
  const WIRE2 = Uint8Array.from([1, ...new Uint8Array(64), ...MSG2]);
  const got: { m: string; h: number }[] = [];
  const signer = { sign: async (_w: string, m: Uint8Array, tx: { lastValidBlockHeight: number }) => { got.push({ m: Buffer.from(m).toString("hex"), h: tx.lastValidBlockHeight }); return ed25519.sign(m, SK); } };
  await solanaSignedWire(signer, PK, { wire: WIRE, message: MSG, lastValidBlockHeight: 1_000 });
  await solanaSignedWire(signer, PK, { wire: WIRE2, message: MSG2, lastValidBlockHeight: 2_000 });
  assert.deepEqual(got, [{ m: Buffer.from(MSG).toString("hex"), h: 1_000 }, { m: Buffer.from(MSG2).toString("hex"), h: 2_000 }]);
  const never = { sign: async () => assert.fail("never signed") };
  for (const h of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1000"]) {
    await assert.rejects(solanaSignedWire(never, PK, { wire: WIRE, message: MSG, lastValidBlockHeight: h as number }), /no lastValidBlockHeight/);
  }
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
const rec = (w: string, sellsAll = true) => ({ wallet: w, amount: 5n, expectedOut: 10n, minOut: 9n, sellsAll }) as Parameters<typeof finishSolanaSet>[1][number];
const tx = (n: number, state: string) => ({ signature: base58.encode(new Uint8Array(64).fill(n)), state }) as unknown as SolanaTxOutcome;
const sellReq = { side: "sell" as const, token: TOKEN, slippageBps: 100, wallets: WALLETS, legs: [] };
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

test("the stage goes out as soon as the fills are read, before any teardown read or send", async () => {
  const log: string[] = [];
  const atas = new Map([W1, W2].map((w) => [solanaAta(w, TOKEN, T), w]));
  const mk = (who: string) => {
    const p = after(() => ok, (k) => (atas.has(k) ? tokenAcc(0n, atas.get(k)) : null));
    return Object.assign(async (m: string, params: readonly unknown[]) => { log.push(`${who} ${m}`); return p(m, params); }, { calls: p.calls });
  };
  const r = [rec(W1), rec(W2)];
  const stage = await finishSolanaSet(sellReq, r, [tx(1, "filled"), tx(2, "filled")], fdeps(mk("A"), mk("B")), T, (s) => log.push(`STAGE ${s}`));
  assert.equal(stage, "filled");
  const at = log.indexOf("STAGE filled");
  const firstTeardown = log.findIndex((x) => / getMultipleAccounts$/.test(x));
  assert.ok(at >= 0 && firstTeardown > at, log.join(" | "));
  assert.ok(r[0]?.teardown, "the teardown still ran, after the stage");
});

test("one queue a provider: called on its own, the settle reads and three teardowns stay within the provider's rate", async () => {
  const atas = new Map([W1, W2, W3].map((w) => [solanaAta(w, TOKEN, T), w]));
  const mk = () => {
    const p = after(() => ok, (k) => (atas.has(k) ? tokenAcc(0n, atas.get(k)) : null));
    const times: number[] = [];
    return Object.assign(async (m: string, params: readonly unknown[]) => { times.push(Date.now()); return p(m, params); }, { times });
  };
  const a = mk();
  const b = mk();
  const r = [rec(W1), rec(W2), rec(W3)];
  assert.equal(await finishSolanaSet(sellReq, r, [tx(1, "unknown"), tx(2, "unknown"), tx(3, "unknown")], { ...fdeps(a, b), providerRps: [4, 4] }, T), "filled");
  assert.ok(r.every((x) => x.teardown), "three teardowns read and checked");
  for (const p of [a, b]) {
    assert.ok(p.times.length > 8, `${p.times.length} calls`);
    const most = Math.max(...p.times.map((x) => p.times.filter((y) => y >= x && y < x + 1_000).length));
    assert.ok(most <= 4, `${most} calls in one second`);
  }
});

test("a filled sell of part of a balance is not torn down; only a sell of the whole balance is", async () => {
  const atas = new Map([W1, W2].map((w) => [solanaAta(w, TOKEN, T), w]));
  const a = after(() => ok, (k) => (atas.has(k) ? tokenAcc(0n, atas.get(k)) : null));
  const b = after(() => ok, (k) => (atas.has(k) ? tokenAcc(0n, atas.get(k)) : null));
  const r = [rec(W1, false), rec(W2, true)];
  assert.equal(await finishSolanaSet(sellReq, r, [tx(1, "filled"), tx(2, "filled")], fdeps(a, b), T), "filled");
  assert.equal(r[0]?.teardown, undefined);
  assert.ok(r[1]?.teardown);
  const read = (p: { calls: Call[] }) => p.calls.filter((c) => c.method === "getMultipleAccounts").flatMap((c) => c.params[0] as string[]);
  assert.ok(!read(a).includes(solanaAta(W1, TOKEN, T)) && !read(b).includes(solanaAta(W1, TOKEN, T)), "nothing is read for the part sell's teardown");
});

test("one provider passed twice, bare and wrapped or by one URL, is refused before any read, by the trade and by its finish", async () => {
  const req = { side: "buy" as const, token: TOKEN, slippageBps: 100, wallets: WALLETS, legs: [{ wallet: W1, amount: 5n, arm: { own: true } }] };
  const p = reads(1_000);
  const twins: [SolanaRpc, SolanaRpc][] = [
    [p, p],
    [p, solanaPacedRpc(p)],
    [solanaPacedRpc(p), p],
    [Object.assign(async () => null, { url: "https://same.example" }), Object.assign(async () => null, { url: "https://same.example/" })],
  ];
  for (const providers of twins) {
    const refs: unknown[] = [];
    await assert.rejects(runSolanaTrade(req, deps({ providers, refs })), /same provider/);
    await assert.rejects(finishSolanaSet(req, [], [], deps({ providers }), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), /same provider/);
    assert.equal(refs.length, 0, "no reference read");
  }
  assert.equal(p.calls.length, 0, "no read");
});

test("the reference reads through the trade's paced providers: the same providers, in their shared queues", async () => {
  const pa = reads(1_000);
  const pb = reads(1_001);
  let given: readonly SolanaRpc[] = [];
  const req = { side: "buy" as const, token: TOKEN, slippageBps: 100, wallets: WALLETS, legs: [{ wallet: W1, amount: 5n, arm: { own: true } }] };
  await runSolanaTrade(req, deps({ providers: [pa, pb], reference: async (_q, providers) => { given = providers; return null; } }));
  assert.equal(given.length, 2);
  assert.ok(given[0] !== pa && given[1] !== pb, "wrapped, not the bare providers");
  assert.ok(solanaSameProvider(given[0]!, pa) && solanaSameProvider(given[1]!, pb), "the trade's own two providers");
});

test("heldMints that are not addresses refuse the trade before any read", async () => {
  for (const heldMints of [["11111111"], ["not a key"], [base58.encode(new Uint8Array(31).fill(3))]]) {
    const refs: unknown[] = [];
    const providers: [SolanaRpc & { calls: Call[] }, SolanaRpc & { calls: Call[] }] = [reads(1_000), reads(1_001)];
    await assert.rejects(runSolanaTrade({ side: "buy", token: TOKEN, slippageBps: 100, wallets: WALLETS, heldMints, legs: [{ wallet: W1, amount: 5n, arm: { own: true } }] }, deps({ providers, refs })), /heldMints must be mint addresses/);
    assert.equal(refs.length + providers[0].calls.length + providers[1].calls.length, 0);
  }
});
