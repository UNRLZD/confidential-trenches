// The helper's EVM sender against a real node (card helper-pool-senders): anvil --chain-id 31337, then
//   node apps/helper/test/pool-evm/anvil.ts http://127.0.0.1:<port>
// Two withdraws go through evmPoolSender: chain id from both providers, the pending nonce, the fees, the signed type-2
// transaction, eth_sendRawTransaction. Each mined transaction must read back from the sender, to the pool, with input
// equal to the calldata received, status 1, consecutive nonces. The pool address holds no code here, so the call is
// accepted as is: this proves the send and the signature, not the pool's withdraw (pool-evm-core's forge tests do).
// The sender key is a test key: sha256("helper-pool-senders/test-key/EVM_SENDER"), funded by anvil_setBalance.
import { createHash } from "node:crypto";
import { evmAddressOf, evmPoolSender, WITHDRAW_SELECTOR } from "../../src/pool/evm.ts";

const url = process.argv[2]!;
const call = async (method: string, params: readonly unknown[]): Promise<any> => {
  const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result;
};
const KEY = new Uint8Array(createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest());
const sender = evmAddressOf(KEY);
await call("anvil_setBalance", [sender, "0xde0b6b3a7640000"]);
const POOL = "0x00000000000000000000000000000000b1f1f001";
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const FEE = 1_000_000_000_000_000n;
const w32 = (n: bigint) => n.toString(16).padStart(64, "0");
const a32 = (a: string) => a.slice(2).padStart(64, "0");
const proof = Array.from({ length: 16 }, (_, i) => w32(BigInt(i + 1))).join("");
const relay = [a32("0x0000000000000000000000000000000000000a11"), a32(FEE_TO), w32(10n ** 16n), w32(2_000_000_000_000n), w32(5n), "c9ebb52422ed595de60e051c69edee1a".padEnd(64, "0")].join("");
const data = `0x${WITHDRAW_SELECTOR}${w32(576n)}${proof}${w32(FEE)}${a32(POOL)}${w32(64n)}${w32(192n)}${relay}`;
const s = evmPoolSender({ network: "anvil", pool: POOL, senderKey: KEY, fee: FEE, feeRecipient: FEE_TO }, [call, (m, p) => call(m, p)]);
let ok = true;
const nonces: number[] = [];
for (let i = 0; i < 2; i++) {
  const t0 = performance.now();
  const a = await s.carry({ pool: POOL, data });
  const ms = Math.round(performance.now() - t0);
  const h = (a.body as { hash?: string }).hash;
  if (a.status !== 200 || !h) {
    console.log(`BAD carry ${i}: ${a.status} ${JSON.stringify(a.body)}`);
    ok = false;
    continue;
  }
  const tx = await call("eth_getTransactionByHash", [h]);
  let rc = await call("eth_getTransactionReceipt", [h]);
  for (let t = 0; rc === null && t < 20; t++) {
    await new Promise((r) => setTimeout(r, 100)); // anvil mines on send, its receipt can trail by a moment
    rc = await call("eth_getTransactionReceipt", [h]);
  }
  const good = tx.from === sender && tx.to === POOL && tx.input === data && tx.type === "0x2" && rc?.status === "0x1" && tx.chainId === "0x7a69";
  nonces.push(Number(tx.nonce));
  console.log(`${good ? "ok " : "BAD"} carry ${i} in ${ms} ms: ${h} from ${tx.from} to ${tx.to} type ${tx.type} nonce ${Number(tx.nonce)} status ${rc?.status} input ${tx.input === data ? "= calldata" : "CHANGED"}`);
  ok &&= good;
}
ok &&= nonces.length === 2 && nonces[1] === nonces[0]! + 1;
console.log(ok ? "PASS pool-evm-anvil" : "FAIL pool-evm-anvil");
process.exit(ok ? 0 : 1);
