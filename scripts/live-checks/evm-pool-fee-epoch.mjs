// The helper's GET /v1/pool/fee for an EVM pool, read so an epoch with no block yet is never a false red (card
// evm-fee-quiet-epoch). The helper prices an EVM epoch at its first block (apps/helper/src/pool/evm.ts feeOf); until its
// provider holds a block at or after the epoch's start it has no fee to give. From this card on it answers that as 503
// { error: { code: "index_behind" } } with Retry-After (apps/helper/src/server.ts), and a pool it does not carry stays
// 404 { error: { code: "not_found" } }. The helper before it answered both 404 not_found: helper live run 42726731385
// (10 Nov 00:15:00Z) asked robinhood-testnet's fee in the first half second of the minute and got 404, and the same
// request answered 200 two minutes later.
// Every EVM fee reader in scripts/live-checks asks through evmPoolFeeAsk: the epoch it asks (the helper's now, or the
// one it names), and on either of those two answers the epoch before it, whose first block the helper holds unless the
// chain made no block for a minute. A pool the helper does not carry answers 404 to both, so it still fails.
// Runs: no check of its own; the EVM fee readers import it, and evm-pool-fee-epoch.test.mjs holds its rules.

/** The helper's epoch grid and the oldest epoch it prices (apps/helper/src/pool/fee.ts POOL_EPOCH_MS, pool/evm.ts
 *  POOL_LIFE_MAX_MS). */
export const POOL_EPOCH_MS = 60_000;
export const POOL_LIFE_MAX_MS = 600_000;

/** The start of the epoch holding `ms`. */
export const epochOf = (ms) => ms - (ms % POOL_EPOCH_MS);

/** The body of an answer, parsed when it came as text. */
const bodyOf = (a) => {
  if (typeof a?.body !== "string") return a?.body;
  try {
    return JSON.parse(a.body);
  } catch {
    return null;
  }
};

/** Whether `a` ({ status, body }, the body parsed or as text) is the helper's "this epoch has no block yet": 503
 *  index_behind. */
export const noBlockYet = (a) => a?.status === 503 && bodyOf(a)?.error?.code === "index_behind";

/** Whether `a` is 404 not_found: a pool the helper does not carry, or, from the helper before card
 *  evm-fee-quiet-epoch, an epoch with no block yet. */
export const notFound = (a) => a?.status === 404 && bodyOf(a)?.error?.code === "not_found";

/** The fee URL for `pool`, at `epochMs` when given (the helper's now when not). */
export const feeUrl = (base, pool, epochMs) => `${String(base).replace(/\/$/, "")}/v1/pool/fee?pool=${encodeURIComponent(pool)}${epochMs === undefined ? "" : `&epoch=${epochMs}`}`;

/**
 * Asks `ask(url)` (the caller's own read: it returns the answer as the caller records it, with `status` and `body`) for
 * `pool`'s fee at `epochMs` (the helper's now when undefined). When that answer is the helper's no-block-yet (503
 * index_behind) or 404 not_found, asks once more for the epoch before it (`nowMs`'s epoch less one when no epoch was
 * named) and returns that answer. Returns { answer, epochMs, first }: the answer to judge, the epoch it is for (undefined:
 * the helper's now), and the first answer when a second was asked (else null).
 */
export async function evmPoolFeeAsk(ask, base, pool, { epochMs, nowMs = Date.now() } = {}) {
  const first = await ask(feeUrl(base, pool, epochMs));
  if (!noBlockYet(first) && !notFound(first)) return { answer: first, epochMs, first: null };
  const before = (epochMs ?? epochOf(nowMs)) - POOL_EPOCH_MS;
  return { answer: await ask(feeUrl(base, pool, before)), epochMs: before, first };
}
