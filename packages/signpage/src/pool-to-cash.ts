// A pool's money back to Cash (card one-balance-buys-on-every-chain, part 3 (b); the Blindfill v2 lite paper §3-4: pool X
// to Cash is pool_out X, intents near, vault_in near).
//
// pool.move { from: X, to: "near", amount } moves `amount` of X's pool coin (whole units) into the NEAR vault as Cash:
// - The amount is planned as the pool withdraw form plans it (./withdraw/pool-form.ts checkPoolAmount on the run's own
//   funds read): the sum the run sends (which a piece rule may round up a grid step) and its Max fee. Nothing else is
//   sent.
// - Cash's own deposit quote carries it (./deposit-wire.ts depositQuoteHost, the deposit sheet's kind): X's coin in on
//   1Click, NEAR USDC out to U, the vault's one-time deposit account the note store names, refund to U inside
//   intents.near (which only U's key moves, and the follow's refund move carries into the vault). The quote is checked by
//   the deposit rule at the device's own price before any address is used, and its follow op is written under
//   `<op>/1click` before the address goes out (deposit-follow.ts quoted): the follow binds what reaches U into the vault
//   with no tap, across reloads.
// - The pool withdraw run pays that address (the form's own run, under `<op>/out`): the deposit address must be an
//   address of X's chain.
// - The move op (kind "move", under the request's id): leaving once the quote is checked and the run started, in_transit
//   once the run sent, then the deposit op's stage (moveStageOfDeposit): done once the money is bound in the vault.
//   A run that stopped with nothing sent fails the move; one that sent part leaves it to the deposit's follow (1Click's
//   refund of a short deposit lands under U and is moved into the vault).
// Pool X to pool Y (pool.move { from: X, to: Y }): the same move to Cash, then, once the deposit op is done, Cash's own
// move into Y (src/cash-to-pool.ts cashMover.move, `onward`) of the deposit quote's checked least USDC less the vault
// withdraw's fee, under `<op>/on`: the move op shows in_vault (that USDC kept as its `cash`), then the onward op's
// stages to done. Every hop stops in the vault: no hop ties the two pools together (lite paper v2 §4). A reload resumes
// it at its stage; the onward move starts only once (an op under `<op>/on` already written is followed, never sent again).
// An onward move the page refuses leaves the money in Cash: the move op shows failed, the money is the user's in Cash.
// Pool X to pool Y in one confidential swap (card move-one-confidential-swap; owner 14 Nov 03:37Z: "Move = ONE NEAR
// Intents confidential swap, pool payout -> destination pool, no vault stop"), when the page gives `direct`: the Move's
// pool.address host quotes X's coin into Y's pool to U_Y on Confidential Intents rails (src/pool-deposit-address.ts,
// `confidential`: checked at the device's own price of both coins and Y's floor, 1Click's own keyless tell read, the
// pool follow's op written under `<op>/pool` before the address goes out), the pool withdraw run pays that address
// (`<op>/out`), and the pool follow carries what lands at U_Y into Y's pool. The follow reads U_Y's balance on Y's two
// RPCs; 1Click's status (through the helper's key alone for a confidential address) only moves the stage shown, so a
// Move whose status is never read still ends once the chain shows the arrival. The move op: leaving, in_transit once
// the run sent, then the follow's stage (cash-to-pool.ts moveStageOfFollow) to done. Moves written before (with `cash`)
// resume on the vault route below.
// A read not in yet (a price, the pool's funds, Y's floor) answers down (Busy, Retry), never not_allowed.
// Every move out of a pool sends or fails in bounded time (card move-sends-or-says-why): its record is written leaving
// before its quote is asked, with send_by_ms (MOVE_SEND_MS on); the pool run claims the move (claimed_ms, one
// compare-and-set on the record) right before its first release leaves the device, and refuses to send past send_by_ms;
// the follow, past send_by_ms with no claim, ends the move failed by the same compare-and-set. Whichever writes first
// wins: a move shown failed never sends, and one that claimed is followed on to its end. A run that waits forever (a
// queue, a lock, a proof) or never started, and a page closed before its run sent, all end there.
// Nothing here logs.
import { base58 } from "@scure/base";
import { EVM_ADDRESS } from "./rules/pool.ts";
import type { DepositStage, ErrorCode, MoveStage, PoolChain, PoolStatePrice, TxRef } from "../../kit/src/signpage/messages.ts";
import { checkPoolAmount, formatUnits, POOL_ASSET, poolSendable, type PoolFunds, type PoolReady } from "./withdraw/pool-form.ts";
import { CASH_MARGIN_BPS, CASH_MOVE_POLL_MS, leastWhere, moveStageOfFollow, type MoveFollow, type MoveOpRecord } from "./cash-to-pool.ts";

type Refusal = { error: ErrorCode };

/** Whether `a` is an address of `chain`, as a deposit address there must be: a 32-byte base58 key on Solana, a 0x
 *  address on Base and Robinhood. */
/** How long a move out of a pool has, from its tap, to start sending its release (card move-sends-or-says-why): its
 *  quote (one 1Click round trip and its keyless tell), then a withdraw part's reads, its wait for an epoch's root (one
 *  60 s epoch and WITHDRAW_BOUNDARY_LAG_MS 30 s), its proof (6.7 s on a laptop, several times that on a phone) and its
 *  bind, about twice over; far inside the quote's 30 min deadline (DEPOSIT_QUOTE_DEADLINE_MS), so a release claimed at
 *  the last moment still lands in time. */
export const MOVE_SEND_MS = 300_000;

/** A move's send-by: its own send_by_ms, or, for a move written before this card (release 137 and earlier, no
 *  send_by_ms), its tap's time plus MOVE_SEND_MS. */
export const sendByOf = (rec: MoveOpRecord): number => rec.send_by_ms ?? rec.created_ms + MOVE_SEND_MS;

/** The claim's compare-and-set on a move record (card move-sends-or-says-why): claimed once already, or still leaving
 *  inside its send-by; never a move ended, nor one past its send-by with no claim. */
export function claimed(rec: MoveOpRecord | undefined, now: number): MoveOpRecord | null {
  if (rec === undefined || rec.kind !== "move" || rec.stage === "failed" || rec.stage === "done") return null;
  if (rec.claimed_ms !== undefined) return rec;
  if (rec.stage === "leaving" && now >= sendByOf(rec)) return null;
  return { ...rec, claimed_ms: now };
}

/** Whether a move's pool run (its op under <id>/out) shows no release sent: no record, or one still before its send or
 *  stopped, with no tx. in_transit is written before a release leaves (pool-testnet.ts owe), so it counts as sent. */
export const nothingSent = (out: { stage?: unknown; txs?: readonly unknown[] } | undefined): boolean =>
  out === undefined || ((out.stage === "proving" || out.stage === "stopped") && (!Array.isArray(out.txs) || out.txs.length === 0));

/** The follow's end of a move nothing sent for in time: failed only while still leaving, unclaimed and past its
 *  send-by. A move written before this card had no claim to write, so it ends only while its run (`out`) shows no
 *  release sent; one whose run sent is followed on as before. */
export function expired(rec: MoveOpRecord | undefined, now: number, out?: { stage?: unknown; txs?: readonly unknown[] }): MoveOpRecord | null {
  if (rec === undefined || rec.kind !== "move" || rec.stage !== "leaving" || rec.claimed_ms !== undefined || now < sendByOf(rec)) return null;
  if (rec.send_by_ms === undefined && !nothingSent(out)) return null;
  return { ...rec, stage: "failed", error: "not_sent" };
}

export function onPoolChain(chain: PoolChain, a: string): boolean {
  if (chain !== "solana") return EVM_ADDRESS.test(a);
  try {
    const k = base58.decode(a);
    return k.length === 32 && base58.encode(k) === a;
  } catch {
    return false;
  }
}

/** Each pool coin on 1Click: what the withdraw pays into the deposit quote's address. */
export const POOL_COIN_ASSET: Readonly<Record<PoolChain, string>> = Object.freeze({
  solana: "nep141:sol.omft.near",
  base: "nep141:base.omft.near",
  robinhood: "nep141:hood.omft.near",
});

/** The device's price of a pool coin as the decimal the kit's 1Click check reads. */
export function priceText(p: Pick<PoolStatePrice, "price" | "expo">): string {
  const d = -p.expo, digits = p.price.padStart(d + 1, "0");
  return d <= 0 ? digits : `${digits.slice(0, digits.length - d)}.${digits.slice(digits.length - d)}`;
}

/** The deposit quote's pricing of a pool coin for the deposit rule (rules/deposit-quote.ts PricedAsset): its decimals and
 *  the device's price on both reads, USDC out at 1; null for any other origin or with no price. */
export function pricedPoolCoin(origin: string, price: (chain: PoolChain) => Pick<PoolStatePrice, "price" | "expo"> | null): { decimals: number; pricing: { in: [string, string]; out: [string, string] } } | null {
  const chain = (Object.keys(POOL_COIN_ASSET) as PoolChain[]).find((c) => POOL_COIN_ASSET[c] === origin);
  const p = chain === undefined ? null : price(chain);
  if (chain === undefined || p === null) return null;
  const usd = priceText(p);
  return { decimals: POOL_ASSET[chain].decimals, pricing: { in: [usd, usd], out: ["1", "1"] } };
}

/** USDC (6 decimals) that `units` of `chain`'s pool coin are worth at the device's price, CASH_MARGIN_BPS under, rounded
 *  down: the least a move back to Cash is shown to bring (display only; the quote's own floor is the deposit rule's). */
export function cashUsdcOf(units: bigint, p: Pick<PoolStatePrice, "price" | "expo">, chain: PoolChain): bigint {
  const price = BigInt(p.price);
  if (price <= 0n || units <= 0n) return 0n;
  const d = POOL_ASSET[chain].decimals;
  // usdc = units / 10^d × price × 10^expo × 10^6 × (10,000 − margin) / 10,000
  const num = units * price * (10_000n - CASH_MARGIN_BPS);
  const e = 6 + p.expo - d;
  return e >= 0 ? (num * 10n ** BigInt(e)) / 10_000n : num / (10_000n * 10n ** BigInt(-e));
}

/** `units` of `from`'s pool coin in `to`'s, at the device's price of each, CASH_MARGIN_BPS under, rounded down: the
 *  least a direct move is shown to bring (display only; the quote's own floor is the pool deposit rule's at the same
 *  prices, and the pool's floor). */
export function coinOf(units: bigint, from: PoolChain, pf: Pick<PoolStatePrice, "price" | "expo">, to: PoolChain, pt: Pick<PoolStatePrice, "price" | "expo">): bigint {
  const a = BigInt(pf.price), b = BigInt(pt.price);
  if (a <= 0n || b <= 0n || units <= 0n) return 0n;
  // out = units / 10^df × a × 10^ef / (b × 10^et) × 10^dt × (10,000 − margin) / 10,000
  const num = units * a * (10_000n - CASH_MARGIN_BPS);
  const e = POOL_ASSET[to].decimals - POOL_ASSET[from].decimals + pf.expo - pt.expo;
  return e >= 0 ? (num * 10n ** BigInt(e)) / (b * 10_000n) : num / (b * 10_000n * 10n ** BigInt(-e));
}

/** A move op's stage from its deposit op's (wallet deposit/follow.ts): done once bound in the vault; refunded while
 *  1Click's refund is carried on; failed once the quote expired or 1Click failed it; in_transit otherwise. */
export function moveStageOfDeposit(stage: DepositStage): MoveStage {
  if (stage === "done") return "done";
  if (stage === "refunded" || stage === "refund_move") return "refunded";
  if (stage === "expired" || stage === "failed") return "failed";
  return "in_transit";
}

export type PoolToCashDeps = {
  price(chain: PoolChain): Pick<PoolStatePrice, "price" | "expo"> | null;
  /** The pool withdraw run's funds read for `chain` (its form's PoolWithdrawFormDeps.funds). */
  funds(chain: PoolChain): Promise<PoolFunds>;
  /** Cash's deposit quote of `amount` of `chain`'s pool coin (POOL_COIN_ASSET) to U, its follow op written under `id`:
   *  the checked deposit address, or the rule's refusal. */
  quote(chain: PoolChain, amount: bigint, id: string): Promise<{ address: string; minOut: bigint } | Refusal>;
  /** Whether `a` is an address of `chain` (a deposit address must be). */
  onChain(chain: PoolChain, a: string): boolean;
  /** `chain`'s pool withdraw run (started for `ready` under op id `id`); null while the chain has no run on this page.
   *  `claim` is awaited right before the run's first release leaves the device: it throws when the move may no longer
   *  send, and the run then ends stopped with nothing sent. */
  withdraw(chain: PoolChain): ((ready: PoolReady, id: string, claim: () => Promise<void>) => void) | null;
  /** An op record from the store's "ops". */
  op(id: string): Promise<{ stage?: unknown; txs?: readonly TxRef[] } | undefined>;
  /** The store's compare-and-set on an op record (WalletStore.update): `change` gets the stored record and gives the
   *  next one, or undefined to write nothing; resolves with what was written. */
  update(id: string, change: (rec: MoveOpRecord | undefined) => MoveOpRecord | undefined): Promise<unknown>;
  now(): number;
  wait?(ms: number): Promise<void>;
  signal?: AbortSignal;
  /** Cash's move into a pool (cashMover.move: `usdc` of Cash into `to` under op id `id`) and the vault withdraw's fee;
   *  none, and only pool to Cash is moved. */
  onward?: { move(to: PoolChain, usdc: bigint, id: string): Promise<Refusal | { op: string }>; fee(): Promise<bigint> };
  /** Pool to pool in one confidential swap: the Move host's checked quote of `amount` of `from`'s coin into `to`'s pool
   *  (its pool follow op written under `id`), the follow op read from the store, and `to`'s pool floor read now (null
   *  with no read). Given, every new pool-to-pool move goes this way and none through Cash. */
  direct?: {
    quote(from: PoolChain, to: PoolChain, amount: bigint, id: string): Promise<{ address: string; minOut: bigint } | Refusal>;
    follow(id: string): Promise<MoveFollow | undefined>;
    floor(to: PoolChain): Promise<bigint | null>;
  };
};

export type PoolToCash = {
  /** pool.move from `chain` to Cash (`to` "near") or on to pool `to`: answered once the run started (or refused). */
  move(chain: PoolChain, amount: bigint, id: string, to?: PoolChain | "near"): Promise<Refusal | { op: string }>;
  /** What that move would give: the run's sum, the least USDC shown, the Max fee, and `max`, what the pool can send now
   *  (each note's largest part after its fees, the withdraw form's Max); or, for an amount the plan cannot send, `limits`:
   *  `max` and the nearest amounts it can (`below`, `above`) or one withdrawal's least part (`min`) (card
   *  move-sends-what-it-shows). */
  dry(chain: PoolChain, amount: bigint, to?: PoolChain | "near"): Promise<Refusal | { sum: bigint; out: bigint; fee: bigint; max: bigint } | { limits: { max: bigint; min?: bigint; below?: bigint; above?: bigint } }>;
  /** Whether a move from a pool to pool `to` is one confidential swap (`direct` given), not through Cash. */
  direct(): boolean;
  /** The least USDC `amount` of `chain`'s pool coin brings (cashUsdcOf at the device's price); 0n with no price. */
  usdcOf(chain: PoolChain, amount: bigint): bigint;
  /** The least amount the plan sends exactly for which `ok` holds (`ok` true from some amount on), or the least amount
   *  for which it holds when the pool cannot send that much; null when none does. */
  least(chain: PoolChain, ok: (amount: bigint) => boolean): Promise<bigint | null>;
  /** After a reload: each move to Cash not ended follows its ops on from its stage. */
  resume(moves: readonly { id: string; rec: MoveOpRecord }[]): void;
  idle(): Promise<void>;
};

export function poolToCash(d: PoolToCashDeps): PoolToCash {
  const tracks: Promise<void>[] = [];
  // a stage written by compare-and-set: the claim kept, and never over a move another write ended failed (an expiry)
  const put = async (id: string, rec: MoveOpRecord): Promise<void> => {
    try {
      await d.update(id, (v) => (v?.stage === "failed" && rec.stage !== "failed" ? undefined : { ...rec, ...(v?.claimed_ms === undefined ? {} : { claimed_ms: v.claimed_ms }), ...(v?.send_by_ms === undefined || rec.send_by_ms !== undefined ? {} : { send_by_ms: v.send_by_ms }) }));
    } catch {
      /* a write that fails costs the display, never the move */
    }
  };
  // the run's claim, right before its first release leaves: refused (a throw) once the move ended or passed send_by_ms
  const claimOf = (id: string) => async (): Promise<void> => {
    const now = d.now();
    await d.update(id, (v) => {
      const c = claimed(v, now);
      return c === null || c === v ? undefined : c;
    });
    const r = (await d.op(id)) as MoveOpRecord | undefined;
    if (r?.claimed_ms === undefined || r.stage === "failed") throw new Error("the move may no longer send");
  };
  // the follow's bound: past send_by_ms with no claim, the move ends failed (true); a claim or an end first, false
  const expire = async (id: string, out: { stage?: unknown; txs?: readonly TxRef[] } | undefined): Promise<boolean> => {
    const now = d.now();
    const w = await d.update(id, (v) => expired(v, now, out) ?? undefined).catch(() => undefined);
    return w !== undefined;
  };
  const plan = async (chain: PoolChain, amount: bigint): Promise<Refusal | { sum: bigint; fee: bigint }> => {
    if (amount <= 0n || d.withdraw(chain) === null) return { error: "not_allowed" };
    const funds = await d.funds(chain);
    const c = checkPoolAmount(chain, formatUnits(amount, POOL_ASSET[chain].decimals), funds);
    if (!c.ok) return { error: c.code === "insufficient" ? "not_funded" : "not_allowed" };
    return { sum: c.amount, fee: c.maxFee };
  };
  const txsOf = (o: { txs?: readonly TxRef[] } | undefined): TxRef[] => (Array.isArray(o?.txs) ? o!.txs.filter((t) => typeof t?.hash === "string").map((t) => ({ chain: t.chain, hash: t.hash })) : []);
  const merge = (a: readonly TxRef[], b: readonly TxRef[]): TxRef[] => [...a, ...b.filter((t, k) => !a.some((x) => x.hash === t.hash) && b.findIndex((y) => y.hash === t.hash) === k)];
  // the run's stages, then the deposit op's, until the move is done or failed (or the sign out)
  const follow = async (op: string, from: MoveOpRecord): Promise<void> => {
    let cur = from;
    const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const set = async (stage: MoveStage, txs: readonly TxRef[]): Promise<void> => {
      const all = merge(cur.txs, txs);
      if (stage === cur.stage && all.length === cur.txs.length) return;
      cur = { ...cur, stage, txs: all };
      await put(op, cur);
    };
    while (!d.signal?.aborted) {
      const out = await d.op(`${op}/out`).catch(() => undefined);
      const dep = await d.op(`${op}/1click`).catch(() => undefined);
      const run = typeof out?.stage === "string" ? out.stage : null;
      const runTxs = txsOf(out);
      if (cur.stage === "leaving" && run === "stopped" && runTxs.length === 0) return set("failed", runTxs);
      if (cur.stage === "leaving" && (await expire(op, out))) return;
      const depStage = typeof dep?.stage === "string" ? (dep.stage as DepositStage) : null;
      if (depStage !== null && depStage !== "quote_checked" && depStage !== "waiting") {
        const stage = moveStageOfDeposit(depStage);
        if (stage === "done" && cur.to !== "near") return onward(op, cur, [...runTxs, ...txsOf(dep)]);
        await set(stage, [...runTxs, ...txsOf(dep)]);
        if (stage === "done" || stage === "failed") return;
      } else if (run === "sent" || run === "stopped") await set("in_transit", runTxs);
      await wait(CASH_MOVE_POLL_MS);
    }
  };
  // pool to pool, its money in the vault: Cash's move into `to` (once), then that move op's stages
  const onward = async (op: string, from: MoveOpRecord, txs: readonly TxRef[]): Promise<void> => {
    let cur: MoveOpRecord = { ...from, stage: "in_vault", txs: merge(from.txs, txs) };
    if (from.stage !== "in_vault" || cur.txs.length !== from.txs.length) await put(op, cur);
    const to = cur.to as PoolChain;
    const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    if ((await d.op(`${op}/on`).catch(() => undefined)) === undefined) {
      const cash = cur.cash === undefined ? null : BigInt(cur.cash);
      const fee = d.onward === undefined ? null : await d.onward.fee().catch(() => null);
      const sent = cash === null || fee === null || cash <= fee ? { error: "not_allowed" as const } : await d.onward!.move(to, cash - fee, `${op}/on`).catch((): Refusal => ({ error: "failed" }));
      if ("error" in sent) return put(op, { ...cur, stage: "failed" });
    }
    while (!d.signal?.aborted) {
      const on = await d.op(`${op}/on`).catch(() => undefined);
      const stage = typeof on?.stage === "string" ? (on.stage as MoveStage) : null;
      const next: MoveStage | null = stage === null || stage === "leaving" ? null : stage === "in_transit" ? "in_transit" : stage;
      const all = merge(cur.txs, txsOf(on));
      if (next !== null && (next !== cur.stage || all.length !== cur.txs.length)) {
        cur = { ...cur, stage: next, txs: all };
        await put(op, cur);
      }
      if (next === "done" || next === "failed") return;
      await wait(CASH_MOVE_POLL_MS);
    }
  };
  // pool to pool in one confidential swap: the run's stages, then the pool follow's, until done or failed (or the sign out)
  const followDirect = async (op: string, from: MoveOpRecord): Promise<void> => {
    let cur = from;
    const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const set = async (stage: MoveStage, txs: readonly TxRef[]): Promise<void> => {
      const all = merge(cur.txs, txs);
      if (stage === cur.stage && all.length === cur.txs.length) return;
      cur = { ...cur, stage, txs: all };
      await put(op, cur);
    };
    while (!d.signal?.aborted) {
      const out = await d.op(`${op}/out`).catch(() => undefined);
      const f = await d.direct!.follow(`${op}/pool`).catch(() => undefined);
      const run = typeof out?.stage === "string" ? out.stage : null;
      const txs = [...txsOf(out), ...txsOf(f)];
      if (cur.stage === "leaving" && run === "stopped" && txsOf(out).length === 0) return set("failed", txs);
      if (cur.stage === "leaving" && (await expire(op, out))) return;
      const fs = typeof f?.stage === "string" ? f.stage : null;
      if (fs !== null && fs !== "quote_checked" && fs !== "waiting") {
        const stage = moveStageOfFollow(f!);
        await set(stage, txs);
        if (stage === "done" || stage === "failed") return;
      } else if (run === "sent" || run === "stopped") await set("in_transit", txs);
      await wait(CASH_MOVE_POLL_MS);
    }
  };
  // the move's record, leaving with its send_by_ms, written before its quote is asked: from the tap on, the app follows
  // an op that ends, never a request with nothing behind it
  const begin = async (chain: PoolChain, to: PoolChain | "near", sum: bigint, id: string): Promise<MoveOpRecord> => {
    const now = d.now();
    const rec: MoveOpRecord = { kind: "move", from: chain, to, stage: "leaving", txs: [], amount: formatUnits(sum, POOL_ASSET[chain].decimals), created_ms: now, send_by_ms: now + MOVE_SEND_MS };
    await put(id, rec);
    return rec;
  };
  // a quote not answered by the move's send_by_ms is down: the move fails, nothing is paid to an address it never had
  const bounded = <T,>(rec: MoveOpRecord, q: Promise<T>): Promise<T | Refusal> => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Refusal>((r) => (t = setTimeout(() => r({ error: "down" }), Math.max(0, rec.send_by_ms! - d.now()))));
    return Promise.race([q, late]).finally(() => clearTimeout(t));
  };
  const sendDirect = async (chain: PoolChain, to: PoolChain, p: { sum: bigint; fee: bigint }, id: string): Promise<Refusal | { op: string }> => {
    const rec = await begin(chain, to, p.sum, id);
    const q = await bounded(rec, d.direct!.quote(chain, to, p.sum, `${id}/pool`));
    if ("error" in q || !d.onChain(chain, q.address)) {
      const error = "error" in q ? q.error : "quote_check_failed";
      await put(id, { ...rec, stage: "failed", error });
      return { error };
    }
    const leaving: MoveOpRecord = { ...rec, out: formatUnits(q.minOut, POOL_ASSET[to].decimals) };
    await put(id, leaving);
    const run = d.withdraw(chain);
    if (run === null) {
      await put(id, { ...leaving, stage: "failed" });
      return { error: "not_allowed" };
    }
    run({ chain, to: q.address, amount: p.sum, maxFee: p.fee }, `${id}/out`, claimOf(id));
    tracks.push(followDirect(id, leaving).catch(() => {}));
    return { op: id };
  };
  const leastOf = async (chain: PoolChain, ok: (amount: bigint) => boolean, funds?: PoolFunds): Promise<bigint | null> => {
    const fs = funds ?? (await d.funds(chain));
    const t = leastWhere(ok);
    if (t === null) return null;
    // the amount the plan sends at or above t: the plan's own sum, the nearest above, or the least part
    let x = t;
    for (let k = 0; k < 4; k++) {
      const c = checkPoolAmount(chain, formatUnits(x, POOL_ASSET[chain].decimals), fs);
      if (c.ok) return c.amount;
      if (c.code === "min" && c.min !== undefined && c.min > x) x = c.min;
      else if (c.code === "unplannable" && c.above !== undefined) x = c.above;
      else return x;
    }
    return x;
  };
  return {
    direct: () => d.direct !== undefined,
    move: async (chain, amount, id, to = "near") => {
      try {
        const p = await plan(chain, amount);
        if ("error" in p) return p;
        if (to === chain || (to !== "near" && d.onward === undefined && d.direct === undefined)) return { error: "not_allowed" };
        if (to !== "near" && d.direct !== undefined) return await sendDirect(chain, to, p, id);
        const rec = await begin(chain, to, p.sum, id);
        const q = await bounded(rec, d.quote(chain, p.sum, `${id}/1click`));
        if ("error" in q || !d.onChain(chain, q.address)) {
          const error = "error" in q ? q.error : "quote_check_failed";
          await put(id, { ...rec, stage: "failed", error });
          return { error };
        }
        const pr = d.price(chain);
        // to Cash: the least USDC shown; on to a pool: the quote's least USDC kept for the onward move (its `cash`)
        const leaving: MoveOpRecord = to !== "near" ? { ...rec, cash: q.minOut.toString() } : pr === null ? rec : { ...rec, out: formatUnits(cashUsdcOf(p.sum, pr, chain), 6) };
        await put(id, leaving);
        const run = d.withdraw(chain);
        if (run === null) {
          await put(id, { ...leaving, stage: "failed" });
          return { error: "not_allowed" };
        }
        run({ chain, to: q.address, amount: p.sum, maxFee: p.fee }, `${id}/out`, claimOf(id));
        tracks.push(follow(id, leaving).catch(() => {}));
        return { op: id };
      } catch {
        return { error: "failed" };
      }
    },
    dry: async (chain, amount, to = "near") => {
      try {
        if (amount <= 0n || d.withdraw(chain) === null || to === chain) return { error: "not_allowed" };
        const direct = to !== "near" && d.direct !== undefined ? { to, d: d.direct } : null;
        // a price not read yet is a read not in yet: down (Busy, Retry), never not_allowed
        const pr = d.price(chain);
        const pt = direct === null ? null : d.price(direct.to);
        if (pr === null || (direct !== null && pt === null)) return { error: "down" };
        // the pool's funds read (its notes and the relayer's fee) that fails is a read not in yet too
        let funds: PoolFunds;
        try {
          funds = await d.funds(chain);
        } catch {
          return { error: "down" };
        }
        const max = poolSendable(funds);
        const c = checkPoolAmount(chain, formatUnits(amount, POOL_ASSET[chain].decimals), funds);
        if (!c.ok) {
          if (c.code === "insufficient") return { limits: { max } };
          if (c.code === "min") return { limits: { max, ...(c.min === undefined ? {} : { min: c.min }) } };
          if (c.code === "unplannable") return { limits: { max, ...(c.below === undefined ? {} : { below: c.below }), ...(c.above === undefined ? {} : { above: c.above }) } };
          if (c.code === "unread") return { error: "down" };
          return { error: "not_allowed" };
        }
        if (direct !== null) {
          // one confidential swap: the least of `to`'s coin at the device's prices, held to `to`'s pool floor read now
          const floor = await direct.d.floor(direct.to).catch(() => null);
          if (floor === null) return { error: "down" };
          const out = (x: bigint) => coinOf(x, chain, pr, direct.to, pt!);
          if (out(c.amount) < floor) return { limits: { max, ...(await leastOf(chain, (x) => out(x) >= floor, funds).then((m) => (m === null ? {} : { min: m }))) } };
          return { sum: c.amount, out: out(c.amount), fee: c.maxFee, max };
        }
        return { sum: c.amount, out: cashUsdcOf(c.amount, pr, chain), fee: c.maxFee, max };
      } catch {
        return { error: "failed" };
      }
    },
    usdcOf: (chain, amount) => {
      const pr = d.price(chain);
      return pr === null ? 0n : cashUsdcOf(amount, pr, chain);
    },
    least: (chain, ok) => leastOf(chain, ok),
    resume: (moves) => {
      for (const { id, rec } of moves)
        if (rec.kind === "move" && rec.from !== "near" && rec.stage !== "done" && rec.stage !== "failed")
          tracks.push((rec.to !== "near" && rec.cash === undefined && d.direct !== undefined ? followDirect(id, rec) : rec.to !== "near" && rec.stage !== "leaving" && rec.stage !== "in_transit" && rec.stage !== "refunded" ? onward(id, rec, []) : follow(id, rec)).catch(() => {}));
    },
    idle: async () => {
      await Promise.all(tracks);
    },
  };
}
