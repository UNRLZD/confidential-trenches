// To, on a chain the page pays out to: the one address rule of every withdraw form (moved whole from ./pool-form.ts,
// card cash-withdraws-everything-to-any-chain, so the vault form's chains (./onward.ts) and the pool form share it with
// no import cycle: this file imports no form). On Solana 32 bytes of base58 (the rules' SOL_KEY), never a key the
// caller names or a key the runtime keeps read-only (SOLANA_RESERVED_KEYS); on Base and Robinhood 0x and 40 hex digits
// (EVM_ADDRESS), its EIP-55 checksum right when it mixes cases, never the zero address or the caller's pool. A pasted To
// is cleaned of what a copy carries first (toCleaned; ./pool-form.ts's header says what and why).
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58 } from "@scure/base";
import { EVM_ADDRESS, SOL_KEY, SOLANA_RESERVED_KEYS, type PoolChain } from "../rules/pool.ts";

/** The pool's own addresses no withdraw may send to (the pin's). */
export type PoolKeys = { pool: string; program?: string; feePayer?: string };
export type PoolAddressCode = "address";
export type PoolAddressCheck = { ok: true; to: string } | { ok: false; code: PoolAddressCode };

export const EVM_ZERO = "0x0000000000000000000000000000000000000000";

/** EIP-55: the checksummed spelling of a 0x address (hex digit i upper case when nibble i of keccak256(lower) >= 8). */
export function eip55(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const h = keccak_256(new TextEncoder().encode(lower));
  return "0x" + [...lower].map((c, i) => (((h[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 15) >= 8 ? c.toUpperCase() : c)).join("");
}

/** What a copy carries around an address: whitespace and invisible format characters at either end. */
const ENDS = /^[\p{White_Space}\p{Cf}]+|[\p{White_Space}\p{Cf}]+$/gu;
/** The invisible joiners a copy can leave inside an address: zero-width space, non-joiner and joiner, word joiner,
 *  byte-order mark, soft hyphen. They separate nothing a person sees. */
const JOINERS = /[​‌‍⁠﻿­]/gu;
/** The direction controls (Arabic letter mark, LRM and RLM, the embeddings and overrides, the isolates): a field holding
 *  one can show other characters, or another order, than it holds. */
const DIRECTION = /[؜‎‏‪-‮⁦-⁩]/u;

/** A typed or pasted To with what a copy carries taken out (ENDS, then JOINERS); null when it holds a direction control. */
export const toCleaned = (raw: string): string | null => (DIRECTION.test(raw) ? null : raw.replace(ENDS, "").replace(JOINERS, ""));

/** To, on the pool's chain. */
export function checkPoolTo(chain: PoolChain, raw: string, keys: PoolKeys): PoolAddressCheck {
  const to = toCleaned(raw);
  const no: PoolAddressCheck = { ok: false, code: "address" };
  if (to === null) return no;
  if (chain === "solana") {
    if (!SOL_KEY(to) || base58.encode(base58.decode(to)) !== to) return no;
    // nor a key the runtime keeps read-only (a sysvar or a builtin program, System among them): nothing lands there
    if ([keys.pool, keys.program, keys.feePayer].includes(to) || SOLANA_RESERVED_KEYS.includes(to)) return no;
    return { ok: true, to };
  }
  if (!EVM_ADDRESS.test(to)) return no;
  const hex = to.slice(2);
  if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && eip55(to) !== to) return no;
  const lower = to.toLowerCase();
  if (lower === EVM_ZERO || lower === keys.pool.toLowerCase()) return no;
  return { ok: true, to: eip55(to) };
}
