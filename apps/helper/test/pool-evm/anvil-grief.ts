// The review's grief demo (M356 (1), (2)), inverted: the helper never pays for a revert, and a fee that cannot be mined
// is refused rather than sent. Against a real node: anvil --chain-id 31337, then
//   node apps/helper/test/pool-evm/anvil-grief.ts http://127.0.0.1:<port>
// The pool address holds code that stands in for what a recipient contract could do inside the pool's push:
//   nullifier 0x65: succeed when GASPRICE is 0 (eth_estimateGas without fee fields), INVALID otherwise;
//   nullifier 0x66: burn about 1.04M gas always (a heavy call, so fee / gas limit is the lowest cap);
//   anything else: succeed.
// Checks, each on the node: the GASPRICE-dependent call is refused simulation_failed five times with nothing sent and
// the sender's balance unchanged; a recipient with code, or an EIP-7702 delegation, is refused recipient_code; with the
// base fee raised over the heavy call's cap, it is refused fee_stale and nothing is sent, while an ordinary send at the
// same moment lands; a deadline under now + 60 s is refused deadline_near. Every transaction the sender sent has
// status 1 and cost at most the fee. The sender key is a test key: sha256("helper-pool-senders/test-key/EVM_GRIEF").
import { createHash } from "node:crypto";
import { evmAddressOf, evmPoolSender, WITHDRAW_SELECTOR } from "../../src/pool/evm.ts";
import { epochStartOf } from "../../src/pool/fee.ts";

const url = process.argv[2]!;
const call = async (method: string, params: readonly unknown[]): Promise<any> => {
  const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(`RPC error ${r.error.code}: ${String(r.error.message).slice(0, 120)}`); // the kit client's wording
  return r.result;
};
const KEY = new Uint8Array(createHash("sha256").update("helper-pool-senders/test-key/EVM_GRIEF").digest());
const sender = evmAddressOf(KEY);
await call("anvil_setBalance", [sender, "0xde0b6b3a7640000"]);
const POOL = "0x00000000000000000000000000000000b1f1f001";
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const PLAIN = "0x0000000000000000000000000000000000000a11";
const CONTRACT = "0x0000000000000000000000000000000000000a12";
const DELEGATED = "0x0000000000000000000000000000000000000a13";
const CODE = [0x61, 0x01, 0x44, 0x35, 0x80, 0x60, 0x66, 0x14, 0x60, 0x1b, 0x57, 0x60, 0x65, 0x14, 0x60, 0x12, 0x57, 0x00, 0x5b, 0x3a, 0x15, 0x60, 0x19, 0x57, 0xfe, 0x5b, 0x00, 0x5b, 0x62, 0x00, 0x9c, 0x40, 0x5b, 0x60, 0x01, 0x90, 0x03, 0x80, 0x60, 0x20, 0x57, 0x00];
// a 4-byte call (currentTreeDepth(), the fee's depth read) answers 2: CALLDATASIZE == 4 jumps past CODE, whose PUSH1
// jump targets move by the 7 bytes put before it
const DEPTH_FIRST = [0x36, 0x60, 0x04, 0x14, 0x60, 7 + CODE.length, 0x57];
const MOVED = CODE.map((b, i) => (i > 0 && CODE[i - 1] === 0x60 && (CODE[i + 1] === 0x56 || CODE[i + 1] === 0x57) ? b + DEPTH_FIRST.length : b));
const DEPTH_TWO = [0x5b, 0x60, 0x02, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3];
await call("anvil_setCode", [POOL, `0x${Buffer.from([...DEPTH_FIRST, ...MOVED, ...DEPTH_TWO]).toString("hex")}`]);
// the fee's reads (kit trade/evm/pool-fee.ts) as a real node answers them at the epoch block's hash: Base Sepolia's
// GasPriceOracle predeploy, here code returning one word, 7,917 wei, for its L1 fee bound and its operator fee alike
const WORD = (n: bigint) => `0x7f${n.toString(16).padStart(64, "0")}60005260206000f3`; // PUSH32 n, MSTORE, RETURN 32 bytes
await call("anvil_setCode", ["0x420000000000000000000000000000000000000f", WORD(7_917n)]);

await call("anvil_setCode", [CONTRACT, "0x00"]);
await call("anvil_setCode", [DELEGATED, `0xef0100${"ab".repeat(20)}`]);
const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [call, (m, p) => call(m, p)]);
await call("evm_mine", []);
const epoch = epochStartOf(Date.now());
const fee = BigInt((await s.fee(epoch))!.fee);
const w32 = (n: bigint) => n.toString(16).padStart(64, "0");
const a32 = (a: string) => a.slice(2).padStart(64, "0");
const dataOf = (nf: bigint, o: { to?: string; deadline?: number } = {}) => {
  const proof = Array.from({ length: 16 }, (_, i) => w32(i === 9 ? nf : BigInt(i + 1))).join("");
  const relay = [a32(o.to ?? PLAIN), a32(FEE_TO), w32(10n ** 16n), w32(BigInt(o.deadline ?? epoch + 270_000)), w32(5n), "c9ebb52422ed595de60e051c69edee1a".padEnd(64, "0")].join("");
  return `0x${WITHDRAW_SELECTOR}${w32(576n)}${proof}${w32(fee)}${a32(POOL)}${w32(64n)}${w32(192n)}${relay}`;
};
const carry = (data: string) => s.carry({ pool: POOL, data, epoch });
const codeOf = (a: { body: unknown }) => (a.body as { error?: { code: string } }).error?.code ?? "ok";
const receipt = async (h: string) => {
  for (let t = 0; t < 30; t++) {
    const rc = await call("eth_getTransactionReceipt", [h]);
    if (rc) return rc;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};
const bal = async () => BigInt(await call("eth_getBalance", [sender, "latest"]));
const nonceNow = async () => Number(await call("eth_getTransactionCount", [sender, "pending"]));
let ok = true;
const check = (good: boolean, line: string) => {
  console.log(`${good ? "ok " : "BAD"} ${line}`);
  ok &&= good;
};
console.log(`epoch fee ${fee} wei`);

// 1. the revert loop: the GASPRICE-dependent call, five times
const [b0, n0] = [await bal(), await nonceNow()];
const answers: string[] = [];
for (let i = 0; i < 5; i++) {
  const a = await carry(dataOf(0x65n));
  answers.push(`${a.status} ${codeOf(a)}${(a.body as { error?: { detail?: string } }).error?.detail ? ` (${(a.body as { error: { detail: string } }).error.detail.slice(0, 60)})` : ""}`);
}
const [b1, n1] = [await bal(), await nonceNow()];
check(answers.every((x) => x.startsWith("422 simulation_failed")) && b1 === b0 && n1 === n0, `revert loop: ${answers[0]} x5; sent ${n1 - n0}, sender paid ${b0 - b1} wei`);

// 2. recipients with code
for (const [to, what] of [[CONTRACT, "a contract"], [DELEGATED, "an EIP-7702 delegation"]] as const) {
  const a = await carry(dataOf(0x70n, { to }));
  check(codeOf(a) === "recipient_code" && (await nonceNow()) === n0, `${what} as recipient: ${a.status} ${codeOf(a)}, nothing sent`);
}

// 3. a deadline under the send margin
const near = await carry(dataOf(0x71n, { deadline: Date.now() + 30_000 }));
check(codeOf(near) === "deadline_near" && (await nonceNow()) === n0, `a deadline 30 s away: ${near.status} ${codeOf(near)}, nothing sent`);

// 4. the base fee raised over the heavy call's cap (fee / its gas limit) and under an ordinary send's
await call("anvil_setNextBlockBaseFeePerGas", ["0x77359400"]); // 2 gwei
await call("evm_mine", []);
const base = BigInt((await call("eth_getBlockByNumber", ["latest", false])).baseFeePerGas);
const heavy = await carry(dataOf(0x66n));
check(codeOf(heavy) === "fee_stale" && (await nonceNow()) === n0, `heavy call at base ${base}: ${heavy.status} ${codeOf(heavy)} ${JSON.stringify(heavy.body).slice(30, 140)}, nothing sent`);
const plain = await carry(dataOf(0x67n));
const ph = (plain.body as { hash?: string }).hash;
const prc = ph ? await receipt(ph) : null;
check(plain.status === 200 && prc?.status === "0x1", `an ordinary send at the same base fee: ${plain.status} ${ph ?? codeOf(plain)} status ${prc?.status}`);

// 5. every transaction the sender sent landed with status 1, each at most the fee
const n2 = await nonceNow();
const paid = b0 - (await bal());
const cost = prc ? BigInt(prc.gasUsed) * BigInt(prc.effectiveGasPrice) : -1n;
check(n2 - n0 === 1 && paid === cost && cost <= fee, `the sender sent ${n2 - n0} transaction(s), all status 1; paid ${paid} wei <= fee ${fee}; reverts paid: 0`);
console.log(ok ? "PASS pool-evm-anvil-grief" : "FAIL pool-evm-anvil-grief");
process.exit(ok ? 0 : 1);
