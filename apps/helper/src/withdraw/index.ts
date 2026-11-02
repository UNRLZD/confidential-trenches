// POST /v1/withdraw's checks 5 and 6 on the nullifier (markets paper H3.4, check 5's spends index and its "caught up"
// rule, check 6's in-flight set and the send record): the relayer never sends for a spent nullifier, and never a
// second send for one whose send is in flight.
//
// The spends index: the vault's `spends` pages (every spend, withdrawals and ragequits alike, append-only), read by
// block_id on two NEAR providers of two operators. A page counts only when both answer it at the same height with the
// same block hash and the same bytes; anything else (an error, a disagreement, a malformed row) counts nothing and
// decides nothing. It is caught up at H once it has read the whole list at a block at or above H. At each request H
// is the newest block final on both providers (the lower of their two finals), and the index waits up to
// INDEX_WAIT_MS for H; past that the request is `index_behind` (503), and the kit resends. A final that has stopped
// moving would freeze H, so H is refused (index_behind) when the two finals are more than MAX_FINAL_GAP blocks apart or
// H's block time is more than MAX_FINAL_AGE_MS behind the helper's clock.
//
// The send records: one row per nullifier value (its 32-byte big-endian hex, never the string as received), written
// once by an atomic create-if-absent before any broadcast, kept across restarts in the relayers' durable store
// (store/durable.ts). A record whose outcome is not final makes the nullifier `in_flight` whatever the index says, so
// an index that lags the chain can never cause a second send: the row, not the index, keys check 6. A row that reads
// succeeded marks the nullifier spent at once, before the pages show it. A failure other than the deadline's is kept
// with its error and the signer's release number: `withdraw_failed` while the running release's number is not above
// it, and a release with a higher number may carry the note once more by replacing that row. The release number is the
// store's own, given once when the running helper opens it, and every claim is stamped with it. A claim also refuses
// unless the signing key's nonce counter is already past the record's nonce, so a record never holds a nonce another
// signer of that key could still take. A deadline failure, or
// a send never applied, deletes the row and frees the note. An unreadable row is treated as open: never replaced,
// never sent past.
//
// Not here: signing, broadcasting, reading a send's outcome from blocks (D_w, E_w) and the restart's rebroadcast
// (withdraw/send.ts); this file holds the rules they write through.
import * as nodeFs from "node:fs";
import { VAULT_FIELD_P } from "@blindfill/kit";
import type { RelayerStore, TxRef } from "../bind/send.ts";
import { listAt, pagesAt, type Rpc } from "../near/pages.ts";
import { openDurableDir, type DurableDir, type StoreFs } from "../store/durable.ts";
import { decimal } from "./checks.ts";

// ---- Values ----

/** Check 5's wait for the index to reach H before `503 index_behind` [design]. */
export const INDEX_WAIT_MS = 2_000;
/** Rows per `spends` page read (the vault caps a page at PAGE_MAX, 1,000; 100 keeps an answer well under the RPC bound). */
export const SPENDS_PAGE = 100;
/**
 * The most blocks the two providers' finals may stand apart before H is refused. F69 (markets paper, H3.4 check 5,
 * M:1124-1126; check 9's margin, M:1380-1381) reads a provider's final answer about 5 blocks behind the other's; twice
 * that is a provider that has stopped, not one that lags [design].
 */
export const MAX_FINAL_GAP = 10n;
/**
 * The most H's block time may trail the helper's clock: check 9's 30 s margin (M:1376), so a frozen final can hold a
 * spend past check 5 for no longer than one deadline margin [design].
 */
export const MAX_FINAL_AGE_MS = 30_000n;
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
 * the key's counter id (`<account>/<public key>`, as the relayer's nonce counter names it), the request's deadline_ms
 * and the release number of the helper that signed. `outcome` is "open" until the send's outcome is read from blocks;
 * `error` holds the on-chain error of a failure.
 */
export type WithdrawSend = TxRef & {
  nullifier: string;
  key: string;
  deadline_ms: number;
  release: number;
  outcome: "open" | "succeeded" | "failed";
  error: string | null;
  /**
   * The settle after a send that succeeded (markets.md H3.1: "settle(nullifier_hash) once the callback has run"): its
   * transaction, and done once it read succeeded or the vault's spends row reads settled. Absent until one is signed.
   */
  settle?: SettleRecord | null;
};

/**
 * The relayer's settle transaction (null when none is signed: another caller settled the spend first, which anyone
 * may) and whether the spend reads settled.
 */
export type SettleRecord = { tx: (TxRef & { key: string }) | null; done: boolean; failed?: SettleFailure };
/**
 * A settle that failed on chain, with the release that signed it: no release at or below it signs another settle for
 * that nullifier (a failure that repeats would burn gas every round); a higher release may try once more.
 */
export type SettleFailure = { release: number; error: string };

/** A send's outcome as read from blocks. A deadline failure and a send never applied delete the row. */
export type SendOutcome = { kind: "succeeded" } | { kind: "failed"; error: string } | { kind: "deadline" } | { kind: "never_applied" };

/** What a signer hands claim(): the store stamps the release, the open outcome and no error. */
export type SendClaim = Omit<WithdrawSend, "release" | "outcome" | "error">;

export type Claim = { ok: true; replaced: WithdrawSend | null } | { ok: false; code: Exclude<NullifierCode, "index_behind"> };

export type WithdrawSendStore = {
  /** The running helper's release number (HELPER_RELEASE), stamped on every claim. */
  readonly release: number;
  /** The nullifier's send record, "unreadable" for a row that does not parse as one, or null. */
  get(nf: bigint): WithdrawSend | "unreadable" | null;
  /**
   * The write before a broadcast: creates the row when none exists, or replaces a row holding a failure (not the
   * deadline's; those rows are deleted) recorded under a lower release number than the store's; durable before it
   * returns. Fails on any other row, writing nothing: its bytes are then dropped, never sent. Throws, writing nothing,
   * unless the key's nonce counter is already past `rec.nonce`.
   */
  claim(rec: SendClaim): Claim;
  /** Records an open send's outcome. Throws unless the row is open and holds `tx_hash` (a stale outcome changes nothing). */
  settle(nf: bigint, tx_hash: string, outcome: SendOutcome): void;
  /** The nullifiers whose row is open or unreadable: the restart's rebroadcast and the outcome rounds' work. */
  open(): bigint[];
  /**
   * Writes a succeeded send's settle (its transaction, durable before it is broadcast, or done), records its open
   * settle's failure on chain under the running release (no more settles for it in this release), or clears one that
   * never landed (or failed under a lower release), so the next round signs again. Throws unless the row reads
   * succeeded and, for a new settle transaction, holds none still open; and unless the key's counter is past its nonce.
   */
  setSettle(nf: bigint, settle: SettleRecord | null): void;
  /** The nullifiers whose send succeeded and whose spend is not settled yet: the settle rounds' work. */
  toSettle(): bigint[];
  close(): void;
};

const NAME = /^w-([0-9a-f]{64})\.json$/;
const name = (nf: bigint) => `w-${nullifierKey(nf)}.json`;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEC = /^(0|[1-9][0-9]{0,19})$/;

function settleOk(s: unknown): boolean {
  if (typeof s !== "object" || s === null || Array.isArray(s)) return false;
  const r = s as Record<string, unknown>;
  const n = Object.keys(r).length;
  if (!(n === 2 || (n === 3 && "failed" in r)) || typeof r.done !== "boolean") return false;
  if (n === 3) {
    const f = r.failed as Record<string, unknown> | null;
    if (r.done || r.tx === null || typeof f !== "object" || f === null || Array.isArray(f) || Object.keys(f).length !== 2) return false;
    if (!Number.isSafeInteger(f.release) || (f.release as number) < 1 || typeof f.error !== "string") return false;
  }
  if (r.tx === null) return r.done; // no transaction of ours: only "settled by another"
  if (typeof r.tx !== "object" || Array.isArray(r.tx)) return false;
  const x = r.tx as Record<string, unknown>;
  return (
    typeof x.tx_hash === "string" && B58.test(x.tx_hash) &&
    typeof x.signed_tx === "string" && x.signed_tx.length > 0 &&
    typeof x.nonce === "string" && DEC.test(x.nonce) &&
    typeof x.height === "string" && DEC.test(x.height) &&
    typeof x.block_hash === "string" && B58.test(x.block_hash) &&
    typeof x.key === "string" && x.key.length > 0
  );
}

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
    ((x.outcome === "failed" && typeof x.error === "string") || ((x.outcome === "open" || x.outcome === "succeeded") && x.error === null)) &&
    (x.settle === undefined || x.settle === null || (x.outcome === "succeeded" && settleOk(x.settle)));
  return ok ? (x as WithdrawSend) : null;
}

export type SendStoreOptions = {
  /** The running helper's release number: a whole number, 1 or more, that only goes up. */
  release: number;
  /** The relayer's nonce counters (bind/send.ts RelayerStore): the one store every signer of a key takes n from. */
  keys: Pick<RelayerStore, "nonceNext">;
};

/** The withdrawal send records in `dir`, owned by this process (the store's lock). */
export function createWithdrawSendStore(dir: string, opts: SendStoreOptions, fs: StoreFs = nodeFs): WithdrawSendStore {
  if (!Number.isSafeInteger(opts.release) || opts.release < 1) throw new Error("release: not a whole number, 1 or more");
  return openDurableDir(dir, fs, (d) => sendStoreOn(d, opts));
}

function sendStoreOn(d: DurableDir, { release, keys }: SendStoreOptions): WithdrawSendStore {
  const read = (nf: bigint): WithdrawSend | "unreadable" | null => {
    const text = d.text(name(nf));
    if (text === null) return null;
    return parseSend(text, nullifierKey(nf)) ?? "unreadable";
  };
  // open rows: read once as the lock is taken (a restart), then kept by every write (one process holds the store)
  const openRows = new Set<string>();
  const settleRows = new Set<string>();
  for (const f of d.names()) {
    const m = NAME.exec(f);
    if (m === null) continue;
    const rec = parseSend(d.text(f) ?? "", m[1]!);
    if (rec === null || rec.outcome === "open") openRows.add(m[1]!);
    else if (rec.outcome === "succeeded" && rec.settle?.done !== true && !((rec.settle?.failed?.release ?? 0) >= release)) settleRows.add(m[1]!);
  }
  return {
    release,
    get: read,
    claim(input) {
      d.held();
      const rec: WithdrawSend = { ...input, release, outcome: "open", error: null };
      const nf = BigInt(`0x${rec.nullifier}`);
      if (parseSend(JSON.stringify(rec), nullifierKey(nf)) === null) throw new Error("claim: not an open send record");
      const counter = keys.nonceNext(rec.key);
      if (counter === null || counter <= BigInt(rec.nonce)) throw new Error("claim: the key's nonce counter is not past this nonce");
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
      if (held.release >= release) return { ok: false, code: "withdraw_failed" };
      d.replace(name(nf), v);
      openRows.add(rec.nullifier);
      return { ok: true, replaced: held };
    },
    settle(nf, tx_hash, outcome) {
      d.held();
      const held = read(nf);
      if (held === null || held === "unreadable" || held.outcome !== "open" || held.tx_hash !== tx_hash) throw new Error("settle: no open send record with that hash");
      if (outcome.kind === "deadline" || outcome.kind === "never_applied") d.remove(name(nf));
      else if (outcome.kind === "succeeded") {
        d.replace(name(nf), JSON.stringify({ ...held, outcome: "succeeded", error: null }));
        settleRows.add(held.nullifier);
      }
      else if (outcome.kind === "failed" && typeof outcome.error === "string") d.replace(name(nf), JSON.stringify({ ...held, outcome: "failed", error: outcome.error }));
      else throw new Error("settle: not an outcome");
      openRows.delete(held.nullifier);
    },
    open: () => [...openRows].map((k) => BigInt(`0x${k}`)),
    setSettle(nf, settle) {
      d.held();
      const held = read(nf);
      if (held === null || held === "unreadable" || held.outcome !== "succeeded") throw new Error("setSettle: no succeeded send record");
      if (held.settle?.done === true) throw new Error("setSettle: already settled");
      const was = held.settle?.tx ?? null;
      if (settle?.failed !== undefined) {
        if (settle.tx === null || was === null || was.tx_hash !== settle.tx.tx_hash) throw new Error("setSettle: a failure names another settle transaction");
        if (settle.failed.release !== release) throw new Error("setSettle: a failure is recorded under the running release only");
      } else if (settle !== null && !settle.done) {
        if (settle.tx === null) throw new Error("setSettle: an open settle names no transaction");
        if (was !== null && was.tx_hash !== settle.tx.tx_hash) throw new Error("setSettle: a settle transaction is still open");
        const counter = keys.nonceNext(settle.tx.key);
        if (counter === null || counter <= BigInt(settle.tx.nonce)) throw new Error("setSettle: the key's nonce counter is not past this nonce");
      }
      if (settle !== null && settle.done && settle.tx !== null && was !== null && was.tx_hash !== settle.tx.tx_hash) throw new Error("setSettle: done names another settle transaction");
      const v = JSON.stringify({ ...held, settle });
      if (parseSend(v, held.nullifier) === null) throw new Error("setSettle: not a settle record");
      d.replace(name(nf), v);
      if (settle?.done === true || settle?.failed !== undefined) settleRows.delete(held.nullifier);
    },
    toSettle: () => [...settleRows].map((k) => BigInt(`0x${k}`)),
    close: d.close,
  };
}

// ---- The spends index ----

export type SpendsIndex = {
  /** H: the newest block final on both providers, the lower of their two finals; throws on finals too far apart or too old. */
  finalHeight(): Promise<bigint>;
  /** Reads the pages at H until the index is caught up at H; false when INDEX_WAIT_MS passes first. */
  reach(h: bigint): Promise<boolean>;
  /** The pages read so far hold this nullifier. */
  holds(nf: bigint): boolean;
  /** The height the index is caught up at, or null before its first whole read. */
  at(): bigint | null;
  /** The nullifier's row in the vault's spends list, as the pages read so far hold it, or null. */
  indexOf(nf: bigint): number | null;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** One provider's newest final block: its height and its time in ms (header.timestamp_nanosec, a decimal string). */
async function finalOf(r: Rpc): Promise<{ height: bigint; ms: bigint }> {
  const b = await r("block", { finality: "final" });
  const head = isObj(b) && isObj(b.header) ? b.header : {};
  const h = head.height;
  const ns = head.timestamp_nanosec;
  if (typeof h !== "number" || !Number.isSafeInteger(h) || h < 0) throw new Error("block: no final height");
  if (typeof ns !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(ns)) throw new Error("block: no timestamp_nanosec");
  return { height: BigInt(h), ms: BigInt(ns) / 1_000_000n };
}

/** The page's nullifiers, refused unless each is one canonical decimal below p (pagesAt holds the rest of the page rule). */
function nullifiersOf(page: Record<string, unknown>[]): bigint[] {
  return page.map((x) => {
    const nf = decimal(x.nullifier_hash, VAULT_FIELD_P);
    if (nf === null) throw new Error("spends: a nullifier_hash not one canonical decimal below p");
    return nf;
  });
}

/**
 * The "caught up" rule for one of the vault's append-only lists: `reach(h)` reads the pages at h (readAt, one read at a
 * time, each at a height at or above the last) until the list is read whole at h, or answers false once waitMs passes.
 */
function caughtUp(readAt: (h: bigint) => Promise<void>, waitMs: number): { reach(h: bigint): Promise<boolean>; at(): bigint | null } {
  let caughtAt: bigint | null = null;
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
  return { reach, at: () => caughtAt };
}

/**
 * The index of the vault's spends pages on two providers of two operators (`rpcs`). Reads run one at a time, each at a
 * final height at or above the last, so the cursor never skips a row.
 */
export function createSpendsIndex(rpcs: readonly [Rpc, Rpc], vault: string, waitMs = INDEX_WAIT_MS, now: () => number = Date.now): SpendsIndex {
  const spent = new Map<string, number>();
  let next = 0;

  /** Every page from the cursor at `h` on both providers; the cursor moves only on a page both answer alike. */
  const readAt = async (h: bigint) => {
    for (;;) {
      const from = next;
      const nfs = nullifiersOf(await pagesAt(rpcs, vault, "spends", h, from, SPENDS_PAGE));
      nfs.forEach((nf, i) => spent.set(nullifierKey(nf), from + i));
      next = from + nfs.length;
      if (nfs.length < SPENDS_PAGE) return;
    }
  };

  const { reach, at } = caughtUp(readAt, waitMs);

  return {
    async finalHeight() {
      const [a, b] = await Promise.all(rpcs.map(finalOf));
      const gap = a!.height > b!.height ? a!.height - b!.height : b!.height - a!.height;
      if (gap > MAX_FINAL_GAP) throw new Error(`the two finals stand ${gap} blocks apart`);
      const low = a!.height < b!.height ? a! : b!;
      const age = BigInt(Math.floor(now())) - low.ms;
      if (age > MAX_FINAL_AGE_MS) throw new Error(`H's block is ${age} ms old`);
      return low.height;
    },
    reach,
    holds: (nf) => spent.has(nullifierKey(nf)),
    at,
    indexOf: (nf) => spent.get(nullifierKey(nf)) ?? null,
  };
}

// ---- The leaves index (check 5, row 12) ----

/** Leaves per `leaves` page read (a page of bare decimals; the vault caps a page at PAGE_MAX, 1,000). */
export const LEAVES_PAGE = 500;
/** The state tree's capacity: depth 32 (row 12's tree-full rule, V@93b827c:233). */
export const TREE_CAPACITY = 1n << 32n;

export type LeavesIndex = {
  /** Reads the `leaves` pages at H until the index is caught up at H (the spends index's rule); false when INDEX_WAIT_MS passes first. */
  reach(h: bigint): Promise<boolean>;
  /** The pages read so far hold this value as a leaf. */
  has(leaf: bigint): boolean;
  /** How many leaves the pages read so far hold. */
  count(): bigint;
};

/** The index of the vault's state-tree `leaves` pages on two providers of two operators, read as the spends index is. */
export function createLeavesIndex(rpcs: readonly [Rpc, Rpc], vault: string, waitMs = INDEX_WAIT_MS): LeavesIndex {
  const leaves = new Set<string>();
  let next = 0;
  const readAt = async (h: bigint) => {
    for (;;) {
      const from = next;
      const page = (await listAt(rpcs, vault, "leaves", h, from, LEAVES_PAGE)).map((x) => {
        const v = decimal(x, VAULT_FIELD_P);
        if (v === null) throw new Error("leaves: an entry not one canonical decimal below p");
        return v;
      });
      page.forEach((v) => leaves.add(nullifierKey(v)));
      next = from + page.length;
      if (page.length < LEAVES_PAGE) return;
    }
  };
  const { reach } = caughtUp(readAt, waitMs);
  return { reach, has: (leaf) => leaves.has(nullifierKey(leaf)), count: () => BigInt(next) };
}

// ---- Checks 5 and 6 on the nullifier ----

export type NullifierDeps = {
  index: SpendsIndex;
  /** The send records, opened with the running helper's release number. */
  store: WithdrawSendStore;
};

export type NullifierVerdict = { ok: true } | { ok: false; code: NullifierCode; why: string };

/**
 * Check 5 (spent: the pages hold it, or its send record reads succeeded; index_behind when the index cannot reach H
 * in time), then check 6 (in_flight: its send record is open or unreadable; withdraw_failed: its send failed under a
 * release number at or above the running one). An ok here is advice: only claim() decides who sends.
 */
export async function checkNullifier(nf: bigint, deps: NullifierDeps): Promise<NullifierVerdict> {
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
  if (rec.release >= deps.store.release) return no("withdraw_failed", `its send failed on chain under release ${rec.release}`);
  return { ok: true };
}
