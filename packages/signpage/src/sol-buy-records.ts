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
//   seed zeroed at once; only their addresses are kept. A W that already has a buy record, or a "read, no buy" mark, is
//   not read.
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
import type { SolanaBuy, SolanaBuyReader } from "../../wallet/src/pool/buy-wallets.ts";

/** The Ws whose history was read for good with no buy, in the wallet store's meta, by W's address. */
export const BUY_NONE_KEY = "owed/buy-sol-none";

export type SolBuyRecordsDeps = {
  /** The addresses of the Ws the pool's SPENT and RESERVED notes paid (see the top); nothing is read for them. */
  wallets(signal: AbortSignal): Promise<readonly string[]>;
  /** The Ws not to read: those with a buy record (owed/buy-sol) or a "read, no buy" mark (BUY_NONE_KEY). */
  done(): Promise<ReadonlySet<string>>;
  /** Writes W's rebuilt buy record only when W has none, or its "read, no buy" mark; whether it wrote a buy record. */
  write(address: string, buy: SolanaBuy | "none"): Promise<boolean>;
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
        buy = await d.reader.read(w, signal);
      } catch {
        signal.throwIfAborted();
        // this W's read failed: it keeps none, and the next run reads it again
        continue;
      }
      signal.throwIfAborted();
      if (buy === null) unanswered.add(w);
      else if (await d.write(w, buy)) d.wrote();
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
