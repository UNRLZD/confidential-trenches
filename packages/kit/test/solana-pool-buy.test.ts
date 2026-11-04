// Card sol-pool-buy-tx: the one transaction W signs to release a chunk from the Solana pool and buy, as tag 3
// release-and-buy with the compressed proof (src/trade/solana/pool-buy.ts, contracts/pool-solana/TAG3.md). The setup
// (recorded reads of two providers, the Rent sysvar, the pool fixture's real proof) is solana-pool-buy-fx.ts; the
// review's attacks are solana-pool-buy-attacks.test.ts.
//   node --test test/solana-pool-buy.test.ts
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import {
  HELPER_V1_PATHS,
  SOLANA_JITO_TIP_ACCOUNTS,
  SOLANA_JITO_TIP_MIN,
  SOLANA_POOL_QUOTE_MAX_AGE_SLOTS,
  SOLANA_POOL_RELEASE_LEN,
  SOLANA_POOL_VOLUME_ACCOUNT_SIZE,
  SOLANA_PUMP_AMM_PROGRAM,
  SOLANA_PUMP_PROGRAM,
  buildSolanaPoolBuy,
  checkSolanaPoolBuy,
  readSolanaPoolBuyVenue,
  readSolanaReference,
  solanaCompressPoolProof,
  solanaDecodePoolRelease,
  solanaEncodePoolRelease,
  solanaPoolAccount,
  solanaPoolBuyFunds,
  solanaPoolBuyInstructions,
  solanaPoolBuySteps,
  solanaPoolReleaseCost, solanaPoolFee, solanaPoolPageReserve, solanaPoolPriorityBudget, SOLANA_POOL_SEND_MARGIN_MS, SOLANA_POOL_SPENT_MARK_LEN,
  readSolanaRent,
  solanaDecodeMessage,
  solanaDecodeLookupTable,
  solanaPoolSellMinOut,
  solanaPoolSellSteps,
  solanaPoolPage,
  solanaPoolReleaseAccounts,
  solanaPoolSpentMark,
  solanaProgramAddress,
  solanaRentMin,
  solanaRentOf,
  SOLANA_TOKEN_ACCOUNT_MAX_SIZE,
  solanaTokenAccountSize,
  type SolanaPoolBuyVenue,
  type SolanaRpc,
} from "../src/index.ts";
import { ALT, BLOCKHASH, FEE_PAYER, POOL, PROGRAM, SPEND, TIP, W, cfg, fx, providers, release, rent, replay, setup, unhex, wireOf } from "./solana-pool-buy-fx.ts";

const failed = (v: ReturnType<typeof checkSolanaPoolBuy>) => v.results.filter((x) => !x.ok).map((x) => x.id);
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const be = (b: Uint8Array): bigint => b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);
const pow = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  for (b %= Q; e > 0n; e >>= 1n, b = (b * b) % Q) if (e & 1n) r = (r * b) % Q;
  return r;
};

test("tag 2 is release.rs's 387 bytes: the proof, then each field in order, little-endian integers", () => {
  const d = solanaEncodePoolRelease(release);
  assert.equal(d.length, SOLANA_POOL_RELEASE_LEN);
  assert.equal(d[0], 2);
  assert.deepEqual(d.subarray(1, 257), release.proof);
  const v = new DataView(d.buffer);
  assert.equal(v.getBigUint64(321, true), 15_000_000n);
  assert.equal(v.getUint32(329, true), 5); // state root index
  assert.equal(v.getBigUint64(339, true), 2_000_000n); // relay fee
  assert.equal(v.getBigUint64(355, true), 1_000_000n); // tip cap
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
});

test("the release's accounts: the fixture's pool PDA, W and the fee payer signing, the nullifier's spent mark, the pages", () => {
  assert.equal(solanaPoolAccount(PROGRAM), cfg.pool);
  const a = solanaPoolReleaseAccounts(cfg, W, FEE_PAYER, release, 1024);
  assert.deepEqual(a.map((x) => [x.signer, x.writable]), [[false, true], [true, true], [true, true], [false, true], [false, false], [false, false], [false, true], [false, false]]);
  assert.equal(a[3]!.key, solanaPoolSpentMark(PROGRAM, release.existingNullifierHash));
  assert.equal(a[4]!.key, solanaPoolPage(PROGRAM, 0, 5));
  assert.equal(a[6]!.key, solanaProgramAddress([new TextEncoder().encode("page"), Uint8Array.of(0), Uint8Array.of(1, 0, 0, 0)], PROGRAM));
});

test("the compressed proof: A and C are x with y's sign in bit 7 and decompress to the proof's points; B is x.c1 x.c0", () => {
  const c = solanaCompressPoolProof(release.proof);
  assert.equal(c.length, 128);
  for (const [raw, comp] of [[0, 0], [192, 96]] as const) {
    const x = be(release.proof.subarray(raw, raw + 32));
    const y = be(release.proof.subarray(raw + 32, raw + 64));
    const cx = c.slice(comp, comp + 32);
    const neg = (cx[0]! & 0x80) !== 0;
    cx[0] = cx[0]! & 0x3f;
    assert.equal(be(cx), x);
    // decompress as solana-bn254 does: y = sqrt(x^3 + 3), the root above q - root when bit 7 is set
    const root = pow((x * x * x + 3n) % Q, (Q + 1n) / 4n);
    assert.equal((root * root) % Q, (x * x * x + 3n) % Q, "x is on the curve");
    const big = root > Q - root ? root : Q - root;
    assert.equal(neg ? big : Q - big, y);
  }
  const b = c.slice(32, 96);
  const neg = (b[0]! & 0x80) !== 0;
  b[0] = b[0]! & 0x3f;
  assert.deepEqual(b, release.proof.subarray(64, 128));
  const y1 = be(release.proof.subarray(128, 160));
  const y0 = be(release.proof.subarray(160, 192));
  assert.equal(neg, y1 !== 0n ? y1 > Q - y1 : y0 > Q - y0);
  assert.throws(() => solanaCompressPoolProof(new Uint8Array(256)), /infinity/);
  assert.throws(() => solanaCompressPoolProof(release.proof.subarray(0, 128)), /256 bytes/);
});

test("tag 3: CU limit, CU price and one instruction into the pool; tag, flags, compressed proof, tag 2's fields, tip, the inner steps", async () => {
  for (const v of ["pump", "pumpswap"] as const) {
    const { venue, req, chain } = await setup(v);
    const ixs = solanaPoolBuyInstructions(cfg, release, venue, req, 6, rent, SOLANA_JITO_TIP_ACCOUNTS[3]!);
    assert.equal(ixs.length, 3);
    const t = ixs[2]!;
    assert.equal(t.program, PROGRAM);
    assert.deepEqual([t.data[0], t.data[1]], [3, 1]);
    assert.deepEqual(t.data.subarray(2, 130), solanaCompressPoolProof(release.proof));
    assert.deepEqual(t.data.subarray(130, 260), solanaEncodePoolRelease(release).subarray(257));
    assert.equal(new DataView(t.data.buffer, t.data.byteOffset).getBigUint64(260, true), TIP);
    const steps = solanaPoolBuySteps(venue, W, SPEND, req.minOut);
    assert.equal(t.data[268], steps.length);
    assert.deepEqual(t.accounts.slice(0, 8), solanaPoolReleaseAccounts(cfg, W, FEE_PAYER, release, 6));
    assert.deepEqual(t.accounts[8], { key: SOLANA_JITO_TIP_ACCOUNTS[3], signer: false, writable: true });
    // the first inner step, read back: its program and accounts by index into tag 3's accounts, then its data
    const first = steps[0]!;
    assert.equal(t.accounts[t.data[269]!]!.key, first.program);
    assert.equal(t.data[270], first.accounts.length);
    assert.deepEqual(Array.from(t.data.subarray(271, 271 + first.accounts.length), (i) => t.accounts[i]!.key), first.accounts.map((a) => a.key));
    // without a tip there is no tip account and the tip is 0
    const none = solanaPoolBuyInstructions(cfg, release, venue, { ...req, tip: 0n, cluster: "devnet" }, 6, rent, null)[2]!;
    assert.equal(none.accounts.length, t.accounts.length - 1);
    assert.ok(!SOLANA_JITO_TIP_ACCOUNTS.includes(none.accounts[8]!.key));
    assert.throws(() => solanaPoolBuyInstructions(cfg, release, venue, req, 6, rent, FEE_PAYER), /not a Jito tip account/);
    assert.throws(() => solanaPoolBuyInstructions(cfg, release, venue, req, 6, rent, null), /tip account goes with a tip/);
    assert.ok(buildSolanaPoolBuy(cfg, release, venue, req, chain).size <= 1232);
  }
});

test("pump's buy carries the bonding-curve-v2 PDA and one of Global's buyback recipients (mainnet code refuses it without: 6062)", async () => {
  const { venue, req } = await setup("pump");
  const buy = solanaPoolBuySteps(venue, W, SPEND, req.minOut).find((x) => x.program === SOLANA_PUMP_PROGRAM)!;
  assert.equal(buy.accounts.length, 18);
  assert.equal(buy.accounts[16]!.key, solanaProgramAddress([new TextEncoder().encode("bonding-curve-v2"), base58.decode(req.token)], SOLANA_PUMP_PROGRAM));
  assert.ok(venue.buybackFeeRecipients.includes(buy.accounts[17]!.key) && buy.accounts[17]!.writable);
});

// @pump-fun/pump-sdk 4.3.1 src/idl/pump.json (sha256 c53b8f5d…6a01) buy_exact_sol_in and @pump-fun/pump-swap-sdk 2.2.0
// src/idl/pump_amm.json (sha256 c2f8ce0b…ce61) buy_exact_quote_in: each account's [signer, writable], in order
const IDL = {
  "pump-curve": [[0, 0], [0, 1], [0, 0], [0, 1], [0, 1], [0, 1], [1, 1], [0, 0], [0, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 1], [0, 0], [0, 0]],
  pumpswap: [[0, 1], [1, 1], [0, 0], [0, 0], [0, 0], [0, 1], [0, 1], [0, 1], [0, 1], [0, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 1], [0, 0], [0, 0], [0, 1], [0, 0], [0, 0]],
} as const;

test("both venues' buy accounts and flags are their IDL's, then the SDKs' remaining accounts", async () => {
  for (const v of ["pump", "pumpswap"] as const) {
    const { venue, req } = await setup(v);
    const buy = solanaPoolBuySteps(venue, W, SPEND, req.minOut).find((x) => x.program === (v === "pump" ? SOLANA_PUMP_PROGRAM : SOLANA_PUMP_AMM_PROGRAM))!;
    const idl = IDL[venue.kind];
    assert.deepEqual(buy.accounts.slice(0, idl.length).map((a) => [a.signer ? 1 : 0, a.writable ? 1 : 0]), idl.map((x) => [...x]), `${v}: the IDL's flags`);
    // remaining: pump bonding-curve-v2 (read-only), buyback recipient (writable); PumpSwap (not a cashback coin, a coin
    // creator set) pool-v2 (read-only), buyback recipient (read-only), its wSOL account (writable)
    const rest = buy.accounts.slice(idl.length).map((a) => [a.signer ? 1 : 0, a.writable ? 1 : 0]);
    assert.deepEqual(rest, v === "pump" ? [[0, 0], [0, 1]] : [[0, 0], [0, 0], [0, 1]]);
    assert.equal(buy.accounts[v === "pump" ? 6 : 1]!.key, W);
  }
});

test("the venue is read on both providers at confirmed, and refused when they disagree", async () => {
  const { venue } = await setup("pump");
  const v = venue as Extract<SolanaPoolBuyVenue, { kind: "pump-curve" }>;
  assert.equal(v.feeRecipient, "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
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
  // every read the venue and the reference make asks for `confirmed`
  const seen: unknown[] = [];
  const spy = (p: 0 | 1): SolanaRpc => (async (m: string, params: readonly unknown[]) => { seen.push((params[1] as { commitment?: string }).commitment); return replay(fx.pump, p)(m, params); }) as SolanaRpc;
  await readSolanaPoolBuyVenue([spy(0), spy(1)], "pump-curve", fx.pump.mint, () => 2);
  await readSolanaReference([spy(0), spy(1)], { side: "buy", token: fx.pump.mint, amount: SPEND });
  assert.ok(seen.length >= 4 && seen.every((c) => c === "confirmed"), JSON.stringify(seen));
});

// The eight buyback recipients pump's Global (at 741) and PumpSwap's GlobalConfig (at 643) both list, read on two
// providers 2026-11-02 21:00Z; the same eight @pump-fun/pump-sdk 4.3.1 CURRENT_FEE_RECIPIENTS_FOR_BUYBACK lists.
const BUYBACK = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD", "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7", "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR", "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6", "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD", "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
];

test("Global is exactly 1,088 bytes and GlobalConfig 949, and both list the same eight buyback recipients", async () => {
  for (const v of ["pump", "pumpswap"] as const) {
    const kind = v === "pump" ? "pump-curve" : "pumpswap";
    const venue = await readSolanaPoolBuyVenue(providers(v), kind, fx[v].mint, () => 0);
    assert.deepEqual(venue.buybackFeeRecipients, BUYBACK, v);
    // a Global one byte longer or shorter on both providers (a layout change) is refused
    for (const delta of [1, -1]) {
      const resized = (p: 0 | 1) => replay(fx[v], p, (_list, ans) => {
        const d = Buffer.from(ans.value[2].data[0], "base64");
        ans.value[2].data[0] = (delta > 0 ? Buffer.concat([d, Buffer.alloc(1)]) : d.subarray(0, d.length - 1)).toString("base64");
        return ans;
      });
      await assert.rejects(readSolanaPoolBuyVenue([resized(0), resized(1)], kind, fx[v].mint, () => 0), /bytes, not/, `${v} ${delta}`);
    }
  }
});

test("rent is read from the sysvar (5,080 a byte on 2 Nov), and a token account's size from its mint", async () => {
  assert.deepEqual(rent, { lamportsPerByte: 5_080n, factor: 1n });
  assert.equal(solanaRentMin(rent, 0), 650_240n);
  assert.equal(solanaRentMin({ lamportsPerByte: 3_480n, factor: 2n }, 165), 2_039_280n); // the pre-SIMD-0194 figure
  const raw = Uint8Array.from(Buffer.from(fx.rent.answers[0].data, "base64"));
  assert.throws(() => solanaRentOf({ owner: ALT, data: raw }), /not the Rent sysvar/);
  const odd = raw.slice();
  new DataView(odd.buffer).setFloat64(8, 1.5, true);
  assert.throws(() => solanaRentOf({ owner: "Sysvar1111111111111111111111111111111111111", data: odd }), /factor/);
  // the recorded pump mint is Token-2022 with MetadataPointer and TokenMetadata: 165 + 1 + ImmutableOwner's head
  const { venue } = await setup("pump");
  assert.equal(venue.tokenAccountSize, 170);
  const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const mint = (ext: number[][]) => Uint8Array.from([...new Uint8Array(165), 1, ...ext.flatMap(([t, n]) => [t! & 0xff, t! >> 8, n! & 0xff, n! >> 8, ...new Uint8Array(n!)])]);
  assert.equal(solanaTokenAccountSize({ owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: new Uint8Array(82) }), 165);
  assert.equal(solanaTokenAccountSize({ owner: T22, data: new Uint8Array(82) }), 170);
  assert.equal(solanaTokenAccountSize({ owner: T22, data: mint([[1, 108], [18, 64]]) }), 182); // TransferFeeConfig adds TransferFeeAmount
  assert.equal(solanaTokenAccountSize({ owner: T22, data: mint([[14, 64]]) }), 175); // TransferHook adds TransferHookAccount
  assert.throws(() => solanaTokenAccountSize({ owner: T22, data: mint([[99, 4]]) }), /not known/);
  assert.throws(() => solanaTokenAccountSize({ owner: T22, data: mint([[18, 64]]).subarray(0, 200) }), /runs past/);
});

test("Token-2022: a mint that lists one extension type twice is refused, so no forged mint sizes W's account past the largest", () => {
  const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const mint = (ext: number[][]) => Uint8Array.from([...new Uint8Array(165), 1, ...ext.flatMap(([t, n]) => [t! & 0xff, t! >> 8, n! & 0xff, n! >> 8, ...new Uint8Array(n!)])]);
  // each of the four extensions that grow W's account, once: the largest size, SOLANA_TOKEN_ACCOUNT_MAX_SIZE
  const once = [[1, 108], [9, 0], [14, 64], [26, 0]];
  assert.equal(solanaTokenAccountSize({ owner: T22, data: mint(once) }), SOLANA_TOKEN_ACCOUNT_MAX_SIZE);
  // any type twice, one that grows W's account or a mint-only one (TokenMetadata, 19)
  const all = [...once, [19, 64]];
  for (const [t, n] of all) assert.throws(() => solanaTokenAccountSize({ owner: T22, data: mint([...all, [t!, n!]]) }), new RegExp(`lists extension ${t} twice`), `type ${t}`);
});

test("a chunk too small to land is refused: W's token account, the volume account, the wrapped SOL at its peak, W's floor", async () => {
  const chunk = release.withdrawnValue - release.relayFee - TIP;
  for (const v of ["pump", "pumpswap"] as const) {
    const { venue } = await setup(v);
    const ata = solanaRentMin(rent, venue.tokenAccountSize);
    const vol = solanaRentMin(rent, SOLANA_POOL_VOLUME_ACCOUNT_SIZE[venue.kind]);
    const wsol = v === "pumpswap" ? solanaRentMin(rent, 165) : 0n;
    const at = (spend: bigint) => solanaPoolBuyFunds(release, venue, { spend, tip: TIP }, rent);
    // the review's GAP-2: the spend takes the whole chunk, nothing for W's accounts
    assert.match(at(chunk).problem ?? "", /does not cover/);
    // the review's GAP-3: W would keep 1 lamport (on PumpSwap the wrapped SOL account's rent is not there at the peak)
    assert.match(at(chunk - ata - vol - 1n).problem ?? "", v === "pump" ? /under the 655240 its sell needs up front/ : /does not cover/);
    // W keeps exactly 0 (pump) or the wrapped SOL's rent (PumpSwap), the old max spend: refused, its sell could never
    // pay the fee and, on PumpSwap, the wrapped SOL account it makes first (the review of signpage-pool-sell 4b6223a)
    assert.match(at(chunk - ata - vol).problem ?? "", v === "pump" ? /W would keep 0 lamports, under the 655240/ : /does not cover/);
    assert.notEqual(at(chunk - ata - vol - wsol).problem, null);
    // W keeps rent(0) only: after the sell's fee it would hold less than rent(0), refused
    assert.match(at(chunk - ata - vol - 650_240n).problem ?? "", v === "pump" ? /its sell needs up front/ : /does not cover/);
    // W keeps the sell's fee and the rent of what it makes before proceeds arrive: lands
    const need = 5_000n + (v === "pumpswap" ? wsol : 650_240n);
    assert.equal(at(chunk - ata - vol - need).problem, null);
    assert.equal(at(chunk - ata - vol - need).left, need);
    assert.match(solanaPoolBuyFunds(release, venue, { spend: 1n, tip: release.withdrawnValue }, rent).problem ?? "", /more than the release/);
  }
});

test("size table: tag 3 with the compressed proof, pump and PumpSwap, with and without a tip, cashback on and off", async () => {
  const rows: string[] = [];
  const sizes: Record<string, number> = {};
  for (const v of ["pump", "pumpswap"] as const) {
    const { venue, req, chain } = await setup(v);
    for (const cashback of [false, true])
      for (const tip of [0n, TIP]) {
        const ven = { ...venue, cashback } as SolanaPoolBuyVenue;
        const b = buildSolanaPoolBuy(cfg, release, ven, { ...req, tip, cluster: tip > 0n ? "mainnet" : "devnet" }, chain, { pick: () => 0 }).size;
        sizes[`${v}${cashback ? " cashback" : ""} ${tip > 0n ? "tip" : "none"}`] = b;
        rows.push(`size tag3 ${v.padEnd(8)} cashback ${cashback ? "yes" : "no "} compressed tip ${tip > 0n ? "yes" : "no "} ${b} B`);
      }
  }
  console.log(rows.join("\n"));
  // with a tip, the tip account is a static key (32 B) instead of a table index (1 B): M362 (4); the largest, PumpSwap on
  // a cashback coin with a tip, is 1,201 B against 1,232 (M369 (L2))
  assert.deepEqual(sizes, {
    "pump none": 977, "pump tip": 1010, "pump cashback none": 977, "pump cashback tip": 1010,
    "pumpswap none": 1134, "pumpswap tip": 1167, "pumpswap cashback none": 1168, "pumpswap cashback tip": 1201,
  });
});

test("M369 (L2): a mainnet pool buy tips at least Jito's minimum; devnet may tip nothing; the check refuses the same", async () => {
  assert.equal(SOLANA_JITO_TIP_MIN, 1_000n);
  for (const v of ["pump", "pumpswap"] as const) {
    const { venue, req, chain } = await setup(v);
    for (const tip of [0n, 1n, SOLANA_JITO_TIP_MIN - 1n])
      assert.throws(() => buildSolanaPoolBuy(cfg, release, venue, { ...req, tip, cluster: "mainnet" }, chain, { pick: () => 0 }), /tips at least 1000 lamports/, `${v} tip ${tip}`);
    assert.ok(buildSolanaPoolBuy(cfg, release, venue, { ...req, tip: SOLANA_JITO_TIP_MIN, cluster: "mainnet" }, chain, { pick: () => 0 }).size > 0);
    assert.ok(buildSolanaPoolBuy(cfg, release, venue, { ...req, tip: 0n, cluster: "devnet" }, chain, { pick: () => 0 }).size > 0);
    assert.throws(() => buildSolanaPoolBuy(cfg, release, venue, { ...req, cluster: "testnet" as "devnet" }, chain), /cluster must be mainnet or devnet/);
    // the device's own check rebuilds through the same rule: a mainnet request under the minimum is refused there too
    const built = buildSolanaPoolBuy(cfg, release, venue, { ...req, tip: 0n, cluster: "devnet" }, chain, { pick: () => 0 });
    assert.throws(() => solanaPoolBuyInstructions(cfg, release, venue, { ...req, tip: 0n, cluster: "mainnet" }, 6, chain.rent, null), /tips at least 1000 lamports/);
    assert.ok(built.size > 0);
  }
});

test("M362 (4): a table holding every Jito tip account still compiles the tip account as a static key, both venues", async () => {
  for (const v of ["pump", "pumpswap"] as const) {
    const { venue, req, chain, addresses } = await setup(v);
    assert.ok(!addresses.some((k) => SOLANA_JITO_TIP_ACCOUNTS.includes(k)), "our table holds no tip account");
    // a table on chain that does hold them (an older table, or anyone's)
    const meta = new Uint8Array(56);
    const dv = new DataView(meta.buffer);
    dv.setUint32(0, 1, true);
    dv.setBigUint64(4, (1n << 64n) - 1n, true);
    const withTips = solanaDecodeLookupTable(Uint8Array.from([...meta, ...[...addresses, ...SOLANA_JITO_TIP_ACCOUNTS].flatMap((k) => [...base58.decode(k)])]));
    for (let pick = 0; pick < SOLANA_JITO_TIP_ACCOUNTS.length; pick++) {
      const b = buildSolanaPoolBuy(cfg, release, venue, { ...req, tip: TIP }, { ...chain, table: { address: chain.table.address, table: withTips } }, { pick: () => pick });
      const m = solanaDecodeMessage(b.message);
      const tip = SOLANA_JITO_TIP_ACCOUNTS[pick]!;
      assert.ok(m.staticKeys.includes(tip), `${v}: ${tip} is static`);
      for (const l of m.lookups) for (const i of [...l.writable, ...l.readonly]) assert.ok(!SOLANA_JITO_TIP_ACCOUNTS.includes(withTips.addresses[i]!), `${v}: no tip account loaded`);
      assert.ok(b.size <= 1232, `${v}: ${b.size} B`);
    }
  }
});

test("the check passes the built transaction and names each check", async () => {
  for (const v of ["pump", "pumpswap"] as const) {
    const { venue, req, chain, reads } = await setup(v);
    const built = buildSolanaPoolBuy(cfg, release, venue, req, chain, { pick: () => 3 });
    const verdict = checkSolanaPoolBuy(built.wire, cfg, release, venue, req, reads);
    assert.ok(verdict.ok, JSON.stringify(verdict.results));
    assert.deepEqual(verdict.results.map((x) => x.id), ["SIZE", "TABLES", "BLOCKHASH", "SIGNERS", "FUNDS", "FEE", "FRAME", "RELEASE", "BUY", "PRIVILEGES", "QUOTE"]);
  }
});

test("the check refuses a changed min_out, a changed curve, a quote under the user's slippage or for another amount", async () => {
  const { venue, req, chain, reads, minOut, E } = await setup("pump");
  const v = venue as Extract<SolanaPoolBuyVenue, { kind: "pump-curve" }>;
  const ids = (wire: Uint8Array, q = req, vv: SolanaPoolBuyVenue = venue, rd = reads) => failed(checkSolanaPoolBuy(wire, cfg, release, vv, q, rd));
  assert.deepEqual(ids(buildSolanaPoolBuy(cfg, release, venue, { ...req, minOut: minOut - 1n }, chain).wire), ["BUY"]);
  const bentCurve = { ...v, curve: base58.encode(new Uint8Array(32).fill(5)) };
  assert.ok(ids(buildSolanaPoolBuy(cfg, release, bentCurve, req, chain).wire).includes("BUY"));
  assert.ok(ids(buildSolanaPoolBuy(cfg, release, bentCurve, req, chain).wire, req, bentCurve).includes("QUOTE"));
  const low = (E * 9_000n) / 10_000n;
  assert.deepEqual(ids(buildSolanaPoolBuy(cfg, release, venue, { ...req, minOut: low }, chain).wire, { ...req, minOut: low }), ["QUOTE"]);
  assert.deepEqual(ids(buildSolanaPoolBuy(cfg, release, venue, req, chain).wire, req, venue, { ...reads, reference: { ...reads.reference, amount: SPEND + 1n } }), ["QUOTE"]);
});

test("the check refuses a blockhash that is not the device's own read (the review's GAP-1)", async () => {
  const { venue, req, chain, reads } = await setup("pump");
  const built = buildSolanaPoolBuy(cfg, release, venue, req, { ...chain, blockhash: base58.encode(new Uint8Array(32).fill(0x33)) }, { pick: () => 0 });
  assert.deepEqual(failed(checkSolanaPoolBuy(built.wire, cfg, release, venue, req, reads)), ["BLOCKHASH"]);
  assert.deepEqual(failed(checkSolanaPoolBuy(built.wire, cfg, release, venue, req, { ...reads, blockhash: "" })), ["BLOCKHASH"]);
});

test("the check refuses a chunk too small to land, though the message is the device's own (the review's GAP-2 and GAP-3)", async () => {
  const chunk = release.withdrawnValue - release.relayFee - TIP;
  const { venue, chain, reads } = await setup("pump");
  const ata = solanaRentMin(rent, venue.tokenAccountSize);
  const vol = solanaRentMin(rent, SOLANA_POOL_VOLUME_ACCOUNT_SIZE["pump-curve"]);
  // built on a rent of 1 lamport a byte, as a server that lies about rent would; checked on the rent the device read
  const cheap = { lamportsPerByte: 1n, factor: 1n } as const;
  // (10,000 short of the chunk: on the cheap rent W keeps over the sell's fee and rent(0), 5,128 lamports there)
  for (const spend of [chunk - 10_000n, chunk - ata - vol - 1n]) {
    const s = await setup("pump", spend);
    const built = buildSolanaPoolBuy(cfg, release, venue, s.req, { ...chain, rent: cheap });
    assert.throws(() => buildSolanaPoolBuy(cfg, release, venue, s.req, chain), /does not cover|under the/);
    assert.deepEqual(failed(checkSolanaPoolBuy(built.wire, cfg, release, venue, s.req, { ...s.reads, rent })), ["FUNDS"]);
  }
  void reads;
});

test("the check refuses a reference older than SOLANA_POOL_QUOTE_MAX_AGE_SLOTS or with no slot, and takes one newer than its slot read", async () => {
  const { venue, req, chain, reads, ref } = await setup("pump");
  const wire = buildSolanaPoolBuy(cfg, release, venue, req, chain).wire;
  const at = (slot: number, r = ref) => failed(checkSolanaPoolBuy(wire, cfg, release, venue, req, { ...reads, slot, reference: { ...reads.reference, ref: r } }));
  assert.deepEqual(at(ref.slot! + SOLANA_POOL_QUOTE_MAX_AGE_SLOTS), []);
  assert.deepEqual(at(ref.slot! + SOLANA_POOL_QUOTE_MAX_AGE_SLOTS + 1), ["QUOTE"]);
  // a reference newer than the device's slot read is fresher, not staler (the review's R8, inverted)
  assert.deepEqual(at(ref.slot! - 1), []);
  assert.deepEqual(at(ref.slot! - 6), []);
  const { slot: _, ...noSlot } = ref;
  assert.deepEqual(at(ref.slot!, noSlot), ["QUOTE"]);
});

test("the check refuses a table the providers disagree on, another W, a tip over the proof's cap", async () => {
  const { venue, req, chain, reads, tableData, tableAddr } = await setup("pump");
  const built = buildSolanaPoolBuy(cfg, release, venue, req, chain);
  const other = tableData.slice();
  other[56] = other[56]! ^ 1; // entry 0, the pool, differs on provider B
  assert.deepEqual(failed(checkSolanaPoolBuy(built.wire, cfg, release, venue, req, { ...reads, tables: { [tableAddr]: [{ owner: ALT, data: tableData }, { owner: ALT, data: other }] } })), ["TABLES"]);
  const v2 = checkSolanaPoolBuy(built.wire, cfg, release, venue, { ...req, wallet: base58.encode(new Uint8Array(32).fill(8)) }, reads);
  assert.ok(failed(v2).includes("SIGNERS"));
  assert.throws(() => buildSolanaPoolBuy(cfg, release, venue, { ...req, tip: release.tipCap + 1n }, chain), /tip cap/);
  void BLOCKHASH;
});

test("the kit's helper paths name the pool relayers' three routes, as apps/helper mounts them (card helper-pool-senders)", () => {
  const row = (path: string) => HELPER_V1_PATHS.find((r) => r.path === path);
  assert.deepEqual(row("/v1/pool/fee"), { method: "GET", path: "/v1/pool/fee", part: "relay", limitBytes: 1024 });
  assert.deepEqual(row("/v1/pool/solana/send"), { method: "POST", path: "/v1/pool/solana/send", part: "relay", limitBytes: 4096 });
  assert.deepEqual(row("/v1/pool/evm/send"), { method: "POST", path: "/v1/pool/evm/send", part: "relay", limitBytes: 4096 });
});

test("a sell's min out comes from the two-provider quote less the user's slippage, never 1 lamport; its steps are the ones the pool ran", async () => {
  for (const v of ["pump", "pumpswap"] as const) {
    const kind = v === "pump" ? "pump-curve" : "pumpswap";
    const ran = JSON.parse(readFileSync(new URL(`../../../contracts/pool-solana/fixtures/venues/${v}.json`, import.meta.url), "utf8"));
    const venue = await readSolanaPoolBuyVenue(providers(v), kind, fx[v].mint, () => 0);
    const amount = BigInt(ran.min_out);
    // the pool's LiteSVM sell (dump.mjs, min out 1) with the kit's steps: the same programs, keys, flags and data but min out
    const steps = solanaPoolSellSteps(venue, W, amount, 1n);
    assert.deepEqual(steps.map((x) => ({ program: x.program, accounts: x.accounts.map((a) => ({ address: a.key, signer: a.signer, writable: a.writable })), data: Buffer.from(x.data).toString("hex") })), ran.sell, v);
    const ref = await readSolanaReference(providers(v), { side: "sell", token: fx[v].mint, amount });
    const E = ref!.pools.find((p) => p.venue === kind)!.expectedOut;
    const minOut = solanaPoolSellMinOut(venue, amount, { amount, ref, slippageBps: 300 }, ref!.slot!);
    assert.equal(minOut, (E * 9_700n) / 10_000n);
    assert.ok(minOut > 1_000_000n, `${v}: ${minOut}`);
    const sell = solanaPoolSellSteps(venue, W, amount, minOut).find((x) => x.program !== "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" && x.program !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")!;
    assert.equal(new DataView(sell.data.buffer, sell.data.byteOffset).getBigUint64(16, true), minOut);
    assert.throws(() => solanaPoolSellMinOut(venue, amount, { amount: amount + 1n, ref, slippageBps: 300 }, ref!.slot!), /not for the amount/);
    assert.throws(() => solanaPoolSellMinOut(venue, amount, { amount, ref: null, slippageBps: 300 }, ref!.slot!), /no slot/);
    assert.throws(() => solanaPoolSellMinOut(venue, amount, { amount, ref: { ...ref!, pools: [] }, slippageBps: 300 }, ref!.slot!), /no reference/);
    assert.throws(() => solanaPoolSellMinOut(venue, amount, { amount, ref, slippageBps: 10_000 }, ref!.slot!), /slippage/);
    assert.throws(() => solanaPoolSellSteps(venue, W, amount, 0n), /above 0/);
  }
});

test("the build refuses a pool that is not the program's, W as the fee payer and a CU price over its cap", async () => {
  const { venue, req, chain } = await setup("pump");
  assert.throws(() => buildSolanaPoolBuy({ ...cfg, pool: base58.encode(new Uint8Array(32).fill(6)) }, release, venue, req, chain), /not the program's pool account/);
  assert.throws(() => buildSolanaPoolBuy(cfg, release, venue, { ...req, feePayer: W }, chain), /must differ/);
  assert.throws(() => buildSolanaPoolBuy(cfg, release, venue, { ...req, cuPrice: 10n ** 12n }, chain), /CU price/);
});

test("the venue read refuses a Mayhem curve, a complete curve, an unset buyback recipient and a PumpSwap pool that is not the mint's", async () => {
  const flip = (v: "pump" | "pumpswap", i: number, at: number, byte: number) => (p: 0 | 1) => replay(fx[v], p, (_list, ans) => {
    const d = Buffer.from(ans.value[i].data[0], "base64");
    if (byte < 0) d.fill(0, at, at + 32);
    else d[at] = byte;
    ans.value[i].data[0] = d.toString("base64");
    return ans;
  });
  const read = (v: "pump" | "pumpswap", f: (p: 0 | 1) => SolanaRpc) => readSolanaPoolBuyVenue([f(0), f(1)], v === "pump" ? "pump-curve" : "pumpswap", fx[v].mint, () => 0);
  await assert.rejects(read("pump", flip("pump", 1, 81, 1)), /Mayhem/);
  await assert.rejects(read("pump", flip("pump", 1, 48, 1)), /complete/);
  await assert.rejects(read("pump", flip("pump", 2, 741 + 32 * 5, -1)), /buyback recipient is unset/);
  await assert.rejects(read("pumpswap", flip("pumpswap", 1, 9, 1)), /canonical pool/);
});

test("the check refuses a deactivated table or one not owned by the table program, and a wire without two signature slots", async () => {
  const { venue, req, chain, reads, tableData, tableAddr } = await setup("pump");
  const built = buildSolanaPoolBuy(cfg, release, venue, req, chain);
  const off = tableData.slice();
  new DataView(off.buffer).setBigUint64(4, 5n, true); // deactivated at slot 5
  const ids = (t: { owner: string; data: Uint8Array }) => failed(checkSolanaPoolBuy(built.wire, cfg, release, venue, req, { ...reads, tables: { [tableAddr]: [t, t] } }));
  assert.deepEqual(ids({ owner: ALT, data: off }), ["TABLES"]);
  assert.deepEqual(ids({ owner: "11111111111111111111111111111111", data: tableData }), ["TABLES"]);
  const three = built.wire.slice();
  three[0] = 3;
  assert.deepEqual(failed(checkSolanaPoolBuy(three, cfg, release, venue, req, reads)), ["DECODE"]);
});

test("QUOTE refuses a min out of 0 even when the floor is 0, and a slippage of 10,000 bps or more (the review's R7, inverted)", async () => {
  const { venue, req, chain, reads, ref } = await setup("pump");
  const zero = { ...ref, pools: ref.pools.map((p) => ({ ...p, expectedOut: 0n })) };
  const q0 = { ...req, minOut: 0n };
  assert.deepEqual(failed(checkSolanaPoolBuy(buildSolanaPoolBuy(cfg, release, venue, q0, chain).wire, cfg, release, venue, q0, { ...reads, reference: { ...reads.reference, ref: zero } })), ["QUOTE"]);
  const wire = buildSolanaPoolBuy(cfg, release, venue, req, chain).wire;
  for (const slippageBps of [10_000, 10_001]) assert.deepEqual(failed(checkSolanaPoolBuy(wire, cfg, release, venue, req, { ...reads, reference: { ...reads.reference, slippageBps } })), ["QUOTE"]);
  // a sell whose reference gives 0 has no floor: refused
  assert.throws(() => solanaPoolSellMinOut(venue, SPEND, { amount: SPEND, ref: zero, slippageBps: 300 }, ref.slot!), /floor is 0/);
});

test("the compressed point's bit 7 is y's sign: set for y above q - y, clear below", () => {
  const p = new Uint8Array(256);
  const put = (at: number, x: bigint) => p.set(Uint8Array.from(Buffer.from(x.toString(16).padStart(64, "0"), "hex")), at);
  put(0, 1n); put(32, Q - 2n); // A = (1, -2): the larger root
  put(64, 1n); put(96, 1n); put(128, 1n); put(160, 1n); // B, any nonzero point
  put(192, 1n); put(224, 2n); // C = (1, 2): the smaller root
  const c = solanaCompressPoolProof(p);
  assert.equal(c[0], 0x80);
  assert.equal(c[96], 0);
});

// ------------------------------------------------------------------------------------------------- fold 2

test("the priority fee must fit in the priority budget: the relay fee less the release's cost and the page reserve, or the helper refuses what W signed (M353, M356 (5))", async () => {
  assert.equal(SOLANA_POOL_SPENT_MARK_LEN, 13); // withdrawnValue u64 ‖ the release's number u32 (M376) ‖ the tag
  assert.equal(solanaPoolReleaseCost(rent), 1_092_040n); // rent(13) 716,280 + 72 x 5,080 + 2 signatures (M355 (3), M376)
  assert.equal(solanaPoolPageReserve(rent), 715n); // ceil((128 + 16) x 5,080 / 1,024) = ceil(731,520 / 1,024)
  assert.equal(solanaPoolFee(rent), 1_300_000n); // 1,092,040 up to 1,100,000, plus two steps
  assert.equal(solanaPoolPriorityBudget(rent), 207_245n); // 1,300,000 - 1,092,040 - 715
  const rel = { ...release, relayFee: 1_300_000n };
  for (const v of ["pump", "pumpswap"] as const) {
    const s = await setup(v);
    const req = { ...s.req, cuPrice: 1_000_000n }; // 300,000 or 400,000 CU x 1 lamport: over 207,245
    assert.throws(() => buildSolanaPoolBuy(cfg, rel, s.venue, req, s.chain), /priority fee/, v);
    const cheap = { lamportsPerByte: 1n, factor: 1n } as const; // a server that lies about rent builds it
    const wire = buildSolanaPoolBuy(cfg, rel, s.venue, req, { ...s.chain, rent: cheap }).wire;
    assert.deepEqual(failed(checkSolanaPoolBuy(wire, cfg, rel, s.venue, req, s.reads)), ["FEE"], v);
    // exactly at the edge: limit x price = (relay_fee - cost - 715) x 1e6 is carried; one lamport less is refused
    const cu = BigInt(v === "pump" ? 300_000 : 400_000);
    const edge = { ...release, relayFee: 1_092_040n + 715n + (cu * 100_000n) / 1_000_000n };
    const ok = { ...s.req, cuPrice: 100_000n };
    assert.equal(solanaPoolPriorityBudget(rent, edge.relayFee) * 1_000_000n, cu * 100_000n);
    assert.ok(checkSolanaPoolBuy(buildSolanaPoolBuy(cfg, edge, s.venue, ok, s.chain).wire, cfg, edge, s.venue, ok, s.reads).ok, v);
    assert.throws(() => buildSolanaPoolBuy(cfg, { ...edge, relayFee: edge.relayFee - 1n }, s.venue, ok, s.chain), /priority fee/, v);
    // the reserve is the difference: a relay fee that covers the cost and priority but not the page's share is refused
    const noReserve = { ...edge, relayFee: edge.relayFee - 715n };
    assert.throws(() => buildSolanaPoolBuy(cfg, noReserve, s.venue, ok, s.chain), /page reserve 715/, v);
    const signed = buildSolanaPoolBuy(cfg, edge, s.venue, ok, s.chain).wire;
    assert.deepEqual(failed(checkSolanaPoolBuy(signed, cfg, noReserve, s.venue, ok, s.reads)).includes("FEE"), true, v);
  }
  // the send margin outlives a blockhash: 150 blocks at 400 ms is 60 s
  assert.equal(SOLANA_POOL_SEND_MARGIN_MS, 90_000n);
});

test("a duplicate key (the compute budget program again, loaded from the table) is refused by the key count (the review's R2)", async () => {
  const CB = "ComputeBudget111111111111111111111111111111";
  const s = await setup("pump");
  const m = buildSolanaPoolBuy(cfg, release, s.venue, s.req, s.chain, { pick: () => 0 }).message;
  const dec = solanaDecodeMessage(m);
  assert.ok(dec.staticKeys.includes(CB));
  const table2 = Uint8Array.from([...s.tableData, ...base58.decode(CB)]);
  const at = m.length - dec.lookups[0]!.readonly.length - 1;
  const bent = Uint8Array.from([...m.subarray(0, at), m[at]! + 1, ...m.subarray(at + 1), s.addresses.length]);
  const reads2 = { ...s.reads, tables: { [s.tableAddr]: [{ owner: ALT, data: table2 }, { owner: ALT, data: table2 }] as const } };
  assert.ok(checkSolanaPoolBuy(wireOf(m), cfg, release, s.venue, s.req, reads2).ok);
  assert.deepEqual(failed(checkSolanaPoolBuy(wireOf(bent), cfg, release, s.venue, s.req, reads2)), ["PRIVILEGES"]);
});

test("a venue read naming the pool, its accounts or the fee payer is refused at build, wherever tag 3 would place it (the review's R5 inverted)", async () => {
  const s = await setup("pump");
  const spent = solanaPoolReleaseAccounts(cfg, W, FEE_PAYER, release, 6)[3]!.key;
  for (const k of [FEE_PAYER, POOL, PROGRAM, spent]) {
    const bent = { ...s.venue, feeRecipient: k } as SolanaPoolBuyVenue;
    assert.throws(() => solanaPoolBuyInstructions(cfg, release, bent, s.req, 6, rent, SOLANA_JITO_TIP_ACCOUNTS[0]!), /names the pool, its accounts or the fee payer/, k);
  }
});

test("a sell's min out refuses a reference older than 25 slots and takes a newer one (the review's R6 inverted)", async () => {
  const s = await setup("pump");
  const amount = 1_000_000_000n;
  const ref = (await readSolanaReference(providers("pump"), { side: "sell", token: fx.pump.mint, amount }))!;
  const at = (slot: number) => solanaPoolSellMinOut(s.venue, amount, { amount, ref, slippageBps: 300 }, slot);
  assert.ok(at(ref.slot! + 25) > 0n);
  assert.ok(at(ref.slot! - 4) > 0n);
  assert.throws(() => at(ref.slot! + 26), /26 slots before/);
  assert.throws(() => at(ref.slot! + 1_000_000), /slots before/);
});

test("pump's cashback flag is the curve's own is_cashback_coin byte (82): a cashback coin's sell names W's volume accumulator", async () => {
  for (const byte of [0, 1]) {
    const f = (p: 0 | 1) => replay(fx.pump, p, (_list, ans) => {
      const d = Buffer.from(ans.value[1].data[0], "base64");
      d[82] = byte;
      ans.value[1].data[0] = d.toString("base64");
      return ans;
    });
    const venue = await readSolanaPoolBuyVenue([f(0), f(1)], "pump-curve", fx.pump.mint, () => 0);
    assert.equal(venue.cashback, byte === 1);
    const sell = solanaPoolSellSteps(venue, W, 1_000n, 1_000n)[0]!;
    const vol = solanaProgramAddress([new TextEncoder().encode("user_volume_accumulator"), base58.decode(W)], SOLANA_PUMP_PROGRAM);
    assert.equal(sell.accounts.length, byte ? 17 : 16);
    assert.equal(sell.accounts.some((a) => a.key === vol && a.writable), byte === 1);
  }
});

test("the venue read refuses a Mayhem PumpSwap pool, vaults that are not the pool's, a cashback byte that is not a bool, a curve not in SOL, unset fee recipients", async () => {
  const edit = (v: "pump" | "pumpswap", i: number, at: number, bytes: number[]) => (p: 0 | 1) => replay(fx[v], p, (_list, ans) => {
    const d = Buffer.from(ans.value[i].data[0], "base64");
    d.set(bytes, at);
    ans.value[i].data[0] = d.toString("base64");
    return ans;
  });
  const read = (v: "pump" | "pumpswap", f: (p: 0 | 1) => SolanaRpc) => readSolanaPoolBuyVenue([f(0), f(1)], v === "pump" ? "pump-curve" : "pumpswap", fx[v].mint, () => 0);
  const zeros = Array(32).fill(0);
  const key5 = Array(32).fill(5);
  await assert.rejects(read("pumpswap", edit("pumpswap", 1, 243, [1])), /Mayhem/);
  await assert.rejects(read("pumpswap", edit("pumpswap", 1, 139, key5)), /vaults/);
  await assert.rejects(read("pumpswap", edit("pumpswap", 1, 171, key5)), /vaults/);
  await assert.rejects(read("pumpswap", edit("pumpswap", 1, 244, [2])), /not a bool/);
  await assert.rejects(read("pump", edit("pump", 1, 83, key5)), /not quoted in SOL/);
  await assert.rejects(read("pump", edit("pump", 2, 41, zeros)), /no fee recipient/);
  await assert.rejects(read("pumpswap", edit("pumpswap", 2, 57, zeros)), /no protocol fee recipient/);
});

test("rent read on two providers that disagree is refused; a deactivated table is refused at build; a cashback pool counts its wSOL account", async () => {
  const sysvar = (lpb: number) => (async () => {
    const d = new Uint8Array(17);
    new DataView(d.buffer).setBigUint64(0, BigInt(lpb), true);
    new DataView(d.buffer).setFloat64(8, 1, true);
    return { context: { slot: 1 }, value: { owner: "Sysvar1111111111111111111111111111111111111", data: [Buffer.from(d).toString("base64"), "base64"] } };
  }) as unknown as SolanaRpc;
  assert.deepEqual(await readSolanaRent([sysvar(5_080), sysvar(5_080)]), rent);
  await assert.rejects(readSolanaRent([sysvar(5_080), sysvar(5_081)]), /disagree on rent/);
  const s = await setup("pump");
  const off = s.tableData.slice();
  new DataView(off.buffer).setBigUint64(4, 5n, true);
  assert.throws(() => buildSolanaPoolBuy(cfg, release, s.venue, s.req, { ...s.chain, table: { address: s.tableAddr, table: solanaDecodeLookupTable(off) } }), /deactivated/);
  const p = await setup("pumpswap");
  const plain = solanaPoolBuyFunds(release, p.venue, p.req, rent);
  const cb = solanaPoolBuyFunds(release, { ...p.venue, cashback: true } as SolanaPoolBuyVenue, p.req, rent);
  assert.equal(cb.peak - plain.peak, solanaRentMin(rent, 165));
  assert.equal(plain.left - cb.left, solanaRentMin(rent, 165));
});

test("a venue kind outside the two venues names no compute limit or account size, even when a polluted Object.prototype has one", async () => {
  const { venue, req, chain } = await setup("pump");
  const bad = { ...venue, kind: "evil" } as unknown as SolanaPoolBuyVenue;
  const P = Object.prototype as Record<string, unknown>;
  try {
    P.evil = 1_400_000;
    assert.throws(() => buildSolanaPoolBuy(cfg, release, bad, req, chain), /no such venue evil/);
    assert.throws(() => solanaPoolBuyFunds(release, bad, req, rent), /no such venue evil/);
  } finally {
    delete P.evil;
  }
  assert.ok(buildSolanaPoolBuy(cfg, release, venue, req, chain).size <= 1232);
});
