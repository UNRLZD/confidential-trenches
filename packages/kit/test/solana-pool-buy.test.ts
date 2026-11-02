// Card sol-pool-buy-tx: the one transaction W signs to release a chunk from the Solana pool and buy (src/trade/solana/
// pool-buy.ts). Replays the two providers' reads recorded in the LiteSVM run (test/svm/pool-buy.svm.mjs, which landed
// shape A on a copy of mainnet's pump program and accounts) and the pool fixture's real release proof.
//   node --test test/solana-pool-buy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58 } from "@scure/base";
import {
  SOLANA_JITO_TIP_ACCOUNTS,
  SOLANA_POOL_RELEASE_LEN,
  buildSolanaPoolBuy,
  buildSolanaPoolBuyTag3,
  checkSolanaPoolBuy,
  readSolanaPoolBuyVenue,
  readSolanaReference,
  solanaCompileV0,
  solanaDecodeLookupTable,
  solanaDecodePoolRelease,
  solanaEncodePoolRelease,
  solanaPoolAccount,
  solanaPoolBuyInstructions,
  solanaPoolBuyTableAccounts,
  solanaPoolPage,
  solanaPoolPages,
  solanaPoolReleaseAccounts,
  solanaPoolSpentMark,
  solanaProgramAddress,
  type SolanaPoolBuyRequest,
  type SolanaPoolBuyVenue,
  type SolanaPoolRelease,
  type SolanaRpc,
} from "../src/index.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/solana-pool-buy.json", import.meta.url), "utf8"));
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const key = (h: string): string => base58.encode(unhex(h));
const PROGRAM = key(fx.program);
const POOL = key(fx.pool);
const W = key(fx.w);
const FEE_PAYER = key(fx.fee_payer);
const ALT = "AddressLookupTab1e1111111111111111111111111";
const cfg = { program: PROGRAM, pool: POOL };
const r = fx.release;
const release: SolanaPoolRelease = {
  proof: unhex(r.proof), newCommitmentHash: unhex(r.new_commitment), existingNullifierHash: unhex(r.nullifier_hash),
  withdrawnValue: BigInt(r.withdrawn), stateRootIndex: r.state_root_index, stateTreeDepth: r.state_depth,
  labelRootIndex: r.label_root_index, labelTreeDepth: r.label_depth, relayFee: 2_000_000n,
  relayFeeCap: BigInt(fx.relay_fee_cap), tipCap: BigInt(fx.tip_cap), deadlineMs: BigInt(fx.deadline_ms), salt: unhex(r.salt),
};
// a provider that answers getMultipleAccounts from the run's recorded reads
const replay = (rec: { reads: Record<string, unknown>[] }, p: 0 | 1, edit?: (list: string[], ans: any) => any): SolanaRpc =>
  (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    const k = JSON.stringify(params[0]);
    const ans = rec.reads[p]![k];
    assert.ok(ans, `no recorded read of ${k}`);
    const copy = structuredClone(ans);
    return edit ? edit(params[0] as string[], copy) : copy;
  }) as SolanaRpc;
const providers = (v: "pump" | "pumpswap") => [replay(fx[v], 0), replay(fx[v], 1)] as const;
const SPEND = 5_000_000n;
const BLOCKHASH = base58.encode(new Uint8Array(32).fill(7));

async function setup(v: "pump" | "pumpswap") {
  const kind = v === "pump" ? "pump-curve" : "pumpswap";
  const mint = fx[v].mint as string;
  const venue = await readSolanaPoolBuyVenue(providers(v), kind, mint, () => 2);
  const ref = await readSolanaReference(providers(v), { side: "buy", token: mint, amount: SPEND });
  const E = ref!.pools.find((p) => p.venue === kind)!.expectedOut;
  const minOut = (E * 9_700n) / 10_000n;
  const addresses = solanaPoolBuyTableAccounts(cfg, venue, solanaPoolPages(PROGRAM, 7, 6));
  const tableAddr = base58.encode(new Uint8Array(32).fill(9));
  const meta = new Uint8Array(56);
  const dv = new DataView(meta.buffer);
  dv.setUint32(0, 1, true);
  dv.setBigUint64(4, (1n << 64n) - 1n, true);
  const tableData = Uint8Array.from([...meta, ...addresses.flatMap((k) => [...base58.decode(k)])]);
  const table = solanaDecodeLookupTable(tableData);
  const req: SolanaPoolBuyRequest = { wallet: W, feePayer: FEE_PAYER, token: mint, spend: SPEND, minOut, tip: 10_000n, cuPrice: 100_000n };
  const chain = { blockhash: BLOCKHASH, lastValidBlockHeight: 100, table: { address: tableAddr, table }, stateSize: 6 };
  const reads = { tables: { [tableAddr]: [{ owner: ALT, data: tableData }, { owner: ALT, data: tableData }] as const }, stateSize: 6, reference: { amount: SPEND, ref, slippageBps: 300 } };
  return { venue, ref, E, minOut, req, chain, reads, tableData, tableAddr };
}

test("tag 2 is release.rs's 387 bytes: the proof, then each field in order, little-endian integers", () => {
  const d = solanaEncodePoolRelease(release);
  assert.equal(d.length, SOLANA_POOL_RELEASE_LEN);
  assert.equal(d[0], 2);
  assert.deepEqual(d.subarray(1, 257), release.proof);
  assert.deepEqual(d.subarray(257, 289), release.newCommitmentHash);
  assert.deepEqual(d.subarray(289, 321), release.existingNullifierHash);
  const v = new DataView(d.buffer);
  assert.equal(v.getBigUint64(321, true), 15_000_000n);
  assert.equal(v.getUint32(329, true), 5); // state root index
  assert.equal(d[333], release.stateTreeDepth);
  assert.equal(v.getUint32(334, true), 5); // label root index
  assert.equal(d[338], release.labelTreeDepth);
  assert.equal(v.getBigUint64(339, true), 2_000_000n); // relay fee
  assert.equal(v.getBigUint64(347, true), 2_500_000n); // relay fee cap
  assert.equal(v.getBigUint64(355, true), 1_000_000n); // tip cap
  assert.equal(v.getBigUint64(363, true), 4_102_444_800_000n); // deadline
  assert.deepEqual(d.subarray(371, 387), release.salt);
  assert.deepEqual(solanaDecodePoolRelease(d), release);
});

test("a release the pool would refuse is refused before it is built", () => {
  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const pBytes = unhex(P.toString(16).padStart(64, "0"));
  assert.throws(() => solanaEncodePoolRelease({ ...release, existingNullifierHash: pBytes }), /field element/);
  assert.throws(() => solanaEncodePoolRelease({ ...release, stateTreeDepth: 33 }), /at most 32/);
  assert.throws(() => solanaEncodePoolRelease({ ...release, relayFee: release.relayFeeCap + 1n }), /over its cap/);
  assert.throws(() => solanaEncodePoolRelease({ ...release, withdrawnValue: 0n }), /not be 0/);
  assert.throws(() => solanaEncodePoolRelease({ ...release, proof: release.proof.subarray(0, 128) }), /256 bytes/);
});

test("the release's accounts: the fixture's pool PDA, W and the fee payer signing, the nullifier's spent mark, the pages", () => {
  assert.equal(solanaPoolAccount(PROGRAM), POOL);
  const a = solanaPoolReleaseAccounts(cfg, W, FEE_PAYER, release, 1024);
  assert.deepEqual(a.map((x) => [x.signer, x.writable]), [[false, true], [true, true], [true, true], [false, true], [false, false], [false, false], [false, true], [false, false]]);
  assert.equal(a[3]!.key, solanaPoolSpentMark(PROGRAM, release.existingNullifierHash));
  assert.equal(a[4]!.key, solanaPoolPage(PROGRAM, 0, 5));
  assert.equal(a[5]!.key, solanaPoolPage(PROGRAM, 1, 5));
  // entry 1,024 opens page 1 of the state tree: ["page", 0, 1 as u32 LE]
  assert.equal(a[6]!.key, solanaProgramAddress([new TextEncoder().encode("page"), Uint8Array.of(0), Uint8Array.of(1, 0, 0, 0)], PROGRAM));
  assert.notEqual(a[6]!.key, a[4]!.key);
});

test("pump's buy carries the bonding-curve-v2 PDA and one of Global's buyback recipients (mainnet code refuses it without: 6062)", async () => {
  const { venue, req } = await setup("pump");
  assert.equal(venue.kind, "pump-curve");
  const ixs = solanaPoolBuyInstructions(cfg, release, venue, req, 6, null);
  const buy = ixs.find((x) => x.program === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")!;
  assert.equal(buy.accounts.length, 18);
  assert.equal(buy.accounts[16]!.key, solanaProgramAddress([new TextEncoder().encode("bonding-curve-v2"), base58.decode(req.token)], "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"));
  assert.ok(venue.buybackFeeRecipients.includes(buy.accounts[17]!.key) && buy.accounts[17]!.writable);
  assert.equal(buy.accounts[6]!.key, W);
  assert.ok(buy.accounts[6]!.signer);
});

test("the venue is read on both providers, and refused when they disagree", async () => {
  const { venue } = await setup("pump");
  const v = venue as Extract<SolanaPoolBuyVenue, { kind: "pump-curve" }>;
  assert.equal(v.feeRecipient, "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
  assert.equal(v.buybackFeeRecipient, v.buybackFeeRecipients[2]);
  // provider B names another creator in the curve
  const bent = replay(fx.pump, 1, (list, ans) => {
    const i = list.indexOf(v.curve);
    if (i >= 0 && ans.value[i]) {
      const d = Buffer.from(ans.value[i].data[0], "base64");
      d[49] = d[49]! ^ 1;
      ans.value[i].data[0] = d.toString("base64");
    }
    return ans;
  });
  await assert.rejects(readSolanaPoolBuyVenue([replay(fx.pump, 0), bent], "pump-curve", fx.pump.mint, () => 2), /disagree/);
});

test("size table: shapes A and B x pump and PumpSwap x raw and compressed proof x with and without tip", async () => {
  const rows: { shape: string; venue: string; proof: string; tip: string; bytes: number; fits: boolean }[] = [];
  for (const v of ["pump", "pumpswap"] as const) {
    const { venue, req, chain } = await setup(v);
    for (const tip of [0n, 10_000n]) {
      const rq = { ...req, tip };
      // shape A: tag 2 has the raw proof only
      const ixs = solanaPoolBuyInstructions(cfg, release, venue, rq, 6, tip > 0n ? SOLANA_JITO_TIP_ACCOUNTS[0]! : null);
      const a = 1 + 128 + solanaCompileV0(FEE_PAYER, ixs, BLOCKHASH, [chain.table], [FEE_PAYER, W]).message.length;
      rows.push({ shape: "A", venue: v, proof: "raw", tip: tip > 0n ? "yes" : "no", bytes: a, fits: a <= 1232 });
      for (const compressed of [false, true]) {
        const rel = compressed ? { ...release, proof: release.proof.subarray(0, 128) } : release;
        const b = buildSolanaPoolBuyTag3(cfg, rel, venue, rq, chain, { compressed, pick: () => 0 }).size;
        rows.push({ shape: "B", venue: v, proof: compressed ? "compressed" : "raw", tip: tip > 0n ? "yes" : "no", bytes: b, fits: b <= 1232 });
      }
    }
  }
  for (const x of rows) console.log(`size ${x.shape} ${x.venue.padEnd(8)} ${x.proof.padEnd(10)} tip ${x.tip.padEnd(3)} ${x.bytes} B ${x.fits ? "fits" : "OVER"}`);
  const at = (shape: string, venue: string, proof: string, tip: string) => rows.find((x) => x.shape === shape && x.venue === venue && x.proof === proof && x.tip === tip)!.bytes;
  // shape A lands on pump, with or without a tip; on PumpSwap it overflows either way (the wrap's programs and the venue
  // are static keys when invoked at the top level)
  assert.deepEqual([at("A", "pump", "raw", "no"), at("A", "pump", "raw", "yes")], [1138, 1187]);
  assert.deepEqual([at("A", "pumpswap", "raw", "no"), at("A", "pumpswap", "raw", "yes")], [1346, 1364]);
  // shape B (tag 3): pump fits with either proof; PumpSwap fits only with the compressed proof (TAG3.md)
  assert.deepEqual([at("B", "pump", "raw", "no"), at("B", "pump", "raw", "yes"), at("B", "pump", "compressed", "no"), at("B", "pump", "compressed", "yes")], [1105, 1107, 977, 979]);
  assert.deepEqual([at("B", "pumpswap", "raw", "no"), at("B", "pumpswap", "raw", "yes"), at("B", "pumpswap", "compressed", "no"), at("B", "pumpswap", "compressed", "yes")], [1262, 1264, 1134, 1136]);
});

test("the check passes the built transaction and names each check", async () => {
  const { venue, req, chain, reads } = await setup("pump");
  const built = buildSolanaPoolBuy(cfg, release, venue, req, chain, { pick: () => 3 });
  const v = checkSolanaPoolBuy(built.wire, cfg, release, venue, req, reads);
  assert.ok(v.ok, JSON.stringify(v.results));
  assert.deepEqual(v.results.map((x) => x.id), ["SIZE", "TABLES", "SIGNERS", "RELEASE", "BUY", "FRAME", "PRIVILEGES", "QUOTE"]);
});

test("the check refuses a changed min_out, a changed curve, a changed pool and a quote under the user's slippage", async () => {
  const { venue, req, chain, reads, minOut, E } = await setup("pump");
  const v = venue as Extract<SolanaPoolBuyVenue, { kind: "pump-curve" }>;
  const failed = (wire: Uint8Array, q = req, vv: SolanaPoolBuyVenue = venue, rd = reads) =>
    checkSolanaPoolBuy(wire, cfg, release, vv, q, rd).results.filter((x) => !x.ok).map((x) => x.id);
  // min_out lowered in the message (a server's edit): the device's own buy differs
  assert.deepEqual(failed(buildSolanaPoolBuy(cfg, release, venue, { ...req, minOut: minOut - 1n }, chain).wire), ["BUY"]);
  // another curve named in the message
  const bentCurve = { ...v, curve: base58.encode(new Uint8Array(32).fill(5)) };
  assert.ok(failed(buildSolanaPoolBuy(cfg, release, bentCurve, req, chain).wire).includes("BUY"));
  // a venue that names another curve than the one read on both providers: no reference for it
  assert.ok(failed(buildSolanaPoolBuy(cfg, release, bentCurve, req, chain).wire, req, bentCurve).includes("QUOTE"));
  // another Blindfill pool in the release
  const otherPool = { program: PROGRAM, pool: base58.encode(new Uint8Array(32).fill(6)) };
  const bentPool = solanaCompileV0(FEE_PAYER, solanaPoolBuyInstructions(cfg, release, venue, req, 6, SOLANA_JITO_TIP_ACCOUNTS[0]!).map((x, i) =>
    i === 2 ? { ...x, accounts: x.accounts.map((a, j) => (j === 0 ? { ...a, key: otherPool.pool } : a)) } : x), BLOCKHASH, [chain.table], [FEE_PAYER, W]).message;
  const wire = new Uint8Array(1 + 128 + bentPool.length);
  wire[0] = 2;
  wire.set(bentPool, 129);
  assert.ok(failed(wire).includes("RELEASE"));
  // the user's own min_out under E x (1 - slippage)
  const low = (E * 9_000n) / 10_000n;
  assert.deepEqual(failed(buildSolanaPoolBuy(cfg, release, venue, { ...req, minOut: low }, chain).wire, { ...req, minOut: low }), ["QUOTE"]);
  // a reference read for another amount than the spend
  assert.deepEqual(failed(buildSolanaPoolBuy(cfg, release, venue, req, chain).wire, req, venue, { ...reads, reference: { ...reads.reference, amount: SPEND + 1n } }), ["QUOTE"]);
});

test("the check refuses a table the providers disagree on, a third signer and a tip over the proof's cap", async () => {
  const { venue, req, chain, reads, tableData, tableAddr } = await setup("pump");
  const built = buildSolanaPoolBuy(cfg, release, venue, req, chain);
  const other = tableData.slice();
  other[56] = other[56]! ^ 1; // entry 0, the pool, differs on provider B
  const v1 = checkSolanaPoolBuy(built.wire, cfg, release, venue, req, { ...reads, tables: { [tableAddr]: [{ owner: ALT, data: tableData }, { owner: ALT, data: other }] } });
  assert.deepEqual(v1.results.filter((x) => !x.ok).map((x) => x.id), ["TABLES"]);
  // the request names another W than the one that signs the message
  const v2 = checkSolanaPoolBuy(built.wire, cfg, release, venue, { ...req, wallet: base58.encode(new Uint8Array(32).fill(8)) }, reads);
  assert.ok(!v2.ok && v2.results.some((x) => x.id === "SIGNERS" && !x.ok));
  assert.throws(() => buildSolanaPoolBuy(cfg, release, venue, { ...req, tip: release.tipCap + 1n }, chain), /tip cap/);
  assert.throws(() => buildSolanaPoolBuy(cfg, release, venue, { ...req, spend: release.withdrawnValue }, chain), /more than the chunk/);
});
