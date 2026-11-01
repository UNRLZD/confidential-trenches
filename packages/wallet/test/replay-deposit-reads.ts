// U's reads on two RPCs, replayed from test/vectors/deposit-account.json (real mainnet answers, 2026-11-01T08:03Z) under
// the network's own RPC names: the good account's key list with its key edited to `publicKey`, its USDC, and USDC's
// code hash (the testnet token's equals the pin). `edit` changes a copy of an answer; `sent` collects every request.
import { readFileSync } from "node:fs";
import { NEAR_NETWORKS, type NearNetwork, type NearRpc } from "../src/deposit/account.ts";

type Answer = { json: unknown };
const REC = JSON.parse(readFileSync(new URL("./vectors/deposit-account.json", import.meta.url), "utf8")) as { answers: Record<string, { a: Answer; b: Answer }> };
export type ReadKind = "keys" | "balance" | "code";
export function replayDepositReads(
  network: NearNetwork,
  publicKey: string,
  { keys = "keys_good", edit = () => {}, sent = [] }: { keys?: string; edit?: (kind: ReadKind, j: any) => void; sent?: unknown[] } = {},
): [NearRpc, NearRpc] {
  const net = NEAR_NETWORKS[network];
  const one = (side: "a" | "b", name: string): NearRpc => ({
    name,
    async query(params) {
      sent.push(params);
      const kind: ReadKind = params.request_type === "view_access_key_list" ? "keys" : params.request_type === "call_function" ? "balance" : "code";
      const pick = kind === "keys" ? keys : kind === "balance" ? "balance_good" : "code";
      const j = structuredClone(REC.answers[pick]![side].json) as any;
      if (pick === "keys_good") j.result.keys[0].public_key = publicKey;
      edit(kind, j);
      return j;
    },
  });
  return [one("a", net.fastnear[0]), one("b", net.drpc)];
}
