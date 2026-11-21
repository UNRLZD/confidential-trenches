// The recorded USDG quote and a follow of it at its block (card evm-cold-multihop-quote-inside-the-kpi), for
// evm-quote-follow.test.ts and evm-quote-follow-reorg.test.ts: each runs it once, in its own file, since the recorded
// quote replays only from a cold module (no scans, warm plans or read sizes another test's quote left).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as Q from "../src/checks/evm/quote.ts";
import { evmJsonRpc, evmPoolBuyQuoteWith, evmPoolIndexReset, evmPoolIndexUse, evmProviders, evmRanked, evmSpeedReset, type EvmHeadWatch, type EvmPoolBuyQuoteRequest } from "../src/checks/evm/quote.ts";
// read through the module so the test runs, and fails on its assertions, where they are not (main)
const evmAgreedReset = (): void => (Q as { evmAgreedReset?: () => void }).evmAgreedReset?.();
const evmQuoteWarmReset = (): void => (Q as { evmQuoteWarmReset?: () => void }).evmQuoteWarmReset?.();
import { evmPaceReset } from "../src/checks/evm/pace.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { callKey, withEventOnly } from "./evm-quote-calls-record.ts";

const F = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/evm-quote-calls.json.gz", import.meta.url))).toString("utf8"));
const POST_MS = 200;
/** The recording's answers, each POST answered POST_MS of the test clock after it is sent; posts counted per host. */
/** `hang`: the first post whose one call it names is never answered, and ends at its signal (the provider's timeout). */
const replay = (lie?: (k: string, a: unknown) => unknown, hang?: (k: string) => boolean) => {
  const answers = new Map<string, unknown>(withEventOnly(F.calls));
  const methods = new Map<string, number>();
  const own = new Map<string, unknown>(F.own);
  const missed: string[] = [];
  const sent = new Map<string, number>();
  let posts = 0;
  let hung = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    sent.set(host, (sent.get(host) ?? 0) + 1);
    posts++;
    const body = JSON.parse(String(init?.body));
    const only = Array.isArray(body) ? (body.length === 1 ? body[0] : undefined) : body;
    if (hang !== undefined && only !== undefined && hang(callKey(only))) {
      hang = undefined;
      hung++;
      const signal = init?.signal;
      await new Promise((_, no) => signal?.addEventListener("abort", () => no(signal.reason)));
    }
    await new Promise((go) => setTimeout(go, POST_MS));
    const one = (c: { id: unknown; method: string; params: unknown }) => {
      methods.set(c.method, (methods.get(c.method) ?? 0) + 1);
      const k = callKey(c);
      if (own.has(`${host} ${k}`)) return { jsonrpc: "2.0", id: c.id, ...(own.get(`${host} ${k}`) as object) };
      if (!answers.has(k)) {
        missed.push(k.slice(0, 120));
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
      }
      return { jsonrpc: "2.0", id: c.id, ...((lie?.(k, answers.get(k)) ?? answers.get(k)) as object) };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, missed, sent, methods, posts: () => posts, hung: () => hung };
};

/** The recorded quote, then the device's watch holding its block: `follow()` asks it again at that block;
 *  `lie` rewrites the by-number answer of that block, `headHeld`: the watch hands it back as its fresh head; `hangPin`:
 *  the follow's first ask of that block by number hangs to its provider's timeout. */
export async function firstThenFollow(lie?: (k: string, a: unknown) => unknown, headHeld = false, hangPin = false) {
  evmSpeedReset();
  evmPaceReset();
  evmPoolIndexReset();
  evmAgreedReset();
  evmQuoteWarmReset();
  const ix = F.index;
  evmPoolIndexUse("robinhood", {
    index: { chainId: ix.chainId, poolManager: ix.poolManager, from: ix.from },
    coversThrough: ix.coversThrough,
    pools: ix.pools.map(([currency0, currency1, fee, tickSpacing, hooks]: [string, string, number, number, string]) => ({ key: { currency0, currency1, fee, tickSpacing, hooks } })),
  });
  const v = evmPoolVenues().robinhood;
  const { buys, ...rest } = F.request;
  const req: EvmPoolBuyQuoteRequest = { ...rest, token: buys, amountIn: BigInt(F.request.amountIn) };
  const scansOf = (r: ReturnType<typeof replay>) => [v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => evmJsonRpc(u, r.fetchFn, 16 << 20));
  const r1 = replay();
  const q1 = await evmPoolBuyQuoteWith(req, evmProviders(evmRanked(v.providers!), r1.fetchFn), F.now, scansOf(r1));
  assert.deepEqual(r1.missed, []);
  // the block as the device's head watch confirmed it: its header as the recording holds it
  const byNumber = callKey({ method: "eth_getBlockByNumber", params: ["0x" + q1.block.number.toString(16), false] });
  const head = (F.calls as [string, { result?: { baseFeePerGas?: string } }][]).find(([k]) => k === byNumber)?.[1].result;
  const block = { number: q1.block.number, hash: q1.block.hash, timestamp: q1.block.timestamp, baseFeePerGas: head?.baseFeePerGas === undefined ? null : BigInt(head.baseFeePerGas) };
  let heads = 0;
  const watch: EvmHeadWatch = {
    head: () => (heads++, headHeld ? Promise.resolve({ block, confirm: async () => {} }) : Promise.reject(new Error("a follow agrees on no new head"))),
    keep: () => {},
    peek: () => null,
    held: (h: string) => (h === block.hash ? block : null),
  };
  // the follow's own reads are the cold quote's (no warm plan of the first), so each is one the first agreed on
  evmQuoteWarmReset();
  const r2 = replay(lie === undefined ? undefined : (k, a) => (k === byNumber ? lie(k, a) : undefined), hangPin ? (k) => k === byNumber : undefined);
  const follow = () => evmPoolBuyQuoteWith({ ...req, at: q1.block.hash }, evmProviders(evmRanked(v.providers!), r2.fetchFn), F.now, scansOf(r2), watch);
  // the same request with no `at`, its watch's head the first quote's block (as a held head within EVM_HEAD_REUSE_MS)
  const plain = () => evmPoolBuyQuoteWith(req, evmProviders(evmRanked(v.providers!), r2.fetchFn), F.now, scansOf(r2), watch);
  const scanHosts = new Set([v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => new URL(u).host));
  return { q1, r1, r2, follow, plain, heads: () => heads, scanHosts };
}

