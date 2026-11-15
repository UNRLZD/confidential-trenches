// Replays of the evm-tape-rows-exact live check (evm-tape-rows-exact.answers.json): the good run, read from the fixed
// helper, passes; the bad run, read from the deployed helper 0d308d3bc before the card (CoinGecko's float amounts on
// Robinhood tapes), fails; read() asks what judge() judges.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SWAP_RPCS } from "../../apps/helper/src/data/evm/swaps.ts";
import { EXIT, judge, operations, read, units } from "./evm-tape-rows-exact.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "evm-tape-rows-exact.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

/** A fetch that answers a recorded run: the helper's lists and tapes, and each provider's replies from the record. */
function replay(run) {
  return async (url, init) => {
    const u = new URL(url);
    if (url.startsWith(run.base)) {
      const chain = u.searchParams.get("chain");
      const c = run.chains[chain];
      if (u.pathname === "/v1/market/lists") return new Response(JSON.stringify({ lists: { new: c.tapes.map((t) => ({ token: t.coin })) } }), { status: 200 });
      const t = c.tapes.find((x) => x.coin === u.searchParams.get("token"));
      return new Response(JSON.stringify({ trades: t.rows, src: t.src }), { status: t.status });
    }
    const chain = Object.keys(SWAP_RPCS).find((k) => SWAP_RPCS[k].includes(url));
    assert.ok(chain, url);
    const c = run.chains[chain];
    const reqs = JSON.parse(init.body);
    return new Response(
      JSON.stringify(
        reqs.map((q) => {
          if (q.method === "eth_call") {
            const d = c.decimals[q.params[0].to];
            return { jsonrpc: "2.0", id: q.id, result: Number.isSafeInteger(d) ? `0x${d.toString(16).padStart(64, "0")}` : null };
          }
          const r = c.receipts[q.params[0]];
          return { jsonrpc: "2.0", id: q.id, result: r === null || r === undefined ? null : { transactionHash: q.params[0], status: "0x1", from: r.from, to: r.to, logs: r.logs.map((l) => ({ address: l.address, logIndex: `0x${l.index.toString(16)}`, topics: l.topics, data: l.data })) } };
        }),
      ),
      { status: 200 },
    );
  };
}

test("good: the fixed helper's Base and Robinhood tapes, every judged row exactly a move of its token and its real trader: PASS", () => {
  const r = judge(A.good);
  assert.deepEqual(bad(r), []);
  assert.equal(r.exit, EXIT.PASS);
  assert.ok(r.lines.some((l) => /^ok {2}robinhood: \d+ rows? judged, [1-9]\d* of them from a tape not of our own reads/.test(l)), "a vendor's rows were judged");
});

test("good_hook: the fixed helper at da17c540b, Base vendor rows judged exact, the v4 hook's own buy in tx 0x2bd3a576 not served: PASS", () => {
  const r = judge(A.good_hook);
  assert.deepEqual(bad(r), []);
  assert.equal(r.exit, EXIT.PASS);
  assert.ok(r.lines.some((l) => /^ok {2}base: \d+ rows? judged, [1-9]\d* of them from a tape not of our own reads/.test(l)), "a vendor's rows were judged");
});

test("bad: the deployed helper 0d308d3bc served CoinGecko's float amounts on Robinhood tapes: FAIL, naming each", () => {
  const r = judge(A.bad);
  assert.equal(r.exit, EXIT.FAIL);
  assert.ok(bad(r).length >= 1);
  assert.ok(bad(r).every((l) => /is no move of the token in its receipt|is the bundler|is no account|is not the transaction's sender/.test(l)), bad(r).join("\n"));
});

test("read() asks the helper and two providers what judge() judges: each recorded run read again judges the same", async () => {
  for (const k of ["good", "good_hook", "bad"]) {
    const again = await read(A[k].base, replay(A[k]), Object.keys(A[k].chains));
    assert.deepEqual(judge(again).lines, judge(A[k]).lines, k);
  }
});

test("a bundle's row naming its bundler, or an account whose operation moved none of it, fails; a row with no receipt two providers gave alike is not judged, and a chain with none judged is INCONCLUSIVE", () => {
  const ep = "0x0000000071727de22e5e9d8baf0edac6f37da032";
  const coin = `0x${"c0".repeat(20)}`;
  const word = (a) => `0x${a.slice(2).padStart(64, "0")}`;
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const receipt = {
    from: `0x${"b0".repeat(20)}`,
    to: ep,
    logs: [
      { address: ep, index: 0, topics: ["0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972"], data: "0x" },
      { address: coin, index: 1, topics: [T, word(`0x${"9".repeat(40)}`), word(`0x${"a1".repeat(20)}`)], data: `0x${(1500n * 10n ** 18n).toString(16).padStart(64, "0")}` },
      { address: ep, index: 2, topics: ["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f", `0x${"0".repeat(64)}`, word(`0x${"a1".repeat(20)}`), word(`0x${"0".repeat(40)}`)], data: "0x" },
    ],
  };
  const tx = `0x${"77".repeat(32)}`;
  const runOf = (trader, amt = "1500", rec = receipt) => ({ base: "x", chains: { robinhood: { tapes: [{ coin, status: 200, src: "coingecko", rows: [{ tx, side: "b", amt, trader }] }], decimals: { [coin]: 18 }, receipts: { [tx]: rec } } } });
  assert.deepEqual(operations(receipt), [{ lo: 0, hi: 2, account: `0x${"a1".repeat(20)}` }]);
  assert.equal(judge(runOf(`0x${"a1".repeat(20)}`)).exit, EXIT.PASS);
  assert.match(bad(judge(runOf(receipt.from)))[0], /is the bundler that sent it/);
  assert.match(bad(judge(runOf(`0x${"a2".repeat(20)}`)))[0], /is no account whose user operation moved the token/);
  assert.match(bad(judge(runOf(`0x${"a1".repeat(20)}`, "1500.00000000001")))[0], /is no move of the token/);
  assert.equal(judge(runOf(`0x${"a1".repeat(20)}`, "1500", null)).exit, EXIT.INCONCLUSIVE);
  assert.equal(units("1.5", 18), 1500000000000000000n);
  assert.equal(units("1.5e3", 18), null);
});
