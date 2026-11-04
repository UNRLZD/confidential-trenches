// Card signpage-pool-buy: one tap on the signing page takes a ready proof, reads the venue and the quote on two RPCs,
// builds the tag 3, checks it against the user's own ask, signs it as W, sends it through the helper and marks the
// note spent only once the transaction reads back on both RPCs (src/pool-buy.ts).
// The chain answers are the kit's recorded reads (packages/kit/test/fixtures/solana-pool-buy.json: the LiteSVM run on
// copies of mainnet's pump program and accounts, both providers' answers, the Rent sysvar as both answered it, and the
// pool fixture's real release proof); the pool's own account and pages are planted around that release. The seed is the
// published all-zero entropy vector (packages/wallet/test/vectors/a8.json).
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { entropyToWords, freshWallet, wordsToSeed64 } from "@blindfill/wallet/derive";
import { solanaPoolPage } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaDecodeMessage } from "../../kit/src/checks/solana/message.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { VaultSnarkjsProof, VaultWithdrawSignals } from "../../kit/src/vault/shapes.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import { solanaContextOf, solanaPoolOf, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { ALT, BLOCKHASH, FEE_PAYER, POOL, PROGRAM, fx, replay, setup, unhex } from "../../kit/test/solana-pool-buy-fx.ts";
import { poolBuyKind, runPoolBuy, solanaProofBytes, type PoolBuyHost } from "../src/pool-buy.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const L = 7n;
const J = 0;
const W = freshWallet(SEED64, "sol", L, J);
W.secretKey.fill(0);
const PIN = { program: PROGRAM, feePayer: FEE_PAYER };
const { scope: SCOPE } = solanaPoolOf(PROGRAM);
const r = fx.release;
const FEE = BigInt(fx.relay_fee_cap);
const STATE_ROOT = 0x1234_5678n;
const LABEL_ROOT = 0x9abc_def0n;
const SIZE = 6;
const SPEND = 5_000_000n;
const SIG = base58.encode(new Uint8Array(64).fill(5)); // the fee payer's signature the helper answers

const beHex = (b: Uint8Array): string => BigInt("0x" + Buffer.from(b).toString("hex")).toString();
// the fixture's 256 proof bytes as snarkjs JSON: A, B (each Fq2 imaginary part first in the bytes), C
const P = unhex(r.proof);
const at = (i: number) => beHex(P.subarray(i * 32, i * 32 + 32));
const PROOF: VaultSnarkjsProof = { pi_a: [at(0), at(1), "1"], pi_b: [[at(3), at(2)], [at(5), at(4)], ["1", "0"]], pi_c: [at(6), at(7), "1"] };

function readyProof(over: { stateRoot?: bigint } = {}): ReadyProof<SolanaReleaseRequest> {
  const request: SolanaReleaseRequest = { program: PROGRAM, pool: POOL, recipient: W.address, feePayer: FEE_PAYER, relayFee: FEE, relayFeeCap: FEE, tipCap: BigInt(fx.tip_cap), deadlineMs: BigInt(fx.deadline_ms), salt: r.salt };
  const context = solanaContextOf(request, SCOPE);
  const signals: VaultWithdrawSignals = [beHex(unhex(r.new_commitment)), beHex(unhex(r.nullifier_hash)), String(r.withdrawn), String(over.stateRoot ?? STATE_ROOT), String(r.state_depth), String(LABEL_ROOT), String(r.label_depth), context.toString()];
  return {
    noteId: "note-1", attempt: "attempt-1", poolId: "sol", wallet: { chain: "sol", l: L, j: J, path: W.path, address: W.address },
    chunk: BigInt(r.withdrawn), epochStartMs: 0n, deadlineMs: BigInt(fx.deadline_ms), root: "epoch",
    binding: { context, feeCap: FEE, request }, proof: PROOF, publicSignals: signals,
  };
}

const b32 = (x: bigint): number[] => [...Buffer.from(x.toString(16).padStart(64, "0"), "hex")];
const page = (root: bigint): Uint8Array => {
  const d = new Uint8Array(16 + SIZE * 72);
  for (let i = 0; i < SIZE; i++) d.set(b32(i === SIZE - 1 ? root : 1000n + BigInt(i)), 16 + i * 72 + 32);
  return d;
};
const poolAccount = (): Uint8Array => {
  const d = new Uint8Array(2179);
  d.set(new TextEncoder().encode("bfpool01"));
  const v = new DataView(d.buffer);
  v.setBigUint64(49, BigInt(SIZE), true);
  v.setBigUint64(49 + 8 + 1 + 33 * 32, BigInt(SIZE), true);
  return d;
};

type World = {
  host: PoolBuyHost;
  log: string[];
  state: () => string;
  sentTx: () => Uint8Array | null;
};
type Plant = {
  /** the slot of the device's blockhash read, past the quote's */
  slotAhead?: number;
  /** provider B's curve account changed at one byte: "reserves" (the top byte of its virtual SOL reserves: far past
   *  the kit's 2% read tolerance) or "creator" (a static byte, the creator's key) */
  venueOff?: "reserves" | "creator";
  /** provider B's state page without the proof's root */
  rootOnOne?: boolean;
  /** getTransaction's answer for the helper's signature */
  readBack?: "ours" | "none" | "other" | "failed";
};

async function world(plant: Plant = {}, proof = readyProof()): Promise<World> {
  const s = await setup("pump", SPEND);
  const log: string[] = [];
  let st = "HELD";
  let sent: Uint8Array | null = null;
  const accounts = (p: 0 | 1): Record<string, { owner: string; data: Uint8Array }> => ({
    [s.tableAddr]: { owner: ALT, data: s.tableData },
    [POOL]: { owner: PROGRAM, data: poolAccount() },
    [solanaPoolPage(PROGRAM, 0, 0)]: { owner: PROGRAM, data: page(plant.rootOnOne && p === 1 ? 77n : STATE_ROOT) },
    [solanaPoolPage(PROGRAM, 1, 0)]: { owner: PROGRAM, data: page(LABEL_ROOT) },
    [fx.rent.account]: { owner: fx.rent.answers[p].owner, data: base64.decode(fx.rent.answers[p].data) },
  });
  const rpc = (p: 0 | 1): SolanaRpc => {
    const venue = replay(fx.pump, p, plant.venueOff && p === 1 ? (list, ans) => {
      const k = list.indexOf(s.venue.kind === "pump-curve" ? s.venue.curve : "");
      if (k >= 0 && ans.value[k]) {
        const d = base64.decode(ans.value[k].data[0]);
        d[plant.venueOff === "creator" ? 60 : 23]! ^= 1; // pump's BondingCurve: creator at 49..81, virtual SOL reserves at 16..24
        ans.value[k].data[0] = base64.encode(d);
      }
      return ans;
    } : undefined);
    return (async (method: string, params: readonly unknown[]) => {
      log.push(`${p}:${method}`);
      if (method === "getMultipleAccounts") return venue(method, params);
      if (method === "getAccountInfo") {
        const a = accounts(p)[params[0] as string];
        return { context: { slot: s.ref.slot! + 2 }, value: a ? { owner: a.owner, lamports: 1, data: [base64.encode(a.data), "base64"] } : null };
      }
      if (method === "getLatestBlockhash") return { context: { slot: s.ref.slot! + (plant.slotAhead ?? 2) }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } };
      if (method === "isBlockhashValid") return { value: true };
      if (method === "getTransaction") {
        const how = plant.readBack ?? "ours";
        if (how === "none" || sent === null) return null;
        const tx = sent.slice();
        tx.set(base58.decode(SIG), 1);
        if (how === "other") tx[tx.length - 1]! ^= 1;
        return { transaction: [base64.encode(tx), "base64"], meta: { err: how === "failed" ? { InstructionError: [2, { Custom: 6 }] } : null } };
      }
      throw new Error(`unexpected ${method}`);
    }) as SolanaRpc;
  };
  const rpcs = [rpc(0), rpc(1)] as const;
  const host: PoolBuyHost = {
    pin: PIN,
    table: s.tableAddr,
    cluster: "mainnet",
    rpcs,
    ready: async () => (st === "HELD" ? [proof] : []),
    take: async (id) => {
      log.push(`take:${id}`);
      assert.equal(st, "HELD");
      st = "RESERVED";
      return proof;
    },
    seed64: async () => SEED64.slice(),
    send: async (pool, tx) => {
      log.push("send");
      assert.equal(pool, POOL);
      assert.equal(st, "RESERVED", "the note is RESERVED before the transaction leaves");
      sent = tx.slice();
      return { signature: SIG };
    },
    settle: async (id) => {
      log.push(`settle:${id}`);
      st = "SPENT";
      return { kind: "spent" };
    },
    now: () => 1_000n,
    reads: 3,
    wait: async () => {},
    pick: () => 2,
  };
  return { host, log, state: () => st, sentTx: () => sent };
}

const ASK: PoolAsk = { kind: "pool.buy", chain: "solana", token: fx.pump.mint, amount: SPEND, slippageBps: 300, decimals: 6 };

test("the proof's bytes are A, B with each Fq2 imaginary part first, C: the fixture's release proof", () => {
  assert.deepEqual(solanaProofBytes(PROOF), P);
});

test("a buy: checked, signed by W in slot 1, taken before it leaves, read back on both RPCs, then the note SPENT", async () => {
  const w = await world();
  const a = await runPoolBuy(w.host, ASK);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal(w.state(), "SPENT");
  const order = w.log.filter((x) => x === "take:note-1" || x === "send" || x.endsWith("getTransaction") || x === "settle:note-1");
  assert.deepEqual(order.slice(0, 2), ["take:note-1", "send"]);
  assert.ok(order.includes("0:getTransaction") && order.includes("1:getTransaction"), "read back on both RPCs");
  assert.equal(order.at(-1), "settle:note-1", "spent only after the read-back");
  const tx = w.sentTx()!;
  assert.equal(tx[0], 2);
  assert.deepEqual(tx.subarray(1, 65), new Uint8Array(64), "slot 0 is the fee payer's, left zero");
  const message = tx.subarray(129);
  assert.ok(ed25519.verify(tx.subarray(65, 129), message, base58.decode(W.address)), "W's signature over the message");
  const m = solanaDecodeMessage(message);
  assert.equal(m.blockhash, BLOCKHASH);
});

test("a quote off the request (older than the device's slot allows) is refused: nothing signed, taken or sent", async () => {
  const w = await world({ slotAhead: 40 });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "quote_check_failed" });
  assert.equal(w.state(), "HELD", "the proof stays ready for the next tap");
  assert.ok(!w.log.includes("send") && !w.log.some((x) => x.startsWith("take")));
});

test("a venue the two RPCs disagree on is refused: nothing taken or sent", async () => {
  for (const venueOff of ["reserves", "creator"] as const) {
    const w = await world({ venueOff });
    // either change leaves the quote with no answer both providers agree on (the kit's readSolanaReference)
    assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "quote_check_failed" }, venueOff);
    assert.equal(w.state(), "HELD");
    assert.ok(!w.log.includes("send") && !w.log.some((x) => x.startsWith("take")), "nothing taken or sent");
  }
});

test("a proof for another root is refused: a root on no page, or on one RPC's page only", async () => {
  for (const [plant, proof] of [[{}, readyProof({ stateRoot: 4242n })], [{ rootOnOne: true }, readyProof()]] as const) {
    const w = await world(plant, proof);
    assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "failed" });
    assert.equal(w.state(), "HELD");
    assert.ok(!w.log.includes("send") && !w.log.some((x) => x.startsWith("take")));
  }
});

test("a helper answer whose tx does not read back, or reads back as another tx, never marks the note spent", async () => {
  for (const readBack of ["none", "other"] as const) {
    const w = await world({ readBack });
    const a = await runPoolBuy(w.host, ASK);
    assert.equal("stage" in a && a.stage, "not_landed", JSON.stringify(a));
    assert.equal(w.state(), "RESERVED", "the proof left: RESERVED until the store's deadline rule");
    assert.ok(!w.log.some((x) => x.startsWith("settle")));
  }
  const w = await world({ readBack: "failed" });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "refused", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal(w.state(), "RESERVED");
  assert.ok(!w.log.some((x) => x.startsWith("settle")));
});

test("a take that hands out another attempt is refused before anything leaves", async () => {
  const w = await world();
  const other = { ...readyProof(), attempt: "attempt-2" };
  w.host.take = async () => other;
  assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "failed" });
  assert.equal(w.sentTx(), null);
});

test("a proof another run of this page holds is never picked: a second tap at once finds none of its own", async () => {
  const w = await world();
  w.host.claimed = new Set(["note-1"]);
  assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "not_funded" });
  assert.equal(w.state(), "HELD");
});

test("the kind answers at the send with its signature, then posts filled; the run holds the seed's shared lock", async () => {
  const w = await world();
  const modes: string[] = [];
  const locks = { request: (name: string, opts: { mode: string }, f: () => Promise<void>) => (modes.push(`${name}:${opts.mode}`), f()) } as unknown as Pick<LockManager, "request">;
  const stages: string[] = [];
  let ended = 0;
  const r = poolBuyKind(() => ({ ...w.host, end: () => void ended++ }), locks)(ASK, { id: "r1", sha: "00", progress: (s: string) => void stages.push(s) } as never) as { running: true; after: Promise<void>; answer: () => unknown };
  await r.after;
  assert.deepEqual(r.answer(), { result: { stage: "sent", txs: [{ chain: "solana", hash: SIG }] } });
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(stages, ["filled"]);
  assert.equal(ended, 1);
  assert.deepEqual(modes, ["ct-wallet/seed:shared"]);
  assert.equal(w.state(), "SPENT");
});
