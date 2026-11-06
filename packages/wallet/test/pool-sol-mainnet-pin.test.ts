// node --test packages/wallet/test/pool-sol-mainnet-pin.test.ts (card pool-sol-deploy-mainnet): the wallet's mainnet pin
// of the Solana pool, SOL_MAINNET_DEPLOY, is the deploy record the owner's paste wrote
// (contracts/pool-solana/deployments/mainnet.json): its program id and its frozen lookup table. It fails while the record
// is missing, so the card cannot merge before the paste has run, and whenever the pin and the record differ.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { SOL_MAINNET_DEPLOY } from "../src/pool/solana.ts";

const RECORD = new URL("../../../contracts/pool-solana/deployments/mainnet.json", import.meta.url);

test("SOL_MAINNET_DEPLOY is the mainnet deploy record's program and lookup table", () => {
  assert.ok(existsSync(RECORD), "contracts/pool-solana/deployments/mainnet.json is missing: the owner's paste (contracts/pool-solana/scripts/mainnet-deploy.sh) writes it");
  const d = JSON.parse(readFileSync(RECORD, "utf8")) as { cluster: string; program_id: string; table: string };
  assert.equal(d.cluster, "mainnet");
  assert.deepEqual(SOL_MAINNET_DEPLOY, { program: d.program_id, table: d.table }, `write SOL_MAINNET_DEPLOY = { program: "${d.program_id}", table: "${d.table}" } in src/pool/solana.ts`);
});
