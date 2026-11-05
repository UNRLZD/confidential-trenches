// node --test scripts/live-checks/helper-v4-hook-liquidity.test.mjs: the live check replays recorded answers
// (helper-v4-hook-liquidity.answers.json). good: apps/helper at the card's fix (14067ea) run on a Mac against Base's real
// lists and providers, every judged v4 trade the token its trader moved, PASS. bad: the deployed helper at 46c6593 read
// 3 minutes before, the buy in Base tx 0x454c1f11 on its tape as the pool's 2,357.007 where its trader got 2,332.259,
// FAIL. robinhood: the fix against Robinhood, where routers send the take straight to the trader, PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SWAP_RPCS } from "../../apps/helper/src/data/evm/swaps.ts";
import { judge, read } from "./helper-v4-hook-liquidity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-v4-hook-liquidity.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const judgedOf = (r) => Number(r.lines.find((l) => /^ok {2}\d+ v4 trades? judged/.test(l))?.match(/\d+/)?.[0] ?? 0);
const TX454 = "0x454c1f113ccd21df881cf0539e92367a7359474550f5d47eb6c51cb32a10a11f";

/** A fetch that answers a recorded run: the lists (its coins as the New list), the tapes, and the providers' replies,
 *  one call or a batch. */
function replay(run) {
  const chain = run.chain ?? "base";
  return async (url, init) => {
    const u = String(url);
    if (SWAP_RPCS[chain].includes(u)) {
      const q = JSON.parse(init.body);
      const one = (c) => ({ jsonrpc: "2.0", id: c.id, result: (c.method === "eth_getTransactionReceipt" ? run.receipts[c.params[0]] : c.method === "eth_call" ? `0x${(run.decimals[c.params[0].to] ?? 18).toString(16).padStart(64, "0")}` : undefined) ?? null });
      return Response.json(Array.isArray(q) ? q.map(one) : one(q));
    }
    if (u.endsWith(`/v1/market/lists?chain=${chain}`)) return Response.json({ lists: { new: run.coins.map((c) => ({ ["tok" + "en"]: c })) } });
    const coin = new URL(u).searchParams.get("token");
    const t = run.tapes[coin];
    return t.status === 200 ? Response.json({ trades: t.trades, src: "chain", as_of_ms: 0 }) : Response.json({ error: { code: "upstream" } }, { status: t.status });
  };
}

test("good: the fix's Base tapes, every judged v4 trade the token its trader moved (Base tx 0x454c1f11's buy the 2,332.259 its trader got): PASS, read again from its answers the same", async () => {
  const r = judge(A.good);
  assert.ok(r.ok, bad(r).join("\n"));
  assert.ok(judgedOf(r) >= 50, r.lines.at(-1));
  const t = A.good.tapes["0x7a6d797910c7148d6f598146b56ebe9b789f7ba3"].trades.find((x) => x.tx === TX454 && x.side === "b");
  assert.equal(t.amt, "2332.259212434009614487");
  const again = await read("https://helper.test", replay(A.good));
  assert.deepEqual(judge(again).lines, r.lines);
});

test("bad: 46c6593's tape shows Base tx 0x454c1f11's buy as the pool's 2,357.007, its hook's cut counted in: FAIL, naming it", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 1, b.join("\n"));
  assert.match(b[0], /0x7a6d797910c7148d6f598146b56ebe9b789f7ba3 trade 0x454c1f11.* amt 2357\.007794273885411305 is not the 2332259212434009614487 its trader 0x103502909141f7025a94b7b99a276dcd128e21a8 got/);
});

test("robinhood: the fix's Robinhood tapes, where a router sends the take straight to the trader, judged and PASS, read again the same", async () => {
  const r = judge(A.robinhood);
  assert.ok(r.ok, bad(r).join("\n"));
  assert.ok(judgedOf(r) >= 50, r.lines.at(-1));
  const again = await read("https://helper.test", replay(A.robinhood), "robinhood");
  assert.deepEqual(judge(again).lines, r.lines);
});

test("no judged trade is a FAIL that says so, never a pass on nothing; an unreadable receipt is a BAD line", () => {
  const none = { ...A.good, receipts: Object.fromEntries(Object.entries(A.good.receipts).map(([tx, r]) => [tx, r && { ...r, logs: r.logs.filter((l) => l.topics?.[0] !== "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f") }])) };
  const r = judge(none);
  assert.equal(r.ok, false);
  assert.match(bad(r).join("\n"), /no v4 trade judged on \d+ base tapes .*: nothing checked/);
  assert.match(bad(judge({ ...A.good, receipts: { ...A.good.receipts, [TX454]: null } })).join("\n"), /its receipt is not agreed by two providers/);
  assert.match(bad(judge({ ...A.good, coins: [] })).join("\n"), /no base token read from the lists/);
});

// Base tx 0xfaaa9cc9... (block 53,537,870), cut to its launch-trade logs: the buy's Swap (178), the hook's cut paid out
// to it (180), the pool's ModifyLiquidity (189), and the buyer's 44,726,051,716,064 minted as PoolManager claims (197).
const FAAA = "0xfaaa9cc939fffb787b906da0c1309746e5229d722df371b1a44322b2994c1460";
const coin = "0xe2969931f5f0d2e2d53e8077e6a923b16512eba3";
const PM = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const POOL = "0x894c4d2aac7d50f1a6e4367e2928a0a1bb876a9cb435d43fe024d2fcd76ef173";
const word = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const CLAIMS_BUY = {
  logs: [
    { address: PM, topics: ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", POOL, word("0xf8cd946adb3e56c6c246fd8eaa32c4c94ec889ed")], data: "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff79d00000000000000000000000000000000000000000000000000002e65fc1021b80000000000000000000000000000000000025c64ad57fb18d558a41852b05664000000000000000000000000000000000000000000000bd1819559a425426917000000000000000000000000000000000000000000000000000000000003a5970000000000000000000000000000000000000000000000000000000000001b58" },
    { address: coin, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", word(PM), word("0x9982538f41f2ae29ddb9d3d9307010052984fdbb")], data: "0x000000000000000000000000000000000000000000000000000005b863a365d8" },
    { address: PM, topics: ["0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec", POOL, word("0x9982538f41f2ae29ddb9d3d9307010052984fdbb")], data: "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2766000000000000000000000000000000000000000000000000000000000000d89a0000000000000000000000000000000000000000000000000000000000050455f84d425564d25e000e629db464057c45d862ce4a5dd192c74cfc9ab2250404026" },
    { address: PM, topics: ["0x1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859", word("0x0"), word("0xf8cd946adb3e56c6c246fd8eaa32c4c94ec889ed"), word(coin)], data: "0x000000000000000000000000f8cd946adb3e56c6c246fd8eaa32c4c94ec889ed000000000000000000000000000000000000000000000000000028ad986cbbe0" },
  ],
};
const claimsRun = (amt) => ({ coins: [coin], tapes: { [coin]: { status: 200, trades: [{ tx: FAAA, side: "b", amt }] } }, decimals: { [coin]: 18 }, receipts: { [FAAA]: CLAIMS_BUY } });

test("a buy taken as PoolManager claims by its router (Base tx 0xfaaa9cc9...) is judged against the claims minted to it: the 44,726,051,716,064 its buyer got PASSes, 04bb10f's 0.000051015555490232 (live run 41990876403) FAILs", () => {
  const r = judge(claimsRun("0.000044726051716064"));
  assert.ok(r.ok, bad(r).join("\n"));
  assert.equal(judgedOf(r), 1);
  assert.match(bad(judge(claimsRun("0.000051015555490232"))).join("\n"), /amt 0\.000051015555490232 is not the 44726051716064 its trader 0xf8cd946adb3e56c6c246fd8eaa32c4c94ec889ed got/);
});
