// node --test scripts/live-checks/market-data-solana-token.test.mjs: the live check replays recorded answers
// (market-data-solana-token.answers.json). good: apps/helper at f539855 run on a Mac against the real Jupiter, Solana
// and GeckoTerminal (the deployed helper has no /v1/market/token yet): PASS. bad_not_deployed: the deployed helper
// before this card, 404 on all three: FAIL. Made from the good answer: a page missing a Risk field, a row with an extra
// field, the authorities not from the chain, a holder row with a stray field, a bar off the hour grid, bars out of
// order, another mint's page, a stale read and no CORS echo: each FAIL. Card helper-restart-fresh: each answer judged by
// its own read's time: one read late in a run, dated past 10 min of it, FAILs.
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
  // each read's own time as recorded; a recording without one is judged against its start (the replay's are now)
  for (const k of Object.keys(r.reads)) {
    if (rec.reads[k]?.at === undefined) delete r.reads[k].at;
    else Object.assign(r.reads[k], { at: rec.reads[k].at, ms: rec.reads[k].ms });
  }
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
  // the helper's list is 06b's then `filling` (card token-page-fills-after)
  assert.deepEqual([...PAGE, "filling"], [...PAGE_FIELDS]);
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

test("card token-page-fills-after: a page with filling false passes; filling not a boolean, or true on a Jupiter row, FAILs", async () => {
  assert.equal((await run(edit("token", (b) => (b.filling = false)))).ok, true);
  for (const [v, re] of [["yes", /filling "yes"/], [true, /filling true on a "jupiter" row/]]) {
    const r = await run(edit("token", (b) => (b.filling = v)));
    assert.equal(r.ok, false, String(v));
    assert.ok(bad(r).some((l) => re.test(l)), bad(r).join("\n"));
  }
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

test("card helper-restart-fresh: each answer is judged by its own read, not the run's start: a candles answer read late in a run, dated 10 min 5 s before its request, FAILs though it is within 10 min of the run's start; dated within 10 min of its own read it PASSES; dated after it arrived (past 2 s) it FAILs", async () => {
  const times = (rec, sentAfterStart, fetchedBeforeSent) => {
    const start = Date.parse(rec.readAt);
    for (const [i, k] of Object.keys(READS).entries()) {
      const sent = start + (k === "candles" ? sentAfterStart : i * 1_000);
      rec.reads[k].at = new Date(sent).toISOString();
      rec.reads[k].ms = 900;
      if (k === "candles") rec.reads[k].headers = { ...rec.reads[k].headers, "x-fetched-at": new Date(sent - fetchedBeforeSent).toISOString() };
      else rec.reads[k].headers = { ...rec.reads[k].headers, "x-fetched-at": new Date(sent + 500).toISOString() };
    }
    return rec;
  };
  // the candles sent 30 s into the run (a slow cold page and holders before them), dated 10 min 5 s before their request
  const stale = await run(times(structuredClone(A.good), 30_000, 605_000));
  assert.deepEqual(bad(stale).map((l) => l.split(":")[0]), ["BAD candles X-Fetched-At"], stale.lines.join("\n"));
  const fresh = await run(times(structuredClone(A.good), 30_000, 595_000));
  assert.deepEqual(bad(fresh), [], fresh.lines.join("\n"));
  assert.ok(fresh.lines.some((l) => /^ok {2}candles X-Fetched-At: .*, within 10 min of its read at .* \(answered in 900 ms\)$/.test(l)), fresh.lines.join("\n"));
  const ahead = await run(times(structuredClone(A.good), 30_000, -(900 + 3_000)));
  assert.deepEqual(bad(ahead).map((l) => l.split(":")[0]), ["BAD candles X-Fetched-At"], ahead.lines.join("\n"));
});

test("card helper-restart-fresh: read() dates each answer by its own request", async () => {
  const before = Date.now();
  const r = await read(undefined, undefined, replay(A.good));
  const after = Date.now();
  let last = before;
  for (const k of Object.keys(READS)) {
    const t = Date.parse(r.reads[k].at);
    assert.ok(t >= last && t <= after && Number.isSafeInteger(r.reads[k].ms), k);
    last = t;
  }
});
