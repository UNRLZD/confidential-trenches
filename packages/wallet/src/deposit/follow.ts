// The device follows a deposit from its checked address to its note, with no tap (card wallet-deposit-follow;
// docs/plan1/wallet.md §2.4 steps 4-9 and point 8, the app paper's APU-04 table, at research HEAD).
//
// - 1Click's status of the deposit address is read through the helper's keyed proxy (GET /v1/proxy/oneclick/v0/status,
//   apps/helper/src/proxy/vendors.ts oneclick): keyless /v0/status answers 404 for our quotes (wallet.md D9). The answer
//   is hostile and only ever moves the stage shown: it counts only when it names our address, with U as its recipient
//   and its refund, and one of 1Click's seven statuses. Money moves only on the device's own chain reads.
// - The statuses map to stages by STATUS_STAGE (APU-04): PENDING_DEPOSIT the address shown, nothing seen; KNOWN_DEPOSIT_TX
//   waiting; PROCESSING in transit; INCOMPLETE_DEPOSIT short; SUCCESS in transit until U's credit is read; REFUNDED
//   refunded (the money under U inside intents.near, held_id U); FAILED failed (1Click still processing it, J2.F12).
// - No timer ever makes a stage. A stage comes from 1Click's status or a chain read: expired only from both RPCs' final
//   block time past the quote's signed deadline while 1Click still reads PENDING_DEPOSIT, and the status keeps being
//   read after it (a late send that 1Click refunds still shows). The polls only space the reads.
// - SUCCESS: U's USDC is read at one final block on both RPCs (each answer at that block, equal); at MIN_DEPOSIT or more
//   that credit is the note's amount, written in the op before the bind starts, so a reload binds the same note at the
//   same amount. The bind is bind.ts's (the prepay and U's signed ft_transfer_call through /v1/bind): it settles a call
//   the note already holds before it signs anything, so a reload never signs a second call at a new nonce.
// - Done only when a fresh vaultSync on both RPCs holds P with the leaf the note store holds and the note is UNSPENT,
//   never on the bind's word. A front-run on P (the pages hold P for another's deposit) lands that note with its leaf and
//   the money still in U goes on U's next second-arrival note, read again at a final block.
// - REFUNDED goes to the refund move (wallet.md §2.4 point 8): deps.refundMove, the device's move of what U holds inside
//   intents.near into the vault; stage refund_move while it runs, then its legs, done only on the leaf as above. With no
//   refund move given, the deposit stays refunded, the money under U, which withdraw.open moves out (held_id).
// - The op in the wallet store's "ops" (kit messages.ts Operation, src/state.ts op contract) is the follow's only state:
//   its stage and facts, and under `follow` what a reload needs (network, U's scope and index, the address, the signed
//   deadline, then the amount and which of U's notes). Nothing secret: no key, words, note secret or signed payload.
// Nothing here logs. The status read names the deposit address only; each chain read names U, the token or the vault.
import { type DepositFacts, type DepositHold, type DepositStage, HELPER_FETCH_INIT, HELPER_RPC_METHODS, VAULT_CONSTANTS } from "@blindfill/kit";
import { base64 } from "@scure/base";
import { noteCommitment, type NoteRef, noteSecrets } from "../notes/secrets.ts";
import type { NoteRecord, NoteStore } from "../notes/store.ts";
import type { WalletStore } from "../store/index.ts";
import { depositAccount, NEAR_NETWORKS, type NearNetwork, RPC_TIMEOUT_MS } from "./account.ts";
import { type BindDeps, bindDeposit, type BindOutcome, type BindRpc, bindRpc, DepositsWatch, POLL_MS } from "./bind.ts";

/** The helper's 1Click proxy for status (apps/helper/src/proxy/vendors.ts: oneclick, GET /v0/status). */
export const DEPOSIT_STATUS_URL = "https://api.confidential.unrealized.trade/v1/proxy/oneclick/v0/status";
export const DEPOSIT_STATUS_TIMEOUT_MS = 10_000;
/** A status answer is the quote and a few hashes: a few KB. */
export const DEPOSIT_STATUS_ANSWER_MAX = 65_536;

/** 1Click's statuses (OpenAPI 0.1.10 GetExecutionStatusResponse.status). */
export const ONECLICK_STATUSES = ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "INCOMPLETE_DEPOSIT", "SUCCESS", "REFUNDED", "FAILED"] as const;
export type OneClickStatus = (typeof ONECLICK_STATUSES)[number];

/** Each status's stage before the device's own reads (APU-04). SUCCESS is in transit until U's credit reads. */
export const STATUS_STAGE: Readonly<Record<OneClickStatus, DepositStage>> = Object.freeze({
  PENDING_DEPOSIT: "quote_checked",
  KNOWN_DEPOSIT_TX: "waiting",
  PROCESSING: "in_transit",
  INCOMPLETE_DEPOSIT: "short",
  SUCCESS: "in_transit",
  REFUNDED: "refunded",
  FAILED: "failed",
});

const IMPLICIT = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * 1Click's status of `address` through the helper, or null when it is no read: not 200, too big, not JSON, not one of
 * the seven statuses, or an answer for another address, recipient or refund than ours (U).
 */
export async function readDepositStatus(address: string, u: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<OneClickStatus | null> {
  try {
    const timeout = AbortSignal.timeout(DEPOSIT_STATUS_TIMEOUT_MS);
    const res = await fetchFn(`${DEPOSIT_STATUS_URL}?depositAddress=${encodeURIComponent(address)}`, {
      ...HELPER_FETCH_INIT,
      redirect: "error",
      method: "GET",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (res.status !== 200) return null;
    const text = await capped(res, DEPOSIT_STATUS_ANSWER_MAX);
    const body: unknown = JSON.parse(text);
    if (!isObj(body) || typeof body.status !== "string" || !(ONECLICK_STATUSES as readonly string[]).includes(body.status)) return null;
    const qr = isObj(body.quoteResponse) ? body.quoteResponse : undefined;
    const quote = qr && isObj(qr.quote) ? qr.quote : undefined;
    const req = qr && isObj(qr.quoteRequest) ? qr.quoteRequest : undefined;
    if (!quote || !req || quote.depositAddress !== address || req.recipient !== u || req.refundTo !== u) return null;
    return body.status as OneClickStatus;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

async function capped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? "0") > max) throw new Error("too big");
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error("too big");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(out);
}

/** A NEAR provider that also reads a block (the kit's HELPER_RPC_METHODS.near names `block`). */
export interface FollowRpc extends BindRpc {
  block(params: { finality: "final" }): Promise<unknown>;
}
const BLOCK_METHOD = "block";
if (!(HELPER_RPC_METHODS.near as readonly string[]).includes(BLOCK_METHOD)) throw new Error(`"${BLOCK_METHOD}" is not on the kit's NEAR method list`);
/** A provider by URL for query, tx and block. */
export function followRpc(url: string, fetchFn: typeof fetch = fetch, timeoutMs = RPC_TIMEOUT_MS): FollowRpc {
  const b = bindRpc(url, fetchFn, timeoutMs);
  return {
    ...b,
    async block(params) {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "blindfill", method: BLOCK_METHOD, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
  };
}

/** Both RPCs' final block time is past `deadlineMs` (each read on its own; either unread: not past). */
export async function pastOnBoth(rpcs: readonly [FollowRpc, FollowRpc], deadlineMs: number): Promise<boolean> {
  const sides = await Promise.all(
    rpcs.map(async (r) => {
      try {
        const a = await r.block({ finality: "final" });
        const h = isObj(a) && a.error === undefined && isObj(a.result) && isObj(a.result.header) ? a.result.header : undefined;
        const ns = h?.timestamp_nanosec;
        return typeof ns === "string" && DIGITS.test(ns) ? BigInt(ns) / 1_000_000n : null;
      } catch {
        return null;
      }
    }),
  );
  return sides.every((ms) => ms !== null && ms > BigInt(deadlineMs));
}

const resultAt = (a: unknown, at?: number): Obj | undefined => {
  const r = isObj(a) && a.error === undefined ? a.result : undefined;
  if (!isObj(r) || r.error !== undefined) return undefined;
  const h = r.block_height;
  if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0 || (at !== undefined && h !== at)) return undefined;
  return r;
};
async function balanceOf(r: BindRpc, account: string, token: string, block: { finality: "final" } | { block_id: number }): Promise<{ balance: bigint; height: number } | null> {
  try {
    const args = base64.encode(new TextEncoder().encode(JSON.stringify({ account_id: account })));
    const res = resultAt(await r.query({ request_type: "call_function", account_id: token, method_name: "ft_balance_of", args_base64: args, ...block }), "block_id" in block ? block.block_id : undefined);
    const bytes = res?.result;
    if (res === undefined || !Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes)));
    return typeof v === "string" && DIGITS.test(v) ? { balance: BigInt(v), height: res.block_height as number } : null;
  } catch {
    return null;
  }
}

/**
 * U's USDC at one final block on both RPCs: each RPC's final height read, then both read at the lower one (an answer
 * at another block is no read), equal; else null.
 */
export async function readCredit(account: string, token: string, rpcs: readonly [BindRpc, BindRpc]): Promise<bigint | null> {
  const finals = await Promise.all(rpcs.map((r) => balanceOf(r, account, token, { finality: "final" })));
  if (finals.some((f) => f === null)) return null;
  const at = Math.min(...finals.map((f) => f!.height));
  const [a, b] = await Promise.all(rpcs.map((r) => balanceOf(r, account, token, { block_id: at })));
  return a && b && a.balance === b.balance ? a.balance : null;
}

/** The deposit op's resume fields (op.follow): plain values, nothing secret. */
export interface FollowRecord {
  network: NearNetwork;
  /** U = U_{s,i}: s as a decimal string. */
  s: string;
  i: number;
  /** The checked quote's deposit address, and its signed deadline (unix ms). */
  address: string;
  deadline_ms: number;
  /** Once U's credit is read: the amount of the note being bound, and which of U's notes (-1 its deposit note, n its n-th second arrival). */
  amount?: string;
  note?: number;
}
export type DepositOp = { kind: "deposit"; stage: DepositStage; txs: { chain: string; hash: string }[]; created_ms: number; follow: FollowRecord } & DepositFacts;

export interface FollowArgs extends Omit<FollowRecord, "s" | "amount" | "note"> {
  /** The op's id: the deposit.quote request's id. */
  opId: string;
  s: bigint;
}

export type FollowOutcome =
  /** The note read on both RPCs, UNSPENT. */
  | { kind: "done"; note: NoteRecord }
  /** 1Click refunded to U and no refund move is given: the money waits under U. */
  | { kind: "refunded" }
  /** The bind stopped (struck or refused): the money waits under U, which withdraw.open moves out. */
  | { kind: "held"; why: string };

export interface FollowDeps {
  /** The wallet store whose "ops" holds the op (src/state.ts op contract). */
  ops: Pick<WalletStore, "get" | "update">;
  store: NoteStore;
  rpcs: readonly [FollowRpc, FollowRpc];
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  /** Each stage as written, with its facts (SIGN_HOST posts it as deposit.confirm's progress). */
  onStage?: (stage: DepositStage, facts: DepositFacts) => void;
  /** bind.ts's bindDeposit unless given (tests); the release relayer account for its tx reads. */
  bind?: typeof bindDeposit;
  relayerAccount?: string | null;
  /** The refund move of a REFUNDED deposit (wallet.md §2.4 point 8): resolves once its USDC is credited to U again. */
  refundMove?: (u: string, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export class DepositFollowRefused extends Error {
  constructor(detail: string) {
    super(`deposit follow refused: ${detail}`);
    this.name = "DepositFollowRefused";
  }
}

// How far a status read has come: a stale answer (a proxy's cache, a lagging 1Click replica) never takes it back.
const RANK: Partial<Record<DepositStage, number>> = { quote_checked: 0, expired: 0, waiting: 1, in_transit: 2, failed: 2, short: 2 };
const FACT_KEYS = ["refunded", "hold", "held_id", "since_ms", "amount_usd"] as const;
/** The USDC base units as a decimal string (6 decimals), trailing zeros dropped. */
export function usdOf(units: bigint): string {
  const s = units.toString().padStart(7, "0");
  const frac = s.slice(-6).replace(/0+$/, "");
  return frac === "" ? s.slice(0, -6) : `${s.slice(0, -6)}.${frac}`;
}

/**
 * Follows the deposit op `args.opId` from its stage to done, refunded (no refund move) or held. Starts the op when the
 * store has none; resumes it from its stage otherwise (a reload, a closed tab). deps.signal stops it; the money is then
 * wherever the chain has it and a later follow of the same op picks up from there.
 */
export async function followDeposit(seed64: Uint8Array, args: FollowArgs, deps: FollowDeps): Promise<FollowOutcome> {
  if (!(seed64 instanceof Uint8Array) || seed64.length !== 64) throw new DepositFollowRefused("seed64 must be 64 bytes");
  if (typeof args.network !== "string" || !Object.hasOwn(NEAR_NETWORKS, args.network)) throw new DepositFollowRefused(`unknown network ${String(args.network)}`);
  const vault = NEAR_NETWORKS[args.network].vault;
  if (vault === null) throw new DepositFollowRefused(`the release names no vault on ${args.network}`);
  if (typeof args.address !== "string" || args.address === "" || !Number.isSafeInteger(args.deadline_ms) || typeof args.opId !== "string" || args.opId === "")
    throw new DepositFollowRefused("an op id, a deposit address and its signed deadline are needed");
  const seed = Uint8Array.from(seed64);
  const { ops, store, rpcs } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const pollMs = deps.pollMs ?? POLL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const now = deps.now ?? Date.now;
  const signal = deps.signal;
  const bind = deps.bind ?? bindDeposit;
  const token = NEAR_NETWORKS[args.network].usdc;
  try {
    const U = depositAccount(seed, args.s, args.i).account;
    if (!IMPLICIT.test(U)) throw new DepositFollowRefused("U is not an implicit id");
    const pause = async () => {
      signal?.throwIfAborted();
      await sleep(pollMs);
      signal?.throwIfAborted();
    };

    // ---------- the op: read, or written fresh ----------
    const fresh: FollowRecord = { network: args.network, s: args.s.toString(), i: args.i, address: args.address, deadline_ms: args.deadline_ms };
    let op = (await ops.update("ops", args.opId, (v) => (v === undefined ? { kind: "deposit", stage: "quote_checked", txs: [], created_ms: now(), follow: fresh } : undefined))) as DepositOp | undefined;
    op ??= (await ops.get("ops", args.opId)) as DepositOp | undefined;
    if (!isObj(op) || op.kind !== "deposit" || !isObj(op.follow)) throw new DepositFollowRefused("the op is not a deposit op");
    const f = op.follow;
    if (f.network !== fresh.network || f.s !== fresh.s || f.i !== fresh.i || f.address !== fresh.address || f.deadline_ms !== fresh.deadline_ms)
      throw new DepositFollowRefused("the op names another deposit");

    // Writes a stage and its facts (only the facts that stage carries, kit messages.ts DepositFacts), and follow fields.
    const write = async (stage: DepositStage, facts: DepositFacts, follow?: Partial<FollowRecord>): Promise<void> => {
      const next = (await ops.update("ops", args.opId, (v) => {
        const cur = v as DepositOp;
        const out: Record<string, unknown> = { kind: "deposit", stage, txs: cur.txs ?? [], created_ms: cur.created_ms, follow: { ...cur.follow, ...follow } };
        for (const k of FACT_KEYS) if (facts[k] !== undefined) out[k] = facts[k];
        return out;
      })) as DepositOp | undefined;
      if (next === undefined) throw new DepositFollowRefused("the op could not be written");
      const changed = op!.stage !== stage || FACT_KEYS.some((k) => op![k] !== next[k]);
      op = next;
      if (changed) deps.onStage?.(stage, facts);
    };
    const since = (): number => op!.since_ms ?? now();
    const refunded = (): boolean => op!.refunded === true;
    // the legs after a refund carry refunded (and the stages that hold money under an id, U as held_id)
    const legFacts = (stage: DepositStage): DepositFacts => {
      const out: DepositFacts = { since_ms: since() };
      if (refunded()) out.refunded = true;
      if (stage === "refunded" || stage === "refund_move" || stage === "held" || stage === "halted") out.held_id = U;
      return out;
    };

    // ---------- the notes of U, by op.follow.note: -1 U's deposit note, n its n-th second arrival ----------
    const refOf = (n: number): NoteRef => (n < 0 ? { kind: "deposit", s: args.s, i: args.i } : { kind: "second", id: { id: "U", s: args.s, i: args.i }, n });
    const sameRef = (a: NoteRef, b: NoteRef): boolean => JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    const noteOf = async (n: number): Promise<NoteRecord> => {
      const ref = refOf(n);
      const found = (await store.list()).find((x) => sameRef(x.ref, ref));
      if (found !== undefined) return found;
      if (n < 0) throw new DepositFollowRefused("U's deposit note is not in the store");
      const scope = (await noteOf(-1)).scope;
      return store.add({ ref, scope, precommitment: noteSecrets(seed, ref).precommitment, state: "PLANNED" });
    };

    // ---------- done: a fresh read of the pages on both RPCs holds P with the note's leaf, the note UNSPENT ----------
    const confirm = async (n: number): Promise<{ note: NoteRecord; ours: boolean } | null> => {
      const note = await noteOf(n);
      const watch = new DepositsWatch(vault, note.precommitment, rpcs, { ...(await store.syncCursor(vault)), deposits: note.searchFrom ?? 0 });
      for (;;) {
        const r = await watch.read(signal);
        if (r.state === "held") {
          const cur = (await store.get(note.id))!;
          const leaf = cur.leaf;
          if (cur.state !== "UNSPENT" || leaf === undefined || leaf.leafIndex !== r.row.leafIndex || leaf.commitment !== noteCommitment(r.row.value, r.row.label, note.precommitment)) return null;
          return { note: cur, ours: r.row.depositor === U };
        }
        await pause();
      }
    };

    // ---------- 1Click's status until U holds the credit ----------
    const credit = async (): Promise<bigint> => {
      for (;;) {
        const c = await readCredit(U, token, rpcs);
        if (c !== null && c >= VAULT_CONSTANTS.MIN_DEPOSIT) return c;
        await pause();
      }
    };
    const followStatus = async (): Promise<"credited" | "refunded"> => {
      for (;;) {
        const st = await readDepositStatus(args.address, U, fetchFn, signal);
        if (st !== null) {
          const stage = STATUS_STAGE[st];
          if (st === "PENDING_DEPOSIT") {
            // nothing sent yet: expired only once both RPCs' final block time is past the signed deadline (block time
            // only moves on, so expired stays); a stage past the address is never taken back by a stale answer
            if (op!.stage === "quote_checked" && (await pastOnBoth(rpcs, args.deadline_ms))) await write("expired", {});
          } else if (st === "REFUNDED") {
            await write("refunded", { ...legFacts("refunded"), refunded: true, held_id: U });
            return "refunded";
          } else if (st === "SUCCESS") {
            const c = await readCredit(U, token, rpcs);
            if (c !== null && c >= VAULT_CONSTANTS.MIN_DEPOSIT) {
              await write("into_vault", legFacts("into_vault"), { amount: c.toString(), note: -1 });
              return "credited";
            }
            await write(stage, legFacts(stage));
          } else if (RANK[stage]! >= RANK[op!.stage]!) {
            await write(stage, legFacts(stage));
          }
        }
        await pause();
      }
    };

    // ---------- the bind, note by note, until the pages hold P for U at the amount ----------
    const bindAll = async (): Promise<FollowOutcome> => {
      for (;;) {
        const n = op!.follow.note ?? -1;
        const amount = BigInt(op!.follow.amount!);
        const note = await noteOf(n);
        const bindDeps: BindDeps = { store, rpcs, fetchFn, sleep, pollMs, ...(signal ? { signal } : {}), ...(deps.relayerAccount !== undefined ? { relayerAccount: deps.relayerAccount } : {}) };
        let out: BindOutcome;
        if (note.state === "UNSPENT") out = { kind: "deposited", note }; // landed before the reload: read below
        else out = await bind(seed, { network: args.network, s: args.s, i: args.i, noteId: note.id, amount }, bindDeps);
        if (out.kind === "struck" || out.kind === "refused") {
          await write("held", legFacts("held"));
          return { kind: "held", why: out.kind === "struck" ? "sender_struck" : out.code };
        }
        const read = await confirm(n);
        if (read === null) throw new DepositFollowRefused("the note's leaf is not the pages' on both RPCs");
        if (out.kind === "deposited" && read.ours && read.note.leaf!.value === amount) {
          await write("done", { ...(refunded() ? { refunded: true } : {}), since_ms: since(), amount_usd: usdOf(amount) });
          return { kind: "done", note: read.note };
        }
        // a front-run on P: that note holds another's deposit; what U still holds goes on U's next second arrival
        const left = await credit();
        await write("into_vault", legFacts("into_vault"), { amount: left.toString(), note: n + 1 });
      }
    };

    // ---------- resume from the op's stage ----------
    if (op.stage === "done") {
      const read = await confirm(op.follow.note ?? -1);
      if (read !== null) return { kind: "done", note: read.note };
      throw new DepositFollowRefused("the op says done but the pages do not hold its note");
    }
    for (;;) {
      if (op.follow.amount !== undefined) return await bindAll();
      if (op.stage === "refunded" || op.stage === "refund_move" || (await followStatus()) === "refunded") {
        if (deps.refundMove === undefined) return { kind: "refunded" };
        await write("refund_move", legFacts("refund_move"));
        await deps.refundMove(U, signal);
        // the refund move's own quote delivers to U on the token as step 5: its credit, then the same bind
        await write("in_transit", legFacts("in_transit"));
        const c = await credit();
        await write("into_vault", legFacts("into_vault"), { amount: c.toString(), note: -1 });
      }
    }
  } finally {
    seed.fill(0);
  }
}
