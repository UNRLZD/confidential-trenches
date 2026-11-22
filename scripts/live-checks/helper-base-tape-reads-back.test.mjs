// node --test scripts/live-checks/helper-base-tape-reads-back.test.mjs: the live check of part C judges recorded runs
// (helper-base-tape-reads-back.answers.json, each tape's answers as read). good: a helper of part C's branch, keyless on a
// Mac: two short tapes said filling and then ended, two were full: PASS. bad_live: the deployed helper before part C, the
// short tapes never filling: FAIL. Planted from the good one: a tape still filling at its end, an answer off the tape's
// fields, fewer trades at the end, no X-Helper-Commit: FAIL; every tape full at its first answer: INCONCLUSIVE. The body
// rule, the read's pacing and its token picks are held on their own. Card evm-tape-check-counts-read-ahead-warm: a short
// tape done at its first answer is read back only when it names whole_ms. ahead_44989861313 (helper live run 44989861313,
// which the check FAILed on new's two tapes the lists had read ahead) and ahead_live (the deployed 77bfa8030, 22 Nov
// 09:06Z): PASS. Every short tape planted with neither filling nor whole_ms: FAIL, a read back seen beside it or not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TRADES_MAX as HELPER_TRADES_MAX } from "../../apps/helper/src/data/evm/swaps.ts";
import { APP, BOUND_MS, bodyFault, judge, OPEN, POLL_MS, readRun, TRADES_MAX } from "./helper-base-tape-reads-back.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-base-tape-reads-back.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const tapeOf = (run, i, f) => ({ ...run, tapes: run.tapes.map((t, j) => (j === i ? f(structuredClone(t)) : t)) });
const short = A.good.tapes.findIndex((t) => t.answers.some((a) => a.filling));

test("the pinned figures are the helper's and the page's", () => {
  assert.equal(TRADES_MAX, HELPER_TRADES_MAX);
  // apps/terminal/src/screens/token/trades.ts imports the kit and React, so its two figures are read from its text
  const page = readFileSync(new URL("../../apps/terminal/src/screens/token/trades.ts", import.meta.url), "utf8");
  assert.equal(Number(/export const TRADES_POLL_MS = ([\d_]+);/.exec(page)?.[1].replaceAll("_", "")), POLL_MS);
  assert.equal(Number(/export const TRADES_LIMIT = ([\d_]+);/.exec(page)?.[1].replaceAll("_", "")), TRADES_MAX);
});

test("good: part C's helper, short tapes filling then done, full ones full: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(short >= 0, "the good answer holds a tape that said filling");
  assert.ok(r.lines.includes("ok  a short tape said filling, then ended: read back seen end to end"));
});

test("bad_live: the deployed helper before part C, short tapes with no read back: FAIL", () => {
  const r = judge(A.bad_live);
  assert.equal(r.verdict, "FAIL");
  const shortOnes = A.bad_live.tapes.filter((t) => t.answers[0].n < TRADES_MAX).map((t) => t.address);
  assert.deepEqual(bad(r), [
    ...shortOnes.map((t) => `BAD ${t}: short and done at its first answer, naming neither filling nor whole_ms: never read back (the helper before part C)`),
    "BAD no tape said filling while a tape answered short: no read back (the helper before part C)",
  ]);
});

test("ahead: a run the check FAILed on short tapes the lists read ahead, whole at their first answer, and the deployed helper's: PASS (red at 893bbaa43: FAIL)", () => {
  for (const k of ["ahead_44989861313", "ahead_live"]) {
    const r = judge(A[k]);
    assert.equal(r.verdict, "PASS", `${k}\n${r.lines.join("\n")}`);
    // short and never filling: the tapes whole at once (ahead_live's fourth said filling, still so at its fiftieth trade)
    const shortOnes = A[k].tapes.filter((t) => t.answers[0].n < TRADES_MAX && !t.answers.some((a) => a.filling)).map((t) => t.address);
    assert.equal(shortOnes.length, 2, k);
    assert.ok(r.lines.includes(`ok  short tape(s) whole at the first answer (whole_ms: ${shortOnes.join(", ")}): read back before this check's read`), `${k}\n${r.lines.join("\n")}`);
  }
});

test("planted: a short tape done at its first answer naming neither filling nor whole_ms: FAIL, a read back beside it or not (red at 893bbaa43 beside a read back)", () => {
  const unread = (run, i) => tapeOf(run, i, (t) => ({ ...t, answers: [{ ...t.answers[0], whole: false }] }));
  const at = A.ahead_44989861313.tapes.findIndex((t) => t.answers[0].n < TRADES_MAX);
  // A.good with a short tape done at once beside its read back
  const beside = { ...A.good, tapes: [...A.good.tapes, { address: "0x" + "c".repeat(40), answers: [{ ...A.good.tapes[short].answers.at(-1), t: 400, n: 5, filling: false, whole: false }] }] };
  for (const [what, run] of [
    ["ahead_44989861313, one short tape naming no whole_ms", unread(A.ahead_44989861313, at)],
    ["the good run with a short tape naming no whole_ms beside its read back", beside],
  ]) {
    const r = judge(run);
    assert.equal(r.verdict, "FAIL", `${what}\n${r.lines.join("\n")}`);
    assert.ok(bad(r).some((l) => / short and done at its first answer, naming neither filling nor whole_ms: never read back \(the helper before part C\)$/.test(l)), `${what}\n${r.lines.join("\n")}`);
  }
});

test("planted from the good answer: FAIL, or INCONCLUSIVE when nothing was short", () => {
  for (const [what, run, want, verdict = "FAIL"] of [
    ["a tape still filling at its end", tapeOf(A.good, short, (t) => ({ ...t, answers: t.answers.map((a) => ({ ...a, filling: true })) })), /still filling/],
    ["an answer off the tape's fields", tapeOf(A.good, 0, (t) => ({ ...t, answers: [{ ...t.answers[0], fault: "fields as_of_ms,src" }, ...t.answers.slice(1)] })), /fields as_of_ms,src/],
    ["an answer 503", tapeOf(A.good, 0, (t) => ({ ...t, answers: [...t.answers.slice(0, -1), { ...t.answers.at(-1), status: 503, fault: "HTTP 503", n: null }] })), /HTTP 503/],
    ["fewer trades at the end than the first answer held", tapeOf(A.good, 2, (t) => ({ ...t, answers: [...t.answers, { ...t.answers.at(-1), n: 3 }] })), /never fewer trades than at its first answer \(50 then 3\)/],
    ["no X-Helper-Commit", tapeOf(A.good, 1, (t) => ({ ...t, answers: t.answers.map((a) => ({ ...a, commit: "" })) })), /X-Helper-Commit ""/],
    ["no tape opened", { ...A.good, tapes: [] }, /0 tape\(s\) opened/],
    ["no lists", { ...A.good, lists: { status: 503, new: null } }, /lists\?chain=base answers 503/],
    ["every tape full at its first answer", { ...A.good, tapes: A.good.tapes.filter((t) => t.answers[0].n >= TRADES_MAX) }, /^N\/A every tape full/, "INCONCLUSIVE"],
  ]) {
    const r = judge(run);
    assert.equal(r.verdict, verdict, `${what}\n${r.lines.join("\n")}`);
    assert.ok(r.lines.some((l) => want.test(l)), `${what}\n${r.lines.join("\n")}`);
  }
});

const ROW = (t, i) => ({ t_ms: t, side: "b", usd: "1.5", amt: "100", trader: "0x" + "ab".repeat(20), tx: "0x" + i.toString(16).padStart(64, "0") });
test("bodyFault: the tape's fields exactly, filling only as true, rows newest first", () => {
  assert.equal(bodyFault({ trades: [ROW(2, 1), ROW(1, 2)], src: "chain", as_of_ms: 1 }), null);
  assert.equal(bodyFault({ trades: [], filling: true, src: "chain", as_of_ms: 1 }), null);
  // release 177's settled tape with its reach (card trades-checks-pass-on-177), and a reach a filling tape claims
  assert.equal(bodyFault({ trades: [], whole_ms: 0, src: "chain", as_of_ms: 1 }), null);
  assert.match(bodyFault({ trades: [], filling: true, whole_ms: 0, src: "chain", as_of_ms: 1 }), /whole_ms on a filling tape/);
  assert.equal(bodyFault({ trades: [{ ...ROW(2, 1), trader: null }], src: "chain", as_of_ms: 1 }), null);
  for (const [what, b, want] of [
    ["filling false", { trades: [], filling: false, src: "chain", as_of_ms: 1 }, /filling false/],
    ["an extra field", { trades: [], src: "chain", as_of_ms: 1, pool: "x" }, /fields/],
    ["no src", { trades: [], as_of_ms: 1 }, /fields/],
    ["a row missing tx", { trades: [(({ tx: _, ...r }) => r)(ROW(1, 1))], src: "chain", as_of_ms: 1 }, /not the row fields/],
    ["oldest first", { trades: [ROW(1, 1), ROW(2, 2)], src: "chain", as_of_ms: 1 }, /not newest first/],
    ["a side neither b nor s", { trades: [{ ...ROW(1, 1), side: "x" }], src: "chain", as_of_ms: 1 }, /row /],
    ["usd not a decimal", { trades: [{ ...ROW(1, 1), usd: "1e3" }], src: "chain", as_of_ms: 1 }, /row /],
    ["more rows than TRADES_MAX", { trades: Array.from({ length: TRADES_MAX + 1 }, (_, i) => ROW(100 - i, i)), src: "chain", as_of_ms: 1 }, /at most TRADES_MAX/],
    ["no object", [], /no JSON object/],
  ]) assert.match(bodyFault(b) ?? "null", want, what);
});

test("readRun: opens new's and trending_1h's first OPEN / 2 as the page reads them, each again every POLL_MS until it ends or BOUND_MS pass, with whole_ms", async () => {
  const tok = (c) => "0x" + c.repeat(40);
  const lists = { chain: "base", lists: { new: [{ token: tok("1") }, { token: tok("2") }, { token: tok("3") }], trending_1h: [{ token: tok("2") }, { token: tok("4") }, { token: tok("5") }] } };
  let clock = 0;
  const asked = [];
  // tok 1: filling twice, then done with 4; tok 2: full at once; tok 4: filling for ever
  const reads = new Map();
  const fetchFn = async (url, init) => {
    assert.equal(init.headers.origin, APP);
    const u = new URL(url);
    const h = { "content-type": "application/json", "x-helper-commit": "a".repeat(40) };
    if (u.pathname === "/v1/market/lists") return new Response(JSON.stringify(lists), { status: 200, headers: h });
    const t = u.searchParams.get("token");
    asked.push([t, u.searchParams.get("limit"), clock]);
    const n = (reads.get(t) ?? 0) + 1;
    reads.set(t, n);
    const body =
      t === tok("1") ? { trades: Array.from({ length: n < 3 ? 1 : 4 }, (_, i) => ROW(10 - i, i)), ...(n < 3 ? { filling: true } : { whole_ms: 0 }), src: "chain", as_of_ms: 1 }
      : t === tok("2") ? { trades: Array.from({ length: TRADES_MAX }, (_, i) => ROW(100 - i, i)), src: "chain", as_of_ms: 1 }
      : { trades: [], filling: true, src: "chain", as_of_ms: 1 };
    return new Response(JSON.stringify(body), { status: 200, headers: h });
  };
  const run = await readRun("https://h.example", { fetchFn, sleep: async (ms) => void (clock += ms), now: () => clock });
  assert.deepEqual(run.tapes.map((t) => t.address), [tok("1"), tok("2"), tok("4")], "new's first two and trending_1h's, each once");
  assert.ok(asked.every(([, limit]) => limit === String(TRADES_MAX)));
  const by = Object.fromEntries(run.tapes.map((t) => [t.address, t.answers]));
  assert.deepEqual(by[tok("1")].map((a) => [a.n, a.filling, a.whole]), [[1, true, false], [1, true, false], [4, false, true]]);
  assert.equal(by[tok("2")].length, 1, "full at once: read once");
  assert.ok(by[tok("4")].length <= BOUND_MS / POLL_MS + 2 && by[tok("4")].at(-1).t >= BOUND_MS, "never ends: read until BOUND_MS, then stopped");
  const r = judge(run);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => l.startsWith(`BAD ${tok("4")}: first 0 trade(s) filling, still filling`)), r.lines.join("\n"));
  assert.equal(OPEN, 4);
});
