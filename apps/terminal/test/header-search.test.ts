// The top bar's search model (card app-header-search-chain, src/shell/search.ts): the rows it searches (every list of
// the lists read, one row a token), the matching rules (symbol, then name, then an address), the chain filter (All, plus
// the chains with data) and the address forms that send a pasted id to the token read (source.ts loadToken), plus the
// lists it searches: the rail's store when it is fresh, else one shared read (data.ts sharedAllLists), never a poll.
// test/discover-data/helper-lists-2026-11-01.json is a recorded answer of GET /v1/market/lists?chain=solana.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REFRESH_MS } from "../src/screens/discover/data.ts";
import type { MarketRow, MarketSnapshot } from "../src/screens/discover/fields.ts";
import { columnRows } from "../src/screens/discover/model.ts";
import { addressChains, allRows, chainsWithData, LIMIT, listsSource, plan, idleRows } from "../src/shell/search.ts";
import lists from "./discover-data/helper-lists-2026-11-01.json" with { type: "json" };

const unzip = (values: readonly unknown[]) => Object.fromEntries(lists.fields.map((f, i) => [f, values[i]]));
const SNAP = { chain: lists.chain, as_of_ms: lists.as_of_ms, lists: Object.fromEntries(Object.entries(lists.lists).map(([k, rows]) => [k, rows.map(unzip)])) } as unknown as MarketSnapshot;

const SOL = "So11111111111111111111111111111111111111112";
const EVM = "0x07b3d902783c3c12b077508c3b5c00113d1291d0";
const NEAR_IMPLICIT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const row = (o: Partial<MarketRow> & { token: string; symbol: string }): MarketRow => ({ chain: "solana", name: o.symbol, icon: false, price_usd: null, src: "jup", as_of_ms: 1, launchpad: null, mc_usd: null, ...o }) as MarketRow;

test("allRows: every list's rows (Trending's first), one row per chain and token, the first seen kept", () => {
  const rows = allRows(SNAP);
  const keys = rows.map((r) => `${r.chain}/${r.token}`);
  assert.equal(new Set(keys).size, keys.length);
  const every = new Set(Object.values(SNAP.lists).flat().map((r) => `${r.chain}/${r.token}`));
  assert.deepEqual(new Set(keys), every);
  // the same token on two chains is two rows; Trending's row is seen before New's
  const two = allRows({ chain: "solana", as_of_ms: 1, lists: { new: [row({ token: "a", symbol: "A" }), row({ token: "a", symbol: "A", chain: "base" })], trending: [row({ token: "a", symbol: "B" })] } } as unknown as MarketSnapshot);
  assert.deepEqual(two.map((r) => `${r.chain}/${r.token}/${r.symbol}`), ["solana/a/B", "base/a/A"]);
});

test("chainsWithData: the chains the rows hold, in the terminal's chain order", () => {
  assert.deepEqual(chainsWithData(allRows(SNAP)), ["solana"]);
  assert.deepEqual(chainsWithData([row({ token: "x", symbol: "X", chain: "near" }), row({ token: "y", symbol: "Y", chain: "base" }), row({ token: "z", symbol: "Z" })]), ["solana", "base", "near"]);
  assert.deepEqual(chainsWithData([]), []);
});

test("addressChains: a base58 mint is Solana's, a 0x address the EVM chains', a NEAR account NEAR's; a word is none", () => {
  assert.deepEqual(addressChains(SOL), ["solana"]);
  assert.deepEqual(addressChains(`  ${SOL}\n`), ["solana"]);
  assert.deepEqual(addressChains(EVM), ["base", "robinhood"]);
  assert.deepEqual(addressChains(EVM.toUpperCase().replace("0X", "0x")), ["base", "robinhood"]);
  assert.deepEqual(addressChains("wrap.near"), ["near"]);
  assert.deepEqual(addressChains("token.v2.ref-finance.near"), ["near"]);
  assert.deepEqual(addressChains(NEAR_IMPLICIT), ["near"]);
  for (const q of ["", "bonk", "$WIF", "pump", "So1111", `${SOL}0`.repeat(2), "0x1234", `0x${"g".repeat(40)}`, "near", ".near", "a..near", "So11111111111111111111111111111111111111O12"]) assert.deepEqual(addressChains(q), [], q);
});

test("plan: an empty query searches nothing", () => {
  assert.deepEqual(plan(allRows(SNAP), "   ", "all", ["solana"]), { rows: [], reads: [] });
});

test("plan: symbol first (exact, then prefix), then name, case and a leading $ ignored", () => {
  const rows = [
    row({ token: "1", symbol: "BONKER", name: "Bonker", mc_usd: "900" }),
    row({ token: "2", symbol: "BONK", name: "Bonk", mc_usd: "10" }),
    row({ token: "3", symbol: "XYZ", name: "bonk the dog", mc_usd: "5000" }),
    row({ token: "4", symbol: "ABONK", name: "A", mc_usd: "1" }),
    row({ token: "5", symbol: "DOG", name: "Super Bonk", mc_usd: "2" }),
    row({ token: "6", symbol: "CAT", name: "catbonkcat", mc_usd: "3" }),
    row({ token: "7", symbol: "NOPE", name: "nothing", mc_usd: "99999" }),
  ];
  const syms = (q: string) => plan(rows, q, "all", ["solana"]).rows.map((r) => r.symbol);
  // exact symbol, symbol prefix, name prefix, a word of the name, symbol inside, name inside
  assert.deepEqual(syms("bonk"), ["BONK", "BONKER", "XYZ", "DOG", "ABONK", "CAT"]);
  assert.deepEqual(syms("$BONK"), syms("bonk"));
  assert.deepEqual(syms("  BoNk "), syms("bonk"));
  assert.deepEqual(syms("zzz"), []);
});

test("plan: a tie is ordered by market cap, largest first, then as listed", () => {
  const rows = [row({ token: "a", symbol: "PEPE2", mc_usd: "5" }), row({ token: "b", symbol: "PEPE1", mc_usd: "50" }), row({ token: "c", symbol: "PEPE3", mc_usd: null }), row({ token: "d", symbol: "PEPE4", mc_usd: "50" })];
  assert.deepEqual(plan(rows, "pepe", "all", ["solana"]).rows.map((r) => r.token), ["b", "d", "a", "c"]);
});

test("plan: at most LIMIT rows", () => {
  const rows = Array.from({ length: LIMIT + 7 }, (_, i) => row({ token: `t${i}`, symbol: `MOON${i}` }));
  assert.equal(plan(rows, "moon", "all", ["solana"]).rows.length, LIMIT);
});

test("plan: the recorded lists find a listed token by its symbol and by its name", () => {
  const rows = allRows(SNAP);
  for (const r of rows) {
    const bySym = plan(rows, r.symbol, "all", ["solana"]).rows;
    assert.ok(bySym.some((x) => x.token === r.token), `symbol ${r.symbol}`);
    if (r.name) assert.ok(plan(rows, r.name, "all", ["solana"]).rows.some((x) => x.token === r.token), `name ${r.name}`);
  }
});

test("plan: the chain filter keeps only that chain's rows; All keeps every chain", () => {
  const rows = [row({ token: "s", symbol: "DOGE" }), row({ token: "0xb", symbol: "DOGE", chain: "base" }), row({ token: "0xr", symbol: "DOGEX", chain: "robinhood" })];
  const chains = chainsWithData(rows);
  assert.deepEqual(plan(rows, "doge", "all", chains).rows.map((r) => r.chain), ["solana", "base", "robinhood"]);
  assert.deepEqual(plan(rows, "doge", "base", chains).rows.map((r) => r.token), ["0xb"]);
  assert.deepEqual(plan(rows, "doge", "solana", chains).rows.map((r) => r.token), ["s"]);
  assert.deepEqual(plan(rows, "doge", "near", chains).rows, []);
});

test("plan: a listed address is its row at once, with no token read", () => {
  const rows = allRows(SNAP);
  const r = rows[3]!;
  assert.deepEqual(plan(rows, r.token, "all", ["solana"]), { rows: [r], reads: [] });
  assert.deepEqual(plan(rows, ` ${r.token} `, "solana", ["solana"]), { rows: [r], reads: [] });
  // an EVM row matches whatever the address's case
  const evm = row({ token: EVM, symbol: "E", chain: "base" });
  assert.deepEqual(plan([evm], EVM.toUpperCase().replace("0X", "0x"), "all", ["base"]).rows, [evm]);
});

test("plan: an address not in the lists is the token read's, one per chain with data its form fits and the filter keeps", () => {
  const rows = allRows(SNAP);
  assert.deepEqual(plan(rows, SOL, "all", ["solana"]), { rows: [], reads: [{ chain: "solana", id: SOL }] });
  assert.deepEqual(plan(rows, SOL, "solana", ["solana"]), { rows: [], reads: [{ chain: "solana", id: SOL }] });
  // the filter on another chain, or no chain with data that the form fits: nothing to read
  assert.deepEqual(plan(rows, SOL, "base", ["solana", "base"]), { rows: [], reads: [] });
  assert.deepEqual(plan(rows, EVM, "all", ["solana"]), { rows: [], reads: [] });
  // an EVM address is read lower case on each EVM chain with data
  assert.deepEqual(plan(rows, EVM.toUpperCase().replace("0X", "0x"), "all", ["solana", "base", "robinhood"]).reads, [
    { chain: "base", id: EVM },
    { chain: "robinhood", id: EVM },
  ]);
  assert.deepEqual(plan(rows, EVM, "robinhood", ["solana", "base", "robinhood"]).reads, [{ chain: "robinhood", id: EVM }]);
});

test("idleRows: with no query, the Trending column as Discover orders it, on the filter's chain, at most LIMIT", () => {
  const want = columnRows(SNAP, "trending").slice(0, LIMIT).map((r) => r.token);
  assert.deepEqual(idleRows(SNAP, "all").map((r) => r.token), want);
  assert.deepEqual(idleRows(SNAP, "solana").map((r) => r.token), want);
  assert.deepEqual(idleRows(SNAP, "base"), []);
});

test("listsSource: the rail's lists while fresh, else one shared read kept for REFRESH_MS; never a timer", async () => {
  let t = 1_000_000;
  const reads: number[] = [];
  let rail: { data: { status: "loading" } | { status: "ready"; snapshot: MarketSnapshot }; nowMs: number } = { data: { status: "loading" }, nowMs: t };
  const src = listsSource({
    rail: () => rail,
    read: async () => {
      reads.push(t);
      return SNAP;
    },
    now: () => t,
  });
  assert.equal(src.now(), null);
  // nothing fresh: one read, its answer kept
  assert.equal(await src.get(), SNAP);
  assert.equal(reads.length, 1);
  assert.equal(src.now(), SNAP);
  t += REFRESH_MS - 1;
  await src.get();
  assert.equal(reads.length, 1, "a read under REFRESH_MS old is reused");
  t += 2;
  await src.get();
  assert.equal(reads.length, 2, "an older one is read again");
  // the rail's fresh lists win, with no read
  const railSnap = { ...SNAP, as_of_ms: 7 } as MarketSnapshot;
  t += REFRESH_MS * 3;
  rail = { data: { status: "ready", snapshot: railSnap }, nowMs: t - 10 };
  assert.equal(src.now(), railSnap);
  assert.equal(await src.get(), railSnap);
  assert.equal(reads.length, 2);
  // a failed read throws to the caller and keeps nothing new
  const failing = listsSource({ rail: () => ({ data: { status: "loading" }, nowMs: 0 }), read: async () => Promise.reject(new Error("503")), now: () => t });
  await assert.rejects(failing.get());
  assert.equal(failing.now(), null);
});
