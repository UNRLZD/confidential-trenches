// Card sol-pool-buy-tx: the shared setup of the pool buy's tests (solana-pool-buy.test.ts, solana-pool-buy-attacks.test.ts).
// Replays the two providers' reads recorded in the LiteSVM run (test/svm/pool-buy.svm.mjs, on copies of mainnet's
// pump and PumpSwap programs and accounts), the Rent sysvar as both providers answered it, and the pool fixture's real
// release proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import { solanaPoolAddresses } from "../src/trade/solana/pool.ts";
import { readSolanaDlmmBuyVenue, readSolanaRaydiumBuyVenue } from "../src/trade/solana/pool-buy.ts";
import {
  readSolanaPoolBuyVenue,
  readSolanaReference,
  solanaDecodeLookupTable,
  solanaPoolBuyTableAccounts,
  solanaPoolPages,
  solanaRentOf,
  type SolanaPoolBuyChain,
  type SolanaPoolBuyReads,
  type SolanaPoolBuyRequest,
  type SolanaPoolRelease,
  type SolanaRpc,
} from "../src/index.ts";

export const fx = JSON.parse(readFileSync(new URL("./fixtures/solana-pool-buy.json", import.meta.url), "utf8"));
// The recorded curve holds 12,589,928 lamports of real SOL (bytes 32..40), what its 450,106 sold tokens paid, and the
// sales of the tests on it sell more (4,000,000 tokens W is planted holding), which that curve could not pay: the kit's
// sell quote pays nothing past a curve's real SOL (card sol-pool-buys-mayhem-coins). Every read of it here holds its
// real SOL at its virtual SOL (bytes 16..24), more than the gross of any sale, so each sale is priced by the curve's
// formula as before; the fixture file keeps the recorded bytes
const CURVE = solanaPoolAddresses(fx.pump.mint).curve;
for (const reads of fx.pump.reads as Record<string, { value: ({ data: [string, string] } | null)[] }>[]) {
  for (const [k, ans] of Object.entries(reads)) {
    const a = ans.value[(JSON.parse(k) as string[]).indexOf(CURVE)];
    if (!a) continue;
    const d = base64.decode(a.data[0]);
    const dv = new DataView(d.buffer, d.byteOffset);
    dv.setBigUint64(32, dv.getBigUint64(16, true), true);
    a.data[0] = base64.encode(d);
  }
}
export const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const key = (h: string): string => base58.encode(unhex(h));
export const PROGRAM = key(fx.program);
export const POOL = key(fx.pool);
export const W = key(fx.w);
export const FEE_PAYER = key(fx.fee_payer);
export const ALT = "AddressLookupTab1e1111111111111111111111111";
export const cfg = { program: PROGRAM, pool: POOL };
const r = fx.release;
export const release: SolanaPoolRelease = {
  proof: unhex(r.proof), newCommitmentHash: unhex(r.new_commitment), existingNullifierHash: unhex(r.nullifier_hash),
  withdrawnValue: BigInt(r.withdrawn), stateRootIndex: r.state_root_index, stateTreeDepth: r.state_depth,
  labelRootIndex: r.label_root_index, labelTreeDepth: r.label_depth, relayFee: 2_000_000n,
  relayFeeCap: BigInt(fx.relay_fee_cap), tipCap: BigInt(fx.tip_cap), deadlineMs: BigInt(fx.deadline_ms), salt: unhex(r.salt),
};
export const rent = solanaRentOf({ owner: fx.rent.answers[0].owner, data: Uint8Array.from(Buffer.from(fx.rent.answers[0].data, "base64")) });
// a provider that answers getMultipleAccounts from the run's recorded reads
export const replay = (rec: { reads: Record<string, unknown>[] }, p: 0 | 1, edit?: (list: string[], ans: any) => any): SolanaRpc =>
  (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    const k = JSON.stringify(params[0]);
    const ans = rec.reads[p]![k];
    assert.ok(ans, `no recorded read of ${k}`);
    const copy = structuredClone(ans);
    return edit ? edit(params[0] as string[], copy) : copy;
  }) as SolanaRpc;
export const providers = (v: "pump" | "pumpswap") => [replay(fx[v], 0), replay(fx[v], 1)] as const;
// NEARKAT's DLMM pair B8BH6ZKr… as two mainnet providers answered it (test/vectors/nearkat-dlmm.json, solana-dlmm.test.ts)
export const dlmmVector = JSON.parse(readFileSync(new URL("./vectors/nearkat-dlmm.json", import.meta.url), "utf8")) as {
  mint: string; pair: string; providers: Record<string, { slot: number; accounts: Record<string, { owner: string; data: string } | null> }>;
};
export const dlmmReplay = (p: 0 | 1, edit: (addr: string, data: Uint8Array) => Uint8Array = (_a, d) => d): SolanaRpc => {
  const rec = Object.values(dlmmVector.providers)[p]!;
  return (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    return {
      context: { slot: rec.slot },
      value: (params[0] as string[]).map((a) => {
        const x = rec.accounts[a];
        return x ? { owner: x.owner, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(edit(a, base64.decode(x.data))), "base64"] } : null;
      }),
    };
  }) as SolanaRpc;
};
export const dlmmProviders = () => [dlmmReplay(0), dlmmReplay(1)] as const;
// HIGH's Raydium CPMM pool CqvMZmWD… and CzLSuj…'s Raydium AMM v4 pool 9Tb2ohu5… as two mainnet providers answered them,
// with the program's own out on mainnet simulation (test/vectors/high-cpmm.json and czlsuj-amm-v4.json, recorded by
// solana-raydium.test.ts's note)
export type RaydiumVector = {
  kind: "raydium-cpmm" | "raydium-amm-v4"; mint: string; pool: string; sellAmount: string;
  providers: Record<string, { slot: number; accounts: Record<string, { owner: string; data: string } | null> }>;
  programOut: Record<string, { E: string; atE: { err: unknown; units: number; program: { received: string } }; atE1: { err: unknown } }>;
};
const vec = (f: string) => JSON.parse(readFileSync(new URL(`./vectors/${f}`, import.meta.url), "utf8")) as RaydiumVector;
export const raydiumVectors = { "raydium-cpmm": vec("high-cpmm.json"), "raydium-amm-v4": vec("czlsuj-amm-v4.json") } as const;
/** A provider that answers getMultipleAccounts from a vector's recorded accounts (any other address: no account). */
export const vectorReplay = (v: { providers: RaydiumVector["providers"] }, p: 0 | 1, edit: (addr: string, data: Uint8Array) => Uint8Array = (_a, d) => d): SolanaRpc => {
  const rec = Object.values(v.providers)[p]!;
  return (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    return {
      context: { slot: rec.slot },
      value: (params[0] as string[]).map((a) => {
        const x = rec.accounts[a];
        return x ? { owner: x.owner, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(edit(a, base64.decode(x.data))), "base64"] } : null;
      }),
    };
  }) as SolanaRpc;
};
export const raydiumProviders = (k: "raydium-cpmm" | "raydium-amm-v4", edit?: (addr: string, data: Uint8Array) => Uint8Array) => [vectorReplay(raydiumVectors[k], 0, edit), vectorReplay(raydiumVectors[k], 1, edit)] as const;
/** The reference request field a Raydium kind's pools go in. */
export const raydiumField = (k: "raydium-cpmm" | "raydium-amm-v4") => (k === "raydium-cpmm" ? "cpmmPools" : "ammV4Pools");
export const SPEND = 5_000_000n;
export const BLOCKHASH = base58.encode(new Uint8Array(32).fill(7));
export const TIP = 10_000n;

export async function setup(v: "pump" | "pumpswap" | "dlmm" | "raydium-cpmm" | "raydium-amm-v4" = "pump", spend = SPEND) {
  const kind = v === "pump" ? "pump-curve" : v;
  const ray = v === "raydium-cpmm" || v === "raydium-amm-v4" ? raydiumVectors[v] : null;
  const mint = v === "dlmm" ? dlmmVector.mint : ray ? ray.mint : (fx[v as "pump" | "pumpswap"].mint as string);
  const venue = v === "dlmm" ? await readSolanaDlmmBuyVenue(dlmmProviders(), mint, dlmmVector.pair, "buy")
    : ray ? await readSolanaRaydiumBuyVenue(raydiumProviders(ray.kind), ray.kind, mint, ray.pool)
    : await readSolanaPoolBuyVenue(providers(v as "pump" | "pumpswap"), kind, mint, () => 2);
  const ref = v === "dlmm"
    ? await readSolanaReference(dlmmProviders(), { side: "buy", token: mint, amount: spend, dlmmPairs: [dlmmVector.pair] })
    : ray ? await readSolanaReference(raydiumProviders(ray.kind), { side: "buy", token: mint, amount: spend, [raydiumField(ray.kind)]: [ray.pool] })
    : await readSolanaReference(providers(v as "pump" | "pumpswap"), { side: "buy", token: mint, amount: spend });
  assert.ok(ref && ref.slot !== undefined);
  const E = ref.pools.find((p) => p.venue === kind)!.expectedOut;
  const minOut = (E * 9_700n) / 10_000n;
  const addresses = solanaPoolBuyTableAccounts(cfg, venue, solanaPoolPages(PROGRAM, 7, 6));
  const tableAddr = base58.encode(new Uint8Array(32).fill(9));
  const meta = new Uint8Array(56);
  const dv = new DataView(meta.buffer);
  dv.setUint32(0, 1, true);
  dv.setBigUint64(4, (1n << 64n) - 1n, true);
  const tableData = Uint8Array.from([...meta, ...addresses.flatMap((k) => [...base58.decode(k)])]);
  const table = solanaDecodeLookupTable(tableData);
  const req: SolanaPoolBuyRequest = { wallet: W, feePayer: FEE_PAYER, token: mint, spend, minOut, tip: TIP, cuPrice: 100_000n, cluster: "mainnet" };
  const chain: SolanaPoolBuyChain = { blockhash: BLOCKHASH, lastValidBlockHeight: 100, table: { address: tableAddr, table }, stateSize: 6, rent };
  const reads: SolanaPoolBuyReads = {
    blockhash: BLOCKHASH, slot: ref.slot + 2, stateSize: 6, rent,
    tables: { [tableAddr]: [{ owner: ALT, data: tableData }, { owner: ALT, data: tableData }] },
    reference: { amount: spend, ref, slippageBps: 300 },
  };
  return { venue, ref, E, minOut, req, chain, reads, tableData, tableAddr, addresses, table };
}

/** Two zeroed signature slots, then the message. */
export const wireOf = (message: Uint8Array): Uint8Array => {
  const w = new Uint8Array(1 + 128 + message.length);
  w[0] = 2;
  w.set(message, 129);
  return w;
};
