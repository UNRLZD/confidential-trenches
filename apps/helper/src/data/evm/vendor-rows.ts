// A vendor's trade row made exact from the chain (card evm-tape-rows-exact). A listed token our reads price from no pool
// of ours (swaps.ts noneTrades) is served its top pool's trades from CoinGecko's on-chain API or GeckoTerminal, whose
// rows print the token amount as a float (Base tx 0xfa31c53f: "4029.69636401198" for the 4029696364011983028639 its
// buyer got) and name the transaction's sender as the trader (a bundle's bundler, never the account: Robinhood tx
// 0xd2f5c29d, sent by bundler 0xfb32a11a for account 0xd22e3afc; helper live runs 43689567273 and 43689580591).
//
// So each row is read again from its transaction's receipt (two providers alike, swaps.ts noneTrades): its amount is the
// raw value of the token's own move in the receipt that the vendor's float was printed from, and its trader is the one
// index.ts names for that move's log (traderAt: the sender, or the user operation's account in a bundle). A move is
// first a Transfer of the token; else, for a v4 pool that settles in claims, a leg of the PoolManager's Swap log or an
// ERC-6909 claim of the token. "Printed from" is a match to 1e-12 of the value: a float keeps about 15 significant
// digits, and two different moves of one token in one transaction that close are not seen in practice. A row with no
// such move, or with two different ones, is no trade the chain shows: it is never served. Nor is a row whose trader did
// not move the token its way: a buy's trader got more of it than it sent in the transaction (in a bundle, in its user
// operation's run), a sell's sent more than it got. The vendor counts a v4 hook's own swaps as trades of the sender
// (Base tx 0x2bd3a576: its sender sold 12,887,788.33, and the hook's contract 0x9982538f bought 18,198.82 with its cut
// and put it back as liquidity; GeckoTerminal served both rows under the sender), and our own tape counts none of them.
//
// A row the vendor printed from a v4 Swap log's leg is the pool's amount, which a hook's cut makes differ from what the
// trader settled (card trades-checks-pass-on-177: Base tx 0xe47f536a, GeckoTerminal's 4484.67211176021 is Swap log 19's
// leg; the pool's hook 0x5e320ea6 had 5.929... of it minted as claims to 0x5dd237d1, and the PoolManager sent the swap's
// sender 0xc3ace431 the 4,478.743022219595877949 that reached the transaction's sender; helper-v4-hook-liquidity on live
// run 43977576335). So such a row serves what the chain tape serves for it (swaps.ts hookTakes, the swap's own sender):
// the token the swap's sender settled with the PoolManager, as a Transfer or as claims, when it made that one swap in the
// transaction; or, the transaction's only swap and its sender settling none, what the one other address that moved the
// token with the PoolManager settled, no ModifyLiquidity or Donate sender (a take sent straight to its recipient). A buy
// gets at most the pool's amount and a sell pays at least it; with no such settlement read the pool's amount stands, as
// it does on the chain tape for a pool with no hook.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { traderAt, txTraders, type Traders } from "./index.ts";

const topic = (sig: string): string => `0x${Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex")}`;
const TRANSFER = topic("Transfer(address,address,uint256)");
const SWAP4 = topic("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const CLAIMS = topic("Transfer(address,address,address,uint256,uint256)");
const MODIFY_LIQUIDITY = topic("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)");
const DONATE = topic("Donate(bytes32,address,uint256,uint256)");
const ZERO = `0x${"0".repeat(40)}`;
const low = (v: unknown): string | null => (typeof v === "string" ? v.toLowerCase() : null);

/** What a receipt says about one token: the transaction's traders and each move of the token with its log index
 *  (`tier` 1 a Transfer of the token, 2 a v4 Swap leg (`swap`) or an ERC-6909 claim of it), the raw value as decimal
 *  text; and the v4 PoolManager's side of it: each Swap log's sender (`swaps`), the token each address got from the
 *  PoolManager less what it paid in, as Transfers and claims (`net`, raw signed decimal text), and the senders of its
 *  ModifyLiquidity and Donate logs (`callers`). */
export type Facts = {
  traders: Traders;
  moves: { index: number; raw: string; tier: 1 | 2; from?: string; to?: string; swap?: true }[];
  swaps?: { index: number; sender: string }[];
  net?: [string, string][];
  callers?: string[];
};

/** The facts of `token` in a receipt (eth_getTransactionReceipt's answer, hostile), or null for a malformed one, one of
 *  another transaction, or a reverted one. `poolManager`: the chain's v4 PoolManager. */
export function receiptFacts(receipt: unknown, tx: string, token: string, poolManager: string): Facts | null {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return null;
  const r = receipt as Record<string, unknown>;
  if (low(r.transactionHash) !== tx || r.status !== "0x1" || !Array.isArray(r.logs)) return null;
  const traders = txTraders({ from: r.from, to: r.to, hash: r.transactionHash }, r);
  if (traders === null) return null;
  const tokenWord = `0x${token.slice(2).padStart(64, "0")}`;
  const moves: Facts["moves"] = [];
  const swaps: { index: number; sender: string }[] = [];
  const net = new Map<string, bigint>();
  const callers = new Set<string>();
  const credit = (a: string, v: bigint) => net.set(a, (net.get(a) ?? 0n) + v);
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
      moves.push({ index, raw: word(0).toString(), tier: 1, from, to });
      if (from === poolManager && to !== poolManager) credit(to, word(0));
      else if (to === poolManager && from !== poolManager) credit(from, -word(0));
    }
    else if (address === poolManager && topics[0] === SWAP4 && topics.length === 3 && words === 6) {
      const sender = holder(topics[2]);
      if (sender === null) return null;
      swaps.push({ index, sender });
      // the swap's two legs, int128 each: either may be the token's
      for (const w of [word(0), word(1)]) {
        const v = BigInt.asIntN(128, w);
        if (v !== 0n) moves.push({ index, raw: (v < 0n ? -v : v).toString(), tier: 2, swap: true });
      }
    } else if (address === poolManager && topics[0] === CLAIMS && topics.length === 4 && topics[3] === tokenWord && words === 2) {
      if (word(1) !== 0n) moves.push({ index, raw: word(1).toString(), tier: 2 });
      // a claim minted is the token its holder took from the PoolManager, one burnt what it paid in
      const [from, to] = [holder(topics[1]), holder(topics[2])];
      if (from === ZERO && to !== null && to !== ZERO) credit(to, word(1));
      else if (to === ZERO && from !== null && from !== ZERO) credit(from, -word(1));
    } else if (address === poolManager && (topics[0] === MODIFY_LIQUIDITY || topics[0] === DONATE) && topics.length === 3) {
      const sender = holder(topics[2]);
      if (sender !== null) callers.add(sender);
    }
  }
  return { traders, moves, swaps, net: [...net].map(([a, v]) => [a, v.toString()]), callers: [...callers] };
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
 *  match. */
export function exactRow(side: "b" | "s", amt: string, decimals: number, f: Facts): { amt: string; trader: string | null } | null {
  const want = vendorUnits(amt, decimals);
  if (want === null) return null;
  for (const tier of [1, 2] as const) {
    const hits = f.moves.filter((m) => m.tier === tier && near(BigInt(m.raw), want));
    const values = new Set(hits.map((m) => m.raw));
    if (values.size > 1) return null;
    if (values.size === 1) {
      // a Swap log's leg is the pool's amount: the trader's is what the swap's sender settled (settledLeg), one value
      const legs = hits.every((m) => m.swap) ? new Set(hits.map((m) => settledLeg(f, m.index, side, BigInt(m.raw)))) : new Set<bigint | null>();
      const leg = legs.size === 1 ? [...legs][0]! : null;
      const raw = leg ?? BigInt(hits[0]!.raw);
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
      return { amt: fixed(raw, decimals), trader };
    }
  }
  return null;
}

/** What the sender of the v4 Swap logged at `index` settled of the token for a swap of `side` whose pool's amount is
 *  `gross`, as swaps.ts hookTakes reads it from the chain tape's logs: its own net with the PoolManager when it made that
 *  one swap in the transaction; or, the transaction's only swap and its sender settling none, the net of the one other
 *  address that moved the token with the PoolManager and sent no swap, ModifyLiquidity or Donate. Null when none is read,
 *  or when it is no cut of the pool's amount (a buy's more than it, a sell's less). */
function settledLeg(f: Facts, index: number, side: "b" | "s", gross: bigint): bigint | null {
  const swaps = f.swaps ?? [];
  const s = swaps.find((x) => x.index === index);
  if (s === undefined || swaps.filter((x) => x.sender === s.sender).length !== 1) return null;
  const net = new Map((f.net ?? []).map(([a, v]) => [a, BigInt(v)]));
  let n = net.get(s.sender) ?? 0n;
  if (n === 0n && swaps.length === 1) {
    const callers = new Set(f.callers ?? []);
    const to = [...net].filter(([a, v]) => v !== 0n && a !== s.sender && !callers.has(a));
    if (to.length === 1) n = to[0]![1];
  }
  const leg = side === "b" ? n : -n;
  return leg <= 0n || (side === "b" ? leg > gross : leg < gross) ? null : leg;
}

/** Whether `raw` is the value a float printed as `want` came from: within 1e-12 of it. */
const near = (raw: bigint, want: bigint): boolean => raw > 0n && (raw > want ? raw - want : want - raw) * 10n ** 12n <= want;
