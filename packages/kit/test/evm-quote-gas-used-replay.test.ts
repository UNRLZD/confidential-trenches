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

type Log = { blockNumber: string; topics: string[] };
const F = JSON.parse(readFileSync(new URL("./fixtures/evm-quote-gas-used.json", import.meta.url), "utf8")) as { at: string; quotes: { now: number; outcome: string }[]; exchanges: { q: number; body: string; answer: string }[]; poolLogs: { address: string; from: number; to: number; logs: Log[] } };
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
  // the scan's batches as the recording sent them, by their getLogs' block ranges: their logs and their block read. The
  // recording (9 Nov) named the coin in two topic positions; since card evm-scan-chain-tail a request names the event
  // alone, answered here with the union of the recorded logs of the same blocks (the pools are the same, so the reads
  // this replays are)
  const range = (c: Call) => { const f = c.params[0] as unknown as { fromBlock: string; toBlock: string }; return `${f.fromBlock}-${f.toBlock}`; };
  const scans = new Map<string, { q: number; logs: unknown[]; block: unknown }>();
  for (const x of F.exchanges) {
    const cs = callsOf(x.body);
    const ls = cs.filter((c) => c.method === "eth_getLogs");
    if (ls.length === 0 || ls.some((c) => range(c) !== range(ls[0]!))) continue;
    const a = JSON.parse(x.answer) as { id: number; result?: unknown }[];
    const of = (c: Call) => a.find((y) => y.id === c.id)?.result;
    const blk = cs.find((c) => c.method === "eth_getBlockByNumber");
    scans.set(`${x.q}:${range(ls[0]!)}`, { q: x.q, logs: ls.flatMap((c) => (of(c) as unknown[] | undefined) ?? []), block: blk === undefined ? undefined : of(blk) });
  }
  const scanAnswer = (q: number, calls: Call[]): string | undefined => {
    const ls = calls.filter((c) => c.method === "eth_getLogs");
    if (ls.length !== 1 || (ls[0]!.params[0] as unknown as { topics: unknown[] }).topics.length !== 1) return undefined;
    const r = scans.get(`${q}:${range(ls[0]!)}`) ?? [...scans.entries()].find(([k]) => k.endsWith(`:${range(ls[0]!)}`))?.[1];
    if (r === undefined) return undefined;
    const seen = new Set<string>();
    const logs = r.logs.filter((l) => { const k = JSON.stringify(l); return !seen.has(k) && (seen.add(k), true); });
    return JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_getLogs" ? logs : r.block })));
  };
  // A scan batch the recording never sent whole (card evm-warm-quote-inside-the-kpi-with-room: a warm quote's scan reads
  // up to its held head, where the recording's read up to its scan provider's head, so its gaps end a few blocks sooner):
  // each getLogs answered with the logs of the recorded getLogs of the same filter whose blocks together hold its own,
  // end to end, those inside its range (a block's logs never change), and its block read by number with that block's
  // recorded header; a call of it none answers leaves the batch unanswered, named as before
  const recorded: { f: string; a: bigint; b: bigint; logs: unknown[] }[] = [];
  const headers = new Map<bigint, unknown>();
  for (const x of F.exchanges) {
    const cs = callsOf(x.body);
    const as = [JSON.parse(x.answer)].flat() as { id: number; result?: unknown }[];
    for (const c of cs) {
      const r = as.find((y) => y.id === c.id)?.result;
      if (c.method === "eth_getLogs" && Array.isArray(r)) {
        const { fromBlock, toBlock, ...f } = c.params[0] as unknown as { fromBlock: string; toBlock: string };
        recorded.push({ f: JSON.stringify(f), a: BigInt(fromBlock), b: BigInt(toBlock), logs: r });
      }
      const h = r as { number?: unknown } | null | undefined;
      // by the number it holds, a read of "latest" (the head watch's) included
      if (c.method === "eth_getBlockByNumber" && typeof h?.number === "string" && /^0x[0-9a-f]+$/i.test(h.number)) headers.set(BigInt(h.number), h);
    }
  }
  // A PoolManager log read (a warm quote's proof that the pools its last prune dropped are unmoved, card
  // evm-warm-tap-skips-pools-it-pruned, which the recording predates): answered with the PoolManager's real logs of those
  // blocks (F.poolLogs, read after the recording on two providers that agreed) of its events and pool ids; one reaching
  // past them is left unanswered, named
  const pmLogs = (c: Call): Log[] | undefined => {
    const f = c.params[0] as unknown as { address?: string; fromBlock: string; toBlock: string; topics?: unknown[] };
    const t0 = f.topics?.[0];
    if (String(f.address).toLowerCase() !== F.poolLogs.address || !Array.isArray(t0)) return undefined;
    const [a, b] = [BigInt(f.fromBlock), BigInt(f.toBlock)];
    if (a < BigInt(F.poolLogs.from) || b > BigInt(F.poolLogs.to)) return undefined;
    const ids = Array.isArray(f.topics?.[1]) ? (f.topics[1] as string[]).map((x) => x.toLowerCase()) : null;
    const events = (t0 as string[]).map((x) => x.toLowerCase());
    return F.poolLogs.logs.filter((l) => a <= BigInt(l.blockNumber) && BigInt(l.blockNumber) <= b && events.includes(l.topics[0]!.toLowerCase()) && (ids === null || ids.includes(l.topics[1]!.toLowerCase())));
  };
  const within = (calls: Call[]): string | undefined => {
    if (!calls.some((c) => c.method === "eth_getLogs") || calls.some((c) => c.method !== "eth_getLogs" && c.method !== "eth_getBlockByNumber")) return undefined;
    const out: unknown[] = [];
    for (const c of calls) {
      if (c.method === "eth_getBlockByNumber") {
        const h = /^0x[0-9a-f]+$/i.test(String(c.params[0])) ? headers.get(BigInt(String(c.params[0]))) : undefined;
        if (h === undefined) return undefined;
        out.push({ jsonrpc: "2.0", id: c.id, result: h });
        continue;
      }
      const pm = pmLogs(c);
      if (pm !== undefined) {
        out.push({ jsonrpc: "2.0", id: c.id, result: pm });
        continue;
      }
      const { fromBlock, toBlock, ...f } = c.params[0] as unknown as { fromBlock: string; toBlock: string };
      const [a, b] = [BigInt(fromBlock), BigInt(toBlock)];
      const same = recorded.filter((x) => x.f === JSON.stringify(f) && x.b >= a && x.a <= b).sort((x, y) => (x.a < y.a ? -1 : 1));
      let reach = a - 1n;
      for (const x of same) if (x.a <= reach + 1n && x.b > reach) reach = x.b;
      if (reach < b) return undefined;
      const seen = new Set<string>();
      const logs = same.flatMap((x) => x.logs).filter((l) => {
        const n = BigInt((l as { blockNumber: string }).blockNumber);
        const k = JSON.stringify(l);
        return a <= n && n <= b && !seen.has(k) && (seen.add(k), true);
      });
      out.push({ jsonrpc: "2.0", id: c.id, result: logs });
    }
    return JSON.stringify(out);
  };
  // An aggregate3 of reads the quote's recording sent in a larger aggregate3 (card evm-warm-tap-skips-pools-it-pruned: a
  // warm quote asks again only the pools the last prune dropped that the proof above does not show unmoved, where the
  // recording's warm quotes asked all 58 in one call): each read answered with its own recorded answer in that quote.
  // A read keeps at least the gas it had in the larger call (fewer reads before it share the call's gas), so its
  // recorded answer stands only where it was not starved: one recorded 2 is left unanswered, named
  const at3 = (h: string, o: number) => Number(BigInt("0x" + h.slice(2 * o, 2 * o + 64)));
  const innerOf = (data: string): string[] => {
    const h = data.slice(10);
    const base = at3(h, 0);
    return Array.from({ length: at3(h, base) }, (_, k) => {
      const t = base + 32 + at3(h, base + 32 + 32 * k);
      const d = t + at3(h, t + 64);
      return h.slice(2 * t, 2 * t + 64) + h.slice(2 * (d + 32), 2 * (d + 32 + at3(h, d)));
    });
  };
  const entriesOf = (result: string): string[] => {
    const h = result.slice(2);
    const n = at3(h, 32);
    const offs = Array.from({ length: n }, (_, k) => 64 + at3(h, 64 + 32 * k));
    return offs.map((o, k) => h.slice(2 * o, k + 1 < n ? 2 * offs[k + 1]! : h.length));
  };
  const asked = new Map<number, Map<string, string>>();
  for (const x of F.exchanges) {
    const as = [JSON.parse(x.answer)].flat() as { id: number; result?: unknown }[];
    for (const c of callsOf(x.body)) {
      const r = as.find((y) => y.id === c.id)?.result;
      if (readsOf(c) === undefined || typeof r !== "string") continue;
      const es = entriesOf(r);
      const m = asked.get(x.q) ?? new Map<string, string>();
      innerOf(c.params[0].data!).forEach((k, i) => es[i] !== undefined && at3(es[i]!, 0) !== 2 && m.set(k, es[i]!));
      asked.set(x.q, m);
    }
  }
  const regrouped = (calls: Call[]): string | undefined => {
    if (calls.some((c) => readsOf(c) === undefined)) return undefined;
    const m = asked.get(atQ);
    const out: unknown[] = [];
    for (const c of calls) {
      const es = innerOf(c.params[0].data!).map((k) => m?.get(k));
      if (es.some((e) => e === undefined)) return undefined;
      const w = (n: number) => n.toString(16).padStart(64, "0");
      let off = 32 * es.length;
      const heads = es.map((e) => { const o = off; off += e!.length / 2; return w(o); });
      out.push({ jsonrpc: "2.0", id: c.id, result: "0x" + w(0x20) + w(es.length) + heads.join("") + es.join("") });
    }
    return JSON.stringify(out);
  };
  let atQ = 0;
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
    const answer = q !== undefined && q.length > 0 ? q.shift()! : (last.get(k) ?? any.get(k) ?? scanAnswer(atQ, calls) ?? within(calls) ?? regrouped(calls));
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
      atQ = q;
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
