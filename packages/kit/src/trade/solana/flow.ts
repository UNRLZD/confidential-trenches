// The Solana trade on the device, joined (markets paper §6.1 rows M1.1-M1.3, T1.3 the standard-size set, T2.1, LD1).
// One call takes the user's request and the set's wallets and runs: the device's own reads on two providers, one build
// per wallet through the helper's Jupiter proxy (build.ts), the assembly on the device's own blockhash and tables, the
// checks S1-S13 on the bytes about to be signed (checks.ts), the signatures (the caller's signer, on the device), the
// send on every path at once and the fill read on two providers (send.ts); after a sell of a wallet's whole balance,
// the teardown frames (06c S-4, S-5; build.ts, checks.ts). Nothing from the helper or the build is trusted for what is
// signed: every leg signs only bytes that passed checkSolanaQuote on the device's own reads.
//
// - Wallets: the kit cannot see the wallet store, so it takes the caller's arm records: a leg whose record does not say
//   its arm (l, j) is the device's own withdrawal (wallet.md §2.3) is refused before anything is read for it. What
//   refuses a wallet this device did not arm is the wallet's signer on the signing page ("Buy from fresh wallets"),
//   which holds the arm records and signs nothing else; the kit never takes the caller's word as that refusal.
// - Blockhash: getLatestBlockhash at `finalized` on both providers; the read from the lower slot is used, so both
//   providers already hold it, with that read's own lastValidBlockHeight. A trade not signed within
//   SOLANA_BLOCKHASH_REFRESH_MS of that read (its builds waited for the helper's room) reads every leg's pre-state and
//   simulation again, then last, together, the set's reference and a blockhash both providers answer valid, and checks
//   each leg's tx on it again, its minOut held to the fresh E, before signing (renewSet).
// - Floors (T1.3): E(A) is the device's own pool read for the whole size A = Σ a_k (the caller's `reference`, never
//   the helper or the route); each wallet's floor is minOut_k = ⌊E_k × (1 − s)⌋ with E_k = ⌊E(A) × a_k / A⌋, while
//   S12 holds its simulated out to E(a_k), its own exact input priced from the same read (no extra read). The build is asked at the user's s; if the route's decoded floor is under minOut_k, it is asked once
//   more at the slippage that puts the floor on minOut_k, and refused if the route's quoted out is not above minOut_k.
// - Reads that gate a signature, all on both providers (LD1): the build's lookup tables, the mint, the rents in play,
//   the wallet's balances and the simulation (sigVerify off, the blockhash replaced) with its post-state.
// - One wallet a request (wallet.md §2.9 request table, rows 8 and 15): every read, simulation and status read names
//   one wallet and its own accounts only, never two of the user's wallets. That another wallet is untouched is S11's
//   static rule over the tx's keys, against the caller's full list of the user's wallets (`wallets`), not a read.
// - One queue a provider (send.ts solanaPacedRpc): every call of the trade on a provider, the settle reads and every
//   teardown's included, is in that provider's one queue, held to its published limit (SOLANA_KEYLESS_RPC_LIMIT) or to
//   a keyed provider's providerRps.
// - Fill: sendSolanaSet's two-provider rule. A tx still "unknown" at the send's deadline is read again on both
//   providers (searchTransactionHistory); it is filled or failed only when both say so, and otherwise stays unknown:
//   never a fill, never dead, and no teardown runs behind it.
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  checkSolanaQuote,
  checkSolanaTeardown,
  solanaVolumeAccumulator,
  SOLANA_PUMP_AMM_PROGRAM,
  SOLANA_PUMP_PROGRAM,
  solanaRouteAmounts,
  solanaTeardownAddresses,
  solanaTeardownPlan,
  SolanaWalletLinks,
  type SolanaAccountRead,
  type SolanaHeldRead,
  type SolanaQuoteVerdict,
  type SolanaSimulation,
  type SolanaTeardownVerdict,
} from "../../checks/solana/checks.ts";
import { SOLANA_ALT_PROGRAM, solanaAta, solanaDecodeLookupTable, type SolanaLookupTable } from "../../checks/solana/message.ts";
import {
  SolanaBuildError,
  SolanaBuildRoom,
  assembleSolanaSwap,
  buildSolanaTeardown,
  fetchSolanaJupiterBuild,
  fetchSolanaJupiterBuildThatFits,
  readSolanaBlockhash,
  simulateSolanaTeardown,
  solanaWithBlockhash,
  type SolanaAssembled,
  type SolanaBlockhash,
  type SolanaBuildRequest,
  type SolanaCapStep,
  type SolanaJupiterBuild,
} from "./build.ts";
import { dryRunSolanaSet, sendSolanaSet, solanaPacedRpc, solanaProviderLimits, solanaSameProvider, type SolanaProviderRps, type SolanaDryTx, type SolanaFetch, type SolanaRpc, type SolanaSendPath, type SolanaTxOutcome } from "./send.ts";

export type SolanaTradeLeg = {
  readonly wallet: string;
  /** a_k: lamports on a buy, the token's base units on a sell. */
  readonly amount: bigint;
  /** The wallet's arm (l, j): `own` is true only when its funding was this device's own withdrawal (wallet.md §2.3). */
  readonly arm: { readonly own: boolean };
};
export type SolanaTradeRequest = {
  readonly side: "buy" | "sell";
  readonly token: string;
  /** s, the user's slippage. */
  readonly slippageBps: number;
  readonly legs: readonly SolanaTradeLeg[];
  /** Every Solana wallet of this user, the set's and all others (the signing page holds every arm record): S11
   * refuses a leg whose tx names any other one of them or its accounts. Each leg's wallet must be in it. */
  readonly wallets: readonly string[];
  /** Mints the user's wallets hold, when the caller names them: S11 also refuses any other wallet's token account for
   * these, though the tx names no such mint. */
  readonly heldMints?: readonly string[];
};
export type SolanaTradeStage = "signed" | "sent" | "filled" | "part_filled" | "refused" | "not_landed";
/** `built`: legs whose build is done (fitted or refused); `waiting`: legs waiting for the helper's room now; `total`:
 * the legs being built. */
export type SolanaBuildsProgress = { built: number; waiting: number; total: number };
/**
 * The longest a trade's builds wait for the helper's room (card solana-legs-share-wait): a 64-leg trade on Jupiter's
 * Free plan, one device lent about 14 builds a minute (apps/helper/src/limits/limits.ts: the callers' 26 less
 * LEND_NEW_SHARES 3 x the share 4), asks 64 builds plus a floor rebuild for some legs, 64 to 128: 4.6 to 9.1 minutes;
 * 10 minutes is that and a margin. A wait that would end past it refuses its leg.
 */
export const SOLANA_TRADE_BUILD_WAIT_MS = 10 * 60_000;
/**
 * The oldest the trade's blockhash may be when its legs are signed. A finalized blockhash is about 32 slots old when
 * read and a tx on it lands for 150 slots, about 47 s after the read at 400 ms a slot; past 20 s the send would have
 * under half of that, so a trade whose builds waited longer reads its pre-states and simulations again, then its
 * reference and a fresh blockhash, and checks every leg again on them before any is signed (renewSet). A trade signed within 20 s reads nothing more.
 */
export const SOLANA_BLOCKHASH_REFRESH_MS = 20_000;
export type SolanaTradeDeps = {
  /** The helper's origin, for the Jupiter build proxy. */
  readonly helper: string;
  /** Provider A (device-direct) and provider B (LD1). */
  readonly providers: readonly [SolanaRpc, SolanaRpc];
  /** S12's reference from the device's own pool read (pool.ts readSolanaReference): expectedOut = E(A) for the whole
   * size A, expectedOuts = E(a_k) for each leg's exact input from the same read; null when there is no reference pool. */
  readonly reference: (q: { side: "buy" | "sell"; token: string; amount: bigint; amounts: readonly bigint[] }, providers: readonly [SolanaRpc, SolanaRpc]) => Promise<{ expectedOut: bigint; expectedOuts?: readonly bigint[] } | null>;
  /** Signs a message with the wallet's key, on the device; answers the 64-byte ed25519 signature. Unused when dry.
   * `lastValidBlockHeight` is the height of the very tx signed: past it the tx can never land, so the signer can free
   * the wallet once its chain passes it. */
  readonly sign?: (wallet: string, message: Uint8Array, tx: { readonly lastValidBlockHeight: number }) => Promise<Uint8Array>;
  readonly paths: readonly SolanaSendPath[];
  /** Simulate the signed set instead of sending it (row M1.3's --dry): no key is used and nothing is sent. */
  readonly dry?: boolean;
  readonly fetch?: SolanaFetch;
  readonly now?: () => number;
  readonly onProgress?: (stage: SolanaTradeStage) => void;
  /** The legs' builds while they wait for the helper's room (card solana-legs-share-wait): the state the app shows
   * during a long trade, called when a leg's build lands or a leg starts or ends a wait. */
  readonly onBuilds?: (p: SolanaBuildsProgress) => void;
  /** The legs' signatures the kit kept, in send order: only those, each a leg's signature that passed the age rule at
   * its signature (card kit-renewal-read-bounded) and is about to be sent; a signature the kit dropped as late is never
   * in it, nor is a teardown frame's. Called once, right before onProgress("signed"), and not at all when no leg is
   * kept. Optional: a caller that does not pass it sees the trade as before. */
  readonly onSigned?: (signed: readonly { wallet: string; signature: string }[]) => void;
  /** The wait's sleep, for tests (with `now`, the clock the trade's bound is held on). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** sendSolanaSet's deadline, for tests. */
  readonly deadlineMs?: number;
  readonly pollMs?: number;
  /** A keyed provider's requests a second, every call of the trade on it counted (sendSolanaSet's providerRps; a
   * provider not named here is held to SOLANA_KEYLESS_RPC_LIMIT). A keyed provider names its own plan's rate. */
  readonly providerRps?: SolanaProviderRps;
  /** One SolanaWalletLinks the caller keeps across trades: each trade grows it only by new wallets and new keys, so its
   * cost does not grow with use. A trade without one builds its own. */
  readonly links?: SolanaWalletLinks;
};

export type SolanaLegRecord = {
  wallet: string;
  amount: bigint;
  /** E_k and minOut_k, both from the device's own E(A). */
  expectedOut: bigint | null;
  minOut: bigint | null;
  /** E(a_k), this leg's own input priced from the same read: S12's bar for the simulated out. */
  legExpectedOut?: bigint;
  /** Why the leg was not signed, when it was not. */
  refused?: string;
  /** From the first build call to the assembled, checked bytes. */
  quoteMs?: number;
  /** The build: the cap search (fetchSolanaJupiterBuildThatFits) with each step's table reads and assembly, and the floor's rebuild when it asked one. */
  buildMs?: number;
  buildCalls?: number;
  /** The cap search's steps: each cap asked and what the device's assembly made of it. */
  buildCaps?: SolanaCapStep[];
  /** A sell of the wallet's whole balance, on both providers' pre-state: the teardown follows its fill. */
  sellsAll?: boolean;
  /** Why a provider gave no simulation, when one did not. */
  simulationErrors?: string[];
  size?: number;
  /** The checks on the bytes signed, or about to be: after a renewal, the renewal's own, or none when the renewal refused
   * the leg before its check. */
  verdict?: SolanaQuoteVerdict;
  /** A renewed leg's first check, on the trade's first blockhash and reads. */
  firstVerdict?: SolanaQuoteVerdict;
  /** A renewed leg's reference, read again at the renewal for the same set: E_k and E(a_k) now (expectedOut and
   * legExpectedOut keep the first read, which set minOut). */
  renewedReference?: { expectedOut: bigint; legExpectedOut: bigint };
  signature?: string;
  outcome?: SolanaTxOutcome;
  dry?: SolanaDryTx;
  /** The unknown-at-deadline re-read, when one ran. */
  reread?: { state: "filled" | "failed" | "unknown"; reads: readonly [unknown, unknown] };
  teardown?: { verdict: SolanaTeardownVerdict; frames: number; outcomes?: SolanaTxOutcome[]; dry?: SolanaDryTx[]; refused?: string };
};
/** `blockhash` is the one the legs are signed on; `firstBlockhash` the trade's first read, when that one grew old before
 * the signatures and a fresh one replaced it (SOLANA_BLOCKHASH_REFRESH_MS); `renewedReference` E(A) read again then
 * (`reference` stays the first read, which set every leg's minOut). */
export type SolanaTradeRecord = { side: "buy" | "sell"; token: string; reference: bigint | null; blockhash: SolanaBlockhash | null; firstBlockhash?: SolanaBlockhash; renewedReference?: bigint; legs: SolanaLegRecord[] };

const isKey = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return false;
  try {
    return base58.decode(v).length === 32;
  } catch {
    return false;
  }
};
const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what} is not an object`);
  return v as Record<string, unknown>;
};
type Acc = { owner: string; lamports: bigint; data: Uint8Array };
function account(v: unknown, what: string): Acc | null {
  if (v === null) return null;
  const o = obj(v, what);
  const d = o.data;
  if (typeof o.owner !== "string" || !Number.isSafeInteger(o.lamports) || (o.lamports as number) < 0 || !Array.isArray(d) || typeof d[0] !== "string" || d[1] !== "base64") throw new Error(`${what} is not a base64 account`);
  return { owner: o.owner, lamports: BigInt(o.lamports as number), data: Uint8Array.from(atob(d[0] as string), (c) => c.charCodeAt(0)) };
}
/** getMultipleAccounts on one provider, in groups of 10 (solana-rpc.publicnode.com's cap). */
async function readAccounts(rpc: SolanaRpc, keys: readonly string[], commitment: "processed" | "confirmed"): Promise<(Acc | null)[]> {
  const out: (Acc | null)[] = [];
  for (let i = 0; i < keys.length; i += 10) {
    const group = keys.slice(i, i + 10);
    const r = obj(await rpc("getMultipleAccounts", [group, { encoding: "base64", commitment }]), "getMultipleAccounts");
    const v = r.value;
    if (!Array.isArray(v) || v.length !== group.length) throw new Error("getMultipleAccounts answered another count");
    v.forEach((a, j) => out.push(account(a, group[j] as string)));
  }
  return out;
}
const both = <T>(f: (rpc: SolanaRpc) => Promise<T>, providers: readonly [SolanaRpc, SolanaRpc]) => Promise.all([f(providers[0]), f(providers[1])]) as Promise<[T, T]>;
const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const tokenAmount = (a: Acc | null): bigint => (a && a.data.length >= 72 ? u64(a.data, 64) : 0n);

/** The size of the wallet's account of a mint: 165 on Token; on Token-2022, 165 + the type byte + ImmutableOwner and
 * the account extensions the mint's own extensions require (TransferFeeAmount 8, NonTransferableAccount 0,
 * TransferHookAccount 1, each with its 4-byte header). A size below the real one only lowers S11's bound. */
function tokenAccountSize(mint: Acc): number {
  if (mint.owner === SOLANA_TOKEN_PROGRAM) return 165;
  let size = 165 + 1 + 4;
  const d = mint.data;
  if (d.length > 166) {
    for (let o = 166; o + 4 <= d.length; ) {
      const t = d[o]! | (d[o + 1]! << 8);
      const len = d[o + 2]! | (d[o + 3]! << 8);
      if (t === 0) break;
      if (t === 1) size += 4 + 8;
      if (t === 9) size += 4;
      if (t === 14) size += 4 + 1;
      o += 4 + len;
    }
  }
  return size;
}

/** Token-2022's TransferFeeConfig (extension 1) on the mint. */
function mintHasTransferFee(mint: Acc): boolean {
  if (mint.owner !== SOLANA_TOKEN_2022_PROGRAM || mint.data.length <= 166) return false;
  for (let o = 166; o + 4 <= mint.data.length; ) {
    const t = mint.data[o]! | (mint.data[o + 1]! << 8);
    if (t === 0) return false;
    if (t === 1) return true;
    o += 4 + (mint.data[o + 2]! | (mint.data[o + 3]! << 8));
  }
  return false;
}

const sameAccounts = (x: readonly (Acc | null)[], y: readonly (Acc | null)[]): boolean =>
  x.length === y.length &&
  x.every((a, i) => {
    const b = y[i] ?? null;
    return a === null ? b === null : b !== null && a.owner === b.owner && a.lamports === b.lamports && a.data.length === b.data.length && a.data.every((v, j) => v === b.data[j]);
  });

/** The older of two finalized reads, which both providers hold, with the higher of the two lastValidBlockHeights:
 * one provider's lowered answer can then never make the tx read past its window before it is. */
export async function readSolanaBlockhashBoth(providers: readonly [SolanaRpc, SolanaRpc]): Promise<SolanaBlockhash> {
  const [a, b] = await both(readSolanaBlockhash, providers);
  return { ...(a.slot <= b.slot ? a : b), lastValidBlockHeight: Math.max(a.lastValidBlockHeight, b.lastValidBlockHeight) };
}

/** A blockhash both providers answer valid (isBlockhashValid at confirmed, both true): readSolanaBlockhashBoth's read,
 * and when the two do not both say so, one read more; then it refuses. */
export async function readSolanaBlockhashValid(providers: readonly [SolanaRpc, SolanaRpc]): Promise<SolanaBlockhash> {
  const valid = async (rpc: SolanaRpc, hash: string): Promise<boolean> => {
    try {
      return obj(await rpc("isBlockhashValid", [hash, { commitment: "confirmed" }]), "isBlockhashValid").value === true;
    } catch {
      return false;
    }
  };
  let last = "";
  for (let i = 0; i < 2; i++) {
    const bh = await readSolanaBlockhashBoth(providers);
    const [a, b] = await both((r) => valid(r, bh.blockhash), providers);
    if (a && b) return bh;
    last = `${bh.blockhash}: valid on A ${a}, on B ${b}`;
  }
  throw new Error(`no blockhash both providers hold (${last})`);
}

/** Only legs whose bytes to sign equal, byte for byte, the copy their checks passed; any other is refused, unsigned. */
export function solanaSignOnlyChecked<T extends { rec: SolanaLegRecord; assembled: { readonly wire: Uint8Array }; checked: Uint8Array }>(legs: readonly T[]): T[] {
  return legs.filter((p) => {
    const w = p.assembled.wire;
    if (w.length === p.checked.length && w.every((x, i) => x === p.checked[i])) return true;
    p.rec.refused = "the bytes to sign are not the bytes the checks passed";
    return false;
  });
}

/** A signature read again on both providers with searchTransactionHistory: filled or failed only when both agree. */
export async function rereadSolanaSignature(providers: readonly [SolanaRpc, SolanaRpc], signature: string): Promise<{ state: "filled" | "failed" | "unknown"; reads: readonly [unknown, unknown] }> {
  const one = async (rpc: SolanaRpc) => {
    try {
      const v = obj(await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]), "getSignatureStatuses").value;
      if (!Array.isArray(v) || v.length !== 1) return { kind: "none" as const, raw: v };
      const s = v[0] as { confirmationStatus?: unknown; err?: unknown } | null;
      if (s === null) return { kind: "none" as const, raw: s };
      const landed = s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized";
      if (!landed) return { kind: "none" as const, raw: s };
      // A landed status must carry its err field (send.ts readStatuses' rule): null is a fill, anything else a failure,
      // and a status without one is no answer.
      if (!("err" in s)) return { kind: "none" as const, raw: s };
      return { kind: s.err === null ? ("ok" as const) : ("err" as const), raw: s };
    } catch (e) {
      return { kind: "none" as const, raw: String((e as Error)?.message ?? e).slice(0, 160) };
    }
  };
  const [a, b] = await both(one, providers);
  const state = a.kind === "ok" && b.kind === "ok" ? "filled" : a.kind === "err" && b.kind === "err" ? "failed" : "unknown";
  return { state, reads: [a.raw, b.raw] };
}

/** T1.3's floors: E_k = ⌊E(A) × a_k / A⌋ and minOut_k = ⌊E_k × (1 − s)⌋, from the device's own E(A) for A = Σ a_k. */
export function solanaSetFloors(e: bigint, amounts: readonly bigint[], slippageBps: number): { expectedOut: bigint; minOut: bigint }[] {
  const total = amounts.reduce((n, a) => n + a, 0n);
  if (e <= 0n || total <= 0n || amounts.some((a) => a <= 0n)) throw new Error("E(A) and every a_k must be above 0");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error("slippageBps must be 0 to 9,999");
  return amounts.map((a) => {
    const expectedOut = (e * a) / total;
    return { expectedOut, minOut: (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n };
  });
}

/** The route's floor as S7 decodes it: ⌊quotedOut × (10,000 − slippageBps) / 10,000⌋. */
export const solanaRouteFloor = (a: { quotedOut: bigint; slippageBps: number }): bigint => (a.quotedOut * BigInt(10_000 - a.slippageBps)) / 10_000n;

/** The slippage to ask again with so the route's floor is at least minOut: ⌊(quotedOut − minOut) × 10,000 / quotedOut⌋;
 * null when the route's quoted out is not above minOut (no slippage puts its floor on minOut, so the leg is refused). */
export function solanaRebuildSlippage(quotedOut: bigint, minOut: bigint): number | null {
  if (quotedOut <= minOut || minOut <= 0n) return null;
  return Number(((quotedOut - minOut) * 10_000n) / quotedOut);
}

/** After the send: every tx the send left "unknown" at its deadline is read again on both providers; the others keep
 * the send's own two-provider state. A state stays "unknown" unless both providers agree. */
export async function settleSolanaSet(providers: readonly [SolanaRpc, SolanaRpc], txs: readonly SolanaTxOutcome[]): Promise<{ state: "filled" | "failed" | "expired" | "unknown"; reread?: Awaited<ReturnType<typeof rereadSolanaSignature>> }[]> {
  // one signature at a time: each read names one wallet, and the reads are not sent in a burst
  const out: { state: "filled" | "failed" | "expired" | "unknown"; reread?: Awaited<ReturnType<typeof rereadSolanaSignature>> }[] = [];
  for (const o of txs) {
    if (o.state !== "unknown") { out.push({ state: o.state }); continue; }
    const reread = await rereadSolanaSignature(providers, o.signature);
    out.push({ state: reread.state, reread });
  }
  return out;
}

/** S12's reference for one leg: E(a_k), the bar for its simulated out, and E_k, the base of its floor. */
type LegReference = { legExpectedOut: bigint; expectedOut: bigint };
/** A leg checked and ready to sign: `checked` is the copy of the bytes the checks passed, `renew` checks it again on
 * fresh reads, a fresh reference and a fresh blockhash. */
type Prepared = { leg: SolanaTradeLeg; rec: SolanaLegRecord; assembled: SolanaAssembled; checked: Uint8Array; renew: () => Promise<((bh: SolanaBlockhash, ref: LegReference) => Promise<Prepared | null>) | null> };

async function prepareLeg(
  req: SolanaTradeRequest,
  leg: SolanaTradeLeg,
  rec: SolanaLegRecord,
  ctx: { deps: SolanaTradeDeps; blockhash: SolanaBlockhash; mint: [Acc | null, Acc | null]; otherWallets: readonly string[]; links: SolanaWalletLinks; heldMints: readonly string[]; room: SolanaBuildRoom },
): Promise<Prepared | null> {
  const { deps, blockhash } = ctx;
  const [pa, pb] = deps.providers;
  const now = deps.now ?? (() => performance.now());
  const mintA = ctx.mint[0];
  if (!mintA || (mintA.owner !== SOLANA_TOKEN_PROGRAM && mintA.owner !== SOLANA_TOKEN_2022_PROGRAM)) { rec.refused = "the mint is not a token mint on provider A"; return null; }
  const tokenProgram = mintA.owner;
  const w = leg.wallet;
  const ata = solanaAta(w, req.token, tokenProgram);
  const uva = solanaVolumeAccumulator(w, SOLANA_PUMP_PROGRAM);
  const sva = solanaVolumeAccumulator(w, SOLANA_PUMP_AMM_PROGRAM);
  const minOut = rec.minOut as bigint;
  const t0 = now();
  const breq: SolanaBuildRequest = { side: req.side, wallet: w, token: req.token, amount: leg.amount, slippageBps: req.slippageBps };
  const room = ctx.room;
  // past the helper's share or room, a build waits the Retry-After inside the trade's bound (SolanaBuildRoom)
  const opts = { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}), wait: room.wait };
  // The build, and with it on both providers the reads that do not depend on it: the rents in play (the wallet's
  // token account, its size from the mint, and the pump volume account) and the pre-state the simulation is held to
  // (the wallet, its token account, its two volume accounts: this wallet's only), which also gives spendable.
  const watch = [w, ata, uva, sva];
  const size = tokenAccountSize(mintA);
  const rentOf = async (r: SolanaRpc) => {
    const [t, v] = await Promise.all([r("getMinimumBalanceForRentExemption", [size]), r("getMinimumBalanceForRentExemption", [137])]);
    if (!Number.isSafeInteger(t) || !Number.isSafeInteger(v)) throw new Error("rent is not a safe integer");
    return [BigInt(t as number), BigInt(v as number)] as const;
  };
  const sideReads = Promise.all([both(rentOf, deps.providers), both((r) => readAccounts(r, watch, "confirmed"), deps.providers)]);
  sideReads.catch(() => undefined); // awaited below; a refused build must not leave it unhandled
  const tb0 = now();
  // A build's tables, read on both providers (assembly uses provider A's, S2 holds B's to the same bytes), and the
  // device's own assembly on them, which refuses (too_large) a tx over 1,232 bytes: the cap search's judge.
  const feeOpts = mintHasTransferFee(mintA) ? { transferFeeMints: [req.token] } : {};
  const fitOn = async (b: SolanaJupiterBuild) => {
    const tableKeys = [...b.tables];
    const [ta, tb] = tableKeys.length ? await both((r) => readAccounts(r, tableKeys, "confirmed"), deps.providers) : ([[], []] as [(Acc | null)[], (Acc | null)[]]);
    const tables: Record<string, readonly [SolanaAccountRead | null, SolanaAccountRead | null]> = {};
    const decoded: Record<string, SolanaLookupTable> = {};
    tableKeys.forEach((k, i) => {
      const a = ta[i] ?? null;
      const bb = tb[i] ?? null;
      tables[k] = [a, bb];
      if (a && a.owner === SOLANA_ALT_PROGRAM) {
        try { decoded[k] = solanaDecodeLookupTable(a.data); } catch { /* S2 refuses */ }
      }
    });
    return { tables, assembled: assembleSolanaSwap(breq, b, { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, tables: decoded, tokenProgram }, feeOpts) };
  };
  // The cap search: 40, up on no route, down when the assembly is over 1,232 bytes (build.ts, Jupiter's requote). Each
  // leg searches on its own answers, all at once: no leg waits on another (at most SOLANA_JUPITER_MAX_BUILDS builds and
  // one floor rebuild a leg, so K legs ask Jupiter K to 4K builds; a one-leg trade at most 4, the helper's share).
  const found = await fetchSolanaJupiterBuildThatFits(deps.helper, breq, fitOn, opts);
  rec.buildCaps = found.steps;
  room.fitted(found.maxAccounts);
  let calls = found.calls.length;
  let build = found.build;
  let fitted = found.fitted;
  let amounts = solanaRouteAmounts(build.swap.data);
  if (!amounts) { rec.refused = "the build's swap is not a route the device decodes"; return null; }
  if (solanaRouteFloor(amounts) < minOut) {
    // the floor's rebuild: once, at the cap the search found
    const s = solanaRebuildSlippage(amounts.quotedOut, minOut);
    if (s === null) { rec.refused = `the route quotes ${amounts.quotedOut}, not above the floor ${minOut}`; return null; }
    let again: Awaited<ReturnType<typeof fetchSolanaJupiterBuild>>;
    try {
      again = await fetchSolanaJupiterBuild(deps.helper, { ...breq, slippageBps: s }, { ...opts, maxAccounts: found.maxAccounts });
    } catch (e) {
      // a route exists (the search's); only its rebuild at the floor's slippage found none: the floor is the reason
      if (e instanceof SolanaBuildError && e.code === "no_route") { rec.buildCalls = calls + 1; rec.refused = `the route quotes ${amounts.quotedOut}, under the floor ${minOut} at its slippage, and its rebuild at ${s} bps found no route at maxAccounts=${found.maxAccounts}`; return null; }
      throw e;
    }
    calls += again.calls.length;
    build = again.build;
    amounts = solanaRouteAmounts(build.swap.data);
    if (!amounts || solanaRouteFloor(amounts) < minOut) { rec.refused = `the route's floor stays under ${minOut}`; return null; }
    fitted = await fitOn(build);
  }
  rec.buildCalls = calls;
  rec.buildMs = now() - tb0;
  const { tables, assembled } = fitted;
  // While the tx is simulated: S11's map grows, in slices, by the keys the build names (its check adds any key the tx
  // names beyond).
  const b = build;
  const growth = ctx.links.grow([], [...b.setup, b.swap, ...(b.cleanup ? [b.cleanup] : []), ...b.other].flatMap((ix) => [ix.program, ...ix.accounts.map((a) => a.key)]));
  growth.catch(() => undefined); // awaited before the check
  const [rent, pre] = await sideReads;
  // The simulation on both providers, at once, reading back this wallet's own four accounts (a provider may read back
  // at most 4). No other wallet of the user is in it: S11 refuses a tx that names one, so none can change. It runs with
  // replaceRecentBlockhash, so it holds for this tx on any blockhash (solanaWithBlockhash changes no other byte).
  const stateOn = async (wire: Uint8Array, before: readonly [(Acc | null)[], (Acc | null)[]]): Promise<{ simulations: [SolanaSimulation | null, SolanaSimulation | null]; spendable: bigint } | null> => {
    const b64 = btoa(String.fromCharCode(...wire));
    const simErrors: string[] = [];
    const simOne = async (rpc: SolanaRpc, at: "A" | "B", was: (Acc | null)[]): Promise<SolanaSimulation | null> => {
      try {
        const run = async (group: string[]) => {
          const r = obj(await rpc("simulateTransaction", [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { addresses: group, encoding: "base64" } }]), "simulateTransaction");
          const v = obj(r.value, "simulateTransaction.value");
          const accs = Array.isArray(v.accounts) && v.accounts.length === group.length ? v.accounts.map((x, j) => account(x, group[j] as string)) : null;
          return { err: v.err ?? null, accs };
        };
        const main = await run(watch);
        if (main.err !== null) return { err: main.err, walletLamports: { pre: 0n, post: 0n }, tokenAccount: { pre: 0n, post: 0n }, tokenAccountLamports: { pre: 0n, post: 0n }, pumpVolumeAccumulator: { pre: 0n, post: 0n }, pumpSwapVolumeAccumulator: { pre: 0n, post: 0n } };
        if (!main.accs || !main.accs[0]) { simErrors.push(`${at}: no wallet read back`); return null; }
        const m = main.accs;
        return {
          err: null,
          walletLamports: { pre: was[0]?.lamports ?? 0n, post: (m[0] as Acc).lamports },
          tokenAccount: { pre: tokenAmount(was[1] ?? null), post: tokenAmount(m[1] ?? null) },
          tokenAccountLamports: { pre: was[1]?.lamports ?? 0n, post: m[1]?.lamports ?? 0n },
          pumpVolumeAccumulator: { pre: was[2]?.lamports ?? 0n, post: m[2]?.lamports ?? 0n },
          pumpSwapVolumeAccumulator: { pre: was[3]?.lamports ?? 0n, post: m[3]?.lamports ?? 0n },
        };
      } catch (e) {
        simErrors.push(`${at}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
        return null;
      }
    };
    const simulations: [SolanaSimulation | null, SolanaSimulation | null] = await Promise.all([simOne(pa, "A", before[0]), simOne(pb, "B", before[1])]);
    if (simErrors.length) rec.simulationErrors = simErrors;
    else delete rec.simulationErrors;
    // The pre-state read again on both providers after the simulations: the bounds S11 draws from it hold only if
    // nothing moved this wallet's accounts meanwhile, so any change refuses the leg.
    const again = await both((r) => readAccounts(r, watch, "confirmed"), deps.providers);
    if (!sameAccounts(before[0], again[0]) || !sameAccounts(before[1], again[1])) { rec.refused = "the wallet's accounts changed while the trade was checked"; return null; }
    // Spendable, the lower of the two providers' pre-state: lamports on a buy, the token account's balance on a sell.
    const spend = (x: (Acc | null)[]) => (req.side === "buy" ? (x[0]?.lamports ?? 0n) : tokenAmount(x[1] ?? null));
    const spendable = spend(before[0]) < spend(before[1]) ? spend(before[0]) : spend(before[1]);
    rec.sellsAll = req.side === "sell" && leg.amount === spendable;
    return { simulations, spendable };
  };
  // The checks on the very bytes to be signed: a copy is checked and kept, and only bytes equal to it are signed
  // (solanaSignOnlyChecked). minOut is the leg's own on every check; the reference is the first read's, or at a renewal
  // the one read again then, so a floor the market has since left behind is refused.
  const verdictOn = async (a: SolanaAssembled, st: { simulations: [SolanaSimulation | null, SolanaSimulation | null]; spendable: bigint }, ref: LegReference): Promise<Prepared | null> => {
    await growth;
    const checked = Uint8Array.from(a.wire);
    const verdict = checkSolanaQuote(checked, { side: req.side, wallet: w, token: req.token, amount: leg.amount, spendable: st.spendable, minOut, otherWallets: ctx.otherWallets, links: ctx.links, heldMints: ctx.heldMints }, {
      tables,
      mint: [ctx.mint[0], ctx.mint[1]],
      rent: { tokenAccount: [rent[0][0], rent[1][0]], pumpVolumeAccumulator: [rent[0][1], rent[1][1]] },
      simulations: st.simulations,
      reference: { expectedOut: ref.legExpectedOut, minOutBase: ref.expectedOut, slippageBps: req.slippageBps },
    });
    rec.size = a.size;
    rec.verdict = verdict;
    if (!verdict.ok) { rec.refused = `checks: ${verdict.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`).join("; ").slice(0, 400)}`; return null; }
    return { leg, rec, assembled: a, checked, renew };
  };
  // A trade whose blockhash grew old while its legs were built (runSolanaTrade): the pre-state and the simulation read
  // again now, then, once a fresh reference and blockhash are in, this tx on it checked again on those reads.
  const renew = async (): Promise<((bh: SolanaBlockhash, ref: LegReference) => Promise<Prepared | null>) | null> => {
    const before = await both((r) => readAccounts(r, watch, "confirmed"), deps.providers);
    const st = await stateOn(assembled.wire, before);
    return st ? (bh, ref) => verdictOn(solanaWithBlockhash(assembled, bh), st, ref) : null;
  };
  const st = await stateOn(assembled.wire, pre);
  if (!st) return null;
  const out = await verdictOn(assembled, st, { legExpectedOut: rec.legExpectedOut as bigint, expectedOut: rec.expectedOut as bigint });
  rec.quoteMs = now() - t0;
  return out;
}

/** Each tx signed, and sent with the very height its signer was handed: one path for the trade and its teardowns. */
function signSet(deps: Pick<SolanaTradeDeps, "dry" | "sign">, items: readonly { wallet: string; tx: { wire: Uint8Array; message: Uint8Array; lastValidBlockHeight: number } }[]): Promise<{ wire: Uint8Array; lastValidBlockHeight: number }[]> {
  return Promise.all(items.map(async ({ wallet, tx }) => ({ wire: await solanaSignedWire(deps, wallet, tx), lastValidBlockHeight: tx.lastValidBlockHeight })));
}

/**
 * The age rule at a leg's signature (card kit-renewal-read-bounded): the price a leg is signed on is the reference read
 * begun at `at`, and it must be no older than SOLANA_BLOCKHASH_REFRESH_MS at `now`. Taken at the sign point's re-read,
 * right before each leg's signer is asked and again when it answers (its store reads and seed open are inside it), so
 * the age that counts is the age at the signature. Late: the leg's refusal, a price check's (the signing page's
 * refusalCode reads `checks: ` as quote_check_failed); a clock that answers no number is late too.
 */
function referenceLate(at: number, now: number): string | null {
  const age = now - at;
  return age <= SOLANA_BLOCKHASH_REFRESH_MS ? null : `checks: the reference is ${Number.isFinite(age) ? Math.round(age) : 0} ms old at the signature, past the ${SOLANA_BLOCKHASH_REFRESH_MS} ms limit`;
}

/** The signature into the wire's one slot, checked against the wallet's key before anything is sent. */
export async function solanaSignedWire(deps: Pick<SolanaTradeDeps, "dry" | "sign">, wallet: string, a: { wire: Uint8Array; message: Uint8Array; lastValidBlockHeight: number }): Promise<Uint8Array> {
  return (await signedWire(deps, wallet, a, () => null)) as Uint8Array;
}

/** solanaSignedWire with the age rule: `late` is read when the signer answers, before its signature is checked or put
 * in the wire; a reason from it is answered instead of the wire, and the signature is dropped. */
async function signedWire(deps: Pick<SolanaTradeDeps, "dry" | "sign">, wallet: string, a: { wire: Uint8Array; message: Uint8Array; lastValidBlockHeight: number }, late: () => string | null): Promise<Uint8Array | string> {
  // The bytes signed are the bytes checked: one signature slot, and the message is the wire's own message.
  if (a.wire[0] !== 1 || a.wire.length !== 65 + a.message.length || a.wire.subarray(65).some((b, i) => b !== a.message[i])) throw new Error("the message is not the checked wire's message");
  let sig: Uint8Array;
  if (deps.dry) {
    // Dry: no key is used. A placeholder fills the slot; every simulation runs with sigVerify off.
    const placeholder = new Uint8Array(64);
    globalThis.crypto.getRandomValues(placeholder);
    sig = placeholder;
  } else {
    if (!deps.sign) throw new Error("no signer");
    if (!Number.isSafeInteger(a.lastValidBlockHeight) || a.lastValidBlockHeight <= 0) throw new Error("the tx has no lastValidBlockHeight");
    sig = await deps.sign(wallet, a.message, { lastValidBlockHeight: a.lastValidBlockHeight });
  }
  const why = late();
  if (why) return why;
  if (!deps.dry && (!(sig instanceof Uint8Array) || sig.length !== 64 || !ed25519.verify(sig, a.message, base58.decode(wallet)))) throw new Error(`the signature for ${wallet} does not verify`);
  const wire = Uint8Array.from(a.wire);
  wire.set(sig, 1);
  return wire;
}

/** The teardown never throws into the trade: the sell has already run; a read or send that fails leaves the accounts
 * open (their rent stays the wallet's) and is recorded. */
async function teardown(req: SolanaTradeRequest, rec: SolanaLegRecord, deps: SolanaTradeDeps, tokenProgram: string, afterFill: boolean): Promise<NonNullable<SolanaLegRecord["teardown"]>> {
  try {
    if (afterFill) {
      // After a fill: only a token account both providers read as empty is torn down.
      const after = await both((r) => readAccounts(r, [solanaAta(rec.wallet, req.token, tokenProgram)], "confirmed"), deps.providers);
      if (tokenAmount(after[0][0] ?? null) !== 0n || tokenAmount(after[1][0] ?? null) !== 0n) {
        const detail = "the token account still holds tokens after the sell";
        return { verdict: { ok: false, plan: null, results: [{ id: "READ", ok: false, detail }] }, frames: 0, refused: detail };
      }
    }
    return await teardownOnce(req, rec, deps, tokenProgram);
  } catch (e) {
    const detail = String((e as Error)?.message ?? e).slice(0, 200);
    return { verdict: { ok: false, plan: null, results: [{ id: "READ", ok: false, detail }] }, frames: 0, refused: detail };
  }
}
async function teardownOnce(req: SolanaTradeRequest, rec: SolanaLegRecord, deps: SolanaTradeDeps, tokenProgram: string): Promise<NonNullable<SolanaLegRecord["teardown"]>> {
  const w = rec.wallet;
  const addresses = solanaTeardownAddresses(w, [{ mint: req.token, program: tokenProgram }]);
  const [ra, rb] = await both((r) => readAccounts(r, [w, ...addresses], "confirmed"), deps.providers);
  const held = (x: Acc | null): SolanaHeldRead | null => x;
  const accounts = Object.fromEntries(addresses.map((x, i) => [x, [held(ra[i + 1] ?? null), held(rb[i + 1] ?? null)] as const]));
  let plan;
  try {
    plan = solanaTeardownPlan(w, accounts);
  } catch (e) {
    return { verdict: { ok: false, plan: null, results: [{ id: "READ", ok: false, detail: (e as Error).message }] }, frames: 0, refused: (e as Error).message };
  }
  const bh = await readSolanaBlockhashBoth(deps.providers);
  const frames = buildSolanaTeardown(w, plan, bh);
  const simulations = await Promise.all(frames.map((f) => both((r) => simulateSolanaTeardown(r, f.wire, w, addresses).catch(() => null), deps.providers)));
  const verdict = checkSolanaTeardown(frames.map((f) => f.wire), w, { accounts, wallet: [ra[0]?.lamports ?? 0n, rb[0]?.lamports ?? 0n], simulations });
  if (!verdict.ok || frames.length === 0) return { verdict, frames: frames.length, ...(verdict.ok ? {} : { refused: "teardown checks" }) };
  const set = await signSet(deps, frames.map((f) => ({ wallet: w, tx: f })));
  const sendOpts = { paths: deps.paths, providers: deps.providers, ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}), ...(deps.pollMs ? { pollMs: deps.pollMs } : {}), ...(deps.providerRps ? { providerRps: deps.providerRps } : {}) };
  if (deps.dry) return { verdict, frames: frames.length, dry: (await dryRunSolanaSet(set, sendOpts)).txs };
  return { verdict, frames: frames.length, outcomes: (await sendSolanaSet(set, sendOpts).done).txs };
}

/**
 * The trade: every leg quoted, built, checked, signed and sent at once, and its fill read. Legs from a wallet not armed
 * by the device's own withdrawal, and legs whose checks fail, are refused and never signed; the others go on.
 */
/** Every call of a trade on a provider, the teardowns' included, in that provider's one shared queue (send.ts). */
function pacedDeps(deps: SolanaTradeDeps): SolanaTradeDeps {
  const p = deps.providers;
  if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "function" || typeof p[1] !== "function") throw new Error("two providers are needed");
  if (solanaSameProvider(p[0], p[1])) throw new Error("the two providers are the same provider: a trade must never rest on one provider's word");
  const limits = solanaProviderLimits(deps.providerRps);
  return { ...deps, providers: [solanaPacedRpc(p[0], limits[0]), solanaPacedRpc(p[1], limits[1])] };
}

/** The set on a fresh blockhash. First every leg's pre-state and simulation read again, at once (on keyless providers
 * this can take tens of seconds for a large set); then, last and together, the set's reference and one blockhash both
 * providers answer valid; then each leg's tx on that blockhash checked again on those reads: its own minOut held to the
 * fresh E_k less s, its simulated out to the fresh E(a_k). At the sign point, a reference older than the limit (the
 * blockhash read was slow) is read once more, the reference only, and the legs checked again on it: one read, so a large
 * set never loops; that read itself answering past the limit refuses every leg (referenceLate), never read again. A leg
 * that fails any of it is refused and keeps its money; a set with no fresh reference or blockhash signs nothing. A leg's
 * first check moves to firstVerdict, so `verdict` is only ever the check of the bytes about to be signed. `at` is when
 * the reference the legs passed on was begun, for the age rule at each signature. */
async function renewSet(prepared: readonly Prepared[], deps: SolanaTradeDeps, record: SolanaTradeRecord, rereference: () => Promise<Map<SolanaLegRecord, LegReference> | null>, clock: () => number): Promise<{ legs: Prepared[]; at: number }> {
  const why = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 200);
  for (const p of prepared) {
    if (p.rec.verdict) p.rec.firstVerdict = p.rec.verdict;
    delete p.rec.verdict;
  }
  const next = await Promise.all(prepared.map(async (p) => {
    try {
      return await p.renew();
    } catch (err) {
      p.rec.refused = `renewal: error: ${why(err)}`;
      return null;
    }
  }));
  if (!next.some((f) => f)) return { legs: [], at: clock() };
  const readReference = () => rereference().catch((err: unknown) => `renewal: error: ${why(err)}`);
  let refAt = clock();
  const [refs, fresh] = await Promise.all([readReference(), readSolanaBlockhashValid(deps.providers).catch((err: unknown) => new Error(`renewal: ${why(err)}`))]);
  if (fresh instanceof Error) {
    prepared.forEach((p, i) => { if (next[i]) p.rec.refused = fresh.message; });
    return { legs: [], at: refAt };
  }
  if (record.blockhash) record.firstBlockhash = record.blockhash;
  record.blockhash = fresh;
  // each leg's renewed tx on the fresh blockhash, checked on reference `r`: the legs that pass, by their index in the set
  const checkOn = async (r: Map<SolanaLegRecord, LegReference> | string | null, legs: readonly number[]): Promise<{ i: number; p: Prepared }[]> => {
    if (r === null || typeof r === "string") {
      for (const i of legs) (prepared[i] as Prepared).rec.refused = r ?? "renewal: no reference pool";
      return [];
    }
    const ok = await Promise.all(legs.map(async (i) => {
      const p = prepared[i] as Prepared;
      const f = next[i];
      const ref = r.get(p.rec);
      if (!f) return null;
      if (!ref) { p.rec.refused = "renewal: no reference for the leg"; return null; }
      p.rec.renewedReference = ref;
      try {
        const renewed = await f(fresh, ref);
        return renewed ? { i, p: renewed } : null;
      } catch (err) {
        p.rec.refused = `renewal: error: ${why(err)}`;
        return null;
      }
    }));
    return ok.filter((x): x is { i: number; p: Prepared } => x !== null);
  };
  let passed = await checkOn(refs, prepared.flatMap((_, i) => (next[i] ? [i] : [])));
  // the sign point: nothing slow runs between here and the signatures
  if (passed.length && referenceLate(refAt, clock())) {
    // the time again, just before the one re-read: a re-read that answers past the limit refuses every leg, unsigned
    refAt = clock();
    const again = await readReference();
    const late = referenceLate(refAt, clock());
    if (late) {
      for (const x of passed) x.p.rec.refused = late;
      return { legs: [], at: refAt };
    }
    passed = await checkOn(again, passed.map((x) => x.i));
  }
  return { legs: passed.map((x) => x.p), at: refAt };
}

export async function runSolanaTrade(req: SolanaTradeRequest, bareDeps: SolanaTradeDeps): Promise<SolanaTradeRecord> {
  if (req.side !== "buy" && req.side !== "sell") throw new Error("side must be buy or sell");
  if (!isKey(req.token)) throw new Error("the token must be an address");
  if (!Number.isInteger(req.slippageBps) || req.slippageBps < 0 || req.slippageBps >= 10_000) throw new Error("slippageBps must be 0 to 9,999");
  if (!Array.isArray(req.legs) || req.legs.length === 0) throw new Error("no wallet in the set");
  if (!Array.isArray(req.wallets) || !req.wallets.every(isKey)) throw new Error("wallets must be the user's wallet addresses");
  const all = new Set(req.wallets);
  const seen = new Set<string>();
  for (const l of req.legs) {
    if (!isKey(l.wallet)) throw new Error("every wallet must be an address");
    if (seen.has(l.wallet)) throw new Error(`wallet ${l.wallet} is in the set twice`);
    if (!all.has(l.wallet)) throw new Error(`wallet ${l.wallet} is not in the user's wallets`);
    seen.add(l.wallet);
    if (typeof l.amount !== "bigint" || l.amount <= 0n || l.amount > 0xffff_ffff_ffff_ffffn) throw new Error("every amount must be a u64 above 0");
  }
  const heldMints = req.heldMints ?? [];
  if (!Array.isArray(heldMints) || !heldMints.every(isKey)) throw new Error("heldMints must be mint addresses");
  if (bareDeps.links !== undefined && !(bareDeps.links instanceof SolanaWalletLinks)) throw new Error("links must be a SolanaWalletLinks");
  const deps = pacedDeps(bareDeps);
  if (!deps.dry && typeof deps.sign !== "function") throw new Error("no signer");
  const progress = (s: SolanaTradeStage) => { try { deps.onProgress?.(s); } catch { /* the caller's display never stops a trade */ } };
  const recs: SolanaLegRecord[] = req.legs.map((l) => ({ wallet: l.wallet, amount: l.amount, expectedOut: null, minOut: null }));
  const live = req.legs.flatMap((l, i) => {
    if (l.arm?.own === true) return [i];
    (recs[i] as SolanaLegRecord).refused = "the wallet was not armed by this device's own withdrawal";
    return [];
  });
  const record: SolanaTradeRecord = { side: req.side, token: req.token, reference: null, blockhash: null, legs: recs };
  if (live.length === 0) { progress("refused"); return record; }
  const total = live.reduce((n, i) => n + (req.legs[i] as SolanaTradeLeg).amount, 0n);
  const amounts = live.map((i) => (req.legs[i] as SolanaTradeLeg).amount);
  const clock = deps.now ?? (() => performance.now());
  const blockhashAt = clock();
  const first = Promise.all([
    deps.reference({ side: req.side, token: req.token, amount: total, amounts }, deps.providers),
    readSolanaBlockhashBoth(deps.providers),
    both((r) => readAccounts(r, [req.token], "processed").then((x) => x[0] ?? null), deps.providers),
  ]);
  first.catch(() => undefined); // awaited next
  // While those are read: S11's map of every wallet's accounts, the token's and the held mints' included, grown in
  // slices (SolanaWalletLinks; the caller's long-lived one when given, so only new wallets and keys cost).
  const links = deps.links ?? new SolanaWalletLinks();
  links.grow(req.wallets, [req.token, ...heldMints]).catch(() => undefined); // each leg awaits it with its own growth
  const [ref, blockhash, mint] = await first;
  const e = ref?.expectedOut ?? null;
  record.reference = e;
  record.blockhash = blockhash;
  if (e === null || e <= 0n || !ref || ref.expectedOuts?.length !== live.length || ref.expectedOuts.some((x) => x <= 0n)) {
    for (const i of live) (recs[i] as SolanaLegRecord).refused = "no reference pool";
    progress("refused");
    return record;
  }
  const floors = solanaSetFloors(e, amounts, req.slippageBps);
  live.forEach((i, j) => {
    const r = recs[i] as SolanaLegRecord;
    Object.assign(r, floors[j]);
    r.legExpectedOut = (ref.expectedOuts as readonly bigint[])[j] as bigint;
    if ((r.minOut as bigint) <= 0n) r.refused = "the floor rounds to 0";
  });
  const room = new SolanaBuildRoom({
    total: live.filter((i) => !(recs[i] as SolanaLegRecord).refused).length,
    boundMs: SOLANA_TRADE_BUILD_WAIT_MS,
    ...(deps.now ? { clock: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.onBuilds ? { onProgress: deps.onBuilds } : {}),
  });
  const prepared = (
    await Promise.all(
      live.map(async (i) => {
        const rec = recs[i] as SolanaLegRecord;
        if (rec.refused) return null;
        try {
          return await prepareLeg(req, req.legs[i] as SolanaTradeLeg, rec, { deps, blockhash, mint, otherWallets: [...all].filter((x) => x !== rec.wallet), links, heldMints, room });
        } catch (err) {
          rec.refused = err instanceof SolanaBuildError ? `build ${err.code}: ${err.message.slice(0, 160)}` : `error: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
          return null;
        } finally {
          room.done();
        }
      }),
    )
  ).filter((x): x is Prepared => x !== null);
  // The renewal's reference: E read again for the same set A, its floors drawn as the first read's were (T1.3).
  const rereference = async (): Promise<Map<SolanaLegRecord, LegReference> | null> => {
    const again = await deps.reference({ side: req.side, token: req.token, amount: total, amounts }, deps.providers);
    const e2 = again?.expectedOut ?? null;
    const outs = again?.expectedOuts;
    if (e2 === null || e2 <= 0n || !outs || outs.length !== live.length || outs.some((x) => x <= 0n)) return null;
    const floors2 = solanaSetFloors(e2, amounts, req.slippageBps);
    record.renewedReference = e2;
    return new Map(live.map((i, j) => [recs[i] as SolanaLegRecord, { legExpectedOut: outs[j] as bigint, expectedOut: (floors2[j] as { expectedOut: bigint }).expectedOut }]));
  };
  // The reference the legs pass on was begun at blockhashAt (read with the blockhash), or at the renewal's last read.
  const renewed = clock() - blockhashAt > SOLANA_BLOCKHASH_REFRESH_MS ? await renewSet(prepared, deps, record, rereference, clock) : { legs: prepared, at: blockhashAt };
  const checked = solanaSignOnlyChecked(renewed.legs);
  // Each leg signed under the age rule (referenceLate), right before its signer is asked and when it answers: a late
  // leg is refused and its signature, if one was made, is dropped, never put in a wire or sent.
  const late = () => referenceLate(renewed.at, clock());
  const wires = await Promise.all(checked.map(async (p) => {
    const w = late() ?? (await signedWire(deps, p.leg.wallet, p.assembled, late));
    if (typeof w === "string") { p.rec.refused = w; return null; }
    return { p, tx: { wire: w, lastValidBlockHeight: p.assembled.lastValidBlockHeight } };
  }));
  const signedLegs = wires.filter((x): x is NonNullable<typeof x> => x !== null);
  const ready = signedLegs.map((x) => x.p);
  const set = signedLegs.map((x) => x.tx);
  if (ready.length === 0) { progress("refused"); return record; }
  ready.forEach((p, i) => { p.rec.signature = base58.encode((set[i] as { wire: Uint8Array }).wire.subarray(1, 65)); });
  try { deps.onSigned?.(ready.map((p) => ({ wallet: p.leg.wallet, signature: p.rec.signature as string }))); } catch { /* the caller's display never stops a trade */ }
  progress("signed");
  const sendOpts = { paths: deps.paths, providers: deps.providers, ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}), ...(deps.pollMs ? { pollMs: deps.pollMs } : {}), ...(deps.providerRps ? { providerRps: deps.providerRps } : {}) };
  const tokenProgram = (mint[0] as Acc).owner;
  if (deps.dry) {
    const d = await dryRunSolanaSet(set, sendOpts);
    ready.forEach((p, i) => { const x = d.txs[i]; if (x) p.rec.dry = x; });
    // Dry: nothing landed, so the teardown is planned and simulated on today's accounts, after each sell-all.
    if (req.side === "sell") await Promise.all(ready.map(async (p) => { if (p.rec.sellsAll) p.rec.teardown = await teardown(req, p.rec, deps, tokenProgram, false); }));
    return record;
  }
  const h = sendSolanaSet(set, sendOpts);
  progress("sent");
  const done = await h.done;
  await finishSolanaSet(req, ready.map((p) => p.rec), done.txs, deps, tokenProgram, progress);
  return record;
}

/**
 * After the send, for the signed legs in send order: each tx's outcome on its record, an unknown read again on both
 * providers (settleSolanaSet), and the stage: filled when every leg filled, part_filled when some did, not_landed only
 * when none filled and none is still unknown; null (no stage) while one is unknown with none filled. The stage goes to
 * `onStage` as soon as it is known, before any teardown. Then, on a sell, the teardown behind each filled leg that sold
 * the wallet's whole balance, and only those; it reads the token account empty on both providers first, and never
 * throws (a failed read is recorded on rec.teardown).
 */
export async function finishSolanaSet(req: SolanaTradeRequest, recs: readonly SolanaLegRecord[], txs: readonly SolanaTxOutcome[], bareDeps: SolanaTradeDeps, tokenProgram: string, onStage: (s: SolanaTradeStage) => void = () => {}): Promise<SolanaTradeStage | null> {
  if (recs.length !== txs.length) throw new Error("one outcome a signed leg");
  const deps = pacedDeps(bareDeps);
  const settled = await settleSolanaSet(deps.providers, txs);
  recs.forEach((rec, i) => {
    const st = settled[i] as Awaited<ReturnType<typeof settleSolanaSet>>[number];
    rec.outcome = txs[i] as SolanaTxOutcome;
    if (st.reread) rec.reread = st.reread;
  });
  const states = settled.map((x) => x.state);
  const filled = states.filter((x) => x === "filled").length;
  const unknown = states.some((x) => x === "unknown");
  const stage: SolanaTradeStage | null = filled === recs.length ? "filled" : filled > 0 ? "part_filled" : unknown ? null : "not_landed";
  if (stage) onStage(stage);
  if (req.side === "sell") {
    await Promise.all(
      recs.map(async (rec, i) => {
        if (states[i] !== "filled" || !rec.sellsAll) return;
        rec.teardown = await teardown(req, rec, deps, tokenProgram, true);
      }),
    );
  }
  return stage;
}
