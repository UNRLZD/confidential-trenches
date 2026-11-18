// node --test scripts/live-checks/cash-buys-spend-every-note.test.mjs: the live check cash-buys-spend-every-note,
// replayed. cash-buys-spend-every-note.answers.json holds two real runs, 2026-11-15 12:5xZ (`--record`, read only; a
// `from` field added):
// - bad_live_before: SIGN_HOST as served before the card: FAIL, its bundle has no least read (a move from Cash sized on
//   the largest note alone); 1Click names its least into SOL;
// - good_built: the card branch's build (build-app.mjs --out), with the 1Click answer of the same run: PASS.
// And three of card cash-least-read-again, 2026-11-18 13:2xZ, SIGN_HOST live (release 175), 1Click with its status:
// - good_live: PASS, 1Click's least named;
// - blip_live: 1Click's 400 "Failed to get quote" to one unit, as sign live run 44300899132 read at 12:09Z: INCONCLUSIVE;
// - bad_quote: 1Click's quote (201) where a least was asked: FAIL.
// Each plant fails on its own line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXIT, NO_LEAST, NO_MARK, blip, bundle, facts, judge } from "./cash-buys-spend-every-note.mjs";

const A = JSON.parse(readFileSync(new URL("./cash-buys-spend-every-note.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));

test("the card's build with 1Click's least named passes", () => {
  const v = judge(A.good_built);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(bad(v), []);
});

test("SIGN_HOST before the card fails: its bundle reads no least", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.ok, false);
  assert.deepEqual(bad(v), [NO_MARK]);
});

test("1Click naming no least fails the check: a refusal that names none, or a quote of one unit", () => {
  for (const oneclick of ['{"message":"recipient is not valid"}', '{"message":"Amount is too low for bridge, try at least 0"}', ""]) {
    assert.deepEqual(bad(judge({ ...A.good_built, oneclick })), [NO_LEAST], oneclick);
  }
  const v = judge(A.bad_quote);
  assert.equal(v.verdict, "FAIL");
  assert.equal(EXIT[v.verdict], 1);
  assert.deepEqual(bad(v), [NO_LEAST]);
  assert.deepEqual(bad(judge({ ...A.good_live, oneclick: '{"message":"recipient is not valid"}', status: 400 })), [NO_LEAST]);
});

test("SIGN_HOST live with 1Click's least, its status recorded, passes", () => {
  const v = judge(A.good_live);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(EXIT[v.verdict], 0);
});

test("a 1Click blip, the one the device asks again, is INCONCLUSIVE (exit 3, read again), never a PASS or a FAIL (card cash-least-read-again)", () => {
  const v = judge(A.blip_live);
  assert.equal(v.verdict, "INCONCLUSIVE", v.lines.join("\n"));
  assert.equal(v.ok, false);
  assert.equal(EXIT[v.verdict], 3);
  assert.deepEqual(bad(v), []);
  assert.ok(v.lines.some((l) => l.startsWith("INCONCLUSIVE ")), v.lines.join("\n"));
  for (const [oneclick, status] of [
    ['{"message":"No liquidity available"}', 400],
    ["<html>bad gateway</html>", 502],
    ['{"message":"Too many requests"}', 429],
    ["no answer: TimeoutError", 0],
    ['{"message":"Failed to get quote"}', undefined],
  ]) {
    assert.equal(judge({ ...A.good_live, oneclick, status }).verdict, "INCONCLUSIVE", `${status} ${oneclick}`);
    assert.equal(blip(oneclick, status), true);
  }
  // a broken build is a FAIL whatever 1Click answered
  assert.equal(judge({ ...A.blip_live, mark: false }).verdict, "FAIL");
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
  const js = 'const R=/"message"\\s*:\\s*"Amount is too low for bridge, try at least (\\d{1,30})"/;';
  const pinned = A.good_built.index.replace(/integrity="[^"]+"/, `integrity="${facts("", js, "").sha384}"`);
  assert.deepEqual(await bundle(served(pinned, js)), { ok: true, lines: [] });
  const v = await bundle(served(pinned, "const R=1;"));
  assert.equal(v.ok, false);
  assert.ok(v.lines.includes(NO_MARK), v.lines.join("\n"));
});

test("the mark is the least read's regex literal as the minifier keeps it, and nothing else", () => {
  const src = 'const R=/"message"\\s*:\\s*"Amount is too low for bridge, try at least (\\d{1,30})"/;';
  assert.equal(facts("", src, "").mark, true);
  assert.equal(facts("", "Amount is too low for bridge, try at least", "").mark, false);
});
