// node --test scripts/live-checks/helper-tape-4337-trader.test.mjs: the live check replays recorded answers
// (helper-tape-4337-trader.answers.json). good: apps/helper's swaps reader at the card's fix (0c5e573) run on a Mac
// against Robinhood's real providers, its lists the deployed helper's, every judged smart-account trade naming its
// account: PASS. bad: the deployed helper at d496961 read minutes before, two smart-account trades on its tapes naming
// their bundlers 0x43375dd4... and 0x4337350b...: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGGREGATOR_CHANGED, BEFORE_EXECUTION, ENTRY_POINTS as HELPER_ENTRY_POINTS, USER_OP_EVENT } from "../../apps/helper/src/data/evm/index.ts";
import { SWAP_RPCS } from "../../apps/helper/src/data/evm/swaps.ts";
import { ENTRY_POINTS, judge, read, swapAccounts } from "./helper-tape-4337-trader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-tape-4337-trader.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const judgedOf = (r) => Number(r.lines.find((l) => /^ok {2}\d+ smart-account trades? judged/.test(l))?.match(/\d+/)?.[0] ?? 0);
const hex = (n) => `0x${n.toString(16)}`;

/** A fetch that answers a recorded run: the lists (its coins as the New list), the tapes, and the providers' replies. */
function replay(run) {
  const chain = run.chain ?? "robinhood";
  return async (url, init) => {
    const u = String(url);
    if (SWAP_RPCS[chain].includes(u)) {
      const q = JSON.parse(init.body);
      const one = (c) => {
        const r = run.receipts[c.params[0]];
        // a transaction the run read no receipt of went to no EntryPoint; one whose receipt was not agreed, to one
        const to = r === undefined ? `0x${"0".repeat(40)}` : r === null ? ENTRY_POINTS[0] : r.to;
        const raw = r && { ...r, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, logIndex: hex(l.index) })) };
        return { jsonrpc: "2.0", id: c.id, result: c.method === "eth_getTransactionByHash" ? { hash: c.params[0], to } : c.method === "eth_getTransactionReceipt" ? (raw ?? null) : null };
      };
      return Response.json(Array.isArray(q) ? q.map(one) : one(q));
    }
    if (u.endsWith(`/v1/market/lists?chain=${chain}`)) return Response.json({ lists: { new: run.coins.map((c) => ({ ["tok" + "en"]: c })) } });
    const coin = new URL(u).searchParams.get("token");
    const t = run.tapes[coin];
    return t.status === 200 ? Response.json({ trades: t.trades, src: "chain", as_of_ms: 0 }) : Response.json({ error: { code: "upstream" } }, { status: t.status });
  };
}

test("the check's EntryPoints and their event topics are the helper's (written out in the check, so it does not take its rule from what it checks)", () => {
  assert.deepEqual(new Set(ENTRY_POINTS), HELPER_ENTRY_POINTS);
  const src = readFileSync(path.join(HERE, "helper-tape-4337-trader.mjs"), "utf8");
  for (const t of [USER_OP_EVENT, BEFORE_EXECUTION, AGGREGATOR_CHANGED]) assert.ok(src.includes(`"${t}"`), t);
});

test("good: the fix's Robinhood tapes, every judged smart-account trade naming the account its bundle's receipt names: PASS, read again from its answers the same", async () => {
  const r = judge(A.good);
  assert.ok(r.ok, bad(r).join("\n"));
  assert.ok(judgedOf(r) >= 1, r.lines.at(-1));
  for (const l of r.lines.filter((x) => x.startsWith("ok  0x"))) assert.doesNotMatch(l, /trader (0x[0-9a-f]{40}), the account \(bundler \1,/);
  const again = await read("https://helper.test", replay(A.good));
  assert.deepEqual(judge(again).lines, r.lines);
});

test("bad: d496961's Robinhood tapes name the bundlers 0x43375dd4 and 0x4337350b as the traders of two smart-account trades: FAIL, naming each", async () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 2, b.join("\n"));
  assert.match(b.join("\n"), /trade 0x389aa571.*trader 0x43375dd4f819b6b6a59cf2603c6575218a0e7774 is the bundler that sent it, not the account \(0xa6ec12278d8c3aee752d8657a47a86bc04d118cc\)/);
  assert.match(b.join("\n"), /trade 0xa30c8ab9.*trader 0x4337350b136106bb7ab5cadca839630fe49c1190 is the bundler that sent it, not the account \(0x473b19cba2a027a1ee3dd1fbd281a5efe6adee2f\)/);
  const again = await read("https://helper.test", replay(A.bad));
  assert.deepEqual(judge(again).lines, r.lines);
});

test("no judged trade is a FAIL that says so, never a pass on nothing; an unagreed receipt, a trader of none, or another account is a BAD line", () => {
  const none = judge({ ...A.good, receipts: {} });
  assert.equal(none.ok, false);
  assert.match(bad(none).join("\n"), /no trade sent through a smart account judged on \d+ robinhood tapes: nothing checked/);
  assert.match(bad(judge({ ...A.good, coins: [] })).join("\n"), /no robinhood token read from the lists/);
  const [tx] = Object.entries(A.good.receipts).find(([, r]) => r !== null && swapAccounts(r).size > 0);
  assert.match(bad(judge({ ...A.good, receipts: { ...A.good.receipts, [tx]: null } })).join("\n"), /its bundle's receipt is not agreed by two providers/);
  const retrade = (trader) => ({ ...A.good, tapes: Object.fromEntries(Object.entries(A.good.tapes).map(([c, t]) => [c, { ...t, trades: t.trades?.map((x) => (x.tx === tx ? { ...x, trader } : x)) }])) });
  assert.match(bad(judge(retrade(null))).join("\n"), /trader null is no account whose user operation swapped/);
  assert.match(bad(judge(retrade(`0x${"9".repeat(40)}`))).join("\n"), /trader 0x9{40} is no account whose user operation swapped/);
});

test("swapAccounts on a real bundle of two user operations (Base tx 0xb2cabb87, the helper's fixture): each operation's account, whose run holds a swap; a swap before BeforeExecution or in no run counts for none", () => {
  const f = JSON.parse(readFileSync(path.join(HERE, "../../apps/helper/src/data/evm/fixtures/swaps-4337-base.json"), "utf8"));
  const { receipt } = Object.values(f.txs)[0];
  const r = { from: receipt.from, to: receipt.to, logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics, index: parseInt(l.logIndex, 16) })) };
  assert.deepEqual([...swapAccounts(r)].sort(), ["0x6ef19e98a6ceb81c3747c01662af806f8422cf2f", "0x8ef7a1b184a0aea45afd9cd0e8d85ede1fb0e8a4"]);
  // the second operation's swap (log 73) gone: only the first's account
  assert.deepEqual([...swapAccounts({ ...r, logs: r.logs.filter((l) => l.index !== 73) })], ["0x8ef7a1b184a0aea45afd9cd0e8d85ede1fb0e8a4"]);
  // no BeforeExecution of the EntryPoint (a contract of another address logs it): no run, no account
  assert.equal(swapAccounts({ ...r, logs: r.logs.map((l) => (l.index === 44 ? { ...l, address: `0x${"2".repeat(40)}` } : l)) }).size, 0);
});
