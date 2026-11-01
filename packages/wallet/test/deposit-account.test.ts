// U's reads before U signs its deposit (card wallet-deposit-account; wallet.md §2.4 step 7, W:416; V 2.10 (a),
// V:666-668, at research aa5bc1e).   node --test test/deposit-account.test.ts   (from packages/wallet)
// The answers are real answers on two operators (test/vectors/deposit-account.json, written by the read-only
// test/record-deposit-account.mjs, 2026-11-01T08:03Z; each answer names the account it is for): an implicit account with one full-access key of its own and USDC (`good`), real accounts
// with a function-call key beside the full one and with two full keys, a derived U that does not exist yet, USDC's
// view_account on mainnet and the testnet token's on testnet, and a real ft_balance_of panic. A test that needs an answer the chain does not give today (a halt, a
// function-call key alone, a bad nonce, a wrong code hash, two RPCs that disagree) edits one field of a recorded answer
// and says which.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VAULT_CONSTANTS, VAULT_TOKEN_CODE_HASH } from "@blindfill/kit";
import { base58 } from "@scure/base";
import {
  checkDepositAccount,
  depositAccount,
  DepositAccountRefused,
  HEIGHT_SPREAD_MAX,
  NEAR_NETWORKS,
  NEAR_RPC_URLS,
  type NearRpc,
  nearRpc,
  PENDING_PAUSE,
  readDepositAccount,
  type RefusalCode,
} from "../src/deposit/account.ts";
import * as d from "../src/derive/index.ts";

type Answers = Record<string, { for: string; a: { url: string; json: unknown }; b: { url: string; json: unknown } }>;
const rec = JSON.parse(readFileSync(new URL("./vectors/deposit-account.json", import.meta.url), "utf8")) as {
  good: string;
  test_u: string;
  answers: Answers;
};
const A = rec.answers;
const USDC = VAULT_CONSTANTS.TOKEN;
const clone = <T>(x: T): T => structuredClone(x);
const SEED = new Uint8Array(64).fill(0x42); // the seed record-deposit-account.mjs derived test_u from: U_{1,0}
const MAIN = NEAR_NETWORKS.mainnet;
const URL_OF: Record<"a" | "b", string> = { a: MAIN.fastnear[0], b: MAIN.drpc }; // RPC_A (FastNEAR), RPC_C (dRPC)

// A provider that answers from the recording. `pick` maps each request to an answer name; `edit` changes a copy.
type Read = "keys" | "balance" | "code";
type Side = "a" | "b";
function replay(side: Side, pick: Partial<Record<Read, string>> = {}, edit: (r: Read, j: any) => void = () => {}, seen: unknown[] = []): NearRpc {
  const names: Record<Read, string> = { keys: "keys_good", balance: "balance_good", code: "code", ...pick };
  return {
    name: URL_OF[side],
    async query(params) {
      seen.push(params);
      const r: Read = params.request_type === "view_access_key_list" ? "keys" : params.request_type === "call_function" ? "balance" : "code";
      const j = clone(A[names[r]][side].json) as any;
      edit(r, j);
      return j;
    },
  };
}
const pair = (pick: Partial<Record<Read, string>> = {}, editA?: (r: Read, j: any) => void, editB?: (r: Read, j: any) => void) =>
  [replay("a", pick, editA), replay("b", pick, editB)] as const;

async function refused(p: Promise<unknown>, code: RefusalCode, detail?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof DepositAccountRefused, `not a refusal: ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (detail) assert.match(e.message, detail);
    return true;
  });
}
const ONE = 1_000_000n;

test("good recorded answers: U's one key, its nonce, its USDC, the pinned code hash; the Pause gap is stated", async () => {
  const seen: unknown[] = [];
  const r = await checkDepositAccount(rec.good, ONE, "mainnet", [replay("a", {}, undefined, seen), replay("b", {}, undefined, seen)]);
  assert.equal(r.account, rec.good);
  assert.equal(r.publicKey, "ed25519:5heuswzYpTiiDPTZcxQWJRf1JxwTELCHoFv1jVtSA7Q8");
  assert.equal(r.nonce, 121445688000168);
  assert.equal(r.balance, 323841010000n);
  assert.equal(r.codeHash, VAULT_TOKEN_CODE_HASH);
  assert.equal(r.height, 222541714); // the lowest height of the six reads
  assert.equal(r.halted, false);
  assert.equal(r.pendingPause, PENDING_PAUSE);
  assert.equal(PENDING_PAUSE, "unread");
  // Each request names U or USDC only, at final; never a key, a secret or a second account.
  assert.equal(seen.length, 6);
  for (const p of seen as Record<string, unknown>[]) {
    assert.equal(p.finality, "final");
    assert.ok(p.account_id === rec.good || p.account_id === USDC, JSON.stringify(p));
    if (p.request_type === "call_function") {
      assert.equal(p.method_name, "ft_balance_of");
      assert.deepEqual(JSON.parse(Buffer.from(String(p.args_base64), "base64").toString()), { account_id: rec.good });
    }
  }
  // The amount exactly equal to the balance passes.
  assert.equal((await checkDepositAccount(rec.good, 323841010000n, "mainnet", pair())).balance, 323841010000n);
});

test("U is derived at the kit's frozen path; a U not created yet has no key and stops", async () => {
  const u = depositAccount(SEED, 1n, 0);
  assert.equal(u.account, rec.test_u);
  assert.equal(u.account, d.depositId(SEED, 1n, 0).id);
  assert.ok(!("secretKey" in u));
  assert.equal(A.keys_no_account.for, rec.test_u);
  await refused(readDepositAccount(SEED, 1n, 0, ONE, "mainnet", pair({ keys: "keys_no_account" })), "not_created", /wait/);
});

test("U at the kit's frozen path equals every U_{s,i} of the A.8 vector set (test/vectors/a8.json)", () => {
  const a8 = JSON.parse(readFileSync(new URL("./vectors/a8.json", import.meta.url), "utf8"));
  const seed = d.wordsToSeed64(d.entropyToWords(Uint8Array.from(Buffer.from(a8.inputs.entropy, "hex"))));
  const ins = a8.ids.filter((e: { kind: string }) => e.kind === "in");
  assert.equal(ins.length, 4);
  for (const e of ins) {
    const u = depositAccount(seed, BigInt(`0x${e.s}`), e.i);
    assert.equal(u.account, e.id, e.name);
    assert.equal(u.publicKey, `ed25519:${base58.encode(Uint8Array.from(Buffer.from(e.id, "hex")))}`, e.name);
  }
});

test("keys: an extra key stops it (real: a function-call key beside the full one; real: two full keys)", async () => {
  assert.deepEqual([A.keys_good.for, A.keys_fa_fc.for, A.keys_fa_fa.for].map((x) => x.length), [64, 64, 64]);
  assert.equal(A.keys_good.for, rec.good);
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({ keys: "keys_fa_fc" })), "keys", /2 keys/);
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({ keys: "keys_fa_fa" })), "keys", /2 keys/);
});

test("keys: a function-call key only stops it (edited: the good key's permission)", async () => {
  const fc = (r: Read, j: any) => {
    if (r === "keys") j.result.keys[0].access_key.permission = clone(A.keys_fa_fc.a.json as any).result.keys[1].access_key.permission;
  };
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, fc, fc)), "keys", /not a full-access key/);
});

test("keys: one key that is not U's own stops it (real: another account's one full key)", async () => {
  await refused(checkDepositAccount(rec.test_u, ONE, "mainnet", pair()), "keys", /not U's own/);
});

test("nonce: a nonce that is not an exact integer stops it (edited on both RPCs)", async () => {
  for (const bad of [2 ** 53, Number.MAX_SAFE_INTEGER, -1, 1.5, "121445688000168", null, undefined]) {
    const e = (r: Read, j: any) => {
      if (r === "keys") j.result.keys[0].access_key.nonce = bad;
    };
    await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, e, e)), "nonce");
  }
});

test("balance below the amount stops it", async () => {
  await refused(checkDepositAccount(rec.good, 323841010001n, "mainnet", pair()), "balance", /under the amount/);
});

test("a wrong code hash stops it (edited on both RPCs)", async () => {
  const e = (r: Read, j: any) => {
    if (r === "code") j.result.code_hash = "11111111111111111111111111111111";
  };
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, e, e)), "code_hash", /not the pin/);
});

test("a halt stops it: ft_balance_of failing with FiatToken: paused, on either RPC, in either error shape", async () => {
  // Edited: the real panic answer with the halted token's panic message (RESULT.md:153, run 20261026T162244Z).
  const halted = (r: Read, j: any) => {
    if (r === "balance") j.result = clone(A.balance_panic.a.json as any).result, (j.result.error = 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused" })');
  };
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, halted)), "halted");
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, undefined, halted)), "halted");
  const rpcError = (r: Read, j: any) => {
    if (r === "balance") (delete j.result, (j.error = { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: { vm_error: "FiatToken: paused" } }, code: -32000 }));
  };
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, rpcError, rpcError)), "halted");
  // Any other failed balance read (real: a panic of the same view) stops it too, never as a zero.
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({ balance: "balance_panic" })), "rpc", /balance read failed/);
});

test("two RPCs that disagree stop it, on each read (edited on RPC B only)", async () => {
  const cases: [string, (r: Read, j: any) => void, RegExp][] = [
    ["keys", (r, j) => r === "keys" && j.result.keys.push(clone(A.keys_fa_fc.b.json as any).result.keys[1]), /key list/],
    ["nonce", (r, j) => r === "keys" && (j.result.keys[0].access_key.nonce += 1), /nonce/],
    ["balance", (r, j) => r === "balance" && (j.result.result = [...new TextEncoder().encode('"323841010001"')]), /balance/],
    ["code hash", (r, j) => r === "code" && (j.result.code_hash = "11111111111111111111111111111111"), /code hash/],
  ];
  for (const [what, e, detail] of cases) {
    await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, undefined, e)), "disagree", detail).catch((x) => assert.fail(`${what}: ${x}`));
  }
});

test("one RPC down stops it: a thrown read, an HTTP 503, a JSON-RPC error, an answer with no result", async () => {
  const down = (name: string): NearRpc => ({ name, query: async () => { throw new Error("connect ECONNREFUSED"); } });
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", [replay("a"), down(MAIN.drpc)]), "rpc", /drpc.org did not answer/);
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", [down(MAIN.fastnear[0]), replay("b")]), "rpc", /fastnear.com did not answer/);
  const http = nearRpc(MAIN.drpc, (async () => new Response("busy", { status: 503 })) as typeof fetch);
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", [replay("a"), http]), "rpc", /did not answer/);
  const err = (r: Read, j: any) => r === "code" && (delete j.result, (j.error = { code: -32000, message: "Server error" }));
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, undefined, err)), "rpc", /code read failed/);
  const empty = (r: Read, j: any) => r === "keys" && delete j.result;
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, empty)), "rpc", /keys read failed/);
});

test("nearRpc posts one JSON-RPC query and returns the answer; the release's three providers", async () => {
  const bodies: any[] = [];
  const f = (async (url: string, init: RequestInit) => {
    bodies.push({ url, body: JSON.parse(String(init.body)), ct: (init.headers as Record<string, string>)["content-type"] });
    const p = JSON.parse(String(init.body)).params;
    const name = p.request_type === "view_access_key_list" ? "keys_good" : p.request_type === "call_function" ? "balance_good" : "code";
    return new Response(JSON.stringify(A[name][url.includes("fastnear") ? "a" : "b"].json), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await checkDepositAccount(rec.good, ONE, "mainnet", [nearRpc(NEAR_RPC_URLS[0], f), nearRpc(NEAR_RPC_URLS[2], f)]);
  assert.equal(r.balance, 323841010000n);
  assert.equal(bodies.length, 6);
  for (const b of bodies) assert.equal(b.body.method, "query"), assert.equal(b.body.jsonrpc, "2.0"), assert.equal(b.ct, "application/json");
  assert.deepEqual(NEAR_RPC_URLS, ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org", "https://near.drpc.org"]);
});

test("inputs refused with the input code: a 64-hex U, an amount at or above MIN_DEPOSIT, a known network", async () => {
  await refused(checkDepositAccount("alice.near", ONE, "mainnet", pair()), "input", /64-hex/);
  await refused(checkDepositAccount(rec.good.toUpperCase(), ONE, "mainnet", pair()), "input", /64-hex/);
  await refused(checkDepositAccount(rec.good, ONE - 1n, "mainnet", pair()), "input", /MIN_DEPOSIT/);
  await refused(checkDepositAccount(rec.good, 1 as unknown as bigint, "mainnet", pair()), "input", /MIN_DEPOSIT/);
  await refused(checkDepositAccount(rec.good, ONE, "evil.near" as "mainnet", pair()), "input", /unknown network/);
  await refused(checkDepositAccount(rec.good, ONE, "toString" as "mainnet", pair()), "input", /unknown network/);
});

// Review round 2, P2 1: two operators, not two URLs (adversary.mjs case 6).
test("the RPC pair is one FastNEAR URL and the network's dRPC URL, exactly, in either order", async () => {
  const named = (name: string, side: "a" | "b"): NearRpc => ({ ...replay(side), name });
  const ok = async (x: string, y: string) => assert.equal((await checkDepositAccount(rec.good, ONE, "mainnet", [named(x, "a"), named(y, "b")])).balance, 323841010000n);
  await ok(NEAR_RPC_URLS[0], NEAR_RPC_URLS[2]);
  await ok(NEAR_RPC_URLS[1], NEAR_RPC_URLS[2]);
  await ok(NEAR_RPC_URLS[2], NEAR_RPC_URLS[0]);
  const bad: [string, string][] = [
    [NEAR_RPC_URLS[0], NEAR_RPC_URLS[1]], // one operator, two URLs
    [NEAR_RPC_URLS[2], NEAR_RPC_URLS[2]],
    [NEAR_RPC_URLS[0], NEAR_RPC_URLS[0]],
    ["https://near.drpc.org", "https://near.drpc.org/"], // one provider under two names
    [NEAR_RPC_URLS[0], "https://near.drpc.org/"],
    ["https://rpc.mainnet.fastnear.com/", NEAR_RPC_URLS[2]],
    [NEAR_RPC_URLS[0], "https://evil.example"],
    [NEAR_NETWORKS.testnet.fastnear[0], NEAR_NETWORKS.testnet.drpc], // the other network's pair
  ];
  for (const [x, y] of bad) await refused(checkDepositAccount(rec.good, ONE, "mainnet", [named(x, "a"), named(y, "b")]), "input", /exactly/);
  const a = replay("a");
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", [a, a]), "input", /exactly/);
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", [a] as unknown as [NearRpc, NearRpc]), "input", /exactly/);
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", [a, { name: MAIN.drpc }] as unknown as [NearRpc, NearRpc]), "input", /exactly/);
});

// Review round 2, P2 2: a lagging RPC (adversary.mjs cases 2 and 3).
test("heights spread over HEIGHT_SPREAD_MAX blocks stop it; the lowest height is kept", async () => {
  assert.equal(HEIGHT_SPREAD_MAX, 30);
  const lag = (n: number) => (_r: Read, j: any) => void (j.result.block_height -= n);
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, undefined, lag(10_000))), "height", /spread/);
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, undefined, (_r, j) => void (j.result.block_height = 4e15))), "height", /spread/);
  // The recording spans 222541714-222541718: B lagging so the spread is exactly 30 passes, 31 stops.
  const top = 222541718;
  const at = (h: number) => (_r: Read, j: any) => void (j.result.block_height = h);
  const r = await checkDepositAccount(rec.good, ONE, "mainnet", pair({}, undefined, at(top - 30)));
  assert.equal(r.height, top - 30);
  await refused(checkDepositAccount(rec.good, ONE, "mainnet", pair({}, undefined, at(top - 31))), "height");
});

// Review round 2, P2 3: one token per network (adversary.mjs case 7).
test("the caller names the network, never the token: each network reads its one token", async () => {
  const dep = JSON.parse(readFileSync(new URL("../../../contracts/vault/deployments/testnet-usdc.json", import.meta.url), "utf8"));
  assert.equal(NEAR_NETWORKS.testnet.token, dep.account_id);
  assert.equal(dep.code_hash, VAULT_TOKEN_CODE_HASH);
  assert.equal(NEAR_NETWORKS.mainnet.token, USDC);
  // Testnet, on the testnet pair: the code read is the testnet token's real answer (its heights set to the mainnet
  // reads', since two networks' heights never meet); every token read names the testnet token.
  const seen: Record<string, unknown>[] = [];
  const T = NEAR_NETWORKS.testnet;
  const tn = (side: "a" | "b", name: string): NearRpc => ({
    name,
    async query(p) {
      seen.push(p);
      if (p.request_type !== "view_account") return replay(side).query(p);
      const j = clone(A.code_testnet[side].json) as any;
      j.result.block_height = (A.code[side].json as any).result.block_height;
      return j;
    },
  });
  const r = await checkDepositAccount(rec.good, ONE, "testnet", [tn("a", T.fastnear[1]), tn("b", T.drpc)]);
  assert.equal(r.codeHash, VAULT_TOKEN_CODE_HASH);
  assert.equal(A.code_testnet.for, T.token);
  for (const p of seen) assert.ok(p.account_id === rec.good || p.account_id === T.token, JSON.stringify(p));
  // No token parameter exists: a fifth argument changes nothing.
  const spy: Record<string, unknown>[] = [];
  const s = (side: "a" | "b"): NearRpc => ({ name: URL_OF[side], query: (p) => (spy.push(p), replay(side).query(p)) });
  await (checkDepositAccount as (...a: unknown[]) => Promise<unknown>)(rec.good, ONE, "mainnet", [s("a"), s("b")], "evil.near");
  assert.ok(spy.every((p) => p.account_id !== "evil.near"));
});
