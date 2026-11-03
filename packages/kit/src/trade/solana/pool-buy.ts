// A private buy on Solana in one transaction W signs (architecture v2, merge notes M349-M350; card sol-pool-buy-tx).
// Device side. The Blindfill pool on Solana (contracts/pool-solana, branch pool-sol-core f0d85a8) releases one ready
// proof's chunk of SOL to the fresh wallet W, and in the same transaction W buys on pump.fun or PumpSwap as the venue's
// `user`. W and the fee payer are the two signers; W's signature covers every account and byte, so no relayer can
// redirect the release or the buy.
//
// One shape: tag 3, release-and-buy (contracts/pool-solana/TAG3.md, src/buy.rs), with the compressed proof. One
// top-level instruction into the pool, which verifies, pays W its chunk and the tip, then invokes the inner
// instructions W signed for with W's signer privilege only (never invoke_signed); the venue's program is an account, so
// it loads from our lookup table. The helper carries only compute budget plus one pool tag 2 or tag 3 instruction
// (card helper-pool-senders), so there is no other path. Measured in LiteSVM on mainnet copies 2026-11-02 22:50Z: pump
// 977 B (979 with a tip), 244k CU; PumpSwap 1,134 B (1,136), 294k CU.
//
// The release (tag 2), as contracts/pool-solana/src/release.rs lays it out at f0d85a8:
// - data, 387 bytes: tag 2 ‖ proof (256) ‖ newCommitmentHash (32) ‖ existingNullifierHash (32) ‖ withdrawnValue u64 ‖
//   stateRootIndex u32 ‖ stateTreeDepth u8 ‖ labelRootIndex u32 ‖ labelTreeDepth u8 ‖ relay_fee u64 ‖ relay_fee_cap u64
//   ‖ tip_cap u64 ‖ deadline_ms u64 ‖ salt (16). Integers little-endian, field elements 32 bytes big-endian.
// - accounts: pool (w); W (w, signer); fee payer (w, signer); spent mark ["spent", nullifier] (w); state root page;
//   label root page; the current state page (w), where the change note goes; system program.
// - page PDA ["page", tree u8 (0 state, 1 label), page_no u32 LE], 1,024 entries a page (src/state.rs).
//
// The venues, from pump-fun/pump-public-docs idl/pump.json and idl/pump_amm.json at 639b87fb (read 2026-11-02 18:37Z,
// docs/research/arch-v2/solana-pool.md A3): pump `buy_exact_sol_in` (16 accounts; args spendable_sol_in u64,
// min_tokens_out u64, track_volume OptionBool, partial_fill OptionBool) and PumpSwap `buy_exact_quote_in` (23 accounts;
// args spendable_quote_in u64, min_base_amount_out u64, track_volume OptionBool). Both spend an exact input, which is
// what a chunk is. PumpSwap spends wrapped SOL, so W wraps exactly the spend first and closes the wrapped account after.
//
// Never sign on a server's word: checkSolanaPoolBuy rebuilds every instruction, inner ones included, from the user's own
// request, the ready proof, the venue's accounts read on two providers and the Rent sysvar, and compares the message to
// it byte for byte and flag for flag, on the device's own blockhash; the chunk must cover the spend and W's new
// accounts, and the buy's min_out must hold against the reference E read from the venue's reserves on both providers
// (pool.ts) at most SOLANA_POOL_QUOTE_MAX_AGE_SLOTS ago.
import { base58, base64 } from "@scure/base";
import {
  SOLANA_ALT_PROGRAM,
  SOLANA_ATA_PROGRAM,
  SOLANA_MAX_TX_BYTES,
  solanaAta,
  solanaDecodeLookupTable,
  solanaDecodeMessage,
  solanaProgramAddress,
  solanaResolveKeys,
  solanaTableIsActive,
  type SolanaLookupTable,
} from "../../checks/solana/message.ts";
import {
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_CU_PRICE_MAX,
  SOLANA_JITO_TIP_ACCOUNTS,
  SOLANA_PUMP_AMM_PROGRAM,
  SOLANA_PUMP_PROGRAM,
  SOLANA_SOL_MINT,
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  solanaEventAuthority,
  solanaVolumeAccumulator,
} from "../../checks/solana/checks.ts";
import { solanaCompileV0, type SolanaApiAccount, type SolanaApiInstruction } from "./build.ts";
import {
  SOLANA_PUMP_FEES_PROGRAM,
  solanaDecodeBondingCurve,
  solanaDecodePumpGlobal,
  solanaDecodePumpSwapConfig,
  solanaDecodePumpSwapPool,
  solanaParseAccountsAnswer,
  solanaPoolAddresses,
  type SolanaPoolAccount,
  type SolanaPoolVenue,
  type SolanaReference,
} from "./pool.ts";
import { solanaSameProvider, type SolanaRpc } from "./send.ts";

export const SOLANA_POOL_TAG_RELEASE = 2;
export const SOLANA_POOL_TAG_RELEASE_AND_BUY = 3;
export const SOLANA_POOL_PROOF_BYTES = 256;
export const SOLANA_POOL_PROOF_COMPRESSED_BYTES = 128;
/** Tag 2's data length (release.rs RELEASE_LEN). */
export const SOLANA_POOL_RELEASE_LEN = 387;
export const SOLANA_POOL_PAGE_ENTRIES = 1024;
/** The tree depth limit (src/tree.rs MAX_TREE_DEPTH). */
export const SOLANA_POOL_MAX_DEPTH = 32;
/** A release and a buy: the release's Groth16 check is ~111k CU (research S1), a pump buy ~58k, ATA and wrap a few k. */
export const SOLANA_POOL_BUY_CU = { "pump-curve": 300_000, pumpswap: 400_000 } as const;
/** Tag 3's inner instructions: at most this many (TAG3.md). */
export const SOLANA_POOL_TAG3_MAX_INNER = 8;

const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const U64_MAX = (1n << 64n) - 1n;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u64le = (n: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const be = (b: Uint8Array): bigint => b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);
const eqBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const isU64 = (x: unknown): x is bigint => typeof x === "bigint" && x >= 0n && x <= U64_MAX;
const isKey = (k: unknown): k is string => {
  if (typeof k !== "string" || k.length < 32 || k.length > 44) return false;
  try {
    return base58.decode(k).length === 32;
  } catch {
    return false;
  }
};
const acc = (key: string, signer: boolean, writable: boolean): SolanaApiAccount => ({ key, signer, writable });
const ix = (program: string, accounts: SolanaApiAccount[], data: number[] | Uint8Array): SolanaApiInstruction => ({ program, accounts, data: Uint8Array.from(data) });

// ------------------------------------------------------------------------------------------------- the release

/** One ready proof's release, the fields tag 2 carries (the wallet's ReadyProof, card wallet-pool-ladder, gives them). */
export type SolanaPoolRelease = {
  readonly proof: Uint8Array; // 256 bytes: A, B (imaginary part first), C, 32 bytes big-endian each
  readonly newCommitmentHash: Uint8Array; // 32, big-endian, below p
  readonly existingNullifierHash: Uint8Array; // 32, big-endian, below p
  readonly withdrawnValue: bigint; // lamports
  readonly stateRootIndex: number;
  readonly stateTreeDepth: number;
  readonly labelRootIndex: number;
  readonly labelTreeDepth: number;
  readonly relayFee: bigint;
  readonly relayFeeCap: bigint;
  readonly tipCap: bigint;
  readonly deadlineMs: bigint;
  readonly salt: Uint8Array; // 16
};
/** The pool W releases from: its program and its pool account (["pool"] under the program). */
export type SolanaPoolConfig = { readonly program: string; readonly pool: string };

function checkRelease(r: SolanaPoolRelease, proofBytes = SOLANA_POOL_PROOF_BYTES): void {
  if (!(r.proof instanceof Uint8Array) || r.proof.length !== proofBytes) throw new Error(`the proof must be ${proofBytes} bytes`);
  for (const [n, h] of [["newCommitmentHash", r.newCommitmentHash], ["existingNullifierHash", r.existingNullifierHash]] as const) {
    if (!(h instanceof Uint8Array) || h.length !== 32 || be(h) >= FIELD_P) throw new Error(`${n} must be a 32-byte field element`);
  }
  for (const [n, v] of [["withdrawnValue", r.withdrawnValue], ["relayFee", r.relayFee], ["relayFeeCap", r.relayFeeCap], ["tipCap", r.tipCap], ["deadlineMs", r.deadlineMs]] as const) {
    if (!isU64(v)) throw new Error(`${n} must be a u64`);
  }
  if (r.withdrawnValue === 0n) throw new Error("withdrawnValue must not be 0");
  if (r.relayFee > r.relayFeeCap) throw new Error("the relay fee is over its cap");
  for (const [n, v] of [["stateRootIndex", r.stateRootIndex], ["labelRootIndex", r.labelRootIndex]] as const) {
    if (!Number.isSafeInteger(v) || v < 0 || v > 0xffff_ffff) throw new Error(`${n} must be a u32`);
  }
  for (const [n, v] of [["stateTreeDepth", r.stateTreeDepth], ["labelTreeDepth", r.labelTreeDepth]] as const) {
    if (!Number.isSafeInteger(v) || v < 0 || v > SOLANA_POOL_MAX_DEPTH) throw new Error(`${n} must be at most ${SOLANA_POOL_MAX_DEPTH}`);
  }
  if (!(r.salt instanceof Uint8Array) || r.salt.length !== 16) throw new Error("the salt must be 16 bytes");
}

/** The release's fields after the proof, in tag 2's order (130 bytes); tag 3 carries the same run. */
function releaseFields(r: SolanaPoolRelease): number[] {
  return [
    ...r.newCommitmentHash, ...r.existingNullifierHash, ...u64le(r.withdrawnValue),
    ...u32le(r.stateRootIndex), r.stateTreeDepth, ...u32le(r.labelRootIndex), r.labelTreeDepth,
    ...u64le(r.relayFee), ...u64le(r.relayFeeCap), ...u64le(r.tipCap), ...u64le(r.deadlineMs), ...r.salt,
  ];
}

/** Tag 2's 387 data bytes. */
export function solanaEncodePoolRelease(r: SolanaPoolRelease): Uint8Array {
  checkRelease(r);
  const out = Uint8Array.from([SOLANA_POOL_TAG_RELEASE, ...r.proof, ...releaseFields(r)]);
  if (out.length !== SOLANA_POOL_RELEASE_LEN) throw new Error(`release data of ${out.length} bytes`);
  return out;
}

/** Tag 2's data read back; throws on any other length or tag. */
export function solanaDecodePoolRelease(d: Uint8Array): SolanaPoolRelease {
  if (d.length !== SOLANA_POOL_RELEASE_LEN || d[0] !== SOLANA_POOL_TAG_RELEASE) throw new Error("not a tag 2 release");
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let at = 1;
  const take = (n: number): Uint8Array => d.slice(at, (at += n));
  const proof = take(256);
  const newCommitmentHash = take(32);
  const existingNullifierHash = take(32);
  const u64 = (): bigint => { const x = v.getBigUint64(at, true); at += 8; return x; };
  const u32 = (): number => { const x = v.getUint32(at, true); at += 4; return x; };
  const u8 = (): number => d[at++] as number;
  const withdrawnValue = u64();
  const stateRootIndex = u32();
  const stateTreeDepth = u8();
  const labelRootIndex = u32();
  const labelTreeDepth = u8();
  const relayFee = u64();
  const relayFeeCap = u64();
  const tipCap = u64();
  const deadlineMs = u64();
  const salt = take(16);
  return { proof, newCommitmentHash, existingNullifierHash, withdrawnValue, stateRootIndex, stateTreeDepth, labelRootIndex, labelTreeDepth, relayFee, relayFeeCap, tipCap, deadlineMs, salt };
}

/** The page holding entry `index` of `tree` (0 state, 1 label). */
export const solanaPoolPage = (program: string, tree: 0 | 1, index: number): string =>
  solanaProgramAddress([enc("page"), Uint8Array.of(tree), Uint8Array.from(u32le(Math.floor(index / SOLANA_POOL_PAGE_ENTRIES)))], program);
/** The spent mark of a nullifier hash. */
export const solanaPoolSpentMark = (program: string, nullifierHash: Uint8Array): string => solanaProgramAddress([enc("spent"), nullifierHash], program);
/** The pool account of a program. */
export const solanaPoolAccount = (program: string): string => solanaProgramAddress([enc("pool")], program);

/** The release's 8 accounts in order; `stateSize` is the pool's state tree size now (its change note goes at that index). */
export function solanaPoolReleaseAccounts(cfg: SolanaPoolConfig, wallet: string, feePayer: string, r: SolanaPoolRelease, stateSize: number): SolanaApiAccount[] {
  if (!Number.isSafeInteger(stateSize) || stateSize < 0 || stateSize > 0xffff_ffff) throw new Error("the state size must be a u32");
  return [
    acc(cfg.pool, false, true),
    acc(wallet, true, true),
    acc(feePayer, true, true),
    acc(solanaPoolSpentMark(cfg.program, r.existingNullifierHash), false, true),
    acc(solanaPoolPage(cfg.program, 0, r.stateRootIndex), false, false),
    acc(solanaPoolPage(cfg.program, 1, r.labelRootIndex), false, false),
    acc(solanaPoolPage(cfg.program, 0, stateSize), false, true),
    acc(SOLANA_SYSTEM_PROGRAM, false, false),
  ];
}

// ------------------------------------------------------------------------------------------------- the venue

/** What the buy needs from the venue's accounts, as both providers read them (readSolanaPoolBuyVenue). */
export type SolanaPoolBuyVenue =
  | {
      readonly kind: "pump-curve"; readonly mint: string; readonly tokenProgram: string; readonly tokenAccountSize: number; readonly curve: string; readonly creator: string; readonly feeRecipient: string;
      readonly cashback: boolean; // the curve's is_cashback_coin (byte 82): a cashback coin's sell also names W's volume accumulator
      readonly buybackFeeRecipients: readonly string[]; readonly buybackFeeRecipient: string;
    }
  | {
      readonly kind: "pumpswap"; readonly mint: string; readonly tokenProgram: string; readonly tokenAccountSize: number; readonly pool: string; readonly baseVault: string;
      readonly quoteVault: string; readonly coinCreator: string; readonly cashback: boolean; readonly protocolFeeRecipient: string;
      readonly buybackFeeRecipients: readonly string[]; readonly buybackFeeRecipient: string;
    };

const PUMP_GLOBAL = solanaProgramAddress([enc("global")], SOLANA_PUMP_PROGRAM);
const PUMP_FEE_CONFIG = solanaProgramAddress([enc("fee_config"), base58.decode(SOLANA_PUMP_PROGRAM)], SOLANA_PUMP_FEES_PROGRAM);
const PUMP_GLOBAL_VOLUME = solanaProgramAddress([enc("global_volume_accumulator")], SOLANA_PUMP_PROGRAM);
const AMM_GLOBAL_CONFIG = solanaProgramAddress([enc("global_config")], SOLANA_PUMP_AMM_PROGRAM);
const AMM_FEE_CONFIG = solanaProgramAddress([enc("fee_config"), base58.decode(SOLANA_PUMP_AMM_PROGRAM)], SOLANA_PUMP_FEES_PROGRAM);
const AMM_GLOBAL_VOLUME = solanaProgramAddress([enc("global_volume_accumulator")], SOLANA_PUMP_AMM_PROGRAM);
const PUMP_BUY_EXACT_SOL_IN = [56, 252, 116, 8, 158, 223, 205, 95];
const AMM_BUY_EXACT_QUOTE_IN = [198, 46, 21, 82, 180, 217, 232, 112];
/** pump Global: fee_recipient at 41 (after the discriminator, initialized and authority); buyback_fee_recipients, 8
 * keys at 741, then buyback_basis_points (read on mainnet-beta and publicnode 2026-11-02 21:00Z: the same 8 keys
 * @pump-fun/pump-sdk 4.3.1 bondingCurve.ts CURRENT_FEE_RECIPIENTS_FOR_BUYBACK lists, 5,000 bps after them). */
const PUMP_GLOBAL_FEE_RECIPIENT = 41;
const PUMP_GLOBAL_BUYBACK_RECIPIENTS = 741;
/** PumpSwap GlobalConfig: protocol_fee_recipients, 8 keys at 57 (pool.ts's layout note); buyback_fee_recipients, 8
 * keys at 643, before buyback_basis_points at 899 (read on both providers 2026-11-02 21:02Z). */
const AMM_PROTOCOL_FEE_RECIPIENTS = 57;
const AMM_GLOBAL_BUYBACK_RECIPIENTS = 643;
/** PumpSwap Pool: is_cashback_coin at 244 (pool.ts's layout note). */
const AMM_POOL_CASHBACK = 244;
const DEFAULT_KEY = SOLANA_SYSTEM_PROGRAM;

/** The pool's pages up to the one holding entry `size` of each tree: shared by every release, so they sit in our table
 * (which gains a page when one opens, once every 1,024 entries). */
export const solanaPoolPages = (program: string, stateSize: number, labelSize: number): string[] => [
  ...Array.from({ length: Math.floor(stateSize / SOLANA_POOL_PAGE_ENTRIES) + 1 }, (_, i) => solanaPoolPage(program, 0, i * SOLANA_POOL_PAGE_ENTRIES)),
  ...Array.from({ length: Math.floor(labelSize / SOLANA_POOL_PAGE_ENTRIES) + 1 }, (_, i) => solanaPoolPage(program, 1, i * SOLANA_POOL_PAGE_ENTRIES)),
];

/** The program-wide accounts a pool buy uses: what our lookup table holds (the pool and its pages, the venue's shared
 * accounts and programs, the token programs, wSOL and the Jito tip accounts). */
export function solanaPoolBuyTableAccounts(cfg: SolanaPoolConfig, venue: SolanaPoolBuyVenue, pages: readonly string[] = []): string[] {
  const common = [cfg.pool, ...pages, SOLANA_SYSTEM_PROGRAM, SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_ATA_PROGRAM, SOLANA_SOL_MINT, SOLANA_PUMP_FEES_PROGRAM, ...SOLANA_JITO_TIP_ACCOUNTS];
  return venue.kind === "pump-curve"
    ? [...common, SOLANA_PUMP_PROGRAM, PUMP_GLOBAL, venue.feeRecipient, solanaEventAuthority(SOLANA_PUMP_PROGRAM), PUMP_GLOBAL_VOLUME, PUMP_FEE_CONFIG, ...venue.buybackFeeRecipients]
    : [
        ...common, SOLANA_PUMP_AMM_PROGRAM, AMM_GLOBAL_CONFIG, venue.protocolFeeRecipient, solanaAta(venue.protocolFeeRecipient, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM),
        solanaEventAuthority(SOLANA_PUMP_AMM_PROGRAM), AMM_GLOBAL_VOLUME, AMM_FEE_CONFIG,
        ...venue.buybackFeeRecipients.flatMap((r) => [r, solanaAta(r, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM)]),
      ];
}

/** The buy itself, W the venue's `user`: spend exactly `spend` lamports for at least `minOut` of the token. */
export function solanaPoolVenueBuy(venue: SolanaPoolBuyVenue, wallet: string, spend: bigint, minOut: bigint): SolanaApiInstruction {
  if (!isU64(spend) || spend === 0n || !isU64(minOut)) throw new Error("spend and minOut must be u64s, spend above 0");
  const tp = venue.tokenProgram;
  if (tp !== SOLANA_TOKEN_PROGRAM && tp !== SOLANA_TOKEN_2022_PROGRAM) throw new Error("the token program must be Token or Token-2022");
  if (venue.kind === "pump-curve") {
    const creatorVault = solanaProgramAddress([enc("creator-vault"), base58.decode(venue.creator)], SOLANA_PUMP_PROGRAM);
    return ix(SOLANA_PUMP_PROGRAM, [
      acc(PUMP_GLOBAL, false, false),
      acc(venue.feeRecipient, false, true),
      acc(venue.mint, false, false),
      acc(venue.curve, false, true),
      acc(solanaAta(venue.curve, venue.mint, tp), false, true),
      acc(solanaAta(wallet, venue.mint, tp), false, true),
      acc(wallet, true, true),
      acc(SOLANA_SYSTEM_PROGRAM, false, false),
      acc(tp, false, false),
      acc(creatorVault, false, true),
      acc(solanaEventAuthority(SOLANA_PUMP_PROGRAM), false, false),
      acc(SOLANA_PUMP_PROGRAM, false, false),
      acc(PUMP_GLOBAL_VOLUME, false, false),
      acc(solanaVolumeAccumulator(wallet, SOLANA_PUMP_PROGRAM), false, true),
      acc(PUMP_FEE_CONFIG, false, false),
      acc(SOLANA_PUMP_FEES_PROGRAM, false, false),
      // remaining accounts, as @pump-fun/pump-sdk 4.3.1 sdk.ts getBuyInstructionRaw appends them (the program refuses a buy
      // without the buyback recipient: BuybackFeeRecipientMissing, 6062, in LiteSVM on mainnet's code 2026-11-02)
      acc(solanaProgramAddress([enc("bonding-curve-v2"), base58.decode(venue.mint)], SOLANA_PUMP_PROGRAM), false, false),
      acc(venue.buybackFeeRecipient, false, true),
    ], [...PUMP_BUY_EXACT_SOL_IN, ...u64le(spend), ...u64le(minOut), 0, 0]);
  }
  const creatorVaultAuth = solanaProgramAddress([enc("creator_vault"), base58.decode(venue.coinCreator)], SOLANA_PUMP_AMM_PROGRAM);
  return ix(SOLANA_PUMP_AMM_PROGRAM, [
    acc(venue.pool, false, true),
    acc(wallet, true, true),
    acc(AMM_GLOBAL_CONFIG, false, false),
    acc(venue.mint, false, false),
    acc(SOLANA_SOL_MINT, false, false),
    acc(solanaAta(wallet, venue.mint, tp), false, true),
    acc(solanaAta(wallet, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), false, true),
    acc(venue.baseVault, false, true),
    acc(venue.quoteVault, false, true),
    acc(venue.protocolFeeRecipient, false, false),
    acc(solanaAta(venue.protocolFeeRecipient, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), false, true),
    acc(tp, false, false),
    acc(SOLANA_TOKEN_PROGRAM, false, false),
    acc(SOLANA_SYSTEM_PROGRAM, false, false),
    acc(SOLANA_ATA_PROGRAM, false, false),
    acc(solanaEventAuthority(SOLANA_PUMP_AMM_PROGRAM), false, false),
    acc(SOLANA_PUMP_AMM_PROGRAM, false, false),
    acc(solanaAta(creatorVaultAuth, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), false, true),
    acc(creatorVaultAuth, false, false),
    acc(AMM_GLOBAL_VOLUME, false, false),
    acc(solanaVolumeAccumulator(wallet, SOLANA_PUMP_AMM_PROGRAM), false, true),
    acc(AMM_FEE_CONFIG, false, false),
    acc(SOLANA_PUMP_FEES_PROGRAM, false, false),
    // remaining accounts, as @pump-fun/pump-swap-sdk 2.2.0 offlinePumpAmm.ts buyInstructionsNoPool appends them
    ...(venue.cashback ? [acc(solanaAta(solanaVolumeAccumulator(wallet, SOLANA_PUMP_AMM_PROGRAM), SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), false, true)] : []),
    ...(venue.coinCreator !== DEFAULT_KEY ? [acc(solanaProgramAddress([enc("pool-v2"), base58.decode(venue.mint)], SOLANA_PUMP_AMM_PROGRAM), false, false)] : []),
    acc(venue.buybackFeeRecipient, false, false),
    acc(solanaAta(venue.buybackFeeRecipient, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), false, true),
  ], [...AMM_BUY_EXACT_QUOTE_IN, ...u64le(spend), ...u64le(minOut), 0]);
}

const createIdempotent = (wallet: string, mint: string, tp: string): SolanaApiInstruction =>
  ix(SOLANA_ATA_PROGRAM, [acc(wallet, true, true), acc(solanaAta(wallet, mint, tp), false, true), acc(wallet, false, false), acc(mint, false, false), acc(SOLANA_SYSTEM_PROGRAM, false, false), acc(tp, false, false)], [1]);
const transfer = (from: string, to: string, lamports: bigint): SolanaApiInstruction =>
  ix(SOLANA_SYSTEM_PROGRAM, [acc(from, true, true), acc(to, false, true)], [...u32le(2), ...u64le(lamports)]);

/** What W does with its chunk, in order: its token account, the wrap (PumpSwap), the buy, the unwrap (PumpSwap). */
export function solanaPoolBuySteps(venue: SolanaPoolBuyVenue, wallet: string, spend: bigint, minOut: bigint): SolanaApiInstruction[] {
  const buy = solanaPoolVenueBuy(venue, wallet, spend, minOut);
  const base = createIdempotent(wallet, venue.mint, venue.tokenProgram);
  if (venue.kind === "pump-curve") return [base, buy];
  const wsol = solanaAta(wallet, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);
  return [
    createIdempotent(wallet, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM),
    transfer(wallet, wsol, spend),
    ix(SOLANA_TOKEN_PROGRAM, [acc(wsol, false, true)], [17]), // SyncNative
    base,
    buy,
    ix(SOLANA_TOKEN_PROGRAM, [acc(wsol, false, true), acc(wallet, false, true), acc(wallet, true, false)], [9]), // CloseAccount
  ];
}

// ------------------------------------------------------------------------------------------------- the proof

const FIELD_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const be32 = (x: bigint): number[] => Array.from({ length: 32 }, (_, i) => Number((x >> BigInt(8 * (31 - i))) & 0xffn));
const negQ = (y: bigint): bigint => (y === 0n ? 0n : FIELD_Q - y);

/**
 * The proof in the alt_bn128 compressed form tag 3's flag bit 0 names, the inverse of solana-bn254 3.2.1
 * `alt_bn128_g1_decompress_be` / `alt_bn128_g2_decompress_be` (ark-serialize's SW compression, byte order reversed):
 * A and C as x (32, big-endian), B as x.c1 ‖ x.c0 (64); bit 7 of the first byte set when y > -y (for B, c1 is compared
 * first, then c0, as ark-ff orders a quadratic extension). 256 bytes in, 128 out.
 */
export function solanaCompressPoolProof(proof: Uint8Array): Uint8Array {
  if (!(proof instanceof Uint8Array) || proof.length !== SOLANA_POOL_PROOF_BYTES) throw new Error(`the proof must be ${SOLANA_POOL_PROOF_BYTES} bytes`);
  const at = (o: number): bigint => {
    const v = be(proof.subarray(o, o + 32));
    if (v >= FIELD_Q) throw new Error("a proof coordinate is not below q");
    return v;
  };
  const g1 = (o: number): number[] => {
    const [x, y] = [at(o), at(o + 32)];
    if (x === 0n && y === 0n) throw new Error("a proof point is the point at infinity");
    const out = be32(x);
    if (y > negQ(y)) out[0]! |= 0x80;
    return out;
  };
  const [x1, x0, y1, y0] = [at(64), at(96), at(128), at(160)];
  if (x1 === 0n && x0 === 0n && y1 === 0n && y0 === 0n) throw new Error("a proof point is the point at infinity");
  const b = [...be32(x1), ...be32(x0)];
  if (y1 !== negQ(y1) ? y1 > negQ(y1) : y0 > negQ(y0)) b[0]! |= 0x80;
  return Uint8Array.from([...g1(0), ...b, ...g1(192)]);
}

// ------------------------------------------------------------------------------------------------- rent

/** The Rent sysvar, as the device reads it on two providers: lamports per byte and the exemption factor (1 since
 * SIMD-0194; 2 before). Read 2026-11-02 22:19Z on mainnet-beta and publicnode: 5,080 lamports a byte, factor 1.0. */
export type SolanaRent = { readonly lamportsPerByte: bigint; readonly factor: 1n | 2n };
export const SOLANA_RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
const SOLANA_SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
/** solana-rent 4.4.0 ACCOUNT_STORAGE_OVERHEAD. */
const RENT_OVERHEAD = 128n;

/** The Rent sysvar's 17 bytes: lamports_per_byte u64, exemption_threshold f64, burn_percent u8. Only a factor of
 * exactly 1.0 or 2.0 is taken (the two solana-rent computes without floats); anything else is refused. */
export function solanaRentOf(a: { owner: string; data: Uint8Array } | null): SolanaRent {
  if (!a || a.owner !== SOLANA_SYSVAR_OWNER || a.data.length !== 17) throw new Error("not the Rent sysvar");
  const v = new DataView(a.data.buffer, a.data.byteOffset, 17);
  const lamportsPerByte = v.getBigUint64(0, true);
  const t = v.getFloat64(8, true);
  if (lamportsPerByte === 0n || lamportsPerByte > 1_000_000n) throw new Error("rent per byte out of range");
  if (t !== 1 && t !== 2) throw new Error(`a rent exemption factor of ${t}`);
  return { lamportsPerByte, factor: t === 1 ? 1n : 2n };
}
/** solana-rent's minimum_balance(size). */
export const solanaRentMin = (rent: SolanaRent, size: number): bigint => (RENT_OVERHEAD + BigInt(size)) * rent.lamportsPerByte * rent.factor;

/** The Rent sysvar read on both providers at `confirmed`; throws unless both give the same rate. */
export async function readSolanaRent(providers: readonly [SolanaRpc, SolanaRpc]): Promise<SolanaRent> {
  if (!Array.isArray(providers) || providers.length !== 2 || solanaSameProvider(providers[0], providers[1])) throw new Error("two different providers are needed");
  const rents = await Promise.all(providers.map(async (rpc) => {
    const r = await withTimeout(Promise.resolve().then(() => rpc("getAccountInfo", [SOLANA_RENT_SYSVAR, { encoding: "base64", commitment: "confirmed" }])), READ_TIMEOUT_MS);
    const value = (r as { value?: { owner?: unknown; data?: unknown } } | null)?.value;
    const d = value?.data;
    if (!value || typeof value.owner !== "string" || !Array.isArray(d) || typeof d[0] !== "string" || d[1] !== "base64") throw new Error("a provider's answer is not an account read");
    return solanaRentOf({ owner: value.owner, data: base64.decode(d[0]) });
  }));
  if (rents[0]!.lamportsPerByte !== rents[1]!.lamportsPerByte || rents[0]!.factor !== rents[1]!.factor) throw new Error("the providers disagree on rent");
  return rents[0]!;
}

// ------------------------------------------------------------------------------------------------- the sell

const SELL = [51, 230, 133, 164, 1, 127, 131, 173]; // Anchor "global:sell", pump's and PumpSwap's

/**
 * The least a sell of `amount` tokens may give, in lamports: E for exactly `amount` from the venue's reserves read on
 * two providers (readSolanaReference, side "sell"), less the user's slippage. Never 1 lamport: a sell that would take
 * anything is the sandwich a min out exists to stop. Throws without a reference for this venue and this amount, read
 * at most SOLANA_POOL_QUOTE_MAX_AGE_SLOTS before the device's own `slot`, and a floor above 0.
 */
export function solanaPoolSellMinOut(venue: SolanaPoolBuyVenue, amount: bigint, reference: { readonly amount: bigint; readonly ref: SolanaReference | null; readonly slippageBps: number }, slot: number): bigint {
  const { ref, slippageBps } = reference;
  if (!isU64(amount) || amount === 0n || reference.amount !== amount) throw new Error("the reference is not for the amount sold");
  if (quoteAgeProblem(ref, slot)) throw new Error(quoteAgeProblem(ref, slot)!);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error("slippage out of range");
  const addr = venue.kind === "pump-curve" ? venue.curve : venue.pool;
  const pool = ref?.pools.find((x) => x.address === addr && x.venue === venue.kind);
  if (!pool) throw new Error(`no reference read for ${addr} on two providers`);
  const floor = (pool.expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (floor === 0n) throw new Error("the sell's floor is 0");
  return floor;
}

/**
 * W's sell of `amount` tokens for at least `minOut` lamports (from solanaPoolSellMinOut). pump: `sell` with the IDL's
 * 14 accounts, then the remaining ones @pump-fun/pump-sdk 4.3.1 getSellInstructionRaw passes (W's volume accumulator
 * for a cashback coin only, as the curve's own is_cashback_coin byte says, bonding-curve-v2, the buyback recipient
 * writable). PumpSwap: W's wrapped-SOL account made,
 * `sell` (the buy's first 19 accounts, its fee config and fee program; remaining: for a cashback pool the volume
 * accumulator's wSOL account and the accumulator, pool-v2 when the coin has a creator, the buyback recipient and its
 * wSOL account), then the wrapped-SOL account closed so W ends with plain SOL (pump-swap-sdk 2.2.0
 * sellInstructionsNoPool). The same steps contracts/pool-solana/fixtures/venues/dump.mjs ran on mainnet's code.
 */
export function solanaPoolSellSteps(venue: SolanaPoolBuyVenue, wallet: string, amount: bigint, minOut: bigint): SolanaApiInstruction[] {
  if (!isU64(amount) || amount === 0n || !isU64(minOut) || minOut === 0n) throw new Error("amount and minOut must be u64s above 0");
  const data = [...SELL, ...u64le(amount), ...u64le(minOut)];
  const tp = venue.tokenProgram;
  if (venue.kind === "pump-curve") {
    return [ix(SOLANA_PUMP_PROGRAM, [
      acc(PUMP_GLOBAL, false, false),
      acc(venue.feeRecipient, false, true),
      acc(venue.mint, false, false),
      acc(venue.curve, false, true),
      acc(solanaAta(venue.curve, venue.mint, tp), false, true),
      acc(solanaAta(wallet, venue.mint, tp), false, true),
      acc(wallet, true, true),
      acc(SOLANA_SYSTEM_PROGRAM, false, false),
      acc(solanaProgramAddress([enc("creator-vault"), base58.decode(venue.creator)], SOLANA_PUMP_PROGRAM), false, true),
      acc(tp, false, false),
      acc(solanaEventAuthority(SOLANA_PUMP_PROGRAM), false, false),
      acc(SOLANA_PUMP_PROGRAM, false, false),
      acc(PUMP_FEE_CONFIG, false, false),
      acc(SOLANA_PUMP_FEES_PROGRAM, false, false),
      ...(venue.cashback ? [acc(solanaVolumeAccumulator(wallet, SOLANA_PUMP_PROGRAM), false, true)] : []),
      acc(solanaProgramAddress([enc("bonding-curve-v2"), base58.decode(venue.mint)], SOLANA_PUMP_PROGRAM), false, false),
      acc(venue.buybackFeeRecipient, false, true),
    ], data)];
  }
  const buy = solanaPoolVenueBuy(venue, wallet, 1n, 1n);
  const rest = buy.accounts.slice(23);
  const vol = solanaVolumeAccumulator(wallet, SOLANA_PUMP_AMM_PROGRAM);
  const remaining = venue.cashback ? [acc(solanaAta(vol, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), false, true), acc(vol, false, true), ...rest.slice(1)] : rest;
  const wsol = solanaAta(wallet, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);
  return [
    createIdempotent(wallet, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM),
    ix(SOLANA_PUMP_AMM_PROGRAM, [...buy.accounts.slice(0, 19), ...buy.accounts.slice(21, 23), ...remaining], data),
    ix(SOLANA_TOKEN_PROGRAM, [acc(wsol, false, true), acc(wallet, false, true), acc(wallet, true, false)], [9]), // CloseAccount
  ];
}

// ------------------------------------------------------------------------------------------------- the build

export type SolanaPoolBuyRequest = {
  readonly wallet: string; // W: signs, receives the chunk, is the venue's user
  readonly feePayer: string; // pays the transaction fee and the release's rent, takes relay_fee; signs
  readonly token: string;
  readonly spend: bigint; // lamports into the venue
  readonly minOut: bigint; // token base units, the least the buy may give
  readonly tip: bigint; // lamports the pool pays a Jito tip account out of the chunk; 0 for none; at most the proof's tip cap
  readonly cuPrice: bigint; // micro-lamports per CU
};
export type SolanaPoolBuyChain = {
  readonly blockhash: string; // the device's own read
  readonly lastValidBlockHeight: number;
  readonly table: { readonly address: string; readonly table: SolanaLookupTable }; // our lookup table, as the device read it
  readonly stateSize: number; // the pool's state tree size now, read by the device
  readonly rent: SolanaRent; // the Rent sysvar, read on two providers
};
export type SolanaPoolBuyOptions = { readonly pick?: (n: number) => number };
export type SolanaPoolBuyBuilt = {
  readonly wire: Uint8Array; // two zeroed signature slots (fee payer, W), then the message
  readonly message: Uint8Array;
  readonly size: number;
  readonly lastValidBlockHeight: number;
  readonly cuLimit: number;
  readonly instructions: readonly SolanaApiInstruction[];
};

const randomIndex = (n: number): number => {
  const u = new Uint32Array(1);
  globalThis.crypto.getRandomValues(u);
  return (u[0] as number) % n;
};

/** Account sizes W pays rent for during a buy: a legacy token account, and each venue's user volume accumulator, which
 * the venue's buy makes for a W that has none: 137 bytes on both, as mainnet's pump and PumpSwap code made them in
 * LiteSVM for a fresh W, 2026-11-02 22:50Z (W ended with exactly what solanaPoolBuyFunds says it keeps). */
const TOKEN_ACCOUNT_SIZE = 165;
export const SOLANA_POOL_VOLUME_ACCOUNT_SIZE = { "pump-curve": 137, pumpswap: 137 } as const;

/** A per-venue constant of `kind`: an own key only, so a kind outside the two venues names none, even when a polluted
 *  page's Object.prototype has one (the review of evm-pool-sell-tx 8d8675d). */
function perVenue<T>(table: Readonly<Record<SolanaPoolVenue, T>>, kind: unknown): T {
  if (typeof kind !== "string" || !Object.hasOwn(table, kind)) throw new Error(`no such venue ${typeof kind === "string" ? kind.slice(0, 40) : typeof kind}`);
  return table[kind as SolanaPoolVenue];
}

/**
 * What W's chunk must cover, in lamports, on today's rent (every account counted as made new, which only raises W's
 * balance when one already exists):
 * - the spend, W's token account (its size from the mint: Token-2022 adds its extensions), the venue's volume account;
 * - PumpSwap: W's wrapped-SOL account while the spend sits in it (its rent comes back when it is closed);
 * - W after the buy holds 0 or at least rent(0), the runtime's floor for a system account.
 * `peak` is what W pays out at its lowest point, `left` what W holds after.
 */
export function solanaPoolBuyFunds(release: SolanaPoolRelease, venue: SolanaPoolBuyVenue, req: Pick<SolanaPoolBuyRequest, "spend" | "tip">, rent: SolanaRent): { chunk: bigint; peak: bigint; left: bigint; problem: string | null } {
  const chunk = release.withdrawnValue - release.relayFee - req.tip;
  const kept = req.spend + solanaRentMin(rent, venue.tokenAccountSize) + solanaRentMin(rent, perVenue(SOLANA_POOL_VOLUME_ACCOUNT_SIZE, venue.kind)) +
    (venue.kind === "pumpswap" && venue.cashback ? solanaRentMin(rent, TOKEN_ACCOUNT_SIZE) : 0n);
  const peak = kept + (venue.kind === "pumpswap" ? solanaRentMin(rent, TOKEN_ACCOUNT_SIZE) : 0n);
  const left = chunk - kept;
  const floor = solanaRentMin(rent, 0);
  const problem =
    chunk < 0n ? "the relay fee and the tip are more than the release"
    : chunk < peak ? `the chunk ${chunk} does not cover the spend and W's new accounts (${peak})`
    : left > 0n && left < floor ? `W would keep ${left} lamports, under the ${floor} a wallet must hold or 0`
    : null;
  return { chunk, peak, left, problem };
}

/** M352/M353/M355: the fee payer's cost of one release, from the device's own rent read: the spent mark, which records
 * withdrawnValue in 8 bytes (rent(8)), the change note's 72-byte page entry and two signatures (5,000 each). 1,066,640
 * lamports at 5,080 a byte. The one definition of the Solana fee rules (M356 (6)): the wallet and the helper import
 * this cost, the fee, the priority budget and the send margin from here. */
export const SOLANA_POOL_SPENT_MARK_LEN = 8;
export const solanaPoolReleaseCost = (rent: SolanaRent): bigint =>
  solanaRentMin(rent, SOLANA_POOL_SPENT_MARK_LEN) + 72n * rent.lamportsPerByte * rent.factor + 10_000n;
/** The epoch relay fee's step, and the headroom over the cost (M353): two steps. */
export const SOLANA_POOL_FEE_STEP = 100_000n;
export const SOLANA_POOL_FEE_HEADROOM = 2n * SOLANA_POOL_FEE_STEP;
/** The epoch relay fee: the cost rounded up to the step, plus two steps. 1,300,000 at 5,080 a byte. */
export const solanaPoolFee = (rent: SolanaRent): bigint => {
  const cost = solanaPoolReleaseCost(rent);
  return ((cost + SOLANA_POOL_FEE_STEP - 1n) / SOLANA_POOL_FEE_STEP) * SOLANA_POOL_FEE_STEP + SOLANA_POOL_FEE_HEADROOM;
};
/** M356 (5): the share of a page's opening each entry carries, so a release that opens a page stays paid for: the
 * page's rent beyond its entries (its 16-byte header and the account overhead) over its 1,024 entries, rounded up.
 * ceil(731,520 / 1,024) = 715 lamports at 5,080 a byte. */
export const SOLANA_POOL_PAGE_HEADER_LEN = 16;
export const solanaPoolPageReserve = (rent: SolanaRent): bigint => {
  const open = solanaRentMin(rent, SOLANA_POOL_PAGE_HEADER_LEN);
  const n = BigInt(SOLANA_POOL_PAGE_ENTRIES);
  return (open + n - 1n) / n;
};
/** M356 (5): what a release may spend on priority (CU limit x price / 1e6, lamports): the relay fee less the cost and
 * the page reserve. 232,645 at 5,080 a byte and the epoch fee 1,300,000. */
export const solanaPoolPriorityBudget = (rent: SolanaRent, relayFee: bigint = solanaPoolFee(rent)): bigint =>
  relayFee - solanaPoolReleaseCost(rent) - solanaPoolPageReserve(rent);
/** M356 (1): the Solana send margin. A deadline under now + 90 s is refused by the device and the helper; 90 s is
 * longer than a blockhash lives (150 blocks), so a signed send cannot outlive its deadline. */
export const SOLANA_POOL_SEND_MARGIN_MS = 90_000n;
/**
 * The priority fee W sets (CU limit x price, in micro-lamports) must fit in the priority budget of the release's relay
 * fee, or the helper refuses the transaction W already signed (apps/helper/src/pool/solana.ts fee_below_cost:
 * relay_fee >= cost + page reserve + ceil(limit x price / 1e6)).
 */
export function solanaPoolPriorityProblem(release: SolanaPoolRelease, venue: SolanaPoolBuyVenue, req: Pick<SolanaPoolBuyRequest, "cuPrice">, rent: SolanaRent): string | null {
  const room = solanaPoolPriorityBudget(rent, release.relayFee);
  const priority = BigInt(perVenue(SOLANA_POOL_BUY_CU, venue.kind)) * req.cuPrice;
  return room < 0n || priority > room * 1_000_000n ? `the priority fee (${perVenue(SOLANA_POOL_BUY_CU, venue.kind)} CU at ${req.cuPrice} micro-lamports) is more than the relay fee ${release.relayFee} leaves after the release's cost ${solanaPoolReleaseCost(rent)} and the page reserve ${solanaPoolPageReserve(rent)}` : null;
}

function checkRequest(cfg: SolanaPoolConfig, release: SolanaPoolRelease, venue: SolanaPoolBuyVenue, req: SolanaPoolBuyRequest, rent: SolanaRent): void {
  for (const k of [cfg.program, cfg.pool, req.wallet, req.feePayer, req.token]) if (!isKey(k)) throw new Error("program, pool, wallet, fee payer and token must be addresses");
  if (cfg.pool !== solanaPoolAccount(cfg.program)) throw new Error("the pool is not the program's pool account");
  if (req.wallet === req.feePayer || req.wallet === cfg.pool || req.feePayer === cfg.pool) throw new Error("W, the fee payer and the pool must differ");
  if (venue.mint !== req.token) throw new Error("the venue is not the token's");
  if (!isU64(req.tip) || req.tip > release.tipCap) throw new Error("the tip is over the proof's tip cap");
  if (!isU64(req.cuPrice) || req.cuPrice > SOLANA_CU_PRICE_MAX) throw new Error("the CU price is over its cap");
  const f = solanaPoolBuyFunds(release, venue, req, rent);
  if (f.problem) throw new Error(f.problem);
  const fee = solanaPoolPriorityProblem(release, venue, req, rent);
  if (fee) throw new Error(fee);
}

/**
 * Tag 3's data (contracts/pool-solana/TAG3.md, src/buy.rs): tag 3 ‖ flags u8 (bit 0: compressed proof) ‖ proof (256 or
 * 128) ‖ the release's 130 field bytes as tag 2 ‖ tip u64 ‖ inner count u8 ‖ per inner instruction: program u8 (index
 * into this instruction's accounts) ‖ n u8 ‖ n account indexes u8 ‖ data length u16 LE ‖ data.
 */
export function solanaEncodePoolTag3(release: SolanaPoolRelease, compressed: boolean, tip: bigint, inner: readonly { program: number; accounts: readonly number[]; data: Uint8Array }[]): Uint8Array {
  checkRelease(release, compressed ? SOLANA_POOL_PROOF_COMPRESSED_BYTES : SOLANA_POOL_PROOF_BYTES);
  if (!isU64(tip) || tip > release.tipCap) throw new Error("the tip is over the proof's tip cap");
  if (inner.length === 0 || inner.length > SOLANA_POOL_TAG3_MAX_INNER) throw new Error(`1 to ${SOLANA_POOL_TAG3_MAX_INNER} inner instructions`);
  const out: number[] = [SOLANA_POOL_TAG_RELEASE_AND_BUY, compressed ? 1 : 0, ...release.proof, ...releaseFields(release), ...u64le(tip), inner.length];
  for (const x of inner) {
    if (x.accounts.length > 255 || x.data.length > 0xffff) throw new Error("an inner instruction is too large");
    out.push(x.program, x.accounts.length, ...x.accounts, x.data.length & 0xff, x.data.length >> 8, ...x.data);
  }
  return Uint8Array.from(out);
}

/** Tag 3's head before the inner instructions: tag, flags, the compressed proof, the 130 field bytes, the tip. */
const TAG3_HEAD = 2 + SOLANA_POOL_PROOF_COMPRESSED_BYTES + 130 + 8;

/**
 * The transaction's three instructions: CU limit, CU price, and tag 3 into the pool with the compressed proof. Tag 3's
 * accounts are the release's eight, the tip account when the tip is above 0, then every account the steps name, each
 * once with its flags merged; the steps (solanaPoolBuySteps) are its inner instructions.
 */
export function solanaPoolBuyInstructions(cfg: SolanaPoolConfig, release: SolanaPoolRelease, venue: SolanaPoolBuyVenue, req: SolanaPoolBuyRequest, stateSize: number, rent: SolanaRent, tipAccount: string | null): SolanaApiInstruction[] {
  checkRequest(cfg, release, venue, req, rent);
  if ((req.tip > 0n) !== (tipAccount !== null)) throw new Error("a tip account goes with a tip above 0, and only then");
  if (tipAccount !== null && !SOLANA_JITO_TIP_ACCOUNTS.includes(tipAccount)) throw new Error("the tip account is not a Jito tip account");
  const steps = solanaPoolBuySteps(venue, req.wallet, req.spend, req.minOut);
  const outer: SolanaApiAccount[] = [...solanaPoolReleaseAccounts(cfg, req.wallet, req.feePayer, release, stateSize), ...(tipAccount ? [acc(tipAccount, false, true)] : [])];
  const indexOf = (a: SolanaApiAccount): number => {
    let i = outer.findIndex((o) => o.key === a.key);
    if (i < 0) i = outer.push({ ...a }) - 1;
    else outer[i] = { key: a.key, signer: outer[i]!.signer || a.signer, writable: outer[i]!.writable || a.writable };
    return i;
  };
  const inner = steps.map((s) => ({ program: indexOf(acc(s.program, false, false)), accounts: s.accounts.map(indexOf), data: s.data }));
  // the pool refuses an inner account that is one of its own (the pool, its spent mark, the pages; by key or owner) or
  // a signer other than W, and the fee payer's signature must never reach a venue: never build one. Checked on every
  // account each step names, so one that lands in tag 3's head (the pool at 0, the fee payer at 2) is caught too.
  const barred = new Set([cfg.pool, cfg.program, req.feePayer, ...[3, 4, 5, 6].map((i) => outer[i]!.key)]);
  if (steps.some((x) => barred.has(x.program) || x.accounts.some((a) => barred.has(a.key)))) throw new Error("a step names the pool, its accounts or the fee payer");
  const data = solanaEncodePoolTag3({ ...release, proof: solanaCompressPoolProof(release.proof) }, true, req.tip, inner);
  return [
    ix(SOLANA_COMPUTE_BUDGET_PROGRAM, [], [2, ...u32le(perVenue(SOLANA_POOL_BUY_CU, venue.kind))]),
    ix(SOLANA_COMPUTE_BUDGET_PROGRAM, [], [3, ...u64le(req.cuPrice)]),
    ix(cfg.program, outer, data),
  ];
}

/** The unsigned v0 transaction the fee payer and W sign: one tag 3 release-and-buy. Refuses over 1,232 bytes. */
export function buildSolanaPoolBuy(cfg: SolanaPoolConfig, release: SolanaPoolRelease, venue: SolanaPoolBuyVenue, req: SolanaPoolBuyRequest, chain: SolanaPoolBuyChain, opts: SolanaPoolBuyOptions = {}): SolanaPoolBuyBuilt {
  if (!isKey(chain.blockhash) || !Number.isSafeInteger(chain.lastValidBlockHeight) || chain.lastValidBlockHeight <= 0) throw new Error("the blockhash must be the device's own read");
  if (!solanaTableIsActive(chain.table.table)) throw new Error("our lookup table is deactivated");
  const tipAccount = req.tip > 0n ? (SOLANA_JITO_TIP_ACCOUNTS[(opts.pick ?? randomIndex)(SOLANA_JITO_TIP_ACCOUNTS.length)] as string) : null;
  const instructions = solanaPoolBuyInstructions(cfg, release, venue, req, chain.stateSize, chain.rent, tipAccount);
  const { message } = solanaCompileV0(req.feePayer, instructions, chain.blockhash, [chain.table], [req.feePayer, req.wallet]);
  const wire = new Uint8Array(1 + 128 + message.length);
  wire[0] = 2;
  wire.set(message, 129);
  if (wire.length > SOLANA_MAX_TX_BYTES) throw new Error(`too_large: ${wire.length} bytes > ${SOLANA_MAX_TX_BYTES}`);
  return { wire, message, size: wire.length, lastValidBlockHeight: chain.lastValidBlockHeight, cuLimit: perVenue(SOLANA_POOL_BUY_CU, venue.kind), instructions };
}

// ------------------------------------------------------------------------------------------------- the reads

const READ_TIMEOUT_MS = 5_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}

/** pump Global and PumpSwap GlobalConfig sizes, read on mainnet-beta and publicnode 2026-11-02 21:00Z; the offsets above
 * hold only on these layouts, so any other size is refused. */
export const SOLANA_PUMP_GLOBAL_SIZE = 1_088;
export const SOLANA_PUMP_AMM_CONFIG_SIZE = 949;

/** Token-2022 mint extensions (spl-token-2022 ExtensionType) that add nothing to a new token account. */
const T22_MINT_ONLY = new Set([3, 4, 6, 10, 12, 16, 18, 19, 20, 21, 22, 23, 24, 25]);
/** Mint extensions that a new token account carries one of (get_required_init_account_extensions): TransferFeeConfig
 * -> TransferFeeAmount (8 bytes), NonTransferable -> NonTransferableAccount (0), TransferHook -> TransferHookAccount
 * (1), Pausable -> PausableAccount (0). */
const T22_ACCOUNT_EXT = new Map([[1, 8], [9, 0], [14, 1], [26, 0]]);

/** The size of W's new associated token account for `mint`: 165 for Token; for Token-2022 165, the account type byte
 * and a 4-byte TLV head per extension: ImmutableOwner (the associated token program always adds it) and the one each
 * mint extension asks. A mint extension this list does not know is refused. */
export function solanaTokenAccountSize(mint: { owner: string; data: Uint8Array }): number {
  if (mint.owner === SOLANA_TOKEN_PROGRAM) {
    if (mint.data.length !== 82) throw new Error("not a Token mint");
    return TOKEN_ACCOUNT_SIZE;
  }
  if (mint.owner !== SOLANA_TOKEN_2022_PROGRAM) throw new Error(`mint owned by ${mint.owner}`);
  const d = mint.data;
  let size = TOKEN_ACCOUNT_SIZE + 1 + 4; // account type, ImmutableOwner
  if (d.length === 82) return size;
  if (d.length < 166 || d[165] !== 1) throw new Error("not a Token-2022 mint");
  for (let at = 166; at < d.length; ) {
    if (at + 4 > d.length) throw new Error("a Token-2022 extension runs past the mint");
    const type = d[at]! | (d[at + 1]! << 8);
    const len = d[at + 2]! | (d[at + 3]! << 8);
    if (type === 0) break; // Uninitialized: the rest is padding
    at += 4 + len;
    if (at > d.length) throw new Error("a Token-2022 extension runs past the mint");
    const extra = T22_ACCOUNT_EXT.get(type);
    if (extra !== undefined) size += 4 + extra;
    else if (!T22_MINT_ONLY.has(type)) throw new Error(`a Token-2022 mint extension ${type} not known here`);
  }
  return size;
}

/** The venue's buy accounts from one provider's read of [mint, curve, pump Global] or [mint, pool, GlobalConfig]; the
 * buyback recipient is the `pick`ed one of the venue's eight (the SDKs pick at random, which spreads the write locks). */
export function solanaPoolBuyVenueOf(kind: SolanaPoolVenue, mint: string, accounts: readonly (SolanaPoolAccount | null)[], pick: (n: number) => number = () => 0): SolanaPoolBuyVenue {
  const [m, main, global] = accounts;
  if (!m || !main || !global) throw new Error("an account is missing");
  if (m.owner !== SOLANA_TOKEN_PROGRAM && m.owner !== SOLANA_TOKEN_2022_PROGRAM) throw new Error(`mint owned by ${m.owner}`);
  const addr = solanaPoolAddresses(mint);
  const keyAt = (d: Uint8Array, o: number): string => {
    if (d.length < o + 32) throw new Error("account too short");
    return base58.encode(d.subarray(o, o + 32));
  };
  const buyback = (d: Uint8Array, o: number): { buybackFeeRecipients: string[]; buybackFeeRecipient: string } => {
    const list = Array.from({ length: 8 }, (_, i) => keyAt(d, o + 32 * i));
    if (list.some((k) => k === DEFAULT_KEY)) throw new Error("a buyback recipient is unset");
    const i = pick(list.length);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new Error("pick out of range");
    return { buybackFeeRecipients: list, buybackFeeRecipient: list[i] as string };
  };
  if (kind === "pump-curve") {
    const c = solanaDecodeBondingCurve(main);
    if (c.complete) throw new Error("the curve is complete");
    if (c.isMayhemMode) throw new Error("a Mayhem curve pays its reserved fee recipients, not built here");
    if (c.quoteMint !== SOLANA_SYSTEM_PROGRAM && c.quoteMint !== SOLANA_SOL_MINT) throw new Error("the curve is not quoted in SOL");
    solanaDecodePumpGlobal(global); // owner and discriminator
    if (global.data.length !== SOLANA_PUMP_GLOBAL_SIZE) throw new Error(`pump Global is ${global.data.length} bytes, not ${SOLANA_PUMP_GLOBAL_SIZE}`);
    const feeRecipient = keyAt(global.data, PUMP_GLOBAL_FEE_RECIPIENT);
    if (feeRecipient === DEFAULT_KEY) throw new Error("pump Global has no fee recipient");
    return { kind, mint, tokenProgram: m.owner, tokenAccountSize: solanaTokenAccountSize(m), curve: addr.curve, creator: c.creator, feeRecipient, cashback: c.isCashbackCoin, ...buyback(global.data, PUMP_GLOBAL_BUYBACK_RECIPIENTS) };
  }
  const p = solanaDecodePumpSwapPool(main);
  if (p.index !== 0 || p.creator !== addr.poolAuthority || p.baseMint !== mint || p.quoteMint !== SOLANA_SOL_MINT) throw new Error("the pool is not the mint's canonical pool");
  if (p.isMayhemMode) throw new Error("a Mayhem pool pays its reserved fee recipients, not built here");
  const t22 = m.owner === SOLANA_TOKEN_2022_PROGRAM;
  if (p.baseVault !== (t22 ? addr.baseVaultToken2022 : addr.baseVaultToken) || p.quoteVault !== addr.quoteVault) throw new Error("the pool's vaults are not its token accounts");
  solanaDecodePumpSwapConfig(global); // owner and discriminator
  if (global.data.length !== SOLANA_PUMP_AMM_CONFIG_SIZE) throw new Error(`GlobalConfig is ${global.data.length} bytes, not ${SOLANA_PUMP_AMM_CONFIG_SIZE}`);
  const protocolFeeRecipient = keyAt(global.data, AMM_PROTOCOL_FEE_RECIPIENTS);
  if (protocolFeeRecipient === DEFAULT_KEY) throw new Error("GlobalConfig has no protocol fee recipient");
  const cashback = main.data[AMM_POOL_CASHBACK];
  if (cashback !== 0 && cashback !== 1) throw new Error("the pool's cashback flag is not a bool");
  return {
    kind, mint, tokenProgram: m.owner, tokenAccountSize: solanaTokenAccountSize(m), pool: addr.pool, baseVault: p.baseVault, quoteVault: p.quoteVault, coinCreator: p.coinCreator, cashback: cashback === 1,
    protocolFeeRecipient, ...buyback(global.data, AMM_GLOBAL_BUYBACK_RECIPIENTS),
  };
}

/** The venue's buy accounts read on both providers; throws unless both give the same accounts. */
export async function readSolanaPoolBuyVenue(providers: readonly [SolanaRpc, SolanaRpc], kind: SolanaPoolVenue, mint: string, pick: (n: number) => number = randomIndex): Promise<SolanaPoolBuyVenue> {
  if (!Array.isArray(providers) || providers.length !== 2 || solanaSameProvider(providers[0], providers[1])) throw new Error("two different providers are needed");
  const addr = solanaPoolAddresses(mint);
  const list = kind === "pump-curve" ? [mint, addr.curve, PUMP_GLOBAL] : [mint, addr.pool, AMM_GLOBAL_CONFIG];
  const reads = await Promise.all(providers.map((rpc) => withTimeout(Promise.resolve().then(() => rpc("getMultipleAccounts", [list, { encoding: "base64", commitment: "confirmed" }])), READ_TIMEOUT_MS)));
  const i = pick(8); // one buyback recipient for both reads, so they compare equal
  const venues = reads.map((r) => {
    const parsed = solanaParseAccountsAnswer(r, list.length);
    if (!parsed) throw new Error("a provider's answer is not an accounts read");
    return solanaPoolBuyVenueOf(kind, mint, parsed.accounts, () => i);
  });
  if (JSON.stringify(venues[0]) !== JSON.stringify(venues[1])) throw new Error("the providers disagree on the venue's accounts");
  return venues[0] as SolanaPoolBuyVenue;
}

// ------------------------------------------------------------------------------------------------- the check

/** The oldest reference QUOTE takes: 25 slots (about 10 s at 400 ms a slot) behind the device's own slot read. A quote
 * completes in under 1 s and the tap follows it, so an older reference means a stale or held-back read. */
export const SOLANA_POOL_QUOTE_MAX_AGE_SLOTS = 25;
/** Null when `ref` was read at most SOLANA_POOL_QUOTE_MAX_AGE_SLOTS before the device's `slot`. A reference newer than
 * the device's slot read is fresher, not staler (one provider's nodes answer a few slots apart), so it is taken. */
function quoteAgeProblem(ref: SolanaReference | null, slot: number): string | null {
  if (!ref || ref.slot === undefined || !Number.isSafeInteger(ref.slot) || !Number.isSafeInteger(slot)) return "the reference has no slot, or the device has no slot read";
  const age = slot - ref.slot;
  return age > SOLANA_POOL_QUOTE_MAX_AGE_SLOTS ? `the reference was read ${age} slots before the device's slot, over ${SOLANA_POOL_QUOTE_MAX_AGE_SLOTS}` : null;
}

export type SolanaPoolBuyReads = {
  /** The blockhash the device read itself (getLatestBlockhash): the message must carry exactly this one. */
  readonly blockhash: string;
  /** The device's own slot read at `confirmed`, beside the blockhash. */
  readonly slot: number;
  /** Every lookup table the message uses, as each provider answered (owner and data) at `confirmed`. */
  readonly tables: Readonly<Record<string, readonly [{ owner: string; data: Uint8Array } | null, { owner: string; data: Uint8Array } | null]>>;
  /** The pool's state tree size now, read by the device. */
  readonly stateSize: number;
  /** The Rent sysvar, read on two providers (readSolanaRent). */
  readonly rent: SolanaRent;
  /** The reference E for exactly `amount` lamports in (readSolanaReference over two providers), and the user's slippage. */
  readonly reference: { readonly amount: bigint; readonly ref: SolanaReference | null; readonly slippageBps: number };
};
export type SolanaPoolBuyCheckId = "DECODE" | "BLOCKHASH" | "TABLES" | "SIGNERS" | "FRAME" | "RELEASE" | "BUY" | "PRIVILEGES" | "FUNDS" | "FEE" | "QUOTE" | "SIZE";
export type SolanaPoolBuyVerdict = { ok: boolean; results: { id: SolanaPoolBuyCheckId; ok: boolean; detail: string }[] };

// An instruction's program, data and account keys in order. Privileges are the message's, one per key (a key that
// signs anywhere signs everywhere), so they are judged once over the whole message (PRIVILEGES), not per instruction.
const same = (a: SolanaApiInstruction, b: { program: string; accounts: { key: string }[]; data: Uint8Array }): boolean =>
  a.program === b.program && eqBytes(a.data, b.data) && a.accounts.length === b.accounts.length && a.accounts.every((x, i) => x.key === b.accounts[i]!.key);
/** Every key of the instructions with its merged privileges, as a v0 message gives them. */
function privileges(ixs: readonly SolanaApiInstruction[]): Map<string, { signer: boolean; writable: boolean }> {
  const m = new Map<string, { signer: boolean; writable: boolean }>();
  const touch = (k: string, signer: boolean, writable: boolean) => {
    const o = m.get(k) ?? { signer: false, writable: false };
    m.set(k, { signer: o.signer || signer, writable: o.writable || writable });
  };
  for (const x of ixs) {
    touch(x.program, false, false);
    for (const a of x.accounts) touch(a.key, a.signer, a.writable);
  }
  return m;
}

type InnerRun = { program: string; accounts: { key: string; signer: boolean; writable: boolean }[]; data: Uint8Array };
/**
 * Tag 3's inner instructions as the pool runs them (src/buy.rs): each index resolved to the tag 3 instruction's
 * account, the signer flag only on W, the writable flag the message gives that account. Null when the data does not
 * parse as the pool parses it (count 1 to 8, every index in range, ending exactly).
 */
function innerRuns(data: Uint8Array, outer: readonly { key: string; signer: boolean; writable: boolean }[], wallet: string): InnerRun[] | null {
  if (data.length < TAG3_HEAD + 1 || data[0] !== SOLANA_POOL_TAG_RELEASE_AND_BUY || data[1] !== 1) return null;
  const count = data[TAG3_HEAD]!;
  if (count === 0 || count > SOLANA_POOL_TAG3_MAX_INNER) return null;
  const out: InnerRun[] = [];
  let at = TAG3_HEAD + 1;
  for (let k = 0; k < count; k++) {
    if (at + 2 > data.length) return null;
    const program = data[at]!;
    const n = data[at + 1]!;
    if (at + 2 + n + 2 > data.length) return null;
    const idx = Array.from(data.subarray(at + 2, at + 2 + n));
    const len = data[at + 2 + n]! | (data[at + 3 + n]! << 8);
    const from = at + 4 + n;
    if (from + len > data.length || program >= outer.length || idx.some((i) => i >= outer.length)) return null;
    out.push({ program: outer[program]!.key, accounts: idx.map((i) => ({ key: outer[i]!.key, signer: outer[i]!.key === wallet, writable: outer[i]!.writable })), data: data.slice(from, from + len) });
    at = from + len;
  }
  return at === data.length ? out : null;
}
const sameRun = (a: InnerRun, b: InnerRun): boolean =>
  a.program === b.program && eqBytes(a.data, b.data) && a.accounts.length === b.accounts.length &&
  a.accounts.every((x, i) => x.key === b.accounts[i]!.key && x.signer === b.accounts[i]!.signer && x.writable === b.accounts[i]!.writable);

/**
 * The device's check before W signs: the message is decoded, must carry the device's own blockhash, and its keys are
 * resolved from our table as both providers read it. It must be exactly CU limit, CU price and one tag 3 into the pool,
 * and that tag 3 the one this device builds from the user's request, the ready proof, the venue read on two providers
 * and today's rent (the tip account may be any of the baked Jito accounts): the release's bytes and accounts, then
 * every inner instruction as the pool will run it (program, data, keys, signer and writable flags), then the merged
 * privileges of every key. The chunk must cover the spend and W's new accounts, and min_out must hold against E for
 * the spend from the venue's reserves on both providers, read at most SOLANA_POOL_QUOTE_MAX_AGE_SLOTS ago.
 */
export function checkSolanaPoolBuy(wire: Uint8Array, cfg: SolanaPoolConfig, release: SolanaPoolRelease, venue: SolanaPoolBuyVenue, req: SolanaPoolBuyRequest, reads: SolanaPoolBuyReads): SolanaPoolBuyVerdict {
  const results: SolanaPoolBuyVerdict["results"] = [];
  const pass = (id: SolanaPoolBuyCheckId, detail: string) => results.push({ id, ok: true, detail });
  const fail = (id: SolanaPoolBuyCheckId, detail: string) => results.push({ id, ok: false, detail });
  const done = (): SolanaPoolBuyVerdict => ({ ok: results.length > 0 && results.every((r) => r.ok), results });
  if (wire.length > SOLANA_MAX_TX_BYTES) fail("SIZE", `${wire.length} bytes > ${SOLANA_MAX_TX_BYTES}`);
  else pass("SIZE", `${wire.length} bytes`);
  let keys: { key: string; signer: boolean; writable: boolean }[];
  let m: ReturnType<typeof solanaDecodeMessage>;
  try {
    if (wire[0] !== 2) throw new Error(`${wire[0]} signature slots, want 2`);
    m = solanaDecodeMessage(wire.subarray(129));
    // TABLES: owned by the table program, active, equal at every used index on both providers
    const tables: Record<string, SolanaLookupTable> = {};
    const wrong: string[] = [];
    for (const l of m.lookups) {
      const pair = Object.hasOwn(reads.tables, l.table) ? reads.tables[l.table] : undefined;
      const st = (pair ?? [null, null]).map((a) => (a && a.owner === SOLANA_ALT_PROGRAM ? solanaDecodeLookupTable(a.data) : null));
      const [a, b] = st;
      if (!a || !b) { wrong.push(`table ${l.table} not read as a table on both providers`); continue; }
      if (!solanaTableIsActive(a) || !solanaTableIsActive(b)) wrong.push(`table ${l.table} is deactivated`);
      const off = [...l.writable, ...l.readonly].filter((i) => a.addresses[i] === undefined || a.addresses[i] !== b.addresses[i]);
      if (off.length) wrong.push(`table ${l.table}: the providers disagree at ${off.join(",")}`);
      tables[l.table] = a;
    }
    if (wrong.length) { fail("TABLES", wrong.join("; ")); return done(); }
    pass("TABLES", `${m.lookups.length} table(s), equal on both providers`);
    keys = solanaResolveKeys(m, tables);
  } catch (e) {
    fail("DECODE", (e as Error).message);
    return done();
  }
  // BLOCKHASH: the device's own read, never the server's
  if (!isKey(reads.blockhash) || m.blockhash !== reads.blockhash) fail("BLOCKHASH", `the message carries ${m.blockhash}, not the device's ${reads.blockhash}`);
  else pass("BLOCKHASH", "the device's own read");
  // SIGNERS: the fee payer first, then W; nothing else signs
  const signers = keys.filter((k) => k.signer).map((k) => k.key);
  if (signers.length !== 2 || signers[0] !== req.feePayer || signers[1] !== req.wallet || m.readonlySigned !== 0) fail("SIGNERS", `signers ${signers.join(",")}`);
  else pass("SIGNERS", "the fee payer and W");
  // FUNDS: the chunk covers the spend and W's new accounts, and W keeps 0 or at least rent(0)
  const funds = solanaPoolBuyFunds(release, venue, req, reads.rent);
  if (funds.problem) { fail("FUNDS", funds.problem); return done(); }
  pass("FUNDS", `chunk ${funds.chunk}, W pays out ${funds.peak} at most, keeps ${funds.left}`);
  // FEE: the priority fee fits in what the relay fee leaves after the release's cost (the helper's fee_below_cost)
  const fee = solanaPoolPriorityProblem(release, venue, req, reads.rent);
  if (fee) { fail("FEE", fee); return done(); }
  pass("FEE", `priority ${perVenue(SOLANA_POOL_BUY_CU, venue.kind)} CU at ${req.cuPrice} within relay fee ${release.relayFee} less cost ${solanaPoolReleaseCost(reads.rent)}`);
  const got = m.instructions.map((x) => ({ program: keys[x.programIndex]?.key ?? "?", accounts: x.accounts.map((i) => keys[i] ?? { key: "?", signer: false, writable: false }), data: x.data }));
  // the tip account the message names (tag 3's ninth account); the rebuild holds it to the baked Jito accounts
  const tipTo = req.tip > 0n ? got[2]?.accounts[8]?.key ?? null : null;
  let want: SolanaApiInstruction[];
  try {
    want = solanaPoolBuyInstructions(cfg, release, venue, req, reads.stateSize, reads.rent, tipTo);
  } catch (e) {
    fail("RELEASE", `the request itself is refused: ${(e as Error).message}`);
    return done();
  }
  // FRAME: exactly CU limit, CU price, tag 3 into the pool
  if (got.length !== 3 || !same(want[0]!, got[0]!) || !same(want[1]!, got[1]!) || got[2]!.program !== cfg.program) fail("FRAME", `want CU limit, CU price and one tag 3 into ${cfg.program}; got ${got.length} instruction(s)`);
  else pass("FRAME", "CU limit, CU price, tag 3");
  const g = got[2];
  const w = want[2]!;
  const head = 8 + (req.tip > 0n ? 1 : 0);
  // RELEASE: the head of tag 3 (tag, flags, this proof compressed, the release's fields, the tip) and its first
  // accounts (the release's eight, then the tip account)
  if (!g || g.program !== cfg.program || g.data.length < TAG3_HEAD || !eqBytes(g.data.subarray(0, TAG3_HEAD), w.data.subarray(0, TAG3_HEAD)) ||
    g.accounts.length < head || w.accounts.slice(0, head).some((a, i) => a.key !== g.accounts[i]!.key)) {
    fail("RELEASE", "the release is not this proof's, to W, paid by the fee payer, into the pool's pages, with this tip");
  } else pass("RELEASE", `tag 3: ${release.withdrawnValue} lamports, relay fee ${release.relayFee}, tip ${req.tip}`);
  // BUY: every inner instruction as the pool will run it, and nothing past them
  const wantRuns = innerRuns(w.data, w.accounts.map((a) => ({ ...a, writable: privileges(want).get(a.key)!.writable })), req.wallet)!;
  const gotRuns = g ? innerRuns(g.data, g.accounts, req.wallet) : null;
  if (!g || !gotRuns || gotRuns.length !== wantRuns.length || gotRuns.some((r, i) => !sameRun(r, wantRuns[i]!)) || !same(w, g)) {
    fail("BUY", `the inner instructions are not ${req.spend} lamports for at least ${req.minOut} of ${req.token} on ${venue.kind === "pump-curve" ? venue.curve : venue.pool}, W the user`);
  } else pass("BUY", `${venue.kind}: ${req.spend} lamports in, min out ${req.minOut}, ${gotRuns.length} inner instructions`);
  // PRIVILEGES: the message gives every key exactly the signer and writable flags this device's instructions ask, and
  // holds no key they do not name (the fee payer is first: it pays the fee)
  const p = privileges(want);
  p.set(req.feePayer, { signer: true, writable: true });
  const off = keys.filter((k) => { const x = p.get(k.key); return !x || x.signer !== k.signer || x.writable !== k.writable; }).map((k) => k.key);
  if (off.length || keys.length !== p.size) fail("PRIVILEGES", `keys with other privileges or not asked for: ${off.join(",") || `${keys.length} keys for ${p.size}`}`);
  else pass("PRIVILEGES", `${keys.length} keys, each with the privileges asked`);
  // QUOTE: min_out within the user's slippage of E for exactly the spend, on this venue, from two providers' reads made
  // at most SOLANA_POOL_QUOTE_MAX_AGE_SLOTS before the device's own slot
  const { amount, ref, slippageBps } = reads.reference;
  const venueAddr = venue.kind === "pump-curve" ? venue.curve : venue.pool;
  const pool = ref?.pools.find((x) => x.address === venueAddr && x.venue === venue.kind);
  const stale = quoteAgeProblem(ref, reads.slot);
  if (amount !== req.spend) fail("QUOTE", `the reference is for ${amount} lamports, not the spend ${req.spend}`);
  else if (!pool) fail("QUOTE", `no reference read for ${venueAddr} on two providers`);
  else if (stale) fail("QUOTE", stale);
  else if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) fail("QUOTE", "slippage out of range");
  else {
    const floor = (pool.expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
    if (req.minOut < floor || req.minOut === 0n) fail("QUOTE", `min out ${req.minOut} under ${floor} (E ${pool.expectedOut}, slippage ${slippageBps} bps)`);
    else pass("QUOTE", `min out ${req.minOut} >= ${floor} (E ${pool.expectedOut}, read at slot ${ref!.slot})`);
  }
  return done();
}

/** A lookup table read the way the check wants it, from a getAccountInfo base64 value. */
export function solanaPoolTableRead(value: { owner: string; data: [string, "base64"] } | null): { owner: string; data: Uint8Array } | null {
  return value ? { owner: value.owner, data: base64.decode(value.data[0]) } : null;
}
