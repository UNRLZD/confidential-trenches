// The NEAR buy's candidate Rhea pools (src/near-pools.ts): read once a session from Rhea's own get_pools pages, a hint
// only (rheaQuote reads each pool on two providers). Fake provider here: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NEAR_NETWORKS, type NearRpc } from "../../kit/src/near/networks.ts";
import { RHEA_QUOTE_POOLS_MAX } from "../../kit/src/near/rhea.ts";
import { NEAR_POOLS_BRIDGE, NEAR_POOLS_PAGE, readRheaPools, rheaCandidates, rheaCandidatesOf, rheaPoolsKept } from "../src/near-pools.ts";

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

test("the pools are read once a session; a read that failed is read again", async () => {
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
  assert.equal(reads, 4, "each provider read once after its failed read");
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
  assert.equal(downReads, m, "then kept");
  // neither read: refused
  const dead: NearRpc = { name: "dead", query: async () => Promise.reject(new Error("HTTP 503")) };
  await assert.rejects(rheaPoolsKept("mainnet", () => [dead, dead])(TOKEN), /503/);
});

