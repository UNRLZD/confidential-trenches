// The NEAR buy's candidate Rhea pools (src/near-pools.ts): read once a session from Rhea's own get_pools pages, a hint
// only (rheaQuote reads each pool on two providers). Fake provider here: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NEAR_NETWORKS, type NearRpc } from "../../kit/src/near/networks.ts";
import { RHEA_QUOTE_POOLS_MAX } from "../../kit/src/near/rhea.ts";
import { dclCandidates, dclPoolsKept, NEAR_DCL_KEPT_MS, NEAR_POOLS_BRIDGE, NEAR_POOLS_PAGE, NEAR_RHEA_KEPT_MS, readRheaPools, rheaCandidates, rheaCandidatesOf, rheaPoolsKept } from "../src/near-pools.ts";
import { DCL_QUOTE_POOLS_MAX, dclPoolOf } from "../../kit/src/near/dcl.ts";

const USDC = NEAR_NETWORKS.mainnet.usdc;
const WRAP = "wrap.near";
const TOKEN = "token.rhealab.near";
const pool = (a: string, b: string, ra: bigint | string, rb: bigint | string, kind = "SIMPLE_POOL") => ({ pool_kind: kind, token_account_ids: [a, b], amounts: [String(ra), String(rb)], total_fee: 30 });
const enc = (v: unknown) => ({ result: { result: [...new TextEncoder().encode(JSON.stringify(v))] } });

function rpcOf(all: unknown[], o: { count?: unknown; asked?: string[] } = {}): NearRpc {
  return {
    name: "fake",
    async query(p) {
      const args = JSON.parse(atob(p.args_base64 as string));
      o.asked?.push(`${p.method_name} ${JSON.stringify(args)}`);
      if (p.method_name === "get_number_of_pools") return enc(o.count ?? all.length);
      return enc(all.slice(args.from_index, args.from_index + args.limit));
    },
  };
}

test("every page is read, only simple two-token pools with u128 reserves are kept, each with its index as its id", async () => {
  const all = [pool(TOKEN, WRAP, 5n, 7n), pool(TOKEN, USDC, 1n, 2n, "STABLE_SWAP"), { junk: true }, pool(TOKEN, USDC, "-1", "2"), ...Array.from({ length: NEAR_POOLS_PAGE }, () => pool("a.near", "b.near", 1n, 1n)), pool(USDC, TOKEN, 9n, 3n)];
  const asked: string[] = [];
  const rows = await readRheaPools("mainnet", rpcOf(all, { asked }));
  assert.equal(asked.filter((a) => a.startsWith("get_pools")).length, 2);
  assert.deepEqual(rows.filter((r) => r.a === TOKEN || r.b === TOKEN).map((r) => r.id), [0, all.length - 1]);
});

test("a count out of range or a page that is not one ends the read", async () => {
  await assert.rejects(readRheaPools("mainnet", rpcOf([], { count: 0 })), /out of range/);
  await assert.rejects(readRheaPools("mainnet", rpcOf([], { count: 10 ** 9 })), /out of range/);
  const bad: NearRpc = { name: "bad", query: async (p) => (p.method_name === "get_number_of_pools" ? enc(3) : enc({ not: "a page" })) };
  await assert.rejects(readRheaPools("mainnet", bad), /not a page/);
  const notView: NearRpc = { name: "x", query: async () => ({ result: { result: "nope" } }) };
  await assert.rejects(readRheaPools("mainnet", notView), /not a view answer/);
});

test("the candidates: the token's pools with USDC or wNEAR by the token's reserve, then the deepest wNEAR/USDC ones, at most the quote's cap", async () => {
  const all = [
    pool(TOKEN, WRAP, 100n, 1n), // 0
    pool(USDC, TOKEN, 1n, 300n), // 1
    pool(TOKEN, "other.near", 999n, 1n), // 2: not a pair the quote routes
    pool(WRAP, USDC, 1n, 50n), // 3
    pool(USDC, WRAP, 70n, 1n), // 4
    pool(TOKEN, WRAP, 0n, 0n), // 5: empty
    ...Array.from({ length: 40 }, (_, k) => pool(TOKEN, USDC, BigInt(k + 1), 1n)), // 6..45
    ...Array.from({ length: 6 }, (_, k) => pool(WRAP, USDC, 1n, BigInt(k + 1))), // 46..51
  ];
  const rows = await readRheaPools("mainnet", rpcOf(all));
  const c = rheaCandidates("mainnet", rows, TOKEN);
  assert.equal(c.length, RHEA_QUOTE_POOLS_MAX);
  assert.deepEqual(c.slice(0, 2), [1, 0]);
  assert.deepEqual(c.slice(-NEAR_POOLS_BRIDGE), [4, 3, 51, 50]);
  assert.ok(!c.includes(2) && !c.includes(5));
  // wNEAR itself: its pools with USDC alone, by its own reserve (all 1 here: by id), no bridge
  const w = rheaCandidates("mainnet", rows, WRAP);
  assert.deepEqual(w, [3, 4, 46, 47, 48, 49, 50, 51]);
});

test("the pools are read whole once, then only their count on each ask (card near-quote-inside-the-kpi); a read that failed is read again", async () => {
  let reads = 0;
  let fail = true;
  const rpc: NearRpc = {
    name: "r",
    async query(p) {
      if (p.method_name === "get_number_of_pools") {
        reads++;
        if (fail) throw new Error("HTTP 429");
        return enc(1);
      }
      return enc([pool(TOKEN, USDC, 1n, 1n)]);
    },
  };
  const kept = rheaPoolsKept("mainnet", () => [rpc, rpc]);
  await assert.rejects(kept(TOKEN));
  fail = false;
  assert.deepEqual(await kept(TOKEN), [0]);
  assert.deepEqual(await kept(TOKEN), [0]);
  assert.equal(reads, 6, "each provider: its failed read, its whole read, then one count read an ask");
});

// the honest list: the token's deep pool (id 1), shallow ones, the wNEAR bridge
const HONEST = [
  pool(TOKEN, WRAP, 10n, 1n), // 0
  pool(USDC, TOKEN, 1n, 1_000_000n), // 1: the deep pool
  pool(WRAP, USDC, 1n, 500n), // 2
  ...Array.from({ length: 40 }, (_, k) => pool(TOKEN, USDC, BigInt(k + 1), 1n)), // 3..42: shallow
];

test("F7 the candidates are read on both providers: one that hides the deep pool, or lists shallow pools as deeper, leaves the honest one's deepest in", async () => {
  const honest = rpcOf(HONEST);
  const want = await rheaPoolsKept("mainnet", () => [honest, honest])(TOKEN);
  assert.equal(want[0], 1);
  // hides the deep pool (its row is another pair) and makes every shallow pool look deeper than it
  const lies = HONEST.map((p, i) => (i === 1 ? pool("a.near", "b.near", 1n, 1n) : i >= 3 ? pool(TOKEN, USDC, 10n ** 30n + BigInt(i), 1n) : p));
  for (const pair of [() => [honest, rpcOf(lies)] as const, () => [rpcOf(lies), honest] as const]) {
    const c = await rheaPoolsKept("mainnet", pair)(TOKEN);
    assert.ok(c.includes(1), "the deep pool is a candidate");
    assert.ok(c.includes(2), "the bridge is a candidate");
    assert.ok(c.length <= RHEA_QUOTE_POOLS_MAX && new Set(c).size === c.length);
  }
  // both honest: the list as one provider's
  assert.deepEqual(rheaCandidatesOf("mainnet", [await readRheaPools("mainnet", honest), await readRheaPools("mainnet", honest)], TOKEN), rheaCandidates("mainnet", await readRheaPools("mainnet", honest), TOKEN));
});

test("F7 one provider failing leaves the other's list; it is read again on the next quote", async () => {
  let down = true;
  let downReads = 0;
  const honest = rpcOf(HONEST);
  const flaky: NearRpc = {
    name: "flaky",
    async query(p) {
      downReads++;
      if (down) throw new Error("HTTP 503");
      return honest.query(p);
    },
  };
  const kept = rheaPoolsKept("mainnet", () => [flaky, honest]);
  assert.equal((await kept(TOKEN))[0], 1);
  const n = downReads;
  down = false;
  assert.equal((await kept(TOKEN))[0], 1);
  assert.ok(downReads > n, "the failed provider is read again");
  const m = downReads;
  await kept(TOKEN);
  assert.equal(downReads, m + 1, "then kept: one count read an ask (card near-quote-inside-the-kpi)");
  // neither read: refused
  const dead: NearRpc = { name: "dead", query: async () => Promise.reject(new Error("HTTP 503")) };
  await assert.rejects(rheaPoolsKept("mainnet", () => [dead, dead])(TOKEN), /503/);
});


// card near-dcl-sell: Rhea DCL's candidates are made on the device from the token alone, never a server's list
test("the DCL candidates: the token with wNEAR and USDC with wNEAR, each at fees 100, 400, 2000 and 10000, lower first", () => {
  const HOODL = "hoodl-95275b.launchpad.justhoot.near";
  const c = dclCandidates("mainnet", HOODL);
  assert.deepEqual(c, [
    `${HOODL}|wrap.near|100`, `${HOODL}|wrap.near|400`, `${HOODL}|wrap.near|2000`, `${HOODL}|wrap.near|10000`,
    `${USDC}|wrap.near|100`, `${USDC}|wrap.near|400`, `${USDC}|wrap.near|2000`, `${USDC}|wrap.near|10000`,
  ]);
  assert.equal(c.length, DCL_QUOTE_POOLS_MAX);
  // a token above wrap.near in order is written second: every id is one dclQuote takes
  const z = dclCandidates("mainnet", "zzz.near");
  assert.equal(z[0], "wrap.near|zzz.near|100");
  for (const id of [...c, ...z]) assert.notEqual(dclPoolOf(id), null, id);
  // wNEAR itself: USDC's four alone; no DCL on testnet; never USDC
  assert.deepEqual(dclCandidates("mainnet", WRAP), c.slice(4));
  assert.deepEqual(dclCandidates("testnet", HOODL), []);
  assert.deepEqual(dclCandidates("mainnet", USDC), []);
});

// card near-dcl-route: the session's read of the token's own DCL pools (dclPoolsKept)
/** A provider whose DCL get_pool answers each id in `has` with its row, every other null; `down` throws; `asked` counts. */
const dclRpc = (name: string, has: string[], o: { down?: boolean; asked?: string[]; junk?: boolean } = {}): NearRpc => ({
  name,
  async query(p) {
    const { pool_id } = JSON.parse(atob(p.args_base64 as string)) as { pool_id: string };
    o.asked?.push(`${p.account_id} ${p.method_name} ${pool_id}`);
    if (o.down) throw new Error(`${name}: 503`);
    if (o.junk) return enc({ pool_id: "another|pool|100" });
    return enc(has.includes(pool_id) ? { pool_id, token_x: "x", token_y: "y", fee: 100, state: "Running" } : null);
  },
});
const ownIds = [100, 400, 2000, 10000].map((f) => `${TOKEN}|${WRAP}|${f}`);
const usdcIds = [100, 400, 2000, 10000].map((f) => `${USDC}|${WRAP}|${f}`);

test("card near-dcl-route: a token with no DCL pool of its own asks DCL nothing; the read is the token's own 4 ids at final on each provider, once a session", async () => {
  const asked: string[] = [];
  const pair = [dclRpc("a", [], { asked }), dclRpc("b", [], { asked })] as const;
  const kept = dclPoolsKept("mainnet", () => pair);
  assert.deepEqual(await kept(TOKEN), []);
  assert.deepEqual(await kept(TOKEN), []);
  assert.equal(asked.length, 8, "4 ids on each provider, then kept");
  assert.ok(asked.every((x) => x.startsWith("dclv2.ref-labs.near get_pool ")) && ownIds.every((id) => asked.includes(`dclv2.ref-labs.near get_pool ${id}`)));
  // testnet and USDC: none, nothing read
  assert.deepEqual(await dclPoolsKept("testnet", () => pair)(TOKEN), []);
  assert.deepEqual(await kept(USDC), []);
  assert.equal(asked.length, 8);
});

test("card near-dcl-route: a pool either provider reads is kept with USDC's 4 (a provider hiding it is outvoted); wrapped NEAR asks USDC's 4 alone", async () => {
  const pair = [dclRpc("a", usdcIds), dclRpc("b", [ownIds[3]!, ...usdcIds])] as const;
  assert.deepEqual(await dclPoolsKept("mainnet", () => pair)(TOKEN), [ownIds[3], ...usdcIds]);
  assert.deepEqual(await dclPoolsKept("mainnet", () => pair)(WRAP), usdcIds);
  // USDC's four are kept as read too (card near-quote-inside-the-kpi): one with no pool on either provider is not asked
  const three = [dclRpc("a", usdcIds.slice(1)), dclRpc("b", [ownIds[3]!, ...usdcIds.slice(1)])] as const;
  assert.deepEqual(await dclPoolsKept("mainnet", () => three)(TOKEN), [ownIds[3], ...usdcIds.slice(1)]);
});

test("card near-dcl-route: a provider that fails is read again next time, the other's answer used meanwhile; both failing gives every candidate (a failed read never takes DCL out); a row that is not the id's is a failed read", async () => {
  const asked: string[] = [];
  const down = { down: true, asked };
  const pair = [dclRpc("a", [ownIds[0]!, ...usdcIds], down), dclRpc("b", [ownIds[0]!, ...usdcIds], { asked })] as const;
  const kept = dclPoolsKept("mainnet", () => pair);
  assert.deepEqual(await kept(TOKEN), [ownIds[0], ...usdcIds]);
  down.down = false;
  await kept(TOKEN);
  assert.equal(asked.filter((x) => x.endsWith(` ${ownIds[0]!}`)).length, 3, "a again, b kept");
  const both = [dclRpc("a", [], { down: true }), dclRpc("b", [], { down: true })] as const;
  assert.deepEqual(await dclPoolsKept("mainnet", () => both)(TOKEN), dclCandidates("mainnet", TOKEN));
  const junk = [dclRpc("a", [], { junk: true }), dclRpc("b", [])] as const;
  assert.deepEqual(await dclPoolsKept("mainnet", () => junk)(TOKEN), [], "the junk provider failed; the other read none");
});

// card near-quote-inside-the-kpi: the kept lists across page loads (a KeptStore), with their refresh
const memStore = () => {
  const m = new Map<string, string>();
  return { m, store: { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) } };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

test("card near-quote-inside-the-kpi: Rhea's list kept across page loads: the next load reads the count alone; a pool added since is read from the tail and quoted on the next ask", async () => {
  const { store } = memStore();
  const all = [...HONEST];
  const asked: string[] = [];
  const rpc = rpcOf(all, { asked });
  let t = 1_000_000;
  const now = () => t;
  assert.equal((await rheaPoolsKept("mainnet", () => [rpc, rpc], { store, now })(TOKEN))[0], 1);
  // a page load later: the stored list, the count read on each provider and no page
  asked.length = 0;
  const next = rheaPoolsKept("mainnet", () => [rpc, rpc], { store, now });
  assert.equal((await next(TOKEN))[0], 1);
  assert.deepEqual(asked, ["get_number_of_pools {}", "get_number_of_pools {}"]);
  // a deeper pool of the token added since: the tail alone is read, and it leads the next ask's candidates
  all.push(pool(USDC, TOKEN, 1n, 10n ** 12n));
  asked.length = 0;
  const c = await next(TOKEN);
  assert.equal(c[0], all.length - 1, "the new pool is the deepest candidate");
  assert.deepEqual(asked.filter((a) => a.startsWith("get_pools")), [`get_pools {"from_index":${HONEST.length},"limit":1}`, `get_pools {"from_index":${HONEST.length},"limit":1}`]);
  // past NEAR_RHEA_KEPT_MS the whole list is read again in the background (reserves re-ranked): the pool that was deep
  // is drained, and the ask after that ranks it last
  all[1] = pool(USDC, TOKEN, 1n, 1n);
  all[all.length - 1] = pool(USDC, TOKEN, 1n, 2n);
  t += NEAR_RHEA_KEPT_MS;
  asked.length = 0;
  await next(TOKEN);
  await flush();
  assert.ok(asked.filter((a) => a.startsWith("get_pools {\"from_index\":0")).length === 2, "read whole on both providers");
  const after = await next(TOKEN);
  assert.notEqual(after[0], 1, "re-ranked by the reserves read now");
});

test("card near-quote-inside-the-kpi: a stored Rhea list that is not one is dropped and read anew; a count lower than kept reads the whole list", async () => {
  const { m, store } = memStore();
  const asked: string[] = [];
  const rpc = rpcOf(HONEST, { asked });
  for (const bad of ["{", JSON.stringify({ count: 3, at: 1, rows: [[0, "a.near", "b.near", "-1", "2"]] }), JSON.stringify({ count: 3, at: 1, rows: [[9, "a.near", "b.near", "1", "2"]] }), JSON.stringify({ count: 3, at: 10 ** 15, rows: [] })]) {
    m.set("rhea-pools:mainnet:0", bad);
    m.set("rhea-pools:mainnet:1", bad);
    asked.length = 0;
    assert.equal((await rheaPoolsKept("mainnet", () => [rpc, rpc], { store, now: () => 1_000 })(TOKEN))[0], 1);
    assert.ok(asked.some((a) => a.startsWith("get_pools {\"from_index\":0")), `read anew after ${bad.slice(0, 40)}`);
  }
  // a stored count above the chain's (pools are never removed): the list is read whole
  m.set("rhea-pools:mainnet:0", JSON.stringify({ count: 999, at: 1, rows: [] }));
  m.set("rhea-pools:mainnet:1", JSON.stringify({ count: 999, at: 1, rows: [] }));
  asked.length = 0;
  assert.equal((await rheaPoolsKept("mainnet", () => [rpc, rpc], { store, now: () => 1_000 })(TOKEN))[0], 1);
  assert.equal(asked.filter((a) => a.startsWith("get_pools {\"from_index\":0")).length, 2);
});

test("card near-quote-inside-the-kpi: DCL's read kept across page loads for NEAR_DCL_KEPT_MS, then read again: a pool added since is seen, one gone is dropped", async () => {
  const { store } = memStore();
  const asked: string[] = [];
  const has = [ownIds[1]!, ...usdcIds];
  const pair = [dclRpc("a", has, { asked }), dclRpc("b", has, { asked })] as const;
  let t = 5_000_000;
  const now = () => t;
  assert.deepEqual(await dclPoolsKept("mainnet", () => pair, { store, now })(TOKEN), [ownIds[1], ...usdcIds]);
  // a page load later, inside the age: nothing read
  asked.length = 0;
  const next = dclPoolsKept("mainnet", () => pair, { store, now });
  assert.deepEqual(await next(TOKEN), [ownIds[1], ...usdcIds]);
  assert.equal(asked.length, 0);
  // a pool added and one gone: past the age, read again on both providers
  has.splice(0, 1, ownIds[2]!);
  t += NEAR_DCL_KEPT_MS;
  assert.deepEqual(await next(TOKEN), [ownIds[2], ...usdcIds]);
  assert.equal(asked.length, 16, "the token's 4 and USDC's 4 on each provider");
});
