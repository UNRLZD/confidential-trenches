// node --test scripts/live-checks/token-stats-count-every-trade.test.mjs: the check replays its recorded answers
// (token-stats-count-every-trade.answers.json, each part's source in its _about): the card's answers pass; the deployed
// helper before the card fails on each chain; a filling tape that claims a reach and a reach past its read fail; the
// read polls a filling tape until it settles, READ_MS at most.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, COINS, judge, POLL_MS, read, READ_MS } from "./token-stats-count-every-trade.mjs";

const A = JSON.parse(readFileSync(new URL("./token-stats-count-every-trade.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(":")[0]);

test("the recorded good answer: every chain's settled tapes claim a reach: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer, the deployed helper before the card: FAIL on each chain", () => {
  assert.deepEqual(bad(judge(A.bad_deployed)), CHAINS.map((c) => `BAD ${c}`));
});

test("planted: a filling tape with a reach, a reach past its read, a non-200 answer: each fails alone", () => {
  const plant = (f) => {
    const r = structuredClone(A.good);
    f(r);
    return bad(judge(r));
  };
  assert.deepEqual(plant((r) => r.chains.base.tapes[0].reads.unshift({ status: 200, n: 0, oldest_ms: null, filling: true, whole_ms: 0, src: "chain", as_of_ms: 1 })), ["BAD base"]);
  assert.deepEqual(plant((r) => { const x = r.chains.near.tapes[0].reads.at(-1); x.whole_ms = x.as_of_ms + 120_000; }), ["BAD near"]);
  assert.deepEqual(plant((r) => (r.chains.solana.tapes[1].reads.at(-1).status = 503)), ["BAD solana"]);
});

test("read: each chain's first COINS Trending coins, a filling tape read every POLL_MS until it settles, READ_MS at most", async () => {
  let t = 0;
  let n = 0;
  const fetchFn = async (url) => {
    const u = new URL(url);
    const body =
      u.pathname === "/v1/market/lists"
        ? { lists: { trending_1h: [{ token: "a" }, { token: "b" }, { token: "c" }, { token: "d" }] } }
        : u.searchParams.get("token") === "a" && u.searchParams.get("chain") === "base" && ++n < 3
          ? { trades: [], filling: true, src: "chain", as_of_ms: 5 }
          : { trades: [{ t_ms: 3 }, { t_ms: 1 }], whole_ms: 1_001, src: "chain", as_of_ms: 5 };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const r = await read("https://h.test", fetchFn, async (ms) => void (t += ms), () => t);
  assert.deepEqual(r.chains.base.tapes.map((x) => x.coin), ["a", "b", "c"].slice(0, COINS));
  assert.equal(r.chains.base.tapes[0].reads.length, 3);
  assert.equal(t, 2 * POLL_MS);
  assert.deepEqual(r.chains.base.tapes[0].reads.at(-1), { status: 200, n: 2, oldest_ms: 1, filling: false, whole_ms: 1_001, src: "chain", as_of_ms: 5 });
  // never settling: READ_MS of reads
  n = -1e9;
  t = 0;
  const never = await read("https://h.test", fetchFn, async (ms) => void (t += ms), () => t);
  assert.equal(never.chains.base.tapes[0].reads.length, READ_MS / POLL_MS + 1);
});
