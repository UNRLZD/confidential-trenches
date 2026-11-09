// node --test packages/wallet/test/sol-pool-venue-tables.test.ts (card sol-pool-venue-tables): the wallet's lookup table
// pin per venue, SOL_POOL_TABLES, is the deploy records' `tables` maps (contracts/pool-solana/deployments/<cluster>.json,
// written by contracts/pool-solana/scripts/venue-table.mjs once both RPCs read the table back frozen), venue for venue,
// on both builds; the mainnet curve's entry is the pool deploy's own table; and every pinned venue is one the kit builds.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SOLANA_POOL_BUY_VENUES } from "@blindfill/kit";
import { SOL_MAINNET_DEPLOY, SOL_POOL_TABLES } from "../src/pool/solana.ts";

const record = (cluster: "mainnet" | "devnet"): Record<string, string> => {
  const f = new URL(`../../../contracts/pool-solana/deployments/${cluster}.json`, import.meta.url);
  if (!existsSync(f)) return {};
  const d = JSON.parse(readFileSync(f, "utf8")) as { cluster: string; tables?: Record<string, { table: string; addresses: string[] }> };
  assert.equal(d.cluster, cluster);
  return Object.fromEntries(Object.entries(d.tables ?? {}).map(([v, t]) => [v, t.table]));
};

test("the mainnet build pins each venue's table as the mainnet record holds it, the curve's the pool deploy's own", () => {
  assert.deepEqual(Object.keys(SOL_POOL_TABLES), ["mainnet"], "the mainnet build pins no devnet table");
  const pin = { ...SOL_POOL_TABLES.mainnet };
  assert.deepEqual(pin, record("mainnet"), `write SOL_POOL_TABLES.mainnet = ${JSON.stringify(record("mainnet"))} in src/pool/solana.ts`);
  assert.equal(pin["pump-curve"], SOL_MAINNET_DEPLOY.table);
  for (const v of Object.keys(pin)) assert.ok(SOLANA_POOL_BUY_VENUES.includes(v as never), `${v}: a venue the kit builds`);
});

test("the testnet build pins each venue's devnet table as the devnet record holds it", () => {
  // the testnet build's constants sit behind POOL_TESTNET: read them in a process whose build is the testnet one
  const src = fileURLToPath(new URL("../src/pool/solana.ts", import.meta.url));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `globalThis.__SIGN_NETWORK__ = "testnet"; const m = await import(${JSON.stringify(src)}); console.log(JSON.stringify(m.SOL_POOL_TABLES));`], { encoding: "utf8" });
  const pins = JSON.parse(out) as Record<string, Record<string, string>>;
  assert.deepEqual(Object.keys(pins), ["devnet"]);
  const rec = record("devnet");
  assert.deepEqual(pins.devnet, rec);
  assert.deepEqual(Object.keys(rec).sort(), [...SOLANA_POOL_BUY_VENUES].sort(), "devnet pins a frozen table for every venue the kit builds");
  for (const v of Object.keys(pins.devnet!)) assert.ok(SOLANA_POOL_BUY_VENUES.includes(v as never), `${v}: a venue the kit builds`);
});
