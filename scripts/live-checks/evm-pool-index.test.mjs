// Replays evm-pool-index.answers.json through the live check: `good`, a real run on the kit of card
// evm-sync-inside-the-kpi-at-any-age (Base's publicnode and bloXroute in 50,000-block spans, Robinhood's own and the
// helper's keyed route in 500,000; 2026-11-21 13:30Z from this Mac), passes; `bad10k`, the good run before it
// (2026-11-18, Base in 10,000-block spans), fails; `bad`, the run on the kit before it (2026-11-08, Robinhood's own and Pocket in 10,000-block
// spans, the reads release 130's page drew 429s on), fails; and the good run with one thing changed fails: no index,
// the readers' block N differs (no pin), one reader misses a pool, a span answered without its last block, two readers
// of one operator, a reader of ours that is not the helper's keyed route second, another span, another margin.
// The read itself, replayed from the good run: a reader one block behind on a span, then caught up, PASSES (asked
// again, as the index asks it); one that stays behind past TRIES FAILS; a receipt answered null or with a rate limit
// once, then present, PASSES (reviews 3 and 4), one null past TRIES FAILS, and any other answer is final and FAILS; the
// receipts are asked in one batch of at most RECEIPTS. A batch answered HTTP 429 (the helper's keyed route at its
// caller share) waits its Retry-After without spending a try, as the kit does, up to LIMITED_WAIT_MS; one answered 503,
// or 2xx with a body that is not a batch, spends a try (card robinhood-index-second-reader-serves-receipts).
// Card evm-batch-fits-each-reader: `good` is now its run (2026-11-18 20:53Z from this Mac, base.api.pocket.network's
// receipts asked as parts of 5 after its 413), and `bad413` the run of the check before it (20:51Z), Base's reader 2
// answering 0 of 10 receipts in every span, each batch of 10 refused 413; a reader that refuses a batch past 5 PASSES
// replayed, one that refuses every batch, one call included, FAILS.
//   node --test scripts/live-checks/evm-pool-index.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LIMITED_WAIT_MS, MOST, RECEIPTS, TRIES, judge, read, sizeRefusal } from "./evm-pool-index.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pool-index.answers.json", import.meta.url), "utf8"));
const bad = (run, re) => {
  const v = judge(run);
  assert.equal(v.pass, false);
  assert.ok(v.lines.some((l) => l.startsWith("BAD") && re.test(l)), v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
};
const changed = (f) => {
  const r = structuredClone(A.good);
  f(r);
  return r;
};

test("the recorded good run passes", () => {
  const v = judge(A.good);
  assert.equal(v.pass, true, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
});

test("the recorded bad run, the kit before this card, fails: Robinhood's 10,000-block spans on Pocket", () => {
  bad(A.bad, /robinhood: span 10000 \(the card's 500000\)/);
});

test("the recorded run of 18 Nov, Base in 10,000-block spans, fails since card evm-sync-inside-the-kpi-at-any-age: Base reads 50,000", () => {
  bad(A.bad10k, /base: span 10000 \(the card's 50000\)/);
});
test("the recorded 413 run, the check before card evm-batch-fits-each-reader, fails: Base's reader 2 answers 0 of 10 receipts", () => {
  bad(A.bad413, /base .*reader 2 answered 0 of 10 receipts/);
  // the run of 18 Nov (Pocket still Base's second reader, the good run until card evm-sync-inside-the-kpi-at-any-age)
  assert.deepEqual(A.bad10k.chains.base.most, { "https://base.api.pocket.network": 5 }, "the 18 Nov run split Pocket's batches at 5");
});

test("the good run with one thing changed fails", () => {
  for (const chain of ["base", "robinhood"]) {
    bad(changed((r) => (r.chains[chain].spans[0].on[1].last = "0x" + "11".repeat(32))), new RegExp(`${chain} .*the pin`));
    bad(changed((r) => r.chains[chain].spans[1].on[1].ids.pop()), new RegExp(`${chain} .*pools on both`));
    bad(changed((r) => (r.chains[chain].spans[2].on[0].last = null)), new RegExp(`${chain} .*with its last block in the same batch`));
    bad(changed((r) => (r.chains[chain].index.readers[1] = r.chains[chain].index.readers[0].replace("://", "://other."))), new RegExp(`${chain}: two index readers on two operators`));
    bad(changed((r) => (r.chains[chain].index = null)), new RegExp(`${chain}: the kit's venue lists no index`));
    bad(changed((r) => (r.chains[chain].index.readers[1] = "https://ct-api.unrealized.trade")), new RegExp(`${chain}: no reader is ours`));
    bad(changed((r) => (r.chains[chain].index.readers[1] = `https://ct-api.unrealized.trade/v1/rpc/${chain}`)), new RegExp(`${chain}: no reader is ours`));
    bad(changed((r) => (r.chains[chain].index.readers = [`https://ct-api.unrealized.trade/v1/rpc/${chain}?keyed=only`, "https://rpc.example.org"])), new RegExp(`${chain}: no reader is ours`));
    bad(changed((r) => (r.chains[chain].index.span = 20_000)), new RegExp(`${chain}: span 20000`));
    bad(changed((r) => (r.chains[chain].index.margin = 0)), new RegExp(`${chain}: span .*margin 0`));
    bad(changed((r) => (r.chains[chain].heads[1] = r.chains[chain].heads[0] + 50_000)), new RegExp(`${chain}: the two heads 50000 blocks apart`));
    const s = A.good.chains[chain].spans.findIndex((x) => x.on[0].ids.length > 0);
    bad(changed((r) => (r.chains[chain].spans[s].receipts[1][0].init = false)), new RegExp(`${chain} .*reader 2 answered \\d+ of`));
    bad(changed((r) => (r.chains[chain].spans[s].receipts[0][0] = null)), new RegExp(`${chain} .*reader 1 answered \\d+ of`));
    bad(changed((r) => r.chains[chain].spans[s].receipts[0].pop()), new RegExp(`${chain} .*receipts read on both readers`));
    bad(changed((r) => delete r.chains[chain].spans[s].receipts), new RegExp(`${chain} .*receipts read on both readers`));
  }
});

const INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
/** A fetch that answers as the good run's readers did; `behind(url, b)` true: that reader does not hold block b yet;
 *  `odd(url, tx)`: that reader's answer to the receipt of tx in place of the recorded one (undefined: the recorded);
 *  `http(url, body)`: that reader's whole HTTP answer to a POST in place of the recorded one, { status, headers, body }
 *  (undefined: the recorded). */
const batches = [];
function replayFetch(run, behind = () => false, odd = () => undefined, http = () => undefined) {
  const byUrl = new Map();
  for (const c of Object.values(run.chains)) c.index?.readers.forEach((u, r) => byUrl.set(u, { c, r }));
  const res = (body, headers = {}, status = 200) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });
  return async (url, init) => {
    const { c, r } = byUrl.get(url);
    const p = c.preflight[url];
    if (init.method === "OPTIONS") return { ...res(null, { "access-control-allow-origin": p.allow, "access-control-allow-headers": p.headers }), status: p.status };
    const body = JSON.parse(init.body);
    const h = http(url, body);
    if (h !== undefined) return res(h.body, h.headers ?? {}, h.status);
    if (!Array.isArray(body)) return res({ jsonrpc: "2.0", id: 1, result: "0x1" }, { "access-control-allow-origin": p.post });
    if (body[0].method === "eth_getTransactionReceipt") {
      batches.push(body.length);
      return res(body.map((q) => {
        const tx = q.params[0];
        // the request's id is the receipt's place among the span's firsts (readReceipts), so one transaction that made
        // several pools (the 13 Nov run's Robinhood span) answers each of them
        const s = c.spans.find((x) => x.txs?.[q.id] === tx);
        const k = q.id;
        const rc = s.receipts[r][k];
        const o = odd(url, tx);
        if (o !== undefined) return { jsonrpc: "2.0", id: q.id, ...o };
        return { jsonrpc: "2.0", id: q.id, result: { blockNumber: "0x" + rc.block.toString(16), logs: rc.init ? [{ address: "0x0", topics: [INIT, s.on[0].firsts[k].id], transactionHash: tx }] : [] } };
      }));
    }
    if (body.length === 1) return res([{ jsonrpc: "2.0", id: 0, result: "0x" + c.heads[r].toString(16) }]);
    // a span's batch, or the aged span's (a coin's read: two getLogs, its pools all in the first)
    const b = Number(body.find((q) => q.method === "eth_getBlockByNumber").params[0]);
    const s = c.spans.find((x) => x.b === b) ?? (c.aged?.b === b ? c.aged : undefined);
    const on = s.on[r];
    const late = behind(url, b);
    return res(body.map((q) =>
      q.method === "eth_getLogs"
        ? { jsonrpc: "2.0", id: q.id, result: late || q.id !== 0 ? [] : on.ids.map((id, i) => ({ topics: ["0x", id], ...(on.firsts?.[i] ? { transactionHash: on.firsts[i].tx } : {}) })) }
        : q.method === "eth_getBlockByNumber"
          ? { jsonrpc: "2.0", id: q.id, result: late ? null : { number: "0x" + b.toString(16), hash: on.last } }
          : { jsonrpc: "2.0", id: q.id, result: "0x" + (late ? b - 1 : c.heads[r]).toString(16) },
    ));
  };
}
const venuesOf = (run) => Object.fromEntries(Object.entries(run.chains).map(([k, c]) => [k, { poolManager: "0x0", weth: c.aged?.coin ?? "0x4200000000000000000000000000000000000006", index: c.index }]));

test("a reader one block behind on a span, then caught up, passes; one behind past TRIES fails", async () => {
  const u = A.good.chains.robinhood.index.readers[1];
  const b = A.good.chains.robinhood.spans[0].b;
  let asked = 0;
  const once = await read(venuesOf(A.good), replayFetch(A.good, (url, x) => url === u && x === b && asked++ === 0), async () => {});
  const v = judge(once);
  assert.equal(v.pass, true, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
  assert.equal(once.chains.robinhood.spans[0].on[1].tries, 2);
  assert.equal(once.chains.robinhood.spans[0].on[1].head, A.good.chains.robinhood.heads[1]);
  const stays = await read(venuesOf(A.good), replayFetch(A.good, (url, x) => url === u && x === b), async () => {});
  assert.equal(stays.chains.robinhood.spans[0].on[1].tries, TRIES);
  bad(stays, /robinhood .*with its last block in the same batch/);
});

test("a receipt answered null or with a rate limit once, then present, passes; null past TRIES or any other answer fails; one batch of at most RECEIPTS", async () => {
  const u = A.good.chains.base.index.readers[1];
  const i = A.good.chains.base.spans.findIndex((x) => x.txs?.length > 1);
  const tx = A.good.chains.base.spans[i].txs[1];
  for (const first of [{ result: null }, { error: { code: -32005, message: "25/second request limit reached" } }]) {
    let asked = 0;
    batches.length = 0;
    const once = await read(venuesOf(A.good), replayFetch(A.good, () => false, (url, x) => (url === u && x === tx && asked++ === 0 ? first : undefined)), async () => {});
    const v = judge(once);
    assert.equal(v.pass, true, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
    assert.equal(once.chains.base.spans[i].receipts[1][1].tries, 2);
    assert.equal(once.chains.base.spans[i].receipts[1][0].tries, 1);
    assert.ok(batches.length > 0 && batches.every((n) => n <= RECEIPTS), JSON.stringify(batches));
  }
  const stays = await read(venuesOf(A.good), replayFetch(A.good, () => false, (url, x) => (url === u && x === tx ? { result: null } : undefined)), async () => {});
  assert.equal(stays.chains.base.spans[i].receipts[1][1].tries, TRIES);
  bad(stays, /base .*reader 2 answered \d+ of/);
  // an error that is no rate limit is final, as in the kit: asked once
  const err = await read(venuesOf(A.good), replayFetch(A.good, () => false, (url, x) => (url === u && x === tx ? { error: { code: -32000, message: "header not found" } } : undefined)), async () => {});
  assert.equal(err.chains.base.spans[i].receipts[1][1].tries, 1);
  bad(err, /base .*reader 2 answered \d+ of/);
});

test("the waits are the kit's (1, 2 then 4 s): a receipt null on tries 1-3, then present, passes; null on every try fails", async () => {
  const u = A.good.chains.base.index.readers[1];
  const i = A.good.chains.base.spans.findIndex((x) => x.txs?.length > 0);
  const tx = A.good.chains.base.spans[i].txs[0];
  let asked = 0;
  const waits = [];
  const late = await read(venuesOf(A.good), replayFetch(A.good, () => false, (url, x) => (url === u && x === tx && asked++ < 3 ? { result: null } : undefined)), async (ms) => void waits.push(ms));
  const v = judge(late);
  assert.equal(v.pass, true, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
  assert.equal(late.chains.base.spans[i].receipts[1][0].tries, 4);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
  const never = await read(venuesOf(A.good), replayFetch(A.good, () => false, (url, x) => (url === u && x === tx ? { result: null } : undefined)), async () => {});
  assert.equal(never.chains.base.spans[i].receipts[1][0].tries, TRIES);
  bad(never, /base .*reader 2 answered \d+ of/);
  // a span's last block: the same waits
  const r = A.good.chains.robinhood.index.readers[1];
  const b = A.good.chains.robinhood.spans[0].b;
  let behind = 0;
  const spanWaits = [];
  const caught = await read(venuesOf(A.good), replayFetch(A.good, (url, x) => url === r && x === b && behind++ < 3), async (ms) => void spanWaits.push(ms));
  assert.equal(judge(caught).pass, true);
  assert.deepEqual(spanWaits, [1_000, 2_000, 4_000]);
});

// Card robinhood-index-second-reader-serves-receipts: the helper's keyed route takes 30 requests a caller each 10 s and
// answered the check's third batch of 10 Robinhood receipts HTTP 429 {"error":{"code":"rate_limited"}}, Retry-After 5
// (2026-11-20 01:4xZ from this Mac; live app runs 44651054036, 44441930508), which the check read as ten receipts
// answered null on try 1 and FAILed. The kit waits a 429 out without spending a try (pool-index.ts `ask`), so does this.
const LIMITED = { status: 429, headers: { "retry-after": "5" }, body: { error: { code: "rate_limited" } } };
const rhReceipts = (run) => {
  const c = run.chains.robinhood;
  const s = c.spans.findLastIndex((x) => x.txs?.length > 0);
  return { u: c.index.readers[1], s, tx: c.spans[s].txs[0] };
};
const receiptBatchOf = (body, tx) => body[0]?.method === "eth_getTransactionReceipt" && body.some((q) => q.params[0] === tx);

test("the helper's keyed route answering a receipt batch 429 with Retry-After 5 once: waited out, no try spent, PASS", async () => {
  const { u, s, tx } = rhReceipts(A.good);
  let asked = 0;
  const waits = [];
  const run = await read(venuesOf(A.good), replayFetch(A.good, () => false, () => undefined, (url, body) => (url === u && receiptBatchOf(body, tx) && asked++ === 0 ? LIMITED : undefined)), async (ms) => void waits.push(ms));
  const v = judge(run);
  assert.equal(v.pass, true, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
  const rc = run.chains.robinhood.spans[s].receipts[1][0];
  assert.equal(rc.tries, 1);
  assert.equal(rc.limitedMs, 5_000);
  assert.deepEqual(waits, [5_000]);
});

test("a 429 on every ask waits at most LIMITED_WAIT_MS a batch, then each 429 spends a try, and FAILs", async () => {
  const { u, tx } = rhReceipts(A.good);
  const waits = [];
  const run = await read(venuesOf(A.good), replayFetch(A.good, () => false, () => undefined, (url, body) => (url === u && receiptBatchOf(body, tx) ? LIMITED : undefined)), async (ms) => void waits.push(ms));
  bad(run, /robinhood .*reader 2 answered 0 of/);
  // each try's batch waits its 429s (Retry-After 5 s, never less than the doubling backoff) up to the bound, and the
  // tries' own waits (1, 2 then 4 s) between them
  assert.equal(waits.reduce((a, b) => a + b, 0), TRIES * LIMITED_WAIT_MS + 1_000 + 2_000 + 4_000, JSON.stringify(waits));
});

test("a batch answered HTTP 503, or 2xx with a body that is not a batch, spends a try and is asked again, never read as receipts answered null", async () => {
  const { u, s, tx } = rhReceipts(A.good);
  for (const once of [{ status: 503, body: { error: { code: "upstream" } } }, { status: 200, body: { error: { code: "upstream" } } }]) {
    let asked = 0;
    const run = await read(venuesOf(A.good), replayFetch(A.good, () => false, () => undefined, (url, body) => (url === u && receiptBatchOf(body, tx) && asked++ === 0 ? once : undefined)), async () => {});
    const v = judge(run);
    assert.equal(v.pass, true, `${once.status}: ${v.lines.filter((l) => l.startsWith("BAD")).join("\n")}`);
    assert.equal(run.chains.robinhood.spans[s].receipts[1][0].tries, 2);
  }
  const stays = await read(venuesOf(A.good), replayFetch(A.good, () => false, () => undefined, (url, body) => (url === u && receiptBatchOf(body, tx) ? { status: 503, body: { error: { code: "upstream" } } } : undefined)), async () => {});
  bad(stays, /robinhood .*reader 2 answered 0 of/);
  assert.match(stays.chains.robinhood.spans[s].receipts[1][0].error, /HTTP 503/);
});

test("a span's batch and a head read answered 429 once are waited out too", async () => {
  const { u } = rhReceipts(A.good);
  let span = 0;
  let head = 0;
  const waits = [];
  const run = await read(venuesOf(A.good), replayFetch(A.good, () => false, () => undefined, (url, body) => {
    if (url !== u || !Array.isArray(body)) return undefined;
    if (body.length === 1 && body[0].method === "eth_blockNumber" && head++ === 0) return LIMITED;
    if (body[0].method === "eth_getLogs" && span++ === 0) return LIMITED;
    return undefined;
  }), async (ms) => void waits.push(ms));
  const v = judge(run);
  assert.equal(v.pass, true, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
  assert.equal(run.chains.robinhood.spans[0].on[1].tries, 1);
  assert.equal(run.chains.robinhood.spans[0].on[1].limitedMs, 5_000);
  assert.deepEqual(waits, [5_000, 5_000]);
});

/** `inner` with `url`'s batches past `max` calls answered 413 with base.api.pocket.network's own body (2026-11-18). */
const sizes = [];
const capped = (inner, url, max) => async (u, init) => {
  const body = init.method === "POST" ? JSON.parse(init.body) : null;
  if (u === url && Array.isArray(body)) sizes.push(body.length);
  if (u === url && Array.isArray(body) && body.length > max) return { status: 413, ok: false, headers: { get: () => null }, json: async () => JSON.parse("request entity too large"), text: async () => "request entity too large: the batch has more items than this window allows\n" };
  return inner(u, init);
};

test("a reader that refuses a batch past 5 calls 413 answers every receipt as parts of 5, the size kept; one that refuses every batch fails", async () => {
  const u = A.good.chains.base.index.readers[1];
  MOST.clear();
  sizes.length = 0;
  const fit = await read(venuesOf(A.good), capped(replayFetch(A.good), u, 5), async () => {});
  const v = judge(fit);
  assert.equal(v.pass, true, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
  assert.deepEqual(fit.chains.base.most, { [u]: 5 });
  assert.equal(sizes.filter((n) => n > 5).length, 1, `one batch past 5 meets the 413, the later ones start at 5: ${sizes.join(",")}`);
  MOST.clear();
  const none = await read(venuesOf(A.good), capped(replayFetch(A.good), u, 0), async () => {}).catch((e) => e);
  MOST.clear();
  assert.ok(none instanceof Error || judge(none).pass === false, "a reader that answers no batch is no reader");
});

test("sizeRefusal reads each mainnet reader's refusal as the kit does, and never a throttle, a 5xx or a revert", () => {
  assert.equal(sizeRefusal(413, "request entity too large: the batch has more items than this window allows"), null);
  assert.equal(sizeRefusal(413, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch too large: max 20 calls" } })), 20);
  assert.equal(sizeRefusal(400, JSON.stringify([{ id: 0, error: { code: 31, message: "Batch of more than 3 requests are not allowed on free plan" } }])), 3);
  assert.equal(sizeRefusal(429, JSON.stringify({ code: 8, message: "JSON-RPC batch exceeds the maximum of 5 requests" })), 5);
  assert.equal(sizeRefusal(429, JSON.stringify({ id: 0, error: { code: -32005, message: "rate limit exceeded" } })), undefined);
  assert.equal(sizeRefusal(200, JSON.stringify([{ id: 0, error: { code: -32007, message: "25/second request limit reached" } }])), undefined);
  assert.equal(sizeRefusal(502, "batch too large"), undefined);
  assert.equal(sizeRefusal(200, JSON.stringify([{ id: 0, error: { code: 3, message: "execution reverted: batch too large" } }])), undefined);
});

test("a 429 on a part of a split batch is waited out too: no try spent, the reader's size kept, PASS", async () => {
  const u = A.good.chains.base.index.readers[1];
  const i = A.good.chains.base.spans.findIndex((x) => x.txs?.length > 5);
  const tx = A.good.chains.base.spans[i].txs[6];
  MOST.clear();
  let asked = 0;
  const waits = [];
  const parts = [];
  const inner = replayFetch(A.good, () => false, () => undefined, (url, body) => {
    if (url !== u || !receiptBatchOf(body, tx)) return undefined;
    parts.push(body.length);
    return asked++ === 0 ? LIMITED : undefined;
  });
  const run = await read(venuesOf(A.good), capped(inner, u, 5), async (ms) => void waits.push(ms));
  MOST.clear();
  const v = judge(run);
  assert.equal(v.pass, true, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
  assert.deepEqual(run.chains.base.most, { [u]: 5 });
  // the part holding tx: answered 429 once (a part of at most 5), then asked again after its Retry-After
  assert.ok(parts.length >= 2 && parts.every((n) => n <= 5), JSON.stringify(parts));
  const rc = run.chains.base.spans[i].receipts[1][6];
  assert.equal(rc.tries, 1);
  assert.equal(rc.limitedMs, 5_000);
  assert.ok(waits.includes(5_000), JSON.stringify(waits));
});

// Card evm-first-quote-reads-its-coin-at-any-age: the aged span, a coin's read 48 h below N, on both readers. `good` is
// now its run (2026-11-21 16:1xZ from this Mac, both chains' aged spans answered alike), `badAged` the good run before it
// (13:30Z), which read no aged span: FAIL.
test("the recorded run before the aged span, the check before this card, fails: no coin's read 48 h below N", () => {
  bad(A.badAged, /^BAD base aged span/);
  bad(A.badAged, /^BAD robinhood aged span/);
});
test("the aged span: not read, read elsewhere, a pool on one reader only, or answered past the RPC timeout, fails", () => {
  for (const chain of ["base", "robinhood"]) {
    bad(changed((r) => delete r.chains[chain].aged), new RegExp(`^BAD ${chain} aged span`));
    bad(changed((r) => (r.chains[chain].aged.b -= 1)), new RegExp(`^BAD ${chain} aged`));
    bad(changed((r) => (r.chains[chain].aged.on[1].ids = [...r.chains[chain].aged.on[1].ids, "0x" + "ab".repeat(32)])), /the same last block and the same/);
    bad(changed((r) => (r.chains[chain].aged.on[1].ms = 10_001)), /answered in/);
  }
});
