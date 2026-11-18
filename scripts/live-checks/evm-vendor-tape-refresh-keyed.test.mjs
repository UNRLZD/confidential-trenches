// node --test scripts/live-checks/evm-vendor-tape-refresh-keyed.test.mjs: the check replays its recorded answers
// (evm-vendor-tape-refresh-keyed.answers.json, each run's source in its _about): this card's local helper passes; main
// before it fails, a held Base or Robinhood vendor tape's rows read past BEHIND_MAX's ms; a run with a chain whose coin
// is not served from the vendor long enough is no verdict, never a pass; a named age at the bound passes and one past it
// fails; the read leaves a coin that answers from our own chain reads and holds the next one HOLD_MS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CANDIDATES, CHAINS, HOLD_MS, judge, MIN_VENDOR, POLL_MS, read, WARM_MS } from "./evm-vendor-tape-refresh-keyed.mjs";
import { BEHIND_MAX } from "../../apps/helper/src/data/evm/swaps.ts";

const A = JSON.parse(readFileSync(new URL("./evm-vendor-tape-refresh-keyed.answers.json", import.meta.url), "utf8"));
const VENDOR = /evm-vendor-read/;

test("the recorded good answer, this card's helper: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer, main before the card: FAIL, its rows past BEHIND_MAX's ms", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines.find((l) => l.startsWith("BAD")), /past it$/);
});

test("planted, each chain: a named age at the bound passes, one past it fails; a non-200 fails; too few vendor answers is no verdict", () => {
  for (const chain of CHAINS) {
    const coin = (r) => r.chains[chain].coins.find((c) => c.reads.filter((x) => VENDOR.test(x.timing)).length >= MIN_VENDOR);
    const ms = BEHIND_MAX[chain].ms;
    const at = structuredClone(A.good);
    const x = coin(at).reads.find((x) => VENDOR.test(x.timing));
    x.timing = x.timing.replace(/rows read \d+ ms ago/, `rows read ${ms} ms ago`);
    assert.equal(judge(at).ok, true, `${chain}: at the bound`);
    x.timing = x.timing.replace(/rows read \d+ ms ago/, `rows read ${ms + 1} ms ago`);
    assert.equal(judge(at).ok, false, `${chain}: past it`);
    const s = structuredClone(A.good);
    coin(s).reads.at(-1).status = 503;
    assert.equal(judge(s).ok, false, `${chain}: a 503`);
    const few = structuredClone(A.good);
    const c = coin(few);
    c.reads = c.reads.slice(0, MIN_VENDOR - 1);
    const r = judge(few);
    assert.equal(r.ok, null, r.lines.join("\n"));
  }
  assert.equal(judge({ chains: {} }).ok, null);
});

test("read: a coin answered from our own chain reads past WARM_MS is left; one whose cold open answers from our reads first and then from the vendor is held HOLD_MS from its first vendor answer, every POLL_MS, on each chain", async () => {
  let t = Date.parse("2026-11-18T15:30:00Z");
  const asked = [];
  // Base's first candidate answers from our own reads always; Robinhood's from our reads at its first read (a cold
  // open past its bound, filling), then from the vendor; the rest from the vendor
  const fetchFn = async (url) => {
    const u = new URL(url);
    const token = u.searchParams.get("token");
    asked.push(token);
    const vendor = token !== CANDIDATES.base[0] && !(token === CANDIDATES.robinhood[0] && asked.filter((x) => x === token).length === 1);
    return new Response(JSON.stringify({ trades: [], src: vendor ? "coingecko" : "chain", as_of_ms: t - 1_000, ...(vendor ? {} : { filling: true }) }), { status: 200, headers: vendor ? { "server-timing": `evm-vendor-read;desc="rows read 1000 ms ago"` } : {} });
  };
  const r = await read("http://h", fetchFn, async (ms) => void (t += ms), () => t);
  const held = Math.floor(HOLD_MS / POLL_MS) + 1;
  assert.deepEqual(r.chains.base.coins.map((c) => c.reads.length), [Math.floor(WARM_MS / POLL_MS) + 1, held]);
  assert.deepEqual(r.chains.robinhood.coins.map((c) => c.reads.length), [1 + held]);
  assert.equal(judge(r).ok, true, judge(r).lines.join("\n"));
});
