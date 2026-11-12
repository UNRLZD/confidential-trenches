// W's buy records back on a device restored from the 12 words (card restore-rebuilds-buy-records), on SIGN_HOST's
// top-level page.
//
// - Why: a buy writes W's buy record ({ mint, program } in the wallet store's meta/owed/buy-sol, by W's address:
//   pool-sell.ts buyMints, pool-buy.ts h.bought.put) before its send, and that record is what the device reads W by: a
//   position is the token it names (src/positions.ts), a sale reads the Ws it names first (pool-sell.ts planPoolSell),
//   and a W's rent back needs it. A restore writes the notes only (src/pool-restore.ts), so a restored device showed no
//   Solana position and read every W through the finder until its next buy.
// - Which Ws: the ones the pool's SPENT and RESERVED notes paid (../../wallet/src/pool/buy-wallets.ts spentNotesOf),
//   derived by the finder's own derive (derivedBuyWallets, with no read of any W), under the seed's shared lock with the
//   seed zeroed at once; only their addresses are kept. A W that has a buy record this device's own buy wrote, a "read,
//   no buy" mark or a "trades read" mark (below) is not read.
// - What: each W's buy from its own transaction (buy-wallets.ts solanaBuyReader: W signs it, the pinned pool's tag 3
//   names W, one mint rises in W's accounts), on the finder's paced route (the helper's keyed route on mainnet) with a
//   gate of its own, one W at a time in a random order, each call on the host's pass turn (the reader's lane, as the
//   finder's rounds), so a trade's reads go first. A token a stranger sent to W is never a buy, so it gets no record and
//   stays no position.
// - The record written is marked `rebuilt`: it is one provider's word (W's history as the helper answered it), so the
//   rent back counts it as no record and holds (pool-sell.ts rentBackOwed); the rows and which W a sale reads stay on
//   it, and a sale sells only what both RPCs read W holds. A buy on this device writes its own record over it, unmarked.
// - A W whose read is final with no buy (the reader's "none": the pool's own release naming W read, and no buy) gets a
//   "read, no buy" mark (BUY_NONE_KEY) and is not read again; never for a failed, cut short or pruned read.
// - A W the reader cannot tell (null: no release read yet, past its bounds, a list cut short) is read once a page load:
//   this page does not read it again, a run after a sale or a later state read's included (review of ae2cfe28, P2).
//   Its cost a load: one history read, at most SOL_BUY_PAGES getSignaturesForAddress and SOL_BUY_TXS getTransaction
//   (buy-wallets.ts), on the rebuild's own gate and the host's pass turn; 0 at a run after a sale. A W whose read
//   failed (a provider fault, a throttle) is read again at the next run, on that gate.
// - Only the buy record is written: never a cost record (owed/cost-sol), whose amount W received would show a W that
//   sold since at that amount. A sold W gets its buy record as any other: it holds none of the token now, so the
//   positions show nothing for it and a sale reads 0 on it.
// - Written only where none is, in one store update: a record a buy on this device wrote (before its send) is never
//   replaced. Each W is written on its own as it is read, and the positions read again after each, so rows come in as
//   their Ws are read. A run stopped part way (a sign out, a closed tab) leaves the Ws it wrote, each whole; the next
//   run (the next load, or the next restore) reads only the Ws still with none.
// - When: after a restore wrote its notes, and at every signed-in load, never inside the restore's wait or a trade.
//   One run at a time; one asked while a run is on runs once more after it. A W whose read fails, or whose history the
//   reader cannot tell, gets nothing this run. A sale's own read of the Ws (pool-testnet.ts wallets) holds the run off
//   as it holds the positions' pass: the run on stops (the W it was reading gets nothing), none starts while a sale
//   reads, and once the last sale's read ends the run starts again (review of 42a99f81, P2; positions.ts preempted).
// - W's trades (card closed-positions-after-a-restore): Portfolio's closed positions, its calendar and How you trade are
//   the device's own trade ops (apps/terminal/src/screens/portfolio/model.ts tradeBook), which a restore never had: the
//   buy record above names W's mint only. So the same read of W hands back W's buy and its later transactions to its
//   sale in full (buy-wallets.ts solanaBuyReader), and each becomes the op this device would have written for it
//   (restoredTradeOps): a filled pool buy, and a filled pool sale for each transaction in which W, signing, sold the
//   mint (src/trade-fill.ts solanaTradeLeg), each keyed by its signature, at its block's time. Their figures (units,
//   the SOL in and out, the USD at each trade's own block) are src/trade-fill.ts's from the same transactions, as for
//   any record that lacks them. An op is written only where no op of the store names its signature (this device's own
//   ops win), so a rerun adds nothing twice.
// - Which Ws: every W with no buy record of this device's own (none, or a `rebuilt` one) and no final "trades read" mark
//   (TRADES_READ_KEY true): a W whose sale in full was read, every answer up to it its signature's own, gets the mark
//   and is not read again (review of 776d40528, P3-2: never when that sale's answer was not its own, so its op is never
//   lost), with a sale op or without one (review of f73ee1c82, P3-b: a signed sale in full trade-fill.ts cannot read
//   still ends W's trades; read on, W would cost a list call every load for good, and a later dust burn and close
//   would read as a sale paid with the rent back); a W still
//   holding (an open buy, a sale in part, a read cut short) gets the mark as a cursor, { after, mint, program }: the
//   last of its transactions read, and the next load reads W on from there only (buy-wallets.ts `from`: one
//   getSignaturesForAddress `until` it and up to SOL_TRADE_TXS getTransaction), so a sale it makes from another device
//   shows up there and no W is read from its first signature twice (review of 776d40528, P2-1).
// - The sale is W's own: W signs it (buy-wallets.ts solanaSignedBy; review of 776d40528, P3-1).
// - Known and accepted: the helper is the single route for these reads, so it can make up display rows (a buy or a
//   sale that never was, in the closed list and the calendar). It cannot overwrite a real op (an op is written only
//   where none names its signature, and this device's own ops win) and it never reaches a signature: these records are
//   shown, never signed on, and the rebuilt buy record holds the rent back (above).
import { solanaOwnTx, solanaSignedBy, type SolanaBuy, type SolanaBuyReader, type SolanaTradesFrom } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaTradeLeg } from "./trade-fill.ts";

/** The Ws whose history was read for good with no buy, in the wallet store's meta, by W's address. */
export const BUY_NONE_KEY = "owed/buy-sol-none";
/** The Ws whose trades were read to W's sale in full (true), or up to a signature (a SolanaTradesFrom cursor), in the
 *  wallet store's meta, by W's address. */
export const TRADES_READ_KEY = "owed/trades-sol-read";

/** One op a restore writes for W's trade (src/state.ts's op contract; a pool buy has no `sha`, a pool sale pool "sol"). */
export type RestoredTradeOp = {
  key: string;
  rec: { kind: "buy" | "sell"; stage: "filled"; txs: { chain: "solana"; hash: string }[]; created_ms: number; chain: "solana"; token: string; pool?: "sol"; legs?: { wallet: string }[] };
};

/** W's trade ops from its buy read (see the top): its buy (not on a read on, `after`), then each later transaction in
 *  which W, signing, sold the mint. They stop at the first answer that is not its signature's own or has no block time
 *  (its time unknown), as the reader does. */
export function restoredTradeOps(w: string, buy: SolanaBuy): RestoredTradeOp[] {
  const out: RestoredTradeOp[] = [];
  for (const [i, { signature, tx }] of (buy.txs ?? []).entries()) {
    // an answer is this signature's own transaction (its first signature), or no op: the route's word is hostile
    if (!solanaOwnTx(tx, signature)) break;
    const base = { stage: "filled" as const, txs: [{ chain: "solana" as const, hash: signature }], created_ms: ((tx as { blockTime: number }).blockTime) * 1000, chain: "solana" as const, token: buy.mint };
    if (i === 0 && buy.after === undefined) out.push({ key: `restored/${signature}`, rec: { kind: "buy", ...base } });
    else if (solanaSignedBy(tx, w) && solanaTradeLeg(tx, "sell", buy.mint)?.wallet === w) out.push({ key: `restored/${signature}`, rec: { kind: "sell", ...base, pool: "sol", legs: [{ wallet: w }] } });
  }
  return out;
}

/** The wallet store as these records use it. */
export type TradesStore = {
  get(store: "meta" | "ops", key: string): Promise<unknown>;
  keys(store: "ops"): Promise<readonly string[]>;
  update(store: "meta" | "ops", key: string, f: (v: unknown) => unknown): Promise<unknown>;
};
const recordOf = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const fromOf = (v: unknown): SolanaTradesFrom | null => {
  const r = recordOf(v);
  return typeof r.after === "string" && typeof r.mint === "string" && typeof r.program === "string" ? { after: r.after, mint: r.mint, program: r.program } : null;
};

/** The Ws not to read (SolBuyRecordsDeps.done): those with a buy record of this device's own (`buyKey`'s, not
 *  `rebuilt`), a "read, no buy" mark or a final "trades read" mark. */
export async function tradesDone(st: Pick<TradesStore, "get">, buyKey: string): Promise<ReadonlySet<string>> {
  const own = Object.entries(recordOf(await st.get("meta", buyKey))).flatMap(([a, r]) => (recordOf(r).rebuilt === true ? [] : [a]));
  const final = Object.entries(recordOf(await st.get("meta", TRADES_READ_KEY))).flatMap(([a, v]) => (v === true ? [a] : []));
  return new Set([...own, ...Object.keys(recordOf(await st.get("meta", BUY_NONE_KEY))), ...final]);
}

/** Where each W still holding is read on from (its "trades read" cursor; see the top). */
export async function tradesFrom(st: Pick<TradesStore, "get">): Promise<ReadonlyMap<string, SolanaTradesFrom>> {
  return new Map(Object.entries(recordOf(await st.get("meta", TRADES_READ_KEY))).flatMap(([a, v]) => {
    const f = fromOf(v);
    return f === null ? [] : [[a, f] as const];
  }));
}

/** Writes W's trade ops (restoredTradeOps) where no op of the store names their signatures, then W's "trades read"
 *  mark: final once the read reached W's sale in full with every answer its own (see the top); else a cursor at the last transaction read whose answer was its own (see the top). Whether it wrote an op. */
export async function writeTradeOps(st: TradesStore, w: string, buy: SolanaBuy): Promise<boolean> {
  const ops = restoredTradeOps(w, buy);
  const named = new Set<string>();
  for (const k of await st.keys("ops")) {
    const r = (await st.get("ops", k).catch(() => undefined)) as { txs?: unknown } | undefined;
    if (Array.isArray(r?.txs)) for (const t of r.txs) if (typeof (t as { hash?: unknown })?.hash === "string") named.add((t as { hash: string }).hash);
  }
  let wrote = false;
  for (const o of ops) {
    if (named.has(o.rec.txs[0]!.hash)) continue;
    await st.update("ops", o.key, (v) => (v === undefined ? ((wrote = true), o.rec) : undefined));
  }
  const txs = buy.txs ?? [];
  const taken = txs.findIndex(({ signature, tx }) => !solanaOwnTx(tx, signature));
  const read = taken < 0 ? txs : txs.slice(0, taken);
  const last = read.at(-1)?.signature;
  const sold = buy.soldOut === true && taken < 0 && last !== undefined;
  if (sold || last !== undefined) {
    const mark: true | SolanaTradesFrom = sold ? true : { after: last!, mint: buy.mint, program: buy.program };
    // a final mark stays final
    await st.update("meta", TRADES_READ_KEY, (v) => (recordOf(v)[w] === true ? undefined : { ...recordOf(v), [w]: mark }));
  }
  return wrote;
}

export type SolBuyRecordsDeps = {
  /** The addresses of the Ws the pool's SPENT and RESERVED notes paid (see the top); nothing is read for them. */
  wallets(signal: AbortSignal): Promise<readonly string[]>;
  /** The Ws not to read: those with a buy record of this device's own (owed/buy-sol, not `rebuilt`), a "read, no buy"
   *  mark (BUY_NONE_KEY) or a "trades read" mark (TRADES_READ_KEY). */
  done(): Promise<ReadonlySet<string>>;
  /** Writes W's rebuilt buy record only when W has none, or its "read, no buy" mark; whether it wrote a buy record. */
  write(address: string, buy: SolanaBuy | "none"): Promise<boolean>;
  /** Writes W's trade ops and its "trades read" mark (writeTradeOps); whether it wrote an op. None: no trade is written
   *  (tests of the records alone). */
  trades?(address: string, buy: SolanaBuy): Promise<boolean>;
  /** Where each W still holding is read on from (tradesFrom). None: every W from its buy. */
  from?(): Promise<ReadonlyMap<string, SolanaTradesFrom>>;
  /** W's buy from its own history, each call on the host's pass turn. */
  reader: SolanaBuyReader;
  /** A W's record was written: the positions read again. */
  wrote(): void;
  /** Tests only: the order the Ws are read in. */
  pick?: (n: number) => number;
};

export type SolBuyRecords = {
  /** A run, or one more after the run on (see the top). */
  run(): void;
  /** A sign out: the run on stops, and writes nothing after. */
  stop(): void;
  /** A sale's read of the Ws begins: the run on stops and none starts until the returned end; then the run starts again
   *  when one was stopped or asked meanwhile. */
  hold(): () => void;
  /** Settles once no run is on. */
  idle(): Promise<void>;
};

const randomIndex = (n: number): number => {
  const max = Math.floor(0x1_0000_0000 / n) * n;
  const b = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(b);
  while (b[0]! >= max);
  return b[0]! % n;
};

export function solBuyRecords(d: SolBuyRecordsDeps): SolBuyRecords {
  const pick = d.pick ?? randomIndex;
  let stop = new AbortController();
  let on: Promise<void> | null = null;
  let again = false;
  let holds = 0;
  // a run stopped by a hold, or asked during one: it runs once the last hold ends
  let missed = false;

  const halt = (reason: string): void => {
    stop.abort(new Error(reason));
    stop = new AbortController();
    on = null;
    again = false;
  };

  // the Ws this page load read whole with no answer (see the top): never read again before the next load or sign-in
  let unanswered = new Set<string>();
  const once = async (signal: AbortSignal): Promise<void> => {
    const ws = await d.wallets(signal);
    if (ws.length === 0) return;
    const had = await d.done();
    const from = (await d.from?.()) ?? new Map<string, SolanaTradesFrom>();
    const todo = [...new Set(ws)].filter((a) => !had.has(a) && !unanswered.has(a));
    for (let i = todo.length - 1; i > 0; i--) {
      const r = pick(i + 1);
      if (!Number.isInteger(r) || r < 0 || r > i) throw new Error("pick: not an index");
      [todo[i], todo[r]] = [todo[r]!, todo[i]!];
    }
    for (const w of todo) {
      signal.throwIfAborted();
      let buy: SolanaBuy | "none" | null;
      try {
        buy = await d.reader.read(w, signal, from.get(w));
      } catch {
        signal.throwIfAborted();
        // this W's read failed: it keeps none, and the next run reads it again
        continue;
      }
      signal.throwIfAborted();
      if (buy === null) unanswered.add(w);
      else {
        const wrote = await d.write(w, buy);
        // W's trades: read again at a later load only while W still holds (see the top)
        if ((buy !== "none" && (await d.trades?.(w, buy))) || wrote) d.wrote();
        // a W whose trades were read: once a page load, as a W with no answer (a sold-out one has its mark)
        if (buy !== "none" && buy.txs !== undefined) unanswered.add(w);
      }
    }
  };

  const start = (): Promise<void> => {
    const signal = stop.signal;
    const p: Promise<void> = (async () => {
      do {
        again = false;
        await once(signal).catch(() => {});
      } while (again && !signal.aborted);
    })().finally(() => {
      // a run a sign out stopped is no longer the one on: a run asked since is its own
      if (on === p) on = null;
    });
    return p;
  };

  const run = (): void => {
    if (holds > 0) {
      missed = true;
      return;
    }
    if (on !== null) {
      again = true;
      return;
    }
    on = start();
  };

  return {
    run,
    stop() {
      halt("signed out");
      missed = false;
      unanswered = new Set();
    },
    hold() {
      holds++;
      if (on !== null) {
        halt("a sale reads the wallets");
        missed = true;
      }
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        holds--;
        if (holds === 0 && missed) {
          missed = false;
          run();
        }
      };
    },
    idle: () => on ?? Promise.resolve(),
  };
}
