// node --test apps/helper/src/pool/solana-pieces.test.ts: POST /v1/pool/solana/pieces (card buy-spends-several-pieces)
// carries one buy made of several pieces: the tag 2s plain, then the tag 3 as the one-piece route sends it (card
// owners-solana-buy-lands); or refuses it before anything is sent. Every key here is a test key: ed25519 of
// sha256("helper-pool-senders/test-key/<name>"), as solana.test.ts makes them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_JITO_TIP_ACCOUNTS,
  SOLANA_POOL_BUY_PIECES_MAX,
  SOLANA_POOL_PAGE_ENTRIES,
  solanaCompileV0,
  solanaEncodePoolRelease,
  solanaEncodePoolTag3,
  solanaPoolAccount,
  solanaPoolReleaseAccounts,
  type SolanaApiInstruction,
  type SolanaPoolRelease,
  type SolanaRent,
  type SolanaRpc,
} from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import { jitoSender } from "./jito.ts";
import { poolSendLine } from "./send-log.ts";
import { LANDED_READ_PACE_MS, POOL_LANDED_READ_MS, solanaPoolSender, type PoolPiecesAnswer, type SolanaPoolSenderDeps } from "./solana.ts";

const testKey = (name: string) => {
  const seed = new Uint8Array(createHash("sha256").update(`helper-pool-senders/test-key/${name}`).digest());
  const pub = ed25519.getPublicKey(seed);
  return { seed, address: base58(pub), secret: base58(Uint8Array.from([...seed, ...pub])) };
};
const FP = testKey("FEE_PAYER");
const W = testKey("W");
const W2 = testKey("W2");
const PROGRAM = testKey("PROGRAM").address;
const POOL = solanaPoolAccount(PROGRAM);
const TIP_TO = testKey("TIP_TO").address;
const TO = testKey("TO").address;
const BLOCKHASH = testKey("BLOCKHASH").address;
const FEE = 2_000_000n;
const TEST_RENT: SolanaRent = { lamportsPerByte: 8_400n, factor: 1n };
const NOW = 1_800_000_000_000;

const field = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
const release = (nullifier: number): SolanaPoolRelease => ({
  proof: new Uint8Array(256).fill(7),
  newCommitmentHash: field(1),
  existingNullifierHash: field(nullifier),
  withdrawnValue: 50_000_000n,
  stateRootIndex: 5,
  stateTreeDepth: 3,
  labelRootIndex: 5,
  labelTreeDepth: 3,
  relayFee: FEE,
  relayFeeCap: 3_000_000n,
  tipCap: 10_000n,
  deadlineMs: 1_800_000_270_000n,
  salt: new Uint8Array(16).fill(9),
});
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const cuLimit = (n: number): SolanaApiInstruction => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([2, ...u32(n)]) });
const cuPrice = (n: bigint): SolanaApiInstruction => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([3, ...u64(n)]) });

/** A piece W signed, the fee payer's slot empty: a tag 2, or the tag 3 that buys (its tip to a Jito tip account). */
function piece(o: { tag: 2 | 3; nullifier: number; w?: typeof W; tipTo?: string; cuPrice?: bigint; stateSize?: number }): Uint8Array {
  const w = o.w ?? W;
  const r = release(o.nullifier);
  const accounts = solanaPoolReleaseAccounts({ program: PROGRAM, pool: POOL }, w.address, FP.address, r, o.stateSize ?? 6);
  let data: Uint8Array;
  if (o.tag === 2) data = solanaEncodePoolRelease(r);
  else {
    accounts.push({ key: o.tipTo ?? SOLANA_JITO_TIP_ACCOUNTS[0]!, signer: false, writable: true }, { key: TO, signer: false, writable: true });
    data = solanaEncodePoolTag3(r, false, 10_000n, [{ program: 7, accounts: [1, 9], data: Uint8Array.from([2, 0, 0, 0, ...u64(1_000_000n)]) }]);
  }
  const { message } = solanaCompileV0(FP.address, [cuLimit(400_000), cuPrice(o.cuPrice ?? 1_000n), { program: PROGRAM, accounts, data }], BLOCKHASH, [], [FP.address, w.address]);
  return Uint8Array.from([2, ...new Uint8Array(64), ...ed25519.sign(message, w.seed), ...message]);
}
const b64 = (w: Uint8Array) => Buffer.from(w).toString("base64");

type Calls = { method: string; params: readonly unknown[] }[];
/** `fail`: a call this answers with a throw (a provider's 429, say) instead of its answer. */
function rpcStub(calls: Calls = [], simErr: unknown = null, fail?: (method: string, params: readonly unknown[]) => Error | null): SolanaRpc {
  return Object.assign(
    async (method: string, params: readonly unknown[]) => {
      calls.push({ method, params });
      const e = fail?.(method, params);
      if (e) throw e;
      if (method === "simulateTransaction") return { context: { slot: 1 }, value: { err: typeof simErr === "function" ? (simErr as (raw: unknown) => unknown)(params[0]) : simErr, logs: [] } };
      if (method === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } };
      throw new Error(`unexpected ${method}`);
    },
    { url: `https://stub.invalid/${Math.random()}` },
  );
}

test("RED first: a body whose pieces two wallets signed is refused wallets_differ, nothing read or sent", async () => {
  const calls: Calls = [];
  const sent: Uint8Array[][] = [];
  const s = solanaPoolSender(
    { cluster: "devnet", program: PROGRAM, feePayerSecret: FP.secret, fee: String(FEE) },
    {
      providers: [rpcStub(calls), rpcStub(calls)],
      now: () => NOW,
      readRent: async () => TEST_RENT,
      log: () => {},
      send: (set) => {
        sent.push(set.map((t) => t.wire));
        throw new Error("nothing may be sent");
      },
    },
  );
  const a = await s.carryPieces({ pool: POOL, txs: [b64(piece({ tag: 2, nullifier: 2 })), b64(piece({ tag: 3, nullifier: 3, w: W2 }))] });
  assert.equal(a.status, 422);
  assert.equal("error" in a.body ? a.body.error.code : "ok", "wallets_differ");
  assert.deepEqual([calls.length, sent.length], [0, 0]);
});

// ---- the stand-ins: providers, the kit's sender, the block engines ----

const code = (a: PoolPiecesAnswer) => ("error" in a.body ? a.body.error.code : "ok");
const tick = () => new Promise((r) => setImmediate(r));
const deferred = <T>() => {
  let done!: (v: T) => void;
  const p = new Promise<T>((r) => (done = r));
  return { p, done };
};
type Set = { wires: Uint8Array[]; paths: string[] };
type EngineCall = { url: string; method: string; params: unknown[] };
/** A sender on `cluster` whose kit sender records each set and, for a set with a block engine path, drives it twice
 *  (the first send, then one rebroadcast) before the set's end `end` gives. */
function rig(cluster: "devnet" | "mainnet", o: { end?: (n: number) => Promise<string>; result?: unknown; simErr?: unknown; fail?: (method: string, params: readonly unknown[]) => Error | null } = {}) {
  const calls: Calls = [];
  const sets: Set[] = [];
  const pauses: number[] = [];
  const engine: EngineCall[] = [];
  const jito =
    cluster === "mainnet"
      ? jitoSender({
          regions: ["https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true", "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true"],
          intervalMs: 0,
          timeoutMs: 1_000,
          fetch: async (url, init) => {
            const j = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
            engine.push({ url, method: j.method, params: j.params });
            // a transaction send answers its own signature, as a block engine does
            const sig = j.method === "sendTransaction" ? base58(new Uint8Array(Buffer.from(String(j.params[0]), "base64")).subarray(1, 65)) : undefined;
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: o.result ?? sig ?? "ab".repeat(32) }), { status: 200 });
          },
        })
      : null;
  const deps: SolanaPoolSenderDeps = {
    providers: [rpcStub(calls, o.simErr, o.fail), rpcStub(calls)],
    now: () => NOW,
    readRent: async () => TEST_RENT,
    log: () => {},
    jito,
    pause: async (ms) => void pauses.push(ms),
    // the log line's timed reads never come before the send ends
    wait: (_ms, signal) => new Promise<boolean>((r) => (signal.aborted ? r(false) : signal.addEventListener("abort", () => r(false), { once: true }))),
    send: (set, opts) => {
      const n = sets.length;
      sets.push({ wires: set.map((t) => t.wire), paths: opts.paths.map((p) => p.name) });
      const sig = base58(set[0]!.wire.subarray(1, 65));
      const done = (async () => {
        const sends: { path: string; attempt: number; ok: boolean; ms: number }[] = [];
        if (opts.paths[0]?.name === "jito") for (let i = 0; i < 2; i++) sends.push({ path: "jito", attempt: i, ok: (await opts.paths[0]!.send(b64(set[0]!.wire))) === sig, ms: 0 });
        const state = await (o.end ?? (async () => "filled"))(n);
        // set n lands at slot 100 + n, as provider a reads it
        return { txs: [{ signature: sig, state: state as "filled", sends, ...(state === "filled" ? { slot: 100 + n } : {}) }] };
      })();
      return { signatures: [sig], done, stop() {} };
    },
  };
  const s = solanaPoolSender({ cluster, program: PROGRAM, feePayerSecret: FP.secret, fee: String(FEE) }, deps);
  return { s, calls, sets, engine, pauses };
}
const two = () => [piece({ tag: 2, nullifier: 2 }), piece({ tag: 3, nullifier: 3 })];
const bodyOf = (ws: Uint8Array[]) => ({ pool: POOL, txs: ws.map(b64) });
/** The fee payer's signature of a piece W signed, over its message: what the helper adds in slot 0. */
const fpSig = (w: Uint8Array) => base58(ed25519.sign(w.subarray(129), FP.seed));

test("count bounds: one transaction, more than SOLANA_POOL_BUY_PIECES_MAX, or no list are bad_shape (400), nothing read or sent", async () => {
  const { s, calls, sets, engine } = rig("mainnet");
  const many = [...Array.from({ length: SOLANA_POOL_BUY_PIECES_MAX }, (_, i) => piece({ tag: 2, nullifier: 10 + i })), piece({ tag: 3, nullifier: 3 })];
  assert.equal(many.length, SOLANA_POOL_BUY_PIECES_MAX + 1);
  for (const body of [bodyOf([piece({ tag: 3, nullifier: 3 })]), bodyOf(many), { pool: POOL, txs: b64(piece({ tag: 3, nullifier: 3 })) }, { pool: POOL }, { pool: POOL, txs: [], extra: 1 }, { pool: POOL, txs: ["not base64!", "AA=="] }]) {
    const a = await s.carryPieces(body);
    assert.deepEqual([a.status, code(a)], [400, "bad_shape"], JSON.stringify(body).slice(0, 80));
  }
  assert.deepEqual([calls.length, sets.length, engine.length], [0, 0, 0]);
});

test("order: a tag 3 not last, or a tag 2 last, is bad_shape (400), nothing read or sent", async () => {
  const { s, calls, sets, engine } = rig("mainnet");
  for (const ws of [[piece({ tag: 3, nullifier: 3 }), piece({ tag: 2, nullifier: 2 })], [piece({ tag: 2, nullifier: 2 }), piece({ tag: 2, nullifier: 4 })], [piece({ tag: 2, nullifier: 2 }), piece({ tag: 3, nullifier: 3 }), piece({ tag: 3, nullifier: 4 })]]) {
    const a = await s.carryPieces(bodyOf(ws));
    assert.deepEqual([a.status, code(a)], [400, "bad_shape"]);
  }
  assert.deepEqual([calls.length, sets.length, engine.length], [0, 0, 0]);
});

test("a nullifier twice is bad_shape (400); a piece failing its own one-piece check is refused with its code", async () => {
  const { s, calls, sets } = rig("mainnet");
  const a = await s.carryPieces(bodyOf([piece({ tag: 2, nullifier: 2 }), piece({ tag: 3, nullifier: 2 })]));
  assert.deepEqual([a.status, code(a)], [400, "bad_shape"]);
  // the tag 3's tip to an account that is not a Jito one: tip_low, as on the one-piece route on mainnet
  const b = await s.carryPieces(bodyOf([piece({ tag: 2, nullifier: 2 }), piece({ tag: 3, nullifier: 3, tipTo: TIP_TO })]));
  assert.deepEqual([b.status, code(b)], [422, "tip_low"]);
  const c = two();
  c[0]![70]! ^= 1; // W's signature of the tag 2
  assert.equal(code(await s.carryPieces(bodyOf(c))), "bad_signature");
  assert.deepEqual([calls.length, sets.length], [0, 0]);
});

test("a tag 2 the simulation refuses: blockhash_not_found or simulation_failed (422), as on the one-piece route, nothing sent", async () => {
  for (const [err, want] of [["BlockhashNotFound", "blockhash_not_found"], [{ InstructionError: [2, { Custom: 16 }] }, "simulation_failed"]] as const) {
    for (const cluster of ["devnet", "mainnet"] as const) {
      const { s, sets, engine } = rig(cluster, { simErr: err });
      const a = await s.carryPieces(bodyOf(two()));
      assert.deepEqual([a.status, code(a)], [422, want], `${cluster} ${want}`);
      assert.deepEqual([sets.length, engine.length], [0, 0]);
    }
  }
});

test("RED at 4c1826a7: mainnet sends the tag 2s plain, side by side, then the tag 3 as the one-piece route does: simulated on the state they left, the bundle beside the plain copy, its tip in the log line; the answer only after the fill", async () => {
  const ends = [deferred<string>(), deferred<string>(), deferred<string>()];
  const { s, calls, sets, engine } = rig("mainnet", { end: (n) => ends[n]!.p });
  const ws = [piece({ tag: 2, nullifier: 2 }), piece({ tag: 2, nullifier: 4 }), piece({ tag: 3, nullifier: 3 })];
  const p = s.carryPieces(bodyOf(ws));
  let settled = false;
  void p.then(() => (settled = true));
  for (let i = 0; i < 20; i++) await tick();
  const sims = () => calls.filter((c) => c.method === "simulateTransaction").map((c) => c.params[0]);
  assert.deepEqual(sims(), [b64(ws[0]!), b64(ws[1]!)], "the tag 2s simulated before anything is sent");
  assert.deepEqual(sets.map((x) => x.paths), [["rpc0", "rpc1"], ["rpc0", "rpc1"]], "both tag 2s at once, plain");
  assert.equal(engine.length, 0, "no block engine for a tag 2");
  sets.forEach((x, i) => assert.equal(base58(x.wires[0]!.subarray(1, 65)), fpSig(ws[i]!)));
  ends[0]!.done("filled");
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(sets.length, 2, "the tag 3 waits for every tag 2");
  ends[1]!.done("filled");
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(sims(), [b64(ws[0]!), b64(ws[1]!), b64(ws[2]!)], "the tag 3 simulated once the tag 2s landed");
  assert.deepEqual(sets[2]!.paths, ["jito", "rpc0", "rpc1"], "the tag 3: the bundle beside the plain copy");
  assert.ok(engine.length >= 2 && engine.every((e) => e.method === "sendTransaction"), "the one-piece route's send and rebroadcast");
  assert.equal(settled, false, "no answer before the tag 3's fill");
  ends[2]!.done("filled");
  const a = await p;
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { signatures: ws.map(fpSig) });
  const line = poolSendLine({ chain: "solana", net: "mainnet", route: "pieces", status: a.status, body: a.body, ms: 1, note: a.note });
  assert.match(line, /^pool send solana mainnet pieces outcome=filled status=200 ms=1 tag=3 tip=10000 via=jito region=ny bundle=unnamed end=filled rebroadcasts=2 misses=0 plain=0 hash_ms=/);
  for (const sig of ws.map(fpSig)) assert.ok(!line.includes(sig));
  // a repeat of the same set answers the first and sends nothing
  const n = sets.length;
  assert.deepEqual(await s.carryPieces(bodyOf(ws)), a);
  assert.equal(sets.length, n);
});

test("mainnet: a tag 3 that does not land after its tag 2s did is 503 not_landed, its end read (end simulation, tip), and the one-piece route takes the very same tag 3 again", async () => {
  let end3 = "expired";
  const { s, sets } = rig("mainnet", { end: async (n) => (n < 1 ? "filled" : end3) });
  const ws = two();
  const a = await s.carryPieces(bodyOf(ws));
  assert.deepEqual([a.status, a.body], [503, { error: { code: "not_landed" } }], "never a 4xx once a piece is on chain");
  const line = poolSendLine({ chain: "solana", net: "mainnet", route: "pieces", status: a.status, body: a.body, ms: 1, note: a.note });
  assert.match(line, /^pool send solana mainnet pieces outcome=not_landed status=503 ms=1 tag=3 tip=10000 via=jito region=ny bundle=unnamed end=expired .*end_sim=ok/);
  assert.deepEqual(sets.map((x) => x.paths), [["rpc0", "rpc1"], ["jito", "rpc0", "rpc1"]]);
  // the page's resend of the same bytes on the one-piece route is carried (its nullifier free again)
  end3 = "filled";
  await tick();
  const again = await s.carry({ pool: POOL, tx: b64(ws[1]!) });
  assert.deepEqual([again.status, again.body], [200, { signature: fpSig(ws[1]!) }]);
  // a tag 3 the simulation refuses once the tag 2s landed: 503 not_landed naming it, nothing sent for it
  const sim = rig("mainnet", { simErr: (raw: unknown) => (raw === b64(ws[1]!) ? { InstructionError: [2, { Custom: 6001 }] } : null) });
  const b = await sim.s.carryPieces(bodyOf(ws));
  assert.deepEqual([b.status, b.body], [503, { error: { code: "not_landed", detail: "simulation_failed" } }]);
  assert.match(poolSendLine({ chain: "solana", net: "mainnet", route: "pieces", status: b.status, body: b.body, ms: 1, note: b.note }), /outcome=not_landed status=503 ms=1 tag=3 tip=10000 err=\{"InstructionError":\[2,\{"Custom":6001\}\]\}$/);
  assert.equal(sim.sets.length, 1, "the tag 2 only");
  // a tag 2 that fails on chain while the other landed: 503 too; both failing alone: 422, as before
  const half = rig("mainnet", { end: async (n) => (n === 0 ? "filled" : "failed") });
  const c = await half.s.carryPieces(bodyOf([piece({ tag: 2, nullifier: 12 }), piece({ tag: 2, nullifier: 14 }), piece({ tag: 3, nullifier: 13 })]));
  assert.deepEqual([c.status, code(c)], [503, "not_landed"]);
  const none = rig("mainnet", { end: async () => "failed" });
  const d = await none.s.carryPieces(bodyOf([piece({ tag: 2, nullifier: 22 }), piece({ tag: 3, nullifier: 23 })]));
  assert.deepEqual([d.status, code(d)], [422, "not_landed"]);
});

test("a piece another carry holds is refused in_flight (429), so no nullifier goes out twice", async () => {
  const hold = deferred<string>();
  const { s, sets } = rig("devnet", { end: () => hold.p });
  const one = s.carry({ pool: POOL, tx: b64(piece({ tag: 2, nullifier: 2 })) });
  await tick();
  const a = await s.carryPieces(bodyOf(two()));
  assert.deepEqual([a.status, code(a), a.retryAfterS], [429, "in_flight", 2]);
  assert.equal(sets.length, 1, "only the one-piece send");
  hold.done("filled");
  await one;
});

test("devnet: the same way, no block engine: the tag 2s plain side by side, then the tag 3 simulated and sent plain, answered at its send; the signatures in order", async () => {
  const ends = [deferred<string>(), deferred<string>(), deferred<string>()];
  const { s, sets, calls, engine } = rig("devnet", { end: (n) => ends[n]!.p });
  const ws = [piece({ tag: 2, nullifier: 2 }), piece({ tag: 2, nullifier: 4 }), piece({ tag: 3, nullifier: 3 })];
  const p = s.carryPieces(bodyOf(ws));
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(sets.length, 2, "both tag 2s at once");
  ends[0]!.done("filled");
  ends[1]!.done("filled");
  const a = await p;
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { signatures: ws.map(fpSig) });
  assert.equal(sets.length, 3);
  sets.forEach((x, i) => {
    assert.equal(x.wires.length, 1, "one transaction a send");
    assert.deepEqual(x.paths, ["rpc0", "rpc1"], "plain");
    assert.deepEqual(x.wires[0]!.subarray(65), ws[i]!.subarray(65), `piece ${i} in order`);
  });
  assert.equal(engine.length, 0);
  assert.equal(calls.filter((c) => c.method === "simulateTransaction").length, 3, "the tag 3 simulated once the tag 2s landed");
  ends[2]!.done("filled");
  // a tag 2 that does not fill stops the buy: the tag 3 is never sent
  const stop = rig("devnet", { end: async () => "expired" });
  const b = await stop.s.carryPieces(bodyOf([piece({ tag: 2, nullifier: 5 }), piece({ tag: 3, nullifier: 6 })]));
  assert.deepEqual([b.status, code(b)], [503, "not_landed"]);
  assert.equal(stop.sets.length, 1);
});

test("a page boundary: a tag 2 whose change note goes on the next state page is simulated and sent only once the pieces before it landed, on every cluster", async () => {
  // the first piece's change note is the page's last entry, the second's the next page's first
  const E = SOLANA_POOL_PAGE_ENTRIES;
  const ws = [piece({ tag: 2, nullifier: 2, stateSize: E - 1 }), piece({ tag: 2, nullifier: 4, stateSize: E }), piece({ tag: 3, nullifier: 3, stateSize: E + 1 })];
  const sims = (c: Calls) => c.filter((x) => x.method === "simulateTransaction").map((x) => x.params[0]);
  const ends = [deferred<string>(), deferred<string>(), deferred<string>()];
  const dev = rig("devnet", { end: (n) => ends[n]!.p });
  const p = dev.s.carryPieces(bodyOf(ws));
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(sims(dev.calls), [b64(ws[0]!)], "only the first piece before anything is sent");
  assert.equal(dev.sets.length, 1);
  ends[0]!.done("filled");
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(sims(dev.calls), [b64(ws[0]!), b64(ws[1]!)], "the second, once the first landed");
  assert.equal(dev.sets.length, 2);
  ends[1]!.done("filled");
  assert.equal((await p).status, 200);
  ends[2]!.done("filled");
  // mainnet: the same order, the tag 3 last through the block engine path
  const mends = [deferred<string>(), deferred<string>(), deferred<string>()];
  const main = rig("mainnet", { end: (n) => mends[n]!.p });
  const q = main.s.carryPieces(bodyOf(ws));
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(sims(main.calls), [b64(ws[0]!)]);
  mends[0]!.done("filled");
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(sims(main.calls), [b64(ws[0]!), b64(ws[1]!)]);
  mends[1]!.done("filled");
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(main.sets.map((x) => x.paths[0]), ["rpc0", "rpc0", "jito"]);
  mends[2]!.done("filled");
  assert.equal((await q).status, 200);
  // devnet: the later page's piece refused once the first landed: not_landed (a piece is on chain), the tag 3 never sent
  const later = [piece({ tag: 2, nullifier: 5, stateSize: E - 1 }), piece({ tag: 2, nullifier: 6, stateSize: E }), piece({ tag: 3, nullifier: 7, stateSize: E + 1 })];
  const stop = rig("devnet", { simErr: (raw: unknown) => (raw === b64(later[1]!) ? { InstructionError: [2, { Custom: 16 }] } : null) });
  const r = await stop.s.carryPieces(bodyOf(later));
  assert.deepEqual([r.status, code(r)], [503, "not_landed"]);
  assert.equal(stop.sets.length, 1, "the first piece only: the refused one and the tag 3 never sent");
});

test("POST /v1/pool/solana/pieces: carried through the server, 404 for a pool it does not carry; 413 over 8 KB; 422 wallets_differ", async () => {
  const { createServer } = await import("node:http");
  const { handler } = await import("../server.ts");
  const { s, sets } = rig("devnet");
  const srv = createServer(handler("a".repeat(40), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1, new Map([[s.pool, s]]), new Map(), () => 1_800_000_090_000));
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const post = (b: unknown) => fetch(`${base}/v1/pool/solana/pieces`, { method: "POST", body: JSON.stringify(b) });
    const ws = two();
    const ok = await post(bodyOf(ws));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { signatures: ws.map(fpSig) });
    assert.equal(sets.length, 2);
    assert.equal((await post({ pool: TO, txs: ["AA==", "AA=="] })).status, 404);
    assert.equal((await post({ pool: POOL, txs: ["A".repeat(8_200)] })).status, 413);
    const bad = await post(bodyOf([piece({ tag: 2, nullifier: 7 }), piece({ tag: 3, nullifier: 8, w: W2 })]));
    assert.deepEqual([bad.status, await bad.json()], [422, { error: { code: "wallets_differ" } }]);
    assert.equal((await fetch(`${base}/v1/pool/solana/pieces`)).status, 405);
    // one client's pool window is shared with the one-piece route: past POOL_RATE_MAX on /send, /pieces answers 429
    const { POOL_RATE_MAX } = await import("../server.ts");
    const h = { "x-forwarded-for": "198.51.100.7" };
    for (let i = 0; i < POOL_RATE_MAX; i++) await fetch(`${base}/v1/pool/solana/send`, { method: "POST", headers: h, body: "{}" });
    const over = await fetch(`${base}/v1/pool/solana/pieces`, { method: "POST", headers: h, body: JSON.stringify(bodyOf(two())) });
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get("retry-after")) > 0, "with its wait");
    assert.equal(sets.length, 2, "nothing more carried");
  } finally {
    srv.close();
  }
});

// ---- review FIX of ed9ec97a (card owners-solana-buy-lands) ----

const throttle = () => new Error("HTTP 429 Too Many Requests");
const simsOf = (calls: Calls, w: Uint8Array) => calls.filter((c) => c.method === "simulateTransaction" && c.params[0] === b64(w));

test("RED at ed9ec97a: once the tag 2s landed, the tag 3's simulation is read at their slot or later, and a throttle on it is asked again instead of dropping the buy", async () => {
  for (const cluster of ["mainnet", "devnet"] as const) {
    const ws = two();
    let n = 0;
    const r = rig(cluster, { fail: (m, p) => (m === "simulateTransaction" && p[0] === b64(ws[1]!) && n++ === 0 ? throttle() : null) });
    const a = await r.s.carryPieces(bodyOf(ws));
    assert.equal(a.status, 200, `${cluster}: ${JSON.stringify(a.body)}`);
    assert.equal(r.sets.length, 2, cluster);
    assert.deepEqual(r.pauses, [LANDED_READ_PACE_MS], cluster);
    // set 0 (the tag 2) landed at slot 100: both asks of the tag 3's simulation and its blockhash read ask for it
    const sims = simsOf(r.calls, ws[1]!);
    assert.equal(sims.length, 2, cluster);
    for (const c of sims) assert.equal((c.params[1] as { minContextSlot?: number }).minContextSlot, 100, cluster);
    // the tag 2's own simulation came before anything landed: no slot asked
    assert.equal((simsOf(r.calls, ws[0]!)[0]!.params[1] as { minContextSlot?: number }).minContextSlot, undefined, cluster);
  }
});

test("RED at ed9ec97a: a later page's tag 2 whose simulation meets a node behind the landed slot is asked again at that slot", async () => {
  const E = SOLANA_POOL_PAGE_ENTRIES;
  const ws = [piece({ tag: 2, nullifier: 2, stateSize: E - 1 }), piece({ tag: 2, nullifier: 4, stateSize: E }), piece({ tag: 3, nullifier: 3, stateSize: E + 1 })];
  let n = 0;
  const r = rig("mainnet", { fail: (m, p) => (m === "simulateTransaction" && p[0] === b64(ws[1]!) && n++ === 0 ? new Error("RPC error -32016: Minimum context slot has not been reached") : null) });
  const a = await r.s.carryPieces(bodyOf(ws));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(r.sets.length, 3);
  const sims = simsOf(r.calls, ws[1]!);
  assert.equal(sims.length, 2);
  for (const c of sims) assert.equal((c.params[1] as { minContextSlot?: number }).minContextSlot, 100);
  // the tag 3 after set 1 landed at 101
  for (const c of simsOf(r.calls, ws[2]!)) assert.equal((c.params[1] as { minContextSlot?: number }).minContextSlot, 101);
});

test("a provider that keeps failing after the tag 2s landed: asked again a bounded number of times, then 503 not_landed with its code, the tag 3 never sent", async () => {
  const ws = two();
  const r = rig("mainnet", { fail: (m, p) => (m === "simulateTransaction" && p[0] === b64(ws[1]!) ? throttle() : null) });
  const a = await r.s.carryPieces(bodyOf(ws));
  assert.deepEqual([a.status, a.body], [503, { error: { code: "not_landed", detail: "rate_limited" } }]);
  assert.equal(r.sets.length, 1);
  assert.equal(simsOf(r.calls, ws[1]!).length, POOL_LANDED_READ_MS / LANDED_READ_PACE_MS);
});

test("RED at ed9ec97a: first-page tag 2s, one failed and one with an end the providers did not agree on: 503 not_landed in either order, never a 4xx", async () => {
  for (const ends of [["failed", "unknown"], ["unknown", "failed"]]) {
    const r = rig("mainnet", { end: async (n) => ends[n] ?? "filled" });
    const a = await r.s.carryPieces(bodyOf([piece({ tag: 2, nullifier: 2 }), piece({ tag: 2, nullifier: 4 }), piece({ tag: 3, nullifier: 3 })]));
    assert.equal(a.status, 503, `${ends}: ${JSON.stringify(a.body)}`);
    assert.equal(code(a), "not_landed", String(ends));
    assert.equal(r.sets.length, 2, String(ends));
  }
  // both failed: nothing landed, the 422 the device reads as nothing sent
  const r = rig("mainnet", { end: async (n) => (n < 2 ? "failed" : "filled") });
  const a = await r.s.carryPieces(bodyOf([piece({ tag: 2, nullifier: 2 }), piece({ tag: 2, nullifier: 4 }), piece({ tag: 3, nullifier: 3 })]));
  assert.deepEqual([a.status, code(a)], [422, "not_landed"]);
});

test("RED at ed9ec97a: a tag 2 whose end the providers did not agree on is held as the one-piece route holds one: its nullifier answers 503 not_landed until the release's deadline, unsent", async () => {
  const ws = two();
  const r = rig("mainnet", { end: async (n) => (n === 0 ? "unknown" : "filled") });
  const a = await r.s.carryPieces(bodyOf(ws));
  assert.deepEqual([a.status, code(a)], [503, "not_landed"]);
  assert.equal(r.sets.length, 1);
  const alone = await r.s.carry({ pool: POOL, tx: b64(ws[0]!) });
  assert.deepEqual([alone.status, "error" in alone.body ? alone.body.error.code : "ok"], [503, "not_landed"]);
  const again = await r.s.carryPieces(bodyOf(ws));
  assert.deepEqual([again.status, code(again)], [503, "not_landed"]);
  assert.equal(r.sets.length, 1);
});
