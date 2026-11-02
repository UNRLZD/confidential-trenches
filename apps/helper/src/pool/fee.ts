// GET /v1/pool/fee (card helper-pool-senders; M350 (1), M351 (5)): the relayer's one fee per pool per epoch, in coarse
// steps, the same for every caller. A device binds this fee into every proof it makes for the epoch, so every proof of
// an epoch carries the same relay_fee and no fee tells one user's releases apart. The send routes refuse a release
// whose relay_fee is not the fee published for its epoch (./solana.ts).
//
// The fee is the host's (POOL_SOLANA_FEE_<CLUSTER>), rounded up to POOL_FEE_STEP, and it is the same in every epoch of
// one running release: no caller, request or load moves it, so the answer for an epoch never differs between callers.
// It must cover the fee payer's cost of the average release (SOLANA_RELEASE_COST, M352 (1)); a fee under it stops the
// helper at start. The one release in 1,024 whose change note opens a page costs the fee payer 731,520 more, about 714
// a release on average, which the 100,000 step's rounding carries; charging every release that worst case would
// overcharge the other 1,023.

/** The epoch, ms of chain time (M350 (1)). */
export const POOL_EPOCH_MS = 60_000;
/** The coarse step every Solana fee is rounded up to, lamports [design: 0.0001 SOL, so a fee change is a visible step]. */
export const POOL_FEE_STEP = 100_000n;

/**
 * Mainnet rent, read on two RPCs on 2 Nov 2026 by card pool-sol-core (contracts/pool-solana/src/release.rs row 8):
 * 650,240 lamports for an empty account, 5,080 per byte, so rent(n) = (128 + n) x 5,080. Devnet and testnet share the
 * same rent parameters.
 */
export const SOLANA_RENT_PER_BYTE = 5_080n;
export const SOLANA_ACCOUNT_OVERHEAD = 128n;
export const solanaRent = (bytes: number): bigint => (SOLANA_ACCOUNT_OVERHEAD + BigInt(bytes)) * SOLANA_RENT_PER_BYTE;
/** A page entry (leaf, root, chain time) and a page's header, bytes (contracts/pool-solana/src/state.rs). */
export const SOLANA_PAGE_ENTRY = 72;
export const SOLANA_PAGE_HEADER = 16;
/** Lamports per signature, and the two signatures of a pool transaction (the fee payer and W). */
export const SOLANA_SIGNATURE_FEE = 5_000n;
/**
 * The fee payer's cost of a release before any priority fee: the spent mark (an empty account), the change note's page
 * entry (72 x 5,080) and two signatures: 650,240 + 365,760 + 10,000 = 1,026,000 lamports (release.rs row 8's figure).
 * The relay fee is held at or above this plus the transaction's priority fee (./solana.ts).
 */
export const SOLANA_RELEASE_COST = solanaRent(0) + BigInt(SOLANA_PAGE_ENTRY) * SOLANA_RENT_PER_BYTE + 2n * SOLANA_SIGNATURE_FEE;
/** The same when the change note opens a page (16 + 72 bytes): 1,757,520. The helper carries it at the published fee. */
export const SOLANA_PAGE_RELEASE_COST = solanaRent(0) + solanaRent(SOLANA_PAGE_HEADER + SOLANA_PAGE_ENTRY) + 2n * SOLANA_SIGNATURE_FEE;

export type PoolFeeAnswer = {
  chain: "solana";
  cluster: string;
  program: string;
  pool: string;
  /** The fee payer: the payer and the pool's account 2, which the proof's context binds. */
  fee_payer: string;
  epoch_ms: number;
  epoch_start_ms: number;
  fee: string;
  step: string;
};

/** A fee from the host: whole lamports, refused under a release's cost, then rounded up to the step. */
export function solanaPoolFee(raw: string, what: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(raw)) throw new Error(`${what} must be a whole number of lamports`);
  if (BigInt(raw) < SOLANA_RELEASE_COST) throw new Error(`${what} must cover a release's cost, ${SOLANA_RELEASE_COST} lamports`);
  return ((BigInt(raw) + POOL_FEE_STEP - 1n) / POOL_FEE_STEP) * POOL_FEE_STEP;
}

/** The start of the epoch holding `ms`. */
export const epochStartOf = (ms: number): number => ms - (ms % POOL_EPOCH_MS);
