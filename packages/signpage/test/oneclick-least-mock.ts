// 1Click as the least read meets it (card cash-to-pool-least-signed), behind the helper's proxy: an amount under its
// least answers 400 "Amount is too low for bridge, try at least N", an amount at or above it a dry quote signed by the
// mock's key (./oneclick-mock.ts, which this process alone trusts through a load hook), priced at the test's price
// less 1Click's fee. `helper` stands where a lying helper does: it gets each request and 1Click's answer and gives
// what the device reads. Import this file before anything that loads the kit's 1Click check, and that with
// await import().
/// <reference types="node" />
import type { KeyObject } from "node:crypto";
import { COLLECTOR, mockKey, signAnswer, type Answer } from "./oneclick-mock.ts";

export { mockKey, otherKey, signAnswer, type Answer } from "./oneclick-mock.ts";

/** The read's clock: a still one, so every quote the tests check is checked at this time. */
export const LEAST_NOW = Date.parse("2026-11-18T23:04:42.000Z");
export const SOL_PRICE = Object.freeze({ price: "8000000000", expo: -8 }); // SOL at 80 USD
export const ETH_PRICE = Object.freeze({ price: "300000000000", expo: -8 }); // ETH at 3,000 USD
const DECIMALS_OUT: Readonly<Record<string, number>> = { "nep141:sol.omft.near": 9, "nep141:base.omft.near": 18, "nep141:hood.omft.near": 18 };

export type Req = Record<string, unknown> & { amount: string; destinationAsset: string };
export type Reply = { status: number; body: unknown };

/** A decimal of `x` base units at `d` decimals, no trailing zero (1Click's ...Formatted). */
export function formatted(x: bigint, d: number): string {
  const t = x.toString().padStart(d + 1, "0");
  const f = t.slice(t.length - d).replace(/0+$/, "");
  return f ? `${t.slice(0, t.length - d)}.${f}` : t.slice(0, t.length - d);
}

/** 1Click's dry answer to `req` at `price` (the pool coin's), its withdraw fee `withdrawFee` in the coin's base units,
 *  signed by `key` (none: left unsigned). */
export function dryAnswer(req: Req, price: { price: string; expo: number }, o: { withdrawFee?: bigint; key?: KeyObject | null; at?: number } = {}): Answer {
  const dOut = DECIMALS_OUT[req.destinationAsset]!;
  const a = BigInt(req.amount);
  const raw = (a * 10n ** BigInt(dOut) * 10n ** BigInt(-price.expo)) / (BigInt(price.price) * 10n ** 6n);
  const wf = o.withdrawFee ?? 0n;
  const kept = (raw * 998n) / 1000n - wf;
  const out = kept > 0n ? kept : 1n;
  const min = (out * 995n) / 1000n;
  const answer: Answer = {
    quote: {
      amountIn: req.amount, amountInFormatted: formatted(a, 6), amountInUsd: formatted(a, 6), minAmountIn: req.amount,
      amountOut: out.toString(), amountOutFormatted: formatted(out, dOut), amountOutUsd: "0.07", minAmountOut: min.toString(),
      withdrawFee: wf.toString(), timeEstimate: 10,
    },
    quoteRequest: { ...req, depositMode: "SIMPLE", confidentiality: "public", quoteWaitingTimeMs: 0, appFees: [{ recipient: COLLECTOR, fee: 20 }] },
    signature: "",
    timestamp: new Date(o.at ?? LEAST_NOW - 500).toISOString(),
    correlationId: "00000000-0000-4000-8000-000000000000",
  };
  if (o.key !== null) signAnswer(answer, o.key ?? mockKey.privateKey);
  return answer;
}

export const tooLow = (n: bigint | string): Reply => ({ status: 400, body: { message: `Amount is too low for bridge, try at least ${n}`, correlationId: "00000000-0000-0000-0000-000000000000", path: "/v0/quote" } });
export const said = (m: string, status = 400): Reply => ({ status, body: { message: m, path: "/v0/quote" } });

/** 1Click with least `least` at `price`, behind `helper` (none: an honest one); every amount asked, in order. */
export function least1Click(least: bigint, price: { price: string; expo: number }, o: { withdrawFee?: bigint; helper?: (req: Req, reply: Reply, n: number) => Reply } = {}) {
  const asked: string[] = [];
  const fetchFn = (async (_u: unknown, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as Req;
    asked.push(req.amount);
    const honest: Reply = BigInt(req.amount) < least ? tooLow(least) : { status: 201, body: dryAnswer(req, price, { withdrawFee: o.withdrawFee }) };
    const r = o.helper ? o.helper(req, honest, asked.length) : honest;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}
