// The withdraw form's checks (card signpage-withdraw-form; docs/plan1/wallet.md §2.8 the withdraw.open rows W:927-930
// and WU-05 W:1067 at research 3a705af): every address and amount refusal, before any proof.
//   node --test test/withdraw-checks.test.ts   (from packages/signpage)
// The view_account answers are real reads of rpc.mainnet.fastnear.com and near.drpc.org, 2026-11-02T08:11Z (an unknown
// named account answers HANDLER_ERROR with cause UNKNOWN_ACCOUNT; an account that exists answers its view).
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { NEAR_NETWORKS, type NearRpc } from "../../kit/src/near/networks.ts";
import { VAULT_CONSTANTS } from "../../kit/src/vault/shapes.ts";
import { addressForm, checkAmount, checkRecipient, parseAmount, withdrawable } from "../src/withdraw/checks.ts";

const ABSENT = (id: string) => ({
  jsonrpc: "2.0",
  error: {
    name: "HANDLER_ERROR",
    cause: { info: { block_hash: "71bhnsjMCmMBH95aqTvsibLV9NN15q9SeDLRkmFRviZo", block_height: 222692519, requested_account_id: id }, name: "UNKNOWN_ACCOUNT" },
    code: -32000,
    message: "Server error",
    data: `account ${id} does not exist while viewing`,
  },
  id: "x",
});
const EXISTS = {
  jsonrpc: "2.0",
  result: {
    amount: "132815107332656721558030511110",
    block_hash: "Dfm2oUH5NYtA27Ch3eqBFcs45brX2fQRLEWUiW6wxRV1",
    block_height: 222692520,
    code_hash: "BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk",
    locked: "0",
    storage_paid_at: 0,
    storage_usage: 13202588797,
  },
  id: "x",
};

type Answer = unknown | Error;
function rpc(name: string, answer: (id: string) => Answer, calls: string[] = []): NearRpc {
  return {
    name,
    async query(params) {
      assert.equal(params.request_type, "view_account");
      assert.equal(params.finality, "final");
      calls.push(`${name} ${String(params.account_id)}`);
      const a = answer(String(params.account_id));
      if (a instanceof Error) throw a;
      return a;
    },
  };
}
const MAIN = NEAR_NETWORKS.mainnet;
const pair = (a: (id: string) => Answer, b: (id: string) => Answer, calls: string[] = []) =>
  [rpc(MAIN.fastnear[0], a, calls), rpc(MAIN.drpc, b, calls)] as const;
const both = (a: (id: string) => Answer, calls: string[] = []) => pair(a, a, calls);

test("the address must be a NEAR account id: named, a 64-hex implicit id or 0x and 40 hex", () => {
  for (const ok of ["alice.near", "a1", "sub.alice.near", "a-b_c.near", "near", "0".repeat(64), `0x${"ab".repeat(20)}`])
    assert.notEqual(addressForm(ok), null, ok);
  assert.equal(addressForm("0".repeat(64))!.kind, "implicit");
  assert.equal(addressForm(`0x${"ab".repeat(20)}`)!.kind, "implicit");
  assert.equal(addressForm("alice.near")!.kind, "named");
  // 0x and other than 40 hex is a well-formed name, so it is read like any named account (and absent, it is refused)
  assert.equal(addressForm(`0x${"ab".repeat(19)}`)!.kind, "named");
  assert.equal(addressForm("0xabc")!.kind, "named");
  // so is a lowercase bitcoin address: read, absent on both RPCs, refused (below)
  assert.equal(addressForm("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")!.kind, "named");
  // pasted with spaces or a line break around it: the same account
  assert.equal(addressForm("  alice.near\n")!.account, "alice.near");
  for (const bad of [
    "", "a", "Alice.near", "alice..near", ".alice", "alice.", "alice-.near", "-alice", "al ice.near", "alice@near",
    "a".repeat(65), "0X" + "ab".repeat(20), "0x" + "AB".repeat(20), "A".repeat(64),
    // another chain's address is not a NEAR account (a Solana address has capitals)
    "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
  ])
    assert.equal(addressForm(bad), null, JSON.stringify(bad));
});

test("an address that is not a NEAR account is refused, with no RPC read", async () => {
  const calls: string[] = [];
  for (const bad of ["", "Alice.near", "0x" + "AB".repeat(20), "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV"])
    assert.deepEqual(await checkRecipient(bad, "mainnet", both(() => EXISTS, calls)), { ok: false, code: "not-account" }, bad);
  assert.deepEqual(calls, []);
});

test("the vault, intents.near and the vault's token are refused, before any read, though they exist", async () => {
  const calls: string[] = [];
  assert.deepEqual(await checkRecipient("intents.near", "mainnet", both(() => EXISTS, calls)), { ok: false, code: "intents" });
  assert.deepEqual(await checkRecipient(VAULT_CONSTANTS.TOKEN, "mainnet", both(() => EXISTS, calls)), { ok: false, code: "token" });
  const T = NEAR_NETWORKS.testnet;
  const tpair = [rpc(T.fastnear[0], () => EXISTS, calls), rpc(T.drpc, () => EXISTS, calls)] as const;
  assert.deepEqual(await checkRecipient(T.vault, "testnet", tpair), { ok: false, code: "vault" });
  assert.deepEqual(await checkRecipient(T.usdc, "testnet", tpair), { ok: false, code: "token" });
  assert.deepEqual(await checkRecipient("intents.near", "testnet", tpair), { ok: false, code: "intents" });
  assert.deepEqual(calls, []);
});

test("WU-05: a named account that does not exist on two RPCs is refused; one that exists on both passes", async () => {
  assert.deepEqual(await checkRecipient("nosuchaccount-ct-zz.near", "mainnet", both(ABSENT)), { ok: false, code: "no-account" });
  assert.deepEqual(await checkRecipient("alice.near", "mainnet", both(() => EXISTS)), { ok: true, recipient: "alice.near" });
  assert.deepEqual(await checkRecipient(`0x${"ab".repeat(19)}`, "mainnet", both(ABSENT)), { ok: false, code: "no-account" });
  assert.deepEqual(await checkRecipient("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "mainnet", both(ABSENT)), { ok: false, code: "no-account" });
});

test("WU-05: an absent 64-hex implicit id passes with no read (no stranger can make it); 0x and 40 hex too", async () => {
  const calls: string[] = [];
  const id = "ab".repeat(32);
  assert.deepEqual(await checkRecipient(id, "mainnet", both(ABSENT, calls)), { ok: true, recipient: id });
  const eth = `0x${"cd".repeat(20)}`;
  assert.deepEqual(await checkRecipient(eth, "mainnet", both(ABSENT, calls)), { ok: true, recipient: eth });
  assert.deepEqual(calls, []);
});

test("a named account is never passed on one RPC's word: disagreement, an RPC down or a strange answer is unread", async () => {
  const cases: [string, ReturnType<typeof pair>][] = [
    ["exists on one, absent on the other", pair(() => EXISTS, ABSENT)],
    ["absent on one, exists on the other", pair(ABSENT, () => EXISTS)],
    ["one RPC down", pair(() => EXISTS, () => new Error("HTTP 503"))],
    ["one absent, one down", pair(ABSENT, () => new Error("timeout"))],
    ["another error", both(() => ({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "GARBAGE_COLLECTED_BLOCK" } } }))],
    ["an empty answer", both(() => ({}))],
    ["a result with no view", both(() => ({ jsonrpc: "2.0", result: { block_height: "1" } }))],
    ["null", both(() => null)],
    // JSON-RPC 2.0 answers with result or error, never both: a view beside any error key, even error: null, is unread
    ["a view beside error: null", both(() => ({ ...EXISTS, error: null }))],
    ["a view beside an error", both(() => ({ ...EXISTS, error: { name: "HANDLER_ERROR" } }))],
  ];
  for (const [name, rpcs] of cases) assert.deepEqual(await checkRecipient("alice.near", "mainnet", rpcs), { ok: false, code: "unread" }, name);
});

test("the two RPCs must be the network's release pair (the wallet's one pair rule)", async () => {
  const fast = rpc(MAIN.fastnear[0], () => EXISTS);
  const fast2 = rpc(MAIN.fastnear[1], () => EXISTS);
  const other = rpc("https://rpc.example.com", () => EXISTS);
  await assert.rejects(checkRecipient("alice.near", "mainnet", [fast, fast2]), /RPCs must be/);
  await assert.rejects(checkRecipient("alice.near", "mainnet", [fast, other] as never), /RPCs must be/);
  await assert.rejects(checkRecipient("alice.near", "testnet", both(() => EXISTS)), /RPCs must be/);
  await assert.rejects(checkRecipient("alice.near", "devnet" as never, both(() => EXISTS)), /RPCs must be|network/);
});

test("the amount: a decimal in USDC, at most 6 places, to base units", () => {
  assert.equal(parseAmount("1"), 1_000_000n);
  assert.equal(parseAmount("1.5"), 1_500_000n);
  assert.equal(parseAmount(".5"), 500_000n);
  assert.equal(parseAmount("2."), 2_000_000n);
  assert.equal(parseAmount(" 0.000001 "), 1n);
  assert.equal(parseAmount("1000000"), 1_000_000_000_000n);
  for (const bad of ["", ".", "-1", "+1", "1e3", "1,000", "1.0000001", "abc", "0x10", "1 000", "Infinity", "NaN", "1".repeat(40)])
    assert.equal(parseAmount(bad), null, JSON.stringify(bad));
});

test("the amount is refused above what one note can pay with its fee, and at or below the fee", () => {
  const fee = 120_000n; // 0.12 USDC
  const available = 10_000_000n; // the largest unspent note: 10 USDC
  assert.deepEqual(checkAmount("abc", { available, fee }), { ok: false, code: "amount" });
  assert.deepEqual(checkAmount("0", { available, fee }), { ok: false, code: "min", min: fee + 1n });
  assert.deepEqual(checkAmount("0.12", { available, fee }), { ok: false, code: "min", min: fee + 1n });
  assert.deepEqual(checkAmount("0.120001", { available, fee }), { ok: true, amount: 120_001n });
  // amount + fee must fit in the note: 9.88 fits exactly, one base unit more does not
  assert.deepEqual(checkAmount("9.88", { available, fee }), { ok: true, amount: 9_880_000n });
  assert.deepEqual(checkAmount("9.880001", { available, fee }), { ok: false, code: "insufficient" });
  assert.deepEqual(checkAmount("10", { available, fee }), { ok: false, code: "insufficient" });
  assert.deepEqual(checkAmount("1000000", { available, fee }), { ok: false, code: "insufficient" });
  // no note at all: every amount is insufficient, with or without a fee read
  assert.deepEqual(checkAmount("5", { available: 0n, fee: null }), { ok: false, code: "insufficient" });
  // the fee not read yet: an amount the notes could hold waits for it, never passes
  assert.deepEqual(checkAmount("5", { available, fee: null }), { ok: false, code: "unread" });
  // the notes not read: never insufficient on a read that did not happen, and never passed
  assert.deepEqual(checkAmount("5", { available: null, fee }), { ok: false, code: "unread" });
  assert.deepEqual(checkAmount("0.1", { available: null, fee }), { ok: false, code: "min", min: fee + 1n });
});

test("withdrawable: the largest UNSPENT note of the vault's scope, as the withdraw request picks one", () => {
  const n = (state: string, value: bigint | null, scope = 7n) =>
    ({ id: `${state}${value}`, state, scope, ...(value === null ? {} : { leaf: { value, label: 1n, commitment: 1n, leafIndex: 0n } }) }) as never;
  assert.equal(withdrawable([], 7n), 0n);
  assert.equal(withdrawable([n("UNSPENT", 5n), n("UNSPENT", 9n), n("UNSPENT", 3n)], 7n), 9n);
  for (const s of ["HELD", "RESERVED", "SPENT", "PLANNED", "INCOMING", "TAKEN"]) assert.equal(withdrawable([n(s, 50n), n("UNSPENT", 2n)], 7n), 2n, s);
  assert.equal(withdrawable([n("UNSPENT", 50n, 8n), n("UNSPENT", 2n)], 7n), 2n);
  assert.equal(withdrawable([n("UNSPENT", null)], 7n), 0n);
});
