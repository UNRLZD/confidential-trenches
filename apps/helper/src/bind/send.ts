// POST /v1/bind's carry of a deposit call that passed checks 1-7 (checks.ts): check 9's token hold, check 8's two-RPC
// simulation, the prepay and the send (markets paper H4.3 check 8, M:1755-1801, and check 9, M:1802-1809; M284's
// R1-R7, M:1811-1868; vault paper 2.10 (f)-(i), V:705-726). In order, for one signed call:
//
//   0. A re-send of signed bytes already carried answers 200 {tx_hash} of that same transaction, before any check, so a
//      device whose first answer was lost finds its transaction (check 3 would answer bad_nonce once U's nonce moved).
//      The index is U's record itself, so the count and the index are one write.
//   1. relayer_low when the gas account cannot hold one more send's up-front gas and a (U, P)'s worst spend; then (f)
//      once before the checks, since a paused USDC refuses the views check 6 reads.
//   2. checks 1-7 (checks.ts), with R1-R3 and R7's ledger read from the store below.
//   3. U's one in-flight slot, taken by a synchronous test-and-set; the carried index is read again inside it.
//   4. (f) again (check 9); (g) U's USDC and key nonce read at one final height on two RPCs that must agree.
//   5. R1's binding of P to U, then R7's record for U, each by an atomic create-if-absent; R2's one open P per U.
//   6. Every earlier transaction of (U, P) whose outcome is not known is settled first: its stored signed bytes go out
//      again (a send's only while U's delegate is K or more ahead, as R4 holds for the first send; none while the
//      token is held, as (f) holds) and it is read on both providers and an archival one. It is "dropped" (never
//      landed, never will) only with its hash unknown on all three, read twice on finals a block apart, past its
//      validity period (markets.md l.1300 (b)); until it is known the call answers in_flight and nothing new goes out
//      on (U, P).
//      R2's move to a new P settles the old P's this way first.
//   7. (h) the prepay: 904 B whenever a tree may grow or a send on P already went (R5's top-up), else 756 B; never above
//      904 B on P (the bytes of a prepay in flight count). Then the send, only after the prepay read SuccessValue at
//      FINAL. R4's margin K and (f) are checked inside the relayer's queue, right before each transaction is signed
//      and written, so a call never waits in the queue past its margin. A prepay or send of ours dropped goes again
//      once, signed afresh.
//   8. (i) the count is written before the send (R7). A send counts as failed only once the deposits pages, read at a
//      height both providers' finals have passed beyond its last receipt, do not hold P for U; short of that it stays
//      pending. It is not counted when the pages hold P for U, when USDC's own receipt failed with its paused error
//      and the watch's pause history shows USDC paused at that receipt's height (R3's one exception), or when it was
//      dropped. Any other outcome counts, an expired delegate (DelegateActionExpired) included.
//      At three failures U is struck: sender_struck from then on, no top-up.
//
// The gas account holds NEAR for gas and prepays only (markets.md MN:314 (6)); its key signs the relayer's own
// transactions, whose only actions are storage_prepay on the vault and a Delegate carrying U's signed bytes as they
// came. The store is one directory of small JSON files, each written by write, fsync, rename (or link, for a
// create-if-absent) and fsync of the directory, owned by one process through an exclusive lock the kernel holds.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign } from "node:crypto";
import * as nodeFs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { HELPER_CODE_STATUS } from "@blindfill/kit";
import { base58, checkBindDeposit, decodeSignedDelegate, type BindCode, type BindConfig, type BindLedger, type BindReads, type KeyRead } from "./checks.ts";
import { tokenHeld, type TokenStatus } from "../token-status/status.ts";

// ---- The papers' values ----

/** Yocto per storage byte (nearcore storage_amount_per_byte). */
export const YOCTO_PER_BYTE = 10n ** 19n;
/** A deposit's bytes when no tree grows a level (V 2.3, vault constants DEPOSIT_STORAGE_BYTES). */
export const PREPAY_BYTES = 756n;
/** A deposit's bytes when a tree may grow a level, and the most a P is ever prepaid (V 2.3; R5). */
export const PREPAY_MAX_BYTES = 904n;
/** R3: failed sends per (U, P) before U is struck. */
export const MAX_FAILED_SENDS = 3;
/** storage_prepay's gas: it burns 2-3 Tgas (V 2.11); 30 Tgas as the vault's prepay tests send it. */
export const PREPAY_GAS = 30_000_000_000_000n;
/**
 * The gas account's floor for one more (U, P):
 *   one send's gas bought up front: prepaid gas is bought at max(gas price, 1e9 yocto per gas) (markets.md F10,
 *   M:1480); a delegate transaction holds at most 300 Tgas (its inner call at most G_bind_cap, 203.126 Tgas, check 5),
 *   so 300e12 x 1e9 = 0.3 N, returned less the burn once it runs;
 *   plus a (U, P)'s worst spend, A1's row-7 maximum (vault.md 2.10, V:735-737): 904 B prepaid (0.00904 N), three
 *   prepays' gas (3 x 0.0003 N) and two failed sends that each burn row 7's 0.0101563 N,
 *   0.00904 + 3 x 0.0003 + 2 x 0.0101563 = 0.0302526 N (PER_P_WORST_YOCTO);
 *   = 0.3302526 N. Below it the relayer answers 503 relayer_low, so a relayer at the floor still holds 0.3 N after it.
 */
export const PER_P_WORST_YOCTO = 30_252_600_000_000_000_000_000n;
export const RELAYER_FLOOR_YOCTO = 300_000_000_000_000n * 1_000_000_000n + PER_P_WORST_YOCTO;
/** USDC's message for every call while paused (V 2.5.1 case 2). */
export const USDC_PAUSED = "FiatToken: paused";
/** How long a send's outcome is waited for at FINAL, and the pages for both finals, before it stays pending. */
export const OUTCOME_WAIT_MS = 30_000;
export const SETTLE_WAIT_MS = 6_000;
const POLL_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- What the carry needs ----

export type Answer = { status: number; body: { tx_hash: string } | { error: { code: BindCode } } };

/** What the deposits pages say of P at a height: held (with the row), absent, or not knowable yet. */
export type Settled = { state: "held"; depositor: string; value: bigint } | { state: "absent" } | { state: "unknown" };

/** The two-RPC reads (checks.ts BindReads, finalHeight the lower of the two finals) and the deposits pages. */
export type SendReads = BindReads & {
  /** R4's "newest final height": the higher of the providers' finals. */
  newestFinalHeight(): Promise<bigint>;
  /** The vault's deposits pages' record of P at the lower final, from the relayer's index, or null. */
  deposit(precommitment: bigint): Promise<{ depositor: string; value: bigint } | null>;
  /** The pages' record of P once both providers' finals are at or past `height`; "unknown" until then. */
  depositSettled(precommitment: bigint, height: bigint): Promise<Settled>;
  /** The state and label trees' sizes now (R5). */
  trees(): Promise<{ state: bigint; label: bigint }>;
};

/**
 * One of the relayer's own transactions: its hash, its key nonce, the height b0 of the block it was signed on (its
 * validity runs from there) and its signed bytes (base64), kept to resend.
 */
export type TxRef = { tx_hash: string; nonce: string; height: string; signed_tx: string };
export type Receipt = { executor: string; ok: boolean; failure: string; height: bigint };

/** One relayer transaction's outcome. */
export type TxOutcome =
  | { kind: "final"; tx_hash: string; receipts: Receipt[] }
  /** It never landed and never can: unknown on every provider, read twice past its validity period. */
  | { kind: "dropped"; tx_hash: string; why: string }
  /** Not known yet: it may still land. */
  | { kind: "unknown"; tx_hash: string; why: string };

export type RelayerAction = { kind: "storage_prepay"; precommitment: bigint; bytes: bigint } | { kind: "delegate"; signed: Uint8Array; receiver: string };

export type Relayer = {
  account: string;
  /** The gas account's NEAR, at final. */
  balance(): Promise<bigint>;
  /**
   * In the relayer's queue: `guard` runs first (R4 and (f)); a code from it ends the call with nothing signed or
   * written. Else one transaction of one action is signed, `before` writes it durably, it goes to both providers, the
   * queue moves on, and its outcome is awaited.
   */
  send(action: RelayerAction, guard: () => Promise<BindCode | null>, before: (tx: TxRef) => void): Promise<TxOutcome | { kind: "guarded"; code: BindCode }>;
  /**
   * A transaction of ours whose outcome was not read: its bytes sent again (unless `resend` is false), then read on
   * both providers and the archival one.
   */
  resolve(tx: TxRef, opts: { resend: boolean }): Promise<TxOutcome>;
};

export type SendDeps = {
  cfg: BindConfig;
  reads: SendReads;
  store: DepositStore;
  relayer: Relayer;
  /** The token watch (status.ts); anything but a caught-up open token holds. */
  tokenStatus(): Promise<TokenStatus>;
  /**
   * The watch's answer from its pause history (status.ts pausedAt): was USDC paused at block `height`; null while the
   * watch has not read that far.
   */
  pausedAt(height: bigint): Promise<boolean | null>;
  /** Inserts seen in flight besides this one (R5: other deposits, withdrawals' change leaves and refund notes). */
  insertsInFlight?(): Promise<bigint>;
};

// ---- R7's record ----

export type SendState = "pending" | "failed" | "landed" | "exempt" | "dropped";
export type PrepayEntry = TxRef & { bytes: number; ok: boolean | null };
export type SendEntry = TxRef & { sha256: string; amount: string; max_block_height: string; state: SendState; counted: boolean };

export type DepositRecord = {
  u: string;
  /** P, decimal. */
  p: string;
  /** What this relayer prepaid on P, prepays in flight included, in bytes; never above 904. */
  prepaid_bytes: number;
  /** Failed prepays and failed sends on (U, P) (pending ones are not yet failures). */
  failed: number;
  struck: boolean;
  /** The pages hold P for U: U's next P may open (R2). */
  landed: boolean;
  /** A prepay of ours on P failed and the pages hold P: nothing more is sent on P (V 2.10 (i)). */
  p_closed: boolean;
  prepays: PrepayEntry[];
  sends: SendEntry[];
  /** U's sends on earlier P's, kept for the idempotent answer once U moved on (R2). */
  carried: { sha256: string; tx_hash: string }[];
};

/** failed and struck from the entries; struck is final once set. */
export function tally(rec: DepositRecord): DepositRecord {
  const failed = rec.prepays.filter((x) => x.ok === false).length + rec.sends.filter((x) => x.state === "failed").length;
  const sends = rec.sends.map((x) => ({ ...x, counted: x.state === "pending" || x.state === "failed" }));
  return { ...rec, sends, failed, struck: rec.struck || failed >= MAX_FAILED_SENDS };
}

export type DepositStore = {
  get(u: string): DepositRecord | null;
  /** R7: create-if-absent on U, durable before it returns; the existing record when one is there. */
  create(rec: DepositRecord): { created: boolean; rec: DepositRecord };
  /** Durable replace of U's record. */
  put(rec: DepositRecord): void;
  /** R1: create-if-absent on P; the U it is bound to. */
  bind(p: bigint, u: string): string;
  boundTo(p: bigint): string | null;
  /** Gives the store's lock up (a test's restart; the process's exit does it too). */
  close(): void;
};

/** The fs calls the store makes; a test passes a recorder to check their order. */
export type StoreFs = Pick<typeof nodeFs, "closeSync" | "fsyncSync" | "linkSync" | "mkdirSync" | "openSync" | "readFileSync" | "readdirSync" | "renameSync" | "unlinkSync" | "writeSync">;

/** How long a start waits for another holder's lock before it refuses (two simultaneous starts: one holds). */
const LOCK_WAIT_MS = 250;

/**
 * A store of small JSON files in `dir`, owned by one process. The owner holds an exclusive SQLite lock on `dir/lock`
 * (node:sqlite, a BEGIN EXCLUSIVE never ended): an fcntl lock the kernel keeps for the life of the
 * process and drops when it dies, however it dies, so a killed process never leaves a stale lock and two starts at
 * once leave one holder. Every write is whole and durable: a replace is write, fsync, rename, fsync of the directory;
 * a create-if-absent is write and fsync of a temp file, link to the name (EEXIST: it is there), unlink of the temp,
 * fsync of the directory, so no name ever holds a partial file. Temp names are random; the holder sweeps any left.
 */
export function createFileStore(dir: string, fs: StoreFs = nodeFs): DepositStore {
  fs.mkdirSync(dir, { recursive: true });
  const path = (name: string) => join(dir, name);

  // The lock: one process per store. Only take() opens this path: POSIX drops all of a process's fcntl locks on a
  // file when any descriptor of that file in the process closes, so nothing else in this process may ever open it
  // (no record name can be "lock"; the truncate below runs only before the lock is held).
  const take = (): DatabaseSync => {
    const db = new DatabaseSync(path("lock"), { timeout: LOCK_WAIT_MS });
    try {
      db.exec("BEGIN EXCLUSIVE");
      return db;
    } catch (e) {
      db.close();
      throw e;
    }
  };
  let lock: DatabaseSync;
  try {
    try {
      lock = take();
    } catch (e) {
      // a holder never writes to the file (it stays an empty database), so content that is not a database was left by
      // something else: emptied in place, the same file, so a holder that took it meanwhile keeps it
      if (!(e instanceof Error && /not a database/.test(e.message))) throw e;
      nodeFs.truncateSync(path("lock"), 0);
      lock = take();
    }
  } catch (e) {
    throw new Error(`store: ${dir} is held by another process (${e instanceof Error ? e.message : String(e)})`);
  }
  let open = true;
  const release = () => {
    if (!open) return;
    open = false;
    lock.close();
  };
  const held = () => {
    if (!open) throw new Error("store: closed");
  };

  const syncDir = () => {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  const writeTemp = (v: string): string => {
    const tmp = path(`.tmp-${randomBytes(16).toString("hex")}`);
    const fd = fs.openSync(tmp, "wx");
    try {
      fs.writeSync(fd, v);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return tmp;
  };
  // temps a crash left behind: never a record, swept once the lock is held
  for (const f of fs.readdirSync(dir)) if (f.startsWith(".tmp-")) fs.unlinkSync(path(f));

  /** Create-if-absent: false when the name is there. */
  const createOnce = (name: string, v: string): boolean => {
    const tmp = writeTemp(v);
    try {
      fs.linkSync(tmp, path(name));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      fs.unlinkSync(tmp);
      syncDir();
    }
  };
  const replace = (name: string, v: string) => {
    fs.renameSync(writeTemp(v), path(name));
    syncDir();
  };
  const read = <T>(name: string): T | null => {
    let text: string;
    try {
      text = fs.readFileSync(path(name), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    return JSON.parse(text) as T;
  };

  const uName = (u: string) => {
    if (!/^[0-9a-f]{64}$/.test(u)) throw new Error("store: U is not a 64-hex id");
    return `u-${u}.json`;
  };
  return {
    get: (u) => read<DepositRecord>(uName(u)),
    create(rec) {
      held();
      if (createOnce(uName(rec.u), JSON.stringify(rec))) return { created: true, rec };
      return { created: false, rec: read<DepositRecord>(uName(rec.u))! };
    },
    put(rec) {
      held();
      replace(uName(rec.u), JSON.stringify(rec));
    },
    bind(p, u) {
      held();
      if (createOnce(`p-${p}.json`, JSON.stringify({ u }))) return u;
      return read<{ u: string }>(`p-${p}.json`)!.u;
    },
    boundTo: (p) => read<{ u: string }>(`p-${p}.json`)?.u ?? null,
    close: release,
  };
}

// ---- R5's size ----

/** True when an insert into a tree of `size` leaves grows it a level: the first insert, and each past a power of two. */
export function insertGrows(size: bigint): boolean {
  return size === 0n || (size & (size - 1n)) === 0n;
}

/** 904 B when an insert at any size from now through every insert in flight grows either tree, else 756 B (R5). */
export function prepayBytes(trees: { state: bigint; label: bigint }, inFlight: bigint): bigint {
  if (inFlight < 0n) throw new Error("inFlight below 0");
  for (let k = 0n; k <= inFlight; k++) if (insertGrows(trees.state + k) || insertGrows(trees.label + k)) return PREPAY_MAX_BYTES;
  return PREPAY_BYTES;
}

// ---- The carry ----

const STATUS: Record<string, number> = HELPER_CODE_STATUS;
const no = (code: BindCode): Answer => ({ status: STATUS[code] ?? 400, body: { error: { code } } });
const sent = (tx_hash: string): Answer => ({ status: 200, body: { tx_hash } });

/** The bytes a request carries when it is {signed_delegate: canonical base64} (check 1's first part), else null. */
function requestBytes(request: unknown): Uint8Array | null {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return null;
  const keys = Object.keys(request);
  if (keys.length !== 1 || keys[0] !== "signed_delegate") return null;
  const b64 = (request as { signed_delegate: unknown }).signed_delegate;
  if (typeof b64 !== "string" || b64.length > 8_192 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  return Buffer.from(bytes).toString("base64") === b64 ? bytes : null;
}

const sha256hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The transaction that carried these bytes, from U's record: any send of them that was not dropped. */
function carriedBy(store: DepositStore, raw: Uint8Array, sha: string): string | null {
  let u: string;
  try {
    u = decodeSignedDelegate(raw).sender_id;
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(u)) return null;
  const rec = store.get(u);
  if (rec === null) return null;
  return rec.sends.find((x) => x.sha256 === sha && x.state !== "dropped")?.tx_hash ?? rec.carried.find((x) => x.sha256 === sha)?.tx_hash ?? null;
}

/** U's one in-flight slot in this process (the store's lock makes it the only one): U -> the P being carried. */
const inFlight = new Map<string, bigint>();

/** R1-R3 and R7 for checks.ts, read only: nothing is written outside U's slot. */
export function ledgerOf(store: DepositStore, reads: SendReads): BindLedger {
  return {
    struck: async (u) => store.get(u)?.struck === true,
    boundTo: async (p) => store.boundTo(p),
    async openP(u) {
      const rec = store.get(u);
      if (rec === null || rec.landed) return null;
      // the pages hold U's P, for U or for a stranger who front-ran it: U's next P may open (R2)
      return (await reads.deposit(BigInt(rec.p))) !== null ? null : BigInt(rec.p);
    },
    inFlight: async (u, p) => inFlight.get(u) === p,
  };
}

const held = async (deps: SendDeps) => tokenHeld(await deps.tokenStatus());

/** R4 and (f), run inside the relayer's queue right before a transaction is signed. */
const guardFor = (deps: SendDeps, maxBlockHeight: bigint) => async (): Promise<BindCode | null> => {
  if (maxBlockHeight - (await deps.reads.newestFinalHeight()) < deps.cfg.marginK) return "resign_needed";
  if (await held(deps)) return "token_halted";
  return null;
};

export async function carryDeposit(request: unknown, deps: SendDeps): Promise<Answer> {
  const { store, reads, relayer } = deps;

  // 0. The idempotent answer: these exact bytes were carried before.
  const raw = requestBytes(request);
  const sha = raw === null ? null : sha256hex(raw);
  if (raw !== null && sha !== null) {
    const was = carriedBy(store, raw, sha);
    if (was !== null) return sent(was);
  }

  // 1. The gas account can hold one more send and a (U, P)'s worst spend; (f) before the checks.
  if ((await relayer.balance()) < RELAYER_FLOOR_YOCTO) return no("relayer_low");
  if (await held(deps)) return no("token_halted");

  // 2. Checks 1-7.
  const verdict = await checkBindDeposit(request, deps.cfg, reads, ledgerOf(store, reads));
  if (!verdict.ok) return no(verdict.code);
  const d = verdict.deposit;
  const u = d.sender_id;
  const p = d.precommitment;

  // 3. U's one in-flight slot: test-and-set with no await between, then the carried index again.
  const busy = inFlight.get(u);
  if (busy !== undefined) return no(busy === p ? "in_flight" : "prepay_open");
  inFlight.set(u, p);
  try {
    const was = carriedBy(store, raw!, sha!);
    if (was !== null) return sent(was);
    return await carryChecked(deps, d, sha!);
  } finally {
    inFlight.delete(u);
  }
}

type Checked = Extract<Awaited<ReturnType<typeof checkBindDeposit>>, { ok: true }>["deposit"];

/** A prepay's outcome: ok when the vault's receipt and every other ran. */
const prepayOk = (deps: SendDeps, out: Extract<TxOutcome, { kind: "final" }>) => out.receipts.some((r) => r.executor === deps.cfg.vault && r.ok) && out.receipts.every((r) => r.ok);

/** A send's state from its FINAL outcome: the pages at a height both finals passed, and R3's paused exception. */
async function sendState(deps: SendDeps, u: string, p: bigint, amount: bigint, out: Extract<TxOutcome, { kind: "final" }>): Promise<SendState> {
  const last = out.receipts.reduce((h, r) => (r.height > h ? r.height : h), 0n);
  const pages = await deps.reads.depositSettled(p, last);
  if (pages.state === "unknown") return "pending";
  if (pages.state === "held" && pages.depositor === u && pages.value === amount) return "landed";
  // Whatever else the outcome is, an expiry (DelegateActionExpired) included, it counts (R3, M284, V 2.10): the per-U
  // cost bound never rests on K's value.
  const paused = out.receipts.find((r) => !r.ok && r.executor === deps.cfg.token && r.failure.includes(USDC_PAUSED));
  if (paused !== undefined) {
    // R3's exception: USDC's own receipt failed with its paused error, and the watch's pause history shows USDC
    // paused at that receipt's height. Until the watch has read that far, the send stays pending.
    const at = await deps.pausedAt(paused.height);
    if (at === null) return "pending";
    if (at) return "exempt";
  }
  return "failed";
}

/** Settles every earlier transaction of (U, P) whose outcome is not known; the record as it then stands. */
async function settle(deps: SendDeps, rec: DepositRecord, u: string, p: bigint): Promise<DepositRecord> {
  for (const pre of rec.prepays.filter((x) => x.ok === null)) {
    // (f) holds for a re-send as for the first send
    const out = await deps.relayer.resolve(pre, { resend: !(await held(deps)) });
    if (out.kind === "unknown") continue;
    if (out.kind === "dropped") rec = { ...rec, prepaid_bytes: rec.prepaid_bytes - pre.bytes, prepays: rec.prepays.filter((x) => x.tx_hash !== pre.tx_hash) };
    else rec = await prepayDone(deps, rec, pre, out, p);
    deps.store.put(rec);
  }
  for (const s of rec.sends.filter((x) => x.state === "pending")) {
    // R4 and (f) hold for a re-send as for the first: once U's delegate is within K of its max_block_height, or the
    // token is held, its bytes do not go out again. It is still read: it may have landed, and an expired one counts.
    const newest = await deps.reads.newestFinalHeight();
    const mbh = BigInt(s.max_block_height);
    const out = await deps.relayer.resolve(s, { resend: mbh - newest >= deps.cfg.marginK && !(await held(deps)) });
    if (out.kind === "unknown") continue;
    const state = out.kind === "dropped" ? "dropped" : await sendState(deps, u, p, BigInt(s.amount), out);
    rec = tally({ ...rec, landed: rec.landed || state === "landed", sends: rec.sends.map((x) => (x.tx_hash === s.tx_hash ? { ...x, state } : x)) });
    deps.store.put(rec);
  }
  return rec;
}

/** A prepay's FINAL outcome into the record. A failed one counts (M292); it closes P only when the pages hold P. */
async function prepayDone(deps: SendDeps, rec: DepositRecord, pre: PrepayEntry, out: Extract<TxOutcome, { kind: "final" }>, p: bigint): Promise<DepositRecord> {
  const ok = prepayOk(deps, out);
  const prepays = rec.prepays.map((x) => (x.tx_hash === pre.tx_hash ? { ...x, ok } : x));
  if (ok) return { ...rec, prepays };
  const closed = (await deps.reads.deposit(p)) !== null;
  return tally({ ...rec, prepays, prepaid_bytes: rec.prepaid_bytes - pre.bytes, p_closed: rec.p_closed || closed });
}

async function carryChecked(deps: SendDeps, d: Checked, sha: string): Promise<Answer> {
  const { store, reads, relayer } = deps;
  const u = d.sender_id;
  const p = d.precommitment;

  // 4. (f) check 9, then (g) the simulation: U's USDC and key nonce on two RPCs that agree at final (SendReads).
  if (await held(deps)) return no("token_halted");
  if ((await reads.ftBalance(u)) < d.amount) return no("amount_above_balance");
  const key: KeyRead = await reads.accessKey(u, d.public_key);
  if (key.kind !== "key" || d.nonce <= key.nonce) return no("bad_nonce");

  // 5. R1's binding of P to U, then R7's record, both durable before any prepay; R2.
  if (store.bind(p, u) !== u) return no("p_bound");
  const fresh: DepositRecord = { u, p: p.toString(), prepaid_bytes: 0, failed: 0, struck: false, landed: false, p_closed: false, prepays: [], sends: [], carried: [] };
  let { rec } = store.create(fresh);
  if (rec.p !== fresh.p) {
    // R2: U moves to a new P only once the pages hold the old one (for U, or for a stranger who front-ran it), with
    // nothing of the old P still out. Its open transactions are settled here: once the pages hold the old P, checks 6
    // refuses every call on it, so this is the call that reads them.
    rec = await settle(deps, rec, u, BigInt(rec.p));
    if (rec.struck) return no("sender_struck");
    if (!rec.landed && (await reads.deposit(BigInt(rec.p))) === null) return no("prepay_open");
    if (rec.prepays.some((x) => x.ok === null) || rec.sends.some((x) => x.state === "pending")) return no("prepay_open");
    rec = { ...fresh, carried: [...rec.carried, ...rec.sends.filter((x) => x.state !== "dropped").map((x) => ({ sha256: x.sha256, tx_hash: x.tx_hash }))] };
    store.put(rec);
  }

  // 6. Anything of (U, P) still out is settled first; while it is not known, nothing new goes out.
  rec = await settle(deps, rec, u, p);
  if (rec.prepays.some((x) => x.ok === null) || rec.sends.some((x) => x.state === "pending")) return no("in_flight");
  if (rec.struck) return no("sender_struck");
  if (rec.landed || rec.p_closed) return no("p_used");

  // 7. (h) the prepay, topped up to 904 B on a retry, never above 904 B on P.
  const target = rec.sends.some((x) => x.state !== "dropped") ? PREPAY_MAX_BYTES : prepayBytes(await reads.trees(), (await deps.insertsInFlight?.()) ?? 0n);
  const topUp = target - BigInt(rec.prepaid_bytes);
  // A transaction of ours that never landed (dropped: the key's nonce moved, or it expired) goes again once, signed
  // afresh, so the relayer's own trouble costs U nothing; a second drop asks for a re-sign.
  for (let attempt = 0; topUp > 0n; attempt++) {
    let entry: PrepayEntry | null = null;
    const out = await relayer.send({ kind: "storage_prepay", precommitment: p, bytes: topUp }, guardFor(deps, d.max_block_height), (tx) => {
      entry = { ...tx, bytes: Number(topUp), ok: null };
      rec = { ...rec, prepaid_bytes: rec.prepaid_bytes + Number(topUp), prepays: [...rec.prepays, entry] };
      store.put(rec);
    });
    if (out.kind === "guarded") return no(out.code);
    if (out.kind === "unknown") return no("in_flight"); // settled on the next call
    if (out.kind === "dropped") {
      rec = { ...rec, prepaid_bytes: rec.prepaid_bytes - Number(topUp), prepays: rec.prepays.filter((x) => x.tx_hash !== out.tx_hash) };
      store.put(rec);
      if (attempt === 0) continue;
      return no("resign_needed"); // nothing happened: the device signs again
    }
    rec = await prepayDone(deps, rec, entry!, out, p);
    store.put(rec);
    if (rec.prepays.find((x) => x.tx_hash === out.tx_hash)!.ok !== true) {
      if (rec.struck) return no("sender_struck");
      return no(rec.p_closed ? "p_used" : "resign_needed");
    }
    break;
  }

  // 8. (i) the send: R4 and (f) in the queue, the count written before it goes. R3's three were read after the settle
  // (step 6); a prepay since then either succeeded or returned above, so the record's failures have not moved.
  for (let attempt = 0; ; attempt++) {
    const out = await relayer.send({ kind: "delegate", signed: d.signed_delegate, receiver: u }, guardFor(deps, d.max_block_height), (tx) => {
      const entry: SendEntry = { ...tx, sha256: sha, amount: d.amount.toString(), max_block_height: d.max_block_height.toString(), state: "pending", counted: true };
      rec = tally({ ...rec, sends: [...rec.sends, entry] });
      store.put(rec);
    });
    if (out.kind === "guarded") return no(out.code);
    if (out.kind === "unknown") return sent(out.tx_hash); // pending: the device reads it, and the next call settles it
    const state: SendState = out.kind === "dropped" ? "dropped" : await sendState(deps, u, p, d.amount, out);
    rec = tally({ ...rec, landed: rec.landed || state === "landed", sends: rec.sends.map((x) => (x.tx_hash === out.tx_hash ? { ...x, state } : x)) });
    store.put(rec);
    if (state !== "dropped") return sent(out.tx_hash);
    if (attempt > 0) return no("resign_needed"); // dropped twice
  }
}

// ---- The NEAR side: two RPCs, the relayer's key ----

export type Rpc = (method: string, params: unknown) => Promise<unknown>;
export const RPC_TIMEOUT_MS = 10_000;
const RPC_ANSWER_MAX = 4 * 1024 * 1024;

/** A JSON-RPC client for one NEAR provider: a bounded answer, a timeout, the `error` object thrown as is. */
export function nearRpc(url: string, fetchFn: typeof fetch = fetch, timeoutMs = RPC_TIMEOUT_MS): Rpc {
  return async (method, params) => {
    const res = await fetchFn(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "r", method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (text.length > RPC_ANSWER_MAX) throw new Error(`${method}: answer over ${RPC_ANSWER_MAX} B`);
    const a = JSON.parse(text) as { result?: unknown; error?: unknown };
    if (a.error !== undefined) throw new RpcError(method, a.error);
    if (a.result === undefined) throw new Error(`${method}: no result`);
    return a.result;
  };
}

export class RpcError extends Error {
  readonly data: unknown;
  constructor(method: string, data: unknown) {
    super(`${method}: ${JSON.stringify(data).slice(0, 500)}`);
    this.data = data;
  }
  get cause_name(): string {
    const d = this.data as { cause?: { name?: unknown } } | null;
    return typeof d?.cause?.name === "string" ? d.cause.name : "";
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const u128 = (x: unknown, what: string): bigint => {
  if (typeof x !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(x)) throw new Error(`${what}: not a u128 decimal`);
  return BigInt(x);
};
const u64 = (x: unknown, what: string): bigint => {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) throw new Error(`${what}: not a height or nonce`);
  return BigInt(x);
};
const big = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

/**
 * The reads, each on both providers at one final height (the lower of their two finals), refused unless both answer
 * the same: the call is held, nothing spent on an unknown. The deposits pages are indexed as read, page by page.
 */
export function createSendReads(rpcs: readonly [Rpc, Rpc], cfg: { vault: string; token: string }, waitMs = SETTLE_WAIT_MS): SendReads {
  const finals = () => Promise.all(rpcs.map(async (r) => u64(((await r("block", { finality: "final" })) as { header?: { height?: unknown } }).header?.height, "block.height")));
  const finalHeight = async (): Promise<bigint> => {
    const hs = await finals();
    return hs[0]! < hs[1]! ? hs[0]! : hs[1]!;
  };
  const newestFinalHeight = async (): Promise<bigint> => {
    const hs = await finals();
    return hs[0]! > hs[1]! ? hs[0]! : hs[1]!;
  };
  /** One read on both providers at one height: `at`, else the lower final now. */
  const both = async <T>(read: (r: Rpc, h: bigint) => Promise<T>, at?: bigint): Promise<T> => {
    const h = at ?? (await finalHeight());
    const [a, b] = await Promise.all(rpcs.map((r) => read(r, h)));
    if (big(a) !== big(b)) throw new Error("the two RPCs disagree");
    return a as T;
  };
  const view = async (r: Rpc, h: bigint, account: string, method: string, args: unknown): Promise<unknown> => {
    const res = await r("query", { request_type: "call_function", block_id: Number(h), account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    if (!isObj(res) || !Array.isArray(res.result)) throw new Error(`${method}: no result bytes`);
    return JSON.parse(Buffer.from(res.result as number[]).toString("utf8"));
  };
  const pages = new Map<string, { depositor: string; value: bigint }>();
  let next = 0;
  const PAGE = 100;
  // One index read at a time: two at once would each move the cursor past the same page and skip the rows after it
  // (sandbox case c: a landed deposit read as a failed send).
  let indexing: Promise<unknown> = Promise.resolve();
  const catchUp = async (at?: bigint) => {
    for (;;) {
      const from = next;
      const page = await both(async (r, h) => view(r, h, cfg.vault, "deposits", { from, limit: PAGE }), at);
      if (!Array.isArray(page) || page.length > PAGE) throw new Error("deposits: not a page");
      for (const x of page) {
        if (!isObj(x) || typeof x.precommitment !== "string" || typeof x.depositor !== "string") throw new Error("deposits: not a deposit");
        pages.set(x.precommitment, { depositor: x.depositor, value: u128(x.value, "deposits.value") });
      }
      next = from + page.length;
      if (page.length < PAGE) return;
    }
  };
  const deposit = async (precommitment: bigint, at?: bigint) => {
    const run = indexing.then(() => catchUp(at));
    indexing = run.catch(() => undefined);
    await run;
    return pages.get(precommitment.toString()) ?? null;
  };
  return {
    finalHeight,
    newestFinalHeight,
    accessKey: (account, publicKey) =>
      both(async (r, h): Promise<KeyRead> => {
        try {
          const k = await r("query", { request_type: "view_access_key", block_id: Number(h), account_id: account, public_key: publicKey });
          if (!isObj(k)) throw new Error("view_access_key: not an object");
          return { kind: "key", permission: k.permission, nonce: u64(k.nonce, "nonce") };
        } catch (e) {
          if (e instanceof RpcError && e.cause_name === "UNKNOWN_ACCOUNT") return { kind: "no_account" };
          if (e instanceof RpcError && e.cause_name === "UNKNOWN_ACCESS_KEY") return { kind: "no_key" };
          throw e;
        }
      }),
    ftBalance: (account) => both(async (r, h) => u128(await view(r, h, cfg.token, "ft_balance_of", { account_id: account }), "ft_balance_of")),
    deposit,
    async depositSettled(precommitment, height) {
      const until = Date.now() + waitMs;
      let low: bigint;
      while ((low = await finalHeight()) < height) {
        if (Date.now() >= until) return { state: "unknown" };
        await sleep(POLL_MS);
      }
      // read at the height that passed, not at a final read again (a load-balanced provider may answer lower)
      const row = await deposit(precommitment, low);
      return row === null ? { state: "absent" } : { state: "held", ...row };
    },
    pUsed: async (precommitment) => (await deposit(precommitment)) !== null,
    trees: () =>
      both(async (r, h) => {
        const s = (await view(r, h, cfg.vault, "state_tree", {})) as { size?: unknown };
        const l = (await view(r, h, cfg.vault, "label_tree", {})) as { size?: unknown };
        return { state: u64(s.size, "state_tree.size"), label: u64(l.size, "label_tree.size") };
      }),
  };
}

// ---- The relayer's transactions (borsh, nearcore core/primitives/src/transaction.rs, action/mod.rs) ----

const le = (n: bigint, len: number): Buffer => {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
};
const bstr = (s: string | Uint8Array): Buffer => {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s);
  return Buffer.concat([le(BigInt(b.length), 4), b]);
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("base58: bad character");
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

/** borsh(Transaction V0) of one action. */
export function encodeTransaction(t: { signer: string; publicKey: Uint8Array; nonce: bigint; receiver: string; blockHash: Uint8Array; action: Buffer }): Buffer {
  if (t.publicKey.length !== 32 || t.blockHash.length !== 32) throw new Error("transaction: key or block hash not 32 bytes");
  return Buffer.concat([bstr(t.signer), Buffer.from([0]), Buffer.from(t.publicKey), le(t.nonce, 8), bstr(t.receiver), Buffer.from(t.blockHash), le(1n, 4), t.action]);
}

export function encodeAction(a: RelayerAction): Buffer {
  if (a.kind === "storage_prepay") {
    if (a.bytes <= 0n || a.bytes > PREPAY_MAX_BYTES) throw new Error("storage_prepay: bytes outside 1..904");
    const args = JSON.stringify({ precommitment: a.precommitment.toString() });
    return Buffer.concat([Buffer.from([2]), bstr("storage_prepay"), bstr(args), le(PREPAY_GAS, 8), le(a.bytes * YOCTO_PER_BYTE, 16)]);
  }
  return Buffer.concat([Buffer.from([8]), Buffer.from(a.signed)]); // Action::Delegate(SignedDelegateAction), the bytes as signed
}

/** The ed25519 key behind "ed25519:" + base58 of 64 bytes, its public half checked against its seed. */
export function relayerKey(secretKey: string): { priv: ReturnType<typeof createPrivateKey>; pub: Uint8Array } {
  if (!secretKey.startsWith("ed25519:")) throw new Error("relayer key: not ed25519");
  const sk = base58decode(secretKey.slice(8));
  if (sk.length !== 64) throw new Error("relayer key: not 64 bytes");
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), sk.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const derived = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  if (!derived.equals(Buffer.from(sk.subarray(32)))) throw new Error("relayer key: the public half is not the seed's");
  return { priv, pub: sk.subarray(32) };
}

/** At most this many entries in each of the relayer's caches (block heights, first reads past the validity period). */
export const CACHE_MAX = 4_096;
/** A Map entry kept, the oldest dropped past `CACHE_MAX`: forgetting one only costs a read again. */
export const remember = <K, V>(m: Map<K, V>, k: K, v: V) => {
  m.delete(k);
  m.set(k, v);
  if (m.size > CACHE_MAX) m.delete(m.keys().next().value as K);
};

/**
 * The chain's `transaction_validity_period` (blocks), read live from EXPERIMENTAL_protocol_config on both providers;
 * an error when they differ, so the relayer never starts on a number one provider alone gave.
 */
export async function transactionValidityPeriod(rpcs: readonly [Rpc, Rpc]): Promise<bigint> {
  const ps = await Promise.all(rpcs.map(async (r) => u64(((await r("EXPERIMENTAL_protocol_config", { finality: "final" })) as { transaction_validity_period?: unknown }).transaction_validity_period, "transaction_validity_period")));
  if (ps[0] !== ps[1]) throw new Error(`relayer: the two RPCs disagree on transaction_validity_period (${ps[0]} and ${ps[1]})`);
  return ps[0]!;
}

/** The relayer as it starts: the validity period read from both providers first, then the gas account. */
export async function startRelayer(rpcs: readonly [Rpc, Rpc], archival: Rpc, account: string, secretKey: string, vault: string, waitMs = OUTCOME_WAIT_MS): Promise<Relayer> {
  return createRelayer(rpcs, archival, account, secretKey, vault, await transactionValidityPeriod(rpcs), waitMs);
}

/**
 * The gas account: one key. Its queue holds only the guard, the signing, the durable write and the send to both
 * providers, never the wait for FINAL. Each transaction is signed from one view_access_key answer at final (markets.md
 * send record): its block hash and height b0 from that answer, its nonce one above the larger of the key's nonce there
 * and the last nonce this relayer handed out, so transactions in flight never share one and a key whose nonce jumped
 * is followed at the next signing. They go by send_tx with wait_until NONE, which validates nothing before it answers
 * (nearcore send_tx: NONE is send_tx_async, chain/jsonrpc lib.rs l.1191-1206), so a refusal is never read from the
 * send: only the chain says what happened.
 *
 * A transaction is dropped (never landed, never will) only when its hash is unknown on both providers and on the
 * archival one (a regular node forgets a landed transaction after its garbage collection, an archival one never) and
 * the newest final is more than `validity` blocks past b0, so no block can include it (markets.md l.1300 (b)); that
 * is read twice, on finals at least a block apart, so a provider whose `tx` index lags its own final cannot make a
 * landed transaction look dropped. Nothing else drops one: not UNKNOWN_TRANSACTION on its own, not a nonce past it.
 */
export function createRelayer(rpcs: readonly [Rpc, Rpc], archival: Rpc, account: string, secretKey: string, vault: string, validity: bigint, waitMs = OUTCOME_WAIT_MS): Relayer {
  const { priv, pub } = relayerKey(secretKey);
  const publicKey = `ed25519:${base58(pub)}`;
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0n; // the last nonce handed out

  const broadcast = async (signed: string): Promise<void> => {
    await Promise.allSettled(rpcs.map((r) => r("send_tx", { signed_tx_base64: signed, wait_until: "NONE" })));
  };
  const heights = new Map<string, bigint>();
  const heightOf = async (r: Rpc, hash: unknown): Promise<bigint> => {
    if (typeof hash !== "string") throw new Error("receipt: no block_hash");
    let h = heights.get(hash);
    if (h === undefined) {
      h = u64(((await r("block", { block_id: hash })) as { header?: { height?: unknown } }).header?.height, "block.height");
      remember(heights, hash, h);
    }
    return h;
  };
  const finalOf = async (r: Rpc): Promise<bigint | null> => {
    try {
      return u64(((await r("block", { finality: "final" })) as { header?: { height?: unknown } }).header?.height, "block.height");
    } catch {
      return null;
    }
  };
  type Read = { final: Receipt[] | null; unknownTx: boolean };
  const readTx = async (r: Rpc, tx: TxRef): Promise<Read | null> => {
    try {
      const a = await r("tx", { tx_hash: tx.tx_hash, sender_account_id: account, wait_until: "NONE" });
      if (isObj(a) && a.final_execution_status === "FINAL" && Array.isArray(a.receipts_outcome)) {
        const receipts: Receipt[] = [];
        for (const o of a.receipts_outcome) {
          const out = isObj(o) && isObj(o.outcome) ? o.outcome : {};
          const st = isObj(out.status) ? out.status : {};
          const ok = Object.hasOwn(st, "SuccessValue") || Object.hasOwn(st, "SuccessReceiptId");
          receipts.push({ executor: typeof out.executor_id === "string" ? out.executor_id : "", ok, failure: ok ? "" : JSON.stringify(st), height: await heightOf(r, isObj(o) ? o.block_hash : undefined) });
        }
        return { final: receipts, unknownTx: false };
      }
      return { final: null, unknownTx: false };
    } catch (e) {
      if (e instanceof RpcError && e.cause_name === "UNKNOWN_TRANSACTION") return { final: null, unknownTx: true };
      return null;
    }
  };
  /** The newest final at the first read that found a transaction unknown everywhere past its validity period. */
  const pastAt = new Map<string, bigint>();
  /** One read: the finals first, then the transaction on both providers and the archival one. */
  const readOnce = async (tx: TxRef): Promise<TxOutcome> => {
    const finals = await Promise.all(rpcs.map(finalOf));
    const reads = await Promise.all([...rpcs, archival].map((r) => readTx(r, tx)));
    const f = reads.find((x) => x?.final);
    if (f?.final) {
      pastAt.delete(tx.tx_hash);
      return { kind: "final", tx_hash: tx.tx_hash, receipts: f.final };
    }
    const known = finals.filter((x): x is bigint => x !== null);
    const newest = known.length === 0 ? null : known.reduce((a, b) => (a > b ? a : b));
    const past = newest !== null && newest > BigInt(tx.height) + validity;
    if (!past || !reads.every((x) => x !== null && x.unknownTx)) return { kind: "unknown", tx_hash: tx.tx_hash, why: "not final on any provider" };
    const first = pastAt.get(tx.tx_hash);
    if (first === undefined || newest <= first) {
      if (first === undefined) remember(pastAt, tx.tx_hash, newest);
      return { kind: "unknown", tx_hash: tx.tx_hash, why: "past its validity period once; read again a block later" };
    }
    pastAt.delete(tx.tx_hash);
    return { kind: "dropped", tx_hash: tx.tx_hash, why: "unknown on every provider past its validity period" };
  };
  const wait = async (tx: TxRef): Promise<TxOutcome> => {
    const until = Date.now() + waitMs;
    for (;;) {
      const out = await readOnce(tx);
      if (out.kind !== "unknown" || Date.now() >= until) return out;
      await sleep(POLL_MS);
    }
  };

  return {
    account,
    async balance() {
      const a = (await rpcs[0]("query", { request_type: "view_account", finality: "final", account_id: account })) as { amount?: unknown };
      return u128(a.amount, "relayer amount");
    },
    async send(action, guard, before) {
      const turn = queue.then(async (): Promise<{ guarded: BindCode } | { tx: TxRef }> => {
        const code = await guard();
        if (code !== null) return { guarded: code };
        const ak = (await rpcs[0]("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey })) as { nonce?: unknown; block_hash?: unknown; block_height?: unknown };
        const keyNonce = u64(ak.nonce, "relayer nonce");
        const b0 = u64(ak.block_height, "view_access_key block_height");
        if (typeof ak.block_hash !== "string") throw new Error("view_access_key: no block_hash");
        const nonce = (keyNonce > last ? keyNonce : last) + 1n;
        last = nonce;
        const receiver = action.kind === "storage_prepay" ? vault : action.receiver;
        const body = encodeTransaction({ signer: account, publicKey: pub, nonce, receiver, blockHash: base58decode(ak.block_hash), action: encodeAction(action) });
        const hash = createHash("sha256").update(body).digest();
        const tx: TxRef = { tx_hash: base58(hash), nonce: nonce.toString(), height: b0.toString(), signed_tx: Buffer.concat([body, Buffer.from([0]), edSign(null, hash, priv)]).toString("base64") };
        before(tx);
        await broadcast(tx.signed_tx);
        return { tx };
      });
      queue = turn.catch(() => undefined);
      const t = await turn;
      if ("guarded" in t) return { kind: "guarded", code: t.guarded };
      return wait(t.tx);
    },
    async resolve(tx, opts) {
      if (opts.resend) await broadcast(tx.signed_tx);
      return readOnce(tx);
    },
  };
}
