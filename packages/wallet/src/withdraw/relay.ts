// One withdrawal through the release's relayer, from its fee to its change note (card wallet-withdraw-relay; lane W2.4,
// docs/plan1/wallet.md l.1115; the relayer's paths, markets.md l.3346-3348, and its fee rule, LD5 l.1052-1075; its
// route 1 and the self-submit fallback, markets.md H3.6 l.1509-1524; at research 8e9352d). Everything of Blindfill
// comes from the kit's public entry; the paths and their answers are the kit's frozen helper API (helper/v1.ts).
//
// - The fee (askWithdrawFee): GET /v1/withdraw/fee?token=<id> on the release's helper. The answer is hostile input:
//   exactly the frozen fields, each in its form; relayer_account and fee_recipient equal to the release's, byte for
//   byte (HELPER_FEE_ANSWER_DISPLAY_ONLY: shown, never copied); relay_fee a canonical u128 below the amount. No caller
//   names fee_max (an argument that tries is refused): the device's own (./feemax.ts, LD5's formula on its own reads)
//   bounds the fee where it is bound, in withdrawRequest before the proof, and again here before the first send (the
//   §2.8 arming row, wallet.md l.915). What goes into the withdrawal is the release's fee_recipient, never the answer's.
// - The send (relayWithdraw): POST /v1/withdraw with the request withdrawRequest made, as one fixed string of bytes,
//   sent again unchanged and never re-proved (wallet.md l.990: a retry never re-signs). It is sent only while the
//   note is RESERVED by exactly this attempt (its last context and deadline_ms are the body's: WU-06, nothing leaves
//   before the store has it), and only while the pages' block time + WITHDRAW_SEND_MARGIN_MS is below deadline_ms
//   (H3.4 check 9, markets.md l.1376-1377, 120 s since every request funds A), so nothing is sent while the two RPCs
//   disagree. The answer counts only as one of the frozen codes with its own HTTP status, or 200 {tx_hash, state:
//   "submitted"}; anything else is no answer. A busy or down answer (rate_limited, upstream, index_behind,
//   relayer_low, token_halted, no answer) sends the same bytes again on the next round; submitted or in_flight waits
//   RELAY_RESEND_MS for the pages before the same bytes go again, so a relayer that says submitted and
//   drops the call costs time, never the withdrawal (route 1, markets.md l.1511-1517). withdraw_failed ends the
//   sends and names route 2, self-submit (l.1518-1524: the exit tool, from the 12 words); every other code ends them.
//   Before the first send the device reads its own fee_max (./feemax.ts) for the body's register_deposit; a body whose
//   relay_fee is above it is never sent (lastAnswer "fee_max"), and the pages and the deadline settle the note.
// - Confirm first (wallet.md l.424's rule for deposits, here for the change; §2.3 "own" l.227-230): the change
//   note is written only once the vault's spends and leaves pages, read on two RPCs at one block and matched byte for
//   byte (the kit's vaultSync), hold a spend of this note's nullifier hash and, at its new_leaf_index, the change leaf
//   this seed gives: Poseidon(value, l, precommitment of change note j), value = the note's less the spend's
//   withdrawn. Never on the relayer's answer, a tx hash or one RPC. The store's add(child, parent) then writes the
//   change UNSPENT and moves the spent note to SPENT (../notes/store.ts). The spend is "own" when its context is one
//   this device recorded on the note (l.227-228); another device's spend of the note still makes this seed's change
//   note j of label l (its secrets come from (l, j), wallet.md l.176-178), so it is recorded too, with own false: the
//   caller then signs nothing from A (l.231-234).
// - Nothing landed: only once the pages, equal on both RPCs at one block, hold no spend of the note and that very block's
//   own time is past deadline_ms does the note go RESERVED -> UNSPENT (the store's own rule, wallet.md l.201; the vault
//   refuses a withdrawal past its deadline_ms, V@93b827c:354). The time is the header.timestamp_nanosec of the block the
//   pages were read at (vaultSync's height), read on both RPCs, its hash the pages' block hash on both and its time equal
//   on both: any receipt the vault took ran in an earlier block, so its spend is in those pages. No other block's time
//   counts, so an RPC that reports a low height with a late time frees nothing. The spends are read from the vault's
//   first row on every call (vaultSyncStart), never from a caller's cursor, so no spend can sit before the read. While
//   the RPCs disagree, or one is down, nothing is concluded either way, past the deadline too. A spend whose change
//   leaf is not this seed's (no leaf at its index in the rows read, or another commitment) records nothing and frees
//   nothing: the note stays RESERVED for restore's walk.
// - The two RPCs are a release pair (../deposit/account.ts nearPairNetwork: one FastNEAR URL and the dRPC URL of the
//   network), so one operator never counts as two; the vault is the release's for that network, never an argument.
// - The seed is copied and the copy zeroed before the first await. Nothing here logs. The relayer gets the request's
//   body alone: the withdrawal data, the proof and its public signals, none of which names another note or a key.
//
// Not here: the refund note a settle writes, the "own" act on
// A (the arming card), a withdrawal across several notes (WM-06), the busy answer's Retry-After (WU-08), and route 2
// itself (the exit tool, packages/exit).
import {
  HELPER_CODE_STATUS,
  HELPER_COMMON_CODES,
  HELPER_FETCH_INIT,
  HELPER_RPC_METHODS,
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
import { NEAR_NETWORKS, type NearNetwork, nearPairNetwork, nearPairRule, nearRpc, RPC_TIMEOUT_MS } from "../deposit/account.ts";
import { noteCommitment, noteSecrets } from "../notes/secrets.ts";
import { FeeMaxRefused, type FeeRpc, readWithdrawFeeMax } from "./feemax.ts";
import { type NoteRecord, type NoteStore, refKey } from "../notes/store.ts";
import { blockTimeMsOf, WITHDRAW_SEND_MARGIN_MS, type WithdrawRequest } from "./request.ts";
import { POOL_TESTNET } from "../pool/network.ts";

/** The release's helper (the signing page's CSP lets it reach no other, packages/signpage/public/_headers). */
export const RELEASE_HELPER = "https://ct-api.unrealized.trade";
/**
 * The release's withdrawal relayer on each network (HelperReleaseRelayer: what askWithdrawFee checks the fee answer
 * against and what the withdrawal pays its fee to), written here and never read from a helper; null where the release
 * names none, and no withdrawal is asked there (card signpage-withdraw-handoff). Testnet: VT-T02's R and F
 * (contracts/vault/deployments/testnet-t02-run.json), the pair the deployed helper's GET /v1/withdraw/fee names for the
 * testnet token (read 2026-11-06 15:58Z; R and F in that run record). Mainnet: none until the release's relayer is written with its vault.
 * Testnet's pair is the testnet build's only (POOL_TESTNET, as ../pool/solana.ts folds the devnet pins): SIGN_HOST's
 * build folds it to null and carries neither id. Node and the tests read it with __SIGN_NETWORK__ = "testnet" set.
 */
export const RELEASE_WITHDRAW_RELAYER: Readonly<Record<NearNetwork, HelperReleaseRelayer | null>> = Object.freeze({
  mainnet: null,
  testnet: POOL_TESTNET
    ? Object.freeze({
        relayer_account: "r-2b700409.bf-vt-20261102t071444.testnet", // gitleaks:allow (a public account id)
        fee_recipient: "f-2b700409.bf-vt-20261102t071444.testnet", // gitleaks:allow (a public account id)
      })
    : null,
});
export const WITHDRAW_FEE_URL = `${RELEASE_HELPER}/v1/withdraw/fee`;
export const WITHDRAW_URL = `${RELEASE_HELPER}/v1/withdraw`;
/** Both answers are small (the frozen limits are 1 KB for the fee path); a longer one is refused unread. */
export const RELAY_ANSWER_MAX_BYTES = 1_024;
export const RELAY_TIMEOUT_MS = 10_000;
/** The wait between rounds: one pages read and its block's time, at most one send. */
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

/** Asks the release's relayer for its fee and checks the answer against the release; the device's fee_max bounds it later. */
export async function askWithdrawFee(a: WithdrawFeeArgs): Promise<WithdrawFee> {
  if (a !== null && typeof a === "object" && Object.hasOwn(a, "feeMax")) throw new WithdrawRelayRefused("input", "feeMax: the device computes its own fee cap");
  const { token, relayer, amount } = a;
  if (typeof token !== "string" || token.length === 0 || token.length > 64) throw new WithdrawRelayRefused("input", "token: not an account id");
  if (relayer === null || typeof relayer !== "object" || typeof relayer.relayer_account !== "string" || typeof relayer.fee_recipient !== "string")
    throw new WithdrawRelayRefused("input", "relayer: not the release's relayer");
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
  if (relayFee >= amount) throw new WithdrawRelayRefused("fee", "relay_fee: at or above the amount");
  return { relayFee, feeRecipient: relayer.fee_recipient, validUntilBlock: valid_until_block };
}

// ---------- the send ----------

/** The relayer's answer to one send, checked: submitted with a tx hash, or one of the frozen codes at its status. */
export type WithdrawAnswer = { ok: true; txHash: string } | { ok: false; code: HelperWithdrawCode | HelperCommonCode };

// POSTs the body's bytes to the release's relayer. Module-private: relayWithdraw is the only sender, so nothing is sent
// without its note and fee_max checks.
async function sendWithdraw(bytes: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<WithdrawAnswer> {
  const res = await fetchFn(WITHDRAW_URL, {
    ...HELPER_FETCH_INIT,
    redirect: "error",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bytes,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(RELAY_TIMEOUT_MS)]) : AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  return withdrawAnswerOf(res);
}

/** The relayer's answer to a send, read: submitted with a tx hash, or a frozen code at its status; anything else throws. */
export async function withdrawAnswerOf(res: Response): Promise<WithdrawAnswer> {
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

/** A NEAR provider for the pages (`query`) and for one block's header (`block`), named by its exact URL. */
export interface RelayRpc extends VaultSyncRpc, FeeRpc {
  block(params: { block_id: number } | { finality: "final" }, signal?: AbortSignal): Promise<unknown>;
}
const BLOCK_METHOD = "block";
if (!(HELPER_RPC_METHODS.near as readonly string[]).includes(BLOCK_METHOD)) throw new Error(`"${BLOCK_METHOD}" is not on the kit's NEAR method list`);

/** A provider by URL, for both `query` (nearRpc) and `block`. A status other than 200 or no answer in time throws. */
export function relayRpc(url: string, fetchFn: typeof fetch = fetch, timeoutMs = RPC_TIMEOUT_MS): RelayRpc {
  const q = nearRpc(url, fetchFn, timeoutMs);
  return {
    name: q.name,
    query: (params) => q.query(params),
    async block(params, signal) {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "blindfill", method: BLOCK_METHOD, params }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
  };
}

export type RelayDeps = {
  notes: NoteStore;
  /** The release's network: its vault and its RPC pair. */
  network: NearNetwork;
  /** The network's release pair (nearPairNetwork), for the vault's pages and the time of the block they are read at. */
  rpcs: readonly [RelayRpc, RelayRpc];
  /** Mainnet's release pair, for the price pool of the device's fee_max (./feemax.ts); rpcs again on mainnet. */
  priceRpcs: readonly [RelayRpc, RelayRpc];
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
  const { notes, network, rpcs, priceRpcs, signal } = deps;
  if (typeof network !== "string" || !Object.hasOwn(NEAR_NETWORKS, network)) throw new WithdrawRelayRefused("input", `unknown network ${String(network)}`);
  const vault = NEAR_NETWORKS[network].vault;
  if (vault === null) throw new WithdrawRelayRefused("input", `the release names no vault on ${network}`);
  if (nearPairNetwork(rpcs) !== network || !rpcs.every((r) => typeof r.block === "function")) throw new WithdrawRelayRefused("input", nearPairRule(network));
  if (nearPairNetwork(priceRpcs) !== "mainnet" || !priceRpcs.every((r) => typeof r.block === "function"))
    throw new WithdrawRelayRefused("input", `priceRpcs: ${nearPairRule("mainnet")}`);
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
  const relayFee = body.withdrawal?.relay_fee;
  const registerDeposit = body.withdrawal?.register_deposit;
  if (typeof relayFee !== "string" || !DEC_FIELD.test(relayFee) || typeof registerDeposit !== "string" || !DEC_FIELD.test(registerDeposit))
    throw new WithdrawRelayRefused("input", "req.body: relay_fee or register_deposit is not a decimal");
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

  let cursor: VaultSyncCursor = vaultSyncStart(vault); // every spend from the first: none can sit before the read
  const leaves = new Map<bigint, bigint>(); // leaf index -> leaf, every leaf both RPCs gave since the cursor
  let sending = true;
  let waitRounds = 0;
  let route: "relayer" | "self_submit" = "relayer";
  let lastAnswer: string | null = null;
  let feeMax: bigint | undefined; // the device's own, read before the first send
  for (;;) {
    signal?.throwIfAborted();
    // 1. The pages on both RPCs at one block, then that same block's time on both.
    let spend: VaultSpendRow | undefined;
    let timeMs: bigint | null = null;
    try {
      const s = await vaultSync({ vault, rpcs, cursor, lists: ["spends", "leaves"], ...(signal ? { signal } : {}) });
      s.leaves.forEach((x, k) => leaves.set(BigInt(cursor.leaves + k), x));
      spend = s.spends.find((r) => r.nullifierHash === nullifierHash);
      cursor = s.cursor;
      timeMs = await blockTimeAt(rpcs, s.height, s.blockHash, signal);
    } catch {
      signal?.throwIfAborted(); // one RPC down, behind or disagreeing: nothing is concluded this round
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

    // 3. Nothing landed: the pages hold no spend, and the time of the block they were read at is past deadline_ms.
    if (timeMs !== null && timeMs > BigInt(deadline)) {
      try {
        const freed = await notes.move(noteId, "RESERVED", "UNSPENT", { blockTimeMs: timeMs });
        return { kind: "expired", note: freed, route, lastAnswer };
      } catch (e) {
        const now = await notes.get(noteId); // another tab freed it first, or a spend it read settled it
        if (now?.state === "UNSPENT") return { kind: "expired", note: now, route, lastAnswer };
        throw e;
      }
    }

    // 4. The send: the same bytes, while the relayer's check 9 still takes them.
    if (sending && feeMax === undefined && timeMs !== null) {
      try {
        feeMax = await readWithdrawFeeMax({ network, rpcs, priceRpcs, registerDeposit: BigInt(registerDeposit), ...(signal ? { signal } : {}) });
      } catch (e) {
        signal?.throwIfAborted(); // the reads failed or disagreed: nothing is sent this round
        if (e instanceof FeeMaxRefused && e.code === "input") throw new WithdrawRelayRefused("input", e.message);
      }
      if (feeMax !== undefined && BigInt(relayFee) > feeMax) {
        sending = false; // above the device's own cap: never sent; the pages and the deadline settle the note
        lastAnswer = "fee_max";
      }
    }
    if (sending && feeMax !== undefined && timeMs !== null && timeMs + BigInt(WITHDRAW_SEND_MARGIN_MS) < BigInt(deadline) && waitRounds <= 0) {
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

// The time of block `height` on both RPCs, in ms: its header names that height and `hash` on each, and the two
// timestamp_nanosec strings are equal. Anything else throws.
async function blockTimeAt(rpcs: readonly [RelayRpc, RelayRpc], height: number, hash: string, signal?: AbortSignal): Promise<bigint> {
  const one = async (r: RelayRpc): Promise<string> => {
    const a = await r.block({ block_id: height }, signal);
    const header = isObj(a) && a.error === undefined && isObj(a.result) ? a.result.header : undefined;
    if (!isObj(header) || header.height !== height || header.hash !== hash || typeof header.timestamp_nanosec !== "string")
      throw new Error(`${r.name}: block ${height}: not the pages' block`);
    return header.timestamp_nanosec;
  };
  const [x, y] = await Promise.all([one(rpcs[0]), one(rpcs[1])]);
  if (x !== y) throw new Error(`block ${height}: the RPCs' times differ`);
  return BigInt(blockTimeMsOf(x));
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
