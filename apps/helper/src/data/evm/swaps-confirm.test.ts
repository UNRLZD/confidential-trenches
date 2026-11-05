// node --test apps/helper/src/data/evm/swaps-confirm.test.ts: a v2 or v3 pool is read only once its factory names it
// (swaps.ts confirmed, card helper-robinhood-capacity fold 8). Before, a pool was taken on the factory() it claimed and
// its two tokens: any contract can claim a factory of ours, and its own Swap logs would be the token's tape. Each venue
// the helper lists, on Base and Robinhood, is asked by its own getPool: Uniswap v3's (token0, token1, fee()), a
// Slipstream-kind CL factory's (.., tickSpacing()) and Aerodrome v2's (.., stable()), the interfaces read on chain
// 2026-11-05 04:5xZ (swaps.ts Venues.getPool).
import { keccak_256 } from "@noble/hashes/sha3.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as B from "../../../test/evm-swaps/base.ts";
import * as R from "../../../test/evm-swaps/robinhood.ts";
import { BASE_VENUES, ROBINHOOD_VENUES, TOPIC } from "./swaps.ts";

const sel = (s: string) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(s))).toString("hex").slice(0, 8)}`;
const w = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
type Kind = "fee" | "tickSpacing" | "stable";
const PARAM: Record<Kind, [string, bigint]> = { fee: ["fee()", 3000n], tickSpacing: ["tickSpacing()", 50n], stable: ["stable()", 0n] };
const GET: Record<Kind, string> = { fee: "getPool(address,address,uint24)", tickSpacing: "getPool(address,address,int24)", stable: "getPool(address,address,bool)" };

/** A chain's fake with one listed pool of `factory` for `coin`: the pool claims the factory and the tokens, answers its
 *  parameter, and the factory's getPool answers `names`. It counts the reads of the pool's logs and of the coin's
 *  transfers (the discovery's walk) and the getPool asks. */
function rig(inner: (url: string, init: RequestInit) => Promise<Response>, o: { coin: string; quote: string; pool: string; factory: string; kind: Kind; names: string }) {
  const n = { poolLogs: 0, transfers: 0, getPool: 0 };
  const [pSel, pVal] = PARAM[o.kind];
  const local = (r: { method: string; params: unknown[] }): unknown => {
    if (r.method === "eth_getLogs") {
      const q = r.params[0] as { address?: string; topics?: unknown[] };
      if (q.address === o.pool) return n.poolLogs++, [];
      if (q.address === o.coin && q.topics?.[0] === TOPIC.transfer) return n.transfers++, [];
      return undefined;
    }
    if (r.method !== "eth_call") return undefined;
    const c = r.params[0] as { to: string; data: string };
    if (c.to === o.coin && c.data === "0x313ce567") return w("0x12");
    if (c.to === o.pool && c.data === "0xc45a0155") return w(o.factory);
    if (c.to === o.pool && c.data === "0x0dfe1681") return w(o.coin);
    if (c.to === o.pool && c.data === "0xd21220a7") return w(o.quote);
    if (c.to === o.pool && c.data === sel(pSel)) return `0x${pVal.toString(16).padStart(64, "0")}`;
    if (c.to === o.factory && c.data === `${sel(GET[o.kind])}${w(o.coin).slice(2)}${w(o.quote).slice(2)}${pVal.toString(16).padStart(64, "0")}`) return n.getPool++, w(o.names);
    return undefined;
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map(local);
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await inner(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    if (!Array.isArray(fwd)) return inner(url, init);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, result: mine[i] } : (fwd.find((x) => x.id === r.id) ?? { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "execution reverted" } })));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, n };
}

const COIN = `0x${"c0".repeat(20)}`;
const POOL = `0x${"f0".repeat(20)}`;
const OTHER = `0x${"0b".repeat(20)}`;
const VENUES_LISTED: { chain: "base" | "robinhood"; name: string; factory: string; kind: Kind; quote: string }[] = [
  { chain: "base", name: "Uniswap v3", factory: BASE_VENUES.uniswapV3, kind: "fee", quote: BASE_VENUES.usdc },
  { chain: "base", name: "Aerodrome v2", factory: BASE_VENUES.aerodromeV2, kind: "stable", quote: BASE_VENUES.weth },
  ...BASE_VENUES.slipstream.map((f) => ({ chain: "base" as const, name: `Slipstream ${f.slice(0, 10)}`, factory: f, kind: "tickSpacing" as Kind, quote: BASE_VENUES.weth })),
  { chain: "robinhood", name: "Uniswap v3", factory: ROBINHOOD_VENUES.uniswapV3, kind: "fee", quote: ROBINHOOD_VENUES.usdg },
  { chain: "robinhood", name: "the CL factory", factory: ROBINHOOD_VENUES.cl, kind: "tickSpacing", quote: ROBINHOOD_VENUES.usdg },
];

for (const v of VENUES_LISTED)
  test(`${v.chain} ${v.name}: a listed pool its factory names by getPool(token0, token1, ${PARAM[v.kind][0]}) is read; one it does not name never is`, async () => {
    for (const [names, read] of [[POOL, true], [OTHER, false]] as const) {
      const base = v.chain === "base" ? B.fakeChain() : R.fakeChain();
      if (v.chain === "robinhood") (base as ReturnType<typeof R.fakeChain>).st.head = R.REC.lastHead;
      const r = rig(base.fetch, { coin: COIN, quote: v.quote, pool: POOL, factory: v.factory, kind: v.kind, names });
      const over = { fetch: r.fetch as never, pools: new Map(), hint: async () => POOL };
      const s = v.chain === "base" ? B.open(base as ReturnType<typeof B.fakeChain>, undefined, over) : R.open(base as ReturnType<typeof R.fakeChain>, undefined, over);
      await s.trades(COIN, 50);
      s.stop();
      assert.ok(r.n.getPool > 0, "the factory was asked to name the pool");
      if (read) assert.ok(r.n.poolLogs > 0, "the named pool's swaps are read");
      else assert.equal(r.n.poolLogs, 0, "a pool its factory does not name is never read");
    }
  });

test("the getPool and parameter selectors swaps.ts asks are the keccak-256 of their signatures", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("./swaps.ts", import.meta.url), "utf8");
  for (const k of ["fee", "tickSpacing", "stable"] as Kind[]) {
    assert.match(src, new RegExp(`PARAM_SEL = \\{[^}]*${k}: "${sel(PARAM[k][0])}"`));
    assert.match(src, new RegExp(`GET_POOL_SEL = \\{[^}]*${k}: "${sel(GET[k])}"`));
  }
});
