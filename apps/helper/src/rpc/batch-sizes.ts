// Each upstream's most calls a JSON-RPC batch (card helper-rpc-batch-learns-reader-size): one map for every helper path
// that posts a batch (rpc.ts fitPost for /v1/rpc, data/evm/lists.ts batch for the maker reads, data/evm/swaps.ts one for
// the tapes), so an upstream that refused one path's batch for its size is sent every path's at the size it takes. The
// refusal is read by the kit's one rule (evmBatchSizeRefusal) and the size after it is the kit's (evmBatchFit: half, or
// the maximum the refusal named where smaller), as the device's EVM reads keep theirs (packages/kit/src/checks/evm/pace.ts).
import { evmBatchFit, evmBatchSizeRefusal } from "@blindfill/kit";

/** The most of an answer read for a batch-size refusal's words: a refusal of a 10-call batch is under 2 KB (dRPC's, one
 *  error a call); a larger body is an answer, never a refusal's words. [design: 64 KiB.] */
export const SIZE_WORDS_MAX = 64 * 1024;

/** A refused post's body read for its words, at most SIZE_WORDS_MAX bytes: undefined (the rest cancelled) past that or
 *  on a read error, so a hostile upstream's endless 4xx body is never held whole. */
export async function readWords(r: Response): Promise<string | undefined> {
  if (Number(r.headers.get("content-length") ?? "0") > SIZE_WORDS_MAX) {
    await r.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString("utf8");
      n += value.byteLength;
      if (n > SIZE_WORDS_MAX) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
}

/**
 * Whether an upstream's answer to a post of `n` calls refuses it for its size: the maximum it names (null: none named),
 * or undefined when it is no size refusal. A post of one call never is (no split makes it smaller). An HTTP 413 is one
 * whatever its body; a 4xx (a 429 among them: Sentio's code 8) or a 200 is one where its error names a batch maximum and
 * no rate limit's words (evmBatchSizeRefusal). `text`: the body read, undefined when it was not (past its size).
 * Mainnet's, read 2026-11-18 20:41Z and 23:20Z: base and robinhood .api.pocket.network 413 plain text past 5,
 * robinhood.daybreak-rpc.network 413 "batch too large: max 20 calls", robinhood.drpc.org 400 code 31 past 3,
 * rpc.sentio.xyz/base 429 code 8 "JSON-RPC batch exceeds the maximum of 5 requests".
 */
export function batchRefusal(status: number, text: string | undefined, n: number): number | null | undefined {
  if (n <= 1) return undefined;
  if (!((status >= 400 && status < 500) || status === 200)) return undefined;
  const words = text !== undefined && text.length <= SIZE_WORDS_MAX ? text : undefined;
  // a 200 is read for the words only where it names a batch: an answer's results are never parsed twice for it
  const said = words === undefined || (status === 200 && !/batch/i.test(words)) ? undefined : evmBatchSizeRefusal(words);
  if (said !== undefined) return said;
  return status === 413 ? null : undefined;
}

/** A map of upstream URL to the most calls a batch it takes, once it refused one for its size. */
export type BatchSizes = {
  /** The most calls a batch to `url`: Infinity until it refused one. */
  most(url: string): number;
  /** `url` refused a batch of `n` calls for its size, naming `said` (null: none): its most from now (evmBatchFit, never
   *  more than an earlier refusal set), returned. */
  refused(url: string, n: number, said: number | null): number;
};
export function batchSizes(): BatchSizes {
  const most = new Map<string, number>();
  return {
    most: (url) => most.get(url) ?? Infinity,
    refused(url, n, said) {
      const m = Math.min(most.get(url) ?? Infinity, evmBatchFit(n, said));
      most.set(url, m);
      return m;
    },
  };
}
/** The helper's one map, for the process's life: every path's default (a test passes its own, or a URL of its own). */
export const BATCH_SIZES: BatchSizes = batchSizes();
