/// <reference types="node" />
// A coin's Meteora DLMM SOL pairs, found on the chain (card solana-buy-reaches-raydium-and-meteora): replays
// readSolanaDlmmPairs as mainnet answered it on 15 Nov (test/vectors/dlmm-pairs.json: the scans on Solana Vibe Station
// and api.mainnet-beta, the ranking reads on api.mainnet-beta and publicnode). Good: NEARKAT's four pairs (B8BH6ZKr…
// and J3wZVx37… among them) with no ranking read; USDC's 143 ranked to the four both providers read deepest, SOL-USDC
// 5rCf1DM8… among them. Bad: a provider that hides a pair, or ranks made-up depths, cannot drop the pair the other names
// or reads deepest; a failed scan, an entry that is not an address and an answer past 512 throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SOLANA_DLMM_MAX_PAIRS, SOLANA_DLMM_SCAN_MAX, SOLANA_SOL_MINT, readSolanaDlmmPairs, solanaDlmmPairScan, solanaDlmmReserve } from "../src/index.ts";
import type { SolanaRpc } from "../src/trade/solana/send.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/dlmm-pairs.json", import.meta.url), "utf8")) as {
  scan: [string, string]; read: [string, string]; pairs: Record<string, string[]>; answers: Record<string, Record<string, unknown>>;
};
const NEARKAT = "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USDC = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";

type Edit = (method: string, params: unknown[], result: unknown) => unknown;
/** A provider answering from its recorded answers; `calls` counts each method asked. */
function replay(url: string, edit: Edit = (_m, _p, r) => r, calls: string[] = []): SolanaRpc {
  return (async (method: string, params: readonly unknown[]) => {
    calls.push(method);
    const key = JSON.stringify([method, params]);
    assert.ok(Object.hasOwn(V.answers[url]!, key), `${url} was not asked ${key.slice(0, 160)}`);
    return edit(method, params as unknown[], structuredClone(V.answers[url]![key]));
  }) as SolanaRpc;
}
const pair = (e: Edit[] = [], calls: string[][] = [[], [], [], []]) => ({
  scan: [replay(V.scan[0], e[0], calls[0]), replay(V.scan[1], e[1], calls[1])] as const,
  read: [replay(V.read[0], e[2], calls[2]), replay(V.read[1], e[3], calls[3])] as const,
});

test("NEARKAT: its four DLMM SOL pairs, the union of both scans, with no ranking read", async () => {
  const calls: string[][] = [[], [], [], []];
  const p = pair([], calls);
  const got = await readSolanaDlmmPairs(p.scan, p.read, NEARKAT);
  assert.deepEqual(got, V.pairs[NEARKAT]);
  assert.equal(got.length, 4);
  for (const k of ["B8BH6ZKr64agqNWG51CQWUKrLZZw5L31u2K6hubsZfyf", "J3wZVx37wfEpGNjBHiJyuGZf948jsFe3toCiMkD4D1oz"]) assert.ok(got.includes(k), k);
  assert.deepEqual(calls, [["getProgramAccounts", "getProgramAccounts"], ["getProgramAccounts", "getProgramAccounts"], [], []]);
});

test("USDC: 143 pairs past the reference's 8, each read provider's deepest half kept, SOL-USDC 5rCf1DM8 among them", async () => {
  const got = await readSolanaDlmmPairs(pair().scan, pair().read, USDC);
  assert.deepEqual(got, V.pairs[USDC]);
  assert.ok(got.length <= SOLANA_DLMM_MAX_PAIRS && got.includes(SOL_USDC));
});

test("a scan provider that hides a pair cannot drop it: the other's scan names it", async () => {
  const hide: Edit = (m, _p, r) => (m === "getProgramAccounts" ? { ...(r as object), value: ((r as { value: { pubkey: string }[] }).value).filter((e) => e.pubkey !== "B8BH6ZKr64agqNWG51CQWUKrLZZw5L31u2K6hubsZfyf") } : r);
  assert.deepEqual(await readSolanaDlmmPairs(pair([undefined!, hide]).scan, pair().read, NEARKAT), V.pairs[NEARKAT]);
  assert.deepEqual(await readSolanaDlmmPairs(pair([hide]).scan, pair().read, NEARKAT), V.pairs[NEARKAT]);
});

test("a read provider that ranks made-up depths cannot push out the pair the other reads deepest", async () => {
  // every reserve but SOL-USDC's read as the most SOL there is, SOL-USDC's as none
  const sol = solanaDlmmReserve(SOL_USDC, SOLANA_SOL_MINT);
  const liar: Edit = (m, p, r) => {
    if (m !== "getMultipleAccounts") return r;
    const keys = p[0] as string[];
    const full = Buffer.from(new BigUint64Array([0xffff_ffff_ffff_ffffn]).buffer).toString("base64");
    return { ...(r as object), value: (r as { value: ({ data: [string, string] } | null)[] }).value.map((v, i) => (v === null ? v : { ...v, data: [keys[i] === sol ? "AAAAAAAAAAA=" : full, "base64"] })) };
  };
  for (const at of [2, 3]) {
    const e: Edit[] = [];
    e[at] = liar;
    const p = pair(e);
    const got = await readSolanaDlmmPairs(p.scan, p.read, USDC);
    assert.ok(got.includes(SOL_USDC), `liar at ${at}: ${got}`);
    assert.ok(got.length <= SOLANA_DLMM_MAX_PAIRS);
  }
});

test("a failed scan, an entry that is not an address, or an answer past 512 throws; wSOL itself has none", async () => {
  const fail: Edit = () => { throw new Error("down"); };
  await assert.rejects(readSolanaDlmmPairs(pair([fail]).scan, pair().read, NEARKAT), /down/);
  const junk: Edit = (m, _p, r) => (m === "getProgramAccounts" ? { ...(r as object), value: [{ pubkey: "not-a-key" }] } : r);
  await assert.rejects(readSolanaDlmmPairs(pair([undefined!, junk]).scan, pair().read, NEARKAT), /not an address/);
  const flood: Edit = (m, _p, r) => (m === "getProgramAccounts" ? { ...(r as object), value: Array.from({ length: SOLANA_DLMM_SCAN_MAX + 1 }, () => ({ pubkey: SOL_USDC })) } : r);
  await assert.rejects(readSolanaDlmmPairs(pair([flood]).scan, pair().read, NEARKAT), /at most 512/);
  await assert.rejects(readSolanaDlmmPairs(pair().scan, pair().read, "x"), /32-byte/);
  assert.deepEqual(await readSolanaDlmmPairs(pair().scan, pair().read, SOLANA_SOL_MINT), []);
});

test("the scan is the program, the pair's size and both mints, addresses only", () => {
  assert.deepEqual(solanaDlmmPairScan(NEARKAT, SOLANA_SOL_MINT), [
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    { commitment: "confirmed", encoding: "base64", withContext: true, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: 904 }, { memcmp: { offset: 88, bytes: NEARKAT } }, { memcmp: { offset: 120, bytes: SOLANA_SOL_MINT } }] },
  ]);
});
