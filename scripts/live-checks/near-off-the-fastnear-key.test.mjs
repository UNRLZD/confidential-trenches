// node --test scripts/live-checks/near-off-the-fastnear-key.test.mjs: the live check replays recorded answers
// (near-off-the-fastnear-key.answers.json; the key is on the helper box only). good: this card's helper in-process,
// made-up keyed FastNEAR and dRPC URLs whose sends went to the same companies' free endpoints, the fee quote 200 and the
// helper's key reads 0 -> 5: PASS. bad_pre_card: the deployed helper before the card, read live with --record (no
// X-Helper-Near-Key-Reads): FAIL. Planted from the good one: the ceiling hit at the first read, the count not moving,
// the fee answered 429, a URL or a key in the header, a day that is not the read's, the ceiling changed between the
// reads, the seat's count falling, the two reads on two days: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { daysOf, HEADER, judge, read, SETTLE_MS, USDC } from "./near-off-the-fastnear-key.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "near-off-the-fastnear-key.answers.json"), "utf8"));

/** A fetch that answers a recorded run: the health, the fee quote, the health again, in that order. */
function replay(a) {
  const asked = [];
  const fetchFn = async (url, init) => {
    assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
    const u = new URL(url);
    asked.push(u.pathname + u.search);
    if (u.pathname === "/v1/health") {
      const h = asked.filter((p) => p === "/v1/health").length === 1 ? a.before : a.after;
      return new Response("{}", { status: h.status, headers: h.line === null ? {} : { [HEADER]: h.line } });
    }
    assert.equal(u.pathname, "/v1/withdraw/fee");
    return new Response(a.fee.body, { status: a.fee.status });
  };
  return { asked, fetchFn };
}
/** The recorded run read again through the check's own read(), on the recorded clock. */
async function reread(a) {
  const { asked, fetchFn } = replay(a);
  const naps = [];
  const times = [a.before.at, a.after.at];
  const r = await read("http://127.0.0.1:18741", fetchFn, async (ms) => void naps.push(ms), () => times.shift());
  return { r, asked, naps };
}
const at = (line) => ({ ...A.good, after: { ...A.good.after, line } });

test("recorded good answer (this card's helper in-process: the fee quote 200, the helper's key reads 0 -> 5): PASS", async () => {
  const { r, asked, naps } = await reread(A.good);
  assert.deepEqual(asked, ["/v1/health", `/v1/withdraw/fee?token=${USDC}`, "/v1/health"]);
  assert.deepEqual(naps, [SETTLE_MS]);
  const v = judge(r);
  assert.ok(v.ok, v.lines.join("\n"));
  assert.ok(v.lines.includes("ok  the helper's key reads moved: 0 -> 5"), v.lines.join("\n"));
});

test("recorded bad answer (the deployed helper before the card: no X-Helper-Near-Key-Reads): FAIL", async () => {
  const v = judge((await reread(A.bad_pre_card)).r);
  assert.equal(v.ok, false);
  assert.ok(v.lines.includes("BAD x-helper-near-key-reads (first): null names today and yesterday"), v.lines.join("\n"));
});

test("planted: the ceiling hit, the count not moving, the fee 429, a URL or a key in the header, another day, the ceiling changed, the seat falling, two days: FAIL", () => {
  const g = A.good;
  const [today, yesterday] = [g.before.line.slice(0, 10), g.before.line.split(", ")[1].slice(0, 10)];
  for (const [what, a] of [
    ["the ceiling hit at the first read", { ...g, before: { ...g.before, line: `${today} helper=0 seat=300000 of 300000 hit, ${yesterday} helper=0 seat=0 of 300000 open` } }],
    ["the count not moving", at(g.before.line)],
    ["the fee answered 429", { ...g, fee: { status: 429, body: '{"error":{"code":"rate_limited"}}' } }],
    ["a URL in the header", at(`${today} helper=5 seat=0 of 300000 open, ${yesterday} helper=0 seat=0 of 300000 open https://rpc.mainnet.fastnear.com?apiKey=x`)],
    ["another day named today", at(`${yesterday} helper=5 seat=0 of 300000 open, ${yesterday} helper=0 seat=0 of 300000 open`)],
    ["the ceiling changed", at(`${today} helper=5 seat=0 of 100 open, ${yesterday} helper=0 seat=0 of 100 open`)],
    ["the seat's count falling", { ...g, before: { ...g.before, line: `${today} helper=0 seat=9 of 300000 open, ${yesterday} helper=0 seat=0 of 300000 open` } }],
    ["the two reads on two days", { ...g, after: { ...g.after, at: g.after.at + 86_400_000, line: `${new Date(g.after.at + 86_400_000).toISOString().slice(0, 10)} helper=5 seat=0 of 300000 open, ${today} helper=0 seat=0 of 300000 open` } }],
    ["a health 503", { ...g, after: { ...g.after, status: 503 } }],
  ]) assert.equal(judge(a).ok, false, what);
});

test("the header's shape: two days, each '<day> helper=<n> seat=<n> of <ceiling> open|hit'; anything else is no reading", () => {
  assert.deepEqual(daysOf("2026-11-26 helper=1 seat=2 of 300000 open, 2026-11-25 helper=3 seat=4 of 300000 hit"), [
    { day: "2026-11-26", helper: 1, seat: 2, ceiling: 300000, state: "open" },
    { day: "2026-11-25", helper: 3, seat: 4, ceiling: 300000, state: "hit" },
  ]);
  for (const bad of [null, "", "2026-11-26 helper=1 seat=2 of 300000 open", "2026-11-26 helper=-1 seat=2 of 300000 open, 2026-11-25 helper=3 seat=4 of 300000 open", "2026-11-26 helper=1 seat=2 of 300000 shut, 2026-11-25 helper=3 seat=4 of 300000 open"]) assert.equal(daysOf(bad), null, String(bad));
});
