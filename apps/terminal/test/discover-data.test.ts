// Discover's live read (card app-discover-live): the helper's lists answer, read at HELPER_HOST, has exactly the keys of
// the fixtures' rows, and the read turns a good answer into a snapshot and any bad one into an error.
// test/discover-data/helper-lists-2026-11-01.json is a recorded answer of GET /v1/market/lists?chain=solana.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HELPER_URL, readLists } from "../src/screens/discover/data.ts";
import { ROW_FIELDS, SNAPSHOT_LISTS } from "../src/screens/discover/fields.ts";
import { columnRows } from "../src/screens/discover/model.ts";
import recorded from "./discover-data/helper-lists-2026-11-01.json" with { type: "json" };
import { RECORDED_FIELDS, solana } from "./discover-screens/snapshots.ts";

type Obj = Record<string, unknown>;
/** The recorded answer as the helper sends it: each row an object with the keys of the recorded header. */
const unzip = (values: readonly unknown[]): Obj => Object.fromEntries(recorded.fields.map((f, i) => [f, values[i]]));
const answer = () => ({
  chain: recorded.chain,
  as_of_ms: recorded.as_of_ms,
  lists: Object.fromEntries(Object.entries(recorded.lists).map(([k, rows]) => [k, rows.map(unzip)])) as Record<string, Obj[]>,
});
const reply = (body: unknown, status = 200): typeof fetch => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The first thing wrong with a live row's keys against the fixtures' keys, or null. */
function keyFault(live: Obj, fixture: Obj): string | null {
  const l = Object.keys(live);
  const f = Object.keys(fixture);
  const missing = f.filter((k) => !l.includes(k));
  const extra = l.filter((k) => !f.includes(k));
  if (missing.length || extra.length) return `missing [${missing.join(", ")}] extra [${extra.join(", ")}]`;
  return JSON.stringify(l) === JSON.stringify(f) ? null : "same keys, other order";
}

test("live rows: the recorded answer's keys equal the fixtures' keys, in order (38 fields)", () => {
  const fixtureRow = solana.lists.new[0] as unknown as Obj;
  assert.equal(Object.keys(fixtureRow).length, 38);
  assert.deepEqual(RECORDED_FIELDS, ROW_FIELDS);
  assert.deepEqual(recorded.fields, ROW_FIELDS);
  const a = answer();
  assert.deepEqual(Object.keys(a.lists), [...SNAPSHOT_LISTS]);
  let n = 0;
  for (const [name, rows] of Object.entries(a.lists)) {
    for (const row of rows) {
      n++;
      assert.equal(keyFault(row, fixtureRow), null, `${name}: ${String(row.symbol)}`);
    }
  }
  assert.ok(n >= 25);
});

test("the keys test fails on a live row with a key added, taken away or moved", () => {
  const fixtureRow = solana.lists.new[0] as unknown as Obj;
  const live = answer().lists.new![0]!;
  assert.equal(keyFault(live, fixtureRow), null);
  assert.match(keyFault({ ...live, buys_15m: 1 }, fixtureRow)!, /extra \[buys_15m\]/);
  const { buys_1h: _gone, ...less } = live;
  assert.match(keyFault(less, fixtureRow)!, /missing \[buys_1h\]/);
  const { chain, ...rest } = live;
  assert.match(keyFault({ ...rest, chain }, fixtureRow)!, /other order/);
});

test("a live row's one-sided counts read 0, not null, as the fixtures' do", () => {
  for (const rows of Object.values(answer().lists)) {
    for (const r of rows) {
      for (const [b, s] of [["buys_5m", "sells_5m"], ["buys_1h", "sells_1h"], ["buys_24h", "sells_24h"]] as const) {
        assert.equal(r[b] === null, r[s] === null, `${String(r.symbol)}: ${b}=${String(r[b])} ${s}=${String(r[s])}`);
      }
    }
  }
});

test("readLists: GET /v1/market/lists?chain=solana on HELPER_HOST with the kit's fetch settings; the snapshot draws in the columns", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply(answer())(url, init);
  };
  const s = await readLists(f);
  assert.deepEqual(calls.map((c) => c.url), ["https://api.confidential.unrealized.trade/v1/market/lists?chain=solana"]);
  assert.equal(HELPER_URL, calls[0]!.url);
  assert.equal(calls[0]!.init.credentials, "omit");
  assert.equal(calls[0]!.init.referrerPolicy, "no-referrer");
  assert.equal(s.chain, "solana");
  assert.equal(s.lists.new.length, 5);
  for (const k of ["new", "trending", "hot"] as const) assert.ok(columnRows(s, k).length > 0, k);
});

test("readLists: a failed read, a non-200, text that is not JSON, another chain or lists that are not lists all throw", async () => {
  await assert.rejects(readLists(async () => { throw new TypeError("offline"); }));
  await assert.rejects(readLists(reply(answer(), 503)));
  await assert.rejects(readLists(reply({ error: { code: "upstream" } }, 503)));
  await assert.rejects(readLists(reply("<html>")));
  await assert.rejects(readLists(reply({ ...answer(), chain: "base" })));
  await assert.rejects(readLists(reply({ ...answer(), lists: null })));
  await assert.rejects(readLists(reply({ ...answer(), lists: { ...answer().lists, new: "x" } })));
  await assert.rejects(readLists(reply([])));
});

test("readLists: a row that is not an object with a mint and a symbol is dropped, the others stay", async () => {
  const a = answer();
  const good = a.lists.new![0]!;
  const rows = [good, null, 7, "x", { ...good, token: 5 }, { ...good, symbol: "" }, { ...good, token: undefined }, ...a.lists.new!.slice(1)];
  const s = await readLists(reply({ ...a, lists: { ...a.lists, new: rows } }));
  assert.equal(s.lists.new.length, 5);
});
