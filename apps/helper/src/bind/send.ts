// POST /v1/bind's carry of a deposit call that passed checks 1-7 (checks.ts): check 9's token hold, check 8's two-RPC
// simulation, the prepay and the send (markets paper H4.3 check 8, M:1755-1801, and check 9, M:1802-1809; M284's
// R1-R7, M:1811-1868; vault paper 2.10 (f)-(i), V:705-726). In order, for one signed call:
//
//   0. A re-send of signed bytes already carried answers 200 {tx_hash} of that same transaction, before any check, so a
//      device whose first answer was lost finds its transaction (check 3 would answer bad_nonce once U's nonce moved).
//   1. relayer_low when the gas account cannot pay one more (U, P) at its worst case (V@31d1b99:738).
//   2. checks 1-7 (checks.ts), with R1-R3 and R7's ledger read from the store below.
//   3. U's one in-flight slot, taken by a synchronous test-and-set, then the carried index read again: of two calls
//      for U that pass the checks at once, one goes on and the other gets in_flight (same P) or prepay_open (another
//      P); two binds sending the same bytes get one send between them (review R3-3).
//   4. (f) no prepay and no send while the token is held (status.ts tokenHeld: halted, a pending Pause, the vault
//      blocked, the code hash not the pin, or the watch not caught up): 503 token_halted, nothing spent or counted.
//   5. (g) U's USDC and U's key nonce read at one final height on two RPCs that must agree: amount_above_balance,
//      bad_nonce.
//   6. R7: U's record, written by one create-if-absent write keyed on U, durable before any prepay; P bound to U (R1);
//      one open P per U (R2).
//   7. (h) the prepay: 904 B whenever a tree may grow or a send on P already went (R5's top-up), else 756 B; the
//      record never holds more than 904 B on a P. R4's margin K just before it. A failed prepay counts (M292) and
//      closes P for this relayer. Then the send only after the prepay's receipt read SuccessValue at FINAL (so never
//      in the same chunk), R4's margin again and (f) again.
//   8. (i) the count is written before the send (R7) and taken back only when the pages hold P for U, when the send
//      failed with USDC's paused error while the watch shows the halt (R3's one exception), or when the transaction was
//      refused before inclusion. At three counted failures U is struck: sender_struck from then on, no top-up.
//
// The gas account holds NEAR for gas and prepays only (markets.md MN:314 (6)); its key signs the relayer's own
// transactions, whose only actions are storage_prepay on the vault and a Delegate carrying U's signed bytes as they
// came. The store is one directory of small JSON files, each written by write, fsync, rename and fsync of the
// directory; one relayer process owns a store (the in-flight slot is that process's).
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { HELPER_CODE_STATUS } from "@blindfill/kit";
import { base58, checkBindDeposit, type BindCode, type BindConfig, type BindLedger, type BindReads, type KeyRead } from "./checks.ts";
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
/** One (U, P) at its worst: 0.0104815 N (V@31d1b99:738), with room for the gas of a prepay and three sends. */
export const RELAYER_FLOOR_YOCTO = 20_000_000_000_000_000_000_000n; // 0.02 N
/** USDC's message for every call while paused (V 2.5.1 case 2). */
export const USDC_PAUSED = "FiatToken: paused";

// ---- What the carry needs ----

export type Answer = { status: number; body: { tx_hash: string } | { error: { code: BindCode } } };

/** The two-RPC reads (checks.ts BindReads) and the deposits pages' record of P. */
export type SendReads = BindReads & {
  /** The vault's deposits pages' record of P, from the relayer's index, or null. */
  deposit(precommitment: bigint): Promise<{ depositor: string; value: bigint } | null>;
  /** R4's "newest final height": the higher of the providers' finals (finalHeight is the lower, for reads at one height). */
  newestFinalHeight(): Promise<bigint>;
  /** Inserts that may land before this deposit: the state and label trees' sizes now, and inserts seen in flight. */
  trees(): Promise<{ state: bigint; label: bigint }>;
};

/** One relayer transaction's FINAL outcome, or why there is none. */
export type TxOutcome =
  | { kind: "final"; tx_hash: string; receipts: { executor: string; ok: boolean; failure: string }[] }
  /** Refused before inclusion (an InvalidTransaction): it has no receipt, nothing ran, nothing burnt. */
  | { kind: "refused"; tx_hash: string; why: string }
  /** No FINAL answer in time: it may still land. */
  | { kind: "unknown"; tx_hash: string; why: string };

export type RelayerAction = { kind: "storage_prepay"; precommitment: bigint; bytes: bigint } | { kind: "delegate"; signed: Uint8Array; receiver: string };

export type Relayer = {
  account: string;
  /** The gas account's NEAR, at final. */
  balance(): Promise<bigint>;
  /** Signs one transaction of one action; `before` runs with its hash before it is sent (the carried index). */
  send(action: RelayerAction, before: (txHash: string) => void): Promise<TxOutcome>;
  /** A transaction of ours read at FINAL by its hash; "unknown" until then. */
  status(txHash: string): Promise<TxOutcome>;
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

export type DepositRecord = {
  u: string;
  /** P, decimal. */
  p: string;
  /** What this relayer prepaid on P, in bytes; never above 904. */
  prepaid_bytes: number;
  /** Counted failed sends and failed prepays on (U, P). */
  failed: number;
  struck: boolean;
  /** The pages hold P for U: U's next P may open (R2). */
  landed: boolean;
  /** A prepay of ours on P failed: nothing more is sent on P (V 2.10 (i)). */
  p_closed: boolean;
  prepays: { tx_hash: string; bytes: number; ok: boolean | null }[];
  sends: { tx_hash: string; sha256: string; counted: boolean }[];
};

export type DepositStore = {
  get(u: string): DepositRecord | null;
  /** R7: create-if-absent on U, durable before it returns; the existing record when one is there. */
  create(rec: DepositRecord): { created: boolean; rec: DepositRecord };
  /** Durable replace of U's record. */
  put(rec: DepositRecord): void;
  /** R1: create-if-absent on P; the U it is bound to. */
  bind(p: bigint, u: string): string;
  boundTo(p: bigint): string | null;
  /** The idempotent answer's index: signed bytes' sha256 -> the transaction that carried them. */
  carried(sha256: string): string | null;
  carry(sha256: string, txHash: string): void;
};

/** A store of small JSON files in `dir`, each written whole and durably: write, fsync, rename, fsync the directory. */
export function createFileStore(dir: string): DepositStore {
  mkdirSync(dir, { recursive: true });
  const path = (name: string) => join(dir, name);
  const read = <T>(name: string): T | null => {
    try {
      return JSON.parse(readFileSync(path(name), "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  };
  const syncDir = () => {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const writeFd = (fd: number, v: unknown) => {
    try {
      writeSync(fd, JSON.stringify(v));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  /** Create-if-absent (O_CREAT|O_EXCL): false when the file is there. */
  const createOnce = (name: string, v: unknown): boolean => {
    let fd: number;
    try {
      fd = openSync(path(name), "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    writeFd(fd, v);
    syncDir();
    return true;
  };
  const replace = (name: string, v: unknown) => {
    const tmp = path(`${name}.tmp`);
    writeFd(openSync(tmp, "w"), v);
    renameSync(tmp, path(name));
    syncDir();
  };
  const uName = (u: string) => {
    if (!/^[0-9a-f]{64}$/.test(u)) throw new Error("store: U is not a 64-hex id");
    return `u-${u}.json`;
  };
  return {
    get: (u) => read<DepositRecord>(uName(u)),
    create(rec) {
      if (createOnce(uName(rec.u), rec)) return { created: true, rec };
      return { created: false, rec: read<DepositRecord>(uName(rec.u))! };
    },
    put: (rec) => replace(uName(rec.u), rec),
    bind(p, u) {
      if (createOnce(`p-${p}.json`, { u })) return u;
      return read<{ u: string }>(`p-${p}.json`)!.u;
    },
    boundTo: (p) => read<{ u: string }>(`p-${p}.json`)?.u ?? null,
    carried(sha) {
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("store: not a sha256");
      return read<{ tx_hash: string }>(`s-${sha}.json`)?.tx_hash ?? null;
    },
    carry: (sha, txHash) => replace(`s-${sha}.json`, { tx_hash: txHash }),
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

/** U's one in-flight slot in this process: U -> the P being carried. */
const inFlight = new Map<string, bigint>();

export function ledgerOf(store: DepositStore, reads: SendReads): BindLedger {
  return {
    struck: async (u) => store.get(u)?.struck === true,
    boundTo: async (p) => store.boundTo(p),
    async openP(u) {
      const rec = store.get(u);
      if (rec === null || rec.landed) return null;
      // the pages hold U's P, for U or for a stranger who front-ran it: U's next P may open (R2)
      if ((await reads.deposit(BigInt(rec.p))) !== null) {
        store.put({ ...rec, landed: true });
        return null;
      }
      return BigInt(rec.p);
    },
    inFlight: async (u, p) => inFlight.get(u) === p,
  };
}

/** R4: max_block_height minus the newest final height is at least K. */
async function marginHolds(deps: SendDeps, maxBlockHeight: bigint): Promise<boolean> {
  return maxBlockHeight - (await deps.reads.newestFinalHeight()) >= deps.cfg.marginK;
}

const held = async (deps: SendDeps) => tokenHeld(await deps.tokenStatus());

export async function carryDeposit(request: unknown, deps: SendDeps): Promise<Answer> {
  const { store, reads, relayer } = deps;

  // 0. The idempotent answer: these exact bytes were carried before.
  const raw = requestBytes(request);
  const sha = raw === null ? null : sha256hex(raw);
  if (sha !== null) {
    const was = store.carried(sha);
    if (was !== null) return sent(was);
  }

  // 1. The gas account can pay one more (U, P) at its worst.
  if ((await relayer.balance()) < RELAYER_FLOOR_YOCTO) return no("relayer_low");

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
    const was = store.carried(sha!);
    if (was !== null) return sent(was);
    return await carryChecked(deps, d, sha!);
  } finally {
    inFlight.delete(u);
  }
}

type Checked = Extract<Awaited<ReturnType<typeof checkBindDeposit>>, { ok: true }>["deposit"];

async function carryChecked(deps: SendDeps, d: Checked, sha: string): Promise<Answer> {
  const { store, reads, relayer } = deps;
  const u = d.sender_id;
  const p = d.precommitment;

  // 4. (f) check 9: nothing while the token is held.
  if (await held(deps)) return no("token_halted");

  // 5. (g) the simulation: U's USDC and U's key nonce, each read on two RPCs that agree at final (SendReads).
  if ((await reads.ftBalance(u)) < d.amount) return no("amount_above_balance");
  const key: KeyRead = await reads.accessKey(u, d.public_key);
  if (key.kind !== "key" || d.nonce <= key.nonce) return no("bad_nonce");

  // 6. R1's binding of P to U (create-if-absent on P), then R7's record (create-if-absent on U), both durable before
  // any prepay. P is bound first, so a record never names a P bound to another U.
  if (store.bind(p, u) !== u) return no("p_bound");
  const fresh: DepositRecord = { u, p: p.toString(), prepaid_bytes: 0, failed: 0, struck: false, landed: false, p_closed: false, prepays: [], sends: [] };
  let { rec } = store.create(fresh);
  if (rec.struck) return no("sender_struck");
  if (rec.p !== fresh.p) {
    // R2: U moves to a new P only once the pages hold the old one (for U, or for a stranger who front-ran it).
    if (!rec.landed && (await reads.deposit(BigInt(rec.p))) === null) return no("prepay_open");
    rec = fresh;
    store.put(rec);
  }
  if (rec.landed || rec.p_closed) return no("p_used");

  // A prepay of ours on P whose outcome was not read: read it now; until it is known, hold (it may still land, and
  // its bytes already count toward the 904 B cap).
  for (const pre of rec.prepays.filter((x) => x.ok === null)) {
    const out = await relayer.status(pre.tx_hash);
    if (out.kind !== "final") throw new Error(`storage_prepay ${pre.tx_hash}: outcome not known yet`);
    const ok = out.receipts.some((r) => r.executor === deps.cfg.vault) && out.receipts.every((r) => r.ok);
    rec = { ...rec, prepays: rec.prepays.map((x) => (x.tx_hash === pre.tx_hash ? { ...x, ok } : x)) };
    if (!ok) {
      const failed = rec.failed + 1;
      rec = { ...rec, prepaid_bytes: rec.prepaid_bytes - pre.bytes, failed, struck: failed >= MAX_FAILED_SENDS, p_closed: true };
    }
    store.put(rec);
    if (!ok) return no("p_used");
  }

  // 7. (h) the prepay, topped up to 904 B on a retry, never above 904 B on P. prepaid_bytes is written before the
  // prepay goes and taken back only on its FINAL failure, so a prepay whose outcome is unknown still counts toward the
  // cap (it may land) and P is never prepaid above 904 B by this relayer.
  const target = rec.sends.length > 0 ? PREPAY_MAX_BYTES : prepayBytes(await reads.trees(), (await deps.insertsInFlight?.()) ?? 0n);
  const topUp = target - BigInt(rec.prepaid_bytes);
  if (topUp > 0n) {
    if (!(await marginHolds(deps, d.max_block_height))) return no("resign_needed");
    if (await held(deps)) return no("token_halted");
    const out = await relayer.send({ kind: "storage_prepay", precommitment: p, bytes: topUp }, (h) => {
      rec = { ...rec, prepaid_bytes: rec.prepaid_bytes + Number(topUp), prepays: [...rec.prepays, { tx_hash: h, bytes: Number(topUp), ok: null }] };
      store.put(rec);
    });
    if (out.kind === "refused") {
      // never included: no receipt, nothing burnt, not a failed prepay (V 2.10 (i))
      rec = { ...rec, prepaid_bytes: rec.prepaid_bytes - Number(topUp), prepays: rec.prepays.filter((x) => x.tx_hash !== out.tx_hash) };
      store.put(rec);
      throw new Error(`storage_prepay: refused before inclusion: ${out.why}`);
    }
    if (out.kind === "unknown") throw new Error(`storage_prepay: no FINAL answer: ${out.why}`);
    const ok = out.receipts.some((r) => r.executor === deps.cfg.vault) && out.receipts.every((r) => r.ok);
    const prepays = rec.prepays.map((x) => (x.tx_hash === out.tx_hash ? { ...x, ok } : x));
    if (!ok) {
      // M292: a failed prepay counts toward (U, P)'s three, and closes P for this relayer.
      const failed = rec.failed + 1;
      rec = { ...rec, prepays, prepaid_bytes: rec.prepaid_bytes - Number(topUp), failed, struck: failed >= MAX_FAILED_SENDS, p_closed: true };
      store.put(rec);
      return no("p_used");
    }
    rec = { ...rec, prepays };
    store.put(rec);
  }

  // The send: after the prepay's SuccessValue at FINAL, with R4's margin, R3's three and (f) again just before it.
  if (!(await marginHolds(deps, d.max_block_height))) return no("resign_needed");
  if (rec.failed >= MAX_FAILED_SENDS) {
    rec = { ...rec, struck: true };
    store.put(rec);
    return no("sender_struck");
  }
  if (await held(deps)) return no("token_halted");

  // 8. (i) the count and the carried index, written before the send.
  const out = await relayer.send({ kind: "delegate", signed: d.signed_delegate, receiver: u }, (h) => {
    rec = { ...rec, failed: rec.failed + 1, sends: [...rec.sends, { tx_hash: h, sha256: sha, counted: true }] };
    store.put(rec);
    store.carry(sha, h);
  });
  let uncount = false;
  let landed = false;
  if (out.kind === "refused") uncount = true; // no receipt, nothing ran
  else if (out.kind === "final") {
    const dep = await reads.deposit(p);
    if (dep !== null && dep.depositor === u && dep.value === d.amount) landed = uncount = true;
    else if (out.receipts.some((r) => !r.ok && r.failure.includes(USDC_PAUSED))) {
      if ((await deps.tokenStatus()).halted === true) uncount = true; // R3's one exception: U cannot cause USDC's pause
    }
  }
  const failed = uncount ? rec.failed - 1 : rec.failed;
  const sends = uncount ? rec.sends.map((x) => (x.tx_hash === out.tx_hash ? { ...x, counted: false } : x)) : rec.sends;
  rec = { ...rec, failed, sends, landed, struck: failed >= MAX_FAILED_SENDS };
  store.put(rec);
  if (out.kind === "refused") throw new Error(`send: refused before inclusion: ${out.why}`);
  return sent(out.tx_hash);
}

// ---- The NEAR side: two RPCs, the relayer's key ----

type Rpc = (method: string, params: unknown) => Promise<unknown>;
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

/**
 * The reads, each on both providers at one final height (the lower of their two finals), refused unless both answer
 * the same: the call is held, nothing spent on an unknown. The deposits pages are indexed as read, page by page.
 */
export function createSendReads(rpcs: readonly [Rpc, Rpc], cfg: { vault: string; token: string }): SendReads {
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
    if (JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)) !== JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))) throw new Error("the two RPCs disagree");
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
  const deposit = async (precommitment: bigint) => {
    for (;;) {
      const page = await both(async (r, h) => view(r, h, cfg.vault, "deposits", { from: next, limit: PAGE }));
      if (!Array.isArray(page) || page.length > PAGE) throw new Error("deposits: not a page");
      for (const x of page) {
        if (!isObj(x) || typeof x.precommitment !== "string" || typeof x.depositor !== "string") throw new Error("deposits: not a deposit");
        pages.set(x.precommitment, { depositor: x.depositor, value: u128(x.value, "deposits.value") });
      }
      next += page.length;
      if (page.length < PAGE) break;
    }
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

/**
 * The gas account: one key, one transaction at a time (its nonce read at final before each), sent to both providers
 * and read back at FINAL. The secret key is "ed25519:" + base58 of 64 bytes (seed then public key).
 */
export function createRelayer(rpcs: readonly [Rpc, Rpc], account: string, secretKey: string, vault: string): Relayer {
  if (!secretKey.startsWith("ed25519:")) throw new Error("relayer key: not ed25519");
  const sk = base58decode(secretKey.slice(8));
  if (sk.length !== 64) throw new Error("relayer key: not 64 bytes");
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), sk.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const pub = sk.subarray(32);
  const publicKey = `ed25519:${base58(pub)}`;
  let queue: Promise<unknown> = Promise.resolve();
  let lastNonce = 0n;
  const one = async (action: RelayerAction, before: (h: string) => void): Promise<TxOutcome> => {
    const k = (await rpcs[0]("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey })) as { nonce?: unknown };
    const chainNonce = u64(k.nonce, "relayer nonce");
    const nonce = (chainNonce > lastNonce ? chainNonce : lastNonce) + 1n;
    lastNonce = nonce;
    const block = (await rpcs[0]("block", { finality: "final" })) as { header?: { hash?: unknown } };
    if (typeof block.header?.hash !== "string") throw new Error("block: no hash");
    const receiver = action.kind === "storage_prepay" ? vault : action.receiver;
    const tx = encodeTransaction({ signer: account, publicKey: pub, nonce, receiver, blockHash: base58decode(block.header.hash), action: encodeAction(action) });
    const hash = createHash("sha256").update(tx).digest();
    const txHash = base58(hash);
    const signed = Buffer.concat([tx, Buffer.from([0]), edSign(null, hash, priv)]).toString("base64");
    before(txHash);
    rpcs[1]("broadcast_tx_async", [signed]).catch(() => undefined); // the second provider: the same bytes, its answer unused
    try {
      const r = await rpcs[0]("send_tx", { signed_tx_base64: signed, wait_until: "FINAL" });
      return { kind: "final", tx_hash: txHash, receipts: receiptsOf(r) };
    } catch (e) {
      if (e instanceof RpcError && e.cause_name === "INVALID_TRANSACTION") return { kind: "refused", tx_hash: txHash, why: e.message };
      return { kind: "unknown", tx_hash: txHash, why: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    account,
    async balance() {
      const a = (await rpcs[0]("query", { request_type: "view_account", finality: "final", account_id: account })) as { amount?: unknown };
      return u128(a.amount, "relayer amount");
    },
    async status(txHash) {
      try {
        const r = await rpcs[0]("tx", { tx_hash: txHash, sender_account_id: account, wait_until: "FINAL" });
        return { kind: "final", tx_hash: txHash, receipts: receiptsOf(r) };
      } catch (e) {
        return { kind: "unknown", tx_hash: txHash, why: e instanceof Error ? e.message : String(e) };
      }
    },
    send(action, before) {
      const run = queue.then(() => one(action, before));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

function receiptsOf(r: unknown): { executor: string; ok: boolean; failure: string }[] {
  if (!isObj(r) || !Array.isArray(r.receipts_outcome)) throw new Error("send_tx: no receipts_outcome");
  return r.receipts_outcome.map((o) => {
    const out = isObj(o) && isObj(o.outcome) ? o.outcome : {};
    const st = isObj(out.status) ? out.status : {};
    const ok = Object.hasOwn(st, "SuccessValue") || Object.hasOwn(st, "SuccessReceiptId");
    return { executor: typeof out.executor_id === "string" ? out.executor_id : "", ok, failure: ok ? "" : JSON.stringify(st) };
  });
}
