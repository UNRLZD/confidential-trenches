// Opening the app shows a real token, never a test one (card app-no-test-token). The token route (/) reads the
// helper's lists, takes the top of Discover's Trending column, then reads that token's page answer; a failed or wrong
// read is the error state, never a token. What ships (every module src/main.tsx reaches) holds no fixture: no module
// under test/, no fixtures file, no fixture id and no `fx` switch in the address bar.
// Since card app-chains-evm-rail / reads every chain's lists and takes the top on the shell's chain filter, on its own chain.
// test/discover-data/helper-lists-2026-11-01.json and test/token-source/helper-token-2026-11-03.json are recorded
// answers of GET /v1/market/lists?chain=solana and GET /v1/market/token for the top of that recording's Trending column;
// test/chains-evm/{lists,token}-{base,robinhood}-2026-11-09.json the same for Base and Robinhood.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HELPER_FETCH_INIT } from "@blindfill/kit";
import { allListsReader, HELPER_URL, listsUrl, mergeLists } from "../src/screens/discover/data.ts";
import { columnRows } from "../src/screens/discover/model.ts";
import type { MarketSnapshot } from "../src/screens/discover/fields.ts";
import * as source from "../src/screens/token/source.ts";
import lists from "./discover-data/helper-lists-2026-11-01.json" with { type: "json" };
import tokenRead from "./token-source/helper-token-2026-11-03.json" with { type: "json" };
import baseLists from "./chains-evm/lists-base-2026-11-09.json" with { type: "json" };
import robinhoodLists from "./chains-evm/lists-robinhood-2026-11-09.json" with { type: "json" };
import baseToken from "./chains-evm/token-base-2026-11-09.json" with { type: "json" };
import robinhoodToken from "./chains-evm/token-robinhood-2026-11-09.json" with { type: "json" };

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(APP, "src");

type Obj = Record<string, unknown>;
const unzip = (values: readonly unknown[]): Obj => Object.fromEntries(lists.fields.map((f, i) => [f, values[i]]));
const listsAnswer = () => ({ chain: lists.chain, as_of_ms: lists.as_of_ms, lists: Object.fromEntries(Object.entries(lists.lists).map(([k, rows]) => [k, rows.map(unzip)])) as Record<string, Obj[]> });
/** The recorded token answer as the helper sends it: the row an object of the recorded fields. */
const token = { answer: { ...tokenRead.rest, row: Object.fromEntries(tokenRead.fields.map((f, i) => [f, tokenRead.row[i]])) as Obj & { token: string; symbol: string } } };
const TOP = token.answer.row.token;

type Rec = { chain: string; as_of_ms: number; fields: string[]; lists: Record<string, unknown[][]> };
const listsOf = (rec: Rec) => ({ chain: rec.chain, as_of_ms: rec.as_of_ms, lists: Object.fromEntries(Object.entries(rec.lists).map(([k, rows]) => [k, rows.map((v) => Object.fromEntries(rec.fields.map((f, i) => [f, v[i]])))])) });
const tokenOf = (t: { fields: string[]; row: unknown[]; rest: Obj }) => ({ ...t.rest, row: Object.fromEntries(t.fields.map((f, i) => [f, t.row[i]])) as Obj & { token: string; symbol: string; chain: string } });
/** Base's and Robinhood's recorded lists and a recorded token answer of each. */
const EVM = { base: { lists: listsOf(baseLists as Rec), token: tokenOf(baseToken) }, robinhood: { lists: listsOf(robinhoodLists as Rec), token: tokenOf(robinhoodToken) } };

/** A fetch that answers Solana's lists URL and one token URL from the given bodies, and records every URL it was asked;
 *  `evm` answers Base's and Robinhood's lists and token reads from their recordings too (else those chains fail). */
function helper(o: { lists?: unknown; listsStatus?: number; token?: unknown; tokenStatus?: number; evm?: boolean } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const send = (body: unknown, status: number) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const chain = new URL(url).searchParams.get("chain");
    if (o.evm && (chain === "base" || chain === "robinhood")) {
      const e = EVM[chain];
      if (url === listsUrl(chain)) return send(e.lists, 200);
      // the recorded token answer, its row named as the token asked (a row of that chain's lists)
      const id = new URL(url).searchParams.get("token") ?? "";
      const listed = Object.values(e.lists.lists).flat().find((r) => r.token === id);
      if (url === source.TOKEN_URL(id, chain) && listed) return send({ ...e.token, row: { ...e.token.row, token: id, symbol: listed.symbol } }, 200);
      return send({ error: { code: "not_found" } }, 404);
    }
    if (url === HELPER_URL) return send(o.lists ?? listsAnswer(), o.listsStatus ?? 200);
    if (url.startsWith("https://ct-api.unrealized.trade/v1/market/token?chain=solana&")) return send(o.token ?? token.answer, o.tokenStatus ?? 200);
    throw new TypeError(`no such host: ${url}`);
  };
  return { fetchFn, calls };
}

/** loadTopToken on its own reader of every chain's lists (no lists held from another test), on the pick. */
const load = (fetchFn: typeof fetch, pick: Parameters<typeof source.loadTopToken>[1] = "all") => {
  assert.equal(typeof source.loadTopToken, "function", "source.ts exports loadTopToken (the live read), not a fixture switch");
  return source.loadTopToken!(fetchFn, pick, allListsReader());
};
const LISTS_URLS = ["solana", "base", "robinhood"].map((c) => listsUrl(c as "solana"));

// ---------------------------------------------------------------------------------------------- what ships
/** Every module of src/ that src/main.tsx reaches through relative imports (static, re-exports and dynamic). */
function shipped(): Map<string, string> {
  const seen = new Map<string, string>();
  const todo = [path.join(SRC, "main.tsx")];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const to = path.resolve(path.dirname(file), m[1]!);
      if (/\.(tsx?|mjs|js)$/.test(to) && existsSync(to)) todo.push(to);
    }
  }
  return seen;
}

/** The fixture ids and names: the token page's four ids, its source tag and the word itself, any case. */
const FIXTURE = /fixture/i;
const FX = /["'`]fx["'`]|[?&]fx=/;

test("what ships: no module src/main.tsx reaches sits under test/, is a fixtures file, or holds a fixture id or name", () => {
  const files = shipped();
  assert.ok(files.size > 20, `the walk reached ${files.size} modules`);
  const bad: string[] = [];
  for (const [file, text] of files) {
    const rel = path.relative(APP, file);
    if (!rel.startsWith(`src${path.sep}`)) bad.push(`${rel}: outside src/`);
    if (/fixtures?\.(tsx?|json)$/.test(file)) bad.push(`${rel}: a fixtures file`);
    // string literals only: a context named Fixture (the screen tests' injection point) is an identifier the build renames
    for (const s of text.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) if (FIXTURE.test(s[0])) bad.push(`${rel}: string ${s[0].slice(0, 60)}`);
  }
  assert.deepEqual(bad, []);
});

test("what ships: no module reads an fx switch from the address bar", () => {
  const bad = [...shipped()].filter(([, text]) => FX.test(text)).map(([f]) => path.relative(APP, f));
  assert.deepEqual(bad, []);
});

test("src/ holds no fixtures file at all (they live under test/)", () => {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /fixtures?\./.test(e.name) ? [path.relative(APP, path.join(d, e.name))] : []));
  assert.deepEqual(walk(SRC), []);
});

// ---------------------------------------------------------------------------------------------- the live read
test("loadTopToken: the lists, then /v1/market/token for the top of the Trending column; ready with that token's row", async () => {
  const snap = listsAnswer() as unknown as MarketSnapshot;
  assert.equal(columnRows(snap, "trending")[0]!.token, TOP, "the recorded token answer is the recorded lists' top Trending token");
  const { fetchFn, calls } = helper();
  const d = await load(fetchFn);
  assert.equal(d.status, "ready");
  assert.equal(d.status === "ready" && d.row.token, TOP);
  assert.equal(d.status === "ready" && d.row.symbol, token.answer.row.symbol);
  assert.deepEqual(calls.map((c) => c.url), [...LISTS_URLS, `https://ct-api.unrealized.trade/v1/market/token?chain=solana&token=${TOP}`]);
  for (const c of calls) {
    assert.equal(c.init?.credentials, HELPER_FETCH_INIT.credentials);
    assert.equal(c.init?.referrerPolicy, HELPER_FETCH_INIT.referrerPolicy);
  }
});

test("loadTopToken: the top follows the lists (a different top Trending token is the one read)", async () => {
  const a = listsAnswer();
  const second = columnRows(a as unknown as MarketSnapshot, "trending")[1]!;
  // the recorded top drops out of the hour's list: the next one is the top
  a.lists.trending_1h = a.lists.trending_1h!.filter((r) => r.token !== TOP);
  a.lists.trending = a.lists.trending!.filter((r) => r.token !== TOP);
  const row = { ...token.answer.row, token: second.token, symbol: second.symbol };
  const { fetchFn, calls } = helper({ lists: a, token: { ...token.answer, row } });
  const d = await load(fetchFn);
  assert.equal(d.status === "ready" && d.row.token, second.token);
  assert.equal(calls[3]!.url.endsWith(`token=${second.token}`), true);
});

test("loadTopToken: an empty Trending column is the empty state, and no token is read", async () => {
  const a = listsAnswer();
  a.lists.trending = [];
  a.lists.trending_1h = [];
  const { fetchFn, calls } = helper({ lists: a });
  assert.deepEqual(await load(fetchFn), { status: "empty" });
  assert.equal(calls.length, 3, "the three lists reads, no token read");
});

test("loadTopToken: on All the top of every chain's merged Trending column (Discover's order), read on its own chain", async () => {
  const merged = mergeLists([listsAnswer(), EVM.base.lists, EVM.robinhood.lists] as unknown as MarketSnapshot[]);
  const top = columnRows(merged, "trending")[0]!;
  const { fetchFn, calls } = helper({ evm: true });
  const d = await load(fetchFn, "all");
  assert.equal(d.status, "ready");
  assert.equal(d.status === "ready" && d.row.token, top.token);
  assert.equal(d.status === "ready" && d.row.chain, top.chain);
  assert.equal(calls.at(-1)!.url, source.TOKEN_URL(top.token, top.chain));
});

test("loadTopToken: on a pick, that chain's top Trending token, read on that chain; never another chain's", async () => {
  for (const c of ["base", "robinhood"] as const) {
    const top = columnRows(EVM[c].lists as unknown as MarketSnapshot, "trending")[0]!;
    const { fetchFn, calls } = helper({ evm: true });
    const d = await load(fetchFn, c);
    assert.equal(d.status === "ready" && d.row.token, top.token, c);
    assert.equal(d.status === "ready" && d.row.chain, c, c);
    assert.equal(calls.at(-1)!.url, source.TOKEN_URL(top.token, c), c);
  }
  const { fetchFn } = helper({ evm: true });
  const d = await load(fetchFn, "solana");
  assert.equal(d.status === "ready" && d.row.token, TOP, "solana: Solana's own top");
  // a pick whose chain answered nothing is the empty state, never another chain's token
  const { fetchFn: solOnly } = helper();
  assert.deepEqual(await load(solOnly, "base"), { status: "empty" });
});

test("loadTopToken: every failed or wrong read is the error state, never a token", async () => {
  const other = { ...token.answer, row: { ...token.answer.row, token: "So11111111111111111111111111111111111111112" } };
  const cases: [string, Parameters<typeof helper>[0] | "throw"][] = [
    ["lists 503", { listsStatus: 503 }],
    ["lists not JSON", { lists: "<html>" }],
    ["lists of another chain", { lists: { ...listsAnswer(), chain: "base" } }],
    ["the network refuses", "throw"],
    ["token 503", { tokenStatus: 503 }],
    ["token 404", { tokenStatus: 404 }],
    ["token not JSON", { token: "nope" }],
    ["token answer without a row", { token: { ...token.answer, row: null } }],
    ["token row for another mint", { token: other }],
    ["token row with no symbol", { token: { ...token.answer, row: { ...token.answer.row, symbol: "" } } }],
    ["token row of another chain", { token: { ...token.answer, row: { ...token.answer.row, chain: "base" } } }],
  ];
  for (const [name, o] of cases) {
    const fetchFn: typeof fetch = o === "throw" ? async () => Promise.reject(new TypeError("Failed to fetch")) : helper(o).fetchFn;
    assert.deepEqual(await load(fetchFn), { status: "error" }, name);
  }
});

test("TOKEN_URL: the helper's token read for a Solana mint, the mint encoded", () => {
  assert.equal(typeof source.TOKEN_URL, "function");
  assert.equal(source.TOKEN_URL!(TOP), `https://ct-api.unrealized.trade/v1/market/token?chain=solana&token=${TOP}`);
  assert.equal(source.TOKEN_URL!("a&b=c"), "https://ct-api.unrealized.trade/v1/market/token?chain=solana&token=a%26b%3Dc");
});
