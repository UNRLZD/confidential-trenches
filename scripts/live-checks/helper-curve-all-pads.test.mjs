// node --test scripts/live-checks/helper-curve-all-pads.test.mjs: the live check replays recorded answers
// (helper-curve-all-pads.answers.json). good: the deployed helper read 2026-11-19 11:04Z, Graduating holding met-dbc,
// raydium-launchlab and pump.fun rows, with every Jupiter answer and account the re-read got: PASS. bad_pump_only: the
// same run with Graduating cut to its pump.fun rows, while the re-read finds a LaunchLab and two DBC tokens on their
// curve: FAIL. Made from the good answer: a graduating row off its curve, no graduating list, and a run with no token
// off pump.fun on a curve (which passes and says so). A no-answer from the RPC or Jupiter (read through
// provider-answer.mjs) with none found on a curve is INCONCLUSIVE, never a PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP, BASE, JUP, RPC, candidates, judge, read, reread } from "./helper-curve-all-pads.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-curve-all-pads.answers.json"), "utf8"));
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

// a fetch answering the helper's recorded answer, Jupiter's recorded search and each account from the recording; a
// request the recording does not hold fails the test
const replay = (a, body) => async (url, init) => {
  if (url.startsWith(BASE)) {
    assert.equal(url, `${BASE}/v1/market/lists?chain=solana`);
    assert.equal(init.headers.origin, APP);
    return new Response(body, { status: a.answer.status });
  }
  if (url.startsWith(JUP)) return json(a.jupiter);
  assert.equal(url, RPC);
  const keys = JSON.parse(init.body).params[0];
  for (const k of keys) assert.ok(Object.hasOwn(a.accounts, k), `unrecorded account ${k}`);
  return json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: keys.map((k) => a.accounts[k]) } });
};
const run = async (a, edit, wrap = (f) => f) => {
  const s = JSON.parse(a.answer.body);
  if (edit) edit(s);
  const body = JSON.stringify(s);
  const r = await read(BASE, replay(a, body));
  const log = { jupiter: null, accounts: {}, noAnswer: null };
  const origins = await reread(candidates(s.lists, s.unsettled), wrap(replay(a, body)), RPC, log);
  return judge(r, origins, log.noAnswer);
};
const bad = (r) => r.lines.filter((l) => !l.startsWith("ok")).join("\n");

test("good: the deployed helper, Graduating with LaunchLab and DBC rows beside pump.fun's: PASS", async () => {
  const r = await run(A.good);
  assert.ok(r.ok, bad(r));
  assert.ok(r.lines.some((l) => /re-read on chain: \d+ of \d+ .* [1-9]\d* on a curve/.test(l)), bad(r));
  assert.ok(r.lines.some((l) => /graduating per launchpad: .*"met-dbc".*"raydium-launchlab"/.test(l)), bad(r));
});

test("bad_pump_only: Graduating pump.fun only while a LaunchLab and DBC tokens are on a curve: FAIL", async () => {
  const r = await run(A.bad_pump_only);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && /graduating holds 0 rows off pump.fun while [1-9]/.test(l)), bad(r));
});

test("made from good: a graduating row off its curve and a missing list FAIL; no token off pump.fun on a curve PASSes and says so", async () => {
  const off = await run(A.good, (s) => (s.lists.graduating[0].curve_bps = 10_000));
  assert.equal(off.ok, false, "a row at 10,000");
  const untagged = await run(A.good, (s) => (s.lists.graduating[0].launchpad = null));
  assert.equal(untagged.ok, false, "a row with no launchpad");
  const none = await run(A.good, (s) => delete s.lists.graduating);
  assert.equal(none.ok, false, "no graduating list");
  const status = judge({ status: 503, body: "{}" }, new Map());
  assert.equal(status.ok, false, "not 200");
  // every listed token off pump.fun at 10,000: nothing to re-read, Graduating pump.fun only passes
  const quiet = await run(A.bad_pump_only, (s) => {
    for (const k of ["new", "trending_5m", "trending_1h"]) for (const r of s.lists[k]) if (r.launchpad !== "pump.fun") r.curve_bps = 10_000;
  });
  assert.ok(quiet.ok, bad(quiet));
  assert.ok(quiet.lines.some((l) => l.includes("no listed token off pump.fun is on a curve now")));
});

test("candidates: listed, not at 10,000, not unsettled, off pump.fun, the helper's tagged first, at most SAMPLE", () => {
  const t = (n) => `${"1".repeat(31)}${"ABCDEFGHJK"[n]}`;
  const lists = {
    new: [{ token: t(0), launchpad: null, curve_bps: null }, { token: t(1), launchpad: "met-dbc", curve_bps: 10_000 }, { token: t(2), launchpad: "pump.fun", curve_bps: 50 }],
    trending_5m: [{ token: t(3), launchpad: "raydium-launchlab", curve_bps: 900 }, { token: t(4), launchpad: null, curve_bps: null }],
    trending_1h: [{ token: t(3), launchpad: "raydium-launchlab", curve_bps: 900 }],
  };
  assert.deepEqual(candidates(lists, [t(4)]).map((r) => r.token), [t(3), t(0)]);
});

test("a no-answer: the RPC's 429 or Jupiter's refusal with none found on a curve is INCONCLUSIVE, never a PASS; a wrong Graduating with a no-answer elsewhere still FAILs", async () => {
  const rpc429 = (f) => async (url, init) => (url === RPC ? new Response("", { status: 429 }) : f(url, init));
  const r = await run(A.bad_pump_only, undefined, rpc429);
  assert.equal(r.verdict, "INCONCLUSIVE", bad(r));
  assert.ok(r.lines.some((l) => l.includes("429") && l.includes("INCONCLUSIVE")), bad(r));
  const jup = (f) => async (url, init) => (url.startsWith(JUP) ? new Response("busy", { status: 503 }) : f(url, init));
  assert.equal((await run(A.bad_pump_only, undefined, jup)).verdict, "INCONCLUSIVE");
  // a graduating row off its curve is wrong whatever the re-read answered
  assert.equal((await run(A.good, (s) => (s.lists.graduating[0].curve_bps = 10_000), rpc429)).verdict, "FAIL");
  assert.equal((await run(A.good)).verdict, "PASS");
  assert.equal((await run(A.bad_pump_only)).verdict, "FAIL");
});
