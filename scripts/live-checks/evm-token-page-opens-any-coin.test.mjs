// node --test scripts/live-checks/evm-token-page-opens-any-coin.test.mjs: the live check replays recorded answers
// (evm-token-page-opens-any-coin.answers.json). good: apps/helper at card/evm-token-page-opens-any-coin run on a Mac
// against the real DexScreener, GeckoTerminal and public RPCs: PASS; good_lists_down, the final commit's run with
// Robinhood's lists 503 at the read: PASS. bad_deployed: the deployed helper f166289d0 before
// the card, MOW's and DEGEN's page and holders 404 and DEGEN's chart and tape 404: FAIL. Made from the good answer: a
// coin's page 404 or 503, a page for another token, a chart that is not a list of bars, an address that is no coin
// answered 200, no CORS echo: each FAIL. The lists' bodies are cut to each row's token, the one field the check reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROW_FIELDS as TERMINAL_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";
import { HOLDERS_FIELDS, PAGE_FIELDS } from "../../apps/helper/src/data/solana/token.ts";
import { COINS, HOLDERS, judge, NOT_COINS, PAGE, read, READS, ROW } from "./evm-token-page-opens-any-coin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "evm-token-page-opens-any-coin.answers.json"), "utf8"));
const BASE = "https://ct-api.unrealized.trade";

/** A fetch that answers each asked path with the recorded reads of it, in their order, after checking the Origin. */
const replay = (rec) => {
  const byPath = new Map();
  const add = (p, r) => byPath.set(p, [...(byPath.get(p) ?? []), r]);
  for (const c of COINS) {
    const x = rec.coins[c.chain];
    for (const k of ["lists", "token", "holders", "candles", "trades"]) for (const r of Array.isArray(x[k]) ? x[k] : [x[k]]) add(k === "lists" ? READS.lists(c.chain) : READS[k](c.chain, c.address), r);
  }
  for (const n of rec.not) add(READS.token(n.chain, n.address), n.read);
  return async (url, init) => {
    assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
    const q = byPath.get(url.slice(BASE.length));
    assert.ok(url.startsWith(BASE) && q !== undefined && q.length > 0, `unexpected ${url}`);
    const r = q.shift();
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
  };
};
const run = async (rec) => judge(await read(BASE, replay(rec), async () => {}));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good run with one coin's read edited (the last of its reads, for a chart or tape read again). */
const edit = (chain, k, fn, headers, status) => {
  const rec = structuredClone(A.good.run);
  const x = rec.coins[chain][k];
  const r = Array.isArray(x) ? x.at(-1) : x;
  if (fn) r.body = JSON.stringify(fn(JSON.parse(r.body)) ?? JSON.parse(r.body));
  if (headers) Object.assign(r.headers, headers);
  if (status !== undefined) r.status = status;
  return rec;
};

test("the pinned fields are the helper's own and the terminal's Row; the coins are the card's two", () => {
  assert.deepEqual(ROW, [...TERMINAL_FIELDS]);
  assert.deepEqual(PAGE, [...PAGE_FIELDS]);
  assert.deepEqual(HOLDERS, [...HOLDERS_FIELDS]);
  assert.deepEqual(COINS.map((c) => `${c.chain} ${c.symbol}`), ["robinhood MOW", "base DEGEN"]);
  assert.equal(NOT_COINS.length, 2);
});

test("good: the branch helper's recorded run PASSes, both coins on no list at the read", async () => {
  const r = await run(A.good.run);
  assert.deepEqual(bad(r), []);
  assert.equal(r.ok, true);
  for (const c of COINS) assert.ok(r.lines.includes(`--  ${c.chain} ${c.symbol}: on no list at the read`), c.symbol);
});

test("good_lists_down: the final branch helper with Robinhood's lists 503 still opens MOW: PASS", async () => {
  const r = await run(A.good_lists_down.run);
  assert.deepEqual(bad(r), []);
  assert.ok(r.lines.includes("--  robinhood MOW: lists answered 503"));
});

test("bad_deployed: the helper before the card (the coins' page and holders 404) FAILs, naming each", async () => {
  const r = await run(A.bad_deployed.run);
  assert.equal(r.ok, false);
  for (const c of COINS)
    for (const k of ["token", "holders"]) assert.ok(bad(r).some((l) => l.startsWith(`BAD ${c.chain} ${c.symbol} ${k}: `) && l.includes("answers 404")), `${c.symbol} ${k}`);
  assert.ok(bad(r).some((l) => l.startsWith("BAD base DEGEN candles: ")));
  assert.ok(bad(r).some((l) => l.startsWith("BAD base DEGEN trades: ")));
});

test("made from the good answer: each fault FAILs, naming it", async () => {
  const cases = [
    [edit("robinhood", "token", undefined, undefined, 404), /BAD robinhood MOW token: .*answers 404/],
    [edit("base", "token", undefined, undefined, 503), /BAD base DEGEN token: .*answers 503/],
    [edit("base", "token", (b) => ((b.row.token = COINS[0].address), b)), /BAD base DEGEN token: .*row names/],
    [edit("robinhood", "token", (b) => (delete b.links, b)), /BAD robinhood MOW token: .*page fields/],
    [edit("base", "holders", (b) => (delete b.top_bps, b)), /BAD base DEGEN holders: .*holders fields/],
    [edit("robinhood", "candles", () => ({ tf: "1m" })), /BAD robinhood MOW candles: .*no candles list/],
    [edit("base", "trades", undefined, undefined, 404), /BAD base DEGEN trades: .*answers 404/],
    [edit("base", "candles", undefined, { "access-control-allow-origin": "*" }), /BAD base candles Access-Control-Allow-Origin/],
    [edit("robinhood", "token", undefined, { "x-helper-commit": "f166289" }), /BAD robinhood token X-Helper-Commit/],
  ];
  const notCoin = structuredClone(A.good.run);
  notCoin.not[0].read = { ...notCoin.not[0].read, status: 200, body: "{}" };
  cases.push([notCoin, /BAD base 0x0{39}1 \(no coin\): .*answers 200/]);
  for (const [rec, want] of cases) {
    const r = await run(rec);
    assert.equal(r.ok, false, String(want));
    assert.ok(bad(r).some((l) => want.test(l)), `${want}: ${bad(r).join(" | ")}`);
  }
});
