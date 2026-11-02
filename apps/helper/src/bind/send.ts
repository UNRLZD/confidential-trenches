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
//      token is held, as (f) holds) and it is read by block_id at F, the lower final, on both providers. It is
//      "dropped" (never landed, never will) only by (a2), the relayer key's nonce passed it at a block D whose changes
//      do not name it, or by (b), the key's nonce still below its own at F past its validity period (markets.md
//      l.1215-1232, l.1298-1300; createRelayer); until it is known the call answers in_flight and nothing new goes out
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
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import * as nodeFs from "node:fs";
import { HELPER_CODE_STATUS } from "@blindfill/kit";
import { base58, checkBindDeposit, decodeSignedDelegate, type BindCode, type BindConfig, type BindLedger, type BindReads, type KeyRead } from "./checks.ts";
import { tokenHeld, type TokenStatus } from "../token-status/status.ts";
import { openDurableDir, type DurableDir, type StoreFs } from "../store/durable.ts";
import { pagesAt, type Rpc } from "../near/pages.ts";

export type { Rpc, StoreFs };

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
 * One of the relayer's own transactions: its hash, its key nonce, the height b0 and hash of the block it was signed on
 * (its validity runs from there) and its signed bytes (base64), kept to resend.
 */
export type TxRef = { tx_hash: string; nonce: string; height: string; block_hash: string; signed_tx: string };
/** A receipt's outcome; `ms` is its block's time (header.timestamp_nanosec / 10^6) when it was read from blocks. */
export type Receipt = { executor: string; ok: boolean; failure: string; height: bigint; ms?: bigint };

/** One relayer transaction's outcome. */
export type TxOutcome =
  | { kind: "final"; tx_hash: string; receipts: Receipt[] }
  /** It never landed and never can: (a2) K's nonce passed it at a block D whose changes do not name it, or (b) K's nonce is below its own at F past b0 + the validity period. */
  | { kind: "dropped"; tx_hash: string; why: string }
  /** Not known yet: it may still land. */
  | { kind: "unknown"; tx_hash: string; why: string };

export type RelayerAction =
  | { kind: "storage_prepay"; precommitment: bigint; bytes: bigint }
  | { kind: "delegate"; signed: Uint8Array; receiver: string }
  /** One FunctionCall on `receiver` (the withdrawal relayer's withdraw and settle): `args` the JSON bytes as sent. */
  | { kind: "call"; receiver: string; method: string; args: string; gas: bigint; deposit: bigint };

/** How a send or a resolve reads: `wait` false answers once the bytes are sent; `fromBlocks` reads a call's receipt on the vault from blocks only. */
export type ReadOpts = { wait?: boolean; fromBlocks?: boolean };

export type Relayer = {
  account: string;
  /** The key's nonce counter id, `<account>/<public key>`, as send records name it. */
  key: string;
  /** The gas account's NEAR, at final. */
  balance(): Promise<bigint>;
  /**
   * In the relayer's queue: `guard` runs first (R4 and (f)); a code from it ends the call with nothing signed or
   * written. Else one transaction of one action is signed, `before` writes it durably, it goes to both providers, the
   * queue moves on, and its outcome is awaited.
   */
  send<C extends string = BindCode>(action: RelayerAction, guard: () => Promise<C | null>, before: (tx: TxRef) => void, opts?: ReadOpts): Promise<TxOutcome | { kind: "guarded"; code: C }>;
  /**
   * A transaction of ours whose outcome was not read: its bytes sent again (unless `resend` is false), then read on
   * both providers and the archival one.
   */
  resolve(tx: TxRef, opts: { resend: boolean; fromBlocks?: boolean }): Promise<TxOutcome>;
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
  /** The relayer key's next-nonce counter (markets.md, the send record); null before the key's first signing. */
  nonceNext(key: string): bigint | null;
  /**
   * The counter set to `next` by a compare-and-set on `expected`, the value read, durable before it returns; false,
   * with nothing written, when it no longer holds `expected`.
   */
  nonceCas(key: string, expected: bigint | null, next: bigint): boolean;
  /** D, the block that spent one of the relayer's transactions' nonce, once found: final, so found once. */
  foundAt(tx_hash: string): { height: string; hash: string } | null;
  setFoundAt(tx_hash: string, d: { height: string; hash: string }): void;
  /** The U's whose record has a prepay or a send whose outcome is not known yet (the background round's work). */
  open(): string[];
  /** Gives the store's lock up (a test's restart; the process's exit does it too). */
  close(): void;
};

/**
 * The deposit relayer's store: one directory of small JSON files owned by one process, every write whole and durable
 * (store/durable.ts holds the lock and the write rule, shared with the withdrawal send records).
 */
export function createFileStore(dir: string, fs: StoreFs = nodeFs): DepositStore {
  return openDurableDir(dir, fs, (d) => fileStoreOn(d));
}

function fileStoreOn(d: DurableDir): DepositStore {
  const { held } = d;
  const read = <T>(name: string): T | null => {
    const text = d.text(name);
    return text === null ? null : (JSON.parse(text) as T);
  };

  // the U's with an open record: read once as the lock is taken, then kept by create and put (one process holds the store)
  const openUs = new Set<string>();
  const track = (rec: DepositRecord) => {
    if (isOpen(rec)) openUs.add(rec.u);
    else openUs.delete(rec.u);
  };
  for (const f of d.names()) {
    const m = /^u-([0-9a-f]{64})\.json$/.exec(f);
    if (m === null) continue;
    let rec: DepositRecord | null = null;
    try {
      rec = JSON.parse(d.text(f) ?? "") as DepositRecord;
      if (rec.u !== m[1]) rec = null;
      else track(rec);
    } catch {
      rec = null;
    }
    // unreadable: counted open, so each round tries it and its own catch keeps it
    if (rec === null) openUs.add(m[1]!);
  }
  const uName = (u: string) => {
    if (!/^[0-9a-f]{64}$/.test(u)) throw new Error("store: U is not a 64-hex id");
    return `u-${u}.json`;
  };
  const kName = (key: string) => `k-${createHash("sha256").update(key).digest("hex")}.json`;
  const dName = (tx: string) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tx)) throw new Error("store: not a transaction hash");
    return `d-${tx}.json`;
  };
  const forget = (tx: string) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tx)) return; // never a D's name: setFoundAt refuses it
    d.remove(dName(tx));
  };
  const counter = (key: string): bigint | null => {
    const c = read<{ next: string }>(kName(key));
    return c === null ? null : BigInt(c.next);
  };
  return {
    get: (u) => read<DepositRecord>(uName(u)),
    create(rec) {
      held();
      if (d.createOnce(uName(rec.u), JSON.stringify(rec))) {
        track(rec);
        return { created: true, rec };
      }
      return { created: false, rec: read<DepositRecord>(uName(rec.u))! };
    },
    put(rec) {
      held();
      let before: DepositRecord | null = null;
      try {
        before = read<DepositRecord>(uName(rec.u));
      } catch {
        // an unreadable record is still replaced; its entries' D, if any, stay
      }
      d.replace(uName(rec.u), JSON.stringify(rec));
      track(rec);
      // a D is read only while its entry is open (the relayer's judge): once the entry has a verdict or has left the
      // record, its file goes
      const still = new Set([...rec.prepays.filter((x) => x.ok === null), ...rec.sends.filter((x) => x.state === "pending")].map((x) => x.tx_hash));
      for (const x of [...(before?.prepays ?? []), ...(before?.sends ?? []), ...rec.prepays, ...rec.sends]) if (!still.has(x.tx_hash)) forget(x.tx_hash);
    },
    bind(p, u) {
      held();
      if (d.createOnce(`p-${p}.json`, JSON.stringify({ u }))) return u;
      return read<{ u: string }>(`p-${p}.json`)!.u;
    },
    boundTo: (p) => read<{ u: string }>(`p-${p}.json`)?.u ?? null,
    nonceNext: counter,
    nonceCas(key, expected, next) {
      held();
      // one process holds the store and this runs with no await, so the read and the write are one step
      if (counter(key) !== expected) return false;
      const v = JSON.stringify({ next: next.toString() });
      if (expected === null) return d.createOnce(kName(key), v);
      d.replace(kName(key), v);
      return true;
    },
    foundAt: (tx) => read<{ height: string; hash: string }>(dName(tx)),
    setFoundAt(tx, at) {
      held();
      d.createOnce(dName(tx), JSON.stringify({ height: at.height, hash: at.hash }));
    },
    open: () => [...openUs],
    close: d.close,
  };
}

/** A record with a prepay or a send whose outcome is not known yet. */
const isOpen = (rec: DepositRecord) => rec.prepays.some((x) => x.ok === null) || rec.sends.some((x) => x.state === "pending");

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

/** markets.md l.1192-1193: the relayer reads every open record every 10 s on its own, not only when U calls again. */
export const LOCK_ROUND_MS = 10_000;

/**
 * One background round: every open record settled as step 6 settles it (re-sent under R4 and (f), read, its verdict
 * written), each under its U's in-flight slot; a U being carried right now is left to that call. An error on one
 * record keeps it for the next round.
 */
export async function lockRound(deps: SendDeps): Promise<void> {
  for (const u of deps.store.open()) {
    if (inFlight.has(u)) continue;
    try {
      const rec = deps.store.get(u);
      if (rec === null) continue;
      const p = BigInt(rec.p);
      inFlight.set(u, p);
      try {
        await settle(deps, rec, u, p);
      } finally {
        inFlight.delete(u);
      }
    } catch {
      // kept: read again next round; the records after it are still read in this one
    }
  }
}

/** Starts the background rounds: one at once (a restart reads and rebroadcasts first), then one every `everyMs`; the stop function ends them. */
export function startLockRounds(deps: SendDeps, everyMs = LOCK_ROUND_MS): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      await lockRound(deps);
    } finally {
      if (!stopped) timer = setTimeout(tick, everyMs);
    }
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
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
 * One view_access_key answer. nearcore answers an absent key (or account) with a result holding `error`, "access key
 * … does not exist while viewing", not with an RPC error (read live on mainnet on FastNEAR's regular and archival
 * RPCs, 2026-11-02); older nodes answer UNKNOWN_ACCESS_KEY or UNKNOWN_ACCOUNT. Any other
 * error is thrown.
 */
async function readKey(r: Rpc, params: Record<string, unknown>): Promise<KeyRead & { block?: { height: bigint; hash: string } }> {
  let k: unknown;
  try {
    k = await r("query", { request_type: "view_access_key", ...params });
  } catch (e) {
    if (e instanceof RpcError && e.cause_name === "UNKNOWN_ACCOUNT") return { kind: "no_account" };
    if (e instanceof RpcError && e.cause_name === "UNKNOWN_ACCESS_KEY") return { kind: "no_key" };
    throw e;
  }
  if (!isObj(k)) throw new Error("view_access_key: not an object");
  const block = typeof k.block_hash === "string" && k.block_height !== undefined ? { height: u64(k.block_height, "view_access_key block_height"), hash: k.block_hash } : undefined;
  if (k.error !== undefined) {
    if (typeof k.error === "string" && /^access key .{1,200} does not exist while viewing$/.test(k.error)) return { kind: "no_key", ...(block && { block }) };
    throw new Error(`view_access_key: ${String(k.error).slice(0, 200)}`);
  }
  return { kind: "key", permission: k.permission, nonce: u64(k.nonce, "nonce"), ...(block && { block }) };
}

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
      // the shared page rule (near/pages.ts): both providers at the block asked, one block hash, the same bytes, each row at its index
      const page = await pagesAt(rpcs, cfg.vault, "deposits", at ?? (await finalHeight()), from, PAGE);
      for (const x of page) {
        if (typeof x.precommitment !== "string" || typeof x.depositor !== "string") throw new Error("deposits: not a deposit");
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
        const { block: _block, ...k } = await readKey(r, { block_id: Number(h), account_id: account, public_key: publicKey });
        return k;
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
  if (a.kind === "call") {
    if (a.gas <= 0n || a.gas > 300_000_000_000_000n) throw new Error("call: gas outside 1..300 Tgas");
    if (a.deposit < 0n || a.deposit >= 1n << 128n) throw new Error("call: deposit not a u128");
    return Buffer.concat([Buffer.from([2]), bstr(a.method), bstr(a.args), le(a.gas, 8), le(a.deposit, 16)]);
  }
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

/** At most this many entries in the relayer's cache of receipt block heights. */
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

/** The relayer's part of the store: its key's next-nonce counter and the blocks D it found. */
export type RelayerStore = Pick<DepositStore, "nonceNext" | "nonceCas" | "foundAt" | "setFoundAt">;

/** nearcore refuses a nonce at or above (the height of the block that added the key) x 10^6 (F58). */
const NONCE_RANGE = 1_000_000n;
/** Heights the search for D walks past a height with no block to find the next one (a skip is a few heights). */
const SKIP_MAX = 64n;
/** Steps of the search for D in one round (a binary search over 86,400 blocks takes 17). */
const SEARCH_MAX = 200;
/** Changes to one key in one block that a change list may hold. */
const CHANGES_MAX = 1_000;
/** Heights after D one round reads for a receipt's block E (the rest go on next round, from where this one stopped). */
const RECEIPT_SCAN_MAX = 200n;

/**
 * The id nearcore gives a transaction's receipt: sha256 of the hash's 32 bytes, the height of the block that applied
 * it as a u64 little-endian, and 0 as a u64 little-endian (F64; nearcore create_receipt_id_from_transaction). Live:
 * 6jvSQwan375v77pzg53GGnbGGKjQEoq7THEmjnSGCwzV at 221,384,610 gives A2mdwHyTn7Thxtk4AF8MbN2ahqftwh5xVWrozdLseoAo.
 */
export function receiptIdOf(txHash: string, height: bigint): string {
  const h = base58decode(txHash);
  if (h.length !== 32) throw new Error("receipt id: not a 32-byte hash");
  return base58(createHash("sha256").update(Buffer.concat([Buffer.from(h), le(height, 8), le(0n, 8)])).digest());
}

/** The receiver of a transaction the relayer signed (borsh Transaction V0: signer, key, nonce, receiver). */
function receiverOf(signedTx: string): string {
  const b = Buffer.from(signedTx, "base64");
  const sl = b.readUInt32LE(0);
  const at = 4 + sl + 33 + 8;
  const rl = b.readUInt32LE(at);
  return b.subarray(at + 4, at + 4 + rl).toString("utf8");
}

/** The relayer as it starts: the validity period read from both providers first, then the gas account. */
export async function startRelayer(rpcs: readonly [Rpc, Rpc], archival: Rpc, account: string, secretKey: string, vault: string, store: RelayerStore, waitMs = OUTCOME_WAIT_MS): Promise<Relayer> {
  return createRelayer(rpcs, archival, account, secretKey, vault, await transactionValidityPeriod(rpcs), store, waitMs);
}

/**
 * The gas account: one plain full-access key K. Its queue holds only the guard, the signing, the durable writes and the
 * send to both providers, never the wait for FINAL.
 *
 * Signing (markets.md, the send record and "Whether the Transfer was applied"): b0, its hash and K's nonce come from
 * one view_access_key answer at final; n = max(that nonce + 1, the key's counter in the store), and the counter is set
 * to n + 1 by a compare-and-set on the value read, durable before the transaction is written or sent, so a restart or
 * a second signer on the key never signs n again (the one that loses takes the next n; nothing of the lost n was
 * signed). n at or above b0 x 10^6 is refused (F58). Transactions go by send_tx with wait_until NONE, which validates
 * nothing before it answers (nearcore send_tx_async, chain/jsonrpc lib.rs l.1191-1206), so only the chain says what
 * happened.
 *
 * Reading one (each round): F is the lower of the two providers' finals, read by block_id on both with the same hash,
 * and b0 is read on both with the hash it was signed on; an error, a missing answer or a disagreement anywhere keeps
 * the round. P(x): at block x, view_access_key shows K full-access with a nonce below n, the same on both.
 *   - P at F: not applied through F. Dropped by (b) once F > b0 + transaction_validity_period, read live.
 *   - P fails at F: D is the block in (b0, F] where P fails with P holding at the block before, found by a binary
 *     search by block_id (UNKNOWN_BLOCK counts as a skipped height only when the next block's prev_height shows the
 *     gap), its hash the same on both; final, so found once and kept in the store. EXPERIMENTAL_changes for K at D on
 *     both: a change caused by this transaction means it was applied at D, and its outcome is read from a lookup that
 *     names D (a lookup naming any other block: a prepay's receipt is read from blocks, F56 and T1b; a delegate's
 *     keeps); a list that does not name it means K can never verify these
 *     bytes, (a2), dropped; an empty list keeps (a node that does not save state changes, F54).
 * Nothing else drops one: not UNKNOWN_TRANSACTION, not a failed outcome on its own, not a timer.
 */
export function createRelayer(rpcs: readonly [Rpc, Rpc], archival: Rpc, account: string, secretKey: string, vault: string, validity: bigint, store: RelayerStore, waitMs = OUTCOME_WAIT_MS): Relayer {
  const { priv, pub } = relayerKey(secretKey);
  const publicKey = `ed25519:${base58(pub)}`;
  const counterKey = `${account}/${publicKey}`;
  let queue: Promise<unknown> = Promise.resolve();

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

  // ms: header.timestamp_nanosec (a decimal string) / 10^6, never header.timestamp (a JSON number past 2^53); null when absent
  type Block = { height: bigint; hash: string; prev: bigint; ms: bigint | null };
  const header = (a: unknown): Block => {
    const h = isObj(a) && isObj(a.header) ? a.header : {};
    if (typeof h.hash !== "string") throw new Error("block: no hash");
    const ns = h.timestamp_nanosec;
    if (ns !== undefined && (typeof ns !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(ns))) throw new Error("block: timestamp_nanosec not a decimal");
    return { height: u64(h.height, "block.height"), hash: h.hash, prev: u64(h.prev_height, "block.prev_height"), ms: ns === undefined ? null : BigInt(ns) / 1_000_000n };
  };
  const unknownBlock = (e: unknown) => e instanceof RpcError && e.cause_name === "UNKNOWN_BLOCK";
  /** The block at height h on both providers, its hash and prev_height the same on both; null when neither has one. */
  const blockAt = async (h: bigint): Promise<Block | null> => {
    const [a, b] = await Promise.all(
      rpcs.map(async (r) => {
        try {
          const x = header(await r("block", { block_id: Number(h) }));
          if (x.height !== h) throw new Error(`block ${h}: answered ${x.height}`);
          return x;
        } catch (e) {
          if (unknownBlock(e)) return null;
          throw e;
        }
      }),
    );
    if (a === null && b === null) return null;
    if (a === null || b === null || a!.hash !== b!.hash || a!.prev !== b!.prev || a!.ms !== b!.ms) throw new Error(`the providers disagree on block ${h}`);
    return a!;
  };
  const mustBlock = async (h: bigint): Promise<Block> => {
    const b = await blockAt(h);
    if (b === null) throw new Error(`no block at ${h}`);
    return b;
  };
  /** P at height h, the same on both; null when neither has a block there. */
  const pAt = async (h: bigint, n: bigint): Promise<boolean | null> => {
    const [a, b] = await Promise.all(
      rpcs.map(async (r) => {
        try {
          return await readKey(r, { block_id: Number(h), account_id: account, public_key: publicKey });
        } catch (e) {
          if (unknownBlock(e)) return null;
          throw e;
        }
      }),
    );
    if (a === null && b === null) return null;
    if (a === null || b === null || big(a) !== big(b)) throw new Error(`the providers disagree on K at ${h}`);
    if (a!.block !== undefined && a!.block.height !== h) throw new Error(`view_access_key at ${h}: answered ${a!.block.height}`);
    return a!.kind === "key" && a!.permission === "FullAccess" && a!.nonce < n;
  };
  /** D: the block in (b0, F] where P fails, with P holding at the block before it. */
  const findD = async (b0: bigint, f: bigint, n: bigint): Promise<Block> => {
    let lo = b0; // P holds at lo, and fails at hi; both are blocks
    let hi = f;
    for (let step = 0; hi - lo > 1n; step++) {
      if (step >= SEARCH_MAX) throw new Error("the search for D did not end");
      const mid = (lo + hi) / 2n;
      const p = await pAt(mid, n);
      if (p !== null) {
        if (p) lo = mid;
        else hi = mid;
        continue;
      }
      // no block at mid on either: a skipped height only when the next block's prev_height shows the gap
      let next: Block | null = null;
      for (let h = mid + 1n; h <= hi && next === null; h++) {
        if (h - mid > SKIP_MAX) throw new Error(`no block for ${SKIP_MAX} heights past ${mid}`);
        next = await blockAt(h);
      }
      if (next === null || next.prev >= mid || next.prev < lo) throw new Error(`UNKNOWN_BLOCK at ${mid}, and the next block does not show a gap there`);
      // the heights between next.prev and next have no block
      const at = next.prev > lo ? next.prev : next.height;
      if (at === hi) break; // the block after lo is hi
      const q = await pAt(at, n);
      if (q === null) throw new Error(`UNKNOWN_BLOCK at ${at}, a block`);
      if (q) lo = at;
      else hi = at;
      if (!q && at === next.height) break; // the block before it is lo
    }
    const d = await mustBlock(hi);
    if (d.prev !== lo) throw new Error(`D (${hi}): the block before it is ${d.prev}, not ${lo}`);
    return d;
  };
  /** The changes to K at D on one provider: one caused by this transaction, others only, or none. */
  const changesAt = async (r: Rpc, d: Block, txHash: string): Promise<"ours" | "other" | "empty"> => {
    const a = await r("EXPERIMENTAL_changes", { changes_type: "single_access_key_changes", keys: [{ account_id: account, public_key: publicKey }], block_id: Number(d.height) });
    if (!isObj(a) || a.block_hash !== d.hash || !Array.isArray(a.changes) || a.changes.length > CHANGES_MAX) throw new Error("EXPERIMENTAL_changes: not D's list");
    let ours = false;
    for (const c of a.changes) {
      if (!isObj(c) || !isObj(c.cause) || !isObj(c.change) || c.change.account_id !== account || c.change.public_key !== publicKey || (c.type !== "access_key_update" && c.type !== "access_key_deletion")) {
        throw new Error("EXPERIMENTAL_changes: not a change to K");
      }
      if (c.cause.type === "transaction_processing" && c.cause.tx_hash === txHash) ours = true;
    }
    return a.changes.length === 0 ? "empty" : ours ? "ours" : "other";
  };
  /** How far each transaction's receipt has been looked for: the last block read, so the next round goes on from it. */
  const scanned = new Map<string, { last: Block; next: bigint }>();
  /**
   * The outcome of a prepay's receipt read from blocks, never from a lookup (markets.md l.1240-1262, T1b): r computed
   * from the hash and D's height; E the first block in (D, F] whose account_changes for the vault, the same on both,
   * name r under receipt_processing (it succeeded) or only under action_receipt_gas_reward (it failed and was rolled
   * back, F61). A height with no block is passed only when the next block's prev_height shows the gap; null until E is
   * found (r pending). Each round reads up to RECEIPT_SCAN_MAX heights and the next goes on from the next height, kept
   * apart from the last block, so a run of heights with no block longer than one round is crossed.
   */
  const receiptFromBlocks = async (tx: TxRef, d: Block, f: bigint): Promise<Receipt | null> => {
    const r = receiptIdOf(tx.tx_hash, d.height);
    const at = scanned.get(tx.tx_hash) ?? { last: d, next: d.height + 1n };
    let last = at.last;
    const end = f < at.next - 1n + RECEIPT_SCAN_MAX ? f : at.next - 1n + RECEIPT_SCAN_MAX;
    for (let h = at.next; h <= end; h++) {
      const b = await blockAt(h);
      if (b === null) {
        remember(scanned, tx.tx_hash, { last, next: h + 1n });
        continue;
      }
      if (b.prev !== last.height) throw new Error(`block ${h}: its prev_height ${b.prev} is not ${last.height}`);
      const [v0, v1] = await Promise.all(
        rpcs.map(async (q) => {
          const a = await q("EXPERIMENTAL_changes", { changes_type: "account_changes", account_ids: [vault], block_id: Number(h) });
          if (!isObj(a) || a.block_hash !== b.hash || !Array.isArray(a.changes) || a.changes.length > CHANGES_MAX) throw new Error(`account_changes at ${h}: not that block's list`);
          let ran = false;
          let reward = false;
          for (const c of a.changes) {
            if (!isObj(c) || !isObj(c.cause) || !isObj(c.change) || c.change.account_id !== vault) throw new Error(`account_changes at ${h}: not a change to the vault`);
            if (c.cause.receipt_hash !== r) continue;
            if (c.cause.type === "receipt_processing") ran = true;
            if (c.cause.type === "action_receipt_gas_reward") reward = true;
          }
          return ran ? "ran" : reward ? "failed" : a.changes.length === 0 ? "empty" : "other";
        }),
      );
      if (v0 !== v1) throw new Error(`the providers disagree on the vault's changes at ${h} (${v0}, ${v1})`);
      if (v0 === "ran" || v0 === "failed") {
        scanned.delete(tx.tx_hash);
        return { executor: vault, ok: v0 === "ran", failure: v0 === "ran" ? "" : `receipt ${r} failed at ${h} (read from blocks)`, height: h, ...(b.ms !== null && { ms: b.ms }) };
      }
      last = b;
      remember(scanned, tx.tx_hash, { last, next: h + 1n });
    }
    return null;
  };
  /** A lookup by hash, a node's own view: its receipts and the block its transaction_outcome names, once FINAL. */
  const readTx = async (r: Rpc, tx: TxRef): Promise<{ at: unknown; receipts: Receipt[] } | null> => {
    try {
      const a = await r("tx", { tx_hash: tx.tx_hash, sender_account_id: account, wait_until: "NONE" });
      if (!isObj(a) || a.final_execution_status !== "FINAL" || !Array.isArray(a.receipts_outcome)) return null;
      const receipts: Receipt[] = [];
      for (const o of a.receipts_outcome) {
        const out = isObj(o) && isObj(o.outcome) ? o.outcome : {};
        const st = isObj(out.status) ? out.status : {};
        const ok = Object.hasOwn(st, "SuccessValue") || Object.hasOwn(st, "SuccessReceiptId");
        receipts.push({ executor: typeof out.executor_id === "string" ? out.executor_id : "", ok, failure: ok ? "" : JSON.stringify(st), height: await heightOf(r, isObj(o) ? o.block_hash : undefined) });
      }
      return { at: isObj(a.transaction_outcome) ? a.transaction_outcome.block_hash : undefined, receipts };
    } catch {
      return null; // UNKNOWN_TRANSACTION, a forgotten one, or an error: nothing read
    }
  };
  const judge = async (tx: TxRef, fromBlocks = false): Promise<TxOutcome> => {
    const keep = (why: string): TxOutcome => ({ kind: "unknown", tx_hash: tx.tx_hash, why });
    const finals = await Promise.all(rpcs.map(async (r) => header(await r("block", { finality: "final" })).height));
    const f = finals[0]! < finals[1]! ? finals[0]! : finals[1]!;
    await mustBlock(f);
    const b0 = BigInt(tx.height);
    if ((await mustBlock(b0)).hash !== tx.block_hash) throw new Error(`b0 (${b0}) answered with another hash than the one signed on`);
    const n = BigInt(tx.nonce);
    const p = await pAt(f, n);
    if (p === null) throw new Error(`no block at F (${f})`);
    if (p) return f > b0 + validity ? { kind: "dropped", tx_hash: tx.tx_hash, why: "(b): K's nonce is below its own at F, past b0 + the validity period" } : keep("not applied through F");
    if (f <= b0) throw new Error(`P fails at F (${f}), not past b0 (${b0})`);
    const stored = store.foundAt(tx.tx_hash);
    let d: Block;
    if (stored !== null) {
      d = await mustBlock(BigInt(stored.height));
      if (d.hash !== stored.hash) throw new Error(`D (${stored.height}) answered with another hash than the stored one`);
    } else {
      d = await findD(b0, f, n);
      store.setFoundAt(tx.tx_hash, { height: d.height.toString(), hash: d.hash });
    }
    if (d.height > f) throw new Error(`D (${d.height}) is above F (${f})`);
    const [c0, c1] = await Promise.all(rpcs.map((r) => changesAt(r, d, tx.tx_hash)));
    if (c0 !== c1) throw new Error(`the providers disagree on the changes at D (${c0}, ${c1})`);
    if (c0 === "empty") return keep("an empty change list at D: a node that does not save state changes, or did not apply D's chunk (F54)");
    if (c0 === "other") return { kind: "dropped", tx_hash: tx.tx_hash, why: "(a2): K's nonce passed it at D, whose changes do not name it" };
    // a call on the vault read from blocks only (the withdrawal's send record, markets.md "Its outcome"): never a lookup
    if (fromBlocks) {
      if (receiverOf(tx.signed_tx) !== vault) throw new Error("fromBlocks: not a transaction to the vault");
      const e = await receiptFromBlocks(tx, d, f);
      return e === null ? keep("applied at D; its receipt not found in a block up to F yet") : { kind: "final", tx_hash: tx.tx_hash, receipts: [e] };
    }
    // applied at D: its outcome from a lookup on any provider, the archival one included, that names D
    const reads = await Promise.all([...rpcs, archival].map((r) => readTx(r, tx)));
    if (reads.some((x) => x !== null && x.at !== d.hash)) {
      // F56: one hash can carry two outcomes, and a lookup can name the failed one at another block for good, so a
      // prepay's outcome is read from blocks; a delegate's (its receipts run on U, the token and the vault) keeps
      if (receiverOf(tx.signed_tx) !== vault) return keep("a lookup names a block other than D");
      const e = await receiptFromBlocks(tx, d, f);
      return e === null ? keep("a lookup names a block other than D; the prepay's receipt not found in a block up to F yet") : { kind: "final", tx_hash: tx.tx_hash, receipts: [e] };
    }
    const found = reads.find((x) => x !== null);
    return found ? { kind: "final", tx_hash: tx.tx_hash, receipts: found.receipts } : keep("applied at D; its outcome is not final on any provider yet");
  };
  /** One round; any error, missing answer or disagreement keeps it. */
  const readOnce = async (tx: TxRef, fromBlocks = false): Promise<TxOutcome> => {
    try {
      return await judge(tx, fromBlocks);
    } catch (e) {
      return { kind: "unknown", tx_hash: tx.tx_hash, why: `kept: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
    }
  };
  const wait = async (tx: TxRef, fromBlocks = false): Promise<TxOutcome> => {
    const until = Date.now() + waitMs;
    for (;;) {
      const out = await readOnce(tx, fromBlocks);
      if (out.kind !== "unknown" || Date.now() >= until) return out;
      await sleep(POLL_MS);
    }
  };

  return {
    account,
    key: counterKey,
    async balance() {
      const a = (await rpcs[0]("query", { request_type: "view_account", finality: "final", account_id: account })) as { amount?: unknown };
      return u128(a.amount, "relayer amount");
    },
    async send<C extends string = BindCode>(action: RelayerAction, guard: () => Promise<C | null>, before: (tx: TxRef) => void, opts: ReadOpts = {}) {
      const turn = queue.then(async (): Promise<{ guarded: C } | { tx: TxRef }> => {
        const code = await guard();
        if (code !== null) return { guarded: code };
        let c = store.nonceNext(counterKey); // read before the key: the compare-and-set below is on this value
        const ak = await readKey(rpcs[0], { finality: "final", account_id: account, public_key: publicKey });
        if (ak.kind !== "key" || ak.permission !== "FullAccess" || ak.block === undefined) throw new Error("relayer: the gas account's key is not a full-access key at final");
        const b0 = ak.block;
        let nonce: bigint;
        for (;;) {
          nonce = c !== null && c > ak.nonce + 1n ? c : ak.nonce + 1n;
          if (nonce >= b0.height * NONCE_RANGE) throw new Error(`relayer: nonce ${nonce} at or above b0 (${b0.height}) x 10^6 (F58)`);
          if (store.nonceCas(counterKey, c, nonce + 1n)) break;
          c = store.nonceNext(counterKey); // another signer took the counter's value: the next n
        }
        const receiver = action.kind === "storage_prepay" ? vault : action.receiver;
        const body = encodeTransaction({ signer: account, publicKey: pub, nonce, receiver, blockHash: base58decode(b0.hash), action: encodeAction(action) });
        const hash = createHash("sha256").update(body).digest();
        const tx: TxRef = { tx_hash: base58(hash), nonce: nonce.toString(), height: b0.height.toString(), block_hash: b0.hash, signed_tx: Buffer.concat([body, Buffer.from([0]), edSign(null, hash, priv)]).toString("base64") };
        before(tx);
        await broadcast(tx.signed_tx);
        return { tx };
      });
      queue = turn.catch(() => undefined);
      const t = await turn;
      if ("guarded" in t) return { kind: "guarded" as const, code: t.guarded };
      if (opts.wait === false) return { kind: "unknown" as const, tx_hash: t.tx.tx_hash, why: "sent; not read yet" };
      return wait(t.tx, opts.fromBlocks === true);
    },
    async resolve(tx, opts) {
      if (opts.resend) await broadcast(tx.signed_tx);
      return readOnce(tx, opts.fromBlocks === true);
    },
  };
}
