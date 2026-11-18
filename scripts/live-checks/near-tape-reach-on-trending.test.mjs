// node --test scripts/live-checks/near-tape-reach-on-trending.test.mjs: the check replays its recorded answers
// (near-tape-reach-on-trending.answers.json, each run's source in its _about): this card's NEAR market passes; the
// deployed helper before it fails, each tape asked once after the quiet gap its held rows 12 to 13 s old with no reach;
// a reach claimed on rows named past the bound fails, as does one withheld on rows inside it; a second read within the
// bound is no verdict, never a pass; read makes each coin's two reads QUIET_MS apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COINS, judge, QUIET_MS, read } from "./near-tape-reach-on-trending.mjs";
import { NEAR_VENDOR_REACH_MS } from "../../apps/helper/src/data/near/engine.ts";

const A = JSON.parse(readFileSync(new URL("./near-tape-reach-on-trending.answers.json", import.meta.url), "utf8"));

test("the recorded good answer, this card's NEAR market: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer, the deployed helper before the card: FAIL, no tape claims its reach", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines.find((l) => l.startsWith("BAD")), /^BAD 0 of 3 tapes/);
});

test("planted: a reach on rows named past the bound fails, one withheld inside it fails, a non-200 fails, a short gap is no verdict", () => {
  const past = structuredClone(A.good);
  past.coins[0].second.timing = `near-vendor-read;desc="rows read ${NEAR_VENDOR_REACH_MS + 1} ms ago", total;dur=1`;
  assert.equal(judge(past).ok, false, "a reach claimed on rows past the bound");
  const at = structuredClone(A.good);
  at.coins[0].second.timing = `near-vendor-read;desc="rows read ${NEAR_VENDOR_REACH_MS} ms ago", total;dur=1`;
  assert.equal(judge(at).ok, true, "at the bound");
  const withheld = structuredClone(A.good);
  delete withheld.coins[0].second.whole_ms;
  assert.equal(judge(withheld).ok, false, "a fresh read that claims none");
  const unnamed = structuredClone(A.good);
  unnamed.coins[0].second.timing = "total;dur=1";
  assert.equal(judge(unnamed).ok, false, "an engine tape that names no read");
  const s = structuredClone(A.good);
  s.coins[1].second.status = 503;
  assert.equal(judge(s).ok, false, "a 503");
  const short = structuredClone(A.good);
  short.coins[2].second.at = short.coins[2].first.at + NEAR_VENDOR_REACH_MS;
  assert.equal(judge(short).ok, null, "read again within the bound");
  const one = structuredClone(A.good);
  for (const c of one.coins.slice(1)) delete c.second.whole_ms, (c.second.timing = `near-vendor-read;desc="rows read ${NEAR_VENDOR_REACH_MS + 5_000} ms ago"`);
  assert.equal(judge(one).ok, false, "1 of 3 claimed");
});

test("read: the first COINS Trending (1h) coins, each read once, then again QUIET_MS later", async () => {
  let t = Date.parse("2026-11-18T15:40:00Z");
  const asked = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/v1/market/lists") return new Response(JSON.stringify({ lists: { trending_1h: ["a.near", "b.near", "c.near", "d.near"].map((token) => ({ token })) } }), { status: 200 });
    asked.push([u.searchParams.get("token"), t]);
    return new Response(JSON.stringify({ trades: [{ t_ms: t - 60_000 }], whole_ms: t - 59_000, src: "unrealized", as_of_ms: t }), { status: 200, headers: { "server-timing": `near-vendor-read;desc="rows read 0 ms ago"` } });
  };
  const r = await read("http://h", fetchFn, async (ms) => void (t += ms), () => t);
  assert.deepEqual(r.coins.map((c) => c.coin), ["a.near", "b.near", "c.near"].slice(0, COINS));
  assert.deepEqual(asked.map(([c]) => c), ["a.near", "b.near", "c.near", "a.near", "b.near", "c.near"]);
  assert.equal(r.coins[0].second.at - r.coins[0].first.at, QUIET_MS);
  assert.equal(judge(r).ok, true, judge(r).lines.join("\n"));
});
