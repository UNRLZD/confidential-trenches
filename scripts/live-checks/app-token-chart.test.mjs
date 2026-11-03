// node --test scripts/live-checks/app-token-chart.test.mjs: the live check's verdict replays recorded runs
// (app-token-chart.answers.json), each read on 3 Nov by app-token-chart.mjs collect() in headless Chromium, HELPER_HOST live:
//   good: this card's build served at APP_HOST's name inside the stand-in shell (--build): /token/solana/<a live mint>
//         at 1440 and 390 draws the chart, holding every bar of its own 15m candle read: PASS;
//   bad:  APP_HOST's deployed build before this card: the chart panel draws only its timeframes, reads no candles and
//         holds no bars: FAIL.
// Planted from the good run: a chart that holds fewer bars than its read, a chart left loading, a read at another
// timeframe, a failed candle read, an answer the page's mapping refuses, CoinGecko's label missing over its bars, and
// the label shown over our own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, LOADS } from "./app-token-chart.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-token-chart.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the live mint's chart holds every bar of its candle read at 1440 and 390: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.loads.length, LOADS.length);
  for (const l of ANSWERS.good.loads) {
    assert.equal(l.chart, "ready");
    assert.ok(Number(l.bars) > 0 && Number(l.bars) === l.read.count);
  }
});

test("recorded bad answer: the build before this card draws no chart and reads no candles: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => /^BAD desktop .*the page read no candles/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /^BAD phone .*the chart is not there/.test(l)), r.lines.join("\n"));
});

test("planted: a chart holding fewer bars than its read, or none, or left loading, fails", () => {
  const fewer = mut((rec) => {
    rec.loads[0].bars = String(Number(rec.loads[0].bars) - 1);
  });
  assert.ok(bad(fewer.lines).some((l) => /^BAD desktop .*holds \d+ bars, its read answered \d+/.test(l)), fewer.lines.join("\n"));
  const none = mut((rec) => {
    rec.loads[1].bars = null;
    rec.loads[1].canvases = 0;
  });
  assert.ok(bad(none.lines).some((l) => /^BAD phone .*no canvas drawn/.test(l)), none.lines.join("\n"));
  const loading = mut((rec) => {
    rec.loads[0].chart = "loading";
  });
  assert.ok(bad(loading.lines).some((l) => /the chart is loading/.test(l)), loading.lines.join("\n"));
});

test("planted: a page read at another timeframe or answered 503, and a helper answer the mapping refuses, fail", () => {
  const tf = mut((rec) => {
    rec.loads[0].read.tf = "1m";
  });
  assert.ok(bad(tf.lines).some((l) => /read candles for solana\/\S+ at 1m/.test(l)), tf.lines.join("\n"));
  const failed = mut((rec) => {
    rec.loads[1].read.status = 503;
  });
  assert.ok(bad(failed.lines).some((l) => /answered 503/.test(l)), failed.lines.join("\n"));
  const refused = mut((rec) => {
    rec.candles.body.candles[1][2] = "-1";
  });
  assert.ok(bad(refused.lines).some((l) => /an answer the page's mapping refuses/.test(l)), refused.lines.join("\n"));
  const empty = mut((rec) => {
    rec.candles.body.candles = [];
  });
  assert.ok(bad(empty.lines).some((l) => /no bars/.test(l)), empty.lines.join("\n"));
});

test("planted: CoinGecko's label missing over GeckoTerminal's bars, or shown over our own, fails", () => {
  const gecko = ANSWERS.good.loads[0].read.src.split(",").includes("geckoterminal");
  const flipped = mut((rec) => {
    rec.loads[0].vendor = !gecko;
  });
  assert.ok(bad(flipped.lines).some((l) => /CoinGecko's label (shown|missing) for X-Helper-Source/.test(l)), flipped.lines.join("\n"));
  const own = mut((rec) => {
    rec.loads[1].read.src = "chain";
    rec.loads[1].vendor = true;
  });
  assert.ok(bad(own.lines).some((l) => /^BAD phone .*CoinGecko's label shown for X-Helper-Source chain/.test(l)), own.lines.join("\n"));
});
