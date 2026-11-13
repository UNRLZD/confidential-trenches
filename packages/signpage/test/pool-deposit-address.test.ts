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

function world(o: { records?: Record<string, unknown>; status?: unknown; status_code?: number; throws?: boolean; change?: (a: Answer) => void; checked?: boolean; priced?: boolean; moveAfter?: boolean; network?: "mainnet" | "testnet"; floor?: bigint | null | "throws" | "none"; noLiquidity?: number } = {}) {
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
    // the device's quote-time floor read (card pool-deposit-follow): the rung unless a test names it
    ...(o.floor === "none" ? {} : { floor: async (chain: string) => { if (o.floor === "throws") throw new TypeError("fetch failed"); return o.floor !== undefined ? (o.floor as bigint | null) : chain === "solana" ? 10_000_000n : 1_000_000_000_000_000n; } }),
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      if (o.throws) throw new TypeError("fetch failed");
      const req = JSON.parse(String(init?.body));
      sent.push(req);
      // card deposit-quote-no-liquidity: 1Click's 400 for a size no solver quoted at that second, the first noLiquidity asks
      if (sent.length <= (o.noLiquidity ?? 0)) return new Response(JSON.stringify({ message: "No liquidity available" }), { status: 400, headers: { "content-type": "application/json" } });
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
  // the request asks the user's own amount, exactly (evm-deposit-route-mainnet round 3: EXACT_INPUT of the whole amount)
  assert.equal(w.sent[0]!.swapType, "EXACT_INPUT");
  assert.equal(w.sent[0]!.amount, "25000000");
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

test("pool-deposit-follow floor: the quote is held to the device's own floor read; none, null or a failed read gives no address", async () => {
  const q = { chain: "solana", origin_asset: BASE_USDC, amount: "25" };
  // 25 USDC at 150 USD/SOL is about 0.166 SOL of min out: a floor over it refuses, one under it passes
  const high = world({ floor: 200_000_000n });
  assert.deepEqual(await ask(high, q), { error: "not_allowed" });
  assert.equal(high.took.length, 0);
  const ok = world({ floor: 13_586_400n });
  assert.ok("result" in ((await ask(ok, q)) as object));
  assert.equal(ok.took.length, 1);
  for (const [floor, code] of [["none", "not_allowed"], [null, "not_allowed"], ["throws", "down"]] as const) {
    const w = world({ floor });
    assert.deepEqual(await ask(w, q), { error: code }, String(floor));
    assert.equal(w.sent.length, 0, String(floor));
    assert.equal(w.took.length, 0, String(floor));
  }
});

test("pool-deposit-follow floor: readSolanaPoolFloor reads the rent on both RPCs and takes the higher deposit fee", async () => {
  const { readSolanaPoolFloor } = await import("../src/pool-deposit-address.ts");
  const { SOL_MAINNET_DEPLOY } = await import("../../wallet/src/pool/solana.ts");
  const program = SOL_MAINNET_DEPLOY?.program ?? base58.encode(new Uint8Array(32).fill(7));
  // the Rent sysvar's 17 bytes: 5,080 lamports a byte, factor 1.0, burn 50
  const rentData = new Uint8Array(17);
  new DataView(rentData.buffer).setBigUint64(0, 5_080n, true);
  new DataView(rentData.buffer).setFloat64(8, 1, true);
  rentData[16] = 50;
  const rpcOf = (url: string, fee: number | null, lpb = 5_080n) => {
    const data = rentData.slice();
    new DataView(data.buffer).setBigUint64(0, lpb, true);
    const f = (async (method: string) => {
      if (method === "getAccountInfo") return { context: { slot: 1 }, value: { owner: "Sysvar1111111111111111111111111111111111111", data: [Buffer.from(data).toString("base64"), "base64"], lamports: 1 } };
      if (method === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: base58.encode(new Uint8Array(32).fill(3)), lastValidBlockHeight: 10 } };
      if (method === "getFeeForMessage") return { context: { slot: 1 }, value: fee };
      throw new Error(method);
    }) as unknown as import("../../kit/src/trade/solana/send.ts").SolanaRpc;
    Object.defineProperty(f, "url", { value: url });
    return f;
  };
  assert.equal(await readSolanaPoolFloor([rpcOf("https://a.example", 5_000), rpcOf("https://b.example", 10_000)], program, SOL_U), 13_591_400n);
  // a blockhash one RPC does not know (fee null), rents that differ, or one provider twice: no floor
  await assert.rejects(readSolanaPoolFloor([rpcOf("https://a.example", 5_000), rpcOf("https://b.example", null)], program, SOL_U));
  await assert.rejects(readSolanaPoolFloor([rpcOf("https://a.example", 5_000), rpcOf("https://b.example", 5_000, 6_000n)], program, SOL_U));
  await assert.rejects(readSolanaPoolFloor([rpcOf("https://a.example", 5_000), rpcOf("https://a.example", 5_000)], program, SOL_U));
  // card helper-says-why-a-vendor-refused, delta review P3-5: the page's stop pulled before or during a read, no read
  // starts after it, the fee read (its message names U_X) included
  for (const [at, left] of [["before", []], ["getAccountInfo", ["getAccountInfo", "getAccountInfo"]], ["getLatestBlockhash", ["getAccountInfo", "getAccountInfo", "getLatestBlockhash"]]] as const) {
    const stop = new AbortController();
    if (at === "before") stop.abort();
    const asked: string[] = [];
    const watched = (url: string) => {
      const r = rpcOf(url, 5_000);
      const f = (async (method: string, params: readonly unknown[]) => (asked.push(method), method === at && stop.abort(), r(method, params))) as unknown as import("../../kit/src/trade/solana/send.ts").SolanaRpc;
      Object.defineProperty(f, "url", { value: url });
      return f;
    };
    await assert.rejects(readSolanaPoolFloor([watched("https://a.example"), watched("https://b.example")], program, SOL_U, stop.signal), { name: "AbortError" }, at);
    assert.deepEqual(asked, left, at);
  }
});

// card evm-deposit-route-mainnet: the floor of a quote into an EVM pool's U_X, read now on the pool's two RPCs (names no
// account): the base fee and the two tree depths both read alike, the L1 fee bound on Base (0 on Robinhood), at the tip
// U offers; evmPoolDepositFloor of those, the price the deposit run's own bound is (pool-deposit-evm.ts tryNote)
test("evm-deposit-route-mainnet: readEvmPoolFloor reads the base fee, the depths and Base's L1 fee on both RPCs; reads apart or a failed one give no floor", async () => {
  const { readEvmPoolFloor } = await import("../src/pool-deposit-address.ts");
  const { evmPoolDepositFloor } = await import("../src/pool-deposit-quote.ts");
  const { EVM_DEPOSIT_PRIORITY_CAP } = await import("../src/pool-deposit-evm.ts");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const sel = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);
  const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  type W = { baseFee: bigint; state: bigint; label: bigint; l1: bigint; down?: string };
  const asked: string[] = [];
  const rpcOf = (w: W) => (async (method: string, params: readonly unknown[]) => {
    asked.push(JSON.stringify([method, params]));
    if (w.down === method) throw new Error(`${method} down`);
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: `0x${"11".repeat(32)}`, timestamp: "0x1", baseFeePerGas: "0x" + w.baseFee.toString(16) };
    if (method === "eth_call") {
      const data = (params[0] as { data: string }).data;
      if (data === sel("currentTreeDepth()")) return word(w.state);
      if (data === sel("currentLabelTreeDepth()")) return word(w.label);
      if (data.startsWith("0xf1c7a58b")) return word(w.l1); // getL1FeeUpperBound
      return word(0n); // the operator fee
    }
    throw new Error(`unmocked ${method}`);
  }) as unknown as import("../../wallet/src/pool/evm.ts").EvmRpc;
  const W0: W = { baseFee: 5_000_000n, state: 3n, label: 2n, l1: 7_000_000_000n };
  const pin = (network: "base" | "robinhood") => ({ network, pool: "0x00000000000000000000000000000000000f0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n }) as const;
  assert.equal(await readEvmPoolFloor([rpcOf(W0), rpcOf(W0)], pin("base")), evmPoolDepositFloor({ baseFee: 5_000_000n, tip: EVM_DEPOSIT_PRIORITY_CAP, l1Fee: 7_000_000_000n, stateDepth: 3n, labelDepth: 2n }));
  assert.equal(await readEvmPoolFloor([rpcOf(W0), rpcOf(W0)], pin("robinhood")), evmPoolDepositFloor({ baseFee: 5_000_000n, tip: EVM_DEPOSIT_PRIORITY_CAP, l1Fee: 0n, stateDepth: 3n, labelDepth: 2n }), "Robinhood: no L1 fee");
  assert.ok(asked.every((a) => !a.toLowerCase().includes(BASE_U.slice(2).toLowerCase()) && !/"from"/.test(a)), "no read names U_X or any sender");
  for (const [what, b] of [["the base fee", { ...W0, baseFee: 5_000_001n }], ["the state depth", { ...W0, state: 4n }], ["the L1 fee", { ...W0, l1: 7_000_000_001n }], ["a read that fails", { ...W0, down: "eth_call" }]] as const)
    await assert.rejects(readEvmPoolFloor([rpcOf(W0), rpcOf(b)], pin("base")), what);
});

// Card deposit-quote-no-liquidity: a pool's quote asks again on 1Click's no-liquidity answer, as the vault's does (one
// shared ask, wallet/src/deposit/quote.ts askDepositQuote); the quote that follows is checked as one quote is.
test("no liquidity twice, then a quote: the same request three times, checked, handed to the follow, then answered", async () => {
  for (const chain of ["solana", "base"] as const) {
    const w = world({ noLiquidity: 2 });
    const a = await ask(w, { chain, origin_asset: BASE_USDC, amount: "25" });
    assert.ok(a !== null && "result" in a, `${chain}: ${JSON.stringify(a)}`);
    assert.equal((a as { result: { quote: { deposit_address: string } } }).result.quote.deposit_address, ADDRESS);
    assert.equal(w.sent.length, 3, chain);
    assert.deepEqual(w.sent[2], w.sent[0], chain);
    assert.equal(w.took.length, 1, chain);
  }
  const bad = world({ noLiquidity: 1, change: (x: Answer) => { x.quoteRequest.refundTo = "ab".repeat(32); } });
  assert.deepEqual(await ask(bad, { chain: "solana", origin_asset: BASE_USDC, amount: "25" }), { error: "quote_check_failed" });
  assert.equal(bad.took.length, 0);
  // review d: a 1Click-signed quote for another amount after the no-liquidity answer: refused on the request echo
  // whole for 24 USDC (its echo, amountIn and minAmountIn), so only the echo against 25 refuses it
  const other = world({ noLiquidity: 1, change: (x: Answer) => { x.quoteRequest.amount = x.quote.amountIn = x.quote.minAmountIn = "24000000"; x.quote.amountInFormatted = "24.000000"; } });
  assert.deepEqual(await ask(other, { chain: "solana", origin_asset: BASE_USDC, amount: "25" }), { error: "quote_check_failed" });
  assert.equal(other.sent.length, 2);
  assert.equal(other.took.length, 0);
  const never = world({ noLiquidity: 99 });
  assert.deepEqual(await ask(never, { chain: "solana", origin_asset: BASE_USDC, amount: "25" }), { error: "not_available" });
  assert.equal(never.sent.length, 3);
  assert.equal(never.took.length, 0);
});

test("card pool-usd-price-never-stale: a quote into the Solana pool is priced by the page's own price within the kit's one bound: asked at 74 s, none at 76 s", async () => {
  const { poolPrices } = await import("../src/pool-price.ts");
  const { poolQuotePricing } = await import("../src/pool-deposit-address.ts");
  const { POOL_USD_FEEDS } = await import("../../kit/src/price/pool-usd.ts");
  assert.equal(POOL_USD_FEEDS.solana.maxAgeS, 75);
  const pubS = 1_793_778_006;
  const clock = { ms: pubS * 1000 + 2_000 };
  const prices = poolPrices({
    rpcs: (c) => (c === "solana" ? ([Object.assign(async () => null, { url: "https://a.example" }), Object.assign(async () => null, { url: "https://b.example" })] as never) : null),
    now: () => clock.ms,
    read: async () => ({ chain: "solana", asset: "SOL", decimals: 9, price: 9_301_048_308n, expo: -8, publishedS: pubS, source: "pyth", at: 1n }),
    after: () => {},
  });
  prices.refresh(["solana"]);
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  const q = { chain: "solana", origin_asset: BASE_USDC, amount: "25" };
  const at = (s: number) => {
    clock.ms = (pubS + s) * 1000;
    const w = world();
    w.deps.priced = (_chain, origin) => poolQuotePricing(prices.get("solana"), origin);
    return w;
  };
  assert.deepEqual(poolQuotePricing(prices.get("solana"), BASE_USDC), { decimalsIn: 6, pricing: { in: ["1", "1"], out: ["93.01048308", "93.01048308"] } });
  assert.equal(poolQuotePricing(prices.get("solana"), "nep141:wrap.near"), null, "only USDC in");
  const young = at(74);
  await ask(young, q);
  assert.equal(young.sent.length, 1, "74 s: a quote is asked");
  const old = at(76);
  assert.deepEqual(await ask(old, q), { error: "not_allowed" });
  assert.equal(old.sent.length, 0, "76 s: no quote");
});

// review of eb2dfdc5, D1: the price as a decimal keeps its leading zero under 1 USD and every digit; none for SOL or ETH
// today, but the pricing is the 1Click check's input
test("card pool-usd-price-never-stale, review D1: poolQuotePricing writes the price's decimal whole: under 1 USD with its leading zero, at whole units, and at expo 0", async () => {
  const { poolQuotePricing } = await import("../src/pool-deposit-address.ts");
  const at = (price: string, expo: number) => poolQuotePricing({ price, expo, published_s: 1, read_ms: 1000, rpcs: ["https://a.example", "https://b.example"] } as never, BASE_USDC)?.pricing.out[0];
  assert.equal(at("5", -8), "0.00000005");
  assert.equal(at("99999999", -8), "0.99999999");
  assert.equal(at("100000000", -8), "1.00000000");
  assert.equal(at("9301048308", -8), "93.01048308");
  assert.equal(at("150", 0), "150");
});

// review of eb2dfdc5, P1 (the review's probe, flipped): the price was taken once, before the floor read and the quote,
// and used after them with no second look at its bound
test("card pool-usd-price-never-stale, review P1: the quote is checked at the price as it is at the check: a price 74 s old at the ask and past its bound by the answer refuses the quote (not_allowed, nothing to the follow); a newer price then is the one checked", async () => {
  const { poolPrices } = await import("../src/pool-price.ts");
  const { poolQuotePricing } = await import("../src/pool-deposit-address.ts");
  const { POOL_USD_FEEDS } = await import("../../kit/src/price/pool-usd.ts");
  const max = POOL_USD_FEEDS.solana.maxAgeS;
  const pubS = 1_793_778_006;
  const run = async (newer: boolean) => {
    const clock = { ms: pubS * 1000 + 2_000 };
    let pub = pubS;
    let price = 9_301_048_308n;
    const prices = poolPrices({
      rpcs: (c) => (c === "solana" ? ([Object.assign(async () => null, { url: "https://a.example" }), Object.assign(async () => null, { url: "https://b.example" })] as never) : null),
      now: () => clock.ms,
      read: async () => ({ chain: "solana", asset: "SOL", decimals: 9, price, expo: -8, publishedS: pub, source: "pyth", at: 1n }),
      after: () => {},
      visible: () => true,
    });
    prices.refresh(["solana"]);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    clock.ms = (pubS + max - 1) * 1000; // 74 s old: inside the bound as the quote is asked
    const stale = poolQuotePricing(prices.get("solana"), BASE_USDC)!;
    assert.ok(stale);
    const ages: number[] = [];
    const took: unknown[] = [];
    const deps: Deps = {
      pools: () => [{ chain: "solana", scope: SOL_S }],
      network: "mainnet",
      read: async () => ({ status: STATUS, deposit: RECORDS[SOL_S.toString()] }) as never,
      named: async () => {},
      now: () => clock.ms,
      priced: (_c, origin) => (ages.push(clock.ms / 1000 - pubS), poolQuotePricing(prices.get("solana"), origin)),
      checked: async (id, chain, quote, u) => void took.push({ id, chain, quote, u }),
      // the floor read: 4 s
      floor: async () => ((clock.ms += 4_000), 10_000_000n),
      // the quote: 9 s, its answer exactly on the floor the 74-s-old price gives
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const req = JSON.parse(String(init?.body));
        clock.ms += 9_000;
        if (newer) {
          // a write landed meanwhile, SOL 1% lower: the page holds a newer price at the check, whose floor is 1% more SOL
          pub = Math.floor(clock.ms / 1000) - 2;
          price = (price * 99n) / 100n;
          prices.wake();
          prices.refresh(["solana"]);
          for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
        }
        const { minAmountOut } = oneClickFloors({ amountIn: BigInt(req.amount), withdrawFee: 5_000n, slippageBps: req.slippageTolerance, feeBps: 20, pricing: stale.pricing, decimalsIn: 6, decimalsOut: 9, intoVault: false });
        const fmt = (v: bigint, d: number) => { const s = v.toString().padStart(d + 1, "0"); return `${s.slice(0, -d)}.${s.slice(-d)}`; };
        const a: Answer = {
          quote: {
            amountIn: req.amount, amountInFormatted: fmt(BigInt(req.amount), 6), amountInUsd: "25.0", minAmountIn: req.amount,
            amountOut: minAmountOut.toString(), amountOutFormatted: fmt(minAmountOut, 9), amountOutUsd: "24.9", minAmountOut: minAmountOut.toString(),
            depositAddress: ADDRESS, deadline: new Date(Date.parse(req.deadline) + H72).toISOString(),
            timeWhenInactive: new Date(Date.parse(req.deadline) + H72).toISOString(), timeEstimate: 20, refundFee: "0", withdrawFee: "5000",
          },
          quoteRequest: { ...req, depositMode: "SIMPLE", confidentiality: "public", quoteWaitingTimeMs: 0, insured: false, appFees: [{ recipient: COLLECTOR, fee: 20 }] },
          signature: "", timestamp: new Date(clock.ms - 500).toISOString(), correlationId: "00000000-0000-4000-8000-000000000000",
        };
        signAnswer(a, mockKey.privateKey);
        return new Response(JSON.stringify(a), { status: 201, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    };
    const d = poolAddressHost(deps)({ chain: "solana", origin_asset: BASE_USDC, amount: "25" }, { id: "op-1" });
    await d.after;
    return { out: d.answer() as { error?: string }, took, ages, held: prices.get("solana") };
  };
  const late = await run(false);
  assert.equal(late.held, null, "the page itself no longer uses the price by the answer");
  assert.deepEqual(late.out, { error: "not_allowed" }, "a price past its bound at the check: no quote");
  assert.equal(late.took.length, 0, "nothing handed to the follow");
  assert.deepEqual(late.ages, [max - 1, max - 1 + 13], "the price is taken at the ask and again at the check");
  // a newer price at the check is the floor's: the answer on the old price's floor is 1% short of it, refused
  const fresh = await run(true);
  assert.notEqual(fresh.held, null, "the page holds the newer price");
  assert.ok(fresh.out.error === "not_allowed" || fresh.out.error === "quote_check_failed", JSON.stringify(fresh.out));
  assert.equal(fresh.took.length, 0);
});

// card evm-deposit-route-mainnet review: the floor's reads each held by a test that dies with them changed. The chain
// moves (the two RPCs' heads apart, every value at `latest` other than at the block both hold) and the operator fee is
// gas-priced, so the floor is the agreed block's base fee, depths and L1 fee bound at the cap's gas with the headroom.
test("evm-deposit-route-mainnet review: readEvmPoolFloor reads every value at the block both RPCs hold, and the L1 fee at the cap's gas with the tree's headroom", async () => {
  const { readEvmPoolFloor } = await import("../src/pool-deposit-address.ts");
  const { evmPoolDepositFloor } = await import("../src/pool-deposit-quote.ts");
  const { EVM_DEPOSIT_PRIORITY_CAP } = await import("../src/pool-deposit-evm.ts");
  const { EVM_DEPOSIT_GAS_MAX, evmDepositHeadroom } = await import("../src/rules/pool.ts");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const sel = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);
  const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  const AT = 0x64;
  const block = (n: number) => ({ number: "0x" + n.toString(16), hash: "0x" + n.toString(16).padStart(64, "0"), timestamp: "0x" + n.toString(16), baseFeePerGas: "0x" + (5_000_000 + (n - AT) * 1_000).toString(16) });
  const rpcOf = (head: number) => (async (method: string, params: readonly unknown[]) => {
    const tag = method === "eth_call" ? (params[1] as string) : (params[0] as string);
    const newest = tag === "latest";
    if (method === "eth_getBlockByNumber") return block(newest ? head : Number(tag));
    if (method === "eth_call") {
      const data = (params[0] as { data: string }).data;
      if (data === sel("currentTreeDepth()")) return word(newest ? 9n : 3n);
      if (data === sel("currentLabelTreeDepth()")) return word(newest ? 9n : 2n);
      if (data.startsWith("0xf1c7a58b")) return word(newest ? 1n : 7_000_000_000n); // getL1FeeUpperBound
      return word(BigInt("0x" + data.slice(-64)) * 3n); // the operator fee: 3 wei a gas of the gas it is asked at
    }
    throw new Error(`unmocked ${method}`);
  }) as unknown as import("../../wallet/src/pool/evm.ts").EvmRpc;
  const pin = { network: "base", pool: "0x00000000000000000000000000000000000f0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n } as const;
  const gas = EVM_DEPOSIT_GAS_MAX + evmDepositHeadroom(3n, 2n);
  assert.equal(
    await readEvmPoolFloor([rpcOf(AT + 1), rpcOf(AT)], pin),
    evmPoolDepositFloor({ baseFee: 5_000_000n, tip: EVM_DEPOSIT_PRIORITY_CAP, l1Fee: 7_000_000_000n + gas * 3n, stateDepth: 3n, labelDepth: 2n }),
  );
});

// Review P3 of card helper-says-why-a-vendor-refused: the page's stop (src/main.ts quotesSignedOut) reaches the quote's
// re-ask: a sign out in its pause sends no second quote and gives no address.
test("a sign out in the quote's re-ask pause: no second quote leaves, no address, nothing handed to the follow", async () => {
  const w = world({ noLiquidity: 99 });
  const stop = new AbortController();
  w.deps.stop = () => stop.signal;
  const asked = ask(w, { chain: "solana", origin_asset: BASE_USDC, amount: "25" });
  while (w.sent.length < 1) await new Promise((ok) => setImmediate(ok));
  stop.abort(new DOMException("signed out", "AbortError"));
  assert.deepEqual(await asked, { error: "down" });
  assert.equal(w.sent.length, 1);
  assert.equal(w.took.length, 0);
});

// Re-review P2 of card helper-says-why-a-vendor-refused: the stop is read once, as the request arrives. A sign out swaps
// in a fresh signal (src/quotes-stop.ts), so a host that read it only after its awaits would send its quote anyway.
test("a sign out during pool.address's floor read: no quote leaves, the answer is down", async () => {
  const { quotesStop } = await import("../src/quotes-stop.ts");
  const w = world();
  const page = quotesStop();
  w.deps.stop = page.stopped;
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  let reading = false;
  const floor = w.deps.floor!;
  w.deps.floor = async (chain, wallet) => ((reading = true), await gate, floor(chain, wallet));
  const asked = ask(w, { chain: "solana", origin_asset: BASE_USDC, amount: "25" });
  while (!reading) await new Promise((ok) => setImmediate(ok));
  page.signedOut();
  release();
  assert.deepEqual(await asked, { error: "down" });
  assert.equal(w.sent.length, 0);
});

// Each wait held in turn, a sign out during it, on the page's own stop: nothing after it runs (the floor read carries the
// deposit address to an RPC, the follow reads it on chain).
test("a sign out at each of pool.address's waits: nothing after it runs (no records read, no floor read, no quote, no follow), the answer is down", async () => {
  const { quotesStop } = await import("../src/quotes-stop.ts");
  for (const at of ["named", "read", "floor", "read again", "follow"] as const) {
    const w = world();
    const page = quotesStop();
    w.deps.stop = page.stopped;
    const steps: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    let held = false;
    const hold = async (step: string) => {
      steps.push(step);
      if (step === at) (held = true), await gate;
    };
    const { read, floor, fetch: send, checked } = w.deps;
    w.deps.named = () => hold("named");
    w.deps.read = async (scope) => (await hold(steps.includes("read") ? "read again" : "read"), read(scope));
    let floorSignal: AbortSignal | undefined;
    w.deps.floor = async (chain, wallet, signal) => ((floorSignal = signal), await hold("floor"), floor!(chain, wallet));
    w.deps.fetch = ((url: string | URL | Request, init?: RequestInit) => (steps.push("ask"), send!(url, init))) as typeof fetch;
    w.deps.checked = async (...a) => (await hold("follow"), checked!(...a));
    const asked = ask(w, { chain: "solana", origin_asset: BASE_USDC, amount: "25" });
    while (!held) await new Promise((ok) => setImmediate(ok));
    page.signedOut();
    release();
    assert.deepEqual(await asked, { error: "down" }, at);
    assert.equal(steps.at(-1), at, `${at}: ${steps.join(", ")}`);
    // the follow's write ran before the sign out was seen: it holds the op, but the answer names no address
    assert.equal(w.took.length, at === "follow" ? 1 : 0, at);
    // the floor read is handed the stop, so its own reads end too (readSolanaPoolCosts)
    if (at !== "named" && at !== "read") assert.equal(floorSignal?.aborted, true, at);
  }
});
