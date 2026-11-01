// U's reads before U signs its deposit (card wallet-deposit-account; wallet.md §2.4 step 7, W:416; V 2.10 (a),
// V:666-668, at research aa5bc1e).   node --test test/deposit-account.test.ts   (from packages/wallet)
// The answers are real mainnet answers on RPC_A and RPC_C (test/vectors/deposit-account.json, recorded 2026-11-01T07:26Z
// by a read-only script): an implicit account with one full-access key of its own and USDC (`good`), real accounts
// with a function-call key beside the full one and with two full keys, a derived U that does not exist yet, USDC's
// view_account and a real ft_balance_of panic. A test that needs an answer the chain does not give today (a halt, a
// function-call key alone, a bad nonce, a wrong code hash, two RPCs that disagree) edits one field of a recorded answer
// and says which.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VAULT_CONSTANTS, VAULT_TOKEN_CODE_HASH } from "@blindfill/kit";
import {
  checkDepositAccount,
  depositAccount,
  DepositAccountRefused,
  NEAR_RPC_URLS,
  type NearRpc,
  nearRpc,
  PENDING_PAUSE,
  readDepositAccount,
  type RefusalCode,
} from "../src/deposit/account.ts";
import { depositId } from "../src/derive/index.ts";

type Answers = Record<string, { a: { json: unknown }; b: { json: unknown } }>;
const rec = JSON.parse(readFileSync(new URL("./vectors/deposit-account.json", import.meta.url), "utf8")) as {
  good: string;
  test_u: string;
  answers: Answers;
};
const A = rec.answers;
const USDC = VAULT_CONSTANTS.TOKEN;
const clone = <T>(x: T): T => structuredClone(x);
const SEED = new Uint8Array(64).fill(0x42); // the seed record.mjs derived test_u from: U_{1,0}

// A provider that answers from the recording. `pick` maps each request to an answer name; `edit` changes a copy.
type Read = "keys" | "balance" | "code";
type Side = "a" | "b";
function replay(side: Side, pick: Partial<Record<Read, string>> = {}, edit: (r: Read, j: any) => void = () => {}, seen: unknown[] = []): NearRpc {
  const names: Record<Read, string> = { keys: "keys_good", balance: "balance_good", code: "code", ...pick };
  return {
    name: `recorded-${side}`,
    async query(params) {
      seen.push(params);
      const r: Read = params.request_type === "view_access_key_list" ? "keys" : params.request_type === "call_function" ? "balance" : "code";
      const j = clone(A[names[r]][side].json);
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
  const r = await checkDepositAccount(rec.good, ONE, [replay("a", {}, undefined, seen), replay("b", {}, undefined, seen)]);
  assert.equal(r.account, rec.good);
  assert.equal(r.publicKey, "ed25519:5heuswzYpTiiDPTZcxQWJRf1JxwTELCHoFv1jVtSA7Q8");
  assert.equal(r.nonce, 121445688000168);
  assert.equal(r.balance, 323841010000n);
  assert.equal(r.codeHash, VAULT_TOKEN_CODE_HASH);
  assert.equal(r.height, 222537878); // the lowest height of the six reads
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
  assert.equal((await checkDepositAccount(rec.good, 323841010000n, pair())).balance, 323841010000n);
});

test("U is derived at the kit's frozen path; a U not created yet has no key and stops", async () => {
  const u = depositAccount(SEED, 1n, 0);
  assert.equal(u.account, rec.test_u);
  assert.equal(u.account, depositId(SEED, 1n, 0).id);
  assert.ok(!("secretKey" in u));
  await refused(readDepositAccount(SEED, 1n, 0, ONE, pair({ keys: "keys_no_account" })), "keys", /no key yet/);
});

test("keys: an extra key stops it (real: a function-call key beside the full one; real: two full keys)", async () => {
  await refused(checkDepositAccount(rec.good, ONE, pair({ keys: "keys_fa_fc" })), "keys", /2 keys/);
  await refused(checkDepositAccount(rec.good, ONE, pair({ keys: "keys_fa_fa" })), "keys", /2 keys/);
});

test("keys: a function-call key only stops it (edited: the good key's permission)", async () => {
  const fc = (r: Read, j: any) => {
    if (r === "keys") j.result.keys[0].access_key.permission = clone(A.keys_fa_fc.a.json as any).result.keys[1].access_key.permission;
  };
  await refused(checkDepositAccount(rec.good, ONE, pair({}, fc, fc)), "keys", /not a full-access key/);
});

test("keys: one key that is not U's own stops it (real: another account's one full key)", async () => {
  await refused(checkDepositAccount(rec.test_u, ONE, pair()), "keys", /not U's own/);
});

test("nonce: a nonce that is not an exact integer stops it (edited on both RPCs)", async () => {
  for (const bad of [2 ** 53, Number.MAX_SAFE_INTEGER, -1, 1.5, "121445688000168", null, undefined]) {
    const e = (r: Read, j: any) => {
      if (r === "keys") j.result.keys[0].access_key.nonce = bad;
    };
    await refused(checkDepositAccount(rec.good, ONE, pair({}, e, e)), "nonce");
  }
});

test("balance below the amount stops it", async () => {
  await refused(checkDepositAccount(rec.good, 323841010001n, pair()), "balance", /under the amount/);
});

test("a wrong code hash stops it (edited on both RPCs)", async () => {
  const e = (r: Read, j: any) => {
    if (r === "code") j.result.code_hash = "11111111111111111111111111111111";
  };
  await refused(checkDepositAccount(rec.good, ONE, pair({}, e, e)), "code_hash", /not the pin/);
});

test("a halt stops it: ft_balance_of failing with FiatToken: paused, on either RPC, in either error shape", async () => {
  // Edited: the real panic answer with the halted token's panic message (RESULT.md:153, run 20261026T162244Z).
  const halted = (r: Read, j: any) => {
    if (r === "balance") j.result = clone(A.balance_panic.a.json as any).result, (j.result.error = 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused" })');
  };
  await refused(checkDepositAccount(rec.good, ONE, pair({}, halted)), "halted");
  await refused(checkDepositAccount(rec.good, ONE, pair({}, undefined, halted)), "halted");
  const rpcError = (r: Read, j: any) => {
    if (r === "balance") (delete j.result, (j.error = { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: { vm_error: "FiatToken: paused" } }, code: -32000 }));
  };
  await refused(checkDepositAccount(rec.good, ONE, pair({}, rpcError, rpcError)), "halted");
  // Any other failed balance read (real: a panic of the same view) stops it too, never as a zero.
  await refused(checkDepositAccount(rec.good, ONE, pair({ balance: "balance_panic" })), "rpc", /balance read failed/);
});

test("two RPCs that disagree stop it, on each read (edited on RPC B only)", async () => {
  const cases: [string, (r: Read, j: any) => void, RegExp][] = [
    ["keys", (r, j) => r === "keys" && j.result.keys.push(clone(A.keys_fa_fc.b.json as any).result.keys[1]), /key list/],
    ["nonce", (r, j) => r === "keys" && (j.result.keys[0].access_key.nonce += 1), /nonce/],
    ["balance", (r, j) => r === "balance" && (j.result.result = [...new TextEncoder().encode('"323841010001"')]), /balance/],
    ["code hash", (r, j) => r === "code" && (j.result.code_hash = "11111111111111111111111111111111"), /code hash/],
  ];
  for (const [what, e, detail] of cases) {
    await refused(checkDepositAccount(rec.good, ONE, pair({}, undefined, e)), "disagree", detail).catch((x) => assert.fail(`${what}: ${x}`));
  }
});

test("one RPC down stops it: a thrown read, an HTTP 503, a JSON-RPC error, an answer with no result", async () => {
  const down: NearRpc = { name: "down", query: async () => { throw new Error("connect ECONNREFUSED"); } };
  await refused(checkDepositAccount(rec.good, ONE, [replay("a"), down]), "rpc", /down did not answer/);
  await refused(checkDepositAccount(rec.good, ONE, [down, replay("b")]), "rpc", /down did not answer/);
  const http = nearRpc("https://b.invalid", (async () => new Response("busy", { status: 503 })) as typeof fetch);
  await refused(checkDepositAccount(rec.good, ONE, [replay("a"), http]), "rpc", /did not answer/);
  const err = (r: Read, j: any) => r === "code" && (delete j.result, (j.error = { code: -32000, message: "Server error" }));
  await refused(checkDepositAccount(rec.good, ONE, pair({}, undefined, err)), "rpc", /code read failed/);
  const empty = (r: Read, j: any) => r === "keys" && delete j.result;
  await refused(checkDepositAccount(rec.good, ONE, pair({}, empty)), "rpc", /keys read failed/);
});

test("nearRpc posts one JSON-RPC query and returns the answer; the release's three providers", async () => {
  const bodies: any[] = [];
  const f = (async (url: string, init: RequestInit) => {
    bodies.push({ url, body: JSON.parse(String(init.body)), ct: (init.headers as Record<string, string>)["content-type"] });
    const p = JSON.parse(String(init.body)).params;
    const name = p.request_type === "view_access_key_list" ? "keys_good" : p.request_type === "call_function" ? "balance_good" : "code";
    return new Response(JSON.stringify(A[name][url.includes("fastnear") ? "a" : "b"].json), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await checkDepositAccount(rec.good, ONE, [nearRpc(NEAR_RPC_URLS[0], f), nearRpc(NEAR_RPC_URLS[2], f)]);
  assert.equal(r.balance, 323841010000n);
  assert.equal(bodies.length, 6);
  for (const b of bodies) assert.equal(b.body.method, "query"), assert.equal(b.body.jsonrpc, "2.0"), assert.equal(b.ct, "application/json");
  assert.deepEqual(NEAR_RPC_URLS, ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org", "https://near.drpc.org"]);
});

test("inputs: two different RPCs, a 64-hex U, an amount at or above MIN_DEPOSIT", async () => {
  const a = replay("a");
  await assert.rejects(checkDepositAccount(rec.good, ONE, [a, a]), /two different RPCs/);
  await assert.rejects(checkDepositAccount(rec.good, ONE, [replay("a"), replay("a")]), /two different RPCs/);
  await assert.rejects(checkDepositAccount("alice.near", ONE, pair()), /64-hex/);
  await assert.rejects(checkDepositAccount(rec.good.toUpperCase(), ONE, pair()), /64-hex/);
  await assert.rejects(checkDepositAccount(rec.good, ONE - 1n, pair()), /MIN_DEPOSIT/);
  await assert.rejects(checkDepositAccount(rec.good, 1 as unknown as bigint, pair()), /MIN_DEPOSIT/);
});
