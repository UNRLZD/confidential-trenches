// Recorded Solana RPC answers, for the offline tests of the Solana pool scan (card exit-pool-notes). A lister answers
// getProgramAccounts only from its recording, by the call's exact params. A reader answers getMultipleAccounts for any
// addresses from every account its recording holds (null for one it never gave), at its highest recorded slot (or the minContextSlot asked, when past it), so a
// test can plant a lie (a made-up address, a hidden mark) and the read goes on as it would on a real RPC. Any other call
// is refused, so a test never reaches a network. scripts/record-sol.ts writes the file.
import type { SolanaRpc } from "@blindfill/kit";

/** One RPC's recording: [JSON of [method, params], its answer], in the order asked. */
export type SolRecording = { url: string; answers: [string, unknown][] };
export type SolFile = { cluster: "devnet" | "mainnet"; program: string; recordedAt: string; lister: SolRecording; rpcs: [SolRecording, SolRecording] };

type Account = { owner: string; data: [string, string] } & Record<string, unknown>;

/** An RPC that records what `rpc` answers into `rec`, its URL kept. */
export function recordSolRpc(rpc: SolanaRpc, rec: SolRecording): SolanaRpc {
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const answer = await rpc(method, params);
    rec.answers.push([JSON.stringify([method, params]), structuredClone(answer)]);
    return answer;
  };
  return Object.assign(f, { url: rpc.url ?? rec.url });
}

/** An RPC answering from `rec`; `edit` may change an answer (a deep copy) before it is given. */
export function replaySolRpc(rec: SolRecording, edit?: (method: string, params: readonly unknown[], answer: unknown) => unknown): SolanaRpc {
  const book = new Map(rec.answers);
  const accounts = new Map<string, Account>();
  let slot = 0;
  for (const [key, answer] of rec.answers) {
    const [method, params] = JSON.parse(key) as [string, unknown[]];
    if (method !== "getMultipleAccounts") continue;
    const a = answer as { context: { slot: number }; value: (Account | null)[] };
    slot = Math.max(slot, a.context.slot);
    (params[0] as string[]).forEach((address, i) => {
      const acc = a.value[i];
      if (acc) accounts.set(address, acc);
    });
  }
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    let answer: unknown;
    // at the slot asked for when it is past the recording's (the recorded accounts are the newest it has)
    if (method === "getMultipleAccounts") answer = { context: { slot: Math.max(slot, (params[1] as { minContextSlot?: number }).minContextSlot ?? 0) }, value: (params[0] as string[]).map((x) => structuredClone(accounts.get(x) ?? null)) };
    else {
      const key = JSON.stringify([method, params]);
      if (!book.has(key)) throw new Error(`not recorded: ${key}`);
      answer = structuredClone(book.get(key));
    }
    return edit ? edit(method, params, answer) : answer;
  };
  return Object.assign(f, { url: rec.url });
}
