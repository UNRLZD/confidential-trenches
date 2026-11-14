// The helper's pools of a token, asked beside the device's quote (card evm-pool-index-from-the-first-pool).
//
// The helper keeps every pool of the chain's PoolManager from its first block (helper data/evm/pool-index.ts) and
// answers a token's at GET /v1/market/pools. The quote's scan reaches only the venue's depth back, so a token whose only
// pool is older is held to that pool only through this answer. The page asks it as the quote starts, so it rides beside
// the quote's own reads, and hands it to the kit (evmPoolServedUse), which keeps a pool only where its key hashes to its
// id and the PoolManager holds it on both providers; an answer the helper marks partial, or none, leaves the quote on
// its own scan. The token page already asks the helper for this token's market data, so the ask tells it nothing new.
import { evmPoolServedUse } from "../../kit/src/checks/evm/quote.ts";

/** How long a token's answer is used before it is asked again. [design: a minute: a pool made since is in the scan's
 *  newest blocks, which the device reads itself.] */
export const EVM_SERVED_FRESH_MS = 60_000;
/** The longest the quote waits for the answer. [design: the helper answers from its own file, a few hundred ms from the
 *  device; past this the quote stands on its scan.] */
export const EVM_SERVED_WAIT_MS = 1_500;
/** The tokens whose last ask is remembered at once. */
const HELD = 256;
const askedAt = new Map<string, number>();

/** Asks the helper at `helper` for `token`'s pools on `chain` (Base and Robinhood) and hands the answer to the kit,
 *  unless asked within EVM_SERVED_FRESH_MS. */
export function evmServedAsk(fetchFn: typeof fetch, helper: string, chain: string, token: string, now = Date.now()): void {
  if ((chain !== "base" && chain !== "robinhood") || !/^0x[0-9a-fA-F]{40}$/.test(token)) return;
  const k = `${chain}:${token.toLowerCase()}`;
  if ((askedAt.get(k) ?? -Infinity) > now - EVM_SERVED_FRESH_MS) return;
  askedAt.delete(k);
  if (askedAt.size >= HELD) askedAt.delete(askedAt.keys().next().value!);
  askedAt.set(k, now);
  const answer = fetchFn(`${helper}/v1/market/pools?chain=${chain}&token=${token.toLowerCase()}`, { signal: AbortSignal.timeout(EVM_SERVED_WAIT_MS) }).then((r) => (r.ok ? r.json() : null));
  evmPoolServedUse(chain, token, answer);
}
/** For the tests: forgets every ask. */
export const evmServedReset = (): void => askedAt.clear();
