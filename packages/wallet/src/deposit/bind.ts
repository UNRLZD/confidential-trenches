// U's deposit from the signed call to the note's leaf (card wallet-deposit-bind, lane W2.3, W:1101; docs/plan1 at
// research 6e55c52): the device's side of the relayer's answers, wallet.md §2.4 W:446-480 and the vault paper's 2.10
// (c)-(d), V:674-692; the answers are the kit's frozen POST /v1/bind codes (HELPER_BIND_DEPOSIT_CODES, M:3341).
//
// One call per note. The note is the store's (await planDeposit, or the store's add for a second arrival, before this
// runs): its precommitment P is re-derived from the seed by its ref and must equal the record, and the note goes
// PLANNED -> INCOMING before P first leaves the device inside U's signed call (../notes/store.ts caller rules).
//   - The deposit is confirmed only from the vault's `deposits` pages, read on two RPCs at final and matched on the
//     device (P, depositor U, value = amount): never from the relayer's answer, a tx read by hash or a prepaid read
//     (W:419, V:674-675). One RPC holding P while the other does not confirms nothing: the device reads again.
//   - Nothing landed (W:448-455, V:675-677): only once both RPCs' final heights are past max_block_height + 5, with P
//     not held and U's key nonce unchanged, the device signs again, and at the same nonce, so at most one of the two
//     calls can land (nearcore refuses a delegate nonce at or below the key nonce, actions.rs l.669).
//   - Every re-sign, the lapse's and resign_needed's, is checked before anything is sent: a signed call whose nonce is
//     not the earlier call's is refused and dropped (resignDeposit). The earlier call's nonce is free only once U's key
//     nonce has moved past it.
//   - Refused (W:456-458): U's nonce moved, P not held and U's USDC back at the amount: a new call on the same P at
//     U's nonce + 1. A USDC not back yet is a call still settling, so the device keeps reading.
//   - prepay_open, R2 (W:459-460): wait until the pages hold U's previous note's P, then send the same signed bytes
//     while their window is ahead, else as nothing landed. resign_needed, R4 (W:461): sign again at the same nonce
//     with a new window. sender_struck, R3 (W:462-467): stop; nothing more is signed for U this session, and the
//     outcome tells the caller to open the way out (withdraw.open, U's own plain ft_transfer; V 2.12 step 5).
//   - Never storage_unregister on U, and never DeleteAccount while a call U signed can land (W:471-480, V:682-686):
//     checkCleanup, which the clean-up signer must call first.
// A P the pages hold for another deposit (a front-run naming P, W:456-458 and point 9) is still this device's note:
// its leaf hashes from our P, so the note goes UNSPENT with that leaf and the outcome says front_run; the caller signs
// the amount again on U's next second-arrival note.
// Nothing here logs. No request carries a key, the words or a note's secret: the relayer gets the signed delegate
// alone (sendDepositDelegate), and each read names U or the vault.
import { VAULT_CONSTANTS, VAULT_FIELD_P } from "@blindfill/kit";
import { base58, base64 } from "@scure/base";
import type { NoteRecord, NoteStore } from "../notes/store.ts";
import { noteCommitment, type NoteRef, noteSecrets } from "../notes/secrets.ts";
import { DepositAccountRefused, depositAccount, NEAR_NETWORKS, type NearNetwork, type NearRpc } from "./account.ts";
import { type BindAnswer, depositDelegate, sendDepositDelegate, type SignedDepositDelegate } from "./delegate.ts";

/** The margin past max_block_height, in blocks, before a call counts as dead (W:448; V:741-743 covers both readings). */
export const LAPSE_MARGIN = 5n;
export const POLL_MS = 1_000;

export type BindRefusalCode = "input" | "note" | "struck" | "early" | "nonce" | "cleanup";
export class DepositBindRefused extends Error {
  readonly code: BindRefusalCode;
  constructor(code: BindRefusalCode, detail: string) {
    super(`deposit bind refused (${code}): ${detail}`);
    this.name = "DepositBindRefused";
    this.code = code;
  }
}

export interface BindDepositArgs {
  network: NearNetwork;
  /** U = U_{s,i}. */
  s: bigint;
  i: number;
  /** The store's id of the note this call makes: U's deposit note or one of U's second-arrival notes. */
  noteId: string;
  /** In the token's base units: this call's note in the split (W:422-434). */
  amount: bigint;
  window?: number;
}

export interface BindDeps {
  store: NoteStore;
  rpcs: readonly [NearRpc, NearRpc];
  fetchFn?: typeof fetch;
  /** Waits between reads; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
}

export type BindOutcome =
  /** The pages hold P for U at the amount on both RPCs; the note is UNSPENT with that leaf. */
  | { kind: "deposited"; note: NoteRecord }
  /** The pages hold P for another deposit; the note is UNSPENT with that leaf, and the amount goes on U's next note. */
  | { kind: "front_run"; note: NoteRecord }
  /** R3: nothing more is signed for U; the caller opens withdraw.open for U (V 2.12 step 5). */
  | { kind: "struck"; account: string }
  /** The relayer refused the call by one of its checks: nothing more is sent, the USDC stays in U. */
  | { kind: "refused"; code: string };

// ---------- what this session signed, per U (checkCleanup) ----------
const struck = new Set<string>();
const liveUntil = new Map<string, bigint>(); // U -> the highest max_block_height of every call U signed this session
const running = new Map<string, number>(); // U -> binds running for it
function signedCall(call: SignedDepositDelegate): SignedDepositDelegate {
  const top = liveUntil.get(call.sender_id);
  if (top === undefined || call.max_block_height > top) liveUntil.set(call.sender_id, call.max_block_height);
  return call;
}

// ---------- reads on two RPCs ----------
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const DIGITS = /^(0|[1-9][0-9]*)$/;

function checkPair(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc]): void {
  const net = NEAR_NETWORKS[network];
  const names = Array.isArray(rpcs) && rpcs.length === 2 ? rpcs.map((r) => (isObj(r) && typeof r.query === "function" ? r.name : undefined)) : [];
  const fast = (n: unknown) => (net.fastnear as readonly unknown[]).includes(n);
  if (!((fast(names[0]) && names[1] === net.drpc) || (names[0] === net.drpc && fast(names[1]))))
    throw new DepositBindRefused("input", `the RPCs must be one of ${net.fastnear.join(", ")} and ${net.drpc}, exactly`);
}

function resultOf(a: unknown): Obj | undefined {
  const r = isObj(a) && a.error === undefined ? a.result : undefined;
  if (!isObj(r) || r.error !== undefined) return undefined;
  const h = r.block_height;
  return typeof h === "number" && Number.isSafeInteger(h) && h > 0 ? r : undefined;
}

/** U's key nonce at final on each RPC, or null when either does not answer, lacks U's key or they disagree. */
export type URead = { nonce: bigint; heights: [bigint, bigint] };
export async function readU(account: string, rpcs: readonly [NearRpc, NearRpc]): Promise<URead | null> {
  const publicKey = `ed25519:${base58.encode(Uint8Array.from(account.match(/../g)!, (h) => parseInt(h, 16)))}`;
  const sides = await Promise.all(
    rpcs.map(async (r) => {
      try {
        const res = resultOf(await r.query({ request_type: "view_access_key_list", account_id: account, finality: "final" }));
        const keys = res?.keys;
        if (res === undefined || !Array.isArray(keys)) return null;
        const own = keys.find((k) => isObj(k) && k.public_key === publicKey);
        const nonce = isObj(own) && isObj(own.access_key) ? own.access_key.nonce : undefined;
        if (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0) return null;
        return { nonce: BigInt(nonce), height: BigInt(res.block_height as number) };
      } catch {
        return null;
      }
    }),
  );
  const [a, b] = sides;
  if (!a || !b || a.nonce !== b.nonce) return null;
  return { nonce: a.nonce, heights: [a.height, b.height] };
}

/** One row of the vault's deposits view (contracts/vault/src/lib.rs DepositView). */
export type DepositRow = { index: number; precommitment: bigint; label: bigint; value: bigint; leafIndex: bigint; depositor: string };

function row(x: unknown, at: number): DepositRow {
  const ok = isObj(x) && Object.keys(x).length === 6;
  const { index, precommitment, label, value, leaf_index, depositor } = (ok ? x : {}) as Obj;
  const dec = (v: unknown) => typeof v === "string" && DIGITS.test(v);
  if (!ok || index !== at || !dec(precommitment) || !dec(label) || !dec(value) || typeof depositor !== "string" ||
    typeof leaf_index !== "number" || !Number.isSafeInteger(leaf_index) || leaf_index < 0)
    throw new Error("not a deposits row");
  const r = { index: at, precommitment: BigInt(precommitment as string), label: BigInt(label as string), value: BigInt(value as string), leafIndex: BigInt(leaf_index), depositor };
  if (r.precommitment >= VAULT_FIELD_P || r.label >= VAULT_FIELD_P || r.value >= 1n << 128n) throw new Error("not a deposits row");
  return r;
}

/** One RPC's pages from `from` to their end: the row holding P, if any, and the count read up to. */
async function scan(rpc: NearRpc, vault: string, p: bigint, from: number): Promise<{ found?: DepositRow; end: number }> {
  const limit = VAULT_CONSTANTS.PAGE_MAX;
  for (let at = from; ; at += limit) {
    const args = base64.encode(new TextEncoder().encode(JSON.stringify({ from: at, limit })));
    const res = resultOf(await rpc.query({ request_type: "call_function", account_id: vault, method_name: "deposits", args_base64: args, finality: "final" }));
    const bytes = res?.result;
    if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error("no page");
    const page = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)));
    if (!Array.isArray(page) || page.length > limit) throw new Error("not a page");
    const rows = page.map((x, k) => row(x, at + k));
    const found = rows.find((r) => r.precommitment === p);
    if (found) return { found, end: at + rows.length };
    if (rows.length < limit) return { end: at + rows.length };
  }
}

export type PagesRead = { state: "held"; row: DepositRow } | { state: "absent" } | { state: "unsure" };

/**
 * Whether the vault's deposits pages hold P, read at final on both RPCs: held only when both hold the same row,
 * absent only when neither does, else unsure (one RPC behind, down, or answering what is not a page). The pages only
 * grow, so a read that found P on neither moves the next read's start to the lower of the two counts.
 */
export class DepositsWatch {
  private from = 0;
  readonly vault: string;
  readonly p: bigint;
  readonly rpcs: readonly [NearRpc, NearRpc];
  constructor(vault: string, p: bigint, rpcs: readonly [NearRpc, NearRpc]) {
    this.vault = vault;
    this.p = p;
    this.rpcs = rpcs;
  }
  async read(): Promise<PagesRead> {
    const sides = await Promise.all(this.rpcs.map((r) => scan(r, this.vault, this.p, this.from).catch(() => null)));
    const [a, b] = sides;
    if (!a || !b) return { state: "unsure" };
    if (a.found && b.found) {
      const same = (Object.keys(a.found) as (keyof DepositRow)[]).every((k) => a.found![k] === b.found![k]);
      return same ? { state: "held", row: a.found } : { state: "unsure" };
    }
    if (a.found || b.found) return { state: "unsure" };
    this.from = Math.min(a.end, b.end);
    return { state: "absent" };
  }
}

// ---------- signing ----------

/** What a re-sign needs of the earlier call. */
export type EarlierCall = Pick<SignedDepositDelegate, "sender_id" | "nonce" | "max_block_height">;

/**
 * Signs U's call again at the earlier call's nonce. For the lapse ("lapse") U is read first on two RPCs: both final
 * heights must be past max_block_height + LAPSE_MARGIN and U's key nonce still below the earlier nonce, else it is
 * refused ("early", "nonce"). For R4 ("resign_needed") the relayer never sent the call and the same nonce is the guard.
 * Either way a signed call at another nonce is refused and dropped, never returned.
 */
export async function resignDeposit(
  seed64: Uint8Array, s: bigint, i: number, args: { network: NearNetwork; amount: bigint; precommitment: bigint; window?: number },
  earlier: EarlierCall, why: "lapse" | "resign_needed", rpcs: readonly [NearRpc, NearRpc],
): Promise<SignedDepositDelegate> {
  const nonce = earlier.nonce;
  const mbh = earlier.max_block_height;
  const sender = earlier.sender_id;
  if (typeof nonce !== "bigint" || typeof mbh !== "bigint") throw new DepositBindRefused("input", "the earlier call's nonce and max_block_height are bigints");
  if (why === "lapse") {
    const u = await readU(sender, rpcs);
    if (u === null) throw new DepositBindRefused("early", "U's key nonce is not read on both RPCs");
    const low = u.heights[0] < u.heights[1] ? u.heights[0] : u.heights[1];
    if (low <= mbh + LAPSE_MARGIN) throw new DepositBindRefused("early", `final height ${low} is not past max_block_height ${mbh} + ${LAPSE_MARGIN}`);
    if (u.nonce + 1n !== nonce) throw new DepositBindRefused("nonce", `U's key nonce is ${u.nonce}: the earlier call at ${nonce} is not free to sign again`);
  } else if (why !== "resign_needed") throw new DepositBindRefused("input", "a re-sign is for a lapse or resign_needed");
  const call = await depositDelegate(seed64, s, i, args, rpcs);
  if (call.sender_id !== sender || call.nonce !== nonce)
    throw new DepositBindRefused("nonce", `the re-signed call is at ${call.nonce}, not the earlier nonce ${nonce}: dropped`);
  return signedCall(call);
}

/**
 * The clean-up gate (W:471-480, V:682-686): storage_unregister on a one-time id is always refused; DeleteAccount is
 * refused while a bind for it runs or a call it signed this session is not past max_block_height + LAPSE_MARGIN on both
 * RPCs' final heights. The deposit in the pages and a zero balance are the clean-up row's own reads (W:920).
 */
export async function checkCleanup(action: string, account: string, rpcs: readonly [NearRpc, NearRpc]): Promise<void> {
  if (action === "storage_unregister") throw new DepositBindRefused("cleanup", "never storage_unregister on a one-time id: the token would burn a refund to it");
  if (action !== "DeleteAccount") throw new DepositBindRefused("cleanup", `${String(action)} is not a clean-up`);
  if (running.has(account)) throw new DepositBindRefused("cleanup", "a deposit call of this id is being sent");
  const mbh = liveUntil.get(account);
  if (mbh === undefined) return;
  const u = await readU(account, rpcs);
  if (u === null) throw new DepositBindRefused("cleanup", "the id's heights are not read on both RPCs");
  const low = u.heights[0] < u.heights[1] ? u.heights[0] : u.heights[1];
  if (low <= mbh + LAPSE_MARGIN) throw new DepositBindRefused("cleanup", `a call this id signed can land until ${mbh}; final height ${low}`);
}

// ---------- the bind ----------

// The note before this one under U (R2 waits until the pages hold it): U's deposit note before second arrival 0.
function previousRef(ref: NoteRef): NoteRef | null {
  if (ref.kind !== "second") return null;
  if (ref.id.id !== "U") return null;
  return ref.n === 0 ? { kind: "deposit", s: ref.id.s, i: ref.id.i } : { kind: "second", id: ref.id, n: ref.n - 1 };
}
const isUs = (ref: NoteRef, s: bigint, i: number) =>
  (ref.kind === "deposit" && ref.s === s && ref.i === i) || (ref.kind === "second" && ref.id.id === "U" && ref.id.s === s && ref.id.i === i);

// Codes that say the call may still be (or have been) carried: the pages and U's nonce settle it.
const SETTLE = new Set(["in_flight", "expired", "bad_nonce", "p_used"]);
// Codes that say wait and send the same bytes again while their window is ahead.
const RETRY = new Set(["token_halted", "relayer_low"]);
// Codes on which the device's own reads may continue (one RPC behind or down, a halt, USDC not back yet).
const WAIT_READ = new Set(["rpc", "disagree", "height", "halted", "balance", "not_created"]);

/**
 * Sends U_{s,i}'s call for one note through the release's relayer and follows it until the pages settle it, U is
 * struck, or the relayer refuses it by a check. deps.signal stops the wait (the money stays in U, safe, and a later
 * bind on the same note picks up where the pages and U's nonce say).
 */
export async function bindDeposit(seed64: Uint8Array, args: BindDepositArgs, deps: BindDeps): Promise<BindOutcome> {
  const own: BindDepositArgs = { network: args.network, s: args.s, i: args.i, noteId: args.noteId, amount: args.amount, window: args.window };
  if (!(seed64 instanceof Uint8Array) || seed64.length !== 64) throw new DepositBindRefused("input", "seed64 must be 64 bytes");
  if (typeof own.network !== "string" || !Object.hasOwn(NEAR_NETWORKS, own.network)) throw new DepositBindRefused("input", `unknown network ${String(own.network)}`);
  const vault = NEAR_NETWORKS[own.network].vault;
  if (vault === null) throw new DepositBindRefused("input", `the release names no vault on ${own.network}`);
  const rpcs = deps.rpcs;
  checkPair(own.network, rpcs);
  const seed = Uint8Array.from(seed64);
  const store = deps.store;
  const fetchFn = deps.fetchFn ?? fetch;
  const pollMs = deps.pollMs ?? POLL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const signal = deps.signal;
  const U = depositAccount(seed, own.s, own.i).account;
  if (struck.has(U)) throw new DepositBindRefused("struck", "the relayer struck U: its USDC leaves by withdraw.open");
  running.set(U, (running.get(U) ?? 0) + 1);
  try {
    // The note: in the store before P leaves, of U, and its P the one the seed gives its ref.
    let note = await store.get(own.noteId);
    if (note === undefined) throw new DepositBindRefused("note", "the note is not in the store: await planDeposit first");
    if (!isUs(note.ref, own.s, own.i)) throw new DepositBindRefused("note", "the note is not U's deposit or second-arrival note");
    const P = note.precommitment;
    if (noteSecrets(seed, note.ref).precommitment !== P) throw new DepositBindRefused("note", "the note's precommitment is not its ref's");
    const prevRef = previousRef(note.ref);
    const previousP = prevRef === null ? null : noteSecrets(seed, prevRef).precommitment;
    const call = { network: own.network, amount: own.amount, precommitment: P, window: own.window };
    const watch = new DepositsWatch(vault, P, rpcs);

    const stopped = () => {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    };
    const pause = async () => {
      stopped();
      await sleep(pollMs);
      stopped();
    };
    // The note lands with the leaf the pages give it: INCOMING -> UNSPENT, or already moved by another tab.
    const land = async (r: DepositRow): Promise<BindOutcome> => {
      const leaf = { value: r.value, label: r.label, commitment: noteCommitment(r.value, r.label, P), leafIndex: r.leafIndex };
      let cur = (await store.get(own.noteId))!;
      if (cur.state === "PLANNED") cur = await store.move(own.noteId, "PLANNED", "INCOMING");
      if (cur.state === "INCOMING") cur = await store.move(own.noteId, "INCOMING", "UNSPENT", { leaf });
      if (cur.leaf === undefined || cur.leaf.leafIndex !== leaf.leafIndex || cur.leaf.commitment !== leaf.commitment)
        throw new DepositBindRefused("note", `the note is ${cur.state} with another leaf`);
      return { kind: r.depositor === U && r.value === own.amount ? "deposited" : "front_run", note: cur };
    };
    // A sign that the device's own reads refuse for now (an RPC behind, USDC not back) waits and reads again.
    const signing = async (f: () => Promise<SignedDepositDelegate>): Promise<SignedDepositDelegate | null> => {
      try {
        return await f();
      } catch (e) {
        if (e instanceof DepositAccountRefused && WAIT_READ.has(e.code)) return null;
        if (e instanceof DepositBindRefused && (e.code === "early" || e.code === "nonce")) return null;
        throw e;
      }
    };

    // Settles a call that may be out: the pages hold P, or the call is dead (a lapse, or refused) and a next one is
    // signed. Returns the outcome, or the next call to send.
    const settle = async (out: SignedDepositDelegate): Promise<BindOutcome | SignedDepositDelegate> => {
      for (;;) {
        const pages = await watch.read();
        if (pages.state === "held") return land(pages.row);
        if (pages.state === "absent") {
          const u = await readU(U, rpcs);
          const low = u === null ? null : u.heights[0] < u.heights[1] ? u.heights[0] : u.heights[1];
          if (u !== null && low !== null && low > out.max_block_height + LAPSE_MARGIN && (await watch.read()).state === "absent") {
            const next =
              u.nonce + 1n === out.nonce
                ? await signing(() => resignDeposit(seed, own.s, own.i, call, out, "lapse", rpcs)) // nothing landed: the same nonce
                : u.nonce >= out.nonce
                  ? await signing(async () => {
                      // refused: U's nonce moved past the call, which can never land now; a new call on the same P
                      const c = await depositDelegate(seed, own.s, own.i, call, rpcs);
                      if (c.nonce <= out.nonce) throw new DepositBindRefused("nonce", "a new call must be past the dead one's nonce");
                      return signedCall(c);
                    })
                  : null;
            if (next !== null) return next;
          }
        }
        await pause();
      }
    };

    // Already in the pages (a reload, or another tab's bind): land it and send nothing.
    for (;;) {
      const first = await watch.read();
      if (first.state === "held") return await land(first.row);
      if (first.state === "absent") break;
      await pause();
    }
    if (note.state === "PLANNED") note = await store.move(own.noteId, "PLANNED", "INCOMING"); // before P leaves
    if (note.state !== "INCOMING") throw new DepositBindRefused("note", `the note is ${note.state}, not PLANNED or INCOMING`);

    let out: SignedDepositDelegate | null = null;
    while (out === null) {
      out = await signing(async () => signedCall(await depositDelegate(seed, own.s, own.i, call, rpcs)));
      if (out === null) await pause();
    }
    for (;;) {
      stopped();
      let answer: BindAnswer | null;
      try {
        answer = await sendDepositDelegate(out, fetchFn);
      } catch {
        answer = null; // no answer: the relayer may hold it, so the pages and U's nonce settle it
      }
      let next: BindOutcome | SignedDepositDelegate;
      if (answer === null || answer.ok || SETTLE.has(answer.code)) next = await settle(out);
      else if (answer.code === "sender_struck") {
        struck.add(U);
        return { kind: "struck", account: U };
      } else if (answer.code === "resign_needed") {
        const again: SignedDepositDelegate | null = await signing(() => resignDeposit(seed, own.s, own.i, call, out!, "resign_needed", rpcs));
        next = again ?? (await settle(out));
      } else if (answer.code === "prepay_open" || RETRY.has(answer.code)) {
        if (answer.code === "prepay_open") {
          // R2: wait until the pages hold U's previous P (U's first note has none: the relayer has no earlier P of U)
          if (previousP === null) return { kind: "refused", code: answer.code };
          const before = new DepositsWatch(vault, previousP, rpcs);
          while ((await before.read()).state !== "held") await pause();
        } else await pause();
        const u = await readU(U, rpcs);
        const high = u === null ? null : u.heights[0] > u.heights[1] ? u.heights[0] : u.heights[1];
        next = high !== null && high < out.max_block_height ? out : await settle(out); // the same bytes while ahead
      } else return { kind: "refused", code: answer.code };
      if (!("signed_delegate" in next)) return next;
      out = next;
    }
  } finally {
    seed.fill(0);
    const n = running.get(U)! - 1;
    if (n === 0) running.delete(U);
    else running.set(U, n);
  }
}

/** Tests only: forget what this session signed and struck. */
export function resetBindSession(): void {
  struck.clear();
  liveUntil.clear();
  running.clear();
}
