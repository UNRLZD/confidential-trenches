// The private balance per chain's pool, read from the device's own notes, and how much of it is ready to buy (card
// balances-per-chain; the signing page's state.pools, @blindfill/kit SignpageState). Pure: no store, no network, no
// clock; the caller reads the notes and hands them in.
//
// - balance: the leaf values of the pool's notes (scope === pool.scope) in UNSPENT or HELD. Not counted: PLANNED and
//   INCOMING (no value until the leaf lands; an incoming deposit shows as its op), RESERVED (its proof has left the
//   device: the buy's op shows it), SPENT and TAKEN.
// - ready: the chunks of the proof queue's ready proofs for the pool whose note is still in the store, HELD by the same
//   attempt (a proof whose note moved is not ready), each note counted once. Absent from every entry when no ready list
//   is given (no queue runs), never "0" in its place.
// - One entry per chain, in the order the chain first appears in the pool table; pools on one chain sum into it, each
//   scaled to the largest `one` among them, so an asset with more decimals adds exactly.
// - Amounts: exact decimals of base units / one, bigint only, no trailing zeros after the point, "0" for zero.
// `chain` is the app's chain (the kit's: solana, base, robinhood, near), not the derivation tag of ../derive, which
// names Base and Robinhood alike.
import { CHAINS, type Chain } from "@blindfill/kit";
import type { NoteRecord } from "../notes/store.ts";
import type { ReadyProof } from "./pool.ts";

/** A pool on the device's pool table: its id (ReadyProof.poolId), the app chain, its scope and its asset's 1.0. */
export type BalancePool = { id: string; chain: Chain; scope: bigint; one: bigint };
/** What poolBalances reads of a ready proof. */
export type BalanceProof = Pick<ReadyProof, "noteId" | "attempt" | "poolId" | "chunk">;
export type PoolBalance = { chain: Chain; balance: string; ready?: string };

/** The number of decimals of `one`, which must be a power of ten (1, 10, 100, ...). */
function decimalsOf(one: unknown, id: string): number {
  if (typeof one !== "bigint" || one < 1n || !/^10*$/.test(one.toString())) throw new Error(`pool ${id}: one is not a power of ten`);
  return one.toString().length - 1;
}

/** units / 10^d as an exact decimal string: no trailing zeros after the point, "0" for zero. */
function decimal(units: bigint, d: number): string {
  const s = units.toString().padStart(d + 1, "0");
  const int = s.slice(0, s.length - d);
  const frac = s.slice(s.length - d).replace(/0+$/, "");
  return frac === "" ? int : `${int}.${frac}`;
}

export function poolBalances(notes: readonly NoteRecord[], pools: readonly BalancePool[], ready?: readonly BalanceProof[]): PoolBalance[] {
  const ids = new Set<string>();
  const scopes = new Set<bigint>();
  // per chain, in table order: the largest decimals among its pools, then the sums in that unit
  const chains = new Map<Chain, { d: number; balance: bigint; ready: bigint }>();
  for (const p of pools) {
    if (typeof p.id !== "string" || p.id.length === 0) throw new Error("pool: no id");
    if (!(CHAINS as readonly unknown[]).includes(p.chain)) throw new Error(`pool ${p.id}: unknown chain ${String(p.chain)}`);
    if (typeof p.scope !== "bigint") throw new Error(`pool ${p.id}: scope is not a bigint`);
    const d = decimalsOf(p.one, p.id);
    // one id or one scope twice would count the same notes or proofs twice
    if (ids.has(p.id) || scopes.has(p.scope)) throw new Error(`pool ${p.id}: its id or scope is in the pool table twice`);
    ids.add(p.id);
    scopes.add(p.scope);
    const c = chains.get(p.chain);
    if (c === undefined) chains.set(p.chain, { d, balance: 0n, ready: 0n });
    else c.d = Math.max(c.d, d);
  }
  const byId = new Map(notes.map((n) => [n.id, n]));
  const counted = new Set<string>(); // a note's proof counts once
  for (const p of pools) {
    const c = chains.get(p.chain)!;
    const scale = 10n ** BigInt(c.d - decimalsOf(p.one, p.id));
    for (const n of notes) {
      if (n.scope !== p.scope || (n.state !== "UNSPENT" && n.state !== "HELD")) continue;
      const v = n.leaf?.value;
      if (typeof v !== "bigint" || v < 0n) throw new Error(`note ${n.id}: ${n.state} with no leaf value`);
      c.balance += v * scale;
    }
    for (const r of ready ?? []) {
      if (r.poolId !== p.id || counted.has(r.noteId)) continue;
      const n = byId.get(r.noteId);
      if (n === undefined || n.scope !== p.scope || n.state !== "HELD" || n.attempt !== r.attempt) continue;
      if (typeof r.chunk !== "bigint" || r.chunk < 0n) throw new Error(`ready proof for note ${r.noteId}: chunk is not a bigint`);
      counted.add(r.noteId);
      c.ready += r.chunk * scale;
    }
  }
  return [...chains].map(([chain, c]) => ({
    chain,
    balance: decimal(c.balance, c.d),
    ...(ready === undefined ? {} : { ready: decimal(c.ready, c.d) }),
  }));
}
