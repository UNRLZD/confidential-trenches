// node --test contracts/vault/scripts/testnet-usdc.test.mjs (root script test:vault-scripts, run by CI's test job): the
// setup script's own tests, moved here beside it from scripts/live-checks/vault-testnet-usdc.test.mjs, whose file now
// tests only the live check (nothing outside packages/ and contracts/ imports into them, .dependency-cruiser.cjs).
// The script refuses bytes that are not the pin, its init names are the six the code reads, and its AddKey is full
// access.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { wasmProblems, initArgs, INIT_NAMES, encodeTx, act, PIN } from "./testnet-usdc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const deployment = JSON.parse(readFileSync(path.join(HERE, "../deployments/testnet-usdc.json"), "utf8"));

test("the deploy script refuses any bytes but the pin, and its init names are the six the code reads", () => {
  const notUsdc = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(100)]);
  const p = wasmProblems(notUsdc, PIN.codeHash);
  assert.ok(p.some((x) => /want 321491/.test(x)) && p.some((x) => /want b98ccd53/.test(x)) && p.some((x) => /the RPC reports/.test(x)), p.join("; "));
  assert.deepEqual(Object.keys(initArgs("t.testnet", {})), INIT_NAMES);
  assert.deepEqual(INIT_NAMES, ["admin_ids", "master_minter_ids", "owner_ids", "pauser_ids", "blocklister_id", "metadata"]);
  assert.deepEqual(Object.keys(deployment.init), INIT_NAMES);
});

test("the deploy script's AddKey is a full-access key (nearcore Action 5, AccessKey { nonce 0, FullAccess = 1 })", () => {
  const pub = Buffer.alloc(32, 7);
  const tx = encodeTx({ signer: "a", publicKey: pub, nonce: 1n, receiver: "b", blockHash: Buffer.alloc(32), actions: [act.fullKey(pub)] });
  assert.deepEqual([...tx.subarray(tx.length - 43)], [5, 0, ...pub, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});
