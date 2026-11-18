// node --test scripts/live-checks/evm-vendor-tape-late-open-serves-held.test.mjs: the check replays its recorded answers
// (evm-vendor-tape-late-open-serves-held.answers.json, each run's source in its _about): this card's local helper
// passes; the bad answer, an empty tape from our own reads while the coin was held from the vendor, fails; a 503 and an
// empty chart after its vendor bars fail; a helper no-answer is left out, never judged; a chain whose coin is not held
// from the vendor HOLD_MS is no verdict, never a pass; the read leaves a coin whose tape turns to rows of ours.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CANDIDATES, CHAINS, CHART_EVERY, HOLD_MS, judge, POLL_MS, read } from "./evm-vendor-tape-late-open-serves-held.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-vendor-tape-late-open-serves-held.answers.json", import.meta.url), "utf8"));
const VENDOR = /evm-vendor-read/;
const judged = (r, chain) => r.chains[chain].coins.find((c) => c.reads.some((x) => VENDOR.test(x.timing ?? "")) && c.reads.at(-1).at - c.reads.find((x) => VENDOR.test(x.timing ?? "")).at >= HOLD_MS - POLL_MS);

/** `read` on a virtual clock: each chain's waits are timers, the clock moved to the earliest once both chains are idle. */
async function onClock(start, run) {
  const c = { t: start };
  const timers = [];
  const wait = (ms) => new Promise((ok) => timers.push({ at: c.t + ms, ok }));
  let done = false;
  const p = run(wait, () => c.t, c).finally(() => (done = true));
  while (!done) {
    for (let i = 0; i < 5; i++) await new Promise((ok) => setImmediate(ok));
    if (timers.length === 0) continue;
    timers.sort((a, b) => a.at - b.at);
    const x = timers.shift();
    c.t = Math.max(c.t, x.at);
    x.ok();
  }
  return p;
}

test("the recorded good answer, this card's local helper on mainnet: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer: FAIL, an empty tape from our own reads while the coin was held from the vendor", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines.find((l) => l.startsWith("BAD")), /0 rows( filling)? src chain/);
});

test("planted, each chain: a 503, an empty answer of ours and an empty chart fail; a no-answer is left out; too short a hold is no verdict", () => {
  for (const chain of CHAINS) {
    const s = structuredClone(A.good);
    judged(s, chain).reads.at(-1).status = 503;
    assert.equal(judge(s).ok, false, `${chain}: a 503`);
    const e = structuredClone(A.good);
    Object.assign(judged(e, chain).reads.at(-2), { status: 200, timing: "evm-open;dur=8001", src: "chain", n: 0, filling: true });
    assert.equal(judge(e).ok, false, `${chain}: an empty tape of ours`);
    const c = structuredClone(A.good);
    const charts = judged(c, chain).charts;
    if (charts.some((x) => x.n > 0)) {
      charts.at(-1).n = 0;
      assert.equal(judge(c).ok, false, `${chain}: an empty chart after its vendor bars`);
    }
    const n = structuredClone(A.good);
    const x = judged(n, chain).reads.at(-2);
    for (const k of Object.keys(x)) if (k !== "at") delete x[k];
    x.no = "429";
    assert.equal(judge(n).ok, true, `${chain}: a no-answer left out`);
    const short = structuredClone(A.good);
    const k = judged(short, chain);
    k.reads = k.reads.slice(0, 20);
    assert.equal(judge(short).ok, null, `${chain}: too short a hold`);
  }
  assert.equal(judge({ chains: {} }).ok, null);
});

test("read: a coin whose tape turns to rows of ours is left; one held from the vendor is read every POLL_MS for HOLD_MS, its chart every CHART_EVERY reads, each chain at once", async () => {
  let t = Date.parse("2026-11-18T19:45:00Z");
  const asked = [];
  // Base's first candidate answers from the vendor twice, then rows of ours (its pool found); the rest from the vendor
  const fetchFn = async (url) => {
    const u = new URL(url);
    const token = u.searchParams.get("token");
    const chart = u.pathname.endsWith("/candles");
    asked.push(`${chart ? "c" : "t"} ${token}`);
    if (chart) return new Response(JSON.stringify({ tf: "15m", candles: [[1, "1", "1", "1", "1", "1"]], src: "coingecko", as_of_ms: t }), { status: 200 });
    const ours = token === CANDIDATES.base[0] && asked.filter((x) => x === `t ${token}`).length > 2;
    return new Response(JSON.stringify({ trades: ours ? [{ tx: "0x1" }] : [], src: ours ? "chain" : "coingecko", as_of_ms: t }), { status: 200, headers: ours ? {} : { "server-timing": `evm-vendor-read;desc="rows read 1000 ms ago"` } });
  };
  const r = await onClock(t, (wait, now, c) => read("http://h", (u) => ((t = c.t), fetchFn(u)), wait, now));
  assert.equal(r.chains.base.coins.length, 2, "the first Base candidate left, the second read");
  assert.equal(r.chains.base.coins[0].reads.length, 3);
  for (const chain of CHAINS) {
    const c = r.chains[chain].coins.at(-1);
    assert.equal(c.reads.length, HOLD_MS / POLL_MS + 1);
    assert.equal(c.charts.length, Math.ceil(c.reads.length / CHART_EVERY));
  }
  assert.equal(judge(r).ok, true, judge(r).lines.join("\n"));
});

test("read: a fetch that fails, the helper's 429 and a body that is not JSON are no-answers, never judged", async () => {
  let t = 0;
  let k = 0;
  // Base's first three reads fault; every other read is the vendor's
  const fetchFn = async (url) => {
    const base = new URL(url).searchParams.get("chain") === "base" && !url.includes("/candles");
    if (base) k++;
    if (base && k === 1) throw new TypeError("fetch failed");
    if (base && k === 2) return new Response("{}", { status: 429 });
    if (base && k === 3) return new Response("<html>", { status: 502 });
    return new Response(JSON.stringify({ trades: [], src: "coingecko" }), { status: 200, headers: { "server-timing": `evm-vendor-read;desc="rows read 1 ms ago"` } });
  };
  const r = await onClock(t, (wait, now) => read("http://h", fetchFn, wait, now));
  const first = r.chains.base.coins[0].reads.slice(0, 3);
  assert.deepEqual(first.map((x) => x.no), ["no answer (TypeError)", "429", "HTTP 502: not JSON"]);
});
