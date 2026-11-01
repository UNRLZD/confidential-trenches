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
//      again and it is read on both providers. It is "dropped" (never landed, never will) only on an Expired refusal
//      or once the relayer's key nonce has passed its nonce on both providers with its hash unknown on both; until it
//      is known the call answers in_flight and nothing new goes out on (U, P).
//   7. (h) the prepay: 904 B whenever a tree may grow or a send on P already went (R5's top-up), else 756 B; never above
//      904 B on P (the bytes of a prepay in flight count). Then the send, only after the prepay read SuccessValue at
//      FINAL. R4's margin K and (f) are checked inside the relayer's queue, right before each transaction is signed
//      and written, so a call never waits in the queue past its margin.
//   8. (i) the count is written before the send (R7). A send counts as failed only once the deposits pages, read at a
//      height both providers' finals have passed beyond its last receipt, do not hold P for U; short of that it stays
//      pending. It is not counted when the pages hold P for U, when USDC's own receipt failed with its paused error
//      and the watch, caught up to that height, shows the pause there (R3's one exception), or when it was dropped.
//      At three failures U is struck: sender_struck from then on, no top-up.
//
// The gas account holds NEAR for gas and prepays only (markets.md MN:314 (6)); its key signs the relayer's own
// transactions, whose only actions are storage_prepay on the vault and a Delegate carrying U's signed bytes as they
// came. The store is one directory of small JSON files, each written by write, fsync, rename (or link, for a
// create-if-absent) and fsync of the directory, owned by one process through a lockfile holding its PID.
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
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
 *   plus a (U, P)'s worst spend, row 7's case: 0.00904 + 3 x 0.0003 + 2 x 0.0101563 = 0.0302526 N (V:730-732);
 *   = 0.3302526 N. Below it the relayer answers 503 relayer_low.
 */
export const RELAYER_FLOOR_YOCTO = 300_000_000_000_000n * 1_000_000_000n + 30_252_600_000_000_000_000_000n;
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

/** One of the relayer's own transactions: its hash, its key nonce and its signed bytes (base64), kept to resend. */
export type TxRef = { tx_hash: string; nonce: string; signed_tx: string };
export type Receipt = { executor: string; ok: boolean; failure: string; height: bigint };

/** One relayer transaction's outcome. */
export type TxOutcome =
  | { kind: "final"; tx_hash: string; receipts: Receipt[] }
  /** It never landed and never can (Expired, or the key nonce passed it with its hash unknown on both providers). */
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
  /** A transaction of ours whose outcome was not read: its bytes sent again, then read on both providers. */
  resolve(tx: TxRef): Promise<TxOutcome>;
};

export type SendDeps = {
  cfg: BindConfig;
  reads: SendReads;
  store: DepositStore;
  relayer: Relayer;
  /** The token watch (status.ts); anything but a caught-up open token holds. */
  tokenStatus(): Promise<TokenStatus>;
  /** Inserts seen in flight besides this one (R5: other deposits, withdrawals' change leaves and refund notes). */
  insertsInFlight?(): Promise<bigint>;
};

// ---- R7's record ----

export type SendState = "pending" | "failed" | "landed" | "exempt" | "dropped";
export type PrepayEntry = TxRef & { bytes: number; ok: boolean | null };
export type SendEntry = TxRef & { sha256: string; amount: string; state: SendState; counted: boolean };

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

/** A process holds a lockfile when it is alive: signal 0 reaches it (ESRCH: no such process). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A store of small JSON files in `dir`, owned by one process: a lockfile `lock` holding its PID, created exclusively;
 * a lock whose process is gone is taken over, a live one refused. Every write is whole and durable: a replace is write,
 * fsync, rename, fsync of the directory; a create-if-absent is write and fsync of a temp file, link to the name
 * (EEXIST: it is there), unlink of the temp, fsync of the directory, so no name ever holds a partial file.
 */
export function createFileStore(dir: string): DepositStore {
  mkdirSync(dir, { recursive: true });
  const path = (name: string) => join(dir, name);
  const syncDir = () => {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  let tmpN = 0;
  const writeTemp = (v: string): string => {
    const tmp = path(`.tmp-${process.pid}-${tmpN++}`);
    const fd = openSync(tmp, "wx");
    try {
      writeSync(fd, v);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return tmp;
  };
  /** Create-if-absent: false when the name is there. */
  const createOnce = (name: string, v: string): boolean => {
    const tmp = writeTemp(v);
    try {
      linkSync(tmp, path(name));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      unlinkSync(tmp);
      syncDir();
    }
  };
  const replace = (name: string, v: string) => {
    renameSync(writeTemp(v), path(name));
    syncDir();
  };
  const read = <T>(name: string): T | null => {
    let text: string;
    try {
      text = readFileSync(path(name), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    return JSON.parse(text) as T;
  };

  // the lock: one process per store
  const lock = path("lock");
  for (;;) {
    if (createOnce("lock", String(process.pid))) break;
    const pid = Number(readFileSync(lock, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) throw new Error(`store: ${dir} is held by process ${pid}`);
    unlinkSync(lock); // its process is gone
  }
  let open = true;
  const release = () => {
    if (!open) return;
    open = false;
    process.removeListener("exit", release);
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
    } catch {
      // gone already
    }
  };
  process.once("exit", release);
  const held = () => {
    if (!open) throw new Error("store: closed");
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
  const paused = out.receipts.find((r) => !r.ok && r.executor === deps.cfg.token && r.failure.includes(USDC_PAUSED));
  if (paused !== undefined) {
    // R3's exception: USDC's own receipt failed with its paused error, and the watch, caught up to that height,
    // shows the pause there (paused now, or unpaused only after it).
    const s = await deps.tokenStatus();
    if (s.caught_up !== true || BigInt(s.block_height) < paused.height) return "pending";
    const unpausedAfter = s.last_event?.name === "unpaused" && BigInt(s.last_event.block_height) > paused.height;
    if (s.halted === true || unpausedAfter) return "exempt";
  }
  return "failed";
}

/** Settles every earlier transaction of (U, P) whose outcome is not known; the record as it then stands. */
async function settle(deps: SendDeps, rec: DepositRecord, u: string, p: bigint): Promise<DepositRecord> {
  for (const pre of rec.prepays.filter((x) => x.ok === null)) {
    const out = await deps.relayer.resolve(pre);
    if (out.kind === "unknown") continue;
    if (out.kind === "dropped") rec = { ...rec, prepaid_bytes: rec.prepaid_bytes - pre.bytes, prepays: rec.prepays.filter((x) => x.tx_hash !== pre.tx_hash) };
    else rec = await prepayDone(deps, rec, pre, out, p);
    deps.store.put(rec);
  }
  for (const s of rec.sends.filter((x) => x.state === "pending")) {
    const out = await deps.relayer.resolve(s);
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
  if (topUp > 0n) {
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
      return no("resign_needed"); // nothing happened: the device signs again
    }
    rec = await prepayDone(deps, rec, entry!, out, p);
    store.put(rec);
    if (rec.prepays.find((x) => x.tx_hash === out.tx_hash)!.ok !== true) {
      if (rec.struck) return no("sender_struck");
      return no(rec.p_closed ? "p_used" : "resign_needed");
    }
  }

  // 8. (i) the send: R4 and (f) in the queue, the count written before it goes. R3's three were read after the settle
  // (step 6); a prepay since then either succeeded or returned above, so the record's failures have not moved.
  let entry: SendEntry | null = null;
  const out = await relayer.send({ kind: "delegate", signed: d.signed_delegate, receiver: u }, guardFor(deps, d.max_block_height), (tx) => {
    entry = { ...tx, sha256: sha, amount: d.amount.toString(), state: "pending", counted: true };
    rec = tally({ ...rec, sends: [...rec.sends, entry] });
    store.put(rec);
  });
  if (out.kind === "guarded") return no(out.code);
  if (out.kind === "unknown") return sent(out.tx_hash); // pending: the device reads it, and the next call settles it
  const state: SendState = out.kind === "dropped" ? "dropped" : await sendState(deps, u, p, d.amount, out);
  rec = tally({ ...rec, landed: rec.landed || state === "landed", sends: rec.sends.map((x) => (x.tx_hash === out.tx_hash ? { ...x, state } : x)) });
  store.put(rec);
  if (state === "dropped") return no("resign_needed");
  return sent(out.tx_hash);
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
  const both = async <T>(read: (r: Rpc, h: bigint) => Promise<T>): Promise<T> => {
    const h = await finalHeight();
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
  const catchUp = async () => {
    for (;;) {
      const from = next;
      const page = await both(async (r, h) => view(r, h, cfg.vault, "deposits", { from, limit: PAGE }));
      if (!Array.isArray(page) || page.length > PAGE) throw new Error("deposits: not a page");
      for (const x of page) {
        if (!isObj(x) || typeof x.precommitment !== "string" || typeof x.depositor !== "string") throw new Error("deposits: not a deposit");
        pages.set(x.precommitment, { depositor: x.depositor, value: u128(x.value, "deposits.value") });
      }
      next = from + page.length;
      if (page.length < PAGE) return;
    }
  };
  const deposit = async (precommitment: bigint) => {
    const run = indexing.then(catchUp);
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
      while ((await finalHeight()) < height) {
        if (Date.now() >= until) return { state: "unknown" };
        await sleep(POLL_MS);
      }
      const row = await deposit(precommitment); // read at the lower final, now at or past `height`
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

const causeInfo = (e: unknown): string => (e instanceof RpcError ? JSON.stringify((e.data as { cause?: unknown } | null)?.cause ?? e.data) : "");

/**
 * The gas account: one key. Its queue holds only the guard, the signing, the durable write and the broadcast to both
 * providers, never the wait for FINAL; the nonce comes from a local next-nonce, set from the key's nonce on both
 * providers when unknown and read again after a nonce refusal, so two transactions never share one.
 */
export function createRelayer(rpcs: readonly [Rpc, Rpc], account: string, secretKey: string, vault: string, waitMs = OUTCOME_WAIT_MS): Relayer {
  const { priv, pub } = relayerKey(secretKey);
  const publicKey = `ed25519:${base58(pub)}`;
  let queue: Promise<unknown> = Promise.resolve();
  let next = 0n; // the next nonce to use; 0 until the key is read
  let reread = true;

  const keyNonce = async (r: Rpc): Promise<bigint> => u64(((await r("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey })) as { nonce?: unknown }).nonce, "relayer nonce");
  const broadcast = async (signed: string): Promise<string[]> => {
    const answers = await Promise.allSettled(rpcs.map((r) => r("broadcast_tx_async", [signed])));
    return answers.map((a) => (a.status === "rejected" ? causeInfo(a.reason) : ""));
  };
  const heights = new Map<string, bigint>();
  const heightOf = async (r: Rpc, hash: unknown): Promise<bigint> => {
    if (typeof hash !== "string") throw new Error("receipt: no block_hash");
    if (!heights.has(hash)) heights.set(hash, u64(((await r("block", { block_id: hash })) as { header?: { height?: unknown } }).header?.height, "block.height"));
    return heights.get(hash)!;
  };
  /** One read on both providers: final on either, dropped when both name it unknown past the key nonce or expired. */
  const readOnce = async (tx: TxRef, expired: boolean): Promise<TxOutcome> => {
    const per = await Promise.all(
      rpcs.map(async (r) => {
        try {
          const nonce = await keyNonce(r); // read before the tx, so a tx this nonce counts is visible to the read after it
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
              return { final: receipts, nonce, unknownTx: false };
            }
            return { final: null, nonce, unknownTx: false };
          } catch (e) {
            if (e instanceof RpcError && e.cause_name === "UNKNOWN_TRANSACTION") return { final: null, nonce, unknownTx: true };
            return null;
          }
        } catch {
          return null;
        }
      }),
    );
    const f = per.find((x) => x?.final);
    if (f?.final) return { kind: "final", tx_hash: tx.tx_hash, receipts: f.final };
    const unknownBoth = per.every((x) => x !== null && x.unknownTx);
    if (unknownBoth && (expired || per.every((x) => x!.nonce >= BigInt(tx.nonce)))) return { kind: "dropped", tx_hash: tx.tx_hash, why: expired ? "Expired" : "the key nonce passed it" };
    return { kind: "unknown", tx_hash: tx.tx_hash, why: "not final on either provider" };
  };
  const wait = async (tx: TxRef, expired: boolean): Promise<TxOutcome> => {
    const until = Date.now() + waitMs;
    for (;;) {
      const out = await readOnce(tx, expired);
      if (out.kind !== "unknown" || Date.now() >= until) return out;
      await sleep(POLL_MS);
    }
  };
  const isExpired = (causes: string[]) => causes.some((c) => c.includes("Expired"));

  return {
    account,
    async balance() {
      const a = (await rpcs[0]("query", { request_type: "view_account", finality: "final", account_id: account })) as { amount?: unknown };
      return u128(a.amount, "relayer amount");
    },
    async send(action, guard, before) {
      const turn = queue.then(async (): Promise<{ guarded: BindCode } | { tx: TxRef; causes: string[] }> => {
        const code = await guard();
        if (code !== null) return { guarded: code };
        if (reread) {
          // never below a nonce already handed out: transactions of ours in flight may not show in the key yet
          const ns = await Promise.all(rpcs.map(keyNonce));
          const chain = (ns[0]! > ns[1]! ? ns[0]! : ns[1]!) + 1n;
          if (chain > next) next = chain;
          reread = false;
        }
        const nonce = next;
        next = nonce + 1n;
        const block = (await rpcs[0]("block", { finality: "final" })) as { header?: { hash?: unknown } };
        if (typeof block.header?.hash !== "string") throw new Error("block: no hash");
        const receiver = action.kind === "storage_prepay" ? vault : action.receiver;
        const body = encodeTransaction({ signer: account, publicKey: pub, nonce, receiver, blockHash: base58decode(block.header.hash), action: encodeAction(action) });
        const hash = createHash("sha256").update(body).digest();
        const tx: TxRef = { tx_hash: base58(hash), nonce: nonce.toString(), signed_tx: Buffer.concat([body, Buffer.from([0]), edSign(null, hash, priv)]).toString("base64") };
        before(tx);
        const causes = await broadcast(tx.signed_tx);
        if (causes.some((c) => c.includes("InvalidNonce"))) reread = true; // read the key again for the next one
        return { tx, causes };
      });
      queue = turn.catch(() => undefined);
      const t = await turn;
      if ("guarded" in t) return { kind: "guarded", code: t.guarded };
      return wait(t.tx, isExpired(t.causes));
    },
    async resolve(tx) {
      const causes = await broadcast(tx.signed_tx);
      return readOnce(tx, isExpired(causes));
    },
  };
}
