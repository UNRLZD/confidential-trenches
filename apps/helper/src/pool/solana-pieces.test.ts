// node --test apps/helper/src/pool/solana-pieces.test.ts: POST /v1/pool/solana/pieces (card buy-spends-several-pieces)
// carries one buy made of several pieces, every tag 2 then the tag 3, as one Jito bundle with the helper's own tip last,
// all landing or none; or refuses it before anything is sent. Every key here is a test key: ed25519 of
// sha256("helper-pool-senders/test-key/<name>"), as solana.test.ts makes them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_JITO_TIP_ACCOUNTS,
  SOLANA_JITO_TIP_MIN,
  SOLANA_POOL_BUY_PIECES_MAX,
  SOLANA_POOL_JITO_TIP,
  SOLANA_SYSTEM_PROGRAM,
  solanaCompileV0,
  solanaDecodeTransaction,
  solanaPoolPriorityBudget,
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
import { JITO_BUNDLE_MAX, jitoSender } from "./jito.ts";
import { poolSendLine } from "./send-log.ts";
import { solanaPoolSender, type PoolPiecesAnswer, type SolanaPoolSenderDeps } from "./solana.ts";
import { JITO_TIP_FLOOR_CACHE_MS, jitoTipFloor, piecesTipCap, SOLANA_TIP_TX_FEE, tipFloorOf } from "./solana-pieces.ts";

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
function piece(o: { tag: 2 | 3; nullifier: number; w?: typeof W; tipTo?: string }): Uint8Array {
  const w = o.w ?? W;
  const r = release(o.nullifier);
  const accounts = solanaPoolReleaseAccounts({ program: PROGRAM, pool: POOL }, w.address, FP.address, r, 6);
  let data: Uint8Array;
  if (o.tag === 2) data = solanaEncodePoolRelease(r);
  else {
    accounts.push({ key: o.tipTo ?? SOLANA_JITO_TIP_ACCOUNTS[0]!, signer: false, writable: true }, { key: TO, signer: false, writable: true });
    data = solanaEncodePoolTag3(r, false, 10_000n, [{ program: 7, accounts: [1, 9], data: Uint8Array.from([2, 0, 0, 0, ...u64(1_000_000n)]) }]);
  }
  const { message } = solanaCompileV0(FP.address, [cuLimit(400_000), cuPrice(1_000n), { program: PROGRAM, accounts, data }], BLOCKHASH, [], [FP.address, w.address]);
  return Uint8Array.from([2, ...new Uint8Array(64), ...ed25519.sign(message, w.seed), ...message]);
}
const b64 = (w: Uint8Array) => Buffer.from(w).toString("base64");

type Calls = { method: string; params: readonly unknown[] }[];
function rpcStub(calls: Calls = [], simErr: unknown = null): SolanaRpc {
  return Object.assign(
    async (method: string, params: readonly unknown[]) => {
      calls.push({ method, params });
      if (method === "simulateTransaction") return { context: { slot: 1 }, value: { err: simErr, logs: [] } };
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

// ---- the stand-ins: providers, the kit's sender, the block engines, the tip floor ----

const BUDGET = solanaPoolPriorityBudget(TEST_RENT, FEE);
/** W's priority fee in every piece here: 400,000 CU at 1,000 micro-lamports. */
const PRIORITY = 400n;
const code = (a: PoolPiecesAnswer) => ("error" in a.body ? a.body.error.code : "ok");
const tick = () => new Promise((r) => setImmediate(r));
const deferred = <T>() => {
  let done!: (v: T) => void;
  const p = new Promise<T>((r) => (done = r));
  return { p, done };
};
type Set = { wires: Uint8Array[]; paths: string[] };
type EngineCall = { url: string; method: string; params: unknown[] };
/** A sender on `cluster` whose kit sender records each set and, on mainnet, drives its block engine path twice (the
 *  first send, then one rebroadcast) before the set's end `end` gives. */
function rig(cluster: "devnet" | "mainnet", o: { floor?: bigint | null; end?: (n: number) => Promise<string>; result?: unknown; simErr?: unknown } = {}) {
  const calls: Calls = [];
  const sets: Set[] = [];
  const engine: EngineCall[] = [];
  const floorAsks: number[] = [];
  const jito =
    cluster === "mainnet"
      ? jitoSender({
          regions: ["https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true", "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true"],
          intervalMs: 0,
          timeoutMs: 1_000,
          fetch: async (url, init) => {
            const j = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
            engine.push({ url, method: j.method, params: j.params });
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: o.result ?? "ab".repeat(32) }), { status: 200 });
          },
        })
      : null;
  const deps: SolanaPoolSenderDeps = {
    providers: [rpcStub(calls, o.simErr), rpcStub(calls)],
    now: () => NOW,
    readRent: async () => TEST_RENT,
    log: () => {},
    jito,
    tipFloor: async () => (floorAsks.push(1), o.floor === undefined ? 250_000n : o.floor),
    send: (set, opts) => {
      const n = sets.length;
      sets.push({ wires: set.map((t) => t.wire), paths: opts.paths.map((p) => p.name) });
      const sig = base58(set[0]!.wire.subarray(1, 65));
      const done = (async () => {
        const sends: { path: string; attempt: number; ok: boolean; ms: number }[] = [];
        if (cluster === "mainnet") for (let i = 0; i < 2; i++) sends.push({ path: "jito", attempt: i, ok: (await opts.paths[0]!.send(b64(set[0]!.wire))) === sig, ms: 0 });
        const state = await (o.end ?? (async () => "filled"))(n);
        return { txs: [{ signature: sig, state: state as "filled", sends }] };
      })();
      return { signatures: [sig], done, stop() {} };
    },
  };
  const s = solanaPoolSender({ cluster, program: PROGRAM, feePayerSecret: FP.secret, fee: String(FEE) }, deps);
  return { s, calls, sets, engine, floorAsks };
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

test("mainnet: pieces that with the tip would pass Jito's 5 a bundle are bad_shape (400), nothing read or sent", async () => {
  const { s, calls, sets, engine } = rig("mainnet");
  const ws = [...Array.from({ length: JITO_BUNDLE_MAX - 1 }, (_, i) => piece({ tag: 2, nullifier: 10 + i })), piece({ tag: 3, nullifier: 3 })];
  const a = await s.carryPieces(bodyOf(ws));
  assert.deepEqual([a.status, code(a)], [400, "bad_shape"]);
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

test("the tip: the helper's own transaction last, one transfer to a static Jito tip account, for the floor's amount, on the tag 3's blockhash", async () => {
  const { s, engine } = rig("mainnet", { floor: 250_000n });
  const ws = two();
  const a = await s.carryPieces(bodyOf(ws));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const bundle = engine[0]!.params[0] as string[];
  assert.equal(bundle.length, 3, "two pieces and the tip");
  const tip = new Uint8Array(Buffer.from(bundle[2]!, "base64"));
  const t = solanaDecodeTransaction(tip);
  assert.equal(t.signatures, 1, "the fee payer its only signer");
  assert.ok(ed25519.verify(tip.subarray(1, 65), t.messageBytes, ed25519.getPublicKey(FP.seed)), "signed by the fee payer");
  assert.equal(t.message.staticKeys[0], FP.address);
  assert.deepEqual(t.message.lookups, [], "no lookup table");
  assert.equal(t.message.blockhash, solanaDecodeTransaction(ws[1]!).message.blockhash, "the tag 3's blockhash");
  assert.equal(t.message.instructions.length, 1, "one instruction");
  const ix = t.message.instructions[0]!;
  assert.equal(t.message.staticKeys[ix.programIndex], SOLANA_SYSTEM_PROGRAM);
  assert.deepEqual(ix.accounts, [0, 1]);
  assert.ok(SOLANA_JITO_TIP_ACCOUNTS.includes(t.message.staticKeys[1]!), "to a Jito tip account, a static key");
  assert.deepEqual([...ix.data], [2, 0, 0, 0, ...u64(250_000n)], "a SystemProgram transfer of the floor's lamports");
  // an unread floor gives the kit's 100,000; a floor under Jito's least, the least
  for (const [floor, want] of [[null, SOLANA_POOL_JITO_TIP], [10n, SOLANA_JITO_TIP_MIN]] as const) {
    const r = rig("mainnet", { floor });
    assert.equal((await r.s.carryPieces(bodyOf(two()))).status, 200);
    const d = solanaDecodeTransaction(new Uint8Array(Buffer.from((r.engine[0]!.params[0] as string[])[2]!, "base64")));
    assert.deepEqual([...d.message.instructions[0]!.data], [2, 0, 0, 0, ...u64(want)], `floor ${floor}`);
  }
});

test("the tip's cap: the relay fees less each piece's cost and W's priority fee, less the tip's own fee; a floor over it is refused fee_below_cost, nothing sent", async () => {
  const cap = 2n * (BUDGET - PRIORITY) - SOLANA_TIP_TX_FEE;
  assert.equal(piecesTipCap([{ budget: BUDGET, priority: PRIORITY }, { budget: BUDGET, priority: PRIORITY }]), cap);
  const at = rig("mainnet", { floor: cap });
  assert.equal((await at.s.carryPieces(bodyOf(two()))).status, 200, "a floor at the cap is carried");
  const over = rig("mainnet", { floor: cap + 1n });
  const a = await over.s.carryPieces(bodyOf(two()));
  assert.deepEqual([a.status, a.body], [422, { error: { code: "fee_below_cost", detail: "tip floor over the relay fees" } }]);
  assert.deepEqual([over.calls.length, over.sets.length, over.engine.length], [0, 0, 0], "nothing read or sent");
  // the worked number at mainnet rent (the kit's fee 1,300,000, budget 207,245): four pieces with no priority fee
  const mainnetBudget = solanaPoolPriorityBudget({ lamportsPerByte: 5_080n, factor: 1n }, 1_300_000n);
  assert.equal(mainnetBudget, 207_245n);
  assert.equal(piecesTipCap(Array.from({ length: 4 }, () => ({ budget: mainnetBudget, priority: 0n }))), 823_980n);
});

test("the tip floor read is hostile: a non-finite, negative, absurd or misshapen value is unread; SOL to lamports rounded up", async () => {
  assert.equal(tipFloorOf(JSON.stringify([{ landed_tips_95th_percentile: 0.00005999 }])), 59_990n);
  assert.equal(tipFloorOf(JSON.stringify([{ landed_tips_95th_percentile: 0.0000000001 }])), 1n, "a part of a lamport rounds up");
  for (const bad of ["[]", "{}", "null", "not json", JSON.stringify([{ landed_tips_95th_percentile: -1e-5 }]), JSON.stringify([{ landed_tips_95th_percentile: "0.00001" }]), JSON.stringify([{ landed_tips_95th_percentile: 2 }]), '[{"landed_tips_95th_percentile":1e400}]', JSON.stringify([{ landed_tips_50th_percentile: 0.00001 }])]) assert.equal(tipFloorOf(bad), null, bad);
  // cached JITO_TIP_FLOOR_CACHE_MS, unread included; a slow, failing or oversized answer is unread
  let now = 0;
  let asks = 0;
  const answer = { text: JSON.stringify([{ landed_tips_95th_percentile: 0.0002 }]), status: 200 };
  const read = jitoTipFloor({ now: () => now, fetch: async () => (asks++, new Response(answer.text, { status: answer.status })) });
  assert.equal(await read(), 200_000n);
  now = JITO_TIP_FLOOR_CACHE_MS - 1;
  assert.equal(await read(), 200_000n);
  assert.equal(asks, 1, "one read serves the cache window");
  now = JITO_TIP_FLOOR_CACHE_MS;
  answer.status = 503;
  assert.equal(await read(), null);
  now = 2 * JITO_TIP_FLOOR_CACHE_MS;
  answer.status = 200;
  answer.text = JSON.stringify([{ landed_tips_95th_percentile: 0.0002, pad: "x".repeat(5_000) }]);
  assert.equal(await read(), null, "over the bounded body");
  const t0 = Date.now();
  const slow = jitoTipFloor({ timeoutMs: 30, fetch: () => new Promise<Response>(() => {}) });
  assert.equal(await slow(), null);
  assert.ok(Date.now() - t0 < 1_000, "a read that never answers is unread within its timeout");
});

test("mainnet: only sendBundle, every piece in order then the tip, no plain send on any path; the answer only after the fill, the signatures in order", async () => {
  const fill = deferred<string>();
  const { s, calls, sets, engine } = rig("mainnet", { end: () => fill.p });
  const ws = [piece({ tag: 2, nullifier: 2 }), piece({ tag: 2, nullifier: 4 }), piece({ tag: 3, nullifier: 3 })];
  const p = s.carryPieces(bodyOf(ws));
  let settled = false;
  void p.then(() => (settled = true));
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(settled, false, "no answer before the fill is decided");
  assert.deepEqual(sets.map((x) => x.paths), [["jito"]], "the kit's sender gets the block engine path only: no plain copy");
  assert.ok(engine.length >= 2, "the first send and a rebroadcast");
  for (const e of engine) {
    assert.equal(e.method, "sendBundle");
    assert.equal(e.url, `${new URL(e.url).origin}/api/v1/bundles`);
    assert.deepEqual(e.params[1], { encoding: "base64" });
    const bundle = e.params[0] as string[];
    assert.equal(bundle.length, 4);
    // the pieces as W signed them, the fee payer's signature added in slot 0, in request order
    bundle.slice(0, 3).forEach((x, i) => {
      const w = new Uint8Array(Buffer.from(x, "base64"));
      assert.deepEqual(w.subarray(65), ws[i]!.subarray(65), `piece ${i}: every byte after slot 0 is W's`);
      assert.equal(base58(w.subarray(1, 65)), fpSig(ws[i]!));
    });
  }
  assert.equal(engine[0]!.url, engine[1]!.url, "rebroadcast to the region that took it");
  // the tag 2s simulated alone, the tag 3 never; no provider ever got a send
  const sims = calls.filter((c) => c.method === "simulateTransaction");
  assert.deepEqual(sims.map((c) => c.params[0]), [b64(ws[0]!), b64(ws[1]!)]);
  assert.equal(calls.filter((c) => c.method === "sendTransaction").length, 0);
  fill.done("filled");
  const a = await p;
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { signatures: ws.map(fpSig) });
  assert.equal(new Set((a.body as { signatures: string[] }).signatures).size, 3);
  // the route's log line holds no signature
  const line = poolSendLine({ chain: "solana", net: "mainnet", route: "pieces", status: a.status, body: a.body, ms: 1, note: a.note });
  assert.match(line, /^pool send solana mainnet pieces outcome=filled status=200 ms=1 via=jito region=ny bundle=named end=filled/);
  for (const sig of ws.map(fpSig)) assert.ok(!line.includes(sig));
  // a repeat of the same bundle answers the first and sends nothing
  const n = engine.length;
  assert.deepEqual(await s.carryPieces(bodyOf(ws)), a);
  assert.equal(engine.length, n);
});

test("mainnet: a bundle that expires unlanded is not_landed (503), nothing plain; its nullifiers are free again", async () => {
  let end = "expired";
  const { s, sets, engine } = rig("mainnet", { end: async () => end });
  const a = await s.carryPieces(bodyOf(two()));
  assert.deepEqual([a.status, a.body], [503, { error: { code: "not_landed" } }]);
  assert.equal(a.note?.end, "expired");
  assert.deepEqual(sets.map((x) => x.paths), [["jito"]]);
  assert.ok(engine.every((e) => e.method === "sendBundle"));
  end = "filled";
  await tick();
  assert.equal((await s.carryPieces(bodyOf(two()))).status, 200, "sent again");
  assert.equal(sets.length, 2);
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

test("devnet: plain, in order, each tag 2 filled before the next, then the tag 3; no tip; the signatures in order", async () => {
  const ends = [deferred<string>(), deferred<string>(), deferred<string>()];
  const { s, sets, calls, floorAsks } = rig("devnet", { end: (n) => ends[n]!.p });
  const ws = [piece({ tag: 2, nullifier: 2 }), piece({ tag: 2, nullifier: 4 }), piece({ tag: 3, nullifier: 3 })];
  const p = s.carryPieces(bodyOf(ws));
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(sets.length, 1, "the second piece waits for the first's fill");
  ends[0]!.done("filled");
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(sets.length, 2);
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
  assert.ok(sets.every((x) => x.wires[0]![0] === 2), "no one-signer tip transaction");
  assert.equal(floorAsks.length, 0, "no tip floor read");
  assert.equal(calls.filter((c) => c.method === "simulateTransaction").length, 2, "the tag 3 is not simulated");
  ends[2]!.done("filled");
  // a tag 2 that does not fill stops the buy: the tag 3 is never sent
  const stop = rig("devnet", { end: async () => "expired" });
  const b = await stop.s.carryPieces(bodyOf([piece({ tag: 2, nullifier: 5 }), piece({ tag: 3, nullifier: 6 })]));
  assert.deepEqual([b.status, code(b)], [503, "not_landed"]);
  assert.equal(stop.sets.length, 1);
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
  } finally {
    srv.close();
  }
});
