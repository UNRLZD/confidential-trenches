// node --test apps/helper/src/data/evm/lists.test.ts: Discover's Base lists on recorded answers. GeckoTerminal's Base
// new_pools and trending_pools 5m and 1h (page 1, base tokens included) as read on 2026-11-03 11:35Z (fixtures/gt-base-*),
// and the two Base providers' `eth_getLogs` answers for the table's creation events over each recorded token's pool
// block (fixtures/maker-logs-base.json, recorded with the table as it is in lists.ts). The rows hold exactly the
// terminal's field list; every launchpad comes from a factory's creation event both providers return; a token no table
// factory made is untagged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ROW_FIELDS as TERMINAL_FIELDS, ROW_REQUIRED } from "../../../../terminal/src/screens/discover/fields.ts";
import { geckoBudget, WINDOW_MS } from "../gecko.ts";
import {
  blockAt, blockRange, createEvmLists, FACTORIES, GT_BASE, GT_READS, joinLogs, LIST_MS, BATCH_MAX, MAKER_RPCS, makerFilters, padOf, readMakers, RECORDS,
  recordCalls, recordPad, SETTLE_MS, STALE_MS, toRows,
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
  assert.deepEqual(blockRange("base", 1793705255), [53457953, 53457954]);
  assert.equal(blockRange("robinhood", 1793705255), null, "no fixed clock: Robinhood's makers come from the records");
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

test("recorded Robinhood creation events: at least two live tokens per pad (each creation tx cited) are named by their pad's factory, the range covering every block of the pool's second (Bags' token made in the 10th); an unknown factory's token is named by none", () => {
  for (const pad of new Set(FACTORIES.robinhood.map((f) => f.pad))) assert.ok(RH.cases.filter((c) => c.pad === pad).length >= 2, `${pad}: two recorded tokens`);
  for (const c of RH.cases.filter((x) => x.creation_tx !== undefined)) assert.match(c.creation_tx!, /^0x[0-9a-f]{64}$/);
  assert.ok(RH.cases.some((c) => c.pad === null), "a recorded token from an unknown factory");
  for (const c of RH.cases) for (const which of [0, 1]) {
    const logs = joinLogs(c.answers[which]!);
    if (logs !== undefined) assert.equal(padOf("robinhood", c.address, logs), c.pad, `${c.symbol} ${c.address} on provider ${which}`);
  }
  const bags = RH.cases.find((c) => c.address === "0x4dd4aad9887eb3b7615baace5fcd565c0f61008c")!;
  assert.deepEqual([bags.pad, bags.range[1]], ["bags", 98761499], "made in the 10th block of its second");
  const tagged = (pad: string) => RH.cases.filter((c) => c.pad === pad).map((c) => c.symbol);
  assert.deepEqual(tagged("torch"), ["BLEP", "TORCH", "LOBIN"]);
});

// Robinhood's makers come from each launchpad's own record (RECORDS), read at latest. fixtures/maker-records-robinhood.json.gz
// holds, per JSON-RPC call and provider, what the three Robinhood providers answered on 2026-11-04 (recorded_at): every
// record of every token in maker-logs-robinhood.json and of the two `later` tokens, and the creation-event read
// lists.ts made at 641b5c9 for those two at their later pool's time (block times and eth_getLogs), which named none.
type RecCall = { url: string; method: string; params: unknown[]; result?: unknown; error?: unknown };
const REC = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/maker-records-robinhood.json.gz", import.meta.url))).toString()) as {
  recorded_at: string;
  later: { symbol: string; address: string; created_s: number; pad: string; note: string }[];
  calls: RecCall[];
};
const REC_NOW = Date.parse(REC.recorded_at);
/** The recorded Robinhood providers: each call answered as recorded, by provider, method and params; a call the
 *  recording lacks is an error, as a provider's would be. `down` providers answer 502; `lie` rewrites one answer. */
function rhRecords(opts: { down?: number[]; lie?: (which: number, q: { method: string; params: unknown[] }, result: unknown) => unknown } = {}) {
  const methods: string[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const which = MAKER_RPCS.robinhood.indexOf(url as never);
    assert.ok(which >= 0, `unknown provider ${url}`);
    if (opts.down?.includes(which)) return new Response("bad gateway", { status: 502 });
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    assert.ok(reqs.length <= (BATCH_MAX[url] ?? 10), `${url}: a batch within its cap`);
    return new Response(JSON.stringify(reqs.map((q) => {
      methods.push(q.method);
      const c = REC.calls.find((x) => x.url === url && x.method === q.method && JSON.stringify(x.params) === JSON.stringify(q.params));
      if (c === undefined || c.error !== undefined) return { jsonrpc: "2.0", id: q.id, error: c?.error ?? { code: -32000, message: "not recorded" } };
      return { jsonrpc: "2.0", id: q.id, result: opts.lie ? opts.lie(which, q, c.result) : c.result };
    })), { status: 200 });
  };
  return { fetch: f, methods };
}
const later = (symbol: string) => REC.later.find((c) => c.symbol === symbol)!;

test("GS, a Pons token whose curve was made at 22:13:34Z and whose v4 pools came at 22:17-22:23Z, listed by a later pool: tagged pons from Pons' own record, never none", async () => {
  const gs = later("GS");
  assert.deepEqual([gs.address, gs.created_s], ["0xe27136f29472596bf42c6bf8798ab295d85e7716", Date.parse("2026-11-03T22:17:21Z") / 1000]);
  const r = rhRecords();
  const got = await readMakers("robinhood", r.fetch, [{ token: gs.address, createdS: gs.created_s }], REC_NOW);
  assert.equal(got.get(gs.address), "pons");
  assert.deepEqual([...new Set(r.methods)], ["eth_call"], "the records only: no block search, no logs, no old state");
});

test("0x5920…df8c (a USDT lookalike), made by Clanker v4 at block 105722171 and listed by its later Uniswap v3 pool, where the creation events named none and the live check failed (run 41792520325): tagged clanker from Clanker's own record", async () => {
  const t = later("USDT-lookalike");
  assert.deepEqual([t.address, t.created_s], ["0x5920184d0c50ee1ef3a4eca83e15dad572c6df8c", Date.parse("2026-11-04T07:25:12Z") / 1000]);
  const got = await readMakers("robinhood", rhRecords().fetch, [{ token: t.address, createdS: t.created_s }], REC_NOW);
  assert.equal(got.get(t.address), "clanker");
});

/** The 12 recorded tokens whose creation events at their listed pool's block named none, yet whose launchpad's own
 *  record names them (older tokens listed by a later pool); two checked against their creation events read on
 *  rpc.mainnet.chain.robinhood.com 2026-11-04 08:30Z: GRIFT's Pons v2 TokenLaunched at block 64692512 (tx 0x872da1ed),
 *  USD𖼊 0x439f's Clanker v4 TokenCreated at block 104994431 (tx 0x6d97212c). */
const OLDER_MADE: Record<string, string> = {
  "0x439f170947a9f76b00a5a8bb8d5896e01fbffb07": "clanker", "0x9f4ba41f91a59a34e17ee8c9eb3a51363b11abd5": "pons", "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18": "doppler",
  "0x451b42a15100c340ca12f7c66de06fac5ea2d751": "pons", "0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3": "pons", "0x47569d49471bdbabfaf5531c0f74d9f2de82a11a": "pons",
  "0xea0071a8778fa02c12378e88868255e0e0952be6": "pons", "0xd56a6c45941ee8aae31ce6a30bd049e0f7489cbd": "pons", "0xedbf91223639800bcd5756815caf908df3b890be": "pons",
  "0xfad17d7cc41d9c9ca4a459da798a4446dd217974": "pons", "0xe4d2422ed4d203a0f1ec2043a4db1eda426fca18": "pons", "0x01e6301bc1118be90cc6bc2d1b5c0c44bb883111": "pons",
};

test("recorded Robinhood makers from the launchpads' records: every token a factory's creation event named comes out with that pad; 12 the pool's block showed none are their pads' older tokens; the rest none, two providers agreeing", async () => {
  const got = await readMakers("robinhood", rhRecords().fetch, RH.cases.map((c) => ({ token: c.address, createdS: c.created_s })), REC_NOW);
  for (const c of RH.cases) assert.equal(got.get(c.address), c.pad ?? OLDER_MADE[c.address] ?? null, `${c.symbol} ${c.address}`);
  assert.equal(RH.cases.filter((c) => c.pad === null).length, 34);
  for (const t of Object.keys(OLDER_MADE)) assert.equal(RH.cases.find((c) => c.address === t)?.pad, null, `${t}: none at its pool's block`);
});

test("the records table: each selector is keccak-256 of its signature; Robinhood's pads and factories are its creation-event table's; every view answers its exact length", () => {
  assert.equal(RECORDS.base, null);
  const recs = RECORDS.robinhood!;
  for (const r of recs) {
    assert.equal(r.selector, `0x${Buffer.from(keccak_256(new TextEncoder().encode(r.signature))).toString("hex").slice(0, 8)}`, r.signature);
    assert.equal(r.address, r.address.toLowerCase());
    assert.ok(FACTORIES.robinhood.some((f) => f.pad === r.pad && f.address.toLowerCase() === r.address && (f.shared === true) === (r.shared === true)), `${r.pad} ${r.address}`);
    assert.ok(r.made.word < r.words);
  }
  assert.deepEqual([...new Set(recs.map((r) => r.pad))].sort(), [...new Set(FACTORIES.robinhood.map((f) => f.pad))].sort());
  // every recorded answer of every record is its view's exact static length
  const calls = new Map(recs.map((r) => [r.address, r.words]));
  for (const c of REC.calls.filter((x) => x.method === "eth_call" && x.error === undefined)) {
    const to = (c.params[0] as { to: string }).to;
    assert.equal((c.result as string).length, 2 + 64 * calls.get(to)!, to);
  }
});

test("recordPad refuses what is not a record's exact answer: a revert, another length, a word out of its type; two own pads is no answer; a shared pad counts only alone", () => {
  const tok = `0x${"ab".repeat(20)}`;
  const recs = RECORDS.robinhood!;
  const zero = (r: (typeof recs)[number]) => `0x${"0".repeat(64 * r.words)}`;
  const word = `${"0".repeat(24)}${tok.slice(2)}`;
  const made = (r: (typeof recs)[number]) => {
    const w = r.made.is === "true" ? `${"0".repeat(63)}1` : r.made.is === "token" ? word : `${"0".repeat(24)}${"cd".repeat(20)}`;
    const z = zero(r).slice(2);
    return `0x${z.slice(0, 64 * r.made.word)}${w}${z.slice(64 * (r.made.word + 1))}`;
  };
  const answers = (set: Record<number, string> = {}) => recs.map((r, i) => set[i] ?? zero(r));
  assert.equal(recordPad("robinhood", tok, answers()), null, "no record names it");
  for (const [i, r] of recs.entries()) assert.equal(recordPad("robinhood", tok, answers({ [i]: made(r) })), r.pad, `${r.signature} at ${r.address}`);
  const clanker = recs.findIndex((r) => r.pad === "clanker");
  const other = `0x${"0".repeat(24)}${"ee".repeat(20)}${"0".repeat(128)}`;
  assert.equal(recordPad("robinhood", tok, answers({ [clanker]: other })), null, "Clanker's record of another token");
  assert.equal(recordPad("robinhood", tok, answers({ [clanker]: "0x" })), undefined, "a revert's empty answer");
  assert.equal(recordPad("robinhood", tok, answers({ [clanker]: `${made(recs[clanker]!)}00` })), undefined, "an odd length");
  assert.equal(recordPad("robinhood", tok, answers({ [clanker]: `${made(recs[clanker]!)}${"0".repeat(64)}` })), undefined, "a word more");
  assert.equal(recordPad("robinhood", tok, answers({ [clanker]: `0x${"f".repeat(64)}${"0".repeat(128)}` })), undefined, "an address word with high bytes");
  const torch = recs.findIndex((r) => r.pad === "torch");
  assert.equal(recordPad("robinhood", tok, answers({ [torch]: `0x${"0".repeat(63)}2` })), undefined, "a bool that is not 0 or 1");
  assert.equal(recordPad("robinhood", tok, answers({ [torch]: 1 as never })), undefined, "not a string");
  assert.equal(recordPad("robinhood", tok, answers().slice(1)), undefined, "an answer missing");
  const bags = recs.findIndex((r) => r.pad === "bags");
  assert.equal(recordPad("robinhood", tok, answers({ [clanker]: made(recs[clanker]!), [bags]: made(recs[bags]!) })), undefined, "two own pads");
  const doppler = recs.findIndex((r) => r.shared === true);
  assert.equal(recordPad("robinhood", tok, answers({ [doppler]: made(recs[doppler]!) })), "doppler", "the shared pad alone");
  assert.equal(recordPad("robinhood", tok, answers({ [doppler]: made(recs[doppler]!), [bags]: made(recs[bags]!) })), "bags", "an own pad wins over the shared one");
  assert.deepEqual(recordCalls("robinhood", tok).map((c) => c.params[1]), recs.map(() => "latest"));
});

test("Robinhood records: two providers must answer and agree; one down is covered by the third, two down or the two differing settles nothing; none is not settled within SETTLE_MS of the pool", async () => {
  const gs = later("GS");
  const ask = [{ token: gs.address, createdS: gs.created_s }];
  for (const which of [0, 1]) assert.equal((await readMakers("robinhood", rhRecords({ down: [which] }).fetch, ask, REC_NOW)).get(gs.address), "pons", `provider ${which} down`);
  for (const down of [[0, 1], [0, 2], [1, 2]]) assert.equal((await readMakers("robinhood", rhRecords({ down }).fetch, ask, REC_NOW)).size, 0, `providers ${down} down`);
  const zeroed = (w: number) => rhRecords({ lie: (which, _q, res) => (which === w ? `0x${"0".repeat((res as string).length - 2)}` : res) }).fetch;
  for (const w of [0, 1]) assert.equal((await readMakers("robinhood", zeroed(w), ask, REC_NOW)).size, 0, `provider ${w} says none: the two differ, nothing settles`);
  const none = RH.cases.find((c) => c.pad === null && OLDER_MADE[c.address] === undefined)!;
  assert.equal((await readMakers("robinhood", rhRecords().fetch, [{ token: none.address, createdS: none.created_s }], REC_NOW)).get(none.address), null, "none once old enough");
  assert.equal((await readMakers("robinhood", rhRecords().fetch, [{ token: none.address, createdS: Math.floor(REC_NOW / 1000) - 10 }], REC_NOW)).size, 0, "a pool 10 s old: none is read again");
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

test("a helper started fresh on Robinhood settles its lists in its first tick: none of the recorded lists' 46 tokens left unsettled (the live check allows half), each tagged as its launchpad's record says, from the records only", async () => {
  const now = REC_NOW;
  const lists: Record<string, string> = {
    [`${GT_BASE}/networks/robinhood/${GT_READS.new}`]: fx("gt-robinhood-new.json"),
    [`${GT_BASE}/networks/robinhood/${GT_READS.trending_5m}`]: fx("gt-robinhood-trending-5m.json"),
    [`${GT_BASE}/networks/robinhood/${GT_READS.trending_1h}`]: fx("gt-robinhood-trending-1h.json"),
  };
  const r = rhRecords();
  const fetch = async (url: string, init: RequestInit) => (url.startsWith(GT_BASE) ? new Response(lists[url], { status: 200, headers: { "content-type": "application/json" } }) : r.fetch(url, init));
  const l = createEvmLists("robinhood", geckoBudget(() => now), { fetch, now: () => now });
  await l.tick();
  const s = JSON.parse((await l.get()).body);
  const rows = [...s.lists.new, ...s.lists.trending_5m, ...s.lists.trending_1h] as { token: string; launchpad: string | null; symbol: string }[];
  const tokens = new Set(rows.map((x) => x.token));
  assert.equal(tokens.size, 46);
  assert.deepEqual(s.unsettled, []);
  for (const x of rows) {
    const c = RH.cases.find((k) => k.address === x.token);
    assert.ok(c, `${x.symbol}: recorded`);
    assert.equal(x.launchpad, c.pad ?? OLDER_MADE[x.token] ?? null, `${x.symbol} ${x.token}`);
  }
  assert.ok(rows.filter((x) => x.launchpad !== null).length >= 10, "the lists' launchpad tokens are tagged");
  assert.deepEqual([...new Set(r.methods)], ["eth_call"]);
});

// card helper-rpc-hex-case: robinhood-testnet.drpc.org writes hex in upper case (eth_chainId "0xB626", read 3 Nov 23:07Z)
test("providers that write hex in upper case: the recorded Robinhood makers come out the same, from the records and from the creation events", async () => {
  const up = (v: unknown): unknown =>
    typeof v === "string" && /^0x[0-9a-f]+$/.test(v) ? `0x${v.slice(2).toUpperCase()}` : Array.isArray(v) ? v.map(up) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, up(x)])) : v;
  const asks = RH.cases.map((c) => ({ token: c.address, createdS: c.created_s }));
  const lower = await readMakers("robinhood", rhRecords().fetch, asks, REC_NOW);
  let changed = 0;
  for (const which of [[0], [0, 1, 2]]) {
    const upper = await readMakers("robinhood", rhRecords({ lie: (w, _q, r) => (which.includes(w) ? (JSON.stringify(up(r)) !== JSON.stringify(r) && changed++, up(r)) : r) }).fetch, asks, REC_NOW);
    assert.deepEqual([...upper], [...lower], `providers ${which.join(", ")} in upper case`);
  }
  assert.ok(changed > 0, "answers with hex letters were sent in upper case");
  // the creation events: a pad named from upper-case logs as from the recorded ones
  for (const c of RH.cases) for (const which of [0, 1]) {
    const logs = joinLogs(c.answers[which]!);
    if (logs !== undefined) assert.equal(padOf("robinhood", c.address, up(logs)), c.pad, `${c.symbol} on provider ${which}`);
  }
});
