// node --test scripts/live-checks/app-footer-bar.test.mjs: the live check's verdict replays recorded runs
// (app-footer-bar.answers.json), each read on 8 Nov by app-footer-bar.mjs collect() in headless Chromium at 1440, signed out:
//   good: this card's build at the hosts' names inside the stand-in shell (--harness), a local chain: the footer draws
//         Stable with its round trip and the block, the block moves and keeps with NEAR's, Terms, Privacy and Verify,
//         no price signed out: PASS;
//   bad:  the deployed APP_HOST before this card: no connection and no block in the footer: FAIL.
// Planted from the good run: a static block, a block far behind or ahead of NEAR's, a block not drawn as read,
// Offline, no round trip, a price drawn signed out, a link to a page the app has not, a link missing, one read only,
// a footer outside SIGN_HOST's shell.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROUTES as APP_ROUTES } from "../../apps/terminal/src/routes/routes.ts";
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";
import { judge, NEAR_RPCS, NEAR_SLACK, ROUTES } from "./app-footer-bar.mjs";
import { nearChain } from "./app-in-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-footer-bar.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: Stable, the block moving with NEAR's, Terms, Privacy and Verify, no price signed out: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  const [a, b] = ANSWERS.good.reads;
  assert.ok(b.block > a.block);
});

test("recorded bad answer: the deployed footer before this card draws no connection and no block: FAIL", () => {
  const r = judge(ANSWERS.bad);
  fails(r, /no block drawn/);
  fails(r, /connection not drawn/);
  fails(r, /the block moved: none -> none/);
});

test("the check's lists are the app's: its routes and the mainnet pair the footer reads", () => {
  assert.deepEqual([...new Set(APP_ROUTES.map((r) => r.path))].filter((p) => !p.includes(":")).sort(), [...ROUTES].sort());
  assert.deepEqual(NEAR_RPCS, VERIFY_RELEASES.mainnet.rpcs);
});

test("planted: a static block, or one going back: FAIL", () => {
  fails(mut((r) => (r.reads[1] = { ...r.reads[1], block: r.reads[0].block, blockText: r.reads[0].blockText })), /the block moved/);
  fails(mut((r) => (r.reads[1] = { ...r.reads[1], block: r.reads[0].block - 1, blockText: `Block ${(r.reads[0].block - 1).toLocaleString("en-US")}` })), /the block moved/);
});

test("planted: a block far from NEAR's own final block, behind or ahead: FAIL", () => {
  fails(mut((r) => (r.reads[0].near = r.reads[0].block + NEAR_SLACK.behind + 1)), /behind/);
  fails(mut((r) => (r.reads[0].near = r.reads[0].block - NEAR_SLACK.ahead - 1)), /ahead/);
  fails(mut((r) => (r.reads[0].near = null)), /not held to NEAR's final block/);
});

test("planted: a block drawn as other than read, or not drawn: FAIL", () => {
  fails(mut((r) => (r.reads[0].blockText = "Block 220,948,200")), /read 1: draws/);
  fails(mut((r) => Object.assign(r.reads[0], { block: null, blockText: "Block —" })), /no block drawn/);
});

test("planted: Offline, a missing round trip, the connection not drawn: FAIL", () => {
  fails(mut((r) => Object.assign(r.reads[0], { conn: "off", health: "Offline", ms: null })), /read 1: connection off/);
  fails(mut((r) => (r.reads[1].ms = null)), /no round trip/);
  fails(mut((r) => Object.assign(r.reads[0], { conn: null, health: null })), /connection not drawn/);
});

test("planted: a price drawn signed out: FAIL", () => {
  fails(mut((r) => (r.reads[0].ticks = ["SOL $106.83"])), /prices drawn signed out/);
});

test("planted: a link to a page the app has not, a link missing or added: FAIL", () => {
  fails(mut((r) => (r.links = ["/terms", "/privacy", "/risks", "/verify"])), /links to pages the app does not have: \/risks/);
  fails(mut((r) => (r.links = ["/terms", "/verify"])), /the footer's links/);
  fails(mut((r) => (r.links = [])), /the footer's links: none/);
});

test("planted: one read only, outside the shell, signed in: FAIL", () => {
  fails(mut((r) => (r.reads = r.reads.slice(0, 1))), /1 footer read\(s\) of 2/);
  fails(mut((r) => (r.framed = false)), /not inside SIGN_HOST's shell/);
  fails(mut((r) => (r.header = "S1.4")), /not signed out/);
});

test("the harness's local chain finalises one block per 600 ms", () => {
  let t = 0;
  const c = nearChain(100, () => t);
  assert.equal(c.height(), 100);
  t = 1_199;
  assert.equal(c.height(), 101);
  t = 6_000;
  assert.equal(c.height(), 110);
});
