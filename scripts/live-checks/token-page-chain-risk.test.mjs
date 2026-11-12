// node --test scripts/live-checks/token-page-chain-risk.test.mjs: the check replays its recorded answers
// (token-page-chain-risk.answers.json, each part's source in its _about): the card's chain fields pass; the deployed
// helper before the card (top 10 Jupiter's, snipers none) and a bundlers value with no source fail; the read polls the
// page until the chain fields land, at most READ_MS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, POLL_MS, read, READ_MS } from "./token-page-chain-risk.mjs";

const A = JSON.parse(readFileSync(new URL("./token-page-chain-risk.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer: top 10, snipers and bundlers our chain reads: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answers: the deployed helper before the card, a bundlers value with no source: FAIL", () => {
  assert.deepEqual(bad(judge(A.bad_deployed)).map((l) => l.slice(0, 31)), ["BAD top 10 from our chain read:", "BAD snipers from our chain read"]);
  assert.deepEqual(bad(judge(A.bad_guess)).map((l) => l.slice(0, 30)), ["BAD bundlers our chain read or"]);
});

test("read: the newest pump.fun token of the New list, its page read every POLL_MS until the chain fields land, READ_MS at most", async () => {
  let t = 0;
  const pageOf = (src) => ({ row: { snipers_bps: 1 }, risk: { top10_bps: { v: 1, src, as_of_ms: 1 }, snipers_bps: { v: 1, src, as_of_ms: 1 } } });
  const asked = [];
  let reads = 0;
  const fetchFn = async (url) => {
    asked.push(url.replace(/^https:\/\/h\.test/, ""));
    const body = url.endsWith("/v1/health") ? { solana: { holders: "keyed" } }
      : url.includes("/lists") ? { lists: { new: [{ token: "Old", launchpad: "pump.fun", created_s: 1 }, { token: "Bonk", launchpad: "bonk.fun", created_s: 9 }, { token: "New", launchpad: "pump.fun", created_s: 5 }] } }
      : pageOf(++reads < 3 ? "none" : "chain");
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const r = await read("https://h.test", fetchFn, async (ms) => void (t += ms), () => t);
  assert.equal(r.mint, "New");
  assert.equal(r.pages.length, 3);
  assert.equal(t, 2 * POLL_MS);
  // never landing: READ_MS of reads, then the last read judged
  reads = -1e9;
  t = 0;
  const never = await read("https://h.test", fetchFn, async (ms) => void (t += ms), () => t);
  assert.equal(never.pages.length, READ_MS / POLL_MS + 1);
  assert.equal(judge(never).ok, false);
});
