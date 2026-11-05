// node --test scripts/live-checks/helper-token-page-cold.test.mjs: the live check's verdict replays recorded runs
// (helper-token-page-cold.answers.json):
//   good:         this card's token page at 68c91b2 (createSolanaToken behind the helper's own proxy and RPC path:
//                 Jupiter with no key, PublicNode's keyless Solana RPC as the provider, no Discover lists), served on
//                 the Mac at 127.0.0.1:18788 and read by helper-token-page-cold.mjs --record from 4 Nov 15:18Z: PASS
//                 (the helper's time p50 368 ms, p95 621 ms, n=32; the second of each pair p50 291 ms);
//   bad_pre_card: the deployed helper at 50e15a6, before this card, read the same way from the Mac at the same time:
//                 the second read of each pair waits out the 4 s batch gap (p50 3146 ms; all reads p95 4347 ms): FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COLD_MIN, helperMs, judge, LIMIT_MS, pct, read, slow } from "./helper-token-page-cold.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-token-page-cold.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes: every page read 200, at least COLD_MIN of them cold, p95 within 1 s", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer (the deployed helper before this card) fails on the time, the cold reads named", () => {
  const r = judge(A.bad_pre_card);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD (cold page reads|asked right after a search)/.test(l)), bad(r).join("\n"));
  const second = A.bad_pre_card.reads.filter((x) => x.order === 1 && x.status === 200).map(helperMs);
  assert.ok(pct(second, 95) > LIMIT_MS, "the second of a pair waited the gap");
});

test("planted on the good answer: a slow read past p95, a 429, warm reads, a missing round trip and a dead list fail", () => {
  const edit = (f) => {
    const run = structuredClone(A.good);
    f(run);
    return judge(run);
  };
  // two reads at 4.1 s (the gap) push the nearest-rank p95 of 32 over the limit
  let r = edit((run) => run.reads.slice(0, 2).forEach((x) => (x.ms = 4_100)));
  assert.ok(bad(r).some((l) => l.startsWith("BAD cold page reads")), r.lines.join("\n"));
  r = edit((run) => Object.assign(run.reads[3], { status: 429, retryAfter: "5" }));
  assert.ok(bad(r).some((l) => / did not: 429 Retry-After 5/.test(l)), r.lines.join("\n"));
  // card helper-ready-page-warm: a not-ready page's cause, its Server-Timing, is on the FAIL line
  r = edit((run) => Object.assign(run.reads[4], { status: 503, timing: 'search-held;desc="jupiter held"' }));
  assert.ok(bad(r).some((l) => / did not: 503 Server-Timing search-held;desc="jupiter held"/.test(l)), r.lines.join("\n"));
  // a read whose Jupiter row is older than its send was served from what the helper held: not cold
  r = edit((run) => run.reads.slice(0, run.reads.length - COLD_MIN + 1).forEach((x) => (x.jupAt = x.sentAt - 60_000)));
  assert.ok(bad(r).some((l) => /read cold/.test(l)), r.lines.join("\n"));
  r = edit((run) => Object.assign(run.reads[5], { rttMs: null }));
  assert.ok(bad(r).some((l) => /31 of 32 round trips read/.test(l)), r.lines.join("\n"));
  // a far runner's round trip is not the helper's time: 900 ms of trip on a read of 1.2 s is 300 ms of helper
  r = edit((run) => run.reads.forEach((x) => Object.assign(x, { ms: 1_200, rttMs: 900 })));
  assert.equal(r.ok, true, r.lines.join("\n"));
  r = edit((run) => Object.assign(run, { lists: { status: 503, size: 0 } }));
  assert.ok(bad(r).some((l) => l.startsWith("BAD GET /v1/market/lists")), r.lines.join("\n"));
});

test("card helper-ready-page-warm: every read over 1 s is named with its offset from the start and the helper's Server-Timing, and the verdict is unchanged", () => {
  // the recorded good run passes with one read over the limit (#27, 2807 ms at +147.0 s, before Server-Timing)
  assert.deepEqual(slow(A.good).map((l) => l.split(" ")[3]), ["#27"]);
  const run = structuredClone(A.good);
  const start = Date.parse(run.at);
  Object.assign(run.reads[1], { ms: 2_900, rttMs: 116, sentAt: start + 12_300, timing: 'lists;dur=0, rpc-wait;dur=1800, rpc;dur=40;desc="solana", jup-wait;dur=0, jup;dur=90, launch;dur=1, read;dur=1843, total;dur=1845' });
  Object.assign(run.reads[4], { ms: 1_700, rttMs: 100, timing: null });
  const w = slow(run).filter((l) => !l.includes(" #27 "));
  assert.equal(w.length, 2, w.join("\n"));
  assert.match(w[0], /^WARN slow read #1 \(pair 0, second\) \S+: helper 2784 ms at \+12\.3 s; Server-Timing: lists;dur=0, rpc-wait;dur=1800, /);
  assert.match(w[1], /^WARN slow read #4 .*helper 1600 ms .*Server-Timing: none$/);
  assert.equal(judge(run).ok, judge(structuredClone(run)).ok, "the WARN lines are not the verdict");
  assert.ok(judge(run).lines.every((l) => !l.startsWith("WARN")), "judge's lines stay ok/BAD");
  assert.ok(slow(A.bad_pre_card).length > 0, "the recorded bad run's slow reads are named");
});

test("read() draws distinct mints off the helper's lists, reads them in pairs, and keeps no body", async () => {
  const listedMint = "So11111111111111111111111111111111111111112";
  const ids = Array.from({ length: 12 }, (_, i) => `${"1".repeat(31)}${"ABCDEFGHJKLM"[i]}`);
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    if (url.includes("/v1/market/lists")) return new Response(JSON.stringify({ lists: { new: [{ token: listedMint }] } }), { status: 200 });
    if (url.includes("lite-api.jup.ag")) return new Response(JSON.stringify([{ id: listedMint }, ...ids.map((id) => ({ id }))]), { status: 200 });
    return new Response(JSON.stringify({ risk: { holders: { v: 1, src: "jupiter", as_of_ms: Date.now() } } }), { status: 200 });
  };
  const run = await read("https://helper.test", fetchFn, 3, async () => {});
  assert.equal(run.reads.length, 6);
  assert.deepEqual(run.reads.map((x) => [x.pair, x.order]), [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]]);
  assert.equal(new Set(run.reads.map((x) => x.mint)).size, 6, "no mint read twice");
  assert.ok(run.reads.every((x) => x.mint !== listedMint), "never a listed token");
  assert.ok(run.reads.every((x) => !("body" in x)));
  assert.equal(asked.filter((u) => u.includes("/v1/market/token")).length, 6);
  assert.equal(asked.filter((u) => u.endsWith("/v1/health")).length, 12, "two round trips before each page read");
  assert.ok(run.reads.every((x) => Number.isSafeInteger(x.rttMs)));
});
