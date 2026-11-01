// node --test scripts/live-checks/delete-refund-readback.sweep.test.mjs: the sweep script's txs are the bytes the money
// gate's own rebuild makes from the same fields, its key is the published all-zero-seed key, and a mainnet run without
// --live reads and sends nothing.
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import { rebuildTx, txBytesFacts } from "../ci/money-gate.mjs";
import { enc58, FUNDER, keyFromSeed, run, txBytes } from "./delete-refund-readback.sweep.mjs";

// the all-zero seed (RFC 8032's key derivation; packages/wallet/test/vectors/a8.json uses the same seed)
const ZERO = keyFromSeed(Buffer.alloc(32));
const BLOCK = "4xV3YNkQe6HkvQ7Q3ZrJ8fZw3Ad1V3YzW2c2x8Q7vNnM";

test("the zero seed gives its published ed25519 public key, and a signature verifies under it", () => {
  assert.equal(ZERO.hex, "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29");
  const msg = createHash("sha256").update("x").digest();
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(ZERO.hex, "hex")]);
  assert.equal(verify(null, msg, createPublicKey({ key: der, format: "der", type: "spki" }), ZERO.sign(msg)), true);
});

test("the Transfer and the DeleteAccount are the bytes the gate rebuilds from their tx JSON, and hash to their ids", () => {
  const A = ZERO.hex;
  const cases = [
    [{ transfer: 123456789012345678901234n }, { Transfer: { deposit: "123456789012345678901234" } }, FUNDER],
    [{ beneficiary: FUNDER }, { DeleteAccount: { beneficiary_id: FUNDER } }, A],
  ];
  for (const [action, viewAction, receiver] of cases) {
    const bytes = txBytes({ signer: A, publicKey: ZERO.publicKey, nonce: 7n, receiver, blockHash: BLOCK, action });
    const [v0] = rebuildTx({ signer_id: A, public_key: ZERO.publicKey, nonce: 7, receiver_id: receiver, actions: [viewAction], priority_fee: 0, signature: "ed25519:x", hash: "x" }, BLOCK);
    assert.equal(bytes.toString("base64"), v0);
    const facts = txBytesFacts(v0, enc58(createHash("sha256").update(bytes).digest()));
    assert.deepEqual(facts, { signer: A, receiver, version: 0 });
  }
});

test("a mainnet run without --live reads F and sends nothing", async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    asked.push(method);
    if (method !== "query" || params.request_type !== "view_account") throw new Error(`a dry run asked ${method}`);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { amount: "500000000000000000000000", storage_usage: 182 } }) };
  };
  const logs = [];
  const lines = await run({ network: "mainnet", live: false, fetchFn, log: (l) => logs.push(l) });
  assert.deepEqual([lines, asked], [[], ["query"]]);
  assert.match(logs.join("\n"), /DRY: .*Nothing signed, nothing sent\./);
});
