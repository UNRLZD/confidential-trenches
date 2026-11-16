// node --test scripts/live-checks/market-data-matches-the-page.test.mjs: the check replays its recorded answers
// (market-data-matches-the-page.answers.json, each part's source in its _about): the card's answers pass; the deployed
// helper before the card fails each of its five rules, and one planted fault each fails alone; the read asks the routes
// the page asks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, NEAR_POOLS, NEAR_COIN, read } from "./market-data-matches-the-page.mjs";

const A = JSON.parse(readFileSync(new URL("./market-data-matches-the-page.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(":")[0]);

test("the recorded good answer: the NEAR push upgrades, Base pools 200, no program account or pool among holders, no priced MC 0: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer, the deployed helper before the card: FAIL on each item", () => {
  assert.deepEqual(bad(judge(A.bad_deployed)), [
    "BAD the NEAR push upgrades to a WebSocket",
    "BAD Base pools answer 200 with chain 8453",
    "BAD no Solana holder is a program's account",
    "BAD no NEAR holder is a Ref pool",
    "BAD no priced robinhood row has MC 0",
  ]);
});

test("one planted fault each fails alone", () => {
  const plant = (f) => {
    const r = structuredClone(A.good);
    f(r);
    return bad(judge(r));
  };
  assert.deepEqual(plant((r) => (r.push = 404)), ["BAD the NEAR push upgrades to a WebSocket"]);
  assert.deepEqual(plant((r) => (r.pools = { status: 404, chainId: null, complete: null })), ["BAD Base pools answer 200 with chain 8453"]);
  // the bonding curve the deployed helper listed first for BwKzgd... (bad_deployed), back among the good holders
  const curve = A.bad_deployed.solana[0].holders.find((h) => !A.good.solana[0].holders.some((g) => g.addr === h.addr));
  assert.deepEqual(plant((r) => r.solana[0].holders.unshift(curve)), ["BAD no Solana holder is a program's account"]);
  assert.deepEqual(plant((r) => r.near.addrs.push(NEAR_POOLS[1])), ["BAD no NEAR holder is a Ref pool"]);
  assert.deepEqual(plant((r) => (r.caps.base.priced[0].mc_usd = "0")), ["BAD no priced base row has MC 0"]);
  // a burn row off the curve is no program's account
  assert.deepEqual(plant((r) => r.solana[0].holders.push({ ...curve, kind: "burn" })), []);
});

test("read: the NEAR push, Base pools, the Solana New list's first coins' holders, NEAR holders, the EVM lists", async () => {
  const asked = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    asked.push(`${u.pathname}?${u.searchParams}`);
    const body =
      u.pathname === "/v1/market/pools"
        ? { chainId: 8453, complete: false, pools: [] }
        : u.pathname === "/v1/market/lists" && u.searchParams.get("chain") === "solana"
          ? { lists: { new: [{ token: "a" }, { token: "b" }, { token: "c" }, { token: "d" }] } }
          : u.pathname === "/v1/market/lists"
            ? { lists: { new: [{ token: "0xaa", price_usd: "1", mc_usd: "5" }, { token: "0xbb", price_usd: null, mc_usd: "0" }] } }
            : { holders: [{ addr: "x", bps: 1, amt: "1" }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  let pushed = null;
  const r = await read("https://h.test/", fetchFn, async (url) => ((pushed = url), 101));
  assert.equal(pushed, `https://h.test/v1/market/push?chain=near&token=${NEAR_COIN}`);
  assert.equal(r.push, 101);
  assert.deepEqual(r.pools, { status: 200, chainId: 8453, complete: false });
  assert.deepEqual(r.solana.map((c) => c.coin), ["a", "b", "c"]);
  assert.deepEqual(r.solana[0].holders, [{ addr: "x", bps: 1 }]);
  assert.deepEqual(r.caps.base.priced, [{ address: "0xaa", mc_usd: "5" }], "only a priced row is judged");
  assert.ok(asked.includes(`/v1/market/holders?chain=near&token=${NEAR_COIN}`));
});
