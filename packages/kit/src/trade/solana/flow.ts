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
//   providers already hold it, with that read's own lastValidBlockHeight.
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
  assembleSolanaSwap,
  buildSolanaTeardown,
  fetchSolanaJupiterBuild,
  fetchSolanaJupiterBuildThatFits,
  readSolanaBlockhash,
  simulateSolanaTeardown,
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
  verdict?: SolanaQuoteVerdict;
  signature?: string;
  outcome?: SolanaTxOutcome;
  dry?: SolanaDryTx;
  /** The unknown-at-deadline re-read, when one ran. */
  reread?: { state: "filled" | "failed" | "unknown"; reads: readonly [unknown, unknown] };
  teardown?: { verdict: SolanaTeardownVerdict; frames: number; outcomes?: SolanaTxOutcome[]; dry?: SolanaDryTx[]; refused?: string };
};
export type SolanaTradeRecord = { side: "buy" | "sell"; token: string; reference: bigint | null; blockhash: SolanaBlockhash | null; legs: SolanaLegRecord[] };

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

type Prepared = { leg: SolanaTradeLeg; rec: SolanaLegRecord; assembled: SolanaAssembled };

async function prepareLeg(
  req: SolanaTradeRequest,
  leg: SolanaTradeLeg,
  rec: SolanaLegRecord,
  ctx: { deps: SolanaTradeDeps; blockhash: SolanaBlockhash; mint: [Acc | null, Acc | null]; otherWallets: readonly string[]; links: SolanaWalletLinks; heldMints: readonly string[] },
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
  const opts = { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}) };
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
  // The cap search: 40, up on no route, down when the assembly is over 1,232 bytes (build.ts, Jupiter's requote).
  const found = await fetchSolanaJupiterBuildThatFits(deps.helper, breq, fitOn, opts);
  rec.buildCaps = found.steps;
  let calls = found.calls.length;
  let build = found.build;
  let fitted = found.fitted;
  let amounts = solanaRouteAmounts(build.swap.data);
  if (!amounts) { rec.refused = "the build's swap is not a route the device decodes"; return null; }
  if (solanaRouteFloor(amounts) < minOut) {
    // the floor's rebuild: once, at the cap the search found
    const s = solanaRebuildSlippage(amounts.quotedOut, minOut);
    if (s === null) { rec.refused = `the route quotes ${amounts.quotedOut}, not above the floor ${minOut}`; return null; }
    const again = await fetchSolanaJupiterBuild(deps.helper, { ...breq, slippageBps: s }, { ...opts, maxAccounts: found.maxAccounts });
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
  // at most 4). No other wallet of the user is in it: S11 refuses a tx that names one, so none can change.
  const b64 = btoa(String.fromCharCode(...assembled.wire));
  const simErrors: string[] = [];
  const simOne = async (rpc: SolanaRpc, at: "A" | "B", before: (Acc | null)[]): Promise<SolanaSimulation | null> => {
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
        walletLamports: { pre: before[0]?.lamports ?? 0n, post: (m[0] as Acc).lamports },
        tokenAccount: { pre: tokenAmount(before[1] ?? null), post: tokenAmount(m[1] ?? null) },
        tokenAccountLamports: { pre: before[1]?.lamports ?? 0n, post: m[1]?.lamports ?? 0n },
        pumpVolumeAccumulator: { pre: before[2]?.lamports ?? 0n, post: m[2]?.lamports ?? 0n },
        pumpSwapVolumeAccumulator: { pre: before[3]?.lamports ?? 0n, post: m[3]?.lamports ?? 0n },
      };
    } catch (e) {
      simErrors.push(`${at}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      return null;
    }
  };
  const simulations = await Promise.all([simOne(pa, "A", pre[0]), simOne(pb, "B", pre[1])]);
  if (simErrors.length) rec.simulationErrors = simErrors;
  // The pre-state read again on both providers after the simulations: the bounds S11 draws from it hold only if nothing
  // moved this wallet's accounts meanwhile, so any change refuses the leg.
  const again = await both((r) => readAccounts(r, watch, "confirmed"), deps.providers);
  if (!sameAccounts(pre[0], again[0]) || !sameAccounts(pre[1], again[1])) { rec.refused = "the wallet's accounts changed while the trade was checked"; return null; }
  // Spendable, the lower of the two providers' pre-state: lamports on a buy, the token account's balance on a sell.
  const spend = (x: (Acc | null)[]) => (req.side === "buy" ? (x[0]?.lamports ?? 0n) : tokenAmount(x[1] ?? null));
  const spendable = spend(pre[0]) < spend(pre[1]) ? spend(pre[0]) : spend(pre[1]);
  rec.sellsAll = req.side === "sell" && leg.amount === spendable;
  await growth;
  const verdict = checkSolanaQuote(assembled.wire, { side: req.side, wallet: w, token: req.token, amount: leg.amount, spendable, minOut, otherWallets: ctx.otherWallets, links: ctx.links, heldMints: ctx.heldMints }, {
    tables,
    mint: [ctx.mint[0], ctx.mint[1]],
    rent: { tokenAccount: [rent[0][0], rent[1][0]], pumpVolumeAccumulator: [rent[0][1], rent[1][1]] },
    simulations,
    reference: { expectedOut: rec.legExpectedOut as bigint, minOutBase: rec.expectedOut as bigint, slippageBps: req.slippageBps },
  });
  rec.quoteMs = now() - t0;
  rec.size = assembled.size;
  rec.verdict = verdict;
  if (!verdict.ok) { rec.refused = `checks: ${verdict.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`).join("; ").slice(0, 400)}`; return null; }
  return { leg, rec, assembled };
}

/** Each tx signed, and sent with the very height its signer was handed: one path for the trade and its teardowns. */
function signSet(deps: Pick<SolanaTradeDeps, "dry" | "sign">, items: readonly { wallet: string; tx: { wire: Uint8Array; message: Uint8Array; lastValidBlockHeight: number } }[]): Promise<{ wire: Uint8Array; lastValidBlockHeight: number }[]> {
  return Promise.all(items.map(async ({ wallet, tx }) => ({ wire: await solanaSignedWire(deps, wallet, tx), lastValidBlockHeight: tx.lastValidBlockHeight })));
}

/** The signature into the wire's one slot, checked against the wallet's key before anything is sent. */
export async function solanaSignedWire(deps: Pick<SolanaTradeDeps, "dry" | "sign">, wallet: string, a: { wire: Uint8Array; message: Uint8Array; lastValidBlockHeight: number }): Promise<Uint8Array> {
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
    if (!(sig instanceof Uint8Array) || sig.length !== 64 || !ed25519.verify(sig, a.message, base58.decode(wallet))) throw new Error(`the signature for ${wallet} does not verify`);
  }
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
  const prepared = (
    await Promise.all(
      live.map(async (i) => {
        const rec = recs[i] as SolanaLegRecord;
        if (rec.refused) return null;
        try {
          return await prepareLeg(req, req.legs[i] as SolanaTradeLeg, rec, { deps, blockhash, mint, otherWallets: [...all].filter((x) => x !== rec.wallet), links, heldMints });
        } catch (err) {
          rec.refused = err instanceof SolanaBuildError ? `build ${err.code}: ${err.message.slice(0, 160)}` : `error: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
          return null;
        }
      }),
    )
  ).filter((x): x is Prepared => x !== null);
  if (prepared.length === 0) { progress("refused"); return record; }
  const set = await signSet(deps, prepared.map((p) => ({ wallet: p.leg.wallet, tx: p.assembled })));
  prepared.forEach((p, i) => { p.rec.signature = base58.encode((set[i] as { wire: Uint8Array }).wire.subarray(1, 65)); });
  progress("signed");
  const sendOpts = { paths: deps.paths, providers: deps.providers, ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}), ...(deps.pollMs ? { pollMs: deps.pollMs } : {}), ...(deps.providerRps ? { providerRps: deps.providerRps } : {}) };
  const tokenProgram = (mint[0] as Acc).owner;
  if (deps.dry) {
    const d = await dryRunSolanaSet(set, sendOpts);
    prepared.forEach((p, i) => { const x = d.txs[i]; if (x) p.rec.dry = x; });
    // Dry: nothing landed, so the teardown is planned and simulated on today's accounts, after each sell-all.
    if (req.side === "sell") await Promise.all(prepared.map(async (p) => { if (p.rec.sellsAll) p.rec.teardown = await teardown(req, p.rec, deps, tokenProgram, false); }));
    return record;
  }
  const h = sendSolanaSet(set, sendOpts);
  progress("sent");
  const done = await h.done;
  await finishSolanaSet(req, prepared.map((p) => p.rec), done.txs, deps, tokenProgram, progress);
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
