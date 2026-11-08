/// <reference types="node" />
// The regression of card solana-teardown-cashback, on the kit's teardown entry points alone (no export the card adds):
// GATRKVEP…'s teardown, planned and built from its recorded mainnet reads, claims its PumpSwap volume account's owed
// 12,742,862 and closes that account; replayed on both providers' recorded simulations, the wallet gains exactly that
// claim plus the closed accounts' lamports less the fee. Before the card, the plan kept the account open with the
// WSOL still in it, and nothing read the volume account's WSOL account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base64 } from "@scure/base";
import { SOLANA_PUMP_AMM_PROGRAM, checkSolanaTeardown, solanaTeardownAddresses, solanaTeardownPlan, solanaVolumeAccumulator, type SolanaHeldRead } from "../src/checks/solana/checks.ts";
import { buildSolanaTeardown, simulateSolanaTeardown } from "../src/trade/solana/build.ts";

type RawAcc = { owner: string; lamports: number; data: [string, string] } | null;
const F = JSON.parse(readFileSync(new URL("./fixtures/solana-teardown-cashback.json", import.meta.url), "utf8"));
const R = F.wallets[0];
const held = (a: RawAcc): SolanaHeldRead | null => (a ? { owner: a.owner, lamports: BigInt(a.lamports), data: base64.decode(a.data[0]) } : null);

test("GATRKVEP…: the teardown claims the owed 12,742,862 before it closes the PumpSwap volume account; the wallet gains exactly the claim", async () => {
  const addresses = solanaTeardownAddresses(R.wallet, R.mints);
  assert.deepEqual(addresses, R.addresses, "the teardown reads the volume account's WSOL account");
  const accounts = Object.fromEntries(addresses.map((x: string, i: number) => [x, [held(R.reads[0].value[i + 1]), held(R.reads[1].value[i + 1])] as const]));
  const plan = solanaTeardownPlan(R.wallet, accounts);
  const uva = solanaVolumeAccumulator(R.wallet, SOLANA_PUMP_AMM_PROGRAM);
  assert.ok(plan.close.some((h) => h.address === uva), "the owed volume account is closed");
  const frames = buildSolanaTeardown(R.wallet, plan, R.chain);
  assert.deepEqual(frames.map((f) => base64.encode(f.wire)), R.frames);
  const w0 = BigInt(R.reads[0].value[0].lamports);
  const sims = [];
  for (const [f, pair] of R.sims.entries()) {
    const one = async (answers: unknown[]) => { const q = [...answers]; return simulateSolanaTeardown(async () => q.shift(), frames[f]!.wire, R.wallet, addresses); };
    sims.push([await one(pair[0]), await one(pair[1])] as const);
  }
  const v = checkSolanaTeardown(frames.map((f) => f.wire), R.wallet, { accounts, wallet: [w0, BigInt(R.reads[1].value[0].lamports)], simulations: sims });
  assert.equal(v.ok, true, JSON.stringify(v.results));
  const closed = plan.close.reduce((s, h) => s + h.lamports, 0n);
  for (const s of sims[0]!) assert.equal(s.wallet - w0 - closed + 5_000n, 12_742_862n);
});
