// Discover's live read (card app-discover-live): the helper's lists answer, read at HELPER_HOST, has exactly the keys of
// the fixtures' rows, and the read turns a good answer into a snapshot and any bad one into an error.
// test/discover-data/helper-lists-2026-11-01.json is a recorded answer of GET /v1/market/lists?chain=solana.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HELPER_URL, readChainLists } from "../src/screens/discover/data.ts";
import { BACKOFF_MS, MIN_READ_MS, READY_MS, TIMEOUT_MS } from "../src/screens/discover/read-again.ts";

/** One read of Solana's lists. */
const readSolana = (f: typeof fetch) => readChainLists("solana", f);
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

test("readChainLists solana: GET /v1/market/lists?chain=solana on HELPER_HOST with the kit's fetch settings; the snapshot draws in the columns", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply(answer())(url, init);
  };
  const s = await readSolana(f);
  assert.deepEqual(calls.map((c) => c.url), ["https://ct-api.unrealized.trade/v1/market/lists?chain=solana"]);
  assert.equal(HELPER_URL, calls[0]!.url);
  assert.equal(calls[0]!.init.credentials, "omit");
  assert.equal(calls[0]!.init.referrerPolicy, "no-referrer");
  assert.equal(s.chain, "solana");
  assert.equal(s.lists.new.length, 5);
  for (const k of ["new", "trending", "hot"] as const) assert.ok(columnRows(s, k).length > 0, k);
});

test("readChainLists solana: a refusal (another status, text that is not JSON, another chain, lists that are not lists) throws at once, read once", async () => {
  for (const [name, f] of [
    ["400", reply({ error: { code: "bad" } }, 400)],
    ["not JSON", reply("<html>")],
    ["another chain", reply({ ...answer(), chain: "base" })],
    ["no lists", reply({ ...answer(), lists: null })],
    ["a list that is not a list", reply({ ...answer(), lists: { ...answer().lists, new: "x" } })],
    ["an array", reply([])],
  ] as const) {
    const c = still();
    let n = 0;
    await assert.rejects(readChainLists("solana", (async (i, o) => (n++, f(i, o))) as typeof fetch, c), undefined, name);
    assert.equal(n, 1, `${name}: read once`);
    assert.deepEqual(c.waits, [], name);
  }
});

// Card app-token-page-rides-out-a-slow-token-read: the lists read rides out a helper that does not answer as the token
// read does (read-again.ts readAgain). A clock handed in: `sleep` and a read the helper never answers move it.
function still() {
  let t = 0;
  const waits: number[] = [];
  const timeouts: number[] = [];
  return {
    waits,
    timeouts,
    now: () => t,
    sleep: async (ms: number) => void (waits.push(ms), (t += ms)),
    timeout: (ms: number) => (timeouts.push(ms), new AbortController().signal),
    hang: async (): Promise<Response> => {
      t += timeouts.at(-1)!;
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
  };
}

test("readChainLists: no answer, a network failure, a 503 and a 429 are read again with backoff, and the lists draw on the answer", async () => {
  const c = still();
  const answers: (() => Promise<Response>)[] = [c.hang, async () => Promise.reject(new TypeError("offline")), reply(answer(), 503) as () => Promise<Response>, reply("slow down", 429) as () => Promise<Response>, reply(answer()) as () => Promise<Response>];
  const urls: string[] = [];
  const s = await readChainLists("solana", (async (input) => (urls.push(String(input)), answers[urls.length - 1]!())) as typeof fetch, c);
  assert.equal(s.chain, "solana");
  assert.deepEqual(urls, Array(5).fill(HELPER_URL));
  assert.deepEqual(c.waits, [...BACKOFF_MS]);
  assert.ok(c.now() <= READY_MS);
});

test("readChainLists: a helper that never answers, or answers 5xx or 429 every time, throws once READY_MS is spent, never past it", async () => {
  const c = still();
  let n = 0;
  await assert.rejects(readChainLists("solana", (async () => (n++, c.hang())) as typeof fetch, c));
  assert.deepEqual(c.timeouts, [TIMEOUT_MS, READY_MS - TIMEOUT_MS - 500]);
  assert.equal(n, 2);
  assert.equal(c.now(), READY_MS);
  for (const status of [503, 502, 429]) {
    const k = still();
    let m = 0;
    await assert.rejects(readChainLists("solana", (async () => (m++, new Response("{}", { status }))) as typeof fetch, k), undefined, String(status));
    assert.ok(m > 1, `${status}: read ${m} time(s)`);
    assert.ok(k.now() <= READY_MS - MIN_READ_MS, `${status}: last read at ${k.now()} ms`);
  }
});

test("readChainLists solana: a row that is not an object with a mint and a symbol is dropped, the others stay", async () => {
  const a = answer();
  const good = a.lists.new![0]!;
  const rows = [good, null, 7, "x", { ...good, token: 5 }, { ...good, symbol: "" }, { ...good, token: undefined }, ...a.lists.new!.slice(1)];
  const s = await readSolana(reply({ ...a, lists: { ...a.lists, new: rows } }));
  assert.equal(s.lists.new.length, 5);
});
