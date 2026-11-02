// The sandbox's door into withdraw/send.ts (contracts/vault/tests/relayer_withdraw.rs): one process carries the requests
// it is given against a NEAR RPC with a relayer key made by the sandbox, through the real createSpendsIndex,
// createWithdrawSendStore, createFileStore (the key's nonce counter), startRelayer, carryWithdraw and outcomeRound, so
// every process start is a restart of the relayer on the same stores.
//   stdin: {"rpc":[a,b],"vault","token","scope","relayer":{"account_id","secret_key"},"store","nonces",
//           "status":["ok"|"halted",...],"requests":[{...}],"rounds"?:n,"roundMs"?:n,"feeMin"?:"<decimal>"}
//   stdout: {"answers":[{"status","body"}],"rows":{"<nullifier decimal>":<its send record or null>}}
// `status` stands in for the token watch (the event watch is not built): each ask takes the next answer, the last
// repeats. fee_min is the stand-in for the quoter (the sandbox has no price pool): 0 unless given. After the requests
// (sent at once), `rounds` outcome rounds run, `roundMs` apart, stopping early once every row is final and settled.
import { readFileSync } from "node:fs";
import { createFileStore, nearRpc, startRelayer } from "../../src/bind/send.ts";
import { USDC_CODE_HASH, type TokenStatus } from "../../src/token-status/status.ts";
import { createLeavesIndex, createSpendsIndex, createWithdrawSendStore } from "../../src/withdraw/index.ts";
import { carryWithdraw, outcomeRound, type WithdrawSendDeps } from "../../src/withdraw/send.ts";

type Input = {
  rpc: [string, string];
  vault: string;
  token: string;
  scope: string;
  relayer: { account_id: string; secret_key: string };
  store: string;
  nonces: string;
  status: ("ok" | "halted")[];
  requests: Record<string, unknown>[];
  rounds?: number;
  roundMs?: number;
  feeMin?: string;
};
const input = JSON.parse(readFileSync(0, "utf8")) as Input;
const rpcs = [nearRpc(input.rpc[0]), nearRpc(input.rpc[1])] as const;
const nonces = createFileStore(input.nonces);
const store = createWithdrawSendStore(input.store, { release: 1, keys: nonces });
const relayer = await startRelayer(rpcs, rpcs[0], input.relayer.account_id, input.relayer.secret_key, input.vault, nonces);
let asks = 0;
const tokenStatus = async (): Promise<TokenStatus> => {
  const s = input.status[Math.min(asks++, input.status.length - 1)] ?? "halted";
  return { token: input.token, caught_up: true, halted: s === "halted", vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: 1, last_event: null };
};
const deps: WithdrawSendDeps = {
  cfg: { vault: input.vault, token: input.token, scope: BigInt(input.scope), feeRecipient: input.relayer.account_id },
  rpcs,
  reads: { feeMin: async () => BigInt(input.feeMin ?? "0") },
  index: createSpendsIndex(rpcs, input.vault),
  leaves: createLeavesIndex(rpcs, input.vault),
  store,
  relayers: [relayer],
  tokenStatus,
};
// the restart's round first, before any request (send.ts startOutcomeRounds)
await outcomeRound(deps);
const answers = await Promise.all(input.requests.map((r) => carryWithdraw(r, deps)));
const nfs = input.requests.map((r) => BigInt(String((r.public_signals as unknown[] | undefined)?.[1] ?? "0")));
const done = () => nfs.every((nf) => {
  const row = store.get(nf);
  return row === null || (row !== "unreadable" && row.outcome !== "open" && (row.outcome !== "succeeded" || row.settle?.done === true));
});
for (let i = 0; i < (input.rounds ?? 0) && !done(); i++) {
  await new Promise((r) => setTimeout(r, input.roundMs ?? 1_000));
  await outcomeRound(deps);
}
const rows = Object.fromEntries(nfs.map((nf) => [nf.toString(), store.get(nf)]));
store.close();
console.log(JSON.stringify({ answers, rows }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
