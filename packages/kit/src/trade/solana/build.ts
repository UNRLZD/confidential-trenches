// The Solana swap build (markets paper T2.1 "Quote" and "Tx shape", docs/plan1/markets.md l.291-336; row M1.1).
// Device side. Jupiter's GET /swap/v2/build is asked through the helper's POST /v1/proxy/jupiter/swap/v2/build, which
// adds the key; the device then assembles the v0 transaction itself. Nothing in the build answer is trusted for what
// is signed: the answer only proposes instructions, and checkSolanaQuote (T2.2, S1-S13) judges the assembled bytes.
//
// - Query: inputMint, outputMint, amount = a_k, slippageBps, computeUnitPricePercentile=veryHigh, maxAccounts,
//   taker = W_k. Jupiter: maxAccounts "only applies to the total number of accounts of the inner swaps in the swap
//   instruction and not any of the setup, cleanup or other instructions"; "only reduce maxAccounts if you exceed the
//   transaction size limit", and when an app's own instructions push a transaction past 1,232 bytes, "reduce
//   maxAccounts in the /quote request and rebuild" (developers.jup.ag/docs/swap/get-quote and
//   /docs/swap/requote-with-lower-max-accounts, read 2026-11-05 03:10Z). A cap bounds accounts, not bytes: maxAccounts=48
//   once came back a 1,276-byte route (ExxzYBTt…pump's buy, 03:43Z), and uncapped BZFYNPeQ…B96W's buy 1,244 bytes
//   (helper live run 41956857743). So the trade's build is the cap search fetchSolanaJupiterBuildThatFits: 40 first,
//   a higher cap on "No routes found", a lower one when the device's own assembly is over 1,232 bytes, at most
//   SOLANA_JUPITER_MAX_BUILDS builds; see SOLANA_JUPITER_CAP_UP for the measured budget.
// - Blockhash: the device's own getLatestBlockhash at `finalized`, never the build's blockhashWithMetadata (the
//   solana-set-send review), so the lastValidBlockHeight the send judges expiry by is one the device read itself.
// - Lookup tables: the build names them; their contents come only from the device's own reads (S2), passed in.
// - Frame (T2.1, 06c S-1 and S-2): 0 SetComputeUnitLimit (the route cap S8 applies: a one-step pump.fun curve route
//   200,000 on a buy step and 150,000 on a sell step, every other route 600,000), 1 SetComputeUnitPrice (Jupiter's
//   veryHigh estimate, capped at 1,000,000 micro-lamports per unit), Jupiter's setup, the wallet's own output account
//   (CreateIdempotent) on a buy when the setup has none, the swap, a CloseAccount to W_k for every account the setup
//   created that nothing closes (6a; a Token-2022 account of a mint the caller names as holding a transfer fee gets
//   HarvestWithheldTokensToMint right before it), Jupiter's cleanup, Jupiter's other instructions, then a 5,000-lamport
//   tip to a baked Helius Sender account and a 10,000-lamport tip to a baked Jito account.
// - Size: the unsigned wire (one zeroed signature slot) at most SOLANA_MAX_TX_BYTES = 1,232, else refused (S9).
//
// Every answer is hostile input: size-bounded, shape-checked; anything else is SolanaBuildError("bad_answer").
import { base58, base64 } from "@scure/base";
import { HELPER_FETCH_INIT, HELPER_V1_PREFIX } from "../../helper/v1.ts";
import { SOLANA_ATA_PROGRAM, SOLANA_MAX_TX_BYTES, solanaAta, solanaDecodeMessage, solanaTableIsActive, type SolanaLookupTable } from "../../checks/solana/message.ts";
import {
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_CU_PRICE_MAX,
  SOLANA_JITO_TIP,
  SOLANA_JITO_TIP_ACCOUNTS,
  SOLANA_SENDER_TIP,
  SOLANA_SENDER_TIP_ACCOUNTS,
  SOLANA_SOL_MINT,
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  SOLANA_CLOSE_VOLUME_ACCUMULATOR,
  SOLANA_TEARDOWN_CU,
  solanaEventAuthority,
  solanaRouteCuCap,
  type SolanaTeardownPlan,
  type SolanaTeardownSimulation,
} from "../../checks/solana/checks.ts";
import type { SolanaFetch, SolanaRpc } from "./send.ts";

/** The vendor path on the helper's proxy (apps/helper/src/proxy/vendors.ts, jupiter "/swap/v2/build": GET). */
export const SOLANA_JUPITER_BUILD_PROXY_PATH = `${HELPER_V1_PREFIX}/proxy/jupiter/swap/v2/build`;
/** The first build's account cap (P4S run 1, Fail 1: an uncapped route overran 1,232 bytes once our instructions rode on top). */
export const SOLANA_JUPITER_MAX_ACCOUNTS = 40;
/**
 * The cap search, from a measured byte budget. The device's own part rides on Jupiter's: the two compute-budget
 * instructions, the two tips with their accounts and programs, a buy's output account, the closes. Assembled on the
 * device's own table reads, it measured 150 to 188 bytes over Jupiter's own instructions alone (188 with a close the
 * device adds; every build of the live check's recorded runs of 2026-11-02 to 2026-11-05), so Jupiter's setup, route,
 * cleanup and tables must fit in 1,232 - 188 = 1,044 bytes of their own. A route spends that by how many of its keys
 * no lookup table holds (32 bytes each, against 1 for a table index), not by its account count, so the steps are read
 * off real /swap/v2/build answers through the helper, each assembled on the device's own table reads (2026-11-05
 * 03:12-03:38Z; 0.01 SOL buys and the bought amount's sells):
 *   - 12 listed tokens, buy and sell (24 shapes; 22 route at 40, 7tRqzDMM…pump's two have no route at 40 or 48): at
 *     40, 44 and 48 no build passed 1,232 bytes (the largest 1,152, 1,065 and 1,185); at 52, 56, 60, 64 and uncapped
 *     3, 1, 4, 2 and 3 did (the largest 1,393).
 *   - 7 listed tokens with no route at 40 (new pump.fun curves), buy and sell (14 shapes): 44 routed none; 48 routed 10
 *     that fit; 52 routed 12; 56, 60, 64 and uncapped routed 9, 8, 8 and 8 that fit and 2, 5, 6 and 6 over 1,232.
 * Up on "No routes found": 40, 48, 60, what 3 builds reach (64 fit no shape that 40, 48 or 60 did not fit, so no step
 * goes past 60). Down when the device's assembly is over 1,232: 40 to 32, any other cap by 4,
 * never to a cap already known to have no route (then half way). Replayed on those reads, all 38 shapes got a build
 * that fits within 3 builds (22 at 40, 10 at 48, 6 at 60), where 40 then uncapped fit 32 (6 over 1,232) and 40 then
 * 48 fit 32 (6 with no route). The live check's ExxzYBTt…pump buy fits at 40 (1,010 bytes); its 1,276-byte answer at 48
 * is a cap the search asks only after no route at 40, and then steps down from.
 */
export const SOLANA_JUPITER_CAP_UP: Readonly<Record<number, number>> = { 40: 48, 48: 60 };
/** The cap after 40 when 40's route is over 1,232 bytes; any other cap steps down by SOLANA_JUPITER_CAP_DOWN. */
export const SOLANA_JUPITER_CAP_BELOW_FIRST = 32;
export const SOLANA_JUPITER_CAP_DOWN = 4;
/**
 * The most cap-search builds a leg makes. With the one floor rebuild flow.ts may add, a leg asks at most 4, so K legs
 * searching at once ask K to 4K and a one-leg trade at most 4, the helper's share (apps/helper/src/proxy/proxy.ts
 * PROXY_BUDGETS.jupiter).
 */
export const SOLANA_JUPITER_MAX_BUILDS = 3;
/** The first step up: the cap fetchSolanaJupiterBuild retries at when 40 finds no route. */
export const SOLANA_JUPITER_RETRY_MAX_ACCOUNTS = SOLANA_JUPITER_CAP_UP[SOLANA_JUPITER_MAX_ACCOUNTS] as number;

/**
 * The next cap of the search, or null when none is left. `lo` is the highest cap known to have no route (0 for none),
 * `hi` the lowest known to be over 1,232 bytes (65 for none); a next cap is always strictly between them. No route at
 * a cap with no step up (60, the top) goes half way only below a cap known too large, else ends the search.
 */
export function solanaNextCap(cap: number, outcome: "no_route" | "too_large", lo: number, hi: number): number | null {
  let next = outcome === "no_route" ? SOLANA_JUPITER_CAP_UP[cap] : cap === SOLANA_JUPITER_MAX_ACCOUNTS ? SOLANA_JUPITER_CAP_BELOW_FIRST : cap - SOLANA_JUPITER_CAP_DOWN;
  if (next === undefined && outcome === "no_route" && hi > 64) return null;
  if (next === undefined || next <= lo || next >= hi) next = Math.floor((lo + hi) / 2);
  return next > lo && next < hi && next >= 1 && next <= 64 ? next : null;
}
/** Jupiter's answer when no route fits (P4S run 3, Fail 3; read through the helper 2026-11-02 04:58Z: 400 {"error":"No routes found"}). */
export const SOLANA_JUPITER_NO_ROUTE = "No routes found";
/** One build call is given up after this. */
export const SOLANA_BUILD_TIMEOUT_MS = 5_000;
/** A build is a few KB; its lookup-table lists, which the device never uses, are the bulk (3 tables of ~250 keys ~ 35 KB). */
export const SOLANA_BUILD_ANSWER_MAX_BYTES = 256 * 1024;

const MAX_INSTRUCTION_ACCOUNTS = 256;
const MAX_INSTRUCTION_DATA = SOLANA_MAX_TX_BYTES;
const MAX_SETUP = 16;
const MAX_OTHER = 8;
const MAX_BUDGET = 4;
const MAX_TABLES = 8;
const MAX_ROUTE_STEPS = 16;

export type SolanaBuildErrorCode = "no_route" | "upstream" | "bad_answer" | "too_large";
export class SolanaBuildError extends Error {
  readonly code: SolanaBuildErrorCode;
  constructor(code: SolanaBuildErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "SolanaBuildError";
  }
}
const bad = (m: string): never => {
  throw new SolanaBuildError("bad_answer", m);
};

/** What the device asks Jupiter to build: the user's own request for one wallet. */
export type SolanaBuildRequest = {
  side: "buy" | "sell";
  wallet: string; // W_k, the taker, fee payer and only signer
  token: string; // the token the user tapped
  amount: bigint; // a_k: lamports on a buy, the token's base units on a sell
  slippageBps: number; // set by the buy flow so that the decoded floor is at least minOut_k (T2.1, §1.3)
};

export type SolanaApiAccount = { readonly key: string; readonly signer: boolean; readonly writable: boolean };
export type SolanaApiInstruction = { readonly program: string; readonly accounts: readonly SolanaApiAccount[]; readonly data: Uint8Array };
/** The build answer, shape-checked. Only instructions and table addresses are kept; amounts and quotes are not read. */
export type SolanaJupiterBuild = {
  readonly cuPrice: bigint;
  readonly setup: readonly SolanaApiInstruction[];
  readonly swap: SolanaApiInstruction;
  readonly cleanup: SolanaApiInstruction | null;
  readonly other: readonly SolanaApiInstruction[];
  /** The tables the build names; the device reads their contents itself. */
  readonly tables: readonly string[];
  /** Venue labels from routePlan, for display only. */
  readonly route: readonly string[];
};
export type SolanaBuildCall = { maxAccounts: number | null; status: number; ms: number };
/**
 * `retried`: the build is the retry's, at SOLANA_JUPITER_RETRY_MAX_ACCOUNTS. `uncapped` is kit-v1.4's name for it,
 * kept as a deprecated alias (the retry has a cap now). `maxAccounts`: the cap the build was asked at.
 */
export type SolanaBuildFetched = {
  build: SolanaJupiterBuild;
  retried: boolean;
  /** @deprecated kit-v1.4's name for `retried`. */
  uncapped: boolean;
  maxAccounts: number;
  calls: SolanaBuildCall[];
};
export type SolanaBuildOptions = { fetch?: SolanaFetch; timeoutMs?: number; now?: () => number; wait?: SolanaBuildWait };
/**
 * Waiting for the helper's room (card solana-legs-share-wait): a 429 (past the device's share) or 503 (the vendor's
 * total or reset) that names a Retry-After is waited out and asked again, never a cap step, while the wait ends by
 * `until` (on `clock`, ms); one that would end past it is refused ("upstream", no room by the trade's bound). After a
 * wait, a search that has no step yet asks `knownCap()` when it names one: the cap another leg of the trade already
 * found. With no `wait`, such an answer is "upstream" at once, as before.
 */
export type SolanaBuildWait = {
  until: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  knownCap?: () => number | undefined;
  onWait?: (ms: number) => void;
};
/**
 * A trade's wait for the helper's room, shared by its legs (card solana-legs-share-wait): every leg searches at once;
 * a leg the helper answers past its share or room waits the Retry-After inside the trade's bound (`until`, on `clock`),
 * then asks the cap another leg already fitted (`fitted`), 1 build plus its floor rebuild. `progress` is what the app
 * shows: legs built (fitted or refused), legs waiting now, legs in all.
 */
export class SolanaBuildRoom {
  readonly until: number;
  readonly total: number;
  cap: number | undefined;
  built = 0;
  waiting = 0;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #tell: ((p: { built: number; waiting: number; total: number }) => void) | undefined;
  constructor(o: { total: number; boundMs: number; clock?: () => number; sleep?: (ms: number) => Promise<void>; onProgress?: (p: { built: number; waiting: number; total: number }) => void }) {
    this.#clock = o.clock ?? (() => performance.now());
    this.#sleep = o.sleep ?? ((ms) => new Promise<void>((ok) => setTimeout(ok, ms)));
    this.#tell = o.onProgress;
    this.total = o.total;
    this.until = this.#clock() + o.boundMs;
  }
  get progress(): { built: number; waiting: number; total: number } {
    return { built: this.built, waiting: this.waiting, total: this.total };
  }
  #told(): void {
    try { this.#tell?.(this.progress); } catch { /* the caller's display never stops a trade */ }
  }
  /** The wait a leg's builds take (SolanaBuildOptions.wait). */
  get wait(): SolanaBuildWait {
    return {
      until: this.until,
      clock: this.#clock,
      knownCap: () => this.cap,
      sleep: async (ms) => {
        this.waiting++;
        this.#told();
        try { await this.#sleep(ms); } finally { this.waiting--; this.#told(); }
      },
    };
  }
  /** A leg's search fitted at `cap`: the cap a leg asks after its wait, when no leg fitted before. */
  fitted(cap: number): void {
    this.cap ??= cap;
  }
  /** A leg's build is done, fitted or refused. */
  done(): void {
    this.built++;
    this.#told();
  }
}
/** The longest Retry-After the device takes from the helper: the vendor's minute and its second. */
export const SOLANA_BUILD_RETRY_AFTER_MAX_S = 61;

const isKey = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return false;
  try {
    return base58.decode(v).length === 32;
  } catch {
    return false;
  }
};
const obj = (v: unknown, what: string): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(`${what} is not an object`));
const arr = (v: unknown, what: string, max: number): unknown[] => {
  if (!Array.isArray(v)) return bad(`${what} is not an array`);
  if (v.length > max) bad(`${what} has ${v.length} entries (at most ${max})`);
  return v;
};

function instruction(v: unknown, what: string): SolanaApiInstruction {
  const o = obj(v, what);
  if (!isKey(o.programId)) bad(`${what}.programId is not an address`);
  const accounts = arr(o.accounts, `${what}.accounts`, MAX_INSTRUCTION_ACCOUNTS).map((a, i) => {
    const x = obj(a, `${what}.accounts[${i}]`);
    if (!isKey(x.pubkey) || typeof x.isSigner !== "boolean" || typeof x.isWritable !== "boolean") bad(`${what}.accounts[${i}] is not { pubkey, isSigner, isWritable }`);
    return { key: x.pubkey as string, signer: x.isSigner as boolean, writable: x.isWritable as boolean };
  });
  if (typeof o.data !== "string" || o.data.length > Math.ceil(MAX_INSTRUCTION_DATA / 3) * 4) bad(`${what}.data is not base64 within ${MAX_INSTRUCTION_DATA} bytes`);
  let data: Uint8Array;
  try {
    data = base64.decode(o.data as string);
  } catch {
    return bad(`${what}.data is not base64`);
  }
  return { program: o.programId as string, accounts, data };
}

/** Shape-checks one /swap/v2/build answer. Throws SolanaBuildError("bad_answer") on anything else. */
export function parseSolanaJupiterBuild(answer: unknown): SolanaJupiterBuild {
  const o = obj(answer, "the build");
  const budget = arr(o.computeBudgetInstructions, "computeBudgetInstructions", MAX_BUDGET).map((x, i) => instruction(x, `computeBudgetInstructions[${i}]`));
  const price = budget.filter((ix) => ix.program === SOLANA_COMPUTE_BUDGET_PROGRAM && ix.accounts.length === 0 && ix.data.length === 9 && ix.data[0] === 3);
  if (price.length !== 1) bad(`${price.length} compute unit prices in the build (want 1)`);
  const p = new DataView((price[0] as SolanaApiInstruction).data.buffer, (price[0] as SolanaApiInstruction).data.byteOffset, 9).getBigUint64(1, true);
  const setup = arr(o.setupInstructions, "setupInstructions", MAX_SETUP).map((x, i) => instruction(x, `setupInstructions[${i}]`));
  const swap = instruction(o.swapInstruction, "swapInstruction");
  const cleanup = o.cleanupInstruction === null || o.cleanupInstruction === undefined ? null : instruction(o.cleanupInstruction, "cleanupInstruction");
  const other = (o.otherInstructions === undefined || o.otherInstructions === null ? [] : arr(o.otherInstructions, "otherInstructions", MAX_OTHER)).map((x, i) => instruction(x, `otherInstructions[${i}]`));
  const lists = o.addressesByLookupTableAddress === null || o.addressesByLookupTableAddress === undefined ? {} : obj(o.addressesByLookupTableAddress, "addressesByLookupTableAddress");
  const tables = Object.keys(lists);
  if (tables.length > MAX_TABLES) bad(`${tables.length} lookup tables (at most ${MAX_TABLES})`);
  for (const t of tables) if (!isKey(t)) bad(`lookup table ${String(t).slice(0, 50)} is not an address`);
  const route = (o.routePlan === undefined ? [] : arr(o.routePlan, "routePlan", MAX_ROUTE_STEPS)).map((s) => {
    const label = (s as { swapInfo?: { label?: unknown } } | null)?.swapInfo?.label;
    return typeof label === "string" ? label.slice(0, 64) : "?";
  });
  return { cuPrice: p < SOLANA_CU_PRICE_MAX ? p : SOLANA_CU_PRICE_MAX, setup, swap, cleanup, other, tables, route };
}

/**
 * The /swap/v2/build query for one wallet, in a fixed order, at maxAccounts 1 to 64 (Jupiter's range). null leaves
 * maxAccounts out: kept only for kit-v1.4's callers (deprecated); none of the kit's own builds asks it.
 */
export function solanaJupiterBuildQuery(req: SolanaBuildRequest, maxAccounts: number | null = SOLANA_JUPITER_MAX_ACCOUNTS): string {
  if (maxAccounts !== null && (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 64)) throw new Error("maxAccounts must be 1 to 64");
  if (!isKey(req.wallet) || !isKey(req.token)) throw new Error("the wallet and the token must be addresses");
  if (req.token === SOLANA_SOL_MINT) throw new Error("the token cannot be native SOL");
  if (typeof req.amount !== "bigint" || req.amount <= 0n || req.amount > 0xffff_ffff_ffff_ffffn) throw new Error("the amount must be a u64 above 0");
  if (!Number.isInteger(req.slippageBps) || req.slippageBps < 0 || req.slippageBps > 10_000) throw new Error("slippageBps must be 0 to 10,000");
  const [inputMint, outputMint] = req.side === "buy" ? [SOLANA_SOL_MINT, req.token] : [req.token, SOLANA_SOL_MINT];
  const q = new URLSearchParams({ inputMint, outputMint, amount: req.amount.toString(), slippageBps: String(req.slippageBps), computeUnitPricePercentile: "veryHigh" });
  if (maxAccounts !== null) q.set("maxAccounts", String(maxAccounts));
  q.set("taker", req.wallet);
  return q.toString();
}

async function readCapped(r: Response, max: number): Promise<string> {
  if (Number(r.headers.get("content-length") ?? "0") > max) throw new SolanaBuildError("bad_answer", "the build answer is too large");
  if (!r.body) return "";
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      void reader.cancel().catch(() => {});
      throw new SolanaBuildError("bad_answer", "the build answer is too large");
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

function helperOrigin(origin: string): string {
  let u: URL;
  try { u = new URL(origin); } catch { throw new Error("the helper origin must be an https URL"); }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error("the helper origin must be an https URL");
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash || !(origin === u.origin || origin === `${u.origin}/`)) throw new Error("the helper origin must be an origin only");
  return u.origin;
}

type BuildAnswer = { status: number; body: unknown; cap: number | null };
const isNoRoute = (a: BuildAnswer) => a.status === 400 && typeof a.body === "object" && a.body !== null && (a.body as { error?: unknown }).error === SOLANA_JUPITER_NO_ROUTE;

/** A Retry-After in whole seconds, 0 to SOLANA_BUILD_RETRY_AFTER_MAX_S, else null (the helper's own form). */
function retryAfterS(r: Response): number | null {
  const v = r.headers.get("retry-after");
  if (v === null || !/^\d{1,4}$/.test(v)) return null;
  const s = Number(v);
  return s <= SOLANA_BUILD_RETRY_AFTER_MAX_S ? s : null;
}

/**
 * One build at one cap, each call's time and status kept in `calls`; with `opts.wait`, a 429 or 503 naming a
 * Retry-After is waited out and asked again (SolanaBuildWait), at `knownCap()` after a wait when `first` (the search's
 * first ask). Returns the answer and the cap it was asked at.
 */
async function askBuild(base: string, req: SolanaBuildRequest, maxAccounts: number | null, opts: SolanaBuildOptions, calls: SolanaBuildCall[], first = false): Promise<BuildAnswer> {
  for (;;) {
    const a = await askOnce(base, req, maxAccounts, opts, calls);
    const w = opts.wait;
    if (!w || (a.status !== 429 && a.status !== 503) || a.retryAfterS === null) return { status: a.status, body: a.body, cap: maxAccounts };
    const clock = w.clock ?? (() => Date.now());
    const ms = Math.max(a.retryAfterS, 1) * 1000;
    if (clock() + ms > w.until) throw new SolanaBuildError("upstream", `HTTP ${a.status}: no room by the trade's bound (Retry-After ${a.retryAfterS} s)`);
    w.onWait?.(ms);
    await (w.sleep ?? ((d: number) => new Promise<void>((ok) => setTimeout(ok, d))))(ms);
    const known = first ? w.knownCap?.() : undefined;
    if (known !== undefined && Number.isInteger(known) && known >= 1 && known <= 64) maxAccounts = known;
  }
}

async function askOnce(base: string, req: SolanaBuildRequest, maxAccounts: number | null, opts: SolanaBuildOptions, calls: SolanaBuildCall[]): Promise<{ status: number; body: unknown; retryAfterS: number | null }> {
  const doFetch: SolanaFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? (() => performance.now());
  const url = `${base}${SOLANA_JUPITER_BUILD_PROXY_PATH}?${solanaJupiterBuildQuery(req, maxAccounts)}`;
  const t = now();
  let r: Response;
  let text: string;
  try {
    r = await doFetch(url, { ...HELPER_FETCH_INIT, method: "POST", redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? SOLANA_BUILD_TIMEOUT_MS) });
    text = await readCapped(r, SOLANA_BUILD_ANSWER_MAX_BYTES);
  } catch (e) {
    calls.push({ maxAccounts, status: 0, ms: now() - t });
    if (e instanceof SolanaBuildError) throw e;
    throw new SolanaBuildError("upstream", `the helper did not answer: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  calls.push({ maxAccounts, status: r.status, ms: now() - t });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SolanaBuildError(r.status === 200 ? "bad_answer" : "upstream", `HTTP ${r.status}, not JSON`);
  }
  return { status: r.status, body, retryAfterS: retryAfterS(r) };
}

/** A 200 build parsed; any other answer but "No routes found" is "upstream". */
function builtOrUpstream(a: BuildAnswer): SolanaJupiterBuild {
  if (a.status !== 200) {
    const code = (a.body as { error?: unknown; errorCode?: unknown } | null)?.error;
    throw new SolanaBuildError("upstream", `HTTP ${a.status}${typeof code === "string" ? ` ${code.slice(0, 80)}` : ""}`);
  }
  return parseSolanaJupiterBuild(a.body);
}

/**
 * Asks the helper's proxy for Jupiter's build: maxAccounts=40 first, and one retry at SOLANA_JUPITER_RETRY_MAX_ACCOUNTS
 * only when that answer is Jupiter's 400 "No routes found". The retry's own "No routes found" is
 * SolanaBuildError("no_route"); any other non-200 answer (the helper's 503 upstream included) is "upstream" and is
 * never retried here. `maxAccounts` asks one build at that cap, with no retry (the floor rebuild of flow.ts);
 * `atRetryCap` asks at the retry's cap from the start, with no retry; kit-v1.4's `uncapped` is its deprecated alias
 * (the retry has a cap now). This is one step; a trade's build is fetchSolanaJupiterBuildThatFits.
 */
export async function fetchSolanaJupiterBuild(
  origin: string,
  req: SolanaBuildRequest,
  opts: SolanaBuildOptions & { maxAccounts?: number; atRetryCap?: boolean; /** @deprecated kit-v1.4's name for atRetryCap. */ uncapped?: boolean } = {},
): Promise<SolanaBuildFetched> {
  const base = helperOrigin(origin);
  const calls: SolanaBuildCall[] = [];
  const done = (build: SolanaJupiterBuild, retried: boolean, maxAccounts: number): SolanaBuildFetched => ({ build, retried, uncapped: retried, maxAccounts, calls });
  if (opts.maxAccounts !== undefined) {
    if (!Number.isInteger(opts.maxAccounts) || opts.maxAccounts < 1 || opts.maxAccounts > 64) throw new Error("maxAccounts must be 1 to 64");
    const a = await askBuild(base, req, opts.maxAccounts, opts, calls);
    if (isNoRoute(a)) throw new SolanaBuildError("no_route", `no route at maxAccounts=${opts.maxAccounts}`);
    return done(builtOrUpstream(a), false, opts.maxAccounts);
  }
  const start = opts.atRetryCap === true || opts.uncapped === true;
  let cap = start ? SOLANA_JUPITER_RETRY_MAX_ACCOUNTS : SOLANA_JUPITER_MAX_ACCOUNTS;
  let a = await askBuild(base, req, cap, opts, calls);
  if (start && isNoRoute(a)) throw new SolanaBuildError("no_route", `no route at maxAccounts=${SOLANA_JUPITER_RETRY_MAX_ACCOUNTS}`);
  if (!start && isNoRoute(a)) {
    cap = SOLANA_JUPITER_RETRY_MAX_ACCOUNTS;
    a = await askBuild(base, req, cap, opts, calls);
    if (isNoRoute(a)) throw new SolanaBuildError("no_route", `no route at maxAccounts=${SOLANA_JUPITER_MAX_ACCOUNTS} or ${SOLANA_JUPITER_RETRY_MAX_ACCOUNTS}`);
  }
  return done(builtOrUpstream(a), start || cap !== SOLANA_JUPITER_MAX_ACCOUNTS, cap);
}

/** One build of the cap search, as the caller's `fit` judged it. */
export type SolanaCapStep = { maxAccounts: number; outcome: "fits" | "no_route" | "too_large"; size?: number };
export type SolanaBuildFitted<T> = { build: SolanaJupiterBuild; fitted: T; maxAccounts: number; steps: SolanaCapStep[]; calls: SolanaBuildCall[] };

/**
 * The trade's build: Jupiter's requote with lower max accounts, judged on the device's own assembly. Asks at 40; on
 * "No routes found" steps up (SOLANA_JUPITER_CAP_UP), and when `fit` (the caller's own reads and assembly, e.g.
 * assembleSolanaSwap) throws SolanaBuildError("too_large") steps down (solanaNextCap), at most `maxBuilds`
 * (SOLANA_JUPITER_MAX_BUILDS) builds. Returns the first build `fit` accepts, with what `fit` returned. When none does:
 * SolanaBuildError("too_large") if any build was over 1,232 bytes, else "no_route". Any other error, from a build or
 * from `fit`, ends the search as it is (an "upstream" answer is never retried here). Nothing is returned that `fit`
 * did not accept, so a transaction over 1,232 bytes never leaves it. `startAt` asks that cap first instead of 40 (the
 * live check's probe asks the search's steps past 40 with it).
 */
export async function fetchSolanaJupiterBuildThatFits<T>(
  origin: string,
  req: SolanaBuildRequest,
  fit: (build: SolanaJupiterBuild, maxAccounts: number) => T | Promise<T>,
  opts: SolanaBuildOptions & { maxBuilds?: number; startAt?: number } = {},
): Promise<SolanaBuildFitted<T>> {
  const base = helperOrigin(origin);
  const maxBuilds = opts.maxBuilds ?? SOLANA_JUPITER_MAX_BUILDS;
  if (!Number.isInteger(maxBuilds) || maxBuilds < 1 || maxBuilds > SOLANA_JUPITER_MAX_BUILDS) throw new Error(`maxBuilds must be 1 to ${SOLANA_JUPITER_MAX_BUILDS}`);
  const startAt = opts.startAt ?? SOLANA_JUPITER_MAX_ACCOUNTS;
  if (!Number.isInteger(startAt) || startAt < 1 || startAt > 64) throw new Error("startAt must be 1 to 64");
  const calls: SolanaBuildCall[] = [];
  const steps: SolanaCapStep[] = [];
  let cap: number | null = startAt;
  let lo = 0;
  let hi = 65;
  let largest: string | null = null;
  while (cap !== null && steps.length < maxBuilds) {
    const a = await askBuild(base, req, cap, opts, calls, steps.length === 0);
    cap = a.cap as number;
    if (isNoRoute(a)) {
      steps.push({ maxAccounts: cap, outcome: "no_route" });
      lo = cap;
      cap = solanaNextCap(cap, "no_route", lo, hi);
      continue;
    }
    const build = builtOrUpstream(a);
    try {
      const fitted = await fit(build, cap);
      steps.push({ maxAccounts: cap, outcome: "fits" });
      return { build, fitted, maxAccounts: cap, steps, calls };
    } catch (e) {
      if (!(e instanceof SolanaBuildError && e.code === "too_large")) throw e;
      const size = Number(/(\d+) bytes/.exec(e.message)?.[1] ?? NaN);
      steps.push({ maxAccounts: cap, outcome: "too_large", ...(Number.isFinite(size) ? { size } : {}) });
      largest ??= e.message;
      hi = cap;
      cap = solanaNextCap(cap, "too_large", lo, hi);
    }
  }
  const tried = steps.map((x) => `${x.maxAccounts} ${x.outcome}${x.size ? ` ${x.size}` : ""}`).join(", ");
  if (largest !== null) throw new SolanaBuildError("too_large", `no build within ${SOLANA_MAX_TX_BYTES} bytes (${tried})`);
  throw new SolanaBuildError("no_route", `no route (${tried})`);
}

export type SolanaBlockhash = { blockhash: string; lastValidBlockHeight: number; slot: number };
/** The device's own blockhash: getLatestBlockhash at `finalized` on one of its providers. */
export async function readSolanaBlockhash(rpc: SolanaRpc): Promise<SolanaBlockhash> {
  const r = obj(await rpc("getLatestBlockhash", [{ commitment: "finalized" }]), "getLatestBlockhash");
  const ctx = obj(r.context, "getLatestBlockhash.context");
  const v = obj(r.value, "getLatestBlockhash.value");
  if (!isKey(v.blockhash) || !Number.isSafeInteger(v.lastValidBlockHeight) || (v.lastValidBlockHeight as number) <= 0 || !Number.isSafeInteger(ctx.slot) || (ctx.slot as number) <= 0) {
    bad("getLatestBlockhash answered no blockhash, lastValidBlockHeight and slot");
  }
  return { blockhash: v.blockhash as string, lastValidBlockHeight: v.lastValidBlockHeight as number, slot: ctx.slot as number };
}

// ---------------------------------------------------------------------------------------------------------------
// v0 assembly
// ---------------------------------------------------------------------------------------------------------------

const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u64le = (n: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
function compact(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

/**
 * A v0 message from instructions, the fee payer and the tables, laid out as @solana/web3.js 1.98.4's
 * TransactionMessage.compileToV0Message does (src/message/compiled-keys.ts: keys in first-use order in a Map; the
 * kit's test holds the bytes web3.js made for a recorded two-table build). solana-sdk's v0::Message::try_compile keeps
 * its keys in a BTreeMap, so it orders them by address instead: a different, equally valid message. Every key once
 * with its signer and writable flags merged; a key that signs or is a program id stays static; any other key found in
 * a table is loaded from the first table that holds it (that table's writable then readonly indexes, in first-use
 * order); static keys are writable signers (the payer first), readonly signers, writable non-signers, readonly
 * non-signers; loaded keys follow, every table's writable entries, then every table's readonly. Only `signers` may
 * sign (the wallet alone for a swap; the fee payer and W for a pool release, src/trade/solana/pool-buy.ts). A Jito tip
 * account (SOLANA_JITO_TIP_ACCOUNTS) always stays static, even when a table holds it.
 */
export function solanaCompileV0(
  payer: string,
  ixs: readonly SolanaApiInstruction[],
  blockhash: string,
  tables: readonly { address: string; table: SolanaLookupTable }[],
  signers: readonly string[] = [payer],
): { message: Uint8Array; tablesUsed: string[] } {
  type Meta = { signer: boolean; writable: boolean; invoked: boolean };
  const meta = new Map<string, Meta>([[payer, { signer: true, writable: true, invoked: false }]]);
  const touch = (k: string, m: Partial<Meta>) => {
    const old = meta.get(k) ?? { signer: false, writable: false, invoked: false };
    meta.set(k, { signer: old.signer || !!m.signer, writable: old.writable || !!m.writable, invoked: old.invoked || !!m.invoked });
  };
  for (const ix of ixs) {
    touch(ix.program, { invoked: true });
    for (const a of ix.accounts) touch(a.key, { signer: a.signer, writable: a.writable });
  }
  for (const [k, m] of meta) if (m.signer && !signers.includes(k)) bad(`an instruction asks ${k} to sign (only ${signers.join(" and ")} sign)`);
  const lookups: { address: string; writable: number[]; readonly: number[]; wKeys: string[]; rKeys: string[] }[] = [];
  for (const { address, table } of tables) {
    const l = { address, writable: [] as number[], readonly: [] as number[], wKeys: [] as string[], rKeys: [] as string[] };
    for (const [k, m] of [...meta]) {
      // a Jito tip account is never loaded, whatever a table holds: "When tipping make sure to not use Address Lookup
      // Tables for the tip accounts" (docs.jito.wtf/lowlatencytxnsend, read 2026-11-03), so a block engine counts the tip (M362 (4))
      if (m.signer || m.invoked || SOLANA_JITO_TIP_ACCOUNTS.includes(k)) continue;
      const i = table.addresses.indexOf(k);
      if (i < 0 || i > 255) continue;
      if (m.writable) { l.writable.push(i); l.wKeys.push(k); } else { l.readonly.push(i); l.rKeys.push(k); }
      meta.delete(k);
    }
    if (l.writable.length + l.readonly.length) lookups.push(l);
  }
  const entries = [...meta];
  const group = (s: boolean, w: boolean) => entries.filter(([, m]) => m.signer === s && m.writable === w).map(([k]) => k);
  const staticKeys = [...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  if (staticKeys[0] !== payer) bad("the fee payer is not the first key");
  const order = [...staticKeys, ...lookups.flatMap((l) => l.wKeys), ...lookups.flatMap((l) => l.rKeys)];
  if (order.length > 256) throw new SolanaBuildError("too_large", `${order.length} account keys`);
  const index = new Map(order.map((k, i) => [k, i]));
  const at = (k: string): number => index.get(k) as number;
  const bytes: number[] = [0x80, group(true, true).length + group(true, false).length, group(true, false).length, group(false, false).length];
  bytes.push(...compact(staticKeys.length));
  for (const k of staticKeys) bytes.push(...base58.decode(k));
  bytes.push(...base58.decode(blockhash));
  bytes.push(...compact(ixs.length));
  for (const ix of ixs) {
    bytes.push(at(ix.program), ...compact(ix.accounts.length), ...ix.accounts.map((a) => at(a.key)), ...compact(ix.data.length), ...ix.data);
  }
  bytes.push(...compact(lookups.length));
  for (const l of lookups) bytes.push(...base58.decode(l.address), ...compact(l.writable.length), ...l.writable, ...compact(l.readonly.length), ...l.readonly);
  return { message: Uint8Array.from(bytes), tablesUsed: lookups.map((l) => l.address) };
}

const acc = (key: string, signer: boolean, writable: boolean): SolanaApiAccount => ({ key, signer, writable });
const ix = (program: string, accounts: SolanaApiAccount[], data: number[]): SolanaApiInstruction => ({ program, accounts, data: Uint8Array.from(data) });
const randomIndex = (n: number): number => {
  const u = new Uint32Array(1);
  globalThis.crypto.getRandomValues(u);
  return (u[0] as number) % n;
};
const isCreate = (x: SolanaApiInstruction): boolean => x.program === SOLANA_ATA_PROGRAM && x.accounts.length === 6 && (x.data.length === 0 || (x.data.length === 1 && x.data[0] === 1));
const isClose = (x: SolanaApiInstruction): boolean => (x.program === SOLANA_TOKEN_PROGRAM || x.program === SOLANA_TOKEN_2022_PROGRAM) && x.data.length === 1 && x.data[0] === 9 && x.accounts.length === 3;

export type SolanaAssembleChain = {
  /** From readSolanaBlockhash: the device's own finalized read. */
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  /** The lookup tables the device read itself, by address. A table the build names that is missing or deactivated here is not used. */
  readonly tables: Readonly<Record<string, SolanaLookupTable>>;
  /** The token's program, from the device's own mint read. */
  readonly tokenProgram: string;
};
export type SolanaAssembleOptions = {
  /** Token-2022 mints the device read as holding a transfer fee: an account of one gets its withheld fees harvested before its close. */
  readonly transferFeeMints?: readonly string[];
  /** Tip account choice, for tests; random otherwise. */
  readonly pick?: (n: number) => number;
};
export type SolanaAssembled = {
  /** The unsigned wire: compact-u16 1, 64 zero bytes for W_k's signature, then the message. */
  readonly wire: Uint8Array;
  readonly message: Uint8Array;
  readonly size: number;
  readonly lastValidBlockHeight: number;
  readonly cuLimit: number;
  readonly cuPrice: bigint;
  /** The tables the message loads keys from. */
  readonly tablesUsed: readonly string[];
};

/** The v0 transaction for one wallet from a build answer, on the device's own blockhash and tables. Refuses (SolanaBuildError "too_large") over 1,232 bytes. */
export function assembleSolanaSwap(req: SolanaBuildRequest, build: SolanaJupiterBuild, chain: SolanaAssembleChain, opts: SolanaAssembleOptions = {}): SolanaAssembled {
  const w = req.wallet;
  if (!isKey(w) || !isKey(req.token)) throw new Error("the wallet and the token must be addresses");
  if (!isKey(chain.blockhash) || !Number.isSafeInteger(chain.lastValidBlockHeight) || chain.lastValidBlockHeight <= 0) throw new Error("the blockhash must be the device's own read");
  if (chain.tokenProgram !== SOLANA_TOKEN_PROGRAM && chain.tokenProgram !== SOLANA_TOKEN_2022_PROGRAM) throw new Error("the token program must be Token or Token-2022");
  const pick = opts.pick ?? randomIndex;
  const fee = new Set(opts.transferFeeMints ?? []);
  const cuLimit = solanaRouteCuCap(build.swap.data);
  const head = [ix(SOLANA_COMPUTE_BUDGET_PROGRAM, [], [2, ...u32le(cuLimit)]), ix(SOLANA_COMPUTE_BUDGET_PROGRAM, [], [3, ...u64le(build.cuPrice)])];
  // The accounts the setup creates for the wallet, and the buy's output account, which stays open.
  const created = build.setup.filter((x) => isCreate(x) && x.accounts[2]?.key === w).map((x) => ({ acc: (x.accounts[1] as SolanaApiAccount).key, mint: (x.accounts[3] as SolanaApiAccount).key, tp: (x.accounts[5] as SolanaApiAccount).key }));
  const output = req.side === "buy" ? solanaAta(w, req.token, chain.tokenProgram) : null;
  const pre = [...build.setup];
  if (output && !created.some((c) => c.acc === output)) {
    pre.push(ix(SOLANA_ATA_PROGRAM, [acc(w, true, true), acc(output, false, true), acc(w, false, false), acc(req.token, false, false), acc(SOLANA_SYSTEM_PROGRAM, false, false), acc(chain.tokenProgram, false, false)], [1]));
  }
  const closedLater = new Set([build.cleanup, ...build.other].filter((x): x is SolanaApiInstruction => !!x && isClose(x)).map((x) => (x.accounts[0] as SolanaApiAccount).key));
  const closes: SolanaApiInstruction[] = [];
  for (const c of created) {
    if (c.acc === output || closedLater.has(c.acc) || closes.some((x) => x.accounts[0]?.key === c.acc)) continue;
    if (c.tp !== SOLANA_TOKEN_PROGRAM && c.tp !== SOLANA_TOKEN_2022_PROGRAM) continue; // S13 refuses a create under any other program
    if (c.tp === SOLANA_TOKEN_2022_PROGRAM && fee.has(c.mint)) closes.push(ix(SOLANA_TOKEN_2022_PROGRAM, [acc(c.mint, false, true), acc(c.acc, false, true)], [26, 4]));
    closes.push(ix(c.tp, [acc(c.acc, false, true), acc(w, false, true), acc(w, true, false)], [9]));
  }
  const tips = [
    ix(SOLANA_SYSTEM_PROGRAM, [acc(w, true, true), acc(SOLANA_SENDER_TIP_ACCOUNTS[pick(SOLANA_SENDER_TIP_ACCOUNTS.length)] as string, false, true)], [...u32le(2), ...u64le(SOLANA_SENDER_TIP)]),
    ix(SOLANA_SYSTEM_PROGRAM, [acc(w, true, true), acc(SOLANA_JITO_TIP_ACCOUNTS[pick(SOLANA_JITO_TIP_ACCOUNTS.length)] as string, false, true)], [...u32le(2), ...u64le(SOLANA_JITO_TIP)]),
  ];
  const ixs = [...head, ...pre, build.swap, ...closes, ...(build.cleanup ? [build.cleanup] : []), ...build.other, ...tips];
  const tables = build.tables.flatMap((address) => {
    const t = Object.hasOwn(chain.tables, address) ? chain.tables[address] : undefined;
    return t && solanaTableIsActive(t) ? [{ address, table: t }] : [];
  });
  const { message, tablesUsed } = solanaCompileV0(w, ixs, chain.blockhash, tables);
  const wire = new Uint8Array(1 + 64 + message.length);
  wire[0] = 1;
  wire.set(message, 65);
  if (wire.length > SOLANA_MAX_TX_BYTES) throw new SolanaBuildError("too_large", `${wire.length} bytes > ${SOLANA_MAX_TX_BYTES}`);
  return { wire, message, size: wire.length, lastValidBlockHeight: chain.lastValidBlockHeight, cuLimit, cuPrice: build.cuPrice, tablesUsed };
}

/**
 * The same assembled tx on a newer blockhash (card solana-legs-share-wait): the message's 32 blockhash bytes and the
 * height its signer is handed change, and no other byte, so a simulation run with replaceRecentBlockhash holds for it
 * unchanged. Assembling the build again would not do: the tip accounts are picked at random. The result is checked
 * (checkSolanaQuote) before it is signed, like any assembly.
 */
export function solanaWithBlockhash(a: SolanaAssembled, chain: { blockhash: string; lastValidBlockHeight: number }): SolanaAssembled {
  if (!isKey(chain.blockhash) || !Number.isSafeInteger(chain.lastValidBlockHeight) || chain.lastValidBlockHeight <= 0) throw new Error("the blockhash must be the device's own read");
  if (a.wire[0] !== 1 || a.wire.length !== 65 + a.message.length || a.wire.subarray(65).some((b, i) => b !== a.message[i])) throw new Error("the wire is not its own message");
  const keys = solanaDecodeMessage(a.message).staticKeys.length;
  const at = 4 + compact(keys).length + 32 * keys;
  const message = Uint8Array.from(a.message);
  message.set(base58.decode(chain.blockhash), at);
  if (solanaDecodeMessage(message).blockhash !== chain.blockhash) throw new Error("the blockhash is not at its place in the message");
  const wire = new Uint8Array(1 + 64 + message.length);
  wire[0] = 1;
  wire.set(message, 65);
  return { ...a, wire, message, lastValidBlockHeight: chain.lastValidBlockHeight };
}

// ---------------------------------------------------------------------------------------------------------------
// The teardown frames (row M1.4; 06c §3.1 S-4, S-5), built after the full sell has landed, from solanaTeardownPlan
// over the device's own reads; checkSolanaTeardown judges them before they are signed. S-4: per token account the plan
// closes, HarvestWithheldTokensToMint (mint, account) right before it when the account has Token-2022's transfer-fee
// extension, then CloseAccount (account, the wallet, the wallet). S-5: close_user_volume_accumulator under each pump
// program whose volume account the plan closes. S-4 and S-5 are separate frames, so a pump change that breaks S-5 never
// holds back the token closes; S-4 splits into more frames when one would pass 1,232 bytes. No tips: a teardown is
// never raced. Each frame asks only the compute it uses (SOLANA_TEARDOWN_CU), at the caller's price.
// ---------------------------------------------------------------------------------------------------------------

/** The teardown frames for one wallet; empty when the plan closes nothing. */
export function buildSolanaTeardown(wallet: string, plan: SolanaTeardownPlan, chain: { blockhash: string; lastValidBlockHeight: number }, opts: { cuPrice?: bigint } = {}): SolanaAssembled[] {
  if (!isKey(wallet)) throw new Error("the wallet must be an address");
  if (!isKey(chain.blockhash) || !Number.isSafeInteger(chain.lastValidBlockHeight) || chain.lastValidBlockHeight <= 0) throw new Error("the blockhash must be the device's own read");
  const price = opts.cuPrice ?? 0n;
  if (typeof price !== "bigint" || price < 0n) throw new Error("the compute unit price must be a bigint of at least 0");
  const cuPrice = price < SOLANA_CU_PRICE_MAX ? price : SOLANA_CU_PRICE_MAX;
  const frame = (body: SolanaApiInstruction[], cu: number): SolanaAssembled => {
    const cuLimit = 2 * SOLANA_TEARDOWN_CU.budget + cu;
    const head = [ix(SOLANA_COMPUTE_BUDGET_PROGRAM, [], [2, ...u32le(cuLimit)]), ...(cuPrice > 0n ? [ix(SOLANA_COMPUTE_BUDGET_PROGRAM, [], [3, ...u64le(cuPrice)])] : [])];
    const { message, tablesUsed } = solanaCompileV0(wallet, [...head, ...body], chain.blockhash, []);
    const wire = new Uint8Array(1 + 64 + message.length);
    wire[0] = 1;
    wire.set(message, 65);
    if (wire.length > SOLANA_MAX_TX_BYTES) throw new SolanaBuildError("too_large", `${wire.length} bytes > ${SOLANA_MAX_TX_BYTES}`);
    return { wire, message, size: wire.length, lastValidBlockHeight: chain.lastValidBlockHeight, cuLimit, cuPrice, tablesUsed };
  };
  const out: SolanaAssembled[] = [];
  // S-4, packed greedily: an account's harvest and close never split across frames.
  let body: SolanaApiInstruction[] = [];
  let cu = 0;
  for (const h of plan.close) {
    if (h.kind !== "token") continue;
    const group = [
      ...(h.harvest ? [ix(SOLANA_TOKEN_2022_PROGRAM, [acc(h.mint, false, true), acc(h.address, false, true)], [26, 4])] : []),
      ix(h.program, [acc(h.address, false, true), acc(wallet, false, true), acc(wallet, true, false)], [9]),
    ];
    const groupCu = SOLANA_TEARDOWN_CU.close + (h.harvest ? SOLANA_TEARDOWN_CU.harvest : 0);
    if (body.length) {
      try {
        frame([...body, ...group], cu + groupCu);
      } catch (e) {
        if (!(e instanceof SolanaBuildError && e.code === "too_large")) throw e;
        out.push(frame(body, cu));
        body = [];
        cu = 0;
      }
    }
    body.push(...group);
    cu += groupCu;
  }
  if (body.length) out.push(frame(body, cu));
  // S-5.
  const volumes = plan.close.filter((h) => h.kind === "volume");
  if (volumes.length) {
    out.push(frame(volumes.map((h) => ix(h.program, [acc(wallet, true, true), acc(h.address, false, true), acc(solanaEventAuthority(h.program), false, false), acc(h.program, false, false)], [...SOLANA_CLOSE_VOLUME_ACCUMULATOR])), volumes.length * SOLANA_TEARDOWN_CU.volume));
  }
  return out;
}

/** The most accounts api.mainnet-beta.solana.com reads back in one simulation ("Too many accounts provided; max 4", 2026-11-02). */
export const SOLANA_SIMULATE_ACCOUNTS_MAX = 4;

/**
 * One provider's simulation of one teardown frame (sigVerify false, replaceRecentBlockhash true, at `confirmed`),
 * reading back the wallet and every given address: one call per group of three addresses with the wallet. Each answer
 * is hostile: shape-checked, and every call must report the same wallet lamports; the first error is returned as err.
 */
export async function simulateSolanaTeardown(rpc: SolanaRpc, wire: Uint8Array, wallet: string, addresses: readonly string[]): Promise<SolanaTeardownSimulation> {
  const lamports = (a: unknown, what: string): bigint | null => {
    if (a === null) return null;
    const v = obj(a, what).lamports;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return bad(`${what}.lamports is not a safe integer`);
    return BigInt(v);
  };
  const per = SOLANA_SIMULATE_ACCOUNTS_MAX - 1;
  const accounts: Record<string, bigint | null> = {};
  let walletAfter: bigint | null = null;
  for (let i = 0; i === 0 || i < addresses.length; i += per) {
    const group = [wallet, ...addresses.slice(i, i + per)];
    const r = obj(await rpc("simulateTransaction", [base64.encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { addresses: group, encoding: "base64" } }]), "simulateTransaction");
    const v = obj(r.value, "simulateTransaction.value");
    if (v.err !== null && v.err !== undefined) return { err: v.err, wallet: 0n, accounts: {} };
    const list = arr(v.accounts, "simulateTransaction.value.accounts", group.length);
    if (list.length !== group.length) bad(`the simulation read back ${list.length} of ${group.length} accounts`);
    const w = lamports(list[0], "the wallet");
    if (w === null || (walletAfter !== null && w !== walletAfter)) bad("the simulations disagree on the wallet");
    walletAfter = w;
    group.slice(1).forEach((x, j) => {
      accounts[x] = lamports(list[j + 1], x);
    });
  }
  return { err: null, wallet: walletAfter as bigint, accounts };
}
