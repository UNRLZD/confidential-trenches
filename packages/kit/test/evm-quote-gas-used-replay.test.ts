// Replays a real Robinhood quote, cold then warm, with each read's real gas used (card evm-quote-gas-used, review of
// e9b54f71, P2; recorded by test/evm-quote-gas-used-record.ts into test/fixtures/evm-quote-gas-used.json). TORCH at
// 100 ETH: the cold quote's call of 64 has honest reads above an even share of 64 (623,000) before reads they starve
// (answered 2). The warm quotes must send every read as the recording's warm quotes did: none alone, no read answered 2.
// Before the review's fold the reads that used the gas were kept alone, so the warm quotes sent 16 calls, 9 alone, in
// 1.83 to 2.09 s, against 9 calls, none alone (live, the reviewer's runs). The replay answers each request body with the
// answer the recording gave it in that quote, in order, on any provider; a request the recording never sent is a failure,
// named.
//   node --test packages/kit/test/evm-quote-gas-used-replay.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evmPoolBuyQuote, EvmQuoteError } from "../src/index.ts";
import { REQUEST } from "./evm-quote-gas-used-record.ts";

const F = JSON.parse(readFileSync(new URL("./fixtures/evm-quote-gas-used.json", import.meta.url), "utf8")) as { at: string; quotes: { now: number; outcome: string }[]; exchanges: { q: number; body: string; answer: string }[] };
const MC3 = "0xca11bde05977b3631167028862be2a173976ca11";
type Call = { method: string; params: [{ to?: string; data?: string }, ...unknown[]]; id: number };
const callsOf = (body: string): Call[] => {
  const b = JSON.parse(body) as Call | Call[];
  return Array.isArray(b) ? b : [b];
};
// an aggregate3 call's read count, or undefined
const readsOf = (c: Call) => (c.method === "eth_call" && String(c.params[0]?.to).toLowerCase() === MC3 ? Number(BigInt("0x" + c.params[0].data!.slice(74, 138))) : undefined);
// each aggregate3 answer's success words, by call id
const wordsOf = (answer: string, ids: Set<number>): Map<number, number[]> => {
  const a = JSON.parse(answer) as { id: number; result?: unknown }[] | { id: number; result?: unknown };
  const out = new Map<number, number[]>();
  for (const x of Array.isArray(a) ? a : [a]) {
    if (!ids.has(x.id) || typeof x.result !== "string" || x.result.length < 2 + 128) continue;
    const h = x.result.slice(2);
    const at = (o: number) => Number(BigInt("0x" + h.slice(2 * o, 2 * o + 64)));
    if (at(0) !== 0x20) continue;
    out.set(x.id, Array.from({ length: at(32) }, (_, k) => at(64 + at(64 + 32 * k))));
  }
  return out;
};

test("a real Robinhood quote whose call of 64 starves reads behind honest heavy reads: the warm quotes send no read alone and answer no 2, as recorded", async () => {
  // each quote's own answers to each body, in order, a call's block hash aside: the head watch may hold another block for
  // a warm quote than it held live (its background reads run on timers), and the reads are what this replays; and the
  // swap-gas read's calldata aside (buySwap, card evm-buy-gas-floor: its recipient is new each quote). A body
  // that quote never sent is answered as the last quote that sent it answered it (a block read by number)
  const key = (body: string) => body.replace(/"blockHash":"0x[0-9a-fA-F]{64}"/g, '"blockHash":"*"').replace(/"data":"0x25faf2a3[0-9a-fA-F]*"/g, '"data":"buySwap"');
  let queue = new Map<string, string[]>();
  let last = new Map<string, string>();
  const any = new Map<string, string>();
  for (const x of F.exchanges) any.set(key(x.body), x.answer);
  const load = (q: number) => {
    queue = new Map();
    last = new Map();
    for (const x of F.exchanges.filter((y) => y.q === q)) {
      queue.set(key(x.body), [...(queue.get(key(x.body)) ?? []), x.answer]);
      last.set(key(x.body), x.answer);
    }
  };
  // each quote's aggregate3 calls (read counts) and the success words they were answered
  let sizes: number[] = [];
  let words: number[][] = [];
  const missed: string[] = [];
  const real = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = String(init?.body);
    const calls = callsOf(body);
    const k = key(body);
    const q = queue.get(k);
    const answer = q !== undefined && q.length > 0 ? q.shift()! : (last.get(k) ?? any.get(k));
    if (answer === undefined) {
      missed.push(calls.map((c) => (readsOf(c) !== undefined ? `aggregate3 of ${readsOf(c)}` : c.method)).join(", "));
      return new Response("upstream unavailable", { status: 503 });
    }
    const w = wordsOf(answer, new Set(calls.filter((c) => readsOf(c) !== undefined).map((c) => c.id)));
    for (const c of calls) {
      const n = readsOf(c);
      if (n === undefined) continue;
      sizes.push(n);
      words.push(w.get(c.id) ?? []);
    }
    return new Response(answer, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const per: { outcome: string; sizes: number[]; words: number[][] }[] = [];
    for (const [q, { now }] of F.quotes.entries()) {
      load(q);
      sizes = [];
      words = [];
      const t0 = realNow();
      Date.now = () => now + (realNow() - t0);
      let outcome: string;
      try {
        await evmPoolBuyQuote(REQUEST);
        outcome = "ok";
      } catch (e) {
        if (!(e instanceof EvmQuoteError)) throw e;
        outcome = `${e.code}: ${e.message}`;
      }
      per.push({ outcome, sizes, words });
      // the recording's 1.5 s between quotes, in which the head watch reads the head again (answered from this quote's
      // own recording, as it was)
      await new Promise((r) => setTimeout(r, 1_500));
    }
    const show = per.map((p, q) => `${q === 0 ? "cold" : "warm" + q} ${p.outcome.slice(0, 80)} [${p.sizes.join(",")}]`).join(" | ");
    assert.deepEqual(missed, [], `requests the recording never sent: ${missed.slice(0, 6).join(" / ")} || ${show}`);
    assert.deepEqual(per.map((p) => p.outcome), F.quotes.map((q) => q.outcome), show);
    // control: the cold quote's call of 64 answered 30 reads 2 or more, behind the honest reads above S(64)
    assert.ok(per[0]!.words.some((w) => w.length === 64 && w.filter((x) => x === 2).length >= 30), show);
    for (const p of per.slice(1)) {
      assert.ok(p.sizes.every((n) => n > 1), `a read sent alone on a warm quote: ${show}`);
      assert.ok(p.words.flat().every((x) => x !== 2), `a read answered 2 on a warm quote: ${show}`);
    }
  } finally {
    globalThis.fetch = real;
    Date.now = realNow;
  }
});
