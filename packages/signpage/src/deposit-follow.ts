// The deposit's follow on SIGN_HOST's top-level page (card wallet-deposit-follow): once a deposit.quote shows a checked
// address, the page carries the deposit to its note with no tap (../../wallet/src/deposit/follow.ts), and deposit.confirm
// answers where it is.
// - quoted(): deposit.quote's rule checked an address under U's deposit record (src/deposit-wire.ts checked, before its
//   answer goes out). Its op is written under the request's id (src/state.ts op contract: { kind: "deposit", stage:
//   "quote_checked", txs, created_ms } and the follow's resume fields from that checked quote and that record, nothing
//   secret) and followed at once. Every stage the follow writes reaches the app in state.ops, posted again on each change.
// - deposit.confirm { deposit_address }: answered with the stage and facts of the op that names that address (no op:
//   not_allowed), and each later stage goes out as the request's progress; the op is followed if no follow runs for it.
// - settle(): each signed-in landing resumes every deposit op not at an end (FOLLOW_ENDS: done, held), so a reload or a
//   closed tab carries on from its stage, and an op past its deadline (expired, refunded, waiting) reads U's balances on
//   the chain again: anything that reached U since is bound.
// - One follower per U across tabs: the lock below, held while any op of U is followed; another tab's follow of U waits
//   for it. One follower per U (the money is U's: two quotes before a payment name one U): one lock per U across tabs,
//   FOLLOW_LOCK/<network>/<U>, and in the tab every op of U attaches to U's one follower. The wallet's seed lock is taken
//   shared only around a bind phase, while the seed is open (followDeposit's seedLock and seed64); a sign out aborts
//   every follow first (signedOut()).
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import type { DepositFacts, DepositStage, SignpageResults } from "../../kit/src/signpage/messages.ts";
import { type DepositOp, followDeposit, DepositFollowRefused, type FollowRecord, followRpc, type FollowRpc, usdcUnits } from "../../wallet/src/deposit/follow.ts";
import { NEAR_NETWORKS, type NearNetwork } from "../../wallet/src/deposit/account.ts";
import { type NoteStore, openNoteStore } from "../../wallet/src/notes/store.ts";
import type { ApiHost, Deferred, KindContext } from "./api.ts";

type Kinds = NonNullable<ApiHost["kinds"]>;

export const FOLLOW_LOCK = "ct-wallet/deposit-follow/";
/**
 * The stages no landing or deposit.confirm follows again: the note read on both RPCs, or held (the bind stopped, the
 * money under U for withdraw.open). Every other op, expired and refunded among them, is read again on each landing.
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

const isDepositOp = (v: unknown): v is DepositOp =>
  typeof v === "object" && v !== null && (v as DepositOp).kind === "deposit" && typeof (v as DepositOp).follow === "object" && (v as DepositOp).follow !== null;

export function depositFollows(h: FollowHost) {
  const running = new Map<string, Promise<void>>();
  const listeners = new Map<string, Set<(s: DepositStage) => void>>();
  let abort = new AbortController();
  const rpcs = h.rpcs ?? (() => [followRpc(NEAR_NETWORKS[h.network()].fastnear[0]), followRpc(NEAR_NETWORKS[h.network()].drpc)] as const);
  const locks = h.locks ?? (() => (typeof navigator !== "undefined" ? (navigator.locks ?? null) : null));

  // One body per U in this tab, under FOLLOW_LOCK/<network>/<U> across tabs: it opens U's note store once and keeps it
  // while any op of U is followed; each op's followDeposit attaches to U's one follower (wallet follow.ts). No seed
  // lock while it polls: the wallet's seed lock is taken shared only around a bind phase, while the seed is open.
  type UBody = { pending: Set<Promise<void>>; ready: Promise<NoteStore>; drained: () => void };
  const bodies = new Map<string, UBody>();
  const sleep = h.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const follow = (id: string, f: FollowRecord): Promise<void> => {
    const had = running.get(id);
    if (had) return had;
    const signal = abort.signal;
    const key = `${f.network}/${f.u}`;
    let ub = bodies.get(key);
    if (ub === undefined) {
      let opened!: (n: NoteStore) => void;
      let failed!: (e: unknown) => void;
      const ready = new Promise<NoteStore>((ok, no) => ((opened = ok), (failed = no)));
      ready.catch(() => {});
      let drained!: () => void;
      const empty = new Promise<void>((ok) => (drained = ok));
      const body: UBody = { pending: new Set(), ready, drained };
      const hold = async () => {
        const notes = await openNoteStore(await h.store());
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
    const one = async () => {
      for (let wait = 1_000; ; wait = Math.min(wait * 2, 60_000)) {
        if (signal.aborted) return;
        try {
          const notes = await u.ready;
          const ops = await h.store();
          const now = await ops.get("ops", id);
          if (!isDepositOp(now) || FOLLOW_ENDS.has(now.stage)) return;
          await followDeposit({ opId: id, network: f.network, s: BigInt(f.s), i: f.i, u: f.u, address: f.address, deadline_ms: f.deadline_ms, origin: f.origin, min_out: f.min_out }, {
            ops,
            store: notes,
            rpcs: rpcs(),
            seed64: () => h.seed64(),
            seedLock,
            signal,
            ...(h.fetch ? { fetchFn: h.fetch } : {}),
            ...(h.sleep ? { sleep: h.sleep } : {}),
            ...(h.now ? { now: h.now } : {}),
            onStage: (s, _f, opId) => listeners.get(opId)?.forEach((fn) => fn(s)),
          });
          return;
        } catch (e) {
          if (signal.aborted || e instanceof DepositFollowRefused) return;
          await sleep(wait).catch(() => {});
        }
      }
    };
    const p: Promise<void> = one().finally(() => {
      running.delete(id);
      u.pending.delete(p);
      if (u.pending.size === 0) {
        if (bodies.get(key) === u) bodies.delete(key);
        u.drained();
      }
    });
    u.pending.add(p);
    running.set(id, p);
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
        if (FOLLOW_ENDS.has(found.op.stage)) return;
        let set = listeners.get(found.id);
        if (!set) listeners.set(found.id, (set = new Set()));
        const fn = (s: DepositStage) => ctx.progress(s);
        set.add(fn);
        void follow(found.id, found.op.follow).finally(() => set!.delete(fn));
      })().catch(() => {});
      return { after, answer: () => out };
    },
    /** Each signed-in landing: every deposit op not at an end is followed again. */
    async settle(): Promise<void> {
      const ops = await h.store();
      for (const k of await ops.keys("ops")) {
        const v = await ops.get("ops", k).catch(() => undefined);
        if (isDepositOp(v) && v.follow.network === h.network() && !FOLLOW_ENDS.has(v.stage)) void follow(k, v.follow);
      }
    },
    /** This tab's sign out: every follow stops first. */
    signedOut(): void {
      abort.abort(new Error("signed out"));
      abort = new AbortController();
    },
    /** Tests: the follows running now. */
    idle: (): Promise<unknown> => Promise.all(running.values()),
    /** The shell's kinds with deposit.confirm answered here (deposit.quote's op is written by its host's `checked`). */
    withFollow(kinds: Kinds): Kinds {
      return { ...kinds, "deposit.confirm": (p, ctx) => api.kind(p, ctx) };
    },
  };
  return api;
}
