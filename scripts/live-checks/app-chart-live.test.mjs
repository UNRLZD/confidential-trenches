// node --test scripts/live-checks/app-chart-live.test.mjs: the live check's verdict replays recorded runs
// (app-chart-live.answers.json), each read on 5 Nov by app-chart-live.mjs collect() in headless Chromium, HELPER_HOST live:
//   good: this card's build served at APP_HOST's name inside the stand-in shell (--build): the picked token's page at
//         1440 and 390 drew the helper's moved bar, with no reload: PASS;
//   bad:  APP_HOST's deployed build before this card: the chart is drawn once, draws no live bar and makes no live
//         read: FAIL.
// Planted from the good run: the helper moved and the page did not, a bar the helper never answered (a wrong fold), a
// reload, no live read, a full read every second, a console error, a helper silent in every pick (INCONCLUSIVE), and a
// helper whose tape moved while its candles did not (FAIL).
//   flake: app live run 42453338800's first attempt (06:06Z, APP_HOST at main 1ffffdf0), rebuilt from its log: three
//          probes found no token that moved and nothing was watched; main's check failed it "the helper was silent in
//          all 3 picks" (card app-chart-live-flake), this one answers INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classify, EXIT, judge, LOADS, pickOf, probeSaid } from "./app-chart-live.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-chart-live.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec, rec.attempts.at(-1));
  return judge(rec);
};
/** The good run's last watch made silent: neither the page, the helper's bars nor its tape moved. */
const silence = (a) => {
  const k = a.loads[0].first;
  const [t, c] = k.split(":");
  for (const l of a.loads) l.final = l.first = k;
  for (const h of a.helper) h.last = [Number(t) / 1000, c, c, c, c];
  for (const x of a.tape) x.newest_ms = 1;
};

test("recorded good answer: the page drew the helper's moved bar at 1440 and 390, with no reload: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.verdict, "PASS");
  const last = ANSWERS.good.attempts.at(-1);
  assert.equal(classify(last), "page");
  assert.equal(last.loads.length, LOADS.length);
  for (const l of last.loads) assert.notEqual(l.final, l.first);
});

test("recorded bad answer: the build before this card draws no live bar and makes no live read: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "FAIL");
  const b = bad(r);
  assert.ok(b.some((l) => / desktop: .*(no last bar drawn|the page's last bar stayed)/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => / desktop: .*no live read/.test(l)), r.lines.join("\n"));
});

test("planted: the helper's bars moved and the page drew none", () => {
  const r = mut((_, a) => {
    for (const l of a.loads) l.final = l.first;
  });
  assert.ok(bad(r).some((l) => / desktop: .*the page's last bar stayed/.test(l)), r.lines.join("\n"));
});

test("planted: a last bar the helper never answered (a wrong fold's price)", () => {
  const r = mut((_, a) => {
    const [t, c] = a.loads[1].final.split(":");
    a.loads[1].final = `${t}:${Number(c) * 1.01}`;
  });
  assert.ok(bad(r).some((l) => / phone: .*none the helper answered/.test(l)), r.lines.join("\n"));
});

test("planted: a reload, no live read, a full read every second, a console error", () => {
  assert.ok(bad(mut((_, a) => (a.loads[0].originEnd = a.loads[0].origin + 5000))).some((l) => /loaded again/.test(l)));
  assert.ok(bad(mut((_, a) => (a.loads[0].liveReads = 0))).some((l) => /no live read/.test(l)));
  assert.ok(bad(mut((_, a) => (a.loads[0].fullReads = 90))).some((l) => /90 full reads/.test(l)));
  assert.ok(bad(mut((_, a) => a.loads[1].errors.push("Failed to load resource: the server responded with a status of 503 ()"))).some((l) => / phone: .*errors:/.test(l)));
});

test("planted: a helper silent in every pick is INCONCLUSIVE, never a FAIL; a silent pick before a moving one is no verdict", () => {
  const all = mut((_, a) => silence(a));
  assert.equal(all.ok, false);
  assert.equal(all.verdict, "INCONCLUSIVE", all.lines.join("\n"));
  assert.equal(bad(all).length, 0, all.lines.join("\n"));
  assert.ok(all.lines.some((l) => /^INCONCLUSIVE .*did not move in the \d+ s watch: no verdict on the page or the helper in 1 picks$/.test(l)), all.lines.join("\n"));
  const before = structuredClone(ANSWERS.good);
  const quiet = structuredClone(before.attempts.at(-1));
  silence(quiet);
  before.attempts.unshift(quiet);
  const r = judge(before);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("planted: the helper's tape took new trades while its candles did not move: FAIL, named the helper's", () => {
  const r = mut((_, a) => {
    silence(a);
    const ready = Math.min(...a.loads.map((l) => l.readyAt));
    a.tape = [{ at_ms: ready + 1000, status: 200, newest_ms: ready - 500 }, { at_ms: ready + 30_000, status: 200, newest_ms: ready + 29_000 }];
  });
  assert.ok(bad(r).some((l) => /candles lag its tape/.test(l)), r.lines.join("\n"));
  assert.equal(r.verdict, "FAIL");
});

test("recorded flake (run 42453338800, 06:06Z): three probes that found nothing and watched nothing are INCONCLUSIVE, exit 3, where main's check failed them as a silent helper (card app-chart-live-flake)", () => {
  const r = judge(ANSWERS.flake);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.equal(EXIT[r.verdict], 3);
  assert.equal(bad(r).length, 0, r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => /in 0 s|silent in all/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.at(-1).startsWith("INCONCLUSIVE pick 3: no candidate's bars moved in the 30 s probe: the probe kept no counts"), r.lines.join("\n"));
});

test("planted quiet market: a probe that found no token moving says what it read, and the run is INCONCLUSIVE", () => {
  const probe = { rounds: 2, reads: 31, own: 9, vendor: 6, refused: 16, retryAfterMaxS: 75, failed: 0, tapeMoved: 0, ms: 31_400 };
  const rec = { ...structuredClone(ANSWERS.flake), attempts: [0, 1, 2].map(() => ({ pick: null, probe, helper: [], tape: [], loads: [] })) };
  const r = judge(rec);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.equal(r.lines.at(-1), `INCONCLUSIVE pick 3: no candidate's bars moved in the 30 s probe: ${probeSaid(probe)}: no verdict on the page or the helper in 3 picks`);
  assert.match(probeSaid(probe), /31 times in 2 rounds over 31 s: 9 the helper's own bars, 6 with none of its own yet, 16 refused \(429, Retry-After up to 75 s\), 0 failed; 0 tokens' tape took a trade/);
});

test("the pick: the token whose own bars changed most; with none, a token whose tape took a trade (so a helper whose candles stand while its tape moves is watched and fails); with neither, none", () => {
  const [a, b, c] = [{ token: "a" }, { token: "b" }, { token: "c" }];
  const none = new Map([[a, 0], [b, 0], [c, 0]]);
  assert.equal(pickOf([a, b, c], new Map([[a, 1], [b, 3], [c, 0]]), new Map([[c, [1, 2]]])).token, "b");
  const t = pickOf([a, b, c], none, new Map([[a, [5, 5]], [b, [null, 9]], [c, [5, 7]]]));
  assert.equal(t.token, "c");
  assert.equal(t.changes, 0);
  assert.equal(pickOf([a, b, c], none, new Map([[a, [5, 5]], [b, [null, null]]])), null);
});
