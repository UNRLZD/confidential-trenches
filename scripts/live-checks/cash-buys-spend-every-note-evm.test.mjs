// node --test scripts/live-checks/cash-buys-spend-every-note-evm.test.mjs: the live check cash-buys-spend-every-note-evm,
// replayed. cash-buys-spend-every-note-evm.answers.json holds two real runs, 2026-11-15 13:38Z (`--record`, read only; a
// `from` field added):
// - bad_live_before: SIGN_HOST as served before the card: FAIL, its bundle has no read past 1Click's "Failed to get
//   quote" (a move from Cash sized on the largest note alone, no least into Base's ETH); 1Click, read as the card's
//   page reads it, names its least into Base's and Robinhood's ETH;
// - good_built: the card branch's build (build-app.mjs --out), with the 1Click answers of the same run: PASS.
// And three of card cash-least-read-again, 2026-11-18 13:2xZ, SIGN_HOST live (release 175), 1Click with its statuses:
// - good_live: PASS, both leasts named;
// - blip_live: into Base, "Failed to get quote" at every rung to one USDC, the blip the device asks again: INCONCLUSIVE;
// - bad_quote: into Base, a quote (201) where the walk asked for a least: FAIL.
// Each plant fails on its own line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXIT, NO_MARK, blipOf, bundle, facts, judge, leastOf, noLeast } from "./cash-buys-spend-every-note-evm.mjs";

const A = JSON.parse(readFileSync(new URL("./cash-buys-spend-every-note-evm.answers.json", import.meta.url), "utf8"));

test("SIGN_HOST live with both leasts, their statuses recorded, passes", () => {
  const v = judge(A.good_live);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(EXIT[v.verdict], 0);
});

test("a 1Click blip at the walk's end, the one the device asks again, is INCONCLUSIVE (exit 3, read again) (card cash-least-read-again)", () => {
  const v = judge(A.blip_live);
  assert.equal(v.verdict, "INCONCLUSIVE", v.lines.join("\n"));
  assert.equal(EXIT[v.verdict], 3);
  assert.deepEqual(v.lines.filter((l) => l.startsWith("BAD")), []);
  assert.ok(v.lines.some((l) => l.startsWith("INCONCLUSIVE ") && l.includes("base's ETH")), v.lines.join("\n"));
  const failed = A.good_live.oneclick.base[0];
  for (const [last, status] of [
    ['{"message":"No liquidity available"}', 400],
    ["<html>bad gateway</html>", 502],
    ['{"message":"Too many requests"}', 429],
    ["no answer: TimeoutError", 0],
  ]) {
    const robinhood = [failed, last];
    assert.equal(blipOf(robinhood, [400, status]), true, last);
    assert.equal(judge({ ...A.good_live, oneclick: { ...A.good_live.oneclick, robinhood }, status: { ...A.good_live.status, robinhood: [400, status] } }).verdict, "INCONCLUSIVE", `${status} ${last}`);
  }
  // a broken build is a FAIL whatever 1Click answered
  assert.equal(judge({ ...A.blip_live, mark: false }).verdict, "FAIL");
});

test("a quote where the walk asked for a least is a FAIL", () => {
  const v = judge(A.bad_quote);
  assert.equal(v.verdict, "FAIL");
  assert.equal(EXIT[v.verdict], 1);
  assert.deepEqual(v.lines.filter((l) => l.startsWith("BAD")), [noLeast("base")]);
});
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));

test("the card's build with 1Click's least named into Base's and Robinhood's ETH passes", () => {
  const v = judge(A.good_built);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(bad(v), []);
  assert.ok(v.lines.includes("ok 1Click's least into base's ETH: 1042 USDC base units"), v.lines.join("\n"));
});

test("SIGN_HOST before the card fails: its bundle reads no least past 'Failed to get quote'", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.ok, false);
  assert.deepEqual(bad(v), [NO_MARK]);
});

test("1Click's least as the page before the card read it, one unit alone, is no read: the check fails", () => {
  const once = { base: A.good_built.oneclick.base.slice(0, 1), robinhood: A.good_built.oneclick.robinhood };
  assert.match(once.base[0], /Failed to get quote/);
  assert.deepEqual(bad(judge({ ...A.good_built, oneclick: once })), [noLeast("base")]);
  for (const answers of [['{"message":"recipient is not valid"}', '{"message":"Amount is too low for bridge, try at least 1042"}'], ['{"message":"Amount is too low for bridge, try at least 0"}'], [], undefined]) {
    assert.deepEqual(bad(judge({ ...A.good_built, oneclick: { ...A.good_built.oneclick, robinhood: answers } })), [noLeast("robinhood")], JSON.stringify(answers));
  }
  assert.equal(leastOf(A.good_built.oneclick.robinhood) > 0n, true);
});

test("a served bundle the index does not pin, or an index with no pin, fails", () => {
  assert.deepEqual(bad(judge({ ...A.good_built, sha384: A.bad_live_before.sha384 })), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(bad(judge({ ...A.good_built, index: "<html></html>" })), ["BAD SIGN_HOST's index.html pins no /app.js"]);
});

test("the bundle checks' run reads only the build: the pin and the mark, with no 1Click read", async () => {
  const served = (index, js) => async (u) => {
    const p = new URL(String(u));
    if (p.origin !== "https://confidential.unrealized.trade") throw new Error(`${p.origin}: not this build`);
    return p.pathname === "/" ? new Response(index) : p.pathname === "/app.js" ? new Response(js) : new Response("", { status: 404 });
  };
  const js = 'const F=/"message"\\s*:\\s*"Failed to get quote"/;';
  const pinned = A.good_built.index.replace(/integrity="[^"]+"/, `integrity="${facts("", js, {}).sha384}"`);
  assert.deepEqual(await bundle(served(pinned, js)), { ok: true, lines: [] });
  const v = await bundle(served(pinned, "const F=1;"));
  assert.equal(v.ok, false);
  assert.ok(v.lines.includes(NO_MARK), v.lines.join("\n"));
});

test("the mark is the read's regex literal as the minifier keeps it, and nothing else", () => {
  assert.equal(facts("", 'const F=/"message"\\s*:\\s*"Failed to get quote"/;', {}).mark, true);
  assert.equal(facts("", '"Failed to get quote"', {}).mark, false);
});
