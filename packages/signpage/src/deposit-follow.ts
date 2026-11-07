// The deposit's follow on SIGN_HOST's top-level page (card wallet-deposit-follow): once a deposit.quote shows a checked
// address, the page carries the deposit to its note with no tap (../../wallet/src/deposit/follow.ts), and deposit.confirm
// answers where it is.
// - quoted(): deposit.quote's rule checked an address under U's deposit record (src/deposit-wire.ts checked, before its
//   answer goes out). Its op is written under the request's id (src/state.ts op contract: { kind: "deposit", stage:
//   "quote_checked", txs, created_ms } and the follow's resume fields from that checked quote and that record, nothing
//   secret) and followed at once. Every stage the follow writes reaches the app in state.ops, posted again on each change.
// - deposit.confirm { deposit_address }: answered with the stage and facts of the op that names that address (no op:
//   not_allowed), and each later stage goes out as the request's progress; the op is followed if no follow runs for it.
// - settle(): each signed-in landing resumes every deposit op no follow has ended (wallet follow.ts followEnded: held, or
//   done past its quote's deadline on both RPCs), so a reload or a closed tab carries on from its stage, an op past its
//   deadline (expired, refunded, waiting) reads U's balances on the chain again, and a done op's U is followed to its
//   deadline (an older quote's late send to U is bound). The follows run on the wallet store's handle they opened on:
//   when that connection closes (another tab's upgrade or delete), storeClosed() ends them, which frees U's lock, and
//   main.ts settles them again once the store is opened next; a settle() that finds another handle ends them first.
// - One follower per U across tabs: the lock below, held while any op of U is followed; another tab's follow of U waits
//   for it. One follower per U (the money is U's: two quotes before a payment name one U): one lock per U across tabs,
//   FOLLOW_LOCK/<network>/<U>, and in the tab every op of U attaches to U's one follower. The wallet's seed lock is taken
//   shared only around a bind phase, or the refund move's signature, while the seed is open (followDeposit's seedLock
//   and seed64); a sign out aborts every follow first (signedOut()).
// - The refund move (card wallet-refund-move; wallet.md §2.4 point 8): a deposit 1Click refunded to U inside
//   intents.near is moved on into the vault with no tap (refundMove below, the wallet's runRefundMove), signed only under
//   this page's rules for it (rules/refund.ts: checkRefundMoveQuote, checkIdTransferIntent, signIdIntent). Only a USDC
//   refund is moved, the one asset deposit.quote quotes; one under MIN_DEPOSIT, or one the quote's MIN_DEPOSIT floor
//   refuses, waits under U for withdraw.open.
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import type { DepositFacts, DepositStage, SignpageResults } from "../../kit/src/signpage/messages.ts";
import { type DepositOp, followDeposit, DepositFollowRefused, followEnded, type FollowMoveAsk, type FollowRecord, followRpc, type FollowRpc, usdcUnits } from "../../wallet/src/deposit/follow.ts";
import { RefundMoveUnderMin, type RefundMoveResult, runRefundMove } from "../../wallet/src/deposit/refund.ts";
import { ONECLICK_USDC_ASSETS, type OneClickCheckOptions } from "../../kit/src/checks/oneclick.ts";
import type { HelperSignedIntent } from "../../kit/src/helper/v1.ts";
import { VAULT_CONSTANTS } from "../../kit/src/vault/shapes.ts";
import { DEPOSIT_QUOTE_PATH, shortOnlyOfMinimum } from "./rules/deposit-dry.ts";
import { USDC_DECIMALS } from "./rules/deposit-quote.ts";
import { checkIdTransferIntent, checkRefundMoveQuote, signIdIntent, type IdIntent, type RefundQuote } from "./rules/refund.ts";
import { NEAR_NETWORKS, type NearNetwork } from "../../wallet/src/deposit/account.ts";
import { type NoteStore, openNoteStore } from "../../wallet/src/notes/store.ts";
import type { ApiHost, Deferred, KindContext } from "./api.ts";

type Kinds = NonNullable<ApiHost["kinds"]>;

export const FOLLOW_LOCK = "ct-wallet/deposit-follow/";
/**
 * The stages that end an op's follow: the note read on both RPCs (followed on to its quote's deadline, followEnded), or
 * held (the bind stopped, the money under U for withdraw.open). Every other op, expired and refunded among them, is read
 * again on each landing.
 */
export const FOLLOW_ENDS: ReadonlySet<DepositStage> = new Set(["done", "held"]);
const FACTS = ["refunded", "hold", "held_id", "since_ms", "amount_usd"] as const;

export interface FollowHost {
  /** The page's network (read when needed: main.ts names it below its first use). */
  network(): NearNetwork;
  store(): Promise<WalletStore>;
  seed64(): Promise<Uint8Array>;
  /** The network's NEAR pair (FastNEAR and dRPC) unless given (tests). */
  rpcs?: () => readonly [FollowRpc, FollowRpc];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  locks?: () => LockManager | null;
  now?: () => number;
}

/**
 * SIGN_HOST's refund move on `network` (followDeposit's deps.refundMove): the wallet's runRefundMove, every step checked
 * by this page's rules (rules/refund.ts) with U as the signer; a USDC refund only (the asset deposit.quote quotes, at 6
 * decimals on every chain); under MIN_DEPOSIT, or short only of the vault's least deposit at the quote's floor, it is
 * not moved (under_min).
 */
export function refundMover(network: NearNetwork, opts: { fetch?: typeof fetch; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  return async (ask: FollowMoveAsk, signal?: AbortSignal): Promise<RefundMoveResult> => {
    if (!ONECLICK_USDC_ASSETS.includes(ask.asset)) return { kind: "refused", why: "asset" };
    if (ask.reads[0].held < VAULT_CONSTANTS.MIN_DEPOSIT || ask.reads[1].held < VAULT_CONSTANTS.MIN_DEPOSIT) return { kind: "under_min" };
    const signer = { role: "U" as const, id: ask.u, publicKey: Uint8Array.from(ask.u.match(/../g) ?? [], (h) => parseInt(h, 16)) };
    return await runRefundMove<RefundQuote, IdIntent>(ask, {
      check: {
        quote(request, answer) {
          // checked at the time the answer came back
          const check: Omit<OneClickCheckOptions, "intoVault"> = { path: DEPOSIT_QUOTE_PATH, pricing: "usdc", decimalsIn: USDC_DECIMALS, decimalsOut: USDC_DECIMALS, now: now() };
          try {
            return checkRefundMoveQuote(request, answer, { network, signer, origin: ask.asset, check });
          } catch (e) {
            if (shortOnlyOfMinimum(e, request, answer, check)) throw new RefundMoveUnderMin();
            throw e;
          }
        },
        read: (q) => ({ depositAddress: q.depositAddress as string, amountIn: q.amountIn, deadlineMs: Date.parse(q.deadline as string) }),
        intent: (payload, q, reads, priorDeadline) => checkIdTransferIntent(payload, q, { network, signer, reads, priorDeadline }),
        // signIdIntent writes both as "ed25519:" and base58 (rules/refund.ts)
        sign: (secretKey, intent) => signIdIntent(secretKey, intent) as HelperSignedIntent,
      },
      openKey: ask.openKey,
      record: ask.record,
      now,
      ...(opts.fetch ? { fetchFn: opts.fetch } : {}),
      ...(signal ? { signal } : {}),
    });
  };
}

const isDepositOp = (v: unknown): v is DepositOp =>
  typeof v === "object" && v !== null && (v as DepositOp).kind === "deposit" && typeof (v as DepositOp).follow === "object" && (v as DepositOp).follow !== null;

export function depositFollows(h: FollowHost) {
  // each op's follow and the signal it runs under: one that is stopping (a sign out, a closed store) is never handed back
  const running = new Map<string, { p: Promise<void>; signal: AbortSignal }>();
  const listeners = new Map<string, Set<(s: DepositStage) => void>>();
  // each op's next retry pause, kept across its re-follows (a note store that never opens is retried at the capped
  // pace, never every second); a follow that returns clean drops it
  const waits = new Map<string, number>();
  const RETRY_MIN_MS = 1_000;
  const RETRY_MAX_MS = 60_000;
  let abort = new AbortController();
  const rpcs = h.rpcs ?? (() => [followRpc(NEAR_NETWORKS[h.network()].fastnear[0]), followRpc(NEAR_NETWORKS[h.network()].drpc)] as const);
  const locks = h.locks ?? (() => (typeof navigator !== "undefined" ? (navigator.locks ?? null) : null));

  // One body per U in this tab, under FOLLOW_LOCK/<network>/<U> across tabs: it opens U's note store once and keeps it
  // while any op of U is followed; each op's followDeposit attaches to U's one follower (wallet follow.ts). No seed
  // lock while it polls: the wallet's seed lock is taken shared only around a bind phase, while the seed is open.
  // dead: its note store never opened (the wallet store would not open); the next follow of U opens a new one
  type UBody = { pending: Set<Promise<void>>; ready: Promise<NoteStore>; drained: () => void; signal: AbortSignal; dead?: true };
  const bodies = new Map<string, UBody>();
  // the wallet store handle the follows run on: another one means that connection closed (main.ts reopens the store)
  let on: WalletStore | null = null;
  const restart = () => {
    abort.abort(new Error("the store closed"));
    abort = new AbortController();
    on = null;
  };
  const sleep0 = h.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  // a pause the follow's signal ends: a stopped follow lets U's lock go at once, not after its pause
  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((ok) => {
      const done = () => (signal.removeEventListener("abort", done), ok());
      signal.addEventListener("abort", done, { once: true });
      sleep0(ms).then(done, done);
    });
  const follow = (id: string, f: FollowRecord): Promise<void> => {
    const had = running.get(id);
    if (had && !had.signal.aborted) return had.p;
    const signal = abort.signal;
    const key = `${f.network}/${f.u}`;
    let ub = bodies.get(key);
    if (ub === undefined || ub.signal.aborted || ub.dead) {
      let opened!: (n: NoteStore) => void;
      let failed!: (e: unknown) => void;
      const ready = new Promise<NoteStore>((ok, no) => ((opened = ok), (failed = no)));
      ready.catch(() => {});
      let drained!: () => void;
      const empty = new Promise<void>((ok) => (drained = ok));
      const body: UBody = { pending: new Set(), ready, drained, signal };
      const hold = async () => {
        const w = await h.store();
        on ??= w;
        const notes = await openNoteStore(w);
        opened(notes);
        try {
          await empty;
        } finally {
          notes.close();
        }
      };
      const lm = locks();
      void (lm ? lm.request(`${FOLLOW_LOCK}${key}`, { mode: "exclusive", signal }, hold) : hold()).catch(failed);
      bodies.set(key, (ub = body));
    }
    const u = ub;
    const lm = locks();
    const seedLock = <T,>(fn: () => Promise<T>): Promise<T> => (lm ? (lm.request(WALLET_SEED_LOCK, { mode: "shared", signal }, fn) as Promise<T>) : fn());
    // a throw that is no refusal (the store, a read) pauses and runs again; only the sign out's signal ends it
    let again = false;
    const one = async () => {
      for (let wait = waits.get(id) ?? RETRY_MIN_MS; ; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
        if (signal.aborted) return;
        waits.set(id, Math.min(wait * 2, RETRY_MAX_MS));
        try {
          let notes: NoteStore;
          try {
            notes = await u.ready;
          } catch {
            // U's note store did not open: after a pause the op is followed again on a new one (finally below)
            u.dead = true;
            again = true;
            await sleep(wait, signal);
            return;
          }
          const ops = await h.store();
          const now = await ops.get("ops", id);
          if (!isDepositOp(now) || followEnded(now)) return void waits.delete(id);
          await followDeposit({ opId: id, network: f.network, s: BigInt(f.s), i: f.i, u: f.u, address: f.address, deadline_ms: f.deadline_ms, origin: f.origin, min_out: f.min_out }, {
            ops,
            store: notes,
            rpcs: rpcs(),
            seed64: () => h.seed64(),
            seedLock,
            signal,
            untilFinal: true,
            refundMove: refundMover(f.network, { ...(h.fetch ? { fetch: h.fetch } : {}), ...(h.now ? { now: h.now } : {}) }),
            ...(h.fetch ? { fetchFn: h.fetch } : {}),
            ...(h.sleep ? { sleep: h.sleep } : {}),
            ...(h.now ? { now: h.now } : {}),
            onStage: (s, _f, opId) => listeners.get(opId)?.forEach((fn) => fn(s)),
          });
          return void waits.delete(id);
        } catch (e) {
          if (signal.aborted) return;
          if (e instanceof DepositFollowRefused) return void waits.delete(id);
          await sleep(wait, signal);
        }
      }
    };
    const p: Promise<void> = one().finally(() => {
      if (running.get(id)?.p === p) running.delete(id);
      u.pending.delete(p);
      if (u.pending.size === 0) {
        if (bodies.get(key) === u) bodies.delete(key);
        u.drained();
      }
      if (again && !signal.aborted) void follow(id, f);
    });
    u.pending.add(p);
    running.set(id, { p, signal });
    return p;
  };

  const opByAddress = async (address: string): Promise<{ id: string; op: DepositOp } | null> => {
    const ops = await h.store();
    for (const k of await ops.keys("ops")) {
      const v = await ops.get("ops", k).catch(() => undefined);
      if (isDepositOp(v) && v.follow.address === address && v.follow.network === h.network()) return { id: k, op: v };
    }
    return null;
  };

  const api = {
    /**
     * deposit.quote checked `result` under request `id`, for U_{scope,index} (`u.u`, the deposit record's id): the op is
     * written and followed. Throws when the op cannot be written, so no address goes out that nothing follows.
     */
    async quoted(id: string, result: SignpageResults["deposit.quote"], u: { scope: bigint; index: number; u: string }): Promise<void> {
      const deadline = Date.parse(result.deadline);
      if (!Number.isSafeInteger(deadline)) throw new Error("the quote's deadline is not a time");
      const minOut = usdcUnits(result.min_amount_out);
      if (minOut === null) throw new Error("the quote's min_amount_out is not a USDC amount");
      const f: FollowRecord = { network: h.network(), s: u.scope.toString(), i: u.index, u: u.u, address: result.deposit_address, deadline_ms: deadline, origin: result.origin_asset, min_out: minOut.toString() };
      const ops = await h.store();
      // a retry of the same request (the same id) keeps the op it made
      await ops.update("ops", id, (v) => (v === undefined ? { kind: "deposit", stage: "quote_checked", txs: [], created_ms: (h.now ?? Date.now)(), follow: f } : undefined));
      const op = await ops.get("ops", id);
      if (!isDepositOp(op) || (Object.keys(f) as (keyof FollowRecord)[]).some((k) => op.follow[k] !== f[k])) throw new Error("the request's op names another deposit");
      void follow(id, f);
    },
    /** deposit.confirm: the stage and facts of the op naming the address, its later stages as progress. */
    kind(params: Record<string, unknown>, ctx: KindContext): Deferred<"deposit.confirm"> {
      let out: { result: SignpageResults["deposit.confirm"] } | { error: "not_allowed" } = { error: "not_allowed" };
      const after = (async () => {
        const found = typeof params.deposit_address === "string" ? await opByAddress(params.deposit_address) : null;
        if (found === null) return;
        const facts: DepositFacts = {};
        for (const k of FACTS) if (found.op[k] !== undefined) (facts as Record<string, unknown>)[k] = found.op[k];
        out = { result: { stage: found.op.stage, ...facts } };
        if (followEnded(found.op)) return;
        let set = listeners.get(found.id);
        if (!set) listeners.set(found.id, (set = new Set()));
        const fn = (s: DepositStage) => ctx.progress(s);
        set.add(fn);
        void follow(found.id, found.op.follow).finally(() => set!.delete(fn));
      })().catch(() => {});
      return { after, answer: () => out };
    },
    /** Each signed-in landing: every deposit op no follow has ended is followed again, on the store open now. */
    async settle(): Promise<void> {
      const ops = await h.store();
      if (on !== null && on !== ops) restart();
      for (const k of await ops.keys("ops")) {
        const v = await ops.get("ops", k).catch(() => undefined);
        if (isDepositOp(v) && v.follow.network === h.network() && !followEnded(v)) void follow(k, v.follow);
      }
    },
    /** The wallet store's connection closed (main.ts onEvent "closed"): every follow ends, U's lock with it; main.ts
     * calls settle() once the store is opened again. */
    storeClosed(): void {
      restart();
    },
    /** This tab's sign out: every follow stops first. */
    signedOut(): void {
      abort.abort(new Error("signed out"));
      abort = new AbortController();
    },
    /** Tests: the follows running now. */
    idle: (): Promise<unknown> => Promise.all([...running.values()].map((r) => r.p)),
    /** The shell's kinds with deposit.confirm answered here (deposit.quote's op is written by its host's `checked`). */
    withFollow(kinds: Kinds): Kinds {
      return { ...kinds, "deposit.confirm": (p, ctx) => api.kind(p, ctx) };
    },
  };
  return api;
}
