// The restore kind on SIGN_HOST (card pool-restore-wired): the 12 words on a new browser bring back every pool note and
// so every fresh wallet W (each W is derived from its note, ../../wallet/src/pool/buy-wallets.ts spentNotesOf).
// - The app asks `restore` (apps/terminal/src/screens/signin/source.tsx, kit schema.ts restore: {} in, {stage:
//   "started"} out). The answer is "started" at once; the run's stages go to its op record under the request's id
//   (kind "restore", src/state.ts's op contract: no secret in it) and, for a request, as its progress events: "reading"
//   at the start and again every RESTORE_BEAT_MS while it reads (the kit's client gives restore no timeout and the app
//   shows it stalled when progress stops: packages/kit/src/signpage/client.ts restore, at least every 10 s), then
//   "done", or "stalled" when any pool's read failed (the app's Retry asks a new restore; a run again writes only what
//   is missing).
// - A sign-in with the words (or a passkey that opens an existing account) on a note store with no note runs it once
//   with no tap (src/main.ts), under an op id of its own, so the app's sign-in sheet shows it (S19).
// - It runs on every pool the page's network pins (pagePools): the Solana pool through the wallet's solanaRestoreNotes
//   on the page's Solana pair, each EVM pool through evmRestoreNotes on its pool list, notes only (wallets: false: no W
//   is named to any provider, since the page keeps no W record). A pin with no reads on this page (an EVM pin on
//   mainnet, which has no EVM pool list yet) is a failed pool, never skipped: the run ends stalled, so "done" always
//   means every pinned pool was read.
// - What they find goes to the note store through the wallet's writeRestored (parents first; a note the store holds in
//   flight is left as it is), the pools' notes together. A pool that fails leaves the others' notes written.
// - No request names a note: each restore reads its pool's whole public set and finds the seed's own notes on the
//   device (solana-restore.ts, evm-restore.ts headers). The seed is read under the store's seed lock, shared (a sign out
//   waits for the run), and zeroed at its end; this tab's sign out aborts the run first.
// - One run at a time on the page: a request while one runs is answered "started" and follows that run. Across tabs,
//   runs take RESTORE_LOCK in turn, so two tabs' writes never race on one note.
// - A run's op records stay "started" or "reading" only while it lives: each follower holds RESTORE_LOCK/<op id> for
//   the run's life, and settle() (each signed-in load, src/main.ts landed) writes "stalled" on any record still
//   running whose lock no tab holds (its page was closed or reloaded mid-run), so the app offers Retry, never a scan
//   that never ends.
// - "Empty" for the run with no tap: no note but PLANNED ones (a deposit index this page named ahead, src/deposit-name.ts,
//   holds no money until it lands).
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import type { RestoreStage } from "../../kit/src/signpage/messages.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { writeRestored, type RestoredNote } from "../../wallet/src/notes/restore.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { evmRestoreNotes } from "../../wallet/src/pool/evm-restore.ts";
import { EVM_POOLS, type EvmNetwork, type EvmPoolPin, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";
import { solanaRestoreNotes } from "../../wallet/src/pool/solana-restore.ts";
import type { Deferred, KindContext } from "./api.ts";
import { PAGE_SOL_PIN, TESTNET_RPCS, pageSolanaRpcs, testnetRpc } from "./pool-testnet.ts";

/** The Web Lock a run holds (each tab's runs in turn); RESTORE_LOCK/<op id>: one follower's op, held while it runs. */
export const RESTORE_LOCK = "ct-pool/restore";

/** The gap between two "reading" progress events: within the 10 s the kit's client names. */
export const RESTORE_BEAT_MS = 5_000;

/** One pinned pool to restore, with its reads (null when this page has none for it: the run ends stalled). */
export type RestorePool =
  | { chain: "solana"; program: string; rpcs: (() => readonly [SolanaRpc, SolanaRpc]) | null }
  | { chain: "evm"; pin: EvmPoolPin; rpcs: (() => readonly EvmRpc[]) | null };

const EVM_PAGE: Readonly<Record<"base" | "robinhood", EvmNetwork>> = POOL_TESTNET ? { base: "base-sepolia", robinhood: "robinhood-testnet" } : { base: "base", robinhood: "robinhood" };

/** Every pool the page's network pins (PAGE_SOL_PIN, EVM_POOLS on the page's networks), each with the page's reads. */
export function pagePools(): RestorePool[] {
  const out: RestorePool[] = [];
  if (PAGE_SOL_PIN !== undefined) out.push({ chain: "solana", program: PAGE_SOL_PIN.program, rpcs: pageSolanaRpcs });
  for (const chain of ["base", "robinhood"] as const) {
    const pin = EVM_POOLS[EVM_PAGE[chain]];
    if (pin === undefined) continue;
    const net = pin.network;
    // the testnet lists sit behind POOL_TESTNET, folded at build time, so SIGN_HOST's bundle carries none of them
    if (POOL_TESTNET && (net === "base-sepolia" || net === "robinhood-testnet"))
      out.push({ chain: "evm", pin, rpcs: () => TESTNET_RPCS[chain].map((u) => testnetRpc(u)) });
    // mainnet: the page has no EVM pool list yet (src/pool-testnet.ts testnetPoolDeps answers null), so a pin there is
    // read by no one until its list lands, and the run says so (stalled), never done
    else out.push({ chain: "evm", pin, rpcs: null });
  }
  return out;
}

/** What the restore reads on, each called when a run starts. */
export type PoolRestoreHost = {
  store(): Promise<WalletStore>;
  seed64(): Promise<Uint8Array>;
  /** Whether a seed is stored: a restore asked with none is refused not_allowed, and nothing is read. */
  signedIn(): Promise<boolean>;
  /** The pools to read (pagePools unless given). */
  pools?: () => readonly RestorePool[];
  /** Web Locks (navigator.locks otherwise). */
  locks?: Pick<LockManager, "request" | "query">;
  /** After the notes are written: the page's proof queue's pass, so a restored note can pay the next buy. */
  written?: () => void;
  /** Tests only: the beat, the clock and the two restores (the wallet's otherwise). */
  beatMs?: number;
  now?: () => number;
  solana?: typeof solanaRestoreNotes;
  evm?: typeof evmRestoreNotes;
};

type Run = { done: Promise<RestoreStage>; follow(id: string, progress?: (s: RestoreStage) => void): void };

export type PoolRestore = {
  /** The `restore` kind's handler: "started" once the seed is read as stored (else not_allowed), the run's stages after. */
  kind(params: Record<string, unknown>, ctx: KindContext): Deferred<"restore">;
  /** After a sign-in: a run under its own op id when the note store holds no note; resolves to its end (or null). */
  auto(): Promise<RestoreStage | null>;
  /** This tab signed out: the run in flight stops. */
  signedOut(): void;
  /** A signed-in load: every restore op still running whose run no tab holds is written stalled. */
  settle(): Promise<void>;
};

export function poolRestore(h: PoolRestoreHost): PoolRestore {
  const beat = h.beatMs ?? RESTORE_BEAT_MS;
  const now = h.now ?? Date.now;
  const locks = (): Pick<LockManager, "request" | "query"> => h.locks ?? navigator.locks;
  let run: Run | null = null;
  let abort: AbortController | null = null;

  const read = async (signal: AbortSignal): Promise<RestoreStage> => {
    const pools = (h.pools ?? pagePools)();
    const solana = h.solana ?? solanaRestoreNotes;
    const evm = h.evm ?? evmRestoreNotes;
    // the restore lock, then the seed's (shared): a sign out waits only for the run that holds the seed
    return locks().request(RESTORE_LOCK, { mode: "exclusive", signal }, () => locks().request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
      const seed64 = await h.seed64();
      const found: RestoredNote[] = [];
      let failed = false;
      try {
        // each pool on its own: one that fails leaves the others' notes found
        const reads = pools.map(async (p): Promise<RestoredNote[]> => {
          if (p.rpcs === null) throw new Error(`${p.chain === "solana" ? "solana" : p.pin.network}: no reads on this page`);
          if (p.chain === "solana") return (await solana({ seed64, program: p.program, rpcs: p.rpcs(), signal })).notes;
          // the notes only: no W is read or named to a provider for a record the page keeps none of
          return (await evm({ seed64, pin: p.pin, rpcs: p.rpcs(), signal, wallets: false })).notes;
        });
        for (const r of await Promise.allSettled(reads)) {
          if (r.status === "fulfilled") found.push(...r.value);
          else failed = true;
        }
      } finally {
        seed64.fill(0);
      }
      signal.throwIfAborted();
      if (found.length > 0) {
        const notes = await openNoteStore(await h.store());
        try {
          await writeRestored(notes, { notes: found });
        } finally {
          notes.close();
        }
        h.written?.();
      }
      return failed ? "stalled" : "done";
    }));
  };

  const start = (): Run => {
    if (run) return run;
    // each follower's op record, its writes in order (a stage never lands before the one it follows)
    const followers: { id: string; created: number; writes: Promise<void>; progress?: (s: RestoreStage) => void }[] = [];
    const write = (f: (typeof followers)[number], stage: RestoreStage): void => {
      f.writes = f.writes.then(async () => (await h.store()).put("ops", f.id, { kind: "restore", stage, txs: [], created_ms: f.created })).catch(() => {});
    };
    const ctl = (abort = new AbortController());
    // the beat posts "reading" again and writes nothing: the record says reading until the run ends
    const timer = setInterval(() => {
      for (const f of followers) f.progress?.("reading");
    }, beat);
    const done = read(ctl.signal)
      .catch((): RestoreStage => "stalled")
      .then((stage) => {
        clearInterval(timer);
        run = null;
        if (abort === ctl) abort = null;
        // a run this tab's sign out stopped writes nothing more: its records went with the store
        if (!ctl.signal.aborted)
          for (const f of followers) {
            f.progress?.(stage);
            write(f, stage);
          }
        // the run's end is its records' end: each follower's last write landed (or failed)
        return Promise.all(followers.map((f) => f.writes)).then(() => stage);
      });
    const r: Run = {
      done,
      follow: (id, progress) => {
        const f = { id, created: now(), writes: Promise.resolve(), ...(progress ? { progress } : {}) };
        followers.push(f);
        // held for the run's life: a record whose lock no tab holds is a dead run's (settle)
        void locks().request(`${RESTORE_LOCK}/${id}`, { mode: "exclusive" }, () => done.catch(() => {}));
        write(f, "started");
        write(f, "reading");
        progress?.("reading");
      },
    };
    run = r;
    return r;
  };

  return {
    kind: (_params, ctx) => {
      let yes = false;
      const after = h.signedIn().then((s) => {
        if (!(yes = s)) return;
        start().follow(ctx.id, (stage) => ctx.progress(stage));
      });
      return { after, answer: () => (yes ? { result: { stage: "started" } } : { error: "not_allowed" }) };
    },
    auto: async () => {
      if (run) return null;
      const notes = await openNoteStore(await h.store());
      let empty: boolean;
      try {
        empty = (await notes.list()).every((n) => n.state === "PLANNED");
      } finally {
        notes.close();
      }
      if (!empty || run) return null;
      const r = start();
      r.follow(crypto.randomUUID());
      return r.done;
    },
    signedOut: () => abort?.abort(),
    settle: async () => {
      const ops = await h.store();
      const q = await locks().query();
      const alive = new Set([...(q.held ?? []), ...(q.pending ?? [])].map((l) => l.name));
      for (const k of await ops.keys("ops")) {
        if (alive.has(`${RESTORE_LOCK}/${k}`)) continue;
        await ops.update("ops", k, (v) => {
          const r = v as { kind?: unknown; stage?: unknown } | undefined;
          return r?.kind === "restore" && (r.stage === "started" || r.stage === "reading") ? { ...r, stage: "stalled" } : undefined;
        });
      }
    },
  };
}
