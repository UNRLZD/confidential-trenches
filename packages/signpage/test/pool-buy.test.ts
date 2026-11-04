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
import { SOLANA_POOL_FEE_STEP, solanaPoolFee, solanaPoolPage } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaDecodeMessage } from "../../kit/src/checks/solana/message.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { VaultSnarkjsProof, VaultWithdrawSignals } from "../../kit/src/vault/shapes.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import { solanaContextOf, solanaPoolOf, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { ALT, BLOCKHASH, FEE_PAYER, POOL, PROGRAM, fx, rent, replay, setup, unhex } from "../../kit/test/solana-pool-buy-fx.ts";
import { PoolSendBusy, poolBuyKind, runPoolBuy, solanaProofBytes, type PoolBuyHost } from "../src/pool-buy.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const L = 7n;
const J = 0;
const W = freshWallet(SEED64, "sol", L, J);
W.secretKey.fill(0);
const PIN = { program: PROGRAM, feePayer: FEE_PAYER };
const { scope: SCOPE } = solanaPoolOf(PROGRAM);
const r = fx.release;
// the epoch fee the device works out from the Rent sysvar both RPCs answered (the kit's solanaPoolFee): the most a
// proof's relay fee cap may be
const FEE = solanaPoolFee(rent);
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

function readyProof(over: { stateRoot?: bigint; attempt?: string; fee?: bigint; j?: number } = {}): ReadyProof<SolanaReleaseRequest> {
  const fee = over.fee ?? FEE;
  const request: SolanaReleaseRequest = { program: PROGRAM, pool: POOL, recipient: W.address, feePayer: FEE_PAYER, relayFee: fee, relayFeeCap: fee, tipCap: BigInt(fx.tip_cap), deadlineMs: BigInt(fx.deadline_ms), salt: r.salt };
  const context = solanaContextOf(request, SCOPE);
  const signals: VaultWithdrawSignals = [beHex(unhex(r.new_commitment)), beHex(unhex(r.nullifier_hash)), String(r.withdrawn), String(over.stateRoot ?? STATE_ROOT), String(r.state_depth), String(LABEL_ROOT), String(r.label_depth), context.toString()];
  return {
    noteId: "note-1", attempt: over.attempt ?? "attempt-1", poolId: "sol", wallet: { chain: "sol", l: L, j: over.j ?? J, path: W.path, address: W.address },
    chunk: BigInt(r.withdrawn), epochStartMs: 0n, deadlineMs: BigInt(fx.deadline_ms), root: "epoch",
    binding: { context, feeCap: fee, request }, proof: PROOF, publicSignals: signals,
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
  /** getTransaction's answer for the helper's signature; "lieOne": the chain holds it, RPC 1 answers another tx */
  readBack?: "ours" | "none" | "other" | "failed" | "lieOne";
  /** RPC 1's first read of the pool account is a slot behind: its state tree one leaf short */
  sizeSkewOnce?: boolean;
  /** what each call of ready() answers, in turn (the last one again after); the queue's own ready attempt is the last's */
  readies?: ReadyProof<SolanaReleaseRequest>[][];
  /** the helper's answer: an HTTP 502 (thrown) or a signature that is not one; either way it sent the transaction */
  helper?: "502" | "badSig";
  /** the helper answers busy (its 429, Retry-After 1 s) to this many sends first, nothing sent for them */
  busy?: number;
  /** the chain holds the transaction only from the settle of this number on (1: at once), or never */
  landsAtSettle?: number | "never";
  /** RPC p's finalized block height at its i-th read (1,000 when not given: past the blockhash's last height) */
  finalHeight?: (p: 0 | 1, i: number) => number;
};

async function world(plant: Plant = {}, proof = readyProof()): Promise<World> {
  const s = await setup("pump", SPEND);
  const log: string[] = [];
  let st = "HELD";
  let sent: Uint8Array | null = null;
  const sends: Uint8Array[] = [];
  const waits: number[] = [];
  const readies = plant.readies ?? [[proof]];
  let readyCalls = 0;
  // the queue's ready proof for the note now: the last list's (a remake swaps it in place, the note HELD)
  const current = readies.at(-1)![0] ?? proof;
  let skewed = false;
  let settles = 0;
  const heightReads = [0, 0];
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
        if (plant.sizeSkewOnce && p === 1 && params[0] === POOL && !skewed) {
          skewed = true;
          const d = poolAccount();
          new DataView(d.buffer).setBigUint64(49, BigInt(SIZE - 1), true);
          return { context: { slot: s.ref.slot! + 1 }, value: { owner: PROGRAM, lamports: 1, data: [base64.encode(d), "base64"] } };
        }
        return { context: { slot: s.ref.slot! + 2 }, value: a ? { owner: a.owner, lamports: 1, data: [base64.encode(a.data), "base64"] } : null };
      }
      if (method === "getLatestBlockhash") return { context: { slot: s.ref.slot! + (plant.slotAhead ?? 2) }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } };
      if (method === "isBlockhashValid") return { value: true };
      if (method === "getBlockHeight") {
        // confirmed: RPC 1's height beside the blockhash, so the last height is max(100, 0 + 151) = 151
        if ((params[0] as { commitment: string }).commitment === "confirmed") return 0;
        return plant.finalHeight?.(p, heightReads[p]!++) ?? 1_000;
      }
      if (method === "getTransaction") {
        const how = plant.readBack ?? "ours";
        if (how === "none" || sent === null) return null;
        const tx = sent.slice();
        tx.set(base58.decode(SIG), 1);
        if (how === "other" || (how === "lieOne" && p === 1)) tx[tx.length - 1]! ^= 1;
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
    ready: async () => (st === "HELD" ? readies[Math.min(readyCalls++, readies.length - 1)]! : []),
    // the queue's take (../../wallet/src/pool/queue.ts): with an attempt, refused inside the note's turn, before any
    // write, unless it is the note's ready one; without one (012b565's call), the ready one is taken, whatever it is
    take: async (id: string, attempt?: string) => {
      log.push(`take:${id}`);
      assert.equal(st, "HELD");
      if (attempt !== undefined && attempt !== current.attempt) throw new Error(`note ${id}'s ready proof is another attempt`);
      st = "RESERVED";
      return current;
    },
    seed64: async () => (log.push("seed"), SEED64.slice()),
    send: async (pool, tx) => {
      log.push("send");
      assert.equal(pool, POOL);
      assert.equal(st, "RESERVED", "the note is RESERVED before the transaction leaves");
      sends.push(tx.slice());
      if (sends.length <= (plant.busy ?? 0)) throw new PoolSendBusy("rate_limited", 1_000);
      sent = tx.slice();
      if (plant.helper === "502") throw new Error("pool send: HTTP 502");
      return { signature: plant.helper === "badSig" ? "not-a-signature" : SIG };
    },
    // the wallet's solanaSettleSpent: spent only when the chain holds the transaction (its mark and change)
    settle: async (id) => {
      log.push(`settle:${id}`);
      const how = plant.readBack ?? "ours";
      settles++;
      const lands = plant.landsAtSettle ?? 1;
      if (sent === null || (how !== "ours" && how !== "lieOne") || lands === "never" || settles < lands) return { kind: "unspent" };
      st = "SPENT";
      return { kind: "spent" };
    },
    now: () => 1_000n,
    reads: 3,
    wait: async (ms: number) => void waits.push(ms),
    pick: () => 2,
  };
  return { host, log, state: () => st, sentTx: () => sent, sends, waits };
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

test("a helper answer whose tx does not read back, or reads back as another tx, never marks the note spent: the settle is tried first", async () => {
  for (const readBack of ["none", "other"] as const) {
    const w = await world({ readBack });
    const a = await runPoolBuy(w.host, ASK);
    assert.equal("stage" in a && a.stage, "not_landed", JSON.stringify(a));
    assert.equal(w.state(), "RESERVED", "the proof left: RESERVED until the state reads' pass settles or frees it");
    assert.ok(w.log.includes("settle:note-1"), "the chain's word asked before not_landed");
  }
  const w = await world({ readBack: "failed" });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "refused", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal(w.state(), "RESERVED");
});

test("fold 2 (1): the helper's 502 or a signature that is not one, the transaction landing later: never not_landed, filled and SPENT", async () => {
  for (const helper of ["502", "badSig"] as const) {
    // the chain shows the spend from the third settle; the height is never past the blockhash's last
    const w = await world({ helper, landsAtSettle: 3, finalHeight: () => 50 });
    assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "filled", txs: [] }, helper);
    assert.equal(w.state(), "SPENT", helper);
  }
});

test("fold 2 (1): a transaction that never lands is not_landed only once both RPCs' finalized height is past its blockhash's last", async () => {
  // RPC 0 past from its first read, RPC 1 only from its third: two rounds go on, the third answers not_landed
  const w = await world({ helper: "502", landsAtSettle: "never", finalHeight: (p, i) => (p === 0 || i >= 2 ? 1_000 : 50) });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "not_landed", txs: [] });
  assert.equal(w.log.filter((x) => x === "settle:note-1").length, 3);
  assert.equal(w.state(), "RESERVED", "the state reads' pass frees it past its deadline");
  // the last height is the higher of RPC 0's word (100) and RPC 1's height + 151 (151): 120 on both is not past it
  const x = await world({ helper: "502", landsAtSettle: "never", finalHeight: () => 120 });
  assert.deepEqual(await runPoolBuy(x.host, ASK), { stage: "sent", txs: [] }, "never past within the reads: sent, not not_landed");
  assert.equal(x.state(), "RESERVED");
  // a read-back that never shows the helper's signature: the same rule, with its signature shown
  const n = await world({ readBack: "none", finalHeight: () => 50 });
  assert.deepEqual(await runPoolBuy(n.host, ASK), { stage: "sent", txs: [{ chain: "solana", hash: SIG }] });
});

test("fold 1 (3): one RPC answering another tx under the helper's signature does not turn a landed buy into not_landed", async () => {
  const w = await world({ readBack: "lieOne" });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal(w.state(), "SPENT");
  assert.equal(w.log.filter((x) => x === "0:getTransaction").length, 3, "the reads went on past the one RPC's other");
});

test("fold 1 (1): a take whose attempt a remake swapped out is refused inside the queue's turn: nothing leaves, the note HELD", async () => {
  // ready() still shows attempt-1 while the queue holds attempt-2 for the note
  const w = await world({ readies: [[readyProof()], [readyProof()], [readyProof()], [readyProof({ attempt: "attempt-2" })]] });
  w.host.ready = async () => [readyProof()];
  assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "failed" });
  assert.equal(w.state(), "HELD", "never RESERVED for bytes no one sends");
  assert.ok(w.log.includes("take:note-1"));
  assert.equal(w.sentTx(), null);
});

test("fold 1 (6): the pick reads the ready proofs again after the quote: a proof remade during the reads is the one bought", async () => {
  const w = await world({ readies: [[readyProof()], [readyProof()], [readyProof({ attempt: "attempt-2" })]] });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal(w.state(), "SPENT");
  // remade onto a newer root (one the pool's pages hold at leaf 4) during the reads: its root is looked up, the reads run
  // once more, and that proof is bought with its own root index
  const p2 = readyProof({ attempt: "attempt-2", stateRoot: 1004n });
  const n = await world({ readies: [[readyProof()], [readyProof()], [p2]] });
  assert.deepEqual(await runPoolBuy(n.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal(n.state(), "SPENT");
  assert.equal(n.log.filter((x) => x === "0:getLatestBlockhash").length, 2, "the quote and slot read again for it");
  // gone during the reads (taken by another tab): none to buy with, nothing taken
  const g = await world({ readies: [[readyProof()], [readyProof()], []] });
  assert.deepEqual(await runPoolBuy(g.host, ASK), { error: "not_funded" });
  assert.ok(!g.log.some((x) => x.startsWith("take")));
});

test("fold 1 (5): a relay fee cap over the epoch fee the device works out from its own rent read is refused: nothing taken", async () => {
  const w = await world({}, readyProof({ fee: FEE + SOLANA_POOL_FEE_STEP }));
  assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "quote_check_failed" });
  assert.equal(w.state(), "HELD");
  assert.ok(!w.log.some((x) => x.startsWith("take")) && !w.log.includes("send"));
  // at the epoch fee: bought
  const ok = await world({}, readyProof({ fee: FEE }));
  assert.equal((await runPoolBuy(ok.host, ASK) as { stage?: string }).stage, "filled");
});

test("fold 1 (4): the device's slot read is last before signing: no RPC read between it and the take, W derived after it", async () => {
  const w = await world();
  assert.equal((await runPoolBuy(w.host, ASK) as { stage?: string }).stage, "filled");
  const bh = w.log.indexOf("0:getLatestBlockhash");
  const take = w.log.indexOf("take:note-1");
  const between = w.log.slice(bh + 1, take);
  assert.deepEqual(between.filter((x) => /^[01]:/.test(x) && x !== "1:isBlockhashValid" && x !== "1:getBlockHeight"), [], between.join(" "));
  assert.ok(w.log.indexOf("seed") > bh, "W is derived after the slot read");
  // a proof whose l, j derive another W than it names: refused before W signs, nothing taken
  const x = await world({}, readyProof({ j: 1 }));
  assert.deepEqual(await runPoolBuy(x.host, ASK), { error: "failed" });
  assert.equal(x.state(), "HELD");
  assert.ok(!x.log.some((y) => y.startsWith("take")));
});

test("fold 1 (7): two providers a slot apart on the state tree's size are read again once", async () => {
  const w = await world({ sizeSkewOnce: true });
  assert.equal((await runPoolBuy(w.host, ASK) as { stage?: string }).stage, "filled");
  assert.equal(w.state(), "SPENT");
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

// The card signpage-pool-flow-run, run 6 (12:41Z): the helper answered the send 429 rate_limited, Retry-After 1 (a
// devnet provider throttled its read), and the page answered not_landed. A busy helper is waited out: the same signed
// bytes again after its Retry-After, until the blockhash is past on both RPCs.
test("a send the helper answers busy (429) once is sent again, the same bytes after its Retry-After, and lands: filled", async () => {
  // the blockhash still lives (both RPCs' finalized height under its last, 151)
  const w = await world({ busy: 1, finalHeight: () => 50 });
  const a = await runPoolBuy(w.host, ASK);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal(w.sends.length, 2);
  assert.deepEqual(w.sends[1], w.sends[0], "the same signed bytes");
  assert.equal(w.waits[0], 1_000, "its Retry-After");
  assert.equal(w.state(), "SPENT");
});

test("a send the helper answers busy until the blockhash is past on both RPCs: not_landed, never sent past it", async () => {
  // the blockhash lives for the first three height reads on each RPC, then both are past it
  const w = await world({ busy: 1_000, landsAtSettle: "never", finalHeight: (_p, i) => (i < 3 ? 50 : 1_000) });
  const a = await runPoolBuy(w.host, ASK);
  assert.deepEqual(a, { stage: "not_landed", txs: [] });
  assert.ok(w.sends.length >= 2 && w.sends.length <= 5, `sent ${w.sends.length} times`);
  assert.equal(w.state(), "RESERVED", "the note held for the state reads' pass to free");
});

test("a send error that is not the helper's busy answer is not sent again (a 502 may have sent it): the read-back decides", async () => {
  const w = await world({ helper: "502", landsAtSettle: "never", finalHeight: () => 1_000 });
  const a = await runPoolBuy(w.host, ASK);
  assert.deepEqual(a, { stage: "not_landed", txs: [] });
  assert.equal(w.sends.length, 1);
});
