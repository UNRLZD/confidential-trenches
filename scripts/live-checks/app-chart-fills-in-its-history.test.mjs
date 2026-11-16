// node --test scripts/live-checks/app-chart-fills-in-its-history.test.mjs: the live check's verdict replays recorded runs
// (app-chart-fills-in-its-history.answers.json), each read on 16 Nov by app-chart-fills-in-its-history.mjs collect() in
// headless Chromium on the PC box, HELPER_HOST live:
//   good: this card's build served at APP_HOST's name inside the stand-in shell (--build): a cold coin's chart first
//         drawn with bars and filling was read in full again AWAY_MS on and filled, with no reload: PASS;
//   bad:  APP_HOST's deployed build before this card: the chart first drawn filling was read in full again only
//         RESYNC_MS on: FAIL.
// Planted from the good run: the next full read past AWAY_MS + SLACK_MS, a full read sooner than AWAY_MS (FAIL) and the
// same after a failed read (no BAD line), no full read after a filling answer, a reload, a console error, every load
// warm (INCONCLUSIVE), and a helper still filling at the end (INCONCLUSIVE).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AWAY_MS, EXIT, FULL, judge, loadVerdict, RESYNC_MS, SLACK_MS } from "./app-chart-fills-in-its-history.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-chart-fills-in-its-history.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good run's watched loads (a filling first answer that filled). */
const watched = (rec) => rec.picks.flatMap((p) => p.loads).filter((l) => loadVerdict(l).kind === "filled");
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  for (const l of watched(rec)) f(l);
  return judge(rec);
};
/** The full reads of a load: [send, answer] pairs, in order. */
const fulls = (l) => {
  const s = l.sends.filter((x) => x.limit === FULL);
  const a = l.answers.filter((x) => x.limit === FULL);
  return s.map((x, i) => [x, a[i]]);
};
/** The first full answer with bars (the one drawn) and the full read after it. */
const drawnAndNext = (l) => {
  const f = fulls(l);
  const k = f.findIndex(([, a]) => a?.status === 200 && a.bars > 0);
  return { drawn: f[k], next: f[k + 1] };
};

test("recorded good answer: a chart first drawn filling read in full AWAY_MS on and filled, at 1440 and 390, no reload: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.verdict, "PASS");
  assert.equal(EXIT[r.verdict], 0);
  assert.ok(watched(ANSWERS.good).length >= 1);
  for (const l of watched(ANSWERS.good)) {
    const { drawn, next } = drawnAndNext(l);
    assert.equal(drawn[1].filling, true);
    const gap = next[0].at_ms - drawn[1].at_ms;
    assert.ok(gap >= AWAY_MS - 1_000 && gap <= AWAY_MS + SLACK_MS, `${l.width}: ${gap} ms`);
  }
});

test("recorded bad answer: the build before this card read a filling chart in full again only RESYNC_MS on: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => /the next full read came (5[89]|6\d)\.\d s on, past AWAY_MS/.test(l)), r.lines.join("\n"));
});

test("planted: the next full read past AWAY_MS + SLACK_MS (RESYNC_MS, the build before this card)", () => {
  const r = mut((l) => {
    const { drawn, next } = drawnAndNext(l);
    const shift = drawn[1].at_ms + RESYNC_MS - next[0].at_ms;
    for (const x of [...l.sends, ...l.answers]) if (x.at_ms >= next[0].at_ms) x.at_ms += shift;
  });
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => /past AWAY_MS/.test(l)), r.lines.join("\n"));
});

const soon = (l, failed) => {
  const { drawn } = drawnAndNext(l);
  const at = drawn[1].at_ms + 10_000;
  const i = l.sends.findIndex((x) => x.at_ms > at);
  l.sends.splice(i, 0, { at_ms: at, limit: FULL });
  const j = l.answers.findIndex((x) => x.at_ms > at);
  l.answers.splice(j, 0, { at_ms: at + 200, limit: FULL, status: 200, bars: drawn[1].bars, filling: true, own: drawn[1].own });
  if (failed) l.answers.splice(j, 0, { at_ms: at - 500, limit: "2", status: 503 });
};

test("planted: a full read 10 s after a filling answer, no failed read between: sooner than AWAY_MS", () => {
  const r = mut((l) => soon(l, false));
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => /sooner than AWAY_MS/.test(l)), r.lines.join("\n"));
});

test("planted: a full read 10 s on after a failed read is the follow's read back, never a BAD line", () => {
  const r = mut((l) => soon(l, true));
  // the planted read 10 s on is judged, not the real one after it (which the planted read would have moved)
  assert.ok(!bad(r).some((l) => /a full read 10\.\d s after the last/.test(l)), r.lines.join("\n"));
  assert.ok(bad(mut((l) => soon(l, false))).some((l) => /a full read 10\.\d s after the last/.test(l)), "the same read with no failed read before it is a BAD line");
});

test("planted: no full read after a filling answer for the rest of the watch", () => {
  const rec = structuredClone(ANSWERS.good);
  for (const l of watched(rec)) {
    const { drawn } = drawnAndNext(l);
    l.sends = l.sends.filter((x) => x.limit !== FULL || x.at_ms <= drawn[1].at_ms);
    l.answers = l.answers.filter((x) => x.limit !== FULL || x.at_ms <= drawn[1].at_ms);
    l.endedAt = drawn[1].at_ms + 2 * AWAY_MS;
  }
  const r = judge(rec);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => /sent no full read in 90 s/.test(l)), r.lines.join("\n"));
});

test("planted: a reload, a console error, a chart not ready", () => {
  for (const [f, want] of [
    [(l) => (l.originEnd = l.origin + 1), /loaded again/],
    [(l) => l.errors.push("TypeError: x is undefined"), /errors: TypeError/],
    [(l) => (l.chart = "error"), /the chart is error/],
  ]) {
    const r = mut(f);
    assert.equal(r.verdict, "FAIL");
    assert.ok(bad(r).some((l) => want.test(l)), r.lines.join("\n"));
  }
});

test("planted: every load warm (no first answer still filling): INCONCLUSIVE", () => {
  const r = mut((l) => {
    for (const a of l.answers) a.filling = false;
  });
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.equal(EXIT[r.verdict], 3);
});

test("planted: the helper still filling at the end of the watch, the page's reads on time: INCONCLUSIVE", () => {
  const r = mut((l) => {
    for (const a of l.answers) if (a.limit === FULL && a.status === 200) a.filling = true;
  });
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
});
