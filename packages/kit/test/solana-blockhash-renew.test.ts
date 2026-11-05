/// <reference types="node" />
// Card solana-legs-share-wait, the blockhash renewal's two pure parts: solanaWithBlockhash puts a fresh blockhash into
// an assembled tx and changes no other byte, and solanaSignOnlyChecked lets through only bytes equal to the copy the
// checks passed. The flow's own runs over recorded answers are in solana-flow-replay.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { solanaCompileV0, solanaDecodeMessage, solanaSignOnlyChecked, solanaWithBlockhash, type SolanaAssembled, type SolanaLegRecord } from "../src/index.ts";

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
