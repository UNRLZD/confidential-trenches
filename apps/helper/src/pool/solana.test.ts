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
import { checkSolanaPoolTx, feePayerKey, signAsFeePayer, solanaPoolSender, solanaPoolSendersFromEnv, solanaPoolSignaturesHold, type PoolSendAnswer } from "./solana.ts";
import { poolSendLine } from "./send-log.ts";
import { call, listening } from "../../test/servers.ts";

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
/** Every signature of `wire` checked over its message against the signer keys, as an RPC's sigVerify does. */
const signaturesHold = (wire: Uint8Array): boolean => {
  const n = wire[0]!;
  const message = wire.subarray(1 + 64 * n);
  // v0: prefix, header (3), compact-u16 key count (one byte here), then the keys; the first n sign
  const keys = Array.from({ length: n }, (_, i) => message.subarray(5 + 32 * i, 5 + 32 * (i + 1)));
  return keys.every((k, i) => ed25519.verify(wire.subarray(1 + 64 * i, 1 + 64 * (i + 1)), message, k));
};
function rpcStub(simErr: unknown = null, calls: Calls = []): SolanaRpc {
  return Object.assign(
    async (method: string, params: readonly unknown[]) => {
      calls.push({ method, params });
      if (method === "simulateTransaction") {
        const opts = params[1] as { sigVerify?: boolean };
        // sigVerify as a public mainnet RPC answers it (11 Nov 18:10Z): value.err "SignatureFailure"
        if (opts.sigVerify && !signaturesHold(Buffer.from(params[0] as string, "base64"))) return { context: { slot: 1 }, value: { err: "SignatureFailure", logs: [] } };
        // "echo": a provider that puts whatever it is given in its error
        if (simErr === "echo") return { context: { slot: 1 }, value: { err: { InstructionError: [0, { BorshIoError: params[0] }] }, logs: [] } };
        return { context: { slot: 1 }, value: { err: simErr, logs: [] } };
      }
      if (method === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } };
      throw new Error(`unexpected ${method}`);
    },
    { url: `https://stub.invalid/${Math.random()}` },
  );
}
function sender(simErr: unknown = null, calls: Calls = [], sent: Uint8Array[] = [], o: { fee?: bigint; ends?: () => Promise<string>; memory?: number; now?: () => number; rent?: SolanaRent; readRent?: (epoch: number) => Promise<SolanaRent>; log?: (line: string) => void; signFeePayer?: typeof signAsFeePayer } = {}) {
  return solanaPoolSender(
    { cluster: "devnet", program: PROGRAM, feePayerSecret: FP.secret, fee: String(o.fee ?? FEE) },
    {
      ...(o.signFeePayer ? { signFeePayer: o.signFeePayer } : {}),
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

test("the carry simulates W's bytes, adds the fee payer's signature and nothing else, verifies both, and sends", async () => {
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
  // card sol-pool-buy-lands-on-mainnet (review R1): one simulation, of W's bytes as received (slot 0 empty), on their own
  // blockhash; the signed bytes leave only in the send
  const sims = calls.filter((c) => c.method === "simulateTransaction");
  assert.equal(sims.length, 1, "one simulation round");
  assert.equal(sims[0]!.params[0], body(wire).tx, "the simulation ran on W's bytes as received");
  assert.deepEqual(sims[0]!.params[1], { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "processed" });
});

// card sol-pool-buy-lands-on-mainnet (review R1): both signatures of the bytes as sent are verified here, before any
// send; a wire whose fee-payer or W signature does not verify is refused, and no provider call ever carries signed bytes
test("both signatures of the bytes as sent are verified here: a wrong fee-payer or W signature does not hold", () => {
  for (const tag of [2, 3] as const) {
    const c = checkSolanaPoolTx(build({ tag }), CFG);
    assert.ok(c.ok);
    const signed = signAsFeePayer(c.tx, FP.seed);
    assert.equal(solanaPoolSignaturesHold(signed, c.tx), true, `tag ${tag}`);
    for (const at of [3, 70]) {
      const bad = signed.slice();
      bad[at]! ^= 1; // slot 0 (the fee payer's), slot 1 (W's)
      assert.equal(solanaPoolSignaturesHold(bad, c.tx), false, `tag ${tag}, byte ${at}`);
    }
    // a fee payer key that is not the message's payer: its signature does not hold
    assert.equal(solanaPoolSignaturesHold(signAsFeePayer(c.tx, W.seed), c.tx), false);
  }
});
test("a fee payer signature that does not verify at the call site is refused signature_failed, nothing sent, none in the answer", async () => {
  for (const tag of [2, 3] as const) {
    const sent: Uint8Array[] = [];
    // the signing seam: a slot 0 one bit off what the fee payer's key signs
    const flip: typeof signAsFeePayer = (tx, seed) => {
      const w = signAsFeePayer(tx, seed);
      w[3]! ^= 1;
      return w;
    };
    const a = await sender(null, [], sent, { signFeePayer: flip }).carry(body(build({ tag })));
    assert.deepEqual([a.status, code(a), a.note?.err], [422, "signature_failed", "signature"], `tag ${tag}`);
    assert.equal(sent.length, 0, "nothing sent");
    assert.deepEqual(Object.keys(a.body), ["error"]);
  }
});
test("a wire whose W signature does not verify is refused before any provider call; no provider call carries a signed slot 0", async () => {
  for (const tag of [2, 3] as const) {
    const calls: Calls = [];
    const bad = build({ tag });
    bad[70]! ^= 1;
    assert.equal(code(await sender(null, calls, []).carry(body(bad))), "bad_signature");
    assert.equal(calls.length, 0, "no provider call");
    const all: Calls = [];
    await sender(null, all, []).carry(body(build({ tag })));
    for (const c of all.filter((x) => typeof x.params[0] === "string")) {
      const w = Buffer.from(c.params[0] as string, "base64");
      if (w.length > 65 && w[0] === 2) assert.ok(w.subarray(1, 65).every((x) => x === 0), `${c.method} carried a signed slot 0`);
    }
  }
});
test("a provider that echoes what it is given never puts the fee payer's signature in an answer or a log line", async () => {
  for (const tag of [2, 3] as const) {
    const wire = build({ tag });
    const c = checkSolanaPoolTx(wire, CFG);
    assert.ok(c.ok);
    const fp = Buffer.from(signAsFeePayer(c.tx, FP.seed).subarray(1, 65));
    // base58, hex, and base64 at each of the three byte alignments it can sit at inside a longer base64 text
    const forms = [base58(fp), fp.toString("hex").slice(0, 40), ...[0, 1, 2].map((k) => Buffer.concat([Buffer.alloc(k), fp]).toString("base64").slice(4, 44))];
    for (const err of ["echo", "BlockhashNotFound"]) {
      const sent: Uint8Array[] = [];
      const a = await sender(err, [], sent).carry(body(wire));
      assert.equal(sent.length, 0);
      assert.ok(a.status === 422, `${err}: ${a.status}`);
      const line = poolSendLine({ chain: "solana", net: "devnet", route: "send", status: a.status, body: a.body, ms: 1, note: a.note });
      for (const f of forms) assert.ok(!JSON.stringify(a.body).includes(f) && !line.includes(f), `${err}: the fee payer's signature in ${JSON.stringify(a.body)} / ${line}`);
    }
  }
});
test("a blockhash the provider does not know is refused blockhash_not_found, nothing sent", async () => {
  const sent: Uint8Array[] = [];
  const a = await sender("BlockhashNotFound", [], sent).carry(body(build({ tag: 3 })));
  assert.deepEqual([a.status, code(a)], [422, "blockhash_not_found"]);
  assert.equal(sent.length, 0);
  assert.equal(a.note?.err, '"BlockhashNotFound"');
});

test("a failed simulation is refused before any signature or send (simulation_failed)", async () => {
  const sent: Uint8Array[] = [];
  const a = await sender({ InstructionError: [2, { Custom: 16 }] }, [], sent).carry(body(build()));
  assert.equal(code(a), "simulation_failed");
  assert.equal(a.status, 422);
  assert.equal(sent.length, 0);
  // card sol-pool-buy-lands-on-mainnet: the log line's note carries the error's shape only
  assert.equal(a.note?.err, '{"InstructionError":[2,{"Custom":16}]}');
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
  const port = await listening(srv.listen(0, "127.0.0.1"), "the helper");
  try {
    const f = await call(port, { path: `/v1/pool/fee?pool=${POOL}&epoch=1800000060000` }, "the helper");
    assert.equal(f.status, 200);
    assert.deepEqual(JSON.parse(f.body), await s.fee(1_800_000_060_000));
    // M356 (3): an epoch off the grid, after now, or older than POOL_LIFE_MAX_MS (600,000) is refused before any read
    for (const q of [`pool=${OTHER.address}`, "", `pool=${POOL}&epoch=1800000000001`, `pool=${POOL}&pool=${POOL}`, `pool=${POOL}&epoch=1800000120000`, `pool=${POOL}&epoch=1799999460000`]) assert.equal((await call(port, { path: `/v1/pool/fee?${q}` }, "the helper")).status, 404, q);
    assert.equal((await call(port, { path: `/v1/pool/fee?pool=${POOL}&epoch=1799999520000` }, "the helper")).status, 200, "ten minutes back is still in the window");
    const post = (b: unknown) => call(port, { path: `/v1/pool/solana/send`, method: "POST", body: JSON.stringify(b) }, "the helper");
    const ok = await post(body(build({ tag: 3 })));
    assert.equal(ok.status, 200);
    assert.equal(sent.length, 1);
    const off = await post(body(build({ fee: FEE + 100_000n })));
    assert.equal(off.status, 422);
    assert.deepEqual(JSON.parse(off.body), { error: { code: "fee_off", detail: "relay_fee 2100000, published 2000000" } });
    assert.equal((await post({ pool: OTHER.address, tx: "AA==" })).status, 404);
    assert.equal(sent.length, 1);
    // M356 (3): one client past POOL_RATE_MAX (30) in a window gets 429 on every pool route; 11 requests so far
    let last = 0;
    for (let i = 0; i < 19; i++) last = (await post({ pool: OTHER.address, tx: "AA==" })).status;
    assert.equal(last, 404, "the 30th request is still under the limit");
    assert.equal((await post({ pool: OTHER.address, tx: "AA==" })).status, 429);
    const limited = await call(port, { path: `/v1/pool/fee?pool=${POOL}` }, "the helper");
    assert.equal(limited.status, 429);
    assert.deepEqual(JSON.parse(limited.body), { error: { code: "rate_limited" } });
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

// ---- card helper-pool-fee-never-a-client-429: helper-25 on ee5c7dac4 (live run 45032297159) answered GET /v1/pool/fee
// 429 "provider limit", fee none: each epoch is 60 s (fee.ts POOL_EPOCH_MS) and its first ask read the Rent sysvar on the
// pool's two public providers, which the market's and the read ahead's reads held (the container's log: 104 "rpc hold
// solana-public background" and 103 "rpc hold solana publicnode.com market" lines). Planted here: both providers
// refuse every read as an address the market loads is refused (HTTP 429), from the second epoch on.

/** A pool sender whose rent read is refused 429 while `held` says so, and the epochs it read. */
function heldWorld(held: (n: number) => boolean) {
  let now = NOW;
  const reads: number[] = [];
  const s = sender(null, [], [], {
    now: () => now,
    readRent: async (epoch) => {
      reads.push(epoch);
      if (held(reads.length)) throw new Error("HTTP 429 Too Many Requests");
      return TEST_RENT;
    },
  });
  return { s, reads, at: () => now, step: (ms: number) => void (now += ms) };
}

test("card helper-pool-fee-never-a-client-429: every rent read after the first refused 429 (as both pool providers refuse a loaded address): 50 GET /v1/pool/fee, one an epoch, each answer 200 with the fee read first, one read an epoch (red at ee5c7dac4: the second epoch's ask answered 429 provider limit)", async () => {
  const { createServer } = await import("node:http");
  const { handler } = await import("../server.ts");
  const w = heldWorld((n) => n > 1);
  await w.s.ready;
  const srv = createServer(handler("a".repeat(40), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1, new Map([[w.s.pool, w.s]]), new Map(), w.at));
  const port = await listening(srv.listen(0, "127.0.0.1"), "the helper");
  try {
    const got: string[] = [];
    for (let k = 0; k < 50; k++) {
      const f = await call(port, { path: `/v1/pool/fee?pool=${POOL}` }, "the helper");
      got.push(f.status === 200 ? (JSON.parse(f.body) as { fee: string }).fee : `${f.status} ${f.body}`);
      w.step(POOL_EPOCH_MS);
    }
    assert.deepEqual(got, got.map(() => String(FEE)));
    // one read an epoch, never one an ask: the refused read is not asked again inside its epoch
    assert.equal(w.reads.length, 50);
  } finally {
    srv.close();
  }
});

test("card helper-pool-fee-never-a-client-429: a fresh start whose first rent read is throttled reads again until it is good, and once the fee is known no ask answers 429, the epoch the next reads are refused in included; a carried fee is the fee the send route holds the epoch's releases to (red at ee5c7dac4)", async () => {
  const w = heldWorld((n) => n === 1 || n > 2);
  let settled = "pending";
  w.s.ready.then(() => (settled = "ok"), () => (settled = "rejected"));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, "pending", "the first read was throttled and the start check waits");
  // the start check's next ask (server.ts poolsChecked, every READY_EVERY_MS) reads again, in the same epoch
  w.step(2_000);
  await w.s.ready;
  assert.equal(settled, "ok");
  w.step(POOL_EPOCH_MS);
  assert.equal((await w.s.fee(w.at())).fee, String(FEE), "the first epoch after the fee was known");
  // a release in the carried epoch: the fee published for it is carried, any other refused, where at ee5c7dac4 the
  // throttled read answered it 429 rate_limited too
  assert.equal(code(await w.s.carry(body(build({ fee: FEE, nullifier: 21 })))), "ok");
  assert.equal(code(await w.s.carry(body(build({ fee: 1_300_000n, nullifier: 22 })))), "fee_off");
  for (let k = 2; k <= 4; k++) {
    w.step(POOL_EPOCH_MS);
    assert.equal((await w.s.fee(w.at())).fee, String(FEE), `epoch ${k} after the fee was known`);
  }
});

test("card helper-pool-fee-never-a-client-429: a failed read before any good one carries nothing: the ask is still refused", async () => {
  const t = heldWorld(() => true);
  await assert.rejects(t.s.fee(t.at()), /HTTP 429/);
});

/** A rent a little above TEST_RENT's: the kit's fee for it is not FEE. */
const RENT2: SolanaRent = { lamportsPerByte: 12_000n, factor: 1n };
/** A pool sender whose rent reads answer `script` in order (its last for every read after), "fail" a 429. */
function seqWorld(script: Array<SolanaRent | "fail">) {
  let now = NOW;
  const reads: number[] = [];
  const s = sender(null, [], [], {
    now: () => now,
    readRent: async (epoch) => {
      reads.push(epoch);
      const r = script[Math.min(reads.length - 1, script.length - 1)]!;
      if (r === "fail") throw new Error("HTTP 429 Too Many Requests");
      return r;
    },
  });
  return { s, reads, at: () => now, step: (ms: number) => void (now += ms) };
}

test("card helper-pool-fee-never-a-client-429 (review M1): an epoch whose read fails carries the newest fee read, after a rent change the new one, never the first", async () => {
  const y = solanaPoolFee(RENT2);
  assert.notEqual(y, FEE);
  const w = seqWorld([TEST_RENT, RENT2, "fail"]);
  await w.s.ready;
  assert.equal((await w.s.fee(w.at())).fee, String(FEE));
  w.step(POOL_EPOCH_MS);
  assert.equal((await w.s.fee(w.at())).fee, String(y), "the next epoch read the new rent");
  w.step(POOL_EPOCH_MS);
  assert.equal((await w.s.fee(w.at())).fee, String(y), "the epoch after failed: it carries the newest fee");
});

test("card helper-pool-fee-never-a-client-429 (review M2): a carried epoch's fee is kept as that epoch's: a release bound in it is carried in the next epoch after the rent moved, though the last good read at its fee is past a proof's life", async () => {
  const y = solanaPoolFee(RENT2);
  // a good read at FEE, then 11 failed epochs (each carries FEE), then a good read at the new rent
  const w = seqWorld([TEST_RENT, ...Array<"fail">(11).fill("fail"), RENT2]);
  await w.s.ready;
  for (let k = 1; k <= 11; k++) {
    w.step(POOL_EPOCH_MS);
    assert.equal((await w.s.fee(w.at())).fee, String(FEE), `carried epoch ${k}`);
  }
  // the device binds FEE in the 11th carried epoch (its deadline 270 s on) and sends in the next, read good at the new rent
  const wire = build({ fee: FEE, nullifier: 77, deadlineMs: BigInt(w.at()) + 270_000n });
  w.step(POOL_EPOCH_MS);
  assert.equal((await w.s.fee(w.at())).fee, String(y));
  assert.equal(code(await w.s.carry(body(wire))), "ok");
});

test("card helper-pool-fee-never-a-client-429 (review M4): the pool senders the helper builds from its environment (server.ts poolSendersOf) read through poolFetchAhead: a 429 to the pool's rent read holds the market's reads of that provider", async () => {
  const { poolSendersOf } = await import("../server.ts");
  const { createRpc } = await import("../rpc/rpc.ts");
  let t = 1_795_000_000_000;
  const BETA = "https://api.mainnet-beta.solana.com";
  const NODE = "https://solana-rpc.publicnode.com";
  const rpc = createRpc({ SOLANA_RPC_URL: "https://mainnet.helius-rpc.invalid/?api-key=fake-helius-key-0123456789abcdef" }, { fetch: (async () => new Response("{}")) as never, now: () => t, log: () => {} });
  const refusing = (async () => new Response("Too many requests", { status: 429, headers: { "retry-after": "10" } })) as unknown as typeof fetch;
  const env = { POOL_SOLANA_PROGRAM_MAINNET: PROGRAM, POOL_SOLANA_FEE_PAYER_KEY_MAINNET: FP.secret, POOL_SOLANA_FEE_MAINNET: String(FEE), POOL_SOLANA_RPCS_MAINNET: `${BETA}/,${NODE}` };
  // the helper's start builds its pools so (server.ts main), on the rpc its market reads draw
  assert.match(readFileSync(new URL("../server.ts", import.meta.url), "utf8"), /\n {4}const pools = poolSendersOf\(process\.env, rpc\);\n/, "the helper's start builds its pools through poolSendersOf");
  const pools = poolSendersOf(env, rpc, refusing);
  assert.equal(pools.size, 1);
  for (const url of [BETA, NODE]) assert.equal(rpc.caller("solana", url, "getTransaction", "198.51.100.7"), 0, `${url} free before the pool's read`);
  await assert.rejects([...pools.values()][0]!.fee(t), /429/);
  t += 1_000;
  for (const url of [BETA, NODE]) assert.ok(rpc.caller("solana", url, "getTransaction", "198.51.100.7") > 0, `${url}: the market's reads held after the pool's 429`);
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
/** A release W signed with the next page: a ninth account (tag 2), or flag bit 1 and the next page after the tip (tag 3;
 *  at 8 when the tip is 0, since no tip account comes before it). `flags` sets more of tag 3's flag bits. */
function withNext(tag: 2 | 3, o: { innerNames?: boolean; noAccount?: boolean; tip?: bigint; flags?: number } = {}): Uint8Array {
  const r = release();
  const accounts = solanaPoolReleaseAccounts({ program: PROGRAM, pool: POOL }, W.address, FP.address, r, 1023);
  let data: Uint8Array;
  if (tag === 2) {
    data = solanaEncodePoolRelease(r);
    accounts.push({ key: NEXT, signer: false, writable: true });
  } else {
    const tip = o.tip ?? 10_000n;
    const t = tip > 0n ? 1 : 0;
    if (t) accounts.push({ key: TIP_TO, signer: false, writable: true });
    if (!o.noAccount) accounts.push({ key: NEXT, signer: false, writable: true }, { key: TO, signer: false, writable: true });
    const transferData = Uint8Array.from([2, 0, 0, 0, ...u64(1_000_000n)]);
    // the inner transfer W to TO (index 9 + t, past the next page at 8 + t), or to the next page itself (8 + t)
    data = solanaEncodePoolTag3(r, false, tip, [{ program: 7, accounts: [1, o.innerNames ? 8 + t : o.noAccount ? 8 : 9 + t], data: transferData }]);
    data[1] = data[1]! | 2 | (o.flags ?? 0);
  }
  const { message } = solanaCompileV0(FP.address, [cuLimit(400_000), cuPrice(1_000n), { program: PROGRAM, accounts, data }], BLOCKHASH, [], [FP.address, W.address]);
  return Uint8Array.from([2, ...new Uint8Array(64), ...ed25519.sign(message, W.seed), ...message]);
}

test("pool-senders-next-page: a tag 2 naming the next state page (9 accounts) and a tag 3 with flag bit 1 and the page after the tip pass", () => {
  assert.equal(refusal(withNext(2)), "ok");
  assert.equal(refusal(withNext(3)), "ok");
  // a tag 3 with no tip names its next page at 8 (contracts/pool-solana/svm-tests/tests/release.rs
  // a_tag3_with_no_tip_names_its_next_page_at_8), as the device builds it
  assert.equal(refusal(withNext(3, { tip: 0n })), "ok");
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
  // with no tip the page is at 8, so an inner instruction naming 8 names the page
  assert.equal(refusal(withNext(3, { tip: 0n, innerNames: true })), "not_pool");
  // a flag bit the program does not take (bit 2): refused here, not left to the simulation
  assert.equal(refusal(withNext(3, { flags: 4 })), "not_pool");
});

// card pool-senders-next-page-helper (the expand) let POOL_SOLANA_PROGRAM_DEVNET list several devnet programs. Card
// helper-mainnet-pools-only: the helper serves the mainnet pool alone, one program; devnet's lines load nothing and stop
// nothing, a devnet list naming the mainnet program included
test("mainnet one program, keyed by its own pool, a list refused at start; devnet's lines beside it load nothing", () => {
  const OLD = "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ";
  const NEW = "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8";
  const down = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
  const env = (cluster: "DEVNET" | "MAINNET", program: string) => ({ [`POOL_SOLANA_PROGRAM_${cluster}`]: program, [`POOL_SOLANA_FEE_PAYER_KEY_${cluster}`]: FP.secret, [`POOL_SOLANA_FEE_${cluster}`]: "1300000", [`POOL_SOLANA_RPCS_${cluster}`]: "https://a.invalid,https://b.invalid" });
  const one = solanaPoolSendersFromEnv(env("MAINNET", NEW), down);
  assert.deepEqual([...one.keys()], [solanaPoolAccount(NEW)]);
  for (const s of one.values()) void s.ready.catch(() => {});
  for (const bad of [`${OLD},${NEW}`, `${NEW},`, " ", "not-a-program"]) assert.throws(() => solanaPoolSendersFromEnv(env("MAINNET", bad), down), /POOL_SOLANA_PROGRAM_MAINNET must be a program id/, bad);
  assert.equal(solanaPoolSendersFromEnv(env("DEVNET", `${OLD},${NEW}`), down).size, 0);
  const both = solanaPoolSendersFromEnv({ ...env("MAINNET", NEW), ...env("DEVNET", `${OLD},${NEW}`) }, down);
  assert.deepEqual([...both.values()].map((s) => [s.cluster, s.program]), [["mainnet", NEW]]);
  for (const s of both.values()) void s.ready.catch(() => {});
});

// card helper-sol-fee-payer-mainnet: the fee payer's low mark, the least balance that carries the worst release (its own
// rent floor, the release's cost fronted, a page opened, the whole priority budget), one definition the key step's
// print and the live check both read
test("the fee payer's low mark: its rent floor, the worst release fronted and the whole priority budget, from the rent", async () => {
  const { solanaFeePayerLowMark } = (await import("./solana.ts")) as { solanaFeePayerLowMark?: (rent: SolanaRent) => bigint };
  assert.equal(typeof solanaFeePayerLowMark, "function", "solana.ts exports solanaFeePayerLowMark");
  for (const rent of [{ lamportsPerByte: 5_080n, factor: 1n }, { lamportsPerByte: 3_480n, factor: 2n }, { lamportsPerByte: 2_540n, factor: 1n }] as SolanaRent[]) {
    const want = solanaRentMin(rent, 0) + solanaPoolReleaseCost(rent) + solanaRentMin(rent, 16) + solanaPoolPriorityBudget(rent, solanaPoolFee(rent));
    assert.equal(solanaFeePayerLowMark!(rent), want, `at ${rent.lamportsPerByte} a byte, factor ${rent.factor}`);
    assert.ok(solanaFeePayerLowMark!(rent) > solanaPoolFee(rent) - solanaPoolPageReserve(rent), "it covers more than the fee less the page reserve");
  }
  assert.equal(solanaFeePayerLowMark!({ lamportsPerByte: 5_080n, factor: 1n }), 2_681_045n, "2,681,045 lamports at today's mainnet rent (5,080 a byte, factor 1)");
});

// ---- card helper-solana-slots-off-a-spent-key, round 2: a read A throttles goes to B ----
// Live run 44783106750 (20 Nov 17:26:46Z): relayer-cost-guards' program_fails and sol-pool-buy-lands' next_tag2 and
// next_tag3 answered 429 rate_limited, the pool's provider A throttling its simulation, while B had room (the same three
// answered 422 three seconds before and at 18:05Z alone). A user's release is never a 429 while one provider has room.

/** A provider that throttles every read, as the kit's client throws it (send.ts solanaJsonRpc: HTTP 429). */
function throttledStub(calls: Calls = []): SolanaRpc {
  return Object.assign(
    async (method: string, params: readonly unknown[]) => {
      calls.push({ method, params });
      throw new Error("HTTP 429");
    },
    { url: `https://throttled.invalid/${Math.random()}` },
  );
}
const senderOn = (providers: readonly [SolanaRpc, SolanaRpc], sent: Uint8Array[] = []) =>
  solanaPoolSender(
    { cluster: "devnet", program: PROGRAM, feePayerSecret: FP.secret, fee: String(FEE) },
    {
      providers,
      now: () => NOW,
      readRent: async () => TEST_RENT,
      log: () => {},
      send: (set) => {
        sent.push(set[0]!.wire);
        const sig = base58(set[0]!.wire.subarray(1, 65));
        return { signatures: [sig], done: Promise.resolve({ txs: [{ signature: sig, state: "filled" as const, sends: [] }] }), stop() {} };
      },
    },
  );

test("provider A throttles the simulation: B simulates it, so a release whose program fails is refused 422 simulation_failed, never 429", async () => {
  const onA: Calls = [];
  const onB: Calls = [];
  const sent: Uint8Array[] = [];
  const a = await senderOn([throttledStub(onA), rpcStub({ InstructionError: [1, { Custom: 9 }] }, onB)], sent).carry(body(build()));
  assert.equal(code(a), "simulation_failed", JSON.stringify(a.body));
  assert.equal(a.status, 422);
  assert.equal(sent.length, 0);
  assert.ok(onA.some((c) => c.method === "simulateTransaction"), "A was asked first");
  assert.ok(onB.some((c) => c.method === "simulateTransaction"), "B simulated it");
});

test("provider A throttles the simulation: B's passing simulation lets a good release be carried and sent", async () => {
  const sent: Uint8Array[] = [];
  const a = await senderOn([throttledStub(), rpcStub()], sent).carry(body(build({ tag: 3 })));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(sent.length, 1);
});

test("both providers throttle: 429 rate_limited as before, nothing signed or sent", async () => {
  const sent: Uint8Array[] = [];
  const a = await senderOn([throttledStub(), throttledStub()], sent).carry(body(build()));
  assert.equal(a.status, 429);
  assert.equal(code(a), "rate_limited");
  assert.equal(sent.length, 0);
});

// ---- card helper-pool-reads-past-a-stalled-provider: a read A gives no answer to goes to B ----
// Helper live run 45526898423 (25 Nov 01:36:48-01:37:30Z): twelve releases of owners-solana-buy-lands, relayer-cost-guards,
// pool-senders-next-page-helper, buy-carry-helper-round, buy-spends-several-pieces and sol-pool-buy-lands-on-mainnet-helper
// answered 503 upstream at 5,007-5,019 ms, the kit client's 5 s timeout (send.ts SOLANA_CALL_TIMEOUT_MS) on provider A's
// simulation, B never asked; the same releases answered 422 at 23:32Z and at 01:56Z.

/** A provider whose every read fails as the kit's client throws it without a retry (send.ts solanaJsonRpc: the fetch's
 *  own error for no answer in time or no connection, "HTTP 5xx" for a server error, "RPC error ..." for an answer). */
function failingStub(error: () => unknown, calls: Calls = []): SolanaRpc {
  return Object.assign(
    async (method: string, params: readonly unknown[]) => {
      calls.push({ method, params });
      throw error();
    },
    { url: `https://failing.invalid/${Math.random()}` },
  );
}
const NO_ANSWER: readonly [string, () => unknown][] = [
  ["no answer in 5 s", () => new DOMException("The operation was aborted due to timeout", "TimeoutError")],
  ["no connection", () => new TypeError("fetch failed")],
  ["HTTP 503", () => new Error("HTTP 503")],
];

for (const [what, error] of NO_ANSWER) {
  test(`provider A gives no answer (${what}): B simulates it, so a release whose program fails is refused 422 simulation_failed, never 503`, async () => {
    const onA: Calls = [];
    const onB: Calls = [];
    const sent: Uint8Array[] = [];
    const a = await senderOn([failingStub(error, onA), rpcStub({ InstructionError: [1, { Custom: 9 }] }, onB)], sent).carry(body(build()));
    assert.equal(code(a), "simulation_failed", JSON.stringify(a.body));
    assert.equal(a.status, 422);
    assert.equal(sent.length, 0);
    assert.ok(onA.some((c) => c.method === "simulateTransaction"), "A was asked first");
    assert.ok(onB.some((c) => c.method === "simulateTransaction"), "B simulated it");
  });

  test(`provider A gives no answer (${what}): B's passing simulation lets a good release be carried and sent`, async () => {
    const sent: Uint8Array[] = [];
    const a = await senderOn([failingStub(error), rpcStub()], sent).carry(body(build({ tag: 3 })));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(sent.length, 1);
  });
}

test("both providers give no answer: 503 upstream as before, nothing signed or sent", async () => {
  const sent: Uint8Array[] = [];
  const a = await senderOn([failingStub(NO_ANSWER[0]![1]), failingStub(NO_ANSWER[1]![1])], sent).carry(body(build()));
  assert.equal(a.status, 503);
  assert.equal(code(a), "upstream");
  assert.equal(sent.length, 0);
});

test("an answer A gave (a JSON-RPC error) stays A's: 503 upstream, B never asked, nothing signed or sent", async () => {
  const onB: Calls = [];
  const sent: Uint8Array[] = [];
  const a = await senderOn([failingStub(() => new Error("RPC error -32603: Internal error")), rpcStub(null, onB)], sent).carry(body(build()));
  assert.equal(a.status, 503);
  assert.equal(code(a), "upstream");
  assert.equal(onB.length, 0, "B was never asked");
  assert.equal(sent.length, 0);
});
