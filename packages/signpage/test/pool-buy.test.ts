// Card signpage-pool-buy: one tap on the signing page takes a ready proof, reads the venue and the quote on two RPCs,
// builds the tag 3, checks it against the user's own ask, signs it as W, sends it through the helper and marks the
// note spent only once the transaction reads back on both RPCs (src/pool-buy.ts).
// The chain answers are the kit's recorded reads (packages/kit/test/fixtures/solana-pool-buy.json: the LiteSVM run on
// copies of mainnet's pump program and accounts, both providers' answers, the Rent sysvar as both answered it, and the
// pool fixture's real release proof); the pool's own account and pages are planted around that release. The seed is the
// published all-zero entropy vector (packages/wallet/test/vectors/a8.json).
import assert from "node:assert/strict";
import { throughApi } from "./api-ends.ts";
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
import { POOL_BLOCKHASH_LIFE_MS, POOL_BUY_SETTLE_MS, PoolSendBusy, poolBuyKind, readBack, runPoolBuy, solanaProofBytes, type PoolBuyHost } from "../src/pool-buy.ts";
import type { PoolAsk } from "../src/rules/pool.ts";
import type { TxRef } from "../../kit/src/signpage/messages.ts";
import { APP_ORIGIN, signedOutState, startApi } from "../src/api.ts";
import type { IncomingMessage } from "../src/api.ts";

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
const OTHER_SIG = base58.encode(new Uint8Array(64).fill(6)); // another device's buy of the same note

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
  /** every send the helper got, busy ones included */
  sends: Uint8Array[];
  /** each wait the run asked for */
  waits: number[];
  /** the venue's expected out for the spend and the min out the device asks (the kit's fixture setup) */
  E: bigint;
  minOut: bigint;
  /** the venue's pool address: the bonding curve's account */
  curve: string;
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
  readBack?: "ours" | "none" | "other" | "failed" | "lieOne" | "metaJunk";
  /** RPC 1's first read of the pool account is a slot behind: its state tree one leaf short */
  sizeSkewOnce?: boolean;
  /** what each call of ready() answers, in turn (the last one again after); the queue's own ready attempt is the last's */
  readies?: ReadyProof<SolanaReleaseRequest>[][];
  /** the helper's answer: an HTTP 502 (thrown) or a signature that is not one; either way it sent the transaction */
  helper?: "502" | "badSig";
  /** the helper answers this well-formed signature, not the transaction's own; it sent the transaction all the same */
  helperSig?: string;
  /** the helper answers busy (its 429, Retry-After 1 s) to this many sends first, nothing sent for them */
  busy?: number;
  /** the chain holds the transaction only from the settle of this number on (1: at once), or never */
  landsAtSettle?: number | "never";
  /** RPC p's finalized block height at its i-th read (1,000 when not given: past the blockhash's last height) */
  finalHeight?: (p: 0 | 1, i: number) => number;
  /** the token W received as each RPC's getTransaction meta says it (raw units, 6 decimals); absent: a meta with no
   *  token balances. Each meta also lists the fee payer's account of the mint and W's of another mint, never W's fill */
  received?: readonly [bigint, bigint];
  /** the token's decimals in those balances (6 when not given) */
  decimals?: number;
  /** the seed the page hands is another one: the W it derives is not the proof's recipient */
  seedOther?: boolean;
  /** another device on the same 12 words spent the note first, by its own buy (tag 3) to the same W with its own
   *  attempt's salt: the note's spent mark is on chain (the settle finds it) and this device's transaction never
   *  reaches finalized. `otherListed`: whether RPC p's W history lists that buy (both when not given) */
  otherSpent?: boolean;
  otherListed?: (p: 0 | 1) => boolean;
  /** RPC p's first this-many read-back reads (getTransaction at confirmed) answer this very transaction with an
   *  unreadable meta, then as `readBack` says */
  metaJunkReads?: number;
};

/** The keys a v0 transaction's lookups load, as getTransaction's meta gives them (loadedAddresses): every lookup's
 *  writable indexes, then its readonly ones, read from the table's addresses. */
function loadedOf(tx: Uint8Array, addresses: readonly string[]): { writable: string[]; readonly: string[] } {
  const m = solanaDecodeMessage(tx.subarray(1 + 64 * tx[0]!));
  return { writable: m.lookups.flatMap((l) => l.writable.map((i) => addresses[i]!)), readonly: m.lookups.flatMap((l) => l.readonly.map((i) => addresses[i]!)) };
}
/** Another device's buy of the same note to the same W: this device's transaction with another salt (so another
 *  attempt's context) under its own signature. */
function otherBuyOf(sent: Uint8Array): Uint8Array {
  const tx = sent.slice();
  const body = tx.subarray(1 + 64 * tx[0]!);
  const data = solanaDecodeMessage(body).instructions.at(-1)!.data;
  let at = -1;
  for (let i = 0; i + data.length <= body.length && at < 0; i++) if (data.every((x, k) => body[i + k] === x)) at = i;
  assert.ok(at >= 0 && data[0] === 3 && data[1] === 1, "the tag 3, compressed");
  // the salt: the last 16 of the release's 130 field bytes, after tag, flags and the 128-byte proof
  body[at + 2 + 128 + 114] ^= 0xff;
  tx.set(base58.decode(OTHER_SIG), 1);
  return tx;
}

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
  const txReads = [0, 0];
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
      const finalized = (params[1] as { commitment?: string } | undefined)?.commitment === "finalized";
      // the own-spend reads at finalized (pool-withdraw.ts spendOwner) are logged apart from the read-back's
      log.push(method === "getTransaction" && finalized ? `${p}:getTransaction:finalized` : `${p}:${method}`);
      if (method === "getSlot") return 500;
      // the chain at finalized: this device's buy once the settle found its spend, or another device's buy
      const ours = st === "SPENT" && !plant.otherSpent && sent !== null;
      const listed = plant.otherSpent && sent !== null && (plant.otherListed?.(p) ?? true);
      if (method === "getSignaturesForAddress") {
        assert.equal(params[0], W.address, "W's history only");
        if ((params[1] as { before?: string }).before !== undefined) return [];
        return [...(listed ? [OTHER_SIG] : []), ...(ours ? [SIG] : [])].map((signature) => ({ signature, slot: 400, err: null }));
      }
      if (method === "getTransaction" && finalized) {
        const at = (tx: Uint8Array) => ({ transaction: [base64.encode(tx), "base64"], meta: { err: null, loadedAddresses: loadedOf(tx, s.addresses) } });
        if (params[0] === OTHER_SIG) return plant.otherSpent && sent !== null ? at(otherBuyOf(sent)) : null;
        if (params[0] !== SIG || !ours) return null;
        const tx = sent!.slice();
        tx.set(base58.decode(SIG), 1);
        return at(tx);
      }
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
        const how = txReads[p]!++ < (plant.metaJunkReads ?? 0) ? "metaJunk" : plant.readBack ?? "ours";
        if (how === "none" || sent === null) return null;
        const tx = sent.slice();
        tx.set(base58.decode(SIG), 1);
        if (how === "other" || (how === "lieOne" && p === 1)) tx[tx.length - 1]! ^= 1;
        if (how === "metaJunk") return { transaction: [base64.encode(tx), "base64"], meta: "x" };
        const err = how === "failed" ? { InstructionError: [2, { Custom: 6 }] } : null;
        if (!plant.received) return { transaction: [base64.encode(tx), "base64"], meta: { err } };
        const dp = plant.decimals ?? 6;
        const bal = (owner: string, mint: string, amount: bigint) => ({ accountIndex: 3, mint, owner, programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", uiTokenAmount: { amount: amount.toString(), decimals: dp, uiAmount: Number(amount) / 10 ** dp, uiAmountString: String(Number(amount) / 10 ** dp) } });
        const other = base58.encode(new Uint8Array(32).fill(3));
        return {
          transaction: [base64.encode(tx), "base64"],
          meta: {
            err,
            preTokenBalances: [bal(FEE_PAYER, fx.pump.mint, 10n), bal(W.address, other, 5n)],
            postTokenBalances: [bal(FEE_PAYER, fx.pump.mint, 999_999_999n), bal(W.address, other, 99n), bal(W.address, fx.pump.mint, plant.received[p])],
          },
        };
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
    seed64: async () => (log.push("seed"), plant.seedOther ? wordsToSeed64(entropyToWords(new Uint8Array(16).fill(1))) : SEED64.slice()),
    send: async (pool, tx) => {
      log.push("send");
      assert.equal(pool, POOL);
      assert.equal(st, "RESERVED", "the note is RESERVED before the transaction leaves");
      sends.push(tx.slice());
      if (sends.length <= (plant.busy ?? 0)) throw new PoolSendBusy("rate_limited", 1_000);
      sent = tx.slice();
      if (plant.helper === "502") throw new Error("pool send: HTTP 502");
      return { signature: plant.helper === "badSig" ? "not-a-signature" : plant.helperSig ?? SIG };
    },
    // the wallet's solanaSettleSpent: spent only when the chain holds the transaction (its mark and change)
    settle: async (id) => {
      log.push(`settle:${id}`);
      const how = plant.readBack ?? "ours";
      settles++;
      // another device's spend: the note's spent mark is on chain, so the settle writes the change and the note SPENT
      if (plant.otherSpent && sent !== null) {
        st = "SPENT";
        return { kind: "spent" };
      }
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
  return { host, log, state: () => st, sentTx: () => sent, sends, waits, E: s.E, minOut: s.minOut, curve: (s.venue as { curve: string }).curve };
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
    // named by the spend's own signature, read in W's history on both RPCs (card signpage-buy-own-spend, INFO-1)
    assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] }, helper);
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
  // a read-back that never shows the helper's signature: the same rule, and the signature never named (card
  // signpage-sent-read-back: the helper's word alone is no transaction of the user's)
  const n = await world({ readBack: "none", finalHeight: () => 50 });
  assert.deepEqual(await runPoolBuy(n.host, ASK), { stage: "sent", txs: [] });
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

test("the kind answers sent with its signature once it read back on both RPCs as this transaction, then posts filled; the run holds the seed's shared lock", async () => {
  const w = await world();
  const modes: string[] = [];
  const locks = { request: (name: string, opts: { mode: string }, f: () => Promise<void>) => (modes.push(`${name}:${opts.mode}`), f()) } as unknown as Pick<LockManager, "request">;
  const stages: string[] = [];
  let ended = 0;
  const r = poolBuyKind(() => ({ ...w.host, end: () => void ended++ }), locks)(ASK, { id: "r1", sha: "00", progress: (s: string) => void stages.push(s) } as never) as { running: true; after: Promise<void>; answer: () => unknown };
  await r.after;
  assert.deepEqual(r.answer(), { result: { stage: "sent", txs: [{ chain: "solana", hash: SIG }] } });
  assert.ok(w.log.includes("0:getTransaction") && w.log.includes("1:getTransaction"), "answered only after the read-back on both RPCs");
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

// the review of 54b2f65 (finding 1): one RPC down or stuck never keeps a busy send going, nor the read-back, for minutes
test("busy every time, RPC 1 down and RPC 0 past the blockhash: no send again once either RPC reads it past", async () => {
  const w = await world({ busy: 1_000_000, landsAtSettle: "never", finalHeight: (p) => { if (p === 1) throw new Error("RPC 1 down"); return 1_000; } });
  const a = await runPoolBuy(w.host, ASK);
  assert.equal(w.sends.length, 1, `sent ${w.sends.length} times`);
  assert.deepEqual(a, { stage: "sent", txs: [] }, "never not_landed on one RPC's word");
  assert.equal(w.state(), "RESERVED");
});

test("busy every time, RPC 1 stuck below the blockhash and RPC 0 past it: no send again", async () => {
  const w = await world({ busy: 1_000_000, landsAtSettle: "never", finalHeight: (p) => (p === 1 ? 50 : 1_000) });
  const a = await runPoolBuy(w.host, ASK);
  assert.equal(w.sends.length, 1, `sent ${w.sends.length} times`);
  assert.deepEqual(a, { stage: "sent", txs: [] });
});

test("busy every time and both RPCs stuck below the blockhash: the sends stop at its life on the wall clock, the read-back at POOL_BUY_SETTLE_MS", async () => {
  const w = await world({ busy: 1_000_000, landsAtSettle: "never", finalHeight: () => 50 });
  // the page's clock moves with each wait the run asks for
  w.host.now = () => BigInt(1_000 + w.waits.reduce((s, x) => s + x, 0));
  const a = await runPoolBuy({ ...w.host, reads: 1_000 }, ASK);
  const waited = w.waits.reduce((s, x) => s + x, 0);
  assert.deepEqual(a, { stage: "sent", txs: [] });
  assert.ok(w.sends.length <= POOL_BLOCKHASH_LIFE_MS / 1_000 + 1, `sent ${w.sends.length} times`);
  assert.ok(waited <= POOL_BUY_SETTLE_MS + 1_000, `waited ${waited} ms`);
});

test("a pool.buy over one proof's funds (an app's planted price asking ten times the units) is refused not_funded: nothing taken, signed or sent (card signpage-pool-price)", async () => {
  // the box's USD at a price one tenth of the page's own read asks ten times the units; pool.buy carries only its amount
  // in the pool asset's units, and the page spends it only from a ready proof whose chunk funds it after the fee, tip and
  // W's accounts (solanaPoolBuyFunds): an amount over one proof's funds is refused, whatever USD the app showed
  const lie = { ...ASK, amount: BigInt(r.withdrawn) };
  for (const amount of [lie.amount, SPEND * 10n > lie.amount ? SPEND * 10n : lie.amount + 1n]) {
    const w = await world();
    assert.deepEqual(await runPoolBuy(w.host, { ...ASK, amount }), { error: "not_funded" }, `amount ${amount}`);
    assert.equal(w.state(), "HELD", "the proof stays ready");
    assert.ok(!w.log.includes("send") && !w.log.includes("seed") && !w.log.some((x) => x.startsWith("take")));
  }
});

// Card signpage-buy-route-events: the buy strip draws a real buy's one-time wallet, venue, pool and filled amount from
// the page's own route events (messages.ts BuyRoute), each once, in order, under the buy's id; the stage events keep
// their exact shape, so an app of an earlier kit (exact keys) drops the route events and still reads every stage.
const LOCKS = { request: (_n: string, _o: unknown, f: () => Promise<void>) => f() } as unknown as Pick<LockManager, "request">;
// a raw amount of 6 decimals as whole units, worked out here apart from the page's own formatting
const whole6 = (x: bigint): string => {
  const f = (x % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return f ? `${x / 1_000_000n}.${f}` : `${x / 1_000_000n}`;
};

test("a fixture buy posts its route under its id, each once and in order: W, the venue and its pool, the amount W received on both RPCs; queued in order with the stage events, it may follow the answer", async () => {
  const w0 = await world();
  const w = await world({ received: [w0.E, w0.E] });
  const posted: unknown[] = [];
  let listener: ((e: IncomingMessage) => void) | null = null;
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  const api = startApi({
    parent,
    listen: (fn) => (listener = fn),
    state: () => signedOutState(),
    kinds: { "pool.buy": (_params, ctx) => poolBuyKind(() => w.host, LOCKS)(ASK, ctx) },
  });
  const id = crypto.randomUUID();
  listener!({ origin: APP_ORIGIN, source: parent, data: { v: 1, id, type: "pool.buy", chain: "solana", token: fx.pump.mint, amount: "0.005", slippage_bps: 300 } });
  const end = Date.now() + 2_000;
  while (!posted.some((m) => (m as { stage?: string }).stage === "filled")) {
    if (Date.now() > end) assert.fail(`no filled: ${JSON.stringify(posted)}`);
    await new Promise((ok) => setTimeout(ok, 1));
  }
  await api.idle();
  const mine = posted.filter((m) => (m as { id?: string }).id === id);
  const route = mine.filter((m) => (m as { type?: string }).type === "progress" && !("stage" in (m as object)));
  assert.deepEqual(route, [
    { v: 1, type: "progress", id, wallet: W.address },
    { v: 1, type: "progress", id, venue: "pump-curve", pool: w.curve },
    // card pool-buy-send-fast: the transaction, once both RPCs read it back, posted whenever it comes (an answer past the
    // kit client's 10 s is dropped, this event is not)
    { v: 1, type: "progress", id, tx: SIG },
    { v: 1, type: "progress", id, out: whole6(w.E) },
  ]);
  assert.ok(w.E >= w.minOut);
  // the answer and the stage events as before: exact keys, no route field on any of them
  const stages = mine.filter((m) => !(route as unknown[]).includes(m));
  assert.deepEqual(stages, [
    { v: 1, id, ok: true, result: { stage: "sent", txs: [{ chain: "solana", hash: SIG }] } },
    { v: 1, type: "progress", id, stage: "filled" },
  ]);
  // queued in order with the id's stage events: the amount before the filled event (the answer, posted on its own, may
  // come before or after the route events)
  const out = posted.indexOf(route[3]);
  assert.ok(posted.indexOf(route[0]) < posted.indexOf(route[1]) && posted.indexOf(route[1]) < posted.indexOf(route[2]) && posted.indexOf(route[2]) < out);
  assert.ok(out < posted.indexOf(stages[1]), "the amount before filled");
  // nothing posted carries more than an address, a venue name or an amount
  assert.ok(!JSON.stringify(posted).includes(Buffer.from(SEED64).toString("hex")));
});

test("the amount W received is not told when the two RPCs differ on it or it is under the min out; W and the venue still are", async () => {
  const base = await world();
  for (const received of [[base.E, base.E - 1n], [base.minOut - 1n, base.minOut - 1n]] as const) {
    const w = await world({ received });
    const told: unknown[] = [];
    const a = await runPoolBuy({ ...w.host, route: (x) => void told.push(x) }, ASK);
    assert.deepEqual(a, { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
    assert.deepEqual(told, [{ wallet: W.address }, { venue: "pump-curve", pool: w.curve }, { tx: SIG }], String(received));
  }
  // a meta with no token balances: no amount
  const w = await world();
  const told: unknown[] = [];
  await runPoolBuy({ ...w.host, route: (x) => void told.push(x) }, ASK);
  assert.deepEqual(told, [{ wallet: W.address }, { venue: "pump-curve", pool: w.curve }, { tx: SIG }]);
});

test("a buy refused before its check passes tells no route; a route listener that throws never stops a buy", async () => {
  const w = await world({ venueOff: "reserves" });
  const told: unknown[] = [];
  const a = await runPoolBuy({ ...w.host, route: (x) => void told.push(x) }, ASK);
  assert.ok("error" in a);
  assert.deepEqual(told, []);
  assert.equal(w.state(), "HELD");
  const ok = await world({ received: [w.E, w.E] });
  const b = await runPoolBuy({ ...ok.host, route: () => { throw new Error("app display"); } }, ASK);
  assert.deepEqual(b, { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal(ok.state(), "SPENT");
});

// Card signpage-buy-route-events, fold 1: nothing is told until the check passed, W is the proof's recipient and the take
// holds the note (M1, L1); an amount past the kit's bound is never told (L3); an unreadable meta proves nothing and the
// answer keeps the transaction's ref (L4).
const tellRun = async (plant: Plant, over: Partial<PoolBuyHost> = {}) => {
  const w = await world(plant);
  const told: unknown[] = [];
  const a = await runPoolBuy({ ...w.host, ...over, route: (x) => void told.push(x) }, ASK);
  return { w, a, told };
};

test("fold 1 (M1): a buy the check refuses inside checkSolanaBuy (a quote 100 slots old) tells nothing, the seed never read", async () => {
  const { w, a, told } = await tellRun({ slotAhead: 100 });
  assert.deepEqual(a, { error: "quote_check_failed" });
  assert.ok(w.log.includes("0:getLatestBlockhash"), "the run reached the check");
  assert.ok(!w.log.includes("seed"));
  assert.deepEqual(told, []);
});

test("fold 1 (M1): a seed whose W is not the proof's recipient tells nothing: nothing taken or sent", async () => {
  const { w, a, told } = await tellRun({ seedOther: true });
  assert.deepEqual(a, { error: "failed" });
  assert.ok(w.log.includes("seed"), "the run reached W's derivation");
  assert.deepEqual(told, []);
  assert.equal(w.sentTx(), null);
  assert.equal(w.state(), "HELD");
});

test("fold 1 (L1): a take the queue refuses tells nothing: W and the pool are told only once the take holds the note", async () => {
  const w = await world({ readies: [[readyProof()], [readyProof()], [readyProof()], [readyProof({ attempt: "attempt-2" })]] });
  const told: unknown[] = [];
  const a = await runPoolBuy({ ...w.host, ready: async () => [readyProof()], route: (x) => void told.push(x) }, ASK);
  assert.deepEqual(a, { error: "failed" });
  assert.ok(w.log.includes("take:note-1"));
  assert.equal(w.sentTx(), null);
  assert.deepEqual(told, []);
  // a take that holds it: told after the take, before the send
  const ok = await world({ received: [w.E, w.E] });
  const order: string[] = [];
  const log = ok.log;
  await runPoolBuy({ ...ok.host, route: (x) => void order.push(`${Object.keys(x)[0]}@${log.filter((l) => l === "take:note-1" || l === "send").join(",")}`) }, ASK);
  assert.deepEqual(order, ["wallet@take:note-1", "venue@take:note-1", "tx@take:note-1,send", "out@take:note-1,send"]);
});

test("fold 1 (L3): an amount past the kit's bound (a token of 80 decimals) is never told; W and the venue still are", async () => {
  const base = await world();
  const { a, told } = await tellRun({ received: [base.E, base.E], decimals: 80 });
  assert.equal("stage" in a && a.stage, "filled");
  assert.deepEqual(told, [{ wallet: W.address }, { venue: "pump-curve", pool: base.curve }, { tx: SIG }]);
});

test("fold 1 (L4): this very transaction with an unreadable meta on both RPCs proves nothing: the answer keeps its ref", async () => {
  const { a, told } = await tellRun({ readBack: "metaJunk", landsAtSettle: "never" });
  assert.deepEqual(a, { stage: "not_landed", txs: [{ chain: "solana", hash: SIG }] });
  assert.ok(!told.some((x) => Object.hasOwn(x as object, "out")));
});

test("fold 1 (L4): readBack (pool-sell.ts reads its transaction here too): a meta that says nothing is none, never failed or other", async () => {
  const signed = new Uint8Array(200).fill(7);
  signed[0] = 1;
  const tx = signed.slice();
  tx.set(base58.decode(SIG), 1);
  const at = (meta: unknown): SolanaRpc => (async () => ({ transaction: [base64.encode(tx), "base64"], meta })) as SolanaRpc;
  for (const meta of ["x", 1, true, [], {}, { err: undefined }, null, undefined]) assert.equal(await readBack(at(meta), SIG, signed), "none", JSON.stringify(meta));
  assert.equal(await readBack(at({ err: null }), SIG, signed), "ok");
  assert.equal(await readBack(at({ err: { InstructionError: [2, { Custom: 6 }] } }), SIG, signed), "failed");
  assert.equal(await readBack(at({ err: "AccountInUse" }), SIG, signed), "failed");
});

test("fold 1 (L3): the page's poster names each field from the route's own keys and posts only what the kit's client takes", async () => {
  const posted: unknown[] = [];
  let listener: ((e: IncomingMessage) => void) | null = null;
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  let ctx: { route?: (r: unknown) => void } | null = null;
  const api = startApi({
    parent,
    listen: (fn) => (listener = fn),
    state: () => signedOutState(),
    kinds: { "pool.buy": (_p, c) => ((ctx = c as never), { running: true, after: new Promise<void>(() => {}), answer: () => ({ error: "failed" }) }) },
  });
  const id = crypto.randomUUID();
  listener!({ origin: APP_ORIGIN, source: parent, data: { v: 1, id, type: "pool.buy", chain: "solana", token: fx.pump.mint, amount: "0.005", slippage_bps: 300 } });
  await api.idle();
  const route = ctx!.route!;
  route({ wallet: W.address, secretKey: "deadbeef", seed: "00" }); // extra keys: only W is posted
  route(Object.create({ venue: "pumpswap", pool: W.address })); // inherited: nothing
  route({ out: "1", v: 9, id: "other-id", type: "state" }); // its own id and type win
  route({ wallet: "W1" }); // not an address: not posted
  route({ out: `0.${"0".repeat(79)}1` }); // past the kit's bound: not posted
  await api.idle();
  assert.deepEqual(posted.filter((m) => (m as { type?: string }).type === "progress"), [
    { v: 1, type: "progress", id, wallet: W.address },
    { v: 1, type: "progress", id, out: "1" },
  ]);
});

// Card signpage-buy-own-spend: a second device on the same 12 words spends the same note to the same W from its own note
// store, so the spent mark the settle reads never says the tokens are this buy's. Each path that answered filled on
// the settle's word alone answers not_landed on another's spend, and the settle still writes the change (SPENT).
// Each: the plant, the answer's txs (the helper's signature only once both RPCs read this very transaction under it), and
// whether whose spend it is must be read (this very transaction failed on both RPCs: a spend the settle finds is
// another's, so not_landed with no owner read, fold 1 of the review, LOW-1).
const SECOND_DEVICE: readonly [string, Plant, TxRef[], boolean][] = [
  ["the helper's 502 (no signature)", { helper: "502" }, [], true],
  ["a signature that is not one", { helper: "badSig" }, [], true],
  ["the helper's signature never read back", { readBack: "none" }, [], true],
  // the real helper's path (one send per nullifier: it answers the first send's signature, another device's)
  ["the helper's signature read as another transaction on both RPCs", { readBack: "other" }, [], true],
  ["the helper's signature read as another transaction on one RPC", { readBack: "lieOne" }, [], true],
  ["this transaction failed on both RPCs", { readBack: "failed" }, [{ chain: "solana", hash: SIG }], false],
  ["this transaction read back ok at confirmed, never finalized (the settle loop)", {}, [{ chain: "solana", hash: SIG }], true],
];
for (const [name, plant, txs, ownerRead] of SECOND_DEVICE) {
  test(`another device's buy spent the note first, ${name}: not_landed, the change still settled`, async () => {
    // the blockhash never past on either RPC: only whose spend it is decides
    const w = await world({ ...plant, otherSpent: true, finalHeight: () => 50 });
    assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "not_landed", txs });
    assert.equal(w.state(), "SPENT", "the settle wrote the change from the spent mark");
    if (ownerRead) assert.ok(w.log.includes("0:getTransaction:finalized") && w.log.includes("1:getTransaction:finalized"), "whose spend, read on both RPCs");
  });
  test(`another device's buy listed on one RPC only, ${name}: ${ownerRead ? "not known, never filled" : "not_landed"}`, async () => {
    const w = await world({ ...plant, otherSpent: true, otherListed: (p) => p === 0, finalHeight: () => 50 });
    assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: ownerRead ? "sent" : "not_landed", txs });
    assert.equal(w.state(), "SPENT");
  });
}

test("the helper answers a well-formed signature that is not this transaction's, and this one lands: filled names this one's", async () => {
  const w = await world({ helperSig: base58.encode(new Uint8Array(64).fill(8)), finalHeight: () => 50 });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal(w.state(), "SPENT");
});

// Card signpage-sent-read-back: the helper's signature is a name to read back, never a fact. The sent hook (the kind's
// early answer) and every answer's txs name it only once both RPCs read this very transaction's bytes under it.
const NOT_OURS = base58.encode(new Uint8Array(64).fill(8));
const SENT_HOOK: readonly [string, Plant, string, TxRef[]][] = [
  ["a well-formed signature that is not this transaction's, this one landing", { helperSig: NOT_OURS }, "filled", [{ chain: "solana", hash: SIG }]],
  ["a well-formed signature that is not this transaction's, this one never landing", { helperSig: NOT_OURS, landsAtSettle: "never", finalHeight: () => 50 }, "sent", []],
  ["its signature never read back", { readBack: "none", finalHeight: () => 50 }, "sent", []],
  ["its signature read as another transaction on both RPCs", { readBack: "other", finalHeight: () => 50 }, "sent", []],
  ["its signature read as another transaction on one RPC", { readBack: "lieOne" }, "filled", [{ chain: "solana", hash: SIG }]],
];
for (const [name, plant, stage, txs] of SENT_HOOK) {
  test(`the helper answers ${name}: no sent hook, and the answer's txs only what both RPCs read as this transaction`, async () => {
    const w = await world(plant);
    const told: string[] = [];
    const routes: unknown[] = [];
    const a = await runPoolBuy({ ...w.host, sent: (s) => void told.push(s), route: (x) => void routes.push(x) }, ASK);
    assert.deepEqual(a, { stage, txs });
    assert.deepEqual(told, [], "no sent hook before both RPCs read this very transaction");
    // card pool-buy-send-fast: the route's tx is only what both RPCs read as this attempt's, never the helper's word: a
    // filled answer names the spend's own signature as the route's tx too (review M-1: the answer comes past the
    // client's 10 s and is dropped), once; a sent one names none
    const tx = routes.filter((x) => Object.hasOwn(x as object, "tx"));
    assert.deepEqual(tx, stage === "filled" ? [{ tx: SIG }] : [], JSON.stringify(routes));
  });
}

test("card pool-buy-send-fast (review M-1): the helper's 502, this very buy found in W's history on both RPCs: filled, and the route's tx is the spend's own signature, told once", async () => {
  const w = await world({ helper: "502", finalHeight: () => 50 });
  const told: string[] = [];
  const routes: unknown[] = [];
  const a = await runPoolBuy({ ...w.host, sent: (s) => void told.push(s), route: (x) => void routes.push(x) }, ASK);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.deepEqual(told, [], "no early sent: the helper named nothing");
  assert.deepEqual(routes.filter((x) => Object.hasOwn(x as object, "tx")), [{ tx: SIG }]);
});

test("card pool-buy-send-fast (review M-1): another device's spend is never told as this buy's tx", async () => {
  for (const plant of [{ helper: "502" }, { readBack: "other" }] as const) {
    const w = await world({ ...plant, otherSpent: true, finalHeight: () => 50 });
    const routes: unknown[] = [];
    assert.deepEqual(await runPoolBuy({ ...w.host, route: (x) => void routes.push(x) }, ASK), { stage: "not_landed", txs: [] });
    assert.ok(!routes.some((x) => Object.hasOwn(x as object, "tx")), JSON.stringify(routes));
  }
});

test("card pool-buy-send-fast: the route's tx is this very transaction's signature, told once, at the sent hook, before the amount", async () => {
  const w = await world({ received: [0n, 0n] });
  const order: string[] = [];
  await runPoolBuy({ ...w.host, sent: (s) => void order.push(`sent:${s}`), route: (x) => void order.push(JSON.stringify(x)) }, ASK);
  const i = order.indexOf(JSON.stringify({ tx: SIG }));
  assert.ok(i > 0 && order[i + 1] === `sent:${SIG}`, order.join(" | "));
  assert.equal(order.filter((x) => x.includes('"tx"')).length, 1);
});

test("the sent hook fires once, after both RPCs read this very transaction under the signature", async () => {
  const w = await world();
  const at: string[][] = [];
  const a = await runPoolBuy({ ...w.host, sent: (s) => void at.push([s, ...w.log]) }, ASK);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal(at.length, 1);
  assert.equal(at[0]![0], SIG);
  assert.ok(at[0]!.includes("0:getTransaction") && at[0]!.includes("1:getTransaction"), "told only after the read-back on both RPCs");
});

test("the sent hook fires once: both RPCs read this very transaction with an unreadable meta for two rounds, then ok", async () => {
  const w = await world({ metaJunkReads: 2 });
  const told: string[] = [];
  const a = await runPoolBuy({ ...w.host, sent: (s) => void told.push(s) }, ASK);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal(w.log.filter((x) => x === "0:getTransaction").length, 3, "three read-back rounds");
  assert.deepEqual(told, [SIG], "told once, at the first round both RPCs read it as this transaction");
});

// Review fold (HIGH): the kind's answer may come only at the run's end (no read-back within the client's 10 s), which
// the kit's client has dropped by then (packages/kit/src/signpage/client.ts: a timed-out request's late answer); the
// terminal then waits on progress alone (apps/terminal/src/screens/trade/model.ts). The run's stage always goes out as
// progress too, so the button ends.
test("dropped tx: not_landed reaches progress", async () => {
  const w = await world({ readBack: "none", landsAtSettle: "never" });
  const locks = { request: (_n: string, _o: unknown, f: () => Promise<void>) => f() } as unknown as Pick<LockManager, "request">;
  const stages: string[] = [];
  const r = poolBuyKind(() => w.host, locks)(ASK, { id: "r1", sha: "00", progress: (s: string) => void stages.push(s) } as never) as { running: true; after: Promise<void>; answer: () => unknown };
  await r.after;
  assert.deepEqual(r.answer(), { result: { stage: "not_landed", txs: [] } });
  assert.deepEqual(stages, ["not_landed"], "the stage reaches the app as progress, whatever its client waited");
});

test("the kind, the helper answering a well-formed signature that is not this transaction's: the app's answer never names it", async () => {
  const w = await world({ helperSig: NOT_OURS });
  const locks = { request: (_n: string, _o: unknown, f: () => Promise<void>) => f() } as unknown as Pick<LockManager, "request">;
  const r = poolBuyKind(() => w.host, locks)(ASK, { id: "r1", sha: "00", progress: () => {} } as never) as { running: true; after: Promise<void>; answer: () => unknown };
  await r.after;
  assert.deepEqual(r.answer(), { result: { stage: "filled", txs: [{ chain: "solana", hash: SIG }] } });
});

test("this device's own buy is filled by its own signature at finalized, with no read of W's history", async () => {
  const w = await world();
  assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.ok(w.log.includes("0:getTransaction:finalized") && w.log.includes("1:getTransaction:finalized"));
  assert.ok(!w.log.some((x) => x.endsWith(":getSignaturesForAddress")), "the helper's signature read back as this attempt's");
});

test("this device's own buy with no signature from the helper is found in W's history on both RPCs: filled", async () => {
  const w = await world({ helper: "502", finalHeight: () => 50 });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] }, "named by the spend's own signature");
  assert.ok(w.log.includes("0:getSignaturesForAddress") && w.log.includes("1:getSignaturesForAddress"));
});

// Card signpage-error-after-timeout: a pool.buy refused after the client's 10 s window (its answer dropped by the kit's
// client) still ends the app's button and strip: the page posts refused as progress after the answer.
test("a pool.buy refused (not_funded) reaches the app as progress refused after its answer", async () => {
  const w = await world();
  const r = await throughApi("pool.buy", (_p, ctx) => poolBuyKind(() => w.host, LOCKS)({ ...ASK, amount: SPEND * 1_000n }, ctx), { chain: "solana", token: fx.pump.mint, amount: "5", slippage_bps: 300 });
  assert.deepEqual((r.answer as { error: unknown }).error, { code: "not_funded" });
  assert.deepEqual(r.stages, ["refused"]);
});

test("a pool.buy whose end is its answer (dropped tx: not_landed) posts that stage once as progress", async () => {
  const w = await world({ readBack: "none", landsAtSettle: "never" });
  const r = await throughApi("pool.buy", (_p, ctx) => poolBuyKind(() => w.host, LOCKS)(ASK, ctx), { chain: "solana", token: fx.pump.mint, amount: "5", slippage_bps: 300 });
  assert.deepEqual((r.answer as { result: { stage: string } }).result.stage, "not_landed");
  assert.deepEqual(r.stages, ["not_landed"]);
});
