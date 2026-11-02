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
import { POOL_EPOCH_MS, SOLANA_RELEASE_COST_MAX, solanaPoolFee } from "./fee.ts";
import { checkSolanaPoolTx, feePayerKey, solanaPoolSender, type PoolSendAnswer } from "./solana.ts";

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
const CFG = { program: PROGRAM, pool: POOL, feePayer: FP.address, fee: FEE };

const field = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
const release = (relayFee = FEE): SolanaPoolRelease => ({
  proof: new Uint8Array(256).fill(7),
  newCommitmentHash: field(1),
  existingNullifierHash: field(2),
  withdrawnValue: 50_000_000n,
  stateRootIndex: 5,
  stateTreeDepth: 3,
  labelRootIndex: 5,
  labelTreeDepth: 3,
  relayFee,
  relayFeeCap: 3_000_000n,
  tipCap: 10_000n,
  deadlineMs: 1_800_000_270_000n,
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
};
/** A v0 transaction W signed, the fee payer's slot empty: what the device sends. */
function build(o: Build = {}): Uint8Array {
  const r = release(o.fee ?? FEE);
  const cfg = { program: o.program ?? PROGRAM, pool: o.pool ?? POOL };
  const accounts = solanaPoolReleaseAccounts(cfg, W.address, FP.address, r, 6);
  let data: Uint8Array;
  if ((o.tag ?? 2) === 2) data = solanaEncodePoolRelease(r);
  else {
    accounts.push({ key: o.tipTo ?? TIP_TO, signer: false, writable: true }, ...(o.extra ?? [{ key: TO, signer: false, writable: true }]));
    const transferData = Uint8Array.from([2, 0, 0, 0, ...u64(1_000_000n)]);
    data = solanaEncodePoolTag3(r, false, 10_000n, o.inner ?? [{ program: 7, accounts: [1, 9], data: transferData }]);
  }
  const ixs = [...(o.pre ?? [cuLimit(400_000), cuPrice(1_000n)]), { program: cfg.program, accounts, data }, ...(o.post ?? [])];
  const { message } = solanaCompileV0(FP.address, ixs, BLOCKHASH, [], [FP.address, W.address]);
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
  // 400,000 CU at 1,000,000 micro-lamports: 400,000 lamports of priority, over the 242,480 the fee leaves
  assert.equal(refusal(build({ pre: [cuLimit(400_000), cuPrice(1_000_000n)] })), "fee_below_cost");
  assert.equal(refusal(build({ pre: [cuLimit(400_000), cuPrice(606_200n)] })), "ok");
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
function sender(simErr: unknown = null, calls: Calls = [], sent: Uint8Array[] = []) {
  return solanaPoolSender(
    { cluster: "devnet", program: PROGRAM, feePayerSecret: FP.secret, fee: FEE },
    {
      providers: [rpcStub(simErr, calls), rpcStub()],
      send: (set) => {
        sent.push(set[0]!.wire);
        const sig = base58(set[0]!.wire.subarray(1, 65));
        return { signatures: [sig], done: Promise.resolve({ txs: [] }), stop() {} };
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

test("the published fee: on its step, the same for every caller in every epoch, never under the worst release cost", () => {
  const s = sender();
  const a = s.fee(1_800_000_012_345);
  assert.deepEqual(a, { chain: "solana", cluster: "devnet", program: PROGRAM, pool: POOL, fee_payer: FP.address, epoch_ms: POOL_EPOCH_MS, epoch_start_ms: 1_800_000_000_000, fee: "2000000", step: "100000" });
  assert.equal(s.fee(1_800_000_060_000).fee, a.fee);
  assert.equal(solanaPoolFee("1900001", "x"), 2_000_000n);
  assert.equal(SOLANA_RELEASE_COST_MAX, 1_757_520n, "release.rs row 8's figure");
  assert.equal(solanaPoolFee("1757519", "x"), 1_800_000n, "rounded up to the step, above the worst cost");
  assert.throws(() => solanaPoolFee("0", "x"), /whole number/);
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
    { cluster: "devnet", program: f.program, feePayerSecret: fpSecret, fee: BigInt(f.relay_fee) },
    { providers: [rpcStub(), rpcStub()], send: (set) => (sent.push(set[0]!.wire), { signatures: ["x"], done: Promise.resolve({ txs: [] }), stop() {} }) },
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
  const srv = createServer(handler("a".repeat(40), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1, new Map([[s.pool, s]])));
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const f = await fetch(`${base}/v1/pool/fee?pool=${POOL}&epoch=1800000060000`);
    assert.equal(f.status, 200);
    assert.deepEqual(await f.json(), s.fee(1_800_000_060_000));
    for (const q of [`pool=${OTHER.address}`, "", `pool=${POOL}&epoch=1800000000001`, `pool=${POOL}&pool=${POOL}`]) assert.equal((await fetch(`${base}/v1/pool/fee?${q}`)).status, 404, q);
    const post = (b: unknown) => fetch(`${base}/v1/pool/solana/send`, { method: "POST", body: JSON.stringify(b) });
    const ok = await post(body(build({ tag: 3 })));
    assert.equal(ok.status, 200);
    assert.equal(sent.length, 1);
    const off = await post(body(build({ fee: FEE + 100_000n })));
    assert.equal(off.status, 422);
    assert.deepEqual(await off.json(), { error: { code: "fee_off", detail: "relay_fee 2100000, published 2000000" } });
    assert.equal((await post({ pool: OTHER.address, tx: "AA==" })).status, 404);
    assert.equal(sent.length, 1);
  } finally {
    srv.close();
  }
});
