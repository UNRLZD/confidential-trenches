// The signing page's pool rules (card signpage-pool-kinds, src/rules/pool.ts): a good payload of each kind passes its
// check and signs; each bad field is refused not_allowed, named by its rule; no rule takes a field from a server.
// Keys: the all-zero ed25519 seed and the Hardhat mnemonic's account 0, both published test vectors. The Solana buy
// replays the kit's recorded LiteSVM reads (packages/kit/test/solana-pool-buy-fx.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58 } from "@scure/base";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import {
  buildSolanaPoolBuy,
  solanaEncodePoolRelease,
  solanaPoolPage,
  solanaPoolReleaseAccounts,
  solanaPoolSellSteps,
  type SolanaPoolRelease,
} from "../../kit/src/trade/solana/pool-buy.ts";
import { evmPoolVenues, pinnedBuild, type EvmPoolVenue } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { pinnedBuildSell } from "../../kit/src/trade/evm/sell-unpinned.ts";
import { evmPoolContextOf, evmPoolScopeOf, type EvmRelayData } from "../../wallet/src/pool/evm.ts";
import { FEE_PAYER, PROGRAM as FX_PROGRAM, W as FX_W, release as fxRelease, setup } from "../../kit/test/solana-pool-buy-fx.ts";
import {
  POOL_KINDS,
  PoolRuleRefused,
  checkEvmAuthorization,
  checkEvmBuy,
  checkEvmSell,
  checkEvmWithdraw,
  checkPoolRequest,
  checkSolanaBuy,
  checkSolanaDeposit,
  checkSolanaSell,
  checkSolanaWithdraw,
  checkSolanaOnwardSend,
  type SolanaOnwardReads,
  drawPool,
  SOLANA_POOL_SELL_RESERVE_MAX,
  evmWithdrawDigest,
  signEvmAuthorization,
  signEvmBuy,
  signEvmSell,
  signEvmWithdraw,
  signSolana,
  type PoolAsk,
  type PoolContext,
  type SolanaPoolReads,
} from "../src/rules/pool.ts";

const refusedAs = (rule: string) => (e: unknown) => e instanceof PoolRuleRefused && e.code === "not_allowed" && e.rule === rule;
const enc = (s: string) => new TextEncoder().encode(s);
const key = (n: number) => base58.encode(new Uint8Array(32).fill(n));
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return [...b]; };
const NOW = 1_800_000_000_000n;

// ---------- the request ----------

test("a request: each pool kind's good params pass; every other kind, a chain that is not a pool's, a bad token, amount or slippage is refused", () => {
  const sol = key(5);
  const evm = "0xF111111111111111111111111111111111111111";
  assert.deepEqual(checkPoolRequest({ kind: "pool.deposit", chain: "solana", amount: "1.5" }), { kind: "pool.deposit", chain: "solana", token: null, amount: 1_500_000_000n, slippageBps: 0, decimals: 9 });
  assert.deepEqual(checkPoolRequest({ kind: "pool.buy", chain: "solana", token: sol, amount: "0.005", slippage_bps: 300 }).amount, 5_000_000n);
  assert.equal(checkPoolRequest({ kind: "pool.sell", chain: "base", token: evm, amount: "2", slippage_bps: 0 }, evmDec(18)).amount, 2n * 10n ** 18n);
  assert.equal(checkPoolRequest({ kind: "pool.withdraw", chain: "robinhood" }).kind, "pool.withdraw");
  for (const [p, rule] of [
    [{ kind: "buy", chain: "solana" }, "kind"],
    [{ kind: "pool.hop", chain: "solana" }, "kind"],
    [{ kind: "pool.buy", chain: "near", token: sol, amount: "1", slippage_bps: 1 }, "chain"],
    [{ kind: "pool.buy", chain: "ethereum", token: evm, amount: "1", slippage_bps: 1 }, "chain"],
    [{ kind: "pool.buy", chain: "solana", token: evm, amount: "1", slippage_bps: 1 }, "token"],
    [{ kind: "pool.buy", chain: "base", token: sol, amount: "1", slippage_bps: 1 }, "token"],
    [{ kind: "pool.buy", chain: "solana", token: sol, amount: "0", slippage_bps: 1 }, "amount"],
    [{ kind: "pool.buy", chain: "solana", token: sol, amount: "1.0000000001", slippage_bps: 1 }, "amount"],
    [{ kind: "pool.buy", chain: "solana", token: sol, amount: "-1", slippage_bps: 1 }, "amount"],
    [{ kind: "pool.buy", chain: "solana", token: sol, amount: "1", slippage_bps: 5_001 }, "slippage"],
    [{ kind: "pool.sell", chain: "solana", token: sol, amount: "1", slippage_bps: 1.5 }, "slippage"],
  ] as const) {
    assert.throws(() => checkPoolRequest(p as never, solMint(9)), refusedAs(rule), JSON.stringify(p));
  }
  assert.deepEqual([...POOL_KINDS], ["pool.deposit", "pool.buy", "pool.sell", "pool.withdraw"]);
});

// The token's decimals as two providers answered: the mint (byte 44, initialized at 45) or decimals() (one word)
const mintData = (dec: number, o: { len?: number; init?: number; type?: number } = {}) => {
  const d = new Uint8Array(o.len ?? 82);
  d[44] = dec;
  d[45] = o.init ?? 1;
  if (d.length > 165) d[165] = o.type ?? 1;
  return d;
};
const mintAnswer = (dec: number, o: { len?: number; init?: number; type?: number; owner?: string } = {}) => ({
  context: { slot: 1 },
  value: { owner: o.owner ?? SOLANA_TOKEN_PROGRAM, data: [Buffer.from(mintData(dec, o)).toString("base64"), "base64"], lamports: 1, executable: false },
});
function solMint(dec: number) {
  return [mintAnswer(dec), mintAnswer(dec)] as const;
}
const evmWord = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
function evmDec(n: number) {
  return [evmWord(BigInt(n)), evmWord(BigInt(n))] as const;
}

test("a request's decimals are never the caller's: the pool asset's for a deposit or a buy (SOL 9, ETH 18), the token's from two agreeing reads for a sell", () => {
  const sol = key(5);
  const evm = "0xF111111111111111111111111111111111111111";
  // EVM amounts are uint256: 19 ETH into a pool and a 100-token sell of an 18-decimals token pass (no u64 bound)
  assert.equal(checkPoolRequest({ kind: "pool.deposit", chain: "base", amount: "19" }).amount, 19n * 10n ** 18n);
  assert.equal(checkPoolRequest({ kind: "pool.buy", chain: "robinhood", token: evm, amount: "0.000000000000000001", slippage_bps: 1 }).amount, 1n);
  assert.equal(checkPoolRequest({ kind: "pool.sell", chain: "base", token: evm, amount: "100", slippage_bps: 100 }, evmDec(18)).amount, 100n * 10n ** 18n);
  assert.equal(checkPoolRequest({ kind: "pool.sell", chain: "base", token: evm, amount: "1.5", slippage_bps: 100 }, evmDec(24)).amount, 15n * 10n ** 23n);
  // Solana stays u64: 2^64 - 1 lamports passes, 2^64 does not
  assert.throws(() => checkPoolRequest({ kind: "pool.deposit", chain: "solana", amount: "18446744073.709551616" }), refusedAs("amount"));
  assert.equal(checkPoolRequest({ kind: "pool.deposit", chain: "solana", amount: "18446744073.709551615" }).amount, (1n << 64n) - 1n);
  // a Solana sell: an SPL mint or a Token-2022 mint (with extensions, account type 1), at its own decimals
  assert.equal(checkPoolRequest({ kind: "pool.sell", chain: "solana", token: sol, amount: "2.5", slippage_bps: 1 }, solMint(6)).amount, 2_500_000n);
  const t22 = mintAnswer(6, { owner: SOLANA_TOKEN_2022_PROGRAM, len: 200 });
  assert.equal(checkPoolRequest({ kind: "pool.sell", chain: "solana", token: sol, amount: "2.5", slippage_bps: 1 }, [t22, t22]).amount, 2_500_000n);
  assert.throws(() => checkPoolRequest({ kind: "pool.sell", chain: "solana", token: sol, amount: "0.0000001", slippage_bps: 1 }, solMint(6)), refusedAs("amount"));
  const sell = (chain: "solana" | "base", reads: unknown) => checkPoolRequest({ kind: "pool.sell", chain, token: chain === "solana" ? sol : evm, amount: "1", slippage_bps: 1 }, reads as never);
  for (const [chain, reads] of [
    ["solana", undefined],
    ["solana", [mintAnswer(6)]],
    ["solana", [mintAnswer(6), mintAnswer(9)]],
    ["solana", [mintAnswer(6), mintAnswer(6, { owner: key(3) })]],
    ["solana", [mintAnswer(6, { init: 0 }), mintAnswer(6, { init: 0 })]],
    ["solana", [mintAnswer(6, { len: 165 }), mintAnswer(6, { len: 165 })]],
    ["solana", [mintAnswer(6, { owner: SOLANA_TOKEN_2022_PROGRAM, len: 200, type: 2 }), mintAnswer(6, { owner: SOLANA_TOKEN_2022_PROGRAM, len: 200, type: 2 })]],
    ["solana", [mintAnswer(6, { len: 200 }), mintAnswer(6, { len: 200 })]],
    // a Token-2022 multisig (355 bytes) reads as no mint, whatever its byte 165 holds
    ["solana", [mintAnswer(6, { owner: SOLANA_TOKEN_2022_PROGRAM, len: 355 }), mintAnswer(6, { owner: SOLANA_TOKEN_2022_PROGRAM, len: 355 })]],
    ["solana", [{ value: null }, { value: null }]],
    ["solana", [{ value: { owner: SOLANA_TOKEN_PROGRAM, data: ["!!", "base64"] } }, mintAnswer(6)]],
    ["base", undefined],
    ["base", [evmWord(18n), evmWord(6n)]],
    ["base", [evmWord(256n), evmWord(256n)]],
    ["base", ["0x12", "0x12"]],
    ["base", [18, 18]],
  ] as const) {
    assert.throws(() => sell(chain, reads), refusedAs("decimals"), `${chain} ${JSON.stringify(reads)?.slice(0, 120)}`);
  }
});

// ---------- Solana deposit (tag 1) ----------

const SOL_SECRET = new Uint8Array(32); // the all-zero seed, a published vector
const SOL_W = base58.encode(ed25519.getPublicKey(SOL_SECRET));
const PROGRAM = key(41);
const SOL_FEE_PAYER = key(42);
const POOL = solanaProgramAddress([enc("pool")], PROGRAM);
const BLOCKHASH = key(7);
const PRE = 123_456_789n;
const preBytes = (v: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((v >> BigInt(8 * (31 - i))) & 0xffn));
const SOL_READS: SolanaPoolReads = { blockhash: BLOCKHASH, tables: {}, stateSize: 6, labelSize: 4 };
const solCtx = (o: Partial<PoolContext> = {}): PoolContext & { precommitment: bigint } => ({
  nowMs: NOW, wallet: SOL_W, feeCap: 3_000_000n, solana: { program: PROGRAM, feePayer: SOL_FEE_PAYER }, precommitment: PRE, ...o,
});
const acc = (k: string, signer: boolean, writable: boolean) => ({ key: k, signer, writable });
const cuLimit = { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(2, 0x40, 0x0d, 0x03, 0) };
type Ixx = { program: string; accounts: { key: string; signer: boolean; writable: boolean }[]; data: Uint8Array };
const depositIx = (o: { program?: string; pool?: string; from?: string; fromSigns?: boolean; value?: bigint; pre?: bigint; state?: number; label?: number; mark?: string; system?: string } = {}): Ixx => {
  const program = o.program ?? PROGRAM;
  const pre = preBytes(o.pre ?? PRE);
  return {
    program,
    accounts: [
      acc(o.pool ?? POOL, false, true),
      acc(o.from ?? SOL_W, o.fromSigns ?? true, true),
      acc(solanaPoolPage(PROGRAM, 0, o.state ?? 6), false, true),
      acc(solanaPoolPage(PROGRAM, 1, o.label ?? 4), false, true),
      acc(o.mark ?? solanaProgramAddress([enc("pre"), pre], PROGRAM), false, true),
      acc(o.system ?? SOLANA_SYSTEM_PROGRAM, false, false),
    ],
    data: Uint8Array.from([1, ...u64(o.value ?? 2_000_000_000n), ...pre]),
  };
};
const wire = (payer: string, ixs: Ixx[], signers: string[] = [payer], blockhash = BLOCKHASH) => {
  const { message } = solanaCompileV0(payer, ixs, blockhash, [], signers);
  const w = new Uint8Array(1 + 64 * signers.length + message.length);
  w[0] = signers.length;
  w.set(message, 1 + 64 * signers.length);
  return w;
};
const depAsk: PoolAsk = { kind: "pool.deposit", chain: "solana", token: null, amount: 2_000_000_000n, slippageBps: 0, decimals: 9 };

test("Solana deposit: the pinned pool's tag 1 from W of the request's amount and the device's precommitment passes, draws and signs", () => {
  const w = wire(SOL_W, [cuLimit, depositIx()]);
  const d = checkSolanaDeposit(w, depAsk, solCtx(), SOL_READS);
  assert.deepEqual(d, { chain: "solana", op: "pool.deposit", token: null, amount: 2_000_000_000n, feeCap: 0n, pool: POOL, to: POOL, decimals: 9, back: null });
  const sig = signSolana(SOL_SECRET, w);
  assert.ok(ed25519.verify(sig, w.subarray(65), base58.decode(SOL_W)));
  // only the very wire a check passed, as the check read it: a copy, or a byte changed after, is refused
  assert.throws(() => signSolana(SOL_SECRET, w.slice()), refusedAs("unchecked"));
  w[w.length - 1] ^= 1;
  assert.throws(() => signSolana(SOL_SECRET, w), refusedAs("unchecked"));
  assert.deepEqual(drawPool(d), [["Chain", "Solana"], ["Amount", "2"], ["Max fee", "0"], ["Pool", POOL]]);
});

test("Solana deposit: another program, pool, depositor, amount, precommitment, page, blockhash, an extra instruction or a kind is refused", () => {
  const ok = (ixs: Ixx[], o: { payer?: string; signers?: string[]; bh?: string } = {}) => wire(o.payer ?? SOL_W, ixs, o.signers, o.bh);
  const other = key(9);
  for (const [w, rule] of [
    [ok([cuLimit, depositIx({ program: key(43) })]), "program"],
    [ok([cuLimit, depositIx({ pool: key(44) })]), "pool"],
    [ok([cuLimit, depositIx({ from: other })], { payer: other }), "signers"],
    [ok([cuLimit, depositIx({ from: other, fromSigns: false })]), "depositor"],
    [ok([cuLimit, depositIx({ mark: key(45) })]), "precommitment_mark"],
    [ok([cuLimit, depositIx({ system: key(46) })]), "system"],
    [ok([cuLimit, depositIx({ value: 2_000_000_001n })]), "amount"],
    [ok([cuLimit, depositIx({ pre: PRE + 1n })]), "precommitment"],
    [ok([cuLimit, depositIx({ state: 2_000 })]), "state_page"],
    [ok([cuLimit, depositIx({ label: 1_100 })]), "label_page"],
    [ok([cuLimit, depositIx()], { bh: key(8) }), "blockhash"],
    [ok([cuLimit, depositIx(), { program: SOLANA_SYSTEM_PROGRAM, accounts: [acc(SOL_W, true, true), acc(other, false, true)], data: Uint8Array.of(2, 0, 0, 0, ...u64(1n)) }]), "instructions"],
    [ok([depositIx(), cuLimit]), "compute_budget"],
    [ok([{ ...cuLimit, data: Uint8Array.of(2, ...u64(1_400_001n).slice(0, 4)) }, depositIx()]), "cu_limit"],
    [ok([cuLimit, { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(3, ...u64(1_000_001n)) }, depositIx()]), "cu_price"],
  ] as const) {
    assert.throws(() => checkSolanaDeposit(w, depAsk, solCtx(), SOL_READS), refusedAs(rule), rule);
  }
  assert.throws(() => checkSolanaDeposit(ok([cuLimit, depositIx()]), { ...depAsk, kind: "pool.buy" }, solCtx(), SOL_READS), refusedAs("kind"));
  assert.throws(() => checkSolanaDeposit(ok([cuLimit, depositIx()]), depAsk, solCtx({ solana: undefined }), SOL_READS), refusedAs("solana_not_pinned"));
});

// ---------- Solana withdraw (tag 2) ----------

const release: SolanaPoolRelease = { ...fxRelease, deadlineMs: NOW + 120_000n };
const TO = key(77);
const relIx = (r: SolanaPoolRelease = release, w = SOL_W, fp = SOL_FEE_PAYER, program = PROGRAM): Ixx => ({
  program,
  accounts: solanaPoolReleaseAccounts({ program, pool: solanaProgramAddress([enc("pool")], program) }, w, fp, r, 6).map((a) => ({ ...a })),
  data: solanaEncodePoolRelease(r),
});
const send = (to = TO, v = release.withdrawnValue - release.relayFee, from = SOL_W): Ixx => ({
  program: SOLANA_SYSTEM_PROGRAM, accounts: [acc(from, true, true), acc(to, false, true)], data: Uint8Array.of(2, 0, 0, 0, ...u64(v)),
});
const wdAsk: PoolAsk = { kind: "pool.withdraw", chain: "solana", token: null, amount: 0n, slippageBps: 0, decimals: 9 };
const wdWire = (ixs: Ixx[], signers = [SOL_FEE_PAYER, SOL_W]) => wire(signers[0]!, ixs, signers);

test("Solana withdraw: the device's release to W through the pinned pool, alone, passes and draws W as where it lands", () => {
  const d = checkSolanaWithdraw(wdWire([cuLimit, relIx()]), wdAsk, solCtx(), release, SOL_READS);
  assert.deepEqual(d, { chain: "solana", op: "pool.withdraw", token: null, amount: release.withdrawnValue - release.relayFee, feeCap: release.relayFeeCap, pool: POOL, to: SOL_W, decimals: 9, back: null });
  assert.deepEqual(drawPool(d).map((l) => l[0]), ["Chain", "Amount", "To", "Max fee", "Pool"]);
  // review #232 HIGH 1: a send after the release would let W's holder fail the fee payer's transaction at will
  assert.throws(() => checkSolanaWithdraw(wdWire([cuLimit, relIx(), send()]), wdAsk, solCtx(), release, SOL_READS), refusedAs("instructions"), "the release is alone");
});

test("Solana withdraw: another pool program, release, recipient, fee payer, a fee cap over the device's, a past deadline or anything after the release is refused", () => {
  const other = { ...release, withdrawnValue: release.withdrawnValue - 1n };
  for (const [w, ctx, rule] of [
    [wdWire([relIx(release, SOL_W, SOL_FEE_PAYER, key(43))]), solCtx(), "program"],
    [wdWire([relIx(other)]), solCtx(), "release_not_devices"],
    [wdWire([relIx(release, key(50))], [SOL_FEE_PAYER, key(50)]), solCtx(), "signers"],
    [wdWire([relIx(release, SOL_W, key(51))], [key(51), SOL_W]), solCtx(), "signers"],
    [wdWire([relIx()]), solCtx({ feeCap: release.relayFeeCap - 1n }), "fee_cap_over_device_cap"],
    [wdWire([relIx()]), solCtx({ nowMs: release.deadlineMs }), "deadline_past"],
    [wdWire([relIx(), send(key(78))]), solCtx(), "instructions"],
    [wdWire([relIx(), send(), send()]), solCtx(), "instructions"],
    [wdWire([{ ...relIx(), accounts: relIx().accounts.map((x, i) => (i === 0 ? { ...x, key: key(48) } : x)) }]), solCtx(), "release_accounts"],
    [wdWire([{ ...relIx(), accounts: relIx().accounts.map((x, i) => (i === 6 ? { ...x, key: solanaPoolPage(PROGRAM, 0, 2_000) } : x)) }]), solCtx(), "release_accounts"],
  ] as const) {
    assert.throws(() => checkSolanaWithdraw(w, wdAsk, ctx, release, SOL_READS), refusedAs(rule), rule);
  }
});

// ---------- Solana withdraw: W's own send onward ----------

const ON_BAL = 9_000_000n;
const ON_FEE = 5_000n;
const onReads = (o: Partial<SolanaOnwardReads> = {}): SolanaOnwardReads => ({
  blockhash: BLOCKHASH, balance: [ON_BAL, ON_BAL], fee: [ON_FEE, ON_FEE], toExecutable: [false, false],
  releaseAccounts: relIx().accounts.map((a) => a.key), ...o,
});
const onWire = (ixs: Ixx[] = [send(TO, ON_BAL - ON_FEE)], signers = [SOL_W], bh = BLOCKHASH) => wire(signers[0]!, ixs, signers, bh);

test("Solana withdraw onward: W's one transfer of all it holds less its own fee to the typed address passes and draws", () => {
  const d = checkSolanaOnwardSend(onWire(), wdAsk, solCtx(), TO, onReads());
  assert.deepEqual(d, { chain: "solana", op: "pool.withdraw", token: null, amount: ON_BAL - ON_FEE, feeCap: ON_FEE, pool: POOL, to: TO, decimals: 9, back: null });
  assert.deepEqual(drawPool(d)[2], ["To", TO]);
});

test("Solana withdraw onward: a fee payer of ours, a second signer, a compute budget, a send elsewhere, dust left on W, more than W holds or a stale blockhash is refused", () => {
  for (const [w, rule] of [
    [onWire([send(TO, ON_BAL - ON_FEE)], [SOL_FEE_PAYER, SOL_W]), "signers"],
    [onWire([send(TO, ON_BAL - ON_FEE), send(TO, 1n, key(52))], [SOL_W, key(52)]), "signers"],
    [onWire([cuLimit, send(TO, ON_BAL - ON_FEE)]), "instructions"],
    [onWire([send(TO, ON_BAL - ON_FEE - 1n), send(TO, 1n)]), "instructions"],
    [onWire([send(key(78), ON_BAL - ON_FEE)]), "transfer_to"],
    [onWire([send(TO, ON_BAL - ON_FEE - 1n)]), "transfer_amount"],
    [onWire([send(TO, ON_BAL - ON_FEE + 1n)]), "transfer_amount"],
    [onWire([send(TO, ON_BAL)]), "transfer_amount"],
    [onWire([{ ...send(TO, ON_BAL - ON_FEE), program: key(44) }]), "transfer"],
    // a System instruction of the same size that is not a transfer (tag 3 here)
    [onWire([{ ...send(TO, ON_BAL - ON_FEE), data: Uint8Array.of(3, 0, 0, 0, ...u64(ON_BAL - ON_FEE)) }]), "transfer"],
    [onWire([send(TO, ON_BAL - ON_FEE)], [SOL_W], key(8)), "blockhash"],
  ] as const) {
    assert.throws(() => checkSolanaOnwardSend(w, wdAsk, solCtx(), TO, onReads()), refusedAs(rule), rule);
  }
  // W holding exactly its fee sends nothing: refused, never a 0 transfer
  assert.throws(() => checkSolanaOnwardSend(onWire([send(TO, 0n)]), wdAsk, solCtx(), TO, onReads({ balance: [ON_FEE, ON_FEE] })), refusedAs("transfer_amount"));
});

test("Solana withdraw onward: To that is W, the pool, its program, the fee payer, System, an account of the release or executable on either RPC is refused", () => {
  const rel = relIx().accounts.map((a) => a.key);
  for (const to of [SOL_W, POOL, PROGRAM, SOL_FEE_PAYER, SOLANA_SYSTEM_PROGRAM, rel[3]!, rel[4]!, rel[5]!, rel[6]!]) {
    assert.throws(() => checkSolanaOnwardSend(onWire([send(to, ON_BAL - ON_FEE)]), wdAsk, solCtx(), to, onReads()), refusedAs("to"), to);
  }
  assert.throws(() => checkSolanaOnwardSend(onWire(), wdAsk, solCtx(), "not a key", onReads()), refusedAs("to"));
  for (const toExecutable of [[true, false], [false, true], [true, true]] as const) {
    assert.throws(() => checkSolanaOnwardSend(onWire(), wdAsk, solCtx(), TO, onReads({ toExecutable })), refusedAs("to"));
  }
});

test("Solana withdraw onward: reads the two RPCs disagree on are refused, and a buy kind is refused", () => {
  assert.throws(() => checkSolanaOnwardSend(onWire(), wdAsk, solCtx(), TO, onReads({ balance: [ON_BAL, ON_BAL + 1n] })), refusedAs("reads"));
  assert.throws(() => checkSolanaOnwardSend(onWire(), wdAsk, solCtx(), TO, onReads({ fee: [ON_FEE, ON_FEE - 1n] })), refusedAs("reads"));
  assert.throws(() => checkSolanaOnwardSend(onWire(), { ...wdAsk, kind: "pool.buy" }, solCtx(), TO, onReads()), refusedAs("kind"));
});

// ---------- Solana buy (tag 3) ----------

test("Solana buy: the kit's tag 3 on the pinned pool for W, the request's token and spend, passes; every bad binding is refused", async () => {
  const { venue, req, chain, reads } = await setup("pump");
  const built = buildSolanaPoolBuy({ program: FX_PROGRAM, pool: solanaProgramAddress([enc("pool")], FX_PROGRAM) }, fxRelease, venue, req, chain, { pick: () => 3 });
  const ctx: PoolContext = { nowMs: NOW, wallet: FX_W, feeCap: 3_000_000n, solana: { program: FX_PROGRAM, feePayer: FEE_PAYER } };
  const ask: PoolAsk = { kind: "pool.buy", chain: "solana", token: req.token, amount: req.spend, slippageBps: 300, decimals: 9 };
  const d = checkSolanaBuy(built.wire, ask, ctx, fxRelease, venue, req, reads);
  assert.equal(d.to, FX_W);
  assert.equal(d.token, req.token);
  for (const [a, c, r, rule] of [
    [ask, { ...ctx, wallet: key(60) }, req, "wallet"],
    [ask, { ...ctx, solana: { program: key(61), feePayer: FEE_PAYER } }, req, "buy_FRAME"],
    [ask, { ...ctx, solana: { program: FX_PROGRAM, feePayer: key(62) } }, req, "fee_payer"],
    [{ ...ask, token: key(63) }, ctx, req, "token"],
    [{ ...ask, amount: req.spend + 1n }, ctx, req, "amount"],
    [{ ...ask, slippageBps: 301 }, ctx, req, "slippage"],
    [ask, { ...ctx, feeCap: fxRelease.relayFeeCap - 1n }, req, "fee_cap_over_device_cap"],
    [ask, { ...ctx, nowMs: fxRelease.deadlineMs }, req, "deadline_past"],
  ] as const) {
    assert.throws(() => checkSolanaBuy(built.wire, a as PoolAsk, c as PoolContext, fxRelease, venue, r, reads), refusedAs(rule), rule);
  }
  // a release whose fee is over its own cap (the kit's encoder refuses one; the check holds it before the kit runs)
  assert.throws(() => checkSolanaBuy(built.wire, ask, ctx, { ...fxRelease, relayFee: fxRelease.relayFeeCap + 1n }, venue, req, reads), refusedAs("fee_over_cap"));
  // bytes the kit did not build: one byte of the message changed
  const bent = Uint8Array.from(built.wire);
  bent[bent.length - 1] ^= 1;
  assert.throws(() => checkSolanaBuy(bent, ask, ctx, fxRelease, venue, req, reads), (e: unknown) => e instanceof PoolRuleRefused && e.rule.startsWith("buy_"));
});

// ---------- Solana sell ----------

test("Solana sell: the kit's venue sell from W at or above the device's floor, then a deposit of exactly min out less the device's reserve into the pinned pool, passes and draws it; each bad field is refused", async () => {
  const { venue, ref, reads } = await setup("pump");
  const amount = 5_000_000n;
  const reference = { amount, ref, slippageBps: 300 };
  const slot = reads.slot;
  const floor = (ref.pools.find((p) => p.venue === "pump-curve")!.expectedOut * 9_700n) / 10_000n;
  const ask: PoolAsk = { kind: "pool.sell", chain: "solana", token: venue.mint, amount, slippageBps: 300, decimals: 6 };
  const sellWire = (o: { minOut?: bigint; amount?: bigint; dep?: Partial<Parameters<typeof depositIx>[0]>; w?: string; extra?: Ixx[] } = {}) => {
    const steps = solanaPoolSellSteps(venue, o.w ?? SOL_W, o.amount ?? amount, o.minOut ?? floor).map((x) => ({ ...x, accounts: x.accounts.map((a) => ({ ...a })) }));
    return wire(o.w ?? SOL_W, [cuLimit, ...steps, ...(o.extra ?? []), depositIx({ value: (o.minOut ?? floor) - RESERVE, ...o.dep })]);
  };
  const RESERVE = 5_000n;
  const d = checkSolanaSell(sellWire(), ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE);
  assert.deepEqual([d.op, d.token, d.amount, d.pool, d.to, d.back, d.decimals], ["pool.sell", venue.mint, amount, POOL, POOL, floor - RESERVE, 6]);
  assert.deepEqual(drawPool(d).map((l) => l[0]), ["Chain", "Token", "Amount", "To", "To private balance", "Max fee", "Pool"]);
  assert.deepEqual(drawPool(d)[2], ["Amount", "5"]);
  assert.deepEqual(drawPool(d)[4], ["To private balance", String(Number(floor - RESERVE) / 1e9)]);
  // an amount under 1 keeps its leading zeros: 5,000,000 lamports is 0.005 SOL
  assert.deepEqual(drawPool({ ...d, back: 5_000_000n })[4], ["To private balance", "0.005"]);
  // the reserve is the device's own fee money for W, never more than its fixed cap: the cap passes, one lamport more is refused
  // the worst legitimate cost on W (src/rules/pool.ts): the fee at its cap, the mark and a new page on both trees
  assert.equal(SOLANA_POOL_SELL_RESERVE_MAX, 1_405_000n + (128n + 17n) * 6_960n + 2n * (128n + 16n + 72n) * 6_960n);
  assert.equal(SOLANA_POOL_SELL_RESERVE_MAX, 5_420_920n);
  assert.ok(floor > SOLANA_POOL_SELL_RESERVE_MAX + 1n, "the fixture's min out is above the cap");
  const atCap = (r: bigint) => {
    const steps = solanaPoolSellSteps(venue, SOL_W, amount, floor).map((x) => ({ ...x, accounts: x.accounts.map((a) => ({ ...a })) }));
    return checkSolanaSell(wire(SOL_W, [cuLimit, ...steps, depositIx({ value: floor - r })]), ask, solCtx(), venue, reference, slot, SOL_READS, r);
  };
  assert.equal(atCap(SOLANA_POOL_SELL_RESERVE_MAX).back, floor - SOLANA_POOL_SELL_RESERVE_MAX);
  assert.throws(() => atCap(SOLANA_POOL_SELL_RESERVE_MAX + 1n), refusedAs("reserve"));
  assert.throws(() => atCap(floor - 1n), refusedAs("reserve"));
  // a higher min out the bytes carry is fine, its deposit that min out less the reserve
  assert.equal(checkSolanaSell(sellWire({ minOut: floor + 10n }), ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE).back, floor + 10n - RESERVE);
  for (const [w, rule] of [
    [sellWire({ minOut: floor - 1n }), "min_out"],
    [sellWire({ amount: amount - 1n }), "sell"],
    [sellWire({ dep: { value: floor + 1n } }), "deposit_amount"],
    [sellWire({ dep: { value: floor - RESERVE + 1n } }), "deposit_amount"],
    [sellWire({ dep: { value: floor - RESERVE - 1n } }), "deposit_amount"],
    [sellWire({ dep: { value: 1n } }), "deposit_amount"],
    [sellWire({ dep: { pool: key(44) } }), "pool"],
    [sellWire({ dep: { pre: PRE + 1n } }), "precommitment"],
    [sellWire({ dep: { program: key(43) } }), "program"],
    [sellWire({ extra: [send(key(79), 1n)] }), "sell"],
  ] as const) {
    assert.throws(() => checkSolanaSell(w, ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE), refusedAs(rule), rule);
  }
  assert.throws(() => checkSolanaSell(sellWire(), { ...ask, token: key(63) }, solCtx(), venue, reference, slot, SOL_READS, RESERVE), refusedAs("token"));
  assert.throws(() => checkSolanaSell(sellWire(), { ...ask, slippageBps: 301 }, solCtx(), venue, reference, slot, SOL_READS, RESERVE), refusedAs("slippage"));
  for (const r of [-1n, floor, floor + 1n, 5000 as never]) {
    assert.throws(() => checkSolanaSell(sellWire(), ask, solCtx(), venue, reference, slot, SOL_READS, r), refusedAs("reserve"), String(r));
  }
});

// ---------- EVM ----------

const N = secp256k1.Point.CURVE().n;
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
function hardhatAccount0(): Uint8Array {
  const seed = pbkdf2(sha512, enc("test test test test test test test test test test test junk"), enc("mnemonic"), { c: 2048, dkLen: 64 });
  let I = hmac(sha512, enc("Bitcoin seed"), seed);
  let k = BigInt(hex(I.slice(0, 32)));
  let c = I.slice(32);
  for (const [i, hard] of [[44, true], [60, true], [0, true], [0, false], [0, false]] as [number, boolean][]) {
    const kb = Buffer.from(k.toString(16).padStart(64, "0"), "hex");
    const head = hard ? Uint8Array.of(0, ...kb) : secp256k1.getPublicKey(kb, true);
    const idx = Buffer.alloc(4);
    idx.writeUInt32BE(hard ? i + 0x80000000 : i);
    I = hmac(sha512, c, Uint8Array.of(...head, ...idx));
    k = (BigInt(hex(I.slice(0, 32))) + k) % N;
    c = I.slice(32);
  }
  return Buffer.from(k.toString(16).padStart(64, "0"), "hex");
}
const EVM_SECRET = hardhatAccount0();
const EVM_W = hex(keccak_256(secp256k1.getPublicKey(EVM_SECRET, false).slice(1)).slice(12));
const B = evmPoolVenues().base;
const X = "0xF111111111111111111111111111111111111111";
const EVM_POOL = "0x00000000000000000000000000000000000f0011";
const A_V3 = "0x000000000000000000000000000000000000ad03";
const A_V4 = "0x000000000000000000000000000000000000ad04";
const DELEGATE = "0x00000000000000000000000000000000000de1e9";
const FEE_TO = "0x0000000000000000000000000000000000000fee";
const pin = (v: EvmPoolVenue, o: Partial<EvmPoolVenue>): EvmPoolVenue => Object.freeze({ ...v, ...o });
const VENUES = Object.freeze({ base: pin(B, { pool: EVM_POOL, adapters: Object.freeze({ v3: A_V3, v4: A_V4 }), sellDelegate: DELEGATE }) });
const evmCtx = (o: Partial<PoolContext> = {}): PoolContext => ({ nowMs: NOW, wallet: EVM_W, feeCap: 10n ** 15n, evm: { venues: VENUES, feeRecipient: FEE_TO }, ...o });
const relay = (o: Partial<EvmRelayData> = {}): EvmRelayData => ({ recipient: EVM_W, feeRecipient: FEE_TO, feeCap: 10n ** 14n, deadlineMs: NOW + 120_000n, refundPrecommitment: 7n, salt: "0x" + "ab".repeat(16), ...o });
const ctxOf = (r: EvmRelayData, pool = EVM_POOL) => evmPoolContextOf({ processooor: pool, relay: r }, evmPoolScopeOf(pool, BigInt(B.chainId)));
const proofOf = (r: EvmRelayData, value = 10n ** 16n) => ({ nullifier: 11n, context: ctxOf(r), value });
const v3 = (tokens: string[]) => ({ venue: "uniswap-v3" as const, tokens, fees: tokens.slice(1).map(() => 500) });

test("EVM buy: the kit's pinned Buy of the request's token, the proof bound to W's relay data on the pinned pool, passes and signs; each bad field is refused", () => {
  const built = pinnedBuild(VENUES, "base", A_V3, v3([B.weth, X]), 1n, X);
  const r = relay();
  const ask: PoolAsk = { kind: "pool.buy", chain: "base", token: X, amount: 10n ** 16n, slippageBps: 100, decimals: 18 };
  const proof = proofOf(r);
  const d = checkEvmBuy(built, EVM_POOL, proof, r, ask, evmCtx(), 1n);
  assert.deepEqual([d.to, d.pool, d.feeCap], [EVM_W, EVM_POOL, r.feeCap]);
  const sig = signEvmBuy(EVM_SECRET, evmCtx(), built, EVM_POOL, proof);
  assert.equal(sig.length, 65);
  // the signer signs what the check read: a context handed to it after, with another venue list, changes nothing
  const otherCtx = evmCtx({ evm: { venues: Object.freeze({ base: pin(B, { pool: EVM_POOL, chainId: 1, adapters: Object.freeze({ v3: A_V3 }) }) }), feeRecipient: FEE_TO } });
  assert.deepEqual(signEvmBuy(EVM_SECRET, otherCtx, built, EVM_POOL, proof), sig);
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built, "0x2222222222222222222222222222222222222222", proof), refusedAs("unchecked"));
  // a built and a proof each passed by its own check are never signed together
  const r2 = relay({ salt: "0x" + "cd".repeat(16) });
  const built2 = pinnedBuild(VENUES, "base", A_V3, v3([B.weth, X]), 2n, X);
  const proof2 = proofOf(r2, 10n ** 18n);
  checkEvmBuy(built2, EVM_POOL, proof2, r2, { ...ask, amount: 10n ** 18n }, evmCtx(), 1n);
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built, EVM_POOL, proof2), refusedAs("unchecked"));
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built2, EVM_POOL, proof), refusedAs("unchecked"));
  // only what the check passed: another proof object, a proof changed after, a proof checked as a buy signed as a withdraw
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built, EVM_POOL, proofOf(r)), refusedAs("unchecked"));
  assert.throws(() => signEvmWithdraw(EVM_SECRET, evmCtx(), { ...ask, kind: "pool.withdraw" }, EVM_POOL, proof), refusedAs("unchecked"));
  const moved = proofOf(r);
  checkEvmBuy(built, EVM_POOL, moved, r, ask, evmCtx(), 1n);
  moved.context += 1n;
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built, EVM_POOL, moved), refusedAs("unchecked"));
  const other = "0x2222222222222222222222222222222222222222";
  for (const [f, rule] of [
    [() => checkEvmBuy(built, other, proofOf(r), r, ask, evmCtx(), 1n), "pool"],
    [() => checkEvmBuy(pinnedBuild({ base: pin(B, { pool: EVM_POOL, adapters: { v3: other } }) }, "base", other, v3([B.weth, X]), 1n, X), EVM_POOL, proofOf(r), r, ask, evmCtx(), 1n), "adapter"],
    [() => checkEvmBuy(built, EVM_POOL, proofOf(r), r, { ...ask, token: other }, evmCtx(), 1n), "token"],
    [() => checkEvmBuy(built, EVM_POOL, proofOf(r), r, { ...ask, amount: 1n }, evmCtx(), 1n), "amount"],
    [() => checkEvmBuy(built, EVM_POOL, proofOf(r), r, { ...ask, chain: "robinhood" }, evmCtx(), 1n), "chain"],
    [() => checkEvmBuy(built, EVM_POOL, proofOf(relay({ recipient: other })), relay({ recipient: other }), ask, evmCtx(), 1n), "recipient"],
    [() => checkEvmBuy(built, EVM_POOL, proofOf(relay({ feeRecipient: other })), relay({ feeRecipient: other }), ask, evmCtx(), 1n), "fee_recipient"],
    [() => checkEvmBuy(built, EVM_POOL, proofOf(relay({ feeCap: 10n ** 15n + 1n })), relay({ feeCap: 10n ** 15n + 1n }), ask, evmCtx(), 1n), "fee_cap_over_device_cap"],
    [() => checkEvmBuy(built, EVM_POOL, proofOf(relay({ deadlineMs: NOW })), relay({ deadlineMs: NOW }), ask, evmCtx(), 1n), "deadline_past"],
    [() => checkEvmBuy(built, EVM_POOL, proofOf(relay({ salt: "0x" + "cd".repeat(16) })), r, ask, evmCtx(), 1n), "context"],
    [() => checkEvmBuy(built, EVM_POOL, proofOf(r), r, ask, evmCtx({ evm: undefined }), 1n), "evm_not_pinned"],
    [() => checkEvmBuy(built, EVM_POOL, proofOf(r), r, ask, evmCtx(), 2n), "min_out"],
  ] as const) {
    assert.throws(f, refusedAs(rule), rule);
  }
  // bytes the kit did not build: a copy of the kit's Buy is refused by the kit's pinned signer
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), { ...built }, EVM_POOL, proof), refusedAs("unchecked"));
});

test("EVM withdraw: Withdraw(nullifier, context, value) on the pinned pool to W passes and signs as PrivacyPool recovers it; each bad field is refused", () => {
  const r = relay();
  const ask: PoolAsk = { kind: "pool.withdraw", chain: "base", token: null, amount: 0n, slippageBps: 0, decimals: 18 };
  const proof = proofOf(r);
  const d = checkEvmWithdraw(EVM_POOL, proof, r, ask, evmCtx());
  assert.deepEqual([d.to, d.amount], [EVM_W, proof.value]);
  const sig = signEvmWithdraw(EVM_SECRET, evmCtx(), ask, EVM_POOL, proof);
  const rec = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(sig[64]! - 27).recoverPublicKey(evmWithdrawDigest(BigInt(B.chainId), EVM_POOL, proof));
  assert.equal(hex(keccak_256(rec.toBytes(false).slice(1)).slice(12)), EVM_W, "the signature recovers to W");
  const other = "0x2222222222222222222222222222222222222222";
  for (const [f, rule] of [
    [() => checkEvmWithdraw(other, proof, r, ask, evmCtx()), "pool"],
    [() => checkEvmWithdraw(EVM_POOL, proofOf(relay({ recipient: other })), relay({ recipient: other }), ask, evmCtx()), "recipient"],
    [() => checkEvmWithdraw(EVM_POOL, proof, r, ask, evmCtx({ nowMs: r.deadlineMs })), "deadline_past"],
    [() => checkEvmWithdraw(EVM_POOL, proof, r, ask, evmCtx({ feeCap: r.feeCap - 1n })), "fee_cap_over_device_cap"],
    [() => checkEvmWithdraw(EVM_POOL, { ...proof, context: proof.context + 1n }, r, ask, evmCtx()), "context"],
    [() => checkEvmWithdraw(EVM_POOL, proof, r, { ...ask, kind: "pool.buy" }, evmCtx()), "kind"],
    [() => signEvmWithdraw(EVM_SECRET, evmCtx(), ask, other, proof), "pool"],
    // a venue list whose chain id is not a safe integer above 0 signs no domain
    [() => checkEvmWithdraw(EVM_POOL, proof, r, ask, evmCtx({ evm: { venues: Object.freeze({ base: pin(B, { pool: EVM_POOL, chainId: 0 }) }), feeRecipient: FEE_TO } })), "chain"],
    [() => checkEvmWithdraw(EVM_POOL, proof, r, ask, evmCtx({ evm: { venues: Object.freeze({ base: pin(B, { pool: EVM_POOL, chainId: 2 ** 53 }) }), feeRecipient: FEE_TO } })), "chain"],
  ] as const) {
    assert.throws(f, refusedAs(rule), rule);
  }
});

test("EVM sell and authorization: W's own Sell into the pinned pool and the pinned delegate at W's two-RPC nonce pass and sign; each bad field is refused", () => {
  const t = BigInt(Math.floor(Date.now() / 1000));
  const req = { w: EVM_W, token: X, amount: 10n ** 18n, target: B.routers[0]!, route: v3([X, B.weth]), minOut: 10n ** 15n, precommitment: 5n, feeCap: 10n ** 13n, deadline: t + 120n, nonce: 0n };
  const built = pinnedBuildSell(VENUES, "base", req);
  const ask: PoolAsk = { kind: "pool.sell", chain: "base", token: X, amount: 10n ** 18n, slippageBps: 100, decimals: 18 };
  const ctx = { ...evmCtx({ nowMs: t * 1000n }), precommitment: 5n };
  const d = checkEvmSell(built, ask, ctx, req.minOut);
  assert.deepEqual([d.pool, d.amount, d.feeCap], [EVM_POOL, req.amount, req.feeCap]);
  assert.equal(signEvmSell(EVM_SECRET, ctx, built).length, 65);
  const other = "0x2222222222222222222222222222222222222222";
  for (const [f, rule] of [
    [() => checkEvmSell(built, ask, { ...ctx, wallet: other }, 1n), "wallet"],
    [() => checkEvmSell(built, { ...ask, token: other }, ctx, 1n), "token"],
    [() => checkEvmSell(built, { ...ask, amount: 1n }, ctx, 1n), "amount"],
    [() => checkEvmSell(built, ask, { ...ctx, feeCap: req.feeCap - 1n }, 1n), "fee_cap_over_device_cap"],
    [() => checkEvmSell(built, ask, { ...ctx, nowMs: req.deadline * 1000n }, 1n), "deadline_past"],
    [() => checkEvmSell(built, ask, { ...ctx, evm: { venues: { base: pin(B, { pool: other }) }, feeRecipient: FEE_TO } }, 1n), "pool"],
    [() => checkEvmSell(built, { ...ask, kind: "pool.buy" }, ctx, 1n), "kind"],
    [() => checkEvmSell(built, ask, ctx, req.minOut + 1n), "min_out"],
    // the proceeds go into the pool under the device's own precommitment only, never another's note
    [() => checkEvmSell(built, ask, { ...ctx, precommitment: 6n }, 1n), "precommitment"],
  ] as const) {
    assert.throws(f, refusedAs(rule), rule);
  }
  assert.throws(() => signEvmSell(EVM_SECRET, ctx, { ...built }), refusedAs("unchecked"), "a copy is not what the check passed");
  const a = checkEvmAuthorization(ask, ctx, 4n, [4n, 4n]);
  assert.deepEqual(a, { chain: "base", delegate: DELEGATE, nonce: 4n });
  assert.equal(signEvmAuthorization(EVM_SECRET, ctx, a).address, DELEGATE);
  // the signer signs what the check read: a context handed to it after, naming another delegate, changes nothing
  const EVIL = "0x00000000000000000000000000000000000ba0ba";
  const evil = { ...ctx, evm: { venues: Object.freeze({ base: pin(B, { pool: EVM_POOL, adapters: Object.freeze({ v3: A_V3 }), sellDelegate: EVIL }) }), feeRecipient: FEE_TO } };
  assert.equal(signEvmAuthorization(EVM_SECRET, evil, a).address, DELEGATE);
  assert.throws(() => signEvmAuthorization(EVM_SECRET, ctx, { chain: "base", delegate: DELEGATE, nonce: 9n }), refusedAs("unchecked"));
  assert.throws(() => checkEvmAuthorization(ask, ctx, 4n, [4n, 5n]), refusedAs("nonce"));
  assert.throws(() => checkEvmAuthorization(ask, ctx, 3n, [4n, 4n]), refusedAs("nonce"));
  assert.throws(() => checkEvmAuthorization(ask, { ...ctx, evm: { venues: { base: pin(B, { pool: EVM_POOL }) }, feeRecipient: FEE_TO } }, 4n, [4n, 4n]), refusedAs("delegate_not_pinned"));
});

// ---------- no rule reads a server ----------

test("no rule reads a field from a server: the rule file imports no fetch, helper, RPC caller or relay client and calls none", () => {
  const src = readFileSync(new URL("../src/rules/pool.ts", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/**")).join("\n");
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
  assert.doesNotMatch(code, /helper\/v1|withdraw\/relay|solanaJsonRpc|solanaHelperRpc|readSolana[A-Z]\w*\(|evmAgreed|evmNow|RELEASE_HELPER|TRADE_HELPER/);
  const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports.filter((p) => !/^@noble\/|^@scure\//.test(p!) && !/(checks\/solana\/(message|checks)|trade\/solana\/pool-buy|trade\/evm\/(buy|sell)-unpinned|wallet\/src\/pool\/evm)\.ts$/.test(p!)), []);
});
