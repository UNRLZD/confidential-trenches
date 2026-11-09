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
import { masters } from "../derive/index.ts";
import { RESTORE_LANES, walkLaneOf, type LaneWalk, type RestoreArgs } from "../notes/restore.ts";

/** What the page sends one walk Worker. */
export type WalkAsk = { lane: number; scope: bigint; gap: number; reach: number | null; nullifier: bigint; secret: bigint; precommitments: bigint[] };
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
    if (!Array.isArray(a.precommitments) || !a.precommitments.every((p) => typeof p === "bigint")) throw new Error("precommitments: not bigints");
    const ps = new Set<bigint>(a.precommitments);
    return { ok: true, walk: walkLaneOf({ nullifier: a.nullifier, secret: a.secret }, a.scope, a.lane!, (p) => ps.has(p), a.gap!, a.reach) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "the walk failed" };
  }
}

/** A dedicated Worker as the page sees it (a browser Worker is one). */
export interface WalkPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message" | "error", listener: (e: { data?: unknown }) => void): void;
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
