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
import { evmGasPacking, evmJsonRpc, evmPoolBuyQuoteWith, evmPoolIndexPools, evmPoolIndexReset, evmPoolServedUse, evmProviders, evmRanked, evmSpeedReset } from "../src/checks/evm/quote.ts";
import { evmPaceReset } from "../src/checks/evm/pace.ts";
import { evmBuyTapReset, evmPoolBuyQuoteTap, evmPoolIndexRefresh } from "../src/trade/evm/buy-tap.ts";
import { evmPoolVenues, type EvmPoolChain } from "../src/trade/evm/buy-unpinned.ts";
import { callKey, hookSpeculation, withEventOnly } from "./evm-quote-calls-record.ts";

/** The tap's amount: the mainnet check's (scripts/live-checks/evm-buy-and-sell-on-mainnet.mjs QUOTE_AMOUNT). */
export const TAP_AMOUNT = 980_000_000_000_000n;

const POST_MS = 200;

const fixture = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/${name}.json.gz`, import.meta.url))).toString("utf8"));

// each kit quote of the tap answered from its own recorded calls (the chain's head moved between the two)
type Live = (url: string, at: number, call: { method: string; params: unknown }) => Promise<{ result: unknown } | undefined>;
const replayed = (F: { quotes: { calls: [string, unknown][]; own: [string, unknown][] }[] }, live?: Live) => {
  const quotes = F.quotes.map((q) => ({ answers: new Map<string, unknown>(withEventOnly(q.calls)), own: new Map<string, unknown>(q.own) }));
  // a read a quote speculates with a hook of the plan replaced, which a recording made before it never holds: a
  // provider's error, set apart (hookSpeculation); the plan's hooks are those any quote of the tap replaced
  const speculated = hookSpeculation(quotes.flatMap((q) => [...q.answers.keys()]));
  const spec: string[] = [];
  const missed: string[] = [];
  // each missed call whole, with its kit quote and host (`topup` below)
  const missedCalls: { at: number; host: string; url: string; call: { method: string; params: unknown } }[] = [];
  let at = -1;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    const { answers, own } = quotes[at] ?? { answers: new Map(), own: new Map() };
    await new Promise((go) => setTimeout(go, POST_MS));
    const body = JSON.parse(String(init?.body));
    const q = at;
    const one = async (c: { id: unknown; method: string; params: unknown }) => {
      const k = callKey(c);
      if (own.has(`${host} ${k}`)) return { jsonrpc: "2.0", id: c.id, ...(own.get(`${host} ${k}`) as object) };
      if (!answers.has(k) && speculated(c)) {
        spec.push(k.slice(0, 120));
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
      }
      // `topup`: a call the recording never held, read now as it is asked
      if (!answers.has(k) && live !== undefined) {
        const got = await live(String(url), q, { method: c.method, params: c.params });
        if (got !== undefined) answers.set(k, got);
      }
      if (!answers.has(k)) {
        missed.push(k.slice(0, 120));
        missedCalls.push({ at, host, url: String(url), call: { method: c.method, params: c.params } });
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
      }
      return { jsonrpc: "2.0", id: c.id, ...(answers.get(k) as object) };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, missed, missedCalls, spec, next: () => void at++ };
};

/** Replays the recorded tap `name` (test/fixtures/<name>.json.gz) call by call through the tap and the kit's quote,
 *  each post answered POST_MS of the clock after it is sent: its end, the calls not in the recording, the recording. Run
 *  it on the test clock (test/test-clock.ts), one recording of a chain and token a process: the kit's scan of a token is
 *  kept for the module's life, so a second replay of the same token tops up from the first's head. `quotes`: the kit
 *  quotes the tap asked. */
export const replayTap = async (name: string, F0?: ReturnType<typeof fixture>, live?: Live): Promise<{ end: unknown; missed: string[]; missedCalls: { at: number; host: string; url: string; call: { method: string; params: unknown } }[]; F: ReturnType<typeof fixture>; quotes: number }> => {
  evmSpeedReset();
  evmPaceReset();
  evmPoolIndexReset();
  evmBuyTapReset();
  // the taps were recorded before the kit packed measured reads by their gas (card
  // evm-warm-quote-inside-the-kpi-with-room), and their calls are matched call for call
  evmGasPacking(false);
  const F = F0 ?? fixture(name);
  const chain = F.chain as EvmPoolChain;
  const v = evmPoolVenues()[chain]!;
  const r = replayed(F, live);
  let quotes = 0;
  if (F.served !== undefined) evmPoolServedUse(chain, F.buys, Promise.resolve(F.served));
  const scans = [v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => evmJsonRpc(u, r.fetchFn, 16 << 20));
  const end = await evmPoolBuyQuoteTap(
    { chain, token: F.buys, amountIn: BigInt(F.amountIn), slippageBps: 300 },
    { indexPools: () => F.indexPools ?? null, quote: (req) => (quotes++, r.next(), evmPoolBuyQuoteWith(req, evmProviders(evmRanked(v.providers!), r.fetchFn), F.now, scans)) },
  ).catch((e: unknown) => e);
  return { end, missed: r.missed, missedCalls: r.missedCalls, F, quotes };
};

/** `topup <fixture name>` (card evm-scan-chain-tail): each call a replay of the recording asks that it never held, read
 *  on mainnet as the replay asks it, of the host it asks, and kept in that kit quote's calls, so the replay goes on as
 *  the kit would have (no call answered "not in the recording" and asked again as its halves). Only a call of past
 *  blocks is read (a getLogs of numbered blocks, a block by number): its answer is the chain's and never changes; any
 *  other refuses. Each range added is named in the recording's `toppedUp`. Reads only. */
const topup = async (name: string): Promise<void> => {
  const F = fixture(name);
  const added: { quote: number; host: string; method: string; from?: number; to?: number; block?: number }[] = F.toppedUp ?? [];
  const live: Live = async (url, at, call) => {
    const host = new URL(url).host;
    const p = (call.params as unknown[])[0] as { fromBlock?: unknown; toBlock?: unknown } | string;
    const past =
      call.method === "eth_getLogs" ? typeof p === "object" && /^0x[0-9a-f]+$/.test(String(p.fromBlock)) && /^0x[0-9a-f]+$/.test(String(p.toBlock)) : call.method === "eth_getBlockByNumber" && /^0x[0-9a-f]+$/.test(String(p));
    if (!past) throw new Error(`not a call of past blocks: ${callKey(call).slice(0, 160)}`);
    // asked as the kit asks it, a batch of one, paced and asked again past a rate limit
    let r: Response | undefined;
    let text = "";
    for (let t = 0; t < 6; t++) {
      await new Promise((go) => setTimeout(go, 1100 * (t + 1)));
      r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, ...call }]) });
      text = await r.text();
      if (r.status !== 429) break;
    }
    const got = JSON.parse(text) as unknown;
    const a = ((Array.isArray(got) ? got[0] : got) ?? {}) as { result?: unknown; error?: unknown };
    if (r!.status !== 200 || a.error !== undefined || a.result === undefined || a.result === null) throw new Error(`${host} answered ${r!.status} ${text.slice(0, 160)} for ${callKey(call).slice(0, 120)}`);
    const q = F.quotes[at] as { calls: [string, unknown][] };
    if (!q.calls.some(([k]) => k === callKey(call))) q.calls.push([callKey(call), { result: a.result }]);
    added.push(call.method === "eth_getLogs" ? { quote: at, host, method: call.method, from: Number((p as { fromBlock: string }).fromBlock), to: Number((p as { toBlock: string }).toBlock) } : { quote: at, host, method: call.method, block: Number(p) });
    return { result: a.result };
  };
  const { missed } = await replayTap(name, F, live);
  if (missed.length > 0) throw new Error(`still missed: ${missed.slice(0, 4).join(" / ")}`);
  F.toppedUp = added;
  writeFileSync(fileURLToPath(new URL(`./fixtures/${name}.json.gz`, import.meta.url)), gzipSync(JSON.stringify(F), { level: 9 }));
  console.log("topped up", name, JSON.stringify(added));
};

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "topup") {
  await topup(process.argv[3]!);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== "topup") {
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
