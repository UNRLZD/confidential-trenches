// node --test scripts/live-checks/helper-misses.test.mjs: a check on a local build that reads the live helper tells a
// moment the helper missed from the page's own fault (card queue-browser-checks-tell-a-helper-miss-from-a-page-fault).
// The case is merge queue group 44547353452 (19 Nov 14:46Z), job test-browser (2) 135641455202: app-trade-box-mount on
// main's build read "drew nothing; state none, not ready; the page read no token answer" at both widths while the
// helper logged Jupiter /tokens/v2/toptrending/5m and /tokens/v2/search answering 503 on the vendor's timeout.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXIT, HELPER_HOST, MISS_MS, exitOf, helperMisses, helperWatch, stoppedLines, verdictOf, watchContext } from "./helper-misses.mjs";
import { judge } from "./app-trade-box-mount.mjs";
import { noAnswerHosts, rerun } from "../ci/live-rerun.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./app-trade-box-mount.answers.json", import.meta.url), "utf8"));
const TOKEN = `${HELPER_HOST}/v1/market/token?chain=solana&token=x`;
const LISTS = `${HELPER_HOST}/v1/market/lists?chain=solana`;

/** The 14:46Z shard's record: both loads drew nothing and read no token answer (the page never got one). */
const AT_1446 = {
  source: "harness: the build dist at APP_HOST's name in the stand-in shell, signed out, HELPER_HOST live",
  loads: ["desktop", "phone"].map((width, i) => ({ width, route: null, state: null, shown: null, symbol: null, page: null, token: null, signin: { opened: false }, shot: `${i}-${width}.png` })),
};
/** A planted page fault: the good run's answers, every one 200, and the trade box never mounts. */
const NO_BOX = structuredClone(ANSWERS.good);
for (const l of NO_BOX.loads) {
  if (l.page) l.page.box = null;
  if (l.sheet) l.sheet.box = null;
}

/** The helper's answers in one load: [path-ish url, { status, after ms } | { failed, after } | { never: true }]. */
function feed(w, answers, t0 = 0) {
  let end = t0;
  for (const [i, [url, a]] of answers.entries()) {
    const req = { i };
    w.asked(req, url, t0);
    if (a.never) continue;
    end = Math.max(end, t0 + a.after);
    if (a.failed) w.failed(req, a.failed, t0 + a.after);
    else w.answered(req, { status: a.status, acao: a.acao === undefined ? "https://ct-app.unrealized.trade" : a.acao, type: "fetch" }, t0 + a.after);
  }
  return end;
}

test("the 14:46Z record judges BAD at both widths, as the shard printed it", () => {
  const r = judge(AT_1446);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD desktop /desktop: drew nothing; state none, not ready; the page read no token answer; no trade box on the page; the Sign in to trade button did not open the sign-in sheet"), r.lines.join("\n"));
  assert.ok(r.lines.includes("BAD phone /phone: drew nothing; state none, not ready; the page read no token answer; no bottom bar; the Buy button did not open the trade sheet"), r.lines.join("\n"));
});

test("the 14:46Z case: the token answer missing after the helper's 503 reads INCONCLUSIVE, then PASS on its rerun", async () => {
  // run 1: the lists answered (200), the token read never came; run 2: every answer 200 and the good record
  const runs = [
    { rec: AT_1446, answers: [[LISTS, { status: 200, after: 300 }], [TOKEN, { never: true }]] },
    { rec: ANSWERS.good, answers: [[LISTS, { status: 200, after: 300 }], [TOKEN, { status: 200, after: 600 }]] },
  ];
  const said = [];
  let n = 0;
  const run = async () => {
    const { rec, answers } = runs[n++];
    const w = helperWatch();
    const end = feed(w, answers);
    // the check judges once its 25 s wait for the page is over
    const misses = w.misses(end + 25_000);
    const out = [];
    const code = exitOf(judge(rec).ok, (l) => out.push(l), misses);
    return { code, output: out.join("\n") };
  };
  const r = await rerun("app-trade-box-mount", [], { run, sleep: async () => {}, say: (l) => said.push(l), random: () => 0 });
  assert.equal(n, 2);
  assert.equal(r.verdict, "pass");
  assert.equal(r.exit, 0);
  assert.match(said[0], /^live-rerun app-trade-box-mount: run 1 of 3 INCONCLUSIVE \(no answer from: ct-api\.unrealized\.trade\)/);
});

test("the helper's 503 on the token read, or its network error, reads INCONCLUSIVE too", () => {
  for (const a of [{ status: 503, after: 3_600 }, { status: 502, after: 3_600 }, { status: 429, after: 100 }, { failed: "net::ERR_CONNECTION_RESET", after: 200 }, { status: 200, after: MISS_MS + 1 }, { status: 200, acao: null, after: 300 }, { failed: "net::ERR_ABORTED", after: MISS_MS }]) {
    const w = helperWatch();
    const end = feed(w, [[TOKEN, a]]);
    const m = w.misses(end);
    assert.equal(m.length, 1, JSON.stringify(a));
    assert.deepEqual(noAnswerHosts(m.join("\n")), ["ct-api.unrealized.trade"], m[0]);
    const v = verdictOf("FAIL", m);
    assert.equal(v.verdict, "INCONCLUSIVE");
    assert.equal(EXIT[v.verdict], 3);
  }
});

test("a planted page fault: the trade box never mounts while every helper answer is 200, and it FAILs on the first try", async () => {
  assert.equal(judge(ANSWERS.good).ok, true);
  assert.equal(judge(NO_BOX).ok, false);
  let n = 0;
  const run = async () => {
    n++;
    const w = helperWatch();
    const end = feed(w, [[LISTS, { status: 200, after: 300 }], [TOKEN, { status: 200, after: 700 }], [`${HELPER_HOST}/v1/logo/solana/x`, { status: 200, after: 200 }]]);
    const out = [];
    return { code: exitOf(judge(NO_BOX).ok, (l) => out.push(l), w.misses(end + 25_000)), output: out.join("\n") };
  };
  const r = await rerun("app-trade-box-mount", [], { run, sleep: async () => assert.fail("a FAIL is never run again"), say: () => {} });
  assert.equal(n, 1);
  assert.equal(r.verdict, "fail");
  assert.equal(r.exit, 1);
});

test("never a miss: the page's own abort, a read still young when the context closed, another host", () => {
  const w = helperWatch();
  feed(w, [[TOKEN, { failed: "net::ERR_ABORTED", after: 400 }], [`https://rpc.mainnet.fastnear.com/`, { status: 503, after: 10 }], [`${HELPER_HOST}/v1/market/trades?x`, { never: true }]], 0);
  w.closed(2_000);
  // the trades read was 2 s old at the close: the close cut it, the helper did not miss it
  assert.deepEqual(w.misses(60_000), []);
  assert.deepEqual(verdictOf("FAIL", w.misses(60_000)), { verdict: "FAIL", lines: [] });
  // a PASS stays a PASS through a miss, and an INCONCLUSIVE stays one
  assert.equal(verdictOf("PASS", ["x HTTP 503: y"]).verdict, "PASS");
  assert.equal(verdictOf("INCONCLUSIVE", []).verdict, "INCONCLUSIVE");
});

test("watchContext reads Playwright's context events, every frame, and ends at the context's close", async () => {
  const ctx = new EventEmitter();
  ctx.close = async () => ctx.emit("close");
  const req = (url, type = "fetch", failure = null) => ({ url: () => url, resourceType: () => type, failure: () => failure });
  const w = watchContext(ctx);
  const a = req(TOKEN);
  const b = req(LISTS);
  const c = req(`${HELPER_HOST}/v1/logo/solana/x`, "image", { errorText: "net::ERR_ABORTED" });
  for (const r of [a, b, c]) ctx.emit("request", r);
  ctx.emit("response", { request: () => a, status: () => 503, headers: () => ({ "access-control-allow-origin": "https://ct-app.unrealized.trade" }) });
  ctx.emit("response", { request: () => b, status: () => 200, headers: () => ({ "access-control-allow-origin": "https://ct-app.unrealized.trade" }) });
  await ctx.close();
  // the close's abort of the logo is after the watch ended
  ctx.emit("requestfailed", c);
  assert.deepEqual(w.misses(), ["ct-api.unrealized.trade HTTP 503: /v1/market/token"]);
  assert.ok(helperMisses().includes("ct-api.unrealized.trade HTTP 503: /v1/market/token"));
});

test("stopped at its bound (merge queue group 44559433373, 16:06Z): INCONCLUSIVE with a miss seen, FAIL with none", () => {
  const miss = stoppedLines(["ct-api.unrealized.trade HTTP 503: /v1/market/candles"]);
  assert.equal(miss.code, EXIT.INCONCLUSIVE);
  assert.deepEqual(miss.lines, ["-- ct-api.unrealized.trade HTTP 503: /v1/market/candles", "INCONCLUSIVE stopped at its bound; the helper missed 1 answer the page asked for, so the run tells nothing: run again"]);
  assert.deepEqual(noAnswerHosts(miss.lines.join("\n")), ["ct-api.unrealized.trade"]);
  const none = stoppedLines([]);
  assert.equal(none.code, EXIT.FAIL);
  assert.match(none.lines[0], /^BAD stopped at its bound with no helper miss seen/);
});
