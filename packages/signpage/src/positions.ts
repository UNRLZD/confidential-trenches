// The tokens the device's pool buys hold, on SIGN_HOST's top-level page (card signpage-state-holdings; the kit's
// SignpageState.positions, its shape unchanged).
//
// - Only what this device bought: a position is the token W's buy mint names (the wallet store's owed/buy-sol, which
//   the buy writes before every send: pool-buy.ts h.bought.put, pool-sell.ts buyMints). W's buy record
//   (POSITION_COSTS_KEY, written by recordBoughtOut as soon as the run tells the amount W received, read back on both
//   RPCs at confirmed, its early "sent" on: card sell-right-after-a-buy; and again by recordPoolBuy at a filled end)
//   adds to it: the amount shown while the finder lags, the mint's decimals and the cost. It says where to look, never
//   that the buy is final: no reader takes it so, and a sale reads W on both RPCs before it signs. A run that ends
//   not_landed (both RPCs' verdict) takes it back; one whose end is not known ("sent") keeps it. A buy whose run never
//   told that amount (the helper's 502, read-backs apart or unreadable, a tab closed before the read-back) is still a
//   position, at the finder's amount. A token the finder lists in W that W's buy mint does not name (one
//   sent to W by anyone) is no position: not listed, no Sell, and nothing is read for it. A W takes one buy only (a W is
//   its note's, and a note spends once: wallet/src/pool/queue.ts jOf and derive/keys.ts walletPath), so its buy mint
//   names W's one holding. A device restored from the words gets each W's buy mint back from W's own buy transaction
//   (src/sol-buy-records.ts, after the restore and at each load, in the background), so its rows come in as their Ws
//   are read; a W whose buy it cannot read shows nothing.
// - Display only, from one reader: a position's amount is what the finder's one read of its W says, never a read a
//   sell signs on; a sell reads its W again on two providers before it signs (pool-sell.ts tokenHeld).
// - The finder: the Ws the pool's spent notes paid (../../wallet/src/pool/buy-wallets.ts derivedBuyWallets, the one
//   finder a restore and a sell use), derived under the seed's lock with the seed zeroed at once, then only the Ws
//   with a buy mint or record read, each once by its one reader with every token it holds: the helper's keyed route on
//   mainnet, a devnet RPC in the testnet build. No read of this pass names a W to a public provider (buy-wallets.ts
//   header), and none names a mint W's buy did not: a mint's decimals come from its buy record, else from the kept
//   pass, else from one read on the finder's own route (the helper's keyed route on mainnet), once.
// - Open buys first, each row as it is read (card wallets-found-in-one-read): the Ws of buys this device has not sold in
//   full are read before the sold ones, and the state's positions take each W's read as it comes, every W not read yet
//   on the rule for a W unread below (its last amount, else its record's), so no row moves or goes before its own W is
//   read, and the whole pass's end confirms the last rows shown. Only a whole pass is kept.
// - One W at a time: a W whose read fails keeps its last amount (or, never listed and not sold, its record's) while
//   every other W updates, and the pass counts as failed so it runs again; a finder that cannot list at all keeps every
//   W's last. Once the finder listed a token in W and lists it no more (or at 0), it is gone, and an unread W or a
//   finder that is down never brings it back. A recorded token the finder read W whole and never listed shows at the
//   record's amount (a reader that lags hides nothing this device bought) until the finder lists it or this device
//   signed a full sell of it from W (pool-sell.ts writes W's rent-back record with that sell before it leaves the
//   device; noted here). A W with a buy mint or a record that the finder's whole list does not know (its note neither
//   SPENT nor RESERVED: a buy refused or not landed, its note freed) is no position and no fault.
// - Looked for again, never a failed pass: a W whose buy this page ran (`awaited`) that the finder does not list yet,
//   with no record's amount, and a token this device signed a full sell of that the finder still lists (the sell's
//   verdict is read at confirmed, the finder at finalized). Each runs the pass again, and the pass is kept all the same,
//   so a reload shows what the tab showed; once a round of retries has run out with one still looked for, it is looked
//   for no more this sign-in (a buy that never lands, dust sent to a W that sold in full), until a later run or sell of
//   it. A full sell that ends not landed takes its mark back (pool-testnet.ts), so its token stays, plainly held.
// - Kept on the device: the last whole pass's positions (each with its decimals), each W's amounts and the tokens the
//   finder listed (POSITIONS_KEPT_KEY, in the wallet store, gone at sign out with the store), so the first state read
//   after a load answers at once (the finder reads one W per 3 s on mainnet), and the first pass replaces it. A pass
//   with any read failed never replaces it.
// - One position per token: its amount the sum over the Ws that hold it, as an exact decimal at its decimals, and
//   those Ws' addresses.
// - Its cost, in USD: each W's buy record names what the buy spent at the page's own two-RPC pool price at the request
//   (src/pool-price.ts; never a helper's price) and what W received. A W's cost now is that spend times what it holds
//   over what it received, so a sell takes cost off pro rata by the units it sold. A position any of whose Ws has no
//   cost in its record (no record, or a buy with no price read) has cost "0", which the app reads as unknown: never a
//   cost made of part of its Ws.
// - The pool buy's ops record (recordPoolBuy, review P3-1 of card kit-portfolio-reads): written once its run ends, as
//   state.ts's op contract reads it: kind "buy", its end stage, its txs, the error code of a refusal, its time, chain and
//   token, and amount_usd its asked spend at that price; filled, the token W received (units) and the SOL it spent
//   (pool_amount, kit 1.10). Nothing secret. A run a closed tab ended writes none, nor one
//   that answered "sent" (no end yet).
// - When: a pass at the sign-in's first state read, and again each time a pool buy or sell run ends; never inside a
//   state read, which only takes the last pass. One pass at a time: a refresh asked while one runs runs once more after
//   it, a sign out's included. A sell's own read of the Ws holds every pass off (the running one stopped, a booked
//   retry dropped) until it ends: read, it is the next pass's read; failed, the next pass reads the finder. So a sell
//   never shares the finder's paced queue with the display. A pass with any read failed is tried again
//   POSITIONS_RETRY_MS later, up to POSITIONS_RETRIES times. Sign out stops the running pass and drops it all.
// - The SOL a position holds beside its token (asset_held, card portfolio-counts-money-an-open-buy-holds): per W the
//   finder read whole this pass, one getMultipleAccounts on the finder's own route (`assetHeld`) naming that W alone:
//   W's lamports and those of the accounts a full sell closes back to W (its token account of the mint, under either
//   token program, and its pump and PumpSwap volume accounts), all at one slot, so nothing is counted twice. Fees
//   already paid are gone from every one of them. A position's figure is the sum over its Ws, absent when any of its Ws
//   was not read this pass (never a part sum, never "0" in its place); a read that fails is that W's alone, and the pass
//   runs again. Rows shown while the finder reads carry none; the pass's end does.
// - What crosses to APP_HOST: per token its chain, mint, amount, decimals, the Ws' addresses and the SOL they hold:
//   amounts, addresses and tokens only, never a note, a key or a path.
import { SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaVolumeAccumulator } from "../../kit/src/checks/solana/checks.ts";
import { solanaAta } from "../../kit/src/checks/solana/message.ts";
import type { BuyRoute, PoolStatePrice, SignpageState, TxRef } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { ANSWER_ROOM, pickOps } from "./state.ts";
import { poolUnits } from "./rules/pool.ts";

export type Position = SignpageState["positions"][number];

/** A failed pass is tried again this long after it ends. */
export const POSITIONS_RETRY_MS = 5_000;
/** At most this many tries in a row after a failed pass (a minute of a chain catching up), then the next buy, sell or
 *  sign-in load runs it again. */
export const POSITIONS_RETRIES = 12;

/** One W as the finder read it: each token it holds, base units; null when that W's read failed. */
export type FoundWallet = { address: string; tokens: ReadonlyMap<string, bigint> | null };

/** What a pass reads, every read the device's own. */
export type PositionsReads = {
  /** The Ws of these addresses (each with a buy mint or record), each as the finder read it, a W it does not know left
   *  out; throws when it cannot list. The Ws of `first` are read before the rest, and `each` is told each W as it is
   *  read (card wallets-found-in-one-read). */
  wallets(only: ReadonlySet<string>, o?: { first?: ReadonlySet<string>; each?: (w: FoundWallet) => void }): Promise<readonly FoundWallet[]>;
  /** The positions as the pass has read them so far: each W not read yet on the rule for a W unread (its last amount,
   *  else its record's), so a row holds steady until its W is read. Never kept; the pass's end gives the whole. */
  shown?(positions: Position[]): void;
  /** The mint's decimals, one read on the finder's own route; throws when it does not read. Asked only for a mint W
   *  holds whose record and kept pass name none. */
  decimals(mint: string): Promise<number>;
  /** The lamports W holds and gets back at a full sell of `mint` (solanaAssetHeld on the finder's own route); throws when
   *  it does not read. None: no position carries asset_held. */
  assetHeld?(address: string, mint: string, signal?: AbortSignal): Promise<bigint>;
  /** Each W's buy mint (owed/buy-sol: `{ mint, program }` by W's address); none: nothing bought. */
  bought?(): Promise<Readonly<Record<string, unknown>>>;
  /** Each W's buy record (POSITION_COSTS_KEY); none: nothing recorded. */
  costs?(): Promise<PositionCosts>;
  /** The Ws whose buy this page ran to filled or sent: one the finder does not list yet is looked for again. As a map,
   *  each W's run (its request id): a later run on W is looked for afresh. */
  awaited?(): ReadonlySet<string> | ReadonlyMap<string, string>;
  /** The full sells this device signed, as "W mint" (POSITIONS_SOLD_KEY). As a map, each one's sell (its signature): a
   *  later sell of it is looked for afresh. */
  sold?(): Promise<ReadonlySet<string> | ReadonlyMap<string, string>>;
  /** The kept pass (POSITIONS_KEPT_KEY), as stored; read once, before the first pass. */
  kept?(): Promise<unknown>;
  /** Keeps this pass (POSITIONS_KEPT_KEY); only a whole one. */
  keep?(k: KeptPass): Promise<void>;
  /** Aborted: the pass stops, and keeps and answers nothing (a sign out, or a sell's own read in its place). */
  signal?: AbortSignal;
};

/** Where the buy records are, in the wallet store's meta by W's address: an owed/ key, the one meta keyspace the store
 *  lets a caller write, beside W's buy mints (pool-sell.ts buyMints, owed/buy-sol). */
export const POSITION_COSTS_KEY = "owed/cost-sol";
/** The full sells this device signed, in meta by W's address: the mints. */
export const POSITIONS_SOLD_KEY = "owed/sold-sol";
/** Which sell marked each "W mint": its signatures, in meta by "W mint"; a sell that ended not landed takes its mark
 *  back and its signatures go in POSITIONS_UNLANDED_KEY, so a later write of the same sell marks nothing (pool-testnet.ts). */
export const POSITIONS_SOLD_TX_KEY = "owed/sold-tx-sol";
export const POSITIONS_UNLANDED_KEY = "owed/sold-unlanded-sol";
/** The last whole pass, in meta: KeptPass. */
export const POSITIONS_KEPT_KEY = "owed/positions-sol";
/** One W's buy: its mint, the token units it received (a decimal at the mint's own), the mint's decimals (read with
 *  that amount; none in a record from before they were kept) and, with a price read, the USD it spent (a decimal). */
export type PositionCost = { mint: string; received: string; decimals?: number; cost_usd?: string };
export type PositionCosts = Readonly<Record<string, PositionCost>>;

const DEC = /^\d{1,78}(\.\d{1,78})?$/;
/** A token's decimals: a u8, as an SPL mint's are (and the kit's schema bounds them). */
const isDecimals = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255;
/** A decimal string in base units at `d` decimals, the extra digits cut; null when it is not one. */
function base(v: unknown, d: number): bigint | null {
  if (typeof v !== "string" || !DEC.test(v)) return null;
  const [i, f = ""] = v.split(".");
  return BigInt(i!) * 10n ** BigInt(d) + BigInt((f.slice(0, d) || "0").padEnd(d, "0"));
}
/** Cost in USD carried at this scale through the pro rata. */
const COST_SCALE = 12;

/** A position's cost: the sum over its Ws of each W's spend times its held over its received, or "0" when any W has no
 *  record of this mint, or one that does not read. */
export function positionCost(mint: string, decimals: number, held: readonly { address: string; amount: bigint }[], costs: PositionCosts): string {
  let sum = 0n;
  for (const w of held) {
    const c = Object.hasOwn(costs, w.address) ? costs[w.address] : undefined;
    if (!c || c.mint !== mint) return "0";
    const spent = base(c.cost_usd, COST_SCALE);
    const received = base(c.received, decimals);
    if (spent === null || received === null || received <= 0n) return "0";
    sum += w.amount >= received ? spent : (spent * w.amount) / received;
  }
  return poolUnits(sum, COST_SCALE);
}

/** SOL's decimals: asset_held is in whole SOL, as pools[].balance is. */
const SOL_DECIMALS = 9;
/**
 * The lamports W holds beside its `mint` and gets back at a full sell (card portfolio-counts-money-an-open-buy-holds):
 * one getMultipleAccounts at finalized naming W alone, as the finder reads, of W, its token account of the mint under
 * each token program and its pump and PumpSwap volume accounts, all at one slot. An account that is not there counts 0;
 * a closable account owned by any program but its own, a count that is not the keys', or lamports that are not a whole
 * number in range is refused (a throw), so a hostile answer never makes a figure.
 */
export async function solanaAssetHeld(rpc: SolanaRpc, address: string, mint: string, signal?: AbortSignal): Promise<bigint> {
  const keys: [string, string | null][] = [
    [address, null],
    [solanaAta(address, mint, SOLANA_TOKEN_PROGRAM), SOLANA_TOKEN_PROGRAM],
    [solanaAta(address, mint, SOLANA_TOKEN_2022_PROGRAM), SOLANA_TOKEN_2022_PROGRAM],
    [solanaVolumeAccumulator(address, SOLANA_PUMP_PROGRAM), SOLANA_PUMP_PROGRAM],
    [solanaVolumeAccumulator(address, SOLANA_PUMP_AMM_PROGRAM), SOLANA_PUMP_AMM_PROGRAM],
  ];
  signal?.throwIfAborted();
  const answer = await rpc("getMultipleAccounts", [keys.map(([k]) => k), { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 0 } }]);
  signal?.throwIfAborted();
  const value = (answer as { value?: unknown } | null)?.value;
  if (!Array.isArray(value) || value.length !== keys.length) throw new Error("getMultipleAccounts: not an answer for these accounts");
  let sum = 0n;
  value.forEach((a: unknown, i) => {
    if (a === null) return;
    const { lamports, owner } = (a ?? {}) as { lamports?: unknown; owner?: unknown };
    if (!Number.isSafeInteger(lamports) || (lamports as number) < 0) throw new Error("getMultipleAccounts: lamports not a whole number");
    const program = keys[i]![1];
    if (program !== null && owner !== program) throw new Error(`getMultipleAccounts: ${keys[i]![0]} is not ${program}'s`);
    sum += BigInt(lamports as number);
  });
  return sum;
}

/** A pass as kept: its positions, each "W mint" amount (base units, a decimal string) and each "W mint" the finder
 *  listed. */
export type KeptPass = { positions: Position[]; held: Record<string, string>; listed: string[]; lamports?: Record<string, string> };
/** What a pass keeps for the next: each "W mint" last amount, what the finder listed, each mint's decimals, and each
 *  held W's last asset_held read (`lamports`), which stands while a later pass reads W or when W's read fails, as a
 *  token's last amount does, so a Total never dips while the page reads. */
/** `waited`: the "W mint"s a round of retries looked for in vain this sign-in, each looked for no more (see PassResult). */
export type PassMemo = { held: Map<string, bigint>; listed: Set<string>; decimals: Map<string, number>; lamports: Map<string, bigint>; loaded: boolean; stale?: boolean; waited: Set<string> };
export const passMemo = (): PassMemo => ({ held: new Map(), listed: new Set(), decimals: new Map(), lamports: new Map(), loaded: false, waited: new Set() });
/** A pass's positions, whether every read in it held (when not, it runs again and is not kept), and the "W mint"s it
 *  looks for again though every read held (`wait`): a token sold in full the finder still lists, a buy this page ran the
 *  finder does not list yet. A pass with only these is whole, so it is kept; it runs again, but once a round of retries
 *  has run out with one still waiting, that one is looked for no more this sign-in (a sell or buy that never landed,
 *  dust sent to a sold W: the chain answered, nothing is left to wait for). */
export type PassResult = { positions: Position[]; whole: boolean; wait?: readonly string[] };

const KEY = (w: string, m: string): string => `${w} ${m}`;
const BASE = /^\d{1,78}$/;
/** The mint each W bought, from W's buy mints and buy records (each `{ mint }` by W's address). */
const mintsOf = (byW: unknown): Map<string, string> => {
  const out = new Map<string, string>();
  if (typeof byW === "object" && byW !== null) for (const [w, c] of Object.entries(byW)) {
    const m = (c as { mint?: unknown } | null)?.mint;
    if (typeof m === "string") out.set(w, m);
  }
  return out;
};

/** A kept pass's positions, or null when it is not one (the kit's schema checks them again on the way out); with the
 *  buy mints and records (`bought`, each `{ mint }` by W), only the tokens they name (a pass kept before the rule took
 *  any token the finder listed). */
export function keptPositions(v: unknown, ...bought: unknown[]): Position[] | null {
  const k = v as Partial<KeptPass> | null;
  if (typeof k !== "object" || k === null || !Array.isArray(k.positions)) return null;
  if (bought.length === 0) return k.positions as Position[];
  const mints = new Set(bought.flatMap((b) => [...mintsOf(b).values()]));
  return (k.positions as Position[]).filter((p) => mints.has(p?.token));
}
/** A kept pass's listing (KeptPass `listed`, each "W mint" the finder listed), by W: each mint with its kept amount
 *  (`held`; 0 when none kept). Null when `v` is not a kept pass (no whole pass yet). Card pool-sell-legs-side-by-side:
 *  a sale adds a W to read from it, never an amount. */
export function keptListed(v: unknown): Map<string, Map<string, bigint>> | null {
  const k = v as Partial<KeptPass> | null;
  if (typeof k !== "object" || k === null || !Array.isArray(k.listed)) return null;
  return listingOf(k.listed, (key) => {
    const a = (k.held as Record<string, unknown> | undefined)?.[key];
    return typeof a === "string" && BASE.test(a) ? BigInt(a) : undefined;
  });
}
/** The memo's listing, as keptListed reads a kept pass: each "W mint" the finder listed, at the amount this tab last
 *  read (0 when gone). Null before the memo has loaded the kept pass. The memo is loaded from the kept pass and every
 *  read of this tab writes it before the tab keeps a pass (each W's read as it comes; a pass's end), so it is never older
 *  than the kept pass, and a read made after that pass stands over it (review P2 of 8da6b97f). */
export function memoListed(memo: PassMemo): Map<string, Map<string, bigint>> | null {
  return memo.loaded ? listingOf(memo.listed, (key) => memo.held.get(key)) : null;
}
function listingOf(keys: Iterable<unknown>, held: (key: string) => bigint | undefined): Map<string, Map<string, bigint>> {
  const out = new Map<string, Map<string, bigint>>();
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const [w, m, ...rest] = key.split(" ");
    if (!w || !m || rest.length > 0) continue;
    if (!out.has(w)) out.set(w, new Map());
    out.get(w)!.set(m, held(key) ?? 0n);
  }
  return out;
}
function loadMemo(memo: PassMemo, v: unknown): void {
  const k = v as Partial<KeptPass> | null;
  if (typeof k !== "object" || k === null) return;
  if (typeof k.held === "object" && k.held !== null) for (const [key, a] of Object.entries(k.held)) if (typeof a === "string" && BASE.test(a)) memo.held.set(key, BigInt(a));
  if (Array.isArray(k.listed)) for (const key of k.listed) if (typeof key === "string") memo.listed.add(key);
  if (typeof k.lamports === "object" && k.lamports !== null) for (const [w, a] of Object.entries(k.lamports)) if (typeof a === "string" && BASE.test(a)) memo.lamports.set(w, BigInt(a));
  // each kept position's decimals, so a load asks no RPC for a token it showed
  if (Array.isArray(k.positions)) for (const p of k.positions as unknown[]) {
    const q = p as { token?: unknown; decimals?: unknown } | null;
    if (typeof q?.token === "string" && isDecimals(q.decimals) && !memo.decimals.has(q.token)) memo.decimals.set(q.token, q.decimals);
  }
}

/** One pass: the positions of this device's buys, each from the finder's read of its W (see the header). */
export async function positionsPass(r: PositionsReads, memo: PassMemo = passMemo()): Promise<PassResult> {
  const stop = (): void => r.signal?.throwIfAborted();
  // loaded once the kept pass is in it, so memoListed never gives a memo half loaded
  if (!memo.loaded) {
    loadMemo(memo, await r.kept?.().catch(() => null));
    memo.loaded = true;
  }
  let whole = true;
  // each looked for by its trade: "W mint" and the sell or run that asks for it (tally's `look`)
  const wait: string[] = [];
  const bought = r.bought ? await r.bought().catch(() => ((whole = false), {})) : {};
  const costs: PositionCosts = r.costs ? await r.costs().catch(() => ((whole = false), {})) : {};
  const sold: ReadonlySet<string> | ReadonlyMap<string, string> = r.sold ? await r.sold().catch(() => ((whole = false), new Set<string>())) : new Set<string>();
  const awaited: ReadonlySet<string> | ReadonlyMap<string, string> = r.awaited?.() ?? new Set<string>();
  // what each W bought: its buy mint, else (a W with a record and no buy mint) its record's; the record adds the units
  // W received, and the mint's decimals, when it names the same mint
  const records: { address: string; mint: string; received?: string }[] = [];
  const recorded = mintsOf(costs);
  for (const [address, mint] of new Map([...recorded, ...mintsOf(bought)])) {
    const c = recorded.get(address) === mint ? costs[address]! : null;
    if (c !== null && isDecimals(c.decimals) && !memo.decimals.has(mint)) memo.decimals.set(mint, c.decimals);
    records.push({ address, mint, ...(c !== null && typeof c.received === "string" && DEC.test(c.received) ? { received: c.received } : {}) });
  }
  // each "W mint": its amount in base units, or the recorded amount (a decimal) until the mint's decimals are known.
  // `read`: each W's tokens as read, null when its read failed or has not come yet; `answered`: the finder listed, so a
  // W it left out is one it does not know
  const tally = (read: ReadonlyMap<string, ReadonlyMap<string, bigint> | null>, answered: boolean) => {
    let whole = true;
    const waits: string[] = [];
    const look = (k: string, by: ReadonlySet<string> | ReadonlyMap<string, string>, at: string): void => {
      const v = `${k} ${by instanceof Map ? (by.get(at) ?? "") : ""}`;
      if (!memo.waited.has(v)) waits.push(v);
    };
    const held = new Map<string, { address: string; mint: string; amount: bigint | string }>();
    const listed = new Set(memo.listed);
    for (const { address, mint, received } of records) {
      const k = KEY(address, mint);
      const tokens = read.get(address);
      if (tokens) {
        const a = tokens.get(mint);
        // listed: the finder's amount stands (0: gone); a token this device sold in full that is still listed may be the
        // finder behind the sell, so the pass runs again
        if (a !== undefined) {
          listed.add(k);
          if (a > 0n) {
            held.set(k, { address, mint, amount: a });
            if (sold.has(k)) look(k, sold, k);
          }
          continue;
        }
        // read whole, not listed: gone once it was listed before or this device sold it all, else the record's amount;
        // with no record, a buy this page ran is looked for again
        if (listed.has(k) || sold.has(k)) continue;
        if (received !== undefined) held.set(k, { address, mint, amount: received });
        else if (awaited.has(address)) look(k, awaited, address);
        continue;
      }
      // a W the finder answered without (its list whole: every W whose note is SPENT or RESERVED is in it): its note never
      // spent or was freed (a buy refused or not landed), so nothing to show, its record's amount included, and nothing
      // to wait for but a buy this page ran with no record yet
      if (answered && tokens === undefined) {
        if (!awaited.has(address) || received !== undefined) continue;
        // a buy this page ran whose W the finder does not know yet: looked for again, its last amount while it is
        look(k, awaited, address);
        const last = memo.held.get(k);
        if (last !== undefined) held.set(k, { address, mint, amount: last });
        continue;
      }
      // W unread, the finder down or not knowing W yet: W's last, else (never listed, not sold) the record's
      whole = false;
      const last = memo.held.get(k);
      if (last !== undefined) held.set(k, { address, mint, amount: last });
      else if (received !== undefined && !listed.has(k) && !sold.has(k)) held.set(k, { address, mint, amount: received });
    }
    return { held, listed, whole, waits };
  };
  // one position per mint, at its known decimals; an amount whose decimals are not known yet left for the end
  // `lamports`: each W's asset_held read this pass (solanaAssetHeld), else its last read (memo.lamports); a position any
  // of whose Ws has neither has none
  const positionsOf = (held: ReadonlyMap<string, { address: string; mint: string; amount: bigint | string }>, fresh: ReadonlyMap<string, bigint> = new Map()): Position[] => {
    const lamports = r.assetHeld ? new Map([...memo.lamports, ...fresh]) : undefined;
    const by = new Map<string, { amount: bigint; wallets: string[]; held: { address: string; amount: bigint }[] }>();
    for (const h of held.values()) {
      const d = memo.decimals.get(h.mint);
      if (d === undefined) continue;
      const amount = typeof h.amount === "bigint" ? h.amount : base(h.amount, d);
      if (amount === null || amount <= 0n) continue;
      const q = by.get(h.mint) ?? { amount: 0n, wallets: [], held: [] };
      q.amount += amount;
      q.wallets.push(h.address);
      q.held.push({ address: h.address, amount });
      by.set(h.mint, q);
    }
    return [...by].map(([mint, p]) => {
      const decimals = memo.decimals.get(mint)!;
      const sol = lamports !== undefined && p.wallets.every((w) => lamports.has(w)) ? p.wallets.reduce((s, w) => s + lamports.get(w)!, 0n) : null;
      return { chain: "solana" as const, token: mint, amount: poolUnits(p.amount, decimals), cost: positionCost(mint, decimals, p.held, costs), wallets: p.wallets, decimals, ...(sol === null ? {} : { asset_held: poolUnits(sol, SOL_DECIMALS) }) };
    });
  };
  stop();
  // the Ws of open buys first (a record this device has not sold in full), the sold ones behind; each W's row shown as
  // its read comes, every other on the rule for a W unread
  const first = new Set(records.filter(({ address, mint }) => !sold.has(KEY(address, mint))).map(({ address }) => address));
  const soFar = new Map<string, ReadonlyMap<string, bigint> | null>(records.map(({ address }) => [address, null]));
  const each = r.shown
    ? (w: FoundWallet): void => {
        if (r.signal?.aborted || !soFar.has(w.address)) return;
        soFar.set(w.address, w.tokens);
        const t = tally(soFar, true);
        // W's read is the memo's at once, so a pass stopped after it (a sale's read preempts the pass) leaves the next
        // pass W's amount as read, never an older one before W is read again
        if (w.tokens !== null) for (const { address, mint } of records) {
          if (address !== w.address) continue;
          const k = KEY(address, mint);
          const h = t.held.get(k);
          const d = memo.decimals.get(mint);
          const a = h === undefined ? null : typeof h.amount === "bigint" ? h.amount : d === undefined ? null : base(h.amount, d);
          if (a !== null && a > 0n) memo.held.set(k, a);
          else if (h === undefined || a !== null) memo.held.delete(k);
          if (t.listed.has(k)) memo.listed.add(k);
        }
        r.shown!(positionsOf(t.held));
      }
    : undefined;
  let found: readonly FoundWallet[] | null = null;
  try {
    found = records.length === 0 ? [] : await r.wallets(new Set(records.map(({ address }) => address)), { first, ...(each ? { each } : {}) });
  } catch {
    stop();
    whole = false;
  }
  stop();
  const read = new Map<string, ReadonlyMap<string, bigint> | null>();
  for (const w of found ?? []) read.set(w.address, w.tokens);
  const t = tally(read, found !== null);
  if (!t.whole) whole = false;
  wait.push(...t.waits);
  const held = t.held;
  const listed = t.listed;
  // a mint W holds whose record and kept pass name no decimals (no record, or one from before decimals were kept): one
  // read on the finder's own route, once
  for (const m of new Set([...held.values()].map((h) => h.mint))) {
    stop();
    if (memo.decimals.has(m)) continue;
    try {
      memo.decimals.set(m, await r.decimals(m));
    } catch {
      stop();
      whole = false;
    }
  }
  stop();
  // the SOL each W holds beside its token: one read per W the finder read whole this pass, in turn; a failed read is that
  // W's alone (its position goes without asset_held) and the pass runs again
  const lamports = new Map<string, bigint>();
  if (r.assetHeld) for (const h of held.values()) {
    if (!read.get(h.address) || lamports.has(h.address)) continue;
    try {
      lamports.set(h.address, await r.assetHeld(h.address, h.mint, r.signal));
    } catch {
      stop();
      whole = false;
    }
  }
  stop();
  const nextHeld = new Map<string, bigint>();
  for (const [k, h] of held) {
    const d = memo.decimals.get(h.mint);
    // an amount whose decimals are not known yet: never dropped, shown once they are
    if (d === undefined) {
      whole = false;
      if (typeof h.amount === "bigint") nextHeld.set(k, h.amount);
      continue;
    }
    const amount = typeof h.amount === "bigint" ? h.amount : base(h.amount, d);
    if (amount !== null && amount > 0n) nextHeld.set(k, amount);
  }
  const out = positionsOf(held, lamports);
  memo.held = nextHeld;
  memo.listed = listed;
  // each W still held: this pass's read, else its last; a W no longer held is dropped
  const ws = new Set([...held.values()].map((h) => h.address));
  memo.lamports = new Map([...memo.lamports, ...lamports].filter(([w]) => ws.has(w)));
  // only a whole pass is kept, never one a sign out overtook (its store is gone)
  if (whole && !memo.stale) await r.keep?.({ positions: out, held: Object.fromEntries([...nextHeld].map(([k, a]) => [k, a.toString()])), listed: [...listed], ...(memo.lamports.size === 0 ? {} : { lamports: Object.fromEntries([...memo.lamports].map(([w, a]) => [w, a.toString()])) }) }).catch(() => {});
  return { positions: out, whole, ...(wait.length > 0 ? { wait } : {}) };
}

/** A pool asset's amount in base units at `decimals`, in USD at `price` (price x 10^expo USD a whole unit), exact. */
export function usdOf(amount: bigint, decimals: number, price: PoolStatePrice): string | null {
  if (!/^[1-9]\d{0,77}$/.test(price.price) || !Number.isSafeInteger(price.expo) || price.expo > 0) return null;
  return poolUnits(amount * BigInt(price.price), decimals - price.expo);
}

/** The store a pool buy's records go in (the wallet store's ops and meta). */
export type BuyRecordStore = {
  get(store: "ops", key: string): Promise<unknown>;
  put(store: "ops", key: string, value: unknown): Promise<unknown>;
  update(store: "meta", key: string, f: (v: unknown) => unknown): Promise<unknown>;
};
/** What a pool buy run told and asked, for its records. */
export type PoolBuyFacts = { token: string; spend: bigint; spendDecimals: number; price: PoolStatePrice | null; createdMs: number; wallet?: string; out?: string; decimals?: number };
type BuyAnswer = { result: { stage: string; txs: readonly TxRef[] } } | { error: string };

const FINAL = new Set(["filled", "part_filled", "refused", "not_landed"]);

/** The ctx route a buy run tells through, its W and the amount W received kept in `facts` on the way. */
export const routeInto = (facts: PoolBuyFacts, route?: (r: BuyRoute) => void) => (r: BuyRoute): void => {
  if ("wallet" in r) facts.wallet = r.wallet;
  if ("out" in r) facts.out = r.out;
  route?.(r);
};

/** W's buy record from what the run told: the token, the amount W received, the token's decimals when told, and the USD
 *  it spent when a price was read; null without W or that amount. */
function buyRecordOf(f: PoolBuyFacts): PositionCost | null {
  if (f.wallet === undefined || f.out === undefined || !DEC.test(f.out)) return null;
  const usd = f.price === null ? null : usdOf(f.spend, f.spendDecimals, f.price);
  return { mint: f.token, received: f.out, ...(isDecimals(f.decimals) ? { decimals: f.decimals } : {}), ...(usd === null ? {} : { cost_usd: usd }) };
}

/** W's buy record as soon as the run tells the amount W received (card sell-right-after-a-buy: the route's `out`, read
 *  back on both RPCs at confirmed, after its early "sent"), every other W's record kept: the same record a filled end
 *  writes. Nothing else is written: the ops record waits for the run's end. */
export async function recordBoughtOut(store: Pick<BuyRecordStore, "update">, f: PoolBuyFacts): Promise<void> {
  const rec = buyRecordOf(f);
  if (rec === null) return;
  await store.update("meta", POSITION_COSTS_KEY, (v) => ({ ...(typeof v === "object" && v !== null ? v : {}), [f.wallet!]: rec }));
}

/** A pool buy's records once its run ended (see the header): its ops record under the request's id (never over one
 *  already there, nor for an id another tab runs), and when it filled with W and its amount told, W's buy record (with
 *  the token's decimals when told, and the USD it spent when a price was read), every other W's record kept. A run that
 *  ended not_landed or refused on chain (both RPCs' verdict: pool-buy.ts) takes back W's record of this very buy, the
 *  one recordBoughtOut wrote at its read-back; an end not known ("sent") writes nothing, so it stays. */
export async function recordPoolBuy(store: BuyRecordStore, id: string, f: PoolBuyFacts, answer: BuyAnswer | null): Promise<void> {
  if (answer === null || ("error" in answer && answer.error === "id_reused")) return;
  if ((await store.get("ops", id)) !== undefined) return;
  const usd = f.price === null ? null : usdOf(f.spend, f.spendDecimals, f.price);
  const stage = "error" in answer ? "refused" : answer.result.stage;
  // an end only: a run that answered "sent" (read back, its spend not yet read as this attempt's) is the note settle's to
  // finish, which writes no op, so a "sent" record would stay open; and trade.ts settleTradeOps refuses an open buy
  // record with no tx as a trade-box one
  if (!FINAL.has(stage)) return;
  const txs = "error" in answer ? [] : answer.result.txs.map((t) => ({ chain: t.chain, hash: t.hash }));
  // a filled buy's own figures (kit 1.10 OpDetail, card portfolio-shows-pool-trades): the token W received, read back on
  // both RPCs, and the SOL its request spent at the venue; with no `out` told, src/trade-fill.ts reads both from the
  // buy's transaction
  const moved = stage === "filled" && f.out !== undefined && DEC.test(f.out) ? { units: f.out, pool_amount: poolUnits(f.spend, f.spendDecimals) } : {};
  await store.put("ops", id, { kind: "buy", stage, txs, ...("error" in answer ? { code: answer.error } : {}), created_ms: f.createdMs, chain: "solana", token: f.token, ...(usd === null ? {} : { amount_usd: usd }), ...moved });
  const rec = buyRecordOf(f);
  if (rec === null) return;
  if (stage === "filled") return void (await store.update("meta", POSITION_COSTS_KEY, (v) => ({ ...(typeof v === "object" && v !== null ? v : {}), [f.wallet!]: rec })));
  if ("error" in answer || (stage !== "not_landed" && stage !== "refused")) return;
  // W's record only when it is this buy's own (a W takes one buy: its token and the amount it received)
  await store.update("meta", POSITION_COSTS_KEY, (v) => {
    const all = { ...(typeof v === "object" && v !== null ? (v as Record<string, PositionCost>) : {}) };
    const had = Object.hasOwn(all, f.wallet!) ? all[f.wallet!] : undefined;
    if (had?.mint === rec.mint && had.received === rec.received) delete all[f.wallet!];
    return all;
  });
}

export type PositionsCache = {
  /** The last pass (or the kept one before it), or null before either. */
  get(): readonly Position[] | null;
  /** Once per sign-in, before the first pass: the kept pass, if any, read into get(). */
  ready(): Promise<void>;
  /** Once the sign-in's first pass was asked: run a pass now, or once more after the one running. Before it, nothing
   *  (a trade's end after a sign out is no sign-in's first pass). */
  refresh(): void;
  /** The sign-in's first pass, once (a signed-in state read). */
  first(): void;
  /** A signed-in state read's positions: the kept pass read, the sign-in's first pass asked, the last pass; null for a
   *  read a sign out overtook, which asks no pass (the next sign-in's first pass is its own). */
  read(): Promise<readonly Position[] | null>;
  /** A sell's own read of the Ws begins: the running pass stops, a booked retry is dropped, and no pass runs until the
   *  hold ends (its reads never share the finder's queue with the sell's). See PassHold. */
  preempt(): PassHold;
  /** What this tab last read of each W the finder listed (memoListed); null before the kept pass is loaded. */
  listed(): Map<string, Map<string, bigint>> | null;
  /** `fn` runs when a pass changes the positions. */
  watch(fn: () => void): void;
  /** Sign out: the running pass stopped and its answer ignored, the positions and what the passes kept dropped, no
   *  retry left; the next sign-in reads its kept pass and runs its first pass again. */
  clear(): void;
  /** Settles once no pass runs (tests). */
  idle(): Promise<void>;
  /** The last pass was not whole and its round of retries is spent: no pass runs or is booked, so only a refresh() or
   *  once() reads again. */
  spent(): boolean;
  /** One pass, the round of retries left as it is (a spent round books none after it). */
  once(): void;
};

/** A sell's read of the Ws, holding the passes off until it ends, once: fed, the Ws as it read them are the next pass's
 *  read, in place of the finder's; released (the read failed), the next pass reads the finder. Either runs that pass
 *  once no other sell's read holds; a hold from before a sign out ends nothing. */
export type PassHold = { feed(found: readonly FoundWallet[]): void; release(): void };

/** How the cache runs one pass: its stop signal, the sell's read to use when one was fed, and where the pass shows its
 *  rows as its Ws are read (PositionsReads.shown: the positions read gives them at once; never kept). */
export type PassRun = { signal: AbortSignal; found?: readonly FoundWallet[]; shown?: (positions: Position[]) => void };

/** The positions of `pass`, one pass at a time, kept between passes. */
export function positionsCache(pass: (memo: PassMemo, run: PassRun) => Promise<PassResult>, o: { kept?: () => Promise<readonly Position[] | null>; retryMs?: number | ((tries: number) => number); retries?: number; setTimer?: (f: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void; preempted?: () => () => void } = {}): PositionsCache {
  // a fixed wait, or the wait before the try after `tries` tries (a back off)
  const retryMs = (tries: number): number => (typeof o.retryMs === "function" ? o.retryMs(tries) : (o.retryMs ?? POSITIONS_RETRY_MS));
  const retries = o.retries ?? POSITIONS_RETRIES;
  // a retry never holds a process open (Node's unref; a browser's timer has none)
  const setTimer = o.setTimer ?? ((f, ms) => {
    const t = setTimeout(f, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const watchers = new Set<() => void>();
  let last: readonly Position[] | null = null;
  let memo = passMemo();
  let running: Promise<void> | null = null;
  // the running pass's stop
  let current: AbortController | null = null;
  let again = false;
  let fed: readonly FoundWallet[] | null = null;
  // the sells' reads in flight (PassHold): no pass runs while any is
  let holds = 0;
  let gen = 0;
  let tries = 0;
  let timer: unknown = null;
  let started = false;
  let loading: Promise<void> | null = null;
  // the last pass's answer was whole (and looks for nothing again)
  let whole = true;
  const run = (): void => {
    if (timer !== null) clearTimer(timer), (timer = null);
    if (running || holds > 0) return void (again = true);
    const g = gen;
    const stop = new AbortController();
    current = stop;
    const found = fed;
    fed = null;
    // a pass that a sign out or a sell stopped answers nothing
    const live = (): boolean => g === gen && !stop.signal.aborted;
    // booked unless the round of retries has run out (false then)
    const retry = (): boolean => {
      if (!live() || tries >= retries) return false;
      timer = setTimer(() => ((timer = null), run()), retryMs(tries));
      tries++;
      return true;
    };
    const m = memo;
    // a row as soon as its W is read (card wallets-found-in-one-read): the rest on the rule for a W unread, so nothing
    // the last pass showed moves until its W is read again
    const shown = (ps: Position[]): void => {
      if (!live() || JSON.stringify(ps) === JSON.stringify(last)) return;
      last = ps;
      for (const f of watchers) f();
    };
    running = pass(m, { signal: stop.signal, shown, ...(found === null ? {} : { found }) }).then(
      (got) => {
        if (!live()) return;
        whole = got.whole && (got.wait?.length ?? 0) === 0;
        const changed = JSON.stringify(got.positions) !== JSON.stringify(last);
        last = got.positions;
        if (changed) for (const f of watchers) f();
        // a whole pass needs no count reset: every start but a retry's own sets it to 0 first; what a whole pass still
        // looks for, a round of retries in vain ends (PassResult)
        if ((!got.whole || (got.wait?.length ?? 0) > 0) && !retry() && got.whole) for (const k of got.wait ?? []) m.waited.add(k);
      },
      () => {
        if (live()) whole = false;
        void retry();
      },
    ).finally(() => {
      running = null;
      if (current === stop) current = null;
      // asked while it ran, whoever asked: a sign-in's first pass after a sign out included
      if (again) {
        again = false;
        run();
      }
    });
  };
  const cache: PositionsCache = {
    get: () => last,
    ready: () => {
      if (loading === null && o.kept) {
        const g = gen;
        loading = o.kept().then(
          (k) => {
            if (g === gen && last === null && k !== null) last = k;
          },
          () => {},
        );
      }
      return loading ?? Promise.resolve();
    },
    refresh: () => {
      if (!started) return;
      tries = 0;
      run();
    },
    first: () => {
      if (started) return;
      started = true;
      run();
    },
    read: async () => {
      const g = gen;
      await cache.ready();
      if (g !== gen) return null;
      cache.first();
      return last;
    },
    preempt: () => {
      const g = gen;
      holds++;
      current?.abort();
      if (timer !== null) clearTimer(timer), (timer = null);
      // another background read the sell's read stops too (`preempted`: the buy records' rebuild), its end given back
      // once, a sign out between included
      const also = o.preempted?.();
      let ended = false;
      const end = (found: readonly FoundWallet[] | null): void => {
        if (ended) return;
        ended = true;
        also?.();
        if (g !== gen) return;
        holds--;
        if (!started) return;
        if (found !== null) fed = found;
        tries = 0;
        // this pass answers every ask made while the sells read
        again = false;
        run();
      };
      return { feed: (found) => end(found), release: () => end(null) };
    },
    listed: () => memoListed(memo),
    watch: (fn) => void watchers.add(fn),
    clear: () => {
      gen++;
      current?.abort();
      current = null;
      last = null;
      memo.stale = true;
      memo = passMemo();
      started = false;
      loading = null;
      again = false;
      fed = null;
      holds = 0;
      tries = 0;
      whole = true;
      if (timer !== null) clearTimer(timer), (timer = null);
    },
    idle: async () => {
      while (running) await running;
    },
    spent: () => started && !whole && running === null && timer === null && holds === 0,
    once: () => {
      if (started) run();
    },
  };
  return cache;
}

const utf8 = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/** `state` with `positions` when signed in and a pass has run; the oldest ops give way for them as for the vault's
 *  balance (src/vault-balance.ts), and a state they cannot fit, or that the kit's schema refuses with them, goes as it
 *  was. */
export function withPositions(state: SignpageState, positions: readonly Position[] | null): SignpageState {
  if (!state.signed_in || positions === null) return state;
  let out: SignpageState = { ...state, positions };
  if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) out = { ...out, ops: pickOps({ ...out, ops: [] }, state.ops.map((op, t) => ({ op, t }))) };
  if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) return state;
  return SIGNPAGE_RESULT_SCHEMAS.state(out) ? out : state;
}
