// node --test scripts/live-checks/market-token-reads.test.mjs: the live check replays recorded answers
// (market-token-reads.answers.json). good: GET /v1/market/held at card/market-token-reads served by the helper's handler
// on a Mac, its sources the deployed helper's answers and the real GeckoTerminal: PASS. bad_not_deployed: the deployed
// helper before this card, /v1/market/held 404 on every chain: FAIL. Made from the good answer: a slow read, an entry of
// another token, a price in exponent form, an entry with no symbol, no CORS echo, a listed token with no history and
// NEAR answered 200: each FAIL; the off-list token with no history still PASSes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HELD_HISTORY_BARS, HELD_HISTORY_TF, HELD_MARKET_MAX } from "../../packages/kit/src/index.ts";
import { HELD_MAX } from "../../apps/helper/src/data/held.ts";
import { judge, OFF_LIST, pick, read, READS, SPEED_MS } from "./market-token-reads.mjs";
import { candlesReader } from "./candles-read.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "market-token-reads.answers.json"), "utf8"));
const BASE = "https://ct-api.unrealized.trade";

// a fetch that answers with the recorded answers, after checking the check asked the right thing
const replay = (rec) => async (url, init) => {
  assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
  if (url === `${BASE}${READS.near()}`) return new Response(rec.near.body, { status: rec.near.status, headers: rec.near.headers });
  for (const [chain, c] of Object.entries(rec.chains)) {
    if (url === `${BASE}${READS.lists(chain)}`) return new Response(c.lists.body, { status: c.lists.status, headers: c.lists.headers });
    const asked = pick(chain, JSON.parse(c.lists.body)).sort();
    if (url === `${BASE}${READS.held(chain, asked)}`) return new Response(c.held.body, { status: c.held.status, headers: c.held.headers });
    for (const t of asked) if (url === `${BASE}${READS.candles(chain, t)}`) return new Response(c.candles[t].body, { status: c.candles[t].status, headers: c.candles[t].headers });
  }
  assert.fail(`unexpected ${url}`);
};
// the replay re-reads every answer; each keeps its recorded time
const run = async (rec) => {
  const r = await read(undefined, replay(rec));
  for (const [chain, c] of Object.entries(r.chains)) if (c.held) c.held.ms = rec.chains[chain].held.ms;
  return judge(r);
};
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (fn) => {
  const rec = structuredClone(A.good.run);
  fn(rec);
  return rec;
};
const body = (r, fn) => {
  const b = JSON.parse(r.body);
  fn(b);
  r.body = JSON.stringify(b);
};

test("the check's request shapes are the kit's and the helper's", () => {
  assert.equal(HELD_MARKET_MAX, HELD_MAX);
  assert.ok(READS.candles("base", "0x1").includes(`tf=${HELD_HISTORY_TF}&limit=${HELD_HISTORY_BARS}`));
  assert.equal(SPEED_MS, 1000);
});

test("good: PASS", async () => {
  const r = await run(A.good.run);
  assert.deepEqual(bad(r), []);
  assert.ok(r.ok);
  assert.ok(r.lines.some((l) => l.includes("off the lists: not required")));
});

test("bad_not_deployed: FAIL, the held read 404 on each chain", async () => {
  const r = await run(A.bad_not_deployed.run);
  assert.equal(r.ok, false);
  for (const chain of ["solana", "base", "robinhood"]) assert.ok(bad(r).some((l) => l.startsWith(`BAD ${chain}: GET /v1/market/held`) && l.endsWith("answers 404")), chain);
});

test("made from good: each fault FAILs", async () => {
  const cases = {
    "a read over the bar": (rec) => (rec.chains.solana.held.ms = SPEED_MS + 1),
    "another token's entry": (rec) => body(rec.chains.robinhood.held, (b) => (b.tokens[0].token = OFF_LIST.base)),
    "a price in exponent form": (rec) => body(rec.chains.solana.held, (b) => (b.tokens[0].price_usd = "8.9e-3")),
    "no symbol": (rec) => body(rec.chains.base.held, (b) => (b.tokens[1].symbol = null)),
    "an extra field": (rec) => body(rec.chains.base.held, (b) => (b.tokens[0].amount = "1")),
    "no CORS echo": (rec) => delete rec.chains.robinhood.held.headers["access-control-allow-origin"],
    "a listed token with no history": (rec) => {
      const c = rec.chains.solana;
      const t = Object.keys(c.candles)[0];
      c.candles[t].status = 404;
    },
    "NEAR answered": (rec) => (rec.near.status = 200),
  };
  for (const [why, fn] of Object.entries(cases)) {
    const r = await run(edit(fn));
    assert.equal(r.ok, false, why);
  }
});

// card evm-chart-opens-without-a-vendor-call: the candles read as the token page reads it (candles-read.mjs)
test("a listed token's candles 429 that clears inside the span passes; one still standing after it, or an empty 200, FAILs", async () => {
  const clock = { t: 0 };
  const reader = candlesReader({ now: () => clock.t, wait: async (ms) => void (clock.t += ms) });
  const t = Object.keys(A.good.run.chains.solana.candles)[0];
  const url = `${BASE}${READS.candles("solana", t)}`;
  let refused = 1;
  const base = replay(A.good.run);
  const r = await read(undefined, async (u, init) => (u === url && refused-- > 0 ? new Response("{}", { status: 429, headers: { "retry-after": "40" } }) : base(u, init)), reader);
  assert.deepEqual(r.chains.solana.candles[t].waits, [40_000]);
  for (const [chain, c] of Object.entries(r.chains)) if (c.held) c.held.ms = A.good.run.chains[chain].held.ms;
  const passed = await judge(r);
  assert.deepEqual(bad(passed), []);
  const stood = edit((rec) => Object.assign(rec.chains.solana.candles[t], { status: 429, body: '{"error":{"code":"rate_limited"}}', waits: [40_000, 35_000] }));
  const judged = judge(stood);
  const lines = bad(await judged);
  assert.ok(lines.some((l) => l.includes("answers 429 after 75 s of reads at each Retry-After (40, 35 s), the kit takes 0 hourly bars")), lines.join("\n"));
  const empty = edit((rec) => body(rec.chains.solana.candles[t], (b) => (b.candles = [])));
  assert.ok(bad(await judge(empty)).some((l) => l.includes("answers 200, the kit takes 0 hourly bars")));
});
