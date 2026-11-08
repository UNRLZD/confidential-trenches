// node --test contracts/vault/scripts/mainnet-money.test.ts: the mainnet money run's refusals (card vault-mainnet-money),
// offline. Each case plants one wrong input on the real record, pin and kit table and must be refused before anything is
// read, signed or sent: another vault id, another asset, a record that is not the pin, one RPC only (and two hosts of
// one operator), a release with no relayer, a fee above the device's cap, and the vault's own reads on two operators.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { feeProblems, PIN, RECORD, runProblems, vaultReadProblems } from "./mainnet-money.ts";
import { NEAR_NETWORKS } from "../../../packages/kit/src/near/networks.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const record = JSON.parse(readFileSync(RECORD, "utf8"));
const pin = JSON.parse(readFileSync(PIN, "utf8"));
const rpc = (name: string) => ({ name, query: async () => ({}) });
const PAIR = [rpc(NEAR_NETWORKS.mainnet.fastnear[0]), rpc(NEAR_NETWORKS.mainnet.drpc)];
const RELAYERS = { bind: "g.example.near", withdraw: { relayer_account: "r.example.near", fee_recipient: "fees.example.near" } };
const good = () => ({ record: structuredClone(record), pin: structuredClone(pin), net: NEAR_NETWORKS.mainnet, rpcs: PAIR, relayers: RELAYERS });

test("the record files are the deploy's: mainnet-v1.json and its pin, beside this script", () => {
  assert.equal(RECORD, path.join(HERE, "..", "deployments", "mainnet-v1.json"));
  assert.equal(PIN, path.join(HERE, "..", "deployments", "mainnet-v1.pin.json"));
});

test("the deployed record, its pin, the kit's mainnet row and the release pair pass", () => {
  assert.deepEqual(runProblems(good()), []);
});

test("another vault id is refused: in the record, or in the kit's table", () => {
  const a = good();
  a.record.account_id = "vault-test.confidential.unrlzd.near";
  assert.ok(runProblems(a).some((p) => /vault/.test(p)), runProblems(a).join("\n"));
  const b = good();
  b.net = { ...NEAR_NETWORKS.mainnet, vault: "vault-test.confidential.unrlzd.near" } as never;
  assert.ok(runProblems(b).some((p) => /vault/.test(p)), runProblems(b).join("\n"));
  const c = good();
  c.net = { ...NEAR_NETWORKS.mainnet, vault: null } as never;
  assert.ok(runProblems(c).some((p) => /vault/.test(p)), runProblems(c).join("\n"));
});

test("another asset is refused: in the record, or the kit's token", () => {
  const a = good();
  a.record.asset = NEAR_NETWORKS.testnet.usdc;
  assert.ok(runProblems(a).some((p) => /asset/.test(p)), runProblems(a).join("\n"));
  const b = good();
  b.net = { ...NEAR_NETWORKS.mainnet, usdc: "usdt.tether-token.near" } as never;
  assert.ok(runProblems(b).some((p) => /asset/.test(p)), runProblems(b).join("\n"));
});

test("a record that is not the pin is refused, field by field (wasm, code hash, scope, network, source commit)", () => {
  for (const [k, v] of [["wasm_sha256", "0".repeat(64)], ["code_hash", "11111111111111111111111111111111"], ["scope", "1"], ["network", "testnet"], ["source_commit", "f".repeat(40)]] as const) {
    const a = good();
    a.record[k] = v;
    assert.ok(runProblems(a).some((p) => new RegExp(k).test(p)), `${k}: ${runProblems(a).join("\n")}`);
  }
  const b = good();
  b.record.code_hash = undefined;
  assert.ok(runProblems(b).some((p) => /code_hash/.test(p)), runProblems(b).join("\n"));
  const c = good();
  delete c.record.tx_hash;
  assert.ok(runProblems(c).some((p) => /tx_hash/.test(p)), runProblems(c).join("\n"));
});

test("one RPC only is refused, and two hosts of one operator, and a testnet pair", () => {
  for (const rpcs of [[PAIR[0]], [PAIR[0], rpc(NEAR_NETWORKS.mainnet.fastnear[1])], [rpc(NEAR_NETWORKS.testnet.fastnear[0]), rpc(NEAR_NETWORKS.testnet.drpc)], [PAIR[0], PAIR[1], PAIR[1]]]) {
    const a = { ...good(), rpcs };
    assert.ok(runProblems(a).some((p) => /RPC/.test(p)), `${rpcs.map((r) => r.name).join(", ")}: ${runProblems(a).join("\n")}`);
  }
});

test("a release with no mainnet relayer is refused: the device pays no fee to an account it was not built with", () => {
  const a = { ...good(), relayers: { bind: null, withdraw: RELAYERS.withdraw } };
  assert.ok(runProblems(a).some((p) => /deposit relayer/.test(p)), runProblems(a).join("\n"));
  const b = { ...good(), relayers: { bind: RELAYERS.bind, withdraw: null } };
  assert.ok(runProblems(b).some((p) => /withdrawal relayer/.test(p)), runProblems(b).join("\n"));
});

test("a fee above the device's cap is refused, and a fee that leaves nothing to withdraw; at the cap it passes", () => {
  const AMOUNT = 1_000_000n; // the vault's min_deposit, the smallest note the run may hold
  assert.deepEqual(feeProblems({ relayFee: 100n, feeMax: 100n, note: AMOUNT }), []);
  assert.ok(feeProblems({ relayFee: 101n, feeMax: 100n, note: AMOUNT }).some((p) => /above the device's fee_max/.test(p)));
  assert.ok(feeProblems({ relayFee: AMOUNT, feeMax: AMOUNT * 2n, note: AMOUNT }).some((p) => /leaves nothing/.test(p)));
  assert.ok(feeProblems({ relayFee: -1n, feeMax: 100n, note: AMOUNT }).length > 0);
});

// the vault as two operators read it at final: keys [], config naming the record's asset and scope, the record's code
const READ = { keys: [], code_hash: record.code_hash, config: { asset: record.asset, scope: record.scope, version: record.version } };
test("the vault read on two operators as the record says passes; a key, other code, another asset or scope, or one read missing is refused", () => {
  assert.deepEqual(vaultReadProblems(record, [READ, READ]), []);
  assert.ok(vaultReadProblems(record, [READ, { ...READ, keys: [{ public_key: "ed25519:x" }] }]).some((p) => /key/.test(p)));
  assert.ok(vaultReadProblems(record, [READ, { ...READ, code_hash: "x" }]).some((p) => /code/.test(p)));
  assert.ok(vaultReadProblems(record, [{ ...READ, config: { ...READ.config, asset: "x" } }, READ]).some((p) => /asset/.test(p)));
  assert.ok(vaultReadProblems(record, [{ ...READ, config: { ...READ.config, scope: "1" } }, READ]).some((p) => /scope/.test(p)));
  assert.ok(vaultReadProblems(record, [READ]).some((p) => /two/.test(p)));
  assert.ok(vaultReadProblems(record, [READ, null]).some((p) => /two/.test(p)));
});
