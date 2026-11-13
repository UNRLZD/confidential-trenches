// Each pool takes its own coin (card deposit-takes-each-pools-own-coin; owner 13 Nov 08:12Z: the sheet offered USDC
// alone, so ETH could not go to Base or Robinhood): SOL into the Solana pool, ETH into the Base and Robinhood pools, as a
// plain send to U_X from any outside wallet, no 1Click quote and no swap.
// - deposit.assets lists SOL on Solana, ETH on Base and ETH on Robinhood after the USDC rows, each at the pool's floor
//   read now (src/rules/deposit-dry.ts); a floor that does not answer, or is slow, leaves its row out, never the list.
// - pool.address answers the pool's own coin with U_X as the deposit address and asks 1Click and the helper nothing
//   (src/pool-deposit-address.ts); under the floor below_min, over the cap above_max, nothing handed to the follow.
// - the follow carries what lands at U_X and asks 1Click nothing for it (src/pool-deposit-follow.ts).
//   node --test test/deposit-pool-coin.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OneClickRequest } from "../../kit/src/checks/oneclick.ts";
import { COLLECTOR, NEAR_USDC, NOW, SOL_USDC, mockKey, signAnswer, type Answer } from "./oneclick-mock.ts";
// after the mock, so the check loads the mock's keys
const { ONECLICK_USDC_ASSETS } = await import("../../kit/src/checks/oneclick.ts");
const { SIGNPAGE_RESULT_SCHEMAS } = await import("../../kit/src/signpage/schema.ts");
const { HELPER_BIND_DEPOSIT_CAP } = await import("../../kit/src/helper/v1.ts");
const { DEPOSIT_FLOOR_GRACE_MS, DEPOSIT_TOKENS_URL, depositAssetsKind } = await import("../src/rules/deposit-dry.ts");
const { POOL_FLOOR_PLACEHOLDER, poolAddressHost, poolQuotePricing } = await import("../src/pool-deposit-address.ts");
const { followPoolQuote } = await import("../src/pool-deposit-follow.ts");
const { POOL_DEPOSIT_DESTINATION } = await import("../../wallet/src/deposit/quote.ts");
const { SOL_LADDER } = await import("../../wallet/src/pool/solana.ts");
const { depositId, depositIdEvm } = await import("../../wallet/src/derive/keys.ts");
const { base58 } = await import("@scure/base");
const { sha256 } = await import("@noble/hashes/sha2.js");

const BASE_USDC = ONECLICK_USDC_ASSETS[2]!;
const SOL = POOL_DEPOSIT_DESTINATION.solana, BASE_ETH = POOL_DEPOSIT_DESTINATION.base, HOOD_ETH = POOL_DEPOSIT_DESTINATION.robinhood;
const TOKENS = [
  { assetId: NEAR_USDC, decimals: 6, blockchain: "near", symbol: "USDC", price: 0.9995 },
  { assetId: BASE_USDC, decimals: 6, blockchain: "base", symbol: "USDC", price: 0.9995 },
  { assetId: SOL_USDC, decimals: 6, blockchain: "sol", symbol: "USDC", price: 0.9995 },
];
const dec6 = (v: bigint): string => {
  const s = v.toString().padStart(7, "0");
  const f = s.slice(-6).replace(/0+$/, "");
  return f ? `${s.slice(0, -6)}.${f}` : s.slice(0, -6);
};
/** 1Click's honest dry answer (as test/deposit-dry.test.ts's): 1 bp between two USDC assets, 5 bp over it, W off. */
function dryAnswer(req: OneClickRequest): Answer {
  const a = BigInt(req.amount), w = 5_538n;
  const same = req.originAsset === req.destinationAsset;
  const out = a - w - (a * BigInt((same ? 0 : 1) + 5)) / 10_000n;
  const min = (out * 9_900n + 9_999n) / 10_000n;
  const ans: Answer = {
    quote: { amountIn: req.amount, amountInFormatted: dec6(a), amountInUsd: "0", minAmountIn: req.amount, amountOut: out.toString(),
      amountOutFormatted: dec6(out), amountOutUsd: "0", minAmountOut: min.toString(), timeEstimate: 20, refundFee: "0", withdrawFee: w.toString() },
    quoteRequest: { ...req, depositMode: "SIMPLE", confidentiality: "public", quoteWaitingTimeMs: 0, insured: false, appFees: same ? [] : [{ recipient: COLLECTOR, fee: 1 }] },
    signature: "",
    timestamp: new Date(NOW - 500).toISOString(),
  };
  signAnswer(ans, mockKey.privateKey);
  return ans;
}
/** The helper's 1Click proxy: the token list and dry quotes; every request kept. */
function helper(tokens: { status?: number } = {}) {
  const sent: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === DEPOSIT_TOKENS_URL) {
      sent.push("tokens");
      return new Response(JSON.stringify(TOKENS), { status: tokens.status ?? 200, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body)) as OneClickRequest;
    sent.push(body.originAsset);
    return new Response(JSON.stringify(dryAnswer(body)), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchFn, sent };
}
// each pool's floor as the page reads it now (src/main.ts pagePoolFloor): 0.013586400 SOL, 0.0012 ETH on Base, 0.00105 on Robinhood
const FLOORS = { solana: 13_586_400n, base: 1_200_000_000_000_000n, robinhood: 1_050_000_000_000_000n } as const;
const opts = { now: () => NOW, sleep: async () => {} };

// ----------------------------------------------------------------------------------------------- deposit.assets
test("deposit.assets: SOL on Solana, ETH on Base and ETH on Robinhood after the three USDC rows, each at its pool's floor read now", async () => {
  const h = helper();
  const asked: string[] = [];
  const got = await depositAssetsKind({ ...opts, fetch: h.fetch, poolFloor: async (chain) => (asked.push(chain), FLOORS[chain]) });
  assert.ok(got.ok, JSON.stringify(got));
  const rows = got.result.assets;
  assert.deepEqual(rows.map((r) => `${r.symbol} ${r.chain} ${r.origin_asset}`), [
    `USDC near ${NEAR_USDC}`, `USDC solana ${SOL_USDC}`, `USDC base ${BASE_USDC}`,
    `SOL solana ${SOL}`, `ETH base ${BASE_ETH}`, `ETH robinhood ${HOOD_ETH}`,
  ]);
  assert.deepEqual(rows.slice(3).map((r) => [r.decimals, r.min, r.max_usd]), [
    [9, "0.0135864", dec6(HELPER_BIND_DEPOSIT_CAP)], [18, "0.0012", dec6(HELPER_BIND_DEPOSIT_CAP)], [18, "0.00105", dec6(HELPER_BIND_DEPOSIT_CAP)],
  ]);
  assert.deepEqual(asked.sort(), ["base", "robinhood", "solana"]);
  // 1Click is asked nothing for a pool's own coin: the token list and one probe per USDC row only
  assert.deepEqual(h.sent.filter((s) => s !== "tokens").sort(), [...ONECLICK_USDC_ASSETS].sort());
  assert.equal(SIGNPAGE_RESULT_SCHEMAS["deposit.assets"](got.result), true, "the kit's client takes it");
});

test("deposit.assets: a pool whose floor throws, answers null or is not back DEPOSIT_FLOOR_GRACE_MS after the probes is left out; the USDC rows stand", async () => {
  const h = helper();
  const t0 = Date.now();
  const got = await depositAssetsKind({ ...opts, fetch: h.fetch, poolFloor: async (chain) => {
    if (chain === "solana") throw new TypeError("fetch failed");
    if (chain === "base") return null;
    return new Promise<bigint>(() => {}); // never answers
  } });
  assert.ok(got.ok, JSON.stringify(got));
  assert.deepEqual(got.result.assets.map((r) => r.symbol), ["USDC", "USDC", "USDC"]);
  assert.ok(Date.now() - t0 < DEPOSIT_FLOOR_GRACE_MS + 1_000, "the slow floor held the list no longer than its grace");
});

test("deposit.assets with no pool floor given (the read before this card): the USDC rows alone, exactly", async () => {
  const got = await depositAssetsKind({ ...opts, fetch: helper().fetch });
  assert.ok(got.ok);
  assert.deepEqual(got.result.assets.map((r) => `${r.symbol} ${r.chain}`), ["USDC near", "USDC solana", "USDC base"]);
});

test("deposit.assets: 1Click busy still answers busy for the whole list, as before (the USDC rows' retry)", async () => {
  const got = await depositAssetsKind({ ...opts, fetch: helper({ status: 429 }).fetch, poolFloor: async (chain) => FLOORS[chain] });
  assert.deepEqual(got, { ok: false, code: "busy" });
});

// ------------------------------------------------------------------------------------------------- pricing
test("poolQuotePricing: the pool's own coin on its own chain at the pool's price, in and out; on another chain, or no chain, none", () => {
  const p = { price: "15012345678", expo: -8 } as never;
  assert.deepEqual(poolQuotePricing(p, SOL, "solana"), { decimalsIn: 9, pricing: { in: ["150.12345678", "150.12345678"], out: ["150.12345678", "150.12345678"] } });
  assert.deepEqual(poolQuotePricing(p, BASE_ETH, "base"), { decimalsIn: 18, pricing: { in: ["150.12345678", "150.12345678"], out: ["150.12345678", "150.12345678"] } });
  assert.deepEqual(poolQuotePricing(p, HOOD_ETH, "robinhood")?.decimalsIn, 18);
  assert.equal(poolQuotePricing(p, SOL, "base"), null);
  assert.equal(poolQuotePricing(p, BASE_ETH, "robinhood"), null);
  assert.equal(poolQuotePricing(p, SOL), null);
  assert.equal(poolQuotePricing(null, SOL, "solana"), null);
  // USDC exactly as before
  assert.deepEqual(poolQuotePricing(p, BASE_USDC, "solana"), poolQuotePricing(p, BASE_USDC));
  assert.deepEqual(poolQuotePricing(p, BASE_USDC), { decimalsIn: 6, pricing: { in: ["1", "1"], out: ["150.12345678", "150.12345678"] } });
});

test("POOL_FLOOR_PLACEHOLDER is the base58 of sha256(\"blindfill:pool-floor:placeholder\"): a key nobody holds", () => {
  assert.equal(POOL_FLOOR_PLACEHOLDER, base58.encode(sha256(new TextEncoder().encode("blindfill:pool-floor:placeholder"))));
});

// -------------------------------------------------------------------------------------------- pool.address
const SEED64 = new Uint8Array(64); // the all-zero test seed: no user's
const SOL_S = 31n, BASE_S = 32n, HOOD_S = 33n;
const ks = depositId(SEED64, SOL_S, 3), kb = depositId(SEED64, BASE_S, 4), ke = depositIdEvm(SEED64, BASE_S, 4), kh = depositId(SEED64, HOOD_S, 5), khe = depositIdEvm(SEED64, HOOD_S, 5);
const SOL_U = base58.encode(ks.publicKey), BASE_U = ke.address, HOOD_U = khe.address;
const RECORDS: Record<string, unknown> = {
  [SOL_S.toString()]: { v: 1, scope: SOL_S.toString(), index: 3, id: ks.id },
  [BASE_S.toString()]: { v: 1, scope: BASE_S.toString(), index: 4, id: kb.id, evm: BASE_U },
  [HOOD_S.toString()]: { v: 1, scope: HOOD_S.toString(), index: 5, id: kh.id, evm: HOOD_U },
};
for (const k of [ks, kb, ke, kh, khe]) k.secretKey.fill(0);
const PRICE = { price: "300000000000", expo: -8 } as never; // 3,000 USD

function page(o: { network?: "mainnet" | "testnet"; moveAfter?: boolean } = {}) {
  const fetched: string[] = [];
  const took: { id: string; chain: string; quote: Record<string, unknown>; u: Record<string, unknown> }[] = [];
  const floorsAsked: { chain: string; wallet: string }[] = [];
  let reads = 0;
  const deps: Parameters<typeof poolAddressHost>[0] = {
    pools: () => [{ chain: "solana", scope: SOL_S }, { chain: "base", scope: BASE_S }, { chain: "robinhood", scope: HOOD_S }],
    network: o.network ?? "mainnet",
    read: async (scope) => {
      reads++;
      const rec = RECORDS[scope.toString()];
      return { status: { source: "words", code_saved: true } as never, deposit: (o.moveAfter && reads > 1 ? { ...(rec as object), index: 99 } : rec) as never };
    },
    named: async () => {},
    now: () => NOW,
    // as src/main.ts pricedFor: the page's own price read of X's coin
    priced: (chain, origin) => poolQuotePricing(PRICE, origin, chain),
    floor: async (chain, wallet) => (floorsAsked.push({ chain, wallet }), FLOORS[chain]),
    checked: async (id, chain, quote, u) => void took.push({ id, chain, quote: quote as never, u: u as never }),
    fetch: (async (url: string | URL | Request) => {
      fetched.push(String(url));
      throw new Error("a plain send asks nothing");
    }) as typeof fetch,
  };
  const ask = (params: Record<string, unknown>, id = "op-1") => {
    const d = poolAddressHost(deps)(params, { id });
    return d.after.then(() => d.answer() as { result?: Record<string, unknown>; error?: string });
  };
  return { ask, fetched, took, floorsAsked };
}

for (const [chain, origin, u, amount, units, asset] of [
  ["solana", SOL, SOL_U, "0.0135864", 13_586_400n, "SOL"],
  ["base", BASE_ETH, BASE_U, "0.0012", 1_200_000_000_000_000n, "ETH"],
  ["robinhood", HOOD_ETH, HOOD_U, "0.25", 250_000_000_000_000_000n, "ETH"],
] as const) {
  test(`pool.address on ${chain} with ${asset} on ${chain}: a plain send to U_X, 1Click and the helper asked nothing, the follow handed U_X itself`, async () => {
    const p = page();
    const a = await p.ask({ chain, origin_asset: origin, amount });
    assert.ok(a.result, JSON.stringify(a));
    const q = a.result.quote as Record<string, unknown>;
    assert.deepEqual({ ...a.result, quote: undefined }, { chain, address: u, asset, quote: undefined });
    assert.deepEqual(q, { deposit_address: u, origin_asset: origin, amount_in: amount, min_amount_out: amount, deadline: new Date(NOW + 30 * 60_000).toISOString(), time_estimate_s: chain === "solana" ? 30 : 20 });
    assert.equal(SIGNPAGE_RESULT_SCHEMAS["pool.address"](a.result), true, "the kit's client takes it");
    assert.deepEqual(p.fetched, []);
    assert.deepEqual(p.floorsAsked, [{ chain, wallet: u }]);
    assert.equal(p.took.length, 1);
    assert.equal(p.took[0]!.quote.deposit_address, u);
    assert.equal(p.took[0]!.u.wallet, u);
    assert.ok(units >= FLOORS[chain]);
  });
}

test("pool.address plain send: one base unit under the floor is below_min, nothing handed to the follow, nothing asked", async () => {
  const p = page();
  assert.deepEqual(await p.ask({ chain: "solana", origin_asset: SOL, amount: "0.013586399" }), { error: "below_min" });
  assert.deepEqual(await p.ask({ chain: "base", origin_asset: BASE_ETH, amount: "0.001199999999999999" }), { error: "below_min" });
  assert.deepEqual(p.took, []);
  assert.deepEqual(p.fetched, []);
});

test("pool.address plain send: over the beta cap at the device's own price is above_max, before the floor is read", async () => {
  const p = page();
  // the cap at 3,000 USD an ETH: one wei over cap / 3,000 ETH
  const over = (HELPER_BIND_DEPOSIT_CAP * 10n ** 12n) / 3_000n + 1n;
  const s = over.toString().padStart(19, "0");
  const amount = `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, "");
  assert.deepEqual(await p.ask({ chain: "base", origin_asset: BASE_ETH, amount }), { error: "above_max" });
  assert.deepEqual(p.floorsAsked, []);
  assert.deepEqual(p.took, []);
});

test("pool.address plain send: another pool's coin, or a record that moved before the answer, gives no address", async () => {
  const p = page();
  assert.deepEqual(await p.ask({ chain: "base", origin_asset: SOL, amount: "1" }), { error: "not_allowed" });
  assert.deepEqual(await p.ask({ chain: "robinhood", origin_asset: BASE_ETH, amount: "1" }), { error: "not_allowed" });
  const moved = page({ moveAfter: true });
  assert.deepEqual(await moved.ask({ chain: "solana", origin_asset: SOL, amount: "0.1" }), { error: "not_allowed" });
  assert.deepEqual(moved.took, []);
});

// ---------------------------------------------------------------------------------------------- the follow
const PER = 2_936_160n, KEEP = 650_240n, FLOOR = SOL_LADDER.min + PER + KEEP;
const PLAIN = { chain: "solana" as const, s: "777", i: 3, u: "U_X", refund_id: "ab".repeat(32), address: "U_X", deadline_ms: 1, origin: SOL, min_out: FLOOR.toString() };
type Deps = Parameters<typeof followPoolQuote>[1];
function follow(rounds: { bal: readonly [bigint, bigint]; past?: boolean; open?: boolean; noted?: boolean }[]) {
  const stages: string[] = [], deposits: bigint[] = [], sleeps: number[] = [];
  let statusAsks = 0, k = 0;
  const ac = new AbortController();
  const now = () => rounds[Math.min(k, rounds.length - 1)]!;
  const deps: Deps = {
    status: async () => (statusAsks++, { status: "SUCCESS" as never, delivered: null }),
    balances: async () => now().bal,
    costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }),
    ladder: SOL_LADDER,
    deposit: async (_f, amount) => (deposits.push(amount), { end: "filled", txs: [] }),
    open: async () => now().open === true,
    noted: async () => now().noted === true,
    past: async () => now().past === true,
    stage: async (s) => void stages.push(s),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (++k >= rounds.length + 3) ac.abort();
    },
    signal: ac.signal,
  };
  return { deps, stages, deposits, sleeps, statusAsks: () => statusAsks };
}

test("the follow of a plain send asks 1Click nothing: nothing seen, then the send under the floor (short), then topped up (in_transit), carried, in_pool", async () => {
  const w = follow([
    { bal: [0n, 0n] },
    { bal: [0n, 0n] },
    { bal: [FLOOR - 1n, FLOOR - 1n] },
    { bal: [FLOOR, FLOOR] },
    { bal: [0n, 0n], past: true },
  ]);
  assert.equal(await followPoolQuote(PLAIN, w.deps), "in_pool");
  assert.equal(w.statusAsks(), 0);
  assert.deepEqual(w.deposits, [SOL_LADDER.min]);
  assert.deepEqual(w.stages, ["short", "in_transit", "in_pool"]);
  // waiting for its money it reads U_X every 15 s, never backing off to a minute
  assert.deepEqual(w.sleeps.slice(0, 2), [15_000, 15_000]);
});

test("the follow of a plain send: nothing sent by its deadline shows expired and reads on; a late send is carried", async () => {
  const w = follow([{ bal: [0n, 0n], past: true }, { bal: [FLOOR, FLOOR], past: true }, { bal: [0n, 0n], past: true }]);
  assert.equal(await followPoolQuote(PLAIN, w.deps), "in_pool");
  assert.deepEqual(w.stages, ["expired", "in_transit", "in_pool"]);
  assert.equal(w.statusAsks(), 0);
});

test("the follow of a plain send: money on one RPC only moves nothing; what is left at U_X while its rung still lands is not short", async () => {
  const w = follow([
    { bal: [FLOOR, 0n] },
    { bal: [FLOOR, FLOOR], open: true },
    { bal: [5n, 5n], open: true },
    // its note landed (the store's own pass): what is left below the least rung stays for U_X's next move, never short
    { bal: [5n, 5n], noted: true },
    { bal: [5n, 5n], noted: true, past: true },
  ]);
  assert.equal(await followPoolQuote(PLAIN, w.deps), "in_pool");
  assert.deepEqual(w.stages, ["in_transit", "in_pool"]);
  assert.equal(w.statusAsks(), 0);
});

test("a 1Click quote's follow is as before: its status read each round, no in_transit before its status says so", async () => {
  const w = follow([{ bal: [FLOOR, FLOOR] }, { bal: [0n, 0n], past: true }]);
  assert.equal(await followPoolQuote({ ...PLAIN, address: "DEPOSIT", origin: BASE_USDC }, w.deps), "in_pool");
  assert.deepEqual(w.stages, ["in_pool"]);
});
