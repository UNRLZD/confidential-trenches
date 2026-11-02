// POST /v1/withdraw's checks 5 and 6 on the nullifier (markets paper H3.4, check 5's spends index and its "caught up"
// rule, check 6's in-flight set and the send record): the relayer never sends for a spent nullifier, and never a
// second send for one whose send is in flight.
//
// The spends index: the vault's `spends` pages (every spend, withdrawals and ragequits alike, append-only), read by
// block_id on two NEAR providers of two operators. A page counts only when both answer it at the same height with the
// same block hash and the same bytes; anything else (an error, a disagreement, a malformed row) counts nothing and
// decides nothing. It is caught up at H once it has read the whole list at a block at or above H. At each request H
// is the newest block final on both providers (the lower of their two finals), and the index waits up to
// INDEX_WAIT_MS for H; past that the request is `index_behind` (503), and the kit resends.
//
// The send records: one row per nullifier value (its 32-byte big-endian hex, never the string as received), written
// once by an atomic create-if-absent before any broadcast, kept across restarts in the relayers' durable store
// (store/durable.ts). A record whose outcome is not final makes the nullifier `in_flight` whatever the index says, so
// an index that lags the chain can never cause a second send: the row, not the index, keys check 6. A row that reads
// succeeded marks the nullifier spent at once, before the pages show it. A failure other than the deadline's is kept
// with its error and the signer's release number: `withdraw_failed` while the running release's number is not above
// it, and a release with a higher number may carry the note once more by replacing that row. A deadline failure, or
// a send never applied, deletes the row and frees the note. An unreadable row is treated as open: never replaced,
// never sent past.
//
// Not here: signing, broadcasting, reading a send's outcome from blocks (D_w, E_w) and the restart's rebroadcast
// (withdraw/send.ts); this file holds the rules they write through.
import * as nodeFs from "node:fs";
import { VAULT_FIELD_P } from "@blindfill/kit";
import type { Rpc, TxRef } from "../bind/send.ts";
import { openDurableDir, type DurableDir, type StoreFs } from "../store/durable.ts";
import { decimal } from "./checks.ts";

// ---- Values ----

/** Check 5's wait for the index to reach H before `503 index_behind` [design]. */
export const INDEX_WAIT_MS = 2_000;
/** Rows per `spends` page read (the vault caps a page at PAGE_MAX, 1,000; 100 keeps an answer well under the RPC bound). */
export const SPENDS_PAGE = 100;
const POLL_MS = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The codes checks 5 and 6 answer on the nullifier (each is in the kit's HELPER_WITHDRAW_CODES). */
export type NullifierCode = "spent" | "index_behind" | "in_flight" | "withdraw_failed";

/** The nullifier's key: its 32-byte big-endian value as 64 lowercase hex. One spelling per value. */
export function nullifierKey(nf: bigint): string {
  if (typeof nf !== "bigint" || nf < 0n || nf >= VAULT_FIELD_P) throw new Error("nullifier: not a field element");
  return nf.toString(16).padStart(64, "0");
}

// ---- The send record ----

/**
 * One withdrawal send: the signed bytes and their hash, the key's nonce n and the block b0 it was signed on (TxRef),
 * the key, the request's deadline_ms and the release number of the helper that signed. `outcome` is "open" until the
 * send's outcome is read from blocks; `error` holds the on-chain error of a failure.
 */
export type WithdrawSend = TxRef & {
  nullifier: string;
  key: string;
  deadline_ms: number;
  release: number;
  outcome: "open" | "succeeded" | "failed";
  error: string | null;
};

/** A send's outcome as read from blocks. A deadline failure and a send never applied delete the row. */
export type SendOutcome = { kind: "succeeded" } | { kind: "failed"; error: string } | { kind: "deadline" } | { kind: "never_applied" };

export type Claim = { ok: true; replaced: WithdrawSend | null } | { ok: false; code: Exclude<NullifierCode, "index_behind"> };

export type WithdrawSendStore = {
  /** The nullifier's send record, "unreadable" for a row that does not parse as one, or null. */
  get(nf: bigint): WithdrawSend | "unreadable" | null;
  /**
   * The write before a broadcast: creates the row when none exists, or replaces a row holding a failure (not the
   * deadline's; those rows are deleted) recorded under a lower release number than `rec.release`; durable before it
   * returns. Fails on any other row, writing nothing: its bytes are then dropped, never sent.
   */
  claim(rec: WithdrawSend): Claim;
  /** Records an open send's outcome. Throws unless the row is open and holds `tx_hash` (a stale outcome changes nothing). */
  settle(nf: bigint, tx_hash: string, outcome: SendOutcome): void;
  /** The nullifiers whose row is open or unreadable: the restart's rebroadcast and the outcome rounds' work. */
  open(): bigint[];
  close(): void;
};

const NAME = /^w-([0-9a-f]{64})\.json$/;
const name = (nf: bigint) => `w-${nullifierKey(nf)}.json`;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEC = /^(0|[1-9][0-9]{0,19})$/;

/** The row as written, or null for anything else (a torn or foreign file reads as unreadable, never as absent). */
function parseSend(text: string, key: string): WithdrawSend | null {
  let r: unknown;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
  const x = r as Record<string, unknown>;
  const ok =
    x.nullifier === key &&
    typeof x.tx_hash === "string" && B58.test(x.tx_hash) &&
    typeof x.signed_tx === "string" && x.signed_tx.length > 0 &&
    typeof x.nonce === "string" && DEC.test(x.nonce) &&
    typeof x.height === "string" && DEC.test(x.height) &&
    typeof x.block_hash === "string" && B58.test(x.block_hash) &&
    typeof x.key === "string" && x.key.length > 0 &&
    typeof x.deadline_ms === "number" && Number.isSafeInteger(x.deadline_ms) && x.deadline_ms >= 0 &&
    typeof x.release === "number" && Number.isSafeInteger(x.release) && x.release >= 1 &&
    ((x.outcome === "failed" && typeof x.error === "string") || ((x.outcome === "open" || x.outcome === "succeeded") && x.error === null));
  return ok ? (x as WithdrawSend) : null;
}

/** The withdrawal send records in `dir`, owned by this process (the store's lock). */
export function createWithdrawSendStore(dir: string, fs: StoreFs = nodeFs): WithdrawSendStore {
  return openDurableDir(dir, fs, (d) => sendStoreOn(d));
}

function sendStoreOn(d: DurableDir): WithdrawSendStore {
  const read = (nf: bigint): WithdrawSend | "unreadable" | null => {
    const text = d.text(name(nf));
    if (text === null) return null;
    return parseSend(text, nullifierKey(nf)) ?? "unreadable";
  };
  // open rows: read once as the lock is taken (a restart), then kept by every write (one process holds the store)
  const openRows = new Set<string>();
  for (const f of d.names()) {
    const m = NAME.exec(f);
    if (m === null) continue;
    const rec = parseSend(d.text(f) ?? "", m[1]!);
    if (rec === null || rec.outcome === "open") openRows.add(m[1]!);
  }
  return {
    get: read,
    claim(rec) {
      d.held();
      const nf = BigInt(`0x${rec.nullifier}`);
      if (rec.outcome !== "open" || rec.error !== null || parseSend(JSON.stringify(rec), nullifierKey(nf)) === null) throw new Error("claim: not an open send record");
      const v = JSON.stringify(rec);
      // one process holds the store and nothing here awaits: the read and the write are one step
      if (d.createOnce(name(nf), v)) {
        openRows.add(rec.nullifier);
        return { ok: true, replaced: null };
      }
      const held = read(nf);
      if (held === null) throw new Error("claim: the row went between its link and its read"); // nothing runs between them: no await
      if (held === "unreadable" || held.outcome === "open") return { ok: false, code: "in_flight" };
      if (held.outcome === "succeeded") return { ok: false, code: "spent" };
      if (held.release >= rec.release) return { ok: false, code: "withdraw_failed" };
      d.replace(name(nf), v);
      openRows.add(rec.nullifier);
      return { ok: true, replaced: held };
    },
    settle(nf, tx_hash, outcome) {
      d.held();
      const held = read(nf);
      if (held === null || held === "unreadable" || held.outcome !== "open" || held.tx_hash !== tx_hash) throw new Error("settle: no open send record with that hash");
      if (outcome.kind === "deadline" || outcome.kind === "never_applied") d.remove(name(nf));
      else if (outcome.kind === "succeeded") d.replace(name(nf), JSON.stringify({ ...held, outcome: "succeeded", error: null }));
      else if (outcome.kind === "failed" && typeof outcome.error === "string") d.replace(name(nf), JSON.stringify({ ...held, outcome: "failed", error: outcome.error }));
      else throw new Error("settle: not an outcome");
      openRows.delete(held.nullifier);
    },
    open: () => [...openRows].map((k) => BigInt(`0x${k}`)),
    close: d.close,
  };
}

// ---- The spends index ----

export type SpendsIndex = {
  /** H: the newest block final on both providers, the lower of their two finals. */
  finalHeight(): Promise<bigint>;
  /** Reads the pages at H until the index is caught up at H; false when INDEX_WAIT_MS passes first. */
  reach(h: bigint): Promise<boolean>;
  /** The pages read so far hold this nullifier. */
  holds(nf: bigint): boolean;
  /** The height the index is caught up at, or null before its first whole read. */
  at(): bigint | null;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** One provider's newest final block height. */
async function finalOf(r: Rpc): Promise<bigint> {
  const b = await r("block", { finality: "final" });
  const h = isObj(b) && isObj(b.header) ? b.header.height : undefined;
  if (typeof h !== "number" || !Number.isSafeInteger(h) || h < 0) throw new Error("block: no final height");
  return BigInt(h);
}

/** One provider's `spends` page at block `h`: the answer's bytes and the block hash it names, which must be at `h`. */
async function pageOf(r: Rpc, vault: string, h: bigint, from: number): Promise<{ bytes: Buffer; hash: string }> {
  const a = await r("query", {
    request_type: "call_function",
    block_id: Number(h),
    account_id: vault,
    method_name: "spends",
    args_base64: Buffer.from(JSON.stringify({ from, limit: SPENDS_PAGE })).toString("base64"),
  });
  if (!isObj(a) || !Array.isArray(a.result)) throw new Error("spends: no result bytes");
  if (a.block_height !== Number(h)) throw new Error("spends: not answered at the block asked");
  if (typeof a.block_hash !== "string" || !B58.test(a.block_hash)) throw new Error("spends: no block hash");
  if (!a.result.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error("spends: result not bytes");
  return { bytes: Buffer.from(a.result as number[]), hash: a.block_hash };
}

/** The page's nullifiers, refused unless every row is the vault's SpendView at its own index with a canonical nullifier. */
function nullifiersOf(bytes: Buffer, from: number): bigint[] {
  const page = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
  if (!Array.isArray(page) || page.length > SPENDS_PAGE) throw new Error("spends: not a page");
  return page.map((x, i) => {
    if (!isObj(x) || x.index !== from + i) throw new Error("spends: a row not at its index");
    const nf = decimal(x.nullifier_hash, VAULT_FIELD_P);
    if (nf === null) throw new Error("spends: a nullifier_hash not one canonical decimal below p");
    return nf;
  });
}

/**
 * The index of the vault's spends pages on two providers of two operators (`rpcs`). Reads run one at a time, each at a
 * final height at or above the last, so the cursor never skips a row.
 */
export function createSpendsIndex(rpcs: readonly [Rpc, Rpc], vault: string, waitMs = INDEX_WAIT_MS): SpendsIndex {
  const spent = new Set<string>();
  let next = 0;
  let caughtAt: bigint | null = null;

  /** Every page from the cursor at `h` on both providers; the cursor moves only on a page both answer alike. */
  const readAt = async (h: bigint) => {
    for (;;) {
      const from = next;
      const [a, b] = await Promise.all(rpcs.map((r) => pageOf(r, vault, h, from)));
      if (a!.hash !== b!.hash) throw new Error("spends: the two providers name different blocks");
      if (!a!.bytes.equals(b!.bytes)) throw new Error("spends: the two providers disagree on a page");
      const nfs = nullifiersOf(a!.bytes, from);
      for (const nf of nfs) spent.add(nullifierKey(nf));
      next = from + nfs.length;
      if (nfs.length < SPENDS_PAGE) return;
    }
  };

  let chain: Promise<unknown> = Promise.resolve();
  const reach = (h: bigint): Promise<boolean> => {
    const until = Date.now() + waitMs;
    const run = chain.then(async () => {
      for (;;) {
        if (caughtAt !== null && caughtAt >= h) return true;
        if (Date.now() >= until) return false;
        try {
          await readAt(h);
          caughtAt = h;
          return true;
        } catch {
          await sleep(POLL_MS);
        }
      }
    });
    chain = run.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), Math.max(0, until - Date.now()));
    });
    return Promise.race([run, late]).finally(() => clearTimeout(timer));
  };

  return {
    async finalHeight() {
      const [a, b] = await Promise.all(rpcs.map(finalOf));
      return a! < b! ? a! : b!;
    },
    reach,
    holds: (nf) => spent.has(nullifierKey(nf)),
    at: () => caughtAt,
  };
}

// ---- Checks 5 and 6 on the nullifier ----

export type NullifierDeps = {
  index: SpendsIndex;
  store: WithdrawSendStore;
  /** The running helper's release number (HELPER_RELEASE): a whole number that only goes up. */
  release: number;
};

export type NullifierVerdict = { ok: true } | { ok: false; code: NullifierCode; why: string };

/**
 * Check 5 (spent: the pages hold it, or its send record reads succeeded; index_behind when the index cannot reach H
 * in time), then check 6 (in_flight: its send record is open or unreadable; withdraw_failed: its send failed under a
 * release number at or above the running one). An ok here is advice: only claim() decides who sends.
 */
export async function checkNullifier(nf: bigint, deps: NullifierDeps): Promise<NullifierVerdict> {
  if (!Number.isSafeInteger(deps.release) || deps.release < 1) throw new Error("release: not a whole number, 1 or more");
  const no = (code: NullifierCode, why: string): NullifierVerdict => ({ ok: false, code, why });
  const first = deps.store.get(nf);
  if (first !== null && first !== "unreadable" && first.outcome === "succeeded") return no("spent", "its send record reads succeeded");

  let h: bigint;
  try {
    h = await deps.index.finalHeight();
  } catch (e) {
    return no("index_behind", `the providers' final heights do not read (${e instanceof Error ? e.message.slice(0, 200) : "error"})`);
  }
  if (!(await deps.index.reach(h))) return no("index_behind", `the spends index has not reached final height ${h}`);
  if (deps.index.holds(nf)) return no("spent", "the vault's spends pages hold it");

  const rec = deps.store.get(nf); // read again: a claim may have landed during the wait
  if (rec === null) return { ok: true };
  if (rec === "unreadable") return no("in_flight", "its send record does not read; held as open");
  if (rec.outcome === "succeeded") return no("spent", "its send record reads succeeded");
  if (rec.outcome === "open") return no("in_flight", "its send's outcome is not final");
  if (rec.release >= deps.release) return no("withdraw_failed", `its send failed on chain under release ${rec.release}`);
  return { ok: true };
}
