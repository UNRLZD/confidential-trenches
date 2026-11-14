// The withdraw form's checks (card signpage-withdraw-form; docs/plan1/wallet.md §2.8 the withdraw.open rows W:927-930,
// WU-05 W:1067; app.md CH-075, CH-078 A:996-999 and AM-09 A:1272, at research 3a705af). SIGN_HOST's top-level form
// takes where the money goes and how much, typed by the user, never passed in by the app, and refuses a bad one before
// any proof is made. Every input but the device's own is hostile: the RPC answers are read on the network's release
// pair and must agree.
//
// - The address is a NEAR account id (nearcore's account id rule: 2-64 characters, lowercase letters and digits in
//   parts joined by "-" or "_", the parts joined by "."). Trimmed of the spaces a paste brings; never lowercased, so
//   what is checked is what was typed. Another chain's address is refused here: this form's way out is to a NEAR
//   account (W:927-930).
// - Never the release's vault, never intents.near (the ft_withdraw row, W:930) and never the vault's token (the USDC
//   contract's own id is a 64-hex implicit id, which the implicit rule below would pass: money sent to it is stuck).
// - A named account must exist: view_account on two RPCs, both answering its view (W:927-928). Both answering
//   UNKNOWN_ACCOUNT refuses it. Anything else (one says absent and one exists, an RPC down, any other answer) is unread
//   and never passes: no account is taken on one RPC's word. The two RPCs are the network's release pair by the
//   kit's one rule (../../../kit/src/near/networks.ts nearPairNetwork), so one operator never counts as two.
// - An implicit id (64 hex, or 0x and 40 hex) passes with no read, existing or not: no stranger can create it, so a
//   typo never pays a name someone else can (W:928; WU-05: "to an absent 64-hex implicit id (signed)").
// - The amount is USDC typed as a decimal with at most the token's 6 places, in base units. It is sent from every UNSPENT
//   note of the vault's scope (card cash-withdraws-everything-to-any-chain: Cash goes out whole), one withdrawal per
//   note, each paying the relay fee on top of its part (../../../wallet/src/withdraw/request.ts: a part above its fee,
//   part + fee within its note). planCashWithdraw plans the parts on the pool form's planner (../pool-withdraw.ts
//   planPoolWithdraw: the fewest parts, no change between 0 and the note floor, here two fees and one unit, the least a
//   later withdrawal can send), so no withdrawal leaves a change no withdrawal could move. What can be sent (Max,
//   cashSendable) is every note that gives more than its fee, each whole, less its fee: the whole of Cash. The amount
//   is refused at or below the fee (min: the §2.8 arming row, W:915), above Max (insufficient, naming Max), and when no
//   plan sends it (unplannable, naming the nearest amounts that can be sent). The fee is the device's own bound on the
//   relay fee; until it and the notes are read, an amount is unread, never passed.
//
// Not here: the proof, the relay call and the move from the arming account to the typed account (the wallet's withdraw
// path), storage_balance_of on the typed account (the plain move out row, W:929) and withdraw.open from a one-time id.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultScopeOf } from "../../../kit/src/vault/shapes.ts";
import { NEAR_NETWORKS, type NearNetwork, nearPairNetwork, nearPairRule, type NearRpc } from "../../../kit/src/near/networks.ts";
import type { NoteRecord } from "../../../wallet/src/notes/store.ts";
import { nearestPlannable, planPoolWithdraw, WITHDRAW_PLAN_NOTES, type WithdrawCosts, type WithdrawPart, type WithdrawSource } from "../pool-withdraw.ts";

/** intents.near: an ft_withdraw out of it may never name it (W:930), and nothing sent to it is the user's. */
export const INTENTS = "intents.near";
/** The vault's token's places: USDC, 6. */
export const TOKEN_DECIMALS = 6;

export type AddressCode = "not-account" | "vault" | "intents" | "token" | "no-account" | "unread";
export type AmountCode = "amount" | "min" | "insufficient" | "unplannable" | "unread";
export type RecipientCheck = { ok: true; recipient: string } | { ok: false; code: AddressCode };
export type AmountCheck =
  | { ok: true; amount: bigint; parts: readonly WithdrawPart[] }
  | { ok: false; code: "min"; min: bigint }
  | { ok: false; code: "insufficient"; below?: bigint }
  | { ok: false; code: "unplannable"; below?: bigint; above?: bigint }
  | { ok: false; code: Exclude<AmountCode, "min" | "insufficient" | "unplannable"> };

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT = /^([0-9a-f]{64}|0x[0-9a-f]{40})$/;

/** The typed address as a NEAR account id, or null: `implicit` for 64 hex or 0x and 40 hex, else `named`. */
export function addressForm(typed: unknown): { account: string; kind: "implicit" | "named" } | null {
  if (typeof typed !== "string") return null;
  const account = typed.trim();
  if (account.length < 2 || account.length > 64 || !ACCOUNT.test(account)) return null;
  return { account, kind: IMPLICIT.test(account) ? "implicit" : "named" };
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** One RPC's view_account answer: the account's view, UNKNOWN_ACCOUNT, or anything else. */
function seen(answer: unknown): "exists" | "absent" | "unread" {
  if (!isObj(answer)) return "unread";
  const { result, error } = answer;
  if (result !== undefined && error === undefined) {
    const ok = isObj(result) && Number.isSafeInteger(result.block_height) && typeof result.amount === "string" && typeof result.code_hash === "string";
    return ok ? "exists" : "unread";
  }
  if (error !== undefined && result === undefined && isObj(error) && isObj(error.cause) && error.cause.name === "UNKNOWN_ACCOUNT") return "absent";
  return "unread";
}

/**
 * The typed address checked for `network` on its release pair `rpcs` (each NearRpc's name is its exact URL). A pair
 * that is not the network's throws: that is the page's own mistake, never the user's.
 */
export async function checkRecipient(typed: unknown, network: NearNetwork, rpcs: readonly [NearRpc, NearRpc]): Promise<RecipientCheck> {
  if (typeof network !== "string" || !Object.hasOwn(NEAR_NETWORKS, network) || nearPairNetwork(rpcs) !== network) throw new Error(nearPairRule(Object.hasOwn(NEAR_NETWORKS, network) ? network : undefined));
  const net = NEAR_NETWORKS[network];
  const form = addressForm(typed);
  if (form === null) return { ok: false, code: "not-account" };
  const { account } = form;
  if (net.vault !== null && account === net.vault) return { ok: false, code: "vault" };
  if (account === INTENTS) return { ok: false, code: "intents" };
  if (account === net.usdc) return { ok: false, code: "token" };
  if (form.kind === "implicit") return { ok: true, recipient: account };
  const params = { request_type: "view_account", account_id: account, finality: "final" };
  const reads = await Promise.all(rpcs.map((r) => r.query(params).then(seen, () => "unread" as const)));
  if (reads[0] === "exists" && reads[1] === "exists") return { ok: true, recipient: account };
  if (reads[0] === "absent" && reads[1] === "absent") return { ok: false, code: "no-account" };
  return { ok: false, code: "unread" };
}

const AMOUNT = new RegExp(`^(\\d{0,30})(?:\\.(\\d{0,${TOKEN_DECIMALS}}))?$`);

/** The typed amount in the token's base units, or null when it is not a plain decimal with at most 6 places. */
export function parseAmount(typed: unknown): bigint | null {
  if (typeof typed !== "string") return null;
  const m = AMOUNT.exec(typed.trim());
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  return BigInt(m[1] || "0") * 10n ** BigInt(TOKEN_DECIMALS) + BigInt((m[2] ?? "").padEnd(TOKEN_DECIMALS, "0") || "0");
}

/** A Cash withdrawal's costs in the pool planner's terms: each part pays the relay fee and no W's fee, a part is above
 *  the fee (the request refuses a fee at or above the amount), so a change is 0 or above two fees (withdrawNoteFloor):
 *  one a later withdrawal can still send. */
export const cashCosts = (fee: bigint): WithdrawCosts => ({ fee, wFee: 0n, minPart: fee + 1n });

/** The notes that can give a part: each sends more than its fee. Largest first, then by id. */
const giving = (notes: readonly WithdrawSource[], fee: bigint): WithdrawSource[] =>
  notes.filter((n) => n.value - fee > fee).sort((x, y) => (x.value !== y.value ? (x.value > y.value ? -1 : 1) : x.id < y.id ? -1 : 1));
const whole = (n: WithdrawSource, fee: bigint): WithdrawPart => ({ noteId: n.id, part: n.value - fee, chunk: n.value });

/** What Cash can send now (Max): every note that gives more than its fee, each whole, less its fee. 0n when none. */
export function cashSendable(notes: readonly WithdrawSource[], fee: bigint): bigint {
  return giving(notes, fee).reduce((t, n) => t + n.value - fee, 0n);
}

/**
 * The withdrawals that send `amount` from `notes` at `fee` each, largest note first; null when no plan does. Max
 * (cashSendable) is every giving note whole, at any count of notes. Any other amount is the pool planner's plan
 * (planPoolWithdraw: the fewest parts, every change 0 or above the note floor), which reads the WITHDRAW_PLAN_NOTES
 * largest notes; past that many, the largest note goes whole and the rest is planned the same way, so a Cash of many
 * small notes still sends what its notes hold. The one planner for every Cash spend (the form and cashMover).
 */
export function planCashWithdraw(notes: readonly WithdrawSource[], amount: bigint, fee: bigint): WithdrawPart[] | null {
  if (typeof amount !== "bigint" || typeof fee !== "bigint" || fee < 0n || amount <= fee) return null;
  const all = giving(notes, fee);
  if (amount === cashSendable(all, fee)) return all.map((n) => whole(n, fee));
  if (all.length <= WITHDRAW_PLAN_NOTES) return planPoolWithdraw(all, amount, cashCosts(fee));
  const [first, ...rest] = all as [WithdrawSource, ...WithdrawSource[]];
  const tail = amount > first.value - fee ? planCashWithdraw(rest, amount - (first.value - fee), fee) : null;
  return tail !== null ? [whole(first, fee), ...tail] : planPoolWithdraw(all, amount, cashCosts(fee));
}

/**
 * The typed amount against `notes` (the vault scope's UNSPENT notes, cashNotes) and `fee` (the device's bound on the
 * relay fee per withdrawal), each null until read (an amount that needs it is then unread, never passed): above the fee
 * (`min` is the smallest amount that is), at most Max (`below` names it), and sent by a plan (`parts`), else the nearest
 * amounts that are.
 */
export function checkAmount(typed: unknown, { notes, fee }: { notes: readonly WithdrawSource[] | null; fee: bigint | null }): AmountCheck {
  const amount = parseAmount(typed);
  if (amount === null) return { ok: false, code: "amount" };
  if (fee !== null && amount <= fee) return { ok: false, code: "min", min: fee + 1n };
  if (notes === null) return { ok: false, code: "unread" };
  // no note at all: nothing can be sent at any fee
  if (!notes.some((n) => n.value > 0n)) return { ok: false, code: "insufficient" };
  // the fee unread: what can be sent is not known yet, so the amount waits (unread)
  if (fee === null) return { ok: false, code: "unread" };
  const can = cashSendable(notes, fee);
  if (amount > can) return can > 0n ? { ok: false, code: "insufficient", below: can } : { ok: false, code: "insufficient" };
  const parts = planCashWithdraw(notes, amount, fee);
  if (parts === null) return { ok: false, code: "unplannable", ...nearestPlannable(giving(notes, fee), amount, cashCosts(fee)) };
  return { ok: true, amount, parts };
}

/** The amount the Cash form sends for a typed one (card withdraw-max-means-all): the typed amount when a plan sends it,
 *  else the nearest a plan sends at or below it, Max above everything; nothing at or below it is refused with the least
 *  plannable amount, in the Min words. No Try: the form never asks for a pick. */
export function payableAmount(typed: unknown, reads: { notes: readonly WithdrawSource[] | null; fee: bigint | null }): AmountCheck {
  const c = checkAmount(typed, reads);
  if (c.ok || (c.code !== "insufficient" && c.code !== "unplannable")) return c;
  if (c.below !== undefined) {
    const at = checkAmount(unitsText(c.below), reads);
    if (at.ok) return at;
  }
  return c.code === "unplannable" && c.above !== undefined ? { ok: false, code: "min", min: c.above } : c.code === "insufficient" ? { ok: false, code: "insufficient" } : c;
}

/** Base units as the plain decimal parseAmount reads. */
const unitsText = (units: bigint): string => {
  const s = units.toString().padStart(TOKEN_DECIMALS + 1, "0");
  return `${s.slice(0, -TOKEN_DECIMALS)}.${s.slice(-TOKEN_DECIMALS)}`;
};

/** The vault scope's UNSPENT notes, each as a source a Cash plan may spend. */
export function cashNotes(notes: readonly NoteRecord[], scope: bigint): WithdrawSource[] {
  return notes.filter((n) => n.state === "UNSPENT" && n.scope === scope && n.leaf !== undefined).map((n) => ({ id: n.id, value: n.leaf!.value }));
}

/** The largest UNSPENT note's value in `scope`: what one withdrawal can pay, its fee included. */
export function withdrawable(notes: readonly NoteRecord[], scope: bigint): bigint {
  let most = 0n;
  for (const n of notes) if (n.state === "UNSPENT" && n.scope === scope && n.leaf !== undefined && n.leaf.value > most) most = n.leaf.value;
  return most;
}

/** The vault's scope on `network`, or null while the release names no vault there. */
export function vaultScope(network: NearNetwork): bigint | null {
  const net = NEAR_NETWORKS[network];
  return net.vault === null ? null : vaultScopeOf(keccak_256, net.vault, net.usdc);
}
