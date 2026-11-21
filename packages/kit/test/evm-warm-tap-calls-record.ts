// Records a heavy coin's buy taps on Robinhood Chain mainnet call by call (card robinhood-taps-meet-no-429): PONS, its
// cold tap and then a warm one, each through the tap's own route order (evmPoolBuyQuoteTap), every kit quote of each
// kept with its request and the device's clock. Each JSON-RPC call is kept alone, its method and params with the
// provider's answers in the order they came, each with its host, so test/evm-warm-tap-calls.test.ts answers each quote
// however it batches its calls, and a head read at "latest" answers the heads in the order the taps read them. Reads only: no key, no transaction, no money moves.
//   node packages/kit/test/evm-warm-tap-calls-record.ts --record
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { evmJsonRpc, evmPoolBuyQuoteWith, evmProviders, evmRanked, type EvmPoolBuyQuoteRequest } from "../src/checks/evm/quote.ts";
import { evmPoolBuyQuoteTap, evmPoolIndexRefresh } from "../src/trade/evm/buy-tap.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { callKey } from "./evm-quote-calls-record.ts";

/** PONS on Robinhood (the helper's list, 2026-11-20): 24 routes priced, its warm taps 47 eth_call a side. */
export const PONS = "0x39dbed3a2bd333467115de45665cc57f813c4571";
export const TAP_AMOUNT = 980_000_000_000_000n;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // it overwrites test/fixtures/evm-warm-tap-calls.json.gz with live mainnet reads: only when asked to (a loop over test/ ran it, and
  // replaced both recordings, card evm-warm-tap-ends-inside-two-seconds)
  if (!process.argv.includes("--record")) {
    console.error("this records test/fixtures/evm-warm-tap-calls.json.gz from mainnet and overwrites it: run it with --record");
    process.exit(2);
  }
  const v = evmPoolVenues().robinhood;
  const ix = await evmPoolIndexRefresh("robinhood", null);
  if (!ix.served || ix.sync?.index == null || ix.sync.pools == null) throw new Error("the pool index was not served");
  let phase = "cold";
  // each call's answers in the order they came: [host, answer]
  const answers = new Map<string, [string, unknown][]>();
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
          if (a === undefined || (a.error !== undefined && /rate|limit|too many|not found|unknown block|header|missing trie|archive/i.test(JSON.stringify(a.error)))) continue;
          const kept = a.error === undefined ? { result: a.result } : { error: a.error };
          const k = callKey(c);
          const host = new URL(String(url)).host;
          const m = answers.get(k) ?? [];
          m.push([host, kept]);
          answers.set(k, m);
        }
      } catch {
        // an answer that is not JSON is not kept
      }
    }
    return new Response(text, { status: r.status, headers: r.headers });
  };
  const scans = [v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => evmJsonRpc(u, recording, 16 << 20));
  const providers = evmProviders(evmRanked(v.providers!), recording);
  const quotes: { phase: string; now: number; request: Record<string, unknown>; outcome: string }[] = [];
  const quote = async (req: EvmPoolBuyQuoteRequest) => {
    const now = Date.now();
    try {
      const q = await evmPoolBuyQuoteWith(req, providers, now, scans);
      quotes.push({ phase, now, request: { ...req, token: undefined, buys: req.token, amountIn: req.amountIn.toString() }, outcome: `ok ${q.amountOut} ${q.block.hash}` });
      return q;
    } catch (e) {
      quotes.push({ phase, now, request: { ...req, token: undefined, buys: req.token, amountIn: req.amountIn.toString() }, outcome: String((e as { code?: unknown }).code ?? e) });
      throw e;
    }
  };
  for (const p of ["cold", "warm"]) {
    phase = p;
    try {
      await evmPoolBuyQuoteTap({ chain: "robinhood", token: PONS, amountIn: TAP_AMOUNT, slippageBps: 300 }, { quote, held: () => null });
    } catch (e) {
      console.log(p, "refused", (e as { code?: unknown }).code);
    }
  }
  console.log(JSON.stringify(quotes.map((q) => [q.phase, q.outcome])), "calls", answers.size);
  const s = ix.sync;
  const out = {
    recorded: new Date().toISOString(),
    index: { chainId: s.index!.chainId, poolManager: s.index!.poolManager, from: s.index!.from, coversThrough: s.coversThrough, pools: s.pools!.map((p) => [p.key.currency0, p.key.currency1, p.key.fee, p.key.tickSpacing, p.key.hooks]) },
    quotes,
    calls: [...answers],
  };
  writeFileSync(fileURLToPath(new URL("./fixtures/evm-warm-tap-calls.json.gz", import.meta.url)), gzipSync(JSON.stringify(out), { level: 9 }));
}
