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
// Nothing here logs.
import { base58 } from "@scure/base";
import { EVM_ADDRESS } from "./rules/pool.ts";
import type { DepositStage, ErrorCode, MoveStage, PoolChain, PoolStatePrice, TxRef } from "../../kit/src/signpage/messages.ts";
import { checkPoolAmount, formatUnits, POOL_ASSET, type PoolFunds, type PoolReady } from "./withdraw/pool-form.ts";
import { CASH_MARGIN_BPS, CASH_MOVE_POLL_MS, type MoveOpRecord } from "./cash-to-pool.ts";

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
  quote(chain: PoolChain, amount: bigint, id: string): Promise<{ address: string } | Refusal>;
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
};

export type PoolToCash = {
  /** pool.move from `chain` to Cash: answered once the run started (or refused). */
  move(chain: PoolChain, amount: bigint, id: string): Promise<Refusal | { op: string }>;
  /** What that move would give: the run's sum, the least USDC shown, the Max fee. */
  dry(chain: PoolChain, amount: bigint): Promise<Refusal | { sum: bigint; out: bigint; fee: bigint }>;
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
        await set(stage, [...runTxs, ...txsOf(dep)]);
        if (stage === "done" || stage === "failed") return;
      } else if (run === "sent" || run === "stopped") await set("in_transit", runTxs);
      await wait(CASH_MOVE_POLL_MS);
    }
  };
  return {
    move: async (chain, amount, id) => {
      try {
        const p = await plan(chain, amount);
        if ("error" in p) return p;
        const rec: MoveOpRecord = { kind: "move", from: chain, to: "near", stage: "leaving", txs: [], amount: formatUnits(p.sum, POOL_ASSET[chain].decimals), created_ms: d.now() };
        const q = await d.quote(chain, p.sum, `${id}/1click`);
        if ("error" in q || !d.onChain(chain, q.address)) {
          await put(id, { ...rec, stage: "failed" });
          return { error: "error" in q ? q.error : "quote_check_failed" };
        }
        const pr = d.price(chain);
        const leaving: MoveOpRecord = pr === null ? rec : { ...rec, out: formatUnits(cashUsdcOf(p.sum, pr, chain), 6) };
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
        const p = await plan(chain, amount);
        if ("error" in p) return p;
        const pr = d.price(chain);
        if (pr === null) return { error: "not_allowed" };
        return { sum: p.sum, out: cashUsdcOf(p.sum, pr, chain), fee: p.fee };
      } catch {
        return { error: "failed" };
      }
    },
    resume: (moves) => {
      for (const { id, rec } of moves) if (rec.kind === "move" && rec.to === "near" && rec.from !== "near" && rec.stage !== "done" && rec.stage !== "failed") tracks.push(follow(id, rec).catch(() => {}));
    },
    idle: async () => {
      await Promise.all(tracks);
    },
  };
}
