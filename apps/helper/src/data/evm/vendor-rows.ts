// A vendor's trade row made exact from the chain (card evm-tape-rows-exact). A listed token our reads price from no pool
// of ours (swaps.ts noneTrades) is served its top pool's trades from CoinGecko's on-chain API or GeckoTerminal, whose
// rows print the token amount as a float (Base tx 0xfa31c53f: "4029.69636401198" for the 4029696364011983028639 its
// buyer got) and name the transaction's sender as the trader (a bundle's bundler, never the account: Robinhood tx
// 0xd2f5c29d, sent by bundler 0xfb32a11a for account 0xd22e3afc; helper live runs 43689567273 and 43689580591).
//
// So each row is read again from its transaction's receipt (two providers alike, swaps.ts noneTrades): its amount is the
// raw value of the token's own move in the receipt that the vendor's float was printed from, and its trader is the one
// index.ts names for that move's log (traderAt: the sender, or the user operation's account in a bundle). A move is
// first a Transfer of the token; else, for a v4 pool that settles in claims, an ERC-6909 claim of the token. Only a
// swap's own settlement is a trade's move: a Transfer into or out of a pool that logged a swap in the transaction (a v2
// pair, a v3, Slipstream or PancakeSwap v3 pool, a Pons curve, the v4 PoolManager), what its trader paid in or took
// out, whoever the router; or a claim the PoolManager minted or burnt. A Swap log's own leg is never one: it is the
// pool's amount, which a hook's cut makes differ from what the trader settled, and a hook's own swap logs one with no
// move at all (Base tx 0x95ac6c34: the account 0x05168e5c sold 3,450.918... through router 0x5cdc0f0f, whose Transfer
// into the PoolManager is log 13 and its Swap log 15; then the pool's hook 0x0469a4bd swapped 27.607... out of its own
// liquidity, Swap log 18, which no Transfer or claim moved. GeckoTerminal served both under the account, and the leg
// made the second a row: helper-v4-hook-liquidity on live run 43702430864). Nor is a pass-through between other
// addresses (a router to its user, an aggregator's fee to its integrator). "Printed from" is a match to 1e-12 of the value: a float keeps about 15 significant
// digits, and two different moves of one token in one transaction that close are not seen in practice. A row with no
// such move, or with two different ones, is no trade the chain shows: it is never served. Nor is a row whose trader did
// not move the token its way: a buy's trader got more of it than it sent in the transaction (in a bundle, in its user
// operation's run), a sell's sent more than it got. The vendor counts a v4 hook's own swaps as trades of the sender
// (Base tx 0x2bd3a576: its sender sold 12,887,788.33, and the hook's contract 0x9982538f bought 18,198.82 with its cut
// and put it back as liquidity; GeckoTerminal served both rows under the sender), and our own tape counts none of them.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { traderAt, txTraders, type Traders } from "./index.ts";

const topic = (sig: string): string => `0x${Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex")}`;
const TRANSFER = topic("Transfer(address,address,uint256)");
const CLAIMS = topic("Transfer(address,address,address,uint256,uint256)");
const low = (v: unknown): string | null => (typeof v === "string" ? v.toLowerCase() : null);

/** What a receipt says about one token: the transaction's traders and each move of the token with its log index
 *  (`tier` 1 a Transfer of the token, 2 an ERC-6909 claim of it), the raw value as decimal text, and `pool` when it is a
 *  swap's own settlement (a Transfer into or out of a pool that logged a swap in the transaction, or a claim). */
export type Facts = { traders: Traders; moves: { index: number; raw: string; tier: 1 | 2; from?: string; to?: string; pool?: true }[] };

/** The facts of `token` in a receipt (eth_getTransactionReceipt's answer, hostile), or null for a malformed one, one of
 *  another transaction, or a reverted one. `poolManager`: the chain's v4 PoolManager; `swapTopics`: every venue's swap
 *  event (swaps.ts SWAP_TOPICS), whose emitters are the transaction's pools. */
export function receiptFacts(receipt: unknown, tx: string, token: string, poolManager: string, swapTopics: readonly string[]): Facts | null {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return null;
  const r = receipt as Record<string, unknown>;
  if (low(r.transactionHash) !== tx || r.status !== "0x1" || !Array.isArray(r.logs)) return null;
  const traders = txTraders({ from: r.from, to: r.to, hash: r.transactionHash }, r);
  if (traders === null) return null;
  const tokenWord = `0x${token.slice(2).padStart(64, "0")}`;
  const moves: Facts["moves"] = [];
  // the transaction's pools: each address that logged a venue's swap event
  const pools = new Set<string>();
  for (const raw of r.logs as unknown[]) {
    const l = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const [address, t0] = [low(l.address), Array.isArray(l.topics) ? low(l.topics[0]) : null];
    if (address !== null && t0 !== null && swapTopics.includes(t0)) pools.add(address);
  }
  for (const raw of r.logs as unknown[]) {
    const l = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const index = typeof l.logIndex === "string" && /^0x[0-9a-f]{1,8}$/i.test(l.logIndex) ? parseInt(l.logIndex, 16) : null;
    const topics = Array.isArray(l.topics) ? l.topics.map(low) : null;
    const data = low(l.data);
    if (index === null || topics === null || data === null || !/^0x([0-9a-f]{2})*$/.test(data)) return null;
    const address = low(l.address);
    const words = (data.length - 2) / 64;
    const word = (i: number): bigint => BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
    const holder = (t: string | null | undefined): string | null => (t != null && /^0x0{24}[0-9a-f]{40}$/.test(t) ? `0x${t.slice(26)}` : null);
    if (address === token && topics[0] === TRANSFER && topics.length === 3 && words === 1) {
      const [from, to] = [holder(topics[1]), holder(topics[2])];
      if (from === null || to === null) return null;
      moves.push({ index, raw: word(0).toString(), tier: 1, from, to, ...(pools.has(from) || pools.has(to) ? { pool: true as const } : {}) });
    }
    else if (address === poolManager && topics[0] === CLAIMS && topics.length === 4 && topics[3] === tokenWord && words === 2) {
      if (word(1) !== 0n) moves.push({ index, raw: word(1).toString(), tier: 2, pool: true });
    }
  }
  return { traders, moves };
}

/** A vendor's decimal amount in the token's smallest units (its digits past `decimals` dropped), or null when it is no
 *  plain positive decimal. */
export function vendorUnits(amt: string, decimals: number): bigint | null {
  const m = /^(\d{1,40})(?:\.(\d{1,80}))?$/.exec(amt);
  if (m === null) return null;
  const v = BigInt(m[1]! + (m[2] ?? "").padEnd(decimals, "0").slice(0, decimals));
  return v > 0n ? v : null;
}

/** `raw` in whole tokens as decimal text, no exponent, no trailing zeros. */
function fixed(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${s.slice(0, s.length - decimals)}${frac === "" ? "" : `.${frac}`}`;
}

/** The exact row for a vendor's `amt` of a token of `decimals` from its transaction's facts: the one raw value of the
 *  first tier that holds a match, and the trader of the first log that moved it; null when no move or two different ones
 *  match. A match is a swap's own settlement (Facts `pool`). */
export function exactRow(side: "b" | "s", amt: string, decimals: number, f: Facts): { amt: string; trader: string | null } | null {
  const want = vendorUnits(amt, decimals);
  if (want === null) return null;
  for (const tier of [1, 2] as const) {
    const hits = f.moves.filter((m) => m.tier === tier && m.pool && near(BigInt(m.raw), want));
    const values = new Set(hits.map((m) => m.raw));
    if (values.size > 1) return null;
    if (values.size === 1) {
      // the trader of the moves that carry it: the one they name (a bundle's validation logs name none); two different
      // ones (two user operations moving the same amount) name no one, never a guess
      const named = [...new Set(hits.map((m) => traderAt(f.traders, m.index)).filter((t): t is string => t !== null))];
      const trader = named.length === 1 ? named[0]! : null;
      if (trader !== null) {
        // its net move of the token over the transaction, or its user operation's run
        let net = 0n;
        for (const m of f.moves)
          if (m.tier === 1 && traderAt(f.traders, m.index) === trader) net += (m.to === trader ? BigInt(m.raw) : 0n) - (m.from === trader ? BigInt(m.raw) : 0n);
        if (side === "b" ? net <= 0n : net >= 0n) return null;
      }
      return { amt: fixed(BigInt(hits[0]!.raw), decimals), trader };
    }
  }
  return null;
}

/** Whether `raw` is the value a float printed as `want` came from: within 1e-12 of it. */
const near = (raw: bigint, want: bigint): boolean => raw > 0n && (raw > want ? raw - want : want - raw) * 10n ** 12n <= want;
