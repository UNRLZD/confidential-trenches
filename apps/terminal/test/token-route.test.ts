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
  assert.deepEqual(TOKEN_CHAINS, ["solana", "base", "robinhood", "near"]);
  for (const chain of TOKEN_CHAINS) assert.deepEqual(parseTokenRoute({ chain, id: "abc" }), { chain, id: "abc" }, chain);
  assert.deepEqual(parseTokenRoute({ chain: "solana", id: MINT }), { chain: "solana", id: MINT });
  assert.deepEqual(parseTokenRoute({ chain: "near", id: "a-token.tkn.near" }), { chain: "near", id: "a-token.tkn.near" });
});

test("parse: a bad chain or a missing id is refused", () => {
  for (const chain of ["dogecoin", "Solana", "SOLANA", "eip155:1", "eip155:4663", "", " solana", "solana ", "__proto__", "constructor", undefined])
    assert.equal(parseTokenRoute({ chain, id: "abc" }), null, String(chain));
  for (const id of ["", undefined]) assert.equal(parseTokenRoute({ chain: "solana", id }), null, String(id));
  assert.equal(parseTokenRoute({}), null);
});

test("href: a row's link is /token/<chain>/<id>, the id encoded", () => {
  assert.equal(tokenHref("solana", MINT), `/token/solana/${MINT}`);
  assert.equal(tokenHref("robinhood", "0xAbC"), "/token/robinhood/0xAbC");
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
  assert.deepEqual(calls.map((c) => c.url), [`https://ct-api.unrealized.trade/v1/market/token?chain=solana&token=${MINT}`]);
  assert.equal(calls[0]!.init?.credentials, HELPER_FETCH_INIT.credentials);
  assert.equal(calls[0]!.init?.referrerPolicy, HELPER_FETCH_INIT.referrerPolicy);
});

test("TOKEN_URL: the chain and the id are the query, both encoded; the chain defaults to solana", () => {
  assert.equal(source.TOKEN_URL(MINT), `https://ct-api.unrealized.trade/v1/market/token?chain=solana&token=${MINT}`);
  assert.equal(source.TOKEN_URL("0xab", "robinhood"), "https://ct-api.unrealized.trade/v1/market/token?chain=robinhood&token=0xab");
});

test("loadToken on NEAR: GET /v1/market/token?chain=near&token=<account id>, ready with that token's row; a row of another id or chain is the error state", async () => {
  for (const id of ["token.rhealab.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"]) {
    const near = { ...answer, row: { ...row, chain: "near", token: id } };
    const { fetchFn, calls } = helper({ body: near });
    const d = await source.loadToken!("near", id, fetchFn);
    assert.equal(d.status === "ready" && d.row.token, id);
    assert.equal(d.status === "ready" && d.row.chain, "near");
    assert.deepEqual(calls.map((c) => c.url), [`https://ct-api.unrealized.trade/v1/market/token?chain=near&token=${id}`]);
    assert.deepEqual(parseTokenRoute({ chain: "near", id }), { chain: "near", id });
    assert.deepEqual(await source.loadToken!("near", id, helper({ body: { ...near, row: { ...near.row, token: "wrap.near" } } }).fetchFn), { status: "error" });
    assert.deepEqual(await source.loadToken!("near", id, helper({ body: { ...near, row: { ...near.row, chain: "base" } } }).fetchFn), { status: "error" });
    assert.deepEqual(await source.loadToken!("near", id, helper({ status: 404, body: { error: { code: "not_found" } } }).fetchFn), { status: "empty" });
  }
});

test("loadToken: an unknown id (the helper answers 404) is the not-found state, not the error state", async () => {
  assert.deepEqual(await source.loadToken!("solana", "nope", helper({ status: 404, body: { error: { code: "not_found" } } }).fetchFn), { status: "empty" });
});

test("loadToken: a refusal (another status, a body that is not this token's row) is the error state at once, never another token", async () => {
  const other = { ...answer, row: { ...row, token: "So11111111111111111111111111111111111111112" } };
  const cases: [string, Parameters<typeof helper>[0]][] = [
    ["400", { status: 400, body: { error: "bad id" } }],
    ["403", { status: 403, body: { error: "origin" } }],
    ["not JSON", { body: "nope" }],
    ["no row", { body: { ...answer, row: null } }],
    ["a row for another id", { body: other }],
    ["a row of another chain", { body: { ...answer, row: { ...row, chain: "base" } } }],
    ["a row with no symbol", { body: { ...answer, row: { ...row, symbol: "" } } }],
  ];
  for (const [name, o] of cases) {
    const c = still();
    const { fetchFn, calls } = helper(o);
    assert.deepEqual(await source.loadToken!("solana", MINT, fetchFn, c), { status: "error" }, name);
    assert.equal(calls.length, 1, `${name}: read once`);
    assert.deepEqual(c.waits, [], `${name}: no wait`);
  }
});

// Card app-token-page-rides-out-a-slow-token-read: merge group 44618685462 drew /token/robinhood/<cbBTC> in the error
// state after one token read the helper did not answer in 10 s, never read again. A clock handed in (ReadDeps): `sleep`
// and a read the helper never answers move it, nothing else does.
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
    /** A read the helper never answers: its whole wait passes, then the read's own timeout ends it. */
    hang: async (): Promise<Response> => {
      t += timeouts.at(-1)!;
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
  };
}

test("loadToken: a read with no answer, a 5xx or a 429 is read again with backoff, and the page opens on the answer", async () => {
  const c = still();
  const urls: string[] = [];
  const answers: (() => Promise<Response>)[] = [
    c.hang,
    async () => Promise.reject(new TypeError("Failed to fetch")),
    async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
    async () => new Response("slow down", { status: 429 }),
    async () => new Response(JSON.stringify(answer), { status: 200 }),
  ];
  const fetchFn: typeof fetch = async (input) => (urls.push(String(input)), answers[urls.length - 1]!());
  const d = await source.loadToken!("solana", MINT, fetchFn, c);
  assert.equal(d.status, "ready");
  assert.equal(d.status === "ready" && d.row.token, MINT);
  assert.deepEqual(urls, Array(5).fill(source.TOKEN_URL(MINT)), "the same read, five times");
  assert.deepEqual(c.waits, [500, 1_000, 2_000, 4_000], "the waits back off");
  assert.ok(c.now() <= source.READY_MS!, `opened at ${c.now()} ms, inside READY_MS`);
});

test("loadToken: a helper that never answers is read again inside READY_MS, then the error state, never past it", async () => {
  const c = still();
  let n = 0;
  const d = await source.loadToken!("robinhood", "0xcec185eb182c47d1ba1efc84e6959e18cd620be4", async () => (n++, c.hang()), c);
  assert.deepEqual(d, { status: "error" });
  assert.deepEqual(c.timeouts, [source.TIMEOUT_MS, source.READY_MS! - source.TIMEOUT_MS! - 500], "the second read waits what READY_MS has left");
  assert.equal(n, 2);
  assert.equal(c.now(), source.READY_MS);
});

test("loadToken: 5xx, 429 and network failures on every read are the error state once READY_MS has no room for another read", async () => {
  const cases: [string, () => Promise<Response>][] = [
    ["503", async () => new Response("{}", { status: 503 })],
    ["502", async () => new Response("<html>", { status: 502 })],
    ["429", async () => new Response("slow down", { status: 429 })],
    ["the network refuses", async () => Promise.reject(new TypeError("Failed to fetch"))],
  ];
  for (const [name, answer] of cases) {
    const c = still();
    let n = 0;
    assert.deepEqual(await source.loadToken!("solana", MINT, async () => (n++, answer()), c), { status: "error" }, name);
    assert.ok(n > 1, `${name}: read ${n} time(s)`);
    assert.ok(c.now() <= source.READY_MS! - source.MIN_READ_MS!, `${name}: the last read started at ${c.now()} ms, with a read's room left`);
  }
});

test("loadToken: a closed page reads no more (its signal stops the reads again)", async () => {
  const c = still();
  const closed = new AbortController();
  let n = 0;
  const d = await source.loadToken!("solana", MINT, async () => (n++, closed.abort(), new Response("{}", { status: 503 })), { ...c, signal: closed.signal });
  assert.deepEqual(d, { status: "error" });
  assert.equal(n, 1);
  assert.deepEqual(c.waits, []);
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
