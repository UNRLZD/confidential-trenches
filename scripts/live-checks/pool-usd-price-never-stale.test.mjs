// node --test scripts/live-checks/pool-usd-price-never-stale.test.mjs: the live check replays its recorded answers
// (pool-usd-price-never-stale.answers.json), each a 3-minute run of read() on the signing page's own Solana pair
// (provider A and the helper's keyed route) on 10 Nov:
//   good: the page's schedule (SCHEDULE: from publish + 55 s, each 3 s): a price held from the first read to the end,
//         never gone, each write held within WRITE_HELD_MS of landing; its `sign` is facts() over this tree's own
//         signing page build (SIGN_HOST still served release-110's when it was recorded), so the release list line is
//         judged against a list that names it (planted) until a release of this card is cut and the answer recorded again;
//   bad:  the page's schedule before this card (BEFORE: every 15 s), and SIGN_HOST's page as served then
//         (release-110): writes held up to 11.6 s after they landed, the 60 s bound, no schedule at the write: FAIL.
// Planted on the good one: a span with no price, too few writes, a short run, another pair, a write with no landing
// time, a late hold, an unpinned bundle, a bundle in no release list: each FAIL. And on this tree's own build (review of
// eb2dfdc5, P2-3): the bundle of release-110 under any release number, the 60 s bound, the 15 s schedule, the 1 s poll,
// no timer rearm and no late tag each FAIL on the bundle's marks. And follow() on a mocked clock: the 10 Nov writes; a
// feed that stops (its price gone from its end, judged FAIL; the late window ends at end + leadMs); a provider answering
// an older price (never held over the newer one) (review of eb2dfdc5, L4, L5, L7).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { BEFORE, BOUND_S, facts, follow, foldedReleases, HEARTBEAT_FROM_S, judge, MOVE_HELD_MS, RUN_MS, SCHEDULE, WRITE_HELD_MS, WRITES_MIN } from "./pool-usd-price-never-stale.mjs";
import { PAGE_PAIR } from "./signpage-pool-price.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-usd-price-never-stale.answers.json", import.meta.url), "utf8"));
const okLedger = (rec) => ({ folded: new Set([rec.sign.sha384]) });
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const planted = (f) => {
  const rec = structuredClone(A.good);
  f(rec);
  return judge(rec, okLedger(rec));
};

test("recorded good answer: the page's schedule on its own pair, never gone, each write held within WRITE_HELD_MS, the bundle's marks: PASS", () => {
  const v = judge(A.good, okLedger(A.good));
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.ok(A.good.run.held.length - 1 >= WRITES_MIN);
  assert.deepEqual(A.good.run.gone, []);
  assert.equal(A.good.sign.boundS, BOUND_S);
});

test("recorded good answer on a moving market (the account written each 15 s): writes on a move held within MOVE_HELD_MS, never gone: PASS", () => {
  const v = judge(A.goodMoving, okLedger(A.goodMoving));
  assert.equal(v.ok, true, v.lines.join("\n"));
  const w = A.goodMoving.run.held;
  assert.ok(w.slice(1).some((x, i) => x.blockTimeS - w[i].publishedS < HEARTBEAT_FROM_S), "a write on a move is in it");
  // the same writes held to the heartbeat's bound would fail: the two bounds are not one
  const tight = judge({ ...A.goodMoving, run: { ...A.goodMoving.run, held: w.map((x, i) => (i === 0 ? x : { ...x, heldMs: Math.max(x.heldMs, x.blockTimeS * 1000 + MOVE_HELD_MS + 1) })) } }, okLedger(A.goodMoving));
  assert.equal(tight.ok, false);
});

test("recorded bad answer: the page before this card (every 15 s, the 60 s bound, release-110's bundle): FAIL on the holds and on every mark, even with its bundle in a release list", () => {
  const v = judge(A.bad, okLedger(A.bad));
  assert.equal(v.ok, false);
  const b = bad(v);
  assert.ok(b.some((l) => /^BAD the write published \d+ \(landed \d+, \d+ s into the last price, at the heartbeat\) was held \d+\.\d s after it landed, not within 5 s/.test(l)), v.lines.join("\n"));
  assert.ok(b.includes(`BAD SIGN_HOST's page holds Solana's price 60 s, not ${BOUND_S} s: a price between writes runs out`), v.lines.join("\n"));
  assert.ok(b.some((l) => l.startsWith("BAD SIGN_HOST's page reads on no schedule at the write")), v.lines.join("\n"));
  assert.ok(foldedReleases(undefined, 110).has(A.bad.sign.sha384), "the bad answer's bundle is release-110's");
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
  one((r) => (r.run.held[1].heldMs = r.run.held[1].blockTimeS * 1000 + WRITE_HELD_MS + 500), /^BAD the write published \d+ \(landed \d+, \d+ s into the last price, at the heartbeat\) was held 5\.5 s after it landed/);
  one((r) => (r.run.held = []), /^BAD no price was ever held/);
  one((r) => (r.sign.index = "<html></html>"), /^BAD SIGN_HOST's index\.html pins no \/app\.js/);
  // a bundle the index does not pin
  const v = judge({ ...A.good, sign: { ...A.good.sign, sha384: "sha384-other" } }, okLedger(A.good));
  assert.ok(bad(v).includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"), v.lines.join("\n"));
  // a bundle in no release list
  assert.deepEqual(bad(judge(A.good, { folded: new Set() })), [`BAD SIGN_HOST's /app.js is in no release list: ${A.good.sign.sha384}`]);
  assert.equal(judge(null, okLedger(A.good)).ok, false);
});

test("planted on this tree's own signing page build (review P2-3): release-110's bundle under any number, the 60 s bound, the 15 s schedule, the 1 s poll, no rearm, no late tag: each FAILs on the bundle's marks", () => {
  const dir = signBuilt();
  const js = readFileSync(path.join(dir, "public/app.js"), "utf8");
  const index = readFileSync(path.join(dir, "index.html"), "utf8");
  const asBuilt = facts(index, js);
  assert.deepEqual({ boundS: asBuilt.boundS, schedule: asBuilt.schedule, rearm: asBuilt.rearm, late: asBuilt.late }, { boundS: BOUND_S, schedule: { ...SCHEDULE }, rearm: true, late: true }, "this tree's build carries every mark");
  const on = (edit, re) => {
    const j = edit(js);
    assert.notEqual(j, js, String(re));
    const f = facts(index.replace(/integrity="sha384-[^"]+"/, `integrity="${facts("", j).sha384}"`), j);
    const v = judge({ ...A.good, sign: f }, { folded: new Set([f.sha384]) });
    assert.equal(v.ok, false, String(re));
    assert.ok(bad(v).some((l) => re.test(l)), v.lines.join("\n"));
  };
  // the 60 s bound
  on((j) => j.replace(/(7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE[^}]{0,400}?maxAgeS:)75/, "$160"), /^BAD SIGN_HOST's page holds Solana's price 60 s, not 75 s/);
  // the 15 s schedule: no lead or poll before wakeWhenShown
  on((j) => j.replace(/(var [\w$]+=15e3,[\w$]+=1e3,[\w$]+=6e4),[\w$]+=2e4,[\w$]+=3e3;/, "$1;"), /^BAD SIGN_HOST's page reads on no schedule at the write/);
  // the as-built 1 s poll from publish + 50 s
  on((j) => j.replace(/(var [\w$]+=15e3,[\w$]+=1e3,[\w$]+=6e4,[\w$]+=)2e4,([\w$]+=)3e3;/, "$125e3,$21e3;"), /^BAD SIGN_HOST's page reads on refresh 15000, retry 1000, Retry-After cap 60000, lead 25000, poll 1000/);
  // the timer that does not make its own read due
  on((j) => j.replace(/([\w$]+)\.get\(([\w$]+)\)===([\w$]+)&&\1\.set\(\2,Math\.min\(\3,[\w$]+\(\)\)\),/, ""), /^BAD SIGN_HOST's page's timer does not make its own read due/);
  // no late tag
  on((j) => j.replace(/\.name===`PoolUsdStale`/, ".name===`PoolUsdLate`"), /^BAD SIGN_HOST's page does not tell a late feed/);
  // release-110's bundle (the bad answer's facts) under a new release number: in the ledger, and still FAIL
  const old = judge({ ...A.good, sign: A.bad.sign }, { folded: new Set([A.bad.sign.sha384]) });
  assert.equal(old.ok, false);
  assert.ok(bad(old).length >= 4, old.lines.join("\n"));
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
    if (t / 1000 - p > BOUND_S) throw Object.assign(new Error(`the price is older than ${BOUND_S} s: published ${p}`), { name: "PoolUsdStale", publishedS: p });
    return { chain: "solana", price: 1n, expo: -8, publishedS: p, at: BigInt(p) };
  };
  const run = await follow({ read, now, sleep, untilMs: at + 10_000, schedule });
  const late = run.held.slice(1).map((h) => h.heldMs - lands.find((w) => w.pubS === h.publishedS).atMs);
  return { run, late };
}

test("follow() on the 10 Nov writes, a mocked clock: the page's schedule is never gone and holds each write within one poll; before this card, up to 15 s late", async () => {
  const now = await onTimeline(SCHEDULE);
  assert.deepEqual(now.run.gone, []);
  assert.equal(now.late.length, WRITES.length);
  assert.ok(now.late.every((ms) => ms <= SCHEDULE.pollMs), String(now.late));
  const before = await onTimeline(BEFORE);
  assert.ok(Math.max(...before.late) > WRITE_HELD_MS, String(before.late));
  assert.ok(before.late.every((ms) => ms <= BEFORE.refreshMs), String(before.late));
});

// a feed on a mocked clock: `pubAt(t)` the price's publish time a read at t (ms) returns, or late past BOUND_S as the kit
// tells it (PoolUsdStale with the feed's time)
async function onFeed(pubAt, forMs) {
  let t = 1_794_282_000_000;
  const startMs = t;
  const read = async () => {
    const p = pubAt(t);
    if (t / 1000 - p > BOUND_S) throw Object.assign(new Error(`the price is older than ${BOUND_S} s: published ${p}`), { name: "PoolUsdStale", publishedS: p });
    return { chain: "solana", price: 1n, expo: -8, publishedS: p, at: BigInt(p) };
  };
  const run = await follow({ read, now: () => t, sleep: async (ms) => void (t += ms), untilMs: t + forMs });
  return { run, startMs, P: Math.floor(startMs / 1000) - 10 };
}

test("follow() on a feed that stops (review of eb2dfdc5, L4, L7): the price is gone from its end, the run judged FAIL; read each poll for leadMs past the end, then backing off to refreshMs", async () => {
  const P = Math.floor(1_794_282_000_000 / 1000) - 10;
  const { run } = await onFeed(() => P, 160_000);
  const endMs = (P + BOUND_S) * 1000;
  assert.equal(run.held.length, 1);
  assert.equal(run.gone.length, 1, JSON.stringify(run.gone));
  assert.ok(run.gone[0][0] >= endMs && run.gone[0][0] <= endMs + 200, `gone from ${run.gone[0][0] - endMs} ms past the end`);
  assert.ok(run.gone[0][1] >= run.endMs - 200);
  const v = judge({ at: "planted", rpcs: [...PAGE_PAIR], run, sign: A.good.sign }, okLedger(A.good));
  assert.ok(bad(v).some((l) => /^BAD no price for \d+\.\d s, \d+ s into the run: Buy off and no USD/.test(l)), v.lines.join("\n"));
  // the late window: each pollMs to its end + leadMs, then a failure's backoff, up to refreshMs
  const after = run.reads.filter((r) => r.startMs > endMs + SCHEDULE.leadMs);
  assert.ok(after.length > 0 && after.length <= 8, `${after.length} reads after the window`);
  const inside = run.reads.filter((r) => r.startMs > endMs && r.startMs <= endMs + SCHEDULE.leadMs);
  assert.ok(inside.every((r, i) => i === 0 || r.startMs - inside[i - 1].startMs === SCHEDULE.pollMs), JSON.stringify(inside.map((r) => r.startMs - endMs)));
  assert.equal(after.at(-1).startMs - after.at(-2).startMs, SCHEDULE.refreshMs);
});

test("follow() never holds an older price over a newer one (review of eb2dfdc5, L5): a provider answering 30 s back leaves the newer price held, never gone before its own end", async () => {
  const P = Math.floor(1_794_282_000_000 / 1000) - 10;
  let first = true;
  const { run } = await onFeed(() => (first ? ((first = false), P) : P - 30), 60_000);
  assert.deepEqual(run.held.map((h) => h.publishedS), [P]);
  assert.deepEqual(run.gone, [], "the newer price is good to P + 75 s, past the run's end (P + 70 s); the older one ended at P + 45 s");
  assert.ok(run.reads.filter((r) => r.kind === "good").length > 1, "the older price was read as good and not held");
});
