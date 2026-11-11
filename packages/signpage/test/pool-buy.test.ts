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
import { SOLANA_PUMP_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { solanaDecodeMessage } from "../../kit/src/checks/solana/message.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { VaultSnarkjsProof, VaultWithdrawSignals } from "../../kit/src/vault/shapes.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import { solanaContextOf, solanaPoolOf, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { ALT, BLOCKHASH, FEE_PAYER, POOL, PROGRAM, fx, rent, replay, setup, unhex } from "../../kit/test/solana-pool-buy-fx.ts";
import { POOL_BLOCKHASH_LIFE_MS, POOL_BUY_READS, POOL_BUY_SETTLE_MS, PoolSendBusy, poolBuyKind, readBack, runPoolBuy, solanaProofBytes, type PoolBuyHost } from "../src/pool-buy.ts";
import * as poolBuy from "../src/pool-buy.ts";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import type { PoolAsk } from "../src/rules/pool.ts";
import { SIGNPAGE_KIT_VERSION, type TxRef } from "../../kit/src/signpage/messages.ts";
import { pairDown } from "./outage.ts";
import { APP_ORIGIN, signedOutState, startApi } from "../src/api.ts";
import type { IncomingMessage } from "../src/api.ts";

/** The kit client's hello (card kit-frame-version). */
const HELLO = { v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION };

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
const poolAccount = (size = SIZE): Uint8Array => {
  const d = new Uint8Array(2179);
  d.set(new TextEncoder().encode("bfpool01"));
  const v = new DataView(d.buffer);
  v.setBigUint64(49, BigInt(size), true);
  v.setBigUint64(49 + 8 + 1 + 33 * 32, BigInt(size), true);
  return d;
};

type World = {
  host: PoolBuyHost;
  log: string[];
  /** every getMultipleAccounts read's key list, in order */
  multi: (readonly string[])[];
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
  /** the minSlots each settle was asked with, in turn (null: none) */
  settleSlots: (number[] | null)[];
};
type Plant = {
  /** our lookup table as served lacks the venue's program (a table made for another venue) */
  tableNotForVenue?: boolean;
  /** the slot of the device's blockhash read, past the quote's */
  slotAhead?: number;
  /** RPC 0's getLatestBlockhash answers in turn (the slot past the quote's, the blockhash); past the list, the last */
  blockhashReads?: readonly { slotAhead: number; blockhash: string }[];
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
  /** the host's tables by venue ({ <the coin's venue>: [the fixture's table] } when not given); OTHER_TABLE reads as the
   *  fixture's table under another address, and `extraTables` adds more (address: the table's addresses) */
  tables?: Readonly<Partial<Record<"pump-curve" | "pumpswap", readonly string[]>>>;
  extraTables?: Readonly<Record<string, (fixture: readonly string[]) => readonly string[]>>;
  /** the coin: pump's curve (the default) or a graduated PumpSwap coin, as the LiteSVM run recorded each */
  coin?: "pump" | "pumpswap";
  /** RPC 1 reads this table otherwise: no account, its last byte flipped, or owned by another program */
  tableOff?: { address: string; how: "gone" | "bytes" | "owner" | "hang" };
  /** the settle throws at its n-th call (1 first) when this says so: a lister that refuses, a 429 past the retry, a stop */
  settleThrows?: (n: number) => boolean;
  /** the finalized slot each RPC's getEpochInfo answers beside its block height (500 when not given) */
  finalSlot?: (p: 0 | 1) => number;
  /** the spend's slot: a settle not held to a slot at or past it on both RPCs answers from before it ("unspent") */
  spendSlot?: number;
  /** RPC 1's getTransaction names no slot for the buy's transaction */
  noTxSlotOn1?: boolean;
  /** RPC 1's getTransaction names this slot for the buy's transaction (TX_SLOT when not given) */
  txSlotOn1?: number;
  /** both trees this many pages past the one that holds the proof's roots (page 0): each newer page holds neither */
  pagesBack?: number;
  /** RPC 1 reads the device's blockhash as not valid */
  blockhashInvalid?: boolean;
  /** RPC 1's pool account always a leaf short on the state tree (not a slot apart: another tree) */
  sizeSkewAlways?: boolean;
  /** RPC p's finalized slot at its i-th getSlot (500 when not given; the buy's transaction lands at TX_SLOT) */
  finalizedSlot?: (p: 0 | 1, i: number) => number;
};
/** The slot the buy's transaction lands at, as getTransaction names it. */
const TX_SLOT = 400;
const OTHER_TABLE = base58.encode(new Uint8Array(32).fill(8));
/** The fixture's table address (solana-pool-buy-fx.ts setup). */
const s0 = { tableAddr: base58.encode(new Uint8Array(32).fill(9)) };

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
  // the tag 3, compressed (flag bit 0), naming the next state page when it fits (bit 1, card pool-senders-next-page)
  assert.ok(at >= 0 && data[0] === 3 && (data[1]! & 1) === 1, "the tag 3, compressed");
  // the salt: the last 16 of the release's 130 field bytes, after tag, flags and the 128-byte proof
  body[at + 2 + 128 + 114] ^= 0xff;
  tx.set(base58.decode(OTHER_SIG), 1);
  return tx;
}

async function world(plant: Plant = {}, proof = readyProof()): Promise<World> {
  const coin = plant.coin ?? "pump";
  const s = await setup(coin, SPEND);
  const log: string[] = [];
  /** Every getMultipleAccounts read's key list, in order (the reference's and the venue's). */
  const multi: (readonly string[])[] = [];
  let st = "HELD";
  let sent: Uint8Array | null = null;
  const sends: Uint8Array[] = [];
  const waits: number[] = [];
  const readies = plant.readies ?? [[proof]];
  let readyCalls = 0;
  // the queue's ready proof for the note now: the last list's (a remake swaps it in place, the note HELD)
  const current = readies.at(-1)![0] ?? proof;
  let skewed = false;
  let bhReads = 0;
  let settles = 0;
  const settleSlots: (number[] | null)[] = [];
  const heightReads = [0, 0];
  const txReads = [0, 0];
  const slotReads = [0, 0];
  const accounts = (p: 0 | 1): Record<string, { owner: string; data: Uint8Array }> => ({
    [s.tableAddr]: { owner: ALT, data: plant.tableNotForVenue ? s.tableData.filter((_, i) => i < 56 || Math.floor((i - 56) / 32) !== s.addresses.indexOf(SOLANA_PUMP_PROGRAM)) : s.tableData },
    [OTHER_TABLE]: { owner: ALT, data: s.tableData },
    ...Object.fromEntries(Object.entries(plant.extraTables ?? {}).map(([a, f]) => [a, { owner: ALT, data: Uint8Array.from([...s.tableData.subarray(0, 56), ...f(s.addresses).flatMap((k) => [...base58.decode(k)])]) }])),
    [POOL]: { owner: PROGRAM, data: poolAccount((plant.pagesBack ?? 0) * 1024 + SIZE) },
    ...Object.fromEntries(Array.from({ length: plant.pagesBack ?? 0 }, (_, k) => ([0, 1] as const).map((tree) => [solanaPoolPage(PROGRAM, tree, (k + 1) * 1024), { owner: PROGRAM, data: page(999n) }])).flat()),
    [solanaPoolPage(PROGRAM, 0, 0)]: { owner: PROGRAM, data: page(plant.rootOnOne && p === 1 ? 77n : STATE_ROOT) },
    [solanaPoolPage(PROGRAM, 1, 0)]: { owner: PROGRAM, data: page(LABEL_ROOT) },
    [fx.rent.account]: { owner: fx.rent.answers[p].owner, data: base64.decode(fx.rent.answers[p].data) },
  });
  const txSlot = (p: 0 | 1): number | undefined => (p === 1 ? (plant.noTxSlotOn1 ? undefined : plant.txSlotOn1 ?? TX_SLOT) : TX_SLOT);
  const rpc = (p: 0 | 1): SolanaRpc => {
    const venue = replay(fx[coin], p, plant.venueOff && p === 1 ? (list, ans) => {
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
      if (method === "getSlot") return plant.finalizedSlot?.(p, slotReads[p]!++) ?? 500;
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
      if (method === "getMultipleAccounts") {
        multi.push(params[0] as readonly string[]);
        return venue(method, params);
      }
      if (method === "getAccountInfo") {
        const a0 = accounts(p)[params[0] as string];
        const off = plant.tableOff && p === 1 && params[0] === plant.tableOff.address ? plant.tableOff.how : null;
        // a read that never answers: nothing (no timer either) keeps the process waiting on it
        if (off === "hang") return new Promise<never>(() => {});
        const a = !a0 || off === null ? a0 : off === "gone" ? undefined : off === "owner" ? { owner: PROGRAM, data: a0.data } : { owner: a0.owner, data: Uint8Array.from(a0.data, (x, i) => (i === a0.data.length - 1 ? x ^ 1 : x)) };
        if ((plant.sizeSkewOnce || plant.sizeSkewAlways) && p === 1 && params[0] === POOL && (!skewed || plant.sizeSkewAlways)) {
          skewed = true;
          const d = poolAccount();
          new DataView(d.buffer).setBigUint64(49, BigInt(SIZE - 1), true);
          return { context: { slot: s.ref.slot! + 1 }, value: { owner: PROGRAM, lamports: 1, data: [base64.encode(d), "base64"] } };
        }
        return { context: { slot: s.ref.slot! + 2 }, value: a ? { owner: a.owner, lamports: 1, data: [base64.encode(a.data), "base64"] } : null };
      }
      if (method === "getLatestBlockhash" && plant.blockhashReads) {
        const b = plant.blockhashReads[Math.min(bhReads++, plant.blockhashReads.length - 1)]!;
        return { context: { slot: s.ref.slot! + b.slotAhead }, value: { blockhash: b.blockhash, lastValidBlockHeight: 100 } };
      }
      if (method === "getLatestBlockhash") return { context: { slot: s.ref.slot! + (plant.slotAhead ?? 2) }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } };
      if (method === "isBlockhashValid") return { value: !plant.blockhashInvalid };
      if (method === "getBlockHeight") {
        // confirmed: RPC 1's height beside the blockhash, so the last height is max(100, 0 + 151) = 151
        if ((params[0] as { commitment: string }).commitment === "confirmed") return 0;
        return plant.finalHeight?.(p, heightReads[p]!++) ?? 1_000;
      }
      // the not_landed verdict's read: one bank's block height and its slot (the same height count as getBlockHeight's)
      if (method === "getEpochInfo") {
        assert.equal((params[0] as { commitment: string }).commitment, "finalized");
        return { blockHeight: plant.finalHeight?.(p, heightReads[p]!++) ?? 1_000, absoluteSlot: plant.finalSlot?.(p) ?? 500, epoch: 1, slotIndex: 0, slotsInEpoch: 432_000 };
      }
      if (method === "getTransaction") {
        const how = txReads[p]!++ < (plant.metaJunkReads ?? 0) ? "metaJunk" : plant.readBack ?? "ours";
        if (how === "none" || sent === null) return null;
        const tx = sent.slice();
        tx.set(base58.decode(SIG), 1);
        if (how === "other" || (how === "lieOne" && p === 1)) tx[tx.length - 1]! ^= 1;
        if (how === "metaJunk") return { slot: txSlot(p), transaction: [base64.encode(tx), "base64"], meta: "x" };
        const err = how === "failed" ? { InstructionError: [2, { Custom: 6 }] } : null;
        if (!plant.received) return { slot: txSlot(p), transaction: [base64.encode(tx), "base64"], meta: { err } };
        const dp = plant.decimals ?? 6;
        const bal = (owner: string, mint: string, amount: bigint) => ({ accountIndex: 3, mint, owner, programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", uiTokenAmount: { amount: amount.toString(), decimals: dp, uiAmount: Number(amount) / 10 ** dp, uiAmountString: String(Number(amount) / 10 ** dp) } });
        const other = base58.encode(new Uint8Array(32).fill(3));
        return {
          slot: txSlot(p),
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
    tables: plant.tables ?? { [coin === "pump" ? "pump-curve" : "pumpswap"]: [s.tableAddr] },
    // the claim, logged: the order of the claim against the take and the seed is what the refusals are held to
    claimed: new (class extends Set<string> {
      override add(x: string) {
        log.push(`claim:${x}`);
        return super.add(x);
      }
    })(),
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
    settle: async (id, minSlots) => {
      log.push(`settle:${id}`);
      const how = plant.readBack ?? "ours";
      settles++;
      settleSlots.push(minSlots ? [...minSlots] : null);
      if (plant.settleThrows?.(settles)) throw new Error("restore: the lister listed 10 deposits and 2 releases, but rpc 0's pages hold 12 state and 10 label leaves");
      // a seat answering from before the spend unless held to a slot at or past it
      if (plant.spendSlot !== undefined && !(minSlots && minSlots[0] >= plant.spendSlot && minSlots[1] >= plant.spendSlot)) return { kind: "unspent" };
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
  return { host, log, multi, state: () => st, sentTx: () => sent, sends, waits, E: s.E, minOut: s.minOut, curve: (s.venue as { curve: string }).curve, settleSlots };
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

// Card sol-pool-venue-tables: the page pins a list of table generations per venue and builds on the buy's venue's
// generation that makes the smallest transaction; a venue with no pinned table is refused venue_not_pinned after the
// reads and before the pick, and a buy no generation fits is refused no_table_fits before the claim: neither claims,
// takes, reads the seed, signs or sends
const ASK_PS: PoolAsk = { ...ASK, token: fx.pumpswap.mint };
const GEN_SMALL = base58.encode(new Uint8Array(32).fill(6));
const CURVE_LIKE = base58.encode(new Uint8Array(32).fill(5));
/** The fixture's table without its pool pages: an older generation, whose buys name the pages as static keys. */
const noPages = (a: readonly string[]): readonly string[] => a.filter((k) => !Array.from({ length: 8 }, (_, i) => [solanaPoolPage(PROGRAM, 0, i * 1024), solanaPoolPage(PROGRAM, 1, i * 1024)]).flat().includes(k));
const nothingMoved = (w: World): void => {
  assert.equal(w.state(), "HELD");
  assert.equal(w.sentTx(), null);
  assert.ok(!w.log.some((x) => x.startsWith("claim:") || x.startsWith("take:") || x === "seed" || x === "send"), w.log.join(","));
  assert.equal(w.host.claimed?.size ?? 0, 0, "no note held claimed");
};
const loadedTables = (w: World): string[] => solanaDecodeMessage(w.sentTx()!.subarray(129)).lookups.map((l) => l.table);

test("a curve buy loads the curve's pinned table, never another venue's", async () => {
  const w = await world({ tables: { pumpswap: [OTHER_TABLE], "pump-curve": [s0.tableAddr] } });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.deepEqual(loadedTables(w), [s0.tableAddr]);
});
test("a buy reads its own venue's tables only: a curve buy fills whatever the PumpSwap table reads (gone, other bytes, another owner on RPC 1)", async () => {
  for (const how of ["gone", "bytes", "owner"] as const) {
    const w = await world({ tables: { pumpswap: [OTHER_TABLE], "pump-curve": [s0.tableAddr] }, tableOff: { address: OTHER_TABLE, how } });
    assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] }, how);
    assert.deepEqual(loadedTables(w), [s0.tableAddr], how);
  }
});
test("a curve buy ends while the PumpSwap table's read never answers: the buy awaits its own venue's tables only", async () => {
  const w = await world({ tables: { pumpswap: [OTHER_TABLE], "pump-curve": [s0.tableAddr] }, tableOff: { address: OTHER_TABLE, how: "hang" } });
  // judged by order, not by time: the buy against 5,000 turns of the event loop (the fake answers every other read at once)
  let turns = 0;
  const spin = new Promise<"hung">((ok) => {
    const turn = (): void => void (++turns >= 5_000 ? ok("hung") : setImmediate(turn));
    setImmediate(turn);
  });
  const got = await Promise.race([runPoolBuy(w.host, ASK), spin]);
  assert.deepEqual(got, { stage: "filled", txs: [{ chain: "solana", hash: SIG }] }, `after ${turns} turns`);
  assert.deepEqual(loadedTables(w), [s0.tableAddr]);
});
test("the venue's own table read otherwise on RPC 1 (gone, other bytes, another owner) refuses the buy before the claim: nothing claimed, taken, seeded or sent", async () => {
  for (const how of ["gone", "bytes", "owner"] as const) {
    const w = await world({ tableOff: { address: s0.tableAddr, how } });
    assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "failed" }, how);
    nothingMoved(w);
  }
});
test("a PumpSwap buy with both venues pinned loads PumpSwap's table (mutant A4: always the curve's)", async () => {
  const w = await world({ coin: "pumpswap", tables: { "pump-curve": [OTHER_TABLE], pumpswap: [s0.tableAddr] } });
  assert.deepEqual(await runPoolBuy(w.host, ASK_PS), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.deepEqual(loadedTables(w), [s0.tableAddr]);
  // the claim comes before the seed is read and the take, once the build fits
  const at = (x: string) => w.log.findIndex((l) => l === x || l.startsWith(x));
  assert.ok(at("claim:") >= 0 && at("claim:") < at("seed") && at("seed") < at("take:"), w.log.join(","));
});
test("generations: the buy loads the venue's generation that makes the smallest transaction, in either pin order", async () => {
  for (const order of [[GEN_SMALL, s0.tableAddr], [s0.tableAddr, GEN_SMALL]]) {
    const w = await world({ coin: "pumpswap", tables: { pumpswap: order }, extraTables: { [GEN_SMALL]: noPages } });
    assert.deepEqual(await runPoolBuy(w.host, ASK_PS), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
    assert.deepEqual(loadedTables(w), [s0.tableAddr], order.join(" "));
  }
});
test("a buy no pinned generation fits is refused no_table_fits before the claim, the take and the seed", async () => {
  const w = await world({ coin: "pumpswap", tables: { pumpswap: [CURVE_LIKE] }, extraTables: { [CURVE_LIKE]: (a) => a.slice(0, 11) } });
  assert.deepEqual(await runPoolBuy(w.host, ASK_PS), { error: "no_table_fits" });
  nothingMoved(w);
});
test("a venue with no pinned table is refused venue_not_pinned once the reference names it, before the venue's own read: never claimed, taken, seeded, signed or sent (mutants A8, A8b)", async () => {
  const w = await world({ tables: { pumpswap: [OTHER_TABLE] } });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "venue_not_pinned" });
  nothingMoved(w);
  // review P3-5 of the pin: the coin's venue is known only from its reference quote, read last on purpose (the quote's
  // age counts from it), so the reads before it stand; the venue's own accounts are not read: the reference's two key
  // lists (the curve's and PumpSwap's candidates) on each RPC are the only multi-account reads (6 at bf69679c: the
  // venue's read on both RPCs after them)
  assert.equal(w.multi.length, 4, JSON.stringify(w.multi));
  assert.equal(new Set(w.multi.map((l) => l.join())).size, 2);
});
test("no table pinned, or a pin that is not a list of addresses: refused not_allowed before any read (mutant A2)", async () => {
  for (const tables of [{}, Object.create({ "pump-curve": [s0.tableAddr] }), { "pump-curve": s0.tableAddr }, { "pump-curve": [] }, { "pump-curve": [7] }, { "pump-curve": [s0.tableAddr], pumpswap: [{}] }, { "pump-curve": [s0.tableAddr], pumpswap: [] }]) {
    const w = await world({ tables: tables as never });
    assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "not_allowed" }, JSON.stringify(tables));
    assert.ok(!w.log.some((x) => /^[01]:/.test(x)), w.log.join(","));
  }
});

// Card sol-w-sweep, delta review 7 of 08290868: the buy writes W's buy mint (and its token program, the venue's) before
// its send, so the rent back after a later sell knows W's own coin; a buy whose send fails keeps the record (it can only
// make a rent back hold); a write that fails sends nothing
test("the buy writes W's buy mint before its send; a send that fails keeps it; a write that fails sends nothing", async () => {
  const rec = new Map<string, { mint: string; program: string }>();
  const w = await world({ helper: "502", landsAtSettle: "never", finalHeight: () => 1_000 });
  w.host.bought = { get: async (a) => rec.get(a), put: async (a, m) => void (w.log.push("bought"), rec.set(a, m)) };
  const a = await runPoolBuy(w.host, ASK);
  assert.deepEqual(a, { stage: "not_landed", txs: [] });
  const order = w.log.filter((x) => x === "bought" || x === "send");
  assert.deepEqual(order, ["bought", "send"]);
  assert.deepEqual(rec.get(W.address), { mint: ASK.token, program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" });
  const x = await world();
  x.host.bought = { get: async () => undefined, put: async () => { throw new Error("store down"); } };
  const b = await runPoolBuy(x.host, ASK);
  assert.ok("error" in b, JSON.stringify(b));
  assert.equal(x.sends.length, 0, "nothing sent");
  assert.equal(x.state(), "HELD", "nothing taken");
});

test("a quote off the request (older than the device's slot allows) is refused: nothing signed, taken or sent", async () => {
  const w = await world({ slotAhead: 40 });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "quote_check_failed" });
  assert.equal(w.state(), "HELD", "the proof stays ready for the next tap");
  assert.ok(!w.log.includes("send") && !w.log.some((x) => x.startsWith("take")));
});

// review P3-4 of a34c1626: a buy on a venue our lookup table is not made for (PumpSwap on the mainnet's curve-only table)
// threw a plain Error and answered "failed". With a list of tables per venue (card sol-pool-venue-tables), a table that
// holds no account of the venue's program is no generation of it: the kit passes over it, and a venue none of whose
// pinned tables is made for it (a table pinned under the wrong venue) has no table on this page, as venue_not_pinned
// answers, before the claim: never failed, nothing claimed, taken, seeded, signed or sent
test("a venue whose pinned tables hold none of its program's accounts is refused venue_not_pinned before the claim; one such table beside its own is passed over", async () => {
  const w = await world({ tableNotForVenue: true });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "venue_not_pinned" });
  nothingMoved(w);
  const both = await world({ tableNotForVenue: true, tables: { "pump-curve": [s0.tableAddr, OTHER_TABLE] } });
  assert.deepEqual(await runPoolBuy(both.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.deepEqual(loadedTables(both), [OTHER_TABLE]);
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

test("a take that hands back another attempt's proof, or other proof bytes, is refused by the page itself: nothing leaves", async () => {
  for (const other of [readyProof({ attempt: "attempt-2" }), { ...readyProof(), proof: { ...readyProof().proof, pi_a: [...readyProof().proof.pi_a].reverse() } }]) {
    const w = await world();
    w.host.take = async (id: string) => (w.log.push(`take:${id}`), other as never);
    assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "failed" });
    assert.ok(w.log.includes("take:note-1"));
    assert.equal(w.sentTx(), null);
  }
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
  // card pool-buy-filled-2s: the venue's read goes out in the slot read's own round, its call a tick behind (the kit
  // starts it in a microtask): one per RPC, the venue's accounts (the mint first); no other read starts after the slot's
  const venue = between.filter((x) => x.endsWith(":getMultipleAccounts"));
  assert.deepEqual(venue, ["0:getMultipleAccounts", "1:getMultipleAccounts"], between.join(" "));
  assert.equal(w.multi.at(-1)![0], fx.pump.mint, "the last accounts read is the venue's");
  assert.deepEqual(between.filter((x) => /^[01]:/.test(x) && x !== "1:isBlockhashValid" && x !== "1:getBlockHeight" && !x.endsWith(":getMultipleAccounts")), [], between.join(" "));
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
  // the app on this kit names its version first, as the kit's client does: route events go to kit-v1.5 and on only
  listener!({ origin: APP_ORIGIN, source: parent, data: HELLO });
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

test("the decimals of the token W received, read with that amount on both RPCs, are told with W just before the amount (card signpage-state-holdings: W's buy record); none when the amount is not told; a listener that throws never stops a buy", async () => {
  const w0 = await world();
  const ok = await world({ received: [w0.E, w0.E] });
  const told: unknown[] = [];
  const a = await runPoolBuy({ ...ok.host, route: (x) => void told.push(x), outDecimals: (wallet, d, mint) => void told.push({ decimals: [wallet, d, mint] }) }, ASK);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  // with the token's mint, which the page keeps them for (card sell-first-read-waits-out-a-throttle)
  assert.deepEqual(told.slice(-2), [{ decimals: [W.address, 6, ASK.token] }, { out: whole6(w0.E) }]);
  const apart = await world({ received: [w0.E, w0.E - 1n] });
  const none: unknown[] = [];
  await runPoolBuy({ ...apart.host, outDecimals: (wallet, d) => void none.push([wallet, d]) }, ASK);
  assert.deepEqual(none, [], "the two RPCs differ on the amount: no decimals told");
  const loud = await world({ received: [w0.E, w0.E] });
  const b = await runPoolBuy({ ...loud.host, outDecimals: () => { throw new Error("the record"); } }, ASK);
  assert.deepEqual(b, { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
});

test("P3-8: an async decimals listener that rejects never stops a buy, and its rejection is caught (none left unhandled)", async () => {
  const w0 = await world();
  const w = await world({ received: [w0.E, w0.E] });
  const loose: unknown[] = [];
  const seen = (e: unknown) => void loose.push(e);
  process.on("unhandledRejection", seen);
  try {
    const a = await runPoolBuy({ ...w.host, outDecimals: async () => { throw new Error("the record's store"); } }, ASK);
    assert.deepEqual(a, { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", seen);
  }
  assert.deepEqual(loose, []);
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

test("a buy refused after its claim (the check, or a seed whose W is not the proof's recipient) releases the claim: no note stays held from the next tap", async () => {
  for (const plant of [{ slotAhead: 100 }, { seedOther: true }] as const) {
    const w = await world(plant);
    const a = await runPoolBuy(w.host, ASK);
    assert.ok("error" in a, JSON.stringify(a));
    assert.ok(w.log.some((x) => x.startsWith("claim:")), `the run reached the claim: ${w.log.join(",")}`);
    assert.equal(w.host.claimed?.size, 0, `${JSON.stringify(plant)}: the claim is released`);
    assert.equal(w.state(), "HELD");
  }
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
  // the app on this kit names its version first, as the kit's client does: route events go to kit-v1.5 and on only
  listener!({ origin: APP_ORIGIN, source: parent, data: HELLO });
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

// Review of 418af7d5 (P3-2): a run that ends with an error after its early answer "sent" (the transaction went out, its
// end not known) posts "sent" as its final progress, so the app's Filled not yet Final ends (Landing again, as for any
// buy whose end is not known) instead of staying Filled for good; before its answer an error is the answer itself.
test("review of 418af7d5: a run that throws after its early answer posts sent as its final progress", async () => {
  const w = await world();
  const locks = { request: (_n: string, _o: unknown, f: () => Promise<void>) => f() } as unknown as Pick<LockManager, "request">;
  const stages: string[] = [];
  // the page's clock throws once the read-back read the transaction on both RPCs (an unplanned fault past the answer)
  const now = w.host.now;
  const host = { ...w.host, now: () => {
    if (w.log.filter((x) => /^[01]:getTransaction/.test(x)).length >= 2) throw new Error("a fault after the answer");
    return now ? now() : BigInt(Date.now());
  } };
  const r = poolBuyKind(() => host, locks)(ASK, { id: "r1", sha: "00", progress: (s: string) => void stages.push(s) } as never) as { running: true; after: Promise<void>; answer: () => unknown };
  await r.after;
  assert.deepEqual(r.answer(), { result: { stage: "sent", txs: [{ chain: "solana", hash: SIG }] } });
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(stages, ["sent"], "the run's end reaches the app");
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

// Card pool-read-down: one provider down past the page's own retry, from each of its calls in turn. Before W signs, the
// buy answers "down" (api.ts RETRY_CODES: the same request again runs again), never failed or not_allowed, with
// nothing taken, signed or sent; the other provider's word alone is never taken. From the take on (W signed), it is
// never "down": the transaction may land, and the read-back rules decide.
for (const p of [0, 1] as const) {
  test(`card pool-read-down: provider ${p} down past the page's retry answers down before W signs, and never down after`, async () => {
    let before = 0;
    let after = 0;
    for (let from = 0; ; from++) {
      const w = await world();
      const d = pairDown(w.host.rpcs, p, from);
      const a = await runPoolBuy({ ...w.host, rpcs: d.rpcs }, ASK);
      if (!d.fired()) break;
      if (!w.log.some((x) => x.startsWith("take"))) {
        before++;
        assert.deepEqual(a, { error: "down" }, `from call ${from}`);
        assert.equal(w.state(), "HELD", `from call ${from}`);
        assert.ok(!w.log.includes("send"), `from call ${from}: nothing sent`);
      } else {
        after++;
        assert.notDeepEqual(a, { error: "down" }, `from call ${from}`);
      }
    }
    assert.ok(before > 0 && after > 0, `${before} before, ${after} after`);
  });
}

// Card sol-settle-failed-is-not-unspent: a settle that throws says nothing of the chain (a lister that refuses, a 429
// past the retry, a stop). The helper answers 502 (or no signature, or one that never reads back) and sends the buy
// anyway, the buy lands, and the settle fails while both RPCs read the blockhash past: the answer was not_landed, the app
// told nothing happened while the tokens were on W. A thrown settle is not known yet: the reads go on, and past them the
// answer is "sent", the note RESERVED for the state reads' pass.
for (const [name, plant] of [["the helper's 502", { helper: "502" }], ["a signature that is not one", { helper: "badSig" }], ["the helper's signature never read back", { readBack: "none" }], ["the helper's signature read as another transaction", { readBack: "other" }]] as const) {
  test(`a settle that throws is not known yet, ${name}: every settle failing past the blockhash, sent and never not_landed; failing once, filled`, async () => {
    const w = await world({ ...plant, finalHeight: () => 1_000, settleThrows: () => true });
    assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "sent", txs: [] });
    assert.equal(w.state(), "RESERVED", "held for the state reads' pass");
    assert.equal(w.log.filter((x) => x === "settle:note-1").length, 3, "the reads went on");
    if ("readBack" in plant) return; // the transaction is not this one's under the helper's name: never filled by it
    const x = await world({ ...plant, finalHeight: () => 1_000, settleThrows: (n) => n === 1 });
    assert.deepEqual(await runPoolBuy(x.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
    assert.equal(x.state(), "SPENT");
  });
}

// Card sol-settle-failed-is-not-unspent (C3): seats behind a load balancer may answer from before the spend unless held
// to a slot, so the settle that decides not_landed is read at or past each RPC's slot of the read that saw the blockhash
// past (one getEpochInfo at finalized: its block height and its slot are one bank's).
test("the not_landed verdict's settle is held to the slots of the read that saw the blockhash past: seats from before the spend never answer a landed buy not_landed", async () => {
  // the spend at slot 450; the past read's bank at 500 on RPC 0 and 510 on RPC 1
  const w = await world({ helper: "502", finalHeight: () => 1_000, finalSlot: (p) => 500 + 10 * p, spendSlot: 450 });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.deepEqual(w.settleSlots[0], [500, 510], "each RPC's own slot");
  assert.equal(w.state(), "SPENT");
  // not past yet on both: the settle is asked with no slot, and its "unspent" decides nothing
  const n = await world({ helper: "502", finalHeight: (p) => (p === 0 ? 1_000 : 50), finalSlot: () => 500, spendSlot: 450 });
  assert.deepEqual(await runPoolBuy(n.host, ASK), { stage: "sent", txs: [] });
  assert.deepEqual(n.settleSlots, [null, null, null]);
});

// How long each ending takes on the page's clock (it moves with each wait the run asks for), at the production read
// count: a real not-landed buy still ends not_landed at its first read past the blockhash; a settle that keeps failing
// ends "sent" at the read-back's bound.
test("each ending's time: not_landed at the first read past the blockhash (and one read later after one failed settle); a settle that never works, sent within POOL_BUY_SETTLE_MS", async () => {
  const run = async (plant: Plant) => {
    const w = await world(plant);
    w.host.now = () => BigInt(1_000 + w.waits.reduce((s, x) => s + x, 0));
    const a = await runPoolBuy({ ...w.host, reads: POOL_BUY_READS }, ASK);
    return { a, ms: w.waits.reduce((s, x) => s + x, 0) };
  };
  const NL = { stage: "not_landed", txs: [] };
  assert.deepEqual(await run({ helper: "502", landsAtSettle: "never" }), { a: NL, ms: 0 }, "past at the first read");
  assert.deepEqual(await run({ helper: "502", landsAtSettle: "never", settleThrows: (n) => n === 1 }), { a: NL, ms: 1_000 }, "one failed settle: one read later");
  assert.deepEqual(await run({ helper: "502", landsAtSettle: "never", finalHeight: (_p, i) => (i < 60 ? 50 : 1_000) }), { a: NL, ms: 60_000 }, "past from the 61st read");
  const always = await run({ helper: "502", settleThrows: () => true });
  assert.deepEqual(always.a, { stage: "sent", txs: [] });
  assert.ok(always.ms <= POOL_BUY_SETTLE_MS, `${always.ms} ms`);
  // card pool-buy-filled-2s: a settle that throws is asked again after a wait that doubles to 8 s, so the run reaches
  // its bound in under twenty settles (120 at a fixed second before), never past it
  assert.equal(always.ms, POOL_BUY_SETTLE_MS);
  const settles = await world({ helper: "502", settleThrows: () => true });
  settles.host.now = () => BigInt(1_000 + settles.waits.reduce((s, x) => s + x, 0));
  await runPoolBuy({ ...settles.host, reads: POOL_BUY_READS }, ASK);
  assert.ok(settles.log.filter((x) => x === "settle:note-1").length < 20, settles.waits.join(","));
});

// Card sol-settle-failed-is-not-unspent: "past" is a finalized height above the blockhash's last valid one (151 here:
// the higher of RPC 0's word, 100, and RPC 1's height + 151). At the last itself a block may still take the transaction.
test("past is a finalized height above the blockhash's last valid one: at the last itself, sent; one above, not_landed", async () => {
  const at = await world({ helper: "502", landsAtSettle: "never", finalHeight: () => 151 });
  assert.deepEqual(await runPoolBuy(at.host, ASK), { stage: "sent", txs: [] });
  assert.deepEqual(at.settleSlots, [null, null, null], "never asked as the verdict's settle");
  const above = await world({ helper: "502", landsAtSettle: "never", finalHeight: () => 152 });
  assert.deepEqual(await runPoolBuy(above.host, ASK), { stage: "not_landed", txs: [] });
  assert.deepEqual(above.settleSlots, [[500, 500]]);
});

// Card pool-buy-filled-2s: the checks' reads go out in rounds by their inputs alone. A round is every call made before
// any of them is answered; the gate holds each call until the round is let go, so the count is the run's own, never a
// clock's.
/** The read-back's pace: a slot (~400 ms), pool-buy.ts POOL_BUY_POLL_MS. */
const POOL_BUY_POLL_MS = 400;
async function roundsToSend(w: World): Promise<{ rounds: string[][]; answer: unknown }> {
  const held: { go: () => void; name: string }[] = [];
  const gate = (p: 0 | 1, rpc: SolanaRpc): SolanaRpc => (async (method: string, params: readonly unknown[]) => {
    await new Promise<void>((go) => held.push({ go, name: `${p}:${method}` }));
    return rpc(method, params);
  }) as SolanaRpc;
  w.host.rpcs = [gate(0, w.host.rpcs[0]), gate(1, w.host.rpcs[1])];
  const rounds: string[][] = [];
  let done = false;
  let answer: unknown;
  const run = runPoolBuy(w.host, ASK).then((a) => ((done = true), (answer = a)));
  while (!done && !w.log.includes("send")) {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    if (held.length === 0) continue;
    const now = held.splice(0);
    rounds.push(now.map((x) => x.name));
    now.forEach((x) => x.go());
  }
  // past the send the gate stays open
  w.host.rpcs = w.host.rpcs;
  const drain = setInterval(() => held.splice(0).forEach((x) => x.go()), 0);
  await run;
  clearInterval(drain);
  return { rounds, answer };
}

test("card pool-buy-filled-2s: the checks' reads go out in three rounds by their inputs (8 serial rounds before), every read on both RPCs as before", async () => {
  const w = await world();
  const { rounds, answer } = await roundsToSend(w);
  assert.equal((answer as { stage?: string }).stage, "filled");
  const before = rounds.slice(0, rounds.findIndex((r) => r.includes("0:getTransaction")));
  assert.deepEqual(before.map((r) => [...r].sort()), [
    // the rent, the pinned table, the pool account and the reference: each needs only the pin and the ask
    ["0:getAccountInfo", "0:getAccountInfo", "0:getAccountInfo", "0:getMultipleAccounts", "0:getMultipleAccounts", "1:getAccountInfo", "1:getAccountInfo", "1:getAccountInfo", "1:getMultipleAccounts", "1:getMultipleAccounts"],
    // the two root pages (the sizes name them), the venue (the reference names it), then the device's blockhash and slot
    ["0:getAccountInfo", "0:getAccountInfo", "0:getLatestBlockhash", "0:getMultipleAccounts", "1:getAccountInfo", "1:getAccountInfo", "1:getMultipleAccounts"],
    // the blockhash on RPC 1, which needs RPC 0's
    ["1:getBlockHeight", "1:isBlockhashValid"],
  ]);
});

test("card pool-buy-filled-2s: the read-back polls at the slot's pace, never a fixed second", async () => {
  const w = await world({ metaJunkReads: 2 });
  assert.equal((await runPoolBuy(w.host, ASK) as { stage?: string }).stage, "filled");
  assert.ok(w.waits.length >= 2, w.waits.join(","));
  assert.ok(w.waits.every((ms) => ms === POOL_BUY_POLL_MS), w.waits.join(","));
  assert.equal((poolBuy as Record<string, unknown>).POOL_BUY_POLL_MS, POOL_BUY_POLL_MS);
});

test("card pool-buy-filled-2s: no settle before both RPCs' finalized slot reaches the transaction's slot; then one, held to those slots", async () => {
  // RPC 1's finalized slot trails: below the transaction's slot for its first three reads
  const w = await world({ finalizedSlot: (p, i) => (p === 1 && i < 3 ? TX_SLOT - 10 : TX_SLOT + 5) });
  assert.equal((await runPoolBuy({ ...w.host, reads: 10 }, ASK) as { stage?: string }).stage, "filled");
  assert.equal(w.log.filter((x) => x === "settle:note-1").length, 1, w.log.join(","));
  assert.deepEqual(w.settleSlots, [[TX_SLOT + 5, TX_SLOT + 5]]);
  const firstSettle = w.log.indexOf("settle:note-1");
  assert.equal(w.log.slice(0, firstSettle).filter((x) => x === "1:getSlot").length, 4, "three reads below, the fourth at or past it");
});

test("card pool-buy-filled-2s: a settle that throws is asked again only after a wait that doubles from the slot's pace", async () => {
  const w = await world({ settleThrows: (n) => n <= 3 });
  assert.equal((await runPoolBuy({ ...w.host, reads: 10 }, ASK) as { stage?: string }).stage, "filled");
  assert.equal(w.log.filter((x) => x === "settle:note-1").length, 4);
  assert.deepEqual(w.waits, [2 * POOL_BUY_POLL_MS, 4 * POOL_BUY_POLL_MS, 8 * POOL_BUY_POLL_MS]);
});

test("card pool-buy-filled-2s: a provider answering 429 for 30 s is asked again at a doubling wait (its Retry-After honoured), not at the slot's pace", async () => {
  const w = await world();
  let t = 0;
  const calls = { tx: 0 };
  const inner = w.host.rpcs[1];
  w.host.rpcs = [w.host.rpcs[0], (async (method: string, params: readonly unknown[]) => {
    if (method === "getTransaction" && t < 30_000) {
      calls.tx++;
      throw new SolanaRpcTransportError("http_429", "HTTP 429", 3, "rpc1", calls.tx === 3 ? 5_000 : null);
    }
    return inner(method, params);
  }) as SolanaRpc];
  const a = await runPoolBuy({ ...w.host, reads: POOL_BUY_READS, now: () => BigInt(t), wait: async (ms) => void ((t += ms), w.waits.push(ms)) }, ASK) as { stage?: string };
  assert.equal(a.stage, "filled");
  // 400, 800, then the provider's 5 s, then 6.4 s and the 8 s cap: under ten calls in 30 s, where a fixed 400 ms is 75
  assert.ok(calls.tx <= 8, `${calls.tx} calls in 30 s`);
  assert.ok(w.waits.includes(5_000), w.waits.join(","));
  assert.ok(w.waits.every((ms) => ms <= 8_000), w.waits.join(","));
});

test("card pool-buy-filled-2s: the device's blockhash not valid on RPC 1 is refused before anything is claimed, taken or sent", async () => {
  const w = await world({ blockhashInvalid: true });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "failed" });
  nothingMoved(w);
});

test("card pool-buy-filled-2s: two RPCs on two state tree sizes after the read again are refused: nothing claimed, taken or sent", async () => {
  const w = await world({ sizeSkewAlways: true });
  assert.deepEqual(await runPoolBuy(w.host, ASK), { error: "failed" });
  nothingMoved(w);
});

test("card pool-buy-filled-2s: the finality wait reads both RPCs' slot, then waits the gap: 32 slots behind, at most 4 getSlot a provider before the settle, asked within a second of both reaching it", async () => {
  const w = await world();
  let t = 0;
  const behind = 32;
  // each RPC's finalized slot, a slot every 400 ms of the run's clock from 32 behind the transaction's at the send
  let sentAt: number | null = null;
  const slotsBefore = [0, 0];
  let settledAt: number | null = null;
  const inner = w.host.rpcs;
  const at = (p: 0 | 1): SolanaRpc => (async (method: string, params: readonly unknown[]) => {
    if (method === "getSlot" && sentAt !== null && settledAt === null) {
      slotsBefore[p]!++;
      return TX_SLOT - behind + Math.floor((t - sentAt) / 400);
    }
    return inner[p](method, params);
  }) as SolanaRpc;
  const host: PoolBuyHost = { ...w.host, rpcs: [at(0), at(1)], reads: POOL_BUY_READS, now: () => BigInt(t), wait: async (ms) => void (t += ms),
    send: async (pool, tx) => ((sentAt = t), w.host.send(pool, tx)),
    settle: async (id, m) => ((settledAt ??= t), w.host.settle(id, m)) };
  assert.equal((await runPoolBuy(host, ASK) as { stage?: string }).stage, "filled");
  assert.ok(slotsBefore.every((n) => n <= 4), `getSlot calls before the settle: ${slotsBefore.join(", ")}`);
  const reached = sentAt! + behind * 400;
  assert.ok(settledAt! >= reached && settledAt! - reached <= 1_000, `the settle at ${settledAt! - sentAt!} ms, both reached at ${reached - sentAt!} ms`);
});

test("card pool-buy-filled-2s: an RPC that names no slot for the transaction is held to the other's: the settle is asked once, when both finalized slots reach it", async () => {
  // the spend at the transaction's slot: a settle held to a slot below it on either RPC answers unspent (nothing
  // written, the note RESERVED). RPC 1 names no slot; its finalized slot is 390 at first, then 410; RPC 0's is 405
  const w = await world({ noTxSlotOn1: true, spendSlot: TX_SLOT, finalizedSlot: (p, i) => (p === 0 ? TX_SLOT + 5 : i < 1 ? TX_SLOT - 10 : TX_SLOT + 10) });
  assert.equal((await runPoolBuy({ ...w.host, reads: 10 }, ASK) as { stage?: string }).stage, "filled");
  assert.deepEqual(w.settleSlots, [[TX_SLOT + 5, TX_SLOT + 10]], "no early settle: RPC 1's gate is RPC 0's slot of the transaction");
});

// Review of 1caf0b17 (card pool-buy-filled-2s). A fake clock for the run: `after(ms, f)` answers f() ms on from now, and
// the clock moves to each answer's time as it lands, earliest first (every other read answers at once, at now), so a
// read held on one RPC holds only what waits on it. `t()` is the clock; the host's now and wait run on it.
function timeline() {
  let t = 0;
  const q: { at: number; n: number; go: () => void }[] = [];
  let n = 0;
  let pumping = false;
  const step = (): void => {
    if (q.length === 0) return void (pumping = false);
    q.sort((a, b) => a.at - b.at || a.n - b.n);
    const x = q.shift()!;
    t = Math.max(t, x.at);
    x.go();
    setImmediate(step);
  };
  const after = <T,>(ms: number, f: () => Promise<T>): Promise<T> =>
    ms <= 0 ? f() : new Promise<T>((ok, ko) => {
      q.push({ at: t + ms, n: n++, go: () => void f().then(ok, ko) });
      if (!pumping) (pumping = true), setImmediate(step);
    });
  return { t: () => t, after };
}
const GATE_MAX_MS = 30_000; // POOL_BUY_GATE_MAX_MS (a local copy, so the run before it loads)
const SLOT_STALE_MS = 1_000; // POOL_BUY_SLOT_STALE_MS
const SLOT_MS = 400;
/** The host on the fake clock, each RPC read held `delay(p, method, params)` ms; the times of the device's slot reads
 *  (getLatestBlockhash answered), of W's seed read, of each settle and of RPC 1's read-backs. */
function clocked(w: World, delay: (p: 0 | 1, method: string, params: readonly unknown[]) => number = () => 0) {
  const c = timeline();
  const at = { slot: [] as number[], seed: [] as number[], settle: [] as number[], landed: [] as number[] };
  const inner = w.host.rpcs;
  const rpc = (p: 0 | 1): SolanaRpc => (async (method: string, params: readonly unknown[]) => {
    const x = await c.after(delay(p, method, params), () => inner[p](method, params));
    if (method === "getLatestBlockhash") at.slot.push(c.t());
    if (method === "getTransaction" && p === 1 && x) at.landed.push(c.t());
    return x;
  }) as SolanaRpc;
  const host: PoolBuyHost = {
    ...w.host, rpcs: [rpc(0), rpc(1)], reads: POOL_BUY_READS, now: () => BigInt(c.t()),
    wait: (ms) => (w.waits.push(ms), c.after(ms, async () => {})),
    seed64: () => (at.seed.push(c.t()), w.host.seed64()),
    settle: (id, m) => (at.settle.push(c.t()), w.host.settle(id, m)),
  };
  return { host, at, t: c.t };
}
/** The time W's seed was read after the slot read it signs on: what the quote's age check did not count. */
const uncounted = (at: { slot: number[]; seed: number[] }): number => at.seed[0]! - at.slot.filter((x) => x <= at.seed[0]!).at(-1)!;
const isPage = (params: readonly unknown[]): boolean => Array.from({ length: 8 }, (_, k) => ([0, 1] as const).map((tree) => solanaPoolPage(PROGRAM, tree, k * 1024))).flat().includes(params[0] as string);

test("review P2 of 1caf0b17: a root 4 pages back with RPC 1 holding each page read 9 slots: the slot is read again after the pages, so W signs within a second of the slot it is checked on", async () => {
  const w = await world({ pagesBack: 4 });
  const c = clocked(w, (p, m, params) => (p === 1 && m === "getAccountInfo" && isPage(params) ? 9 * SLOT_MS : 0));
  assert.equal((await runPoolBuy(c.host, ASK) as { stage?: string }).stage, "filled");
  assert.equal(c.at.slot.length, 2, "the blockhash and slot read again");
  assert.ok(uncounted(c.at) <= SLOT_STALE_MS, `W signed ${uncounted(c.at)} ms after its slot read (${Math.round(uncounted(c.at) / SLOT_MS)} slots)`);
});

test("review P2 of 1caf0b17: RPC 1 holding the venue's read 9 slots: the slot is read again after it, so W signs within a second of the slot it is checked on", async () => {
  const w = await world();
  const c = clocked(w, (p, m, params) => (p === 1 && m === "getMultipleAccounts" && (params[0] as string[])[0] === fx.pump.mint ? 9 * SLOT_MS : 0));
  assert.equal((await runPoolBuy(c.host, ASK) as { stage?: string }).stage, "filled");
  assert.equal(c.at.slot.length, 2, "the blockhash and slot read again");
  assert.ok(uncounted(c.at) <= SLOT_STALE_MS, `W signed ${uncounted(c.at)} ms after its slot read`);
});

// Review of 418af7d5 (P3-1): the read again is the one the buy is checked and built on. The fixture answered the same
// slot and blockhash both times, so a check that kept the first slot, or a transaction built on the first blockhash,
// passed; here the second read answers another of each.
const OTHER_BLOCKHASH = base58.encode(new Uint8Array(32).fill(9));
const holdVenue = (p: 0 | 1, m: string, params: readonly unknown[]): number => (p === 1 && m === "getMultipleAccounts" && (params[0] as string[])[0] === fx.pump.mint ? 9 * SLOT_MS : 0);
test("review of 418af7d5: the slot read again 30 slots past the quote's is the one checked: quote_check_failed, nothing taken or sent", async () => {
  const w = await world({ blockhashReads: [{ slotAhead: 2, blockhash: BLOCKHASH }, { slotAhead: 30, blockhash: BLOCKHASH }] });
  const c = clocked(w, holdVenue);
  assert.deepEqual(await runPoolBuy(c.host, ASK), { error: "quote_check_failed" });
  assert.equal(c.at.slot.length, 2, "the blockhash and slot read again");
  assert.equal(w.state(), "HELD");
  assert.ok(!w.log.includes("send") && !w.log.some((x) => x.startsWith("take")));
  assert.equal(w.sends.length, 0);
});

test("review of 418af7d5: the blockhash read again is the one W signs: the sent transaction carries the second", async () => {
  const w = await world({ blockhashReads: [{ slotAhead: 2, blockhash: BLOCKHASH }, { slotAhead: 2, blockhash: OTHER_BLOCKHASH }] });
  assert.notEqual(OTHER_BLOCKHASH, BLOCKHASH);
  const c = clocked(w, holdVenue);
  assert.equal((await runPoolBuy(c.host, ASK) as { stage?: string }).stage, "filled");
  assert.equal(c.at.slot.length, 2, "the blockhash and slot read again");
  assert.equal(solanaDecodeMessage(w.sentTx()!.subarray(129)).blockhash, OTHER_BLOCKHASH);
});

test("review P2 of 1caf0b17: a round that ends within a second of the slot read reads it once (three rounds), however slow the reads before it", async () => {
  const w = await world({ pagesBack: 1 });
  // the first round (rent, tables, pool account, reference) slow, the pages and the venue at once
  const c = clocked(w, (_p, m, params) => (m === "getAccountInfo" && !isPage(params) ? 5 * SLOT_MS : 0));
  assert.equal((await runPoolBuy(c.host, ASK) as { stage?: string }).stage, "filled");
  assert.equal(c.at.slot.length, 1);
  assert.equal(w.log.filter((x) => x === "0:getLatestBlockhash").length, 1);
});

test("fold 1 (4), two pages: past the device's slot read, before the take, only RPC 1's blockhash reads, the venue's, and the root pages past the first", async () => {
  const w = await world({ pagesBack: 1 });
  const c = clocked(w);
  assert.equal((await runPoolBuy(c.host, ASK) as { stage?: string }).stage, "filled");
  const bh = w.log.indexOf("0:getLatestBlockhash");
  const between = w.log.slice(bh + 1, w.log.indexOf("take:note-1"));
  assert.deepEqual(between.filter((x) => x.endsWith(":getMultipleAccounts")), ["0:getMultipleAccounts", "1:getMultipleAccounts"], between.join(" "));
  // the second page of each tree (page 0, after page 1 found neither root) on each RPC
  assert.deepEqual(between.filter((x) => x.endsWith(":getAccountInfo")).sort(), ["0:getAccountInfo", "0:getAccountInfo", "1:getAccountInfo", "1:getAccountInfo"], between.join(" "));
  assert.deepEqual(between.filter((x) => /^[01]:/.test(x) && !["1:isBlockhashValid", "1:getBlockHeight"].includes(x) && !/:get(MultipleAccounts|AccountInfo)$/.test(x)), [], between.join(" "));
  assert.ok(uncounted(c.at) <= SLOT_STALE_MS);
});

test("review P3a of 1caf0b17: one RPC's word for the transaction's slot (2^53 - 1) holds the settle at most POOL_BUY_GATE_MAX_MS from the land; its own reads decide: filled", async () => {
  const w = await world({ txSlotOn1: Number.MAX_SAFE_INTEGER, finalizedSlot: () => TX_SLOT + 5 });
  const c = clocked(w);
  assert.deepEqual(await runPoolBuy(c.host, ASK), { stage: "filled", txs: [{ chain: "solana", hash: SIG }] });
  assert.equal((poolBuy as Record<string, unknown>).POOL_BUY_GATE_MAX_MS, GATE_MAX_MS);
  const held = c.at.settle[0]! - c.at.landed[0]!;
  assert.ok(held >= GATE_MAX_MS && held <= GATE_MAX_MS + SLOT_MS, `the settle ${held} ms after the land`);
  const before = w.log.slice(0, w.log.indexOf("settle:note-1"));
  assert.ok(before.filter((x) => x === "1:getSlot").length <= 6, `${before.filter((x) => x === "1:getSlot").length} getSlot on RPC 1 before it`);
});

test("review P3b of 1caf0b17: past the gate, a settle that finds no spend is asked again at a doubling wait: under 20 in the run's 120 s", async () => {
  const w = await world({ finalizedSlot: () => TX_SLOT + 5, spendSlot: TX_SLOT + 1_000 });
  const c = clocked(w);
  assert.deepEqual(await runPoolBuy(c.host, ASK), { stage: "sent", txs: [{ chain: "solana", hash: SIG }] });
  assert.ok(c.at.settle.length < 20, `${c.at.settle.length} settles`);
  assert.ok(c.t() <= POOL_BUY_SETTLE_MS + 1_000, `${c.t()} ms`);
});

test("review P3c of 1caf0b17: a finalized-slot read that goes through puts the wait back to the slot's pace after a throttle", async () => {
  const w = await world({ finalizedSlot: (_p, i) => (i < 2 ? TX_SLOT - 1 : TX_SLOT + 5) });
  let throttles = 0;
  const inner = w.host.rpcs[1];
  w.host.rpcs = [w.host.rpcs[0], (async (m: string, q: readonly unknown[]) => {
    if (m === "getSlot" && throttles < 3) throw (throttles++, new SolanaRpcTransportError("http_429", "HTTP 429", 3, "rpc1", null));
    return inner(m, q);
  }) as SolanaRpc];
  assert.equal((await runPoolBuy({ ...w.host, reads: 20 }, ASK) as { stage?: string }).stage, "filled");
  // three throttles (800, 1,600, 3,200), then RPC 1 a slot short on two reads that went through: the slot's time each,
  // not 3,200
  assert.deepEqual(w.waits, [800, 1_600, 3_200, SLOT_MS, SLOT_MS], w.waits.join(","));
});

test("review P3d of 1caf0b17: a finalized-slot read that fails asks no settle that round", async () => {
  let fails = 0;
  const w = await world();
  const inner = w.host.rpcs[1];
  w.host.rpcs = [w.host.rpcs[0], (async (m: string, q: readonly unknown[]) => {
    if (m === "getSlot" && fails < 2) throw (fails++, new Error("rpc1: socket hang up"));
    return inner(m, q);
  }) as SolanaRpc];
  assert.equal((await runPoolBuy({ ...w.host, reads: 10 }, ASK) as { stage?: string }).stage, "filled");
  assert.equal(w.log.filter((x) => x === "settle:note-1").length, 1);
  assert.equal(w.log.slice(0, w.log.indexOf("settle:note-1")).filter((x) => x === "0:getSlot").length, 3, "the settle only on the third round, the first whose read went through");
});

test("review P3d of 1caf0b17: a Retry-After past POOL_BUY_RETRY_AFTER_MAX_MS (60 s) waits 10 s, never the provider's word", async () => {
  const w = await world();
  let once = false;
  const inner = w.host.rpcs[1];
  w.host.rpcs = [w.host.rpcs[0], (async (m: string, q: readonly unknown[]) => {
    if (m === "getTransaction" && !once) throw ((once = true), new SolanaRpcTransportError("http_429", "HTTP 429", 3, "rpc1", 60_000));
    return inner(m, q);
  }) as SolanaRpc];
  assert.equal((await runPoolBuy({ ...w.host, reads: 10 }, ASK) as { stage?: string }).stage, "filled");
  assert.deepEqual(w.waits, [10_000]);
});

test("review P3e of 1caf0b17: a Retry-After that is no number (NaN) never becomes the wait: the doubling wait instead", async () => {
  const w = await world();
  let once = false;
  const inner = w.host.rpcs[1];
  w.host.rpcs = [w.host.rpcs[0], (async (m: string, q: readonly unknown[]) => {
    if (m === "getTransaction" && !once) throw ((once = true), new SolanaRpcTransportError("http_429", "HTTP 429", 3, "rpc1", Number.NaN));
    return inner(m, q);
  }) as SolanaRpc];
  assert.equal((await runPoolBuy({ ...w.host, reads: 10 }, ASK) as { stage?: string }).stage, "filled");
  assert.deepEqual(w.waits, [800]);
});

// Card signpage-throttled-read-is-not-asked-again-at-once (the review of PR #604, pool-buy.ts's landed loop): every read
// of the buy that fails waits the one rule's growing pause (the wallet's throttleWaitMs, from the slot's pace to
// POOL_BUY_BACKOFF_MAX_MS, a Retry-After when longer), a 503 as a 429, back to the pace only after a round that went
// through whole. Before: a read that failed without a 429 was asked again at the slot's pace (300 asks in 120 s), and a
// failed whose-spend read after the settle, 429 or not, the same.
const shift = (w: World, at: (p: 0 | 1, method: string, now: number) => Error | null) => {
  let t = 0;
  const inner = w.host.rpcs;
  const seat = (p: 0 | 1): SolanaRpc => (async (method: string, params: readonly unknown[]) => {
    const e = at(p, method, t);
    if (e) throw e;
    return inner[p](method, params);
  }) as SolanaRpc;
  return { host: { ...w.host, rpcs: [seat(0), seat(1)] as [SolanaRpc, SolanaRpc], reads: POOL_BUY_READS, now: () => BigInt(t), wait: async (ms: number) => void ((t += ms), w.waits.push(ms)) } as PoolBuyHost, t: () => t };
};
const fiveOhThree = () => new SolanaRpcTransportError("http_5xx", "HTTP 503", 3, "rpc1", null);

test("a 503 on one RPC's finalized slot after the land: the other is asked at a growing wait, not the slot's pace, and the buy fills once it answers", async () => {
  const w = await world();
  let sentAt: number | null = null, asked = 0;
  const s = shift(w, (p, m, now) => {
    if (m !== "getSlot" || sentAt === null || now - sentAt >= 60_000) return null;
    if (p === 0) return asked++, null;
    return fiveOhThree();
  });
  const send = w.host.send;
  const host: PoolBuyHost = { ...s.host, send: async (pool, tx) => ((sentAt = s.t()), send(pool, tx)) };
  assert.equal((await runPoolBuy(host, ASK) as { stage?: string }).stage, "filled");
  // 800, 1,600, 3,200, 6,400 then the 8 s cap: about ten in 60 s, where the slot's pace is 150
  assert.ok(asked <= 15, `RPC 0's getSlot asked ${asked} times in 60 s of RPC 1's 503`);
});

test("a whose-spend read that fails after the settle (a 429, Retry-After 5 s) is asked again after that wait, not at the slot's pace", async () => {
  const w = await world();
  let settledAt: number | null = null, asked = 0;
  const s = shift(w, (p, m, now) => {
    if (m !== "getTransaction" || p !== 1 || settledAt === null || now - settledAt >= 60_000) return null;
    asked++;
    return new SolanaRpcTransportError("http_429", "HTTP 429", 3, "rpc1", 5_000);
  });
  const settle = w.host.settle;
  const host: PoolBuyHost = { ...s.host, settle: async (id, m) => ((settledAt ??= s.t()), settle(id, m)) };
  assert.equal((await runPoolBuy(host, ASK) as { stage?: string }).stage, "filled");
  assert.ok(asked <= 13, `RPC 1's getTransaction asked ${asked} times in 60 s of 429 (Retry-After 5 s)`);
});

test("a read-back that fails without a 429 (a 503 for 30 s) waits the same growing pause as a throttle", async () => {
  const w = await world();
  let asked = 0;
  const s = shift(w, (p, m, now) => (m === "getTransaction" && p === 1 && now < 30_000 ? (asked++, fiveOhThree()) : null));
  assert.equal((await runPoolBuy(s.host, ASK) as { stage?: string }).stage, "filled");
  assert.ok(asked <= 8, `${asked} calls in 30 s of 503`);
  assert.ok(w.waits.every((ms) => ms <= 8_000), w.waits.join(","));
});

test("the read-back's growing wait under a 429 (Retry-After 7 s) never runs past the blockhash's life: a read comes at its end", async () => {
  const w = await world();
  let t = 0;
  const spans: [number, number][] = [];
  const inner = w.host.rpcs;
  const seat = (p: 0 | 1): SolanaRpc => (async (method: string, params: readonly unknown[]) => {
    if (method === "getTransaction" && p === 1 && t < 100_000) throw new SolanaRpcTransportError("http_429", "HTTP 429", 3, "rpc1", 7_000);
    return inner[p](method, params);
  }) as SolanaRpc;
  const host: PoolBuyHost = { ...w.host, rpcs: [seat(0), seat(1)], reads: POOL_BUY_READS, now: () => BigInt(t), wait: async (ms) => void (spans.push([t, ms]), (t += ms)) };
  assert.equal((await runPoolBuy(host, ASK) as { stage?: string }).stage, "filled");
  const across = spans.filter(([at, ms]) => at < POOL_BLOCKHASH_LIFE_MS && at + ms > POOL_BLOCKHASH_LIFE_MS);
  assert.deepEqual(across, [], `a wait across the blockhash's end: ${across.map(([a, m]) => `${a}+${m}`).join(", ")}`);
  assert.ok(spans.some(([at, ms]) => at + ms === POOL_BLOCKHASH_LIFE_MS), "a read at the blockhash's end");
});

test("the not-landed reads: a 503 on one RPC's height read waits the growing pause, and once it answers the reads go back to their second", async () => {
  // the helper refuses the send (no busy): the reads decide; each RPC's finalized height stays short of the blockhash's
  // last until 100 s, RPC 1's read failing with a 503 for the first 60 s
  const w = await world();
  let t = 0, hot = 0, after = 0;
  const inner = w.host.rpcs;
  const seat = (p: 0 | 1): SolanaRpc => (async (method: string, params: readonly unknown[]) => {
    if (method === "getEpochInfo" && t < 100_000) {
      if (p === 0) t < 60_000 ? hot++ : after++;
      if (p === 1 && t < 60_000) throw new SolanaRpcTransportError("http_5xx", "HTTP 503", 3, "rpc1", null);
      return { blockHeight: 0, absoluteSlot: 0 };
    }
    return inner[p](method, params);
  }) as SolanaRpc;
  const host: PoolBuyHost = { ...w.host, rpcs: [seat(0), seat(1)], reads: POOL_BUY_READS, now: () => BigInt(t), wait: async (ms) => void (t += ms),
    send: async () => { throw new Error("HTTP 502"); } };
  const a = (await runPoolBuy(host, ASK)) as { stage?: string };
  assert.notEqual(a.stage, "filled");
  assert.ok(hot <= 15, `RPC 0's height read ${hot} times in 60 s of RPC 1's 503, where a second's pace is 60`);
  assert.ok(after >= 20, `${after} reads in the 40 s after RPC 1 answers: back to a second's pace`);
});
