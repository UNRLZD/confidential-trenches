// The app's own Withdraw (card withdraw-address-in-the-app, owner 14 Nov 12:22Z picked A on
// https://claude.ai/artifact/AQ5Dc4wAfjqMk3JQHMgyAg): the amount and the address are typed in the app's sheet, then
// SIGN_HOST checks both again with its own rules (packages/signpage/src/withdraw: form.ts, pool-form.ts) and shows them
// on its Confirm sheet over the dimmed app. The checks here are the shape only, so Withdraw is on for an address of the
// chain the money arrives on and an amount the place holds; what is sent is decided on the signing page, never here.
// Card withdraw-in-app-to-any-chain: a pool's money arrives on any chain (the kit's pool.withdraw `dest`, paid out through
// 1Click; packages/signpage/src/withdraw/pool-form.ts refuses a dest the pool does not pay out to), so the form picks
// the arrival chain and the address is checked on it. Card cash-withdraw-in-app-to-any-chain: Cash arrives on each chain
// of the kit's CASH_WITHDRAW_DESTS, the one list SIGN_HOST's Cash form sends to (NEAR alone until a refunded send can come
// back to Cash), and the tap's withdraw.open carries `dest` when it is not NEAR.
import { CASH_WITHDRAW_DESTS, type PoolChain, type SignpageParams } from "@blindfill/kit";
import { DESTS } from "../deposit/model.ts";
import type { WithdrawPlace } from "./target.ts";

/** A chain the money can arrive on: the kit's pool.withdraw dest (the deposit's To places, in the same order). */
export type Arrival = NonNullable<SignpageParams["pool.withdraw"]["dest"]>;

// nearcore's account id rule, as packages/signpage/src/withdraw/checks.ts addressForm
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
/** Each asset's decimals; one not listed is read as 18 (ETH's), the most a typed amount may carry. */
const DECIMALS: Readonly<Record<string, number>> = { USDC: 6, SOL: 9, ETH: 18 };

/** The bytes a base58 string decodes to, or null for a character outside the alphabet. */
function base58Bytes(s: string): number | null {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let lead = 0;
  while (lead < s.length && s[lead] === "1") lead++;
  let bytes = 0;
  for (; n > 0n; n >>= 8n) bytes++;
  return lead + bytes;
}

/** Where a place's money can arrive: a pool's on every chain (its own and each 1Click pays out to), Cash's on each chain
 *  SIGN_HOST's Cash form sends to (the kit's CASH_WITHDRAW_DESTS). */
export function arrivals(place: WithdrawPlace): readonly Arrival[] {
  return place.kind === "pool.withdraw" ? DESTS : CASH_WITHDRAW_DESTS;
}

/** Whether `typed` is an address of the arrival chain: a NEAR account on NEAR, a 32-byte key on Solana, 0x and 40 hex on an EVM chain. */
export function addressFits(chain: Arrival, typed: string): boolean {
  const to = typed.trim();
  if (chain === "near") return to.length >= 2 && to.length <= 64 && ACCOUNT.test(to);
  if (chain === "solana") return to.length >= 32 && to.length <= 44 && base58Bytes(to) === 32;
  return EVM.test(to);
}

/** A decimal string as base units of `decimals`, or null (not a plain decimal, or finer than the asset). */
export function units(typed: string, decimals: number): bigint | null {
  const m = DECIMAL.exec(typed.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export type FieldCheck = "empty" | "bad" | "ok";
export type FormCheck = { amount: FieldCheck; address: FieldCheck; ready: boolean };

/** The two fields' shape: an amount above zero and at most the place's balance (or Max), an address of the arrival chain
 *  (one the place cannot reach fits no address). */
export function checkWithdraw(place: WithdrawPlace, dest: Arrival, amount: string, address: string, max: boolean): FormCheck {
  const d = DECIMALS[place.symbol] ?? 18;
  const held = units(place.balance, d) ?? 0n;
  const v = max ? held : units(amount, d);
  const a: FieldCheck = !max && amount.trim() === "" ? "empty" : v !== null && v > 0n && v <= held ? "ok" : "bad";
  const t: FieldCheck = address.trim() === "" ? "empty" : arrivals(place).includes(dest) && addressFits(dest, address) ? "ok" : "bad";
  return { amount: a, address: t, ready: a === "ok" && t === "ok" };
}

type Given = { to: string; amount: string } | { to: string; max: true };
export type WithdrawHop = { kind: "withdraw.open"; params: Given & { dest?: Arrival } } | { kind: "pool.withdraw"; params: Given & { chain: PoolChain; dest?: Arrival } };

/** What the Withdraw tap sends SIGN_HOST: the place's kind with the address and the amount, or Max (the signing page's
 *  live Max), with `dest` when the money arrives on another chain than the place's own (a pool's chain, Cash's NEAR;
 *  the kit takes dest only with to). */
export function withdrawHop(place: WithdrawPlace, dest: Arrival, amount: string, address: string, max: boolean): WithdrawHop {
  const to = address.trim();
  const given: Given = max ? { to, max: true } : { to, amount: amount.trim() };
  if (place.kind !== "pool.withdraw") return { kind: "withdraw.open", params: { ...given, ...(dest !== "near" ? { dest } : {}) } };
  return { kind: "pool.withdraw", params: { chain: place.chain, ...given, ...(dest !== place.chain ? { dest } : {}) } };
}
