// Every Discover row opens its token's own page (card app-token-route). The route is /token/<chain>/<id>: this file holds
// the route's parse (a chain the terminal draws, any non-empty id; anything else is refused), the href a row carries,
// and the page's read for that chain and id (GET /v1/market/token): a row that is this token's draws, an unknown id
// draws the page's not-found state (the helper answers 404), a failed read draws the error state, never another token.
// The browser side (a click on a desktop row and a phone row, a deep link inside the shell) is test/token-route/run.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HELPER_FETCH_INIT } from "@blindfill/kit";
import { parseTokenRoute, ROUTES, TOKEN_CHAINS, TOKEN_ROUTE, tokenHref } from "../src/routes/routes.ts";
import * as source from "../src/screens/token/source.ts";
import tokenRead from "./token-source/helper-token-2026-11-03.json" with { type: "json" };

type Obj = Record<string, unknown>;
const row = Object.fromEntries(tokenRead.fields.map((f, i) => [f, tokenRead.row[i]])) as Obj & { token: string; symbol: string };
const answer = { ...tokenRead.rest, row };
const MINT = row.token;

function helper(o: { body?: unknown; status?: number } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const body = o.body ?? answer;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: o.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetchFn, calls };
}

test("the route: /token/:chain/:id, one entry of the route map, drawn by the token screen", () => {
  assert.equal(TOKEN_ROUTE, "/token/:chain/:id");
  assert.deepEqual(ROUTES.filter((r) => r.path === TOKEN_ROUTE).map((r) => r.id), ["token"]);
  assert.deepEqual(ROUTES.find((r) => r.path === "/"), { id: "token", path: "/" });
});

test("parse: a chain the terminal draws and an id", () => {
  assert.deepEqual(TOKEN_CHAINS, ["solana", "base", "eip155:4663", "near"]);
  for (const chain of TOKEN_CHAINS) assert.deepEqual(parseTokenRoute({ chain, id: "abc" }), { chain, id: "abc" }, chain);
  assert.deepEqual(parseTokenRoute({ chain: "solana", id: MINT }), { chain: "solana", id: MINT });
  assert.deepEqual(parseTokenRoute({ chain: "near", id: "a-token.tkn.near" }), { chain: "near", id: "a-token.tkn.near" });
});

test("parse: a bad chain or a missing id is refused", () => {
  for (const chain of ["dogecoin", "Solana", "SOLANA", "eip155:1", "", " solana", "solana ", "__proto__", "constructor", undefined])
    assert.equal(parseTokenRoute({ chain, id: "abc" }), null, String(chain));
  for (const id of ["", undefined]) assert.equal(parseTokenRoute({ chain: "solana", id }), null, String(id));
  assert.equal(parseTokenRoute({}), null);
});

test("href: a row's link is /token/<chain>/<id>, the id encoded", () => {
  assert.equal(tokenHref("solana", MINT), `/token/solana/${MINT}`);
  assert.equal(tokenHref("eip155:4663", "0xAbC"), "/token/eip155:4663/0xAbC");
  assert.equal(tokenHref("near", "a/b?c#d.tkn.near"), "/token/near/a%2Fb%3Fc%23d.tkn.near");
  // what the href names parses back to the same token (the router decodes the segment)
  const href = tokenHref("near", "a/b?c#d.tkn.near");
  const [, , chain, id] = href.split("/");
  assert.deepEqual(parseTokenRoute({ chain, id: decodeURIComponent(id!) }), { chain: "near", id: "a/b?c#d.tkn.near" });
});

test("loadToken: reads /v1/market/token for that chain and id (and nothing else), ready with that token's row", async () => {
  const { fetchFn, calls } = helper();
  const d = await source.loadToken!("solana", MINT, fetchFn);
  assert.equal(d.status, "ready");
  assert.equal(d.status === "ready" && d.row.token, MINT);
  assert.deepEqual(calls.map((c) => c.url), [`https://api.confidential.unrealized.trade/v1/market/token?chain=solana&token=${MINT}`]);
  assert.equal(calls[0]!.init?.credentials, HELPER_FETCH_INIT.credentials);
  assert.equal(calls[0]!.init?.referrerPolicy, HELPER_FETCH_INIT.referrerPolicy);
});

test("TOKEN_URL: the chain and the id are the query, both encoded; the chain defaults to solana", () => {
  assert.equal(source.TOKEN_URL(MINT), `https://api.confidential.unrealized.trade/v1/market/token?chain=solana&token=${MINT}`);
  assert.equal(source.TOKEN_URL("0xab", "eip155:4663"), "https://api.confidential.unrealized.trade/v1/market/token?chain=eip155%3A4663&token=0xab");
});

test("loadToken: an unknown id (the helper answers 404) is the not-found state, not the error state", async () => {
  assert.deepEqual(await source.loadToken!("solana", "nope", helper({ status: 404, body: { error: { code: "not_found" } } }).fetchFn), { status: "empty" });
});

test("loadToken: a failed or wrong read is the error state, never another token", async () => {
  const other = { ...answer, row: { ...row, token: "So11111111111111111111111111111111111111112" } };
  const cases: [string, Parameters<typeof helper>[0] | "throw"][] = [
    ["503", { status: 503, body: { error: "unavailable" } }],
    ["429", { status: 429, body: "slow down" }],
    ["not JSON", { body: "nope" }],
    ["no row", { body: { ...answer, row: null } }],
    ["a row for another id", { body: other }],
    ["a row of another chain", { body: { ...answer, row: { ...row, chain: "base" } } }],
    ["a row with no symbol", { body: { ...answer, row: { ...row, symbol: "" } } }],
    ["the network refuses", "throw"],
  ];
  for (const [name, o] of cases) {
    const fetchFn: typeof fetch = o === "throw" ? async () => Promise.reject(new TypeError("Failed to fetch")) : helper(o).fetchFn;
    assert.deepEqual(await source.loadToken!("solana", MINT, fetchFn), { status: "error" }, name);
  }
});

test("the token route reads the address: Screen.tsx and TokenPage.tsx", () => {
  const page = readFileSync(new URL("../src/screens/token/TokenPage.tsx", import.meta.url), "utf8");
  assert.match(page, /useParams/);
  assert.match(page, /parseTokenRoute/);
});

test("Discover: a row is a link to its token (desktop and phone), the whole row the target", () => {
  const src = readFileSync(new URL("../src/screens/discover/Discover.tsx", import.meta.url), "utf8");
  assert.match(src, /<Link[^>]*className="dsc-row"/);
  assert.match(src, /<Link[^>]*className="dsc-prow"/);
  assert.equal([...src.matchAll(/tokenHref\(/g)].length, 2);
});
