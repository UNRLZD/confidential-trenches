// The sandbox's door into create.ts (contracts/vault/tests/relayer_send.rs, case `create_after_delivery_usdc`): one
// process asks createOnDelivery for the ids it is given, at once, against a NEAR RPC with a relayer key made by the
// sandbox, through the real deliveryReads, startRelayer and createFileStore, so every process start is a restart of
// the relayer on the same store.
//   stdin: {"rpc":[a,b],"vault","token","relayer":{"account_id","secret_key"},"store","ids":[...],"waitMs"?:n}
//   stdout: {"answers":[{code, tx_hash?, why?},...],"records":[<each id's creation record or null>]}
import { readFileSync } from "node:fs";
import { createOnDelivery, deliveryReads } from "../../src/bind/create.ts";
import { createFileStore, nearRpc, startRelayer } from "../../src/bind/send.ts";

type Input = { rpc: [string, string]; vault: string; token: string; relayer: { account_id: string; secret_key: string }; store: string; ids: string[]; waitMs?: number };
const input = JSON.parse(readFileSync(0, "utf8")) as Input;
const rpcs = [nearRpc(input.rpc[0]), nearRpc(input.rpc[1])] as const;
const store = createFileStore(input.store);
// the sandbox node keeps every block, so it stands in for the archival provider too
const relayer = await startRelayer(rpcs, null, input.relayer.account_id, input.relayer.secret_key, input.vault, store, input.waitMs);
const deps = { token: input.token, delivery: deliveryReads(rpcs, input.token), store, relayer };
const answers = await Promise.all(input.ids.map((id) => createOnDelivery(id, deps).catch((e: unknown) => ({ code: "internal", why: e instanceof Error ? e.message : String(e) }))));
process.stdout.write(JSON.stringify({ answers, records: input.ids.map((id) => (/^[0-9a-f]{64}$/.test(id) ? store.creation(id) : null)) }) + "\n");
