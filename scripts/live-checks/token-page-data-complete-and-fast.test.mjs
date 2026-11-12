// node --test scripts/live-checks/token-page-data-complete-and-fast.test.mjs: the live check replays recorded answers
// (token-page-data-complete-and-fast.answers.json). bad_deployed: the deployed helper before this card (release 116),
// 2026-11-11 15:50Z: every row icon false, GET /v1/logo a 404 with a JSON body, no `links`, a busy pump.fun coin quoted
// in another coin with an empty tape: FAIL. good: assembled, its three logo reads from this branch's route run locally
// on Jupiter's public top trending icons (200 image/webp with the route's headers), the rest the deployed run edited to
// the end state (icon true on those rows, a 404 with no body for an icon-false row, `links`, the empty tape filled):
// PASS. Replace it with the first deployed run's record (--record). Made from the good answer: an SVG, no nosniff, a
// body bigger than the cap, bytes that are not the type, a 404 with a body, a script link, an empty tape: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, magic, picks } from "./token-page-data-complete-and-fast.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "token-page-data-complete-and-fast.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (fn) => {
  const rec = structuredClone(A.good);
  fn(rec);
  return rec;
};

test("the good answer passes", () => {
  const r = judge(A.good);
  assert.deepEqual(bad(r), []);
  assert.equal(r.ok, true);
});

test("the deployed helper before this card fails: no icon, the logo route not served, no links, an empty busy tape", () => {
  const r = judge(A.bad_deployed);
  assert.equal(r.ok, false);
  const b = bad(r).join("\n");
  for (const want of [/0 of \d+ rows have icon true/, /icon false: logo 404, 21 bytes/, /links none/, /200\/0 rows/]) assert.match(b, want);
});

test("a logo that breaks a rule fails: SVG, no nosniff, no CSP, past the cap, bytes not its type", () => {
  const svg = edit((r) => (r.logos[0].headers["content-type"] = "image/svg+xml"));
  const sniff = edit((r) => delete r.logos[0].headers["x-content-type-options"]);
  const csp = edit((r) => (r.logos[0].headers["content-security-policy"] = "default-src *"));
  const big = edit((r) => (r.logos[0].length = 262_145));
  const bytes = edit((r) => (r.logos[0].head = Buffer.from("<svg xmlns=").toString("hex")));
  const cache = edit((r) => (r.logos[0].headers["cache-control"] = "no-store"));
  for (const rec of [svg, sniff, csp, big, bytes, cache]) assert.equal(judge(rec).ok, false);
  // a source that refused is a 204 with no body, and fine while one logo serves
  assert.equal(judge(edit((r) => (r.logos[1] = { ...r.logos[1], status: 204, headers: {}, length: 0, head: "" }))).ok, true);
  assert.equal(judge(edit((r) => (r.logos = r.logos.map((l) => ({ ...l, status: 204, headers: {}, length: 0, head: "" }))))).ok, false, "none served");
  // card app-live-run-green-after-119: a listed logo answered 404 is a failed load the browser logs as a console error
  assert.equal(judge(edit((r) => (r.logos[1] = { ...r.logos[1], status: 404, headers: {}, length: 0, head: "" }))).ok, false, "a 404 for an icon-true row");
  assert.equal(judge(edit((r) => (r.logos[1] = { ...r.logos[1], status: 204, headers: {}, length: 3, head: "" }))).ok, false, "a 204 with a body");
});

test("a row with icon false that answers a body, a script link and an empty tape each fail", () => {
  assert.equal(judge(edit((r) => (r.plain.length = 21))).ok, false);
  // the helper's no-logo answer for it: 204 with no body (card app-live-run-green-after-119), or the 404 before it
  assert.equal(judge(edit((r) => (r.plain = { ...r.plain, status: 204, length: 0 }))).ok, true);
  assert.equal(judge(edit((r) => (r.plain = { ...r.plain, status: 200, length: 0 }))).ok, false);
  assert.equal(judge(edit((r) => (r.page.links = { site: "javascript:alert(1)" }))).ok, false);
  assert.equal(judge(edit((r) => delete r.page.links)).ok, false, "no links field");
  assert.equal(judge(edit((r) => (r.tapes[0].reads = r.tapes[0].reads.map((x) => ({ ...x, rows: 0 }))))).ok, false);
  assert.equal(judge(edit((r) => (r.tapes[0].reads = [r.tapes[0].reads[0], { ...r.tapes[0].reads[1], atMs: r.tapes[0].reads[0].atMs + 2_500 }].map((x, i) => ({ ...x, rows: i === 0 ? 0 : 5 }))))).ok, false, "rows only after 2 s");
});

test("magic and picks read what they say", () => {
  assert.equal(magic("89504e470d0a1a0a00"), "image/png");
  assert.equal(magic("ffd8ffe0"), "image/jpeg");
  assert.equal(magic(Buffer.from("<svg").toString("hex")), null);
  const p = picks([{ mint: "a", icon: true, launchpad: "pump.fun", buys_5m: 50 }, { mint: "b", icon: false, launchpad: "pump.fun", buys_5m: 9 }, { mint: "c", icon: false, launchpad: null, buys_5m: 99 }]);
  assert.deepEqual(p, { tapes: ["a"], icons: ["a"], plain: "b", page: "a" });
});
