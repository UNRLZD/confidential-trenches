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
// Nothing here logs.
import { base58 } from "@scure/base";
import { EVM_ADDRESS } from "./rules/pool.ts";
import type { DepositStage, ErrorCode, MoveStage, PoolChain, PoolStatePrice, TxRef } from "../../kit/src/signpage/messages.ts";
import { checkPoolAmount, formatUnits, POOL_ASSET, poolSendable, type PoolFunds, type PoolReady } from "./withdraw/pool-form.ts";
import { CASH_MARGIN_BPS, CASH_MOVE_POLL_MS, leastWhere, type MoveOpRecord } from "./cash-to-pool.ts";

type Refusal = { error: ErrorCode };

/** Whether `a` is an address of `chain`, as a deposit address there must be: a 32-byte base58 key on Solana, a 0x
 *  address on Base and Robinhood. */
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
  /** `chain`'s pool withdraw run (started for `ready` under op id `id`); null while the chain has no run on this page. */
  withdraw(chain: PoolChain): ((ready: PoolReady, id: string) => void) | null;
  /** An op record from the store's "ops". */
  op(id: string): Promise<{ stage?: unknown; txs?: readonly TxRef[] } | undefined>;
  put(id: string, rec: MoveOpRecord): Promise<void>;
  now(): number;
  wait?(ms: number): Promise<void>;
  signal?: AbortSignal;
  /** Cash's move into a pool (cashMover.move: `usdc` of Cash into `to` under op id `id`) and the vault withdraw's fee;
   *  none, and only pool to Cash is moved. */
  onward?: { move(to: PoolChain, usdc: bigint, id: string): Promise<Refusal | { op: string }>; fee(): Promise<bigint> };
};

export type PoolToCash = {
  /** pool.move from `chain` to Cash (`to` "near") or on to pool `to`: answered once the run started (or refused). */
  move(chain: PoolChain, amount: bigint, id: string, to?: PoolChain | "near"): Promise<Refusal | { op: string }>;
  /** What that move would give: the run's sum, the least USDC shown, the Max fee, and `max`, what the pool can send now
   *  (each note's largest part after its fees, the withdraw form's Max); or, for an amount the plan cannot send, `limits`:
   *  `max` and the nearest amounts it can (`below`, `above`) or one withdrawal's least part (`min`) (card
   *  move-sends-what-it-shows). */
  dry(chain: PoolChain, amount: bigint): Promise<Refusal | { sum: bigint; out: bigint; fee: bigint; max: bigint } | { limits: { max: bigint; min?: bigint; below?: bigint; above?: bigint } }>;
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
  const put = async (id: string, rec: MoveOpRecord): Promise<void> => {
    try {
      await d.put(id, rec);
    } catch {
      /* a write that fails costs the display, never the move */
    }
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
  return {
    move: async (chain, amount, id, to = "near") => {
      try {
        const p = await plan(chain, amount);
        if ("error" in p) return p;
        if (to === chain || (to !== "near" && d.onward === undefined)) return { error: "not_allowed" };
        const rec: MoveOpRecord = { kind: "move", from: chain, to, stage: "leaving", txs: [], amount: formatUnits(p.sum, POOL_ASSET[chain].decimals), created_ms: d.now() };
        const q = await d.quote(chain, p.sum, `${id}/1click`);
        if ("error" in q || !d.onChain(chain, q.address)) {
          await put(id, { ...rec, stage: "failed" });
          return { error: "error" in q ? q.error : "quote_check_failed" };
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
        run({ chain, to: q.address, amount: p.sum, maxFee: p.fee }, `${id}/out`);
        tracks.push(follow(id, leaving).catch(() => {}));
        return { op: id };
      } catch {
        return { error: "failed" };
      }
    },
    dry: async (chain, amount) => {
      try {
        if (amount <= 0n || d.withdraw(chain) === null) return { error: "not_allowed" };
        const pr = d.price(chain);
        if (pr === null) return { error: "not_allowed" };
        const funds = await d.funds(chain);
        const max = poolSendable(funds);
        const c = checkPoolAmount(chain, formatUnits(amount, POOL_ASSET[chain].decimals), funds);
        if (!c.ok) {
          if (c.code === "insufficient") return { limits: { max } };
          if (c.code === "min") return { limits: { max, ...(c.min === undefined ? {} : { min: c.min }) } };
          if (c.code === "unplannable") return { limits: { max, ...(c.below === undefined ? {} : { below: c.below }), ...(c.above === undefined ? {} : { above: c.above }) } };
          return { error: "not_allowed" };
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
    least: async (chain, ok) => {
      const funds = await d.funds(chain);
      const t = leastWhere(ok);
      if (t === null) return null;
      // the amount the plan sends at or above t: the plan's own sum, the nearest above, or the least part
      let x = t;
      for (let k = 0; k < 4; k++) {
        const c = checkPoolAmount(chain, formatUnits(x, POOL_ASSET[chain].decimals), funds);
        if (c.ok) return c.amount;
        if (c.code === "min" && c.min !== undefined && c.min > x) x = c.min;
        else if (c.code === "unplannable" && c.above !== undefined) x = c.above;
        else return x;
      }
      return x;
    },
    resume: (moves) => {
      for (const { id, rec } of moves)
        if (rec.kind === "move" && rec.from !== "near" && rec.stage !== "done" && rec.stage !== "failed")
          tracks.push((rec.to !== "near" && rec.stage !== "leaving" && rec.stage !== "in_transit" && rec.stage !== "refunded" ? onward(id, rec, []) : follow(id, rec)).catch(() => {}));
    },
    idle: async () => {
      await Promise.all(tracks);
    },
  };
}
