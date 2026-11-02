// A private buy on Solana in one transaction W signs (architecture v2, merge notes M349-M350; card sol-pool-buy-tx).
// Device side. The Blindfill pool on Solana (contracts/pool-solana, branch pool-sol-core f0d85a8) releases one ready
// proof's chunk of SOL to the fresh wallet W, and in the same transaction W buys on pump.fun or PumpSwap as the venue's
// `user`. W and the fee payer are the two signers; W's signature covers every account and byte, so no relayer can
// redirect the release or the buy.
//
// Shapes:
// - A (lands now): the pool's tag 2 `release`, then the venue's buy as its own top-level instruction. Every invoked
//   program is a static key (a v0 message never invokes a program it loads from a table).
// - B (tag 3, release-and-buy, contracts/pool-solana/TAG3.md): one top-level instruction into the pool, which verifies,
//   pays W, then invokes the inner instructions W signed for with W's signer privilege only (never invoke_signed). The
//   venue's program id is then an account, loaded from our lookup table. Built here for its size only, until the pool
//   has tag 3 (card pool-sol-buy-sell).
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
// Never sign on a server's word: checkSolanaPoolBuy rebuilds every instruction from the user's own request, the ready
// proof and the venue's accounts read on two providers, and compares the message to it byte for byte; the buy's
// min_out must also hold against the reference E read from the venue's reserves on both providers (pool.ts).
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
      readonly kind: "pump-curve"; readonly mint: string; readonly tokenProgram: string; readonly curve: string; readonly creator: string; readonly feeRecipient: string;
      readonly buybackFeeRecipients: readonly string[]; readonly buybackFeeRecipient: string;
    }
  | {
      readonly kind: "pumpswap"; readonly mint: string; readonly tokenProgram: string; readonly pool: string; readonly baseVault: string;
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

// ------------------------------------------------------------------------------------------------- the build

export type SolanaPoolBuyRequest = {
  readonly wallet: string; // W: signs, receives the chunk, is the venue's user
  readonly feePayer: string; // pays the transaction fee and the release's rent, takes relay_fee; signs
  readonly token: string;
  readonly spend: bigint; // lamports into the venue
  readonly minOut: bigint; // token base units, the least the buy may give
  readonly tip: bigint; // lamports from W to a Jito tip account; 0 for none; at most the proof's tip cap
  readonly cuPrice: bigint; // micro-lamports per CU
};
export type SolanaPoolBuyChain = {
  readonly blockhash: string; // the device's own read
  readonly lastValidBlockHeight: number;
  readonly table: { readonly address: string; readonly table: SolanaLookupTable }; // our lookup table, as the device read it
  readonly stateSize: number; // the pool's state tree size now, read by the device
};
export type SolanaPoolBuyOptions = { readonly pick?: (n: number) => number };
export type SolanaPoolBuyBuilt = {
  readonly shape: "A";
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

function checkRequest(cfg: SolanaPoolConfig, release: SolanaPoolRelease, venue: SolanaPoolBuyVenue, req: SolanaPoolBuyRequest): void {
  for (const k of [cfg.program, cfg.pool, req.wallet, req.feePayer, req.token]) if (!isKey(k)) throw new Error("program, pool, wallet, fee payer and token must be addresses");
  if (cfg.pool !== solanaPoolAccount(cfg.program)) throw new Error("the pool is not the program's pool account");
  if (req.wallet === req.feePayer || req.wallet === cfg.pool || req.feePayer === cfg.pool) throw new Error("W, the fee payer and the pool must differ");
  if (venue.mint !== req.token) throw new Error("the venue is not the token's");
  if (!isU64(req.tip) || req.tip > release.tipCap) throw new Error("the tip is over the proof's tip cap");
  if (!isU64(req.cuPrice) || req.cuPrice > SOLANA_CU_PRICE_MAX) throw new Error("the CU price is over its cap");
  // W pays the spend and the tip out of the chunk the release pays it (withdrawn - relay_fee)
  if (req.spend + req.tip > release.withdrawnValue - release.relayFee) throw new Error("the spend and the tip are more than the chunk W receives");
}

/** The instructions of shape A, in order. */
export function solanaPoolBuyInstructions(cfg: SolanaPoolConfig, release: SolanaPoolRelease, venue: SolanaPoolBuyVenue, req: SolanaPoolBuyRequest, stateSize: number, tipAccount: string | null): SolanaApiInstruction[] {
  checkRequest(cfg, release, venue, req);
  const cu = SOLANA_POOL_BUY_CU[venue.kind];
  return [
    ix(SOLANA_COMPUTE_BUDGET_PROGRAM, [], [2, ...u32le(cu)]),
    ix(SOLANA_COMPUTE_BUDGET_PROGRAM, [], [3, ...u64le(req.cuPrice)]),
    ix(cfg.program, solanaPoolReleaseAccounts(cfg, req.wallet, req.feePayer, release, stateSize), solanaEncodePoolRelease(release)),
    ...solanaPoolBuySteps(venue, req.wallet, req.spend, req.minOut),
    ...(req.tip > 0n && tipAccount ? [transfer(req.wallet, tipAccount, req.tip)] : []),
  ];
}

/** Shape A: the unsigned v0 transaction the fee payer and W sign. Refuses over 1,232 bytes. */
export function buildSolanaPoolBuy(cfg: SolanaPoolConfig, release: SolanaPoolRelease, venue: SolanaPoolBuyVenue, req: SolanaPoolBuyRequest, chain: SolanaPoolBuyChain, opts: SolanaPoolBuyOptions = {}): SolanaPoolBuyBuilt {
  if (!isKey(chain.blockhash) || !Number.isSafeInteger(chain.lastValidBlockHeight) || chain.lastValidBlockHeight <= 0) throw new Error("the blockhash must be the device's own read");
  if (!solanaTableIsActive(chain.table.table)) throw new Error("our lookup table is deactivated");
  const tipAccount = req.tip > 0n ? (SOLANA_JITO_TIP_ACCOUNTS[(opts.pick ?? randomIndex)(SOLANA_JITO_TIP_ACCOUNTS.length)] as string) : null;
  const instructions = solanaPoolBuyInstructions(cfg, release, venue, req, chain.stateSize, tipAccount);
  const { message } = solanaCompileV0(req.feePayer, instructions, chain.blockhash, [chain.table], [req.feePayer, req.wallet]);
  const wire = new Uint8Array(1 + 128 + message.length);
  wire[0] = 2;
  wire.set(message, 129);
  if (wire.length > SOLANA_MAX_TX_BYTES) throw new Error(`too_large: ${wire.length} bytes > ${SOLANA_MAX_TX_BYTES}`);
  return { shape: "A", wire, message, size: wire.length, lastValidBlockHeight: chain.lastValidBlockHeight, cuLimit: SOLANA_POOL_BUY_CU[venue.kind], instructions };
}

// ------------------------------------------------------------------------------------------------- tag 3 (shape B)

/**
 * Tag 3's data (contracts/pool-solana/TAG3.md): tag 3 ‖ flags u8 (bit 0: compressed proof) ‖ proof (256 or 128) ‖ the
 * release's 130 field bytes as tag 2 ‖ tip u64 ‖ inner count u8 ‖ per inner instruction: program u8 (index into this
 * instruction's accounts) ‖ n u8 ‖ n account indexes u8 ‖ data length u16 LE ‖ data. The instruction's accounts are
 * the release's 8, then the tip account when the tip is above 0, then every account the inner instructions name, each
 * once; an inner instruction's signer and writable flags are the outer account's.
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

/** Shape B's unsigned v0 transaction (its size; the pool has no tag 3 yet). */
export function buildSolanaPoolBuyTag3(cfg: SolanaPoolConfig, release: SolanaPoolRelease, venue: SolanaPoolBuyVenue, req: SolanaPoolBuyRequest, chain: SolanaPoolBuyChain, opts: SolanaPoolBuyOptions & { compressed: boolean }): { wire: Uint8Array; size: number } {
  checkRequest(cfg, release, venue, req);
  const steps = solanaPoolBuySteps(venue, req.wallet, req.spend, req.minOut);
  const tipAccount = req.tip > 0n ? (SOLANA_JITO_TIP_ACCOUNTS[(opts.pick ?? randomIndex)(SOLANA_JITO_TIP_ACCOUNTS.length)] as string) : null;
  const outer: SolanaApiAccount[] = [...solanaPoolReleaseAccounts(cfg, req.wallet, req.feePayer, release, chain.stateSize), ...(tipAccount ? [acc(tipAccount, false, true)] : [])];
  const indexOf = (a: SolanaApiAccount): number => {
    let i = outer.findIndex((o) => o.key === a.key);
    if (i < 0) i = outer.push({ ...a }) - 1;
    else outer[i] = { key: a.key, signer: outer[i]!.signer || a.signer, writable: outer[i]!.writable || a.writable };
    return i;
  };
  const inner = steps.map((s) => ({ program: indexOf(acc(s.program, false, false)), accounts: s.accounts.map(indexOf), data: s.data }));
  const data = solanaEncodePoolTag3(release, opts.compressed, req.tip, inner);
  const ixs = [
    ix(SOLANA_COMPUTE_BUDGET_PROGRAM, [], [2, ...u32le(SOLANA_POOL_BUY_CU[venue.kind])]),
    ix(SOLANA_COMPUTE_BUDGET_PROGRAM, [], [3, ...u64le(req.cuPrice)]),
    ix(cfg.program, outer, data),
  ];
  const { message } = solanaCompileV0(req.feePayer, ixs, chain.blockhash, [chain.table], [req.feePayer, req.wallet]);
  const wire = new Uint8Array(1 + 128 + message.length);
  wire[0] = 2;
  wire.set(message, 129);
  return { wire, size: wire.length };
}

// ------------------------------------------------------------------------------------------------- the reads

const READ_TIMEOUT_MS = 5_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
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
    const feeRecipient = keyAt(global.data, PUMP_GLOBAL_FEE_RECIPIENT);
    if (feeRecipient === DEFAULT_KEY) throw new Error("pump Global has no fee recipient");
    return { kind, mint, tokenProgram: m.owner, curve: addr.curve, creator: c.creator, feeRecipient, ...buyback(global.data, PUMP_GLOBAL_BUYBACK_RECIPIENTS) };
  }
  const p = solanaDecodePumpSwapPool(main);
  if (p.index !== 0 || p.creator !== addr.poolAuthority || p.baseMint !== mint || p.quoteMint !== SOLANA_SOL_MINT) throw new Error("the pool is not the mint's canonical pool");
  if (p.isMayhemMode) throw new Error("a Mayhem pool pays its reserved fee recipients, not built here");
  const t22 = m.owner === SOLANA_TOKEN_2022_PROGRAM;
  if (p.baseVault !== (t22 ? addr.baseVaultToken2022 : addr.baseVaultToken) || p.quoteVault !== addr.quoteVault) throw new Error("the pool's vaults are not its token accounts");
  solanaDecodePumpSwapConfig(global); // owner and discriminator
  const protocolFeeRecipient = keyAt(global.data, AMM_PROTOCOL_FEE_RECIPIENTS);
  if (protocolFeeRecipient === DEFAULT_KEY) throw new Error("GlobalConfig has no protocol fee recipient");
  const cashback = main.data[AMM_POOL_CASHBACK];
  if (cashback !== 0 && cashback !== 1) throw new Error("the pool's cashback flag is not a bool");
  return {
    kind, mint, tokenProgram: m.owner, pool: addr.pool, baseVault: p.baseVault, quoteVault: p.quoteVault, coinCreator: p.coinCreator, cashback: cashback === 1,
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

export type SolanaPoolBuyReads = {
  /** Every lookup table the message uses, as each provider answered (owner and data). */
  readonly tables: Readonly<Record<string, readonly [{ owner: string; data: Uint8Array } | null, { owner: string; data: Uint8Array } | null]>>;
  /** The pool's state tree size now, read by the device. */
  readonly stateSize: number;
  /** The reference E for exactly `amount` lamports in (readSolanaReference over two providers), and the user's slippage. */
  readonly reference: { readonly amount: bigint; readonly ref: SolanaReference | null; readonly slippageBps: number };
};
export type SolanaPoolBuyCheckId = "DECODE" | "TABLES" | "SIGNERS" | "RELEASE" | "BUY" | "FRAME" | "PRIVILEGES" | "QUOTE" | "SIZE";
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

/**
 * The device's check of a shape A transaction before W signs it: the message is decoded and its keys resolved from our
 * table as both providers read it; then every instruction must be the one this device builds from the user's request,
 * the ready proof and the venue read on two providers (the tip account may be any of the baked Jito accounts), and the
 * buy's min_out must hold against E for the spend from the venue's reserves on both providers.
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
  // SIGNERS: the fee payer first, then W; nothing else signs
  const signers = keys.filter((k) => k.signer).map((k) => k.key);
  if (signers.length !== 2 || signers[0] !== req.feePayer || signers[1] !== req.wallet || m.readonlySigned !== 0) fail("SIGNERS", `signers ${signers.join(",")}`);
  else pass("SIGNERS", "the fee payer and W");
  const got = m.instructions.map((x) => ({ program: keys[x.programIndex]?.key ?? "?", accounts: x.accounts.map((i) => keys[i] ?? { key: "?", signer: false, writable: false }), data: x.data }));
  let want: SolanaApiInstruction[];
  try {
    want = solanaPoolBuyInstructions(cfg, release, venue, req, reads.stateSize, null);
  } catch (e) {
    fail("RELEASE", `the request itself is refused: ${(e as Error).message}`);
    return done();
  }
  const releaseAt = 2;
  const buyAt = want.findIndex((x) => x.program === (venue.kind === "pump-curve" ? SOLANA_PUMP_PROGRAM : SOLANA_PUMP_AMM_PROGRAM));
  const g = (i: number) => got[i];
  if (!g(releaseAt) || !same(want[releaseAt]!, g(releaseAt)!)) fail("RELEASE", "the release is not this proof's, to W, paid by the fee payer, into the pool's pages");
  else pass("RELEASE", `tag 2: ${release.withdrawnValue} lamports to W, relay fee ${release.relayFee}`);
  if (!g(buyAt) || !same(want[buyAt]!, g(buyAt)!)) fail("BUY", `the buy is not ${req.spend} lamports for at least ${req.minOut} of ${req.token} on ${venue.kind === "pump-curve" ? venue.curve : venue.pool}, W the user`);
  else pass("BUY", `${venue.kind}: ${req.spend} lamports in, min out ${req.minOut}`);
  // FRAME: the rest, in order; the tip (last, when asked) to one of the baked Jito accounts for exactly req.tip
  const tipWanted = req.tip > 0n;
  const frameOk =
    got.length === want.length + (tipWanted ? 1 : 0) &&
    want.every((w, i) => i === releaseAt || i === buyAt || same(w, g(i)!)) &&
    (!tipWanted || (() => {
      const t = g(want.length)!;
      const to = t.accounts[1]?.key ?? "";
      return SOLANA_JITO_TIP_ACCOUNTS.includes(to) && same(transfer(req.wallet, to, req.tip), t);
    })());
  if (!frameOk) fail("FRAME", "an instruction other than the release and the buy is not the one this device builds");
  else pass("FRAME", `${got.length} instructions`);
  // PRIVILEGES: the message gives every key exactly the signer and writable flags this device's instructions ask, and
  // holds no key they do not name (the fee payer is first: it pays the fee)
  const tipTo = tipWanted ? got[want.length]?.accounts[1]?.key : undefined;
  const p = privileges([...want, ...(tipTo ? [transfer(req.wallet, tipTo, req.tip)] : [])]);
  p.set(req.feePayer, { signer: true, writable: true });
  const off = keys.filter((k) => { const w = p.get(k.key); return !w || w.signer !== k.signer || w.writable !== k.writable; }).map((k) => k.key);
  if (off.length || keys.length !== p.size) fail("PRIVILEGES", `keys with other privileges or not asked for: ${off.join(",") || `${keys.length} keys for ${p.size}`}`);
  else pass("PRIVILEGES", `${keys.length} keys, each with the privileges asked`);
  // QUOTE: min_out within the user's slippage of E for exactly the spend, on this venue, from two providers' reads
  const { amount, ref, slippageBps } = reads.reference;
  const venueAddr = venue.kind === "pump-curve" ? venue.curve : venue.pool;
  const pool = ref?.pools.find((p) => p.address === venueAddr && p.venue === venue.kind);
  if (amount !== req.spend) fail("QUOTE", `the reference is for ${amount} lamports, not the spend ${req.spend}`);
  else if (!pool) fail("QUOTE", `no reference read for ${venueAddr} on two providers`);
  else if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) fail("QUOTE", "slippage out of range");
  else {
    const floor = (pool.expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
    if (req.minOut < floor || req.minOut === 0n) fail("QUOTE", `min out ${req.minOut} under ${floor} (E ${pool.expectedOut}, slippage ${slippageBps} bps)`);
    else pass("QUOTE", `min out ${req.minOut} >= ${floor} (E ${pool.expectedOut})`);
  }
  return done();
}

/** A lookup table read the way the check wants it, from a getAccountInfo base64 value. */
export function solanaPoolTableRead(value: { owner: string; data: [string, "base64"] } | null): { owner: string; data: Uint8Array } | null {
  return value ? { owner: value.owner, data: base64.decode(value.data[0]) } : null;
}
