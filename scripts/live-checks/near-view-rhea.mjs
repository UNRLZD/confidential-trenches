#!/usr/bin/env node
// Live check of card near-view-rhea: the kit's Rhea classic quote (packages/kit/src/near/rhea.ts, rheaQuote) equals the
// exchange's own `get_return` view on mainnet, to the unit, at the block the quote read. The quote is of a fixed small
// amount, 1 USDC into wrapped NEAR on pool 4512 (USDC and wrap.near, a simple pool), read from the network's two
// providers at one pinned block; get_return is then asked of both providers at that same block. A quote that drops the
// pool's fee, rounds the other way or reads another block differs from get_return, and the check fails. Reads only.
// Every read goes through scripts/live-checks/provider-answer.mjs rpcAnswer: a provider that answers nothing usable is
// its no-answer, never a wrong answer. A no-answer while the quote is made, or on either get_return read, is
// INCONCLUSIVE (exit 3), never PASS.
// After: app
// Bundle: out mainnet NEAR RPC reads of the Rhea pool and get_return on the two providers, never the build
//   node scripts/live-checks/near-view-rhea.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rheaQuote } from "../../packages/kit/src/index.ts";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "near-view-rhea";
/** The mainnet pair the kit accepts (packages/kit/src/near/networks.ts): one FastNEAR URL and dRPC. */
export const RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
export const EXCHANGE = "v2.ref-finance.near";
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const WRAP = "wrap.near";
export const POOL = 4512;
export const AMOUNT = 1_000_000n;

/** A provider's no-answer (provider-answer.mjs), thrown out of the kit's quote: the run is INCONCLUSIVE. */
export class NoAnswer extends Error {}

/** The kit's provider shape on rpcAnswer: `{ result }` or `{ error }` as the JSON-RPC answer holds them. Each no-answer
 *  is kept in `quiet`, since the kit's quote wraps what a provider throws in its own refusal. */
function provider(url, fetchFn, quiet) {
  return {
    name: url,
    async query(params) {
      const a = await rpcAnswer(url, "query", params, { fetchFn });
      if (a.noAnswer !== undefined) {
        quiet.push(a.noAnswer);
        throw new NoAnswer(a.noAnswer);
      }
      return a.error !== undefined ? { error: a.error } : { result: a.result };
    },
  };
}

/** The quote's facts and get_return's answer on both providers at the quote's block. */
export async function read(fetchFn = fetch) {
  const quiet = [];
  const rpcs = RPCS.map((u) => provider(u, fetchFn, quiet));
  let q;
  try {
    q = await rheaQuote({ network: "mainnet", rpcs, side: "buy", token: WRAP, amountIn: AMOUNT, pools: [POOL] });
  } catch (e) {
    // a quote refused because a provider gave no answer is that provider's moment, not the kit's
    if (quiet.length > 0) throw new NoAnswer(quiet.join("; "));
    throw e;
  }
  const args = Buffer.from(JSON.stringify({ pool_id: POOL, token_in: USDC, amount_in: String(AMOUNT), token_out: WRAP })).toString("base64");
  const getReturn = await Promise.all(
    rpcs.map(async (r) => {
      let a;
      try {
        a = await r.query({ request_type: "call_function", account_id: EXCHANGE, method_name: "get_return", args_base64: args, block_id: q.height });
      } catch (e) {
        if (e instanceof NoAnswer) return { provider: r.name, noAnswer: e.message };
        throw e;
      }
      const res = a?.result;
      return { provider: r.name, height: res?.block_height, hash: res?.block_hash, value: Array.isArray(res?.result) ? JSON.parse(Buffer.from(res.result).toString()) : null, error: res?.error ?? a?.error ?? null };
    }),
  );
  return { height: q.height, blockHash: q.blockHash, hops: q.hops.map((h) => ({ pool: h.pool, tokenIn: h.tokenIn, tokenOut: h.tokenOut, amountIn: String(h.amountIn), amountOut: String(h.amountOut), feeBps: h.feeBps })), amountOut: String(q.amountOut), getReturn };
}

/** The verdict on an answer. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const hop = a?.hops?.[0];
  if (!Array.isArray(a?.hops) || a.hops.length !== 1 || hop?.pool !== POOL || hop.tokenIn !== USDC || hop.tokenOut !== WRAP || hop.amountIn !== String(AMOUNT)) bad(`the quote is not ${AMOUNT} USDC into ${WRAP} on pool ${POOL} in one hop`);
  const quiet = [];
  if (!Array.isArray(a?.getReturn) || a.getReturn.length !== 2) bad("get_return was not read on both providers");
  else
    for (const g of a.getReturn) {
      if (typeof g.noAnswer === "string") quiet.push(`--  ${g.noAnswer}: INCONCLUSIVE`);
      else if (g.height !== a.height || g.hash !== a.blockHash) bad(`${g.provider}: get_return not read at the quote's block ${a.height}`);
      else if (typeof g.value !== "string") bad(`${g.provider}: get_return gave no amount (${JSON.stringify(g.error)})`);
      else if (g.value !== a.amountOut) bad(`${g.provider}: get_return is ${g.value}, the kit's quote ${a.amountOut}`);
    }
  const verdict = verdictOf(lines.length > 0, quiet.length > 0);
  if (verdict === "PASS") lines.push(`ok: ${AMOUNT} USDC on pool ${POOL} at block ${a.height}: the kit ${a.amountOut}, get_return ${a.getReturn[0].value} on both providers`);
  lines.push(...quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer, null, 2)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.verdict} ${KEY}`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    if (e instanceof NoAnswer) {
      console.log(`--  ${e.message}: INCONCLUSIVE`);
      console.log(`INCONCLUSIVE ${KEY}`);
      process.exit(EXIT.INCONCLUSIVE);
    }
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
