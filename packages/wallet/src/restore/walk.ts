// The deposit index walk in Workers (card wallet-restore-wallets; docs/plan1/wallet.md §2.3 "Restore" step 3,
// l.267-274): the 8 lanes run in parallel, one Worker each, through restoreNotes `walk` (../notes/restore.ts).
//
// - The page side (walkInWorkers) derives the deposit note masters once and hands each Worker the two masters, the
//   scope, its lane, the gap and the vault's precommitments. The seed never goes to a Worker. The Worker side
//   (answerWalk, run by ./walk-worker.ts) walks the lane with walkLaneOf and answers the LaneWalk.
// - Messages go by structured clone (postMessage), which carries bigint as bigint. A bridge that turned the
//   precommitments into strings (JSON has no bigint) would match nothing and give an empty walk that passes every
//   check restorePages makes on a walk's end, so answerWalk refuses any field that is not a bigint, and restorePages
//   checks the answer as it checks any walk handed in.
// - A Worker that fails, or answers anything but a walk, stops the restore with its lane named; every Worker is
//   ended once it has answered or failed.
// - The pools' walks (card restore-shows-the-balance-in-seconds: walkLanes below): every pool's restore (Solana's,
//   Base's and Robinhood's, the NEAR vault's) walks its 8 lanes here, each lane in a Worker of the page's own pinned
//   file (the signing page's /walk-worker.js), at most one Worker a core, 8 at most, so a walk takes about an eighth of
//   one thread's time on an 8-core device. What a Worker holds: the deposit note masters (the nullifier master and the
//   secret master, two field elements from which every deposit note's secrets derive), the scope, its lane and what
//   to match. Never the seed, the 12 words or any chain key. A Worker is terminated the moment it answers, fails or the
//   run is stopped, so the masters it held go with it; the page holds them only for the walk, as before. The match is
//   public: a set of precommitments (an EVM pool, the vault), or the Solana pool's precommitment marks, each an address
//   the pool program derives from the precommitment (a PDA, computed in the Worker as solana-restore.ts solanaMarkOf).
// - Every walk a Worker hands back is checked on the page before a note is taken from it, as any walk handed in is
//   (../notes/restore.ts checkedWalk, through each pool's laneOf): the lane's own indices, ascending; its last index
//   the one a whole walk reads to; that index's precommitment recomputed from the seed. A walk that ends short, or on
//   the wrong index, stops the restore with its lane named. What the check cannot see: a walk that reaches its end
//   but leaves out a note found on the way (a middle index) passes it. That is why a Worker runs only the page's own
//   file, /walk-worker.js from this origin (its bytes pinned by the release list, started through the Trusted Types
//   policy walk-worker), the same walk code the page runs; walk-lanes.test.ts holds the Workers' walks equal to the
//   page's, a dropped middle note included.
// - A Worker that cannot start (no Worker in this browser, a policy that refuses the file, its load failing) walks
//   that lane on the page instead, yielding as before (../notes/restore.ts walkLaneYielding); one that answers a
//   refusal stops the restore.
import { base58 } from "@scure/base";
import { masters } from "../derive/index.ts";
import { RESTORE_LANES, walkLaneOf, walkLaneYielding, type LaneWalk, type RestoreArgs, type Slices } from "../notes/restore.ts";
import { solanaPda } from "../pool/solana.ts";

/** What a lane's walk matches: the precommitments a pool holds, or the Solana pool's precommitment marks by address. */
export type WalkMatch = { kind: "pre"; precommitments: bigint[] } | { kind: "solana"; program: string; marks: string[] };
/** What the page sends one walk Worker: the precommitments to match, or the Solana pool's marks (`solana`). */
export type WalkAsk = { lane: number; scope: bigint; gap: number; reach: number | null; nullifier: bigint; secret: bigint } & ({ precommitments: bigint[]; solana?: undefined } | { solana: { program: string; marks: string[] }; precommitments?: undefined });
/** A match as a WalkAsk carries it. */
const askMatch = (m: WalkMatch): Pick<WalkAsk, "precommitments" | "solana"> => (m.kind === "pre" ? { precommitments: m.precommitments } : { solana: { program: m.program, marks: m.marks } });

const enc = /* @__PURE__ */ new TextEncoder();
const be32 = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};
/** The Solana pool's precommitment mark of P: the program's address for ["pre", P] (solana-restore.ts solanaMarkOf). */
export const solanaPreMarkOf = (program: Uint8Array, precommitment: bigint): string => base58.encode(solanaPda([enc.encode("pre"), be32(precommitment)], program).address);

/** `has` for a match: whether the pool holds the precommitment. Throws on a match of any other shape. */
export function matchOf(match: WalkMatch | { kind?: unknown }): (precommitment: bigint) => boolean {
  const m = match as Partial<{ kind: unknown; precommitments: unknown; program: unknown; marks: unknown }> | null;
  if (m?.kind === "pre") {
    if (!Array.isArray(m.precommitments) || !m.precommitments.every((p) => typeof p === "bigint")) throw new Error("precommitments: not bigints");
    const ps = new Set<bigint>(m.precommitments as bigint[]);
    return (p) => ps.has(p);
  }
  if (m?.kind === "solana") {
    if (typeof m.program !== "string" || !Array.isArray(m.marks) || !m.marks.every((x) => typeof x === "string")) throw new Error("solana marks: not addresses");
    const program = base58.decode(m.program);
    if (program.length !== 32) throw new Error("solana program: not an address");
    const marks = new Set<string>(m.marks as string[]);
    return (p) => marks.has(solanaPreMarkOf(program, p));
  }
  throw new Error("match: neither precommitments nor solana marks");
}
/** What a walk Worker answers. */
export type WalkAnswer = { ok: true; walk: LaneWalk } | { ok: false; error: string };

/** The Worker side: one lane's walk from a WalkAsk, every field checked first. */
export function answerWalk(ask: unknown): WalkAnswer {
  try {
    const a = ask as Partial<WalkAsk> | null;
    if (typeof a !== "object" || a === null) throw new Error("not a walk ask");
    if (!Number.isInteger(a.lane) || a.lane! < 0 || a.lane! >= RESTORE_LANES) throw new Error("lane: not 0-7");
    if (!Number.isSafeInteger(a.gap) || a.gap! < 1) throw new Error("gap: not a count above 0");
    if (a.reach !== null && !Number.isSafeInteger(a.reach)) throw new Error("reach: not an index or null");
    if (typeof a.scope !== "bigint" || typeof a.nullifier !== "bigint" || typeof a.secret !== "bigint") throw new Error("scope and masters: not bigints");
    const has = a.solana !== undefined ? matchOf({ kind: "solana", ...(a.solana as object) }) : matchOf({ kind: "pre", precommitments: a.precommitments });
    return { ok: true, walk: walkLaneOf({ nullifier: a.nullifier, secret: a.secret }, a.scope, a.lane!, has, a.gap!, a.reach ?? null) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "the walk failed" };
  }
}

/** A dedicated Worker as the page sees it (a browser Worker is one). */
export interface WalkPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (e: { data?: unknown }) => void): void;
  terminate(): void;
}

/**
 * The page side: restoreNotes `walk`, each lane in a Worker of its own from `spawn` (a module Worker running
 * ./walk-worker.ts). seed64 is read once here, for the masters, and never copied.
 */
export function walkInWorkers(seed64: Uint8Array, spawn: () => WalkPort): NonNullable<RestoreArgs["walk"]> {
  const m = masters(seed64, "deposit");
  return (lane, scope, gap, precommitments, reach) =>
    new Promise<LaneWalk>((resolve, reject) => {
      const w = spawn();
      let done = false;
      const end = (f: () => void): void => {
        if (done) return;
        done = true;
        w.terminate();
        f();
      };
      w.addEventListener("message", (e) => {
        const a = e.data as WalkAnswer | undefined;
        end(() => (a?.ok === true ? resolve(a.walk) : reject(new Error(`lane ${lane}: the walk worker refused: ${String((a as { error?: unknown } | undefined)?.error ?? "no answer")}`))));
      });
      w.addEventListener("error", () => end(() => reject(new Error(`lane ${lane}: the walk worker failed`))));
      const ask: WalkAsk = { lane, scope, gap, reach, nullifier: m.nullifier, secret: m.secret, precommitments: [...precommitments] };
      w.postMessage(ask);
    });
}

/** A Worker that could not start, failed, sent what the page cannot read, or gave no answer in time: its lane walks on
 *  the page instead. */
class NoWorker extends Error {}

/** The longest a lane's Worker is waited on (review of 9de383865, P3): a lane at RESTORE_GAP takes seconds on a laptop
 *  and well under a minute on a slow phone; a Worker the browser stops with no error event (memory pressure, a tab
 *  frozen) would otherwise hold its lane and the walks' turn until a sign out. Past it the lane walks on the page. */
export const WALK_LANE_MAX_MS = 120_000;
/** The real timer, cleared when the lane ends (`ended`), so no timer outlives its lane. */
const after = (ms: number, ended: AbortSignal): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    ended.addEventListener("abort", () => clearTimeout(t), { once: true });
  });

/** One lane in one Worker: its walk, a refusal (thrown), or NoWorker when the Worker cannot start, fails, sends what the
 *  page cannot read (messageerror), or gives no answer by `bound` (see WALK_LANE_MAX_MS). */
function inWorker(spawn: () => WalkPort, ask: WalkAsk, signal?: AbortSignal, wait: (ms: number, ended: AbortSignal) => Promise<void> = after): Promise<LaneWalk> {
  return new Promise<LaneWalk>((resolve, reject) => {
    let w: WalkPort;
    try {
      w = spawn();
    } catch {
      return reject(new NoWorker());
    }
    let done = false;
    const ended = new AbortController();
    const end = (f: () => void): void => {
      if (done) return;
      done = true;
      ended.abort();
      signal?.removeEventListener("abort", stop);
      // the Worker and the masters it holds end here, whatever the answer
      w.terminate();
      f();
    };
    const stop = (): void => end(() => reject(signal!.reason));
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    w.addEventListener("message", (e) => {
      const a = e.data as WalkAnswer | undefined;
      end(() => (a?.ok === true ? resolve(a.walk) : reject(new Error(`lane ${ask.lane}: the walk worker refused: ${String((a as { error?: unknown } | undefined)?.error ?? "no answer")}`))));
    });
    w.addEventListener("error", () => end(() => reject(new NoWorker())));
    w.addEventListener("messageerror", () => end(() => reject(new NoWorker())));
    void wait(WALK_LANE_MAX_MS, ended.signal).then(() => end(() => reject(new NoWorker())));
    w.postMessage(ask);
  });
}

/** The cores a walk uses: the device's (navigator.hardwareConcurrency), RESTORE_LANES at most, 1 at least. */
export function walkCores(n: number | undefined = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency): number {
  return Math.max(1, Math.min(RESTORE_LANES, Number.isSafeInteger(n) ? n! : 1));
}

/**
 * A pool's 8 lane walks (see the top): with `spawn`, each lane in a Worker, `cores` of them at a time; a lane whose
 * Worker cannot start, fails or gives no answer within WALK_LANE_MAX_MS (`wait`, the timer, injected in tests) walks on
 * the page (walkLaneYielding on `slice`); without `spawn`, every lane on the page, as
 * before. The walks in lane order, unchecked: the pool's restore checks each (laneOf) before it takes a note.
 */
export async function walkLanes(a: { m: { nullifier: bigint; secret: bigint }; scope: bigint; match: WalkMatch; gap: number; signal?: AbortSignal; slice: Slices; spawn?: () => WalkPort; cores?: number; wait?: (ms: number, ended: AbortSignal) => Promise<void> }): Promise<LaneWalk[]> {
  a.signal?.throwIfAborted();
  const has = matchOf(a.match);
  if (!a.spawn) {
    const lanes: LaneWalk[] = [];
    for (let lane = 0; lane < RESTORE_LANES; lane++) lanes.push(await walkLaneYielding(a.m, a.scope, lane, has, a.gap, null, a.signal, a.slice));
    return lanes;
  }
  const spawn = a.spawn;
  const out: LaneWalk[] = new Array(RESTORE_LANES);
  let next = 0;
  // a lane fails: the others stop at once, in a Worker or on the page (the run's error, or the signal's)
  const quit = new AbortController();
  const stopped = a.signal ? AbortSignal.any([a.signal, quit.signal]) : quit.signal;
  const onPage = (lane: number): Promise<LaneWalk> => walkLaneYielding(a.m, a.scope, lane, has, a.gap, null, stopped, a.slice);
  const runner = async (): Promise<void> => {
    for (let lane = next++; lane < RESTORE_LANES; lane = next++) {
      const ask = { lane, scope: a.scope, gap: a.gap, reach: null, nullifier: a.m.nullifier, secret: a.m.secret, ...askMatch(a.match) } as WalkAsk;
      try {
        out[lane] = await inWorker(spawn, ask, stopped, a.wait);
      } catch (e) {
        if (!(e instanceof NoWorker)) throw e;
        out[lane] = await onPage(lane);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: walkCores(a.cores) }, runner));
  } catch (e) {
    quit.abort(e);
    a.signal?.throwIfAborted();
    throw e;
  }
  return out;
}
