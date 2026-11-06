// The review of src/rules/pool.ts (card signpage-pool-kinds): each attack it planted, kept as a test that failed before
// its fold (A1-A4, A9) and passes after. The setup is test/rules-pool.test.ts's: a good payload of each kind passes its
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
import { SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_SYSTEM_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import {
  buildSolanaPoolBuy,
  solanaEncodePoolRelease,
  solanaPoolPage,
  solanaPoolReleaseAccounts,
  solanaPoolSellSteps,
  type SolanaPoolRelease,
} from "../../kit/src/trade/solana/pool-buy.ts";
import { evmPoolVenues, pinnedBuild, pinnedBuildQuoted, type EvmPoolVenue } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolSellFeeMax, pinnedBuildSell } from "../../kit/src/trade/evm/sell-unpinned.ts";
import { evmPoolBuyQuoteWith, type EvmPoolBuyQuote, type EvmRpc, type EvmRpcCall } from "../../kit/src/checks/evm/quote.ts";
import { evmQuotedBuy, evmQuotedSell } from "../../kit/src/trade/evm/quoted.ts";
import { flat, provider as sellModel, req as sellReq, sellQuoteWith } from "../../kit/test/evm-sell-quote-fx.ts";
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
  drawPool,
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

const enc = (s: string) => new TextEncoder().encode(s);
const key = (n: number) => base58.encode(new Uint8Array(32).fill(n));
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return [...b]; };
const NOW = 1_800_000_000_000n;
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
// the network's FeeCollector a Sell pays (card evm-testnet-delegate-review3), not the withdraw relayer's FEE_TO
const COLLECTOR = "0x00000000000000000000000000000000000c011e";
const pin = (v: EvmPoolVenue, o: Partial<EvmPoolVenue>): EvmPoolVenue => Object.freeze({ ...v, ...o });
const VENUES = Object.freeze({ base: pin(B, { pool: EVM_POOL, adapters: Object.freeze({ v3: A_V3, v4: A_V4 }), sellDelegate: DELEGATE, feeCollector: COLLECTOR }) });
const evmCtx = (o: Partial<PoolContext> = {}): PoolContext => ({ nowMs: NOW, wallet: EVM_W, feeCap: 10n ** 15n, evm: { venues: VENUES, feeRecipient: FEE_TO }, ...o });
const relay = (o: Partial<EvmRelayData> = {}): EvmRelayData => ({ recipient: EVM_W, feeRecipient: FEE_TO, feeCap: 10n ** 14n, deadlineMs: NOW + 120_000n, refundPrecommitment: 7n, salt: "0x" + "ab".repeat(16), ...o });
const ctxOf = (r: EvmRelayData, pool = EVM_POOL) => evmPoolContextOf({ processooor: pool, relay: r }, evmPoolScopeOf(pool, BigInt(B.chainId)));
const proofOf = (r: EvmRelayData, value = 10n ** 16n) => ({ nullifier: 11n, context: ctxOf(r), value });
const v3 = (tokens: string[]) => ({ venue: "uniswap-v3" as const, tokens, fees: tokens.slice(1).map(() => 500) });
// The device's own quotes (the page signs only builds made from one, card evm-buy-hookdata-fee M1): a buy replayed from
// Base's recorded answers (kit test/fixtures/evm-quote.json "base-ok", at the recording's clock), a sell on the kit's
// modelled chain (kit test/evm-sell-quote-fx.ts), W the page's
type Exchange = { calls: EvmRpcCall[]; answers: unknown[] };
const QF = (JSON.parse(readFileSync(new URL("../../kit/test/fixtures/evm-quote.json", import.meta.url), "utf8")) as Record<string, { request: Record<string, unknown>; now: number; exchanges: [Exchange[], Exchange[]] }>)["base-ok"]!;
const replay = (ex: Exchange[]): EvmRpc => async (calls) => structuredClone(ex.find((x) => JSON.stringify(x.calls) === JSON.stringify(calls))!.answers);
const buyQuote = (): Promise<EvmPoolBuyQuote> => {
  const { buys, amountIn, ...rest } = QF.request;
  return evmPoolBuyQuoteWith({ ...(rest as object), token: buys as string, amountIn: BigInt(amountIn as string) } as never, [replay(QF.exchanges[0]), replay(QF.exchanges[1])], QF.now);
};
const sellQuote = () => sellQuoteWith(sellReq("base", { w: EVM_W }), [sellModel({ price: flat }), sellModel({ price: flat })], Date.now());

// ======================= the reviewer's planted attacks: each payload must be refused =======================
const refused = (f: () => unknown) => assert.throws(f, (e: unknown) => e instanceof PoolRuleRefused);

// A1: the EVM sell's proceeds deposited under a precommitment the device did not make (the helper's own note)
test("ATTACK A1: EVM sell whose Sell carries the attacker's precommitment is refused", async () => {
  const t = BigInt(Math.floor(Date.now() / 1000));
  const ATTACKER_PRE = 666n; // the device's would be ctx.precommitment; the Solana sell holds it, the EVM sell must too
  const q = await sellQuote();
  const built = evmQuotedSell(VENUES, q, { feeRecipient: COLLECTOR, precommitment: ATTACKER_PRE, feeCap: 10n ** 13n, deadline: t + 120n, nonce: 0n }, Date.now());
  const ask: PoolAsk = { kind: "pool.sell", chain: "base", token: q.token, amount: q.amountIn, slippageBps: 100, decimals: 18 };
  const ctx = { ...evmCtx({ nowMs: t * 1000n }), precommitment: 5n };
  assert.throws(() => { checkEvmSell(built, ask, ctx, q.minOut); signEvmSell(EVM_SECRET, ctx, built); }, (e: unknown) => e instanceof PoolRuleRefused && e.rule === "precommitment");
});

// A2: the withdraw draws "amount X to <typed address>" while the signed bytes send 1 lamport (or nothing) there
const ON_BAL = 9_000_000n;
const ON_FEE = 5_000n;
const onReads = { blockhash: BLOCKHASH, balance: [ON_BAL, ON_BAL], fee: [ON_FEE, ON_FEE], toExecutable: [false, false], releaseAccounts: relIx().accounts.map((a) => a.key) } as const;
const onWire = (ixs: ReturnType<typeof send>[], signers = [SOL_W]) => wire(signers[0]!, ixs, signers);
test("ATTACK A2a: Solana withdraw whose onward send is 1 lamport, drawn as the full amount to the typed address, is refused", () => {
  refused(() => checkSolanaOnwardSend(onWire([send(TO, 1n)]), wdAsk, solCtx(), TO, onReads));
});
test("ATTACK A2b: Solana withdraw's release is never drawn as going to the typed address: it lands on W", () => {
  let d: ReturnType<typeof checkSolanaWithdraw> | null = null;
  try { d = checkSolanaWithdraw(wdWire([cuLimit, relIx()]), wdAsk, solCtx(), release, SOL_READS); } catch (e) { if (!(e instanceof PoolRuleRefused)) throw e; }
  if (d) assert.notEqual(d.to, TO, `drawn: ${d.amount} to ${d.to}, signed: nothing to ${TO}`);
});

// A3: request amounts on an EVM chain: an ordinary sell of 100 tokens of an 18-decimals ERC-20 (not an attack: a limit)
test("LIMIT A3: an EVM sell of 100 tokens of an 18-decimals token is a valid request", () => {
  // decimals come from the device's two reads of decimals() (fold: never the caller's number), here both 18
  const d18 = "0x" + (18).toString(16).padStart(64, "0");
  assert.equal(checkPoolRequest({ kind: "pool.sell", chain: "base", token: X, amount: "100", slippage_bps: 100 }, [d18, d18]).amount, 100n * 10n ** 18n);
});

// A4: a proof object whose context reads one way for the checks and another for the digest
test("ATTACK A4: an EVM withdraw proof whose context changes after the check (an accessor) never signs another context", () => {
  const r = relay();
  const ask: PoolAsk = { kind: "pool.withdraw", chain: "base", token: null, amount: 0n, slippageBps: 0, decimals: 18 };
  const real = ctxOf(r);
  let reads = 0;
  const proof = { nullifier: 11n, value: 10n ** 16n, get context() { return ++reads <= 3 ? real : real + 1n; } };
  checkEvmWithdraw(EVM_POOL, proof, r, ask, evmCtx());
  let sig: Uint8Array | null = null;
  try { sig = signEvmWithdraw(EVM_SECRET, evmCtx(), ask, EVM_POOL, proof); } catch (e) { if (!(e instanceof PoolRuleRefused)) throw e; }
  if (sig) {
    const want = evmWithdrawDigest(BigInt(B.chainId), EVM_POOL, { nullifier: 11n, context: real, value: 10n ** 16n });
    const rec = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(sig[64]! - 27).recoverPublicKey(want);
    assert.equal(hex(keccak_256(rec.toBytes(false).slice(1)).slice(12)), EVM_W, "the signature is over a context no check read");
  }
});

// A5: Solana wire aliasing: a second view over the checked wire's buffer, written after the check
test("ATTACK A5: a byte written through another view of the checked wire's buffer is refused at signing", () => {
  const w = wire(SOL_W, [cuLimit, depositIx()]);
  checkSolanaDeposit(w, { kind: "pool.deposit", chain: "solana", token: null, amount: 2_000_000_000n, slippageBps: 0, decimals: 9 }, solCtx(), SOL_READS);
  new Uint8Array(w.buffer)[w.byteOffset + w.length - 1] ^= 1;
  refused(() => signSolana(SOL_SECRET, w));
});

// A6: an extra privilege on a release account: the state root page writable
test("ATTACK A6: the release's state root page made writable is refused", () => {
  const ix = relIx();
  const root = solanaPoolPage(PROGRAM, 0, release.stateRootIndex);
  const newPage = solanaPoolPage(PROGRAM, 0, 6);
  if (root === newPage) return; // same page: writable is the merge's right answer
  ix.accounts = ix.accounts.map((a) => (a.key === root ? { ...a, writable: true } : a));
  refused(() => checkSolanaWithdraw(wdWire([cuLimit, ix]), wdAsk, solCtx(), release, SOL_READS));
});

// A7: a transfer leg in the fee payer's release, two onward legs, or W's onward send to the fee payer
test("ATTACK A7: a release with a send after it, an onward with two sends, or an onward send to the fee payer, is refused", () => {
  refused(() => checkSolanaWithdraw(wdWire([cuLimit, relIx(), send(TO, 1n)]), wdAsk, solCtx(), release, SOL_READS));
  refused(() => checkSolanaOnwardSend(onWire([send(TO, ON_BAL - ON_FEE - 1n), send(TO, 1n)]), wdAsk, solCtx(), TO, onReads));
  refused(() => checkSolanaOnwardSend(onWire([send(SOL_FEE_PAYER, ON_BAL - ON_FEE)]), wdAsk, solCtx(), SOL_FEE_PAYER, onReads));
});

// A8: compute budget: a price over the cap, a heap frame request, a loaded-data limit, a limit over 1.4M
test("ATTACK A8: compute budget instructions outside the caps are refused", () => {
  const cb = (data: number[]) => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from(data) });
  for (const x of [cb([2, 0xc1, 0x5c, 0x15, 0]), cb([3, ...u64(10n ** 12n)]), cb([1, 0, 0, 4, 0]), cb([4, 0, 0, 4, 0])]) {
    refused(() => checkSolanaDeposit(wire(SOL_W, [x, depositIx()]), { kind: "pool.deposit", chain: "solana", token: null, amount: 2_000_000_000n, slippageBps: 0, decimals: 9 }, solCtx(), SOL_READS));
  }
});

// A9: the EVM withdraw's chain id from the context's venue list: a list with chain id 0 signs a chain-id-0 domain
test("HARDEN A9: an EVM withdraw signs only under the kit's own chain id, never a context list's 0", () => {
  const r = relay();
  const ask: PoolAsk = { kind: "pool.withdraw", chain: "base", token: null, amount: 0n, slippageBps: 0, decimals: 18 };
  const zero = Object.freeze({ base: pin(B, { pool: EVM_POOL, chainId: 0, adapters: Object.freeze({ v3: A_V3 }), sellDelegate: DELEGATE }) });
  const ctx = evmCtx({ evm: { venues: zero, feeRecipient: FEE_TO } });
  const proof = { nullifier: 11n, context: evmPoolContextOf({ processooor: EVM_POOL, relay: r }, evmPoolScopeOf(EVM_POOL, 0n)), value: 10n ** 16n };
  refused(() => { checkEvmWithdraw(EVM_POOL, proof, r, ask, ctx); signEvmWithdraw(EVM_SECRET, ctx, ask, EVM_POOL, proof); });
});

// ======================= the re-check's planted attacks (fold 2): each payload must be refused =======================

// R1: the Solana sell's reserve is the caller's: a reserve of min out - 1 deposits 1 lamport and W signs it.
test("RECHECK R1: a Solana sell whose 'reserve' leaves 1 lamport for the pool is refused", async () => {
  const { venue, ref, reads } = await setup("pump");
  const amount = 5_000_000n;
  const reference = { amount, ref, slippageBps: 300 };
  const floor = (ref.pools.find((p) => p.venue === "pump-curve")!.expectedOut * 9_700n) / 10_000n;
  const ask: PoolAsk = { kind: "pool.sell", chain: "solana", token: venue.mint, amount, slippageBps: 300, decimals: 6 };
  const steps = solanaPoolSellSteps(venue, SOL_W, amount, floor).map((x) => ({ ...x, accounts: x.accounts.map((a) => ({ ...a })) }));
  const w = wire(SOL_W, [cuLimit, ...steps, depositIx({ value: 1n })]);
  let signed = false;
  try {
    const d = checkSolanaSell(w, ask, solCtx(), venue, reference, reads.slot, SOL_READS, floor - 1n);
    signed = signSolana(SOL_SECRET, w).length === 64;
  } catch (e) { if (!(e instanceof PoolRuleRefused)) throw e; }
  assert.equal(signed, false, "W signed a sell whose deposit is 1 lamport (reserve = min out - 1, the caller's number)");
});

// R2: an EVM buy's built and proof from two different checks are signed together.
test("RECHECK R2: an EVM buy signs only the built and the proof one check passed together", async () => {
  const r1 = relay();
  const r2 = relay({ salt: "0x" + "cd".repeat(16) });
  const q = await buyQuote();
  const builtSmall = evmQuotedBuy(VENUES, A_V3, q, QF.now); // the device's quote for 0.01 ETH
  const builtBig = evmQuotedBuy(VENUES, A_V3, q, QF.now); // a second build of it, checked with a 1 ETH proof
  const p1 = proofOf(r1, 10n ** 16n);
  const p2 = proofOf(r2, 10n ** 18n);
  checkEvmBuy(builtSmall, EVM_POOL, p1, r1, { kind: "pool.buy", chain: "base", token: q.token, amount: 10n ** 16n, slippageBps: 100, decimals: 18 }, evmCtx(), q.minOut);
  checkEvmBuy(builtBig, EVM_POOL, p2, r2, { kind: "pool.buy", chain: "base", token: q.token, amount: 10n ** 18n, slippageBps: 100, decimals: 18 }, evmCtx(), q.minOut);
  let sig: Uint8Array | null = null;
  try { sig = signEvmBuy(EVM_SECRET, evmCtx(), builtSmall, EVM_POOL, p2); } catch (e) { if (!(e instanceof PoolRuleRefused)) throw e; }
  assert.equal(sig, null, "W signed a Buy pairing check 1's built (min out 10) with check 2's 1 ETH proof");
});

// M1 (card evm-buy-hookdata-fee, review fold 1): the page's EVM buy and sell were signed for any build the kit's unpinned
// builders return, a server's hook data and a fee cap far above the device's rule included. Only builds from the
// device's own quote pass (kit trade/evm/quoted.ts); every other is refused not_quoted, and nothing is signed.
const quotedRefusal = (e: unknown) => e instanceof PoolRuleRefused && e.code === "not_allowed" && e.rule === "not_quoted";

test("PLANTED M1a: an EVM buy with a server's hook data (the kit's unquoted pinned builder) is refused not_quoted, and never signed", async () => {
  const CLANKER = "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"; // Base's pinned Clanker hook, in its own shape
  const route = { venue: "uniswap-v4" as const, currencyIn: B.weth, hops: [{ currency: X, fee: 0x800000, tickSpacing: 200, hooks: CLANKER, hookData: "0x" + "de".repeat(20) }] };
  const r = relay();
  const ask: PoolAsk = { kind: "pool.buy", chain: "base", token: X, amount: 10n ** 16n, slippageBps: 100, decimals: 18 };
  const hooked = pinnedBuild(VENUES, "base", A_V4, route, 1n, X);
  assert.ok(hooked.data.includes("de".repeat(20)), "the build carries the server's hook data");
  const proof = proofOf(r);
  assert.throws(() => checkEvmBuy(hooked, EVM_POOL, proof, r, ask, evmCtx(), 1n), quotedRefusal);
  assert.throws(() => signEvmBuy(EVM_SECRET, evmCtx(), hooked, EVM_POOL, proof), (e: unknown) => e instanceof PoolRuleRefused && e.rule === "unchecked");
  // the quoted pinned builder, which takes a caller's route, and a copy of a quoted build: not the device's quote either
  const q = await buyQuote();
  const quoted = evmQuotedBuy(VENUES, A_V3, q, QF.now);
  const qAsk: PoolAsk = { ...ask, token: q.token };
  for (const b of [pinnedBuildQuoted(VENUES, "base", A_V3, q.route, q.minOut, q.token), { ...quoted }]) {
    assert.throws(() => checkEvmBuy(b, EVM_POOL, proofOf(r), r, qAsk, evmCtx(), q.minOut), quotedRefusal);
  }
  // the device's own build of the same quote passes and signs
  checkEvmBuy(quoted, EVM_POOL, proof, r, qAsk, evmCtx(), q.minOut);
  assert.equal(signEvmBuy(EVM_SECRET, evmCtx(), quoted, EVM_POOL, proof).length, 65);
});

test("PLANTED M1b: an EVM sell with a fee cap 45 x the device's fee rule (the kit's unquoted pinned builder) is refused not_quoted, though the page's cap is above it", async () => {
  const t = BigInt(Math.floor(Date.now() / 1000));
  const q = await sellQuote();
  const feeMax = evmPoolSellFeeMax("base", 5_000_000n, 0n); // the model's block: a 5,000,000 wei base fee, no chain fee
  assert.equal(q.feeMax, feeMax);
  const cap = 45n * feeMax;
  assert.ok(cap < q.minOut, "below min out, so the unpinned builder takes it");
  const ask: PoolAsk = { kind: "pool.sell", chain: "base", token: q.token, amount: q.amountIn, slippageBps: 100, decimals: 18 };
  const ctx = { ...evmCtx({ nowMs: t * 1000n, feeCap: 10n ** 18n }), precommitment: 5n };
  const greedy = pinnedBuildSell(VENUES, "base", { w: EVM_W, token: q.token, amount: q.amountIn, target: q.target, route: q.route, minOut: q.minOut, feeRecipient: COLLECTOR, precommitment: 5n, feeCap: cap, deadline: t + 120n, nonce: 0n });
  assert.throws(() => checkEvmSell(greedy, ask, ctx, q.minOut), quotedRefusal);
  assert.throws(() => signEvmSell(EVM_SECRET, ctx, greedy), (e: unknown) => e instanceof PoolRuleRefused && e.rule === "unchecked");
  // the device's builder refuses that cap itself, and a copy of its build is not its build
  assert.throws(() => evmQuotedSell(VENUES, q, { feeRecipient: COLLECTOR, precommitment: 5n, feeCap: cap, deadline: t + 120n, nonce: 0n }, Date.now()), (e: unknown) => (e as { code?: string }).code === "bad_fee");
  const quoted = evmQuotedSell(VENUES, q, { feeRecipient: COLLECTOR, precommitment: 5n, deadline: t + 120n, nonce: 0n }, Date.now());
  assert.throws(() => checkEvmSell({ ...quoted }, ask, ctx, q.minOut), quotedRefusal);
  // the device's own, at the rule's cap, passes and signs
  assert.equal(checkEvmSell(quoted, ask, ctx, q.minOut).feeCap, feeMax);
  assert.equal(signEvmSell(EVM_SECRET, ctx, quoted).length, 65);
});

// The review of 14196e5c (card evm-testnet-delegate-review3): a sell checkEvmSell refuses is never recorded as
// checked, whatever rule refuses it (the record is made only after every rule: a `passed` moved above any of them
// fails here), so signEvmSell refuses it unchecked; and the pin side of the fee recipient rule is lower-cased too.
test("ATTACK A9: an EVM sell checkEvmSell refused, at any rule, stays unsigned (unchecked)", async () => {
  const t = BigInt(Math.floor(Date.now() / 1000));
  const q = await sellQuote();
  const ask: PoolAsk = { kind: "pool.sell", chain: "base", token: q.token, amount: q.amountIn, slippageBps: 100, decimals: 18 };
  const ctx = { ...evmCtx({ nowMs: t * 1000n }), precommitment: 5n };
  const fields = { feeRecipient: COLLECTOR, precommitment: 5n, feeCap: 10n ** 13n, deadline: t + 120n, nonce: 0n };
  // the withdraw relayer paid in place of the collector: a list whose collector is FEE_TO built it
  const relayerPaid = evmQuotedSell(Object.freeze({ base: pin(VENUES.base, { feeCollector: FEE_TO }) }), q, { ...fields, feeRecipient: FEE_TO }, Date.now());
  const cases: [ReturnType<typeof evmQuotedSell>, PoolAsk, typeof ctx, bigint, string][] = [
    [relayerPaid, ask, ctx, q.minOut, "fee_recipient"],
    [evmQuotedSell(VENUES, q, { ...fields, precommitment: 6n }, Date.now()), ask, ctx, q.minOut, "precommitment"],
    [evmQuotedSell(VENUES, q, fields, Date.now()), { ...ask, amount: q.amountIn - 1n }, ctx, q.minOut, "amount"],
    [evmQuotedSell(VENUES, q, fields, Date.now()), ask, { ...ctx, feeCap: 10n ** 13n - 1n }, q.minOut, "fee_cap_over_device_cap"],
    [evmQuotedSell(VENUES, q, fields, Date.now()), ask, ctx, q.minOut + 1n, "min_out"],
    [evmQuotedSell(VENUES, q, fields, Date.now()), ask, { ...ctx, nowMs: (t + 120n) * 1000n }, q.minOut, "deadline_past"],
  ];
  for (const [built, a, c, floor, rule] of cases) {
    assert.throws(() => checkEvmSell(built, a, c, floor), (e: unknown) => e instanceof PoolRuleRefused && e.rule === rule, rule);
    assert.throws(() => signEvmSell(EVM_SECRET, c, built), (e: unknown) => e instanceof PoolRuleRefused && e.rule === "unchecked", rule);
  }
  // the pin in another case is the same collector: the sell passes and is signed
  const upper = { ...ctx, evm: { venues: Object.freeze({ base: pin(VENUES.base, { feeCollector: COLLECTOR.toUpperCase().replace("0X", "0x") }) }), feeRecipient: FEE_TO } };
  const ok = evmQuotedSell(VENUES, q, fields, Date.now());
  assert.equal(checkEvmSell(ok, ask, upper, q.minOut).feeCap, fields.feeCap);
  assert.equal(signEvmSell(EVM_SECRET, upper, ok).length, 65);
});
