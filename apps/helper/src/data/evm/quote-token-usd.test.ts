// node --test apps/helper/src/data/evm/quote-token-usd.test.ts (card evm-quote-token-priced-from-our-reads): a held
// vendor tape whose pool is quoted in a third token (Base USEF/ZORA on Uniswap v4, Robinhood fBOMB/r33 on Ramses
// Legacy) prices the rows our own reads renew through that token's own pool at their block, never at the vendor's last
// rate: with the CoinGecko key's share spent (every keyed call refused), the newest trade on chain is served at the USD
// the vendor printed for it within 1%, and its answer names no evm-vendor-price age. Red at b0cb7010b: those rows were
// priced at the USD per unit the vendor's own older rows paid, its age named (evm-vendor-price).
//
// The reads are mainnet's, recorded 19 Nov (fixtures/quote-token-usd.json; RECORD=1 reads any missing one): the
// vendor's rows of each pool (their two legs kept as `legs`, as fixtures/gt-pool-trades-sogni-base.json keeps them)
// and their receipts, the pools GeckoTerminal lists for the quote token and for the token its route goes on through,
// and every eth_call the helper asks, at the newest row's own block (base-rpc.publicnode.com; robinhood.drpc.org,
// which serves state that old).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { fakeChain, REC, URLS } from "../../../test/evm-swaps/robinhood.ts";
import { CG_ONCHAIN, coingeckoPace, createKeyed } from "../coingecko.ts";
import { geckoBudget } from "../gecko.ts";
import { providerHolds } from "../../limits/limits.ts";
import { GT_BASE } from "./lists.ts";
import {
  createSwaps,
  poolStateLegs,
  quoteCands,
  refStateUsd,
  TOPIC,
  usdThrough,
  v4StateSlot,
  VENUES,
} from "./swaps.ts";

const FILE = new URL("./fixtures/quote-token-usd.json", import.meta.url);
type Case = {
  rpc: string;
  coin: string;
  pool: string;
  quote: string;
  usd: string;
  weth: string;
  head: number;
  trades: {
    data: {
      id: string;
      attributes: Record<string, string>;
      legs: { from: [string, string]; to: [string, string] };
    }[];
  };
  quotePools: unknown;
  lists: Record<string, unknown>;
  receipts: Record<
    string,
    { blockNumber: string; logs: Record<string, unknown>[] }
  >;
  calls: Record<string, string | null>;
};
const FIX = JSON.parse(readFileSync(FILE, "utf8")) as Record<
  "base" | "robinhood",
  Case
>;
/** RECORD=1: an eth_call the fixture lacks is read from mainnet (the case's rpc) and kept, then written back. */
const RECORD = process.env.RECORD === "1";

const KEY = ["CG", "planted", "quote", "usd", "key"].join("-");
const PRICE_READ = /evm-vendor-price;desc="usd read (\d+) ms ago"/;
const THROUGH =
  /evm-quote-usd;desc="(\d+) rows priced from chain at their block"/;
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((ok) => setImmediate(ok));
};
const BALANCE_OF = "0x70a08231";
const EXTSLOAD = "0x1e2eaeaf";

/** `thin`: every quote-side read of a candidate pool answers under LIQ_MIN_USD (a balance of 999 of the USD token, no
 *  v4 liquidity), as a pool of a few dollars does. */
function harness(chain: "base" | "robinhood", o: { thin?: boolean } = {}) {
  const f = FIX[chain];
  const c = fakeChain();
  const head = REC.lastHead;
  c.st.head = head;
  if (chain === "base")
    for (const u of URLS) c.st.faults.set(u, { span: 1_000 });
  const [newest, ...rest] = f.trades.data;
  const real = parseInt(
    f.receipts[newest!.attributes.tx_hash!]!.blockNumber,
    16,
  );
  const clock = { t: Date.parse(newest!.attributes.block_timestamp!) + 60_000 };
  let refused = false;
  const keyedCalls: string[] = [];
  // the newest trade's logs, at the fake head: a read at it is read at the row's own block on mainnet (a pool's price,
  // the coin's decimals, its pool's key), any other block at the recorded head
  const pm = VENUES[chain].poolManager;
  const placedAt = head;
  const placed = f.receipts[newest!.attributes.tx_hash!]!.logs.map(
    (l): Record<string, unknown> => ({
      ...l,
      blockNumber: `0x${placedAt.toString(16)}`,
    }),
  );
  const liqSlots = new Set(
    quoteCands(f.quotePools, f.quote, [f.usd, f.weth])
      .filter((x) => x.length === 66)
      .map((id) => BigInt(v4StateSlot(id)) + 3n),
  );
  const blockOf = (n: number) => (n === placedAt ? real : f.head);
  const answerCall = async (
    to: string,
    data: string,
    n: number,
  ): Promise<string | null> => {
    const k = `${to.toLowerCase()} ${data.toLowerCase()} ${blockOf(n)}`;
    if (!(k in f.calls) && RECORD) {
      const r = (await (
        await globalThis.fetch(f.rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to, data }, `0x${blockOf(n).toString(16)}`],
          }),
        })
      ).json()) as { result?: string };
      f.calls[k] = typeof r.result === "string" ? r.result.toLowerCase() : null;
    }
    const got = f.calls[k] ?? null;
    if (
      got !== null &&
      o.thin &&
      data.startsWith(BALANCE_OF) &&
      to !== f.coin &&
      to !== f.quote
    )
      return `0x${999_000_000n.toString(16).padStart(64, "0")}`;
    // the liquidity word of a candidate v4 pool (its Slot0 slot + 3, quoteSideCalls) holds none
    if (
      got !== null &&
      o.thin &&
      to === pm &&
      data.startsWith(EXTSLOAD) &&
      liqSlots.has(BigInt(`0x${data.slice(10)}`))
    )
      return `0x${"0".repeat(64)}`;
    return got;
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith(CG_ONCHAIN)) {
      keyedCalls.push(url);
      // the key's share: its first answers of the coin, then spent
      if (refused || !url.includes(f.coin))
        return new Response("{}", {
          status: 429,
          headers: { "retry-after": "60" },
        });
    }
    if (url.startsWith(CG_ONCHAIN) || url.startsWith(GT_BASE)) {
      if (url.includes(`/tokens/${f.coin}/pools?page=1`))
        return refused
          ? new Response("{}", {
              status: 429,
              headers: { "retry-after": "60" },
            })
          : new Response(
              JSON.stringify({
                data: [
                  { id: `${chain}_${f.pool}`, attributes: { address: f.pool } },
                ],
              }),
              { status: 200 },
            );
      if (url.includes(`/pools/${f.pool}/trades?token=${f.coin}`))
        return refused
          ? new Response("{}", {
              status: 429,
              headers: { "retry-after": "60" },
            })
          : new Response(
              JSON.stringify({
                data: rest.map(({ legs, ...t }) => ({
                  ...t,
                  attributes: {
                    ...t.attributes,
                    from_token_address: legs.from[0],
                    from_token_amount: legs.from[1],
                    to_token_address: legs.to[0],
                    to_token_amount: legs.to[1],
                  },
                })),
              }),
              { status: 200 },
            );
      // the keyless list of the quote token's pools, and of the token a route goes on through (GeckoTerminal's own
      // budget, not the key's)
      if (
        url.startsWith(GT_BASE) &&
        url.includes(`/tokens/${f.quote}/pools?page=1`)
      )
        return new Response(JSON.stringify(f.quotePools), { status: 200 });
      const other = /\/tokens\/(0x[0-9a-f]{40})\/pools\?page=1$/.exec(url)?.[1];
      if (url.startsWith(GT_BASE) && other !== undefined && other !== f.coin) {
        if (!(other in f.lists) && RECORD)
          f.lists[other] = await (
            await globalThis.fetch(
              `https://api.geckoterminal.com/api/v2/networks/${chain}/tokens/${other}/pools?page=1`,
              { headers: { accept: "application/json" } },
            )
          ).json();
        if (other in f.lists)
          return new Response(JSON.stringify(f.lists[other]), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }
    const reqs = JSON.parse(String(init.body ?? "null")) as
      | { id: number; method: string; params: Record<string, unknown>[] }[]
      | null;
    if (!Array.isArray(reqs)) return c.fetch(url, init);
    const out = [];
    for (const r of reqs) {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
      if (r.method === "eth_getTransactionReceipt") {
        out.push(ok(f.receipts[r.params[0] as unknown as string] ?? null));
        continue;
      }
      if (r.method === "eth_call") {
        const call = r.params[0] as { to: string; data: string };
        const n = parseInt(r.params[1] as unknown as string, 16);
        const got = await answerCall(call.to, call.data, n);
        out.push(
          got === null
            ? {
                jsonrpc: "2.0",
                id: r.id,
                error: { code: 3, message: "execution reverted" },
              }
            : ok(got),
        );
        continue;
      }
      const q = r.params[0] as
        | {
            address?: string | string[];
            topics?: (string | string[] | null)[];
            fromBlock?: string;
            toBlock?: string;
          }
        | undefined;
      // our reads of the held pools (heldFilters): a pair's Transfers (an address list), a v4 pool's Swap logs by id
      const pairs =
        r.method === "eth_getLogs" &&
        Array.isArray(q?.address) &&
        q.topics?.[0] === TOPIC.transfer;
      const v4 =
        r.method === "eth_getLogs" &&
        q?.address === pm &&
        q.topics?.[0] === TOPIC.swap4 &&
        Array.isArray(q.topics[1]);
      if (pairs || v4) {
        const [lo, hi] = [
          parseInt(String(q!.fromBlock), 16),
          parseInt(String(q!.toBlock), 16),
        ];
        const at = (v: unknown, x: string) =>
          v == null || (Array.isArray(v) ? v.includes(x) : v === x);
        const addr = (a: string) =>
          Array.isArray(q!.address) ? q!.address.includes(a) : q!.address === a;
        out.push(
          ok(
            placed.filter(
              (l) =>
                placedAt >= lo &&
                placedAt <= hi &&
                addr(String(l.address)) &&
                (l.topics as string[]).every(
                  (x, i) =>
                    i >= (q!.topics ?? []).length || at(q!.topics![i], x),
                ),
            ),
          ),
        );
        continue;
      }
      const one = (await (
        await c.fetch(url, { ...init, body: JSON.stringify([r]) })
      ).json()) as unknown[];
      out.push(one[0]);
    }
    return new Response(JSON.stringify(out), { status: 200 });
  };
  const env = { COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: "300" };
  const holds = providerHolds(() => clock.t, coingeckoPace(env));
  const keyed = createKeyed(env, holds, { fetch: fetch as never })!;
  const gecko = geckoBudget(() => clock.t);
  const s = createSwaps(chain, {
    fetch,
    now: () => clock.t,
    listed: async () => true,
    rpcs: URLS,
    pools: new Map(),
    tickMs: 0,
    gecko,
    keyed,
    sleep: async (ms: number) => void (clock.t += ms),
  });
  after(() => s.stop());
  const tape = async () => {
    const a = await s.trades(f.coin, 50);
    return {
      ...a,
      j: JSON.parse(a.body) as { trades: { tx: string; usd: string }[] },
      price: PRICE_READ.exec(a.timing ?? "")?.[1],
      through: THROUGH.exec(a.timing ?? "")?.[1],
    };
  };
  return {
    clock,
    tape,
    newest: newest!,
    refuse: () => void (refused = true),
    keyedCalls,
  };
}

async function run(chain: "base" | "robinhood", o: { thin?: boolean } = {}) {
  const h = harness(chain, o);
  await h.tape();
  await settle();
  const cold = await h.tape();
  assert.equal(cold.status, 200, cold.body.slice(0, 200));
  h.refuse();
  let last = cold;
  for (let i = 0; i < 30; i++) {
    h.clock.t += 2_000;
    await settle();
    last = await h.tape();
    if (
      last.j.trades.some((t) => t.tx === h.newest.attributes.tx_hash) &&
      (last.through !== undefined || last.price !== undefined)
    )
      break;
  }
  return { h, last };
}

after(() => {
  if (RECORD) writeFileSync(FILE, `${JSON.stringify(FIX)}\n`);
});

test("base: the newest USEF trade (USEF/ZORA, Uniswap v4), renewed by our reads with the key's share spent, is priced through ZORA's own pool at its block, within 1% of the USD the vendor printed, and names no vendor price age (red at b0cb7010b: the vendor's last rate, evm-vendor-price named)", async () => {
  const { h, last } = await run("base");
  const row = last.j.trades.find((t) => t.tx === h.newest.attributes.tx_hash);
  assert.ok(
    row !== undefined,
    `the newest trade is served: ${JSON.stringify(last.j.trades.map((t) => t.tx.slice(0, 10)))} ${last.timing}`,
  );
  const want = Number(h.newest.attributes.volume_in_usd);
  assert.ok(
    Math.abs(Number(row.usd) - want) / want < 0.01,
    `usd ${row.usd} vs the vendor's ${want}`,
  );
  assert.equal(last.price, undefined, `no vendor price age: ${last.timing}`);
  assert.equal(
    last.through,
    "1",
    `the row priced from chain is named: ${last.timing}`,
  );
});

// fBOMB's vendor rows are not served yet (their receipts fail exactRow: card robinhood-solidly-vendor-rows-serve), so
// the answer shows the round's pricing by its timing, and the USD by the same reads recomputed: r33 holds under $1 of
// USDG in each USDG pool (its every one under LIQ_MIN_USD), so it goes through RAM (r33/RAM 1%, the CL factory's
// 0xb2f5a2ee) to WETH (RAM/WETH 1%, 0x5860dd46), ETH at the reference pool's price, all at the row's own block
test("robinhood: the newest fBOMB trade (r33/fBOMB, Ramses Legacy), renewed by our reads with the key's share spent, is priced through r33's route (r33/RAM then RAM/WETH) at its block and names no vendor price age; that route's recorded reads at the row's block give the vendor's USD within 2%, the spread of r33's own pools (red at b0cb7010b: the vendor's last rate, evm-vendor-price named)", async () => {
  const { last } = await run("robinhood");
  assert.equal(last.price, undefined, `no vendor price age: ${last.timing}`);
  assert.equal(
    last.through,
    "1",
    `the row priced from chain is named: ${last.timing}`,
  );
  const f = FIX.robinhood;
  const newest = f.trades.data[0]!.attributes;
  const block = parseInt(f.receipts[newest.tx_hash!]!.blockNumber, 16);
  const call = (to: string, data: string) =>
    f.calls[`${to} ${data} ${block}`] ?? undefined;
  const ram = "0x5173d45a1191ee33cbb7d8c7e65f21b04ed54802";
  const hop = poolStateLegs({ venue: "v3", tokenIs0: true }, [
    call("0xb2f5a2eef7cca3d0057f95352b2d0cf6e084bb96", "0x3850c7bd"),
  ]);
  const end = poolStateLegs({ venue: "v3", tokenIs0: false }, [
    call("0x5860dd468b4fc1740eaf80a3b7f22e78d70a076a", "0x3850c7bd"),
  ]);
  const ethUsd = refStateUsd(
    call(
      VENUES.robinhood.poolManager,
      `0x1e2eaeaf${v4StateSlot(VENUES.robinhood.refPoolId).slice(2)}`,
    ),
  );
  assert.ok(
    hop !== null && end !== null && ethUsd !== null,
    "the route's reads at the row's block are recorded",
  );
  // the row's r33 leg as its receipt shows it: the Transfer of r33 into or out of the pair
  const leg = f.receipts[newest.tx_hash!]!.logs.find(
    (l) =>
      l.address === f.quote &&
      (l.topics as string[]).some(
        (t) => t === `0x${f.pool.slice(2).padStart(64, "0")}`,
      ),
  );
  assert.ok(leg !== undefined, "the receipt moves r33 at the pair");
  const raw = BigInt(String(leg.data));
  const usd = usdThrough(
    { quote: { kind: "eth", decimals: 18 } },
    end,
    (raw * hop.quote) / hop.amt,
    ethUsd,
  );
  // within 2%, not 1%: r33's own pools disagree by more than that (GeckoTerminal 19 Nov 13:5xZ: r33 at $0.02595 in
  // r33/RAM on Ramses DLMM, $0.02480 in r33/fBOMB, $0.02341 in r33/RAM 1%), and the vendor prices it on its own
  // pick of them; our route's price of this row is $0.025274 an r33 to the vendor's $0.024803 (1.9%)
  const want = Number(newest.volume_in_usd);
  assert.ok(
    usd !== null && Math.abs(Number(usd) / 1e18 - want) / want < 0.02,
    `usd ${Number(usd) / 1e18} vs the vendor's ${want} (via ${ram})`,
  );
});

for (const chain of ["base", "robinhood"] as const)
  test(`${chain}: a quote token whose every pool against USD or WETH holds under LIQ_MIN_USD on its quote side never prices a row: the vendor's rate, its age named`, async () => {
    const { h, last } = await run(chain, { thin: true });
    // fBOMB's rows are not served yet (card robinhood-solidly-vendor-rows-serve): its answer's timing tells
    if (chain === "base")
      assert.ok(
        last.j.trades.some((t) => t.tx === h.newest.attributes.tx_hash),
        last.timing,
      );
    assert.equal(
      last.through,
      undefined,
      `no row priced through a thin pool: ${last.timing}`,
    );
    assert.ok(
      last.price !== undefined,
      `the vendor's rate, its age named: ${last.timing}`,
    );
  });

test("quoteCands: the pools a GeckoTerminal list names of the token against USD or WETH, in its order; a hostile entry names none", () => {
  const usdc = FIX.base.usd;
  const got = quoteCands(FIX.base.quotePools, FIX.base.quote, [
    usdc,
    FIX.base.weth,
  ]);
  assert.ok(
    got.length > 0 &&
      got.every((x) => /^0x[0-9a-f]{40}([0-9a-f]{24})?$/.test(x)),
    JSON.stringify(got),
  );
  assert.deepEqual(
    quoteCands(
      {
        data: [
          {
            attributes: { address: "0xzz" },
            relationships: {
              base_token: { data: { id: `base_${FIX.base.quote}` } },
              quote_token: { data: { id: `base_${usdc}` } },
            },
          },
          null,
          7,
          { attributes: { address: `0x${"ab".repeat(20)}` } },
        ],
      },
      FIX.base.quote,
      [usdc],
    ),
    [],
  );
  assert.deepEqual(quoteCands("nope", FIX.base.quote, [usdc]), []);
});
