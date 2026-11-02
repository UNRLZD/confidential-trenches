// GET /v1/pool/fee (card helper-pool-senders; M350 (1), M351 (5)): the relayer's one fee per pool per epoch, in coarse
// steps, the same for every caller. A device binds this fee into every proof it makes for the epoch, so every proof of
// an epoch carries the same relay_fee and no fee tells one user's releases apart. The send routes refuse a release
// whose relay_fee is not the fee published for its epoch (./solana.ts).
//
// The fee is the host's (POOL_SOLANA_FEE_<CLUSTER>), rounded up to POOL_FEE_STEP, and it is the same in every epoch of
// one running release: no caller, request or load moves it, so the answer for an epoch never differs between callers.
// It must cover the fee payer's worst cost per release (SOLANA_RELEASE_COST_MAX), so the helper never pays a release's
// rent out of its own gas; a fee under it stops the helper at start.

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
 * The fee payer's worst cost per release before any priority fee: the spent mark (an empty account), the change note's
 * page when it opens one (16 + 72 bytes; an entry, 72 x 5,080, otherwise) and two signatures:
 * 650,240 + 1,097,280 + 10,000 = 1,757,520 lamports (release.rs row 8's figure). The published fee is held at or above
 * this plus the transaction's priority fee (./solana.ts), so the one release in 1,024 that opens a page is carried too.
 */
export const SOLANA_RELEASE_COST_MAX = solanaRent(0) + solanaRent(SOLANA_PAGE_HEADER + SOLANA_PAGE_ENTRY) + 2n * SOLANA_SIGNATURE_FEE;

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

/** A fee from the host: whole lamports, rounded up to the step, refused under the worst release cost. */
export function solanaPoolFee(raw: string, what: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(raw)) throw new Error(`${what} must be a whole number of lamports`);
  const fee = ((BigInt(raw) + POOL_FEE_STEP - 1n) / POOL_FEE_STEP) * POOL_FEE_STEP;
  if (fee < SOLANA_RELEASE_COST_MAX) throw new Error(`${what} must cover a release's worst cost, ${SOLANA_RELEASE_COST_MAX} lamports`);
  return fee;
}

/** The start of the epoch holding `ms`. */
export const epochStartOf = (ms: number): number => ms - (ms % POOL_EPOCH_MS);
