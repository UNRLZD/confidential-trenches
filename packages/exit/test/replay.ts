// Recorded RPC answers, for the offline tests: each RPC answers a query only from its own recording, by the query's
// exact params, and refuses any other (so a test never reaches a network). scripts/record-pages.ts writes the file.
import type { VaultSyncRpc } from "@blindfill/kit";

/** One RPC's recording: [the query's params as JSON, its whole JSON-RPC answer], in the order asked. */
export type Recording = { url: string; answers: [string, unknown][] };
export type PagesFile = { network: "testnet" | "mainnet"; vault: string; recordedAt: string; rpcs: [Recording, Recording] };

/** An RPC that answers from `rec`; `edit` may change an answer (a deep copy) before it is given. */
export function replayRpc(rec: Recording, edit?: (params: string, answer: unknown) => unknown): VaultSyncRpc {
  const book = new Map(rec.answers);
  return {
    name: rec.url,
    async query(params) {
      const key = JSON.stringify(params);
      if (!book.has(key)) throw new Error(`not recorded: ${key}`);
      const answer = structuredClone(book.get(key));
      return edit ? edit(key, answer) : answer;
    },
  };
}

/** An RPC that records what `rpc` answers into `rec`. */
export function recordRpc(rpc: VaultSyncRpc, rec: Recording): VaultSyncRpc {
  return {
    name: rpc.name,
    async query(params, signal) {
      const answer = await rpc.query(params, signal);
      rec.answers.push([JSON.stringify(params), structuredClone(answer)]);
      return answer;
    },
  };
}
