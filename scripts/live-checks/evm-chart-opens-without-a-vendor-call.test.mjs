// node --test scripts/live-checks/evm-chart-opens-without-a-vendor-call.test.mjs: the live check replays recorded answers
// (evm-chart-opens-without-a-vendor-call.answers.json). good: the deployed helper read from a Mac at 2026-11-11
// 07:47:33Z, nine Base trending tokens (the lists read plus nine kept the run at ten reads): PASS. The list rows are cut
// to their `token`, the one field the check reads, and GeckoTerminal's 500-bar chart to its newest 40 bars. Made from
// it: one token's candles answering 429 with retry-after 58 (the helper's live run at 06:58Z and three Base reads at
// 07:12Z, the second and third 429 with retry-after 58-75; the page's reads given up on it), a GeckoTerminal-only chart
// naming bars of ours, an X-Helper-Source that differs from the body's src, a token's chart answered 200 with no bars
// (live run 42995547054 at 09:29:50Z: Base 0xb2000000...8c01, which GeckoTerminal charts), a chart opened past the
// page's 75 s of reads, and a token of the lists not read: each FAIL by name.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WINDOW_MS } from "../../apps/helper/src/data/gecko.ts";
import { CANDLES_LIMIT, DEFAULT_TF, TF_API, THROTTLE_SPAN_S } from "../../apps/terminal/src/screens/token/candles.ts";
import { CANDLES_PATH, judge, read, trending, WINDOW_S } from "./evm-chart-opens-without-a-vendor-call.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "evm-chart-opens-without-a-vendor-call.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer: nine trending Base tokens, every chart 200 from a source the helper names: PASS", () => {
  const r = judge(A.good);
  assert.deepEqual(bad(r), []);
  assert.equal(r.ok, true);
  assert.equal(A.good.candles.length, 9);
});

for (const [k, why] of [
  ["bad_429_on_a_cold_token", /answered 429 \(retry-after 58\)/],
  ["bad_vendor_bars_named_ours", /own_from_s on a GeckoTerminal-only chart/],
  ["bad_source_header_differs", /X-Helper-Source "geckoterminal"/],
  ["bad_empty_chart", /no bars \(src "chain"\): an empty chart for a trending token/],
  ["bad_opened_past_the_span", /opened after 80 s, over the page's 75 s/],
  ["bad_a_token_not_read", /not the lists' first 9/],
]) {
  test(`recorded bad answer ${k}: FAIL by name`, () => {
    const r = judge(A[k]);
    assert.equal(r.ok, false);
    assert.ok(bad(r).some((l) => why.test(l)), bad(r).join("\n"));
  });
}

test("the check reads the token page's first candles read and GeckoTerminal's window as the app and the helper have them", () => {
  assert.equal(TF_API[DEFAULT_TF], "15m");
  assert.match(CANDLES_PATH("0xab"), new RegExp(`tf=${TF_API[DEFAULT_TF]}&limit=${CANDLES_LIMIT}$`));
  assert.equal(WINDOW_S * 1000, WINDOW_MS);
  assert.equal(THROTTLE_SPAN_S * 1000, WINDOW_MS, "the page reads a 429 again for one budget window");
});

test("read: a 429 is read again at its Retry-After as the page reads it, and the answer after it judged", async () => {
  const lists = { lists: { trending_5m: [{ token: `0x${"1".repeat(40)}` }] } };
  let n = 0;
  const fetchFn = async (url) => (url.includes("/lists") ? new Response(JSON.stringify(lists), { status: 200 }) : ++n <= 2 ? new Response("{}", { status: 429, headers: { "retry-after": "30" } }) : new Response("{}", { status: 200 }));
  const waits = [];
  const run = await read("https://helper.test", 1, fetchFn, async (ms) => void waits.push(ms));
  assert.deepEqual(waits, [30_000, 30_000]);
  assert.deepEqual([run.candles[0].status, run.candles[0].waitedMs], [200, 60_000]);
});

test("read: the lists once, then each of the first n trending tokens once, Trending 5m's before 1h's, no token twice", async () => {
  const lists = { lists: { trending_5m: [{ token: `0x${"1".repeat(40)}` }, { token: `0x${"2".repeat(40)}` }], trending_1h: [{ token: `0x${"2".repeat(40)}` }, { token: `0x${"3".repeat(40)}` }] } };
  assert.deepEqual(trending(lists), [`0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`, `0x${"3".repeat(40)}`]);
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    return new Response(url.includes("/lists") ? JSON.stringify(lists) : "{}", { status: 200 });
  };
  const run = await read("https://helper.test", 2, fetchFn);
  assert.deepEqual(asked.map((u) => new URL(u).pathname), ["/v1/market/lists", "/v1/market/candles", "/v1/market/candles"]);
  assert.deepEqual(run.candles.map((c) => c.coin), [`0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`]);
});

test("a chart that opened after a 429 cleared inside the span passes, its wait named", () => {
  const run = structuredClone(A.good);
  run.candles[1].waitedMs = 30_000;
  const r = judge(run);
  assert.deepEqual(bad(r), []);
  assert.ok(r.lines.some((l) => l.endsWith("after 30 s of 429s")));
});
