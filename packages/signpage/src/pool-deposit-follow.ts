// The follow of a pool deposit quote (card pool-deposit-follow): money 1Click delivers to U_X, chain X's one-time
// deposit wallet that pool.address showed, is carried on into X's pool with no tap. The vault's follow
// (../../wallet/src/deposit/follow.ts followDeposit) is the pattern: a status answer from the server moves only the stage
// shown and never ends a follow; the device's own chain reads decide.
// - Each round reads the chain first: U_X's balance at finalized on X's two RPCs, the lower of the two counted. While
//   it covers one deposit (`floor`: the rung, one deposit's worst-case cost and, on Solana, the rent U_X keeps; the
//   floor the quote was held to, pool-deposit-quote.ts), pool.deposit runs from U_X (`deposit`, the page's own kind,
//   under pool-deposit-sent-end's end rules: its answer at its first send, its end as progress), for the largest ask
//   that U_X's lower balance pays with each rung's worst-case cost and the rent kept (askOf). Anything that credits U_X,
//   a stranger's gift or a late second send too, is carried on, so nothing under U_X is left unfollowed.
// - 1Click's status of the quote's deposit address (`status`, read through the helper) is hostile: it counts only for
//   our address with U_X as its recipient and U_{s,i} as its refund (readDepositStatus), and then it moves only the
//   stage shown, never back. SUCCESS shows nothing the chain has not read: in_transit until U_X's balance reads.
// - The end: in_pool once a deposit from U_X ended filled (or part_filled with nothing of the ask open) and U_X's lower
//   balance no longer covers one more deposit; the follow then reads on to the quote's deadline past on both RPCs'
//   clocks (`past`), so a late second send to U_X is carried too. A deposit that ends not_landed, or a provider down, is
//   read again next round; only the signal (a sign out) ends a follow early. A quote with nothing seen sent by its
//   deadline shows expired and is read on (a late send is refunded by 1Click and carried); a stale status never shows
//   it live again.
// - REFUNDED: refunded is shown; the money is under U_{s,i} inside intents.near, and the refund carry (`refund`,
//   poolRefundMover below: moved with the same signer back to X's coin, to U_X, and carried on by the rounds above) is
//   asked once per round while the status reads REFUNDED. With no `refund` given the stage stays refunded and the follow does not end (followed on at
//   every landing), so no refund is left as if done.
// - Pace: FAST_MS while a status shows a send in flight or a deposit ran; else SLOW_MS doubling to SLOW_MAX_MS.
// Nothing here logs. Every read names one public account (U_X) or the quote's deposit address; no request carries a
// key, the words, or which note is whose.
import type { PoolChain } from "../../kit/src/signpage/messages.ts";
import { ladderSplit, type Ladder } from "../../wallet/src/pool/ladder.ts";
import { type MoveRead, type OneClickStatus, readDepositStatus, type StatusRead } from "../../wallet/src/deposit/follow.ts";
import { solanaRentMin } from "../../kit/src/trade/solana/pool-buy.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { SOL_LADDER } from "../../wallet/src/pool/solana.ts";
import { readSolanaPoolCosts } from "./pool-deposit-address.ts";
import { solanaPoolDepositFloor } from "./pool-deposit-quote.ts";
import { hex } from "@scure/base";
import type { OneClickPricing } from "../../kit/src/checks/oneclick.ts";
import type { HelperSignedIntent } from "../../kit/src/helper/v1.ts";
import { depositId } from "../../wallet/src/derive/keys.ts";
import { type MoveRecord, poolRefundMoveRequest, runRefundMove } from "../../wallet/src/deposit/refund.ts";
import { DEPOSIT_QUOTE_PATH } from "./rules/deposit-dry.ts";
import { checkIdTransferIntent, checkPoolRefundQuote, signIdIntent, type IdIntent, type RefundQuote } from "./rules/refund.ts";

/** What a reload needs to follow the quote again (written in the op under `follow`; nothing secret). */
export interface PoolFollowRecord {
  chain: PoolChain;
  /** The pool's scope and the planned index U_X was named at. */
  s: string;
  i: number;
  /** U_X (base58 on Solana, EIP-55 on EVM) and U_{s,i}'s 64-hex id, where a refund lands. */
  u: string;
  refund_id: string;
  /** The quote's signed deposit address, deadline and origin, and its min out in the pool coin's base units. */
  address: string;
  deadline_ms: number;
  origin: string;
  min_out: string;
  /** The refund carry's last move (poolRefundMover), written before it is sent. */
  move?: MoveRecord;
}

/** The pool follow's stages, as kit messages.ts PoolDepositStage names them. */
export type PoolFollowStage = "quote_checked" | "waiting" | "in_transit" | "in_pool" | "refunded" | "refund_move" | "failed" | "short" | "expired";

/** Each 1Click status's stage before the device's own reads (as the vault's STATUS_STAGE). */
export const POOL_STATUS_STAGE: Readonly<Record<OneClickStatus, PoolFollowStage>> = Object.freeze({
  PENDING_DEPOSIT: "quote_checked",
  KNOWN_DEPOSIT_TX: "waiting",
  PROCESSING: "in_transit",
  INCOMPLETE_DEPOSIT: "short",
  SUCCESS: "in_transit",
  REFUNDED: "refunded",
  FAILED: "failed",
});
// expired ranks with waiting: a stale PENDING_DEPOSIT never shows a quote past its deadline as live again, and a send
// seen after it (waiting, in transit) still shows
const RANK: Partial<Record<PoolFollowStage, number>> = { quote_checked: 0, expired: 1, waiting: 1, in_transit: 2, failed: 2, short: 2 };

/** A deposit run's end as the page's pool.deposit kind tells it (pool-deposit.ts poolDepositKind: the answer, then its
 *  end as progress), or its refusal code. */
export type PoolDepositEnd = "filled" | "part_filled" | "not_landed" | "sent" | "not_allowed" | "not_funded" | "failed" | "down";

export interface PoolFollowDeps {
  /** 1Click's status of the quote's address for U_X and U_{s,i} (readDepositStatus with the refund id), or null. */
  status(f: PoolFollowRecord, signal: AbortSignal): Promise<StatusRead | null>;
  /** U_X's balance at finalized on X's two RPCs (each its own read). Throws when a read fails. */
  balances(f: PoolFollowRecord): Promise<readonly [bigint, bigint]>;
  /** The least U_X must hold for one deposit, and what one deposit costs on top of its rung (worst case), and the
   *  rent U_X keeps after it (0 on EVM), read on two RPCs at the round's time. */
  costs(f: PoolFollowRecord): Promise<{ floor: bigint; perRung: bigint; keep: bigint }>;
  /** The pool's ladder on X. */
  ladder: Ladder;
  /** The page's pool.deposit on X from U_X, for `amount`, to its end. */
  deposit(f: PoolFollowRecord, amount: bigint, signal: AbortSignal): Promise<PoolDepositEnd>;
  /** The quote's deadline past on both RPCs' clocks. */
  past(f: PoolFollowRecord): Promise<boolean>;
  /** The refund carry: what U_{s,i} holds inside intents.near moved back to X's coin, to U_X; none, and a refund waits. */
  refund?(f: PoolFollowRecord, signal: AbortSignal): Promise<"moved" | "none" | "wait">;
  /** The op's stage written (and posted to the app in state.ops). */
  stage(s: PoolFollowStage): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
}

export const POOL_FOLLOW_FAST_MS = 2_000;
export const POOL_FOLLOW_SLOW_MS = 15_000;
export const POOL_FOLLOW_SLOW_MAX_MS = 60_000;

/**
 * The largest ask U_X pays from `have` (its lower balance): rungs whose sum, with `perRung` for each and `keep` left,
 * fits; 0n when not even one rung does.
 */
export function askOf(ladder: Ladder, have: bigint, perRung: bigint, keep: bigint): bigint {
  for (let k = 1n; ; k++) {
    const room = have - keep - k * perRung;
    if (room < ladder.min) return 0n;
    const { notes } = ladderSplit(ladder, room);
    if (BigInt(notes.length) <= k) return notes.reduce((a, b) => a + b, 0n);
  }
}

/** Follows one pool quote to its end (in_pool past the deadline), or until the signal stops it; returns the last stage. */
export async function followPoolQuote(f: PoolFollowRecord, deps: PoolFollowDeps, from: PoolFollowStage = "quote_checked"): Promise<PoolFollowStage> {
  let shown: PoolFollowStage = from;
  const show = async (s: PoolFollowStage): Promise<void> => {
    if (s === shown) return;
    // a status moves the stage shown forward only (a stale answer never steps it back); the device's own reads may
    if (RANK[s] !== undefined && RANK[shown] !== undefined && RANK[s]! < RANK[shown]!) return;
    shown = s;
    await deps.stage(s);
  };
  let landed = shown === "in_pool";
  let slow = POOL_FOLLOW_SLOW_MS;
  for (;;) {
    if (deps.signal.aborted) return shown;
    let fast = false;
    try {
      // the chain first: U_X's money, the lower of two RPCs at finalized, carried into the pool while it covers a deposit
      const [a, b] = await deps.balances(f);
      const low = a < b ? a : b;
      const c = await deps.costs(f);
      if (low >= c.floor) {
        const amount = askOf(deps.ladder, low, c.perRung, c.keep);
        if (amount > 0n) {
          const end = await deps.deposit(f, amount, deps.signal);
          // landed: the next round reads what is left at once; anything else (not landed, refused, down) is read again
          // at the slow pace, so a deposit that cannot go is never asked in a tight loop
          if (end === "filled" || end === "part_filled") {
            landed = true;
            fast = true;
            await show("in_pool");
          }
        }
      } else if (landed) {
        // nothing left under U_X to carry: read on to the quote's deadline, so a late send is carried too
        if (shown !== "in_pool") await show("in_pool");
        if (await deps.past(f)) return shown;
      } else {
        const st = await deps.status(f, deps.signal);
        if (st !== null && "status" in st) {
          // a refund being moved stays shown as moved while 1Click still reads REFUNDED
          if (!(shown === "refund_move" && st.status === "REFUNDED")) await show(POOL_STATUS_STAGE[st.status]);
          if (st.status === "KNOWN_DEPOSIT_TX" || st.status === "PROCESSING" || st.status === "SUCCESS") fast = true;
          if (st.status === "REFUNDED" && deps.refund) {
            const r = await deps.refund(f, deps.signal);
            if (r === "moved") {
              await show("refund_move");
              fast = true;
            }
          }
        }
        // nothing seen sent by the deadline on both RPCs' clocks: expired, and read on (a late send to the address is
        // refunded by 1Click, and that refund is carried as any other)
        if (shown === "quote_checked" && (st === null || ("status" in st && st.status === "PENDING_DEPOSIT")) && (await deps.past(f))) await show("expired");
      }
    } catch {
      if (deps.signal.aborted) return shown;
    }
    if (fast) slow = POOL_FOLLOW_SLOW_MS;
    await deps.sleep(fast ? POOL_FOLLOW_FAST_MS : slow, deps.signal);
    if (!fast) slow = Math.min(slow * 2, POOL_FOLLOW_SLOW_MAX_MS);
  }
}

// ---------------------------------------------------------------------------------------------- on SIGN_HOST's page

/** The op a pool quote's follow keeps in the wallet store's "ops" under its request's id (src/state.ts op contract):
 *  nothing secret. `final` once in_pool is read on past the quote's deadline. */
export type PoolDepositOp = { kind: "pool_deposit"; stage: PoolFollowStage; txs: { chain: PoolChain; hash: string }[]; created_ms: number; follow: PoolFollowRecord; final?: true };

/** One follower per op across tabs: POOL_FOLLOW_LOCK/<op id>, held while it is followed. */
export const POOL_FOLLOW_LOCK = "ct-wallet/pool-follow/";

const FOLLOW_KEYS = ["chain", "s", "i", "u", "refund_id", "address", "deadline_ms", "origin", "min_out"] as const;
const isPoolOp = (v: unknown): v is PoolDepositOp =>
  typeof v === "object" && v !== null && (v as PoolDepositOp).kind === "pool_deposit" && typeof (v as PoolDepositOp).follow === "object" && (v as PoolDepositOp).follow !== null;
/** A pool op's follow ended: in_pool read on past its quote's deadline. Every other op is followed again at each landing. */
export const poolFollowEnded = (op: Pick<PoolDepositOp, "stage" | "final">): boolean => op.stage === "in_pool" && op.final === true;

const DEC = /^[0-9]+(\.[0-9]+)?$/;
/** A decimal at `decimals` in base units, exactly; null otherwise. */
function baseUnits(v: unknown, decimals: number): bigint | null {
  if (typeof v !== "string" || !DEC.test(v)) return null;
  const [i = "", f = ""] = v.split(".");
  return f.length > decimals ? null : BigInt(i + f.padEnd(decimals, "0"));
}

export interface PoolFollowHost {
  store(): Promise<{ get(s: "ops", k: string): Promise<unknown>; update(s: "ops", k: string, change: (v: unknown) => unknown): Promise<unknown>; keys(s: "ops"): Promise<string[]> }>;
  /** The chain reads and the deposit for X's pool (its pinned pair, the page's pool.deposit), or null when the page
   *  pins no pool there: the op waits, followed again at the next landing. */
  deps(f: PoolFollowRecord, op: { move(): Promise<MoveRecord | undefined>; record(m: MoveRecord): Promise<void> }): Omit<PoolFollowDeps, "stage" | "signal"> | null;
  /** The decimals of X's coin (kit POOL_ASSET_DECIMALS). */
  decimals(chain: PoolChain): number;
  locks?: () => Pick<LockManager, "request"> | null;
  now?: () => number;
}

export function poolFollows(h: PoolFollowHost) {
  const running = new Map<string, { p: Promise<void>; signal: AbortSignal }>();
  let abort = new AbortController();
  const locks = h.locks ?? (() => (typeof navigator !== "undefined" ? (navigator.locks ?? null) : null));

  const follow = (id: string, f: PoolFollowRecord): Promise<void> => {
    const had = running.get(id);
    if (had && !had.signal.aborted) return had.p;
    const signal = abort.signal;
    const body = async () => {
      const ops = await h.store();
      const now = await ops.get("ops", id);
      if (!isPoolOp(now) || poolFollowEnded(now)) return;
      // the refund carry's move, kept in the op's follow record (written before its send)
      const d = h.deps(f, {
        move: async () => {
          const v = await ops.get("ops", id);
          return isPoolOp(v) ? v.follow.move : undefined;
        },
        record: async (m) => void (await ops.update("ops", id, (v) => (isPoolOp(v) ? { ...v, follow: { ...v.follow, move: m } } : undefined))),
      });
      if (d === null) return;
      const stage = async (s: PoolFollowStage) => {
        await ops.update("ops", id, (v) => (isPoolOp(v) ? { ...v, stage: s } : undefined));
      };
      const end = await followPoolQuote(f, { ...d, stage, signal }, now.stage);
      // the follow returns past its deadline only at in_pool; a signal's return leaves the op to the next landing
      if (end === "in_pool" && !signal.aborted) await ops.update("ops", id, (v) => (isPoolOp(v) ? { ...v, stage: "in_pool", final: true } : undefined));
    };
    const lm = locks();
    // one follower per op across tabs; two ops of one U_X may run at once, since each deposit from U_X is the page's
    // pool.deposit, one at a time on the device (POOL_DEPOSIT_LOCK), priced on U's own balance read then
    const p: Promise<void> = (lm ? (lm.request(`${POOL_FOLLOW_LOCK}${id}`, { mode: "exclusive", signal }, body) as Promise<void>) : body())
      .catch(() => {})
      .finally(() => {
        if (running.get(id)?.p === p) running.delete(id);
      });
    running.set(id, { p, signal });
    return p;
  };

  return {
    /**
     * pool.address checked `quote` under request `id` for U_X (`u`): the op is written and followed. Throws when it
     * cannot be written, so no address goes out that nothing follows.
     */
    async quoted(id: string, chain: PoolChain, quote: { deposit_address: string; origin_asset: string; min_amount_out: string; deadline: string }, u: { scope: bigint; index: number; wallet: string; refundId: string }): Promise<void> {
      const deadline = Date.parse(quote.deadline);
      if (!Number.isSafeInteger(deadline)) throw new Error("the quote's deadline is not a time");
      const minOut = baseUnits(quote.min_amount_out, h.decimals(chain));
      if (minOut === null) throw new Error("the quote's min_amount_out is not an amount of the pool's coin");
      const f: PoolFollowRecord = { chain, s: u.scope.toString(), i: u.index, u: u.wallet, refund_id: u.refundId, address: quote.deposit_address, deadline_ms: deadline, origin: quote.origin_asset, min_out: minOut.toString() };
      const ops = await h.store();
      // a retry of the same request (the same id) keeps the op it made
      await ops.update("ops", id, (v) => (v === undefined ? { kind: "pool_deposit", stage: "quote_checked", txs: [], created_ms: (h.now ?? Date.now)(), follow: f } : undefined));
      const op = await ops.get("ops", id);
      if (!isPoolOp(op) || FOLLOW_KEYS.some((k) => op.follow[k] !== f[k])) throw new Error("the request's op names another deposit");
      void follow(id, f);
    },
    /** Each signed-in landing: every pool op no follow has ended is followed again. */
    async settle(): Promise<void> {
      const ops = await h.store();
      for (const k of await ops.keys("ops")) {
        const v = await ops.get("ops", k).catch(() => undefined);
        if (isPoolOp(v) && !poolFollowEnded(v)) void follow(k, v.follow);
      }
    },
    /** This tab's sign out, or the store closing: every follow stops; settle() starts them again. */
    stop(): void {
      abort.abort(new Error("stopped"));
      abort = new AbortController();
    },
    /** Tests: the follows running now. */
    idle: (): Promise<unknown> => Promise.all([...running.values()].map((r) => r.p)),
  };
}

/**
 * The page's pool.deposit handler (src/pool-kinds.ts poolKinds, the kind the app asks) run to its end for the follow:
 * its answer, and when that is "sent", the end it posts as progress (filled, part_filled, not_landed; card
 * pool-deposit-sent-end). A kind that posts no end before the signal stops it reads "down" (read again next round).
 */
export function depositToEnd(
  kind: (params: Record<string, unknown>, ctx: { id: string; sha: string; progress(s: string): void; route(): void }) => unknown,
  chain: PoolChain,
  decimals: number,
  amount: bigint,
  signal: AbortSignal,
): Promise<PoolDepositEnd> {
  return new Promise<PoolDepositEnd>((resolve) => {
    let done = false;
    const fin = (e: PoolDepositEnd): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", stop);
      resolve(e);
    };
    const stop = (): void => fin("down");
    if (signal.aborted) return fin("down");
    signal.addEventListener("abort", stop, { once: true });
    const ENDS = new Set(["filled", "part_filled", "not_landed"]);
    const codeOf = (c: unknown): PoolDepositEnd => (c === "not_allowed" || c === "not_funded" || c === "failed" ? c : "down");
    type Answer = { result: { stage: string } } | { error: string };
    const read = (a: Answer | null | undefined): void => {
      if (!a) return fin("not_allowed");
      if ("error" in a) return fin(codeOf(a.error));
      if (ENDS.has(a.result.stage)) fin(a.result.stage as PoolDepositEnd);
      // "sent": its end comes as progress
    };
    const s = amount.toString().padStart(decimals + 1, "0");
    const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "");
    let r: unknown;
    try {
      r = kind({ chain, amount: frac ? `${whole}.${frac}` : whole }, {
        id: `pool-follow-${chain}`,
        sha: "",
        progress: (st) => void (ENDS.has(st) && fin(st as PoolDepositEnd)),
        route: () => {},
      });
    } catch {
      return fin("down");
    }
    if (r === null || typeof r !== "object") return fin("not_allowed");
    if ("after" in r) {
      const d = r as { after: Promise<void>; answer(): Answer | null };
      d.after.then(() => read(d.answer()), () => fin("down"));
    } else read(r as Answer);
  });
}

// ------------------------------------------------------------------------------------------------ the refund carry

/**
 * The refund carry for one pool op (the follow's `refund`): what U_{s,i} holds of the quote's origin inside intents.near,
 * read at one block on NEAR's two RPCs (the wallet's readMoveAt), moved by the wallet's runRefundMove with U_{s,i} as
 * the signer under this page's rules: the request poolRefundMoveRequest's (X's coin, to U_X, refunded under the id),
 * its quote checkPoolRefundQuote's (min out over the pool's floor read now), its intent checkIdTransferIntent's, signed
 * by signIdIntent with the key opened only for the signature (the seed under its lock, U_{s,i} checked, both zeroed).
 * - The move is recorded in the op (`record`) before it is sent. While a recorded move's nonce reads unused at a block
 *   inside its deadline, nothing new is signed ("wait"); its nonce read used, the money is on its way to U_X ("moved",
 *   the rounds carry it); past its deadline unused, a new move may go, the earlier deadline handed to the rule.
 * - Nothing held: "none". A read that does not agree, a quote that fails a check (one under the pool's floor among
 *   them: it waits under U_{s,i}), or a relayer that refuses: "wait", read again next round.
 */
export interface PoolRefundHost {
  /** NEAR mainnet's two RPCs (FastNEAR and dRPC) and intents.near. */
  read(f: PoolFollowRecord, nonce: string | null): Promise<MoveRead | null>;
  /** The pool's floor now (solanaPoolDepositFloor or evmPoolDepositFloor at reads made now). */
  floor(f: PoolFollowRecord): Promise<bigint>;
  /** The device's own two price reads of the origin and X's coin, and the origin's decimals; null when it has none. */
  priced(f: PoolFollowRecord): { decimalsIn: number; pricing: Exclude<OneClickPricing, "usdc"> } | null;
  decimals(chain: PoolChain): number;
  /** The 64-byte seed, opened under the wallet's seed lock (shared), zeroed here. */
  seed64(): Promise<Uint8Array>;
  seedLock<T>(fn: () => Promise<T>): Promise<T>;
  /** The op's recorded move, and its write (before the send). */
  move(): Promise<MoveRecord | undefined>;
  record(m: MoveRecord): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}

export function poolRefundMover(h: PoolRefundHost): (f: PoolFollowRecord, signal: AbortSignal) => Promise<"moved" | "none" | "wait"> {
  const now = h.now ?? Date.now;
  return async (f, signal) => {
    const m = await h.move();
    const r = await h.read(f, m?.nonce ?? null);
    if (r === null) return "wait";
    let prior: number | null = null;
    if (m !== undefined) {
      // through on its nonce: that money is on its way to U_X (the rounds carry it); anything held now is other money
      // (a second refund), moved by a new move
      if (r.used !== true) {
        if (r.timeMs <= m.deadline_ms) return "wait"; // in its window: never a second intent for the same money
        prior = m.deadline_ms;
      }
    }
    if (r.held === 0n) return "none";
    const priced = h.priced(f);
    if (priced === null) return "wait";
    const floor = await h.floor(f);
    const signer = { role: "U" as const, id: f.refund_id, publicKey: hex.decode(f.refund_id) };
    const decimalsOut = h.decimals(f.chain);
    const res = await runRefundMove<RefundQuote, IdIntent>(
      { u: f.refund_id, asset: f.origin, reads: r.reads, height: r.height, salt: r.salt, priorMs: prior },
      {
        request: (u, asset, amount, at) => poolRefundMoveRequest(f.chain, f.u, u, asset, amount, at),
        check: {
          quote: (request, answer) =>
            checkPoolRefundQuote(request, answer, { network: "mainnet", signer, origin: f.origin, chain: f.chain, wallet: f.u, floor, check: { path: DEPOSIT_QUOTE_PATH, pricing: priced.pricing, decimalsIn: priced.decimalsIn, decimalsOut, now: now() } }),
          read: (q) => ({ depositAddress: q.depositAddress as string, amountIn: q.amountIn, deadlineMs: Date.parse(q.deadline as string) }),
          intent: (payload, q, reads, priorDeadline) => checkIdTransferIntent(payload, q, { network: "mainnet", signer, reads, priorDeadline }),
          sign: (secretKey, intent) => signIdIntent(secretKey, intent) as HelperSignedIntent,
        },
        openKey: <T,>(fn: (secretKey: Uint8Array) => T) =>
          h.seedLock(async () => {
            const seed = await h.seed64();
            try {
              if (!(seed instanceof Uint8Array) || seed.length !== 64) throw new Error("seed64 must be 64 bytes");
              const k = depositId(seed, BigInt(f.s), f.i);
              try {
                if (k.id !== f.refund_id) throw new Error("the seed's U_{s,i} is not the op's refund id");
                return fn(k.secretKey);
              } finally {
                k.secretKey.fill(0);
              }
            } finally {
              seed.fill(0);
            }
          }),
        record: (mv) => h.record(mv),
        now,
        signal,
        ...(h.fetch ? { fetchFn: h.fetch } : {}),
      },
    );
    return res.kind === "sent" && res.status >= 200 && res.status < 300 ? "moved" : "wait";
  };
}

// ------------------------------------------------------------------------------------------------ Solana's reads

const lamports = (v: unknown): bigint => {
  const x = (v as { value?: unknown } | null)?.value;
  if (!Number.isSafeInteger(x) || (x as number) < 0) throw new Error("not a balance");
  return BigInt(x as number);
};

/**
 * The follow's reads on Solana (the pool kinds' own pair, two operators): 1Click's status through the helper for U_X
 * and U_{s,i}; U_X's balance at finalized on each RPC; one deposit's costs from the fee and the Rent sysvar read now
 * (readSolanaPoolCosts: the floor the quote was held to, its worst-case cost per rung and the rent U_X keeps); the
 * quote's deadline past on both RPCs' finalized block time. `deposit` is the page's pool.deposit (depositToEnd).
 */
export function solanaPoolFollowDeps(o: { rpcs: readonly [SolanaRpc, SolanaRpc]; program: string; deposit: PoolFollowDeps["deposit"]; refund?: PoolFollowDeps["refund"]; fetch?: typeof fetch; sleep?: PoolFollowDeps["sleep"] }): Omit<PoolFollowDeps, "stage" | "signal"> {
  const both = <T,>(f: (r: SolanaRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(o.rpcs[0]), f(o.rpcs[1])]);
  return {
    status: (f, signal) => readDepositStatus(f.address, f.u, o.fetch ?? fetch, signal, Date.now(), f.refund_id),
    balances: (f) => both(async (r) => lamports(await r("getBalance", [f.u, { commitment: "finalized" }]))),
    costs: async (f) => {
      const { fee, rent } = await readSolanaPoolCosts(o.rpcs, o.program, f.u);
      const floor = solanaPoolDepositFloor(fee, rent), keep = solanaRentMin(rent, 0);
      return { floor, perRung: floor - SOL_LADDER.min - keep, keep };
    },
    ladder: SOL_LADDER,
    deposit: o.deposit,
    past: async (f) => {
      const times = await both(async (r) => {
        const slot = await r("getSlot", [{ commitment: "finalized" }]);
        const t = await r("getBlockTime", [slot]);
        if (!Number.isSafeInteger(t)) throw new Error("no block time");
        return (t as number) * 1000;
      });
      return times.every((t) => t > f.deadline_ms);
    },
    ...(o.refund ? { refund: o.refund } : {}),
    sleep: o.sleep ?? ((ms, signal) => new Promise<void>((ok) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        ok();
      }
      signal.addEventListener("abort", done, { once: true });
    })),
  };
}
