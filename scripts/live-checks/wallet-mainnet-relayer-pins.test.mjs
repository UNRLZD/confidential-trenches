// node --test scripts/live-checks/wallet-mainnet-relayer-pins.test.mjs: the live check replays its recorded answers
// (wallet-mainnet-relayer-pins.answers.json; its _note says where and when each was read).
//   good: this branch's own SIGN_HOST build, with the helper and both RPCs read live: PASS.
//   bad: SIGN_HOST as served (release-95), both pins null in its bundle: FAIL.
//   bad_throwaway: a build pinning helper-mainnet-vault-env's Mac test relayer, whose chain reads alone would pass: FAIL.
// Planted on good: each fact broken FAILs, naming it. And the pins are read from this checkout's source, in the shape
// bind.ts and relay.ts write them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FEE_RECIPIENT, implicitKey, judge, judgeBundle, loadPins, PAIR, pinsOf, THROWAWAY } from "./wallet-mainnet-relayer-pins.mjs";

const A = JSON.parse(readFileSync(new URL("./wallet-mainnet-relayer-pins.answers.json", import.meta.url), "utf8"));
const CARRY = "f874a24241077a92d78daebf0e20585b2b6c89f7da30b05a67fb1969f70388cc";
const RELAYER = "4519129d35447942d92ef046ffa52af0430fb06b95b59936d7173290a6972756";
const BAD_BUNDLE = [
  `BAD deposit: the bundle holds 0 frozen copies of the deposit pin ${CARRY}, not one`,
  `BAD withdraw: the bundle holds 0 frozen copies of the withdrawal pin ${RELAYER}, not one`,
];

test("recorded good: this branch's build carries both pins, the helper names each, each relayer holds its own one key on both RPCs: PASS", () => {
  const v = judge(A.good);
  assert.deepEqual(v.lines, []);
  assert.equal(v.ok, true);
  assert.deepEqual(A.good.bundle.pins, { deposit: CARRY, withdraw: { relayer_account: RELAYER, fee_recipient: FEE_RECIPIENT } });
  assert.equal(A.good.bundle.deposit, 1);
  assert.equal(A.good.bundle.withdraw, 1);
  for (const [a, id] of [[A.good.chain.deposit, CARRY], [A.good.chain.withdraw, RELAYER]])
    for (const r of a.view_access_key_list) assert.deepEqual(r.json.result.keys.map((k) => [k.public_key, k.access_key.permission]), [[implicitKey(id), "FullAccess"]]);
});

test("recorded bad: SIGN_HOST as served (release-95) carries neither pin, though every chain fact holds: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, BAD_BUNDLE);
});

test("recorded bad_throwaway: FAIL by the refusal and the helper's answer, though the account holds its own one key on both RPCs", () => {
  const v = judge(A.bad_throwaway);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    `BAD bundle: the bundle names the throwaway relayer ${THROWAWAY}`,
    "BAD withdraw: the helper's GET /v1/withdraw/fee for mainnet USDC answered 404, naming no relayer",
    `BAD withdraw: ${THROWAWAY} is the throwaway relayer of helper-mainnet-vault-env's Mac test run`,
  ]);
  // the chain rule alone would take it: one full-access key, its own, on both RPCs
  for (const r of A.bad_throwaway.chain.withdraw.view_access_key_list) assert.deepEqual(r.json.result.keys.map((k) => [k.public_key, k.access_key.permission]), [[implicitKey(THROWAWAY), "FullAccess"]]);
});

const written = () => structuredClone(A.good);

test("planted on good: each broken fact FAILs, naming it", () => {
  const bad = (f, re) => {
    const a = written();
    f(a);
    const v = judge(a);
    assert.equal(v.ok, false, String(re));
    assert.ok(v.lines.some((l) => re.test(l)), `${re}: ${v.lines.join(" | ")}`);
  };
  bad((a) => (a.bundle.withdraw = 0), /BAD withdraw: the bundle holds 0 frozen copies/);
  bad((a) => (a.bundle.deposit = 2), /BAD deposit: the bundle holds 2 frozen copies/);
  bad((a) => (a.bundle.sha384 = "sha384-x"), /BAD bundle: SIGN_HOST's served \/app.js is not the one index.html pins/);
  bad((a) => (a.chain.fee.body.fee_recipient = "f.near"), /BAD withdraw: the helper names .* not the pin's/);
  bad((a) => (a.chain.health.bind.mainnet = "ab".repeat(32)), /BAD deposit: the helper names .* not the pin/);
  bad((a) => (a.bundle.pins.withdraw.fee_recipient = a.chain.pins.withdraw.fee_recipient = a.chain.fee.body.fee_recipient = "other.near"), /BAD withdraw: the pin's fee recipient is other.near, not fees.unrlzd.near/);
  bad((a) => a.chain.withdraw.view_access_key_list[1].json.result.keys.push({ access_key: { nonce: 1, permission: "FullAccess" }, public_key: implicitKey(THROWAWAY) }), /holds 2 keys on https:\/\/near\.drpc\.org, not one/);
  bad((a) => (a.chain.withdraw.view_access_key_list[0].json.result.keys[0].access_key.permission = { FunctionCall: {} }), /is not its own full-access key/);
  bad((a) => (a.chain.withdraw.view_account[0] = { url: PAIR[0], status: 200, json: { error: { cause: { name: "UNKNOWN_ACCOUNT" } } } }), /does not exist on https:\/\/rpc\.mainnet\.fastnear\.com/);
  bad((a) => (a.chain.feeRecipient.storage_balance_of[1].json.result.result = [...Buffer.from("null")]), /not registered on mainnet USDC on https:\/\/near\.drpc\.org/);
  bad((a) => (a.chain.deposit.view_access_key_list[1].url = "https://rpc.mainnet.near.org"), /was not read on/);
  bad((a) => (a.chain.pins.withdraw.relayer_account = "ef".repeat(32)), /BAD bundle: the bundle and the chain were read for different pins/);
  bad((a) => {
    a.bundle.pins.withdraw.relayer_account = a.chain.pins.withdraw.relayer_account = a.chain.fee.body.relayer_account = CARRY;
    a.chain.withdraw = structuredClone(a.chain.deposit);
  }, /BAD withdraw: the withdrawal relayer is the deposit carry/);
});

test("the bundle part alone (what bundle-checks.mjs runs on a build) reads only the build's facts", () => {
  assert.deepEqual(judgeBundle(A.bad.bundle).lines, BAD_BUNDLE);
  assert.deepEqual(judgeBundle(A.good.bundle).lines, []);
  const nulls = structuredClone(A.bad.bundle);
  nulls.pins = { deposit: null, withdraw: null };
  assert.deepEqual(judgeBundle(nulls).lines, [
    "BAD deposit: the release names no mainnet deposit carry (bind.ts RELEASE_RELAYER.mainnet is null)",
    "BAD withdraw: the release names no mainnet withdrawal relayer (relay.ts RELEASE_WITHDRAW_RELAYER.mainnet is null)",
  ]);
  assert.equal(judgeBundle(undefined).ok, false);
});

test("the pins are this checkout's source: bind.ts's mainnet carry, relay.ts's mainnet relayer as written or null", () => {
  assert.deepEqual(loadPins(), { deposit: CARRY, withdraw: { relayer_account: RELAYER, fee_recipient: FEE_RECIPIENT } });
  const bind = 'export const RELEASE_RELAYER: Readonly<Record<NearNetwork, string | null>> = Object.freeze({\n  mainnet: "aa",\n  testnet: null,\n});';
  const relay = (mainnet) => `export const RELEASE_WITHDRAW_RELAYER: Readonly<Record<NearNetwork, HelperReleaseRelayer | null>> = Object.freeze({\n  mainnet: ${mainnet},\n  testnet: POOL_TESTNET ? x : null,\n});`;
  const pair = 'Object.freeze({\n    relayer_account: "r", // gitleaks:allow (a public account id)\n    fee_recipient: "fees.unrlzd.near", // gitleaks:allow (a public account id)\n  })';
  assert.deepEqual(pinsOf(bind, relay(pair)), { deposit: "aa", withdraw: { relayer_account: "r", fee_recipient: "fees.unrlzd.near" } });
  assert.deepEqual(pinsOf(bind.replace('"aa"', "null"), relay("null")), { deposit: null, withdraw: null });
  assert.throws(() => pinsOf(bind.replace('"aa"', "CARRY"), relay("null")), /RELEASE_RELAYER's mainnet pin is not null or one string/);
  assert.throws(() => pinsOf(bind, relay("PAIR")), /RELEASE_WITHDRAW_RELAYER's mainnet pin is not null/);
});

test("implicitKey is the key the server script prints for its account", () => {
  assert.equal(implicitKey(CARRY), "ed25519:HisG7d9D3eQBP8sDw3oLpJDrSrxiqTTgDh2Cwuxv8rEo");
  assert.equal(implicitKey("00".repeat(32)), `ed25519:${"1".repeat(32)}`);
});
