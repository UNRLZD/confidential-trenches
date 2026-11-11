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
//   seed zeroed at once; only their addresses are kept. A W that already has a buy record is not read.
// - What: each W's buy from its own transaction (buy-wallets.ts solanaBuyReader: W signs it, the pinned pool's tag 3
//   names W, one mint rises in W's accounts), on the finder's route (the helper's keyed route on mainnet), one W at a
//   time in a random order, each W's reads on the finder host's pass turn, so a trade's reads go first. A token a
//   stranger sent to W is never a buy, so it gets no record and stays no position.
// - Only the buy record is written: never a cost record (owed/cost-sol), whose amount W received would show a W that
//   sold since at that amount. A sold W gets its buy record as any other: it holds none of the token now, so the
//   positions show nothing for it and a sale reads 0 on it.
// - Written only where none is, in one store update: a record a buy on this device wrote (before its send) is never
//   replaced. Each W is written on its own as it is read, and the positions read again after each, so rows come in as
//   their Ws are read. A run stopped part way (a sign out, a closed tab) leaves the Ws it wrote, each whole; the next
//   run (the next load, or the next restore) reads only the Ws still with none.
// - When: after a restore wrote its notes, and at every signed-in load, never inside the restore's wait or a trade.
//   One run at a time; one asked while a run is on runs once more after it. A W whose read fails, or whose history the
//   reader cannot tell, gets nothing this run.
import type { SolanaBuy, SolanaBuyReader } from "../../wallet/src/pool/buy-wallets.ts";

export type SolBuyRecordsDeps = {
  /** The addresses of the Ws the pool's SPENT and RESERVED notes paid (see the top); nothing is read for them. */
  wallets(signal: AbortSignal): Promise<readonly string[]>;
  /** The buy records as stored (owed/buy-sol), by W's address. */
  records(): Promise<Readonly<Record<string, unknown>>>;
  /** Writes W's buy record only when W has none; whether it wrote. */
  write(address: string, buy: SolanaBuy): Promise<boolean>;
  /** W's buy from its own history. */
  reader: SolanaBuyReader;
  /** Waits the finder host's pass turn (the page's budget for it: trades first). */
  turn(signal: AbortSignal): Promise<void>;
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

  const once = async (signal: AbortSignal): Promise<void> => {
    const ws = await d.wallets(signal);
    if (ws.length === 0) return;
    const had = await d.records();
    const todo = [...new Set(ws)].filter((a) => !Object.hasOwn(had, a));
    for (let i = todo.length - 1; i > 0; i--) {
      const r = pick(i + 1);
      if (!Number.isInteger(r) || r < 0 || r > i) throw new Error("pick: not an index");
      [todo[i], todo[r]] = [todo[r]!, todo[i]!];
    }
    for (const w of todo) {
      signal.throwIfAborted();
      let buy: SolanaBuy | null;
      try {
        await d.turn(signal);
        buy = await d.reader.read(w, signal);
      } catch {
        signal.throwIfAborted();
        // this W's read failed: it keeps none, and the next run reads it again
        continue;
      }
      signal.throwIfAborted();
      if (buy !== null && (await d.write(w, buy))) d.wrote();
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

  return {
    run() {
      if (on !== null) {
        again = true;
        return;
      }
      on = start();
    },
    stop() {
      stop.abort(new Error("signed out"));
      stop = new AbortController();
      on = null;
      again = false;
    },
    idle: () => on ?? Promise.resolve(),
  };
}
