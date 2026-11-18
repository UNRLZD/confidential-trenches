// node --test scripts/live-checks/sol-vendor-tape-refresh-lands.test.mjs: the check replays its recorded answers
// (sol-vendor-tape-refresh-lands.answers.json, each run's source in its _about): this card's local helper passes; main
// before it fails, a held vendor tape's rows read up to 42 s before; a run with no coin served from the vendor long
// enough is no verdict, never a pass; a named age at the bound passes and one past it fails; the read leaves a coin
// that answers from our own chain reads and holds the next one HOLD_MS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CANDIDATES, HOLD_MS, judge, MIN_VENDOR, POLL_MS, read } from "./sol-vendor-tape-refresh-lands.mjs";
import { SOL_VENDOR_REACH_MS } from "../../apps/helper/src/data/solana/trades.ts";

const A = JSON.parse(readFileSync(new URL("./sol-vendor-tape-refresh-lands.answers.json", import.meta.url), "utf8"));

test("the recorded good answer, this card's helper: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer, main before the card: FAIL, its rows past SOL_VENDOR_REACH_MS", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines.find((l) => l.startsWith("BAD")), /past it$/);
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
  assert.equal(asked.filter((x) => x === CANDIDATES[0]).length, 1);
  assert.equal(judge(r).ok, true, judge(r).lines.join("\n"));
});
