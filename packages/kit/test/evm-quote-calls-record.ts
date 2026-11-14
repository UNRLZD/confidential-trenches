// Records one device buy quote on Robinhood Chain mainnet call by call (card robinhood-quotes-inside-provider-limits):
// USDG at 4.5e15 wei on the native v4 0.01% pool (its reference search reads every pool of USDG's in the device's pool
// index), with the index served as the signing page serves it. Each JSON-RPC call is kept alone, its method and params
// with the provider's answer, so test/evm-quote-calls.test.ts answers it however the quote batches it; and the device's
// clock, the index and the quote's result. An answer is kept as the provider gave it, a result or an error. Reads only: no key, no transaction, no money moves.
//   node packages/kit/test/evm-quote-calls-record.ts [kept index, a v8-serialized Map of chain to the index data] [route]
// Without a kept index the pool index is synced from none, which takes minutes.
import { readFileSync, writeFileSync } from "node:fs";
import { deserialize } from "node:v8";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { evmJsonRpc, evmPoolBuyQuoteWith, evmProviders, evmRanked, EvmQuoteError, type EvmPoolBuyQuoteRequest } from "../src/checks/evm/quote.ts";
import { evmPoolIndexRefresh } from "../src/trade/evm/buy-tap.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ZERO = "0x0000000000000000000000000000000000000000";
export const CALLS_REQUEST: EvmPoolBuyQuoteRequest = {
  chain: "robinhood",
  token: USDG,
  amountIn: 45n * 10n ** 14n,
  slippageBps: 300,
  route: { venue: "uniswap-v4", currencyIn: ZERO, hops: [{ currency: USDG.toLowerCase(), fee: 100, tickSpacing: 1, hooks: ZERO, hookData: "0x" }] },
};
/** A call's key: its method and params, never its id. */
export const callKey = (c: { method: unknown; params?: unknown }): string => JSON.stringify([c.method, c.params ?? []]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const v = evmPoolVenues().robinhood;
  const kept = process.argv[2] === undefined ? null : (deserialize(readFileSync(process.argv[2])) as Map<string, unknown>).get("robinhood") ?? null;
  const ix = await evmPoolIndexRefresh("robinhood", kept as never);
  if (!ix.served || ix.sync?.index == null || ix.sync.pools == null) throw new Error("the pool index was not served");
  const answers = new Map<string, unknown>();
  // a call one provider answered otherwise than the first (a head at "latest", a block another does not hold yet): that
  // provider's own answer, by its host
  const own = new Map<string, unknown>();
  const recording: typeof fetch = async (url, init) => {
    const r = await fetch(url, init);
    const text = await r.text();
    if (r.status === 200) {
      try {
        const sent = JSON.parse(String(init?.body));
        const got = JSON.parse(text);
        const byId = new Map((Array.isArray(got) ? got : [got]).map((a: { id: unknown }) => [a.id, a]));
        for (const c of Array.isArray(sent) ? sent : [sent]) {
          const a = byId.get(c.id) as Record<string, unknown> | undefined;
          // the first answer a call had is the one kept, and each other provider's first that differs, a result or a
          // revert; an error naming a rate limit or a block or state the provider does not hold is never kept
          if (a === undefined || (a.error !== undefined && /rate|limit|too many|not found|unknown block|header|missing trie|archive/i.test(JSON.stringify(a.error)))) continue;
          const kept = a.error === undefined ? { result: a.result } : { error: a.error };
          const k = callKey(c);
          const host = new URL(String(url)).host;
          if (!answers.has(k)) answers.set(k, kept);
          else if (JSON.stringify(answers.get(k)) !== JSON.stringify(kept) && !own.has(`${host} ${k}`)) own.set(`${host} ${k}`, kept);
        }
      } catch {
        // an answer that is not JSON is not kept
      }
    }
    return new Response(text, { status: r.status, headers: r.headers });
  };
  // the route the device's own best was at the last run (its printed reference), where given: a recording is one quote
  // in a fresh process, so its scans and reads are a cold quote's, as the replay's are
  const req: EvmPoolBuyQuoteRequest = process.argv[3] === undefined ? CALLS_REQUEST : { ...CALLS_REQUEST, route: JSON.parse(process.argv[3]) };
  const scans = [v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => evmJsonRpc(u, recording, 16 << 20));
  const now = Date.now();
  let outcome: Record<string, unknown>;
  try {
    const q = await evmPoolBuyQuoteWith(req, evmProviders(evmRanked(v.providers!), recording), now, scans);
    outcome = { code: "ok", amountOut: q.amountOut.toString(), minOut: q.minOut.toString(), route: q.route, block: { number: q.block.number.toString(), hash: q.block.hash }, reference: q.reference === null ? null : { route: q.reference.route, amountOut: q.reference.amountOut.toString() } };
  } catch (e) {
    if (!(e instanceof EvmQuoteError)) throw e;
    outcome = { code: e.code, message: e.message, reference: e.reference === null ? null : { route: e.reference.route, amountOut: e.reference.amountOut.toString() } };
  }
  console.log("outcome", JSON.stringify(outcome), "calls", answers.size);
  const s = ix.sync;
  const out = {
    recorded: new Date().toISOString(),
    // the request's token is kept as "buys": gitleaks' generic-api-key rule reads a "token" key with a hex value as a secret
    request: { ...req, token: undefined, buys: req.token, amountIn: req.amountIn.toString() },
    now,
    index: { chainId: s.index!.chainId, poolManager: s.index!.poolManager, from: s.index!.from, coversThrough: s.coversThrough, pools: s.pools!.map((p) => [p.key.currency0, p.key.currency1, p.key.fee, p.key.tickSpacing, p.key.hooks]) },
    outcome,
    calls: [...answers],
    own: [...own],
  };
  writeFileSync(fileURLToPath(new URL("./fixtures/evm-quote-calls.json.gz", import.meta.url)), gzipSync(JSON.stringify(out), { level: 9 }));
}
