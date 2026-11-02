// The sandbox's door into send.ts (contracts/vault/tests/relayer_send.rs): one process carries the requests it is given
// against a NEAR RPC with a relayer key made by the sandbox, through the real createSendReads, startRelayer and
// createFileStore, so every process start is a restart of the relayer on the same store.
//   stdin: {"rpc":[a,b],"vault","token","relayer":{"account_id","secret_key"},"store","marginK","status":["ok"|"halted",...],
//           "requests":[{"signed_delegate"},...]}
//   stdout: {"answers":[{"status","body"},...],"record":<U's record or null>}
// `status` stands in for the token watch, which is not built (token-status/status.ts): each ask takes the next answer,
// the last repeats; its pause history is read from the token itself at the asked block (pausedAt below). The requests
// run at once.
import { readFileSync } from "node:fs";
import { decodeSignedDelegate } from "../../src/bind/checks.ts";
import { USDC_PAUSED, carryDeposit, createFileStore, createSendReads, nearRpc, startRelayer } from "../../src/bind/send.ts";
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
// The watch's pause history stands in as a read of the token at that block: USDC answers every call, its views
// included, with "FiatToken: paused" while paused; the mock token never pauses. nearcore answers a view that panicked
// with a result holding `error` (no `result` bytes), or with an RPC error: both are read.
const pausedAt = async (height: bigint): Promise<boolean | null> => {
  let res: unknown;
  try {
    res = await rpcs[0]("query", { request_type: "call_function", block_id: Number(height), account_id: input.token, method_name: "ft_balance_of", args_base64: Buffer.from(JSON.stringify({ account_id: input.vault })).toString("base64") });
  } catch (e) {
    if (String(e instanceof Error ? e.message : e).includes(USDC_PAUSED)) return true;
    throw e;
  }
  const r = res as { result?: unknown; error?: unknown };
  if (Array.isArray(r.result)) return false;
  if (typeof r.error === "string" && r.error.includes(USDC_PAUSED)) return true;
  throw new Error(`pausedAt ${height}: ${JSON.stringify(res).slice(0, 300)}`);
};
const deps = {
  cfg: { vault: input.vault, token: input.token, marginK: BigInt(input.marginK) },
  reads: createSendReads(rpcs, { vault: input.vault, token: input.token }),
  store,
  // the sandbox node keeps every block, so it stands in for the archival provider too
  // the validity period read live from both providers (EXPERIMENTAL_protocol_config), as the relayer starts
  // the relayer key's nonce counter and the blocks D it found live in the same store, so a restart signs the next nonce
  relayer: await startRelayer(rpcs, rpcs[0], input.relayer.account_id, input.relayer.secret_key, input.vault, store),
  tokenStatus,
  pausedAt,
};
const answers = await Promise.all(
  input.requests.map((r) =>
    carryDeposit(r, deps).catch((e: unknown) => ({ status: 500, body: { error: { code: "internal" } }, thrown: e instanceof Error ? e.message : String(e) })),
  ),
);
const u = input.requests.length > 0 ? decodeSignedDelegate(new Uint8Array(Buffer.from(input.requests[0]!.signed_delegate, "base64"))).sender_id : null;
process.stdout.write(JSON.stringify({ answers, record: u === null ? null : store.get(u) }) + "\n");
