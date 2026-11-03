// GET /v1/pool/fee (card helper-pool-senders; M350 (1), M351 (5)): the relayer's one fee per pool per epoch, in coarse
// steps, the same for every caller. A device binds this fee into every proof it makes for the epoch, so every proof of
// an epoch carries the same relay_fee and no fee tells one user's releases apart. The send routes refuse a release
// whose relay_fee is not the fee published for its epoch (./solana.ts).
//
// The fee is the kit's one definition, solanaPoolFee(rent) (M355 (2)): the release's cost (solanaPoolReleaseCost: the
// spent mark's rent with its 13 bytes, withdrawnValue, the release's number and the tag; the change note's page entry;
// two signatures; 1,092,040 at mainnet rent)
// rounded up to the 100,000 step, plus two steps: 1,300,000. The helper reads the rent on both providers once an epoch
// (./solana.ts) and computes the fee from it, as the device does, so one epoch's answer never differs between callers
// and a Rent sysvar change moves the fee at the next epoch with no restart. The host also sets it
// (POOL_SOLANA_FEE_<CLUSTER>): the helper starts only when that equals the kit's number for the rent read at start. A priority fee W sets is carried up
// to solanaPoolPriorityBudget (the fee less the cost and the page reserve, 715 a release, so the one release in 1,024
// whose change note opens a page is paid for by the others).

import { SOLANA_POOL_FEE_STEP } from "@blindfill/kit";

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

/** The start of the epoch holding `ms`. */
export const epochStartOf = (ms: number): number => ms - (ms % POOL_EPOCH_MS);

