// The page's binding of the NEAR private buy (card near-private-trading): src/near-trade.ts's flow with the real parts on
// the page's network. pool-kinds.ts sends a checked NEAR buy here (deps.near.buy).
// - The record: the buy's own, in the wallet store's "quotes" (which the APP_HOST frame never opens: it holds W's
//   indexes and the note it is paid from), under NEAR_BUY_KEY + the request's id: the token, the amount, the slippage,
//   W and its (l, j), the note, the fee drawn, and each step's stage, code and cause and every tx. Its public side is the
//   request's op in "ops" ({ kind "buy", chain "near", token, stage, txs, code }), which state.ops shows once it is no
//   longer "pending". Both are written before the payout is asked.
// - W = W_{near,l,j} of the vault note the payout spends: l its label, j = jOf(its ref) (the wallet's queue.ts, as every
//   pool buy names its W), so a restore from the 12 words finds W as it finds every arm wallet: restore/wallets.ts reads
//   W_{near,l,j} for each withdrawal (l, j) the note walk finds. The note is picked here first, by withdrawRequest's own
//   rule (the smallest UNSPENT note of the vault's scope covering the amount and the fee), and the payout is pinned to
//   it (withdrawHandoff's `note`): a note is spent once in the vault, so no record is paid twice. The pick and the new
//   record's write are one step under one Web Lock per network (any token), and a note named by any unended record is
//   never picked, so two buys begun together never share a note or a W.
// - Each buy is a record of its own, run at once: it holds its token's lock shared (a sell of the token takes it whole)
//   and its record's own lock, so it never waits on another record's run. An unfinished record (not filled, not
//   refused, resumed fewer than NEAR_BUY_RESUMES times) is taken up as its own run, with its own amount and op, on each
//   page load and after an ask of its token (resumeNearBuys), never before the ask. A record at the cap that still
//   names a note is decided on a load with no new ask (landed stays; else refused, its note freed).
// - The payout: the record marks it asked before the hand-off (so before the note can go HELD). The note UNSPENT, the
//   hand-off to W with fund_recipient false (to = W, register_deposit the token's minimum: the withdraw relayer refuses
//   fund_recipient true for an absent W; the helper's trade kind creates W); RESERVED by this record's request (it pays
//   W), followed by the settle pass to its end; SPENT, landed only when the record says its own payout landed, or, asked
//   and not known, when the vault's spend row of the note's nullifier pays W. A note never asked, or held, spent or paid
//   to another account, ends the buy "taken" (payout_taken). arrived and landed are W's; expired frees the note and the
//   same note is asked again; anything else ends the buy before any helper call.
// - The helper: POST /v1/bind with the trade body, its answer checked here (a tx hash list, or one of the trade kind's
//   codes at its HTTP status); the device signs only what nearSwapCheck passed, from its own two-provider reads.
// - Every step logs one line on this device's console (public words: the step, its outcome, legCause's shape).
// - The sell (src/near-sell.ts's flow, deps.near.sell): W is a buy record's, never one the request names. A sell of a
//   token takes, under the same token lock, the record whose sell is unfinished, else the oldest record of the token
//   whose payout landed (stage sent or filled, its note SPENT in the store) and whose W was not sold yet. The sell is
//   kept on that record (`sell`: its op id, stage, step, code, cause, txs), its op in "ops" ({ kind "sell", chain
//   "near", ... }), both written before W is read. From then the buy's own run never takes that record again: the sell
//   owns W. W's return note (return/near/l/j) and the move into the vault are the wallet's, the seed opened under its
//   lock. An unfinished sell is taken by the next sell of the token and on each page load, as is any paid W whose money
//   is on its way home (resumeNearSells). A sell once sent is never answered or recorded as nothing sold.
// - The rebuild (card near-holdings-restore, nearHoldingsPass): a store with no record of a W (a sign out, a new device,
//   a restore from the 12 words) gets one back from the chain alone, on every load and after each restore's NEAR walk,
//   so the coin W holds shows as a position and sells, and USDC left on W comes home by resumeNearSells.
//   The pass reads W only on the helper's keyed seat (NEAR_NETWORKS seat, with no keyless spare) and its record route.
//   The way home, the sell run it starts, filledFromRead and confirmOnTwo read W on page.rpcs(): dRPC from the device,
//   and the seat, which falls back to FastNEAR's keyless URL from the device on a 429, a 5xx, a timeout or no answer
//   (wallet/src/pace.ts nearSeatRpc, seatDown); the sell's move into the vault reads and sends on bindRpcs()
//   (FastNEAR's keyless URL and dRPC). Each of those providers can see W's id from this device's address; it is kept
//   at one rebuilt W a page load.
import { HELPER_BIND_RECORD_WALLETS_MAX, HELPER_BIND_TRADE_CODES, HELPER_CODE_STATUS, HELPER_FETCH_INIT, type HelperBindRecord, type HelperBindRecordRequest, type HelperBindRecordState, type HelperBindTradeRequest } from "../../kit/src/helper/v1.ts";
import { NEAR_NETWORKS, type NearNetwork, type NearRpc } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA, rheaQuote } from "../../kit/src/near/rhea.ts";
import { nearFeeBuyerReceives, nearTokenFeeView, type NearTokenFee } from "../../kit/src/near/token-fee.ts";
import { vaultSync, vaultSyncStart, type VaultSpendRow } from "../../kit/src/vault/sync.ts";
import { readNearHeld, readNearSwapPair, readNearSwapWallet, type NearSwapWalletArgs, type NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import type { BuyRoute, TxRef } from "../../kit/src/signpage/messages.ts";
import { VAULT_CONSTANTS } from "../../kit/src/vault/shapes.ts";
import { RELEASE_BIND_URL, SEND_TIMEOUT_MS } from "../../wallet/src/deposit/delegate.ts";
import { readCapped } from "../../wallet/src/deposit/capped.ts";
import { nearSwapWallet, signNearSwapDelegates } from "../../wallet/src/near/swap-delegate.ts";
import type { NoteRecord, NoteStore } from "../../wallet/src/notes/store.ts";
import { noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { withdrawArrival, type ArrivalArgs, type ArrivalOutcome } from "../../wallet/src/withdraw/arrival.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import type { WalletStore } from "../../wallet/src/store/index.ts";
import { bindRpc, type BindRpc } from "../../wallet/src/deposit/bind.ts";
import type { HostRefusal, KindContext, Running } from "./api.ts";
import { nearReturnMove, nearSellFlow, nearSellNote, type NearMoveEnd, type NearSellDeps, type NearSellStep } from "./near-sell.ts";
import type { NearSellAsk } from "./rules/near-trade.ts";
import { nearBuyFlow, runNearBuy, type NearBuyAsk, type NearBuyBegun, type NearBuyDeps, type NearBuyProgress, type NearHeldState, type NearHelperAnswer, type NearPair, type NearPairAsk, type NearPayoutEnd } from "./near-trade.ts";
import { nearView } from "./near-pools.ts";
import { nearWCallOf, nearWCallToken } from "./near-w-calls.ts";
import { pacedNearRpc } from "../../wallet/src/pace.ts";
import { unitsOf } from "./pool-buy.ts";
import { legCause } from "./pool-sell.ts";
import type { Position } from "./positions.ts";
import { vaultScope } from "./withdraw/checks.ts";
import { HANDOFF_WAIT_MAX_MS, type HandoffEnd, type SettlePass } from "./withdraw/handoff.ts";

/** The record's key prefix in its store. */
export const NEAR_BUY_KEY = "near-buy:";
/** The record's store: "quotes", the trade's own records, which the APP_HOST frame's reader never opens (it opens "ops"
 *  and two meta keys only, store/index.ts). Never "wallets": its only writer is arming/records.ts, whose records let a
 *  signer sign (arm-records.test.ts holds that). In a store the database already has, so it stays at version 1. */
const RECORDS = "quotes";
/** The most times one record is taken up again (an ask or a load) after its run stopped. */
export const NEAR_BUY_RESUMES = 3;
/** Times a sell kept open by trade_used with nothing of it sent is taken up again (on load or a tap) before it ends with
 *  its code: the token stays in positions and the next tap starts a fresh sell. */
export const NEAR_SELL_RESUMES = 3;
const LOCK = "ct-near-buy/";
/** The network's one note pick: the records read, the note picked and the new record written under it. */
const PICK_LOCK = "ct-near-buy-pick/";
/** One run of a record at a time (a load in two tabs, a load and the run after an ask). */
const RECORD_LOCK = "ct-near-buy-record/";
const BIND_ANSWER_MAX_BYTES = 2_048;

/** The record as stored. Amounts as decimal strings. */
export type NearBuyRecord = {
  v: 1;
  id: string;
  network: NearNetwork;
  token: string;
  amount: string;
  slippage_bps: number;
  w: string;
  l: string;
  j: number;
  note: string;
  fee: string;
  created_ms: number;
  resumes: number;
  stage: NearBuyProgress["stage"];
  step: NearBuyProgress["step"];
  txs: TxRef[];
  code?: string;
  cause?: string;
  /** The vault's payout to W from the note: "none" until it is asked (written before the hand-off, so before the note
   *  can go HELD), "asked", then "landed" on proof that it paid W. Absent on a record written before it: read as asked. */
  payout?: NearPayoutMark;
  swap?: { floor: string; before: string };
  /** What W received of the token (base units) and its decimals, read at the buy's end. */
  fill?: { out: string; decimals: number };
  /** The sell of W, once one was asked (it owns W from then). */
  sell?: NearSellMark;
};

/** Where the record's payout is: see NearBuyRecord.payout. */
export type NearPayoutMark = "none" | "asked" | "landed";
const PAYOUT_MARKS: readonly unknown[] = ["none", "asked", "landed"];

/** A sell of the record's W, kept on its buy record. */
export type NearSellMark = {
  /** Its op's id in "ops" (the request that started it). */
  id: string;
  slippage_bps: number;
  created_ms: number;
  resumes: number;
  stage: NearBuyProgress["stage"];
  step: NearSellStep;
  txs: TxRef[];
  code?: string;
  cause?: string;
  /** The last trade delegate signed for this W's sell (decimal nonce and max_block_height), kept before it is sent: every
   *  later run waits for W's nonce to reach it or its window to pass before a move is signed (near-sell.ts). */
  trade?: { nonce: string; mbh: string };
  /** The way home (a load's run: W's USDC moved, nothing sold), stored so a run that stops partway is taken up as the
   *  way home again, never as a sale; absent: a sale the user asked. A tap on it makes it a sale. */
  home?: true;
};

/** What the page gives the binding, each opened when a step needs it; the parts that reach a network can be replaced. */
export type NearBuyPage = {
  network: NearNetwork;
  store(): Promise<WalletStore>;
  notes(): Promise<NoteStore>;
  seed64(): Promise<Uint8Array>;
  /** The seed's shared lock (WALLET_SEED_LOCK): a sign out waits for a signature. */
  seedLock<T>(fn: () => Promise<T>): Promise<T>;
  /** The vault payout's fee as the withdraw form draws it (withdrawFormDeps().fee). */
  fee(): Promise<bigint>;
  /** withdrawHandoff(page) on the page's network; null where it names no vault or relayer. */
  handoff: ((w: { recipient: string; amount: bigint }, drawnFee: bigint, note?: string) => Promise<HandoffEnd>) | null;
  /** withdrawSettle(page): the RESERVED notes followed to their end. */
  settle(): Promise<SettlePass>;
  /** The vault's spend row of a nullifier, followed until its payout ran (the wallet's withdrawArrival on rpcs() unless given). */
  arrival?(a: Pick<ArrivalArgs, "nullifierHash" | "recipient" | "signal">): Promise<ArrivalOutcome>;
  /** The network's two providers (the release pair). */
  rpcs(): readonly [NearRpc, NearRpc];
  /** The same pair with the `tx` read, for W's move into the vault (the wallet's bindDeposit); bindRpc's by default. */
  bindRpcs?(): readonly [BindRpc, BindRpc];
  /** W's USDC into the vault on a sale's note (near-sell.ts nearReturnMove on bindRpcs() unless given). */
  move?(w: { id: string; l: bigint; j: number }, noteId: string, amount: bigint): Promise<NearMoveEnd>;
  /** The sign out's signal of the moment (the move's wait ends on it; the money stays on W, its call written). */
  signal?(): AbortSignal;
  /** W read on both providers (the kit's readNearSwapWallet on rpcs() unless given). */
  readWallet?(a: Pick<NearSwapWalletArgs, "wallet" | "side" | "token">): Promise<NearSwapWalletState>;
  /** The token's decimals (readNearDecimals on rpcs() unless given). */
  decimals?(token: string): Promise<number>;
  /** The token's own fee as a buy's quote reads it (a quote's fee read unless given). */
  tokenFee?(token: string): Promise<NearTokenFee>;
  /** The quote's candidate pools (near-pools.ts rheaPoolsKept). */
  pools(token: string): Promise<number[]>;
  locks?: LockManager;
  fetchFn?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

/** What the NEAR reads need of the page. */
type NearReadsPage = Pick<NearBuyPage, "network" | "rpcs" | "pools" | "readWallet">;
/** The NEAR buy's and sell's reads of W and the quote on the page's pair, bound once for both flows (card
 *  near-quote-under-the-pace; test/near-reads-count.test.ts counts each step's reads on them). */
export function nearReads(page: NearReadsPage): Pick<NearBuyDeps, "readWallet" | "quote" | "pair" | "held"> {
  return {
    readWallet: (a) => readW(page, a),
    quote: async (a) => rheaQuote({ network: page.network, rpcs: page.rpcs(), ...a, pools: await page.pools(a.token) }),
    pair: (a) => pairOf(page, a),
    held: (a) => heldOf(page, a),
  };
}
const readW = (page: NearReadsPage, a: Pick<NearSwapWalletArgs, "wallet" | "side" | "token">): Promise<NearSwapWalletState> =>
  page.readWallet ? page.readWallet(a) : readNearSwapWallet({ network: page.network, rpcs: page.rpcs(), ...a });
/** W and the quote at one block: the kit's readNearSwapPair on rpcs(). A page given its own W read (page.readWallet)
 *  has that read, then the quote, and its baseline from W's read of the other side. */
const pairOf = async (page: NearReadsPage, a: NearPairAsk): Promise<NearPair> => {
  const pools = await page.pools(a.token);
  if (!page.readWallet) return readNearSwapPair({ network: page.network, rpcs: page.rpcs(), wallet: a.wallet, side: a.side, token: a.token, amountIn: a.amountIn, pools, ...(a.baseline === undefined ? {} : { baseline: a.baseline }) });
  const state = await page.readWallet({ wallet: a.wallet, side: a.side, token: a.token });
  const quote = await rheaQuote({ network: page.network, rpcs: page.rpcs(), side: a.side, token: a.token, amountIn: a.amountIn, pools });
  const other = a.side === "buy" ? "sell" : "buy";
  if (a.baseline === undefined) return { state, quote };
  if (a.baseline !== (a.side === "buy" ? a.token : NEAR_NETWORKS[page.network].usdc)) throw new Error("a baseline of the token W receives only");
  return { state, quote, baseline: (await page.readWallet({ wallet: a.wallet, side: other, token: a.token })).held };
};
/** W's light read: what it holds of the token it sends and its registration on the one it receives (the kit's
 *  readNearHeld on rpcs()), or page.readWallet when the page is given its own. */
const heldOf = async (page: NearReadsPage, a: Pick<NearSwapWalletArgs, "wallet" | "side" | "token">): Promise<NearHeldState> => {
  if (page.readWallet) return page.readWallet(a);
  const usdc = NEAR_NETWORKS[page.network].usdc;
  const [sent, received] = a.side === "buy" ? [usdc, a.token] : [a.token, usdc];
  const h = await readNearHeld({ network: page.network, rpcs: page.rpcs(), wallet: a.wallet, token: sent, on: received });
  return { account: h.account, height: h.height, held: h.held, registered: h.registered === true };
};
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const ended = (r: NearBuyRecord) => r.stage === "filled" || r.stage === "refused";
/** A buy the buy's own run may take up again: not ended, not resumed too often, its W not taken by a sell, and not
 *  ended carry_failed at its swap (the swap rounds the relayer allows W used, the USDC back on W: the sell's load pass
 *  sends it home, never another buy round). */
const buyOpen = (r: NearBuyRecord) => !ended(r) && r.resumes < NEAR_BUY_RESUMES && r.sell === undefined && !(r.step === "swap" && r.code === "carry_failed");
/** A record that will never run again as a buy (its resumes used up) whose payout is not known to have landed: it is
 *  decided on a load (depsOf's close) so that it names no note for good. */
const capped = (r: NearBuyRecord) => !ended(r) && r.resumes >= NEAR_BUY_RESUMES && r.sell === undefined && r.payout !== "landed";
/** W paid: its record's payout landed by its own proof (its hand-off, a RESERVED request naming W, the vault's spend row
 *  naming W), or, on a record from before the payout mark, its note SPENT. A payout only asked is never paid, whatever
 *  became of its note (another withdrawal may have spent it). */
const paidW = async (r: NearBuyRecord, notes: NoteStore): Promise<boolean> =>
  r.payout === "landed" || (r.payout === undefined && (await notes.get(r.note))?.state === "SPENT");
/** A sell that ended refused with nothing of it sent: W's money as it was before it. */
const unsentRefused = (m: NearSellMark | undefined): boolean => m !== undefined && m.stage === "refused" && m.txs.length === 0;
/** The sale done: W's token sold and its USDC in the vault (filled), or left in W under the least deposit (part_filled). */
const sold = (m: NearSellMark | undefined) => m !== undefined && (m.stage === "filled" || m.stage === "part_filled");
/** A sell kept open after trade_used with nothing of it sent: W still holds the token (shown in positions). */
const unsent = (m: NearSellMark): boolean => m.stage === "pending" && m.code === "trade_used" && m.txs.length === 0;
const sellOpen = (m: NearSellMark | undefined): m is NearSellMark => m !== undefined && !sold(m) && m.stage !== "refused";

/** The record under `key`, or undefined when it is not one. */
export function nearBuyRecordOf(v: unknown): NearBuyRecord | undefined {
  if (!isObj(v) || v.v !== 1 || typeof v.id !== "string" || typeof v.token !== "string" || typeof v.w !== "string" || typeof v.note !== "string") return undefined;
  if (typeof v.amount !== "string" || !/^[1-9]\d{0,38}$/.test(v.amount) || typeof v.l !== "string" || !/^\d{1,78}$/.test(v.l) || !Number.isSafeInteger(v.j)) return undefined;
  if (typeof v.fee !== "string" || !/^\d{1,39}$/.test(v.fee) || !Array.isArray(v.txs)) return undefined;
  if (v.payout !== undefined && !PAYOUT_MARKS.includes(v.payout)) return undefined;
  return v as NearBuyRecord;
}

/** The trade kind's answer from POST /v1/bind, checked: 200 { tx_hashes }, or { error: { code } } (with the txs it
 *  carried) at the code's own status. Anything else throws, and the flow sends the same body again (bounded). */
export async function sendNearTrade(body: HelperBindTradeRequest, fetchFn: typeof fetch = fetch): Promise<NearHelperAnswer> {
  const res = await fetchFn(RELEASE_BIND_URL, {
    ...HELPER_FETCH_INIT,
    redirect: "error",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  let a: unknown;
  try {
    a = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readCapped(res, BIND_ANSWER_MAX_BYTES)));
  } catch {
    throw new Error(`helper: HTTP ${res.status}, not JSON`);
  }
  const hashes = (x: unknown): string[] | null => (Array.isArray(x) && x.length <= 8 && x.every((h) => typeof h === "string") ? (x as string[]) : null);
  if (res.status === 200 && isObj(a) && Object.keys(a).length === 1) {
    const h = hashes(a.tx_hashes);
    if (h !== null) return { ok: true, tx_hashes: h };
  }
  if (isObj(a) && isObj(a.error) && Object.keys(a.error).length === 1 && typeof a.error.code === "string") {
    const code = a.error.code;
    const known = (HELPER_BIND_TRADE_CODES as readonly string[]).includes(code) || code === "upstream" || code === "rate_limited";
    const want = Object.hasOwn(HELPER_CODE_STATUS, code) ? HELPER_CODE_STATUS[code as keyof typeof HELPER_CODE_STATUS] : 400;
    const extra = Object.keys(a).filter((k) => k !== "error");
    const h = a.tx_hashes === undefined ? [] : hashes(a.tx_hashes);
    if (known && res.status === want && h !== null && extra.every((k) => k === "tx_hashes")) return { ok: false, code: code === "rate_limited" ? "upstream" : code, ...(h.length > 0 ? { tx_hashes: h } : {}) };
  }
  throw new Error(`helper: HTTP ${res.status}, not an answer of the trade kind`);
}

/** The NEAR buy's kind for pool-kinds.ts (deps.near.buy): one buy of a token at a time, each from its record. */
export function nearBuyKind(page: NearBuyPage): (ask: NearBuyAsk, ctx: KindContext) => Running<"pool.buy"> | HostRefusal {
  return (ask, ctx) => {
    const deps = depsOf(page, null, ctx.id, ctx.route);
    // the ask runs at once as a record of its own: it never waits on another record's run
    const r = nearBuyFlow(deps)(ask, ctx);
    if (!("running" in r)) return r;
    // its locks go once the run has ended, however it ended; then the token's unfinished records are taken up, never
    // awaited by this ask's answer
    const later = () => void resumeNearBuys(page, ask.token, ctx.id).catch((e: unknown) => page.log?.(`near buy resume: ${legCause(e)}`));
    return { ...r, after: r.after.finally(() => (deps.release(), later())) };
  };
}

/** Every unfinished record of the page's network (of `token` only when named, never `except`) taken up again, oldest
 *  first, each as its own run under its own lock (one a run already holds is left to it): a page load, and after an ask
 *  of the token. A record at the resume cap that still names a note is decided without a new ask (capped). */
export async function resumeNearBuys(page: NearBuyPage, token?: string, except?: string): Promise<void> {
  const store = await page.store();
  const keys = (await store.keys(RECORDS)).filter((k) => k.startsWith(NEAR_BUY_KEY));
  const open: NearBuyRecord[] = [];
  const shut: NearBuyRecord[] = [];
  for (const k of keys) {
    const r = nearBuyRecordOf(await store.get(RECORDS, k).catch(() => undefined));
    if (!r || r.network !== page.network || (token !== undefined && r.token !== token) || r.id === except) continue;
    if (buyOpen(r)) open.push(r);
    else if (capped(r)) shut.push(r);
  }
  for (const r of open.sort((x, y) => x.created_ms - y.created_ms)) {
    const deps = depsOf(page, r.id, r.id);
    await runNearBuy(deps, { token: r.token, amount: BigInt(r.amount), slippageBps: r.slippage_bps })
      .catch((e: unknown) => page.log?.(`near buy resume: ${legCause(e)}`))
      .finally(deps.release);
  }
  for (const r of shut) {
    const deps = depsOf(page, r.id, r.id);
    await deps
      .close()
      .catch((e: unknown) => page.log?.(`near buy close: ${legCause(e)}`))
      .finally(deps.release);
  }
}

/** The account a RESERVED note's stored withdrawal request pays (withdrawRequest's body), or undefined. */
const reservedRecipient = (n: NoteRecord): string | undefined => {
  try {
    const b: unknown = JSON.parse(n.request ?? "null");
    return isObj(b) && isObj(b.withdrawal) && typeof b.withdrawal.recipient === "string" ? b.withdrawal.recipient : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The flow's deps over one record. `only`: the record a resume takes (none: the ask's token decides, a new record under
 * `id` when no unfinished one is there).
 */
export function depsOf(page: NearBuyPage, only: string | null, id: string, route?: (r: BuyRoute) => void): NearBuyDeps & { release(): void; close(): Promise<void> } {
  const log = page.log ?? ((line: string) => console.info(line));
  const now = page.now ?? (() => Date.now());
  const locks = page.locks ?? (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  let rec: NearBuyRecord | null = null;
  let release: (() => void) | null = null;

  const write = async (r: NearBuyRecord): Promise<void> => {
    const store = await page.store();
    await store.put(RECORDS, `${NEAR_BUY_KEY}${r.id}`, r);
    // its public side: what state.ops shows
    await store.put("ops", r.id, { kind: "buy", chain: "near", token: r.token, stage: r.stage, txs: r.txs, created_ms: r.created_ms, ...(r.code === undefined ? {} : { code: r.code }) });
  };
  // held from begin to the run's end (release, called by the kind and the resume): the token's lock shared (buys of a
  // token run side by side, each on its own note and W; a sell of the token takes it whole) and the record's own,
  // exclusive. `free`: the record's only if no run holds it (false: nothing held)
  const lock = async (token: string, record: string, free: boolean): Promise<boolean> => {
    if (!locks) return true;
    const take = (name: string, mode: LockMode, ifAvailable: boolean) =>
      new Promise<(() => void) | null>((held) => {
        void locks.request(name, { mode, ifAvailable }, (l) => (l === null ? held(null) : new Promise<void>((done) => held(done))));
      });
    const t = (await take(`${LOCK}${page.network}/${token}`, "shared", false))!;
    const k = await take(`${RECORD_LOCK}${page.network}/${record}`, "exclusive", free);
    if (k === null) return (t(), false);
    release = () => (k(), t());
    return true;
  };
  const records = async (): Promise<NearBuyRecord[]> => {
    const store = await page.store();
    const out: NearBuyRecord[] = [];
    for (const k of (await store.keys(RECORDS)).filter((x) => x.startsWith(NEAR_BUY_KEY))) {
      const r = nearBuyRecordOf(await store.get(RECORDS, k).catch(() => undefined));
      if (r && r.network === page.network) out.push(r);
    }
    return out;
  };
  const unlock = () => {
    release?.();
    release = null;
  };
  // the network's note pick, held only while `fn` runs
  const picking = <T>(fn: () => Promise<T>): Promise<T> => (locks ? (locks.request(`${PICK_LOCK}${page.network}`, { mode: "exclusive" }, fn) as Promise<T>) : fn());

  // Landed only on proof that the record's own payout went to its W: its own hand-off's answer, the note's stored
  // request naming W, or the vault's spend row of the note's nullifier naming W. A note spent or held by anything
  // else ends the record "taken" (payout_taken), nothing signed for W. `askable` false (a record at the resume cap):
  // never a new ask, "none" where one would be made.
  const decide = async (askable: boolean): Promise<NearPayoutEnd> => {
    const r = rec!;
    const notes = await page.notes();
    const mark = async (m: NearPayoutMark): Promise<void> => {
      rec = { ...rec!, payout: m };
      await write(rec);
    };
    const landed = async (tx: string | null): Promise<NearPayoutEnd> => (await mark("landed"), { kind: "landed", tx });
    const before = r.txs[0]?.hash ?? null;
    const ask = async (): Promise<NearPayoutEnd> => {
      if (page.handoff === null) throw new Error("no vault on this network");
      // asked, on the record before the hand-off can hold the note
      await mark("asked");
      const end = await page.handoff({ recipient: r.w, amount: BigInt(r.amount) }, BigInt(r.fee), r.note);
      if (end.kind === "arrived" || end.kind === "landed") return landed("tx" in end && typeof end.tx === "string" ? end.tx : null);
      if (end.kind === "unmatched") throw new Error("the payout's spend is not this device's");
      return { kind: end.kind };
    };
    const n = await notes.get(r.note);
    if (n === undefined) throw new Error("the record's note is not in the store");
    if (n.state === "UNSPENT") return askable ? ask() : { kind: "none" };
    if (n.state === "SPENT") {
      if (r.payout === "landed") return { kind: "landed", tx: before };
      if (r.payout === "none") return { kind: "taken" };
      // asked (or a record from before the mark): the vault's spend row of the note says where it paid
      const seed = await page.seed64();
      let nullifierHash: bigint;
      try {
        nullifierHash = noteSecrets(seed, n.ref).nullifierHash;
      } finally {
        seed.fill(0);
      }
      const out = page.signal?.();
      const signal = AbortSignal.any([AbortSignal.timeout(HANDOFF_WAIT_MAX_MS), ...(out ? [out] : [])]);
      const a = await (page.arrival ? page.arrival({ nullifierHash, recipient: r.w, signal }) : withdrawArrival({ network: page.network, rpcs: page.rpcs(), nullifierHash, recipient: r.w, signal }));
      if (a.kind === "arrived" && a.spend.recipient === r.w) return landed(before);
      return { kind: a.kind === "refunded" ? "refunded" : "taken" };
    }
    if (n.state === "RESERVED") {
      // a withdrawal in flight that is not this record's (never asked, or its stored request pays another account)
      if (r.payout === "none" || reservedRecipient(n) !== r.w) return { kind: "taken" };
      const out = (await page.settle()).outcomes[r.note];
      if (out === "arrived" || out === "landed") return landed(before);
      if (out === "refunded") return { kind: "refunded" };
      if (out === "elsewhere") return { kind: "taken" };
      if (out === "expired" && (await notes.get(r.note))?.state === "UNSPENT") return askable ? ask() : { kind: "none" };
      throw new Error(`the payout is ${String(out)}`);
    }
    throw new Error(`the note is ${n.state}`);
  };

  return {
    release: unlock,
    network: page.network,
    async begin(ask): Promise<NearBuyBegun | null> {
      if (!(await lock(ask.token, only ?? id, only !== null))) return null;
      try {
        // a resume: the record it names, if its buy is still open. An ask never takes another ask's record: it is a
        // record of its own
        if (only !== null) {
          const r = (await records()).find((x) => x.id === only && buyOpen(x));
          if (r === undefined) return (unlock(), null);
          rec = { ...r, resumes: r.resumes + 1 };
          await write(rec);
          log(`near buy resumed at ${r.step}`);
          return { ask: { token: r.token, amount: BigInt(r.amount), slippageBps: r.slippage_bps }, w: { id: r.w, l: BigInt(r.l), j: r.j }, txs: r.txs, ...(r.swap ? { swap: { floor: BigInt(r.swap.floor), before: BigInt(r.swap.before) } } : {}) };
        }
        // a new buy: the note first (withdrawRequest's rule), W from it, the record before anything is asked
        const scope = vaultScope(page.network);
        if (scope === null || page.handoff === null) return (unlock(), null);
        const fee = await page.fee();
        const notes = await page.notes();
        const need = ask.amount + fee;
        // the pick and the record's write are one step for the whole network (any token): two buys begun together never
        // take one note, and a note named by any unended record is never picked again
        const begun = await picking(async (): Promise<NearBuyBegun | null> => {
          const named = new Set((await records()).filter((r) => !ended(r)).map((r) => r.note));
          const fits = (await notes.list())
            .filter((n): n is NoteRecord & { leaf: NonNullable<NoteRecord["leaf"]> } => n.scope === scope && n.state === "UNSPENT" && n.leaf !== undefined && n.leaf.value >= need && !named.has(n.id))
            .sort((x, y) => (x.leaf.value < y.leaf.value ? -1 : x.leaf.value > y.leaf.value ? 1 : Number(x.leaf.leafIndex - y.leaf.leafIndex)));
          const note = fits[0];
          if (note === undefined) return null;
          const l = note.leaf.label;
          const j = jOf(note.ref);
          const seed = await page.seed64();
          let w: string;
          try {
            w = nearSwapWallet(seed, l, j).id;
          } finally {
            seed.fill(0);
          }
          rec = { v: 1, id, network: page.network, token: ask.token, amount: ask.amount.toString(), slippage_bps: ask.slippageBps, w, l: l.toString(), j, note: note.id, fee: fee.toString(), created_ms: now(), resumes: 0, stage: "pending", step: "payout", payout: "none", txs: [] };
          await write(rec);
          return { ask, w: { id: w, l, j }, txs: [] };
        });
        if (begun === null) return (unlock(), null);
        log("near buy recorded");
        return begun;
      } catch (e) {
        unlock();
        throw e;
      }
    },
    async progress(p) {
      if (rec === null) return;
      const { swap, ...rest } = p;
      rec = { ...rec, ...rest, ...(swap ? { swap } : {}) };
      if (p.code === undefined) delete rec.code;
      if (p.cause === undefined) delete rec.cause;
      await write(rec);
    },
    payout: () => decide(true),
    // a record at the resume cap: its payout decided with no new ask and no resume counted; landed stays as it is (its
    // USDC goes home by the sell's load pass), anything else ends it refused and frees its note
    async close(): Promise<void> {
      const r = (await records()).find((x) => x.id === only);
      if (r === undefined || !capped(r) || !(await lock(r.token, r.id, true))) return;
      try {
        const again = (await records()).find((x) => x.id === only);
        if (again === undefined || !capped(again)) return;
        rec = again;
        const end = await decide(false);
        if (end.kind !== "landed") {
          rec = { ...rec, stage: "refused", code: `payout_${end.kind}` };
          delete rec.cause;
          await write(rec);
        }
        log(`near buy closed: ${end.kind}`);
      } finally {
        unlock();
      }
    },
    helper: (body) => sendNearTrade(body, page.fetchFn),
    ...nearReads(page),
    sign: (given, request, q, s, bound) =>
      page.seedLock(async () => {
        const r = rec!;
        const seed = await page.seed64();
        try {
          // W derived again here, from the record's indexes, and held to the record's W
          if (nearSwapWallet(seed, BigInt(r.l), r.j).id !== r.w || request.wallet !== r.w) throw new Error("W is not the record's");
          return signNearSwapDelegates(seed, BigInt(r.l), r.j, given, request, q, s, bound);
        } finally {
          seed.fill(0);
        }
      }),
    wait: page.wait ?? ((ms) => new Promise((ok) => setTimeout(ok, ms))),
    log: (step, outcome) => log(`near buy ${step}: ${outcome}`),
    ...(route ? { route } : {}),
    decimals: (token) => (page.decimals ? page.decimals(token) : readNearDecimals(page.network, page.rpcs(), token)),
  };
}

// ---- What the page tells of NEAR trades: the token's decimals, the positions ----

const decimalsKept = new Map<string, number>();
/** A NEP-141 token's decimals (ft_metadata) read at final on both providers, which must agree; kept for the session. */
export async function readNearDecimals(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], token: string): Promise<number> {
  const key = `${network}/${token}`;
  const kept = decimalsKept.get(key);
  if (kept !== undefined) return kept;
  const one = async (rpc: NearRpc): Promise<number> => {
    const m = await nearView(rpc, token, "ft_metadata", {});
    const d = isObj(m) ? m.decimals : undefined;
    if (!Number.isInteger(d) || (d as number) < 0 || (d as number) > 255) throw new Error(`${rpc.name}: ft_metadata: no decimals`);
    return d as number;
  };
  const [a, b] = await Promise.all([one(rpcs[0]), one(rpcs[1])]);
  if (a !== b) throw new Error("ft_metadata: the providers disagree");
  decimalsKept.set(key, a);
  return a;
}

/**
 * state.positions on NEAR: each token the page's buys hold, from their records (no chain read inside a state read):
 * every paid buy (filled, or sent whatever code it ended with) whose record holds W's last two-provider read with some
 * of the token (fill) and no sell asked of its W (or one refused), by token: what W holds in all (the baseline before
 * the swap and what it received), the USDC paid for it as its cost, its Ws and the token's decimals.
 */
export async function nearPositions(page: Pick<NearBuyPage, "network" | "store">): Promise<Position[]> {
  const store = await page.store();
  const by = new Map<string, { out: bigint; cost: bigint; decimals: number; wallets: string[] }>();
  for (const k of (await store.keys(RECORDS)).filter((x) => x.startsWith(NEAR_BUY_KEY))) {
    const r = nearBuyRecordOf(await store.get(RECORDS, k).catch(() => undefined));
    if (!r || r.network !== page.network || (r.stage !== "filled" && r.stage !== "sent") || !r.fill || !(r.sell === undefined || r.sell.stage === "refused" || unsent(r.sell))) continue;
    const { out, decimals } = r.fill;
    if (typeof out !== "string" || !/^[1-9]\d{0,77}$/.test(out) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) continue;
    const before = r.swap?.before ?? "0";
    if (typeof before !== "string" || !/^\d{1,78}$/.test(before)) continue;
    const p = by.get(r.token) ?? { out: 0n, cost: 0n, decimals, wallets: [] };
    if (p.decimals !== decimals) continue;
    p.out += BigInt(before) + BigInt(out);
    p.cost += BigInt(r.amount);
    p.wallets.push(r.w);
    by.set(r.token, p);
  }
  return [...by].map(([token, p]) => ({ chain: "near", token, amount: unitsOf(p.out, p.decimals), cost: unitsOf(p.cost, NEAR_USDC_DECIMALS), wallets: p.wallets, decimals: p.decimals }));
}
/** USDC's decimals on NEAR (the vault's asset). */
const NEAR_USDC_DECIMALS = 6;

// ---- The sell (deps.near.sell): W from its buy record ----

/** The NEAR sell's kind for pool-kinds.ts (deps.near.sell): one trade of a token at a time, W from its buy record. */
export function nearSellKind(page: NearBuyPage): (ask: NearSellAsk, ctx: KindContext) => Running<"pool.sell"> | HostRefusal {
  return (ask, ctx) => {
    const deps = sellDepsOf(page, null, ctx.id, ask.slippageBps);
    const r = nearSellFlow(deps)(ask, ctx);
    if (!("running" in r)) return (deps.release(), r);
    // the answer as end gives it: a sell that was sent before is never answered as nothing sold
    let final: ReturnType<typeof r.answer> | null = null;
    const after = r.after.then(async () => void (final = (await deps.end(r.answer())) as ReturnType<typeof r.answer>)).finally(deps.release);
    return { ...r, after, answer: () => final ?? r.answer() };
  };
}

/**
 * A page load: a sell taken up for every paid W of the page's network (its buy's note SPENT) not sold yet whose money is
 * on its way home: a sell unfinished, W's return note PLANNED or INCOMING, or W holding none of the token and 1 USDC or
 * more (a buy whose swap did not run: its USDC goes back to the vault). A W holding the token with no sell asked is a
 * position, never sold unasked. Each under its token's lock, on every load (the flow moves nothing twice).
 */
/**
 * W's creation asked of the helper for a paid record whose buy never created it: the buy's creation body, from the
 * record alone (the helper's creation reads no quote, hop or pool: W's payout landed and W absent are its own reads). True
 * when the helper made W, found it made, or takes it as it is.
 */
async function createNearW(page: NearBuyPage, r: NearBuyRecord): Promise<boolean> {
  const usdc = NEAR_NETWORKS[page.network].usdc;
  const body: HelperBindTradeRequest = {
    trade: { network: page.network, side: "buy", token: r.token, wallet: r.w, amount_in: r.amount, slippage_bps: r.slippage_bps, venue_out: "1", hops: [{ pool: 0, token_in: usdc, token_out: r.token }] },
    signed_delegates: [],
  };
  try {
    const a = await sendNearTrade(body, page.fetchFn);
    page.log?.(`near sell resume: W's creation ${a.ok === true ? "asked" : a.code}`);
    return a.ok === true || a.code === "wallet_created" || a.code === "wallet_exists";
  } catch (e) {
    page.log?.(`near sell resume: W's creation not answered (${legCause(e)})`);
    return false;
  }
}

/** The page loads that read a rebuilt record's W on the two providers already: one W per load (see resumeNearSells). */
const restoredReadThisLoad = new WeakSet<NearBuyPage>();
/** The key prefix of a record nearHoldingsPass rebuilt. */
const RESTORED_ID = "restored:";
/** The key (network after it) of when each rebuilt W was last read on the way home: the least recent goes next. */
export const NEAR_HOLDINGS_HOME_KEY = "near-holdings-home:";

export async function resumeNearSells(page: NearBuyPage): Promise<void> {
  const store = await page.store();
  const notes = await page.notes();
  const now = page.now ?? (() => Date.now());
  // W's sale notes on their way: its return note, or an R second arrival on NEAR, PLANNED or INCOMING
  const homing = new Set(
    (await notes.list()).flatMap((n) => {
      if (n.state !== "PLANNED" && n.state !== "INCOMING") return [];
      const r = n.ref;
      if (r.kind === "return" && r.c === "near") return [`${r.l}:${r.j}`];
      if (r.kind === "second" && r.id.id === "R" && r.id.c === "near") return [`${r.id.l}:${r.id.j}`];
      return [];
    }),
  );
  const keys = (await store.keys(RECORDS)).filter((k) => k.startsWith(NEAR_BUY_KEY));
  // the one rebuilt W this load reads (see below): of those the way home would read, the one read least recently
  const homeKey = `${NEAR_HOLDINGS_HOME_KEY}${page.network}`;
  const lastRead = await store.get(RECORDS, homeKey).catch(() => undefined);
  const readAt = (w: string): number => (isObj(lastRead) && Number.isSafeInteger(lastRead[w]) ? (lastRead[w] as number) : -1);
  // every rebuilt W this load would name to the two providers (its home check, its sell taken up, its way home), and
  // every W one seat answer closed (nearHoldingsPass's confirm list): one of them a load, the least recently read
  const emptyKey = `${NEAR_HOLDINGS_EMPTY_KEY}${page.network}`;
  const confirms = confirmsOf(await store.get(RECORDS, emptyKey).catch(() => undefined));
  const named = new Set<string>();
  let turn: string | null = null;
  const pick = (w: string) => void (turn === null || readAt(w) < readAt(turn) ? (turn = w) : undefined);
  for (const k of keys) {
    const r = nearBuyRecordOf(await store.get(RECORDS, k).catch(() => undefined));
    if (!r || r.network !== page.network) continue;
    named.add(r.w);
    if (!r.id.startsWith(RESTORED_ID) || sold(r.sell) || (r.stage !== "sent" && r.stage !== "filled") || !(await paidW(r, notes))) continue;
    if (sellOpen(r.sell) || homing.has(`${r.l}:${r.j}`) || r.fill === undefined) pick(r.w);
  }
  for (const w of confirms.keys()) if (!named.has(w)) pick(w);
  if (restoredReadThisLoad.has(page)) turn = null;
  const take = async (w: string): Promise<boolean> => {
    if (w !== turn || restoredReadThisLoad.has(page)) return false;
    restoredReadThisLoad.add(page);
    await store.put(RECORDS, homeKey, { ...(isObj(lastRead) ? lastRead : {}), [w]: now() });
    return true;
  };
  for (const k of keys) {
    const r = nearBuyRecordOf(await store.get(RECORDS, k).catch(() => undefined));
    if (!r || r.network !== page.network || sold(r.sell) || (r.stage !== "sent" && r.stage !== "filled")) continue;
    if (!(await paidW(r, notes))) continue;
    let go = sellOpen(r.sell) || homing.has(`${r.l}:${r.j}`);
    // a buy with a fill holds the token: a position, sold only on a tap, never sent home on a load
    if (!go && r.fill !== undefined) continue;
    // a W rebuilt from the chain (nearHoldingsPass) is read on the two providers by anything below, which see W's id
    // from this device: one such W a page load, so no provider sees several of one user's Ws from one address in one
    // load; the rest wait for the next load
    const restored = r.id.startsWith(RESTORED_ID);
    if (restored && !(await take(r.w))) continue;
    if (!go) {
      const holds = async () => {
        const [t, u] = await Promise.all([readW(page, { wallet: r.w, side: "sell", token: r.token }), readW(page, { wallet: r.w, side: "buy", token: r.token })]);
        // a coin under the record's floor is no coin (a stranger's dust): never shown, never holding the USDC back
        // two questions, apart: W's USDC of the least deposit goes home whatever W holds of the token (the way home moves
        // it and sells nothing); W's token at its coinMin is its coin, a position, never sold unasked
        if (u.held >= VAULT_CONSTANTS.MIN_DEPOSIT) return true;
        // a buy that ended below its floor with no fill written (its USDC read failed then): what W holds over its baseline
        // is what it received, now that W's USDC is under the least deposit
        const below = r.code === "received_below_floor" && t.held > baselineOf(r);
        if ((coinCounts(r, t.held) || below) && (r.sell === undefined || r.sell.stage === "refused")) await filledFromRead(page, k, r, t.held);
        return false;
      };
      try {
        go = await holds();
      } catch (e) {
        page.log?.(`near sell resume: W not read (${legCause(e)})`);
        // W paid and never created, its buy past its resumes (the helper down or low, the token's quote never read):
        // the creation is asked on its own (the helper reads W absent on its two providers before it sends anything;
        // one it finds there it takes as it is), then W's USDC comes home as any other's
        // (a tap that reached it first and was refused with nothing sent leaves it to this load as well)
        if (buyOpen(r) || !(r.sell === undefined || unsentRefused(r.sell)) || r.payout !== "landed" || !(await createNearW(page, r))) continue;
        try {
          go = await holds();
        } catch (e2) {
          page.log?.(`near sell resume: W not read after its creation (${legCause(e2)})`);
          continue;
        }
      }
    }
    if (!go) continue;
    const id = sellOpen(r.sell) ? r.sell.id : `${r.id}:sell:${now()}`;
    const slippage = r.sell?.slippage_bps ?? r.slippage_bps;
    // a sale the user asked (its sell open) goes on as one; anything else a load takes up is the way home: W's USDC moved,
    // nothing sold, a coin still on W after it a position
    // which it is, read from the mark the run stored (never inferred from its stage): a run that stopped partway goes on
    // as what it was
    const deps = sellDepsOf(page, r.id, id, slippage, !sellOpen(r.sell) || r.sell.home === true);
    const run = nearSellFlow(deps)({ token: r.token, slippageBps: slippage }, { id } as KindContext);
    if (!("running" in run)) {
      deps.release();
      continue;
    }
    await run.after
      .then(() => deps.end(run.answer()))
      .catch((e: unknown) => page.log?.(`near sell resume: ${legCause(e)}`))
      .finally(deps.release);
  }
  // this load's turn on a W one seat answer closed: read once on the two providers; its coin over the floor makes it a
  // position, its USDC of the least deposit a record on its way home, else it stays closed
  const c = turn === null ? undefined : confirms.get(turn);
  if (c !== undefined && (await take(c.w))) await confirmOnTwo(page, c);
}

/** One W a seat answer closed, read on the two providers: a record written ("filled" from the coin over its floor, or
 *  "sent" for USDC of the least deposit) when the store has none of W, under the pick lock; its confirm entry dropped
 *  once read. A read or decimals read that fails leaves the entry for a later load. */
async function confirmOnTwo(page: NearBuyPage, c: NearBuyRecord): Promise<void> {
  let t: NearHeldState, u: NearHeldState;
  let decimals: number | null = null;
  try {
    [t, u] = await Promise.all([readW(page, { wallet: c.w, side: "sell", token: c.token }), readW(page, { wallet: c.w, side: "buy", token: c.token })]);
    if (u.held < VAULT_CONSTANTS.MIN_DEPOSIT && coinCounts(c, t.held)) decimals = page.decimals ? await page.decimals(c.token) : await readNearDecimals(page.network, page.rpcs(), c.token);
  } catch (e) {
    page.log?.(`near sell resume: a closed W not read (${legCause(e)})`);
    return;
  }
  const store = await page.store();
  const emptyKey = `${NEAR_HOLDINGS_EMPTY_KEY}${page.network}`;
  const write = async () => {
    const all = await store.keys(RECORDS);
    let mine = false;
    for (const k of all.filter((x) => x.startsWith(NEAR_BUY_KEY))) if (nearBuyRecordOf(await store.get(RECORDS, k).catch(() => undefined))?.w === c.w) mine = true;
    const key = `${NEAR_BUY_KEY}${c.id}`;
    if (!mine && (await store.get(RECORDS, key).catch(() => undefined)) === undefined) {
      if (decimals !== null) await store.put(RECORDS, key, { ...c, stage: "filled", fill: { out: t.held.toString(), decimals } } satisfies NearBuyRecord);
      else if (u.held >= VAULT_CONSTANTS.MIN_DEPOSIT) await store.put(RECORDS, key, c);
      if (decimals !== null || u.held >= VAULT_CONSTANTS.MIN_DEPOSIT) page.log?.("near sell resume: a closed W read again on the two providers holds money: rebuilt");
    }
    const kept = await store.get(RECORDS, emptyKey).catch(() => undefined);
    if (isObj(kept) && isObj(kept.confirm)) {
      const { [c.w]: _, ...rest } = kept.confirm;
      await store.put(RECORDS, emptyKey, { ...kept, confirm: rest });
    }
  };
  const locks = page.locks ?? (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  await (locks ? locks.request(`${PICK_LOCK}${page.network}`, { mode: "exclusive" }, write) : write());
}

/** A rebuilt "sent" record whose W the two providers read holding its token: "filled" with that read as its fill, under
 *  the pick lock, unless the record changed meanwhile. A decimals read that fails leaves it for the next load. */
async function filledFromRead(page: NearBuyPage, key: string, r: NearBuyRecord, held: bigint): Promise<void> {
  let decimals: number;
  try {
    decimals = page.decimals ? await page.decimals(r.token) : await readNearDecimals(page.network, page.rpcs(), r.token);
  } catch (e) {
    page.log?.(`near sell resume: decimals not read (${legCause(e)})`);
    return;
  }
  const store = await page.store();
  const write = async () => {
    const now = nearBuyRecordOf(await store.get(RECORDS, key).catch(() => undefined));
    if (!now || now.stage !== "sent" || now.fill !== undefined || !(now.sell === undefined || now.sell.stage === "refused")) return;
    const before = baselineOf(now);
    if (held <= before) return;
    await store.put(RECORDS, key, { ...now, stage: "filled", fill: { out: (held - before).toString(), decimals } } satisfies NearBuyRecord);
    page.log?.("near sell resume: a rebuilt W holds its coin, shown");
  };
  const locks = page.locks ?? (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  await (locks ? locks.request(`${PICK_LOCK}${page.network}`, { mode: "exclusive" }, write) : write());
}

/**
 * The sell flow's deps over one buy record. `only`: the record a resume takes (none: the oldest of the ask's token as the
 * header says). `id`: the op of a new sell. `end` writes the run's answer to the record and its op.
 */
export function sellDepsOf(page: NearBuyPage, only: string | null, id: string, slippageBps: number, home = false): NearSellDeps & { release(): void; end(a: unknown): Promise<unknown> } {
  const log = page.log ?? ((line: string) => console.info(line));
  const now = page.now ?? (() => Date.now());
  const locks = page.locks ?? (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  let rec: (NearBuyRecord & { sell: NearSellMark }) | null = null;
  let release: (() => void) | null = null;
  // the record's writes, one after another in the order asked
  let queue: Promise<void> = Promise.resolve();

  const write = (change: (m: NearSellMark) => NearSellMark): Promise<void> => {
    if (rec === null) return queue;
    rec = { ...rec, sell: change(rec.sell) };
    const r = rec;
    queue = queue
      .then(async () => {
        const store = await page.store();
        await store.put(RECORDS, `${NEAR_BUY_KEY}${r.id}`, r);
        const m = r.sell;
        await store.put("ops", m.id, { kind: "sell", chain: "near", token: r.token, stage: m.stage, txs: m.txs, created_ms: m.created_ms, ...(m.code === undefined ? {} : { code: m.code }) });
      })
      .catch((e: unknown) => log(`near sell record: ${legCause(e)}`));
    return queue;
  };
  const addTxs = (hashes: readonly string[]) => write((m) => ({ ...m, txs: [...m.txs, ...hashes.filter((h) => !m.txs.some((t) => t.hash === h)).map((hash): TxRef => ({ chain: "near", hash }))] }));
  const unlock = () => {
    release?.();
    release = null;
  };
  // W and the token its buy record names (the signer's bound), with the least of it that is W's coin (coinMinOf)
  const w = () => {
    const r = rec!;
    return { id: r.w, l: BigInt(r.l), j: r.j, token: r.token, coinMin: coinMinOf(r) };
  };
  // the seed under its lock, zeroed after; W derived again and held to the record's
  const withSeed = <T>(fn: (seed: Uint8Array) => Promise<T> | T): Promise<T> =>
    page.seedLock(async () => {
      const r = rec!;
      const seed = await page.seed64();
      try {
        if (nearSwapWallet(seed, BigInt(r.l), r.j).id !== r.w) throw new Error("W is not the record's");
        return await fn(seed);
      } finally {
        seed.fill(0);
      }
    });

  return {
    release: unlock,
    home,
    // W's coin kept once its USDC moved: the record a position of what W holds over its baseline (a fill); a decimals
    // read that fails leaves it to the way home's next read (filledFromRead)
    async kept(held) {
      const r = rec;
      if (r === null) return;
      const before = baselineOf(r);
      if (held <= before) return;
      const decimals = page.decimals ? await page.decimals(r.token) : await readNearDecimals(page.network, page.rpcs(), r.token);
      rec = { ...r, stage: "filled", fill: { out: (held - before).toString(), decimals } };
      await write((m) => m);
      log("near sell: W's coin kept as a position");
    },
    async end(a) {
      if (rec === null) return a;
      const result = isObj(a) && isObj(a.result) ? a.result : null;
      // a sell sent before (its swap out, or its USDC on the way home) stays sent: never read as nothing sold
      const was = rec.sell.stage;
      const code = isObj(a) && typeof a.error === "string" ? a.error : undefined;
      // trade_used with nothing of this sell sent (a swap of W's still on its way, or the helper's bound on what W costs
      // it): never a dead end, the sell stays open (its stage as it was) and is taken up again on load and on the next tap
      const open = result === null && code === "trade_used" && was !== "sent";
      // a run that ended with nothing sold and W's coin kept (coin_kept, or amount_too_low: a sale the vault would refuse)
      // is over whatever came before it: refused, so no load takes it up again as an open sell
      const over = result === null && (code === "coin_kept" || code === "amount_too_low");
      const stage: NearSellMark["stage"] = result !== null && (result.stage === "filled" || result.stage === "part_filled" || result.stage === "sent") ? result.stage : over ? "refused" : was === "sent" ? "sent" : open ? was : "refused";
      const hashes = result !== null && Array.isArray(result.txs) ? result.txs.flatMap((t) => (isObj(t) && typeof t.hash === "string" ? [t.hash] : [])) : [];
      await addTxs(hashes);
      await write((m) => {
        const next: NearSellMark = { ...m, stage };
        if (stage === "filled" || stage === "part_filled") {
          delete next.code;
          delete next.cause;
        }
        if (code !== undefined) next.code = code;
        return next;
      });
      log(`near sell ${stage}${code === undefined ? "" : `: ${code}`}`);
      return stage === "sent" && result === null ? { result: { stage: "sent", txs: rec.sell.txs } } : a;
    },
    network: page.network,
    async wallet(token) {
      // asked once per run; asked again, the lock held before goes first
      unlock();
      if (locks) await new Promise<void>((held) => void locks.request(`${LOCK}${page.network}/${token}`, { mode: "exclusive" }, () => new Promise<void>((done) => ((release = done), held()))));
      const store = await page.store();
      const notes = await page.notes();
      const all: NearBuyRecord[] = [];
      for (const k of (await store.keys(RECORDS)).filter((x) => x.startsWith(NEAR_BUY_KEY))) {
        const r = nearBuyRecordOf(await store.get(RECORDS, k).catch(() => undefined));
        if (r && r.network === page.network && r.token === token && (only === null || r.id === only)) all.push(r);
      }
      all.sort((x, y) => x.created_ms - y.created_ms);
      // an unfinished sell first (continued, never started again), else the oldest W paid and not sold that holds
      // something to sell or to bring home (a token, or USDC of at least the least deposit); a W whose last sell found
      // its proceeds under the least deposit (amount_too_low) only after every other, so dust never holds up the next W
      let r = all.find((x) => sellOpen(x.sell));
      // a sell kept open by trade_used with nothing sent, taken up NEAR_SELL_RESUMES times already: it ends with its code
      // (its token stays in positions); a load leaves it there, a tap goes on to a fresh sell
      while (r !== undefined && unsent(r.sell!) && r.sell!.resumes >= NEAR_SELL_RESUMES) {
        const m: NearSellMark = { ...r.sell!, stage: "refused" };
        const ended = { ...r, sell: m };
        await store.put(RECORDS, `${NEAR_BUY_KEY}${r.id}`, ended);
        await store.put("ops", m.id, { kind: "sell", chain: "near", token: r.token, stage: m.stage, txs: m.txs, created_ms: m.created_ms, ...(m.code === undefined ? {} : { code: m.code }) });
        all[all.indexOf(r)] = ended;
        log(`near sell ended past its resumes: ${m.code ?? ""}`);
        if (only !== null) return null;
        r = all.find((x) => sellOpen(x.sell));
      }
      if (r === undefined) {
        const paid: NearBuyRecord[] = [];
        for (const x of all) {
          if (sold(x.sell) || (x.stage !== "sent" && x.stage !== "filled")) continue;
          if (!(await paidW(x, notes))) continue;
          paid.push(x);
        }
        const dust = (x: NearBuyRecord) => x.sell?.stage === "refused" && x.sell.code === "amount_too_low";
        // what W holds: something to sell or bring home, nothing, or not read (a W never created reads as no account)
        const holds = async (x: NearBuyRecord): Promise<"holds" | "empty" | "unread"> => {
          try {
            const [t, u] = await Promise.all([readW(page, { wallet: x.w, side: "sell", token }), readW(page, { wallet: x.w, side: "buy", token })]);
            // a coin under the record's floor is a stranger's dust: no token, so a W holding only that is empty here
            return t.account === x.w && u.account === x.w && !coinCounts(x, t.held) && u.held < VAULT_CONSTANTS.MIN_DEPOSIT ? "empty" : "holds";
          } catch {
            return "unread";
          }
        };
        // a W read holding something first; a W that cannot be read only when none can (its run reads it again)
        const unread: NearBuyRecord[] = [];
        for (const x of [...paid.filter((y) => !dust(y)), ...paid.filter(dust)]) {
          const h = await holds(x);
          if (h === "unread") unread.push(x);
          if (h !== "holds") continue;
          r = x;
          break;
        }
        r ??= unread[0];
      }
      if (r === undefined) {
        log("near sell: no wallet holds the token");
        return null;
      }
      // a new sell on a W sold before keeps the last trade delegate that sell signed (it may still be held)
      const kept = (r.sell as NearSellMark | undefined)?.trade;
      const m: NearSellMark = sellOpen(r.sell) ? { ...r.sell, resumes: r.sell.resumes + 1 } : { id, slippage_bps: slippageBps, created_ms: now(), resumes: 0, stage: "pending", step: "read", txs: [], ...(kept === undefined ? {} : { trade: kept }) };
      // which run this is, stored on the mark: the way home, or a sale (a tap, or a sale the user asked taken up)
      if (home) m.home = true;
      else delete m.home;
      rec = { ...r, sell: m };
      await write((x) => x);
      log(sellOpen(r.sell) ? `near sell resumed at ${r.sell.step}` : "near sell recorded");
      return w();
    },
    helper: async (body) => {
      const a = await sendNearTrade(body, page.fetchFn);
      if (Array.isArray(a.tx_hashes)) await addTxs(a.tx_hashes);
      return a;
    },
    ...(({ quote: _q, ...r }) => r)(nearReads(page)),
    sign: (l, j, given, request, q, s, bound) =>
      withSeed((seed) => {
        const r = rec!;
        if (l !== BigInt(r.l) || j !== r.j || request.wallet !== r.w || bound !== r.token) throw new Error("the sell is not the record's W");
        return signNearSwapDelegates(seed, l, j, given, request, q, s, bound);
      }),
    note: async (x, k, create) => {
      const scope = vaultScope(page.network);
      if (scope === null) throw new Error("no vault on this network");
      const notes = await page.notes();
      return withSeed((seed) => nearSellNote(notes, seed, scope, { l: x.l, j: x.j }, k, create));
    },
    move: async (x, noteId, amount) => {
      if (page.move) {
        const given = await page.move(x, noteId, amount);
        if (given.kind === "deposited") await addTxs(given.txs);
        return given;
      }
      const notes = await page.notes();
      const net = NEAR_NETWORKS[page.network];
      const rpcs = page.bindRpcs?.() ?? ([bindRpc(net.fastnear[0]!), bindRpc(net.drpc)] as const);
      const signal = page.signal?.();
      const end = await withSeed((seed) => nearReturnMove(seed, { l: x.l, j: x.j }, noteId, amount, { network: page.network, store: notes, rpcs, ...(signal ? { signal } : {}) }));
      if (end.kind === "deposited") await addTxs(end.txs);
      return end;
    },
    wait: page.wait ?? ((ms) => new Promise((ok) => setTimeout(ok, ms))),
    log: (step, outcome) => {
      log(`near sell ${step}: ${outcome}`);
      void write((m) => ({ ...m, step }));
    },
    stop: (step, code, cause) => {
      log(`near sell stopped at ${step}: ${code}${cause === undefined ? "" : ` (${cause})`}`);
      void write((m) => ({ ...m, step, code, ...(cause === undefined ? {} : { cause }) }));
    },
    lastTrade: () => {
      const t = rec?.sell.trade;
      if (t === undefined) return null;
      if (!isObj(t) || typeof t.nonce !== "string" || !/^\d{1,20}$/.test(t.nonce) || typeof t.mbh !== "string" || !/^\d{1,20}$/.test(t.mbh)) throw new Error("the sell's trade is not one");
      return { nonce: BigInt(t.nonce), mbh: BigInt(t.mbh) };
    },
    // kept on the record before the delegate is sent; a write that fails throws, and nothing is sent
    traded: async (t) => {
      if (rec === null) throw new Error("no sell record");
      rec = { ...rec, sell: { ...rec.sell, trade: { nonce: t.nonce.toString(), mbh: t.mbh.toString() } } };
      const r = rec;
      const kept = queue.then(async () => (await page.store()).put(RECORDS, `${NEAR_BUY_KEY}${r.id}`, r));
      queue = kept.then(
        () => {},
        (e: unknown) => log(`near sell record: ${legCause(e)}`),
      );
      await kept;
    },
  };
}

// ---- The rebuild of the buy records from the chain (card near-holdings-restore) ----

/** The key (in the trade's own "quotes" store, with the network after it) of the Ws never read again: a W whose note's
 *  final spend paid someone else, and a W whose proven token and USDC both read empty with nothing of it in flight. */
export const NEAR_HOLDINGS_EMPTY_KEY = "near-holdings-empty:";
/** The key of each SPENT note's W and nullifier (note id -> both), derived once under the seed's lock, never per load. */
export const NEAR_HOLDINGS_W_KEY = "near-holdings-w:";
/** The slippage a rebuilt record keeps: its sell's bound only for a USDC-only W's way home (no swap), as a tap brings its own. */
export const NEAR_RESTORED_SLIPPAGE_BPS = 100;
/** Wallets asked of the helper in one POST /v1/bind/record (the kit's cap on its body). */
export const NEAR_RECORD_WALLETS_MAX = HELPER_BIND_RECORD_WALLETS_MAX;
/** The longest record answer read: 64 Ws of a few carried calls each. */
export const NEAR_RECORD_MAX_BYTES = 1_048_576;
/** A delegate's life in blocks at most (the helper's EXPIRY_MAX_BLOCKS, bind/checks.ts): no call W signed lands after
 *  its max_block_height, and a creation's W gets its first call well inside this many blocks of it. */
export const NEAR_DELEGATE_LIFE_BLOCKS = 600n;
/** The seat's final may stand this many blocks behind the spends read's block at most, else it is stale. */
export const NEAR_SEAT_LAG_MAX = 30;
/** Blocks past a pending call's max_block_height after which it is settled whatever the helper last read. A delegate
 *  runs at its max_block_height at the latest, but what it starts runs on in later receipts (the token's
 *  ft_transfer_call into Rhea, the swap, the output's ft_transfer back, ft_resolve_transfer): a block or two each, and
 *  the protocol delays receipts under congestion. 100 blocks, about a minute and a half, holds that chain with room;
 *  a longer wait only keeps USDC on W longer. A creation the helper calls pending (a plain Transfer, no last block of
 *  its own) is settled the same many blocks past the block this device first read W so. */
export const NEAR_PENDING_SETTLED_BLOCKS = 100n;

/** The helper's record of one W (POST /v1/bind/record): the token its first carried call named, each call's relayer
 *  transaction as signed and sent, and W's creation. Nothing here is believed but what W's own signature proves. */
export type NearWRecord = HelperBindRecord;
const RECORD_URL = RELEASE_BIND_URL.replace(/\/v1\/bind$/, "/v1/bind/record");
const CALL_STATES: readonly HelperBindRecordState[] = ["pending", "landed", "failed", "dropped"];

/** The helper's records of `wallets` (at most NEAR_RECORD_WALLETS_MAX), checked to the shape, one per wallet asked in order. */
export async function nearWRecords(network: NearNetwork, wallets: readonly string[], fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<NearWRecord[]> {
  if (wallets.length < 1 || wallets.length > NEAR_RECORD_WALLETS_MAX || !wallets.every((w) => IMPLICIT_W.test(w)) || new Set(wallets).size !== wallets.length) throw new Error("record: 1 to 64 distinct implicit ids");
  const res = await fetchFn(RECORD_URL, {
    ...HELPER_FETCH_INIT,
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ network, wallets: [...wallets] } satisfies HelperBindRecordRequest),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]) : AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`record: HTTP ${res.status}`);
  let a: unknown;
  try {
    a = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readCapped(res, NEAR_RECORD_MAX_BYTES)));
  } catch {
    throw new Error("record: not JSON");
  }
  const recs = isObj(a) && Array.isArray(a.records) ? a.records : null;
  if (recs === null || recs.length !== wallets.length) throw new Error("record: not one per wallet");
  return recs.map((r, k): NearWRecord => {
    const str = (x: unknown) => typeof x === "string";
    if (!isObj(r) || r.wallet !== wallets[k] || !(r.token === null || (str(r.token) && ACCOUNT_ID.test(r.token as string))) || !Array.isArray(r.calls)) throw new Error("record: out of shape");
    for (const c of r.calls) {
      if (!isObj(c) || !str(c.tx_hash) || !str(c.method) || !str(c.side) || !CALL_STATES.includes(c.state as HelperBindRecordState)) throw new Error("record: a call out of shape");
      // a final call (landed, failed) with its signed bytes; one not on chain (pending, dropped) with its last block alone
      const final = c.state === "landed" || c.state === "failed";
      if (final ? !str(c.signed_tx) || c.max_block_height !== undefined : c.signed_tx !== undefined || !(c.max_block_height === undefined || (str(c.max_block_height) && /^(0|[1-9]\d{0,19})$/.test(c.max_block_height as string))))
        throw new Error("record: a call out of shape");
    }
    const cr = r.created;
    if (!(cr === null || (isObj(cr) && str(cr.tx_hash) && CALL_STATES.includes(cr.state as HelperBindRecordState) && str(cr.height) && /^(0|[1-9]\d{0,19})$/.test(cr.height as string)))) throw new Error("record: the creation out of shape");
    return r as unknown as NearWRecord; // every field checked above
  });
}
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_W = /^[0-9a-f]{64}$/;

/** One reader's view at one block: the result's JSON, refused unless the answer names that block (and its hash). */
async function seatView(rpc: NearRpc, contract: string, method: string, args: unknown, at: { finality: "final" } | { block_id: number }, hash: string | null, signal?: AbortSignal): Promise<{ v: unknown; height: number; hash: string }> {
  const a = await rpc.query({ request_type: "call_function", ...at, account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) }, signal);
  const r = isObj(a) && a.error === undefined && isObj(a.result) ? a.result : null;
  if (r === null || !Number.isSafeInteger(r.block_height) || typeof r.block_hash !== "string" || !Array.isArray(r.result) || r.result.length > 4096 || !r.result.every((x) => Number.isInteger(x) && x >= 0 && x <= 255))
    throw new Error(`seat: ${method}: not a view answer`);
  if ("block_id" in at && (r.block_height !== at.block_id || r.block_hash !== hash)) throw new Error(`seat: ${method}: not at block ${at.block_id}`);
  return { v: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(r.result as number[]))), height: r.block_height as number, hash: r.block_hash };
}
const u128Of = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^(0|[1-9]\d{0,38})$/.test(v)) throw new Error(`seat: ${what}: not an amount`);
  return BigInt(v);
};

/** What the pass did: the records it wrote (their W), the Ws kept empty, and what it left to a later pass. */
export type NearHoldingsPass = { written: string[]; empty: string[]; unread: string[] };
/** The pass's own reads, each replaceable in tests: the vault's spends rows and the block they were read at (both
 *  providers at one block, vaultSync), the helper's records of W, and the seat W's balances are read on. */
export type NearHoldingsReads = {
  spends?(signal?: AbortSignal): Promise<{ rows: readonly VaultSpendRow[]; height: number }>;
  records?(wallets: readonly string[], signal?: AbortSignal): Promise<NearWRecord[]>;
  seat?: NearRpc;
  signal?: AbortSignal;
  /** A restore or a Sync (pool-restore's nearWalked): the soft empty marks and the first-seen marks are dropped first,
   *  so every such W is read again. */
  fresh?: boolean;
};

/** The least of `token` on W that counts as W's coin: W's own buy swap's min_amount_out as it reaches W (the token's
 *  buy fee taken off, as the quote reads it: a mainnet launchpad token only, every other token has none), and no less
 *  than what W's own sell swap sent in when it signed one. A fee read as not known (code not pinned, an answer not
 *  understood) is taken at the widest fee the device reads (NEAR_FEE_WIDEST_BPS): the least the coin can have arrived
 *  as, so W's own coin is never under its floor and W is never left unread for good. A fee read that fails throws (W read
 *  again on a later pass). page.tokenFee replaces the fee read in tests. */
/** The widest token fee the device reads, in bps (kit/src/near/token-fee.ts takes a rate under 10,000 bps). */
export const NEAR_FEE_WIDEST_BPS = 9_999;
async function coinFloor(page: NearBuyPage, token: string, buyMin: bigint, sellIn: bigint | null): Promise<bigint> {
  let f = buyMin;
  const fee = page.tokenFee
    ? await page.tokenFee(token)
    : page.network === "mainnet" && nearTokenFeeView(token) !== null
      ? (await rheaQuote({ network: page.network, rpcs: page.rpcs(), side: "buy", token, amountIn: VAULT_CONSTANTS.MIN_DEPOSIT, pools: await page.pools(token) })).fee
      : null;
  if (fee !== null) {
    f = fee.unknown ? (buyMin * BigInt(10_000 - NEAR_FEE_WIDEST_BPS)) / 10_000n : nearFeeBuyerReceives(fee, NEAR_RHEA[page.network].exchange, buyMin);
  }
  if (f < 1n) f = 1n;
  return sellIn !== null && sellIn > f ? sellIn : f;
}
/** The coin on W counts as the record's: at least coinMinOf(r). A record with no floor and no fill counts none: a
 *  live one never sent a swap (every build writes the floor before its swap leaves, src/near-trade.ts's swap step), a
 *  rebuilt one has no buy swap of W's (or only Rhea's wrapped NEAR as a stand-in token). */
const coinCounts = (r: NearBuyRecord, held: bigint): boolean => {
  const m = coinMinOf(r);
  return m !== null && held >= m;
};
/** What W held of the token before its buy's swap (the record's baseline), 0 when it keeps none. */
const baselineOf = (r: NearBuyRecord): bigint => (isObj(r.swap) && typeof r.swap.before === "string" && /^\d{1,78}$/.test(r.swap.before) ? BigInt(r.swap.before) : 0n);
/** The least of the record's token on W that is W's coin (coinMin of its floor, its baseline and its fill). Any other
 *  field a record's swap carries (a `funded` floor an unshipped build wrote) is not read. */
function coinMinOf(r: NearBuyRecord): bigint | null {
  const digits = (x: unknown): x is string => typeof x === "string" && /^\d{1,78}$/.test(x);
  const swap = isObj(r.swap) && digits(r.swap.floor) && digits(r.swap.before) ? r.swap : undefined;
  const fill = isObj(r.fill) && typeof r.fill.out === "string" && /^[1-9]\d{0,77}$/.test(r.fill.out) ? BigInt(r.fill.out) : null;
  return coinMin(swap ? BigInt(swap.floor) : null, swap ? BigInt(swap.before) : 0n, fill);
}
/**
 * The one rule for what of W's token is W's coin, for every site that decides on it (the way home, confirmOnTwo, the
 * tap's W pick, the sell run's coinMin, the rebuild's coin and lost-found reads): the baseline plus the floor W's buy
 * signed, or plus what that buy received (`fill`) when it landed under its floor, the lesser; no floor and no fill: none
 * is. A coin a buy received is a position and sells, whatever its floor; dust on top of it only joins the sale.
 */
function coinMin(floor: bigint | null, before: bigint, fill: bigint | null): bigint | null {
  const f = floor !== null && floor > 0n ? floor : null;
  const least = f === null ? fill : fill !== null && fill < f ? fill : f;
  return least === null ? null : before + least;
}
/** The kept records awaiting their one read on the two providers, from the empty key's value. */
function confirmsOf(kept: unknown): Map<string, NearBuyRecord> {
  const m = new Map<string, NearBuyRecord>();
  if (isObj(kept) && isObj(kept.confirm))
    for (const [w, v] of Object.entries(kept.confirm)) {
      const r = nearBuyRecordOf(v);
      if (IMPLICIT_W.test(w) && r !== undefined && r.w === w && r.swap !== undefined) m.set(w, r);
    }
  return m;
}

/** A spends row that paid its recipient: paid, or settled with nothing refunded (the helper's own `delivered` rule). */
const delivered = (r: VaultSpendRow): boolean => r.status === "paid" || (r.status === "settled" && r.refundValue === 0n);

/**
 * Every NEAR buy's W the store holds no record of, its record made again (card near-holdings-restore):
 * - The Ws: each SPENT note of the vault's scope gives W = W_{near,l,j} (l its label, j = jOf(its ref)), as the buy
 *   names it, derived once and kept (NEAR_HOLDINGS_W_KEY). A W counts only where the vault's spends row of that note's
 *   nullifier pays W and delivered (vaultSync's, both providers at one final block: the whole list, naming no W).
 * - The token: from W's own signed calls, never from what W holds. The helper's records (POST /v1/bind/record, up to
 *   64 Ws a call) carry each final call's relayer transaction (a pending or dropped one: its last block alone);
 *   nearWCallOf checks the delegate inside as W's (its NEP-366 signature by W's key), and the token is the one those
 *   calls name. A helper token they do not prove, or two tokens,
 *   rebuild nothing. A W the helper has no call of has no proven token.
 * - What W holds: its proven token, its USDC and Rhea's lost-found of the token for W, read on the helper's keyed seat
 *   alone (the network's `seat`: no spare, no other provider), one reader at one final block, each answer of that
 *   block and hash; the seat's final no more than NEAR_SEAT_LAG_MAX behind the spends read, else stale. No request of
 *   the pass names W to anyone but the helper; a seat or helper failure stops the pass, read again on a later load.
 *   Tokens W holds beyond its proven token and USDC are never read, shown or signed on.
 * - The coin that counts (coinFloor): W's proven token at no less than the floor W itself signed, its buy swap's
 *   min_amount_out as it reaches W (the token's buy fee taken off), and no less than what W's own sell swap sent in once
 *   it signed one. Under it the coin is ignored for every decision (a stranger's dust, or what a whole-balance sell
 *   leaves): never shown, never holding the USDC back. A W with no buy swap of its own has no floor and no coin counts.
 * - The record: W holding the coin that counts: "filled", its fill what W holds, its cost the payout W received (the
 *   row's withdrawn less its fee), its floor kept (swap.floor) for the way home, whatever the helper says of a sell.
 *   W holding USDC of at least the least deposit: "sent", its proven token as its token (Rhea's wrapped NEAR, with no
 *   floor, only for a W no call of names one), past its resumes (resumeNearSells takes it home, or makes it "filled"
 *   when the two providers find the coin that counts on W), only once nothing of W is in flight and no call W signed
 *   can still land: the seat's final past every delegate's max_block_height, a pending call's by
 *   NEAR_PENDING_SETTLED_BLOCKS more (with no last block known, past W's life and that margin); with no call, past W's
 *   life, NEAR_DELEGATE_LIFE_BLOCKS from the creation's height or this device's first read of W, the later; a creation
 *   the helper calls pending, NEAR_PENDING_SETTLED_BLOCKS past that first read (the helper's word moving only when,
 *   never where, the money goes). The coin in the lost-found, or USDC held back by a call still able to land: nothing
 *   yet, read again later. A proven token under its floor and USDC empty with nothing in flight: closed by that seat
 *   answer until the next restore or Sync (reads.fresh), and read once on the two providers on the way home (the
 *   confirm list), so no seat answer hides a coin for good. Closed for good: a note's W whose spends row is final and
 *   paid someone else or was refunded (a plain withdrawal).
 * - Idempotent: under the network's pick lock, a record is written only when no record of the store names W, under
 *   NEAR_BUY_KEY + "restored:" + W, so a record the store has always wins and two passes write one. Nothing is signed.
 * - The sign out's signal (reads.signal, else page.signal()) stops it between any two reads: nothing is asked after.
 */
export async function nearHoldingsPass(page: NearBuyPage, reads: NearHoldingsReads = {}): Promise<NearHoldingsPass> {
  const out: NearHoldingsPass = { written: [], empty: [], unread: [] };
  const net = NEAR_NETWORKS[page.network];
  const scope = vaultScope(page.network);
  if (net.vault === null || scope === null) return out;
  const vault = net.vault;
  const log = page.log ?? ((line: string) => console.info(line));
  const now = page.now ?? (() => Date.now());
  const locks = page.locks ?? (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  const signal = reads.signal ?? page.signal?.();
  const stopped = () => signal?.aborted === true;
  if (stopped()) return out;
  const store = await page.store();
  const notes = await page.notes();
  const spent = (await notes.list()).filter((n): n is NoteRecord & { leaf: NonNullable<NoteRecord["leaf"]> } => n.scope === scope && n.state === "SPENT" && n.leaf !== undefined);
  if (spent.length === 0) return out;
  const records = async (): Promise<NearBuyRecord[]> => {
    const all: NearBuyRecord[] = [];
    for (const k of (await store.keys(RECORDS)).filter((x) => x.startsWith(NEAR_BUY_KEY))) {
      const r = nearBuyRecordOf(await store.get(RECORDS, k).catch(() => undefined));
      if (r && r.network === page.network) all.push(r);
    }
    return all;
  };
  const known = new Set((await records()).map((r) => r.w));
  const emptyKey = `${NEAR_HOLDINGS_EMPTY_KEY}${page.network}`;
  const kept = await store.get(RECORDS, emptyKey).catch(() => undefined);
  // final: a W whose note's spend paid someone else (the vault's list says so, never read again). soft: a W one seat
  // answer read empty, by the block it read at, dropped on a restore or a Sync. seen: a paid W with no call and no
  // creation at the helper, by the block it was first read at (another device may be mid-buy on it).
  const empty = new Set<string>(isObj(kept) && Array.isArray(kept.final) ? kept.final.filter((x): x is string => typeof x === "string" && IMPLICIT_W.test(x)) : []);
  const marks = (k: string): Map<string, number> =>
    new Map(isObj(kept) && isObj(kept[k]) ? Object.entries(kept[k]).filter((e): e is [string, number] => IMPLICIT_W.test(e[0]) && Number.isSafeInteger(e[1]) && (e[1] as number) >= 0) : []);
  // a restore or Sync drops the soft marks; the first-seen marks only time the wait, so they stay
  const soft = reads.fresh === true ? new Map<string, number>() : marks("soft");
  const seen = marks("seen");
  // the Ws one seat answer closed, each with the record it would have: read once on the two providers on the way home
  const confirm = confirmsOf(kept);
  let changed = reads.fresh === true && marks("soft").size > 0;
  // each spent note's W and nullifier: kept by note id, so the seed is opened only for notes not derived before
  const wKey = `${NEAR_HOLDINGS_W_KEY}${page.network}`;
  const wKept = await store.get(RECORDS, wKey).catch(() => undefined);
  const ws = new Map<string, { w: string; nh: string }>(
    isObj(wKept) ? Object.entries(wKept).filter((e): e is [string, { w: string; nh: string }] => isObj(e[1]) && typeof e[1].w === "string" && IMPLICIT_W.test(e[1].w) && typeof e[1].nh === "string" && /^\d{1,80}$/.test(e[1].nh)) : [],
  );
  const missing = spent.filter((n) => !ws.has(n.id));
  if (missing.length > 0) {
    await page.seedLock(async () => {
      const seed = await page.seed64();
      try {
        for (const n of missing) ws.set(n.id, { w: nearSwapWallet(seed, n.leaf.label, jOf(n.ref)).id, nh: noteSecrets(seed, n.ref).nullifierHash.toString() });
      } finally {
        seed.fill(0);
      }
    });
    await store.put(RECORDS, wKey, Object.fromEntries(ws));
  }
  const arms = spent.map((n) => ({ note: n, l: n.leaf.label, j: jOf(n.ref), ...ws.get(n.id)! }));
  const open = arms.filter((a) => !known.has(a.w) && !empty.has(a.w) && !soft.has(a.w));
  if (open.length === 0 || stopped()) return out;
  let rows: readonly VaultSpendRow[];
  let spendsAt: number;
  try {
    if (reads.spends) ({ rows, height: spendsAt } = await reads.spends(signal));
    else {
      const s = await vaultSync({ vault, rpcs: page.rpcs(), cursor: vaultSyncStart(vault), lists: ["spends"], ...(signal ? { signal } : {}) });
      (rows = s.spends), (spendsAt = s.height);
    }
  } catch (e) {
    log(`near holdings: spends not read (${legCause(e)})`);
    out.unread.push("spends");
    return out;
  }
  const byNh = new Map(rows.map((r) => [r.nullifierHash.toString(), r]));
  const paid: (typeof open[number] & { row: VaultSpendRow })[] = [];
  for (const a of open) {
    const row = byNh.get(a.nh);
    // a withdrawal of this note that did not pay its W (or did not deliver) is no buy, kept so for good; one not yet on
    // the list, or still moving, is read again on the next pass
    if (row !== undefined && (row.recipient !== a.w || (row.status === "settled" && !delivered(row)))) {
      empty.add(a.w);
      changed = true;
      continue;
    }
    if (row === undefined || !delivered(row) || row.withdrawn <= 0n || row.withdrawn <= row.fee) continue;
    paid.push({ ...a, row });
  }
  const seat = reads.seat ?? (net.seat === null ? null : pacedNearRpc(net.seat, page.fetchFn));
  const recordsOf = reads.records ?? ((w: readonly string[], s?: AbortSignal) => nearWRecords(page.network, w, page.fetchFn, s));
  const exchange = NEAR_RHEA[page.network].exchange;
  let block: { height: number; hash: string } | null = null;
  for (let k = 0; k < paid.length && !stopped(); k += NEAR_RECORD_WALLETS_MAX) {
    const batch = paid.slice(k, k + NEAR_RECORD_WALLETS_MAX);
    let recs: NearWRecord[];
    try {
      if (seat === null) throw new Error("no seat on this network");
      recs = await recordsOf(batch.map((a) => a.w), signal);
    } catch (e) {
      log(`near holdings: the helper's records not read (${legCause(e)})`);
      out.unread.push(...batch.map((a) => a.w));
      break;
    }
    let stop = false;
    for (const [i, a] of batch.entries()) {
      if (stopped() || stop) break;
      const rec = recs[i]!;
      // W's own calls: each final one checked as W's, the token they name; a call not on chain (pending, dropped) gives
      // only its last block, the helper's word for when, never for what
      const named = new Set<string>();
      let lastHeight = -1n;
      const pendingTill: (bigint | null)[] = [];
      // the least W's own buy swaps let the exchange send (min_amount_out), and the most its sell swaps sent in
      let buyMin: bigint | null = null;
      let sellIn: bigint | null = null;
      for (const c of rec.calls) {
        const mbh = c.max_block_height === undefined ? null : BigInt(c.max_block_height);
        if (c.state === "pending") pendingTill.push(mbh);
        if (c.signed_tx === undefined) {
          if (mbh !== null && mbh > lastHeight) lastHeight = mbh;
          continue;
        }
        const call = nearWCallOf(a.w, c.signed_tx);
        if (call === null) continue;
        if (call.maxBlockHeight > lastHeight) lastHeight = call.maxBlockHeight;
        const t = nearWCallToken(call, net.usdc, exchange);
        if (t === null) continue;
        named.add(t.token);
        if (t.minOut !== undefined && (buyMin === null || t.minOut < buyMin)) buyMin = t.minOut;
        if (t.amountIn !== undefined && (sellIn === null || t.amountIn > sellIn)) sellIn = t.amountIn;
      }
      if (named.size > 1 || (rec.token !== null && named.size === 1 && !named.has(rec.token))) {
        log("near holdings: a W's calls name more than one token, or not the helper's: nothing rebuilt");
        out.unread.push(a.w);
        continue;
      }
      const token = named.size === 1 ? [...named][0]! : null;
      let usdc: bigint, held = 0n, lost = 0n;
      try {
        if (block === null) {
          const f = await seatView(seat!, net.usdc, "ft_balance_of", { account_id: a.w }, { finality: "final" }, null, signal);
          if (f.height < spendsAt - NEAR_SEAT_LAG_MAX) throw new Error(`seat: its final ${f.height} stands behind ${spendsAt}`);
          block = { height: f.height, hash: f.hash };
          usdc = u128Of(f.v, "ft_balance_of");
        } else usdc = u128Of((await seatView(seat!, net.usdc, "ft_balance_of", { account_id: a.w }, { block_id: block.height }, block.hash, signal)).v, "ft_balance_of");
        if (token !== null) {
          held = u128Of((await seatView(seat!, token, "ft_balance_of", { account_id: a.w }, { block_id: block.height }, block.hash, signal)).v, "ft_balance_of");
          lost = u128Of((await seatView(seat!, exchange, "get_lostfound_token", { account_id: a.w, token_id: token }, { block_id: block.height }, block.hash, signal)).v, "get_lostfound_token");
        }
      } catch (e) {
        if (stopped()) break;
        log(`near holdings: the seat did not answer (${legCause(e)}); read again on a later load`);
        out.unread.push(...batch.slice(i).map((x) => x.w));
        stop = true;
        break;
      }
      const at = BigInt(block.height);
      // the block this device first read W: kept across loads, never reset by a Sync. W's life is timed from it or from
      // the creation's height, the later, so a helper that names an old creation cannot cut a wait short (another
      // device's buy asks W's creation right after its payout)
      if (!seen.has(a.w)) (seen.set(a.w, block.height), (changed = true));
      const first = BigInt(seen.get(a.w)!);
      const born = rec.created !== null && BigInt(rec.created.height) > first ? BigInt(rec.created.height) : first;
      // in flight: W's creation pending until the seat's final is NEAR_PENDING_SETTLED_BLOCKS past the first read; a call
      // pending until NEAR_PENDING_SETTLED_BLOCKS past its last block, or with no last block known, past W's life and that
      // margin
      const creating = rec.created?.state === "pending" && at <= first + NEAR_PENDING_SETTLED_BLOCKS;
      const inFlight = creating || pendingTill.some((m) => at <= (m ?? born + NEAR_DELEGATE_LIFE_BLOCKS) + NEAR_PENDING_SETTLED_BLOCKS);
      // no call W signed can land any more: past every delegate's last block; with no call, past W's life
      const settledW = !inFlight && (lastHeight >= 0n ? at > lastHeight : at > born + NEAR_DELEGATE_LIFE_BLOCKS);
      const base = { v: 1 as const, id: `restored:${a.w}`, network: page.network, amount: (a.row.withdrawn - a.row.fee).toString(), slippage_bps: NEAR_RESTORED_SLIPPAGE_BPS, w: a.w, l: a.l.toString(), j: a.j, note: a.note.id, fee: a.row.fee.toString(), created_ms: now(), resumes: NEAR_BUY_RESUMES, payout: "landed" as const, txs: [] };
      let made: NearBuyRecord | null = null;
      // the least of the coin that counts as W's (coinFloor): what W's own buy swap made the exchange send, as it reaches
      // W (less the token's buy fee), and once W signed a sell, no less than what that sell sent in. Under it the coin is
      // ignored for every decision (a stranger's dust, or what a whole-balance sell leaves): not shown, never holding
      // the USDC back. No buy swap of W's: no floor, no coin counts.
      let floor: bigint | null = null;
      if (token !== null && buyMin !== null) {
        try {
          floor = await coinFloor(page, token, buyMin, sellIn);
        } catch (e) {
          log(`near holdings: the token's fee not read (${legCause(e)})`);
          out.unread.push(a.w);
          continue;
        }
      }
      // W's own buy output the exchange could not send it waits in the lost-found: at its floor or more it is W's coin, read
      // again later; under it (or with no buy swap of W's) it is no coin of W's and holds nothing back
      const least = coinMin(floor, 0n, null);
      if (token !== null && least !== null && lost >= least) {
        log("near holdings: a W's coin waits in the exchange's lost-found; read again later");
        out.unread.push(a.w);
        continue;
      }
      const swap = floor === null ? {} : { swap: { floor: floor.toString(), before: "0" } };
      // two questions, apart: USDC of the least deposit goes home whatever W holds of the token (a "sent" record, whose
      // way home moves it, sells nothing and makes a coin still on W a position); with less, W's token at its floor is
      // its coin, a position
      if (usdc >= VAULT_CONSTANTS.MIN_DEPOSIT) {
        if (!settledW) {
          out.unread.push(a.w);
          continue;
        }
        // its proven token (a W no call of names a token keeps Rhea's wrapped NEAR, which it never bought)
        made = { ...base, token: token ?? NEAR_RHEA[page.network].wrap, stage: "sent", step: "receive", ...swap };
      } else if (token !== null && least !== null && held >= least) {
        let decimals: number;
        try {
          decimals = page.decimals ? await page.decimals(token) : await readNearDecimals(page.network, page.rpcs(), token);
        } catch (e) {
          log(`near holdings: decimals not read (${legCause(e)})`);
          out.unread.push(a.w);
          continue;
        }
        made = { ...base, token, stage: "filled", step: "receive", ...swap, fill: { out: held.toString(), decimals } };
      } else if (token !== null && settledW) {
        // its proven token and USDC empty, nothing in flight: closed by this seat answer, read again on a restore or Sync,
        // and once on the two providers on the way home (resumeNearSells), so no seat answer hides a coin for good
        soft.set(a.w, block.height);
        if (floor !== null) confirm.set(a.w, { ...base, token, stage: "sent", step: "receive", ...swap });
        out.empty.push(a.w);
        changed = true;
        continue;
      } else {
        out.unread.push(a.w);
        continue;
      }
      const r = made;
      const wrote = await (locks ? (locks.request(`${PICK_LOCK}${page.network}`, { mode: "exclusive" }, async () => put(r)) as Promise<boolean>) : put(r));
      if (wrote) out.written.push(a.w);
      if (seen.delete(a.w)) changed = true;
      if (confirm.delete(a.w)) changed = true;
    }
    if (stop) break;
  }
  async function put(rec: NearBuyRecord): Promise<boolean> {
    if ((await records()).some((r) => r.w === rec.w)) return false;
    const key = `${NEAR_BUY_KEY}${rec.id}`;
    if ((await store.get(RECORDS, key).catch(() => undefined)) !== undefined) return false;
    await store.put(RECORDS, key, rec);
    return true;
  }
  if (changed) await store.put(RECORDS, emptyKey, { final: [...empty], soft: Object.fromEntries(soft), seen: Object.fromEntries(seen), confirm: Object.fromEntries(confirm) });
  if (out.written.length > 0) log(`near holdings: ${out.written.length} record(s) rebuilt`);
  return out;
}
