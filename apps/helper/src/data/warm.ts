// The market data a deploy's next helper takes over (card helper-ready-gate): GeckoTerminal answers one address a few
// calls a minute (gecko.ts), and the old and new helper share that address while they overlap, so the new one must not
// spend those calls on lists the old one already holds. The running helper writes this file under HELPER_STORE_DIR
// every TICK_MS and at its stop: its GeckoTerminal calls of the last window and the EVM lists' answers as read
// (evm/lists.ts state). The next helper seeds its budget with those calls and its EVM lists with those answers, which
// it parses again as GeckoTerminal's own (evm/lists.ts restore): the file is read as hostile input. Card app-console-429:
// the Solana token page's answers too (solana/token.ts state: pages, holders, top pools, last good bars), so a swap's
// first loads are answered from what the old helper held, not all at once from upstreams it had just spent.
//
// Not the relayers' store (store/durable.ts): nothing here is a record anyone relies on. A write is a temp file and
// one rename, so a reader sees a whole file or the one before; a file that does not parse, or is older than STALE_MS,
// is ignored and the lists are read from GeckoTerminal.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { STALE_MS } from "./evm/lists.ts";
import { HANDOVER_MAX } from "./solana/token.ts";

export const WARM_DIR = "market";
export const WARM_FILE = "warm.json";
/** The file's size limit on read: six GeckoTerminal answers of at most 2 MB each, the Solana token page's handover
 *  (HANDOVER_MAX), and the rest. */
export const WARM_MAX = 16 * 1024 * 1024 + HANDOVER_MAX;

/** `solana`: the token page's answers (solana/token.ts state), checked entry by entry by its restore. */
export type Warm = { at: number; gecko: number[]; evm: Record<string, unknown>; solana?: unknown };

/** The warm file under `storeDir`, or null when there is none, it does not parse, or it is older than STALE_MS. */
export function readWarm(storeDir: string, now: number): Warm | null {
  if (storeDir === "") return null;
  let text: string;
  try {
    text = readFileSync(join(storeDir, WARM_DIR, WARM_FILE), "utf8");
  } catch {
    return null;
  }
  if (text.length > WARM_MAX) return null;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const w = o as Partial<Warm> | null;
  if (typeof w !== "object" || w === null || typeof w.at !== "number" || !Number.isFinite(w.at) || w.at > now || now - w.at >= STALE_MS) return null;
  const gecko = Array.isArray(w.gecko) ? w.gecko.filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(-64) : [];
  const evm = typeof w.evm === "object" && w.evm !== null && !Array.isArray(w.evm) ? (w.evm as Record<string, unknown>) : {};
  return { at: w.at, gecko, evm, ...(w.solana === undefined ? {} : { solana: w.solana }) };
}

/** Writes the warm file whole: a temp file, then one rename. A failure is the caller's to ignore. */
export function writeWarm(storeDir: string, w: Warm): void {
  if (storeDir === "") return;
  const dir = join(storeDir, WARM_DIR);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(w), { mode: 0o600 });
  renameSync(tmp, join(dir, WARM_FILE));
}
