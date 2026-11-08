// The vendor calls every helper on the same keys makes, shared (card helper-deploy-reads-fast). A vendor counts every
// call on its key, and a deploy runs the new helper beside the old one for up to REDEPLOY_READY_S, then the old one's
// drain: each counted only its own, so together they drew Jupiter past its minute, Jupiter answered 429 and the proxy
// held it (live run 42125976095 attempt 1: helper-token-page-cold, a page 503 "jupiter held"). Each helper keeps its
// own calls of the window in a file under HELPER_STORE_DIR (the volume both mount), rewritten at each draw that may
// reach a vendor, and each such draw first counts every other helper's file (proxy.ts drawUp): a shared counter, the
// one a host's replicas keep on a shared store, read and told at the draw, so the two count each other's draws within
// the few ms between one's read and the other's write.
// A stopped helper's file still counts until its calls leave the vendor's window, as they do at the vendor.
//
// Every file is hostile input: a name that is not a helper's, a file past CALLS_FILE_MAX, one that does not parse, or
// one older than CALLS_STALE_MS (removed) is skipped, and proxy.ts seed bounds what is counted.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VENDOR_WINDOW_MS, type Peers } from "./proxy.ts";

export const CALLS_DIR = "vendor-calls";
/** A file's size limit: about 17,000 ms times at about 15 bytes each, the four vendors' seed caps (proxy.ts
 *  vendorSeedMax) with room at the defaults. */
export const CALLS_FILE_MAX = 256 * 1024;
/** The most other helpers' files read: a deploy runs two helpers. */
export const CALLS_FILES_MAX = 8;
/** A file older than this holds no call any window counts and is removed. */
export const CALLS_STALE_MS = 2 * VENDOR_WINDOW_MS;
const NAME = /^[0-9a-f-]{8,64}\.json$/;

/** This helper's (`id`, a random UUID) calls file and the other helpers' under `storeDir`, or none when the helper has
 *  no store. `write` replaces this helper's file whole (a temp file, then one rename); `read` gives every other
 *  helper's calls, each vendor's merged. */
export function callsFiles(storeDir: string, id: string, now: () => number = Date.now): Peers | undefined {
  if (storeDir === "") return undefined;
  const dir = join(storeDir, CALLS_DIR);
  const own = `${id}.json`;
  return {
    write(calls) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.tmp-${id}`);
      writeFileSync(tmp, JSON.stringify({ at: now(), vendors: calls }), { mode: 0o600 });
      renameSync(tmp, join(dir, own));
    },
    read() {
      const merged: Record<string, unknown[]> = Object.create(null) as Record<string, unknown[]>;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return merged; // no helper has drawn yet
      }
      const t = now();
      for (const n of names.filter((x) => NAME.test(x) && x !== own).sort().slice(0, CALLS_FILES_MAX)) {
        const f = join(dir, n);
        try {
          if (statSync(f).size > CALLS_FILE_MAX) continue;
          const w = JSON.parse(readFileSync(f, "utf8")) as { at?: unknown; vendors?: unknown };
          if (typeof w?.at !== "number" || !Number.isFinite(w.at)) continue;
          if (t - w.at >= CALLS_STALE_MS) {
            rmSync(f, { force: true });
            continue;
          }
          const v = w.vendors;
          if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
          for (const [k, c] of Object.entries(v)) if (Array.isArray(c)) (merged[k] ??= []).push(...(c as unknown[]).slice(-CALLS_FILE_MAX));
        } catch {
          // a file replaced or removed meanwhile: read again at the next draw
        }
      }
      return merged;
    },
  };
}
