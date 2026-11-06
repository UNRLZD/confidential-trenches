// The deposit's follow on SIGN_HOST's top-level page (card wallet-deposit-follow): once a deposit.quote shows a checked
// address, the page carries the deposit to its note with no tap (../../wallet/src/deposit/follow.ts), and deposit.confirm
// answers where it is.
// - quoted(): deposit.quote's answer went out with a checked address. Its op is written under the request's id (src/
//   state.ts op contract: { kind: "deposit", stage: "quote_checked", txs, created_ms } and the follow's resume fields,
//   nothing secret) and followed at once. Every stage the follow writes reaches the app in state.ops, posted again on
//   each change.
// - deposit.confirm { deposit_address }: answered with the stage and facts of the op that names that address (no op:
//   not_allowed), and each later stage goes out as the request's progress; the op is followed if no follow runs for it.
// - settle(): each signed-in landing resumes every deposit op not at an end (FOLLOW_ENDS), so a reload or a closed tab
//   carries on from its stage.
// - One follower per op across tabs: FOLLOW_LOCK/<op id>, held while it runs; another tab's follow of the same op waits
//   for it. The seed is opened per follow and zeroed by it; a sign out stops every follow first.
import type { WalletStore } from "@blindfill/wallet/store";
import type { DepositFacts, DepositStage, SignpageResults } from "../../kit/src/signpage/messages.ts";
import { type DepositOp, followDeposit, type FollowRecord, followRpc, type FollowRpc } from "../../wallet/src/deposit/follow.ts";
import { NEAR_NETWORKS, type NearNetwork } from "../../wallet/src/deposit/account.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import type { ApiHost, Deferred, KindContext } from "./api.ts";

type Kinds = NonNullable<ApiHost["kinds"]>;

export const FOLLOW_LOCK = "ct-wallet/deposit-follow/";
/**
 * The stages no landing or deposit.confirm follows again: the note read, the money waiting under U (refunded with no
 * refund move yet, held), or the address past its signed deadline on both RPCs with nothing sent (a follow running
 * then keeps reading 1Click's status while its page lives, so a send 1Click saw late still shows).
 */
export const FOLLOW_ENDS: ReadonlySet<DepositStage> = new Set(["done", "refunded", "held", "expired"]);
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

  const follow = (id: string, f: FollowRecord): Promise<void> => {
    const had = running.get(id);
    if (had) return had;
    const signal = abort.signal;
    const body = async () => {
      signal.throwIfAborted();
      const ops = await h.store();
      const now = await ops.get("ops", id);
      if (!isDepositOp(now) || FOLLOW_ENDS.has(now.stage)) return;
      const notes = await openNoteStore(ops);
      const seed = await h.seed64();
      try {
        await followDeposit(seed, { opId: id, network: f.network, s: BigInt(f.s), i: f.i, address: f.address, deadline_ms: f.deadline_ms }, {
          ops,
          store: notes,
          rpcs: rpcs(),
          signal,
          ...(h.fetch ? { fetchFn: h.fetch } : {}),
          ...(h.sleep ? { sleep: h.sleep } : {}),
          ...(h.now ? { now: h.now } : {}),
          onStage: (s) => listeners.get(id)?.forEach((fn) => fn(s)),
        });
      } finally {
        seed.fill(0);
        notes.close();
      }
    };
    const lm = locks();
    const p = (lm ? lm.request(`${FOLLOW_LOCK}${id}`, { mode: "exclusive", signal }, body) : body())
      // a follow that stops (a sign out, a read that threw) leaves the op at its stage: the next landing resumes it
      .catch(() => {})
      .finally(() => running.delete(id));
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
    /** deposit.quote answered `result` under request `id`, for U_{scope,index}: the op is written and followed. */
    async quoted(id: string, result: SignpageResults["deposit.quote"], u: { scope: bigint; index: number }): Promise<void> {
      const deadline = Date.parse(result.deadline);
      if (!Number.isSafeInteger(deadline)) return;
      const f: FollowRecord = { network: h.network(), s: u.scope.toString(), i: u.index, address: result.deposit_address, deadline_ms: deadline };
      const ops = await h.store();
      // a retry of the same request (the same id) keeps the op it made
      await ops.update("ops", id, (v) => (v === undefined ? { kind: "deposit", stage: "quote_checked", txs: [], created_ms: (h.now ?? Date.now)(), follow: f } : undefined));
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
    /**
     * The shell's kinds with deposit.quote followed from its answer and deposit.confirm answered here. `named` reads
     * U's public record (scope and index) the quote was asked under; deposit.quote's own wire checks it did not move.
     */
    withFollow(kinds: Kinds, named: () => Promise<{ scope: bigint; index: number } | null>): Kinds {
      const quote = kinds["deposit.quote"];
      const wrapped: Kinds["deposit.quote"] = (p, ctx) => {
        const d = quote!(p, ctx);
        if (d === null || typeof d !== "object" || !("after" in d)) return d;
        const after = d.after.then(async () => {
          const a = d.answer();
          if (a === null || !("result" in a)) return;
          const u = await named().catch(() => null);
          if (u !== null) await api.quoted(ctx.id, a.result, u).catch(() => {});
        });
        return { ...d, after }; // a Running answer stays Running
      };
      return { ...kinds, ...(quote ? { "deposit.quote": wrapped } : {}), "deposit.confirm": (p, ctx) => api.kind(p, ctx) };
    },
  };
  return api;
}
