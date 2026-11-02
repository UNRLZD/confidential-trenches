// Card sol-pool-buy-tx: the shared setup of the pool buy's tests (solana-pool-buy.test.ts, solana-pool-buy-attacks.test.ts).
// Replays the two providers' reads recorded in the LiteSVM run (test/svm/pool-buy.svm.mjs, on copies of mainnet's
// pump and PumpSwap programs and accounts), the Rent sysvar as both providers answered it, and the pool fixture's real
// release proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58 } from "@scure/base";
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
export const SPEND = 5_000_000n;
export const BLOCKHASH = base58.encode(new Uint8Array(32).fill(7));
export const TIP = 10_000n;

export async function setup(v: "pump" | "pumpswap" = "pump", spend = SPEND) {
  const kind = v === "pump" ? "pump-curve" : "pumpswap";
  const mint = fx[v].mint as string;
  const venue = await readSolanaPoolBuyVenue(providers(v), kind, mint, () => 2);
  const ref = await readSolanaReference(providers(v), { side: "buy", token: mint, amount: spend });
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
  const req: SolanaPoolBuyRequest = { wallet: W, feePayer: FEE_PAYER, token: mint, spend, minOut, tip: TIP, cuPrice: 100_000n };
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
