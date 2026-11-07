// node --test packages/kit/test/pool-deposit.test.ts: the kit's same-chain pool deposit builders (card pool-deposits),
// against deposits that landed:
// - Solana: fixtures/solana-pool-deposit.json, the devnet pool's first deposit (the mark recorded in
//   packages/signpage/test/fixtures/pool-devnet.json), read on both devnet RPCs; and that fixture's pool account, whose
//   tree sizes pick the pages.
// The EVM deposit is encoded in the wallet, after its note is picked (packages/wallet/src/pool/same-chain.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_POOL_MIN_DEPOSIT,
  SolanaPoolDepositError,
  solanaPoolDepositCost,
  solanaPoolDepositIx,
  solanaPoolDepositTx,
  solanaPoolPreMark,
  solanaPoolTreeSizes,
  VAULT_FIELD_P,
} from "@blindfill/kit";
import { solanaDecodeMessage } from "../src/checks/solana/message.ts";

const json = (u: string) => JSON.parse(readFileSync(new URL(u, import.meta.url), "utf8"));
const SOL = json("./fixtures/solana-pool-deposit.json") as { answers: { rpc: string; err: unknown; transaction: string }[] };
const DEVNET = json("../../signpage/test/fixtures/pool-devnet.json") as { program: string; pool: string; addresses: Record<string, string>; answers: { accounts: Record<string, { data: [string, string] } | null> }[] };

// a legacy message (the recorded run's): header, keys, blockhash, instructions
function legacy(msg: Uint8Array) {
  let o = 0;
  const compact = () => {
    let v = 0, s = 0, b = 0;
    do (b = msg[o++]!), (v |= (b & 0x7f) << s), (s += 7);
    while (b & 0x80);
    return v;
  };
  const [req, roSigned, roUnsigned] = [msg[o++]!, msg[o++]!, msg[o++]!];
  const keys = Array.from({ length: compact() }, () => base58.encode(msg.subarray(o, (o += 32))));
  const blockhash = base58.encode(msg.subarray(o, (o += 32)));
  const flag = (k: number) => ({ key: keys[k]!, signer: k < req, writable: k < req ? k < req - roSigned : k < keys.length - roUnsigned });
  const ixs = Array.from({ length: compact() }, () => {
    const program = keys[msg[o++]!]!;
    const accounts = Array.from({ length: compact() }, () => flag(msg[o++]!));
    const n = compact();
    const data = msg.slice(o, (o += n));
    return { program, accounts, data };
  });
  assert.equal(o, msg.length);
  return { blockhash, ixs };
}
const beInt = (b: Uint8Array) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("the recorded devnet deposit is one tag 1, the same on both RPCs, landed", () => {
  assert.equal(SOL.answers.length, 2);
  assert.notEqual(SOL.answers[0]!.rpc, SOL.answers[1]!.rpc);
  assert.equal(SOL.answers[0]!.transaction, SOL.answers[1]!.transaction);
  assert.deepEqual(SOL.answers.map((a) => a.err), [null, null]);
});

test("Solana: the kit's tag 1 is the landed deposit's instruction byte for byte (pool, depositor, pages, mark, system; 41 bytes)", () => {
  const wire = base64.decode(SOL.answers[0]!.transaction);
  const { ixs } = legacy(wire.subarray(1 + 64 * wire[0]!));
  const dep = ixs.filter((x) => x.program === DEVNET.program);
  assert.equal(dep.length, 1);
  const got = dep[0]!;
  assert.equal(got.data[0], 1);
  const value = new DataView(got.data.buffer, got.data.byteOffset).getBigUint64(1, true);
  const precommitment = beInt(got.data.subarray(9, 41));
  const depositor = got.accounts[1]!.key;
  // the pool's first deposit: both trees at size 0
  const built = solanaPoolDepositIx(DEVNET.program, depositor, { value, precommitment }, { stateSize: 0, labelSize: 0 });
  assert.equal(built.program, got.program);
  assert.deepEqual(built.accounts, got.accounts);
  assert.equal(hex(built.data), hex(got.data));
  assert.equal(built.data.length, 41);
  assert.equal(built.accounts[0]!.key, DEVNET.pool);
  assert.equal(built.accounts[2]!.key, DEVNET.addresses.state0);
  assert.equal(built.accounts[3]!.key, DEVNET.addresses.label0);
  assert.equal(built.accounts[4]!.key, DEVNET.addresses.mark);
  assert.equal(solanaPoolPreMark(DEVNET.program, precommitment), DEVNET.addresses.mark);
});

test("Solana: the tree sizes come from the recorded pool account (both RPCs' bytes), and pick the pages a deposit writes", () => {
  const [a, b] = DEVNET.answers.map((x) => base64.decode(x.accounts.pool!.data[0]));
  assert.equal(hex(a!), hex(b!));
  const sizes = solanaPoolTreeSizes(a!);
  // one deposit landed: one leaf on each tree
  assert.deepEqual(sizes, { stateSize: 1, labelSize: 1 });
  const ix = solanaPoolDepositIx(DEVNET.program, "11111111111111111111111111111112", { value: 10_000_000n, precommitment: 7n }, sizes);
  assert.equal(ix.accounts[2]!.key, DEVNET.addresses.state0); // entry 1 is still on page 0
  assert.throws(() => solanaPoolTreeSizes(a!.subarray(1)), SolanaPoolDepositError);
  const bad = a!.slice();
  bad[0] = bad[0]! ^ 1;
  assert.throws(() => solanaPoolTreeSizes(bad), SolanaPoolDepositError);
});

test("Solana: the unsigned v0 tx carries exactly the one tag 1, the depositor its one signer and payer, the signature slot zeroed", () => {
  const blockhash = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
  const { message, wire } = solanaPoolDepositTx(DEVNET.program, "11111111111111111111111111111112", { value: 20_000_000n, precommitment: 9n }, { stateSize: 1, labelSize: 1 }, blockhash);
  assert.equal(wire[0], 1);
  assert.ok(wire.subarray(1, 65).every((x) => x === 0));
  assert.equal(hex(wire.subarray(65)), hex(message));
  const m = solanaDecodeMessage(message);
  assert.equal(m.requiredSignatures, 1);
  assert.equal(m.staticKeys[0], "11111111111111111111111111111112");
  assert.equal(m.instructions.length, 1);
  assert.equal(m.staticKeys[m.instructions[0]!.programIndex], DEVNET.program);
  assert.equal(hex(m.instructions[0]!.data), hex(Uint8Array.of(1, ...[0, 0x2d, 0x31, 1, 0, 0, 0, 0], ...new Uint8Array(31), 9)));
});

test("Solana: a value below MIN_DEPOSIT or past u64, a precommitment of 0 or at p, or a size not a u32 is refused before any bytes", () => {
  const ok = { value: SOLANA_POOL_MIN_DEPOSIT, precommitment: 1n };
  const s = { stateSize: 0, labelSize: 0 };
  assert.doesNotThrow(() => solanaPoolDepositIx(DEVNET.program, DEVNET.pool, ok, s));
  for (const note of [{ ...ok, value: SOLANA_POOL_MIN_DEPOSIT - 1n }, { ...ok, value: 1n << 64n }, { ...ok, precommitment: 0n }, { ...ok, precommitment: VAULT_FIELD_P }, { ...ok, value: 5 as never }])
    assert.throws(() => solanaPoolDepositIx(DEVNET.program, DEVNET.pool, note, s), SolanaPoolDepositError);
  for (const bad of [{ stateSize: -1, labelSize: 0 }, { stateSize: 0, labelSize: 2 ** 32 }, { stateSize: 0.5, labelSize: 0 }])
    assert.throws(() => solanaPoolDepositIx(DEVNET.program, DEVNET.pool, ok, bad), SolanaPoolDepositError);
});

test("Solana: one note's cost is the fee, the 17-byte mark's rent and each page's entry, or a new page's rent at a boundary", () => {
  const perByte = 6_960n;
  const rentMin = (n: number) => BigInt(128 + n) * perByte;
  assert.equal(solanaPoolDepositCost(5_000n, rentMin, perByte, { stateSize: 1, labelSize: 1 }), 5_000n + rentMin(17) + 2n * 72n * perByte);
  assert.equal(solanaPoolDepositCost(5_000n, rentMin, perByte, { stateSize: 1024, labelSize: 1 }), 5_000n + rentMin(17) + rentMin(88) + 72n * perByte);
});
