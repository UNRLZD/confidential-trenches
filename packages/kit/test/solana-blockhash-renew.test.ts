/// <reference types="node" />
// Card solana-legs-share-wait, the blockhash renewal's two pure parts: solanaWithBlockhash puts a fresh blockhash into
// an assembled tx and changes no other byte, and solanaSignOnlyChecked lets through only bytes equal to the copy the
// checks passed. The flow's own runs over recorded answers are in solana-flow-replay.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58 } from "@scure/base";
import {
  assembleSolanaSwap,
  checkSolanaQuote,
  parseSolanaJupiterBuild,
  readSolanaBlockhashValid,
  solanaCompileV0,
  solanaDecodeLookupTable,
  solanaDecodeMessage,
  solanaSignOnlyChecked,
  solanaWithBlockhash,
  type SolanaAssembled,
  type SolanaLegRecord,
  type SolanaRpc,
} from "../src/index.ts";

const key = (n: number): string => base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 + (n % 250) : i === 1 ? Math.floor(n / 250) + 1 : 9)));
const OLD = key(900);
const NEW = key(901);
const SYSTEM = "11111111111111111111111111111111";

/** An assembled tx paying `keys` accounts from one wallet: its message as the device compiles it. */
function assembled(keys: number): SolanaAssembled {
  const w = key(0);
  const ixs = [{ program: SYSTEM, accounts: Array.from({ length: keys }, (_, i) => ({ key: key(i + 1), signer: false, writable: true })), data: Uint8Array.of(2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0) }];
  const { message, tablesUsed } = solanaCompileV0(w, ixs, OLD, []);
  const wire = new Uint8Array(65 + message.length);
  wire[0] = 1;
  wire.set(message, 65);
  return { wire, message, size: wire.length, lastValidBlockHeight: 100, cuLimit: 0, cuPrice: 0n, tablesUsed };
}

for (const keys of [3, 130]) {
  test(`a fresh blockhash changes the 32 blockhash bytes and the height only (${keys + 2} static keys)`, () => {
    const a = assembled(keys);
    const b = solanaWithBlockhash(a, { blockhash: NEW, lastValidBlockHeight: 250 });
    assert.equal(solanaDecodeMessage(a.message).blockhash, OLD);
    assert.equal(solanaDecodeMessage(b.message).blockhash, NEW);
    assert.equal(b.lastValidBlockHeight, 250);
    assert.equal(b.wire.length, a.wire.length);
    const diff = [...b.wire.keys()].filter((i) => b.wire[i] !== a.wire[i]);
    assert.ok(diff.length > 0 && diff.length <= 32);
    assert.ok(diff.at(-1)! - diff[0]! < 32, "every changed byte is inside one 32-byte slot");
    assert.deepEqual(b.wire.subarray(65), b.message);
    // the old assembly is not touched
    assert.equal(solanaDecodeMessage(a.wire.subarray(65)).blockhash, OLD);
    const { blockhash: _x, ...restA } = solanaDecodeMessage(a.message);
    const { blockhash: _y, ...restB } = solanaDecodeMessage(b.message);
    assert.deepEqual(restB, restA);
  });
}

test("a fresh blockhash that is not an address, a height that is not one, or a wire not its own message is refused", () => {
  const a = assembled(3);
  assert.throws(() => solanaWithBlockhash(a, { blockhash: "x", lastValidBlockHeight: 250 }), /the blockhash must be the device's own read/);
  assert.throws(() => solanaWithBlockhash(a, { blockhash: NEW, lastValidBlockHeight: 0 }), /the blockhash must be the device's own read/);
  const wire = Uint8Array.from(a.wire);
  wire[wire.length - 1] = (wire[wire.length - 1] as number) ^ 1;
  assert.throws(() => solanaWithBlockhash({ ...a, wire }, { blockhash: NEW, lastValidBlockHeight: 250 }), /the wire is not its own message/);
});

const rec = (): SolanaLegRecord => ({ wallet: key(0), amount: 1n, expectedOut: 1n, minOut: 1n });

test("planted: a leg whose bytes change between the check and the sign is refused, unsigned; an unchanged leg goes", () => {
  const a = assembled(3);
  const same = { rec: rec(), assembled: a, checked: Uint8Array.from(a.wire) };
  const moved = solanaWithBlockhash(a, { blockhash: NEW, lastValidBlockHeight: 250 });
  // checked on the old bytes, the bytes to sign moved to a new blockhash afterwards
  const changed = { rec: rec(), assembled: moved, checked: Uint8Array.from(a.wire) };
  const oneByte = Uint8Array.from(a.wire);
  oneByte[70] = (oneByte[70] as number) ^ 1;
  const flipped = { rec: rec(), assembled: { wire: oneByte }, checked: Uint8Array.from(a.wire) };
  const shorter = { rec: rec(), assembled: { wire: a.wire.subarray(0, a.wire.length - 1) }, checked: Uint8Array.from(a.wire) };
  const out = solanaSignOnlyChecked([same, changed, flipped, shorter]);
  assert.deepEqual(out, [same]);
  assert.equal(same.rec.refused, undefined);
  for (const x of [changed, flipped, shorter]) assert.equal(x.rec.refused, "the bytes to sign are not the bytes the checks passed");
});

// Recorded builds whose message loads keys from two lookup tables (test/fixtures/solana-builds.json `twoTable`): the
// lookups sit after the instructions, so a fresh blockhash must leave them, and every check's verdict, as they were.
type Acc = { owner: string; data: string } | null;
const TWO = (JSON.parse(readFileSync(new URL("./fixtures/solana-builds.json", import.meta.url), "utf8")) as { twoTable: { side: "buy" | "sell"; wallet: string; mint: string; amount: string; body: string; accounts: Record<string, [Acc, Acc]>; blockhash: { blockhash: string; lastValidBlockHeight: number } }[] }).twoTable;
const accOf = (a: Acc) => (a ? { owner: a.owner, data: Uint8Array.from(Buffer.from(a.data, "base64")) } : null);

test("recorded two-table builds: a fresh blockhash changes only its own 32 bytes, the lookups stay, every check reads the same", () => {
  assert.equal(TWO.length, 2);
  for (const c of TWO) {
    const build = parseSolanaJupiterBuild(JSON.parse(c.body));
    const tables = Object.fromEntries(build.tables.flatMap((t) => (c.accounts[t]?.[0] ? [[t, solanaDecodeLookupTable(accOf(c.accounts[t][0])!.data)]] : [])));
    const req = { side: c.side, wallet: c.wallet, token: c.mint, amount: BigInt(c.amount), slippageBps: 1000 };
    const a = assembleSolanaSwap(req, build, { blockhash: c.blockhash.blockhash, lastValidBlockHeight: c.blockhash.lastValidBlockHeight, tables, tokenProgram: c.accounts[c.mint]![0]!.owner }, { pick: () => 0 });
    assert.equal(a.tablesUsed.length, 2);
    const b = solanaWithBlockhash(a, { blockhash: NEW, lastValidBlockHeight: 999 });
    const m0 = solanaDecodeMessage(a.message);
    const m1 = solanaDecodeMessage(b.message);
    assert.equal(m1.blockhash, NEW);
    assert.equal(m1.lookups.length, 2);
    assert.deepEqual({ ...m1, blockhash: "" }, { ...m0, blockhash: "" });
    const diff = [...b.wire.keys()].filter((i) => b.wire[i] !== a.wire[i]);
    assert.ok(diff.length > 0 && diff.at(-1)! - diff[0]! < 32);
    const reads = {
      tables: Object.fromEntries(build.tables.map((t) => [t, [accOf(c.accounts[t]![0]), accOf(c.accounts[t]![1])] as const])),
      mint: [accOf(c.accounts[c.mint]![0]), accOf(c.accounts[c.mint]![1])] as const,
      rent: { tokenAccount: [0n, 0n] as const, pumpVolumeAccumulator: [0n, 0n] as const },
      simulations: [null, null] as const,
      reference: null,
    };
    const q = { ...req, spendable: req.amount, minOut: 1n, otherWallets: [] };
    const v0 = checkSolanaQuote(a.wire, q, reads).results.map((r) => [r.id, r.ok, r.detail]);
    const v1 = checkSolanaQuote(b.wire, q, reads).results.map((r) => [r.id, r.ok, r.detail]);
    assert.deepEqual(v1, v0);
    assert.equal(v0.find((r) => r[0] === "S2")?.[1], true, "S2 reads both tables");
  }
});

test("the validity read counts only `value: true` on both providers: an error, a string, 1, no value or null never count", async () => {
  const bh = key(902);
  const rpc = (valid: (n: number) => unknown): SolanaRpc => {
    let n = 0;
    return (async (method: string) => {
      if (method === "getLatestBlockhash") return { context: { slot: 10 }, value: { blockhash: bh, lastValidBlockHeight: 100 } };
      if (method === "isBlockhashValid") { const v = valid(n++); if (v instanceof Error) throw v; return v; }
      throw new Error(method);
    }) as SolanaRpc;
  };
  const good = () => rpc(() => ({ context: { slot: 1 }, value: true }));
  for (const odd of [() => new Error("timeout"), () => ({ value: "true" }), () => ({ value: 1 }), () => ({}), () => null, () => ({ value: [true] })]) {
    await assert.rejects(readSolanaBlockhashValid([good(), rpc(odd)]), /no blockhash both providers hold/);
    await assert.rejects(readSolanaBlockhashValid([rpc(odd), good()]), /no blockhash both providers hold/);
  }
  assert.equal((await readSolanaBlockhashValid([good(), rpc((n) => ({ value: n > 0 }))])).blockhash, bh, "invalid once on B, valid on the read after: goes");
});
