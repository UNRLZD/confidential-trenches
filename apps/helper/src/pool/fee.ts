// GET /v1/pool/fee (card helper-pool-senders; M350 (1), M351 (5)): the relayer's one fee per pool per epoch, in coarse
// steps, the same for every caller. A device binds this fee into every proof it makes for the epoch, so every proof of
// an epoch carries the same relay_fee and no fee tells one user's releases apart. The send routes refuse a release
// whose relay_fee is not the fee published for its epoch (./solana.ts).
//
// The fee is the kit's one definition, solanaPoolFee(rent) (M355 (2)): the release's cost (solanaPoolReleaseCost: the
// spent mark's rent with its 8-byte value, the change note's page entry, two signatures; 1,066,640 at mainnet rent)
// rounded up to the 100,000 step, plus two steps: 1,300,000. The host sets it (POOL_SOLANA_FEE_<CLUSTER>) and the helper
// starts only when it equals the kit's number for the rent both providers read at start. It is the same in every epoch
// of one running release, so the answer for an epoch never differs between callers. A priority fee W sets is carried up
// to solanaPoolPriorityBudget (the fee less the cost and the page reserve, 715 a release, so the one release in 1,024
// whose change note opens a page is paid for by the others).

import { SOLANA_POOL_FEE_STEP, solanaPoolFee, type SolanaRent } from "@blindfill/kit";

/** The epoch, ms of chain time (M350 (1)). */
export const POOL_EPOCH_MS = 60_000;
/** The coarse step every Solana fee is on: the kit's SOLANA_POOL_FEE_STEP (0.0001 SOL). */
export const POOL_FEE_STEP = SOLANA_POOL_FEE_STEP;

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

/**
 * The host's configured fee (POOL_SOLANA_FEE_<CLUSTER>), held to the kit's one definition (M355 (2), M356 (6)): it must
 * be exactly solanaPoolFee(rent) for the rent both providers read at start, or the helper does not start. The device
 * computes the same number itself and refuses any other, so no configured value can mark one user by fee.
 */
export function solanaConfiguredFee(raw: string, rent: SolanaRent, what: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(raw)) throw new Error(`${what} must be a whole number of lamports`);
  const want = solanaPoolFee(rent);
  if (BigInt(raw) !== want) throw new Error(`${what} must be the kit's fee for this rent, ${want} lamports`);
  return want;
}

/** The start of the epoch holding `ms`. */
export const epochStartOf = (ms: number): number => ms - (ms % POOL_EPOCH_MS);

