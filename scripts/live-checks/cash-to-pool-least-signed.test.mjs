// node --test scripts/live-checks/cash-to-pool-least-signed.test.mjs: the live check cash-to-pool-least-signed, replayed.
// cash-to-pool-least-signed.answers.json holds two real runs, 2026-11-18 23:53Z, read only (a `from` field added), each
// with mainnet 1Click's answers through the helper's proxy (signatures left out, as recorded) and the verdict of the
// page's own read over them, signatures checked in the run:
// - good_built: the card branch's build (build-app.mjs --out, --local): PASS, a least on every chain from a signed quote
//   the kit's check passed (into SOL 1Click refused its own N 76,520 and quoted a hundredth more, 77,285; into Base's and
//   Robinhood's ETH the signed quote at 1Click's N fails the kit's floor, and twice it passes: 2,024 and 36,028);
// - bad_live_before: SIGN_HOST as served before the card: FAIL, its bundle sets the least from no checked answer.
// And plants on the good run, each failing on its own line: the read refused for an answer that fails the check (a
// signature broken), a least that is no amount 1Click quoted, 1Click's blips alone (INCONCLUSIVE), and no record.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXIT, NO_MARK, bundle, judge, priceOf, unsigned } from "./cash-to-pool-least-signed.mjs";

const A = JSON.parse(readFileSync(new URL("./cash-to-pool-least-signed.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const copy = (x) => JSON.parse(JSON.stringify(x));

test("the card's build, with the page's read over 1Click's signed answers, passes: a least on every chain", () => {
  const v = judge(A.good_built);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(EXIT[v.verdict], 0);
  assert.deepEqual(bad(v), []);
  assert.ok(v.lines.some((l) => /^ok solana: the page's least 77285 .*raised from 1Click's N 76520 \(76520: 1Click refused it\)/.test(l)), v.lines.join("\n"));
  assert.ok(v.lines.some((l) => /^ok base: the page's least 2024 .*\(1012: its signed quote fails the kit's floor\)/.test(l)), v.lines.join("\n"));
  assert.ok(v.lines.some((l) => /^ok robinhood: the page's least 36028 .*\(18014: its signed quote fails the kit's floor\)/.test(l)), v.lines.join("\n"));
});

test("SIGN_HOST before the card fails: its bundle sets the least from no checked answer", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.verdict, "FAIL");
  assert.equal(EXIT[v.verdict], 1);
  assert.deepEqual(bad(v), [NO_MARK]);
});

test("a read refused for an answer that fails the check fails: the device would plan no move", () => {
  const a = copy(A.good_built);
  delete a.chains.solana.least;
  a.chains.solana.error = "1Click's answer at 77285 fails the device's check: quote check failed (signature): the signature does not verify under the pinned 1Click keys";
  const v = judge(a);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(bad(v).length, 1, v.lines.join("\n"));
  assert.match(bad(v)[0], /^BAD solana: the page reads no least: .*quote check failed \(signature\)/);
  // a verdict missing is no least either
  const b = copy(A.good_built);
  delete b.chains.base.least;
  assert.match(bad(judge(b))[0], /^BAD base: the page reads no least: no verdict recorded/);
});

test("a least that is not the amount of the last answer 1Click quoted fails: N read off a 400, or a quote under it", () => {
  const a = copy(A.good_built);
  a.chains.solana.least = "76520"; // 1Click's unsigned N, which it refused
  assert.match(bad(judge(a))[0], /^BAD solana: the page's least 76520 is not the amount of the last answer 1Click quoted \(77285, HTTP 201\)/);
  const b = copy(A.good_built);
  b.chains.robinhood.asks = b.chains.robinhood.asks.slice(0, 2); // the 400s alone
  assert.match(bad(judge(b))[0], /^BAD robinhood: the page's least 36028 is not the amount of the last answer 1Click quoted \(10, HTTP 400\)/);
});

test("1Click's blips alone are INCONCLUSIVE (exit 3, read again), never PASS or FAIL", () => {
  const a = copy(A.good_built);
  const blip = { amount: "1", status: 400, text: '{"message":"No liquidity available"}' };
  a.chains.robinhood = { usd: "1761", asks: [blip, blip, blip], error: "1Click gave no least in 3 tries: HTTP 400 No liquidity available" };
  const v = judge(a);
  assert.equal(v.verdict, "INCONCLUSIVE", v.lines.join("\n"));
  assert.equal(EXIT[v.verdict], 3);
  assert.deepEqual(bad(v), []);
  // a blip beside a real refusal on another chain is still a FAIL
  a.chains.base.error = "1Click names no least: HTTP 400 recipient is not valid";
  delete a.chains.base.least;
  assert.equal(judge(a).verdict, "FAIL");
});

test("no read recorded, or an ask that is not an amount, fails on its chain's line", () => {
  const a = copy(A.good_built);
  delete a.chains.base;
  assert.deepEqual(bad(judge(a)), ["BAD base: no read of 1Click recorded"]);
  const b = copy(A.good_built);
  b.chains.solana.asks[0].amount = "-1";
  assert.deepEqual(bad(judge(b)), ["BAD solana: no read of 1Click recorded"]);
});

test("the record keeps no signature: an answer's is left out, the rest as sent", () => {
  const sig = `ed25519:${"1".repeat(87)}`;
  const kept = JSON.parse(unsigned(JSON.stringify({ quote: { amountIn: "5" }, signature: sig })));
  assert.deepEqual(kept, { quote: { amountIn: "5" }, signature: "ed25519:(left out)" });
  assert.equal(unsigned('{"message":"x"}'), '{"message":"x"}');
  assert.equal(unsigned("not json"), "not json");
  assert.ok(!JSON.stringify(A).includes(sig.slice(0, 20)) && !/ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}/.test(JSON.stringify(A)), "no signature in the recorded answers");
});

test("1Click's price is read as the page's { price, expo }", () => {
  assert.deepEqual(priceOf("72.71"), { price: "7271", expo: -2 });
  assert.deepEqual(priceOf("1761"), { price: "1761", expo: 0 });
  assert.equal(priceOf("0"), null);
  assert.equal(priceOf("-1"), null);
  assert.equal(priceOf(undefined), null);
});

test("the bundle half: a build with the mark passes, one without fails", async () => {
  const { createHash } = await import("node:crypto");
  const pinOf = (js) => `sha384-${createHash("sha384").update(js).digest("base64")}`;
  const host = (js) => async (u) => new Response(String(u).endsWith("/app.js") ? js : `<script src="/app.js" integrity="${pinOf(js)}"></script>`, { status: 200 });
  const js = "x=`1Click's answer at ${e} fails the device's check: no price of the pool's coin to check it at`";
  assert.deepEqual(await bundle(host(js)), { ok: true, lines: [] });
  assert.deepEqual((await bundle(host("x=1"))).lines, [NO_MARK]);
});
