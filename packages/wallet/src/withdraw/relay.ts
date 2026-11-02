// One withdrawal through the release's relayer, from its fee to its change note (card wallet-withdraw-relay; lane W2.4,
// docs/plan1/wallet.md l.1115; the relayer's paths, markets.md l.3346-3348, and its fee rule, LD5 l.1052-1075; its
// route 1 and the self-submit fallback, markets.md H3.6 l.1509-1524; at research 8e9352d). Everything of Blindfill
// comes from the kit's public entry; the paths and their answers are the kit's frozen helper API (helper/v1.ts).
//
// - The fee (askWithdrawFee): GET /v1/withdraw/fee?token=<id> on the release's helper. The answer is hostile input:
//   exactly the frozen fields, each in its form; relayer_account and fee_recipient equal to the release's, byte for
//   byte (HELPER_FEE_ANSWER_DISPLAY_ONLY: shown, never copied); relay_fee a canonical u128 at most the device's own
//   fee_max and below the amount (the §2.8 arming row, wallet.md l.915; LD5, markets.md l.1071-1072). fee_max is the
//   caller's, computed from its own reads (LD5's formula, never a helper figure), so no helper answer can raise the
//   bound. What goes into the withdrawal is the release's fee_recipient, never the answer's.
// - The send (relayWithdraw): POST /v1/withdraw with the request withdrawRequest made, as one fixed string of bytes,
//   sent again unchanged and never re-proved (wallet.md l.990: a retry never re-signs). It is sent only while the
//   note is RESERVED by exactly this attempt (its last context and deadline_ms are the body's: WU-06, nothing leaves
//   before the store has it), and only while block time + WITHDRAW_SEND_MARGIN_MS is below deadline_ms (H3.4 check 9,
//   markets.md l.1376-1377, 120 s since every request funds A). The answer counts only as one of the frozen codes
//   with its own HTTP status, or 200 {tx_hash, state: "submitted"}; anything else is no answer. A busy or down answer (rate_limited, upstream,
//   index_behind, relayer_low, token_halted, no answer) sends the same bytes again on the next round; submitted or
//   in_flight waits RELAY_RESEND_MS for the pages before the same bytes go again, so a relayer that says submitted and
//   drops the call costs time, never the withdrawal (route 1, markets.md l.1511-1517). withdraw_failed ends the
//   sends and names route 2, self-submit (l.1518-1524: the exit tool, from the 12 words); every other code ends them.
// - Confirm first (wallet.md l.424's rule for deposits, here for the change; §2.3 "own" l.227-230): the change
//   note is written only once the vault's spends and leaves pages, read on two RPCs at one block and matched byte for
//   byte (the kit's vaultSync), hold a spend of this note's nullifier hash and, at its new_leaf_index, the change leaf
//   this seed gives: Poseidon(value, l, precommitment of change note j), value = the note's less the spend's
//   withdrawn. Never on the relayer's answer, a tx hash or one RPC. The store's add(child, parent) then writes the
//   change UNSPENT and moves the spent note to SPENT (../notes/store.ts). The spend is "own" when its context is one
//   this device recorded on the note (l.227-228); another device's spend of the note still makes this seed's change
//   note j of label l (its secrets come from (l, j), wallet.md l.176-178), so it is recorded too, with own false: the
//   caller then signs nothing from A (l.231-234).
// - Nothing landed: only once the newest final block's time (the lower of two RPCs') is past deadline_ms and the pages,
//   read at or above that block and equal on both RPCs, hold no spend of the note, does the note go RESERVED -> UNSPENT
//   (the store's own rule, wallet.md l.201; the vault refuses a withdrawal past its deadline_ms, V@93b827c:354). While
//   the RPCs disagree, or one is down, nothing is concluded either way, past the deadline too. A spend whose change
//   leaf is not this seed's (no leaf at its index in the rows read, or another commitment) records nothing and frees
//   nothing: the note stays RESERVED for restore's walk.
// - The seed is copied and the copy zeroed before the first await. Nothing here logs. The relayer gets the request's
//   body alone: the withdrawal data, the proof and its public signals, none of which names another note or a key.
//
// Not here: fee_max's own reads (gas price and the NEAR price, LD1), the refund note a settle writes, the "own" act on
// A (the arming card), a withdrawal across several notes (WM-06), the busy answer's Retry-After (WU-08), and route 2
// itself (the exit tool, packages/exit).
import {
  HELPER_CODE_STATUS,
  HELPER_COMMON_CODES,
  HELPER_FETCH_INIT,
  HELPER_V1_PATHS,
  HELPER_WITHDRAW_CODES,
  type HelperCommonCode,
  type HelperReleaseRelayer,
  type HelperWithdrawCode,
  vaultSync,
  vaultSyncStart,
  type VaultSpendRow,
  type VaultSyncCursor,
  type VaultSyncRpc,
} from "@blindfill/kit";
import { base58 } from "@scure/base";
import { noteCommitment, noteSecrets } from "../notes/secrets.ts";
import { type NoteRecord, type NoteStore, refKey } from "../notes/store.ts";
import { blockTimeMsOf, WITHDRAW_SEND_MARGIN_MS, type WithdrawRequest } from "./request.ts";

/** The release's helper (the signing page's CSP lets it reach no other, packages/signpage/public/_headers). */
export const RELEASE_HELPER = "https://api.confidential.unrealized.trade";
export const WITHDRAW_FEE_URL = `${RELEASE_HELPER}/v1/withdraw/fee`;
export const WITHDRAW_URL = `${RELEASE_HELPER}/v1/withdraw`;
/** Both answers are small (the frozen limits are 1 KB for the fee path); a longer one is refused unread. */
export const RELAY_ANSWER_MAX_BYTES = 1_024;
export const RELAY_TIMEOUT_MS = 10_000;
/** The wait between rounds: one block-time read, one pages read, at most one send. */
export const RELAY_POLL_MS = 1_000;
/** After submitted or in_flight, the same bytes go again only once the pages have shown nothing for this long. */
export const RELAY_RESEND_MS = 30_000;
const WITHDRAW_BODY_MAX = HELPER_V1_PATHS.find((p) => p.method === "POST" && p.path === "/v1/withdraw")!.limitBytes;

export type RelayRefusalCode = "input" | "answer" | "relayer" | "fee" | "helper" | "note";
export class WithdrawRelayRefused extends Error {
  readonly code: RelayRefusalCode;
  constructor(code: RelayRefusalCode, detail: string) {
    super(`withdraw relay refused (${code}): ${detail}`);
    this.name = "WithdrawRelayRefused";
    this.code = code;
  }
}

// ---------- the fee ----------

export type WithdrawFeeArgs = {
  /** The vault's token, the one the fee is asked in. */
  token: string;
  /** The release's relayer, written in the release: never a helper's answer. */
  relayer: HelperReleaseRelayer;
  /** The device's fee_max in the token's base units, from its own reads (LD5); never a helper figure. */
  feeMax: bigint;
  /** What the recipient gets, in the token's base units. */
  amount: bigint;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
};

/** The fee to bind: relayFee and the release's own fee_recipient; the answer's validUntilBlock, for display. */
export type WithdrawFee = { relayFee: bigint; feeRecipient: string; validUntilBlock: number };

const FEE_FIELDS = ["relayer_account", "fee_recipient", "relay_fee", "gp", "px", "g_w", "valid_until_block"] as const;
const U128 = 1n << 128n;
const DEC = /^(0|[1-9][0-9]{0,38})$/;
const PX = /^(0|[1-9][0-9]{0,38})(\.[0-9]{1,39})?$/;

/** Asks the release's relayer for its fee and checks the answer against the release and the device's own fee_max. */
export async function askWithdrawFee(a: WithdrawFeeArgs): Promise<WithdrawFee> {
  const { token, relayer, feeMax, amount } = a;
  if (typeof token !== "string" || token.length === 0 || token.length > 64) throw new WithdrawRelayRefused("input", "token: not an account id");
  if (relayer === null || typeof relayer !== "object" || typeof relayer.relayer_account !== "string" || typeof relayer.fee_recipient !== "string")
    throw new WithdrawRelayRefused("input", "relayer: not the release's relayer");
  if (typeof feeMax !== "bigint" || feeMax < 0n) throw new WithdrawRelayRefused("input", "feeMax: not a bigint at or above 0");
  if (typeof amount !== "bigint" || amount <= 0n) throw new WithdrawRelayRefused("input", "amount: not a bigint above 0");
  const res = await (a.fetchFn ?? fetch)(`${WITHDRAW_FEE_URL}?token=${encodeURIComponent(token)}`, {
    ...HELPER_FETCH_INIT,
    redirect: "error",
    method: "GET",
    signal: a.signal ? AbortSignal.any([a.signal, AbortSignal.timeout(RELAY_TIMEOUT_MS)]) : AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  const body = await jsonOf(res);
  if (res.status !== 200) {
    const code = codeOf(body, res.status, []);
    throw new WithdrawRelayRefused("helper", code === null ? `HTTP ${res.status}, not a fee answer` : code);
  }
  if (!isObj(body) || Object.keys(body).length !== FEE_FIELDS.length || !FEE_FIELDS.every((k) => Object.hasOwn(body, k)))
    throw new WithdrawRelayRefused("answer", "not the fee answer's fields");
  const { relayer_account, fee_recipient, relay_fee, gp, px, g_w, valid_until_block } = body;
  if (typeof relay_fee !== "string" || !DEC.test(relay_fee) || BigInt(relay_fee) >= U128) throw new WithdrawRelayRefused("answer", "relay_fee: not a u128 decimal");
  if (typeof gp !== "string" || !DEC.test(gp) || typeof g_w !== "string" || !DEC.test(g_w)) throw new WithdrawRelayRefused("answer", "gp, g_w: not decimals");
  if (typeof px !== "string" || !PX.test(px)) throw new WithdrawRelayRefused("answer", "px: not a decimal");
  if (typeof valid_until_block !== "number" || !Number.isSafeInteger(valid_until_block) || valid_until_block <= 0)
    throw new WithdrawRelayRefused("answer", "valid_until_block: not a block height");
  // display only: equal to the release's, byte for byte, and never copied (HELPER_FEE_ANSWER_DISPLAY_ONLY)
  if (relayer_account !== relayer.relayer_account || fee_recipient !== relayer.fee_recipient)
    throw new WithdrawRelayRefused("relayer", "the answer names a relayer that is not the release's");
  const relayFee = BigInt(relay_fee);
  if (relayFee > feeMax) throw new WithdrawRelayRefused("fee", "relay_fee: above the device's fee_max");
  if (relayFee >= amount) throw new WithdrawRelayRefused("fee", "relay_fee: at or above the amount");
  return { relayFee, feeRecipient: relayer.fee_recipient, validUntilBlock: valid_until_block };
}

// ---------- the send ----------

/** The relayer's answer to one send, checked: submitted with a tx hash, or one of the frozen codes at its status. */
export type WithdrawAnswer = { ok: true; txHash: string } | { ok: false; code: HelperWithdrawCode | HelperCommonCode };

/** POSTs the body's bytes to the release's relayer; anything that is not a withdraw answer throws. */
export async function sendWithdraw(bytes: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<WithdrawAnswer> {
  const res = await fetchFn(WITHDRAW_URL, {
    ...HELPER_FETCH_INIT,
    redirect: "error",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bytes,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(RELAY_TIMEOUT_MS)]) : AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  const body = await jsonOf(res);
  if (res.status === 200 && isObj(body) && Object.keys(body).length === 2 && body.state === "submitted" && typeof body.tx_hash === "string") {
    let raw: Uint8Array | undefined;
    try {
      raw = base58.decode(body.tx_hash);
    } catch {
      raw = undefined;
    }
    if (raw?.length === 32) return { ok: true, txHash: body.tx_hash };
  }
  const code = codeOf(body, res.status, HELPER_WITHDRAW_CODES);
  if (code === null) throw new WithdrawRelayRefused("answer", `HTTP ${res.status}, not a withdraw answer`);
  return { ok: false, code: code as HelperWithdrawCode | HelperCommonCode };
}

// Busy or down: the same bytes go again next round (H3.4 check 5's index_behind says "the device resends").
const AGAIN = new Set<string>(["rate_limited", "upstream", "index_behind", "relayer_low", "token_halted"]);
// The relayer carries it or has: the pages settle it; the same bytes go again only after RELAY_RESEND_MS.
const CARRIED = new Set<string>(["in_flight"]);

export type RelayDeps = {
  notes: NoteStore;
  /** The release's vault. */
  vault: string;
  /** Two RPCs of different operators, for the vault's pages. */
  rpcs: readonly [VaultSyncRpc, VaultSyncRpc];
  /**
   * The newest final block on the same two RPCs: the lower height and the lower header.timestamp_nanosec (a decimal
   * string; never header.timestamp, never the device clock).
   */
  newestBlock: (signal?: AbortSignal) => Promise<{ height: number; timestampNanosec: string }>;
  /**
   * Where the pages are read from: a cursor a sync returned at or before the proof's tree read (every spend and leaf
   * of this withdrawal comes after it). vaultSyncStart(vault), the whole pages, unless given.
   */
  cursor?: VaultSyncCursor;
  fetchFn?: typeof fetch;
  /** The wait between rounds; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  resendMs?: number;
};

export type RelayOutcome =
  /** The pages on both RPCs hold the spend and this seed's change leaf: the change is UNSPENT, the note SPENT. */
  | { kind: "landed"; own: boolean; change: NoteRecord; spend: VaultSpendRow }
  /**
   * Block time is past deadline_ms and the pages hold no spend of the note: it is UNSPENT again. route "self_submit"
   * when the relayer answered withdraw_failed (H3.6 route 2), else "relayer".
   */
  | { kind: "expired"; note: NoteRecord; route: "relayer" | "self_submit"; lastAnswer: string | null }
  /** The pages hold a spend of the note whose change leaf is not this seed's: nothing written, the note stays RESERVED. */
  | { kind: "unmatched"; spend: VaultSpendRow };

/**
 * Sends a RESERVED withdrawal to the release's relayer and follows it until the vault's pages, on two RPCs, show its
 * spend (the change note is written then, and only then) or block time passes its deadline_ms with nothing landed.
 * deps.signal stops it with nothing written: the note stays RESERVED and a later call picks up from the pages.
 */
export async function relayWithdraw(seed64: Uint8Array, req: WithdrawRequest, deps: RelayDeps): Promise<RelayOutcome> {
  if (!(seed64 instanceof Uint8Array) || seed64.length !== 64) throw new WithdrawRelayRefused("input", "seed64: not 64 bytes");
  const seed = Uint8Array.from(seed64);
  let precommitment: bigint;
  try {
    if (req === null || typeof req !== "object" || req.change?.kind !== "change") throw new WithdrawRelayRefused("input", "req: not a withdraw request");
    precommitment = noteSecrets(seed, req.change).precommitment;
  } finally {
    seed.fill(0);
  }
  const { notes, vault, rpcs, newestBlock, signal } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const pollMs = deps.pollMs ?? RELAY_POLL_MS;
  const resendRounds = Math.max(1, Math.ceil((deps.resendMs ?? RELAY_RESEND_MS) / pollMs));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const { body, noteId, change } = req;
  const signals = body?.public_signals;
  if (!Array.isArray(signals) || signals.length !== 8 || !signals.every((s) => typeof s === "string" && DEC_FIELD.test(s)))
    throw new WithdrawRelayRefused("input", "req.body: public_signals are not 8 decimals");
  const deadline = body.withdrawal?.deadline_ms;
  if (!Number.isSafeInteger(deadline)) throw new WithdrawRelayRefused("input", "req.body: deadline_ms is not a whole number");
  const nullifierHash = BigInt(signals[1]!);
  const bytes = JSON.stringify(body);
  if (new TextEncoder().encode(bytes).length > WITHDRAW_BODY_MAX!) throw new WithdrawRelayRefused("input", `req.body: over ${WITHDRAW_BODY_MAX} bytes`);

  // The note: RESERVED by this very attempt. One another tab or an earlier call settled is SPENT or UNSPENT by now.
  const note = await notes.get(noteId);
  if (note === undefined || note.leaf === undefined) throw new WithdrawRelayRefused("note", "the note is not in the store");
  const label = note.leaf.label;
  if (change.l !== label) throw new WithdrawRelayRefused("note", "the change note is not of the note's label");
  const last = note.contexts?.[note.contexts.length - 1];
  if (note.state !== "RESERVED" || last === undefined || last.context !== signals[7] || last.deadlineMs !== BigInt(deadline) || note.deadlineMs !== BigInt(deadline))
    throw new WithdrawRelayRefused("note", "the note is not RESERVED by this attempt: nothing of it is sent");

  let cursor: VaultSyncCursor = deps.cursor ?? vaultSyncStart(vault);
  const leaves = new Map<bigint, bigint>(); // leaf index -> leaf, every leaf both RPCs gave since the cursor
  let sending = true;
  let waitRounds = 0;
  let route: "relayer" | "self_submit" = "relayer";
  let lastAnswer: string | null = null;
  for (;;) {
    signal?.throwIfAborted();
    // 1. Block time first, then the pages at or above that block: a spend that can still land is in them.
    let block: { height: number; timeMs: bigint } | null = null;
    try {
      const b = await newestBlock(signal);
      if (!Number.isSafeInteger(b.height) || b.height <= 0) throw new Error("not a height");
      block = { height: b.height, timeMs: BigInt(blockTimeMsOf(b.timestampNanosec)) };
    } catch {
      signal?.throwIfAborted();
    }
    let spend: VaultSpendRow | undefined;
    let read = false;
    if (block !== null) {
      try {
        const s = await vaultSync({ vault, rpcs, cursor: { ...cursor, height: Math.max(cursor.height, block.height) }, lists: ["spends", "leaves"], ...(signal ? { signal } : {}) });
        s.leaves.forEach((x, k) => leaves.set(BigInt(cursor.leaves + k), x));
        spend = s.spends.find((r) => r.nullifierHash === nullifierHash);
        cursor = s.cursor;
        read = true;
      } catch {
        signal?.throwIfAborted(); // one RPC down, behind or disagreeing: nothing is concluded this round
      }
    }

    // 2. Confirm first: the change is written only from the pages both RPCs gave.
    if (spend !== undefined) {
      const value = note.leaf.value - spend.withdrawn;
      const commitment = value >= 0n ? noteCommitment(value, label, precommitment) : null;
      if (commitment === null || leaves.get(spend.newLeafIndex) !== commitment) return { kind: "unmatched", spend };
      const own = (note.contexts ?? []).some((c) => c.context === spend.context.toString());
      const leaf = { value, label, commitment, leafIndex: spend.newLeafIndex };
      return { kind: "landed", own, change: await recordChange(notes, note, change, precommitment, leaf), spend };
    }

    // 3. Nothing landed: block time past deadline_ms, and the pages read at or above that block hold no spend.
    if (read && block!.timeMs > BigInt(deadline)) {
      try {
        const freed = await notes.move(noteId, "RESERVED", "UNSPENT", { blockTimeMs: block!.timeMs });
        return { kind: "expired", note: freed, route, lastAnswer };
      } catch (e) {
        const now = await notes.get(noteId); // another tab freed it first, or a spend it read settled it
        if (now?.state === "UNSPENT") return { kind: "expired", note: now, route, lastAnswer };
        throw e;
      }
    }

    // 4. The send: the same bytes, while the relayer's check 9 still takes them.
    if (sending && block !== null && block.timeMs + BigInt(WITHDRAW_SEND_MARGIN_MS) < BigInt(deadline) && waitRounds <= 0) {
      try {
        const a = await sendWithdraw(bytes, fetchFn, signal);
        lastAnswer = a.ok ? "submitted" : a.code;
        if (a.ok || CARRIED.has(a.code)) waitRounds = resendRounds;
        else if (!AGAIN.has(a.code)) {
          sending = false; // a check refused it: the pages and the deadline settle the note
          if (a.code === "withdraw_failed") route = "self_submit";
        }
      } catch {
        signal?.throwIfAborted(); // no answer: the same bytes go again next round
      }
    }
    waitRounds -= 1;
    await sleep(pollMs);
  }
}

// ---------- the change note ----------

const DEC_FIELD = /^(0|[1-9][0-9]{0,77})$/;

// The note's change already in the store (another tab or an earlier call recorded it), or undefined.
async function changeIn(notes: NoteStore, note: NoteRecord, change: WithdrawRequest["change"]): Promise<NoteRecord | undefined> {
  const key = refKey(change);
  return (await notes.list()).find((n) => n.scope === note.scope && refKey(n.ref) === key);
}

// add(child, parent): the change UNSPENT naming the spent note, which goes SPENT with it. A change another tab wrote
// first between the read and the write is taken when it holds this very leaf.
async function recordChange(
  notes: NoteStore,
  note: NoteRecord,
  change: WithdrawRequest["change"],
  precommitment: bigint,
  leaf: { value: bigint; label: bigint; commitment: bigint; leafIndex: bigint },
): Promise<NoteRecord> {
  const same = (n: NoteRecord | undefined): n is NoteRecord =>
    n !== undefined && n.precommitment === precommitment && n.leaf?.commitment === leaf.commitment && n.leaf.leafIndex === leaf.leafIndex;
  try {
    return await notes.add({ ref: change, scope: note.scope, precommitment, state: "UNSPENT", parent: note.id, leaf });
  } catch (e) {
    const there = await changeIn(notes, note, change);
    if (same(there)) return there;
    throw e;
  }
}

// ---------- answers ----------

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

// The body as JSON, read up to RELAY_ANSWER_MAX_BYTES; undefined when it is not JSON.
async function jsonOf(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > RELAY_ANSWER_MAX_BYTES) throw new WithdrawRelayRefused("answer", `an answer over ${RELAY_ANSWER_MAX_BYTES} B`);
  if (res.body === null) return undefined;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > RELAY_ANSWER_MAX_BYTES) {
      await reader.cancel();
      throw new WithdrawRelayRefused("answer", `an answer over ${RELAY_ANSWER_MAX_BYTES} B`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(out));
  } catch {
    return undefined;
  }
}

// { error: { code } } exactly, the code one of `codes` or a common one, at its own HTTP status (400 when unlisted).
function codeOf(body: unknown, status: number, codes: readonly string[]): string | null {
  if (!isObj(body) || Object.keys(body).length !== 1 || !isObj(body.error) || Object.keys(body.error).length !== 1) return null;
  const code = body.error.code;
  if (typeof code !== "string" || !(codes.includes(code) || (HELPER_COMMON_CODES as readonly string[]).includes(code))) return null;
  const want = Object.hasOwn(HELPER_CODE_STATUS, code) ? HELPER_CODE_STATUS[code as keyof typeof HELPER_CODE_STATUS] : 400;
  return status === want ? code : null;
}
