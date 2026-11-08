// pool.address (card pool-deposit-address; src/pool-deposit-address.ts): U_X from the scope's public record only, and
// with an origin a 1Click quote to U_X, checked before its address goes out, and only when a follow takes it.
//   node --test test/pool-deposit-address.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDRESS, H72, NOW, COLLECTOR, mockKey, signAnswer, type Answer } from "./oneclick-mock.ts";

const { oneClickFloors } = await import("../../kit/src/checks/oneclick.ts");
const { depositId, depositIdEvm } = await import("../../wallet/src/derive/keys.ts");
const { base58 } = await import("@scure/base");
const { poolAddressHost } = await import("../src/pool-deposit-address.ts");
type Deps = Parameters<typeof poolAddressHost>[0];

const SEED64 = new Uint8Array(64); // the all-zero test seed: no user's
const SOL_S = 31n, BASE_S = 32n;
const ks = depositId(SEED64, SOL_S, 3), kb = depositId(SEED64, BASE_S, 4), ke = depositIdEvm(SEED64, BASE_S, 4);
const SOL_ID = ks.id, SOL_U = base58.encode(ks.publicKey), BASE_ID = kb.id, BASE_U = ke.address;
for (const k of [ks, kb, ke]) k.secretKey.fill(0);
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const STATUS = { source: "words", code_saved: true } as const;
const POOLS = [{ chain: "solana", scope: SOL_S }, { chain: "base", scope: BASE_S }] as const;
const RECORDS: Record<string, unknown> = {
  [SOL_S.toString()]: { v: 1, scope: SOL_S.toString(), index: 3, id: SOL_ID },
  [BASE_S.toString()]: { v: 1, scope: BASE_S.toString(), index: 4, id: BASE_ID, evm: BASE_U },
};
const PRICING = { in: ["1", "1"], out: ["150", "150.1"] } as const;

/** 1Click's signed answer to the request in `init`, at the device's floor plus a margin; `change` before the signature. */
function answerFor(req: Record<string, string | number | boolean>, decimalsOut: number, change?: (a: Answer) => void): Answer {
  const withdrawFee = 5_000n;
  const { minAmountOut } = oneClickFloors({ amountIn: BigInt(req.amount as string), withdrawFee, slippageBps: req.slippageTolerance as number, feeBps: 20,
    pricing: PRICING, decimalsIn: 6, decimalsOut, intoVault: false });
  const out = minAmountOut + 10n ** BigInt(decimalsOut - 4), min = out - 1n;
  const fmt = (v: bigint, d: number) => { const s = v.toString().padStart(d + 1, "0"); return `${s.slice(0, -d)}.${s.slice(-d)}`; };
  const a: Answer = {
    quote: {
      amountIn: req.amount, amountInFormatted: fmt(BigInt(req.amount as string), 6), amountInUsd: "25.0", minAmountIn: req.amount,
      amountOut: out.toString(), amountOutFormatted: fmt(out, decimalsOut), amountOutUsd: "24.9", minAmountOut: min.toString(),
      depositAddress: ADDRESS, deadline: new Date(Date.parse(req.deadline as string) + H72).toISOString(),
      timeWhenInactive: new Date(Date.parse(req.deadline as string) + H72).toISOString(), timeEstimate: 20, refundFee: "0", withdrawFee: withdrawFee.toString(),
    },
    quoteRequest: { ...req, depositMode: "SIMPLE", confidentiality: "public", quoteWaitingTimeMs: 0, insured: false, appFees: [{ recipient: COLLECTOR, fee: 20 }] },
    signature: "", timestamp: new Date(NOW - 500).toISOString(), correlationId: "00000000-0000-4000-8000-000000000000",
  };
  change?.(a);
  signAnswer(a, mockKey.privateKey);
  return a;
}

function world(o: { records?: Record<string, unknown>; status?: unknown; status_code?: number; throws?: boolean; change?: (a: Answer) => void; checked?: boolean; priced?: boolean; moveAfter?: boolean; network?: "mainnet" | "testnet" } = {}) {
  const sent: Record<string, string | number | boolean>[] = [];
  const took: unknown[] = [];
  let reads = 0;
  const records = { ...RECORDS, ...(o.records ?? {}) };
  const deps: Deps = {
    pools: () => POOLS,
    network: o.network ?? "mainnet",
    read: async (scope) => {
      reads++;
      const rec = records[scope.toString()];
      const moved = o.moveAfter && reads > 1 && rec ? { ...(rec as object), index: 99 } : rec;
      return { status: (o.status === undefined ? STATUS : o.status) as never, deposit: moved as never };
    },
    named: async () => {},
    now: () => NOW,
    ...(o.priced === false ? {} : { priced: () => ({ decimalsIn: 6, pricing: PRICING }) }),
    ...(o.checked === false ? {} : { checked: async (id, chain, quote, u) => void took.push({ id, chain, quote, u }) }),
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      if (o.throws) throw new TypeError("fetch failed");
      const req = JSON.parse(String(init?.body));
      sent.push(req);
      if (o.status_code !== undefined) return new Response("{}", { status: o.status_code, headers: { "content-type": "application/json" } });
      const a = answerFor(req, req.destinationAsset === "nep141:sol.omft.near" ? 9 : 18, o.change);
      return new Response(JSON.stringify(a), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  };
  return { deps, sent, took };
}
function ask(w: ReturnType<typeof world>, params: Record<string, unknown>, id: string | null = "op-1"): Promise<object | null> {
  const d = poolAddressHost(w.deps)(params, id === null ? undefined : { id });
  return d.after.then(() => d.answer() as object | null);
}

test("the same chain: U_X from the record alone, nothing sent: base58 of U_{s,i} on Solana, U^evm on Base", async () => {
  const w = world();
  assert.deepEqual(await ask(w, { chain: "solana" }), { result: { chain: "solana", address: SOL_U, asset: "SOL" } });
  assert.deepEqual(await ask(w, { chain: "base" }), { result: { chain: "base", address: BASE_U, asset: "ETH" } });
  assert.equal(w.sent.length, 0);
});

test("refused not_allowed, nothing sent: a chain not pinned, signed out, the backup not saved, another scope's record, an EVM record with no address", async () => {
  for (const [w, params, why] of [
    [world(), { chain: "robinhood" }, "not pinned"],
    [world({ status: null }), { chain: "solana" }, "signed out"],
    [world({ status: { source: "code", code_saved: false } }), { chain: "solana" }, "backup first"],
    [world({ records: { [SOL_S.toString()]: { v: 1, scope: "999", index: 3, id: SOL_ID } } }), { chain: "solana" }, "another scope"],
    [world({ records: { [BASE_S.toString()]: { v: 1, scope: BASE_S.toString(), index: 4, id: BASE_ID } } }), { chain: "base" }, "no EVM address"],
    [world({ records: { [SOL_S.toString()]: { v: 1, scope: SOL_S.toString(), index: 3, id: SOL_ID, evm: BASE_U } } }), { chain: "solana" }, "an EVM address on Solana"],
  ] as const) {
    assert.deepEqual(await ask(w, params), { error: "not_allowed" }, why);
    assert.equal(w.sent.length, 0, why);
  }
});

test("from another chain: a quote to U_X, its refund under U_{s,i}'s id, checked, handed to the follow, then answered", async () => {
  const w = world();
  const a = await ask(w, { chain: "solana", origin_asset: BASE_USDC, amount: "25" });
  assert.ok(a !== null && "result" in a, JSON.stringify(a));
  const r = (a as { result: { address: string; quote: { deposit_address: string; amount_in: string; min_amount_out: string } } }).result;
  assert.equal(r.address, SOL_U);
  assert.equal(r.quote.deposit_address, ADDRESS);
  assert.equal(r.quote.amount_in, "25");
  assert.match(r.quote.min_amount_out, /^0\.\d{1,9}$/);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0]!.recipient, SOL_U);
  assert.equal(w.sent[0]!.refundTo, SOL_ID);
  assert.equal(w.sent[0]!.refundType, "INTENTS");
  assert.deepEqual((w.took[0] as { u: unknown }).u, { scope: SOL_S, index: 3, wallet: SOL_U, refundId: SOL_ID });
  const b = world();
  await ask(b, { chain: "base", origin_asset: BASE_USDC, amount: "25" });
  assert.equal(b.sent[0]!.recipient, BASE_U);
  assert.equal(b.sent[0]!.refundTo, BASE_ID, "an EVM pool's refund is the ed25519 id, never the 0x");
});

test("an answer whose recipient or refund is not U_X: quote_check_failed, nothing handed to the follow", async () => {
  for (const change of [(a: Answer) => { a.quoteRequest.recipient = base58.encode(new Uint8Array(32).fill(9)); }, (a: Answer) => { a.quoteRequest.refundTo = "ab".repeat(32); }]) {
    const w = world({ change });
    assert.deepEqual(await ask(w, { chain: "solana", origin_asset: BASE_USDC, amount: "25" }), { error: "quote_check_failed" });
    assert.equal(w.took.length, 0);
  }
});

test("no follow, no price reads or no request id: no quote asked; the helper's codes and the cap; records moved in the wait", async () => {
  const q = { chain: "solana", origin_asset: BASE_USDC, amount: "25" };
  for (const w of [world({ checked: false }), world({ priced: false })]) {
    assert.deepEqual(await ask(w, q), { error: "not_allowed" });
    assert.equal(w.sent.length, 0);
  }
  const noId = world();
  assert.deepEqual(await ask(noId, q, null), { error: "not_allowed" });
  assert.equal(noId.sent.length, 0);
  assert.deepEqual(await ask(world({ status_code: 429 }), q), { error: "busy" });
  assert.deepEqual(await ask(world({ status_code: 503 }), q), { error: "down" });
  assert.deepEqual(await ask(world({ status_code: 400 }), q), { error: "not_available" });
  assert.deepEqual(await ask(world({ throws: true }), q), { error: "down" });
  const cap = world();
  assert.deepEqual(await ask(cap, { ...q, amount: "1000.000001" }), { error: "above_max" });
  assert.equal(cap.sent.length, 0);
  for (const amount of ["0", "1e3", "1.0000001"]) assert.deepEqual(await ask(world(), { ...q, amount }), { error: "not_allowed" }, amount);
  // another coin at its higher read: 250 NEAR at 4.01 is over the $1,000 cap, at 4 it is not
  const near = world();
  near.deps.priced = () => ({ decimalsIn: 24, pricing: { in: ["4", "4.01"], out: ["150", "150.1"] } });
  assert.deepEqual(await ask(near, { chain: "solana", origin_asset: "nep141:wrap.near", amount: "250" }), { error: "above_max" });
  assert.equal(near.sent.length, 0);
  near.deps.priced = () => ({ decimalsIn: 24, pricing: { in: ["4", "4"], out: ["150", "150.1"] } });
  await ask(near, { chain: "solana", origin_asset: "nep141:wrap.near", amount: "250" });
  assert.equal(near.sent.length, 1, "at exactly the cap a quote is asked");
  const moved = world({ moveAfter: true });
  assert.deepEqual(await ask(moved, q), { error: "not_allowed" });
  assert.equal(moved.took.length, 0);
});

test("review F2: the testnet build answers the same-chain U_X but never quotes: 1Click pays out on mainnet only", async () => {
  const w = world({ network: "testnet" });
  assert.deepEqual(await ask(w, { chain: "solana" }), { result: { chain: "solana", address: SOL_U, asset: "SOL" } });
  assert.deepEqual(await ask(w, { chain: "solana", origin_asset: BASE_USDC, amount: "25" }), { error: "not_allowed" });
  assert.deepEqual(await ask(w, { chain: "base", origin_asset: BASE_USDC, amount: "25" }), { error: "not_allowed" });
  assert.equal(w.sent.length, 0);
  assert.equal(w.took.length, 0);
});

test("review F3: 0.5 and 0.1 USDC into the Solana pool are refused before any address goes out (under 0.01 SOL)", async () => {
  for (const amount of ["0.5", "0.1"]) {
    const w = world();
    assert.deepEqual(await ask(w, { chain: "solana", origin_asset: BASE_USDC, amount }), { error: "not_allowed" }, amount);
    assert.equal(w.took.length, 0, amount);
  }
});

test("review F4: the cap's edge, unpriced reads, the decimals bound, USDC at other decimals, the time estimate", async () => {
  const q = { chain: "solana", origin_asset: BASE_USDC, amount: "25" };
  // A4: exactly 1000 USDC is asked; one base unit more is above_max (the other test)
  const edge = world();
  await ask(edge, { ...q, amount: "1000" });
  assert.equal(edge.sent.length, 1, "1000 USDC is at the cap, not over it");
  // A5: a price read that is not a price: no quote, nothing sent
  const unpriced = world();
  unpriced.deps.priced = () => ({ decimalsIn: 24, pricing: { in: ["x", "1"], out: ["150", "150.1"] } as never });
  assert.deepEqual(await ask(unpriced, { chain: "solana", origin_asset: "nep141:wrap.near", amount: "1" }), { error: "not_allowed" });
  assert.equal(unpriced.sent.length, 0);
  // A18: decimals past 36, or below 0: no quote, nothing sent
  for (const decimalsIn of [37, -1, 1.5]) {
    const w = world();
    w.deps.priced = () => ({ decimalsIn, pricing: PRICING });
    assert.deepEqual(await ask(w, { chain: "solana", origin_asset: "nep141:wrap.near", amount: "1" }), { error: "not_allowed" }, String(decimalsIn));
    assert.equal(w.sent.length, 0, String(decimalsIn));
  }
  // A14: a USDC origin read at decimals other than 6 is capped at its reads, never as USDC base units
  const odd = world();
  odd.deps.priced = () => ({ decimalsIn: 18, pricing: PRICING });
  assert.notDeepEqual(await ask(odd, { ...q, amount: "1" }), { error: "above_max" });
  assert.equal(odd.sent.length, 1, "1 at a $1 read is under the cap");
  // A20: a signed time estimate that is not a whole number of seconds, or below 0: quote_check_failed
  for (const t of [-1, 1.5]) {
    const w = world({ change: (a) => { (a.quote as Record<string, unknown>).timeEstimate = t; } });
    assert.deepEqual(await ask(w, q), { error: "quote_check_failed" }, String(t));
    assert.equal(w.took.length, 0, String(t));
  }
});
