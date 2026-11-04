// node --test scripts/live-checks/market-data-solana-token.test.mjs: the live check replays recorded answers
// (market-data-solana-token.answers.json). good: apps/helper at f539855 run on a Mac against the real Jupiter, Solana
// and GeckoTerminal (the deployed helper has no /v1/market/token yet): PASS. bad_not_deployed: the deployed helper
// before this card, 404 on all three: FAIL. Made from the good answer: a page missing a Risk field, a row with an extra
// field, the authorities not from the chain, a holder row with a stray field, a bar off the hour grid, bars out of
// order, another mint's page, a stale read and no CORS echo: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROW_FIELDS as TERMINAL_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";
import { CANDLES_FIELDS, HOLDERS_FIELDS, PAGE_FIELDS, RISK_FIELDS } from "../../apps/helper/src/data/solana/token.ts";
import { ROW_FIELDS as HELPER_ROW } from "../../apps/helper/src/data/solana/lists.ts";
import { CANDLES, HOLDERS, judge, MINT, PAGE, read, READS, RISK, ROW } from "./market-data-solana-token.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "market-data-solana-token.answers.json"), "utf8"));

// a fetch that answers with the recorded answers, after checking the check asked the right thing
const replay = (run) => async (url, init) => {
  const k = Object.keys(READS).find((k) => url === `https://api.confidential.unrealized.trade${READS[k](MINT)}`);
  assert.ok(k, url);
  assert.equal(init.method, undefined);
  assert.equal(init.headers.origin, "https://confidential.unrealized.trade");
  const a = run.reads[k];
  return new Response(a.body, { status: a.status, headers: a.headers });
};
const run = async (rec) => {
  const r = await read(undefined, undefined, replay(rec));
  r.readAt = rec.readAt; // the recorded read's own time, for the freshness windows
  return judge(r);
};
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good run with one read's body or headers edited. */
const edit = (k, fn, headers) => {
  const rec = structuredClone(A.good);
  const b = JSON.parse(rec.reads[k].body);
  fn?.(b);
  rec.reads[k].body = JSON.stringify(b);
  if (headers) Object.assign(rec.reads[k].headers, headers);
  return rec;
};

test("the pinned lists are 06b's, the Row is the terminal's, and the helper serves exactly them", () => {
  assert.deepEqual(ROW, [...TERMINAL_FIELDS]);
  assert.deepEqual(ROW, [...HELPER_ROW]);
  assert.deepEqual(PAGE, [...PAGE_FIELDS]);
  assert.deepEqual(RISK, [...RISK_FIELDS]);
  assert.deepEqual(HOLDERS, [...HOLDERS_FIELDS]);
  assert.deepEqual(CANDLES, [...CANDLES_FIELDS]);
});

test("recorded good answer: the page, holders and candles of one live mint in exactly the frozen fields: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 21);
  assert.ok(JSON.parse(A.good.reads.candles.body).candles.length > 0);
});

test("recorded bad answer: the deployed helper before this card, 404 on all three: FAIL", async () => {
  const r = await run(A.bad_not_deployed);
  assert.equal(r.ok, false);
  for (const k of Object.keys(READS)) assert.ok(bad(r).includes(`BAD GET ${READS[k](MINT)} answers 404`), bad(r).join("\n"));
});

test("candles from the helper's own bars: \"chain\" or \"chain,geckoterminal\", with own_from_s on one of its bars, PASS; another source or own_from_s off our bars FAILs", async () => {
  const ours = (src, own) => edit("candles", (c) => {
    c.src = src;
    if (own) {
      const as = c.as_of_ms;
      delete c.as_of_ms;
      c.own_from_s = c.candles.at(-1)[0];
      c.as_of_ms = as;
    }
  }, { "x-helper-source": src });
  for (const [src, own] of [["chain,geckoterminal", true], ["chain", true], ["chain,geckoterminal", false]]) {
    const r = await run(ours(src, own));
    assert.equal(r.ok, true, `${src} ${own}\n${bad(r).join("\n")}`);
  }
  const cases = [
    [edit("candles", null, { "x-helper-source": "binance" }), 'BAD candles X-Helper-Source: "binance"'],
    [edit("candles", (c) => (c.src = "chain,binance"), { "x-helper-source": "chain" }), "BAD candles: exactly the frozen fields in their wire forms: tf"],
    [edit("candles", (c) => { const as = c.as_of_ms; delete c.as_of_ms; c.own_from_s = c.candles.at(-1)[0]; c.as_of_ms = as; }), "BAD candles: exactly the frozen fields in their wire forms: own_from_s"],
    [edit("candles", (c) => { c.src = "chain"; const as = c.as_of_ms; delete c.as_of_ms; c.own_from_s = c.candles.at(-1)[0] + 1; c.as_of_ms = as; }, { "x-helper-source": "chain" }), "BAD candles: exactly the frozen fields in their wire forms: own_from_s"],
  ];
  for (const [rec, line] of cases) {
    const r = await run(rec);
    assert.equal(r.ok, false, line);
    assert.equal(bad(r).length, 1, `${line}\n${bad(r).join("\n")}`);
    assert.ok(bad(r)[0].startsWith(line), `${line}\n${bad(r)[0]}`);
  }
});

test("made from the good answer: each fault FAILs on its own line", async () => {
  const cases = [
    [edit("token", (p) => delete p.risk.tax), "BAD token: exactly the frozen fields in their wire forms: risk keys"],
    [edit("token", (p) => (p.row.extra = 1)), "BAD token: exactly the frozen fields in their wire forms: row keys"],
    [edit("token", (p) => (p.risk.mint_auth.src = "jupiter")), "BAD token: exactly the frozen fields in their wire forms: risk mint_auth"],
    [edit("token", (p) => (p.row.token = "So11111111111111111111111111111111111111112")), "BAD token: exactly the frozen fields in their wire forms: row is"],
    [edit("token", (p) => (p.pool = MINT)), "BAD token: exactly the frozen fields in their wire forms: pool"],
    [edit("holders", (h) => h.holders.push({ addr: MINT, amt: "1", bps: 1, owner: "x" })), "BAD holders: exactly the frozen fields in their wire forms: row 0 keys"],
    [edit("candles", (c) => (c.candles[0][0] += 60)), "BAD candles: exactly the frozen fields in their wire forms: bar 0"],
    [edit("candles", (c) => c.candles.reverse()), "BAD candles: exactly the frozen fields in their wire forms: bar 1 not after bar 0"],
    [edit("candles", (c) => (c.candles[0][4] = 0.004)), "BAD candles: exactly the frozen fields in their wire forms: bar 0"],
    [edit("token", null, { "x-fetched-at": "2026-11-02T13:00:00.000Z" }), "BAD token X-Fetched-At"],
    // card helper-restart-fresh: live run 41871356171 straight after a swap, candles dated 16 min 15 s before the read
    [edit("candles", null, { "x-fetched-at": "2026-11-02T13:51:56.169Z" }), "BAD candles X-Fetched-At"],
    [edit("holders", null, { "access-control-allow-origin": "*" }), 'BAD holders Access-Control-Allow-Origin: "*"'],
  ];
  for (const [rec, line] of cases) {
    const r = await run(rec);
    assert.equal(r.ok, false, line);
    assert.equal(bad(r).length, 1, `${line}\n${bad(r).join("\n")}`);
    assert.ok(bad(r)[0].startsWith(line), `${line}\n${bad(r)[0]}`);
  }
});
