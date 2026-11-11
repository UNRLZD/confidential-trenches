// node --test scripts/live-checks/helper-near-lists-and-token.test.mjs: the live check replays recorded answers
// (helper-near-lists-and-token.answers.json). good: apps/helper at this card run on a Mac on mainnet's public reads:
// PASS. bad_not_deployed: the deployed helper before this card, chain=near 404: FAIL. Made from the good answer: a row
// of another chain, a page missing a field, a trade with an extra field, a bar of five values, the account with no pool
// answered 200, a stale read and no CORS echo: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROW_FIELDS as TERMINAL_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";
import { HOLDERS_FIELDS, PAGE_FIELDS, RISK_FIELDS } from "../../apps/helper/src/data/solana/token.ts";
import { HOLDERS, judge, PAGE, pick, read, READS, RISK, ROW, UNLISTED } from "./helper-near-lists-and-token.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-near-lists-and-token.answers.json"), "utf8"));
const BASE = "https://ct-api.unrealized.trade";

const replay = (rec) => async (url, init) => {
  assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
  const r = rec.reads;
  const row = r.lists.status === 200 ? pick(JSON.parse(r.lists.body)) : null;
  const paths = [["lists", READS.lists()], ...(row ? [["token", READS.token(row.token)], ["holders", READS.holders(row.token)], ["trades", READS.trades(row.token)], ["candles", READS.candles(row.token)], ["unlisted", READS.token(UNLISTED)]] : [])];
  for (const [k, p] of paths) if (url === `${BASE}${p}`) return new Response(r[k].body, { status: r[k].status, headers: r[k].headers });
  assert.fail(`unexpected ${url}`);
};
const run = async (rec) => {
  const r = await read(undefined, replay(rec));
  r.readAt = rec.readAt;
  for (const k of Object.keys(r.reads)) r.reads[k].at = rec.reads[k].at;
  return judge(r);
};
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (k, fn, headers, status) => {
  const rec = structuredClone(A.good.run);
  const c = rec.reads[k];
  if (fn) {
    const b = JSON.parse(c.body);
    fn(b);
    c.body = JSON.stringify(b);
  }
  if (headers) Object.assign(c.headers, headers);
  if (status !== undefined) c.status = status;
  return rec;
};

test("the pinned lists are the helper's own and the terminal's Row", () => {
  assert.deepEqual(ROW, [...TERMINAL_FIELDS]);
  assert.deepEqual(PAGE, [...PAGE_FIELDS]);
  assert.deepEqual(RISK, [...RISK_FIELDS]);
  assert.deepEqual(HOLDERS, [...HOLDERS_FIELDS]);
});

test("good: the helper at this card answers every NEAR read in the frozen fields: PASS", async () => {
  const r = await run(A.good.run);
  assert.deepEqual(bad(r), []);
  assert.equal(r.ok, true);
});

test("bad_not_deployed: the helper before this card answers chain=near 404: FAIL", async () => {
  const r = await run(A.bad_not_deployed.run);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes("lists?chain=near answers 404")));
});

for (const [name, rec, want] of [
  ["a list row of another chain", () => edit("lists", (b) => (b.lists.new[0].chain = "base")), /chain "base"/],
  ["a page missing a field", () => edit("token", (b) => delete b.filling), /page: not the page fields/],
  ["a trade with an extra field", () => edit("trades", (b) => (b.trades[0].extra = 1)), /trade /],
  ["a bar of five values", () => edit("candles", (b) => b.candles[0].pop()), /bar /],
  ["the account with no pool answered 200", () => edit("unlisted", null, null, 200), /no Rhea pool\) answers 200/],
  ["a read dated an hour before", () => edit("trades", null, { "x-fetched-at": new Date(Date.parse(A.good.run.reads.trades.at) - 3_600_000).toISOString() }), /trades X-Fetched-At/],
  ["no CORS echo", () => edit("token", null, { "access-control-allow-origin": "*" }), /token Access-Control-Allow-Origin/],
]) {
  test(`${name}: FAIL`, async () => {
    const r = await run(rec());
    assert.equal(r.ok, false);
    assert.ok(bad(r).some((l) => want.test(l)), bad(r).join("\n"));
  });
}
