// node --test apps/helper/src/data/evm/swaps-hint.test.ts: a listed token's pool from its list's entry (swaps.ts
// fromHint, card helper-robinhood-capacity fold 3). Read live 2026-11-04 22:2xZ on a fresh local helper: one cold
// Robinhood tape cost 89 to 128 calls and 12 at once about 1,200, most of them the discovery (the token's transfers over
// the cold window, then each address's factory and tokens, the v4 receipts and keys, the Pons records, and every
// candidate's swaps), while GeckoTerminal's row already names the pool. The list's pool is taken only once the chain
// says it is the token's, on two agreeing providers; a pool the chain does not confirm is discovered as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CURVE_TOKEN, fakeChain, open, REC } from "../../../test/evm-swaps/robinhood.ts";
import { toRows } from "./lists.ts";
import { TOPIC } from "./swaps.ts";

/** The recorded chain, counting each call by method and the token's own Transfer reads (the discovery's walk). */
function rig() {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const calls = new Map<string, number>();
  let transfers = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    for (const r of JSON.parse(String(init.body)) as { method: string; params: { address?: string; topics?: unknown[] }[] }[]) {
      calls.set(r.method, (calls.get(r.method) ?? 0) + 1);
      const q = r.params[0];
      if (r.method === "eth_getLogs" && q?.address === CURVE_TOKEN && q.topics?.[0] === TOPIC.transfer) transfers++;
    }
    return chain.fetch(url, init);
  };
  return { chain, fetch, calls, transfers: () => transfers };
}
const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const tape = async (hint: string | null) => {
  const r = rig();
  const s = open(r.chain, { t: 1_000_000 }, { pools: new Map(), fetch: r.fetch as never, hint: async () => hint });
  const a = await s.trades(CURVE_TOKEN, 50);
  s.stop();
  return { a, r };
};

test("a listed token whose list names its Pons curve: the curve, confirmed by the factory's record, is read at once: the same tape as the discovery's, no Transfer walk, fewer calls", async () => {
  const found = await tape(null);
  const hinted = await tape(REC.curve);
  assert.equal(found.a.status, 200, found.a.body);
  assert.equal(hinted.a.status, 200, hinted.a.body);
  const trades = (b: string) => (JSON.parse(b) as { trades: unknown[] }).trades;
  assert.ok(trades(found.a.body).length > 0);
  assert.deepEqual(trades(hinted.a.body), trades(found.a.body));
  assert.ok(found.r.transfers() > 0, "the discovery walks the token's transfers");
  assert.equal(hinted.r.transfers(), 0, "the list's pool needs no transfer walk");
  // the recorded chain has no transfers to walk and one candidate, so its discovery is cheap; on the live chain it was
  // about four in five of a cold tape's calls
  assert.ok(total(hinted.r.calls) < total(found.r.calls), `calls with the list's pool ${total(hinted.r.calls)}, discovered ${total(found.r.calls)}`);
  assert.ok((hinted.r.calls.get("eth_call") ?? 0) <= (found.r.calls.get("eth_call") ?? 0), "no more eth_call than the discovery");
});

for (const [name, hint] of [
  ["an address that is no pool of the token (no factory of ours, no Pons record naming it)", `0x${"7".repeat(40)}`],
  ["a v4 pool id the PositionManager holds no key for", `0x${"6".repeat(64)}`],
] as const) {
  test(`a listed token whose list names ${name}: the hint is dropped and the token discovered as before (the same tape)`, async () => {
    const found = await tape(null);
    const hinted = await tape(hint);
    assert.equal(hinted.a.status, 200, hinted.a.body);
    assert.equal(hinted.a.body.replace(/"as_of_ms":\d+/, ""), found.a.body.replace(/"as_of_ms":\d+/, ""));
    assert.ok(hinted.r.transfers() > 0, "discovered");
  });
}

test("a list's rows keep each row's pool aside as its list names it (a v4 id or an address), never a row field", () => {
  const token = (a: string) => ({ type: "token", id: `robinhood_${a}`, attributes: { address: a, symbol: "T", name: "T" } });
  const pool = (address: unknown, base: string) => ({ type: "pool", attributes: { address, pool_created_at: "2026-11-04T20:00:00Z" }, relationships: { base_token: { data: { id: `robinhood_${base}` } } } });
  const [a, b, c] = ["0x" + "a".repeat(40), "0x" + "b".repeat(40), "0x" + "c".repeat(40)];
  const id = "0x" + "D".repeat(64);
  const got = toRows("robinhood", { data: [pool(id, a), pool("0x" + "e".repeat(40), b), pool("not a pool", c)], included: [token(a), token(b), token(c)] }, 1_793_740_000_000);
  assert.ok(got !== null);
  assert.deepEqual([...got.pools], [[a, id.toLowerCase()], [b, "0x" + "e".repeat(40)]]);
  assert.equal(got.rows.length, 3);
  for (const r of got.rows) assert.ok(!Object.hasOwn(r, "pool"));
});

test("card helper-robinhood-capacity fold 5: an eth_call at a mined block is asked once: the hint's decimals read, then the discovery's at the same block, is one agreed read (two providers), not two", async () => {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  let decimals = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    for (const r of JSON.parse(String(init.body)) as { method: string; params: { to?: string; data?: string }[] }[]) if (r.method === "eth_call" && r.params[0]?.to === CURVE_TOKEN && r.params[0]?.data === "0x313ce567") decimals++;
    return chain.fetch(url, init);
  };
  // a hint the chain does not confirm: fromHint reads the token's decimals, then the discovery reads them again
  const s = open(chain, { t: 1_000_000 }, { pools: new Map(), fetch: fetch as never, hint: async () => `0x${"7".repeat(40)}` });
  const a = await s.trades(CURVE_TOKEN, 50);
  s.stop();
  assert.equal(a.status, 200, a.body);
  assert.equal(decimals, 2, `the token's decimals asked ${decimals} times`);
});

test("card helper-robinhood-capacity fold 9: a call that reverts is agreed by two providers as a result is: a listed address that is no pool (its factory() reverts) is asked of two providers, never of every one and again patiently", async () => {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const hint = `0x${"7".repeat(40)}`;
  const asked = new Map<string, number>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    for (const r of JSON.parse(String(init.body)) as { method: string; params: { to?: string; data?: string }[] }[])
      if (r.method === "eth_call" && r.params[0]?.to === hint && r.params[0]?.data === "0xc45a0155") asked.set(url, (asked.get(url) ?? 0) + 1);
    return chain.fetch(url, init);
  };
  const s = open(chain, { t: 1_000_000 }, { pools: new Map(), fetch: fetch as never, hint: async () => hint });
  const a = await s.trades(CURVE_TOKEN, 50);
  s.stop();
  assert.equal(a.status, 200, a.body);
  assert.equal([...asked.values()].reduce((x, y) => x + y, 0), 2, `factory() asked ${[...asked].map(([u, k]) => `${new URL(u).host} ${k}`).join(", ")}`);
});
