// node --test scripts/live-checks/helper-v4-hook-liquidity.test.mjs: the live check replays recorded answers
// (helper-v4-hook-liquidity.answers.json). good: apps/helper at the card's fix run on a Mac against Base's real lists
// and providers, its launch trades each the Transfer the trader got, PASS. bad: the deployed helper at c68e2b7 read in
// the same minutes, two launches (0x2ee14e9a..., 0x3ca86bbb...) on the tape as 2,500,000,000 tokens where the trader
// got 500,000,000 (the hook's 2e9 liquidity settle counted as the buy's cut), FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SWAP_RPCS } from "../../apps/helper/src/data/evm/swaps.ts";
import { judge, OLDEST, read } from "./helper-v4-hook-liquidity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-v4-hook-liquidity.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

/** A fetch that answers a recorded run: the lists (its coins as the New list), the tapes, and the providers' replies. */
function replay(run) {
  return async (url, init) => {
    const u = String(url);
    if (SWAP_RPCS.base.includes(u)) {
      const q = JSON.parse(init.body);
      const result = q.method === "eth_getTransactionReceipt" ? run.receipts[q.params[0]] : q.method === "eth_call" ? `0x${(run.decimals[q.params[0].to] ?? 18).toString(16).padStart(64, "0")}` : undefined;
      return Response.json({ jsonrpc: "2.0", id: q.id, result: result ?? null });
    }
    if (u.endsWith("/v1/market/lists?chain=base")) return Response.json({ lists: { new: run.coins.map((c) => ({ ["tok" + "en"]: c })) } });
    const coin = new URL(u).searchParams.get("token");
    const t = run.tapes[coin];
    return t.status === 200 ? Response.json({ trades: t.trades, src: "chain", as_of_ms: 0 }) : Response.json({ error: { code: "upstream" } }, { status: t.status });
  };
}

test("good: the fix's tape holds launch trades, each exactly the Transfer the trader got: PASS, read again from its answers the same", async () => {
  const r = judge(A.good);
  assert.ok(r.ok, bad(r).join("\n"));
  assert.ok(r.lines.some((l) => /^ok {2}\d+ launch trades? read$/.test(l)));
  assert.ok(r.lines.some((l) => l.includes("0x2ee14e9abe17551f042ef75b2d96d085dd445e24 launch trade") && l.includes("500000000.000000061969702758")));
  const again = await read("https://helper.test", replay(A.good));
  assert.deepEqual(judge(again).lines, r.lines);
});

test("bad: c68e2b7's tape shows two launches with the hook's liquidity settle counted in: FAIL, naming each", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 2, b.join("\n"));
  assert.match(b[0], /0x2ee14e9abe17551f042ef75b2d96d085dd445e24 launch trade 0xefcdde26.* amt 2500000000\.00000006161709351 is no Transfer/);
  assert.match(b[1], /0x3ca86bbbb10d85eb3a5cae69232611d02123f8fc launch trade 0x169782d3/);
});

test("no launch trade among the tapes' oldest trades is a FAIL that says so, never a pass on nothing; an unreadable receipt is a BAD line", () => {
  const none = { ...A.good, receipts: Object.fromEntries(Object.entries(A.good.receipts).map(([tx, r]) => [tx, r && { ...r, logs: r.logs.filter((l) => !/^0x(dd466e67|f208f491|29ef05ca)/.test(l.topics?.[0] ?? "")) }])) };
  const r = judge(none);
  assert.equal(r.ok, false);
  assert.match(bad(r).join("\n"), new RegExp(`no launch trade .* among the oldest ${OLDEST} trades of \\d+ Base tapes: nothing checked`));
  const tx = A.good.tapes[A.good.coins.find((c) => A.good.tapes[c].status === 200 && A.good.tapes[c].trades.length > 0)].trades.at(-1).tx;
  assert.match(bad(judge({ ...A.good, receipts: { ...A.good.receipts, [tx]: null } })).join("\n"), /its receipt is not agreed by two providers/);
  assert.match(bad(judge({ ...A.good, coins: [] })).join("\n"), /no Base token read from the lists/);
});
