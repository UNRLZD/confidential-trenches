// Records one buy tap (src/trade/evm/buy-tap.ts evmPoolBuyQuoteTap) on Base or Robinhood mainnet call by call, each kit
// quote on the pinned providers and scans with no pool index served (the page's tap passes none) and, with `served`, the
// helper's answer for the token's pools handed to the kit first as the page does (signpage src/evm-served.ts), so
// test/evm-buy-tap-names.test.ts replays it: each kit quote's JSON-RPC calls kept apart (the chain's head moves between
// two quotes of one tap), each call alone, its method and params with the provider's answer (a provider's own where it
// differs from the first), the device's clock, the routes the tap asked and each kit refusal. With `index`, the tap is
// handed the token's pools from the chain's pool index synced on its two index readers, as the mainnet check's tap is
// (card evm-buy-quotes-pass-on-helper-178), kept in the recording as `indexPools`; the kit's quote still scans with no
// index served. Reads only: no key, no transaction, no money moves.
//   node packages/kit/test/evm-tap-record.ts <base|robinhood> <token> <fixture name> [served|index]
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { evmJsonRpc, evmPoolBuyQuoteWith, evmPoolIndexPools, evmPoolIndexReset, evmPoolServedUse, evmProviders, evmRanked, evmSpeedReset } from "../src/checks/evm/quote.ts";
import { evmPaceReset } from "../src/checks/evm/pace.ts";
import { evmBuyTapReset, evmPoolBuyQuoteTap, evmPoolIndexRefresh } from "../src/trade/evm/buy-tap.ts";
import { evmPoolVenues, type EvmPoolChain } from "../src/trade/evm/buy-unpinned.ts";
import { callKey } from "./evm-quote-calls-record.ts";

/** The tap's amount: the mainnet check's (scripts/live-checks/evm-buy-and-sell-on-mainnet.mjs QUOTE_AMOUNT). */
export const TAP_AMOUNT = 980_000_000_000_000n;

const POST_MS = 200;

const fixture = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/${name}.json.gz`, import.meta.url))).toString("utf8"));

// each kit quote of the tap answered from its own recorded calls (the chain's head moved between the two)
const replayed = (F: { quotes: { calls: [string, unknown][]; own: [string, unknown][] }[] }) => {
  const quotes = F.quotes.map((q) => ({ answers: new Map<string, unknown>(q.calls), own: new Map<string, unknown>(q.own) }));
  const missed: string[] = [];
  let at = -1;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    const { answers, own } = quotes[at] ?? { answers: new Map(), own: new Map() };
    await new Promise((go) => setTimeout(go, POST_MS));
    const body = JSON.parse(String(init?.body));
    const one = (c: { id: unknown; method: string; params: unknown }) => {
      const k = callKey(c);
      if (own.has(`${host} ${k}`)) return { jsonrpc: "2.0", id: c.id, ...(own.get(`${host} ${k}`) as object) };
      if (!answers.has(k)) {
        missed.push(k.slice(0, 120));
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
      }
      return { jsonrpc: "2.0", id: c.id, ...(answers.get(k) as object) };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, missed, next: () => void at++ };
};

/** Replays the recorded tap `name` (test/fixtures/<name>.json.gz) call by call through the tap and the kit's quote,
 *  each post answered POST_MS of the clock after it is sent: its end, the calls not in the recording, the recording. Run
 *  it on the test clock (test/test-clock.ts), one recording of a chain and token a process: the kit's scan of a token is
 *  kept for the module's life, so a second replay of the same token tops up from the first's head. `quotes`: the kit
 *  quotes the tap asked. */
export const replayTap = async (name: string): Promise<{ end: unknown; missed: string[]; F: ReturnType<typeof fixture>; quotes: number }> => {
  evmSpeedReset();
  evmPaceReset();
  evmPoolIndexReset();
  evmBuyTapReset();
  const F = fixture(name);
  const chain = F.chain as EvmPoolChain;
  const v = evmPoolVenues()[chain]!;
  const r = replayed(F);
  let quotes = 0;
  if (F.served !== undefined) evmPoolServedUse(chain, F.buys, Promise.resolve(F.served));
  const scans = [v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => evmJsonRpc(u, r.fetchFn, 16 << 20));
  const end = await evmPoolBuyQuoteTap(
    { chain, token: F.buys, amountIn: BigInt(F.amountIn), slippageBps: 300 },
    { indexPools: () => F.indexPools ?? null, quote: (req) => (quotes++, r.next(), evmPoolBuyQuoteWith(req, evmProviders(evmRanked(v.providers!), r.fetchFn), F.now, scans)) },
  ).catch((e: unknown) => e);
  return { end, missed: r.missed, F, quotes };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [chain, token, name, serve] = process.argv.slice(2) as [EvmPoolChain, string, string, string | undefined];
  // the page's ask (signpage src/evm-served.ts): the helper's pools of the token
  const served = serve === "served" ? await fetch(`https://ct-api.unrealized.trade/v1/market/pools?chain=${chain}&token=${token.toLowerCase()}`).then((r) => (r.ok ? r.json() : null)) : undefined;
  if (served !== undefined) evmPoolServedUse(chain, token, Promise.resolve(served));
  // the token's pools in the chain's index, then the index forgotten: the kit's quote scans as with none served
  let indexPools: unknown;
  if (serve === "index") {
    if (!(await evmPoolIndexRefresh(chain, null)).served) throw new Error(`${chain}'s pool index was not served`);
    indexPools = evmPoolIndexPools(chain, token);
    evmPoolIndexReset();
  }
  const v = evmPoolVenues()[chain]!;
  const quotes: { answers: Map<string, unknown>; own: Map<string, unknown> }[] = [];
  const recording: typeof fetch = async (url, init) => {
    const r = await fetch(url, init);
    const text = await r.text();
    if (r.status === 200) {
      try {
        const sent = JSON.parse(String(init?.body));
        const got = JSON.parse(text);
        const { answers, own } = quotes.at(-1)!;
        const byId = new Map((Array.isArray(got) ? got : [got]).map((a: { id: unknown }) => [a.id, a]));
        for (const c of Array.isArray(sent) ? sent : [sent]) {
          const a = byId.get(c.id) as Record<string, unknown> | undefined;
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
  const scans = [v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => evmJsonRpc(u, recording, 16 << 20));
  const now = Date.now();
  const asked: unknown[] = [];
  let outcome: Record<string, unknown>;
  try {
    const q = await evmPoolBuyQuoteTap({ chain, token, amountIn: TAP_AMOUNT, slippageBps: 300 }, {
      indexPools: () => (indexPools ?? null) as ReturnType<typeof evmPoolIndexPools>,
      quote: async (req) => {
        quotes.push({ answers: new Map(), own: new Map() });
        try {
          return await evmPoolBuyQuoteWith(req, evmProviders(evmRanked(v.providers!), recording), now, scans);
        } catch (e) {
          const x = e as { code?: string; message?: string; reference?: { route: unknown; amountOut: bigint } | null };
          asked.push({ route: req.route, code: x.code, message: x.message, reference: x.reference == null ? null : { route: x.reference.route, amountOut: x.reference.amountOut.toString() } });
          throw e;
        }
      },
    });
    outcome = { code: "ok", route: q.route, amountOut: q.amountOut.toString() };
  } catch (e) {
    outcome = { code: (e as { code?: string }).code, message: String((e as Error).message) };
  }
  console.log("outcome", JSON.stringify(outcome), "asked", JSON.stringify(asked), "calls", quotes.map((q) => `${q.answers.size}+${q.own.size}`).join(" "));
  const out = { recorded: new Date().toISOString(), chain, buys: token, amountIn: TAP_AMOUNT.toString(), now, ...(served === undefined ? {} : { served }), ...(indexPools === undefined ? {} : { indexPools }), asked, outcome, quotes: quotes.map((q) => ({ calls: [...q.answers], own: [...q.own] })) };
  writeFileSync(fileURLToPath(new URL(`./fixtures/${name}.json.gz`, import.meta.url)), gzipSync(JSON.stringify(out), { level: 9 }));
}
