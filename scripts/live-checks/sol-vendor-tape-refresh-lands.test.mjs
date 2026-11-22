// node --test scripts/live-checks/sol-vendor-tape-refresh-lands.test.mjs: the check replays its recorded answers
// (sol-vendor-tape-refresh-lands.answers.json, each run's source in its _about): this card's local helper passes; main
// before it fails, a held vendor tape's rows read up to 42 s before; a run with no coin served from the vendor long
// enough is no verdict, never a pass; a named age at the bound passes and one past it fails; the read leaves a coin
// that answers from our own chain reads and holds the next one HOLD_MS. Card sol-vendor-tape-waits-past-reach: the
// judged coin is then read GAPS times, each after GAP_MS unread; its good answer is that card's local helper, its bad
// one main before it, whose gap reads were served the held rows past SOL_VENDOR_REACH_MS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CANDIDATES, GAP_MS, GAPS, HOLD_MS, judge, MIN_VENDOR, POLL_MS, read, totalOf } from "./sol-vendor-tape-refresh-lands.mjs";
import { SOL_VENDOR_REACH_MS } from "../../apps/helper/src/data/solana/trades.ts";

const A = JSON.parse(readFileSync(new URL("./sol-vendor-tape-refresh-lands.answers.json", import.meta.url), "utf8"));

test("the recorded good answer, this card's helper: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer, main before card sol-vendor-tape-waits-past-reach: FAIL, its gap reads' rows past SOL_VENDOR_REACH_MS", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines.find((l) => l.startsWith("BAD")), /after 17 s unread.*past it$/);
});

// Card sol-vendor-tape-gap-served-inside-reach: rows past the reach are BAD, and an answer past it that does not say
// filling is a second, separate BAD (the page draws it as live); saying filling never makes rows past the reach pass.
test("the recorded answer of the deployed helper before card sol-vendor-tape-gap-served-inside-reach: FAIL on both rules, POPCAT's third gap read served rows 19,651 ms old with no word of it", () => {
  const r = judge(A.gapUnsaid);
  assert.equal(r.ok, false, r.lines.join("\n"));
  const badLines = r.lines.filter((l) => l.startsWith("BAD"));
  assert.deepEqual(badLines, [
    "BAD 7GCihgDB8f: 3 vendor answers after 17 s unread, rows read 1, 0, 19651 ms before (at most 15000): 1 past it",
    "BAD 7GCihgDB8f: 1 gap answers past 15000 ms, each saying filling: 1 with no word of it",
  ]);
});

test("planted: a gap or hold read past the reach saying filling still FAILs, on the reach alone; without filling it FAILs on both; a filling read inside the reach passes", () => {
  const judged = (r) => r.coins.find((c) => Array.isArray(c.gaps));
  const said = structuredClone(A.gapUnsaid);
  judged(said).gaps[2].filling = true;
  const v = judge(said);
  assert.equal(v.ok, false, v.lines.join("\n"));
  assert.deepEqual(v.lines.filter((l) => l.startsWith("BAD")), ["BAD 7GCihgDB8f: 3 vendor answers after 17 s unread, rows read 1, 0, 19651 ms before (at most 15000): 1 past it"]);
  assert.ok(v.lines.includes("ok 7GCihgDB8f: 1 gap answers past 15000 ms, each saying filling: yes"), v.lines.join("\n"));
  const early = structuredClone(A.good);
  judged(early).gaps[0].filling = true;
  assert.equal(judge(early).ok, true);
  for (const filling of [true, false]) {
    const hold = structuredClone(A.good);
    const h = judged(hold).reads.find((x) => /rows read \d+ ms ago/.test(x.timing));
    h.timing = h.timing.replace(/rows read \d+ ms ago/, `rows read ${SOL_VENDOR_REACH_MS + 1} ms ago`);
    if (filling) h.filling = true;
    const j = judge(hold);
    assert.equal(j.ok, false, j.lines.join("\n"));
    const bad = j.lines.filter((l) => l.startsWith("BAD"));
    assert.equal(bad.length, filling ? 1 : 2, bad.join("\n"));
    assert.match(bad[0], /past it$/);
    if (!filling) assert.match(bad[1], /1 hold answers past 15000 ms, each saying filling: 1 with no word of it$/);
  }
});

test("planted gap reads: one at the bound passes, one past it fails, a 503 fails; none from the vendor, or none at all, is no verdict", () => {
  const judged = (r) => r.coins.find((c) => Array.isArray(c.gaps));
  const at = structuredClone(A.good);
  const g = judged(at).gaps[0];
  g.timing = g.timing.replace(/rows read \d+ ms ago/, `rows read ${SOL_VENDOR_REACH_MS} ms ago`);
  assert.equal(judge(at).ok, true, "at the bound");
  g.timing = g.timing.replace(/rows read \d+ ms ago/, `rows read ${SOL_VENDOR_REACH_MS + 1} ms ago`);
  assert.equal(judge(at).ok, false, "past it");
  const s = structuredClone(A.good);
  judged(s).gaps.at(-1).status = 503;
  assert.equal(judge(s).ok, false, "a 503");
  const none = structuredClone(A.good);
  for (const x of judged(none).gaps) x.timing = "";
  assert.equal(judge(none).ok, null, "no gap answer from the vendor");
  const gone = structuredClone(A.good);
  delete judged(gone).gaps;
  assert.equal(judge(gone).ok, null, "no gap read");
});

test("planted: a named age at the bound passes, one past it fails; a non-200 fails; too few vendor answers is no verdict", () => {
  const vendor = (r) => r.coins.find((c) => c.reads.filter((x) => /sol-vendor-read/.test(x.timing)).length >= MIN_VENDOR);
  const at = structuredClone(A.good);
  const x = vendor(at).reads.find((x) => /sol-vendor-read/.test(x.timing));
  x.timing = x.timing.replace(/rows read \d+ ms ago/, `rows read ${SOL_VENDOR_REACH_MS} ms ago`);
  assert.equal(judge(at).ok, true, "at the bound");
  x.timing = x.timing.replace(/rows read \d+ ms ago/, `rows read ${SOL_VENDOR_REACH_MS + 1} ms ago`);
  assert.equal(judge(at).ok, false, "past it");
  const s = structuredClone(A.good);
  vendor(s).reads.at(-1).status = 503;
  assert.equal(judge(s).ok, false, "a 503");
  const few = structuredClone(A.good);
  const c = vendor(few);
  c.reads = c.reads.slice(0, MIN_VENDOR - 1);
  const r = judge(few);
  assert.equal(r.ok, null, r.lines.join("\n"));
  assert.equal(judge({ coins: [] }).ok, null);
});

test("read: a coin answered from our own chain reads is left at its first answer; the next one, from the vendor, is held HOLD_MS every POLL_MS", async () => {
  let t = Date.parse("2026-11-18T14:10:00Z");
  const asked = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/v1/market/lists") return new Response(JSON.stringify({ lists: { trending_1h: [] } }), { status: 200 });
    const token = u.searchParams.get("token");
    asked.push(token);
    const vendor = token === CANDIDATES[1];
    return new Response(JSON.stringify({ trades: [], src: vendor ? "coingecko" : "chain", as_of_ms: t - 1_000 }), { status: 200, headers: vendor ? { "server-timing": `sol-vendor-read;desc="rows read 1000 ms ago"` } : {} });
  };
  const r = await read("http://h", fetchFn, async (ms) => void (t += ms), () => t);
  assert.deepEqual(r.coins.map((c) => c.reads.length), [1, Math.floor(HOLD_MS / POLL_MS) + 1]);
  // then GAPS reads of the judged coin, each GAP_MS after the one before
  const gaps = r.coins[1].gaps;
  assert.equal(gaps.length, GAPS);
  assert.equal(gaps[0].at - r.coins[1].reads.at(-1).at, GAP_MS);
  assert.equal(gaps[1].at - gaps[0].at, GAP_MS);
  assert.equal(r.coins[0].gaps, undefined, "a coin not judged is not gap-read");
  assert.equal(asked.filter((x) => x === CANDIDATES[0]).length, 1);
  assert.equal(judge(r).ok, true, judge(r).lines.join("\n"));
});

// Card sol-vendor-tape-refresh-lands-live: on 22 Nov BONK, WIF, JUP and POPCAT were all held by the lists, so served from
// our own chain reads, and the run had nothing to judge (live run 45006783900; the read of 11:02Z, recorded below as
// allListed). Red at fd4d3d39a: every candidate read, none from the vendor, no verdict.
test("read: a candidate the lists hold now is not read; the first candidate no list holds is judged (red at fd4d3d39a: the four listed candidates read, nothing to judge)", async () => {
  let t = Date.parse("2026-11-22T11:02:00Z");
  const asked = [];
  const listed = CANDIDATES.slice(0, 4);
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/v1/market/lists") return new Response(JSON.stringify({ lists: { new: [{ token: listed[0] }], trending_5m: [{ token: listed[1] }, { token: listed[2] }], trending_1h: [{ token: listed[3] }] } }), { status: 200 });
    const token = u.searchParams.get("token");
    asked.push(token);
    const vendor = !listed.includes(token);
    return new Response(JSON.stringify({ trades: [], src: vendor ? "coingecko" : "chain", as_of_ms: t - 1_000 }), { status: 200, headers: vendor ? { "server-timing": `sol-vendor-read;desc="rows read 1000 ms ago", total;dur=12` } : {} });
  };
  const r = await read("http://h", fetchFn, async (ms) => void (t += ms), () => t);
  assert.deepEqual(r.coins.map((c) => c.coin), [CANDIDATES[4]], "the listed four unread, the fifth judged");
  assert.equal(asked.filter((x) => listed.includes(x)).length, 0);
  const v = judge(r);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.ok(v.lines.includes(`--  ${CANDIDATES[4].slice(0, 10)}: gap answers took 12, 12, 12 ms (Server-Timing total)`), v.lines.join("\n"));
});

test("the recorded read of 22 Nov 11:02Z, every coin tried held by the lists and answered from our chain reads: no verdict, never a pass", () => {
  const r = judge(A.allListed);
  assert.equal(r.ok, null, r.lines.join("\n"));
  assert.equal(r.lines.at(-1), "--  no coin served from the vendor's rows long enough to judge");
});

test("totalOf reads Server-Timing's total, null without it", () => {
  assert.equal(totalOf(`sol-vendor-read;desc="rows read 5 ms ago", total;dur=633.4`), 633);
  assert.equal(totalOf(`sol-vendor-read;desc="rows read 5 ms ago"`), null);
});
