// Opening the app shows a real token, never a test one (card app-no-test-token). The token route (/) reads the
// helper's lists, takes the top of Discover's Trending column, then reads that token's page answer; a failed or wrong
// read is the error state, never a token. What ships (every module src/main.tsx reaches) holds no fixture: no module
// under test/, no fixtures file, no fixture id and no `fx` switch in the address bar.
// test/discover-data/helper-lists-2026-11-01.json and test/token-source/helper-token-2026-11-03.json are recorded
// answers of GET /v1/market/lists?chain=solana and GET /v1/market/token for the top of that recording's Trending column.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HELPER_FETCH_INIT } from "@blindfill/kit";
import { HELPER_URL } from "../src/screens/discover/data.ts";
import { columnRows } from "../src/screens/discover/model.ts";
import type { MarketSnapshot } from "../src/screens/discover/fields.ts";
import * as source from "../src/screens/token/source.ts";
import lists from "./discover-data/helper-lists-2026-11-01.json" with { type: "json" };
import tokenRead from "./token-source/helper-token-2026-11-03.json" with { type: "json" };

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(APP, "src");

type Obj = Record<string, unknown>;
const unzip = (values: readonly unknown[]): Obj => Object.fromEntries(lists.fields.map((f, i) => [f, values[i]]));
const listsAnswer = () => ({ chain: lists.chain, as_of_ms: lists.as_of_ms, lists: Object.fromEntries(Object.entries(lists.lists).map(([k, rows]) => [k, rows.map(unzip)])) as Record<string, Obj[]> });
/** The recorded token answer as the helper sends it: the row an object of the recorded fields. */
const token = { answer: { ...tokenRead.rest, row: Object.fromEntries(tokenRead.fields.map((f, i) => [f, tokenRead.row[i]])) as Obj & { token: string; symbol: string } } };
const TOP = token.answer.row.token;

/** A fetch that answers the lists URL and one token URL from the given bodies, and records every URL it was asked. */
function helper(o: { lists?: unknown; listsStatus?: number; token?: unknown; tokenStatus?: number } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const send = (body: unknown, status: number) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === HELPER_URL) return send(o.lists ?? listsAnswer(), o.listsStatus ?? 200);
    if (url.startsWith("https://ct-api.unrealized.trade/v1/market/token?")) return send(o.token ?? token.answer, o.tokenStatus ?? 200);
    throw new TypeError(`no such host: ${url}`);
  };
  return { fetchFn, calls };
}

const load = (fetchFn: typeof fetch) => {
  assert.equal(typeof source.loadTopToken, "function", "source.ts exports loadTopToken (the live read), not a fixture switch");
  return source.loadTopToken!(fetchFn);
};

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
  assert.deepEqual(calls.map((c) => c.url), [HELPER_URL, `https://ct-api.unrealized.trade/v1/market/token?chain=solana&token=${TOP}`]);
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
  assert.equal(calls[1]!.url.endsWith(`token=${second.token}`), true);
});

test("loadTopToken: an empty Trending column is the empty state, and no token is read", async () => {
  const a = listsAnswer();
  a.lists.trending = [];
  a.lists.trending_1h = [];
  const { fetchFn, calls } = helper({ lists: a });
  assert.deepEqual(await load(fetchFn), { status: "empty" });
  assert.equal(calls.length, 1);
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
