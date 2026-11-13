// A Base or Robinhood W's buy record, rebuilt on a device that never made the buy (a restore from the 12 words, a new
// browser), from chain data alone, so its token shows in the positions and sells (the sale finds a W only by its record,
// pool-sell-evm.ts planEvmSell). Run at each state read beside the carry (src/pool-testnet.ts), so a pass that could
// not finish runs again on the next one.
// - The Ws: each SPENT or RESERVED note of the pool's scope whose release in the pool sync's round (evmTreeSync: every
//   log of the pool, two operators out of the seats, the helper's keyed route and the public history sources answering
//   each row byte for byte) is a Bought with the note's nullifier and
//   W (freshWallet(seed, "evm", l, jOf(ref))) as its recipient. A Withdrawn (a refused buy, a withdraw) writes nothing:
//   the carry owns a refused buy's ETH (pool-carry-evm.ts). The token, the block and the buy's transaction hash are
//   that row's own (its bytes hold the hash those two operators gave).
// - The route: the buy's transaction by that hash, asked of the helper's /v1/rpc/{chain} alone (pageEvmWalletRpc,
//   decision M359), never of a public provider: a public provider asked for one device's buys together learns which
//   buys are one device's. The answer is taken only when its fields hash to the agreed hash (keccak256 of the signed
//   type 2 transaction they make), it calls the pinned pool, and its Buy (evm-send.ts evmBuyCalldataRead) buys the
//   row's token on the route the kit's builder makes (evmBuyRouteOf). So the helper can withhold a route, never forge
//   one; a withheld one is asked again at the next pass, and the kit's sell quote reads any route against the pools it
//   finds itself (packages/kit/src/checks/evm/quote.ts).
// - The token's decimals: decimals() on both pool RPCs (pool-kinds.ts keptTokenDecimals), which names only the token.
// - The write: a W that has a record keeps it (the buy's own run wrote it, pending until its follow fills it); else the
//   filled record is written once, under the store's update. Any read that fails or disagrees writes nothing. A sold
//   W's record stays filled on every device: its amount is balanceOf, so a W sold in full shows no row
//   (positions-evm.ts) and gives the sale nothing (pool-sell-evm.ts planEvmSell).
import { evmBuyRouteOf, type EvmPoolChain } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteSecrets } from "../../wallet/src/notes/secrets.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import type { EvmPoolEvent, EvmPoolPin, EvmRpc } from "../../wallet/src/pool/evm.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import type { WalletStore } from "@blindfill/wallet/store";
import { evmBuyCalldataRead } from "./evm-send.ts";
import { evmAgreedTx, evmRowTx } from "./evm-tx-hash.ts";
import { shuffled } from "./positions-evm.ts";
export { evmType2Hash } from "./evm-tx-hash.ts";
import { EVM_POSITION_COSTS_KEY, type EvmHolding } from "./pool-buy-evm.ts";
import { EVM_CARRY_DONE_KEY } from "./pool-carry-evm.ts";
import { keptTokenDecimals, type PoolRpc } from "./pool-kinds.ts";

const lower = (s: string): string => s.toLowerCase();

/** A buy's place in the round: W, the token, its block and the transaction hash the round agreed (the row's bytes:
 *  block, block hash, log index, transaction hash, ...). Null for any other row. */
export function evmBoughtOf(e: EvmPoolEvent): { w: string; token: string; block: bigint; tx: string } | null {
  if (e.kind !== "buy" || e.recipient === null || e.token === null) return null;
  const tx = evmRowTx(e);
  return tx !== null ? { w: e.recipient, token: e.token, block: e.block, tx } : null;
}

/** The route of the buy at `tx`, from the helper's answer (see the header): throws unless that answer hashes to `tx`,
 *  calls `pool` and buys `token`. */
export async function evmBuyRouteByTx(helper: EvmRpc, network: EvmPoolChain, pool: string, b: { token: string; block: bigint; tx: string }): Promise<EvmHolding["route"]> {
  const t = await evmAgreedTx(helper, b.tx);
  if (t.to !== lower(pool)) throw new Error("the transaction does not call the pool");
  const buy = evmBuyCalldataRead(t.input);
  if (buy === null || lower(buy.token) !== lower(b.token)) throw new Error("the transaction is not a Buy of the token");
  const path = evmBuyRouteOf(network, buy);
  return { venue: path.venue, adapter: lower(buy.adapter), path, tx: lower(b.tx), block: b.block.toString() };
}

export type EvmHoldingsHost = {
  chain: "base" | "robinhood";
  /** The kit's network of the pin (base, robinhood, or a testnet's). */
  network: EvmPoolChain;
  pin: EvmPoolPin;
  scope: bigint;
  /** The pool's two RPCs: the token's decimals. */
  rpcs: readonly [EvmRpc, EvmRpc];
  /** The helper's /v1/rpc/{chain}: the buys' transactions. */
  helper: EvmRpc;
  /** The pool sync's round (every row agreed byte for byte by two operators). */
  round(): Promise<{ events: readonly EvmPoolEvent[] }>;
  notes(): Promise<readonly NoteRecord[]>;
  seed64(): Promise<Uint8Array>;
  held(): Promise<Pick<WalletStore, "get" | "update">>;
  signal?: AbortSignal;
  /** The random source the buys are asked in (positions-evm.ts shuffled; crypto.getRandomValues when not given). */
  random?: (out: Uint32Array<ArrayBuffer>) => void;
};

/** One pass (see the header): the Ws whose record it wrote. */
export async function rebuildEvmHoldings(h: EvmHoldingsHost): Promise<string[]> {
  const spent = (await h.notes()).filter((n) => n.scope === h.scope && (n.state === "SPENT" || n.state === "RESERVED") && n.leaf !== undefined);
  if (spent.length === 0) return [];
  const store = await h.held();
  const keysOf = (v: unknown): string[] => Object.keys(typeof v === "object" && v !== null ? v : {}).map(lower);
  // a W with a buy record, or one the carry ended (a Withdrawn release: a refused buy or a withdraw), is never looked
  // for: a device whose spent notes all have one reads no round (a state read then costs the pool's RPCs nothing here)
  const known = new Set([...keysOf(await store.get("meta", EVM_POSITION_COSTS_KEY)), ...keysOf(await store.get("meta", EVM_CARRY_DONE_KEY))]);
  const lacking: { w: string; nullifier: bigint }[] = [];
  const seed = await h.seed64();
  try {
    for (const n of spent) {
      const k = freshWallet(seed, "evm", n.leaf!.label, jOf(n.ref));
      k.secretKey.fill(0);
      const w = lower(k.address);
      if (!known.has(w)) lacking.push({ w, nullifier: noteSecrets(seed, n.ref).nullifierHash });
    }
  } finally {
    seed.fill(0);
  }
  if (lacking.length === 0) return [];
  const { events } = await h.round();
  const buys = new Map<bigint, EvmPoolEvent>();
  for (const e of events) if (e.kind === "buy" && e.nullifier !== null) buys.set(e.nullifier, e);
  const owed: { w: string; token: string; block: bigint; tx: string }[] = [];
  for (const { w, nullifier } of lacking) {
    const e = buys.get(nullifier);
    const b = e === undefined ? null : evmBoughtOf(e);
    if (b !== null && b.w === w) owed.push({ ...b, w });
  }
  const out: string[] = [];
  // asked in a random order, never the notes' (M359 (4)): the order says nothing of which buy came first
  for (const b of shuffled(owed, h.random)) {
    h.signal?.throwIfAborted();
    let route: EvmHolding["route"];
    let decimals: number;
    try {
      route = await evmBuyRouteByTx(h.helper, h.network, h.pin.pool, b);
      decimals = await keptTokenDecimals(h.chain, b.token, h.rpcs as readonly [PoolRpc, PoolRpc], { waits: 0 });
    } catch {
      continue;
    }
    h.signal?.throwIfAborted();
    let wrote = false;
    await store.update("meta", EVM_POSITION_COSTS_KEY, (v) => {
      const all = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
      if (Object.keys(all).some((a) => lower(a) === b.w)) return undefined;
      wrote = true;
      const rec: EvmHolding = { mint: lower(b.token), decimals, chain: h.chain, state: "filled", route };
      return { ...all, [b.w]: rec };
    });
    if (wrote) out.push(b.w);
  }
  return out;
}
