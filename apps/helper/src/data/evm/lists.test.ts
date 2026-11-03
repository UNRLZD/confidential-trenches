// node --test apps/helper/src/data/evm/lists.test.ts: Discover's Base lists on recorded answers. GeckoTerminal's Base
// new_pools and trending_pools 5m and 1h (page 1, base tokens included) as read on 2026-11-03 11:35Z (fixtures/gt-base-*),
// and the two Base providers' `eth_getLogs` answers for the table's creation events over each recorded token's pool
// block (fixtures/maker-logs-base.json, recorded with the table as it is in lists.ts). The rows hold exactly the
// terminal's field list; every launchpad comes from a factory's creation event both providers return; a token no table
// factory made is untagged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROW_FIELDS as TERMINAL_FIELDS, ROW_REQUIRED } from "../../../../terminal/src/screens/discover/fields.ts";
import { geckoBudget, WINDOW_MS } from "../gecko.ts";
import {
  blockAt, blockRange, createEvmLists, FACTORIES, GT_BASE, GT_READS, LIST_MS, BATCH_MAX, MAKER_RPCS, makerFilters, padOf, readMakers, SETTLE_MS, STALE_MS, toRows,
} from "./lists.ts";

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const GT: Record<string, string> = {
  [`${GT_BASE}/networks/base/${GT_READS.new}`]: fx("gt-base-new.json"),
  [`${GT_BASE}/networks/base/${GT_READS.trending_5m}`]: fx("gt-base-trending-5m.json"),
  [`${GT_BASE}/networks/base/${GT_READS.trending_1h}`]: fx("gt-base-trending-1h.json"),
};
type Case = { address: string; symbol: string; created_s: number; range: [number, number]; pad: string | null; answers: unknown[][]; code_before?: string };
type Call = { url: string; method: string; params: unknown[]; result?: unknown; error?: unknown };
const EARLIER = JSON.parse(fx("maker-earlier-base.json")) as { recorded_at: string; paper_recorded_at: string; cases: { symbol: string; address: string; created_s: number; pad: string | null }[]; calls: Call[] };
const MAKERS = JSON.parse(fx("maker-logs-base.json")) as { recorded_at: string; cases: Case[] };
const NOW = Date.parse(MAKERS.recorded_at);

/** A fetch that answers GeckoTerminal's recorded lists and each provider's recorded eth_getLogs, by block. */
function recorded(opts: { gt?: number; rpcFails?: number[]; tamper?: (which: number, logs: unknown) => unknown } = {}) {
  const calls: string[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push(url);
    if (url.startsWith(GT_BASE)) {
      if (opts.gt !== undefined) return new Response('{"errors":[]}', { status: opts.gt, headers: { "content-type": "application/json" } });
      const body = GT[url];
      assert.ok(body, `unrecorded GeckoTerminal read ${url}`);
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    const which = MAKER_RPCS.base.indexOf(url as never);
    assert.ok(which >= 0, `unknown provider ${url}`);
    if (opts.rpcFails?.includes(which)) return new Response("bad gateway", { status: 502 });
    const reqs = JSON.parse(String(init.body)) as { id: number; params: [{ toBlock: string; fromBlock: string; address: string[]; topics: string[][] }] }[];
    assert.ok(reqs.length <= (BATCH_MAX[url] ?? 10), `${url}: a batch within its cap`);
    const out = reqs.map((r) => {
      const q = r as unknown as { id: number; method: string; params: unknown[] };
      if (q.method !== "eth_getLogs") {
        // eth_getCode: whether the token had code before its pool, as recorded, or the creation-block search's reads
        const before = MAKERS.cases.find((c) => q.method === "eth_getCode" && c.address === q.params[0] && `0x${(c.range[0] - 1).toString(16)}` === q.params[1] && c.code_before !== undefined);
        if (before && which === 0) return { jsonrpc: "2.0", id: q.id, result: before.code_before };
        const e = EARLIER.calls.find((c) => c.url === url && c.method === q.method && JSON.stringify(c.params) === JSON.stringify(q.params));
        return e === undefined ? { jsonrpc: "2.0", id: q.id, error: { code: -32000, message: "not recorded" } } : { jsonrpc: "2.0", id: q.id, ...(e.error !== undefined ? { error: e.error } : { result: e.result }) };
      }
      const [from, to] = [parseInt(r.params[0].fromBlock, 16), parseInt(r.params[0].toBlock, 16)];
      const c = MAKERS.cases.find((x) => x.range[0] === from && x.range[1] === to);
      if (c === undefined) {
        const e = EARLIER.calls.find((x) => x.url === url && x.method === "eth_getLogs" && JSON.stringify(x.params) === JSON.stringify(q.params));
        assert.ok(e, `unrecorded range ${from}-${to}`);
        return { jsonrpc: "2.0", id: q.id, ...(e.error !== undefined ? { error: e.error } : { result: e.result }) };
      }
      const k = makerFilters("base", ...c.range).findIndex((f) => JSON.stringify(f) === JSON.stringify(r.params[0]));
      assert.ok(k >= 0, "the filter is one of the table's");
      const logs = c.answers[which]![k];
      if (logs === null) return { jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "recorded as refused" } };
      return { jsonrpc: "2.0", id: r.id, result: opts.tamper ? opts.tamper(which, logs) : logs };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: f, calls };
}

test("the field list is the terminal's ROW_FIELDS; recorded GeckoTerminal answers (Base 11:35Z, Robinhood 11:46Z) give rows with exactly it, in wire forms", () => {
  for (const [chain, f] of [["base", "gt-base-new.json"], ["base", "gt-base-trending-5m.json"], ["base", "gt-base-trending-1h.json"], ["robinhood", "gt-robinhood-new.json"], ["robinhood", "gt-robinhood-trending-5m.json"], ["robinhood", "gt-robinhood-trending-1h.json"]] as const) {
    const raw = JSON.parse(fx(f));
    const { rows, created } = toRows(chain, raw, NOW)!;
    assert.ok(rows.length > 0 && rows.length <= raw.data.length, f);
    assert.equal(created.size, rows.length);
    for (const r of rows) {
      assert.deepEqual(Object.keys(r), [...TERMINAL_FIELDS], `${r.symbol}: keys`);
      for (const k of ROW_REQUIRED) assert.notEqual(r[k], undefined, `${r.symbol}: ${k}`);
      assert.equal(r.chain, chain);
      assert.match(r.token as string, /^0x[0-9a-f]{40}$/);
      assert.equal(r.src, "geckoterminal");
      assert.equal(r.launchpad, null, "a row is tagged only by the maker read");
      for (const k of TERMINAL_FIELDS.filter((x) => x.endsWith("_usd"))) assert.ok(r[k] === null || /^-?\d+(\.\d+)?$/.test(r[k] as string), `${r.symbol}: ${k}=${String(r[k])}`);
      for (const k of TERMINAL_FIELDS.filter((x) => x.endsWith("_bps") || x === "created_s" || x.startsWith("buys_") || x.startsWith("sells_"))) assert.ok(r[k] === null || Number.isSafeInteger(r[k]), `${r.symbol}: ${k}`);
    }
  }
});

test("one row field by field against its recorded pool", () => {
  const raw = JSON.parse(fx("gt-base-trending-1h.json"));
  const p = raw.data[0];
  const id = p.relationships.base_token.data.id as string;
  const t = raw.included.find((x: { id: string }) => x.id === id).attributes;
  const r = toRows("base", raw, NOW)!.rows[0]!;
  assert.equal(r.token, t.address.toLowerCase());
  assert.equal(r.symbol, t.symbol);
  assert.equal(r.created_s, Math.floor(Date.parse(p.attributes.pool_created_at) / 1000));
  assert.equal(Number(r.price_usd), Number(Number(p.attributes.base_token_price_usd).toPrecision(12)));
  assert.equal(Number(r.vol_24h_usd), Number(Number(p.attributes.volume_usd.h24).toPrecision(12)));
  assert.equal(Number(r.liq_usd), Number(Number(p.attributes.reserve_in_usd).toPrecision(12)));
  assert.equal(r.chg_1h_bps, Math.round(Number(p.attributes.price_change_percentage.h1) * 100) || 0);
  assert.equal(r.buys_5m, p.attributes.transactions.m5.buys);
  assert.equal(r.sells_24h, p.attributes.transactions.h24.sells);
});

test("hostile list input: a bad address, a token not on this network, no symbol, numbers out of form, control marks; each token once", () => {
  const pool = (id: string, attrs: Record<string, unknown> = {}) => ({ type: "pool", attributes: { pool_created_at: "2026-11-03T11:00:00Z", base_token_price_usd: "1.5", ...attrs }, relationships: { base_token: { data: { id, type: "token" } } } });
  const tok = (id: string, a: Record<string, unknown>) => ({ type: "token", id, attributes: a });
  const A = "0x" + "ab".repeat(20);
  const answer = {
    data: [
      pool("base_0x12"),
      pool(`robinhood_${A}`),
      pool(`base_${A}`, { base_token_price_usd: "1e400", reserve_in_usd: "-5", volume_usd: { h24: "NaN" }, price_change_percentage: { h1: "-150" }, transactions: { m5: { buys: -1, sells: 2.5 } } }),
      pool(`base_${A}`),
      pool(`base_0x${"cd".repeat(20)}`),
    ],
    included: [tok("base_0x12", { address: "0x12", symbol: "X", name: "X" }), tok(`base_${A}`, { address: A.toUpperCase().replace("0X", "0x"), symbol: "‮AB\u0000C", name: "" }), tok(`base_0x${"cd".repeat(20)}`, { address: `0x${"cd".repeat(20)}`, symbol: "  ", name: "N" })],
  };
  const { rows } = toRows("base", answer, NOW)!;
  assert.equal(rows.length, 1, "only the valid base row, once");
  const r = rows[0]!;
  assert.equal(r.token, A);
  assert.equal(r.symbol, "ABC");
  assert.equal(r.name, "ABC");
  for (const k of ["price_usd", "liq_usd", "vol_24h_usd", "chg_1h_bps", "buys_5m", "sells_5m"] as const) assert.equal(r[k], null, k);
  assert.equal(toRows("base", { data: "x" }, NOW), null);
  assert.equal(toRows("base", [], NOW), null);
});

test("Base's block clock: the block a pool time falls in; the maker read covers it and the one before", async () => {
  assert.deepEqual(await blockRange("base", 1793705255, () => Promise.reject(new Error("no read on Base"))), [53457953, 53457954]);
  assert.equal(blockAt("base", 1793705255), 53457954);
  assert.equal(blockAt("base", 1686789346), null);
  assert.equal(blockAt("robinhood", 1793705255), null);
});

test("every table row is well formed: a pad id, a lowercase-able address, a 32-byte topic0, a place for the token", () => {
  for (const chain of ["base", "robinhood"] as const)
    for (const f of FACTORIES[chain]) {
      assert.match(f.pad, /^[a-z0-9][a-z0-9.-]{0,31}$/);
      assert.match(f.address, /^0x[0-9a-fA-F]{40}$/);
      assert.match(f.topic0, /^0x[0-9a-f]{64}$/);
      assert.ok("topic" in f.at ? [1, 2, 3].includes(f.at.topic) : Number.isSafeInteger(f.at.word) && f.at.word >= 0 && f.at.word < 64);
    }
});

test("recorded makers: at least two live tokens per Base pad come out with that pad, both providers agreeing; an unknown factory's token gets none", async () => {
  const pads = new Set(FACTORIES.base.map((f) => f.pad));
  for (const pad of pads) assert.ok(MAKERS.cases.filter((c) => c.pad === pad).length >= 2, `${pad}: two recorded tokens`);
  assert.ok(MAKERS.cases.some((c) => c.pad === null), "a recorded token from an unknown factory");
  const { fetch } = recorded();
  const got = await readMakers("base", fetch, MAKERS.cases.map((c) => ({ token: c.address, createdS: c.created_s })), NOW);
  for (const c of MAKERS.cases) {
    if (c.pad !== null) assert.equal(got.get(c.address), c.pad, `${c.symbol} ${c.address}`);
    // none at its pool block: settled none when it had no code before its pool, else not settled until its creation
    // block is searched (those reads are recorded for three tokens below)
    else if (c.code_before === "0x") assert.equal(got.get(c.address), null, `${c.symbol}: made at its pool, by no listed factory`);
    else assert.ok(!got.has(c.address) || got.get(c.address) === null, `${c.symbol}: never a pad`);
  }
  assert.ok(MAKERS.cases.some((c) => c.pad === null && c.code_before === "0x" && got.get(c.address) === null), "a token no listed factory made gets none");
});

const RH = JSON.parse(fx("maker-logs-robinhood.json")) as { recorded_at: string; head: number; block_times: Record<string, number>; cases: (Case & { creation_tx?: string; factory?: string })[] };

/** Robinhood's recorded chain: block times (any provider, the head fixed at the recorded head) and each provider's
 *  recorded eth_getLogs for each case's block range; a read the recording lacks is an error, as a provider's would be. */
const rhRecorded = async (url: string, init: RequestInit): Promise<Response> => {
  const which = MAKER_RPCS.robinhood.indexOf(url as never);
  assert.ok(which >= 0, `unknown provider ${url}`);
  const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: [Record<string, string> | string, boolean?] }[];
  assert.ok(reqs.length <= (BATCH_MAX[url] ?? 10), `${url}: a batch within its cap`);
  const err = (id: number) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "not recorded" } });
  return new Response(JSON.stringify(reqs.map((q) => {
    if (q.method === "eth_getBlockByNumber") {
      const n = q.params[0] === "latest" ? RH.head : parseInt(q.params[0] as string, 16);
      const t = RH.block_times[n];
      return t === undefined ? err(q.id) : { jsonrpc: "2.0", id: q.id, result: { number: `0x${n.toString(16)}`, timestamp: `0x${t.toString(16)}` } };
    }
    assert.equal(q.method, "eth_getLogs");
    const f = q.params[0] as Record<string, string>;
    const c = RH.cases.find((x) => x.range[0] === parseInt(f.fromBlock!, 16) && x.range[1] === parseInt(f.toBlock!, 16));
    if (c === undefined) return err(q.id);
    const k = makerFilters("robinhood", ...c.range).findIndex((x) => JSON.stringify(x) === JSON.stringify(f));
    const a = c.answers[which]?.[k];
    return a === null || a === undefined ? err(q.id) : { jsonrpc: "2.0", id: q.id, result: a };
  })), { status: 200 });
};

test("recorded Robinhood makers: at least two live tokens per pad (each creation tx cited) come out with that pad, two providers agreeing, the range covering every block of the pool's second (Bags' token made in the 10th); an unknown factory's token gets none", async () => {
  for (const pad of new Set(FACTORIES.robinhood.map((f) => f.pad))) assert.ok(RH.cases.filter((c) => c.pad === pad).length >= 2, `${pad}: two recorded tokens`);
  for (const c of RH.cases.filter((x) => x.creation_tx !== undefined)) assert.match(c.creation_tx!, /^0x[0-9a-f]{64}$/);
  assert.ok(RH.cases.some((c) => c.pad === null), "a recorded token from an unknown factory");
  const got = await readMakers("robinhood", rhRecorded, RH.cases.map((c) => ({ token: c.address, createdS: c.created_s })), Date.parse(RH.recorded_at), new Map());
  for (const c of RH.cases) assert.equal(got.get(c.address), c.pad, `${c.symbol} ${c.address}`);
  const bags = RH.cases.find((c) => c.address === "0x4dd4aad9887eb3b7615baace5fcd565c0f61008c")!;
  assert.deepEqual([bags.pad, bags.range[1]], ["bags", 98761499], "made in the 10th block of its second");
});

test("an older token with a new pool: its creation block found from its code on chain, then its maker read there (two Clanker tokens tagged, Aerodrome's token none)", async () => {
  const { fetch } = recorded();
  for (const c of EARLIER.cases) {
    const got = await readMakers("base", fetch, [{ token: c.address, createdS: c.created_s }], Date.parse(EARLIER.paper_recorded_at));
    assert.equal(got.get(c.address), c.pad, `${c.symbol}`);
  }
  assert.deepEqual(EARLIER.cases.map((c) => c.pad), ["clanker", "clanker", null, "clanker"]);
});

test("every older token one read asks about is searched in that read, not two of them (Paper, a Clanker v4 token with a new Aerodrome pool, was served untagged live)", async () => {
  const { fetch } = recorded();
  const got = await readMakers("base", fetch, EARLIER.cases.map((c) => ({ token: c.address, createdS: c.created_s })), Date.parse(EARLIER.paper_recorded_at));
  for (const c of EARLIER.cases) assert.equal(got.get(c.address), c.pad, `${c.symbol}`);
  const paper = EARLIER.cases.find((c) => c.symbol === "Paper")!;
  assert.deepEqual([paper.address, paper.pad], ["0x2fd3f789fe25984295c8fa032be2485c5c7e4276", "clanker"]);
});

test("padOf refuses what is not a creation event of a table row: another emitter, another topic0, the token elsewhere; two pads is no answer", () => {
  const f = FACTORIES.base[0]!;
  const tok = "0x" + "ee".repeat(20);
  const word = "0x" + "0".repeat(24) + tok.slice(2);
  const place = (l: { topics: string[]; data: string }) => {
    if ("topic" in f.at) l.topics[f.at.topic] = word;
    else l.data = "0x" + "0".repeat(64 * f.at.word) + word.slice(2) + "0".repeat(64);
    return l;
  };
  const base = () => place({ address: f.address, topics: [f.topic0, "0x" + "0".repeat(64), "0x" + "0".repeat(64), "0x" + "0".repeat(64)], data: "0x" } as never);
  assert.equal(padOf("base", tok, [base()]), f.pad);
  assert.equal(padOf("base", tok, [{ ...base(), address: "0x" + "11".repeat(20) }]), null, "another emitter");
  assert.equal(padOf("base", tok, [{ ...base(), topics: ["0x" + "22".repeat(32), ...base().topics.slice(1)] }]), null, "another event");
  assert.equal(padOf("base", "0x" + "33".repeat(20), [base()]), null, "another token");
  assert.equal(padOf("base", tok, [{ ...base(), removed: true }]), null, "a removed log");
  assert.equal(padOf("base", tok, [{ ...base(), topics: ["0x12"] }]), undefined, "a malformed log is no answer");
  assert.equal(padOf("base", tok, "x"), undefined);
  const other = FACTORIES.base.find((x) => x.pad !== f.pad);
  if (other) {
    const l2 = { address: other.address, topics: [other.topic0, word, word, word], data: "0x" + word.slice(2).repeat(8) };
    assert.equal(padOf("base", tok, [base(), l2]), undefined, "two pads naming one token");
  }
});

test("two providers must answer and agree: one failing is covered by the third, two failing or one differing settles nothing; a block too new to show none is read again", async () => {
  const c = MAKERS.cases.find((x) => x.pad !== null && x.answers.every((a) => a.every((l) => l !== null)))!;
  const ask = [{ token: c.address, createdS: c.created_s }];
  for (const which of [0, 1]) assert.equal((await readMakers("base", recorded({ rpcFails: [which] }).fetch, ask, NOW)).get(c.address), c.pad, `provider ${which} down`);
  for (const down of [[0, 1], [0, 2], [1, 2]]) assert.equal((await readMakers("base", recorded({ rpcFails: down }).fetch, ask, NOW)).size, 0, `providers ${down} down: one answers`);
  assert.equal((await readMakers("base", recorded({ tamper: (w, logs) => (w === 1 ? [] : logs) }).fetch, ask, NOW)).size, 0, "one provider shows no creation event: the two differ");
  const n = MAKERS.cases.find((x) => x.pad === null && x.code_before === "0x")!;
  assert.equal((await readMakers("base", recorded().fetch, [{ token: n.address, createdS: n.created_s }], NOW)).get(n.address), null, "settled as none once old enough");
  const fresh = await readMakers("base", recorded().fetch, [{ token: n.address, createdS: n.created_s }], n.created_s * 1000 + SETTLE_MS - 1_000);
  assert.equal(fresh.size, 0, "none is not settled within SETTLE_MS of the pool");
});

test("the lists: tagged rows, the tokens not read yet named in unsettled, the lists read once per LIST_MS within the lane's yield; 503 when GeckoTerminal never answered or the read is past STALE_MS", async () => {
  let now = NOW;
  const r = recorded();
  const gecko = geckoBudget(() => now);
  const first = createEvmLists("base", gecko, { fetch: r.fetch, now: () => now });
  await first.tick();
  const s0 = JSON.parse((await first.get()).body);
  const rows0 = [...s0.lists.new, ...s0.lists.trending_5m, ...s0.lists.trending_1h] as { token: string; launchpad: unknown }[];
  assert.ok(s0.unsettled.length > 0, "after one tick some makers are not read yet");
  for (const t of s0.unsettled) assert.ok(rows0.some((x) => x.token === t), "unsettled names listed tokens");
  for (const x of rows0) if (s0.unsettled.includes(x.token)) assert.equal(x.launchpad, null, "a token not read yet carries no tag");
  now += WINDOW_MS; // the window clears for the lists read below
  const l = createEvmLists("base", gecko, { fetch: r.fetch, now: () => now });
  for (let i = 0; i < 6; i++) await l.tick(); // makers are read MAKER_PER_TICK tokens a tick
  const a = await l.get();
  assert.ok(JSON.parse(a.body).unsettled.length < s0.unsettled.length, "unsettled shrinks as makers are read");
  assert.equal(a.status, 200);
  const s = JSON.parse(a.body);
  assert.equal(s.chain, "base");
  assert.deepEqual(Object.keys(s.lists), ["new", "trending", "trending_5m", "trending_1h", "graduating"]);
  assert.deepEqual(s.lists.trending, s.lists.trending_1h);
  const tagged = [...s.lists.new, ...s.lists.trending_5m, ...s.lists.trending_1h].filter((x: { launchpad: unknown }) => x.launchpad !== null);
  assert.ok(tagged.length >= 5, `the recorded lists' launchpad tokens are tagged: ${tagged.length}`);
  for (const t of tagged) assert.equal(MAKERS.cases.find((c) => c.address === t.token)?.pad, t.launchpad, `${t.symbol}`);
  assert.equal(r.calls.filter((u) => u.startsWith(GT_BASE)).length, 6, "each list once per LIST_MS (the first and this one)");
  now += WINDOW_MS;
  await l.tick();
  assert.equal(r.calls.filter((u) => u.startsWith(GT_BASE)).length, 9);
  assert.equal(gecko.take("lists"), false, "the lists leave PAGE_RESERVE free");
  assert.equal(gecko.take("pages"), true, "which a page finds");

  // GeckoTerminal fails from now on: the last read serves until STALE_MS, then 503, never a stale list as fresh
  let down = createEvmLists("base", geckoBudget(() => now), { fetch: recorded({ gt: 503 }).fetch, now: () => now });
  assert.deepEqual([(await down.get()).status, JSON.parse((await down.get()).body)], [503, { error: { code: "upstream" } }]);
  const t0 = now;
  const flaky = { ok: true };
  const rr = recorded();
  down = createEvmLists("base", geckoBudget(() => now), { fetch: (u, i) => (flaky.ok || !u.startsWith(GT_BASE) ? rr.fetch(u, i) : recorded({ gt: 500 }).fetch(u, i)), now: () => now });
  assert.equal((await down.get()).status, 200);
  flaky.ok = false;
  now = t0 + STALE_MS;
  await down.tick();
  assert.equal((await down.get()).status, 200);
  now = t0 + STALE_MS + 1;
  assert.equal((await down.get()).status, 503);
});

test("a chain with no fixed clock (Robinhood): the block range is every block whose time is the pool's second, found by reading block times; a provider that refuses falls to the next; a time past the head is none", async () => {
  const HEAD = 105_000_000;
  // 16 blocks a second: Robinhood put Bags' creation of 0x4dd4aad9887eb3b7615baace5fcd565c0f61008c in block 98761499, the 10th
  // block of its second (fixtures/maker-logs-robinhood.json, bags-1)
  const time = (n: number) => 1_700_000_000 + Math.floor(n / 16);
  let reads = 0;
  const chain = (refuse: string[] = []) => async (url: string, init: RequestInit): Promise<Response> => {
    if (refuse.includes(url)) return new Response("{}", { status: 429 });
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: [string, boolean] }[];
    assert.ok(reqs.length <= (BATCH_MAX[url] ?? 10));
    reads += reqs.length;
    return new Response(JSON.stringify(reqs.map((r) => {
      assert.equal(r.method, "eth_getBlockByNumber");
      const n = r.params[0] === "latest" ? HEAD : parseInt(r.params[0], 16);
      return { jsonrpc: "2.0", id: r.id, result: { number: `0x${n.toString(16)}`, timestamp: `0x${time(n).toString(16)}` } };
    })), { status: 200 });
  };
  const s = time(93_296_272);
  const first = 93_296_272 - (93_296_272 % 16);
  assert.deepEqual(await blockRange("robinhood", s, chain()), [first, first + 15]);
  assert.ok(reads <= 140, `reads ${reads}`);
  assert.deepEqual(await blockRange("robinhood", s, chain([MAKER_RPCS.robinhood[1]])), [first, first + 15], "the second provider refuses: the first answers");
  assert.equal(await blockRange("robinhood", time(HEAD) + 5, chain()), null, "after the head");
  assert.equal(await blockRange("robinhood", s, chain([...MAKER_RPCS.robinhood])), null, "every provider refuses");
});
