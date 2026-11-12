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
import { HELPER_BIND_TRADE_CODES, HELPER_CODE_STATUS, HELPER_FETCH_INIT, type HelperBindTradeRequest } from "../../kit/src/helper/v1.ts";
import { NEAR_NETWORKS, type NearNetwork, type NearRpc } from "../../kit/src/near/networks.ts";
import { rheaQuote } from "../../kit/src/near/rhea.ts";
import { readNearSwapWallet, type NearSwapWalletArgs, type NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
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
import { nearReturnMove, nearSellFlow, nearSellNote, type NearSellDeps, type NearSellStep } from "./near-sell.ts";
import type { NearSellAsk } from "./rules/near-trade.ts";
import { nearBuyFlow, runNearBuy, type NearBuyAsk, type NearBuyBegun, type NearBuyDeps, type NearBuyProgress, type NearHelperAnswer, type NearPayoutEnd } from "./near-trade.ts";
import { nearView } from "./near-pools.ts";
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
  /** The sign out's signal of the moment (the move's wait ends on it; the money stays on W, its call written). */
  signal?(): AbortSignal;
  /** W read on both providers (the kit's readNearSwapWallet on rpcs() unless given). */
  readWallet?(a: Pick<NearSwapWalletArgs, "wallet" | "side" | "token">): Promise<NearSwapWalletState>;
  /** The token's decimals (readNearDecimals on rpcs() unless given). */
  decimals?(token: string): Promise<number>;
  /** The quote's candidate pools (near-pools.ts rheaPoolsKept). */
  pools(token: string): Promise<number[]>;
  locks?: LockManager;
  fetchFn?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

const readW = (page: NearBuyPage, a: Pick<NearSwapWalletArgs, "wallet" | "side" | "token">): Promise<NearSwapWalletState> =>
  page.readWallet ? page.readWallet(a) : readNearSwapWallet({ network: page.network, rpcs: page.rpcs(), ...a });
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
    readWallet: (a) => readW(page, a),
    quote: async (a) => rheaQuote({ network: page.network, rpcs: page.rpcs(), ...a, pools: await page.pools(a.token) }),
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
  for (const k of keys) {
    const r = nearBuyRecordOf(await store.get(RECORDS, k).catch(() => undefined));
    if (!r || r.network !== page.network || sold(r.sell) || (r.stage !== "sent" && r.stage !== "filled")) continue;
    if (!(await paidW(r, notes))) continue;
    let go = sellOpen(r.sell) || homing.has(`${r.l}:${r.j}`);
    // a buy with a fill holds the token: a position, sold only on a tap, never sent home on a load
    if (!go && r.fill !== undefined) continue;
    if (!go) {
      const holds = async () => {
        const [t, u] = await Promise.all([readW(page, { wallet: r.w, side: "sell", token: r.token }), readW(page, { wallet: r.w, side: "buy", token: r.token })]);
        return t.held === 0n && u.held >= VAULT_CONSTANTS.MIN_DEPOSIT;
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
    const deps = sellDepsOf(page, r.id, id, slippage);
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
}

/**
 * The sell flow's deps over one buy record. `only`: the record a resume takes (none: the oldest of the ask's token as the
 * header says). `id`: the op of a new sell. `end` writes the run's answer to the record and its op.
 */
export function sellDepsOf(page: NearBuyPage, only: string | null, id: string, slippageBps: number): NearSellDeps & { release(): void; end(a: unknown): Promise<unknown> } {
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
  // W and the token its buy record names (the signer's bound)
  const w = () => {
    const r = rec!;
    return { id: r.w, l: BigInt(r.l), j: r.j, token: r.token };
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
    async end(a) {
      if (rec === null) return a;
      const result = isObj(a) && isObj(a.result) ? a.result : null;
      // a sell sent before (its swap out, or its USDC on the way home) stays sent: never read as nothing sold
      const was = rec.sell.stage;
      const code = isObj(a) && typeof a.error === "string" ? a.error : undefined;
      // trade_used with nothing of this sell sent (a swap of W's still on its way, or the helper's bound on what W costs
      // it): never a dead end, the sell stays open (its stage as it was) and is taken up again on load and on the next tap
      const open = result === null && code === "trade_used" && was !== "sent";
      const stage: NearSellMark["stage"] = result !== null && (result.stage === "filled" || result.stage === "part_filled" || result.stage === "sent") ? result.stage : was === "sent" ? "sent" : open ? was : "refused";
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
            return t.account === x.w && u.account === x.w && t.held === 0n && u.held < VAULT_CONSTANTS.MIN_DEPOSIT ? "empty" : "holds";
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
    readWallet: (a) => readW(page, a),
    quote: async (a) => rheaQuote({ network: page.network, rpcs: page.rpcs(), ...a, pools: await page.pools(a.token) }),
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
