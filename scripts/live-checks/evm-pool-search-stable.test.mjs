// node --test scripts/live-checks/evm-pool-search-stable.test.mjs: the live check of card evm-pool-search-stable judges
// recorded runs (evm-pool-search-stable.answers.json). good: a helper of the card's branch, keyless on a Mac: every
// graduated coin's tape settled with trades from our own reads: PASS. bad_live: the deployed helper before the card,
// ZOLVA and VETO settled with none while their pools swapped: FAIL. Planted from the good one: a tape still filling, a
// 503, a tape settled empty, a vendor's tape, the hook unread: FAIL; no graduated coin that swapped: INCONCLUSIVE. The
// pool the check works out from a record, its pinned addresses and its read are held on their own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROBINHOOD_VENUES } from "../../apps/helper/src/data/evm/swaps.ts";
import { RETRY } from "./provider-answer.mjs";
import { APP, BOUND_MS, COINS, FACTORY, judge, KNOWN, POLL_MS, POOL_MANAGER, poolOf, readRun, RPCS } from "./evm-pool-search-stable.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pool-search-stable.answers.json", import.meta.url), "utf8"));
const G = JSON.parse(readFileSync(new URL("../../apps/helper/src/data/evm/fixtures/swaps-robinhood-graduated.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const lastOf = (run, i, f) => ({ ...run, coins: run.coins.map((c, j) => (j === i ? { ...c, answers: [...c.answers.slice(0, -1), f({ ...c.answers.at(-1) })] } : c)) });

test("the pinned addresses are the helper's, and the good run read its memeHook", () => {
  assert.equal(FACTORY, ROBINHOOD_VENUES.ponsV2);
  assert.equal(POOL_MANAGER, ROBINHOOD_VENUES.poolManager);
  assert.equal(A.good.hook, ROBINHOOD_VENUES.ponsV2Hook);
  assert.equal(KNOWN[0], G.coin);
  assert.equal(KNOWN.length, 2);
});

test("good: the card's helper, every graduated coin's tape settled with our own trades: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(A.good.coins.some((c) => c.coin === KNOWN[0] && c.answers.at(-1).txs.length > 0), "ZOLVA's tape holds trades");
});

test("bad_live: the deployed helper before the card, ZOLVA and VETO settled with no trade while their pools swapped: FAIL", () => {
  const r = judge(A.bad_live);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(
    bad(r).map((l) => l.split(":")[0]),
    KNOWN.map((t) => `BAD ${t}`),
  );
  assert.ok(bad(r).every((l) => / with 0 trade\(s\) from chain, 0 of them swaps of its pool/.test(l)), r.lines.join("\n"));
});

test("planted from the good answer: FAIL, or INCONCLUSIVE when no graduated coin swapped", () => {
  for (const [what, run, want, verdict = "FAIL"] of [
    ["a tape still filling at its end", lastOf(A.good, 0, (a) => ({ ...a, filling: true })), /still filling/],
    ["an answer 503", lastOf(A.good, 1, (a) => ({ ...a, status: 503 })), /one 503 at/],
    ["a tape settled with no trade", lastOf(A.good, 0, (a) => ({ ...a, txs: [] })), /with 0 trade\(s\) from chain/],
    ["a vendor's tape", lastOf(A.good, 0, (a) => ({ ...a, src: "geckoterminal" })), /from geckoterminal/],
    ["the hook unread", { ...A.good, hook: null }, /memeHook read alike on both RPCs: null/],
    ["no graduated coin swapped", { ...A.good, coins: A.good.coins.map((c) => ({ ...c, swaps: [] })) }, /^N\/A .* 0 with a swap/, "INCONCLUSIVE"],
  ]) {
    const r = judge(run);
    assert.equal(r.verdict, verdict, `${what}\n${r.lines.join("\n")}`);
    assert.ok(r.lines.some((l) => want.test(l)), `${what}\n${r.lines.join("\n")}`);
  }
});

test("poolOf: a PoolCreated record keys its pool as the factory does (ZOLVA's, recorded, is DexScreener's pool); a record not graduated, or of another token, none", () => {
  const hook = ROBINHOOD_VENUES.ponsV2Hook;
  assert.equal(poolOf(G.coin, G.record, hook), G.pool);
  const phase = (n) => `${G.record.slice(0, 2 + 64 * 10)}${n.toString(16).padStart(64, "0")}${G.record.slice(2 + 64 * 11)}`;
  assert.equal(poolOf(G.coin, phase(2), hook), G.pool);
  for (const n of [0, 1, 3]) assert.equal(poolOf(G.coin, phase(n), hook), null, `phase ${n}`);
  assert.equal(poolOf(KNOWN[1], G.record, hook), null, "another token's record");
  assert.equal(poolOf(G.coin, G.record.slice(0, -64), hook), null, "a short record");
  assert.equal(poolOf(G.coin, undefined, hook), null);
});

test("readRun: the records on both RPCs at one block, then each coin that swapped read as the page reads it until settled; a provider that answers nothing leaves the hook unread: INCONCLUSIVE", async () => {
  const w = (a) => a.slice(2).padStart(64, "0");
  const lists = { chain: "robinhood", lists: { trending: Array.from({ length: 30 }, (_, i) => ({ token: `0x${(i + 16).toString(16).padStart(40, "0")}` })) } };
  const posts = [];
  const down = new Set();
  let reads = 0;
  let clock = 0;
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/v1/market/lists") return assert.equal(init.headers.origin, APP), new Response(JSON.stringify(lists), { status: 200 });
    if (u.pathname === "/v1/market/trades") {
      assert.equal(u.searchParams.get("limit"), "50");
      assert.equal(u.searchParams.get("token"), G.coin);
      reads++;
      const settled = reads >= 3;
      return new Response(JSON.stringify({ trades: settled ? [{ tx: G.logs.at(-1).tx }] : [], src: "chain", as_of_ms: 1, ...(settled ? {} : { filling: true }) }), { status: 200 });
    }
    const { id, method, params } = JSON.parse(init.body);
    posts.push(u.host);
    if (down.has(u.host)) return new Response("", { status: 429 });
    const result =
      method === "eth_blockNumber" ? "0x6ebf000"
      : method === "eth_getLogs" ? (params[0].topics[1] === G.pool ? G.logs.map((l) => ({ topics: l.t, transactionHash: l.tx })) : [])
      : params[0].data === "0x6651812c" ? `0x${w(ROBINHOOD_VENUES.ponsV2Hook)}`
      : params[0].data.endsWith(w(G.coin)) ? G.record : `0x${"0".repeat(960)}`;
    const block = method === "eth_call" ? params[1] : method === "eth_getLogs" ? params[0].toBlock : "0x6ebefec";
    if (block !== "0x6ebefec") return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: `not the head less 20: ${block}` } }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
  };
  const run = await readRun("https://h.example", { fetchFn, sleep: async (ms) => void (clock += ms), now: () => clock });
  for (const u of RPCS) assert.ok(posts.includes(new URL(u).host), `${u} read`);
  assert.deepEqual(run.coins.map((c) => c.coin), [G.coin], "the one PoolCreated record");
  assert.equal(run.coins[0].pool, G.pool);
  assert.equal(run.coins[0].swaps.length, G.logs.length - 2, "the hook's two swaps left out");
  assert.deepEqual(run.coins[0].answers.map((a) => [a.t, a.filling, a.n ?? a.txs.length]), [[0, true, 0], [POLL_MS, true, 0], [2 * POLL_MS, false, 1]]);
  assert.equal(judge(run).verdict, "PASS", judge(run).lines.join("\n"));
  assert.ok(COINS >= KNOWN.length && BOUND_MS >= 60_000);
  // the second provider answers 429 to every read: no hook, no coin, INCONCLUSIVE
  RETRY.ms = 0;
  down.add(new URL(RPCS[1]).host);
  reads = 0;
  const quiet = await readRun("https://h.example", { fetchFn, sleep: async (ms) => void (clock += ms), now: () => clock });
  const v = judge(quiet);
  assert.equal(v.verdict, "INCONCLUSIVE", v.lines.join("\n"));
  assert.equal(quiet.hook, null);
  assert.ok(v.lines.some((l) => l.startsWith("--  ") && l.includes("429")), v.lines.join("\n"));
});
