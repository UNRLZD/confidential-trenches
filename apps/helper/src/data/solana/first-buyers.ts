// Snipers and bundlers of a Solana token from its first trades, read on chain (card token-page-data-complete-and-fast).
// The definitions are the main product's ("NEAR trading terminal" services/engine/src/core/holder-risk.ts:143-146,
// :241 and :296-308), with a slot for its block:
//   - Snipers: the wallets whose first buy is within SNIPER_SLOTS (3) slots of the token's first decoded trade; their
//     share is what they hold now, of the supply.
//   - Bundlers: when BUNDLE_WALLETS (2) or more wallets make their first buy in the first trade's own slot, what they
//     hold now; fewer, 0.
//   Each leaves out the creator (the dev) and any wallet off ed25519 (a program address: a pool, a curve, a vault).
// Insiders (the main product: holders whose first receipt was a direct transfer from the dev, holder-risk.ts:147-150)
// need every holder's first receipt, which the first trades do not give; they are not read here and stay absent.
// Bounded reads: the mint's signatures newest first, SIG_PAGES pages of 1,000 at most, to its oldest (a token with more
// has no value: the first trades are out of reach, never guessed); its first trades' transactions, TX_MAX at most (a
// window with more has no value); the buyers' token accounts in one getMultipleAccounts. Every answer is hostile input:
// a page, a transaction or an account not of its shape is no value. The venues decoded are decode.ts's (pump.fun's
// curve and PumpSwap): a token whose first trades decode to none has no value.
import { fromInner, fromLogs, type RawTrade } from "./decode.ts";
import { address, b58decode } from "./lists.ts";
import { onCurve, pda } from "./origin.ts";

export const SNIPER_SLOTS = 3;
export const BUNDLE_WALLETS = 2;
export const SIG_PAGES = 3;
export const SIG_PAGE = 1_000;
export const TX_MAX = 40;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xV4Nh5Kbta2JmfVwv";

/** One of the mint's signatures as getSignaturesForAddress answers it. */
export type Sig = { signature: string; slot: number; err: unknown };
export type FirstBuys = { anchor: number; buyers: Map<string, number> };
export type Shares = { snipers_bps: number; bundlers_bps: number };

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const wallet = (a: string): boolean => onCurve(b58decode(a) ?? new Uint8Array());

/** The first buys of `mint` from its first trades (each with its slot, oldest first): the first trade's slot and each
 *  wallet's first buy slot within SNIPER_SLOTS of it, the creator and program addresses left out; null with no trade. */
export function firstBuys(trades: readonly { slot: number; t: RawTrade }[], mint: string, creator: string | null): FirstBuys | null {
  const mine = trades.filter((x) => x.t.mint === null || x.t.mint === mint).sort((a, b) => a.slot - b.slot);
  if (mine.length === 0) return null;
  const anchor = mine[0]!.slot;
  const buyers = new Map<string, number>();
  for (const { slot, t } of mine) {
    if (slot >= anchor + SNIPER_SLOTS) break;
    if (t.side !== "b" || t.user === creator || buyers.has(t.user) || !wallet(t.user)) continue;
    buyers.set(t.user, slot);
  }
  return { anchor, buyers };
}

/** Their shares of `supply`, from what each wallet holds now (`held`; a wallet not in it holds 0). */
export function shares(f: FirstBuys, held: ReadonlyMap<string, bigint>, supply: bigint): Shares | null {
  if (supply <= 0n) return null;
  const sum = (ws: Iterable<string>) => [...ws].reduce((s, w) => s + (held.get(w) ?? 0n), 0n);
  const bps = (v: bigint) => Math.min(10_000, Number((v * 10_000n) / supply));
  const inSlot = [...f.buyers].filter(([, s]) => s === f.anchor).map(([w]) => w);
  return { snipers_bps: bps(sum(f.buyers.keys())), bundlers_bps: inSlot.length >= BUNDLE_WALLETS ? bps(sum(inSlot)) : 0 };
}

/** A wallet's associated token account for `mint` under `program` (the token program that owns the mint). */
export const ata = (owner: string, mint: string, program: string): string => pda([b58decode(owner)!, b58decode(program)!, b58decode(mint)!], ATA_PROGRAM);

type Call = (method: string, params: unknown[]) => Promise<unknown>;

/** The first buys read on chain, or null when the reads cannot give them within their bounds. */
export async function readFirstBuys(call: Call, mint: string, creator: string | null): Promise<FirstBuys | null> {
  const sigs: Sig[] = [];
  let before: string | undefined;
  let oldest = false;
  for (let page = 0; page < SIG_PAGES && !oldest; page++) {
    const got = await call("getSignaturesForAddress", [mint, { limit: SIG_PAGE, commitment: "confirmed", ...(before === undefined ? {} : { before }) }]);
    if (!Array.isArray(got) || got.length > SIG_PAGE) return null;
    for (const s of got) {
      const o = obj(s);
      if (typeof o.signature !== "string" || o.signature.length > 100 || !Number.isSafeInteger(o.slot)) return null;
      sigs.push({ signature: o.signature, slot: o.slot as number, err: o.err ?? null });
    }
    oldest = got.length < SIG_PAGE;
    before = sigs.at(-1)?.signature;
  }
  if (!oldest || sigs.length === 0) return null;
  // oldest first, the transactions read until the first trade's SNIPER_SLOTS slots are past, TX_MAX at most
  const ok = sigs.filter((s) => s.err === null).sort((x, y) => x.slot - y.slot);
  const trades: { slot: number; t: RawTrade }[] = [];
  let anchor: number | null = null;
  let read = 0;
  for (const s of ok) {
    if (anchor !== null && s.slot >= anchor + SNIPER_SLOTS) break;
    if (read++ === TX_MAX) return null;
    // version 1 transactions are on mainnet (as trades.ts reads them): a client that names 0 is refused (-32015)
    const tx = obj(await call("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]));
    if (obj(tx.meta).err != null) continue;
    const logs = fromLogs(obj(tx.meta).logMessages);
    const got = (logs.truncated ? fromInner(tx) : logs.trades).filter((t) => t.mint === null || t.mint === mint);
    for (const t of got) trades.push({ slot: s.slot, t });
    if (anchor === null && got.length > 0) anchor = s.slot;
  }
  return firstBuys(trades, mint, creator);
}

/** What each first buyer holds now: their associated token accounts' amounts, one getMultipleAccounts; null when an
 *  answer is not of its shape. */
export async function readHeld(call: Call, f: FirstBuys, mint: string, program: string): Promise<Map<string, bigint> | null> {
  const ws = [...f.buyers.keys()];
  const held = new Map<string, bigint>();
  if (ws.length === 0) return held;
  const v = await call("getMultipleAccounts", [ws.map((w) => ata(w, mint, program)), { encoding: "jsonParsed", commitment: "confirmed" }]);
  if (!Array.isArray(v) || v.length !== ws.length) return null;
  for (let i = 0; i < ws.length; i++) {
    if (v[i] === null) continue; // no account: holds 0
    const info = obj(obj(obj(obj(v[i]).data).parsed).info);
    const amt = obj(info.tokenAmount).amount;
    if (info.mint !== mint || address(info.owner) !== ws[i] || typeof amt !== "string" || !/^\d{1,20}$/.test(amt)) return null;
    held.set(ws[i]!, BigInt(amt));
  }
  return held;
}
