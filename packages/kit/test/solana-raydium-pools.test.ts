/// <reference types="node" />
// A coin's Raydium CPMM and AMM v4 SOL pools, found on the chain (card solana-buy-reaches-raydium-and-meteora): replays
// readSolanaCpmmPools and readSolanaAmmV4Pools as mainnet answered them on 15 Nov (test/vectors/raydium-pools.json: the
// scans on Solana Vibe Station and api.mainnet-beta, the ranking reads on api.mainnet-beta and publicnode). Good:
// HIGH's one CPMM pool CqvMZmWD… and CzLSuj…'s one AMM v4 pool 9Tb2ohu5…, with no ranking read; USDC's 14 CPMM and 17
// AMM v4 pools ranked to each read provider's deepest half (the CPMM pool's SOL vault a program address of the pool,
// the AMM v4 pool's read from the pool itself). Bad: a provider that hides a pool cannot drop it; a provider that ranks
// made-up depths cannot push out the pool the other reads deepest; a failed scan and an entry that is not an address
// throw; the scan is the pool's size and both mints, nothing wider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SOLANA_AMM_V4_PROGRAM,
  SOLANA_CPMM_PROGRAM,
  SOLANA_SOL_MINT,
  readSolanaAmmV4Pools,
  readSolanaCpmmPools,
  solanaAmmV4PoolScan,
  solanaCpmmPoolScan,
} from "../src/index.ts";
import type { SolanaRpc } from "../src/trade/solana/send.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/raydium-pools.json", import.meta.url), "utf8")) as {
  scan: [string, string]; read: [string, string]; pools: Record<string, Record<string, string[]>>; answers: Record<string, Record<string, unknown>>;
};
const HIGH = "7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh";
const CZLSUJ = "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FIND = { "raydium-cpmm": readSolanaCpmmPools, "raydium-amm-v4": readSolanaAmmV4Pools } as const;

type Edit = (method: string, params: unknown[], result: unknown) => unknown;
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

test("HIGH's one CPMM pool and CzLSuj's one AMM v4 pool, the union of both scans, with no ranking read", async () => {
  for (const [kind, mint, pool] of [["raydium-cpmm", HIGH, "CqvMZmWDvEufa5rzkubidyR4zMDqDPoLjAtsW6wGsPMu"], ["raydium-amm-v4", CZLSUJ, "9Tb2ohu5P16BpBarqd3N27WnkF51Ukfs8Z1GzzLDxVZW"]] as const) {
    const calls: string[][] = [[], [], [], []];
    const p = pair([], calls);
    assert.deepEqual(await FIND[kind](p.scan, p.read, mint), [pool]);
    assert.deepEqual(V.pools[kind]![mint], [pool]);
    assert.deepEqual(calls, [["getProgramAccounts", "getProgramAccounts"], ["getProgramAccounts", "getProgramAccounts"], [], []]);
  }
});

test("USDC: 14 CPMM and 17 AMM v4 SOL pools ranked to each read provider's deepest half", async () => {
  for (const kind of ["raydium-cpmm", "raydium-amm-v4"] as const) {
    const calls: string[][] = [[], [], [], []];
    const p = pair([], calls);
    const got = await FIND[kind](p.scan, p.read, USDC);
    assert.deepEqual(got, V.pools[kind]![USDC]);
    assert.ok(got.length >= 4 && got.length <= 8, `${kind}: ${got.length}`);
    assert.ok(calls[2]!.length > 0 && calls[3]!.length > 0, "both read providers ranked");
  }
});

test("a scan provider that hides a pool cannot drop it: the other's scan names it", async () => {
  for (const [kind, mint] of [["raydium-cpmm", HIGH], ["raydium-amm-v4", CZLSUJ]] as const) {
    const hide: Edit = (m, _p, r) => (m === "getProgramAccounts" ? (Array.isArray(r) ? [] : { ...(r as object), value: [] }) : r);
    assert.deepEqual(await FIND[kind](pair([hide]).scan, pair().read, mint), V.pools[kind]![mint]);
    assert.deepEqual(await FIND[kind](pair([undefined!, hide]).scan, pair().read, mint), V.pools[kind]![mint]);
  }
});

test("a read provider that ranks made-up depths cannot push out the pool the other reads deepest", async () => {
  for (const kind of ["raydium-cpmm", "raydium-amm-v4"] as const) {
    const honest = V.pools[kind]![USDC]!;
    // each reserve read as the most SOL there is: the liar's half is any four, the honest provider's half stays
    const full = Buffer.from(new BigUint64Array([0xffff_ffff_ffff_ffffn]).buffer).toString("base64");
    const liar: Edit = (m, p, r) => {
      if (m !== "getMultipleAccounts" || (p[1] as { dataSlice?: { offset: number } }).dataSlice?.offset !== 64) return r;
      return { ...(r as object), value: (r as { value: ({ data: [string, string] } | null)[] }).value.map((v) => (v === null ? v : { ...v, data: [full, "base64"] })) };
    };
    for (const at of [2, 3]) {
      const e: Edit[] = [];
      e[at] = liar;
      const got = await FIND[kind](pair(e).scan, pair(e).read, USDC);
      // the honest provider's own half is in the list whatever the liar ranks
      const own = await FIND[kind](pair().scan, [replay(V.read[at === 2 ? 1 : 0]), replay(V.read[at === 2 ? 1 : 0])] as const, USDC).catch(() => null);
      assert.ok(got.length <= 8, `${kind} liar at ${at}: ${got.length}`);
      if (own) for (const k of own) assert.ok(got.includes(k), `${kind} liar at ${at} dropped ${k}`);
      assert.ok(honest.some((k) => got.includes(k)));
    }
  }
});

test("a failed scan or an entry that is not an address throws; wSOL itself has none", async () => {
  for (const kind of ["raydium-cpmm", "raydium-amm-v4"] as const) {
    const fail: Edit = (m) => { if (m === "getProgramAccounts") throw new Error("down"); return null; };
    const mint = kind === "raydium-cpmm" ? HIGH : CZLSUJ;
    await assert.rejects(FIND[kind](pair([fail]).scan, pair().read, mint), /down/);
    const junk: Edit = (m, _p, r) => (m === "getProgramAccounts" ? (Array.isArray(r) ? [{ pubkey: "x" }] : { ...(r as object), value: [{ pubkey: "x" }] }) : r);
    await assert.rejects(FIND[kind](pair([undefined!, junk]).scan, pair().read, mint), /not an address/);
    assert.deepEqual(await FIND[kind](pair().scan, pair().read, SOLANA_SOL_MINT), []);
  }
});

test("each scan is its program's pool size and both mints at their offsets, addresses only", () => {
  const c = solanaCpmmPoolScan(HIGH, SOLANA_SOL_MINT) as [string, { dataSlice: unknown; filters: unknown[] }];
  assert.equal(c[0], SOLANA_CPMM_PROGRAM);
  assert.deepEqual(c[1].dataSlice, { offset: 0, length: 0 });
  assert.deepEqual(c[1].filters, [{ dataSize: 637 }, { memcmp: { offset: 168, bytes: HIGH } }, { memcmp: { offset: 200, bytes: SOLANA_SOL_MINT } }]);
  const a = solanaAmmV4PoolScan(CZLSUJ, SOLANA_SOL_MINT) as [string, { dataSlice: unknown; filters: unknown[] }];
  assert.equal(a[0], SOLANA_AMM_V4_PROGRAM);
  assert.deepEqual(a[1].dataSlice, { offset: 0, length: 0 });
  assert.deepEqual(a[1].filters, [{ dataSize: 752 }, { memcmp: { offset: 400, bytes: CZLSUJ } }, { memcmp: { offset: 432, bytes: SOLANA_SOL_MINT } }]);
});
