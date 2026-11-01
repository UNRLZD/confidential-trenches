// The sandbox's door into send.ts (contracts/vault/tests/relayer_send.rs): one process carries the requests it is given
// against a NEAR RPC with a relayer key made by the sandbox, through the real createSendReads, createRelayer and
// createFileStore, so every process start is a restart of the relayer on the same store.
//   stdin: {"rpc":[a,b],"vault","token","relayer":{"account_id","secret_key"},"store","marginK","status":["ok"|"halted",...],
//           "requests":[{"signed_delegate"},...]}
//   stdout: {"answers":[{"status","body"},...],"record":<U's record or null>}
// `status` stands in for the token watch, which is not built (token-status/status.ts): each ask takes the next answer,
// the last repeats. The requests run at once.
import { readFileSync } from "node:fs";
import { decodeSignedDelegate } from "../../src/bind/checks.ts";
import { carryDeposit, createFileStore, createRelayer, createSendReads, nearRpc } from "../../src/bind/send.ts";
import { USDC_CODE_HASH, type TokenStatus } from "../../src/token-status/status.ts";

type Input = {
  rpc: [string, string];
  vault: string;
  token: string;
  relayer: { account_id: string; secret_key: string };
  store: string;
  marginK: string;
  status: ("ok" | "halted")[];
  requests: { signed_delegate: string }[];
};
const input = JSON.parse(readFileSync(0, "utf8")) as Input;
const rpcs = [nearRpc(input.rpc[0]), nearRpc(input.rpc[1])] as const;
const store = createFileStore(input.store);
let asks = 0;
const tokenStatus = async (): Promise<TokenStatus> => {
  const s = input.status[Math.min(asks++, input.status.length - 1)] ?? "halted";
  // the watch's answer as of the newest final height: caught up to it
  const block_height = Number((await rpcs[0]("block", { finality: "final" }) as { header: { height: number } }).header.height);
  return { token: input.token, caught_up: true, halted: s === "halted", vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height, last_event: null };
};
const deps = {
  cfg: { vault: input.vault, token: input.token, marginK: BigInt(input.marginK) },
  reads: createSendReads(rpcs, { vault: input.vault, token: input.token }),
  store,
  relayer: createRelayer(rpcs, input.relayer.account_id, input.relayer.secret_key, input.vault),
  tokenStatus,
};
const answers = await Promise.all(
  input.requests.map((r) =>
    carryDeposit(r, deps).catch((e: unknown) => ({ status: 500, body: { error: { code: "internal" } }, thrown: e instanceof Error ? e.message : String(e) })),
  ),
);
const u = input.requests.length > 0 ? decodeSignedDelegate(new Uint8Array(Buffer.from(input.requests[0]!.signed_delegate, "base64"))).sender_id : null;
process.stdout.write(JSON.stringify({ answers, record: u === null ? null : store.get(u) }) + "\n");
