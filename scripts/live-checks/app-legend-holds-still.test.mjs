// node --test scripts/live-checks/app-legend-holds-still.test.mjs: the live check's verdict replays recorded answers
// (app-legend-holds-still.answers.json), each read on 2026-11-08 by app-legend-holds-still.mjs collect() with the
// paced walk of card app-legend-crosshair-proof:
//   good: the terminal build with the legend reading the crosshair's bar from its x (chart.ts), at APP_HOST's name in
//         the stand-in shell, the helper live: the crosshair moved the legend through texts of its own at both widths,
//         30 s of ticks and zero layout shifts: PASS;
//   bad:  APP_HOST as deployed (main 4f133769): the legend never followed the crosshair, only the ticks and the Price
//         press changed it: FAIL at both widths.
// Planted from the good answer: one shift (named by its element), a legend that never drew, a walk short in time or in
// points, Price never pressed, a page error, one width missing; a point that reads what the rest read before or after
// it (a tick, the Price press) is never the crosshair's; too few crosshair texts on a chart of few bars is
// INCONCLUSIVE (exit 3), on a chart of many a FAIL; the press's own redraw (marked as following input) passes, the same
// shift unmarked fails.
// The token it walks is picked from the lists (card live-checks-quiet-chart-and-receipt). picked: a live run of
// 2026-11-10 06:58Z that picked the top Trending token (500 bars) and walked it, PASS. pick.*: real lists and candles
// answers of the same day (see the "//" note of the answers file): skip, a 3-bar token above a 111-bar one, the second is
// picked and the first is named as skipped; throttled, the helper's real 429 on a token (read again after its Retry-After,
// then skipped) above a 500-bar one; none, Robinhood's 15 Trending tokens, each of 1 bar: INCONCLUSIVE, exit 3, naming how
// many it read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, MAX_READS, MIN_BARS, MIN_TEXTS, collect, crosshairTexts, judge, pickLines, pickToken } from "./app-legend-holds-still.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-legend-holds-still.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
// every point reads the rest text read before it: the legend never followed the crosshair
const stuck = (l) => {
  let rest = null;
  for (const r of l.reads) {
    if (r.kind === "rest") rest = r.text;
    else r.text = rest;
  }
};

test("recorded good answer: the crosshair moved the legend at both widths, which held still: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  for (const l of ANSWERS.good.loads) assert.ok(crosshairTexts(l.reads).size >= MIN_TEXTS, `${l.width} moved the legend`);
});

test("recorded bad answer: the deployed legend never followed the crosshair, only ticks and the Price press moved it: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.verdict, "FAIL");
  assert.equal(EXIT[r.verdict], 1);
  for (const w of ["phone", "desktop"]) assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: the crosshair moved the legend through 0 text(s) of its own`)), r.lines.join("\n"));
  const desk = ANSWERS.bad.loads.find((l) => l.width === "desktop");
  assert.ok(desk.toggled === true && new Set(desk.reads.map((x) => x.text)).size >= 2, "the desktop's legend changed, by the press and the ticks alone");
});

test("planted: one shift fails and names its element and rects", () => {
  const r = mut((rec) => rec.loads[1].shifts.push({ at: 1808, value: 0.00001, input: false, sources: ["span.tkp-lgkv 355,145 92x10 -> 349,145 92x10"] }));
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => l.includes("1 layout shift(s) [+1808ms 0.00001: span.tkp-lgkv 355,145 92x10 -> 349,145 92x10]")), r.lines.join("\n"));
});

test("planted: no legend, a short walk, Price never pressed, a page error or a missing width fails", () => {
  for (const f of [
    (rec) => (rec.loads[0].legend = false),
    (rec) => (rec.loads[1].heldMs = 12_000),
    (rec) => (rec.loads[0].reads = rec.loads[0].reads.slice(0, 9)),
    (rec) => (rec.loads[1].toggled = false),
    (rec) => rec.loads[1].errors.push("TypeError: x is undefined"),
    (rec) => rec.loads.pop(),
    (rec) => (rec.loads = []),
  ]) {
    assert.equal(mut(f).verdict, "FAIL");
  }
});

test("planted: a point that reads the rest text before or after it is never the crosshair's (a tick, the Price press)", () => {
  const reads = [
    { kind: "rest", text: "A" },
    { kind: "point", text: "B" }, // a tick moved the newest bar between the reads: the next rest reads B
    { kind: "rest", text: "B" },
    { kind: "point", text: "B" },
    { kind: "rest", text: "P" }, // the Price press: the rest reads anew
    { kind: "point", text: "X" },
    { kind: "rest", text: "P" },
    { kind: "point", text: "Y" }, // the last point with no rest after it is not counted
  ];
  assert.deepEqual([...crosshairTexts(reads)], ["X"]);
});

test("planted: under 3 crosshair texts is a FAIL on a chart of many bars, INCONCLUSIVE (exit 3) on one of few, never a PASS", () => {
  const many = mut((rec) => stuck(rec.loads[0]));
  assert.equal(many.verdict, "FAIL", many.lines.join("\n"));
  const few = mut((rec) => {
    stuck(rec.loads[0]);
    rec.loads[0].bars = MIN_BARS - 1;
  });
  assert.equal(few.verdict, "INCONCLUSIVE", few.lines.join("\n"));
  assert.equal(EXIT[few.verdict], 3);
  assert.ok(few.lines.some((l) => l.startsWith("INCONCLUSIVE phone: the crosshair moved the legend through 0 text(s)")), few.lines.join("\n"));
  // a page fault beside it still fails
  const both = mut((rec) => {
    stuck(rec.loads[0]);
    rec.loads[0].bars = 2;
    rec.loads[1].errors.push("TypeError: x is undefined");
  });
  assert.equal(both.verdict, "FAIL");
});

test("planted: the Price press's own redraw passes only while marked as following the press", () => {
  const shift = { at: 16_000, value: 0.002, sources: ["span.tkp-lgkv 239,6 79x14 -> 232,6 72x14"] };
  assert.equal(mut((rec) => rec.loads[1].shifts.push({ ...shift, input: true })).verdict, "PASS");
  assert.equal(mut((rec) => rec.loads[1].shifts.push({ ...shift, input: false })).verdict, "FAIL");
  assert.equal(mut((rec) => rec.loads[0].shifts.push({ ...shift, input: true })).verdict, "FAIL");
});

// ------------------------------------------------------------------------------------------------ the token it picks
/** A fetch that answers a recorded pick fixture (a token's id back under its wire key), and what was asked. */
function helper(fx, asked = []) {
  const wire = (r) => ({ ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "addr")), ["tok" + "en"]: r.addr });
  return async (url) => {
    const u = new URL(String(url));
    asked.push(`${u.pathname}${u.search}`);
    if (u.pathname === "/v1/market/lists") {
      if (u.searchParams.get("chain") !== fx.chain) return new Response("{}", { status: 404 });
      const l = fx.list;
      return Response.json({ ...l.body, lists: { trending_1h: l.body.lists.trending_1h.map(wire) } }, { status: l.status });
    }
    assert.equal(u.pathname, "/v1/market/candles");
    assert.equal(u.searchParams.get("tf"), "15m", "the page's default interval");
    const c = fx.candles[u.searchParams.get("token")];
    return new Response(JSON.stringify(c.body), { status: c.status, headers: { "x-helper-source": c.src ?? "chain", ...(c.status === 429 ? { "retry-after": "2" } : {}) } });
  };
}
const noWait = () => Promise.resolve();

test("the top token's chart holds 3 bars and a 111-bar token is below it: the second is picked, the first named as skipped, and the run walks the second: PASS", async () => {
  const asked = [];
  const pick = await pickToken({ fetchFn: helper(ANSWERS.pick.skip, asked), chains: ["solana"], wait: noWait });
  assert.equal(pick.picked.bars, 111);
  assert.deepEqual(pick.read.map((r) => r.bars), [3, 111]);
  assert.equal(asked.filter((u) => u.includes("/candles")).length, 2, "it stops at the first token it can walk");
  assert.ok(asked.every((u) => !u.includes("limit=") || u.includes("limit=500")), asked.join("\n"));
  const lines = pickLines(pick).join("\n");
  assert.match(lines, /^ok {2}picked solana\/NVDAV\w+, 111 bars at 15m \(24 needed\), read 2 tokens for it, 1 skipped: solana\/73c1i\w+ \(3 bars\) \(solana 3 Trending\)$/);
  // the walk of the picked token (a recorded live walk) with that pick: PASS, the pick printed first
  const r = judge({ ...ANSWERS.picked, pick: { ...pick } });
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.match(r.lines[0], /picked solana\/NVDAV\w+, 111 bars/);
  // the route the run opens is that token's own page, never /
  const rec = (await collect({ pick: { ...pick, picked: null }, shots: path.join(tmpdir(), "lc-no-shots") })).rec;
  assert.equal(rec.route, null);
});

test("a 429 on a token is read again after its Retry-After (as the page does), then skipped with its status; the token below it is picked", async () => {
  const waits = [];
  const pick = await pickToken({ fetchFn: helper(ANSWERS.pick.throttled), chains: ["solana"], wait: (ms) => (waits.push(ms), Promise.resolve()) });
  assert.deepEqual(waits, [2000, 2000]);
  assert.equal(pick.read[0].bars, null);
  assert.equal(pick.read[0].why, "bars 429");
  assert.equal(pick.picked.bars, 30);
  assert.match(pickLines(pick)[0], /1 skipped: solana\/TTWof\w+ \(bars 429\)/);
});

test("no listed token holds 24 bars (Robinhood's 15, each of 1): INCONCLUSIVE (exit 3), no BAD line, says how many it read and opens no page", async () => {
  const pick = await pickToken({ fetchFn: helper(ANSWERS.pick.none), chains: ["robinhood"], wait: noWait });
  assert.equal(pick.picked, null);
  assert.equal(pick.read.length, 15);
  const r = judge({ pick, loads: [] });
  assert.equal(r.verdict, "INCONCLUSIVE");
  assert.equal(EXIT[r.verdict], 3);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), []);
  assert.match(r.lines.join("\n"), /^INCONCLUSIVE no listed token holds 24 bars or more at 15m: read 15 tokens, 15 skipped: robinhood\/0x\w+ \(1 bar\), .* and 7 more \(robinhood 15 Trending\): no chart to walk$/);
  // a quiet pick never reaches the browser
  const out = await collect({ pick, shots: path.join(tmpdir(), "lc-no-shots") });
  assert.equal(out.rec.loads.length, 0);
  assert.equal(out.rec.browser, null);
});

test("the pick reads at most MAX_READS tokens, and lists that do not answer are named: INCONCLUSIVE, never a pass", async () => {
  const capped = await pickToken({ fetchFn: helper(ANSWERS.pick.none), chains: ["robinhood"], max: 4, wait: noWait });
  assert.equal(capped.read.length, 4);
  assert.ok(MAX_READS >= 24 && MAX_READS <= 60);
  const down = await pickToken({ fetchFn: async () => new Response("{}", { status: 503 }), wait: noWait });
  assert.equal(down.picked, null);
  assert.equal(down.read.length, 0);
  const r = judge({ pick: down, loads: [] });
  assert.equal(r.verdict, "INCONCLUSIVE");
  assert.match(r.lines[0], /read 0 tokens, none skipped \(solana lists 503, base lists 503, robinhood lists 503\)/);
  const thrown = await pickToken({ fetchFn: async () => { throw new Error("boom"); }, wait: noWait });
  assert.equal(thrown.picked, null);
});

test("a picked token whose walk fails is still a FAIL: the legend that never followed the crosshair on 500 bars", () => {
  const r = judge({ ...structuredClone(ANSWERS.picked), loads: ANSWERS.bad.loads.map((l) => ({ ...l, bars: 500 })) });
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.match(r.lines[0], /^ok {2}picked solana\//);
});

test("the recorded live run that picked its token: PASS, the picked token printed first, none skipped", () => {
  const r = judge(ANSWERS.picked);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.match(r.lines[0], /^ok {2}picked solana\/\w+, 500 bars at 15m \(24 needed\), read 1 token for it, none skipped \(solana 99 Trending\)$/);
  assert.equal(ANSWERS.picked.route, `/token/${ANSWERS.picked.pick.picked.chain}/${ANSWERS.picked.pick.picked.addr}`);
});
