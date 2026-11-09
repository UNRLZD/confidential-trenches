// The tokens the device's pool buys hold, on SIGN_HOST's top-level page (card signpage-state-holdings; the kit's
// SignpageState.positions, its shape unchanged).
//
// - Which wallets: the buy wallets the pool's spent notes paid (../../wallet/src/pool/buy-wallets.ts buyWallets, the
//   one finder a restore and a sell use), so a restored device finds the same ones. That read names each W's tokens on
//   one reader (the helper's keyed route on mainnet, a devnet RPC in the testnet build) and only says where to look.
// - What is held: each token that read names, read again as W's associated token account on both of the page's RPCs
//   (pool-sell.ts tokenHeld, the read a sell gates on: the mint's program the same on both, then the account's amount
//   the same on both, read again once). A token's decimals are its mint's on both RPCs (rules/pool.ts tokenDecimalsOf).
//   An amount one RPC alone reports, or that the two read apart, is never shown: the pass fails and the last whole
//   pass stays. A token whose agreed amount is 0 is not held, so after a full sell its position is gone.
// - One position per token: its amount the sum over the Ws that hold it, as an exact decimal at its decimals, and
//   those Ws' addresses. `cost` is "0" (no buy record names it yet), which the app reads as unknown.
// - When: a pass at the first signed-in state read, and again each time a pool buy or sell run ends; never inside a
//   state read, which only takes the last whole pass. One pass at a time: a refresh asked while one runs runs once more
//   after it. A failed pass is tried again POSITIONS_RETRY_MS later, up to POSITIONS_RETRIES times, so a buy's tokens
//   that one RPC has not shown yet still appear without a reload. Sign out drops it all.
// - What crosses to APP_HOST: per token its chain, mint, amount, decimals and the Ws' addresses: amounts, addresses and
//   tokens only, never a note, a key or a path.
import type { SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { ANSWER_ROOM, pickOps } from "./state.ts";
import { poolUnits } from "./rules/pool.ts";

export type Position = SignpageState["positions"][number];

/** A failed pass is tried again this long after it ends. */
export const POSITIONS_RETRY_MS = 5_000;
/** At most this many tries in a row after a failed pass (a minute of a chain catching up), then the next buy, sell or
 *  sign-in load runs it again. */
export const POSITIONS_RETRIES = 12;

/** What a pass reads, every read the device's own. */
export type PositionsReads = {
  /** Each buy wallet with the tokens the finder's read names in it (more than nothing); throws when it cannot list. */
  wallets(): Promise<readonly { address: string; tokens: readonly string[] }[]>;
  /** W's amount of `mint` in base units, the same on both RPCs; throws when they differ or a read fails. */
  held(address: string, mint: string): Promise<bigint>;
  /** The mint's decimals, the same on both RPCs; throws otherwise. */
  decimals(mint: string): Promise<number>;
};

/** One whole pass: the positions of the Solana pool's buy wallets, in the order of the tokens first met. */
export async function positionsPass(r: PositionsReads): Promise<Position[]> {
  const by = new Map<string, { amount: bigint; wallets: string[] }>();
  for (const w of await r.wallets()) {
    for (const mint of new Set(w.tokens)) {
      const amount = await r.held(w.address, mint);
      if (amount <= 0n) continue;
      const p = by.get(mint) ?? { amount: 0n, wallets: [] };
      p.amount += amount;
      p.wallets.push(w.address);
      by.set(mint, p);
    }
  }
  const out: Position[] = [];
  for (const [mint, p] of by) {
    const decimals = await r.decimals(mint);
    out.push({ chain: "solana", token: mint, amount: poolUnits(p.amount, decimals), cost: "0", wallets: p.wallets, decimals });
  }
  return out;
}

export type PositionsCache = {
  /** The last whole pass, or null before the first. */
  get(): readonly Position[] | null;
  /** Run a pass now, or once more after the one running. */
  refresh(): void;
  /** A pass when none has run or is running (a signed-in state read). */
  first(): void;
  /** `fn` runs when a pass changes the positions. */
  watch(fn: () => void): void;
  /** Sign out: the positions dropped, a running pass's answer ignored, no retry left. */
  clear(): void;
  /** Settles once no pass runs (tests). */
  idle(): Promise<void>;
};

/** The positions of `pass`, one pass at a time, kept between passes. */
export function positionsCache(pass: () => Promise<Position[]>, o: { retryMs?: number; retries?: number; setTimer?: (f: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {}): PositionsCache {
  const retryMs = o.retryMs ?? POSITIONS_RETRY_MS;
  const retries = o.retries ?? POSITIONS_RETRIES;
  const setTimer = o.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const watchers = new Set<() => void>();
  let last: readonly Position[] | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let gen = 0;
  let tries = 0;
  let timer: unknown = null;
  const run = (): void => {
    if (timer !== null) clearTimer(timer), (timer = null);
    if (running) return void (again = true);
    const g = gen;
    running = pass().then(
      (got) => {
        if (g !== gen) return;
        tries = 0;
        const changed = JSON.stringify(got) !== JSON.stringify(last);
        last = got;
        if (changed) for (const f of watchers) f();
      },
      () => {
        if (g !== gen || tries >= retries) return;
        tries++;
        timer = setTimer(() => ((timer = null), run()), retryMs);
      },
    ).finally(() => {
      running = null;
      if (again && g === gen) {
        again = false;
        run();
      }
    });
  };
  return {
    get: () => last,
    refresh: () => {
      tries = 0;
      run();
    },
    first: () => {
      if (last === null && running === null && timer === null) run();
    },
    watch: (fn) => void watchers.add(fn),
    clear: () => {
      gen++;
      last = null;
      again = false;
      tries = 0;
      if (timer !== null) clearTimer(timer), (timer = null);
    },
    idle: async () => {
      while (running) await running;
    },
  };
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
