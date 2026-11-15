// node --test scripts/live-checks/evm-tape-from-our-index-fast.test.mjs: the live check of card evm-tape-from-our-index-fast
// judges recorded runs (evm-tape-from-our-index-fast.answers.json, each tape's answers as read). good: a keyless helper
// of this card's branch on a Mac: the short tapes said filling and then ended within BOUND_MS: PASS. bad_live: the
// deployed helper 0d308d3bc: a short tape still filling at BOUND_MS: FAIL. Planted from the good one: a tape still filling
// at its end, an answer off the tape's fields, a 503, fewer trades at the end, no X-Helper-Commit: FAIL; every tape full
// at its first answer: INCONCLUSIVE. The bound is the listed tape's, the read's pacing and picks are held on their own.
// Card evm-keyed-checks-hold-steady: good_live, the deployed helper beb3ef4f8 with tapes opened cold: PASS; warm_live,
// the same check a run later, every tape open before it (evm-open 0 ms): INCONCLUSIVE, never the FAIL the check at
// b78515461 gave it; planted from it: the short tapes opened cold (or naming no open) and done with no filling: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TRADES_MAX as HELPER_TRADES_MAX } from "../../apps/helper/src/data/evm/swaps.ts";
import { APP, BOUND_MS, bodyFault, judge, OPEN, POLL_MS, readRun, TRADES_MAX, WARM_MS } from "./evm-tape-from-our-index-fast.mjs";
import { FILLED_MS } from "./tape-read.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-tape-from-our-index-fast.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const tapeOf = (run, i, f) => ({ ...run, tapes: run.tapes.map((t, j) => (j === i ? f(structuredClone(t)) : t)) });
const short = A.good.tapes.findIndex((t) => t.answers.some((a) => a.filling));
const full = A.good.tapes.findIndex((t) => t.answers[0].n >= TRADES_MAX);
const other = A.good.tapes.findIndex((_, i) => i !== short && i !== full);

test("the pinned figures are the helper's, the page's and the listed tape's bound", () => {
  assert.equal(TRADES_MAX, HELPER_TRADES_MAX);
  assert.equal(BOUND_MS, FILLED_MS);
  assert.equal(BOUND_MS, 45_000);
  // apps/terminal/src/screens/token/trades.ts imports the kit and React, so its two figures are read from its text
  const page = readFileSync(new URL("../../apps/terminal/src/screens/token/trades.ts", import.meta.url), "utf8");
  assert.equal(Number(/export const TRADES_POLL_MS = ([\d_]+);/.exec(page)?.[1].replaceAll("_", "")), POLL_MS);
  assert.equal(Number(/export const TRADES_LIMIT = ([\d_]+);/.exec(page)?.[1].replaceAll("_", "")), TRADES_MAX);
});

test("good: this card's helper, short tapes filling then done within BOUND_MS: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(short >= 0 && full >= 0 && other >= 0, "the good answer holds a tape that said filling, a full one and a third");
  assert.ok(r.lines.includes("ok  a short tape said filling, then ended: read back seen end to end"));
});

test("bad_live: the deployed helper 0d308d3bc, a short tape still filling at BOUND_MS: FAIL", () => {
  const r = judge(A.bad_live);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).length > 0 && bad(r).every((l) => / still filling at \d+ ms/.test(l)), r.lines.join("\n"));
});

test("good_live: the deployed helper beb3ef4f8, short tapes opened cold said filling then ended: PASS", () => {
  const r = judge(A.good_live);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(A.good_live.tapes.filter((t) => t.answers[0].n < TRADES_MAX).every((t) => t.answers[0].open > 0), "every short tape opened cold");
});

test("warm_live: every tape open before the check's first read (evm-open 0 ms), the short ones done at once: INCONCLUSIVE, naming them (red at b78515461: FAIL)", () => {
  const r = judge(A.warm_live);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  const warmShort = A.warm_live.tapes.filter((t) => t.answers[0].n < TRADES_MAX);
  assert.ok(warmShort.length > 0 && A.warm_live.tapes.every((t) => t.answers[0].open === 0));
  assert.ok(r.lines.some((l) => l.startsWith("N/A every short tape open before this check's first read") && warmShort.every((t) => l.includes(t.address))), r.lines.join("\n"));
  // a held book's open read 1 ms on this branch's helper (15 Nov 15:08:51Z, 0x734be42b, opened twice before): still warm
  const one = { ...A.warm_live, tapes: A.warm_live.tapes.map((t) => ({ ...t, answers: t.answers.map((a, i) => (i === 0 ? { ...a, open: WARM_MS - 9 } : a)) })) };
  assert.equal(judge(one).verdict, "INCONCLUSIVE", judge(one).lines.join("\n"));
});

test("planted from warm_live: a short tape opened cold, or naming no open, done at its first answer with no filling: FAIL", () => {
  for (const open of [WARM_MS, 215, null, undefined]) {
    const run = { ...A.warm_live, tapes: A.warm_live.tapes.map((t) => (t.answers[0].n < TRADES_MAX ? { ...t, answers: t.answers.map((a, i) => (i === 0 ? { ...a, open } : a)) } : t)) };
    const r = judge(run);
    assert.equal(r.verdict, "FAIL", `open ${open}\n${r.lines.join("\n")}`);
    assert.ok(bad(r).includes("BAD no tape said filling while a tape opened cold answered short: no read back"), r.lines.join("\n"));
  }
});

test("planted from the good answer: FAIL, or INCONCLUSIVE when nothing was short", () => {
  for (const [what, run, want, verdict = "FAIL"] of [
    ["a tape still filling at its end", tapeOf(A.good, short, (t) => ({ ...t, answers: t.answers.map((a) => ({ ...a, filling: true })) })), /still filling/],
    ["an answer off the tape's fields", tapeOf(A.good, 0, (t) => ({ ...t, answers: [{ ...t.answers[0], fault: "fields as_of_ms,src" }, ...t.answers.slice(1)] })), /fields as_of_ms,src/],
    ["an answer 503", tapeOf(A.good, 0, (t) => ({ ...t, answers: [...t.answers.slice(0, -1), { ...t.answers.at(-1), status: 503, fault: "HTTP 503", n: null }] })), /HTTP 503/],
    ["fewer trades at the end than the first answer held", tapeOf(A.good, full, (t) => ({ ...t, answers: [...t.answers, { ...t.answers.at(-1), n: 3 }] })), /never fewer trades than at its first answer \(50 then 3\)/],
    ["no X-Helper-Commit", tapeOf(A.good, other, (t) => ({ ...t, answers: t.answers.map((a) => ({ ...a, commit: "" })) })), /X-Helper-Commit ""/],
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
  assert.equal(bodyFault({ trades: [], src: "chain", as_of_ms: 1, filling: true }), null);
  assert.equal(bodyFault({ trades: [{ ...ROW(2, 1), trader: null }], src: "chain", as_of_ms: 1 }), null);
  for (const [what, b, want] of [
    ["filling false", { trades: [], src: "chain", as_of_ms: 1, filling: false }, /filling false/],
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

test("readRun: opens new's and trending_1h's next OPEN / 2 past helper-base-tape-reads-back's picks (the first OPEN / 2 of each) as the page reads them, each again every POLL_MS until it ends or BOUND_MS pass, with the helper's evm-open", async () => {
  const tok = (c) => "0x" + c.repeat(40);
  // helper-base-tape-reads-back opens 1, 2 (new) and 2, 4 (trending_1h); this check the next two of each not among them
  const lists = { chain: "base", lists: { new: [1, 2, 3, 6, 7].map((c) => ({ token: tok(String(c)) })), trending_1h: [2, 4, 5, 3, 8].map((c) => ({ token: tok(String(c)) })) } };
  let clock = 0;
  const asked = [];
  // tok 3: opened cold in 812 ms, filling twice, then done with 4; tok 6: full at once; tok 5: filling for ever
  const reads = new Map();
  const fetchFn = async (url, init) => {
    assert.equal(init.headers.origin, APP);
    const u = new URL(url);
    const h = { "content-type": "application/json", "x-helper-commit": "a".repeat(40), ...(u.searchParams.get("token") === tok("3") ? { "server-timing": `evm-open;dur=${reads.has(tok("3")) ? 0 : 812}, evm-queue;dur=3;desc="1 posts"` } : {}) };
    if (u.pathname === "/v1/market/lists") return new Response(JSON.stringify(lists), { status: 200, headers: h });
    const t = u.searchParams.get("token");
    asked.push([t, u.searchParams.get("limit"), clock]);
    const n = (reads.get(t) ?? 0) + 1;
    reads.set(t, n);
    const body =
      t === tok("3") ? { trades: Array.from({ length: n < 3 ? 1 : 4 }, (_, i) => ROW(10 - i, i)), src: "chain", as_of_ms: 1, ...(n < 3 ? { filling: true } : {}) }
      : t === tok("6") ? { trades: Array.from({ length: TRADES_MAX }, (_, i) => ROW(100 - i, i)), src: "chain", as_of_ms: 1 }
      : { trades: [], src: "chain", as_of_ms: 1, filling: true };
    return new Response(JSON.stringify(body), { status: 200, headers: h });
  };
  const run = await readRun("https://h.example", { fetchFn, sleep: async (ms) => void (clock += ms), now: () => clock });
  assert.deepEqual(run.tapes.map((t) => t.address), [tok("3"), tok("6"), tok("5")], "new's and trending_1h's next two past the other check's picks, each once");
  assert.ok(asked.every(([, limit]) => limit === String(TRADES_MAX)));
  const by = Object.fromEntries(run.tapes.map((t) => [t.address, t.answers]));
  assert.deepEqual(by[tok("3")].map((a) => [a.n, a.filling, a.open]), [[1, true, 812], [1, true, 0], [4, false, 0]]);
  assert.equal(by[tok("6")].length, 1, "full at once: read once");
  assert.equal(by[tok("6")][0].open, null, "no Server-Timing: no open read");
  assert.ok(by[tok("5")].length <= BOUND_MS / POLL_MS + 2 && by[tok("5")].at(-1).t >= BOUND_MS, "never ends: read until BOUND_MS, then stopped");
  const r = judge(run);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => l.startsWith(`BAD ${tok("5")}: first 0 trade(s) filling, still filling`)), r.lines.join("\n"));
  assert.equal(OPEN, 4);
});
