// The helper's EVM sender against a real node (card helper-pool-senders): anvil --chain-id 31337, then
//   node apps/helper/test/pool-evm/anvil.ts http://127.0.0.1:<port>
// The epoch's fee is read from the epoch's first block (the same for a second sender); two withdraws at that fee go
// through evmPoolSender: chain id from both providers, the pending nonce, the gas price capped at fee / gas limit, the
// signed type-2 transaction, eth_sendRawTransaction. Each mined transaction must read back from the sender, to the
// pool, with input equal to the calldata received, status 1, consecutive nonces, maxFeePerGas x gas at most the fee;
// the first nullifier sent again must answer its first hash and send nothing. Each send passes the M356 checks on a real
// node: the recipient's code read at pending and latest, then eth_call at pending with the gas and fee fields it signs
// (anvil-grief.ts shows what they refuse). The pool's code here answers every call with one word, its tree depth 2,
// so the call is accepted as is: this proves the fee's reads, the send and the signature, not the pool's withdraw
// (pool-evm-core's forge tests do).
// The sender key is a test key: sha256("helper-pool-senders/test-key/EVM_SENDER"), funded by anvil_setBalance.
import { createHash } from "node:crypto";
import { evmAddressOf, evmPoolSender, WITHDRAW_SELECTOR } from "../../src/pool/evm.ts";
import { epochStartOf } from "../../src/pool/fee.ts";

const url = process.argv[2]!;
const call = async (method: string, params: readonly unknown[]): Promise<any> => {
  const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(`RPC error ${r.error.code}: ${String(r.error.message).slice(0, 120)}`); // the kit client's wording
  return r.result;
};
const KEY = new Uint8Array(createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest());
const sender = evmAddressOf(KEY);
await call("anvil_setBalance", [sender, "0xde0b6b3a7640000"]);
const POOL = "0x00000000000000000000000000000000b1f1f001";
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const FLOOR = 10n ** 12n;
const w32 = (n: bigint) => n.toString(16).padStart(64, "0");
const a32 = (a: string) => a.slice(2).padStart(64, "0");
// the fee's reads (kit trade/evm/pool-fee.ts) as a real node answers them at the epoch block's hash: Base Sepolia's
// GasPriceOracle predeploy, here code returning one word, 7,917 wei, for its L1 fee bound and its operator fee alike
const WORD = (n: bigint) => `0x7f${n.toString(16).padStart(64, "0")}60005260206000f3`; // PUSH32 n, MSTORE, RETURN 32 bytes
await call("anvil_setCode", ["0x420000000000000000000000000000000000000f", WORD(7_917n)]);
// the pool: code answering every call with one word, 2, its tree depth (currentTreeDepth) and an accepted withdraw
await call("anvil_setCode", [POOL, WORD(2n)]);
const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [call, (m, p) => call(m, p)]);
// a block in the epoch now, then that epoch's fee, as a device reads it before it proves
await call("evm_mine", []);
const epoch = epochStartOf(Date.now());
const published = await s.fee(epoch);
const again = await evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [call, (m, p) => call(m, p)]).fee(epoch);
let ok = published !== null && JSON.stringify(published) === JSON.stringify(again);
console.log(`${ok ? "ok " : "BAD"} epoch ${epoch} fee ${published?.fee} wei from block ${published?.block}, the same for a second sender`);
const FEE = BigInt(published?.fee ?? "0");
/** withdraw's calldata: nullifier `nf`, the epoch's fee, a deadline 270 s after the epoch's start. */
const dataOf = (nf: bigint) => {
  const proof = Array.from({ length: 16 }, (_, i) => w32(i === 9 ? nf : BigInt(i + 1))).join("");
  const relay = [a32("0x0000000000000000000000000000000000000a11"), a32(FEE_TO), w32(10n ** 16n), w32(BigInt(epoch + 270_000)), w32(5n), "c9ebb52422ed595de60e051c69edee1a".padEnd(64, "0")].join("");
  return `0x${WITHDRAW_SELECTOR}${w32(576n)}${proof}${w32(FEE)}${a32(POOL)}${w32(64n)}${w32(192n)}${relay}`;
};
const nonces: number[] = [];
const hashes: string[] = [];
for (let i = 0; i < 2; i++) {
  const data = dataOf(BigInt(100 + i));
  const t0 = performance.now();
  const a = await s.carry({ pool: POOL, data, epoch });
  const ms = Math.round(performance.now() - t0);
  const h = (a.body as { hash?: string }).hash;
  if (a.status !== 200 || !h) {
    console.log(`BAD carry ${i}: ${a.status} ${JSON.stringify(a.body)}`);
    ok = false;
    continue;
  }
  hashes.push(h);
  const tx = await call("eth_getTransactionByHash", [h]);
  let rc = await call("eth_getTransactionReceipt", [h]);
  for (let t = 0; rc === null && t < 20; t++) {
    await new Promise((r) => setTimeout(r, 100)); // anvil mines on send, its receipt can trail by a moment
    rc = await call("eth_getTransactionReceipt", [h]);
  }
  const most = BigInt(tx.maxFeePerGas) * BigInt(tx.gas);
  const good = tx.from === sender && tx.to === POOL && tx.input === data && tx.type === "0x2" && rc?.status === "0x1" && tx.chainId === "0x7a69" && most <= FEE;
  nonces.push(Number(tx.nonce));
  console.log(`${good ? "ok " : "BAD"} carry ${i} in ${ms} ms: ${h} from ${tx.from} to ${tx.to} type ${tx.type} nonce ${Number(tx.nonce)} status ${rc?.status} input ${tx.input === data ? "= calldata" : "CHANGED"}, most gas ${most} <= fee ${FEE}`);
  ok &&= good;
}
ok &&= nonces.length === 2 && nonces[1] === nonces[0]! + 1;
// the first release again: answered with its first hash, nothing sent
const count = Number(await call("eth_getTransactionCount", [sender, "latest"]));
const repeat = await s.carry({ pool: POOL, data: dataOf(100n), epoch });
const after = Number(await call("eth_getTransactionCount", [sender, "latest"]));
const same = (repeat.body as { hash?: string }).hash === hashes[0] && after === count;
console.log(`${same ? "ok " : "BAD"} the first nullifier again: ${JSON.stringify(repeat.body)}, ${after - count} sent`);
ok &&= same;
console.log(ok ? "PASS pool-evm-anvil" : "FAIL pool-evm-anvil");
process.exit(ok ? 0 : 1);
