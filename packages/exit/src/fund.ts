// The fee wallet's wait (card exit-with-only-the-words): every fee of an exit is paid by a wallet of the 12 words, never
// by a server of ours. When that wallet holds less than the fees it pays, the command says its address and how much it
// is short, in the chain's own unit, then reads its balance again until the money is there: the user sends it from any
// wallet, exchange or friend, and the exit goes on by itself.

/** What fundedOrWait reads and says. `balance` reads the fee wallet on both of the chain's RPCs and gives the lower, or throws. */
export type FundWait = {
  /** the fee wallet's address, as the user sends money to it */
  address: string;
  /** what it must hold before the next transaction, in base units */
  need: bigint;
  /** the chain's unit and its decimals, for the line the user reads */
  unit: { symbol: string; decimals: number };
  balance(): Promise<bigint>;
  say(line: string): void;
  sleep(ms: number): Promise<void>;
};

/** How long between two reads of a short fee wallet. */
export const FUND_POLL_MS = 10_000;

/** Base units as a decimal number of the unit: 1500000 at 6 decimals is "1.5". */
export function units(x: bigint, decimals: number): string {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const d = 10n ** BigInt(decimals);
  const frac = (a % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / d}${frac ? `.${frac}` : ""}`;
}

/**
 * The fee wallet's balance once it holds `need`: read at once, and while short, one line naming its address and the
 * amount it is short (said once, and again only when the shortfall changes), then read again every FUND_POLL_MS. A read
 * that throws is said and read again; it never counts as funded.
 */
export async function fundedOrWait(w: FundWait): Promise<bigint> {
  let said: bigint | null = null;
  for (;;) {
    let have: bigint;
    try {
      have = await w.balance();
    } catch (e) {
      w.say(`could not read ${w.address}'s balance (${e instanceof Error ? e.message : String(e)}); reading again`);
      await w.sleep(FUND_POLL_MS);
      continue;
    }
    if (have >= w.need) return have;
    const short = w.need - have;
    if (said !== short) {
      w.say(`Send ${units(short, w.unit.decimals)} ${w.unit.symbol} to ${w.address} to pay the fees (it holds ${units(have, w.unit.decimals)}, needs ${units(w.need, w.unit.decimals)}). Waiting...`);
      said = short;
    }
    await w.sleep(FUND_POLL_MS);
  }
}
