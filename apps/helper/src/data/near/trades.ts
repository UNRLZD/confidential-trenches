// GET /v1/market/trades and /v1/market/candles with chain=near: a NEAR token's trade tape and chart, in the shapes the
// other chains answer ({ trades, src, as_of_ms } and { tf, candles, src, as_of_ms }, ../candles.ts TapeRow and Candle),
// from the token's own swaps on Rhea classic (v2.ref-finance.near) against wNEAR.
//
// Source: FastNEAR's free transactions API (tx.main.fastnear.com, read 2026-11-11 18:2xZ), which serves a transaction's
// receipts and their logs by account. `POST /v0/account` lists the newest transactions that touched the token's contract (up to
// 200 an answer), `POST /v0/transactions` gives each one's receipts and logs (at most 20 hashes a call: a call with 40
// answered 400 "Limit is 20", read 2026-11-11 18:23Z). No rate limit is published or sent in its headers (same read),
// so a token's reads are held for FRESH_MS and only hashes not read before are asked for. A swap is Rhea's own log line
// on a receipt v2.ref-finance.near executed: `Swapped <amount> <token> for <amount> <token>[, total fee ..]`; one with
// the token on one side and wNEAR on the other is a trade (wNEAR in: a buy; wNEAR out: a sell), priced by the one rule
// of ../candles.ts with wNEAR as the quote at NEAR's USD price of the latest pool read (lists.ts). The chart also holds
// the main pool's state at that read as its mark, so a quiet pool still draws its price.
//
// Display only: nothing here feeds a signature. Every answer is hostile input: size bounded, hashes and accounts checked,
// amounts digit strings, at most READ_TXS transactions a token.
import { createBook, TF_SECONDS, type Event, type Tf } from "../candles.ts";
import { NOT_FOUND, UPSTREAM, type DataAnswer } from "../solana/token.ts";
import { WNEAR, WNEAR_DECIMALS, REF, type NearLists } from "./lists.ts";
import { nearAccount, pacedFetch, type Fetch } from "./views.ts";

export const TX_API = "https://tx.main.fastnear.com";
/** Transactions read a token: three calls of 20 [design: 20 answered in 1.0-1.9 s and ~440 KB from a Mac; the tape
 *  shows 50]. A first read asks for one call's worth (TX_BATCH), so a cold page waits on two calls, not four; the next
 *  read brings the rest (only hashes not read before are asked for). */
export const READ_TXS = 60;
const TX_BATCH = 20;
/** A token's reads are served as held this long; past it the next ask reads the newest. */
export const FRESH_MS = 5_000;
export const TRADES_MAX = 50;
const ANSWER_MAX = 8 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
const TOKENS_MAX = 500;
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const SWAP = /^Swapped (\d{1,40}) (\S{2,64}) for (\d{1,40}) (\S{2,64})(, total fee \d{1,40}, admin fee \d{1,40})?$/;

/** `pos`: the receipt's outcome index and the log's place in it, as read (two transactions' receipts in one block can
 *  share it); `index`: the swap's place in its block once sorted by (block, pos, tx), unique, the book's order. */
export type NearSwap = { block: number; pos: number; index: number; tx: string; t: number; side: "b" | "s"; amt: bigint; quote: bigint; trader: string | null };

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The swaps of `token` against wNEAR in one `/v0/transactions` entry. */
export function swapsOf(token: string, entry: unknown): NearSwap[] {
  const e = obj(entry);
  const tx = obj(e.transaction);
  const hash = typeof tx.hash === "string" && HASH.test(tx.hash) ? tx.hash : null;
  if (hash === null || !Array.isArray(e.receipts)) return [];
  const trader = nearAccount(tx.signer_id);
  const out: NearSwap[] = [];
  for (const r of e.receipts) {
    const o = obj(obj(r).execution_outcome);
    const outcome = obj(o.outcome);
    if (outcome.executor_id !== REF || !Array.isArray(outcome.logs)) continue;
    const block = o.block_height;
    const at = o.block_timestamp;
    const index = o.index;
    if (!Number.isSafeInteger(block) || !Number.isFinite(at) || !Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > 100_000) continue;
    outcome.logs.slice(0, 64).forEach((l: unknown, i: number) => {
      const m = typeof l === "string" ? SWAP.exec(l) : null;
      if (m === null) return;
      const [, a, ta, b, tb] = m as unknown as [string, string, string, string, string];
      const buy = ta === WNEAR && tb === token;
      const sell = ta === token && tb === WNEAR;
      if (!buy && !sell) return;
      const amt = BigInt(buy ? b : a);
      const quote = BigInt(buy ? a : b);
      if (amt <= 0n || quote <= 0n) return;
      out.push({ block: block as number, pos: (index as number) * 64 + i, index: 0, tx: hash, t: Math.floor((at as number) / 1e9), side: buy ? "b" : "s", amt, quote, trader });
    });
  }
  return out;
}

/** Swaps in (block, pos, tx) order, each one's `index` its place in its block. */
export function ordered(swaps: readonly NearSwap[]): NearSwap[] {
  const out = [...swaps].sort((x, y) => x.block - y.block || x.pos - y.pos || (x.tx < y.tx ? -1 : x.tx > y.tx ? 1 : 0));
  let n = 0;
  return out.map((s, i) => ({ ...s, index: i > 0 && out[i - 1]!.block === s.block ? ++n : (n = 0) }));
}

async function post(fetchFn: Fetch, path: string, body: unknown): Promise<unknown> {
  const r = await fetchFn(`${TX_API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status !== 200) throw new Error(`tx api ${r.status}`);
  const text = await r.text();
  if (text.length > ANSWER_MAX) throw new Error("tx api answer too large");
  return JSON.parse(text);
}

type Held = { at: number; seen: Set<string>; swaps: NearSwap[] };

export function createNearTrades(lists: NearLists, deps: { fetch?: Fetch; now?: () => number } = {}) {
  const fetchFn: Fetch = deps.fetch ?? pacedFetch();
  const now = deps.now ?? Date.now;
  const held = new Map<string, Held>();
  const reading = new Map<string, Promise<Held | null>>();

  async function read(token: string): Promise<Held | null> {
    const had = held.get(token);
    const max = had === undefined ? TX_BATCH : READ_TXS;
    const list = obj(await post(fetchFn, "/v0/account", { account_id: token, max, is_success: true })).account_txs;
    if (!Array.isArray(list)) throw new Error("tx api: no list");
    // the API answered more than `max` (60 for 20, 2026-11-11 18:32Z): only the newest `max` are read
    const hashes = [...new Set(list.slice(0, max).map((x) => obj(x).transaction_hash).filter((h): h is string => typeof h === "string" && HASH.test(h)))];
    const fresh = hashes.filter((h) => !had?.seen.has(h));
    const batches = Array.from({ length: Math.ceil(fresh.length / TX_BATCH) }, (_, i) => fresh.slice(i * TX_BATCH, (i + 1) * TX_BATCH));
    const answers = await Promise.all(batches.map((b) => post(fetchFn, "/v0/transactions", { tx_hashes: b })));
    const found: NearSwap[] = [];
    for (const a of answers) {
      const txs = obj(a).transactions;
      if (!Array.isArray(txs)) throw new Error("tx api: no transactions");
      for (const t of txs.slice(0, TX_BATCH)) found.push(...swapsOf(token, t));
    }
    const keep = new Set(hashes);
    const swaps = ordered([...(had?.swaps.filter((s) => keep.has(s.tx)) ?? []), ...found]);
    const h: Held = { at: now(), seen: new Set(hashes), swaps };
    if (!held.has(token) && held.size >= TOKENS_MAX) held.delete(held.keys().next().value!);
    held.set(token, h);
    return h;
  }

  /** The token's held swaps, read now when none are held or they are past FRESH_MS (the held ones serve while it reads). */
  async function open(token: string): Promise<{ h: Held; main: NonNullable<Awaited<ReturnType<NearLists["row"]>>> } | "none" | null> {
    const t = nearAccount(token);
    if (t === null) return "none";
    const r = await lists.row(t);
    if (r === null) return "none";
    const had = held.get(t);
    if (had === undefined || now() - had.at > FRESH_MS) {
      let p = reading.get(t);
      if (p === undefined) {
        p = read(t).catch(() => null).finally(() => reading.delete(t));
        reading.set(t, p);
      }
      if (had === undefined) {
        const got = await p;
        return got === null ? null : { h: got, main: r };
      }
    }
    return { h: had!, main: r };
  }

  function bookOf(o: { h: Held; main: NonNullable<Awaited<ReturnType<NearLists["row"]>>> }) {
    const s = lists.scan();
    const book = createBook({ decimals: o.main.meta.decimals, quote: { kind: "eth", decimals: WNEAR_DECIMALS } });
    const nearUsd = s?.nearUsd ?? null;
    const swaps = o.h.swaps;
    if (nearUsd !== null) {
      const first = swaps[0]?.block ?? s!.height;
      const events: Event[] = [{ kind: "ref", block: first, index: -1, ethUsd: nearUsd }, ...swaps.map((w) => ({ kind: "swap" as const, block: w.block, index: w.index, tx: w.tx, t: w.t, side: w.side, amt: w.amt, quote: w.quote }))];
      book.ingest(first, events, Math.max(first, swaps.at(-1)?.block ?? first));
      if (s !== null) book.mark({ block: s.height, t: Math.floor(s.t_ms / 1000), amt: o.main.main.amt, quote: o.main.main.wnear, ethUsd: nearUsd });
    }
    return book;
  }

  return {
    /** 06b Trades: the newest `limit` swaps, newest first; 404 for a token with no Rhea wNEAR pool, 503 when no read landed. */
    async trades(token: string, limit: number): Promise<DataAnswer> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > TRADES_MAX) return NOT_FOUND;
      const o = await open(token);
      if (o === "none") return NOT_FOUND;
      if (o === null) return UPSTREAM;
      const traders = new Map(o.h.swaps.map((s) => [`${s.tx}:${s.block}:${s.index}`, s.trader]));
      const rows = bookOf(o).tape(limit).map((r) => ({ t_ms: r.t_ms, side: r.side, usd: r.usd, amt: r.amt, trader: traders.get(`${r.tx}:${r.block}:${r.index}`) ?? null, tx: r.tx }));
      const at = o.h.at;
      return { status: 200, body: JSON.stringify({ trades: rows, src: "fastnear", as_of_ms: at }), src: "fastnear", asOfMs: at };
    },
    /** 06b Candles of `tf`: bars from the swaps read and the main pool's mark, oldest first. */
    async candles(token: string, tf: string, to: number | null, limit: number): Promise<DataAnswer> {
      if (!Object.hasOwn(TF_SECONDS, tf)) return NOT_FOUND;
      const o = await open(token);
      if (o === "none") return NOT_FOUND;
      if (o === null) return UPSTREAM;
      const at = o.h.at;
      const candles = bookOf(o).candles(tf as Tf, to, limit);
      return { status: 200, body: JSON.stringify({ tf, candles, src: "fastnear", as_of_ms: at }), src: "fastnear", asOfMs: at };
    },
  };
}
export type NearTrades = ReturnType<typeof createNearTrades>;
