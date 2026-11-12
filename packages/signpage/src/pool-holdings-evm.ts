// A Base or Robinhood W's buy record, rebuilt on a device that never made the buy (a restore from the 12 words, a new
// browser), from chain data alone, so its token shows in the positions and sells (the sale finds a W only by its record,
// pool-sell-evm.ts planEvmSell). Run at each state read beside the carry (src/pool-testnet.ts), so a pass that could
// not finish runs again on the next one.
// - The Ws: each SPENT or RESERVED note of the pool's scope whose release in the pool sync's round (evmTreeSync: every
//   log of the pool, read on both pool RPCs, which agree on each row's bytes) is a Bought with the note's nullifier and
//   W (freshWallet(seed, "evm", l, jOf(ref))) as its recipient. A Withdrawn (a refused buy, a withdraw) writes nothing:
//   the carry owns a refused buy's ETH (pool-carry-evm.ts). The token, the block and the buy's transaction hash are
//   that row's own (its bytes hold the hash both RPCs gave).
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
import { keccak_256 } from "@noble/hashes/sha3.js";
import { evmBuyRouteOf, type EvmPoolChain } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteSecrets } from "../../wallet/src/notes/secrets.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import type { EvmPoolEvent, EvmPoolPin, EvmRpc } from "../../wallet/src/pool/evm.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import type { WalletStore } from "@blindfill/wallet/store";
import { evmBuyCalldataRead } from "./evm-send.ts";
import { EVM_POSITION_COSTS_KEY, type EvmHolding } from "./pool-buy-evm.ts";
import { keptTokenDecimals, type PoolRpc } from "./pool-kinds.ts";

const lower = (s: string): string => s.toLowerCase();
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

// RLP (the Ethereum yellow paper, appendix B)
const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) (out.set(x, o), (o += x.length));
  return out;
};
const beBytes = (v: bigint): Uint8Array => {
  if (v < 0n) throw new Error("a negative integer");
  const out: number[] = [];
  for (let x = v; x > 0n; x >>= 8n) out.unshift(Number(x & 0xffn));
  return Uint8Array.from(out);
};
const head = (n: number, short: number): Uint8Array => {
  if (n < 56) return Uint8Array.of(short + n);
  const len = beBytes(BigInt(n));
  return cat(Uint8Array.of(short + 55 + len.length), len);
};
const rlpBytes = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? b : cat(head(b.length, 0x80), b));
const rlpList = (items: Uint8Array[]): Uint8Array => {
  const body = cat(...items);
  return cat(head(body.length, 0xc0), body);
};
const hexBytes = (h: string): Uint8Array => {
  if (!/^0x([0-9a-f]{2})*$/.test(h)) throw new Error("not hex bytes");
  return Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));
};
const qty = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(v)) throw new Error(`${what}: not a quantity`);
  return BigInt(v);
};
const hex = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;

/** The hash of a signed type 2 transaction as an RPC gives it (eth_getTransactionByHash): keccak256(0x02 ‖ rlp([chainId,
 *  nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, input, accessList, yParity, r, s])). Throws on any
 *  other type or a field out of its shape. */
export function evmType2Hash(t: Record<string, unknown>): string {
  if (t?.type !== "0x2") throw new Error("not a type 2 transaction");
  const u = (k: string) => rlpBytes(beBytes(qty(t[k], k)));
  if (typeof t.to !== "string" || !ADDRESS.test(lower(t.to))) throw new Error("to: not an address");
  if (typeof t.input !== "string") throw new Error("input: not hex");
  const list = t.accessList;
  if (!Array.isArray(list)) throw new Error("accessList: not a list");
  const access = rlpList(
    list.map((e: { address?: unknown; storageKeys?: unknown }) => {
      if (typeof e?.address !== "string" || !ADDRESS.test(lower(e.address)) || !Array.isArray(e.storageKeys)) throw new Error("accessList: not an entry");
      return rlpList([rlpBytes(hexBytes(lower(e.address))), rlpList(e.storageKeys.map((k: unknown) => {
        if (typeof k !== "string" || !HASH.test(lower(k))) throw new Error("accessList: not a storage key");
        return rlpBytes(hexBytes(lower(k)));
      }))]);
    }),
  );
  const parity = t.yParity ?? t.v;
  const y = qty(parity, "yParity");
  if (y !== 0n && y !== 1n) throw new Error("yParity: not 0 or 1");
  const fields = [u("chainId"), u("nonce"), u("maxPriorityFeePerGas"), u("maxFeePerGas"), u("gas"), rlpBytes(hexBytes(lower(t.to))), u("value"), rlpBytes(hexBytes(lower(t.input))), access, rlpBytes(beBytes(y)), u("r"), u("s")];
  return hex(keccak_256(cat(Uint8Array.of(2), rlpList(fields))));
}

/** A buy's place in the round: W, the token, its block and the transaction hash both pool RPCs gave (the row's bytes:
 *  block, block hash, log index, transaction hash, ...). Null for any other row. */
export function evmBoughtOf(e: EvmPoolEvent): { w: string; token: string; block: bigint; tx: string } | null {
  if (e.kind !== "buy" || e.recipient === null || e.token === null) return null;
  const tx = e.bytes.split(" ")[3];
  return typeof tx === "string" && HASH.test(tx) ? { w: e.recipient, token: e.token, block: e.block, tx } : null;
}

/** The route of the buy at `tx`, from the helper's answer (see the header): throws unless that answer hashes to `tx`,
 *  calls `pool` and buys `token`. */
export async function evmBuyRouteByTx(helper: EvmRpc, network: EvmPoolChain, pool: string, b: { token: string; block: bigint; tx: string }): Promise<EvmHolding["route"]> {
  const t = (await helper("eth_getTransactionByHash", [b.tx])) as Record<string, unknown> | null;
  if (t === null || typeof t !== "object") throw new Error("the helper has no such transaction");
  if (evmType2Hash(t) !== lower(b.tx)) throw new Error("the helper's transaction is not the agreed one");
  if (lower(String(t.to)) !== lower(pool)) throw new Error("the transaction does not call the pool");
  const buy = evmBuyCalldataRead(lower(String(t.input)));
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
  /** The pool sync's round (every row agreed on both RPCs). */
  round(): Promise<{ events: readonly EvmPoolEvent[] }>;
  notes(): Promise<readonly NoteRecord[]>;
  seed64(): Promise<Uint8Array>;
  held(): Promise<Pick<WalletStore, "get" | "update">>;
  signal?: AbortSignal;
};

/** One pass (see the header): the Ws whose record it wrote. */
export async function rebuildEvmHoldings(h: EvmHoldingsHost): Promise<string[]> {
  const spent = (await h.notes()).filter((n) => n.scope === h.scope && (n.state === "SPENT" || n.state === "RESERVED") && n.leaf !== undefined);
  if (spent.length === 0) return [];
  const store = await h.held();
  const had = (await store.get("meta", EVM_POSITION_COSTS_KEY)) as Record<string, unknown> | undefined;
  const known = new Set(Object.keys(typeof had === "object" && had !== null ? had : {}).map(lower));
  const { events } = await h.round();
  const buys = new Map<bigint, EvmPoolEvent>();
  for (const e of events) if (e.kind === "buy" && e.nullifier !== null) buys.set(e.nullifier, e);
  const owed: { w: string; token: string; block: bigint; tx: string }[] = [];
  const seed = await h.seed64();
  try {
    for (const n of spent) {
      const e = buys.get(noteSecrets(seed, n.ref).nullifierHash);
      const b = e === undefined ? null : evmBoughtOf(e);
      if (b === null) continue;
      const k = freshWallet(seed, "evm", n.leaf!.label, jOf(n.ref));
      k.secretKey.fill(0);
      const w = lower(k.address);
      if (b.w !== w || known.has(w)) continue;
      owed.push({ ...b, w });
    }
  } finally {
    seed.fill(0);
  }
  const out: string[] = [];
  for (const b of owed) {
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
