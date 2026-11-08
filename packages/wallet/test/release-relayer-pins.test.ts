// The release's mainnet relayer pins (card wallet-mainnet-relayer-pins): deposit/bind.ts RELEASE_RELAYER.mainnet, the
// deposit carry's gas account, and withdraw/relay.ts RELEASE_WITHDRAW_RELAYER.mainnet, the withdrawal relayer and its
// fee recipient, are each the account the server script printed, read on two public mainnet RPCs before it was written;
// the chain reads decide each pin, and the helper's answers are held equal to it.
//   node --test test/release-relayer-pins.test.ts      (from packages/wallet)
// The reads are test/vectors/mainnet-relayer-pins.json (test/record-relayer-pins.mjs; its recorded_at says when):
// - each relayer account is a 64-hex implicit account (as bind-relayer-key.sh and withdraw-relayer-key.sh make them)
//   that exists on both RPCs and holds exactly one key, full access, its own implicit key: the public key the server
//   script printed (it prints ed25519:<base58 of the key whose hex is the account>);
// - each pin is the account read on chain, and the helper names the same (GET /v1/health bind.mainnet; GET
//   /v1/withdraw/fee's relayer_account and fee_recipient, byte for byte); the fee recipient is fees.unrlzd.near
//   (owner 7 Nov 09:27Z), registered on mainnet USDC on both RPCs;
// - the device takes a fee answer only when it names the written pair: another relayer or fee recipient is refused;
// - neither pin is the throwaway relayer of helper-mainnet-vault-env's Mac test run, and the two are not one account.
// Planted reads (a second key, a function-call key, another key, one RPC, the throwaway, an unregistered recipient)
// each fail, so the rule bites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58, hex } from "@scure/base";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import { RELEASE_RELAYER } from "../src/deposit/bind.ts";
import { askWithdrawFee, RELEASE_WITHDRAW_RELAYER, WITHDRAW_FEE_URL } from "../src/withdraw/relay.ts";

type Rpc = { url: string; status: number; json: any };
type Account = { id: string; view_account: Rpc[]; view_access_key_list: Rpc[] };
type Registered = { id: string; storage_balance_of: Rpc[] };
type Vector = {
  recorded_at: string;
  helper: { health: { status: number; bind: { mainnet?: unknown } | null }; fee: { status: number; body: any } };
  bind: Account | null;
  withdraw_relayer: Account | null;
  fee_recipients: Registered[];
};
const V = JSON.parse(readFileSync(new URL("vectors/mainnet-relayer-pins.json", import.meta.url), "utf8")) as Vector;

/** The fee recipient the owner named for mainnet withdrawals (owner 7 Nov 09:27Z, card helper-mainnet-vault-env). */
const FEE_RECIPIENT = "fees.unrlzd.near";
/** helper-mainnet-vault-env's Mac test run's relayer (scripts/live-checks/helper-mainnet-vault-env.answers.json): never a pin. */
const THROWAWAY = "9747fa11a4de38cecc3b9086239633a2164a81c8e7b03a39bd3f1522438717d6";
const MAIN = NEAR_NETWORKS.mainnet;
/** Mainnet's release pair, two operators (scripts/ci/near-rpc-operators.mjs): FastNEAR and dRPC. */
const PAIR = [MAIN.fastnear[0], MAIN.drpc];
const IMPLICIT = /^[0-9a-f]{64}$/;
const implicitKey = (id: string): string => `ed25519:${base58.encode(hex.decode(id))}`;

/** [] when `a` is `id` read on mainnet's release pair: it exists on both, and holds one key, full access, its own. */
function relayerProblems(id: unknown, a: Account | null): string[] {
  if (typeof id !== "string" || !IMPLICIT.test(id)) return [`${String(id)} is not a 64-hex implicit account`];
  if (id === THROWAWAY) return [`${id} is the throwaway relayer of helper-mainnet-vault-env's Mac test run`];
  if (a === null || a.id !== id) return [`${id} was not read`];
  const p: string[] = [];
  for (const k of ["view_account", "view_access_key_list"] as const) {
    if (JSON.stringify(a[k].map((r) => r.url)) !== JSON.stringify(PAIR)) p.push(`${k}: not read on ${PAIR.join(" and ")}`);
  }
  for (const r of a.view_account) if (r.status !== 200 || typeof r.json?.result?.amount !== "string" || BigInt(r.json.result.amount) <= 0n) p.push(`${id} does not exist on ${r.url}`);
  for (const r of a.view_access_key_list) {
    const keys = r.status === 200 ? r.json?.result?.keys : undefined;
    if (!Array.isArray(keys) || keys.length !== 1) p.push(`${id} holds ${Array.isArray(keys) ? keys.length : "no readable"} keys on ${r.url}, not one`);
    else if (keys[0].public_key !== implicitKey(id) || keys[0].access_key?.permission !== "FullAccess") p.push(`${id}'s one key on ${r.url} is not its own full-access key ${implicitKey(id)}`);
  }
  return p;
}
/** [] when `id` is registered on mainnet USDC on both RPCs of the pair. */
function registeredProblems(id: string, rs: Registered[]): string[] {
  const r = rs.find((x) => x.id === id);
  if (r === undefined) return [`${id}'s USDC registration was not read`];
  if (JSON.stringify(r.storage_balance_of.map((x) => x.url)) !== JSON.stringify(PAIR)) return [`${id}: not read on ${PAIR.join(" and ")}`];
  const p: string[] = [];
  for (const x of r.storage_balance_of) {
    const bytes = x.status === 200 ? x.json?.result?.result : undefined;
    const bal = Array.isArray(bytes) ? JSON.parse(Buffer.from(bytes).toString()) : undefined;
    if (bal === null || typeof bal?.total !== "string") p.push(`${id} is not registered on mainnet USDC on ${x.url}`);
  }
  return p;
}

test("the deposit pin is the carry the helper names, existing on both RPCs with one full-access key, its own", () => {
  assert.ok(V.bind !== null);
  assert.equal(RELEASE_RELAYER.mainnet, V.bind.id, "RELEASE_RELAYER.mainnet is the account read on chain");
  assert.deepEqual(relayerProblems(RELEASE_RELAYER.mainnet, V.bind), []);
  assert.equal(V.helper.health.status, 200);
  assert.equal(V.helper.health.bind?.mainnet, RELEASE_RELAYER.mainnet, "the helper's bind.mainnet is the pin");
  assert.equal(RELEASE_RELAYER.testnet, null, "testnet names none: the rehearsal names its gas account itself");
  assert.ok(Object.isFrozen(RELEASE_RELAYER));
});

test("the withdrawal pin is the relayer read on chain and fees.unrlzd.near, and the helper's fee answer names that pair", () => {
  const pin = RELEASE_WITHDRAW_RELAYER.mainnet;
  assert.ok(pin !== null && Object.isFrozen(pin), "RELEASE_WITHDRAW_RELAYER.mainnet is written and frozen");
  assert.ok(V.withdraw_relayer !== null);
  assert.deepEqual(Object.keys(pin).sort(), ["fee_recipient", "relayer_account"]);
  assert.equal(pin.relayer_account, V.withdraw_relayer.id, "the relayer pin is the account read on chain");
  assert.equal(pin.fee_recipient, FEE_RECIPIENT);
  assert.deepEqual(relayerProblems(pin.relayer_account, V.withdraw_relayer), []);
  assert.deepEqual(registeredProblems(pin.fee_recipient, V.fee_recipients), []);
  assert.notEqual(pin.relayer_account, RELEASE_RELAYER.mainnet, "the deposit carry and the withdrawal relayer are two accounts");
  assert.equal(V.helper.fee.status, 200);
  assert.deepEqual({ relayer_account: V.helper.fee.body.relayer_account, fee_recipient: V.helper.fee.body.fee_recipient }, { ...pin }, "the helper names the pin's pair");
});

test("the device takes the recorded fee answer with the written pair, and refuses one naming another relayer or fee recipient", async () => {
  const pin = RELEASE_WITHDRAW_RELAYER.mainnet;
  assert.ok(pin !== null);
  const answer = V.helper.fee.body as Record<string, unknown>;
  const seen: string[] = [];
  const helper = (body: unknown): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  const ask = (body: unknown) => askWithdrawFee({ token: MAIN.usdc, relayer: pin, amount: 1_000_000_000n, fetchFn: helper(body) });
  const fee = await ask(answer);
  assert.equal(fee.relayFee, BigInt(answer.relay_fee as string));
  assert.equal(fee.feeRecipient, FEE_RECIPIENT);
  assert.equal(seen[0], `${WITHDRAW_FEE_URL}?token=${MAIN.usdc}`);
  for (const over of [{ relayer_account: THROWAWAY }, { relayer_account: RELEASE_RELAYER.mainnet }, { fee_recipient: "unrlzd.near" }, { fee_recipient: pin.relayer_account }])
    await assert.rejects(ask({ ...answer, ...over }), /withdraw relay refused \(relayer\): the answer names a relayer that is not the release's/, JSON.stringify(over));
});

test("the fee recipient the owner named is registered on mainnet USDC on both RPCs", () => {
  assert.deepEqual(registeredProblems(FEE_RECIPIENT, V.fee_recipients), []);
});

test("planted: a second key, a function-call key, another key, one RPC, an absent account, the throwaway, an unregistered recipient each fail", () => {
  assert.ok(V.bind !== null);
  const id = V.bind.id;
  const edit = (f: (a: Account) => void): Account => {
    const a = structuredClone(V.bind!);
    f(a);
    return a;
  };
  const key0 = V.bind.view_access_key_list[0]!.json.result.keys[0];
  const bads: [string, Account][] = [
    ["a second key", edit((a) => a.view_access_key_list[1]!.json.result.keys.push({ ...key0, public_key: implicitKey(THROWAWAY) }))],
    ["a function-call key", edit((a) => (a.view_access_key_list[0]!.json.result.keys[0].access_key.permission = { FunctionCall: { allowance: null, receiver_id: "x.near", method_names: [] } }))],
    ["another key", edit((a) => (a.view_access_key_list[1]!.json.result.keys[0].public_key = implicitKey(THROWAWAY)))],
    ["one RPC", edit((a) => (a.view_access_key_list[1]!.url = PAIR[0]!))],
    ["one operator", edit((a) => (a.view_access_key_list[1]!.url = MAIN.fastnear[1]))],
    ["absent", edit((a) => (a.view_account[0] = { ...a.view_account[0]!, json: { error: { cause: { name: "UNKNOWN_ACCOUNT" } } } }))],
  ];
  for (const [why, a] of bads) assert.notDeepEqual(relayerProblems(id, a), [], why);
  assert.match(relayerProblems(THROWAWAY, { ...V.bind, id: THROWAWAY }).join(), /throwaway/);
  assert.match(relayerProblems("bind.unrlzd.near", V.bind).join(), /not a 64-hex implicit account/);
  const unregistered = structuredClone(V.fee_recipients);
  unregistered[0]!.storage_balance_of[1]!.json.result.result = [...Buffer.from("null")];
  assert.match(registeredProblems(FEE_RECIPIENT, unregistered).join(), /not registered on mainnet USDC on https:\/\/near\.drpc\.org/);
});
