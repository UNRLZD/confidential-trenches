// Replays evm-pool-index.answers.json through the live check: `good`, a real run on this card's kit (2026-11-08 from
// this Mac), passes; `bad`, the same script run in a checkout of the kit before this card (fb2c25cf, no index in the
// venue list), fails; and the good run with one thing changed fails: the readers' block N differs (no pin), one reader
// misses a pool, a span answered without its last block, two readers of one operator, a reader of ours, another margin.
// The read itself, replayed from the good run: a reader one block behind on a span, then caught up, PASSES (asked
// again, as the index asks it); one that stays behind past TRIES FAILS; a receipt answered null or with a rate limit
// once, then present, PASSES (reviews 3 and 4), one null past TRIES FAILS, and any other answer is final and FAILS; the
// receipts are asked in one batch of at most RECEIPTS.
//   node --test scripts/live-checks/evm-pool-index.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RECEIPTS, TRIES, judge, read } from "./evm-pool-index.mjs";

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

test("the recorded bad run, the kit before this card, fails: no index", () => {
  bad(A.bad, /base: the kit's venue lists no index/);
  bad(A.bad, /robinhood: the kit's venue lists no index/);
});

test("the good run with one thing changed fails", () => {
  for (const chain of ["base", "robinhood"]) {
    bad(changed((r) => (r.chains[chain].spans[0].on[1].last = "0x" + "11".repeat(32))), new RegExp(`${chain} .*the pin`));
    bad(changed((r) => r.chains[chain].spans[1].on[1].ids.pop()), new RegExp(`${chain} .*pools on both`));
    bad(changed((r) => (r.chains[chain].spans[2].on[0].last = null)), new RegExp(`${chain} .*with its last block in the same batch`));
    bad(changed((r) => (r.chains[chain].index.readers[1] = r.chains[chain].index.readers[0].replace("://", "://other."))), new RegExp(`${chain}: two index readers on two operators`));
    bad(changed((r) => (r.chains[chain].index.readers[1] = "https://ct-api.unrealized.trade")), new RegExp(`${chain}: no reader is ours`));
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
 *  `odd(url, tx)`: that reader's answer to the receipt of tx in place of the recorded one (undefined: the recorded). */
const batches = [];
function replayFetch(run, behind = () => false, odd = () => undefined) {
  const byUrl = new Map();
  for (const c of Object.values(run.chains)) c.index?.readers.forEach((u, r) => byUrl.set(u, { c, r }));
  const res = (body, headers = {}) => ({ status: 200, ok: true, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });
  return async (url, init) => {
    const { c, r } = byUrl.get(url);
    const p = c.preflight[url];
    if (init.method === "OPTIONS") return { ...res(null, { "access-control-allow-origin": p.allow, "access-control-allow-headers": p.headers }), status: p.status };
    const body = JSON.parse(init.body);
    if (!Array.isArray(body)) return res({ jsonrpc: "2.0", id: 1, result: "0x1" }, { "access-control-allow-origin": p.post });
    if (body[0].method === "eth_getTransactionReceipt") {
      batches.push(body.length);
      return res(body.map((q) => {
        const tx = q.params[0];
        const s = c.spans.find((x) => x.txs?.includes(tx));
        const k = s.txs.indexOf(tx);
        const rc = s.receipts[r][k];
        const o = odd(url, tx);
        if (o !== undefined) return { jsonrpc: "2.0", id: q.id, ...o };
        return { jsonrpc: "2.0", id: q.id, result: { blockNumber: "0x" + rc.block.toString(16), logs: rc.init ? [{ address: "0x0", topics: [INIT, s.on[0].firsts[k].id], transactionHash: tx }] : [] } };
      }));
    }
    if (body.length === 1) return res([{ jsonrpc: "2.0", id: 0, result: "0x" + c.heads[r].toString(16) }]);
    const b = Number(body[1].params[0]);
    const s = c.spans.find((x) => x.b === b);
    const on = s.on[r];
    const late = behind(url, b);
    return res([
      { jsonrpc: "2.0", id: 0, result: late ? [] : on.ids.map((id, i) => ({ topics: ["0x", id], ...(on.firsts?.[i] ? { transactionHash: on.firsts[i].tx } : {}) })) },
      { jsonrpc: "2.0", id: 1, result: late ? null : { number: "0x" + b.toString(16), hash: on.last } },
      { jsonrpc: "2.0", id: 2, result: "0x" + (late ? b - 1 : c.heads[r]).toString(16) },
    ]);
  };
}
const venuesOf = (run) => Object.fromEntries(Object.entries(run.chains).map(([k, c]) => [k, { poolManager: "0x0", index: c.index }]));

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
