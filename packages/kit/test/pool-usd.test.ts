// node --test packages/kit/test/pool-usd.test.ts: a USD amount in the pool asset's base units, from the device's own
// price reads on two RPCs (card kit-pool-tap-inputs, src/price/pool-usd.ts). The ok cases replay real answers recorded
// once by test/fixtures/pool-usd-capture.mjs (test/fixtures/pool-usd.json, its `read` field gives the time): the Pyth
// SOL/USD account on two Solana RPCs, Chainlink's ETH/USD feed on two Base and two Robinhood RPCs. Every other case is
// that recording with one thing planted. No network.
// The test names' first words are what test/pool-usd-mutants.mjs runs against each mutant: "agreement" and "staleness".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base64 } from "@scure/base";
import {
  POOL_USD_CROSS_BPS,
  POOL_USD_FEEDS,
  POOL_USD_MAX_AHEAD_S,
  poolUsdPrice,
  poolUsdToUnits,
  solanaProgramAddress,
  type SolanaRpc,
} from "../src/index.ts";

type Call = { url: string; method: string; params: unknown[]; result: unknown };
type Recorded = { rpcs: [string, string]; calls: Call[] };
const FX = JSON.parse(readFileSync(new URL("./fixtures/pool-usd.json", import.meta.url), "utf8")) as {
  read: string;
  nowMs: number;
  solana: Recorded;
  base: Recorded;
  robinhood: Recorded;
};
const NOW = FX.nowMs;

/** A Solana read's params without minContextSlot: a re-read at a newer slot gets the recorded answer again. */
const key = (params: readonly unknown[]): string =>
  JSON.stringify(params.map((x) => (x !== null && typeof x === "object" && !Array.isArray(x) ? { ...x, minContextSlot: undefined } : x)));
/** One recorded RPC: answers a call only as recorded (by method and params), through `edit` when given. */
function replay(rec: Recorded, k: 0 | 1, edit?: (method: string, params: unknown[], result: unknown) => unknown, log?: Call[]): SolanaRpc {
  const url = rec.rpcs[k];
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    log?.push({ url, method, params: [...params], result: null });
    const c = rec.calls.find((x) => x.url === url && x.method === method && key(x.params) === key(params));
    if (c === undefined) throw new Error(`no recorded answer for ${method} ${JSON.stringify(params)} on ${url}`);
    const r = structuredClone(c.result);
    return edit ? edit(method, [...params], r) : r;
  };
  return Object.assign(rpc, { url });
}
type Edit = (method: string, params: unknown[], result: unknown) => unknown;
const pair = (rec: Recorded, edits: readonly (Edit | undefined)[] = [], log?: Call[]): [SolanaRpc, SolanaRpc] => [
  replay(rec, 0, edits[0], log),
  replay(rec, 1, edits[1], log),
];

// ------------------------------------------------------------------------------------------------ Pyth's account bytes
/** PriceUpdateV2 with VerificationLevel::Full, as the Pyth Solana Receiver lays it out (see src/price/pool-usd.ts). */
const AT = { writeAuthority: 8, level: 40, feedId: 41, price: 73, conf: 81, expo: 89, publish: 93, postedSlot: 125 } as const;
/** The recorded account's bytes (both RPCs answered the same bytes). */
function solBytes(): Uint8Array {
  const c = FX.solana.calls.find((x) => x.method === "getMultipleAccounts")!;
  const v = (c.result as { value: [{ data: [string, string] }] }).value[0];
  return base64.decode(v.data[0]);
}
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const SOL_PRICE = view(solBytes()).getBigInt64(AT.price, true);
const SOL_EXPO = view(solBytes()).getInt32(AT.expo, true);
const SOL_PUBLISH_S = Number(view(solBytes()).getBigInt64(AT.publish, true));

/** An edit of every getMultipleAccounts answer: the account's bytes through `f`, and its other fields through `g`. */
const solEdit = (f: (b: Uint8Array) => void, g?: (acc: Record<string, unknown>) => void) => (method: string, _p: unknown[], r: unknown) => {
  if (method !== "getMultipleAccounts") return r;
  const acc = (r as { value: Record<string, unknown>[] }).value[0]!;
  const b = base64.decode((acc.data as [string, string])[0]);
  f(b);
  acc.data = [base64.encode(b), "base64"];
  g?.(acc);
  return r;
};
const setI64 = (at: number, v: bigint) => (b: Uint8Array) => view(b).setBigInt64(at, v, true);
const setU64 = (at: number, v: bigint) => (b: Uint8Array) => view(b).setBigUint64(at, v, true);
const setI32 = (at: number, v: number) => (b: Uint8Array) => view(b).setInt32(at, v, true);

const solana = (edits?: Parameters<typeof pair>[1], nowMs = NOW) => poolUsdToUnits({ chain: "solana", usd: "100", rpcs: pair(FX.solana, edits), nowMs });

// ------------------------------------------------------------------------------------------------ Chainlink's words
/** An edit of every latestRoundData answer: word `i` (roundId, answer, startedAt, updatedAt, answeredInRound) set. */
const LRD = "0xfeaf968c";
const DECIMALS = "0x313ce567";
const isCall = (p: unknown[], data: string) => (p[0] as { data?: string })?.data === data;
const wordEdit = (data: string, i: number, w: bigint) => (method: string, p: unknown[], r: unknown) => {
  if (method !== "eth_call" || !isCall(p, data)) return r;
  const h = (r as string).slice(2);
  return `0x${h.slice(0, 64 * i)}${BigInt.asUintN(256, w).toString(16).padStart(64, "0")}${h.slice(64 * (i + 1))}`;
};
function words(rec: Recorded): bigint[] {
  const c = rec.calls.find((x) => x.method === "eth_call" && isCall(x.params, LRD))!;
  const h = (c.result as string).slice(2);
  return [0, 1, 2, 3, 4].map((i) => BigInt(`0x${h.slice(64 * i, 64 * i + 64)}`));
}
/** Base's two RPCs for a Robinhood read, its updatedAt moved to `nowMs` so only Robinhood's own age is under test. */
const baseAt = (nowMs: number, edit?: Edit): [SolanaRpc, SolanaRpc] => {
  const fresh = wordEdit(LRD, 3, BigInt(Math.floor(nowMs / 1000)));
  const both: Edit = (m, p, r) => fresh(m, p, edit ? edit(m, p, r) : r);
  return pair(FX.base, [both, both]);
};
const evm = (chain: "base" | "robinhood", edits?: Parameters<typeof pair>[1], nowMs = NOW) =>
  poolUsdToUnits({ chain, usd: "100", rpcs: pair(FX[chain], edits), nowMs, ...(chain === "robinhood" ? { baseRpcs: baseAt(nowMs) } : {}) });

// ------------------------------------------------------------------------------------------------ ok
test("ok: the recorded Pyth SOL/USD read turns USD into lamports, rounded down, never more than the USD asked", async () => {
  assert.equal(SOL_EXPO, -8);
  assert.ok(SOL_PRICE > 0n);
  const p = await poolUsdPrice({ chain: "solana", rpcs: pair(FX.solana), nowMs: NOW });
  assert.deepEqual({ asset: p.asset, decimals: p.decimals, price: p.price, expo: p.expo, publishedS: p.publishedS, source: p.source }, { asset: "SOL", decimals: 9, price: SOL_PRICE, expo: -8, publishedS: SOL_PUBLISH_S, source: "pyth" });
  for (const usd of ["100", "0.01", "1", "12.34", "999999.999999", "0.000000000000000001"]) {
    const units = await poolUsdToUnits({ chain: "solana", usd, rpcs: pair(FX.solana), nowMs: NOW });
    // units = floor(usd * 10^9 / (price * 10^-8)), worked here with integers only
    const [w, f = ""] = usd.split(".");
    const U = BigInt(w! + f);
    const want = (U * 10n ** BigInt(9 + 8)) / (SOL_PRICE * 10n ** BigInt(f.length));
    assert.equal(units, want, usd);
    // rounded down: the units are worth at most the USD, and one more unit is worth more
    assert.ok(units * SOL_PRICE * 10n ** BigInt(f.length) <= U * 10n ** 17n, `${usd}: at most the USD`);
    assert.ok((units + 1n) * SOL_PRICE * 10n ** BigInt(f.length) > U * 10n ** 17n, `${usd}: rounded down by less than one unit`);
  }
});

test("ok: the recorded Chainlink ETH/USD reads on Base and on Robinhood turn USD into wei, each from its own chain's feed", async () => {
  for (const chain of ["base", "robinhood"] as const) {
    const [, answer] = words(FX[chain]);
    const p = await poolUsdPrice({ chain, rpcs: pair(FX[chain]), nowMs: NOW, baseRpcs: pair(FX.base) });
    assert.deepEqual({ asset: p.asset, decimals: p.decimals, price: p.price, expo: p.expo, source: p.source }, { asset: "ETH", decimals: 18, price: answer!, expo: -8, source: "chainlink" });
    assert.equal(await evm(chain), (100n * 10n ** 26n) / answer!, chain);
    assert.equal(await poolUsdToUnits({ chain, usd: "0.5", rpcs: pair(FX[chain]), nowMs: NOW, baseRpcs: pair(FX.base) }), (5n * 10n ** 25n) / answer!, chain);
  }
  // two feeds of one asset: within the two feeds' deviation thresholds (0.15% and 0.5%) of each other
  const [b, r] = [words(FX.base)[1]!, words(FX.robinhood)[1]!];
  const gap = b > r ? b - r : r - b;
  assert.ok(gap * 10_000n <= b * 100n, `Base ${b} and Robinhood ${r} within 1%`);
});

test("ok: the Pyth account is the push oracle's shard-0 address of the SOL/USD feed id, and the recording is of it", () => {
  const f = POOL_USD_FEEDS.solana;
  const id = Uint8Array.from(f.feedId.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));
  assert.equal(solanaProgramAddress([new Uint8Array([0, 0]), id], f.pushOracle), f.account);
  const c = FX.solana.calls.find((x) => x.method === "getMultipleAccounts")!;
  assert.deepEqual(c.params[0], [f.account]);
  for (const chain of ["base", "robinhood"] as const) assert.ok(FX[chain].calls.some((x) => x.method === "eth_call" && (x.params[0] as { to: string }).to === POOL_USD_FEEDS[chain].proxy), chain);
});

// ------------------------------------------------------------------------------------------------ agreement
test("agreement: Pyth bytes that differ between the two RPCs in any field are refused, after the re-reads", async () => {
  const fields: [string, (b: Uint8Array) => void][] = [
    ["price", setI64(AT.price, SOL_PRICE + 1n)],
    ["conf", setU64(AT.conf, 1n)],
    ["exponent", setI32(AT.expo, -9)],
    ["publish time", setI64(AT.publish, BigInt(SOL_PUBLISH_S - 1))],
    ["posted slot", setU64(AT.postedSlot, 1n)],
    ["feed id", (b) => (b[AT.feedId]! ^= 1)],
    ["write authority", (b) => (b[AT.writeAuthority]! ^= 1)],
    ["the last byte", (b) => (b[b.length - 1]! ^= 1)],
  ];
  for (const [name, f] of fields) {
    await assert.rejects(solana([undefined, solEdit(f)]), /the two RPCs disagree on the Pyth account/, name);
    await assert.rejects(solana([solEdit(f), undefined]), /the two RPCs disagree on the Pyth account/, `${name}, on the other RPC`);
  }
  await assert.rejects(solana([undefined, solEdit(() => {}, (acc) => (acc.owner = "11111111111111111111111111111111"))]), /disagree/, "the owner");
});

test("agreement: a disagreement re-reads both at the newer slot, and two answers that then agree are used", async () => {
  const good = FX.solana.calls.find((x) => x.method === "getMultipleAccounts")!.result as { context: { slot: number } };
  const seen: unknown[][] = [];
  let n = 0;
  const a = Object.assign(async (_m: string, p: readonly unknown[]) => (seen.push([...p]), structuredClone(good)), { url: "https://a.example" });
  const b = Object.assign(async (_m: string, p: readonly unknown[]) => {
    seen.push([...p]);
    const r = structuredClone(good);
    r.context.slot += 3;
    return n++ === 0 ? solEdit(setI64(AT.price, 1n))("getMultipleAccounts", [], r) : r;
  }, { url: "https://b.example" });
  assert.equal(await poolUsdToUnits({ chain: "solana", usd: "100", rpcs: [a, b], nowMs: NOW }), (100n * 10n ** 17n) / SOL_PRICE);
  // the second round asks both RPCs for an answer at or past the newer of the first round's slots
  const second = seen.slice(2).map((p) => (p[1] as { minContextSlot?: number }).minContextSlot);
  assert.deepEqual(second, [good.context.slot + 3, good.context.slot + 3]);
});

test("agreement: Chainlink answers that differ between the two RPCs in any field are refused", async () => {
  for (const chain of ["base", "robinhood"] as const) {
    const w = words(FX[chain]);
    for (const [i, name] of ["roundId", "answer", "startedAt", "updatedAt", "answeredInRound"].entries()) {
      await assert.rejects(evm(chain, [undefined, wordEdit(LRD, i, w[i]! - 1n)]), new RegExp(`the two RPCs disagree on ${name}`), `${chain} ${name}`);
    }
    await assert.rejects(evm(chain, [wordEdit(DECIMALS, 0, 18n), undefined]), /the two RPCs disagree on decimals/, `${chain} decimals`);
  }
});

test("agreement: both Chainlink reads are at one block, the lower of the two RPCs' heads, never latest on each", async () => {
  for (const chain of ["base", "robinhood"] as const) {
    const log: Call[] = [];
    await poolUsdPrice({ chain, rpcs: pair(FX[chain], [], log), nowMs: NOW, baseRpcs: pair(FX.base) });
    const heads = FX[chain].calls.filter((c) => c.method === "eth_blockNumber").map((c) => BigInt(c.result as string));
    const low = `0x${(heads[0]! < heads[1]! ? heads[0]! : heads[1]!).toString(16)}`;
    const blocks = log.filter((c) => c.method === "eth_call").map((c) => c.params[1]);
    assert.equal(blocks.length, 4, chain);
    assert.deepEqual(new Set(blocks), new Set([low]), chain);
  }
});

test("agreement: Robinhood's ETH/USD is used only within 1% of Base's, read in the same call; with no Base RPCs it is refused", async () => {
  assert.equal(POOL_USD_CROSS_BPS, 100n);
  const [b, r] = [words(FX.base)[1]!, words(FX.robinhood)[1]!];
  const at = (price: bigint) => poolUsdPrice({ chain: "robinhood", rpcs: pair(FX.robinhood), nowMs: NOW, baseRpcs: baseAt(NOW, wordEdit(LRD, 1, price)) });
  // Base's price that puts Robinhood's exactly 1% away, either side (lo = the lower of the two), and one step past
  const over = (r * 10_100n) / 10_000n; // Base above: lo = r, 1% of r
  assert.equal((await at(over)).price, r, "1% above: used");
  await assert.rejects(at(over + 1n), /more than 100 bps from Base's/);
  const under = (r * 10_000n + 10_099n) / 10_100n; // Base below: r - b <= 1% of b
  assert.equal((await at(under)).price, r, "1% below: used");
  await assert.rejects(at(under - 1n), /more than 100 bps from Base's/);
  assert.ok(b > 0n);
  // a halted Robinhood feed far from Base's, still inside its 24 h age bound: refused
  await assert.rejects(poolUsdPrice({ chain: "robinhood", rpcs: pair(FX.robinhood, [wordEdit(LRD, 1, r / 2n), wordEdit(LRD, 1, r / 2n)]), nowMs: NOW, baseRpcs: pair(FX.base) }), /more than 100 bps/);
  await assert.rejects(poolUsdPrice({ chain: "robinhood", rpcs: pair(FX.robinhood), nowMs: NOW }), /Base's two RPCs are needed/);
  // Base's own reads are held as Base's: its age, its chain id, its two providers
  await assert.rejects(poolUsdPrice({ chain: "robinhood", rpcs: pair(FX.robinhood), nowMs: NOW, baseRpcs: pair(FX.robinhood) }), /chain id/);
  const one = pair(FX.base)[0];
  await assert.rejects(poolUsdPrice({ chain: "robinhood", rpcs: pair(FX.robinhood), nowMs: NOW, baseRpcs: [one, one] }), /one provider twice/);
});

test("agreement: hex in upper case on one RPC is the same answer (as the wallet's evmRpcHex reads it)", async () => {
  const upper = (_m: string, _p: unknown[], r: unknown) => (typeof r === "string" ? `0x${r.slice(2).toUpperCase()}` : r);
  assert.equal(await evm("base", [undefined, upper]), (100n * 10n ** 26n) / words(FX.base)[1]!);
});

// ------------------------------------------------------------------------------------------------ staleness
test("staleness: a Pyth price older than 60 s is refused; at 60 s it is used; one ahead of the clock is refused", async () => {
  const f = POOL_USD_FEEDS.solana;
  assert.equal(f.maxAgeS, 60);
  assert.ok(await solana(undefined, (SOL_PUBLISH_S + 60) * 1000));
  await assert.rejects(solana(undefined, (SOL_PUBLISH_S + 60) * 1000 + 1), /older than 60 s/);
  await assert.rejects(solana(undefined, (SOL_PUBLISH_S + 3600) * 1000), /older than 60 s/);
  assert.ok(await solana(undefined, (SOL_PUBLISH_S - POOL_USD_MAX_AHEAD_S) * 1000));
  await assert.rejects(solana(undefined, (SOL_PUBLISH_S - POOL_USD_MAX_AHEAD_S) * 1000 - 1), /ahead of the device's clock/);
});

test("staleness: a Chainlink price older than its chain's bound is refused; at the bound it is used", async () => {
  assert.equal(POOL_USD_FEEDS.base.maxAgeS, 1_500);
  assert.equal(POOL_USD_FEEDS.robinhood.maxAgeS, 86_700);
  for (const chain of ["base", "robinhood"] as const) {
    const updated = Number(words(FX[chain])[3]);
    const max = POOL_USD_FEEDS[chain].maxAgeS;
    assert.ok(await evm(chain, undefined, (updated + max) * 1000), chain);
    await assert.rejects(evm(chain, undefined, (updated + max) * 1000 + 1), new RegExp(`older than ${max} s`), chain);
    await assert.rejects(evm(chain, undefined, (updated - POOL_USD_MAX_AHEAD_S) * 1000 - 1), /ahead of the device's clock/, chain);
    await assert.rejects(evm(chain, [wordEdit(LRD, 3, 0n), wordEdit(LRD, 3, 0n)]), /round/, `${chain}: an updatedAt of 0`);
  }
});

// ------------------------------------------------------------------------------------------------ the account and the feed
test("refused: a Pyth account with the wrong owner, length, discriminator, feed id or write authority, on both RPCs", async () => {
  const both = (f: (b: Uint8Array) => void, g?: (acc: Record<string, unknown>) => void) => solana([solEdit(f, g), solEdit(f, g)]);
  await assert.rejects(both(() => {}, (acc) => (acc.owner = "11111111111111111111111111111111")), /owned by 11111111111111111111111111111111, not the Pyth Solana Receiver/);
  await assert.rejects(both((b) => (b[0]! ^= 1)), /not a PriceUpdateV2/);
  await assert.rejects(both((b) => (b[AT.feedId]! ^= 1)), /not the SOL\/USD feed/);
  await assert.rejects(both((b) => (b[AT.writeAuthority]! ^= 1)), /write authority/);
  const short = (method: string, _p: unknown[], r: unknown) => {
    if (method !== "getMultipleAccounts") return r;
    const acc = (r as { value: Record<string, unknown>[] }).value[0]!;
    acc.data = [base64.encode(solBytes().slice(0, 133)), "base64"];
    return r;
  };
  await assert.rejects(solana([short, short]), /not a PriceUpdateV2/);
  const none = (method: string, _p: unknown[], r: unknown) => (method === "getMultipleAccounts" ? { ...(r as object), value: [null] } : r);
  await assert.rejects(solana([none, none]), /no Pyth account/);
  const junk = () => ({ nope: 1 });
  await assert.rejects(solana([junk, junk]), /not a getMultipleAccounts answer/);
});

test("refused: a Pyth update with only partial Wormhole verification", async () => {
  // VerificationLevel::Partial { num_signatures } is tag 0 and one byte: the message starts a byte later
  const partial = (b: Uint8Array) => {
    const full = b.slice();
    b[AT.level] = 0;
    b[AT.level + 1] = 13;
    b.set(full.slice(AT.feedId, 133), AT.feedId + 1);
  };
  await assert.rejects(solana([solEdit(partial), solEdit(partial)]), /verification level is Partial \(13 signatures\), not Full/);
  await assert.rejects(solana([solEdit((b) => (b[AT.level] = 2)), solEdit((b) => (b[AT.level] = 2))]), /verification level/);
});

test("refused: a Pyth confidence wider than 1% of the price", async () => {
  const bound = POOL_USD_FEEDS.solana.maxConfBps;
  assert.equal(bound, 100);
  const at = (conf: bigint) => solEdit(setU64(AT.conf, conf));
  const edge = (SOL_PRICE * BigInt(bound)) / 10_000n;
  assert.ok(await solana([at(edge), at(edge)]));
  await assert.rejects(solana([at(edge + 1n), at(edge + 1n)]), /confidence .* is wider than 100 bps/);
});

test("refused: a non-positive price, Pyth or Chainlink", async () => {
  for (const v of [0n, -1n, -SOL_PRICE]) await assert.rejects(solana([solEdit(setI64(AT.price, v)), solEdit(setI64(AT.price, v))]), /price .* is not positive/, String(v));
  for (const chain of ["base", "robinhood"] as const) {
    for (const v of [0n, -1n, -words(FX[chain])[1]!]) await assert.rejects(evm(chain, [wordEdit(LRD, 1, v), wordEdit(LRD, 1, v)]), /price .* is not positive/, `${chain} ${v}`);
  }
});

test("refused: a Pyth exponent or Chainlink decimals out of range, and a Chainlink round answered in an earlier round", async () => {
  await assert.rejects(solana([solEdit(setI32(AT.expo, 1)), solEdit(setI32(AT.expo, 1))]), /exponent/);
  await assert.rejects(solana([solEdit(setI32(AT.expo, -19)), solEdit(setI32(AT.expo, -19))]), /exponent/);
  await assert.rejects(evm("base", [wordEdit(DECIMALS, 0, 19n), wordEdit(DECIMALS, 0, 19n)]), /decimals/);
  const w = words(FX.base);
  await assert.rejects(evm("base", [wordEdit(LRD, 4, w[0]! - 1n), wordEdit(LRD, 4, w[0]! - 1n)]), /round/);
  await assert.rejects(evm("base", [wordEdit(LRD, 0, 1n << 80n), wordEdit(LRD, 0, 1n << 80n)]), /round/);
});

test("refused: a Chainlink RPC of another chain, and answers that are not one ABI word list", async () => {
  const chainId = (id: string) => (method: string, _p: unknown[], r: unknown) => (method === "eth_chainId" ? id : r);
  await assert.rejects(evm("base", [undefined, chainId("0x1")]), /chain id 0x1 is not base's 0x2105/);
  await assert.rejects(evm("robinhood", [chainId("0x2105"), undefined]), /chain id 0x2105 is not robinhood's 0x1237/);
  const cut = (method: string, p: unknown[], r: unknown) => (method === "eth_call" && isCall(p, LRD) ? (r as string).slice(0, -2) : r);
  await assert.rejects(evm("base", [cut, cut]), /latestRoundData: not 5 words/);
  const notHex = (method: string, p: unknown[], r: unknown) => (method === "eth_call" && isCall(p, DECIMALS) ? "0xzz" : r);
  await assert.rejects(evm("base", [notHex, notHex]), /decimals: not 1 word/);
  const badHead = (method: string, _p: unknown[], r: unknown) => (method === "eth_blockNumber" ? "0x01" : r);
  await assert.rejects(evm("base", [badHead, undefined]), /not a quantity/);
});

// ------------------------------------------------------------------------------------------------ the request
test("refused: one provider passed twice, the same function or the same URL", async () => {
  const [a, b] = pair(FX.solana);
  await assert.rejects(poolUsdToUnits({ chain: "solana", usd: "1", rpcs: [a, a], nowMs: NOW }), /one provider twice/);
  const sameUrl = Object.assign((m: string, p: readonly unknown[]) => b(m, p), { url: a.url! });
  await assert.rejects(poolUsdToUnits({ chain: "solana", usd: "1", rpcs: [a, sameUrl], nowMs: NOW }), /one provider twice/);
  const [x] = pair(FX.base);
  await assert.rejects(poolUsdToUnits({ chain: "base", usd: "1", rpcs: [x, x], nowMs: NOW }), /one provider twice/);
  await assert.rejects(poolUsdToUnits({ chain: "base", usd: "1", rpcs: [x] as never, nowMs: NOW }), /two RPCs/);
});

test("refused: a USD amount that is not a positive finite decimal string", async () => {
  for (const usd of ["0", "0.0", "-1", "1e3", "", " 1", "1 ", "1.", ".5", "01", "abc", "NaN", "Infinity", "1,5", "0x10", "1.0000000000000000001", "10000000000000000", 1, 1n, null, undefined]) {
    await assert.rejects(poolUsdToUnits({ chain: "solana", usd: usd as never, rpcs: pair(FX.solana), nowMs: NOW }), /USD amount .* is not a positive decimal/, String(usd));
  }
});

test("refused: an unknown chain, NEAR included (its vault holds USDC: no price read)", async () => {
  for (const chain of ["ethereum", "near", "", "__proto__", "toString", undefined]) {
    await assert.rejects(poolUsdToUnits({ chain: chain as never, usd: "1", rpcs: pair(FX.solana), nowMs: NOW }), /no USD price for chain/, String(chain));
  }
});

test("refused: a now that is not a time", async () => {
  for (const nowMs of [NaN, -1, Infinity, 1.5, "1" as never]) await assert.rejects(poolUsdToUnits({ chain: "solana", usd: "1", rpcs: pair(FX.solana), nowMs }), /nowMs/, String(nowMs));
});
