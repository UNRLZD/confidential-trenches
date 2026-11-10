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
  solanaRentMin,
  type SolanaPoolRelease,
} from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaSellReserve } from "../src/pool-sell.ts";
import { solanaPoolNoteFloor } from "../../kit/src/trade/solana/pool-deposit.ts";
import { evmPoolVenues, pinnedBuild, type EvmPoolVenue } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolBuildSimSellUnpinned, pinnedBuildSell } from "../../kit/src/trade/evm/sell-unpinned.ts";
import { evmPoolBuyQuoteWith, type EvmPoolBuyQuote, type EvmRpc, type EvmRpcCall } from "../../kit/src/checks/evm/quote.ts";
import { evmQuotedBuy, evmQuotedSell } from "../../kit/src/trade/evm/quoted.ts";
import { flat, provider as sellModel, req as sellReq, sellQuoteWith } from "../../kit/test/evm-sell-quote-fx.ts";
import { asRecorded, gasRoundAnswers, withMarker } from "../../kit/test/evm-quote-gas-fx.ts";
import { evmPoolContextOf, evmPoolScopeOf, type EvmRelayData } from "../../wallet/src/pool/evm.ts";
import { FEE_PAYER, PROGRAM as FX_PROGRAM, W as FX_W, release as fxRelease, setup } from "../../kit/test/solana-pool-buy-fx.ts";
import {
  POOL_KINDS,
  PoolRuleRefused,
  checkEvmAuthorization,
  checkEvmBuy,
  checkEvmSell,
  checkEvmSellSim,
  signEvmSellSim,
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
  SOLANA_POOL_MIN_DEPOSIT,
  solanaSweepFloor,
  solanaDepositRents,
  solanaSellAfterFull,
  type SolanaDepositHeld,
  type SolanaSellSurplus,
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

test("card pool-sell-share-across-wallets: a sell by share is 1 to 10,000 basis points of the whole holding with no amount beside it, the token's decimals still read; no other kind takes a share", () => {
  const sol = key(5);
  assert.deepEqual(checkPoolRequest({ kind: "pool.sell", chain: "solana", token: sol, share_bps: 7_500, slippage_bps: 300 }, solMint(6)), { kind: "pool.sell", chain: "solana", token: sol, amount: 0n, slippageBps: 300, decimals: 6, shareBps: 7_500 });
  assert.equal(checkPoolRequest({ kind: "pool.sell", chain: "solana", token: sol, share_bps: 10_000, slippage_bps: 0 }, solMint(6)).shareBps, 10_000);
  // an amount-only request is as before: no share
  assert.equal(checkPoolRequest({ kind: "pool.sell", chain: "solana", token: sol, amount: "2", slippage_bps: 0 }, solMint(6)).shareBps, undefined);
  for (const [p, rule] of [
    [{ kind: "pool.sell", chain: "solana", token: sol, share_bps: 0, slippage_bps: 1 }, "amount"],
    [{ kind: "pool.sell", chain: "solana", token: sol, share_bps: 10_001, slippage_bps: 1 }, "amount"],
    [{ kind: "pool.sell", chain: "solana", token: sol, share_bps: 50.5, slippage_bps: 1 }, "amount"],
    [{ kind: "pool.sell", chain: "solana", token: sol, share_bps: "5000", slippage_bps: 1 }, "amount"],
    [{ kind: "pool.sell", chain: "solana", token: sol, share_bps: 5_000, amount: "1", slippage_bps: 1 }, "amount"],
    [{ kind: "pool.sell", chain: "solana", token: sol, slippage_bps: 1 }, "amount"],
    [{ kind: "pool.sell", chain: "solana", token: sol, share_bps: 5_000, slippage_bps: 5_001 }, "slippage"],
    [{ kind: "pool.buy", chain: "solana", token: sol, share_bps: 5_000, slippage_bps: 1 }, "amount"],
    [{ kind: "pool.deposit", chain: "solana", share_bps: 5_000 }, "amount"],
  ] as const) {
    assert.throws(() => checkPoolRequest(p as never, solMint(6)), refusedAs(rule), JSON.stringify(p));
  }
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
// the kit's tag 1 since card pool-senders-next-page: the six, then each tree's next page (deposit.rs:72-76)
const depositIx = (o: { program?: string; pool?: string; from?: string; fromSigns?: boolean; value?: bigint; pre?: bigint; state?: number; label?: number; mark?: string; system?: string; nextState?: string; nextLabel?: string; six?: boolean } = {}): Ixx => {
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
      ...(o.six ? [] : [acc(o.nextState ?? solanaPoolPage(PROGRAM, 0, 1024), false, true), acc(o.nextLabel ?? solanaPoolPage(PROGRAM, 1, 1024), false, true)]),
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
    // card pool-senders-next-page: the next pages are each tree's page after its size's, writable; a seventh account or a ninth is no form
    [ok([cuLimit, depositIx({ nextState: solanaPoolPage(PROGRAM, 0, 2048) })]), "state_page"],
    [ok([cuLimit, depositIx({ nextState: solanaPoolPage(PROGRAM, 1, 1024) })]), "state_page"],
    [ok([cuLimit, depositIx({ nextLabel: solanaPoolPage(PROGRAM, 1, 0) })]), "label_page"],
    [ok([cuLimit, { ...depositIx(), accounts: depositIx().accounts.slice(0, 7) }]), "deposit_accounts"],
    [ok([cuLimit, { ...depositIx(), accounts: [...depositIx().accounts, acc(SOLANA_SYSTEM_PROGRAM, false, false)] }]), "deposit_accounts"],
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

// Card pool-senders-next-page, review of 14b04117: the trees on different pages (releases grow the state tree alone),
// each tree's next page from its own size; the next page's privileges held; a plain deposit takes the eight only.
test("Solana deposit: each tree's next page from its own size, the trees on different pages; a read-only next page or the six alone is refused", () => {
  const next = (tree: 0 | 1, size: number) => solanaPoolPage(PROGRAM, tree, (Math.floor(size / 1024) + 1) * 1024);
  for (const [s, l] of [[1030, 1000], [1000, 1030]] as const) {
    const reads = { ...SOL_READS, stateSize: s, labelSize: l };
    const dep = (o: Parameters<typeof depositIx>[0] = {}) => wire(SOL_W, [cuLimit, depositIx({ state: s, label: l, nextState: next(0, s), nextLabel: next(1, l), ...o })]);
    assert.equal(checkSolanaDeposit(dep(), depAsk, solCtx(), reads).amount, 2_000_000_000n, `${s}/${l}`);
    // the state tree's next page from the label tree's size, and the label's from the state's: refused
    assert.throws(() => checkSolanaDeposit(dep({ nextState: next(0, l) }), depAsk, solCtx(), reads), refusedAs("state_page"), `${s}/${l} state`);
    assert.throws(() => checkSolanaDeposit(dep({ nextLabel: next(1, s) }), depAsk, solCtx(), reads), refusedAs("label_page"), `${s}/${l} label`);
  }
  // the right next page, read-only: refused
  const ro = (i: 6 | 7) => { const x = depositIx(); x.accounts[i] = { ...x.accounts[i]!, writable: false }; return wire(SOL_W, [cuLimit, x]); };
  assert.throws(() => checkSolanaDeposit(ro(6), depAsk, solCtx(), SOL_READS), refusedAs("state_page"));
  assert.throws(() => checkSolanaDeposit(ro(7), depAsk, solCtx(), SOL_READS), refusedAs("label_page"));
  // the six alone: every deposit the device builds names the next pages, so a plain deposit takes the eight only
  assert.throws(() => checkSolanaDeposit(wire(SOL_W, [cuLimit, depositIx({ six: true })]), depAsk, solCtx(), SOL_READS), refusedAs("deposit_accounts"));
});

// ---------- Solana withdraw (tag 2) ----------

const release: SolanaPoolRelease = { ...fxRelease, deadlineMs: NOW + 120_000n };
const TO = key(77);
const relIx = (r: SolanaPoolRelease = release, w = SOL_W, fp = SOL_FEE_PAYER, program = PROGRAM): Ixx => ({
  program,
  // the kit's tag 2 since card pool-senders-next-page: the release's eight, then the next state page (release.rs:155)
  accounts: [...solanaPoolReleaseAccounts({ program, pool: solanaProgramAddress([enc("pool")], program) }, w, fp, r, 6), acc(solanaPoolPage(program, 0, 1024), false, true)].map((a) => ({ ...a })),
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
    // card pool-senders-next-page: the ninth is the state tree's next page, writable, and it is there
    [wdWire([{ ...relIx(), accounts: relIx().accounts.map((x, i) => (i === 8 ? { ...x, key: solanaPoolPage(PROGRAM, 0, 2_048) } : x)) }]), solCtx(), "release_accounts"],
    [wdWire([{ ...relIx(), accounts: relIx().accounts.map((x, i) => (i === 8 ? { ...x, writable: false } : x)) }]), solCtx(), "release_accounts"],
    [wdWire([{ ...relIx(), accounts: relIx().accounts.slice(0, 8) }]), solCtx(), "release_accounts"],
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

test("Solana withdraw onward: To that is W, the pool, its program, the fee payer, a key the runtime keeps read-only, an account of the release or executable on either RPC is refused", () => {
  const rel = relIx().accounts.map((a) => a.key);
  for (const to of [SOL_W, POOL, PROGRAM, SOL_FEE_PAYER, SOLANA_SYSTEM_PROGRAM, "SysvarC1ock11111111111111111111111111111111", "SysvarRent111111111111111111111111111111111", "Vote111111111111111111111111111111111111111", "Stake11111111111111111111111111111111111111", rel[3]!, rel[4]!, rel[5]!, rel[6]!]) {
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
  // a partial sell's reads: the rent both RPCs read, the kit's release floor's (card sol-sell-deposit-back-floor)
  const PART: SolanaSellSurplus = { full: false, lamports: 0n, fee: 5_000n, made: 0n, rent: { lamportsPerByte: 5_080n, factor: 1n }, held: { mark: [null, null], state: [null, null], label: [null, null] }, next: false, owed: 0 };
  const d = checkSolanaSell(sellWire(), ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART);
  assert.deepEqual([d.op, d.token, d.amount, d.pool, d.to, d.back, d.decimals], ["pool.sell", venue.mint, amount, POOL, POOL, floor - RESERVE, 6]);
  // card pool-sell-share-across-wallets: a share is never checked as signed bytes; each wallet's sale is its units
  assert.throws(() => checkSolanaSell(sellWire(), { ...ask, shareBps: 10_000 }, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART), refusedAs("amount"));
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
    return checkSolanaSell(wire(SOL_W, [cuLimit, ...steps, depositIx({ value: floor - r })]), ask, solCtx(), venue, reference, slot, SOL_READS, r, PART);
  };
  assert.equal(atCap(SOLANA_POOL_SELL_RESERVE_MAX).back, floor - SOLANA_POOL_SELL_RESERVE_MAX);
  assert.throws(() => atCap(SOLANA_POOL_SELL_RESERVE_MAX + 1n), refusedAs("reserve"));
  assert.throws(() => atCap(floor - 1n), refusedAs("reserve"));
  // a higher min out the bytes carry is fine, its deposit that min out less the reserve
  assert.equal(checkSolanaSell(sellWire({ minOut: floor + 10n }), ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART).back, floor + 10n - RESERVE);
  // the deposit back in the six as well (card pool-senders-next-page: a sell over 1,232 bytes with the eight, the PumpSwap
  // cashback sell with no lookup table, sends the form before d3edab1); the next pages wrong are still refused
  assert.equal(checkSolanaSell(sellWire({ dep: { six: true } }), ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART).back, floor - RESERVE);
  assert.throws(() => checkSolanaSell(sellWire({ dep: { nextState: key(45) } }), ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART), refusedAs("state_page"));
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
    assert.throws(() => checkSolanaSell(w, ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART), refusedAs(rule), rule);
  }
  assert.throws(() => checkSolanaSell(sellWire(), { ...ask, token: key(63) }, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART), refusedAs("token"));
  assert.throws(() => checkSolanaSell(sellWire(), { ...ask, slippageBps: 301 }, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART), refusedAs("slippage"));
  for (const r of [-1n, floor, floor + 1n, 5000 as never]) {
    assert.throws(() => checkSolanaSell(sellWire(), ask, solCtx(), venue, reference, slot, SOL_READS, r, PART), refusedAs("reserve"), String(r));
  }
  // card sol-w-sweep, review L1 of 38faee89: a reserve under 0 (W's surplus deposited too) or over the cap only on a sell
  // that empties W's holding, priced exactly from the device's reads: what W holds over the fee, what the sell makes,
  // the deposit's rents and what W keeps for the rent back (solanaSellAfterFull for its owed claims, or rent(0) alone)
  const rent = { lamportsPerByte: 5_080n, factor: 1n } as SolanaSellSurplus["rent"];
  const none = [null, null] as const;
  const held: SolanaDepositHeld = { mark: none, state: none, label: none };
  const rents = solanaDepositRents(rent, SOL_READS, held, false);
  const keep = solanaSellAfterFull(rent, 0);
  const r0 = 650_240n;
  const surplus = 3_000_000n;
  const P: SolanaSellSurplus = { full: true, lamports: 5_000n + rents + keep + surplus, fee: 5_000n, made: 0n, rent, held, next: false, owed: 0 };
  const sell = (reserve: bigint, p?: SolanaSellSurplus) => checkSolanaSell(sellWire({ dep: { value: floor - reserve } }), ask, solCtx(), venue, reference, slot, SOL_READS, reserve, p);
  assert.equal(sell(-surplus, P).back, floor + surplus);
  // review 2 L1 of 911d7e25: rent(0) alone only where the device falls back; this note clears the floor with the keep
  assert.throws(() => sell(-surplus, { ...P, lamports: 5_000n + rents + r0 + surplus }), refusedAs("reserve"));
  // a full sell is priced exactly inside [0, cap] too: its reserve 3,052,720 passes, a million more or the full cap
  // from the same reads is refused
  const held3 = { ...P, lamports: 5_000n + rents + keep - 3_052_720n };
  assert.equal(sell(3_052_720n, held3).back, floor - 3_052_720n);
  assert.throws(() => sell(3_052_720n + 1_000_000n, held3), refusedAs("reserve"));
  assert.throws(() => sell(SOLANA_POOL_SELL_RESERVE_MAX, held3), refusedAs("reserve"));
  assert.throws(() => sell(0n, held3), refusedAs("reserve"));
  // the deposit must then be min out plus that surplus, exactly
  assert.throws(() => checkSolanaSell(sellWire(), ask, solCtx(), venue, reference, slot, SOL_READS, -surplus, P), refusedAs("deposit_amount"));
  // planted: a full sell keeping nothing (after 0, every lamport of W in the note) and a partial sell's surplus
  assert.throws(() => sell(-(surplus + keep), P), refusedAs("reserve"));
  assert.throws(() => sell(-surplus, { ...P, full: false }), refusedAs("reserve"));
  // no reads, a lamport off, the owed claims miscounted or out of range, a bad shape: refused
  assert.throws(() => sell(-1n), refusedAs("reserve"));
  assert.throws(() => sell(-surplus, { ...P, lamports: P.lamports - 1n }), refusedAs("reserve"));
  assert.throws(() => sell(-surplus, { ...P, owed: 1 }), refusedAs("reserve"));
  assert.throws(() => sell(-surplus, { ...P, owed: 3 }), refusedAs("reserve"));
  // three owed claims priced exactly as three: still refused, there are only two pump programs
  assert.throws(() => sell(-surplus, { ...P, owed: 3, lamports: 5_000n + rents + solanaSellAfterFull(rent, 3) + surplus }), refusedAs("reserve"));
  assert.throws(() => sell(-surplus, { ...P, made: -1n }), refusedAs("reserve"));
  assert.throws(() => sell(-surplus, { ...P, lamports: 1 as never }), refusedAs("reserve"));
  // review 2 L2: the rent rate is the cap's at most (SOLANA_RENT_PER_BYTE_MAX), so what a full sell holds back stays
  // bounded: at 100,000 a byte with two owed claims, priced exactly, 135,640,920 would be held back
  const steep = { lamportsPerByte: 100_000n, factor: 1n } as SolanaSellSurplus["rent"];
  const steepRents = solanaDepositRents(steep, SOL_READS, held, false);
  const steepKeep = solanaSellAfterFull(steep, 2);
  assert.throws(() => sell(-surplus, { ...P, rent: steep, owed: 2, lamports: 5_000n + steepRents + steepKeep + surplus }), refusedAs("reserve"));
  const top = { lamportsPerByte: 6_960n, factor: 1n } as SolanaSellSurplus["rent"];
  const topLamports = 5_000n + solanaDepositRents(top, SOL_READS, held, false) + solanaSellAfterFull(top, 2) + surplus;
  assert.equal(sell(-surplus, { ...P, rent: top, owed: 2, lamports: topLamports }).back, floor + surplus);
  // the bound is on the rate the rent is paid at, the byte price times its factor: 3,481 x 2 is over it
  const twice = { lamportsPerByte: 3_481n, factor: 2n } as SolanaSellSurplus["rent"];
  assert.throws(() => sell(-surplus, { ...P, rent: twice, owed: 2, lamports: 5_000n + solanaDepositRents(twice, SOL_READS, held, false) + solanaSellAfterFull(twice, 2) + surplus }), refusedAs("reserve"));
  // over the cap: what the keep holds over rent(0) the rent back's sweep carries into the user's note, so the cap leaves it
  // out, only when the reserve is priced exactly with that keep (two owed claims: 7,689,840 kept)
  const keep2 = solanaSellAfterFull(rent, 2);
  const over = SOLANA_POOL_SELL_RESERVE_MAX + 1_000n;
  const P2 = { ...P, owed: 2, lamports: 5_000n + rents + keep2 - over };
  assert.equal(sell(over, P2).back, floor - over);
  assert.throws(() => sell(over), refusedAs("reserve"));
  assert.throws(() => sell(over, { ...P2, full: false }), refusedAs("reserve"));
  const past = SOLANA_POOL_SELL_RESERVE_MAX + keep2 - r0 + 1n;
  assert.ok(past < floor, "refused for the cap, not the min out");
  assert.throws(() => sell(past, { ...P2, lamports: 5_000n + rents + keep2 - past }), refusedAs("reserve"));
  // priced with rent(0) alone, nothing is swept later: the cap holds as it is
  assert.throws(() => sell(over, { ...P, lamports: 5_000n + rents + r0 - over }), refusedAs("reserve"));
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
// Base with its pins taken out (the kit pins Base's mainnet set since card pool-evm-deploy-mainnet): the lists below pin
// what they name
const { pool: _p, adapters: _a, sellDelegate: _s, feeCollector: _f, ...B } = evmPoolVenues().base;
const X = "0xF111111111111111111111111111111111111111";
const EVM_POOL = "0x00000000000000000000000000000000000f0011";
const A_V3 = "0x000000000000000000000000000000000000ad03";
const A_V4 = "0x000000000000000000000000000000000000ad04";
const DELEGATE = "0x00000000000000000000000000000000000de1e9";
const FEE_TO = "0x0000000000000000000000000000000000000fee";
// the network's FeeCollector a Sell pays (card evm-testnet-delegate-review3), not the withdraw relayer's FEE_TO
const COLLECTOR = "0x00000000000000000000000000000000000c011e";
const pin = (v: EvmPoolVenue, o: Partial<EvmPoolVenue>): EvmPoolVenue => Object.freeze({ ...v, ...o });
const VENUES = Object.freeze({ base: pin(B, { pool: EVM_POOL, adapters: Object.freeze({ v3: A_V3, v4: A_V4 }), sellDelegate: DELEGATE, feeCollector: COLLECTOR }) });
const evmCtx = (o: Partial<PoolContext> = {}): PoolContext => ({ nowMs: NOW, wallet: EVM_W, feeCap: 10n ** 15n, evm: { venues: VENUES, feeRecipient: FEE_TO }, ...o });
const relay = (o: Partial<EvmRelayData> = {}): EvmRelayData => ({ recipient: EVM_W, feeRecipient: FEE_TO, feeCap: 10n ** 14n, deadlineMs: NOW + 120_000n, refundPrecommitment: 7n, salt: "0x" + "ab".repeat(16), ...o });
const ctxOf = (r: EvmRelayData, pool = EVM_POOL) => evmPoolContextOf({ processooor: pool, relay: r }, evmPoolScopeOf(pool, BigInt(B.chainId)));
const proofOf = (r: EvmRelayData, value = 10n ** 16n) => ({ nullifier: 11n, context: ctxOf(r), value });
const v3 = (tokens: string[]) => ({ venue: "uniswap-v3" as const, tokens, fees: tokens.slice(1).map(() => 500) });
// The device's own buy quote (card evm-buy-hookdata-fee, review fold 1 M1: the page signs only a build from one):
// replayed from the answers Base's two pinned providers gave (kit test/fixtures/evm-quote.json, "base-ok": 0.01 ETH of
// USDC through a v3 pool), at the recording's clock
type Exchange = { calls: EvmRpcCall[]; answers: unknown[] };
const QF = (JSON.parse(readFileSync(new URL("../../kit/test/fixtures/evm-quote.json", import.meta.url), "utf8")) as Record<string, { request: Record<string, unknown>; now: number; exchanges: [Exchange[], Exchange[]] }>)["base-ok"]!;
// the recording predates the kit's per-read gas code (card evm-quote-read-gas-starve): each call is matched as it was
// recorded (asRecorded) and each aggregate3 answer ends in the code's marker (withMarker), as the kit's replay does
const replay = (ex: Exchange[]): EvmRpc => async (sent) => {
  const calls = asRecorded(sent);
  return withMarker(sent, structuredClone(ex.find((x) => JSON.stringify(x.calls) === JSON.stringify(calls))?.answers ?? gasRoundAnswers(ex, calls)!));
};
const buyQuote = (): Promise<EvmPoolBuyQuote> => {
  const { buys, amountIn, ...rest } = QF.request;
  return evmPoolBuyQuoteWith({ ...(rest as object), token: buys as string, amountIn: BigInt(amountIn as string) } as never, [replay(QF.exchanges[0]), replay(QF.exchanges[1])], QF.now);
};
/** A buy the kit built from the device's quote `q`, through `adapter` on `venues`, at the quote's clock. */
const quotedBuy = (q: EvmPoolBuyQuote, adapter = A_V3, venues: Parameters<typeof evmQuotedBuy>[0] = VENUES) => evmQuotedBuy(venues, adapter, q, QF.now);

test("EVM buy: the kit's Buy built from the device's quote of the request's token, the proof bound to W's relay data on the pinned pool, passes and signs; each bad field is refused", async () => {
  const q = await buyQuote();
  const built = quotedBuy(q);
  const r = relay();
  const ask: PoolAsk = { kind: "pool.buy", chain: "base", token: q.token, amount: q.amountIn, slippageBps: 100, decimals: 18 };
  const proof = proofOf(r, q.amountIn);
  const d = checkEvmBuy(built, EVM_POOL, proof, r, ask, evmCtx(), q.minOut);
  assert.deepEqual([d.to, d.pool, d.feeCap], [EVM_W, EVM_POOL, r.feeCap]);
  const sig = signEvmBuy(EVM_SECRET, evmCtx(), built, EVM_POOL, proof);
  assert.equal(sig.length, 65);
  // the signer signs what the check read: a context handed to it after, with another venue list, changes nothing
  const otherCtx = evmCtx({ evm: { venues: Object.freeze({ base: pin(B, { pool: EVM_POOL, chainId: 1, adapters: Object.freeze({ v3: A_V3 }) }) }), feeRecipient: FEE_TO } });
  assert.deepEqual(signEvmBuy(EVM_SECRET, otherCtx, built, EVM_POOL, proof), sig);
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built, "0x2222222222222222222222222222222222222222", proof), refusedAs("unchecked"));
  // a built and a proof each passed by its own check are never signed together
  const r2 = relay({ salt: "0x" + "cd".repeat(16) });
  const built2 = quotedBuy(q);
  const proof2 = proofOf(r2, 10n ** 18n);
  checkEvmBuy(built2, EVM_POOL, proof2, r2, { ...ask, amount: 10n ** 18n }, evmCtx(), q.minOut);
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built, EVM_POOL, proof2), refusedAs("unchecked"));
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built2, EVM_POOL, proof), refusedAs("unchecked"));
  // only what the check passed: another proof object, a proof changed after, a proof checked as a buy signed as a withdraw
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built, EVM_POOL, proofOf(r)), refusedAs("unchecked"));
  assert.throws(() => signEvmWithdraw(EVM_SECRET, evmCtx(), { ...ask, kind: "pool.withdraw" }, EVM_POOL, proof), refusedAs("unchecked"));
  const moved = proofOf(r, q.amountIn);
  checkEvmBuy(built, EVM_POOL, moved, r, ask, evmCtx(), q.minOut);
  moved.context += 1n;
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built, EVM_POOL, moved), refusedAs("unchecked"));
  const other = "0x2222222222222222222222222222222222222222";
  const P = (x: EvmRelayData) => proofOf(x, q.amountIn);
  const F = q.minOut;
  for (const [f, rule] of [
    [() => checkEvmBuy(built, other, P(r), r, ask, evmCtx(), F), "pool"],
    // a quoted build through another venue list's adapter
    [() => checkEvmBuy(quotedBuy(q, other, { base: pin(B, { pool: EVM_POOL, adapters: { v3: other } }) }), EVM_POOL, P(r), r, ask, evmCtx(), F), "adapter"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, { ...ask, token: other }, evmCtx(), F), "token"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, { ...ask, amount: 1n }, evmCtx(), F), "amount"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, { ...ask, chain: "robinhood" }, evmCtx(), F), "chain"],
    [() => checkEvmBuy(built, EVM_POOL, P(relay({ recipient: other })), relay({ recipient: other }), ask, evmCtx(), F), "recipient"],
    [() => checkEvmBuy(built, EVM_POOL, P(relay({ feeRecipient: other })), relay({ feeRecipient: other }), ask, evmCtx(), F), "fee_recipient"],
    [() => checkEvmBuy(built, EVM_POOL, P(relay({ feeCap: 10n ** 15n + 1n })), relay({ feeCap: 10n ** 15n + 1n }), ask, evmCtx(), F), "fee_cap_over_device_cap"],
    [() => checkEvmBuy(built, EVM_POOL, P(relay({ deadlineMs: NOW })), relay({ deadlineMs: NOW }), ask, evmCtx(), F), "deadline_past"],
    [() => checkEvmBuy(built, EVM_POOL, P(relay({ salt: "0x" + "cd".repeat(16) })), r, ask, evmCtx(), F), "context"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, ask, evmCtx({ evm: undefined }), F), "evm_not_pinned"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, ask, evmCtx(), F + 1n), "min_out"],
    // the kit's unquoted pinned builder, of the same route and min out: not the device's quote
    [() => checkEvmBuy(pinnedBuild(VENUES, "base", A_V3, q.route, q.minOut, q.token), EVM_POOL, P(r), r, ask, evmCtx(), F), "not_quoted"],
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

test("EVM sell and authorization: W's own Sell, built from the device's sell quote, into the pinned pool and the pinned delegate at W's two-RPC nonce pass and sign; each bad field is refused", async () => {
  const t = BigInt(Math.floor(Date.now() / 1000));
  // the device's own sell quote on the kit's modelled chain (kit test/evm-sell-quote-fx.ts), W the page's
  const q = await sellQuoteWith(sellReq("base", { w: EVM_W }), [sellModel({ price: flat }), sellModel({ price: flat })], Date.now());
  const req = { amount: q.amountIn, minOut: q.minOut, feeCap: 10n ** 13n, deadline: t + 120n };
  const built = evmQuotedSell(VENUES, q, { feeRecipient: COLLECTOR, precommitment: 5n, feeCap: req.feeCap, deadline: req.deadline, nonce: 0n }, Date.now());
  const X = q.token;
  const ask: PoolAsk = { kind: "pool.sell", chain: "base", token: X, amount: q.amountIn, slippageBps: 100, decimals: 18 };
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
    // the fee goes to the Sell's signed recipient (card pool-review-3, L-1)
    // the fee goes to the venue's pinned FeeCollector (card evm-testnet-delegate-review3): a sell paying another address
    // (built under a list that pins it), or a page that pins another collector, is refused
    [() => checkEvmSell(evmQuotedSell(Object.freeze({ base: pin(VENUES.base, { feeCollector: other }) }), q, { feeRecipient: other, precommitment: 5n, feeCap: req.feeCap, deadline: req.deadline, nonce: 0n }, Date.now()), ask, ctx, 1n), "fee_recipient"],
    [() => checkEvmSell(built, ask, { ...ctx, evm: { venues: Object.freeze({ base: pin(VENUES.base, { feeCollector: other }) }), feeRecipient: FEE_TO } }, 1n), "fee_recipient"],
    // the kit's unquoted pinned builder, of the same route and min out: not the device's quote
    [() => checkEvmSell(pinnedBuildSell(VENUES, "base", { w: EVM_W, token: X, amount: q.amountIn, target: q.target, route: q.route, minOut: q.minOut, feeRecipient: COLLECTOR, precommitment: 5n, feeCap: req.feeCap, deadline: req.deadline, nonce: 0n }), ask, ctx, 1n), "not_quoted"],
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

// card evm-testnet-delegate-review3: SellDelegate pays a sale's fee to the Sell's signed feeRecipient (pool-review-3, L-1)
// and the helper sends only a Sell paying the network's FeeCollector (its Paid log proves the fee): the page holds a
// sell's fee recipient to the venue's collector pin, never to the withdraw relayer's fee recipient a release binds
test("card evm-testnet-delegate-review3: an EVM sell pays its fee only to the venue's FeeCollector pin: one paying the withdraw relayer's fee recipient is refused fee_recipient, one paying the collector passes; a venue with none is refused evm_not_pinned", async () => {
  const t = BigInt(Math.floor(Date.now() / 1000));
  const q = await sellQuoteWith(sellReq("base", { w: EVM_W }), [sellModel({ price: flat }), sellModel({ price: flat })], Date.now());
  const COLL = "0x00000000000000000000000000000000000c011e";
  const venues = Object.freeze({ base: pin(B, { pool: EVM_POOL, adapters: Object.freeze({ v3: A_V3, v4: A_V4 }), sellDelegate: DELEGATE, feeCollector: COLL }) });
  const fields = (feeRecipient: string) => ({ feeRecipient, precommitment: 5n, feeCap: 10n ** 13n, deadline: t + 120n, nonce: 0n });
  const ask: PoolAsk = { kind: "pool.sell", chain: "base", token: q.token, amount: q.amountIn, slippageBps: 100, decimals: 18 };
  const ctx = { ...evmCtx({ nowMs: t * 1000n, evm: { venues, feeRecipient: FEE_TO } }), precommitment: 5n };
  // the collector's sell passes and signs
  const good = evmQuotedSell(venues, q, fields(COLL), Date.now());
  assert.equal(checkEvmSell(good, ask, ctx, q.minOut).pool, EVM_POOL);
  assert.equal(signEvmSell(EVM_SECRET, ctx, good).length, 65);
  // a sell paying the withdraw relayer's fee recipient (the device's quote, built under a list that pins it as the
  // collector): the page refuses it, so the helper's fee_recipient refusal is never the first to see it
  const relayerPaid = evmQuotedSell(Object.freeze({ base: pin(venues.base, { feeCollector: FEE_TO }) }), q, fields(FEE_TO), Date.now());
  assert.throws(() => checkEvmSell(relayerPaid, ask, ctx, q.minOut), refusedAs("fee_recipient"));
  // the withdraw relayer's fee recipient is not a sell's: another one changes nothing
  assert.equal(checkEvmSell(good, ask, { ...ctx, evm: { venues, feeRecipient: "0x2222222222222222222222222222222222222222" } }, q.minOut).pool, EVM_POOL);
  // a venue that pins no collector takes no sell
  const none = Object.freeze({ base: pin(B, { pool: EVM_POOL, adapters: Object.freeze({ v3: A_V3, v4: A_V4 }), sellDelegate: DELEGATE }) });
  assert.throws(() => checkEvmSell(good, ask, { ...ctx, evm: { venues: none, feeRecipient: FEE_TO } }, q.minOut), refusedAs("evm_not_pinned"));
});

test("EVM sim sell: W signs a sim only into EVM_SELL_SIM, deadline at most the agreed block's time, that time at most the device's clock; each planted attack is refused", async () => {
  const t = BigInt(Math.floor(Date.now() / 1000)) - 2n;
  const hops = [{ currency: "0x0000000000000000000000000000000000000000", fee: 3000, tickSpacing: 60, hooks: "0x00000000000000000000000000000000000020cc", hookData: "0x" }];
  const ask: PoolAsk = { kind: "pool.sell", chain: "base", token: X, amount: 10n ** 18n, slippageBps: 100, decimals: 18 };
  const ctx = evmCtx({ nowMs: t * 1000n + 2000n });
  const sim = (o: Partial<{ deadline: bigint; amount: bigint; w: string }> = {}) => evmPoolBuildSimSellUnpinned("base", { w: EVM_W, token: X, amount: 10n ** 18n, hops, minOut: 1n, nonce: 0n, deadline: t, ...o });
  const s = sim();
  checkEvmSellSim(s, t, ask, ctx);
  assert.equal(signEvmSellSim(EVM_SECRET, ctx, s).length, 65);
  const other = "0x2222222222222222222222222222222222222222";
  for (const [f, rule] of [
    // a live deadline: one second past the agreed block, so the signature could land in the next block
    [() => checkEvmSellSim(sim({ deadline: t + 1n }), t, ask, ctx), "sim_deadline"],
    // the real pool: a sim into the pinned pool would deposit there
    [() => checkEvmSellSim({ ...s, pool: EVM_POOL }, t, ask, ctx), "sim_pool"],
    // a block timestamp past the device's clock
    [() => checkEvmSellSim(s, t, ask, evmCtx({ nowMs: t * 1000n - 1n })), "sim_block_after_clock"],
    // a sim for another chain than the one asked
    [() => checkEvmSellSim({ ...s, chain: "robinhood" }, t, ask, ctx), "chain"],
    [() => checkEvmSellSim(sim({ w: other }), t, ask, ctx), "wallet"],
    [() => checkEvmSellSim(s, t, { ...ask, token: other }, ctx), "token"],
    [() => checkEvmSellSim(sim({ amount: 1n }), t, ask, ctx), "amount"],
    [() => checkEvmSellSim(s, t, { ...ask, kind: "pool.buy" }, ctx), "kind"],
    [() => checkEvmSellSim(s, t, ask, evmCtx({ nowMs: t * 1000n + 2000n, evm: { venues: { base: pin(B, { pool: EVM_POOL }) }, feeRecipient: FEE_TO } })), "delegate_not_pinned"],
  ] as const) {
    assert.throws(f, refusedAs(rule), rule);
  }
  // only the sim the check passed is signed: a copy is not it, and a real sell is never signed as a sim
  assert.throws(() => signEvmSellSim(EVM_SECRET, ctx, { ...s }), refusedAs("unchecked"));
  // a real sell (the kit's sell builder, into the pinned pool, live for 120 s), even one the sell check passed, is
  // refused by the sim check and by the sim signer
  const q = await sellQuoteWith(sellReq("base", { w: EVM_W }), [sellModel({ price: flat }), sellModel({ price: flat })], Date.now());
  const real = evmQuotedSell(VENUES, q, { feeRecipient: COLLECTOR, precommitment: 5n, feeCap: 10n ** 13n, deadline: t + 120n, nonce: 0n }, Date.now());
  const realAsk: PoolAsk = { ...ask, token: q.token, amount: q.amountIn };
  assert.throws(() => checkEvmSellSim(real as never, t, realAsk, ctx), refusedAs("sim_pool"));
  assert.throws(() => signEvmSellSim(EVM_SECRET, ctx, real as never), refusedAs("unchecked"));
  checkEvmSell(real, realAsk, { ...ctx, precommitment: 5n }, q.minOut);
  assert.throws(() => signEvmSellSim(EVM_SECRET, ctx, real as never), refusedAs("unchecked"));
});

// ---------- no rule reads a server ----------

test("no rule reads a field from a server: the rule file imports no fetch, helper, RPC caller or relay client and calls none", () => {
  const src = readFileSync(new URL("../src/rules/pool.ts", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/**")).join("\n");
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
  assert.doesNotMatch(code, /helper\/v1|withdraw\/relay|solanaJsonRpc|solanaHelperRpc|readSolana[A-Z]\w*\(|evmAgreed|evmNow|RELEASE_HELPER|TRADE_HELPER/);
  const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  // trade/evm/quoted.ts: the record of the builds the device's own quotes made (card evm-buy-hookdata-fee); the rules
  // call only its two predicates, which read no server (the line above holds that the file calls no reader);
  // trade/solana/pool-deposit.ts: its constant SOLANA_POOL_NEXT_PAGE_WINDOW (card pool-senders-next-page), a module of
  // pure builders with no reader
  assert.deepEqual(imports.filter((p) => !/^@noble\/|^@scure\//.test(p!) && !/(checks\/solana\/(message|checks)|trade\/solana\/pool-(buy|deposit)|trade\/evm\/(buy|sell)-unpinned|trade\/evm\/quoted|wallet\/src\/pool\/evm)\.ts$/.test(p!)), []);
  assert.deepEqual([...code.matchAll(/\b(evmQuoted\w*|evmIsQuoted\w*)\b/g)].map((m) => m[1]).filter((n) => !/^evmIsQuoted(Buy|Sell)$/.test(n!)), [], "the rules call quoted.ts's predicates only, never its builders");
});

// Review 3 of 446d830f (its fuzz, kept at a fixed seed): on a full sell the rule passes exactly the reserve the device
// prices (solanaSellReserve, pool-sell.ts's form: the keep, or rent(0) as its fallback) and nothing else, so no sell the
// device builds is refused (stuck) and no other reserve passes (extra). L-a: on the fallback the rule did not hold the
// note to the pool's least deposit: at 216 x 2 a byte with two owed, reserve 5,420,920 (short + rent(0)) left a note of
// 999,999, which the device refuses and the program (deposit.rs) too; the rule passed it.
// Card sol-sell-deposit-back-floor: the rule refused only a deposit back of 0 (depositOf) and one under the pool's least
// deposit, so a note between 1,000,000 and the kit's release floor (solanaPoolNoteFloor, 2,600,000 at mainnet's rent)
// passed though no release can take it whole. Under the floor it is refused by name; the sell is the venue's alone.
test("Solana sell: a deposit back under the kit's release floor at the rent read is refused by name (deposit_floor); at the floor it passes; under it the venue's sell alone passes, drawing no deposit", async () => {
  const { venue, ref, reads } = await setup("pump");
  const amount = 5_000_000n;
  const reference = { amount, ref: { ...ref, pools: ref.pools.map((p) => ({ ...p, expectedOut: 1_000n })) }, slippageBps: 300 };
  const ask: PoolAsk = { kind: "pool.sell", chain: "solana", token: venue.mint, amount, slippageBps: 300, decimals: 6 };
  const rent = { lamportsPerByte: 5_080n, factor: 1n } as SolanaSellSurplus["rent"];
  const none = [null, null] as const;
  const PART: SolanaSellSurplus = { full: false, lamports: 10_000_000n, fee: 5_000n, made: 0n, rent, held: { mark: none, state: none, label: none }, next: false, owed: 0 };
  const noteFloor = solanaPoolNoteFloor(rent);
  assert.equal(noteFloor, 2_600_000n);
  const RESERVE = 5_000n;
  const steps = (minOut: bigint) => solanaPoolSellSteps(venue, SOL_W, amount, minOut) as Ixx[];
  const sell = (minOut: bigint, ixs: Ixx[], p: SolanaSellSurplus | null = PART) => checkSolanaSell(wire(SOL_W, ixs), ask, solCtx(), venue, reference, reads.slot, SOL_READS, RESERVE, p ?? undefined);
  // a lamport under the floor: the deposit refused by name, in the eight and the six
  const under = RESERVE + noteFloor - 1n;
  assert.throws(() => sell(under, [...steps(under), depositIx({ value: noteFloor - 1n })]), refusedAs("deposit_floor"));
  assert.throws(() => sell(under, [...steps(under), depositIx({ value: noteFloor - 1n, six: true })]), refusedAs("deposit_floor"));
  // the old bound's own case: just over the pool's least deposit
  const least = RESERVE + SOLANA_POOL_MIN_DEPOSIT;
  assert.throws(() => sell(least, [...steps(least), depositIx({ value: SOLANA_POOL_MIN_DEPOSIT })]), refusedAs("deposit_floor"));
  // at the floor: the deposit passes, drawn
  const at = RESERVE + noteFloor;
  assert.equal(sell(at, [...steps(at), depositIx({ value: noteFloor })]).back, noteFloor);
  // under the floor the venue's sell alone passes: no deposit drawn, the proceeds to W
  const kept = sell(under, steps(under));
  assert.deepEqual([kept.back, kept.to], [null, SOL_W]);
  assert.deepEqual(drawPool(kept).map((l) => l[0]), ["Chain", "Token", "Amount", "To", "Max fee", "Pool"]);
  // at the floor the venue's sell alone is refused: the sale goes into a note whenever one can be made
  assert.throws(() => sell(at, steps(at)), (e: unknown) => e instanceof PoolRuleRefused);
  // under the floor nothing else rides after the sell
  assert.throws(() => sell(under, [...steps(under), send(key(79), 1n)]), refusedAs("sell"));
  // no rent read, or one out of the Rent sysvar's range: refused, the floor never guessed
  assert.throws(() => sell(at, [...steps(at), depositIx({ value: noteFloor })], null), refusedAs("reserve"));
  for (const r of [{ lamportsPerByte: 0n, factor: 1n }, { lamportsPerByte: 1_000_001n, factor: 1n }, { lamportsPerByte: 5_080n, factor: 3n }, { lamportsPerByte: 5_080, factor: 1n }]) {
    assert.throws(() => sell(at, [...steps(at), depositIx({ value: noteFloor })], { ...PART, rent: r as never }), refusedAs("reserve"), JSON.stringify(r, (_, v) => String(v)));
  }
  // the floor follows the rent read: at twice the rent the same deposit is under it
  assert.throws(() => sell(at, [...steps(at), depositIx({ value: noteFloor })], { ...PART, rent: { lamportsPerByte: 10_160n, factor: 1n } }), refusedAs("deposit_floor"));
});

test("Solana full sell: the rule passes exactly the device's reserve, a note under the pool's least deposit never, a partial sell's neither", async () => {
  const { venue, ref, reads } = await setup("pump");
  const amount = 5_000_000n;
  // a reference whose expected out is small, so min outs of a few million lamports (where the fallback and the floor
  // matter) clear the venue's floor
  const reference = { amount, ref: { ...ref, pools: ref.pools.map((p) => ({ ...p, expectedOut: 1_000n })) }, slippageBps: 300 };
  const ask: PoolAsk = { kind: "pool.sell", chain: "solana", token: venue.mint, amount, slippageBps: 300, decimals: 6 };
  // `kept`: the venue's sell alone, no deposit back (card sol-sell-deposit-back-floor: the device's value 0)
  const rule = (minOut: bigint, reserve: bigint, p: SolanaSellSurplus, kept = false): boolean => {
    try {
      checkSolanaSell(wire(SOL_W, [...(solanaPoolSellSteps(venue, SOL_W, amount, minOut) as Ixx[]), ...(kept ? [] : [depositIx({ value: minOut - reserve })])]), ask, solCtx(), venue, reference, reads.slot, SOL_READS, reserve, p);
      return true;
    } catch (e) {
      if (e instanceof PoolRuleRefused) return false;
      throw e;
    }
  };
  type Case = { rent: SolanaSellSurplus["rent"]; owed: number; next: boolean; held: SolanaDepositHeld; fee: bigint; made: bigint; lamports: bigint; minOut: bigint };
  const run = (c: Case): { stuck: string[]; extra: string[] } => {
    const rents = solanaDepositRents(c.rent, SOL_READS, c.held, c.next);
    const full = solanaSellAfterFull(c.rent, c.owed);
    const r0 = solanaRentMin(c.rent, 0);
    const floor = solanaSweepFloor(c.rent) > SOLANA_POOL_MIN_DEPOSIT ? solanaSweepFloor(c.rent) : SOLANA_POOL_MIN_DEPOSIT;
    const short = c.fee + c.made + rents - c.lamports;
    const P: SolanaSellSurplus = { full: true, lamports: c.lamports, fee: c.fee, made: c.made, rent: c.rent, held: c.held, next: c.next, owed: c.owed };
    const dev = solanaSellReserve({ fee: c.fee, made: c.made, rents, after: full, lamports: c.lamports, minOut: c.minOut, keeps: false, noteFloor: solanaPoolNoteFloor(c.rent), swept: full - r0, base: r0, floor });
    const out = { stuck: [] as string[], extra: [] as string[] };
    for (const r of new Set([short + r0, short + full, short + full + 1n, short + full - 1n, short + r0 + 1n, short + r0 - 1n, 0n, -1n, SOLANA_POOL_SELL_RESERVE_MAX, SOLANA_POOL_SELL_RESERVE_MAX + full - r0])) {
      if (r >= c.minOut) continue;
      // the device's build at this reserve: its deposit back, or the venue's sell alone (value 0)
      const at = !("refused" in dev) && dev.reserve === r;
      const made = at && dev.value > 0n;
      const kept = at && dev.value === 0n;
      const got = rule(c.minOut, r, P);
      const gotKept = rule(c.minOut, r, P, true);
      if (made && !got) out.stuck.push(`${r}`);
      if (!made && got) out.extra.push(`${r} note ${c.minOut - r}`);
      if (kept && !gotKept) out.stuck.push(`${r} kept`);
      if (!kept && gotKept) out.extra.push(`${r} kept, its note ${c.minOut - r}`);
    }
    return out;
  };
  // L-a's case, pinned: the device refuses it, the rule refuses it
  const nothing = { mark: [null, null], state: [null, null], label: [null, null] } as unknown as SolanaDepositHeld;
  const r216 = { lamportsPerByte: 216n, factor: 2n } as SolanaSellSurplus["rent"];
  const la = { rent: r216, owed: 2, next: false, held: nothing, fee: 5_000n, made: 0n, lamports: 0n, minOut: 0n };
  const laShort = 5_420_920n - solanaRentMin(r216, 0);
  la.made = laShort - 5_000n - solanaDepositRents(r216, SOL_READS, nothing, false);
  la.minOut = 5_420_920n + 999_999n;
  assert.ok(la.made >= 0n);
  assert.deepEqual(run(la), { stuck: [], extra: [] }, "216 x 2, owed 2, a 999,999 note");
  // and on a partial sell (the review of c1fd2d20, 3): a 999,999 note refused; since card sol-sell-deposit-back-floor
  // exactly the least deposit too (under the kit's release floor), which the venue's sell alone carries; at the floor the
  // note passes; no rent read: refused
  const part = { full: false, lamports: 0n, fee: 5_000n, made: 0n, rent: { lamportsPerByte: 5_080n, factor: 1n }, held: nothing, next: false, owed: 0 } as SolanaSellSurplus;
  assert.equal(rule(2_000_000n, 1_000_001n, part), false, "a partial sell's 999,999 note");
  assert.equal(rule(2_000_000n, 1_000_000n, part), false, "a partial sell's 1,000,000 note");
  assert.equal(rule(2_000_000n, 1_000_000n, part, true), true, "a partial sell's 1,000,000 kept on W");
  assert.equal(rule(3_600_000n, 1_000_000n, part), true, "a partial sell's 2,600,000 note");
  assert.equal(rule(3_600_000n, 1_000_000n, part, true), false, "a partial sell's 2,600,000 never kept on W");
  assert.equal(rule(3_600_000n, 1_000_000n, undefined as never), false, "no rent read");
  // the fuzz: rents, owed counts, held lamports, fees and the cost of made accounts drawn at a fixed seed, each min out
  // anchored at an edge (the floor, the least deposit, the fallback's note at the least deposit, 0, the cap)
  let s = 7;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ri = (a: bigint, b: bigint) => a + BigInt(Math.floor(rnd() * Number(b - a + 1n)));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  let n = 0;
  const bad: string[] = [];
  for (let it = 0; it < 300; it++) {
    const rent = pick([{ lamportsPerByte: 5_080n, factor: 1n }, { lamportsPerByte: 6_960n, factor: 1n }, { lamportsPerByte: 3_480n, factor: 2n }, { lamportsPerByte: 1n, factor: 1n }, { lamportsPerByte: ri(1n, 6_960n), factor: 1n }, { lamportsPerByte: ri(1n, 3_480n), factor: 2n }]) as SolanaSellSurplus["rent"];
    const owed = Number(ri(0n, 2n));
    const next = rnd() < 0.5;
    const pair = () => { const v = rnd() < 0.5 ? null : ri(0n, 3_000_000n); return [v, v] as const; };
    const held: SolanaDepositHeld = { mark: pair(), state: pair(), label: pair() };
    const fee = rnd() < 0.5 ? 5_000n : ri(0n, 1_405_000n);
    let made = rnd() < 0.5 ? 0n : ri(0n, 3_000_000n);
    const rents = solanaDepositRents(rent, SOL_READS, held, next);
    const full = solanaSellAfterFull(rent, owed);
    const r0 = solanaRentMin(rent, 0);
    const floor = solanaSweepFloor(rent) > SOLANA_POOL_MIN_DEPOSIT ? solanaSweepFloor(rent) : SOLANA_POOL_MIN_DEPOSIT;
    const lamports = rnd() < 0.2 ? 0n : ri(0n, 8_000_000n);
    let minOut: bigint;
    if (rnd() < 0.25) {
      // short + rent(0) at the cap, give or take: made fitted to it
      const want = SOLANA_POOL_SELL_RESERVE_MAX - r0 + ri(-3n, 3n) + (rnd() < 0.5 ? 0n : ri(-500_000n, 500_000n));
      minOut = want + full + pick([floor, SOLANA_POOL_MIN_DEPOSIT - (full - r0), 0n, floor + 5_000_000n]) + ri(-3n, 3n);
      made = want - fee - rents + lamports;
      if (made < 0n) continue;
    } else {
      const anchor = pick([floor, SOLANA_POOL_MIN_DEPOSIT, 0n, SOLANA_POOL_MIN_DEPOSIT - (full - r0), floor + 3_000_000n, -1_000_000n]);
      minOut = anchor + ri(-3n, 3n) + (rnd() < 0.5 ? 0n : ri(-1_500_000n, 1_500_000n)) + fee + made + rents + full - lamports;
    }
    if (minOut < 970n) continue; // the venue's floor for this reference
    n++;
    const r = run({ rent, owed, next, held, fee, made, lamports, minOut });
    for (const x of r.stuck) bad.push(`stuck it=${it} ${x}`);
    for (const x of r.extra) bad.push(`extra it=${it} ${x}`);
  }
  assert.ok(n > 200, String(n));
  assert.deepEqual(bad.slice(0, 10), []);
});
