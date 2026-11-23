// The exit tool's Base and Robinhood pools, offline (card exit-evm-pools-with-the-words): the pins are the deploy
// records, and a bad To, the pool as To, one RPC twice or no prover is refused before any money moves. The signatures
// are the wallet's (packages/wallet/test/pool-evm-exit.test.ts); the whole exit runs on a fork of each mainnet
// (scripts/evm-fork.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, EVM_POOLS, evmExitU, evmPoolScopeOf, wordsToSeed64, type EvmRpc } from "@blindfill/kit/core";
import type { VaultProver } from "@blindfill/kit";
import { exitBase, exitEth, exitEvm, exitRobinhood, ExitEvmRefused } from "../src/evm-out.ts";

const ROOT = new URL("../../../", import.meta.url);
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the wallet's A.8 words, public, holding nothing
const PROVER: VaultProver = { load: async () => {}, prove: async () => ({}) as never };

test("each chain's pool is its deploy record's PrivacyPoolSimple, scanned from that deploy", () => {
  for (const chain of ["base", "robinhood"] as const) {
    const rec = JSON.parse(readFileSync(new URL(`contracts/pool-evm/deployments/${chain}.json`, ROOT), "utf8"));
    assert.equal(EVM_POOLS[chain]?.pool, rec.contracts.PrivacyPoolSimple.address.toLowerCase(), chain);
    assert.ok(EVM_POOLS[chain]!.fromBlock > 0n);
  }
  assert.equal(typeof exitBase, "function");
  assert.equal(typeof exitRobinhood, "function");
  assert.equal(exitEth(1_000_000_000_000_000n), "0.001 ETH");
  assert.equal(exitEth(0n), "0 ETH");
});

test("a To that is no address to pay, the pool as To, one RPC twice and no prover are refused before any money moves", async () => {
  let reads = 0;
  const rpc = Object.assign(async () => (reads++, "0x2105"), { url: "https://a.example" }) as unknown as EvmRpc;
  const other = Object.assign(async () => (reads++, "0x2105"), { url: "https://b.example" }) as unknown as EvmRpc;
  const ctx = { seed: SEED, to: "0x0000000000000000000000000000000000000001", rpcs: ["https://a.example", "https://b.example"] as [string, string], say: () => {} };
  const TO = "0x5555555555555555555555555555555555555555";
  await assert.rejects(exitEvm("base", ctx, { rpcs: [rpc, other], prover: PROVER }), ExitEvmRefused);
  await assert.rejects(exitEvm("base", { ...ctx, to: "0xnot" }, { rpcs: [rpc, other], prover: PROVER }), ExitEvmRefused);
  await assert.rejects(exitEvm("base", { ...ctx, to: TO }, { rpcs: [rpc, rpc], prover: PROVER }), ExitEvmRefused);
  await assert.rejects(exitEvm("base", { ...ctx, to: TO }, { rpcs: [rpc, other] }), /no prover/);
  assert.equal(reads, 0);
  await assert.rejects(exitEvm("base", { ...ctx, to: EVM_POOLS.base!.pool }, { rpcs: [rpc, other], prover: PROVER }), ExitEvmRefused);
  assert.equal(reads, 2, "only the pool-To case read the chain ids");
});

// card wallet-u-restore-exit: a pool deposit's one-time wallet U^evm_{s,i} on Base and Robinhood is an HKDF key no
// outside wallet imports; money left there (a delivery 1Click left, a remainder under the pool's floor) leaves only by
// the exit. A fake Robinhood pair (no L1 fee) answers by method, the same on both; the restore holds no note.
function evmPair(balance: Map<string, bigint>, nonce: Map<string, bigint>, apart: string[] = []) {
  const sent: string[] = [];
  const answer = (side: number) => async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const a = String((params as unknown[])[0]).toLowerCase();
    switch (method) {
      case "eth_chainId":
        return "0x1237"; // 4663, Robinhood
      case "eth_blockNumber":
        return "0x10";
      case "eth_getBlockByNumber":
        return { hash: "0xb1", timestamp: "0x1", baseFeePerGas: "0x1" };
      case "eth_getBalance":
        return `0x${((balance.get(a) ?? 0n) + (apart.includes(a) ? BigInt(side) : 0n)).toString(16)}`;
      case "eth_getTransactionCount":
        return `0x${(nonce.get(a) ?? 0n).toString(16)}`;
      case "eth_estimateGas":
        return "0x5208";
      case "eth_getCode":
        return "0x";
      case "eth_sendRawTransaction":
        if (side === 0 && !sent.includes(a)) sent.push(a);
        return null;
      case "eth_getTransactionReceipt":
        return { status: "0x1", blockHash: "0xb2" };
      default:
        throw new Error(`the fake pair has no ${method}`);
    }
  };
  const rpcs = [Object.assign(answer(0), { url: "https://a.example" }), Object.assign(answer(1), { url: "https://b.example" })] as unknown as [EvmRpc, EvmRpc];
  return { rpcs, sent };
}
/** A type 2 raw send's to, value and signer: a minimal RLP read of its twelve short fields, the signer recovered. */
function readSend(rawHex: string): { to: string; value: bigint; from: string } {
  const raw = Buffer.from(rawHex.slice(2), "hex");
  const items: Buffer[] = [];
  const head = raw[1]!;
  for (let at = head < 0xf8 ? 2 : 2 + (head - 0xf7); at < raw.length; ) {
    const p = raw[at]!;
    if (p < 0x80) (items.push(raw.subarray(at, at + 1)), (at += 1));
    else if (p < 0xb8) (items.push(raw.subarray(at + 1, at + 1 + p - 0x80)), (at += 1 + p - 0x80));
    else if (p === 0xc0) (items.push(Buffer.alloc(0)), (at += 1));
    else throw new Error("a field this read does not take");
  }
  const big = (b: Buffer): bigint => (b.length === 0 ? 0n : BigInt(`0x${b.toString("hex")}`));
  const field = (b: Buffer): Buffer => (b.length === 1 && b[0]! < 0x80 ? b : Buffer.concat([Buffer.from([0x80 + b.length]), b]));
  const body = Buffer.concat([...items.slice(0, 8).map(field), Buffer.from([0xc0])]);
  const digest = keccak_256(Buffer.concat([Buffer.from([2]), body.length < 56 ? Buffer.from([0xc0 + body.length]) : Buffer.from([0xf8, body.length]), body]));
  const pad = (b: Buffer): Buffer => Buffer.concat([Buffer.alloc(32 - b.length), b]);
  const sig = secp256k1.Signature.fromBytes(Buffer.concat([pad(items[10]!), pad(items[11]!)]), "compact").addRecoveryBit(Number(big(items[9]!)));
  const pub = sig.recoverPublicKey(digest).toBytes(false);
  return { to: `0x${items[5]!.toString("hex")}`, value: big(items[6]!), from: `0x${Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString("hex")}` };
}

test("money left on U^evm_3 and U^evm_7 of the pool's deposits goes to the typed address, each U its own signer; under its gas stays, told; an id read apart stops the chain, named", async () => {
  const scope = evmPoolScopeOf(EVM_POOLS.robinhood!.pool, 4663n);
  const U = (i: number) => evmExitU(SEED, scope, i);
  const TO = "0x5555555555555555555555555555555555555555";
  const balance = new Map([[U(3), 1_000_000_000_000_000n], [U(7), 500_000_000_000_000n], [U(23), 30_000n]]);
  const nonce = new Map([[U(15), 1n]]); // used and emptied: the walk reads on past it to U_23
  const lines: string[] = [];
  const ctx = { seed: SEED, to: TO, rpcs: ["https://a.example", "https://b.example"] as [string, string], say: (l: string) => void lines.push(l) };
  const p = evmPair(balance, nonce);
  const r = await exitEvm("robinhood", ctx, { rpcs: p.rpcs, prover: PROVER, wait: async () => {}, restore: async () => ({ notes: [], spends: [] }) as never });
  assert.equal(p.sent.length, 2, lines.join("\n"));
  const gas = 21_000n * 2n; // Robinhood: twice the base fee of 1, no tip
  assert.deepEqual(p.sent.map(readSend), [
    { to: TO, value: 1_000_000_000_000_000n - gas, from: U(3) },
    { to: TO, value: 500_000_000_000_000n - gas, from: U(7) },
  ]);
  assert.ok(lines.some((l) => l.includes(U(23)) && l.includes("stays")), lines.join("\n"));
  assert.deepEqual([r.sent, r.left], [(1_500_000_000_000_000n - 2n * gas).toString(), "30000"]);
  // U_4 read apart on the two RPCs: unread, and the chain stops naming it after U_3 and U_7 were sent
  const q = evmPair(balance, nonce, [U(4)]);
  await assert.rejects(exitEvm("robinhood", ctx, { rpcs: q.rpcs, prover: PROVER, wait: async () => {}, restore: async () => ({ notes: [], spends: [] }) as never }), /one-time wallet is not read: unread index 4 .*run the exit again to go on/);
  assert.equal(q.sent.length, 2);
});

// card exit-evm-base-harness-retry: the fork run (scripts/evm-fork.ts) failed twice on Base at a read right after the
// proof, "fetch failed" on its second RPC, because it built its pair without the retry the command gives its own
// (evm-out.ts pairOf). The command's read is now one function, exitEvmRpc, and the fork reads through it.
test("one read for the command and the fork: exitEvmRpc reads again after a dropped connection; evm-fork.ts builds no RPC of its own", async () => {
  const m = (await import("../src/evm-out.ts")) as Record<string, unknown>;
  assert.equal(typeof m.exitEvmRpc, "function", "evm-out.ts exports the command's read");
  const exitEvmRpc = m.exitEvmRpc as (url: string, fetchFn?: (u: string, i: RequestInit) => Promise<Response>) => EvmRpc;
  let calls = 0;
  const fetchFn = async (_u: string, i: RequestInit): Promise<Response> => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    const { id } = JSON.parse(String(i.body)) as { id: string };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x2105" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  assert.equal(await exitEvmRpc("https://a.example", fetchFn)("eth_chainId", []), "0x2105");
  assert.equal(calls, 2, "the dropped connection was read again");
  const fork = readFileSync(new URL("../scripts/evm-fork.ts", import.meta.url), "utf8");
  assert.match(fork, /\bexitEvmRpc\(/, "the fork reads through the command's own read");
  assert.doesNotMatch(fork, /\bsolanaJsonRpc\(/, "the fork builds no RPC of its own");
});
