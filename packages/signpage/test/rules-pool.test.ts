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
import { SOLANA_CLOSE_VOLUME_ACCUMULATOR, SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_PUMP_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaEventAuthority, solanaVolumeAccumulator } from "../../kit/src/checks/solana/checks.ts";
import { solanaAta, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import {
  buildSolanaPoolBuy,
  solanaPoolBuyMaxSpend,
  solanaPoolTag2Accounts,
  solanaEncodePoolRelease,
  solanaPoolPage,
  solanaPoolReleaseAccounts,
  solanaPoolSellSteps,
  solanaRentMin,
  type SolanaPoolRelease,
} from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaSellReserve } from "../src/pool-sell.ts";
import { noteOf, SOL_GRID, SOL_NOTE_FLOOR } from "../../wallet/src/pool/pieces.ts";
import { SOL_PIECES } from "../../wallet/src/pool/solana.ts";
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
  planEvmBuy,
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
  SOLANA_POOL_SELL_PRIORITY,
  SOLANA_POOL_MIN_DEPOSIT,
  solanaSweepFloor,
  solanaDepositRents,
  solanaNoteOf,
  solanaSellNoteFloor,
  solanaSweepOf,
  solanaSweepKeep,
  checkSolanaSweep,
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
    [{ kind: "pool.sell", chain: "solana", token: sol, share_bps: 5_000, slippage_bps: -1 }, "slippage"],
    [{ kind: "pool.sell", chain: "solana", token: sol, share_bps: 5_000, slippage_bps: 1.5 }, "slippage"],
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
  // the number two reads agreed on earlier this session (src/pool-kinds.ts keptTokenDecimals): taken as the reads' own,
  // 0 to 255 only (card sell-first-read-waits-out-a-throttle)
  assert.equal(checkPoolRequest({ kind: "pool.sell", chain: "solana", token: sol, amount: "2.5", slippage_bps: 1 }, 6).amount, 2_500_000n);
  assert.equal(checkPoolRequest({ kind: "pool.sell", chain: "base", token: evm, share_bps: 10_000, slippage_bps: 1 }, 255).decimals, 255);
  assert.equal(checkPoolRequest({ kind: "pool.sell", chain: "base", token: evm, amount: "1", slippage_bps: 1 }, 0).amount, 1n);
  assert.throws(() => checkPoolRequest({ kind: "pool.sell", chain: "solana", token: sol, amount: "0.0000001", slippage_bps: 1 }, 6), refusedAs("amount"));
  for (const d of [256, -1, 1.5, NaN, Infinity]) assert.throws(() => sell("base", d), refusedAs("decimals"), String(d));
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

test("Solana buy of several pieces: each tag 2 to the same W at its own state index, then the tag 3 funded by all; any other wallet, index, note or sum is refused", async () => {
  const cfg = { program: FX_PROGRAM, pool: solanaProgramAddress([enc("pool")], FX_PROGRAM) };
  const base = await setup("pump");
  const piece = (n: number, over: Partial<SolanaPoolRelease> = {}): SolanaPoolRelease => ({ ...fxRelease, existingNullifierHash: Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0)), withdrawnValue: 5_000_000n, ...over });
  const p1 = piece(1), p2 = piece(2);
  const spend = solanaPoolBuyMaxSpend([p1, p2, fxRelease], base.venue, base.req.tip, base.reads.rent);
  const { venue, req: req0, chain, reads: reads0 } = await setup("pump", spend);
  // the pool's size read is 6: the two tag 2s' change notes go at 6 and 7, the tag 3's at 8
  const tag2 = (r: SolanaPoolRelease, at: number, w = FX_W, extra: Ixx[] = []) =>
    wire(FEE_PAYER, [cuLimit, { program: FX_PROGRAM, accounts: solanaPoolTag2Accounts(cfg, w, FEE_PAYER, r, at), data: solanaEncodePoolRelease(r) }, ...extra], [FEE_PAYER, w], reads0.blockhash);
  const req = { ...req0, before: [p1, p2].map((p) => ({ withdrawnValue: p.withdrawnValue, relayFee: p.relayFee })) };
  const built = buildSolanaPoolBuy(cfg, fxRelease, venue, req, { ...chain, stateSize: 8 }, { pick: () => 3 });
  const reads = { ...reads0, stateSize: 8 };
  const ctx: PoolContext = { nowMs: NOW, wallet: FX_W, feeCap: 3_000_000n, solana: { program: FX_PROGRAM, feePayer: FEE_PAYER } };
  const ask: PoolAsk = { kind: "pool.buy", chain: "solana", token: req.token, amount: spend, slippageBps: 300, decimals: 9 };
  const pieces = [{ wire: tag2(p1, 6), release: p1 }, { wire: tag2(p2, 7), release: p2 }];
  const d = checkSolanaBuy(built.wire, ask, ctx, fxRelease, venue, req, reads, pieces);
  assert.equal(d.to, FX_W);
  assert.equal(d.feeCap, 3n * fxRelease.relayFeeCap, "the draw's fee cap is every release's");
  // the tag 3 alone does not pay this spend: its pieces are what fund it
  assert.throws(() => checkSolanaBuy(built.wire, ask, ctx, fxRelease, venue, req0, reads), refusedAs("buy_FUNDS"));
  const W2 = key(64);
  for (const [list, r, rule] of [
    // a piece that pays another wallet: its signer is not this W
    [[{ wire: tag2(p1, 6, W2), release: p1 }, pieces[1]!], req, "signers"],
    // a piece's change note on another page than the one its index lands on
    [[{ wire: tag2(p1, 6 + 1024), release: p1 }, pieces[1]!], req, "release_accounts"],
    // a piece that is not the device's release
    [[{ wire: tag2(piece(1, { withdrawnValue: 5_000_001n }), 6), release: p1 }, pieces[1]!], req, "release_not_devices"],
    // anything after a piece's release
    [[{ wire: tag2(p1, 6, FX_W, [{ program: SOLANA_SYSTEM_PROGRAM, accounts: [acc(FX_W, true, true), acc(W2, false, true)], data: Uint8Array.of(2, 0, 0, 0, ...u64(1n)) }]), release: p1 }, pieces[1]!], req, "instructions"],
    // one note twice: the tag 3's own note as a piece
    [[{ wire: tag2(fxRelease, 6), release: fxRelease }, pieces[1]!], { ...req, before: [{ withdrawnValue: fxRelease.withdrawnValue, relayFee: fxRelease.relayFee }, req.before[1]!] }, "pieces"],
    // the request's pieces not the ones checked: more than they pay, or none sent for them
    [pieces, { ...req, before: [{ ...req.before[0]!, withdrawnValue: 6_000_000n }, req.before[1]!] }, "pieces"],
    [[], req, "pieces"],
    [pieces.slice(0, 1), req, "pieces"],
    // five pieces before the tag 3: over the five one tap carries
    [[...pieces, ...pieces, ...pieces], req, "pieces"],
  ] as const) {
    assert.throws(() => checkSolanaBuy(built.wire, ask, ctx, fxRelease, venue, r, reads, list), refusedAs(rule), rule);
  }
});

// ---------- Solana sell ----------

test("Solana sell: the kit's venue sell from W at or above the device's floor, then on a partial sell a deposit of the grid note of min out less the device's reserve into the pinned pool, passes and draws it; each bad field is refused", async () => {
  const { venue, ref, reads } = await setup("pump");
  const amount = 5_000_000n;
  const reference = { amount, ref, slippageBps: 300 };
  const slot = reads.slot;
  const floor = (ref.pools.find((p) => p.venue === "pump-curve")!.expectedOut * 9_700n) / 10_000n;
  const ask: PoolAsk = { kind: "pool.sell", chain: "solana", token: venue.mint, amount, slippageBps: 300, decimals: 6 };
  const sellWire = (o: { minOut?: bigint; amount?: bigint; dep?: Partial<Parameters<typeof depositIx>[0]>; w?: string; extra?: Ixx[]; account?: [number, string] } = {}) => {
    const steps = solanaPoolSellSteps(venue, o.w ?? SOL_W, o.amount ?? amount, o.minOut ?? floor).map((x) => ({ ...x, accounts: x.accounts.map((a) => ({ ...a })) }));
    // `account`: the venue sell's account at that index names another key, its flags kept (a wire's own accounts)
    if (o.account) steps[0]!.accounts[o.account[0]]!.key = o.account[1];
    return wire(o.w ?? SOL_W, [cuLimit, ...steps, ...(o.extra ?? []), depositIx({ value: solanaNoteOf((o.minOut ?? floor) - RESERVE), ...o.dep })]);
  };
  const RESERVE = 5_000n;
  // card every-lamport-can-move: the note on the grid, the rest under it left on W
  const NOTE = solanaNoteOf(floor - RESERVE);
  assert.ok(NOTE % SOL_GRID === 0n && NOTE >= SOL_NOTE_FLOOR && floor - RESERVE - NOTE < SOL_GRID && NOTE !== floor - RESERVE, "the fixture's note is off its min out, on the grid");
  // a partial sell's reads: the rent both RPCs read, the kit's release floor's (card sol-sell-deposit-back-floor)
  const PART: SolanaSellSurplus = { full: false, fee: 5_000n, rent: { lamportsPerByte: 5_080n, factor: 1n } };
  const d = checkSolanaSell(sellWire(), ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART);
  assert.deepEqual([d.op, d.token, d.amount, d.pool, d.to, d.back, d.decimals], ["pool.sell", venue.mint, amount, POOL, POOL, NOTE, 6]);
  // card pool-sell-share-across-wallets: a share is never checked as signed bytes; each wallet's sale is its units
  assert.throws(() => checkSolanaSell(sellWire(), { ...ask, shareBps: 10_000 }, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART), refusedAs("amount"));
  assert.deepEqual(drawPool(d).map((l) => l[0]), ["Chain", "Token", "Amount", "To", "To private balance", "Max fee", "Pool"]);
  assert.deepEqual(drawPool(d)[2], ["Amount", "5"]);
  assert.deepEqual(drawPool(d)[4], ["To private balance", String(Number(NOTE) / 1e9)]);
  // an amount under 1 keeps its leading zeros: 5,000,000 lamports is 0.005 SOL
  assert.deepEqual(drawPool({ ...d, back: 5_000_000n })[4], ["To private balance", "0.005"]);
  // the reserve is the device's own fee money for W, never more than its fixed cap: the cap passes, one lamport more is refused
  // the worst legitimate cost on W (src/rules/pool.ts): the fee at its cap, the mark and a new page on both trees
  assert.equal(SOLANA_POOL_SELL_RESERVE_MAX, 1_405_000n + (128n + 17n) * 6_960n + 2n * (128n + 16n + 72n) * 6_960n);
  assert.equal(SOLANA_POOL_SELL_RESERVE_MAX, 5_420_920n);
  assert.ok(floor > SOLANA_POOL_SELL_RESERVE_MAX + 1n, "the fixture's min out is above the cap");
  const atCap = (r: bigint) => {
    const steps = solanaPoolSellSteps(venue, SOL_W, amount, floor).map((x) => ({ ...x, accounts: x.accounts.map((a) => ({ ...a })) }));
    return checkSolanaSell(wire(SOL_W, [cuLimit, ...steps, depositIx({ value: solanaNoteOf(floor - r) })]), ask, solCtx(), venue, reference, slot, SOL_READS, r, PART);
  };
  assert.equal(atCap(SOLANA_POOL_SELL_RESERVE_MAX).back, solanaNoteOf(floor - SOLANA_POOL_SELL_RESERVE_MAX));
  assert.throws(() => atCap(SOLANA_POOL_SELL_RESERVE_MAX + 1n), refusedAs("reserve"));
  assert.throws(() => atCap(floor - 1n), refusedAs("reserve"));
  // a higher min out the bytes carry is fine, its deposit that min out less the reserve
  assert.equal(checkSolanaSell(sellWire({ minOut: floor + 10n }), ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART).back, solanaNoteOf(floor + 10n - RESERVE));
  // the deposit back in the six as well (card pool-senders-next-page: a sell over 1,232 bytes with the eight, the PumpSwap
  // cashback sell with no lookup table, sends the form before d3edab1); the next pages wrong are still refused
  assert.equal(checkSolanaSell(sellWire({ dep: { six: true } }), ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART).back, NOTE);
  assert.throws(() => checkSolanaSell(sellWire({ dep: { nextState: key(45) } }), ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART), refusedAs("state_page"));
  // the kit's curve sell is one instruction, the fee recipient its second account and the curve its fourth
  const built = solanaPoolSellSteps(venue, SOL_W, amount, floor);
  assert.ok(venue.kind === "pump-curve" && built.length === 1 && built[0]!.accounts[1]!.key === venue.feeRecipient && built[0]!.accounts[3]!.key === venue.curve);
  for (const [w, rule] of [
    [sellWire({ minOut: floor - 1n }), "min_out"],
    [sellWire({ amount: amount - 1n }), "sell"],
    [sellWire({ dep: { value: floor + 1n } }), "deposit_amount"],
    // card every-lamport-can-move: the exact min out less the reserve (an exact lamport amount), off the grid by one,
    // a grid step over or under the note
    [sellWire({ dep: { value: floor - RESERVE } }), "deposit_amount"],
    [sellWire({ dep: { value: NOTE + 1n } }), "deposit_amount"],
    [sellWire({ dep: { value: NOTE - 1n } }), "deposit_amount"],
    [sellWire({ dep: { value: NOTE + SOL_GRID } }), "deposit_amount"],
    [sellWire({ dep: { value: NOTE - SOL_GRID } }), "deposit_amount"],
    [sellWire({ dep: { value: 1n } }), "deposit_amount"],
    [sellWire({ dep: { pool: key(44) } }), "pool"],
    [sellWire({ dep: { pre: PRE + 1n } }), "precommitment"],
    [sellWire({ dep: { program: key(43) } }), "program"],
    [sellWire({ extra: [send(key(79), 1n)] }), "sell"],
    // no account of W's closes inside a sale (card round-trip-costs-less's closes in the sale were taken out: on a fixed
    // deposit value they save one frame fee and a relayed dust unit makes them fail): W's token account's close or its
    // volume account's, between the venue's sell and the deposit, is refused as any other step
    [sellWire({ extra: [{ program: venue.tokenProgram, accounts: [{ key: solanaAta(SOL_W, venue.mint, venue.tokenProgram), signer: false, writable: true }, { key: SOL_W, signer: false, writable: true }, { key: SOL_W, signer: true, writable: false }], data: Uint8Array.of(9) }] }), "sell"],
    [sellWire({ extra: [{ program: SOLANA_PUMP_PROGRAM, accounts: [{ key: SOL_W, signer: true, writable: true }, { key: solanaVolumeAccumulator(SOL_W, SOLANA_PUMP_PROGRAM), signer: false, writable: true }, { key: solanaEventAuthority(SOLANA_PUMP_PROGRAM), signer: false, writable: false }, { key: SOLANA_PUMP_PROGRAM, signer: false, writable: false }], data: Uint8Array.from(SOLANA_CLOSE_VOLUME_ACCUMULATOR) }] }), "sell"],
    // the sell's accounts are the ones the kit builds from the device's own venue read, never the wire's: a sell paying
    // another fee recipient (pump's sell names it second, writable), or sending the SOL out of another curve
    [sellWire({ account: [1, key(80)] }), "sell_accounts"],
    [sellWire({ account: [3, key(81)] }), "sell_accounts"],
  ] as const) {
    assert.throws(() => checkSolanaSell(w, ask, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART), refusedAs(rule), rule);
  }
  assert.throws(() => checkSolanaSell(sellWire(), { ...ask, token: key(63) }, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART), refusedAs("token"));
  assert.throws(() => checkSolanaSell(sellWire(), { ...ask, slippageBps: 301 }, solCtx(), venue, reference, slot, SOL_READS, RESERVE, PART), refusedAs("slippage"));
  for (const r of [-1n, floor, floor + 1n, 5000 as never]) {
    assert.throws(() => checkSolanaSell(sellWire(), ask, solCtx(), venue, reference, slot, SOL_READS, r, PART), refusedAs("reserve"), String(r));
  }
  // card every-lamport-can-move: a full sell (W holds none of the token after it) is the venue's sell alone, a reserve of
  // 0, drawing no deposit: its one note is W's sweep after the teardown. Any deposit on it is refused by name, at any
  // value, on the grid or off it, in the eight or the six; so is any reserve but 0, and a sell with no reads
  const FULL: SolanaSellSurplus = { ...PART, full: true };
  const bare = (o: { reserve?: bigint; p?: SolanaSellSurplus; extra?: Ixx[] } = {}) => checkSolanaSell(wire(SOL_W, [cuLimit, ...(solanaPoolSellSteps(venue, SOL_W, amount, floor) as Ixx[]), ...(o.extra ?? [])]), ask, solCtx(), venue, reference, slot, SOL_READS, o.reserve ?? 0n, o.p ?? FULL);
  const f = bare();
  assert.deepEqual([f.back, f.to], [null, SOL_W]);
  for (const v of [NOTE, floor, floor - RESERVE, SOL_NOTE_FLOOR]) {
    assert.throws(() => checkSolanaSell(wire(SOL_W, [cuLimit, ...(solanaPoolSellSteps(venue, SOL_W, amount, floor) as Ixx[]), depositIx({ value: v })]), ask, solCtx(), venue, reference, slot, SOL_READS, 0n, FULL), refusedAs("deposit_full"), String(v));
    assert.throws(() => checkSolanaSell(wire(SOL_W, [cuLimit, ...(solanaPoolSellSteps(venue, SOL_W, amount, floor) as Ixx[]), depositIx({ value: v, six: true })]), ask, solCtx(), venue, reference, slot, SOL_READS, 0n, FULL), refusedAs("deposit_full"), `${v} six`);
  }
  for (const r of [1n, RESERVE, SOLANA_POOL_SELL_RESERVE_MAX]) assert.throws(() => bare({ reserve: r }), refusedAs("reserve"), String(r));
  assert.throws(() => checkSolanaSell(wire(SOL_W, [cuLimit, ...(solanaPoolSellSteps(venue, SOL_W, amount, floor) as Ixx[])]), ask, solCtx(), venue, reference, slot, SOL_READS, 0n, undefined), refusedAs("reserve"));
  assert.throws(() => bare({ p: { ...FULL, full: "yes" as never } }), refusedAs("reserve"));
  assert.throws(() => bare({ extra: [send(key(79), 1n)] }), refusedAs("sell"));
  // a partial sell's surplus is never a reserve under 0
  assert.throws(() => checkSolanaSell(sellWire(), ask, solCtx(), venue, reference, slot, SOL_READS, -1n, PART), refusedAs("reserve"));
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
// card buy-any-amount-on-every-chain: an ask is the ETH that goes into swaps (the chunk less its relay fee, evmCtx's
// fee cap); its plan spends the one note of that chunk whole
const spend = (a: PoolAsk): PoolAsk => ({ ...a, amount: a.amount - 10n ** 15n });
const planFor = (a: PoolAsk) => planEvmBuy(spend(a), [{ noteId: "n", chunk: a.amount, fee: 10n ** 15n }], 0n);
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
/** The device's quote as the check reads it: its token and output, for `amount` less the device's fee cap (evmCtx's). */
const agreedOf = (q: EvmPoolBuyQuote, amount: bigint, cap = 10n ** 15n) => ({ token: q.token, amountIn: amount - cap, amountOut: q.amountOut });
const quotedBuy = (q: EvmPoolBuyQuote, adapter = A_V3, venues: Parameters<typeof evmQuotedBuy>[0] = VENUES) => evmQuotedBuy(venues, adapter, q, QF.now);

test("EVM buy: the kit's Buy built from the device's quote of the request's token, the proof bound to W's relay data on the pinned pool, passes and signs; each bad field is refused", async () => {
  const q = await buyQuote();
  const built = quotedBuy(q);
  const r = relay();
  const ask: PoolAsk = { kind: "pool.buy", chain: "base", token: q.token, amount: q.amountIn + 10n ** 15n, slippageBps: 100, decimals: 18 };
  const proof = proofOf(r, ask.amount);
  const d = checkEvmBuy(built, EVM_POOL, proof, r, spend(ask), evmCtx(), agreedOf(q, ask.amount), planFor(ask));
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
  checkEvmBuy(built2, EVM_POOL, proof2, r2, spend({ ...ask, amount: 10n ** 18n }), evmCtx(), agreedOf(q, 10n ** 18n), planFor({ ...ask, amount: 10n ** 18n }));
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built, EVM_POOL, proof2), refusedAs("unchecked"));
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built2, EVM_POOL, proof), refusedAs("unchecked"));
  // only what the check passed: another proof object, a proof changed after, a proof checked as a buy signed as a withdraw
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built, EVM_POOL, proofOf(r)), refusedAs("unchecked"));
  assert.throws(() => signEvmWithdraw(EVM_SECRET, evmCtx(), { ...ask, kind: "pool.withdraw" }, EVM_POOL, proof), refusedAs("unchecked"));
  const moved = proofOf(r, ask.amount);
  checkEvmBuy(built, EVM_POOL, moved, r, spend(ask), evmCtx(), agreedOf(q, ask.amount), planFor(ask));
  moved.context += 1n;
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), built, EVM_POOL, moved), refusedAs("unchecked"));
  const other = "0x2222222222222222222222222222222222222222";
  const P = (x: EvmRelayData) => proofOf(x, ask.amount);
  const F = agreedOf(q, ask.amount);
  for (const [f, rule] of [
    [() => checkEvmBuy(built, other, P(r), r, spend(ask), evmCtx(), F, planFor(ask)), "pool"],
    // a quoted build through another venue list's adapter
    [() => checkEvmBuy(quotedBuy(q, other, { base: pin(B, { pool: EVM_POOL, adapters: { v3: other } }) }), EVM_POOL, P(r), r, spend(ask), evmCtx(), F, planFor(ask)), "adapter"],
    // the build's token and the proof's value, each against an ask the quote agrees with (so only that check refuses)
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, spend({ ...ask, token: other }), evmCtx(), { ...F, token: other }, planFor({ ...ask, token: other })), "token"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, spend({ ...ask, amount: ask.amount + 1n }), evmCtx(), agreedOf(q, ask.amount + 1n), planFor({ ...ask, amount: ask.amount + 1n })), "amount"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, spend({ ...ask, chain: "robinhood" }), evmCtx(), F, planFor({ ...ask, chain: "robinhood" })), "chain"],
    [() => checkEvmBuy(built, EVM_POOL, P(relay({ recipient: other })), relay({ recipient: other }), spend(ask), evmCtx(), F, planFor(ask)), "recipient"],
    [() => checkEvmBuy(built, EVM_POOL, P(relay({ feeRecipient: other })), relay({ feeRecipient: other }), spend(ask), evmCtx(), F, planFor(ask)), "fee_recipient"],
    [() => checkEvmBuy(built, EVM_POOL, P(relay({ feeCap: 10n ** 15n + 1n })), relay({ feeCap: 10n ** 15n + 1n }), spend(ask), evmCtx(), F, planFor(ask)), "fee_cap_over_device_cap"],
    [() => checkEvmBuy(built, EVM_POOL, P(relay({ deadlineMs: NOW })), relay({ deadlineMs: NOW }), spend(ask), evmCtx(), F, planFor(ask)), "deadline_past"],
    [() => checkEvmBuy(built, EVM_POOL, P(relay({ salt: "0x" + "cd".repeat(16) })), r, spend(ask), evmCtx(), F, planFor(ask)), "context"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, spend(ask), evmCtx({ evm: undefined }), F, planFor(ask)), "evm_not_pinned"],
    // the floor is the check's own: the quote's output less the ask's slippage; a build whose min out is under it (the
    // quote's output higher, or the ask's slippage smaller than the quote was asked at) is refused
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, spend(ask), evmCtx(), { ...F, amountOut: q.amountOut * 2n }, planFor(ask)), "min_out"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, spend({ ...ask, slippageBps: 0 }), evmCtx(), { ...F, amountOut: q.minOut + 1n }, planFor({ ...ask, slippageBps: 0 })), "min_out"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, spend(ask), evmCtx(), { ...F, amountOut: 0n }, planFor(ask)), "min_out"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, spend({ ...ask, slippageBps: 10_000 }), evmCtx(), F, planFor({ ...ask, slippageBps: 10_000 })), "slippage"],
    // the quote is the ask's: its token, and the ask's amount less the device's fee cap (what the pool swaps)
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, spend(ask), evmCtx(), { ...F, token: other }, planFor(ask)), "token"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, spend(ask), evmCtx(), { ...F, amountIn: ask.amount }, planFor(ask)), "amount"],
    [() => checkEvmBuy(built, EVM_POOL, P(r), r, spend(ask), evmCtx({ feeCap: ask.amount }), { ...F, amountIn: 0n }, planFor(ask)), "amount"],
    // the kit's unquoted pinned builder, of the same route and min out: not the device's quote
    [() => checkEvmBuy(pinnedBuild(VENUES, "base", A_V3, q.route, q.minOut, q.token), EVM_POOL, P(r), r, spend(ask), evmCtx(), F, planFor(ask)), "not_quoted"],
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
  // at the edges: a relay fee cap equal to the device's, a deadline a millisecond ahead of its clock
  checkEvmWithdraw(EVM_POOL, proofOf(r), r, ask, evmCtx({ feeCap: r.feeCap }));
  checkEvmWithdraw(EVM_POOL, proofOf(r), r, ask, evmCtx({ nowMs: r.deadlineMs - 1n }));
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
    // the relay fee paid to anyone but the pinned fee recipient, the proof bound to that relay data
    [() => checkEvmWithdraw(EVM_POOL, proofOf(relay({ feeRecipient: other })), relay({ feeRecipient: other }), ask, evmCtx()), "fee_recipient"],
    // a fee cap one wei over the device's
    [() => checkEvmWithdraw(EVM_POOL, proofOf(relay({ feeCap: 10n ** 15n + 1n })), relay({ feeCap: 10n ** 15n + 1n }), ask, evmCtx()), "fee_cap_over_device_cap"],
    // a deadline already behind the device's clock
    [() => checkEvmWithdraw(EVM_POOL, proofOf(relay({ deadlineMs: NOW - 1n })), relay({ deadlineMs: NOW - 1n }), ask, evmCtx()), "deadline_past"],
    // the context the check recomputes from the relay data on the pinned pool and chain id: a proof bound on another
    // pool, another chain id, or other relay data is not this one
    [() => checkEvmWithdraw(EVM_POOL, { ...proof, context: ctxOf(r, other) }, r, ask, evmCtx()), "context"],
    [() => checkEvmWithdraw(EVM_POOL, { ...proof, context: evmPoolContextOf({ processooor: EVM_POOL, relay: r }, evmPoolScopeOf(EVM_POOL, 1n)) }, r, ask, evmCtx()), "context"],
    [() => checkEvmWithdraw(EVM_POOL, proofOf(relay({ salt: "0x" + "cd".repeat(16) })), r, ask, evmCtx()), "context"],
    // a pool that is not the pin, named in any case
    [() => checkEvmWithdraw(other.toUpperCase().replace("0X", "0x"), proof, r, ask, evmCtx()), "pool"],
    // nothing withdrawn
    [() => checkEvmWithdraw(EVM_POOL, proofOf(r, 0n), r, ask, evmCtx()), "amount"],
  ] as const) {
    assert.throws(f, refusedAs(rule), rule);
  }
  // the signer: only a binding checkEvmWithdraw passed, as it read it
  // one no check saw, though it reads the same
  assert.throws(() => signEvmWithdraw(EVM_SECRET, evmCtx(), ask, EVM_POOL, proofOf(r)), refusedAs("unchecked"));
  // one the check refused at its last rule
  const late = proofOf(relay({ feeRecipient: other }));
  assert.throws(() => checkEvmWithdraw(EVM_POOL, late, relay({ feeRecipient: other }), ask, evmCtx()), refusedAs("fee_recipient"));
  assert.throws(() => signEvmWithdraw(EVM_SECRET, evmCtx(), ask, EVM_POOL, late), refusedAs("unchecked"));
  // one that passed, its value changed after
  const moved = proofOf(r);
  checkEvmWithdraw(EVM_POOL, moved, r, ask, evmCtx());
  moved.value += 1n;
  assert.throws(() => signEvmWithdraw(EVM_SECRET, evmCtx(), ask, EVM_POOL, moved), refusedAs("unchecked"));
  // the passed one, under a context handed to the signer after with another chain id: the digest is the check's
  const otherCtx = evmCtx({ evm: { venues: Object.freeze({ base: pin(B, { pool: EVM_POOL, chainId: 1 }) }), feeRecipient: FEE_TO } });
  assert.deepEqual(signEvmWithdraw(EVM_SECRET, otherCtx, ask, EVM_POOL, proof), sig);
  // r ‖ s ‖ v, s low, v 27 or 28
  assert.equal(sig.length, 65);
  assert.ok(sig[64] === 27 || sig[64] === 28);
  assert.ok(BigInt(hex(sig.slice(32, 64))) <= secp256k1.Point.CURVE().n / 2n, "low s");
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
  const d = checkEvmSell(built, ask, ctx, { amountOut: q.amountOut });
  assert.deepEqual([d.pool, d.amount, d.feeCap], [EVM_POOL, req.amount, req.feeCap]);
  assert.equal(signEvmSell(EVM_SECRET, ctx, built).length, 65);
  const other = "0x2222222222222222222222222222222222222222";
  for (const [f, rule] of [
    [() => checkEvmSell(built, ask, { ...ctx, wallet: other }, { amountOut: 1n }), "wallet"],
    [() => checkEvmSell(built, { ...ask, token: other }, ctx, { amountOut: 1n }), "token"],
    [() => checkEvmSell(built, { ...ask, amount: 1n }, ctx, { amountOut: 1n }), "amount"],
    // a share is turned into units before any sale is built (card pool-sell-share-across-wallets): a share ask is refused
    [() => checkEvmSell(built, { ...ask, shareBps: 10_000 }, ctx, { amountOut: 1n }), "amount"],
    [() => checkEvmSell(built, ask, { ...ctx, feeCap: req.feeCap - 1n }, { amountOut: 1n }), "fee_cap_over_device_cap"],
    [() => checkEvmSell(built, ask, { ...ctx, nowMs: req.deadline * 1000n }, { amountOut: 1n }), "deadline_past"],
    [() => checkEvmSell(built, ask, { ...ctx, evm: { venues: { base: pin(B, { pool: other }) }, feeRecipient: FEE_TO } }, { amountOut: 1n }), "pool"],
    [() => checkEvmSell(built, { ...ask, kind: "pool.buy" }, ctx, { amountOut: 1n }), "kind"],
    [() => checkEvmSell(built, ask, ctx, { amountOut: q.amountOut * 2n }), "min_out"],
    // the floor is the rule's own, from the quote's amount out and the ask's slippage (card signpage-evm-pool-sell): a
    // sell whose min out was made with more slippage than the user asked is refused, whatever the quote's own minOut
    [() => checkEvmSell(built, { ...ask, slippageBps: 50 }, ctx, { amountOut: q.amountOut }), "min_out"],
    [() => checkEvmSell(built, { ...ask, slippageBps: 10_000 }, ctx, { amountOut: q.amountOut }), "slippage"],
    // the proceeds go into the pool under the device's own precommitment only, never another's note
    [() => checkEvmSell(built, ask, { ...ctx, precommitment: 6n }, { amountOut: 1n }), "precommitment"],
    // the fee goes to the Sell's signed recipient (card pool-review-3, L-1)
    // the fee goes to the venue's pinned FeeCollector (card evm-testnet-delegate-review3): a sell paying another address
    // (built under a list that pins it), or a page that pins another collector, is refused
    [() => checkEvmSell(evmQuotedSell(Object.freeze({ base: pin(VENUES.base, { feeCollector: other }) }), q, { feeRecipient: other, precommitment: 5n, feeCap: req.feeCap, deadline: req.deadline, nonce: 0n }, Date.now()), ask, ctx, { amountOut: 1n }), "fee_recipient"],
    [() => checkEvmSell(built, ask, { ...ctx, evm: { venues: Object.freeze({ base: pin(VENUES.base, { feeCollector: other }) }), feeRecipient: FEE_TO } }, { amountOut: 1n }), "fee_recipient"],
    // the kit's unquoted pinned builder, of the same route and min out: not the device's quote
    [() => checkEvmSell(pinnedBuildSell(VENUES, "base", { w: EVM_W, token: X, amount: q.amountIn, target: q.target, route: q.route, minOut: q.minOut, feeRecipient: COLLECTOR, precommitment: 5n, feeCap: req.feeCap, deadline: req.deadline, nonce: 0n }), ask, ctx, { amountOut: 1n }), "not_quoted"],
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
  assert.equal(checkEvmSell(good, ask, ctx, { amountOut: q.amountOut }).pool, EVM_POOL);
  assert.equal(signEvmSell(EVM_SECRET, ctx, good).length, 65);
  // a sell paying the withdraw relayer's fee recipient (the device's quote, built under a list that pins it as the
  // collector): the page refuses it, so the helper's fee_recipient refusal is never the first to see it
  const relayerPaid = evmQuotedSell(Object.freeze({ base: pin(venues.base, { feeCollector: FEE_TO }) }), q, fields(FEE_TO), Date.now());
  assert.throws(() => checkEvmSell(relayerPaid, ask, ctx, { amountOut: q.amountOut }), refusedAs("fee_recipient"));
  // the withdraw relayer's fee recipient is not a sell's: another one changes nothing
  assert.equal(checkEvmSell(good, ask, { ...ctx, evm: { venues, feeRecipient: "0x2222222222222222222222222222222222222222" } }, { amountOut: q.amountOut }).pool, EVM_POOL);
  // a venue that pins no collector takes no sell
  const none = Object.freeze({ base: pin(B, { pool: EVM_POOL, adapters: Object.freeze({ v3: A_V3, v4: A_V4 }), sellDelegate: DELEGATE }) });
  assert.throws(() => checkEvmSell(good, ask, { ...ctx, evm: { venues: none, feeRecipient: FEE_TO } }, { amountOut: q.amountOut }), refusedAs("evm_not_pinned"));
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
  checkEvmSell(real, realAsk, { ...ctx, precommitment: 5n }, { amountOut: q.amountOut });
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
  // pure builders with no reader; wallet/src/pool/pieces.ts: the piece rule (card every-lamport-can-move), pure, no reader;
  // wallet/src/pool/ladder.ts: the rungs (card buy-any-amount-on-every-chain: W's change goes back as rungs), pure, no reader
  assert.deepEqual(imports.filter((p) => !/^@noble\/|^@scure\//.test(p!) && !/(checks\/solana\/(message|checks)|trade\/solana\/pool-(buy|deposit)|trade\/evm\/(buy|sell)-unpinned|trade\/evm\/quoted|wallet\/src\/pool\/(evm|pieces|ladder))\.ts$/.test(p!)), []);
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
// Card sol-pool-buys-mayhem-coins (the review of 6eb64bdb): every account of every step of the venue's sell is the one
// the kit builds from the device's own venue read, never the wire's. Each one in turn names another key (a signer's
// slot planted unsigned, so the signers stay W alone): on the curve, a cashback curve (its volume accumulator) and
// PumpSwap (its wrapped-SOL account, the sell, the close), each is refused sell_accounts, and the wire as built passes
test("Solana sell: each account of each step of the venue's sell, on the curve, a cashback curve and PumpSwap, naming another key is refused sell_accounts", async () => {
  const RESERVE = 5_000n;
  const PART: SolanaSellSurplus = { full: false, fee: 5_000n, rent: { lamportsPerByte: 5_080n, factor: 1n } };
  const amount = 5_000_000n;
  let planted = 0;
  for (const [name, v, cashback] of [["curve", "pump", false], ["cashback curve", "pump", true], ["pumpswap", "pumpswap", false]] as const) {
    const s = await setup(v);
    const venue = cashback ? { ...s.venue, cashback: true } : s.venue;
    const kind = venue.kind;
    const reference = { amount, ref: s.ref, slippageBps: 300 };
    const floor = (s.ref.pools.find((p) => p.venue === kind)!.expectedOut * 9_700n) / 10_000n;
    const ask: PoolAsk = { kind: "pool.sell", chain: "solana", token: venue.mint, amount, slippageBps: 300, decimals: 6 };
    const steps = () => solanaPoolSellSteps(venue, SOL_W, amount, floor).map((x) => ({ ...x, accounts: x.accounts.map((a) => ({ ...a })) }));
    // the deposit back in the six (its pages read on chain), so PumpSwap's sell with no lookup table stays under 1,232 bytes
    const check = (sell: Ixx[]) => checkSolanaSell(wire(SOL_W, [cuLimit, ...sell, depositIx({ value: solanaNoteOf(floor - RESERVE), six: true })]), ask, solCtx(), venue, reference, s.reads.slot, SOL_READS, RESERVE, PART);
    assert.equal(check(steps()).back, solanaNoteOf(floor - RESERVE), `${name}: the kit's own sell passes`);
    const built = steps();
    if (cashback) assert.equal(built[0]!.accounts.length, s.venue.kind === "pump-curve" ? solanaPoolSellSteps(s.venue, SOL_W, amount, floor)[0]!.accounts.length + 1 : 0, "the cashback curve's sell names its volume accumulator too");
    for (let i = 0; i < built.length; i++) {
      for (let j = 0; j < built[i]!.accounts.length; j++) {
        const bent = steps();
        const a = bent[i]!.accounts[j]!;
        bent[i]!.accounts[j] = { key: key(200 + (planted % 50)), signer: false, writable: a.writable };
        assert.throws(() => check(bent), refusedAs("sell_accounts"), `${name}: step ${i} account ${j} (${a.key}) from the wire`);
        planted++;
      }
    }
  }
  assert.equal(planted, 18 + 19 + 29, "the curve's 18 accounts, the cashback curve's 19, PumpSwap's 29 over its three steps");
});

test("Solana sell: a deposit back under the sale's note floor (the pool's piece floor, or the kit's release floor at the rent read up to the grid) is refused by name (deposit_floor); at the floor it passes; under it the venue's sell alone passes, drawing no deposit", async () => {
  const { venue, ref, reads } = await setup("pump");
  const amount = 5_000_000n;
  const reference = { amount, ref: { ...ref, pools: ref.pools.map((p) => ({ ...p, expectedOut: 1_000n })) }, slippageBps: 300 };
  const ask: PoolAsk = { kind: "pool.sell", chain: "solana", token: venue.mint, amount, slippageBps: 300, decimals: 6 };
  const rent = { lamportsPerByte: 5_080n, factor: 1n } as SolanaSellSurplus["rent"];
  const PART: SolanaSellSurplus = { full: false, fee: 5_000n, rent };
  // card every-lamport-can-move: at mainnet's rent the kit's release floor (2,600,000) is under the piece floor, so the
  // piece floor holds
  assert.equal(solanaPoolNoteFloor(rent), 2_600_000n);
  const noteFloor = solanaSellNoteFloor(rent);
  assert.equal(noteFloor, SOL_NOTE_FLOOR);
  const RESERVE = 5_000n;
  const steps = (minOut: bigint) => solanaPoolSellSteps(venue, SOL_W, amount, minOut) as Ixx[];
  const sell = (minOut: bigint, ixs: Ixx[], p: SolanaSellSurplus | null = PART) => checkSolanaSell(wire(SOL_W, ixs), ask, solCtx(), venue, reference, reads.slot, SOL_READS, RESERVE, p ?? undefined);
  // a lamport under the floor: the deposit refused by name, in the eight and the six, at any value
  const under = RESERVE + noteFloor - 1n;
  assert.throws(() => sell(under, [...steps(under), depositIx({ value: noteFloor - SOL_GRID })]), refusedAs("deposit_floor"));
  assert.throws(() => sell(under, [...steps(under), depositIx({ value: noteFloor - SOL_GRID, six: true })]), refusedAs("deposit_floor"));
  assert.throws(() => sell(under, [...steps(under), depositIx({ value: noteFloor - 1n })]), refusedAs("deposit_floor"));
  // the old bound's own case: just over the pool's least deposit
  const least = RESERVE + SOLANA_POOL_MIN_DEPOSIT;
  assert.throws(() => sell(least, [...steps(least), depositIx({ value: SOLANA_POOL_MIN_DEPOSIT })]), refusedAs("deposit_floor"));
  // at the floor: the deposit passes, drawn; a grid step under it refused
  const at = RESERVE + noteFloor;
  assert.equal(sell(at, [...steps(at), depositIx({ value: noteFloor })]).back, noteFloor);
  assert.throws(() => sell(at, [...steps(at), depositIx({ value: noteFloor - SOL_GRID })]), refusedAs("deposit_amount"));
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
  // the floor follows the rent read: where the kit's release floor passes the piece floor (here 3 x mainnet's rent:
  // 7,800,000, up to the grid 8,000,000) the same deposit is under it
  const steep = { lamportsPerByte: 15_240n, factor: 1n } as SolanaSellSurplus["rent"];
  assert.ok(solanaSellNoteFloor(steep) > noteFloor && solanaSellNoteFloor(steep) % SOL_GRID === 0n, String(solanaSellNoteFloor(steep)));
  assert.throws(() => sell(at, [...steps(at), depositIx({ value: noteFloor })], { ...PART, rent: steep }), refusedAs("deposit_floor"));
});

// card every-lamport-can-move: the rules' grid note is the wallet's noteOf at SOL_PIECES, from its constants by name
test("solanaNoteOf is noteOf at SOL_PIECES: down to SOL_GRID, none under SOL_NOTE_FLOOR, at every edge", () => {
  for (const x of [0n, 1n, SOL_GRID - 1n, SOL_GRID, SOL_NOTE_FLOOR - 1n, SOL_NOTE_FLOOR, SOL_NOTE_FLOOR + 1n, SOL_NOTE_FLOOR + SOL_GRID - 1n, SOL_NOTE_FLOOR + SOL_GRID, 123_456_789n, 10n ** 18n + 7n]) {
    assert.equal(solanaNoteOf(x), noteOf(SOL_PIECES, x).note, String(x));
  }
  assert.equal(solanaNoteOf(-1n), 0n);
  assert.deepEqual(solanaSweepOf(SOL_NOTE_FLOOR + SOL_GRID - 1n), { value: SOL_NOTE_FLOOR, under: SOL_GRID - 1n });
  assert.deepEqual(solanaSweepOf(SOL_NOTE_FLOOR), { value: SOL_NOTE_FLOOR, under: 0n });
  assert.deepEqual(solanaSweepOf(SOL_NOTE_FLOOR - 1n), { value: 0n, under: 0n });
  assert.deepEqual(solanaSweepOf(-5n), { value: 0n, under: 0n });
});

// card every-lamport-can-move: the rule passes exactly what the device builds on a partial sell (solanaSellReserve: its
// reserve, and the grid note of min out less it, or the venue's sell alone under the floor), and nothing else at the
// same reads; fuzzed over rents, fees, made accounts, rents taken, W's lamports and min outs at the edges
test("Solana partial sell: the rule passes exactly the device's reserve and grid note, or its venue sell alone under the floor, and no other reserve or value", async () => {
  const { venue, ref, reads } = await setup("pump");
  const amount = 5_000_000n;
  const reference = { amount, ref: { ...ref, pools: ref.pools.map((p) => ({ ...p, expectedOut: 1_000n })) }, slippageBps: 300 };
  const ask: PoolAsk = { kind: "pool.sell", chain: "solana", token: venue.mint, amount, slippageBps: 300, decimals: 6 };
  const rule = (minOut: bigint, reserve: bigint, p: SolanaSellSurplus, value: bigint | null): boolean => {
    try {
      checkSolanaSell(wire(SOL_W, [...(solanaPoolSellSteps(venue, SOL_W, amount, minOut) as Ixx[]), ...(value === null ? [] : [depositIx({ value })])]), ask, solCtx(), venue, reference, reads.slot, SOL_READS, reserve, p);
      return true;
    } catch (e) {
      if (e instanceof PoolRuleRefused) return false;
      throw e;
    }
  };
  let s = 7;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ri = (a: bigint, b: bigint) => a + BigInt(Math.floor(rnd() * Number(b - a + 1n)));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const bad: string[] = [];
  let n = 0;
  for (let it = 0; it < 300; it++) {
    const rent = pick([{ lamportsPerByte: 5_080n, factor: 1n }, { lamportsPerByte: 6_960n, factor: 1n }, { lamportsPerByte: 3_480n, factor: 2n }, { lamportsPerByte: ri(1n, 20_000n), factor: 1n }]) as SolanaSellSurplus["rent"];
    const fee = rnd() < 0.5 ? 5_000n : ri(0n, 5_000n + SOLANA_POOL_SELL_PRIORITY);
    const P: SolanaSellSurplus = { full: false, fee, rent };
    const made = rnd() < 0.5 ? 0n : ri(0n, 3_000_000n);
    const rents = ri(0n, 3_000_000n);
    const after = ri(0n, 3_000_000n);
    const lamports = rnd() < 0.3 ? 0n : ri(0n, 10_000_000n);
    const F = solanaSellNoteFloor(rent);
    const short = fee + made + rents + after - lamports;
    const r0 = short > 0n ? short : 0n;
    const minOut = r0 + pick([F, F - 1n, F + SOL_GRID - 1n, F + SOL_GRID, SOL_NOTE_FLOOR, 2n * F + 123_457n, 1_000n]) + ri(-2n, 2n);
    if (minOut < 970n) continue;
    n++;
    const dev = solanaSellReserve({ fee, made, rents, after, lamports, minOut, noteFloor: F });
    if ("refused" in dev) {
      if (rule(minOut, r0, P, solanaNoteOf(minOut - r0) || null) && r0 > SOLANA_POOL_SELL_RESERVE_MAX) bad.push(`extra it=${it} over the cap`);
      continue;
    }
    // the device's own build passes
    if (!rule(minOut, dev.reserve, P, dev.value === 0n ? null : dev.value)) bad.push(`stuck it=${it} ${dev.reserve} ${dev.value}`);
    // no other value at its reserve: a lamport and a grid step either way, the exact lamport amount, the bare sell
    for (const v of [dev.value + 1n, dev.value - 1n, dev.value + SOL_GRID, dev.value - SOL_GRID, minOut - dev.reserve]) {
      if (v <= 0n || v === dev.value) continue;
      if (rule(minOut, dev.reserve, P, v)) bad.push(`extra it=${it} value ${v} for ${dev.value}`);
    }
    if (dev.value > 0n && rule(minOut, dev.reserve, P, null)) bad.push(`extra it=${it} kept with a note of ${dev.value}`);
    if (dev.value === 0n && minOut - dev.reserve >= F) bad.push(`device kept a note it can make it=${it}`);
    // every note the rule passes is on the grid and at least the piece floor
    if (dev.value !== 0n && (dev.value % SOL_GRID !== 0n || dev.value < SOL_NOTE_FLOOR)) bad.push(`off the grid it=${it} ${dev.value}`);
  }
  assert.ok(n > 200, String(n));
  assert.deepEqual(bad.slice(0, 10), []);
});

// card every-lamport-can-move: W's sweep, the rule's planted refusals. Review P3-1 of T1+T2: accepted exactly
// the one tag 1 deposit, its value on the grid and at least SOL_NOTE_FLOOR, then at most one System transfer from W to
// the pinned relayer's account (the pin's feePayer: review P1-1 of 1d3b96d9c, the pool's account holds no lamport past its
// books, so a tail paid there is locked for good) of the rest under the grid (0 < t < SOL_GRID); no compute budget (W
// pays its one signature, so a sweep that fails on chain costs 5,000); value + fee + t + rents + keep exactly W's lamports
test("Solana sweep, P3-1: the grid note and its rest as one transfer to the pinned relayer's account pass; one to the pool's account, a budget, another recipient, a transfer at the grid, a second transfer, an off-grid value, an equation off by a lamport are each refused", () => {
  const rent = { lamportsPerByte: 5_080n, factor: 1n } as SolanaSellSurplus["rent"];
  const none = [null, null] as const;
  const held: SolanaDepositHeld = { mark: none, state: none, label: none };
  const rents = solanaDepositRents(rent, SOL_READS, held);
  const limitIx = (l: number) => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(2, ...u64(BigInt(l)).slice(0, 4)) });
  const priceIx = (p: bigint) => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(3, ...u64(p)) });
  const sweep = (ixs: Ixx[], lamports: bigint, owed = 0) => checkSolanaSweep(wire(SOL_W, ixs), solCtx(), SOL_READS, lamports, rent, held, owed);
  const value = SOL_NOTE_FLOOR + 7n * SOL_GRID;
  const rest = 345_678n;
  assert.ok(rest < SOL_GRID);
  const lamports = value + 5_000n + rest + rents;
  const ok = [depositIx({ value }), send(SOL_FEE_PAYER, rest)];
  assert.equal(sweep(ok, lamports), value);
  // the device's own split of that rest is this one
  assert.deepEqual(solanaSweepOf(lamports - 5_000n - rents), { value, under: rest });
  // a rest of 0: the deposit alone; the largest rest, a lamport under the grid
  assert.equal(sweep([depositIx({ value })], value + 5_000n + rents), value);
  assert.equal(sweep([depositIx({ value }), send(SOL_FEE_PAYER, SOL_GRID - 1n)], value + 5_000n + SOL_GRID - 1n + rents), value);
  // an owed claim's keep stays on W, exactly; and a kept account's (review P2-1)
  assert.equal(sweep(ok, lamports + solanaSweepKeep(rent, 1), 1), value);
  assert.equal(checkSolanaSweep(wire(SOL_W, ok), solCtx(), SOL_READS, lamports + solanaSweepKeep(rent, 0, 2), rent, held, 0, 2), value);
  for (const [name, ixs, l, rule] of [
    // the old shape: the rest as a priority at a 1,000,000-unit limit, and any compute budget at all
    ["the rest as a priority", [limitIx(1_000_000), priceIx(rest), depositIx({ value })], lamports, "instructions"],
    ["a price before the deposit", [priceIx(rest), depositIx({ value })], lamports, "program"],
    ["a budget after the deposit", [depositIx({ value }), priceIx(rest)], lamports, "transfer"],
    // the transfer: to another account, from another, at or over the grid, of 0, a second one, before the deposit
    ["to another account", [depositIx({ value }), send(key(79), rest)], lamports, "transfer_to"],
    ["to W itself", [depositIx({ value }), send(SOL_W, rest)], lamports, "transfer_to"],
    // review P1-1 of 1d3b96d9c: the pool's account keeps no lamport its books do not name, so nobody could ever take it
    ["to the pool's account", [depositIx({ value }), send(POOL, rest)], lamports, "transfer_to"],
    ["from another account", [depositIx({ value }), { ...send(SOL_FEE_PAYER, rest), accounts: [acc(key(78), false, true), acc(SOL_FEE_PAYER, false, true)] }], lamports, "transfer_to"],
    ["at the grid", [depositIx({ value }), send(SOL_FEE_PAYER, SOL_GRID)], value + 5_000n + SOL_GRID + rents, "transfer_amount"],
    ["over the grid", [depositIx({ value }), send(SOL_FEE_PAYER, SOL_GRID + 1n)], value + 5_000n + SOL_GRID + 1n + rents, "transfer_amount"],
    ["of 0", [depositIx({ value }), send(SOL_FEE_PAYER, 0n)], value + 5_000n + rents, "transfer_amount"],
    ["a second transfer", [depositIx({ value }), send(SOL_FEE_PAYER, rest - 1n), send(SOL_FEE_PAYER, 1n)], lamports, "instructions"],
    ["the transfer first", [send(SOL_FEE_PAYER, rest), depositIx({ value })], lamports, "program"],
    ["another program's bytes", [depositIx({ value }), { ...send(SOL_FEE_PAYER, rest), program: key(80) }], lamports, "transfer"],
    ["another System instruction", [depositIx({ value }), { ...send(SOL_FEE_PAYER, rest), data: Uint8Array.of(3, 0, 0, 0, ...u64(rest)) }], lamports, "transfer"],
    // an off-grid value, and one under the floor on the grid, each with the equation exact
    ["off the grid", [depositIx({ value: value + 1n }), send(SOL_FEE_PAYER, rest - 1n)], lamports, "amount"],
    ["no transfer, off the grid", [depositIx({ value: value + rest })], lamports, "amount"],
    ["under the floor", [depositIx({ value: SOL_NOTE_FLOOR - SOL_GRID }), send(SOL_FEE_PAYER, rest)], SOL_NOTE_FLOOR - SOL_GRID + 5_000n + rest + rents, "amount"],
    ["two deposits", [depositIx({ value }), depositIx({ value })], lamports, "transfer"],
    // the equation off by a lamport either way, with and without the transfer
    ["a lamport more on W", ok, lamports + 1n, "sweep_amount"],
    ["a lamport less on W", ok, lamports - 1n, "sweep_amount"],
    ["no transfer, a lamport more on W", [depositIx({ value })], value + 5_000n + rents + 1n, "sweep_amount"],
    ["the keep not left", ok, lamports, "sweep_amount", 1],
  ] as const) {
    const owed = name === "the keep not left" ? 1 : 0;
    assert.throws(() => sweep(ixs as unknown as Ixx[], l as bigint, owed), refusedAs(rule as string), name as string);
  }
});

// card round-trip-costs-less, review P2-2 of 4f9217972: the sale's priority is bounded by the rule itself, not only by
// the builder (src/pool-sell.ts solanaSellBudget): a sale whose compute budget pays over SOLANA_POOL_SELL_PRIORITY is
// refused at any price the head's own caps pass (its 1,400,000 limit and 1,000,000 price paid 1,400,000 before), and a
// full sell's keep is priced at no fee over one signature and that priority (105,000)
test("round-trip-costs-less P2-2: a Solana sale paying more priority than SOLANA_POOL_SELL_PRIORITY is refused, the cap itself passes, and a full sell's fee is held to 5,000 plus that priority", async () => {
  const { venue, ref, reads } = await setup("pump");
  const amount = 5_000_000n;
  const reference = { amount, ref, slippageBps: 300 };
  const floor = (ref.pools.find((p) => p.venue === "pump-curve")!.expectedOut * 9_700n) / 10_000n;
  const ask: PoolAsk = { kind: "pool.sell", chain: "solana", token: venue.mint, amount, slippageBps: 300, decimals: 6 };
  const RESERVE = 5_000n;
  const PART: SolanaSellSurplus = { full: false, fee: 5_000n, rent: { lamportsPerByte: 5_080n, factor: 1n } };
  const limitIx = (l: number) => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(2, ...u64(BigInt(l)).slice(0, 4)) });
  const priceIx = (p: bigint) => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(3, ...u64(p)) });
  const steps = () => solanaPoolSellSteps(venue, SOL_W, amount, floor).map((x) => ({ ...x, accounts: x.accounts.map((a) => ({ ...a })) }));
  const NOTE = solanaNoteOf(floor - RESERVE);
  const sale = (budget: Ixx[], reserve = RESERVE, p: SolanaSellSurplus = PART) => checkSolanaSell(wire(SOL_W, [...budget, ...steps(), ...(p.full ? [] : [depositIx({ value: solanaNoteOf(floor - reserve) })])]), ask, solCtx(), venue, reference, reads.slot, SOL_READS, reserve, p);
  assert.equal(SOLANA_POOL_SELL_PRIORITY, 100_000n);
  // the pump sale's limit (87,102 units x 1.2) at the price the cap buys: 100,000 lamports exactly, passes; one more
  // micro-lamport a unit is 100,001, refused
  assert.equal(sale([limitIx(104_523), priceIx(956_727n)]).back, NOTE);
  assert.throws(() => sale([limitIx(104_523), priceIx(956_728n)]), refusedAs("priority"));
  // the head's own caps (1,400,000 units, 1,000,000 a unit) pass the head and are refused here: 1,400,000 lamports
  assert.throws(() => sale([limitIx(1_400_000), priceIx(1_000_000n)]), refusedAs("priority"));
  // a price with no limit is priced at the runtime's most, 1,400,000 units: 71,428 a unit is 99,999.2, 100,000 rounded
  // up, passes; 71,429 is 100,000.6, 100,001, refused
  assert.equal(sale([priceIx(71_428n)]).back, NOTE);
  assert.throws(() => sale([priceIx(71_429n)]), refusedAs("priority"));
  // a limit alone, or no budget, pays no priority
  assert.equal(sale([limitIx(1_400_000)]).back, NOTE);
  assert.equal(sale([]).back, NOTE);
  // a full sell (no deposit, a reserve of 0, card every-lamport-can-move): its fee of 5,000 plus SOLANA_POOL_SELL_PRIORITY
  // passes; a lamport of fee over it is refused, with a budget or none
  const budget = [limitIx(104_523), priceIx(956_727n)];
  const fee = 5_000n + 100_000n;
  const FULL: SolanaSellSurplus = { full: true, fee, rent: { lamportsPerByte: 5_080n, factor: 1n } };
  assert.equal(sale(budget, 0n, FULL).back, null);
  assert.throws(() => sale(budget, 0n, { ...FULL, fee: fee + 1n }), refusedAs("reserve"));
  assert.equal(sale([], 0n, FULL).back, null);
  assert.throws(() => sale([], 0n, { ...FULL, fee: fee + 1n }), refusedAs("reserve"));
});

// review 2 P3-b of c0dd55d02: a partial sale's reserve is priced at a fee too, and the rule held only a full sell's; a
// partial sale priced at a 1,405,000 fee (its priority 100,000) passed and held up to SOLANA_POOL_SELL_RESERVE_MAX back
// on W. The fee a sale names is held to one signature and SOLANA_POOL_SELL_PRIORITY on every sale that names one.
test("round-trip-costs-less P3-b: a partial Solana sale's fee is held to 5,000 plus SOLANA_POOL_SELL_PRIORITY as a full one's: 105,000 passes, 105,001 and 1,405,000 are refused", async () => {
  const { venue, ref, reads } = await setup("pump");
  const amount = 5_000_000n;
  const reference = { amount, ref, slippageBps: 300 };
  const floor = (ref.pools.find((p) => p.venue === "pump-curve")!.expectedOut * 9_700n) / 10_000n;
  const ask: PoolAsk = { kind: "pool.sell", chain: "solana", token: venue.mint, amount, slippageBps: 300, decimals: 6 };
  const limit = { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(2, ...u64(104_523n).slice(0, 4)) };
  const price = { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(3, ...u64(956_727n)) };
  const steps = () => solanaPoolSellSteps(venue, SOL_W, amount, floor).map((x) => ({ ...x, accounts: x.accounts.map((a) => ({ ...a })) }));
  const part = (fee: bigint): SolanaSellSurplus => ({ full: false, fee, rent: { lamportsPerByte: 5_080n, factor: 1n } });
  const sale = (fee: bigint) => checkSolanaSell(wire(SOL_W, [limit, price, ...steps(), depositIx({ value: solanaNoteOf(floor - fee) })]), ask, solCtx(), venue, reference, reads.slot, SOL_READS, fee, part(fee));
  assert.equal(sale(5_000n + SOLANA_POOL_SELL_PRIORITY).back, solanaNoteOf(floor - 5_000n - SOLANA_POOL_SELL_PRIORITY));
  assert.throws(() => sale(5_001n + SOLANA_POOL_SELL_PRIORITY), refusedAs("reserve"));
  assert.throws(() => sale(1_405_000n), refusedAs("reserve"));
  // a fee that is no number, or under 0, is refused on a partial sale as on a full one
  assert.throws(() => checkSolanaSell(wire(SOL_W, [limit, price, ...steps(), depositIx({ value: solanaNoteOf(floor - 5_000n) })]), ask, solCtx(), venue, reference, reads.slot, SOL_READS, 5_000n, { ...part(5_000n), fee: -1n }), refusedAs("reserve"));
});
