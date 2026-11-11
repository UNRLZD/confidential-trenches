// Which providers a failed read names as not knowing a fresh block yet, for the live checks whose children run the
// wallet's own reads (no-old-state-live.ts, bind-fee-live.ts). A provider behind a block another provider just reported
// (Base makes one every 200 ms: release 116's sign live run 43024665974, "rpc 1 does not know block 56057679 yet") is
// that provider's moment, not the build's: the child reads under the wallet's evmRetryLag (EVM_LAG_TRIES reads
// EVM_LAG_WAIT_MS apart) and, when the provider still lags on the last read, records its hosts as `lagging`, which the
// check judges INCONCLUSIVE naming them. A provider that knows the block and answers wrong (another hash, another value,
// a pruned state) is never one of these: its read fails as before.
import { EvmLagError } from "../src/pool/evm.ts";

/** A provider's words for a block it does not know (the wallet's UNKNOWN_BLOCK, src/pool/evm.ts, module-private there;
 *  test/live-lag-hosts.test.ts fails when the two differ). */
export const UNKNOWN_BLOCK = /unknown block|header not found|block not found|no such block/i;

const host = (u: string | undefined) => {
  try {
    return new URL(String(u)).host;
  } catch {
    return String(u);
  }
};

/** A walk (the kit's evmTwoOperators) that found no two operators because every seat that refused it did not know the
 *  block: a lag, carrying those seats' hosts, so evmRetryLag reads again. */
export class WalkLagError extends EvmLagError {
  readonly hosts: readonly string[];
  constructor(m: string, hosts: readonly string[]) {
    super(m);
    this.hosts = hosts;
  }
}

/** `e` as a WalkLagError when it is a walk's EvmOperatorsUnanswered and every seat that refused it (`refused`: each seat's
 *  refusal words in this walk, by URL) said it does not know the block; else `e` as it is. */
export function walkLag(e: unknown, refused: ReadonlyMap<string, string>): unknown {
  if ((e as Error)?.name !== "EvmOperatorsUnanswered" || refused.size === 0) return e;
  const words = [...refused];
  if (!words.every(([, w]) => UNKNOWN_BLOCK.test(w))) return e;
  const hosts = words.map(([u]) => host(u));
  return new WalkLagError(`${hosts.join(", ")} did not know the block yet (${String((e as Error).message).slice(0, 160)})`, hosts);
}

/** The hosts a failed read names as not knowing a fresh block yet, or null: a WalkLagError's seats; the pool pair's seat
 *  k for the wallet's "rpc k does not know block n yet"; both seats for "an RPC has no <tag> block". Any other error (a
 *  reorg, two blocks at one height, a wrong answer) is null. */
export function laggingHosts(e: unknown, pair: readonly string[]): string[] | null {
  if (e instanceof WalkLagError) return [...e.hosts];
  if (!(e instanceof EvmLagError)) return null;
  const m = /\brpc ([01]) does not know block\b/.exec(e.message);
  if (m) return [host(pair[Number(m[1])])];
  if (/\ban RPC has no \S+ block\b/.test(e.message)) return pair.map(host);
  return null;
}
