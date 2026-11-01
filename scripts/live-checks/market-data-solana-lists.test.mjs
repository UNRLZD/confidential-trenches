// node --test scripts/live-checks/market-data-solana-lists.test.mjs: the live check replays recorded answers
// (market-data-solana-lists.answers.json). good: apps/helper at df4809d run on a Mac against the real Jupiter and
// Solana (the deployed helper has no /v1/market/lists yet): PASS. bad_missing_field: the good answer with one list's rows
// missing a frozen field: FAIL. bad_not_deployed: the deployed helper before this card, 404: FAIL. Made from the good
// answer: an extra field, a USD value as a number, a graduating row off its curve, trending unlike trending_1h, a stale
// read and no CORS echo: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROW_FIELDS as TERMINAL_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";
import { FIELDS, judge, read } from "./market-data-solana-lists.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "market-data-solana-lists.answers.json"), "utf8"));

// a fetch that answers with the recorded answer, after checking the check asked the right thing
const replay = (a) => async (url, init) => {
  assert.equal(url, "https://api.confidential.unrealized.trade/v1/market/lists?chain=solana");
  assert.equal(init.method, undefined);
  assert.equal(init.headers.origin, "https://confidential.unrealized.trade");
  return new Response(a.status === 204 ? null : a.body, { status: a.status, headers: a.headers });
};
const run = async (a) => {
  const r = await read(undefined, replay(a));
  r.readAt = a.readAt; // the recorded read's own time, for the freshness windows
  return judge(r);
};
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (fn) => {
  const s = JSON.parse(A.good.body);
  fn(s);
  return { ...A.good, body: JSON.stringify(s) };
};

test("the frozen list is the terminal's ROW_FIELDS, which ends with buys_1h and sells_1h", () => {
  assert.deepEqual(FIELDS, [...TERMINAL_FIELDS]);
  assert.deepEqual(FIELDS.slice(-2), ["buys_1h", "sells_1h"]);
});

test("recorded good answer: the snapshot, five lists, every row in exactly the frozen fields: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  const n5 = JSON.parse(A.good.body).lists.trending_5m.length;
  assert.ok(n5 >= 90, "the recorded 5m list is nearly full (100 asked; a row with no visible symbol is dropped)");
  assert.ok(r.lines.includes(`ok  trending_5m: ${n5} rows, each with exactly the 38 fields in their wire forms`), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^ok {2}graduating: [1-9]\d* rows/.test(l)), "the good answer has a graduating list");
});

test("recorded bad answer: a list missing a field: FAIL", async () => {
  const b = A.bad_missing_field;
  const r = await run(edit((s) => (s.lists[b.list] = s.lists[b.list].map(({ [b.drop]: _, ...row }) => row))));
  assert.equal(r.ok, false);
  const rows = JSON.parse(A.good.body).lists.trending_5m;
  assert.deepEqual(bad(r), [`BAD trending_5m: ${rows.length} rows, each with exactly the 38 fields in their wire forms: ${rows.length} not, first row 0 (${JSON.stringify(rows[0].symbol)}) missing holders`]);
});

test("recorded bad answer: the deployed helper before this card, 404: FAIL", async () => {
  const r = await run(A.bad_not_deployed);
  assert.equal(r.ok, false);
  assert.ok(bad(r).includes("BAD GET /v1/market/lists?chain=solana answers 404"));
  assert.ok(bad(r).includes("BAD new: not a list"));
});

test("made from the good answer: an extra field, a USD number, a graduating row off its curve, trending unlike trending_1h: each FAIL", async () => {
  const extra = await run(edit((s) => (s.lists.new[0].secret = 1)));
  assert.deepEqual(bad(extra).map((l) => l.replace(/\(".*"\)/, "(x)")), ["BAD new: 30 rows, each with exactly the 38 fields in their wire forms: 1 not, first row 0 (x) extra secret"]);
  const num = await run(edit((s) => (s.lists.trending_1h[2].mc_usd = 5)));
  assert.equal(num.ok, false);
  assert.ok(bad(num).some((l) => /trending_1h: .* mc_usd 5$/.test(l)), bad(num).join("\n"));
  const off = await run(edit((s) => (s.lists.graduating[0] = { ...s.lists.graduating[0], curve_bps: 10000 })));
  assert.deepEqual(bad(off), ["BAD graduating: every row on a curve (a launchpad and curve_bps 0-9999): 1 not"]);
  const noPad = await run(edit((s) => (s.lists.graduating[0] = { ...s.lists.graduating[0], launchpad: null })));
  assert.deepEqual(bad(noPad), ["BAD graduating: every row on a curve (a launchpad and curve_bps 0-9999): 1 not"]);
  const unlike = await run(edit((s) => s.lists.trending.pop()));
  assert.deepEqual(bad(unlike), ["BAD trending equals trending_1h"]);
  const noRequired = await run(edit((s) => (s.lists.new[0].symbol = null)));
  assert.equal(noRequired.ok, false);
});

test("a stale read or no CORS echo: FAIL", async () => {
  const stale = await run({ ...A.good, readAt: new Date(Date.parse(A.good.readAt) + 3_600_000).toISOString() });
  assert.equal(stale.ok, false);
  assert.ok(bad(stale).some((l) => l.startsWith("BAD as_of_ms")));
  const { "access-control-allow-origin": _, ...noCors } = A.good.headers;
  const r = await run({ ...A.good, headers: noCors });
  assert.deepEqual(bad(r), ["BAD Access-Control-Allow-Origin: none"]);
});
