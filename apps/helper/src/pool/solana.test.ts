// node --test apps/helper/src/pool/solana.test.ts: the Solana pool sender carries what W signed exactly as signed, or
// refuses it. Every key here is a test key: ed25519 of sha256("helper-pool-senders/test-key/<name>").
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_SYSTEM_PROGRAM,
  solanaCompileV0,
  solanaEncodePoolRelease,
  solanaEncodePoolTag3,
  solanaPoolAccount,
  solanaPoolReleaseAccounts,
  type SolanaApiInstruction,
  type SolanaPoolRelease,
  type SolanaRpc,
} from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import { solanaPoolFee, solanaPoolPageReserve, solanaPoolPriorityBudget, solanaPoolReleaseCost, solanaRentMin, type SolanaRent } from "@blindfill/kit";
import { POOL_EPOCH_MS } from "./fee.ts";
import { checkSolanaPoolTx, feePayerKey, solanaPoolSender, solanaPoolSendersFromEnv, type PoolSendAnswer } from "./solana.ts";

const testKey = (name: string) => {
  const seed = new Uint8Array(createHash("sha256").update(`helper-pool-senders/test-key/${name}`).digest());
  const pub = ed25519.getPublicKey(seed);
  return { seed, address: base58(pub), secret: base58(Uint8Array.from([...seed, ...pub])) };
};
const FP = testKey("FEE_PAYER");
const W = testKey("W");
const OTHER = testKey("OTHER");
const PROGRAM = testKey("PROGRAM").address;
const OTHER_PROGRAM = testKey("OTHER_PROGRAM").address;
const POOL = solanaPoolAccount(PROGRAM);
const TIP_TO = testKey("TIP_TO").address;
const TO = testKey("TO").address;
const BLOCKHASH = testKey("BLOCKHASH").address;
const FEE = 2_000_000n;
/** A test rent whose kit fee is FEE: cost (128 + 13 + 72) x 8,400 + 10,000 = 1,799,200, up to 1,800,000, plus two steps
 * (the spent mark is 13 bytes, M376). */
const TEST_RENT: SolanaRent = { lamportsPerByte: 8_400n, factor: 1n };
/** Mainnet's, read 2026-11-02 on two providers (the kit's pool-buy.ts): 5,080 a byte, factor 1.0. */
const MAINNET: SolanaRent = { lamportsPerByte: 5_080n, factor: 1n };
const BUDGET = solanaPoolPriorityBudget(TEST_RENT, FEE);
const NOW = 1_800_000_000_000; // 270 s before the releases' deadline
const CFG = { program: PROGRAM, pool: POOL, feePayer: FP.address, fee: FEE, budget: BUDGET, nowMs: NOW };

const field = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
const release = (relayFee = FEE, nullifier = 2, deadlineMs = 1_800_000_270_000n): SolanaPoolRelease => ({
  proof: new Uint8Array(256).fill(7),
  newCommitmentHash: field(1),
  existingNullifierHash: field(nullifier),
  withdrawnValue: 50_000_000n,
  stateRootIndex: 5,
  stateTreeDepth: 3,
  labelRootIndex: 5,
  labelTreeDepth: 3,
  relayFee,
  relayFeeCap: 3_000_000n,
  tipCap: 10_000n,
  deadlineMs,
  salt: new Uint8Array(16).fill(9),
});
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const cuLimit = (n: number): SolanaApiInstruction => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([2, ...u32(n)]) });
const cuPrice = (n: bigint): SolanaApiInstruction => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([3, ...u64(n)]) });
const transfer = (from: string, to: string, lamports: bigint): SolanaApiInstruction => ({
  program: SOLANA_SYSTEM_PROGRAM,
  accounts: [{ key: from, signer: true, writable: true }, { key: to, signer: false, writable: true }],
  data: Uint8Array.from([2, 0, 0, 0, ...u64(lamports)]),
});

type Build = {
  tag?: 2 | 3;
  fee?: bigint;
  program?: string;
  pool?: string;
  pre?: SolanaApiInstruction[];
  post?: SolanaApiInstruction[];
  /** tag 3: the inner instructions' indexes into the pool instruction's accounts, after tag 2's 8 and the tip (8) */
  inner?: { program: number; accounts: number[]; data: Uint8Array }[];
  /** tag 3: accounts after the tip, which `inner` indexes from 9 */
  extra?: { key: string; signer: boolean; writable: boolean }[];
  tipTo?: string;
  /** the release's nullifier hash (its last byte), the state tree's size (1,024 opens page 1) and the blockhash */
  nullifier?: number;
  stateSize?: number;
  blockhash?: string;
  deadlineMs?: bigint;
};
/** A v0 transaction W signed, the fee payer's slot empty: what the device sends. */
function build(o: Build = {}): Uint8Array {
  const r = release(o.fee ?? FEE, o.nullifier ?? 2, o.deadlineMs);
  const cfg = { program: o.program ?? PROGRAM, pool: o.pool ?? POOL };
  const accounts = solanaPoolReleaseAccounts(cfg, W.address, FP.address, r, o.stateSize ?? 6);
  let data: Uint8Array;
  if ((o.tag ?? 2) === 2) data = solanaEncodePoolRelease(r);
  else {
    accounts.push({ key: o.tipTo ?? TIP_TO, signer: false, writable: true }, ...(o.extra ?? [{ key: TO, signer: false, writable: true }]));
    const transferData = Uint8Array.from([2, 0, 0, 0, ...u64(1_000_000n)]);
    data = solanaEncodePoolTag3(r, false, 10_000n, o.inner ?? [{ program: 7, accounts: [1, 9], data: transferData }]);
  }
  const ixs = [...(o.pre ?? [cuLimit(400_000), cuPrice(1_000n)]), { program: cfg.program, accounts, data }, ...(o.post ?? [])];
  const { message } = solanaCompileV0(FP.address, ixs, o.blockhash ?? BLOCKHASH, [], [FP.address, W.address]);
  return Uint8Array.from([2, ...new Uint8Array(64), ...ed25519.sign(message, W.seed), ...message]);
}
const refusal = (wire: Uint8Array) => {
  const c = checkSolanaPoolTx(wire, CFG);
  return c.ok ? "ok" : c.code;
};

test("a tag 2 and a tag 3 release W signed pass every check", () => {
  assert.equal(refusal(build()), "ok");
  assert.equal(refusal(build({ tag: 3 })), "ok");
});

test("a byte changed after W signed is refused (bad_signature)", () => {
  const good = build();
  for (const at of [129 + 4, good.length - 200, good.length - 1]) {
    const bad = good.slice();
    bad[at]! ^= 1;
    const r = refusal(bad);
    assert.ok(r === "bad_signature" || r === "bad_shape", `byte ${at}: ${r}`);
  }
  // the relay fee's bytes, so the decode still passes and only the signature catches it
  const bad = good.slice();
  // the message ends: relay_fee, relay_fee_cap, tip_cap, deadline_ms (8 each), salt (16), then the lookup count (1)
  bad[bad.length - 1 - 16 - 8 * 4]! ^= 1;
  assert.equal(refusal(bad), "bad_signature");
  const otherW = build();
  otherW.set(ed25519.sign(otherW.subarray(129), OTHER.seed), 65);
  assert.equal(refusal(otherW), "bad_signature");
});

test("another program or another pool is refused (not_pool)", () => {
  assert.equal(refusal(build({ program: OTHER_PROGRAM })), "not_pool");
  assert.equal(refusal(build({ pool: solanaPoolAccount(OTHER_PROGRAM) })), "not_pool");
});

test("an instruction besides one compute limit, one price and the pool's is refused (extra_instruction)", () => {
  assert.equal(refusal(build({ post: [transfer(W.address, TO, 1n)] })), "extra_instruction");
  assert.equal(refusal(build({ pre: [cuLimit(400_000), transfer(W.address, TO, 1n)] })), "extra_instruction");
  assert.equal(refusal(build({ pre: [cuLimit(400_000), cuLimit(400_000)] })), "extra_instruction");
  assert.equal(refusal(build({ pre: [{ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([1, 0, 0, 1, 0]) }] })), "extra_instruction");
  assert.equal(refusal(build({ pre: [] })), "ok");
});

test("the fee payer named anywhere but the payer and the pool's account 2 is refused (fee_payer_named)", () => {
  const data = Uint8Array.from([2, 0, 0, 0, ...u64(1n)]);
  // an inner instruction handing the fee payer (the pool instruction's account 2) to a venue
  assert.equal(refusal(build({ tag: 3, inner: [{ program: 7, accounts: [2, 9], data }] })), "fee_payer_named");
  assert.equal(refusal(build({ tag: 3, inner: [{ program: 2, accounts: [1, 9], data }] })), "fee_payer_named");
  // the fee payer as the tip account
  assert.equal(refusal(build({ tag: 3, tipTo: FP.address })), "fee_payer_named");
  // the fee payer as a venue account after the tip
  assert.equal(refusal(build({ tag: 3, extra: [{ key: FP.address, signer: false, writable: true }] })), "fee_payer_named");
});

test("a relay fee off the published one is refused (fee_off); one under the cost with W's priority fee too (fee_below_cost)", () => {
  assert.equal(refusal(build({ fee: FEE + 100_000n })), "fee_off");
  assert.equal(refusal(build({ fee: FEE - 100_000n })), "fee_off");
  // the kit's budget: the fee less the cost and the page reserve; 400,000 CU at the highest price whose fee fits is
  // carried, one micro-lamport more per CU rounds up past it
  const top = (BUDGET * 1_000_000n) / 400_000n;
  assert.equal(refusal(build({ pre: [cuLimit(400_000), cuPrice(top)] })), "ok");
  assert.equal(refusal(build({ pre: [cuLimit(400_000), cuPrice(top + 1n)] })), "fee_below_cost");
});

test("not a v0 transaction of the fee payer and W, or a fee payer slot already filled, is bad_shape", () => {
  const good = build();
  const filled = good.slice();
  filled[1] = 1;
  assert.equal(refusal(filled), "bad_shape");
  assert.equal(refusal(good.subarray(0, 300)), "bad_shape");
  assert.equal(refusal(new Uint8Array(1300)), "bad_shape");
  assert.equal(checkSolanaPoolTx(good, { ...CFG, feePayer: OTHER.address }).ok, false);
});

// ---- the carry: simulation, signature, send ----

type Calls = { method: string; params: readonly unknown[] }[];
function rpcStub(simErr: unknown = null, calls: Calls = []): SolanaRpc {
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
function sender(simErr: unknown = null, calls: Calls = [], sent: Uint8Array[] = [], o: { fee?: bigint; ends?: () => Promise<string>; memory?: number; now?: () => number; rent?: SolanaRent; readRent?: (epoch: number) => Promise<SolanaRent>; log?: (line: string) => void } = {}) {
  return solanaPoolSender(
    { cluster: "devnet", program: PROGRAM, feePayerSecret: FP.secret, fee: String(o.fee ?? FEE) },
    {
      providers: [rpcStub(simErr, calls), rpcStub()],
      ...(o.memory ? { memory: o.memory } : {}),
      now: o.now ?? (() => NOW),
      readRent: o.readRent ?? (async () => o.rent ?? TEST_RENT),
      log: o.log ?? (() => {}),
      send: (set) => {
        sent.push(set[0]!.wire);
        const sig = base58(set[0]!.wire.subarray(1, 65));
        const done = (o.ends ?? (async () => "filled"))().then((state) => ({ txs: [{ signature: sig, state: state as "filled", sends: [] }] }));
        return { signatures: [sig], done, stop() {} };
      },
    },
  );
}
const body = (wire: Uint8Array) => ({ pool: POOL, tx: Buffer.from(wire).toString("base64") });
const code = (a: PoolSendAnswer) => ("error" in a.body ? a.body.error.code : "ok");

test("the carry simulates W's bytes, adds the fee payer's signature and nothing else, and sends", async () => {
  const calls: Calls = [];
  const sent: Uint8Array[] = [];
  const wire = build({ tag: 3 });
  const a = await sender(null, calls, sent).carry(body(wire));
  assert.equal(a.status, 200);
  assert.equal(sent.length, 1);
  const out = sent[0]!;
  assert.equal(out.length, wire.length);
  assert.deepEqual(out.subarray(65), wire.subarray(65), "every byte after slot 0 is W's");
  assert.ok(ed25519.verify(out.subarray(1, 65), wire.subarray(129), ed25519.getPublicKey(FP.seed)), "slot 0 is the fee payer's signature");
  assert.deepEqual(a.body, { signature: base58(out.subarray(1, 65)) });
  const sim = calls.find((c) => c.method === "simulateTransaction")!;
  assert.equal(sim.params[0], body(wire).tx, "the simulation ran on W's bytes as received");
  assert.deepEqual(sim.params[1], { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "processed" });
});

test("a failed simulation is refused before any signature or send (simulation_failed)", async () => {
  const sent: Uint8Array[] = [];
  const a = await sender({ InstructionError: [2, { Custom: 16 }] }, [], sent).carry(body(build()));
  assert.equal(code(a), "simulation_failed");
  assert.equal(a.status, 422);
  assert.equal(sent.length, 0);
});

test("every refusal of the checks reaches the route before any read", async () => {
  const calls: Calls = [];
  const sent: Uint8Array[] = [];
  const s = sender(null, calls, sent);
  const bad = build();
  bad[bad.length - 1 - 16 - 8 * 4]! ^= 1; // relay_fee's low byte
  assert.equal(code(await s.carry(body(bad))), "bad_signature");
  assert.equal(code(await s.carry(body(build({ fee: FEE + 100_000n })))), "fee_off");
  assert.equal(code(await s.carry({ pool: POOL, tx: "not base64!" })), "bad_shape");
  assert.equal(code(await s.carry({ pool: solanaPoolAccount(OTHER_PROGRAM), tx: body(build()).tx })), "bad_shape");
  assert.equal(code(await s.carry({ pool: POOL, tx: body(build()).tx, extra: 1 })), "bad_shape");
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 0);
});

test("the published fee: the kit's for the rent read, the same for every caller in every epoch; any other refuses to start", async () => {
  const s = sender();
  const a = await s.fee(1_800_000_012_345);
  assert.deepEqual(a, { chain: "solana", cluster: "devnet", program: PROGRAM, pool: POOL, fee_payer: FP.address, epoch_ms: POOL_EPOCH_MS, epoch_start_ms: 1_800_000_000_000, fee: "2000000", step: "100000" });
  assert.equal((await s.fee(1_800_000_060_000)).fee, a.fee);
  // M355, M376 at mainnet rent: cost 1,092,040 (the spent mark 13 bytes), fee 1,300,000, page reserve 715, priority
  // budget 207,245
  assert.equal(solanaPoolReleaseCost(MAINNET), 1_092_040n);
  assert.equal(solanaPoolFee(MAINNET), 1_300_000n);
  assert.equal(solanaPoolPageReserve(MAINNET), 715n);
  assert.equal(solanaPoolPriorityBudget(MAINNET, 1_300_000n), 207_245n);
  await sender(null, [], [], { fee: 1_300_000n, rent: MAINNET }).ready;
  for (const off of [1_200_000n, 1_400_000n, 1_299_999n, 2_000_000n]) await assert.rejects(sender(null, [], [], { fee: off, rent: MAINNET }).ready, /the kit's fee for this rent, 1300000/, String(off));
  await assert.rejects(sender(null, [], [], { fee: 1_300_000n }).ready, /the kit's fee for this rent, 2000000/, "a fee off the kit's for the rent read stops the helper");
});

test("M362 (3): a failed rent read never rejects ready: the pool answers 503 upstream, and the first good read checks the configured fee", async () => {
  let fail = true;
  const reads: number[] = [];
  const s = sender(null, [], [], { fee: 2_000_000n, readRent: async (e) => { reads.push(e); if (fail) throw new Error("down"); return TEST_RENT; } });
  let settled = "pending";
  s.ready.then(() => (settled = "ok"), () => (settled = "rejected"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([settled, reads.length], ["pending", 1], "the start read failed and ready waits");
  await assert.rejects(s.fee(NOW));
  assert.equal(code(await s.carry(body(build()))), "upstream");
  fail = false;
  assert.equal(code(await s.carry(body(build()))), "ok", "the next good read checks the fee and the pool carries");
  assert.equal(settled, "ok");
  // a mismatch found at a later good read: ready rejects (the helper exits) and the pool refuses meanwhile
  fail = true;
  const t = sender(null, [], [], { fee: 1_300_000n, readRent: async () => { if (fail) throw new Error("down"); return TEST_RENT; } });
  const r = t.ready;
  await new Promise((x) => setImmediate(x));
  fail = false;
  assert.equal(code(await t.carry(body(build()))), "upstream");
  await assert.rejects(r, /the kit's fee for this rent, 2000000/);
});

test("a failed start rent read is one stderr line naming the cluster and the error: the first, then one a minute while they fail; none once checked", async () => {
  const tick = () => new Promise((r) => setImmediate(r));
  let now = NOW;
  let why = "HTTP 503";
  let fail = true;
  const lines: string[] = [];
  const s = sender(null, [], [], { now: () => now, log: (l) => lines.push(l), readRent: async () => { if (fail) throw new Error(why); return TEST_RENT; } });
  const ask = async (atMs: number) => ((now = atMs), void s.ready, await tick());
  await ask(NOW);
  assert.deepEqual(lines, ["helper: the devnet pool's rent read failed, its start check waits for a good one: HTTP 503"], "the first failure, at once");
  for (const at of [NOW + 2_000, NOW + 30_000, NOW + 59_999]) await ask(at);
  assert.equal(lines.length, 1, "none again within the minute");
  // a URL in the error is cut to its host: a key in its path or query is never printed
  why = "Failed to parse URL from https://rpc.example.com/k3y-in-path/?api-key=s3cret-in-query";
  await ask(NOW + 60_000);
  assert.equal(lines.length, 2, "one a minute while they fail");
  assert.equal(lines[1], "helper: the devnet pool's rent read failed, its start check waits for a good one: Failed to parse URL from rpc.example.com");
  await ask(NOW + 119_999);
  assert.equal(lines.length, 2);
  fail = false;
  await ask(NOW + 300_000);
  await s.ready;
  fail = true;
  for (const at of [NOW + 400_000, NOW + 500_000]) await ask(at);
  assert.equal(lines.length, 2, "none once the check has passed");
  // a refused fee is not a failed read: the helper exits naming it (server.ts), with no rent read line
  const refusedLines: string[] = [];
  const m = sender(null, [], [], { fee: 1_300_000n, log: (l) => refusedLines.push(l) });
  await assert.rejects(m.ready, /the kit's fee for this rent/);
  void m.ready;
  await tick();
  assert.deepEqual(refusedLines, []);
});

test("ready reads the rent only until the start check settles: an ask after it, in a later epoch, reads nothing", async () => {
  for (const fee of [FEE, 1_300_000n]) {
    let now = NOW;
    let reads = 0;
    const s = sender(null, [], [], { fee, now: () => now, readRent: async () => (reads++, TEST_RENT) });
    await s.ready.catch(() => undefined);
    assert.equal(reads, 1);
    for (let i = 1; i <= 3; i++) {
      now = NOW + i * POOL_EPOCH_MS;
      await s.ready.catch(() => undefined);
    }
    assert.equal(reads, 1, `fee ${fee}: no read after the check ${fee === FEE ? "passed" : "refused"}`);
  }
});

test("the fee payer's key: 64 bytes whose public half is its seed's", () => {
  assert.equal(feePayerKey(FP.secret).address, FP.address);
  assert.throws(() => feePayerKey(base58(Uint8Array.from([...FP.seed, ...ed25519.getPublicKey(W.seed)]))), /public half/);
  assert.throws(() => feePayerKey("0OIl"), /base58/);
});

// ---- the replay: a tag 3 transaction LiteSVM landed on the pool-sol-buy-sell program ----

const LANDED = new URL("./fixtures/tag3-landed.json", import.meta.url);
test("the LiteSVM-landed tag 3 transaction, as W sent it, is carried, and the helper's bytes are the landed bytes", async () => {
  const f = JSON.parse(readFileSync(LANDED, "utf8"));
  const sent: Uint8Array[] = [];
  const fpSecret = base58(Uint8Array.from([...seedOf(f.fee_payer_seed), ...ed25519.getPublicKey(seedOf(f.fee_payer_seed))]));
  const s = solanaPoolSender(
    { cluster: "devnet", program: f.program, feePayerSecret: fpSecret, fee: f.relay_fee },
    { providers: [rpcStub(), rpcStub()], readRent: async () => TEST_RENT, send: (set) => (sent.push(set[0]!.wire), { signatures: ["x"], done: Promise.resolve({ txs: [] }), stop() {} }) },
  );
  assert.equal(s.pool, f.pool);
  assert.equal(s.feePayer, f.fee_payer);
  const a = await s.carry({ pool: f.pool, tx: f.w_only_b64 });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(Buffer.from(sent[0]!).toString("base64"), f.wire_b64, "ed25519 is deterministic: the helper's bytes are the bytes LiteSVM landed");
});
function seedOf(name: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(name).digest());
}

// ---- the routes, through the server's handler ----

test("GET /v1/pool/fee answers the pool's epoch fee; POST /v1/pool/solana/send carries or refuses", async () => {
  const { createServer } = await import("node:http");
  const { handler } = await import("../server.ts");
  const sent: Uint8Array[] = [];
  const s = sender(null, [], sent);
  const srv = createServer(handler("a".repeat(40), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1, new Map([[s.pool, s]]), new Map(), () => 1_800_000_090_000));
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const f = await fetch(`${base}/v1/pool/fee?pool=${POOL}&epoch=1800000060000`);
    assert.equal(f.status, 200);
    assert.deepEqual(await f.json(), await s.fee(1_800_000_060_000));
    // M356 (3): an epoch off the grid, after now, or older than POOL_LIFE_MAX_MS (600,000) is refused before any read
    for (const q of [`pool=${OTHER.address}`, "", `pool=${POOL}&epoch=1800000000001`, `pool=${POOL}&pool=${POOL}`, `pool=${POOL}&epoch=1800000120000`, `pool=${POOL}&epoch=1799999460000`]) assert.equal((await fetch(`${base}/v1/pool/fee?${q}`)).status, 404, q);
    assert.equal((await fetch(`${base}/v1/pool/fee?pool=${POOL}&epoch=1799999520000`)).status, 200, "ten minutes back is still in the window");
    const post = (b: unknown) => fetch(`${base}/v1/pool/solana/send`, { method: "POST", body: JSON.stringify(b) });
    const ok = await post(body(build({ tag: 3 })));
    assert.equal(ok.status, 200);
    assert.equal(sent.length, 1);
    const off = await post(body(build({ fee: FEE + 100_000n })));
    assert.equal(off.status, 422);
    assert.deepEqual(await off.json(), { error: { code: "fee_off", detail: "relay_fee 2100000, published 2000000" } });
    assert.equal((await post({ pool: OTHER.address, tx: "AA==" })).status, 404);
    assert.equal(sent.length, 1);
    // M356 (3): one client past POOL_RATE_MAX (30) in a window gets 429 on every pool route; 11 requests so far
    let last = 0;
    for (let i = 0; i < 19; i++) last = (await post({ pool: OTHER.address, tx: "AA==" })).status;
    assert.equal(last, 404, "the 30th request is still under the limit");
    assert.equal((await post({ pool: OTHER.address, tx: "AA==" })).status, 429);
    const limited = await fetch(`${base}/v1/pool/fee?pool=${POOL}`);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: { code: "rate_limited" } });
  } finally {
    srv.close();
  }
});

// ---- M352: the average release's fee carries a page-opening one; one send per nullifier ----

test("at mainnet's fee (1,300,000), a release whose change opens a page is carried: simulated, signed, sent", async () => {
  const calls: Calls = [];
  const sent: Uint8Array[] = [];
  const s = sender(null, calls, sent, { fee: 1_300_000n, rent: MAINNET });
  const wire = build({ fee: 1_300_000n, stateSize: 1024, pre: [cuLimit(400_000)] });
  const opens = solanaPoolReleaseAccounts({ program: PROGRAM, pool: POOL }, W.address, FP.address, release(1_300_000n), 1024)[6]!.key;
  assert.notEqual(opens, solanaPoolReleaseAccounts({ program: PROGRAM, pool: POOL }, W.address, FP.address, release(1_300_000n), 1023)[6]!.key, "1,024 is page 1's first entry");
  const a = await s.carry(body(wire));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(calls.filter((c) => c.method === "simulateTransaction").length, 1);
  assert.equal(sent.length, 1);
  // the page's opening is paid by the 715-lamport reserve every release keeps out of W's priority budget
  assert.ok(1_300_000n < solanaPoolReleaseCost(MAINNET) + solanaRentMin(MAINNET, 16 + 72), "the fee is under this release's own cost, and it is carried");
  assert.ok(solanaPoolPageReserve(MAINNET) * 1_024n >= solanaRentMin(MAINNET, 16), "1,024 reserves pay a page's opening");
});

test("one send per nullifier: a repeat in flight or landed, even as other bytes, gets the first signature and sends nothing", async () => {
  const sent: Uint8Array[] = [];
  const calls: Calls = [];
  const s = sender(null, calls, sent);
  const first = build({ tag: 3 });
  const copy = build({ tag: 3, blockhash: testKey("BLOCKHASH_2").address }); // the same release, another blockhash
  const [a, b] = await Promise.all([s.carry(body(first)), s.carry(body(first))]);
  const c = await s.carry(body(copy));
  assert.equal(a.status, 200);
  assert.deepEqual(b, a, "a repeat in flight answers the first signature");
  assert.deepEqual(c, a, "a copy with other bytes answers the first signature");
  assert.equal(sent.length, 1);
  assert.equal(calls.filter((x) => x.method === "simulateTransaction").length, 1);
  const other = await s.carry(body(build({ tag: 3, nullifier: 3 })));
  assert.equal(other.status, 200);
  assert.notDeepEqual(other, a);
  assert.equal(sent.length, 2, "another nullifier is its own send");
});

test("a refused carry or an expired send frees the nullifier; a failed one waits for the next epoch; an unknown one its deadline; a filled one never", async () => {
  const sent: Uint8Array[] = [];
  const simCalls: Calls = [];
  const failing = sender({ InstructionError: [1, { Custom: 4 }] }, simCalls, sent);
  assert.equal(code(await failing.carry(body(build()))), "simulation_failed");
  assert.equal(code(await failing.carry(body(build()))), "simulation_failed");
  assert.equal(simCalls.filter((c) => c.method === "simulateTransaction").length, 2, "refused, so simulated again, not answered from memory");
  for (const end of ["failed", "expired", "unknown"]) {
    const sentE: Uint8Array[] = [];
    let finish!: (s: string) => void;
    let now = NOW;
    const s = sender(null, [], sentE, { ends: () => new Promise((r) => (finish = r)), now: () => now });
    await s.carry(body(build()));
    await s.carry(body(build()));
    assert.equal(sentE.length, 1, `${end}: in flight, one send`);
    finish(end);
    await new Promise((r) => setImmediate(r));
    const retry = await s.carry(body(build({ blockhash: testKey("BLOCKHASH_2").address })));
    if (end === "expired") {
      assert.equal(sentE.length, 2, "expired: freed, the retry is sent");
      continue;
    }
    assert.equal(sentE.length, 1, `${end}: not sent again yet`);
    assert.equal(code(retry), end === "failed" ? "failed_this_epoch" : "ok", `${end}: the retry's answer`);
    // failed: the next epoch frees it; unknown: the first release's deadline frees it (a new release, a later deadline)
    now = end === "failed" ? NOW + POOL_EPOCH_MS : 1_800_000_270_000;
    await s.carry(body(build({ blockhash: testKey("BLOCKHASH_3").address, deadlineMs: BigInt(now) + 270_000n })));
    assert.equal(sentE.length, 2, `${end}: freed, the retry is sent`);
  }
  const sentF: Uint8Array[] = [];
  const filled = sender(null, [], sentF);
  await filled.carry(body(build()));
  await new Promise((r) => setImmediate(r));
  await filled.carry(body(build({ blockhash: testKey("BLOCKHASH_2").address })));
  assert.equal(sentF.length, 1, "landed: never sent again");
});

test("the memory is bounded: past it the oldest nullifier goes, and the chain's spent mark is what refuses it then", async () => {
  const sent: Uint8Array[] = [];
  const s = sender(null, [], sent, { memory: 2 });
  for (const n of [2, 3, 4]) await s.carry(body(build({ nullifier: n })));
  await s.carry(body(build({ nullifier: 4 })));
  assert.equal(sent.length, 3, "the newest is remembered");
  await s.carry(body(build({ nullifier: 2 })));
  assert.equal(sent.length, 4, "the oldest was evicted: carried again, and its simulation is what would refuse a spent one");
});

test("N3: the rent is read once an epoch, so a rent change between two epochs gives the new fee in the second with no restart", async () => {
  const reads: number[] = [];
  let now = NOW;
  const s = sender(null, [], [], { now: () => now, readRent: async (epoch) => (reads.push(epoch), epoch < NOW + POOL_EPOCH_MS ? TEST_RENT : MAINNET) });
  await s.ready;
  assert.equal((await s.fee(now)).fee, "2000000");
  assert.equal((await s.fee(now + 30_000)).fee, "2000000", "the same epoch reads nothing again");
  assert.deepEqual(reads, [NOW]);
  now += POOL_EPOCH_MS;
  assert.equal((await s.fee(now)).fee, "1300000", "the next epoch's rent gives the kit's fee for it");
  assert.deepEqual(reads, [NOW, NOW + POOL_EPOCH_MS]);
  // a release at the new fee is carried, priced against the new budget; one proved in the earlier epoch still is
  assert.equal(code(await s.carry(body(build({ fee: 1_300_000n, nullifier: 7 })))), "ok");
  assert.equal(code(await s.carry(body(build({ fee: 2_000_000n, nullifier: 8 })))), "ok");
  assert.equal(code(await s.carry(body(build({ fee: 1_400_000n, nullifier: 9 })))), "fee_off");
  const top = (solanaPoolPriorityBudget(MAINNET, 1_300_000n) * 1_000_000n) / 400_000n;
  assert.equal(code(await s.carry(body(build({ fee: 1_300_000n, nullifier: 10, pre: [cuLimit(400_000), cuPrice(top + 1n)] })))), "fee_below_cost");
  // a failed read is not kept: the next ask reads again
  let fail = true;
  const t = sender(null, [], [], { readRent: async () => { if (fail) throw new Error("down"); return TEST_RENT; } });
  await assert.rejects(t.fee(NOW));
  fail = false;
  assert.equal((await t.fee(NOW)).fee, "2000000");
});

// ---- The relayer's cost guards (card relayer-cost-guards, audit I-6: the program holds no relay fee floor) ----

test("I-6: a release whose relay fee is 0 is refused (fee_off) before any read, signature or send", async () => {
  assert.equal(refusal(build({ fee: 0n })), "fee_off");
  const calls: Calls = [];
  const sent: Uint8Array[] = [];
  const s = sender(null, calls, sent);
  for (const tag of [2, 3] as const) assert.equal(code(await s.carry(body(build({ tag, fee: 0n })))), "fee_off");
  assert.deepEqual([calls.length, sent.length], [0, 0]);
});

test("I-6: a release whose venue fails in the simulation is refused unsigned (simulation_failed), and its repeat sends nothing either", async () => {
  const calls: Calls = [];
  const sent: Uint8Array[] = [];
  // the pool instruction (index 2, after the two compute budget ones) fails inside its tag 3 inner call to the venue
  const s = sender({ InstructionError: [2, { Custom: 6001 }] }, calls, sent);
  const wire = build({ tag: 3, pre: [cuLimit(400_000), cuPrice(1n)] });
  for (let i = 0; i < 2; i++) {
    const a = await s.carry(body(wire));
    assert.deepEqual([a.status, code(a)], [422, "simulation_failed"]);
  }
  assert.equal(sent.length, 0, "nothing signed or sent");
  assert.ok(calls.every((c) => c.method === "simulateTransaction" || c.method === "getLatestBlockhash"));
});

// Card pool-senders-next-page: the forms the program takes since d3edab1 (contracts/pool-solana/src/release.rs:155 tag 2
// of 9 accounts, buy.rs:155-159 tag 3 flag bit 1 with the next state page after the tip account), so a release whose
// change note an insert carried onto the next page still lands; the forms without it keep today's path.
const NEXT = testKey("NEXT_STATE_PAGE").address;
/** A release W signed with the next page: a ninth account (tag 2), or flag bit 1 and the next page after the tip (tag 3). */
function withNext(tag: 2 | 3, o: { innerNames?: boolean; noAccount?: boolean } = {}): Uint8Array {
  const r = release();
  const accounts = solanaPoolReleaseAccounts({ program: PROGRAM, pool: POOL }, W.address, FP.address, r, 1023);
  let data: Uint8Array;
  if (tag === 2) {
    data = solanaEncodePoolRelease(r);
    accounts.push({ key: NEXT, signer: false, writable: true });
  } else {
    accounts.push({ key: TIP_TO, signer: false, writable: true }, ...(o.noAccount ? [] : [{ key: NEXT, signer: false, writable: true }]));
    if (!o.noAccount) accounts.push({ key: TO, signer: false, writable: true });
    const transferData = Uint8Array.from([2, 0, 0, 0, ...u64(1_000_000n)]);
    // the inner transfer W to TO (index 10, past the next page at 9), or to the next page itself (9)
    data = solanaEncodePoolTag3(r, false, 10_000n, [{ program: 7, accounts: [1, o.innerNames ? 9 : o.noAccount ? 8 : 10], data: transferData }]);
    data[1] = data[1]! | 2;
  }
  const { message } = solanaCompileV0(FP.address, [cuLimit(400_000), cuPrice(1_000n), { program: PROGRAM, accounts, data }], BLOCKHASH, [], [FP.address, W.address]);
  return Uint8Array.from([2, ...new Uint8Array(64), ...ed25519.sign(message, W.seed), ...message]);
}

test("pool-senders-next-page: a tag 2 naming the next state page (9 accounts) and a tag 3 with flag bit 1 and the page after the tip pass", () => {
  assert.equal(refusal(withNext(2)), "ok");
  assert.equal(refusal(withNext(3)), "ok");
  // the forms without it keep today's path
  assert.equal(refusal(build()), "ok");
  assert.equal(refusal(build({ tag: 3 })), "ok");
});

test("pool-senders-next-page: a tag 2 of 10 accounts, a tag 3 whose inner instruction names the next page, or flag bit 1 with no account for it, is refused (not_pool)", () => {
  const r = release();
  const accounts = [...solanaPoolReleaseAccounts({ program: PROGRAM, pool: POOL }, W.address, FP.address, r, 1023), { key: NEXT, signer: false, writable: true }, { key: TO, signer: false, writable: true }];
  const { message } = solanaCompileV0(FP.address, [cuLimit(400_000), cuPrice(1_000n), { program: PROGRAM, accounts, data: solanaEncodePoolRelease(r) }], BLOCKHASH, [], [FP.address, W.address]);
  assert.equal(refusal(Uint8Array.from([2, ...new Uint8Array(64), ...ed25519.sign(message, W.seed), ...message])), "not_pool");
  assert.equal(refusal(withNext(3, { innerNames: true })), "not_pool");
  // bit 1 set and nothing past the tip account: the next page the flag names is not there
  assert.equal(refusal(withNext(3, { noAccount: true })), "not_pool");
});

// card pool-senders-next-page-helper (the expand): POOL_SOLANA_PROGRAM_DEVNET may list several devnet programs, comma
// apart, so the re-pinned devnet pool and the one before it are served side by side, each its own sender on the same fee
// payer, fee and RPCs; mainnet takes exactly one program, and a list that names one twice or holds an empty entry is refused
test("the devnet program list: one sender per listed program, keyed by its own pool; mainnet one program; a bad list refused at start", () => {
  const OLD = "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ";
  const NEW = "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8";
  const down = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
  const env = (cluster: "DEVNET" | "MAINNET", program: string) => ({ [`POOL_SOLANA_PROGRAM_${cluster}`]: program, [`POOL_SOLANA_FEE_PAYER_KEY_${cluster}`]: FP.secret, [`POOL_SOLANA_FEE_${cluster}`]: "1300000", [`POOL_SOLANA_RPCS_${cluster}`]: "https://a.invalid,https://b.invalid" });
  const two = solanaPoolSendersFromEnv(env("DEVNET", `${OLD},${NEW}`), down);
  assert.deepEqual([...two.keys()].sort(), [solanaPoolAccount(OLD), solanaPoolAccount(NEW)].sort());
  for (const p of [OLD, NEW]) assert.equal(two.get(solanaPoolAccount(p))!.program, p);
  for (const s of two.values()) void s.ready.catch(() => {});
  const one = solanaPoolSendersFromEnv(env("DEVNET", NEW), down);
  assert.deepEqual([...one.keys()], [solanaPoolAccount(NEW)]);
  for (const s of one.values()) void s.ready.catch(() => {});
  for (const bad of [`${NEW},${NEW}`, `${NEW},`, `,${NEW}`, `${OLD} ,${NEW}`]) assert.throws(() => solanaPoolSendersFromEnv(env("DEVNET", bad), down), /POOL_SOLANA_PROGRAM_DEVNET/, bad);
  assert.throws(() => solanaPoolSendersFromEnv(env("MAINNET", `${OLD},${NEW}`), down), /POOL_SOLANA_PROGRAM_MAINNET must be a program id/);
});
