/// <reference types="node" />
// A Raydium CLMM pool read as a market the device does not trade (card solana-buy-never-below-a-hidden-market): replays
// MPLX's wSOL pool BxRhW4q1… as mainnet answered on 21 Nov (test/vectors/mplx-clmm.json: the pool and both vaults on
// publicnode (A) and api.mainnet-beta (B)). Good: both providers agree, the SOL depth is the pool's wSOL vault, the spot
// out is the price's own (DexScreener read 0.0008269 SOL per MPLX at the same minute). Bad: a provider that lies about
// any field the read takes (a mint, a vault, the price, the SOL vault, a vault's owner or mint, the swap switch) is
// refused after one read more, never priced; a lie once is read again and agreed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import { SOLANA_CLMM_PROGRAM, SOLANA_SOL_MINT, readSolanaClmmSpot, solanaClmmSpotOut, solanaDecodeClmmPool } from "../src/index.ts";
import type { SolanaRpc } from "../src/trade/solana/send.ts";

type Answer = { context: { slot: number }; value: ({ owner: string; data: [string, "base64"] } | null)[] };
const V = JSON.parse(readFileSync(new URL("./vectors/mplx-clmm.json", import.meta.url), "utf8")) as {
  mint: string; pool: string; list: string[]; providers: { A: Answer; B: Answer };
};
const SOL = 1_000_000_000n;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
type Edit = (ans: Answer, list: readonly string[]) => Answer;

/** A provider that answers getMultipleAccounts from the recording, each asked account by its address. */
function replay(name: "A" | "B", edit: Edit = (a) => a, calls: string[][] = []): SolanaRpc {
  const rec = V.providers[name];
  const byKey = new Map(V.list.map((k, i) => [k, rec.value[i]!]));
  const rpc = (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    const list = params[0] as string[];
    calls.push(list);
    const ans: Answer = { context: { slot: rec.context.slot }, value: list.map((k) => structuredClone(byKey.get(k) ?? null)) };
    return edit(ans, list);
  }) as SolanaRpc;
  return Object.assign(rpc, { url: `https://${name.toLowerCase()}.example` });
}
const bytes = (a: { data: [string, "base64"] }): Uint8Array => base64.decode(a.data[0]);
const put = (a: { data: [string, "base64"] }, d: Uint8Array): void => void (a.data[0] = base64.encode(d));
/** Changes the pool's bytes in an answer that has it. */
const onPool = (f: (d: Uint8Array) => void): Edit => (ans, list) => {
  const i = list.indexOf(V.pool);
  const a = ans.value[i];
  if (a) { const d = bytes(a); f(d); put(a, d); }
  return ans;
};
/** Changes a vault's bytes (0 or 1, the pool's order) in an answer that has it. */
const onVault = (v: 0 | 1, f: (d: Uint8Array, a: { owner: string }) => void): Edit => (ans, list) => {
  const i = list.indexOf(V.list[1 + v]!);
  const a = ans.value[i];
  if (i >= 0 && a) { const d = bytes(a); f(d, a); put(a, d); }
  return ans;
};
const setU64 = (d: Uint8Array, o: number, x: bigint) => new DataView(d.buffer, d.byteOffset).setBigUint64(o, x, true);
const getU64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true);
const req = { token: V.mint, pool: V.pool, side: "buy" as const, amount: SOL };
const pool = solanaDecodeClmmPool({ owner: SOLANA_CLMM_PROGRAM, data: bytes(V.providers.B.value[0]!) });

test("CL1 the recorded pool decodes: MPLX is token 0, wSOL token 1, the vaults the read asks for", () => {
  assert.equal(pool.mint0, V.mint);
  assert.equal(pool.mint1, SOLANA_SOL_MINT);
  assert.deepEqual([V.pool, pool.vault0, pool.vault1], V.list);
  assert.equal(pool.decimals0, 6);
  assert.equal(pool.decimals1, 9);
  assert.equal(pool.tickSpacing, 10);
  assert.ok(pool.liquidity > 0n && pool.sqrtPriceX64 > 0n);
  // DexScreener at the same minute: 0.0008269 SOL per MPLX, so 1 SOL spot buys ~1209 MPLX (6 decimals)
  const out = Number(solanaClmmSpotOut(pool.sqrtPriceX64, "buy", SOL, false)) / 1e6;
  assert.ok(Math.abs(out * 0.0008269 - 1) < 0.01, `1 SOL spot-buys ${out} MPLX`);
  // a sell of what the buy spot-gets is the same SOL back, to rounding
  const back = solanaClmmSpotOut(pool.sqrtPriceX64, "sell", solanaClmmSpotOut(pool.sqrtPriceX64, "buy", SOL, false), false);
  assert.ok(SOL - back >= 0n && SOL - back < 1_000_000n);
});

test("CL2 two honest providers: the pool is a market, its depth the wSOL vault on each, the slots each read's", async () => {
  const r = await readSolanaClmmSpot([replay("A"), replay("B")], req);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  const vault1 = (n: "A" | "B") => getU64(bytes(V.providers[n].value[2]!), 64);
  assert.deepEqual(r.spot.depth, [vault1("A"), vault1("B")]);
  assert.ok(r.spot.depth[0] > 20_000n * SOL);
  assert.deepEqual(r.spot.slots, [V.providers.A.context.slot, V.providers.B.context.slot]);
  assert.equal(r.spot.spotOut[1], solanaClmmSpotOut(pool.sqrtPriceX64, "buy", SOL, false));
});

// every field the read takes, lied about by one provider on every read: refused, never priced
const lies: [string, Edit, RegExp][] = [
  ["another coin as token 0", onPool((d) => d.set(base58.decode(SOLANA_SOL_MINT), 73)), /static bytes differ/],
  ["another vault", onPool((d) => d.set(base58.decode(V.mint), 169)), /static bytes differ/],
  ["swaps switched off", onPool((d) => void (d[389] = d[389]! | 16)), /static bytes differ/],
  ["the price 5% up", onPool((d) => { const v = new DataView(d.buffer, d.byteOffset); const s = v.getBigUint64(253, true) + (v.getBigUint64(261, true) << 64n); const t = (s * 1025n) / 1000n; v.setBigUint64(253, t & (2n ** 64n - 1n), true); v.setBigUint64(261, t >> 64n, true); }), /price is outside the band/],
  ["the SOL vault 5% up", onVault(1, (d) => setU64(d, 64, (getU64(d, 64) * 105n) / 100n)), /SOL vault is outside the band/],
  ["a vault of another owner", onVault(1, (d) => d.set(base58.decode(V.mint), 32)), /another mint or owner/],
  ["a vault of another mint", onVault(0, (d) => d.set(base58.decode(SOLANA_SOL_MINT), 0)), /another mint or owner/],
  ["a vault not a token account", onVault(1, (_d, a) => void (a.owner = SOLANA_CLMM_PROGRAM)), /not a token account/],
];
for (const [name, lie, why] of lies) {
  test(`CL3 a provider that lies about ${name} on every read: refused after one read more`, async () => {
    const calls: string[][] = [];
    for (const liar of ["A", "B"] as const) {
      const ps = [replay("A", liar === "A" ? lie : undefined, calls), replay("B", liar === "B" ? lie : undefined)] as const;
      const r = await readSolanaClmmSpot(ps, req);
      assert.equal(r.kind, "bad", `${liar} lying: ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
      if (r.kind === "bad") assert.match(r.why, why);
    }
    // two rounds of a pool read then the pool's own list, per provider, per liar
    assert.equal(calls.length, 8);
  });
}

test("CL4 a lie inside the band is priced on each provider's own read; the judge never mixes them", async () => {
  const r = await readSolanaClmmSpot([replay("A", onVault(1, (d) => setU64(d, 64, (getU64(d, 64) * 101n) / 100n))), replay("B")], req);
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") assert.ok(r.spot.depth[0] > r.spot.depth[1]);
});

test("CL5 a provider that lies once is read again, and the pool is agreed", async () => {
  let n = 0;
  const once: Edit = (ans, list) => (list.length === 3 && n++ === 0 ? onVault(1, (d) => setU64(d, 64, 1n))(ans, list) : ans);
  const r = await readSolanaClmmSpot([replay("A", once), replay("B")], req);
  assert.equal(r.kind, "ok");
});

test("CL6 no market: no account on both, a pool of another coin, an account of another program on both", async () => {
  const gone: Edit = (ans) => ({ ...ans, value: ans.value.map(() => null) });
  assert.deepEqual(await readSolanaClmmSpot([replay("A", gone), replay("B", gone)], req), { kind: "none" });
  assert.deepEqual(await readSolanaClmmSpot([replay("A"), replay("B")], { ...req, token: SOLANA_SOL_MINT }), { kind: "none" });
  assert.deepEqual(await readSolanaClmmSpot([replay("A"), replay("B")], { ...req, token: USDC }), { kind: "none" });
  const other: Edit = (ans, list) => { const a = ans.value[list.indexOf(V.pool)]; if (a) a.owner = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"; return ans; };
  assert.deepEqual(await readSolanaClmmSpot([replay("A", other), replay("B", other)], req), { kind: "none" });
  const off = onPool((d) => void (d[389] = d[389]! | 16));
  assert.deepEqual(await readSolanaClmmSpot([replay("A", off), replay("B", off)], req), { kind: "none" });
});

test("CL7 one provider's fault or a malformed answer is no answer: refused with the fault named, never priced", async () => {
  const dead = Object.assign((async () => { throw Object.assign(new Error("HTTP 429 at https://a.example/?key=SECRET"), { status: 429 }); }) as SolanaRpc, { url: "https://a.example" });
  const r = await readSolanaClmmSpot([dead, replay("B")], req);
  assert.equal(r.kind, "bad");
  if (r.kind === "bad") { assert.match(r.why, /provider A gave no answer/); assert.doesNotMatch(r.why, /SECRET|example/); }
  const junk: Edit = () => ({ context: { slot: -1 }, value: [] }) as unknown as Answer;
  const j = await readSolanaClmmSpot([replay("A"), replay("B", junk)], req);
  assert.equal(j.kind, "bad");
});

test("CL8 the request is checked: two providers that are one, a bad side, amount or address throw", async () => {
  const a = replay("A");
  await assert.rejects(readSolanaClmmSpot([a, a], req), /same provider/);
  await assert.rejects(readSolanaClmmSpot([replay("A"), replay("B")], { ...req, amount: 0n }), /positive u64/);
  await assert.rejects(readSolanaClmmSpot([replay("A"), replay("B")], { ...req, amount: 1n << 64n }), /positive u64/);
  await assert.rejects(readSolanaClmmSpot([replay("A"), replay("B")], { ...req, side: "swap" as "buy" }), /side/);
  await assert.rejects(readSolanaClmmSpot([replay("A"), replay("B")], { ...req, pool: "short" }));
});
