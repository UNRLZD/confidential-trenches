// node --test packages/kit/test/pool-deposit.test.ts: the kit's same-chain pool deposit builders (card pool-deposits),
// against deposits that landed:
// - Solana: fixtures/solana-pool-deposit.json, the devnet pool's first two deposits with their balances before and after
//   (the first made the mark recorded in packages/signpage/test/fixtures/pool-devnet.json and both pages; the second
//   inserted onto existing pages), and the pool account and the Rent sysvar read later (state 44, label 32), each on
//   both devnet RPCs; and pool-devnet.json's pool account (one leaf on each tree).
// The EVM deposit is encoded in the wallet, after its note is picked (packages/wallet/src/pool/same-chain.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_POOL_MIN_DEPOSIT,
  SOLANA_SYSTEM_PROGRAM,
  solanaPoolPreMarkOf,
  solanaRentMin,
  solanaRentOf,
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
type TxAnswer = { rpc: string; err: unknown; fee: number; preBalances: number[]; postBalances: number[]; transaction: string };
const SOL = json("./fixtures/solana-pool-deposit.json") as { deposits: { signature: string; answers: TxAnswer[] }[]; now: { rpc: string; pool: { owner: string; data: string }; rent: { owner: string; data: string } }[] };
const DEVNET = json("../../signpage/test/fixtures/pool-devnet.json") as { program: string; pool: string; addresses: Record<string, string>; answers: { accounts: Record<string, { owner: string; data: [string, string] } | null> }[] };

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
  return { blockhash, ixs, keys };
}
function v0(msg: Uint8Array) {
  const m = solanaDecodeMessage(msg);
  assert.equal(m.lookups.length, 0);
  const keys = m.staticKeys;
  return { keys, ixs: m.instructions.map((x) => ({ program: keys[x.programIndex]!, accounts: x.accounts.map((k) => ({ key: keys[k]! })), data: x.data })) };
}
const beInt = (b: Uint8Array) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("the recorded devnet deposits are one tag 1 each, the same bytes and balances on both RPCs, landed", () => {
  assert.equal(SOL.deposits.length, 2);
  for (const d of SOL.deposits) {
    const [a, b] = d.answers;
    assert.notEqual(a!.rpc, b!.rpc);
    assert.deepEqual([a!.transaction, a!.preBalances, a!.postBalances, a!.fee], [b!.transaction, b!.preBalances, b!.postBalances, b!.fee]);
    assert.deepEqual([a!.err, b!.err], [null, null]);
  }
});

/** A recorded deposit: its tag 1 and the lamports each of its accounts held before and after. */
function landed(k: number) {
  const a = SOL.deposits[k]!.answers[0]!;
  const wire = base64.decode(a.transaction);
  const msg = wire.subarray(1 + 64 * wire[0]!);
  // the first is a legacy message, the second (the signing page's) a v0 one with no lookup table
  const { ixs, keys } = msg[0]! & 0x80 ? v0(msg) : legacy(msg);
  const dep = ixs.filter((x) => x.program === DEVNET.program);
  assert.equal(dep.length, 1);
  const ix = dep[0]!;
  const bal = (key: string, at: "preBalances" | "postBalances") => BigInt(a[at][keys.indexOf(key)]!);
  return { ix, fee: BigInt(a.fee), bal };
}
const RENT = solanaRentOf({ owner: SOL.now[0]!.rent.owner, data: base64.decode(SOL.now[0]!.rent.data) });

test("Solana: the kit's tag 1 is the landed deposit's instruction byte for byte (pool, depositor, pages, mark, system; 41 bytes)", () => {
  const got = landed(0).ix;
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

test("Solana: the tree sizes come from the pool account (both RPCs' bytes), the program's own, and pick the pages a deposit writes", () => {
  const [a, b] = DEVNET.answers.map((x) => ({ owner: x.accounts.pool!.owner, data: base64.decode(x.accounts.pool!.data[0]) }));
  assert.equal(hex(a!.data), hex(b!.data));
  // one deposit landed: one leaf on each tree
  const sizes = solanaPoolTreeSizes(a!, DEVNET.program);
  assert.deepEqual(sizes, { stateSize: 1, labelSize: 1 });
  const ix = solanaPoolDepositIx(DEVNET.program, "11111111111111111111111111111112", { value: 10_000_000n, precommitment: 7n }, sizes);
  assert.equal(ix.accounts[2]!.key, DEVNET.addresses.state0); // entry 1 is still on page 0
  // read later: the trees at different sizes (releases add state leaves only), each read from its own offset
  const [n0, n1] = SOL.now.map((x) => ({ owner: x.pool.owner, data: base64.decode(x.pool.data) }));
  assert.equal(hex(n0!.data), hex(n1!.data));
  assert.deepEqual(solanaPoolTreeSizes(n0!, DEVNET.program), { stateSize: 44, labelSize: 32 });
  assert.throws(() => solanaPoolTreeSizes({ owner: a!.owner, data: a!.data.subarray(1) }, DEVNET.program), SolanaPoolDepositError);
  const bad = a!.data.slice();
  bad[0] = bad[0]! ^ 1;
  assert.throws(() => solanaPoolTreeSizes({ owner: a!.owner, data: bad }, DEVNET.program), SolanaPoolDepositError);
  // the same bytes under another owner are not the pool
  assert.throws(() => solanaPoolTreeSizes({ owner: SOLANA_SYSTEM_PROGRAM, data: a!.data }, DEVNET.program), /not the program's/);
});

test("Solana: a mark's read: no account or a funded system account is no mark; the recorded mark is its value and nonce; anything else refused", () => {
  const rec = DEVNET.answers[0]!.accounts.mark!;
  const data = base64.decode(rec.data[0]);
  assert.deepEqual(solanaPoolPreMarkOf({ owner: rec.owner, data }, DEVNET.program), { value: 10_000_000n, nonce: 1n });
  assert.equal(solanaPoolPreMarkOf(null, DEVNET.program), null);
  // a stranger's lamports at the mark's address: a system account with no data, which the deposit takes over
  assert.equal(solanaPoolPreMarkOf({ owner: SOLANA_SYSTEM_PROGRAM, data: new Uint8Array(0) }, DEVNET.program), null);
  for (const bad of [
    { owner: SOLANA_SYSTEM_PROGRAM, data: new Uint8Array(1) },
    { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data },
    { owner: rec.owner, data: data.subarray(0, 16) },
    { owner: rec.owner, data: Uint8Array.from(data, (x, i) => (i === 16 ? 2 : x)) },
    { owner: rec.owner, data: Uint8Array.from(data, (x, i) => (i < 8 ? 0 : x)) },
    // a value of 1 lamport, below MIN_DEPOSIT and not 0; a nonce of 0 with a real value: the program writes neither
    { owner: rec.owner, data: Uint8Array.from(data, (x, i) => (i === 0 ? 1 : i < 8 ? 0 : x)) },
    { owner: rec.owner, data: Uint8Array.from(data, (x, i) => (i >= 8 && i < 16 ? 0 : x)) },
  ])
    assert.throws(() => solanaPoolPreMarkOf(bad, DEVNET.program), SolanaPoolDepositError);
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

test("Solana: one note's cost is what the depositor really lost in each recorded deposit, less its value", () => {
  // the first: no page yet, no lamports at the mark's address; the second: both pages hold one entry's rent
  for (const [k, sizes] of [[0, { stateSize: 0, labelSize: 0 }], [1, { stateSize: 1, labelSize: 1 }]] as const) {
    const { ix, fee, bal } = landed(k);
    const [, depositor, statePage, labelPage, mark] = ix.accounts.map((x) => x.key);
    const value = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true);
    const have = { mark: bal(mark!, "preBalances"), statePage: bal(statePage!, "preBalances"), labelPage: bal(labelPage!, "preBalances") };
    const lost = bal(depositor!, "preBalances") - bal(depositor!, "postBalances");
    assert.equal(solanaPoolDepositCost(fee, RENT, sizes, have) + value, lost, `deposit ${k}`);
    // and each account ends at the rent-exempt minimum of its length, as the program leaves it
    assert.equal(bal(mark!, "postBalances"), solanaRentMin(RENT, 17));
    assert.equal(bal(statePage!, "postBalances"), solanaRentMin(RENT, 16 + 72 * (sizes.stateSize + 1)));
  }
});

test("Solana: lamports a stranger sends to a page or the mark's address lower the cost exactly as the program charges it (max(0, rent - held))", () => {
  const s = { stateSize: 1, labelSize: 1 };
  const page = solanaRentMin(RENT, 16 + 72); // a page with one entry
  const base = solanaPoolDepositCost(5_000n, RENT, s, { mark: 0n, statePage: page, labelPage: page });
  assert.equal(solanaPoolDepositCost(5_000n, RENT, s, { mark: 0n, statePage: page + 1n, labelPage: page }), base - 1n);
  assert.equal(solanaPoolDepositCost(5_000n, RENT, s, { mark: 7n, statePage: page, labelPage: page }), base - 7n);
  // held above what the new length needs: that account costs nothing, never less
  const full = solanaRentMin(RENT, 16 + 72 * 2);
  assert.equal(solanaPoolDepositCost(5_000n, RENT, s, { mark: solanaRentMin(RENT, 17) * 3n, statePage: full * 2n, labelPage: full }), 5_000n);
  // a page's last slot (1023) and the next page's first: the new length is 16 + 72 x (slot + 1)
  assert.equal(solanaPoolDepositCost(0n, RENT, { stateSize: 1023, labelSize: 1024 }, { mark: 0n, statePage: 0n, labelPage: 0n }), solanaRentMin(RENT, 17) + solanaRentMin(RENT, 16 + 72 * 1024) + solanaRentMin(RENT, 16 + 72));
  assert.throws(() => solanaPoolDepositCost(-1n, RENT, s, { mark: 0n, statePage: 0n, labelPage: 0n }), SolanaPoolDepositError);
});
