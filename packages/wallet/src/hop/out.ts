// A hop's first leg: the vault pays whole dollars to the device's own fresh NEAR accounts (card wallet-hop-out). A move
// of Cash into chain X's pool goes vault -> A -> 1Click -> U_X, so a failed swap refunds to A on NEAR (ORIGIN_CHAIN,
// card wallet-hop-onward), never into intents.near, whose DAO can freeze or move any balance held there; this file is
// the vault -> A part, on the device, before anything is sent.
//
// - The amount is whole dollars, split into the USDC ladder's rungs (pool/near.ts USDC_LADDER: 1-2-5 per power of ten
//   from $2, as every pool's ladder), largest first (pool/ladder.ts ladderSplit): 7 USDC is 5 + 2. An amount the rungs
//   do not cover exactly is refused; the caller sizes it with hopRungs first. Each rung is one withdrawal of the rung
//   plus the relay fee from one note, so every A receives exactly a rung, a size every hop of every user shares.
// - The notes: each rung, largest first, takes the smallest UNSPENT note of the vault's scope covering the rung and its
//   fee that no larger rung took (withdraw/request.ts's own pick rule, one note a rung). Since a note that covers a
//   rung covers every smaller one, largest first and smallest fit pays every rung whenever any one-note-a-rung choice
//   does. Rungs the notes cannot pay one each are refused before anything is read, written or proved.
// - A is A_{l,j} of each note's withdrawal (derive armAccount, the change index of the spent note, as withdrawRequest
//   derives it with no typed account): never a W or a U path, so a move and a buy cannot be tied by address. Its secret
//   key is zeroed at once. The vault funds A's creation (fund_recipient true; the relayer's card relayer-fresh-near).
// - register_deposit is the caller's two-RPC read for each A (arming/accounts.ts armingRegisterDepositOf, the token's
//   storage minimum), and fee_max is the device's own (withdraw/feemax.ts) at the largest of them: a relay fee above it,
//   or a read either RPC refuses, stops the hop before anything is written or proved.
// - Before the first proof the hop is written: its record in "quotes" under HOP_KEY + id (X, the amount, each rung's
//   note, (l, j) and A, "planned"), which no APP_HOST frame opens, and its op in "ops" ({ kind "hop", stage
//   "in_flight" }, the kit's frozen hop op). A page that dies mid-hop leaves every A named; a restore from the 12 words
//   finds each A without the record, as it reads A_{l,j} of every withdrawal it finds (restore/arms.ts).
// - Then each rung is withdrawRequest's arming path pinned to its planned note: HELD, proved, RESERVED with its request
//   body, as every withdrawal (so the settle pass sends it again after a page death). Each RESERVED rung is marked on
//   the record. A rung whose proof fails frees its note (withdrawRequest) and ends the hop there: the rungs already
//   RESERVED are handed back to be sent, the failed one and any after it are marked refused. A hop whose first rung
//   fails sent nothing: its record and op are deleted and the error reaches the caller.
// Not here: the send to the relayer and its follow (withdraw handoff), A's move on to U_X (wallet-hop-onward), the
// page's op wiring (signpage-hop-kind). Nothing here logs.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultScopeOf } from "@blindfill/kit";
import { NEAR_NETWORKS } from "../deposit/account.ts";
import { POOL_DEPOSIT_DESTINATION, type PoolDepositChain } from "../deposit/quote.ts";
import { armAccount, changeIndex } from "../derive/index.ts";
import type { NoteRecord } from "../notes/store.ts";
import { ladderSplit } from "../pool/ladder.ts";
import { USDC_LADDER } from "../pool/near.ts";
import type { WalletStore } from "../store/index.ts";
import { readWithdrawFeeMax } from "../withdraw/feemax.ts";
import { withdrawRequest, type WithdrawRequest, type WithdrawRequestArgs } from "../withdraw/request.ts";

/** The hop record's key prefix in the wallet store's "quotes". */
export const HOP_KEY = "hop/";
const HOP_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type HopRungState = "planned" | "reserved" | "refused";
export type HopRung = { rung: bigint; note: string; l: bigint; j: number; a: string; state: HopRungState; error?: string };
/** A hop's record: X, the amount asked, and each rung's note, (l, j) and A_{l,j}. */
export type HopRecord = { v: 1; id: string; chain: PoolDepositChain; amount: bigint; created_ms: number; rungs: HopRung[] };

export type HopOutArgs = Omit<WithdrawRequestArgs, "to" | "note" | "amount" | "claim"> & {
  /** The hop's op id (the request's). */
  id: string;
  /** X: the pool the money goes into. */
  chain: PoolDepositChain;
  /** Whole USDC rungs, in base units (hopRungs). */
  amount: bigint;
  store: Pick<WalletStore, "update" | "delete">;
  /** The op's created_ms: the caller's clock (the vault never reads it). */
  createdMs: number;
};

export type HopOut = {
  record: HopRecord;
  /** One request per RESERVED rung, in rung order, ready for POST /v1/withdraw. */
  requests: WithdrawRequest[];
  /** The rung whose proof failed, when the hop stopped after RESERVED ones. */
  failed?: { rung: bigint; error: string };
};

/** The rungs a hop of `amount` moves, largest first, and what no rung covers. */
export function hopRungs(amount: bigint): { rungs: bigint[]; left: bigint } {
  const { notes, left } = ladderSplit(USDC_LADDER, amount);
  return { rungs: notes, left };
}

const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** Plans, records and proves a hop's withdrawals to its A_{l,j}; refused with nothing written before the record. */
export async function hopOut(a: HopOutArgs): Promise<HopOut> {
  if (!(a.seed64 instanceof Uint8Array) || a.seed64.length !== 64) throw new Error("seed64: not 64 bytes");
  const seed = Uint8Array.from(a.seed64);
  try {
    const { id, chain, amount, store, relayFee, token, vaultId, network } = a;
    if (typeof id !== "string" || !HOP_ID.test(id)) throw new Error("id: 1-128 letters, digits and ._:-");
    if (typeof chain !== "string" || !Object.hasOwn(POOL_DEPOSIT_DESTINATION, chain)) throw new Error(`chain: no pool on ${String(chain)}`);
    if (!Number.isSafeInteger(a.createdMs)) throw new Error("createdMs: not a whole number");
    if (typeof amount !== "bigint" || amount <= 0n) throw new Error("amount: 0 or less");
    const { rungs, left } = hopRungs(amount);
    if (left !== 0n) throw new Error("amount: not whole rungs of the USDC ladder (hopRungs)");
    if (typeof relayFee !== "bigint" || relayFee < 0n) throw new Error("relayFee: not a bigint of 0 or more");
    if (typeof network !== "string" || !Object.hasOwn(NEAR_NETWORKS, network)) throw new Error(`network: unknown ${String(network)}`);
    if (token !== NEAR_NETWORKS[network].usdc) throw new Error("token: not the network's own (fee_max is in its unit)");

    // one note a rung, largest rung first, the smallest note that covers it and its fee
    const scope = vaultScopeOf(keccak_256, vaultId, token);
    const open = (await a.notes.list()).filter((n) => n.scope === scope && n.leaf !== undefined && n.state === "UNSPENT");
    open.sort((x, y) => (x.leaf!.value < y.leaf!.value ? -1 : x.leaf!.value > y.leaf!.value ? 1 : Number(x.leaf!.leafIndex - y.leaf!.leafIndex)));
    const taken = new Set<string>();
    const plan: { rung: bigint; note: NoteRecord; j: number; a: string }[] = [];
    for (const rung of rungs) {
      const note = open.find((n) => !taken.has(n.id) && n.leaf!.value >= rung + relayFee);
      if (note === undefined) throw new Error(`note: no unspent note covers the ${rung} rung and its fee beside the hop's larger rungs`);
      taken.add(note.id);
      const j = note.ref.kind === "change" ? changeIndex({ kind: "change", j: note.ref.j }) : changeIndex({ kind: "deposit" });
      const arm = armAccount(seed, note.leaf!.label, j);
      arm.secretKey.fill(0);
      plan.push({ rung, note, j, a: arm.id });
    }

    // register_deposit for each A on two RPCs, and the device's fee_max, before anything is written
    let registerDeposit = 0n;
    for (const p of plan) {
      const r = await a.registerDepositOf(p.a, token);
      if (typeof r !== "bigint" || r < 0n) throw new Error("registerDepositOf: not a bigint");
      if (r > registerDeposit) registerDeposit = r;
    }
    const feeMax = await readWithdrawFeeMax({ network, rpcs: a.rpcs, priceRpcs: a.priceRpcs, registerDeposit });
    if (relayFee > feeMax) throw new Error("relayFee: above the device's fee_max");

    const key = HOP_KEY + id;
    const record: HopRecord = {
      v: 1,
      id,
      chain,
      amount,
      created_ms: a.createdMs,
      rungs: plan.map((p) => ({ rung: p.rung, note: p.note.id, l: p.note.leaf!.label, j: p.j, a: p.a, state: "planned" })),
    };
    if ((await store.update("quotes", key, (v) => (v === undefined ? record : undefined))) === undefined) throw new Error(`hop: ${id} is already recorded`);
    const op = { kind: "hop", stage: "in_flight", txs: [], created_ms: a.createdMs };
    if ((await store.update("ops", id, (v) => (v === undefined ? op : undefined))) === undefined) {
      await store.delete("quotes", key);
      throw new Error(`hop: ${id} is already recorded as an op`);
    }
    // rung k RESERVED; or rung k refused with its error, and every rung after it refused (never tried)
    const mark = async (k: number, state: HopRungState, error?: string): Promise<void> => {
      const next = (rs: HopRung[]): HopRung[] =>
        rs.map((x, i) => ((state === "reserved" ? i === k : i >= k) ? { ...x, state, ...(i === k && error !== undefined ? { error } : {}) } : x));
      record.rungs = next(record.rungs);
      await store.update("quotes", key, (v) => ({ ...(v as HopRecord), rungs: next((v as HopRecord).rungs) }));
    };

    const { id: _id, chain: _chain, amount: _amount, store: _store, createdMs: _created, ...withdraw } = a;
    const requests: WithdrawRequest[] = [];
    for (const [k, p] of plan.entries()) {
      try {
        requests.push(await withdrawRequest({ ...withdraw, seed64: seed, amount: p.rung, note: p.note.id }));
      } catch (e) {
        if (requests.length === 0) {
          await store.delete("ops", id);
          await store.delete("quotes", key);
          throw e;
        }
        const error = errorOf(e);
        await mark(k, "refused", error);
        return { record, requests, failed: { rung: p.rung, error } };
      }
      await mark(k, "reserved");
    }
    return { record, requests };
  } finally {
    seed.fill(0);
  }
}
