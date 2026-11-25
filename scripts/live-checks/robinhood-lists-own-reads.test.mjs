// node --test scripts/live-checks/robinhood-lists-own-reads.test.mjs: the live check replays recorded answers
// (robinhood-lists-own-reads.answers.json). good: the branch's lists on DexScreener's recorded pairs of the 40 busiest
// Robinhood pools: PASS. bad_deployed: the deployed helper before the card, its Trending 5m and 1h GeckoTerminal's:
// FAIL. Made from the good answer: a WETH row, a row listed twice, two rows out of volume order, a row under LIQ_MIN_USD,
// a row read past STALE_MS, a list too short, a 503: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP, judge, QUOTES, read } from "./robinhood-lists-own-reads.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "robinhood-lists-own-reads.answers.json"), "utf8"));
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good answer with `edit` made to its parsed body. */
const edited = (edit) => {
  const s = JSON.parse(A.good.answer.body);
  edit(s);
  return { ...A.good.answer, body: JSON.stringify(s) };
};

test("the recorded good answer passes, through read as the check runs it", async () => {
  const fetchFn = async (url, init) => {
    assert.equal(url, "https://ct-api.unrealized.trade/v1/market/lists?chain=robinhood");
    assert.equal(init.headers.origin, APP);
    return new Response(A.good.answer.body, { status: 200, headers: { date: A.good.answer.date } });
  };
  const r = judge(await read(undefined, fetchFn));
  assert.deepEqual(bads(r), []);
  assert.equal(r.ok, true);
  assert.equal(r.lines.filter((l) => l.startsWith("GOOD")).length, 2);
});

test("the deployed helper before the card fails: its trending rows are GeckoTerminal's", () => {
  const r = judge(A.bad_deployed.answer);
  assert.equal(r.ok, false);
  assert.ok(bads(r).some((l) => /src "geckoterminal"/.test(l)));
});

test("each planted fault fails the check", () => {
  const cases = {
    "a WETH row": (s) => s.lists.trending_1h.splice(1, 0, { ...s.lists.trending_1h[1], token: [...QUOTES][0], symbol: "WETH" }),
    "a row listed twice": (s) => s.lists.trending_5m.push({ ...s.lists.trending_5m.at(-1) }),
    "two rows out of order": (s) => ([s.lists.trending_1h[0], s.lists.trending_1h[1]] = [s.lists.trending_1h[1], s.lists.trending_1h[0]]),
    "a row under LIQ_MIN_USD": (s) => (s.lists.trending_5m[2].liq_usd = "999"),
    "a row read past STALE_MS": (s) => (s.lists.trending_1h[3].as_of_ms -= 600_000),
    "a list too short": (s) => (s.lists.trending_5m = s.lists.trending_5m.slice(0, 2)),
    "a GeckoTerminal row": (s) => (s.lists.trending_5m[0].src = "geckoterminal"),
    "no trending_1h": (s) => delete s.lists.trending_1h,
  };
  for (const [name, edit] of Object.entries(cases)) assert.equal(judge(edited(edit)).ok, false, name);
  assert.equal(judge({ status: 503, date: A.good.answer.date, body: "{}" }).ok, false, "a 503");
  assert.equal(judge({ ...A.good.answer, date: null }).ok, false, "no Date");
});
