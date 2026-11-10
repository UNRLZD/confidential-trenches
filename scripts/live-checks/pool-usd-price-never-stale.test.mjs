// node --test scripts/live-checks/pool-usd-price-never-stale.test.mjs: the live check replays its recorded answers
// (pool-usd-price-never-stale.answers.json), each a 3-minute run of read() on the signing page's own Solana pair
// (provider A and the helper's keyed route) on 10 Nov:
//   good: the page's schedule (SCHEDULE): a price held from the first read to the end, never gone, each write held within
//         WRITE_HELD_MS of landing: PASS on the feed and the pin. Its SIGN_HOST bundle is release-110's, from before this
//         card, so the ledger line is judged against a release list that names it (planted) until release-FOLDED_FROM is
//         cut and the answer recorded again from it;
//   bad:  the page's schedule before this card (BEFORE: every 15 s): each write held up to 15 s after it landed: FAIL.
// Planted on the good one: a span with no price, too few writes, a short run, another pair, a write with no landing
// time, an unpinned bundle, a bundle no release list from FOLDED_FROM on names: each FAIL. And follow() itself on a
// recorded timeline (the 10 Nov 03:56-04:26Z writes), on a mocked clock: never gone, each write held within a second.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BEFORE, FOLDED_FROM, follow, foldedReleases, judge, RUN_MS, SCHEDULE, WRITE_HELD_MS, WRITES_MIN } from "./pool-usd-price-never-stale.mjs";
import { PAGE_PAIR } from "./signpage-pool-price.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-usd-price-never-stale.answers.json", import.meta.url), "utf8"));
const okLedger = (rec) => ({ folded: new Set([rec.sign.sha384]) });
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const planted = (f) => {
  const rec = structuredClone(A.good);
  f(rec);
  return judge(rec, okLedger(A.good));
};

test("recorded good answer: the page's schedule on its own pair, never gone, each write held within WRITE_HELD_MS: PASS", () => {
  const v = judge(A.good, okLedger(A.good));
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.ok(A.good.run.held.length - 1 >= WRITES_MIN);
  assert.deepEqual(A.good.run.gone, []);
});

test("recorded bad answer: the page's schedule before this card (every 15 s): writes held long after they landed: FAIL", () => {
  const v = judge(A.bad, okLedger(A.bad));
  assert.equal(v.ok, false);
  assert.ok(bad(v).some((l) => /^BAD the write published \d+ \(landed \d+\) was held \d+\.\d s after it landed, not within 3 s/.test(l)), v.lines.join("\n"));
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const s = A.good.run.startMs;
  const one = (f, re) => {
    const v = planted(f);
    assert.equal(v.ok, false, String(re));
    assert.ok(bad(v).some((l) => re.test(l)), v.lines.join("\n"));
  };
  one((r) => r.run.gone.push([s + 60_000, s + 62_000]), /^BAD no price for 2\.1 s, 60 s into the run: Buy off and no USD/);
  one((r) => (r.run.held = r.run.held.slice(0, WRITES_MIN)), new RegExp(`^BAD ${WRITES_MIN - 1} write\\(s\\) seen, not ${WRITES_MIN} or more`));
  one((r) => (r.run.endMs = s + RUN_MS / 2), /^BAD the feed was followed for 90 s, not 180 s/);
  one((r) => (r.rpcs = [PAGE_PAIR[0], "https://api.mainnet-beta.solana.com"]), /^BAD not the page's Solana pair/);
  one((r) => (r.run.held[1].blockTimeS = null), /^BAD the write published \d+ has no landing time/);
  one((r) => (r.run.held[1].heldMs = r.run.held[1].blockTimeS * 1000 + WRITE_HELD_MS + 500), /^BAD the write published \d+ \(landed \d+\) was held 3\.5 s after it landed/);
  one((r) => (r.run.held = []), /^BAD no price was ever held/);
  one((r) => (r.sign.sha384 = "sha384-other"), /^BAD SIGN_HOST's served \/app\.js is not the one index\.html pins/);
  one((r) => (r.sign.index = "<html></html>"), /^BAD SIGN_HOST's index\.html pins no \/app\.js/);
  const v = judge(A.good, { folded: new Set() });
  assert.deepEqual(bad(v), [`BAD SIGN_HOST's /app.js is not a release-${FOLDED_FROM}-or-later build: ${A.good.sign.sha384}`]);
  assert.equal(judge(null, okLedger(A.good)).ok, false);
});

test("the ledger: release lists from FOLDED_FROM on; none names release-110's bundle, which the good answer was recorded on", () => {
  assert.ok(!foldedReleases().has(A.good.sign.sha384));
  assert.ok(foldedReleases(undefined, 110).has(A.good.sign.sha384), "the good answer's bundle is release-110's");
});

// the writes read 10 Nov 03:56-04:26Z: [publish time step from the last write, s; the price's age when it landed, s]
const WRITES = [[53, 2], [54, 3], [56, 2], [50, 2], [57, 1], [53, 3], [55, 2], [54, 2]];
async function onTimeline(schedule) {
  let t = 1_794_282_000_000;
  const now = () => t;
  const sleep = async (ms) => void (t += ms);
  const lands = [];
  let pub = Math.floor(t / 1000) - 10;
  lands.push({ atMs: 0, pubS: pub });
  let at = (pub + 10) * 1000;
  for (const [step, lag] of WRITES) {
    pub += step;
    at = (pub + lag) * 1000;
    lands.push({ atMs: at, pubS: pub });
  }
  const read = async () => {
    const p = lands.filter((w) => w.atMs <= t).at(-1).pubS;
    if (t / 1000 - p > 75) throw Object.assign(new Error(`the price is older than 75 s: published ${p}`), { name: "PoolUsdStale", publishedS: p });
    return { chain: "solana", price: 1n, expo: -8, publishedS: p, at: BigInt(p) };
  };
  const run = await follow({ read, now, sleep, untilMs: at + 10_000, schedule });
  const late = run.held.slice(1).map((h) => h.heldMs - lands.find((w) => w.pubS === h.publishedS).atMs);
  return { run, late };
}

test("follow() on the 10 Nov writes, a mocked clock: the page's schedule is never gone and holds each write within a second; before this card, up to 15 s late", async () => {
  const now = await onTimeline(SCHEDULE);
  assert.deepEqual(now.run.gone, []);
  assert.equal(now.late.length, WRITES.length);
  assert.ok(now.late.every((ms) => ms <= SCHEDULE.pollMs), String(now.late));
  const before = await onTimeline(BEFORE);
  assert.ok(Math.max(...before.late) > WRITE_HELD_MS, String(before.late));
  assert.ok(before.late.every((ms) => ms <= BEFORE.refreshMs), String(before.late));
});
