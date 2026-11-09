// Card held-deposit-way-out: a held deposit's U moves its USDC to the typed account by its own transaction
// (src/deposit/moveout.ts). A fake chain answers both RPCs of the testnet release pair; the signed bytes are decoded
// and checked against nearcore's borsh by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { VAULT_CONSTANTS, VAULT_TOKEN_CODE_HASH } from "@blindfill/kit";
import { IDBFactory } from "fake-indexeddb";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import type { DepositOp, FollowRecord } from "../src/deposit/follow.ts";
import { buildMoveOut, buildRegisterOut, buildWithdrawOut, checkMoveCalls, checkRegisterCalls, checkWithdrawCalls, readWithdrawOut, GAS_PRICE_MARGIN, MOVE_GAS, moveCalls, withdrawCalls, type MoveOutRecord, MoveOutRefused, type MoveOutRpc, moveOutHeld, SETTLE_BLOCKS, signedBlockHash, TX_VALIDITY_BLOCKS } from "../src/deposit/moveout.ts";
import * as d from "../src/derive/index.ts";
import { depositId } from "../src/derive/keys.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const NET = NEAR_NETWORKS.testnet;
const TOKEN = NET.usdc;
const U = depositId(SEED, 1n, 0).id;
const TO = "alice.testnet";
const NEAR = 10n ** 24n;
const STORAGE_MIN = 1_250_000_000_000_000_000_000n;
const GAS_PRICE = 100_000_000n;
const opened: WalletStore[] = [];
after(() => opened.forEach((s) => s.close()));

type Side = { height: number };
class Chain {
  a: Side = { height: 1000 };
  b: Side = { height: 1000 };
  nonce = 7n;
  near = NEAR / 10n; // 0.1 N
  usage = 182n;
  usdc = 2_500_000n;
  /** what U holds inside intents.near (mt_balance_of on nep141:<token>); null: the view fails */
  held: bigint | null = 3_000_000n;
  registered = new Set<string>();
  keys = 1;
  /** U's one key is another key (not U's own) */
  foreignKey: string | null = null;
  sent: string[] = [];
  txs = new Map<string, "ok" | "failed">();
  /** the access key nonce answered as a JSON string (nearcore answers a number; a hostile RPC may not) */
  nonceString = false;
  /** the access key nonce answered as this exact JSON string, on both RPCs */
  nonceText: string | undefined = undefined;
  /** the head hash both RPCs answer (default: a 32-byte hash per height) */
  headHash: string | null = null;
  /** U's key nonce at a height (default: the current one at every height) */
  nonceAt: (h: number) => bigint = () => this.nonce;
  /** what the second RPC answers differently, at the same height */
  skewB: Partial<{ nonce: bigint; usdc: bigint; registered: boolean; gas: bigint; hash: string; near: bigint; code: string; held: bigint }> = {};
  /** the second RPC's own tx states (default: the same as the first's) */
  txsB: Map<string, "ok" | "failed"> | null = null;
  /** txs both of the pair no longer keep (they answer them as unknown); the archival RPC keeps every one */
  forgot = new Set<string>();
  /** the archival RPC's own tx states (default: every tx in txs, forgotten or not), or no answer there at all */
  archTxs: Map<string, "ok" | "failed"> | null = null;
  archDown = false;
  code = VAULT_TOKEN_CODE_HASH;
  /** what a send does: lands (the default), fails, or is lost */
  onSend: (signed: string, hash: string) => void = (_s, h) => this.land(h);
  land(hash: string) {
    this.txs.set(hash, "ok");
    this.nonce += 1n;
    this.usdc = 1n;
  }
  rpc(name: string, k: "a" | "b"): MoveOutRpc {
    const at = (p: Record<string, unknown>) => (p.block_id as number | undefined) ?? this[k].height;
    const view = (v: unknown, h: number) => ({ result: { block_height: h, result: [...Buffer.from(JSON.stringify(v))] } });
    const sk = k === "b" ? this.skewB : {};
    return {
      name,
      block: async (p) => {
        const h = "block_id" in p ? p.block_id : this[k].height;
        return { result: { header: { height: h, hash: sk.hash ?? this.headHash ?? base58.encode(sha256(new TextEncoder().encode(`b${h}`))), timestamp_nanosec: "1" } } };
      },
      query: async (p) => {
        const h = at(p);
        if (p.request_type === "view_access_key_list") {
          const own = `ed25519:${base58.encode(Uint8Array.from(U.match(/../g)!, (x) => parseInt(x, 16)))}`;
          const keys = [{ public_key: this.foreignKey ?? own, access_key: { nonce: this.nonceText ?? (this.nonceString ? String(sk.nonce ?? this.nonceAt(h)) : Number(sk.nonce ?? this.nonceAt(h))), permission: "FullAccess" } }];
          if (this.keys > 1) keys.push({ public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 0, permission: "FullAccess" } });
          return { result: { block_height: h, keys } };
        }
        if (p.request_type === "view_account" && p.account_id === TOKEN) return { result: { block_height: h, amount: "1", locked: "0", storage_usage: 1, code_hash: sk.code ?? this.code } };
        if (p.request_type === "view_account") return { result: { block_height: h, amount: (sk.near ?? this.near).toString(), locked: "0", storage_usage: Number(this.usage), code_hash: "11111111111111111111111111111111" } };
        const args = JSON.parse(Buffer.from(p.args_base64 as string, "base64").toString());
        if (p.method_name === "ft_balance_of") return view((sk.usdc ?? this.usdc).toString(), h);
        if (p.method_name === "storage_balance_of") return view((sk.registered ?? this.registered.has(args.account_id)) ? { total: STORAGE_MIN.toString(), available: "0" } : null, h);
        if (p.method_name === "mt_balance_of" && p.account_id === "intents.near" && args.account_id === U && args.token_id === `nep141:${TOKEN}`) {
          const v = sk.held ?? this.held;
          if (v === null) throw new Error("no view");
          return view(v.toString(), h);
        }
        if (p.method_name === "storage_balance_bounds") return view({ min: STORAGE_MIN.toString(), max: STORAGE_MIN.toString() }, h);
        throw new Error(`unexpected ${String(p.method_name)}`);
      },
      // the release RPCs, read 8 Nov 2026: a hash nobody sent answers UNKNOWN_TRANSACTION (HTTP 200) only to wait_until
      // NONE; to FINAL fastnear times out (10 s, or no answer in 30 s) and dRPC answers HTTP 408, which the client throws
      tx: async ({ tx_hash, sender_account_id, wait_until }) => {
        const st = this.forgot.has(tx_hash) ? undefined : (k === "b" && this.txsB !== null ? this.txsB : this.txs).get(tx_hash);
        if (st === undefined) {
          if (wait_until === "NONE") return { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } };
          throw new Error("HTTP 408");
        }
        const status = st === "ok" ? { SuccessValue: "" } : { Failure: { ActionError: {} } };
        return { result: { final_execution_status: "FINAL", status, transaction: { hash: tx_hash, signer_id: sender_account_id }, receipts_outcome: [{ id: "r", outcome: { status } }] } };
      },
      call: async (method, params) => {
        if (method === "gas_price") return { result: { gas_price: (sk.gas ?? GAS_PRICE).toString() } };
        if (method === "send_tx") {
          const signed = (params as { signed_tx_base64: string }).signed_tx_base64;
          this.sent.push(signed);
          const bytes = base64.decode(signed);
          const hash = base58.encode(sha256(bytes.subarray(0, bytes.length - 65)));
          if (k === "a" && !this.txs.has(hash)) this.onSend(signed, hash);
          return { result: {} };
        }
        throw new Error(method);
      },
    };
  }
  rpcs(): readonly [MoveOutRpc, MoveOutRpc] {
    return [this.rpc(NET.fastnear[0], "a"), this.rpc(NET.drpc, "b")];
  }
  /** the network's archival RPC: every tx ever (UNKNOWN_TRANSACTION to NONE for one never sent), or no answer when down */
  archival(name: string = NET.archival[0]): MoveOutRpc {
    const base = this.rpc(name, "a");
    return {
      ...base,
      tx: async (p) => {
        if (this.archDown) throw new Error("HTTP 503");
        const st = (this.archTxs ?? this.txs).get(p.tx_hash);
        if (st === undefined) {
          if (p.wait_until === "NONE") return { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } };
          throw new Error("HTTP 408");
        }
        const status = st === "ok" ? { SuccessValue: "" } : { Failure: { ActionError: {} } };
        return { result: { final_execution_status: "FINAL", status, transaction: { hash: p.tx_hash, signer_id: p.sender_account_id }, receipts_outcome: [{ id: "r", outcome: { status } }] } };
      },
    };
  }
}

async function heldOp(why: string, extra: Partial<FollowRecord> = {}) {
  const ops = await openWalletStore({ indexedDB: new IDBFactory() });
  opened.push(ops);
  // 1Click delivered it: its money is in U (follow.ts needOf)
  const follow: FollowRecord = { network: "testnet", s: "1", i: 0, u: U, address: "dep-addr", deadline_ms: 1, origin: "nep141:x", min_out: "1000000", delivered: "2500000", why, ...extra };
  const op: DepositOp = { kind: "deposit", stage: "held", txs: [], created_ms: 1, follow, held_id: U };
  await ops.put("ops", "op1", op);
  return ops;
}
let seedOpens = 0;
// the helper's 1Click status read at the tap (moveout.ts reread): each deposit address's answer, or HTTP 503 (a failed
// read) for one not listed; every address asked, in order
const statusReads: string[] = [];
const oneClick = (answers: Record<string, [string, string?]> = {}) =>
  (async (url: string) => {
    const address = decodeURIComponent(url.split("depositAddress=")[1] ?? "");
    statusReads.push(address);
    const a = answers[address];
    if (a === undefined) return new Response("{}", { status: 503 });
    const swapDetails = a[1] === undefined ? {} : { amountOut: a[1] };
    return Response.json({ status: a[0], quoteResponse: { quote: { depositAddress: address }, quoteRequest: { recipient: U, refundTo: U } }, swapDetails });
  }) as typeof fetch;
const deps = (ops: WalletStore, chain: Chain, status: Record<string, [string, string?]> = {}) => ({ ops, rpcs: chain.rpcs(), archival: NET.archival.map((n) => chain.archival(n)), seed64: async () => (seedOpens++, SEED.slice()), sleep: async () => {}, pollMs: 0, fetchFn: oneClick(status) });

// A signed transaction decoded (nearcore Transaction V0 then a Signature), for the checks below.
function decode(signed: string) {
  const b = base64.decode(signed);
  let at = 0;
  const n = (k: number) => {
    let v = 0n;
    for (let j = k - 1; j >= 0; j--) v = (v << 8n) | BigInt(b[at + j]!);
    at += k;
    return v;
  };
  const raw = (k: number) => b.subarray((at += k) - k, at);
  const str = () => new TextDecoder().decode(raw(Number(n(4))));
  const signer = str();
  assert.equal(n(1), 0n);
  const pk = raw(32);
  const nonce = n(8);
  const receiver = str();
  raw(32);
  const count = Number(n(4));
  const actions = [];
  for (let j = 0; j < count; j++) {
    assert.equal(n(1), 2n, "FunctionCall");
    actions.push({ method: str(), args: JSON.parse(new TextDecoder().decode(raw(Number(n(4))))), gas: n(8), deposit: n(16) });
  }
  const body = b.subarray(0, at);
  assert.equal(n(1), 0n);
  const sig = raw(64);
  assert.equal(at, b.length);
  assert.ok(ed25519.verify(sig, sha256(body), pk), "U's key signed sha256(tx)");
  return { signer, pk, nonce, receiver, actions };
}

for (const why of ["sender_struck", "amount_above_balance", "input", "note", "leaf", "refused"]) {
  test(`a held op (${why}) moves U's USDC less one base unit to the typed account, registered: one ft_transfer, FINAL on both, ends moved_out`, async () => {
    const chain = new Chain();
    chain.registered.add(TO);
    const ops = await heldOp(why);
    const out = await moveOutHeld("op1", TO, deps(ops, chain));
    assert.equal(out.kind, "moved");
    const tx = decode(chain.sent[0]!);
    assert.equal(tx.signer, U);
    assert.equal(tx.receiver, TOKEN);
    assert.equal(tx.nonce, 8n);
    assert.deepEqual(tx.actions, [{ method: "ft_transfer", args: { receiver_id: TO, amount: "2499999" }, gas: MOVE_GAS.ft_transfer, deposit: 1n }]);
    const op = (await ops.get("ops", "op1")) as DepositOp;
    assert.equal(op.stage, "held");
    assert.equal(op.follow.why, "moved_out");
    assert.equal(op.follow.out?.to, TO);
  });
}

test("an unregistered typed account: the registration then the ft_transfer, in one signed transaction", async () => {
  const chain = new Chain();
  const ops = await heldOp("sender_struck");
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "moved");
  const tx = decode(chain.sent[0]!);
  assert.deepEqual(tx.actions.map((a) => a.method), ["storage_deposit", "ft_transfer"]);
  assert.deepEqual(tx.actions[0], { method: "storage_deposit", args: { account_id: TO, registration_only: true }, gas: MOVE_GAS.storage_deposit, deposit: STORAGE_MIN });
});

test("U's NEAR short of the cost: answers how much NEAR U needs and signs nothing", async () => {
  const chain = new Chain();
  chain.near = chain.usage * 10n ** 19n; // its storage only, as the helper creates it
  const ops = await heldOp("sender_struck");
  seedOpens = 0;
  const out = await moveOutHeld("op1", TO, deps(ops, chain));
  const need = (MOVE_GAS.ft_transfer + MOVE_GAS.storage_deposit + MOVE_GAS.send) * GAS_PRICE * GAS_PRICE_MARGIN + 1n + STORAGE_MIN;
  assert.deepEqual(out, { kind: "gas", need, u: U });
  assert.equal(chain.sent.length, 0);
  assert.equal(seedOpens, 0, "the seed is not opened");
});

test("nothing signed when the two RPCs disagree, U holds a second key, or U holds one base unit", async () => {
  for (const plant of [(c: Chain) => (c.b.height += 1000), (c: Chain) => (c.keys = 2)]) {
    const chain = new Chain();
    plant(chain);
    const ops = await heldOp("sender_struck");
    assert.deepEqual(await moveOutHeld("op1", TO, deps(ops, chain)), { kind: "unread" });
    assert.equal(chain.sent.length, 0);
  }
  const chain = new Chain();
  chain.usdc = 1n;
  assert.deepEqual(await moveOutHeld("op1", TO, deps(await heldOp("sender_struck"), chain)), { kind: "empty" });
});

test("a resume after the send signs nothing new: the same bytes again, then moved_out", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {}; // lost on the way
  const ops = await heldOp("amount_above_balance");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "sent");
  const bytes = chain.sent[0]!;
  // the reload: another account typed is not used, the recorded move goes on
  chain.onSend = (_s, h) => chain.land(h);
  seedOpens = 0;
  const again = await moveOutHeld("op1", "bob.testnet", deps(ops, chain));
  assert.equal(again.kind, "moved");
  assert.equal(seedOpens, 0, "no new signature");
  assert.ok(chain.sent.every((s) => s === bytes), "only the recorded bytes were sent");
  assert.equal((again as { to: string }).to, TO);
  // and once more: moved, nothing sent
  const n = chain.sent.length;
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "moved");
  assert.equal(chain.sent.length, n);
});

test("a recorded move that read FINAL failed on both is signed again at U's next nonce; one never landable at the same nonce", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = (_s, h) => (chain.txs.set(h, "failed"), (chain.nonce += 1n));
  const ops = await heldOp("sender_struck");
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "failed");
  chain.onSend = (_s, h) => chain.land(h);
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "moved");
  assert.deepEqual(chain.sent.map((s) => decode(s).nonce).filter((x, k, a) => a.indexOf(x) === k), [8n, 9n]);

  const c2 = new Chain();
  c2.registered.add(TO);
  c2.onSend = () => {};
  const ops2 = await heldOp("sender_struck");
  assert.equal((await moveOutHeld("op1", TO, deps(ops2, c2))).kind, "sent");
  c2.a.height = c2.b.height = 1000 + Number(TX_VALIDITY_BLOCKS) + 1;
  c2.onSend = (_s, h) => c2.land(h);
  assert.equal((await moveOutHeld("op1", TO, deps(ops2, c2))).kind, "moved");
  const nonces = c2.sent.map((s) => decode(s).nonce);
  assert.ok(nonces.every((x) => x === 8n), "the expired move is signed again at its own nonce");
});

test("refused: an op that is not held, a struck intents route, or a seed that is not U's", async () => {
  const chain = new Chain();
  const live = await heldOp("sender_struck");
  await live.update("ops", "op1", (v) => ({ ...(v as DepositOp), stage: "into_vault" }));
  await assert.rejects(moveOutHeld("op1", TO, deps(live, chain)), MoveOutRefused);
  await assert.rejects(moveOutHeld("op1", TO, deps(await heldOp("sender_struck", { intents_struck: true }), chain)), MoveOutRefused);
  const other = await heldOp("sender_struck");
  chain.registered.add(TO);
  await assert.rejects(moveOutHeld("op1", TO, { ...deps(other, chain), seed64: async () => d.wordsToSeed64(d.entropyToWords(new Uint8Array(16).fill(1))) }), MoveOutRefused);
  assert.equal(chain.sent.length, 0);
});

test("the payload rule refuses a memo, another receiver, an amount at U's whole balance, U or the token as the typed account", () => {
  const ok = moveCalls(TO, 2_499_999n, true, STORAGE_MIN);
  checkMoveCalls(U, TO, TOKEN, ok, 2_500_000n, STORAGE_MIN);
  const bad = [
    () => checkMoveCalls(U, TO, TOKEN, moveCalls(TO, 2_500_000n, false, 0n), 2_500_000n, 0n),
    () => checkMoveCalls(U, TO, TOKEN, [{ ...ok[1]!, args: { receiver_id: TO, amount: "1", memo: "x" } }], 2_500_000n, 0n),
    () => checkMoveCalls(U, TO, TOKEN, [{ ...ok[1]!, args: { receiver_id: "bob.testnet", amount: "1" } }], 2_500_000n, 0n),
    () => checkMoveCalls(U, TO, TOKEN, [{ ...ok[0]!, args: { account_id: "bob.testnet", registration_only: true } }, ok[1]!], 2_500_000n, STORAGE_MIN),
    () => checkMoveCalls(U, TO, TOKEN, [ok[1]!, ok[0]!], 2_500_000n, STORAGE_MIN),
    () => checkMoveCalls(U, U, TOKEN, moveCalls(U, 1n, false, 0n), 2_500_000n, 0n),
    () => checkMoveCalls(U, TOKEN, TOKEN, moveCalls(TOKEN, 1n, false, 0n), 2_500_000n, 0n),
  ];
  for (const f of bad) assert.throws(f, MoveOutRefused);
});

test("the payload rule reads an amount only as plain digits and the registration with its two args alone: \"+5\", \"-5\" or an extra arg is refused (review 5 F3)", () => {
  const ok = moveCalls(TO, 5n, true, STORAGE_MIN);
  checkMoveCalls(U, TO, TOKEN, ok, 2_500_000n, STORAGE_MIN);
  for (const amount of ["+5", "-5", " 5", "05", "5.0", "0x5", "5n"]) {
    assert.throws(() => checkMoveCalls(U, TO, TOKEN, [ok[0]!, { ...ok[1]!, args: { receiver_id: TO, amount } }], 2_500_000n, STORAGE_MIN), /the amount is above/, `amount ${JSON.stringify(amount)}`);
  }
  assert.throws(
    () => checkMoveCalls(U, TO, TOKEN, [{ ...ok[0]!, args: { account_id: TO, registration_only: true, extra: 1 } }, ok[1]!], 2_500_000n, STORAGE_MIN),
    /the registration is storage_deposit/,
  );
});

test("the ft_withdraw rule (card exit-ids-out) refuses a memo, a msg, another token or receiver, the vault, more than held less the keep, and a second call", () => {
  const ok = withdrawCalls(TO, 2_999_999n, TOKEN);
  checkWithdrawCalls(U, TO, TOKEN, ok, 3_000_000n);
  checkWithdrawCalls(U, TO, TOKEN, withdrawCalls(TO, 3_000_000n, TOKEN), 3_000_000n, 0n); // A: all
  const c = ok[0]!;
  const bad = [
    () => checkWithdrawCalls(U, TO, TOKEN, withdrawCalls(TO, 3_000_000n, TOKEN), 3_000_000n),
    () => checkWithdrawCalls(U, TO, TOKEN, [{ ...c, args: { ...c.args, memo: "x" } }], 3_000_000n),
    () => checkWithdrawCalls(U, TO, TOKEN, [{ ...c, args: { ...c.args, msg: "{}" } }], 3_000_000n),
    () => checkWithdrawCalls(U, TO, TOKEN, [{ ...c, args: { ...c.args, token: "other.testnet" } }], 3_000_000n),
    () => checkWithdrawCalls(U, TO, TOKEN, [{ ...c, args: { ...c.args, receiver_id: "bob.testnet" } }], 3_000_000n),
    () => checkWithdrawCalls(U, NET.vault, TOKEN, withdrawCalls(NET.vault, 1n, TOKEN), 3_000_000n),
    () => checkWithdrawCalls(U, TO, TOKEN, [c, c], 3_000_000n),
    () => checkWithdrawCalls(U, TO, TOKEN, [{ ...c, deposit: 0n }], 3_000_000n),
    () => checkWithdrawCalls(U, TO, "other.testnet", withdrawCalls(TO, 1n, "other.testnet"), 3_000_000n),
  ];
  for (const f of bad) assert.throws(f, MoveOutRefused);
});

test("readWithdrawOut (card exit-ids-out): what U holds inside intents.near at readMoveOut's block on both RPCs, equal, else unread", async () => {
  const chain = new Chain();
  chain.b.height = 1003;
  const r = await readWithdrawOut(U, TO, TOKEN, chain.rpcs());
  assert.ok(r !== null);
  assert.equal(r.held, 3_000_000n);
  assert.equal(r.height, 1000, "the lower final height, as readMoveOut reads");
  assert.equal(r.nonce, 7n);
  assert.ok(!("usdc" in r), "the token's balance is not the amount moved");
  chain.skewB = { held: 3_000_001n };
  assert.equal(await readWithdrawOut(U, TO, TOKEN, chain.rpcs()), null, "two RPCs that differ");
  chain.skewB = {};
  chain.held = null;
  assert.equal(await readWithdrawOut(U, TO, TOKEN, chain.rpcs()), null, "a failed view is unread, never a zero");
  chain.held = 3_000_000n;
  chain.skewB = { usdc: 1n };
  assert.equal(await readWithdrawOut(U, TO, TOKEN, chain.rpcs()), null, "readMoveOut's own reads must agree too");
});

test("review 2 of exit-ids-out: a typed account or token that is not a string is refused by every builder; each builder checks its read, signs with its own key copy and zeroes that copy", () => {
  const k = depositId(SEED, 1n, 0);
  const k2 = depositId(SEED, 1n, 1);
  const BH = "11111111111111111111111111111111";
  const keyOf = () => ({ ...k, secretKey: k.secretKey.slice() });
  const base = { height: 1000, blockHash: BH, nonce: 7n, free: NEAR, usdc: 2_500_000n, held: 3_000_000n, gasPrice: 100_000_000n, u: U, to: TO, token: TOKEN };
  const builders = {
    move: (to: unknown, token: unknown, read: Record<string, unknown>, key = keyOf()) => buildMoveOut({ read: { ...base, registered: false, ...read } as never, key, kind: "id", to: to as string, token: token as string, storageMin: STORAGE_MIN }),
    register: (to: unknown, token: unknown, read: Record<string, unknown>, key = keyOf()) => buildRegisterOut({ read: { ...base, registered: false, ...read } as never, key, to: to as string, token: token as string, storageMin: STORAGE_MIN }),
    withdraw: (to: unknown, token: unknown, read: Record<string, unknown>, key = keyOf()) => buildWithdrawOut({ read: { ...base, registered: true, ...read } as never, key, kind: "id", to: to as string, token: token as string }),
  };
  for (const [name, b] of Object.entries(builders)) {
    // M1: a String or an object whose toJSON names the vault or intents.near, as both `to` and the read's `to`
    for (const name2 of [NET.vault, "intents.near"]) {
      for (const to of [new String(name2), { toJSON: () => name2 }]) {
        assert.throws(() => b(to, TOKEN, { to }), MoveOutRefused, `${name}: to ${String(to)}`);
      }
      const tok = new String(TOKEN);
      assert.throws(() => b(TO, tok, { token: tok }), MoveOutRefused, `${name}: a String token`);
    }
    // M2: a read of another account, typed account or token
    for (const [f, v] of [["u", k2.id], ["to", "bob.testnet"], ["token", NEAR_NETWORKS.mainnet.usdc]] as const) assert.throws(() => b(TO, TOKEN, { [f]: v }), MoveOutRefused, `${name}: read.${f}`);
    // L3: the read's nonce, block hash and registration
    for (const bad of [{ nonce: -1n }, { nonce: 7 }, { blockHash: "1111" }, { blockHash: 32 }, { blockHash: "0OIl" }, { registered: "no" }]) assert.throws(() => b(TO, TOKEN, bad), MoveOutRefused, `${name}: ${JSON.stringify(bad, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`);
    // M2: the key's fields read once: a getter that answers another key on its second read does not sign with it
    const flipped = Object.defineProperties({ ...keyOf() }, {
      publicKey: { get: ((n = 0) => () => (n++ === 0 ? k.publicKey : k2.publicKey))(), enumerable: true },
      secretKey: { get: ((n = 0, own = k.secretKey.slice()) => () => (n++ === 0 ? own : k2.secretKey.slice()))(), enumerable: true },
    });
    const m = b(TO, TOKEN, {}, flipped as never);
    const signed = base64.decode(m.signed);
    const txBytes = signed.slice(0, signed.length - 65);
    assert.ok(ed25519.verify(signed.slice(signed.length - 64), sha256(txBytes), k.publicKey), `${name}: signed by the key it checked`);
    // M2 (review 3 M1): the builder's own copy of the key is zeroed whole, on a build and on a refusal. The arrays
    // whose length is read while they hold the secret during the call are recorded by identity (the builder reads its
    // copy's length), and after the call each one but the caller's own must read all zero. A copy whose length is never
    // read that way is out of this spy's sight: the source pin below holds every expression that touches the secret.
    for (const refuse of [false, "read", "key"] as const) {
      const lengthOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "length")!;
      const seen = new Set<Uint8Array>();
      Object.defineProperty(Object.getPrototypeOf(Uint8Array.prototype), "length", {
        ...lengthOf,
        get(this: Uint8Array) {
          const n = lengthOf.get!.call(this) as number;
          if (n === 32 && this instanceof Uint8Array && k.secretKey.every((x, i) => this[i] === x)) seen.add(this);
          return n;
        },
      });
      const own = refuse === "key" ? { ...keyOf(), id: k2.id } : keyOf();
      try {
        if (refuse === "read") assert.throws(() => b(TO, TOKEN, { u: k2.id }, own), MoveOutRefused);
        else if (refuse === "key") assert.throws(() => b(TO, TOKEN, { u: k2.id }, own), MoveOutRefused);
        else b(TO, TOKEN, {}, own);
      } finally {
        Object.defineProperty(Object.getPrototypeOf(Uint8Array.prototype), "length", lengthOf);
      }
      assert.ok(own.secretKey.some((x) => x !== 0), "the caller's key is the caller's to zero");
      seen.delete(own.secretKey);
      assert.ok(seen.size >= 1, `${name}: the builder's copy was seen`);
      for (const c of seen) assert.ok(c.every((x) => x === 0), `${name}${refuse ? ` (refused: ${refuse})` : ""}: a copy of the secret is left live`);
    }
    // review 3 L1: a nonce whose + 1 is past a u64, a storage minimum past a u128, are refused, never wrapped
    assert.throws(() => b(TO, TOKEN, { nonce: (1n << 64n) - 1n }), MoveOutRefused, `${name}: nonce 2^64 - 1`);
    b(TO, TOKEN, { nonce: (1n << 64n) - 2n });
  }
});

test("review 3 of exit-ids-out: a storage minimum at or past 2^128 is refused by the move and the registration; checkWithdrawCalls and checkRegisterCalls refuse a String vault or intents.near", () => {
  const k = depositId(SEED, 1n, 0);
  const BH = "11111111111111111111111111111111";
  const key = () => ({ ...k, secretKey: k.secretKey.slice() });
  const read = { height: 1000, blockHash: BH, nonce: 7n, free: NEAR, usdc: 2_500_000n, registered: false, gasPrice: 100_000_000n, u: U, to: TO, token: TOKEN };
  for (const min of [1n << 128n, (1n << 128n) + 1n]) {
    assert.throws(() => buildMoveOut({ read, key: key(), kind: "id", to: TO, token: TOKEN, storageMin: min }), MoveOutRefused);
    assert.throws(() => buildRegisterOut({ read, key: key(), to: TO, token: TOKEN, storageMin: min }), MoveOutRefused);
  }
  buildRegisterOut({ read, key: key(), to: TO, token: TOKEN, storageMin: (1n << 128n) - 1n });
  // the largest storage minimum a u128 holds is built, and signed as itself (review 4, L2)
  const top = buildMoveOut({ read, key: key(), kind: "id", to: TO, token: TOKEN, storageMin: (1n << 128n) - 1n });
  assert.equal(top.calls[0]!.method, "storage_deposit");
  assert.equal(top.calls[0]!.deposit, (1n << 128n) - 1n);
  const bytes = base64.decode(top.signed);
  const tx = bytes.slice(0, bytes.length - 65);
  // the storage_deposit action's deposit, the u128 just before the ft_transfer action's tag (2) and method name
  const name = new TextEncoder().encode("ft_transfer");
  let at = -1;
  for (let i = tx.length - name.length; i >= 0 && at < 0; i--) if (name.every((b, j) => tx[i + j] === b)) at = i;
  const end = at - 4 - 1; // the method name's u32 length and the FunctionCall tag
  const dep = tx.slice(end - 16, end);
  assert.equal(dep.length, 16);
  assert.ok(dep.every((b) => b === 0xff), "the signed deposit is 2^128 - 1, not a wrapped value");
  for (const name of [NET.vault, "intents.near"]) {
    for (const to of [new String(name), { toJSON: () => name }] as unknown as string[]) {
      assert.throws(() => checkWithdrawCalls(U, to, TOKEN, withdrawCalls(to, 1n, TOKEN), 2n), MoveOutRefused, `withdraw ${name}`);
      assert.throws(() => checkRegisterCalls(U, to, TOKEN, [{ method: "storage_deposit", args: { account_id: to, registration_only: true }, gas: MOVE_GAS.storage_deposit, deposit: STORAGE_MIN }], STORAGE_MIN), MoveOutRefused, `register ${name}`);
    }
    const tok = new String(TOKEN) as unknown as string;
    assert.throws(() => checkWithdrawCalls(U, TO, tok, withdrawCalls(TO, 1n, tok), 2n), MoveOutRefused);
    assert.throws(() => checkRegisterCalls(U, TO, tok, [{ method: "storage_deposit", args: { account_id: TO, registration_only: true }, gas: MOVE_GAS.storage_deposit, deposit: STORAGE_MIN }], STORAGE_MIN), MoveOutRefused);
  }
});

/**
 * Every expression in moveout.ts that touches a secret key, as text (review 4, L1): no in-process spy sees a copy kept
 * in a module array, a 64-byte secret-and-public copy or a DataView over a copied buffer, so each line that names
 * secretKey or sk is pinned here. A new copy site fails this test until it is reviewed and the pin is changed with it.
 */
const SECRET_LINES = [
  "function signMoveTx(publicKey: Uint8Array, secretKey: Uint8Array, nonce: bigint, blockHash: string, move: SealedMove): { hash: string; signed: string } {",
  "const signature = ed25519.sign(digest, secretKey);",
  "secretKey: Uint8Array;",
  "const id = k.id, pk = k.publicKey, sk = k.secretKey;",
  'if (!(sk instanceof Uint8Array) || !(pk instanceof Uint8Array)) throw new MoveOutRefused("the key is not a pair of 32-byte arrays");',
  "const key = { id, publicKey: new Uint8Array(pk), secretKey: new Uint8Array(sk) };",
  "if (key.secretKey.length !== 32 || key.publicKey.length !== 32 || typeof id !== \"string\" || !IMPLICIT.test(id) || hex(key.publicKey) !== id || hex(ed25519.getPublicKey(key.secretKey)) !== id) {",
  "key.secretKey.fill(0);",
  "const tx = signMoveTx(key.publicKey, key.secretKey, nonce, read.blockHash, move);",
  "key.secretKey.fill(0);",
  "const tx = signMoveTx(key.publicKey, key.secretKey, nonce, read.blockHash, move);",
  "key.secretKey.fill(0);",
  "const tx = signMoveTx(key.publicKey, key.secretKey, nonce, read.blockHash, move);",
  "key.secretKey.fill(0);",
  "return signMoveTx(k.publicKey, k.secretKey, nonce, read.blockHash, move);",
  "k.secretKey.fill(0);",
];
test("moveout.ts touches a secret key only in the pinned expressions (review 4, L1)", () => {
  const src = readFileSync(new URL("../src/deposit/moveout.ts", import.meta.url), "utf8");
  const code = src.split("\n").map((l) => l.trim()).filter((l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
  const touched = code.filter((l) => /\b(secretKey|sk)\b/.test(l));
  assert.deepEqual(touched.slice().sort(), SECRET_LINES.slice().sort());
});

test("the exit's typed-account rule refuses exactly what checkMoveCalls refuses, over every moving account, token and typed account (card exit-ids-out)", () => {
  const k = depositId(SEED, 1n, 0);
  const tos = [NET.vault, "intents.near", TOKEN, U, "bob.testnet", "c".repeat(64), NEAR_NETWORKS.mainnet.vault, NEAR_NETWORKS.mainnet.usdc, "other.testnet"];
  const verdict = (f: () => unknown) => { try { f(); return "ok"; } catch (e) { return e instanceof MoveOutRefused ? "refused" : `other: ${String(e)}`; } };
  let oks = 0;
  for (const u of [U, "bob.testnet"]) {
    for (const token of [TOKEN, NEAR_NETWORKS.mainnet.usdc, "other.testnet"]) {
      for (const to of tos) {
        const held = verdict(() => checkMoveCalls(u, to, token, moveCalls(to, 1n, false, 0n), 2n, 0n));
        const withdraw = verdict(() => checkWithdrawCalls(u, to, token, withdrawCalls(to, 1n, token), 2n));
        assert.equal(withdraw, held, `withdraw: ${u} ${token} ${to}`);
        if (u === U) {
          const register = verdict(() => buildRegisterOut({ read: { nonce: 1n, blockHash: "11111111111111111111111111111111", registered: false, u, to, token }, key: { ...k, secretKey: k.secretKey.slice() }, to, token, storageMin: STORAGE_MIN }));
          assert.equal(register, held, `register: ${token} ${to}`);
        }
        if (held === "ok") oks++;
      }
    }
  }
  assert.ok(oks >= 4, "some cases pass, so the loop tests the refusals and not a broken setup");
});

test("each exit builder signs what it checked: a getter that answers the check one value and the signer another changes nothing (card exit-ids-out, review M1)", () => {
  const k = depositId(SEED, 1n, 0);
  const BH = "11111111111111111111111111111111";
  const flip = <T,>(first: T, later: T) => { let n = 0; return () => (n++ === 0 ? first : later); };
  const signedText = (m: { signed: string }) => new TextDecoder().decode(base64.decode(m.signed));
  const keyOf = () => ({ ...k, secretKey: k.secretKey.slice() });
  const getterArgs = <A extends object>(base: A, field: keyof A & string, later: unknown) => Object.defineProperty({ ...base }, field, { get: flip((base as Record<string, unknown>)[field], later), enumerable: true });
  const read = { height: 1000, blockHash: BH, nonce: 7n, free: NEAR, usdc: 2_500_000n, registered: false, gasPrice: 100_000_000n, u: U, to: TO, token: TOKEN };
  const move = { read, key: keyOf(), kind: "id" as const, to: TO, token: TOKEN, storageMin: STORAGE_MIN };
  for (const [field, later] of [["to", "evil.testnet"], ["token", "evil.testnet"], ["storageMin", 9n], ["kind", "arm"]] as const) {
    const m = buildMoveOut(getterArgs({ ...move, key: keyOf() }, field, later));
    assert.ok(!signedText(m).includes("evil"), `buildMoveOut ${field}`);
    assert.equal(m.amount, 2_499_999n);
    assert.equal(m.receiver, TOKEN);
  }
  const reg = { read: { nonce: 7n, blockHash: BH, registered: false, u: U, to: TO, token: TOKEN }, key: keyOf(), to: TO, token: TOKEN, storageMin: STORAGE_MIN };
  for (const [field, later] of [["to", "evil.testnet"], ["token", "evil.testnet"], ["storageMin", 9n]] as const) {
    const m = buildRegisterOut(getterArgs({ ...reg, key: keyOf() }, field, later));
    assert.ok(!signedText(m).includes("evil"), `buildRegisterOut ${field}`);
    assert.equal(m.receiver, TOKEN);
    assert.equal(m.calls[0]!.deposit, STORAGE_MIN);
  }
  const wd = { read: { ...read, held: 3_000_000n, registered: true }, key: keyOf(), kind: "id" as const, to: TO, token: TOKEN };
  for (const [field, later] of [["to", "evil.testnet"], ["token", "evil.testnet"], ["kind", "arm"]] as const) {
    const m = buildWithdrawOut(getterArgs({ ...wd, key: keyOf() }, field, later));
    assert.ok(!signedText(m).includes("evil"), `buildWithdrawOut ${field}`);
    assert.equal(m.amount, 2_999_999n);
  }
  // the key's id and the read's fields, flipped after the first read
  const k2 = depositId(SEED, 1n, 1);
  const keyFlip = Object.defineProperty({ ...keyOf() }, "id", { get: flip(k.id, k2.id), enumerable: true });
  assert.equal(new TextDecoder().decode(base64.decode(buildMoveOut({ ...move, key: keyFlip }).signed)).includes(k.id), true);
  const readFlip = Object.defineProperty({ ...read }, "blockHash", { get: flip(BH, "evil"), enumerable: true });
  buildMoveOut({ ...move, key: keyOf(), read: readFlip }); // read once: the second answer is never asked for
  // a read of another account, typed account or token is refused
  for (const [f, v] of [["u", k2.id], ["to", "bob.testnet"], ["token", NEAR_NETWORKS.mainnet.usdc]] as const) assert.throws(() => buildMoveOut({ ...move, key: keyOf(), read: { ...read, [f]: v } }), MoveOutRefused, f);
  // an unknown kind, and storageMin 0 for an unregistered typed account, are refused
  assert.throws(() => buildMoveOut({ ...move, key: keyOf(), kind: "all" as "id" }), MoveOutRefused);
  assert.throws(() => buildMoveOut({ ...move, key: keyOf(), storageMin: 0n }), MoveOutRefused);
  assert.throws(() => buildWithdrawOut({ ...wd, key: keyOf(), kind: "W" as "id" }), MoveOutRefused);
});

test("bytes both RPCs refuse for U's NEAR answer gas and are kept: once U holds the cost the same bytes land, none signed anew", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const real = chain.rpcs();
  let lacking = true;
  const refusing = (r: MoveOutRpc): MoveOutRpc => ({
    ...r,
    call: async (m, p) => {
      if (m === "send_tx" && lacking) {
        chain.sent.push((p as { signed_tx_base64: string }).signed_tx_base64);
        return { error: { name: "HANDLER_ERROR", data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: { balance: "100", cost: "350", signer_id: U } } } } } };
      }
      return r.call(m, p);
    },
  });
  const ops = await heldOp("sender_struck");
  const d0 = { ...deps(ops, chain), rpcs: [refusing(real[0]), refusing(real[1])] as const };
  assert.deepEqual(await moveOutHeld("op1", TO, d0), { kind: "gas", need: 250n, u: U });
  const bytes = chain.sent[0]!;
  lacking = false;
  seedOpens = 0;
  assert.equal((await moveOutHeld("op1", TO, d0)).kind, "moved");
  assert.equal(seedOpens, 0);
  assert.ok(chain.sent.every((s) => s === bytes));
});

// ---------- review of d791adda: M1 (a record whose nonce is taken), M2 (the token's code hash), M3 (a test per rule),
// L1 (the vault and intents.near), L6 (a resume never signs) ----------

test("M3 every read must agree on both RPCs at the one height: one RPC's other nonce, USDC, registration, gas price, block hash, NEAR or code hash signs nothing", async () => {
  const plants: Chain["skewB"][] = [{ nonce: 9n }, { usdc: 2_400_000n }, { registered: false }, { gas: GAS_PRICE * 2n }, { hash: base58.encode(sha256(new TextEncoder().encode("other"))) }, { near: NEAR }, { code: "11111111111111111111111111111111" }];
  for (const skew of plants) {
    const chain = new Chain();
    chain.registered.add(TO);
    chain.skewB = skew;
    seedOpens = 0;
    assert.deepEqual(await moveOutHeld("op1", TO, deps(await heldOp("sender_struck"), chain)), { kind: "unread" }, JSON.stringify(skew, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    assert.equal(chain.sent.length, 0);
    assert.equal(seedOpens, 0);
  }
});

test("M2 the token's code is not the kit's pin on both RPCs: nothing signed (W:928)", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.code = "11111111111111111111111111111111";
  assert.deepEqual(await moveOutHeld("op1", TO, deps(await heldOp("sender_struck"), chain)), { kind: "unread" });
  assert.equal(chain.sent.length, 0);
});

test("L a nonce of 2^64-1 or more, answered as a string by both RPCs, is unread: nonce + 1 would not fit the u64 signed (exit-ids-out delta review 4, finding 3)", async () => {
  for (const nonce of [2n ** 64n - 1n, 2n ** 64n, 2n ** 70n]) {
    const chain = new Chain();
    chain.registered.add(TO);
    chain.nonceString = true;
    chain.nonce = nonce;
    seedOpens = 0;
    assert.deepEqual(await moveOutHeld("op1", TO, deps(await heldOp("sender_struck"), chain)), { kind: "unread" }, String(nonce));
    assert.equal(seedOpens, 0);
    assert.equal(chain.sent.length, 0);
  }
  // the largest nonce whose next one fits a u64 is read, and signed at 2^64-1
  const chain = new Chain();
  chain.registered.add(TO);
  chain.nonceString = true;
  chain.nonce = 2n ** 64n - 2n;
  assert.equal((await moveOutHeld("op1", TO, deps(await heldOp("sender_struck"), chain))).kind, "moved");
  assert.equal(decode(chain.sent[0]!).nonce, 2n ** 64n - 1n);
});

test("a nonce answered as \"+5\", \"-5\" or any string but plain digits, the same on both RPCs, is unread: nothing opened or signed (review 5 F3)", async () => {
  for (const text of ["+5", "-5", "05", " 5", "5.0", "0x5"]) {
    const chain = new Chain();
    chain.registered.add(TO);
    chain.nonceText = text;
    seedOpens = 0;
    assert.deepEqual(await moveOutHeld("op1", TO, deps(await heldOp("sender_struck"), chain)), { kind: "unread" }, text);
    assert.equal(seedOpens, 0);
    assert.equal(chain.sent.length, 0);
  }
  const chain = new Chain();
  chain.registered.add(TO);
  chain.nonceText = "5";
  assert.equal((await moveOutHeld("op1", TO, deps(await heldOp("sender_struck"), chain))).kind, "moved");
  assert.equal(decode(chain.sent[0]!).nonce, 6n);
});

test("M1 a head hash of 33 or 31 bytes, the same on both RPCs, is unread: nothing opened or signed (review 4 M1)", async () => {
  for (const n of [33, 31, 0]) {
    const chain = new Chain();
    chain.registered.add(TO);
    chain.headHash = base58.encode(new Uint8Array(n).fill(7));
    seedOpens = 0;
    assert.deepEqual(await moveOutHeld("op1", TO, deps(await heldOp("sender_struck"), chain)), { kind: "unread" }, String(n));
    assert.equal(seedOpens, 0);
    assert.equal(chain.sent.length, 0);
  }
});

test("L1 the amount is a digit string: a JSON number or a bigint is refused (review 4 L1)", () => {
  for (const amount of [5, 5n, "05", "5.0", " 5"]) {
    const calls = moveCalls(TO, 5n, false, 0n);
    (calls.at(-1)!.args as Record<string, unknown>).amount = amount;
    assert.throws(() => checkMoveCalls(U, TO, TOKEN, calls, 10n, 0n), MoveOutRefused, String(amount));
  }
  assert.equal(checkMoveCalls(U, TO, TOKEN, moveCalls(TO, 5n, false, 0n), 10n, 0n).calls.at(-1)!.args.amount, "5");
});

test("L2 a call with a field of any other name is refused as a move-out refusal, never a TypeError (review 4 L2)", () => {
  for (const extra of [new Uint8Array(1), "unsigned", { x: 1 }, undefined]) {
    for (const k of [0, 1]) {
      const calls = moveCalls(TO, 5n, true, STORAGE_MIN) as unknown as Record<string, unknown>[];
      calls[k]!.x = extra;
      assert.throws(() => checkMoveCalls(U, TO, TOKEN, calls as never, 10n, STORAGE_MIN), (e: unknown) => e instanceof MoveOutRefused && /method, args, gas and deposit/.test((e as Error).message), `call ${k}: ${String(extra)}`);
    }
  }
  const calls = moveCalls(TO, 5n, false, 0n) as unknown as Record<string, unknown>[];
  delete calls[0]!.gas;
  assert.throws(() => checkMoveCalls(U, TO, TOKEN, calls as never, 10n, 0n), MoveOutRefused);
});

test("M3 U's one key is not U's own key: nothing signed", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.foreignKey = "ed25519:11111111111111111111111111111111";
  assert.deepEqual(await moveOutHeld("op1", TO, deps(await heldOp("sender_struck"), chain)), { kind: "unread" });
  assert.equal(chain.sent.length, 0);
});

test("M3 the tx FINAL on one RPC and unknown on the other is not moved: the op is not marked moved_out", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("sender_struck");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "sent");
  chain.txsB = new Map(); // the second RPC knows nothing of it
  chain.txs.set((first as { hash: string }).hash, "ok");
  assert.equal((await moveOutHeld("op1", null, deps(ops, chain))).kind, "sent");
  assert.notEqual(((await ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
  // and failed on one, unknown on the other: not failed either (nothing re-signed on a tap)
  chain.txs.set((first as { hash: string }).hash, "failed");
  seedOpens = 0;
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
  assert.equal(seedOpens, 0);
  // U's nonce settled past it on both RPCs, U still holding its 2,500,000: whatever the split says of the tx, the money
  // in U is open and a tap moves it (delta review 2 of c3e71713, M1)
  chain.nonce = 8n;
  chain.a.height = chain.b.height = 1000 + 2 * SETTLE_BLOCKS;
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "open" });
  assert.equal(seedOpens, 0);
  chain.onSend = (_s, h) => chain.land(h);
  chain.txsB = null; // both RPCs read the new move
  const tap = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(tap.kind, "moved");
  assert.equal(decode(chain.sent.at(-1)!).nonce, 9n);
});

test("M1 a taken record past the validity window too is taken, not expired: a resume with U empty answers empty", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("note");
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
  chain.nonce = 9n; // two more txs of U since
  chain.usdc = 1n;
  chain.a.height = chain.b.height = 1000 + Number(TX_VALIDITY_BLOCKS) + 1;
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "empty" });
});

// another tab's record written between this call's signature and its compare-and-set
function racing(ops: WalletStore, competitor: MoveOutRecord): WalletStore {
  let planted = false;
  return new Proxy(ops, {
    get(t, p) {
      if (p !== "update") return (t as unknown as Record<string | symbol, unknown>)[p] instanceof Function ? ((t as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[p] as (...a: unknown[]) => unknown).bind(t) : (t as unknown as Record<string | symbol, unknown>)[p];
      return async (store: "ops", key: string, change: (v: unknown) => unknown) => {
        if (!planted) {
          const cur = (await t.get(store, key)) as DepositOp | undefined;
          const probe = change(cur) as DepositOp | undefined;
          if (cur?.follow.out === undefined && probe?.follow?.out !== undefined) {
            planted = true;
            await t.update(store, key, (v) => ({ ...(v as DepositOp), follow: { ...(v as DepositOp).follow, out: competitor } }));
          }
        }
        return t.update(store, key, change);
      };
    },
  });
}

test("M3 the compare-and-set: another tab's record written first wins; this call sends only that record's bytes and names its account", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.registered.add("bob.testnet");
  chain.onSend = () => {};
  const signed = base64.encode(new Uint8Array(120).fill(7));
  const competitor: MoveOutRecord = { to: "bob.testnet", amount: "2499999", nonce: "8", height: 1000, register: false, hash: base58.encode(sha256(new Uint8Array(55).fill(7))), signed };
  const ops = await heldOp("sender_struck");
  const out = await moveOutHeld("op1", TO, deps(racing(ops, competitor), chain));
  assert.equal(out.kind, "sent");
  assert.equal((out as { to: string }).to, "bob.testnet");
  assert.ok(chain.sent.length > 0 && chain.sent.every((x) => x === signed), "only the winner's bytes are sent");
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.out?.hash, competitor.hash, "the stored record is the winner's");
});

test("M3 two calls at once, two typed accounts: one set of bytes sent, both answers name the same account", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.registered.add("bob.testnet");
  chain.onSend = () => {};
  const ops = await heldOp("sender_struck");
  const [a, b] = await Promise.all([moveOutHeld("op1", TO, deps(ops, chain)), moveOutHeld("op1", "bob.testnet", deps(ops, chain))]);
  assert.equal(new Set(chain.sent).size, 1);
  assert.equal((a as { to: string }).to, (b as { to: string }).to);
});

test("M1 a record whose nonce another tx of U took (unknown on the archival RPC too: replaced): settled once the nonce is taken SETTLE_BLOCKS back; a resume answers empty, then open (never failed) for new USDC, and a tap signs anew", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("note");
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
  // another tx of U used nonce 8 just now and took U's USDC: too recent to settle (its receipts may still run)
  chain.nonce = 8n;
  chain.usdc = 0n;
  chain.nonceAt = (h) => (h >= 1050 ? 8n : 7n);
  chain.a.height = chain.b.height = 1060;
  seedOpens = 0;
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent", "a nonce taken within SETTLE_BLOCKS: still followed");
  // SETTLE_BLOCKS later the record is settled: a resume answers empty and signs nothing
  chain.a.height = chain.b.height = 1050 + SETTLE_BLOCKS + 1;
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "empty" });
  assert.equal(seedOpens, 0);
  assert.ok(((await ops.get("ops", "op1")) as DepositOp).follow.out !== undefined, "a resume clears nothing");
  // new USDC reaches U: a resume answers open (the replaced record is history, the account typed again; never "not
  // moved"), and the tap signs anew at U's next nonce
  chain.usdc = 5_000_000n;
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "open" });
  assert.equal(seedOpens, 0);
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.out, undefined, "the replaced record is cleared");
  chain.onSend = (_s, h) => chain.land(h);
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "moved");
  const op = (await ops.get("ops", "op1")) as DepositOp;
  assert.equal(op.follow.out_past?.length, 1, "the taken record is kept as history");
  assert.deepEqual([...new Set(chain.sent)].map((x) => decode(x).nonce), [8n, 9n]);
});

test("M1 a never-landable record (expired): a resume answers failed and signs nothing; only the tap signs again (L6)", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("sender_struck");
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
  chain.a.height = chain.b.height = 1000 + Number(TX_VALIDITY_BLOCKS) + 1;
  seedOpens = 0;
  assert.equal((await moveOutHeld("op1", null, deps(ops, chain))).kind, "failed");
  assert.equal(seedOpens, 0);
  // FINAL failed on both: the same, a resume never signs
  const c2 = new Chain();
  c2.registered.add(TO);
  c2.onSend = (_s, h) => (c2.txs.set(h, "failed"), (c2.nonce += 1n));
  const ops2 = await heldOp("sender_struck");
  assert.equal((await moveOutHeld("op1", TO, deps(ops2, c2))).kind, "failed");
  const n = c2.sent.length;
  assert.equal((await moveOutHeld("op1", null, deps(ops2, c2))).kind, "failed");
  assert.equal(c2.sent.length, n, "nothing sent on a resume");
});

test("M1 two held ops of one U: the second op's tap follows the first's live record, one set of bytes, its account named; once it lands both ops read moved (delta review item 8)", async () => {
  const chain = new Chain();
  chain.usdc = 5_000_000n; // both ops' 2,500,000 in U: U's move carries both (delta review 6, F2: Moved capped by it)
  chain.registered.add(TO);
  chain.registered.add("bob.testnet");
  chain.onSend = () => {};
  const ops = await heldOp("note");
  await ops.put("ops", "op2", { ...((await ops.get("ops", "op1")) as DepositOp), created_ms: 2 });
  // a held op of another U, and one of U on mainnet: never marked by U's move
  const one = (await ops.get("ops", "op1")) as DepositOp;
  await ops.put("ops", "op3", { ...one, follow: { ...one.follow, i: 1, u: depositId(SEED, 1n, 1).id } });
  await ops.put("ops", "op4", { ...one, follow: { ...one.follow, network: "mainnet" } });
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
  seedOpens = 0;
  const b = await moveOutHeld("op2", "bob.testnet", deps(ops, chain));
  assert.equal(b.kind, "sent");
  assert.equal((b as { to: string }).to, TO);
  assert.equal(seedOpens, 0);
  assert.equal(new Set(chain.sent).size, 1);
  // it lands: both ops end moved_out on the one record, and the second's next tap reads moved (never an empty Withdraw)
  chain.txs.set((b as { hash: string }).hash, "ok");
  chain.usdc = 1n;
  assert.equal((await moveOutHeld("op2", "bob.testnet", deps(ops, chain))).kind, "moved");
  for (const k of ["op1", "op2"]) {
    const o = (await ops.get("ops", k)) as DepositOp;
    assert.equal(o.follow.why, "moved_out", k);
    assert.equal(o.follow.out?.hash, (b as { hash: string }).hash, k);
  }
  for (const k of ["op3", "op4"]) {
    const o = (await ops.get("ops", k)) as DepositOp;
    assert.equal(o.follow.why, "note", k);
    assert.equal(o.follow.out, undefined, k);
  }
  const again = await moveOutHeld("op2", "bob.testnet", deps(ops, chain));
  assert.equal(again.kind, "moved");
  assert.equal((again as { to: string }).to, TO);
  assert.equal(seedOpens, 0);
});

test("M1 U's lock held elsewhere (a deposit follow of U): nothing read for a signature, nothing signed", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  seedOpens = 0;
  const out = await moveOutHeld("op1", TO, { ...deps(await heldOp("sender_struck"), chain), uLock: async () => null });
  assert.deepEqual(out, { kind: "unread" });
  assert.equal(chain.sent.length, 0);
  assert.equal(seedOpens, 0);
});

test("L1 the payload rule refuses the vault and intents.near, called straight", async () => {
  for (const to of [NET.vault!, "intents.near"]) {
    assert.throws(() => checkMoveCalls(U, to, TOKEN, moveCalls(to, 1n, false, 0n), 2_500_000n, 0n), MoveOutRefused);
    const chain = new Chain();
    chain.registered.add(to);
    await assert.rejects(moveOutHeld("op1", to, deps(await heldOp("sender_struck"), chain)), MoveOutRefused);
    assert.equal(chain.sent.length, 0);
  }
});

test("L1 the vault as a String or a toJSON object (=== compares identity, JSON.stringify signs the vault's name): refused by the rule and by moveOutHeld, before anything is read or signed", async () => {
  const strings = /U, the typed account, the token and every account id are strings/;
  for (const to of [NET.vault!, "intents.near"]) {
    for (const look of [new String(to), { toJSON: () => to }] as unknown as string[]) {
      assert.throws(() => checkMoveCalls(U, look, TOKEN, moveCalls(look, 1n, false, 0n), 2_500_000n, 0n), strings);
      assert.throws(() => checkMoveCalls(U, look, TOKEN, moveCalls(look, 1n, true, STORAGE_MIN), 2_500_000n, STORAGE_MIN), strings);
      // the typed account a string, an account id in the calls not one (a toJSON object's function is not cloned)
      const calls = moveCalls(TO, 1n, true, STORAGE_MIN);
      calls[0]!.args.account_id = look;
      assert.throws(() => checkMoveCalls(U, TO, TOKEN, calls, 2_500_000n, STORAGE_MIN), typeof look === "object" && "toJSON" in (look as object) ? /not plain data/ : strings);
      const chain = new Chain();
      chain.registered.add(to);
      seedOpens = 0;
      let reads = 0;
      const d0 = deps(await heldOp("sender_struck"), chain);
      const counted = d0.rpcs.map((r) => Object.fromEntries(Object.entries(r).map(([k, f]) => [k, typeof f === "function" ? (...a: unknown[]) => (reads++, (f as (...x: unknown[]) => unknown).apply(r, a)) : f]))) as unknown as typeof d0.rpcs;
      await assert.rejects(moveOutHeld("op1", look, { ...d0, rpcs: counted }), strings);
      assert.equal(reads, 0, "no RPC is read with it");
      assert.equal(chain.sent.length, 0);
      assert.equal(seedOpens, 0);
    }
  }
  assert.throws(() => checkMoveCalls(new String(U) as unknown as string, TO, TOKEN, moveCalls(TO, 1n, false, 0n), 2_500_000n, 0n), strings);
  assert.throws(() => checkMoveCalls(U, TO, new String(TOKEN) as unknown as string, moveCalls(TO, 1n, false, 0n), 2_500_000n, 0n), strings);
});

test("D3 the look-back nonce must agree on both RPCs: the second answers a lower nonce at height - SETTLE_BLOCKS only, the record stays followed", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("note");
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
  // another tx of U took nonce 8 at 1050 and U's USDC; SETTLE_BLOCKS + 1 later both RPCs agree on every height but one
  chain.nonce = 8n;
  chain.usdc = 0n;
  chain.nonceAt = (h) => (h >= 1050 ? 8n : 7n);
  chain.a.height = chain.b.height = 1050 + SETTLE_BLOCKS + 1;
  const back = chain.a.height - SETTLE_BLOCKS;
  const [a, b] = chain.rpcs();
  const lagging: MoveOutRpc = {
    ...b,
    query: async (p) => {
      const r = await b.query(p);
      if (p.request_type !== "view_access_key_list" || (p as { block_id?: number }).block_id !== back) return r;
      const res = (r as { result: { keys: { access_key: { nonce: number } }[] } }).result;
      return { result: { ...res, keys: res.keys.map((k) => ({ ...k, access_key: { ...k.access_key, nonce: 7 } })) } };
    },
  };
  seedOpens = 0;
  const out = await moveOutHeld("op1", null, { ...deps(ops, chain), rpcs: [a, lagging] });
  assert.equal(out.kind, "sent", "one RPC's look-back nonce alone never settles a record");
  assert.equal(seedOpens, 0);
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.out_past, undefined);
});

test("D3 the token's code hash read with no answer on one RPC: nothing signed", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const [a, b] = chain.rpcs();
  const mute: MoveOutRpc = {
    ...b,
    query: async (p) => (p.request_type === "view_account" && (p as { account_id?: string }).account_id === TOKEN ? { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } } : b.query(p)),
  };
  seedOpens = 0;
  assert.deepEqual(await moveOutHeld("op1", TO, { ...deps(await heldOp("sender_struck"), chain), rpcs: [a, mute] }), { kind: "unread" });
  assert.equal(chain.sent.length, 0);
  assert.equal(seedOpens, 0);
});

test("D4 another op of U holds a gone record (FINAL failed): the tap clears it to that op's out_past and signs this op's own move", async () => {
  const chain = new Chain();
  chain.usdc = 5_000_000n; // both ops' 2,500,000 in U: U's move carries both (delta review 6, F2: Moved capped by it)
  chain.registered.add(TO);
  chain.registered.add("bob.testnet");
  chain.onSend = (_s, h) => (chain.txs.set(h, "failed"), (chain.nonce += 1n));
  const ops = await heldOp("note");
  await ops.put("ops", "op2", { ...((await ops.get("ops", "op1")) as DepositOp), created_ms: 2 });
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "failed");
  chain.onSend = (_s, h) => chain.land(h);
  const b = await moveOutHeld("op2", "bob.testnet", deps(ops, chain));
  assert.equal(b.kind, "moved");
  assert.equal((b as { to: string }).to, "bob.testnet", "op2's own account, not op1's");
  const op1 = (await ops.get("ops", "op1")) as DepositOp;
  assert.deepEqual(op1.follow.out_past?.map((r) => r.hash), [(first as { hash: string }).hash], "op1's gone record is cleared to its history");
  assert.equal(op1.follow.out?.hash, (b as { hash: string }).hash, "op2's move took all of U: op1 reads it as its move (delta review item 8)");
  assert.equal(op1.follow.why, "moved_out");
  assert.equal(((await ops.get("ops", "op2")) as DepositOp).follow.out?.to, "bob.testnet");
  assert.deepEqual([...new Set(chain.sent)].map((x) => decode(x).nonce), [8n, 9n]);
});

test("L1 an expired record read absent on one RPC and with no answer on the other (a 408): settled expired, a resume answers failed and signs nothing", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("sender_struck");
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
  chain.a.height = chain.b.height = 1000 + Number(TX_VALIDITY_BLOCKS) + 1;
  const [a, b] = chain.rpcs();
  const mute: MoveOutRpc = { ...b, tx: async () => { throw new Error("HTTP 408"); } };
  seedOpens = 0;
  const n = chain.sent.length;
  assert.equal((await moveOutHeld("op1", null, { ...deps(ops, chain), rpcs: [a, mute] })).kind, "failed", "U's nonce alone proves it can never land");
  assert.equal(seedOpens, 0);
  assert.equal(chain.sent.length, n, "nothing sent");
});

test("L1 U empty, its nonce settled past the record, absent on one RPC and a 408 on the other: only an equal archival word settles it; with none listed it stays followed", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("note");
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
  chain.nonce = 8n;
  chain.usdc = 0n;
  chain.nonceAt = (h) => (h >= 1050 ? 8n : 7n);
  chain.a.height = chain.b.height = 1050 + SETTLE_BLOCKS + 1;
  const [a, b] = chain.rpcs();
  const mute: MoveOutRpc = { ...b, tx: async () => { throw new Error("HTTP 408"); } };
  seedOpens = 0;
  const { archival: _none, ...bare } = deps(ops, chain);
  assert.equal((await moveOutHeld("op1", null, { ...bare, rpcs: [a, mute] })).kind, "sent", "one RPC's UNKNOWN_TRANSACTION alone never settles a record");
  assert.equal(seedOpens, 0);
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.out_past, undefined);
  // both archival hosts answer UNKNOWN_TRANSACTION, serving its block: replaced, and with U empty a resume answers empty
  assert.deepEqual(await moveOutHeld("op1", null, { ...deps(ops, chain), rpcs: [a, mute] }), { kind: "empty" });
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "empty" });
});

// Flipped by delta review 5, item 2: L1 held such a record followed, so one lying RPC (a fake FINAL ok or failed, the
// other UNKNOWN_TRANSACTION) held it at Sending forever. U's nonce below the record's, read equal on the pair past the
// validity window, says no side's word can be true: the tx was never included and never can be. It expires; the tap
// signs at that same nonce, so of the old bytes (past their window) and the new at most one can land.
test("L1 one RPC reads the tx ok, the other absent, and both read U's nonce below it past the window (hostile reads): expired, and the tap signs at the same nonce", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.txsB = new Map();
  chain.onSend = (_s, h) => void chain.txs.set(h, "ok"); // the first RPC says it landed; U's nonce never moves
  const ops = await heldOp("sender_struck");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "sent");
  const had = ((await ops.get("ops", "op1")) as DepositOp).follow.out!;
  chain.a.height = chain.b.height = 1000 + Number(TX_VALIDITY_BLOCKS) + 1;
  seedOpens = 0;
  assert.equal((await moveOutHeld("op1", null, deps(ops, chain))).kind, "failed", "a tx U's nonce never reached is expired, whatever one RPC reads");
  assert.equal(seedOpens, 0, "a resume never signs");
  chain.onSend = () => {};
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
  assert.equal(seedOpens, 1);
  const now = ((await ops.get("ops", "op1")) as DepositOp).follow;
  assert.equal(now.out?.nonce, had.nonce, "the same nonce: at most one of the two lands");
  assert.notEqual(now.out?.hash, had.hash);
  assert.deepEqual(now.out_past?.map((x) => x.hash), [had.hash]);
});

// ---- card held-move-forgotten-tx: a landed move both of the pair no longer keep (review 4 of held-deposit-way-out, L1) ----
// Read 8 Nov 2026 (wait_until NONE): a FINAL mainnet tx 180,000 blocks old answers UNKNOWN_TRANSACTION on
// rpc.mainnet.fastnear.com, 230,000 blocks old (about 37 h) on near.drpc.org too; the testnet pair forgets 2Q4pYKQ9...
// (2 Nov) while archival-rpc.testnet.fastnear.com reads it FINAL SuccessValue.
const landedThenForgotten = async (usdcNow: bigint, archival: "keeps" | "down" | "failed" = "keeps", needless = false) => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {}; // the page closed before the tx read FINAL: the first call answers sent
  const ops = await heldOp("sender_struck");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "sent");
  const hash = (first as { hash: string }).hash;
  chain.land(hash); // it landed: U's key nonce 7 -> 8, U holds 1 base unit, the typed account got the rest
  if (needless) {
    // the op 1Click REFUNDED, its delivered never read: the move took none of its money
    const o = (await ops.get("ops", "op1")) as DepositOp;
    const { delivered: _d, ...rest } = o.follow;
    await ops.put("ops", "op1", { ...o, follow: { ...rest, sent: true, status: "REFUNDED" } });
  }
  chain.usdc = usdcNow;
  chain.nonceAt = (h) => (h >= 1001 ? 8n : 7n);
  chain.a.height = chain.b.height = 1000 + 230_000; // the user signs in again ~37 h later on mainnet's pace
  chain.forgot.add(hash); // both of the pair forgot it: UNKNOWN_TRANSACTION to NONE
  if (archival === "down") chain.archDown = true;
  if (archival === "failed") chain.archTxs = new Map([[hash, "failed"]]);
  seedOpens = 0;
  const n = chain.sent.length;
  const again = await moveOutHeld("op1", null, deps(ops, chain));
  return { chain, ops, hash, again, op: (await ops.get("ops", "op1")) as DepositOp, sentAfter: chain.sent.length - n };
};

// Delta review 7, item 4: an op the move took none of stays held, its record history; the page answers the move its
// record landed, which carried money, so never empty (delta review 8, point 3 fold)
test("R7-RESUME a forgotten landed record whose op needs nothing of it: the resume answers that move, the op held, the record history", async () => {
  const r = await landedThenForgotten(1n, "keeps", true);
  assert.deepEqual(r.again, { kind: "moved", to: TO, amount: 2_499_999n, hash: r.hash });
  assert.notEqual(r.op.follow.why, "moved_out");
  assert.equal(r.op.follow.out, undefined);
  assert.deepEqual(r.op.follow.out_past?.map((x) => x.hash), [r.hash]);
  assert.equal(r.sentAfter, 0);
  assert.equal(seedOpens, 0);
});

test("R4a a landed move both of the pair forgot, U holds 1: the archival RPC reads it FINAL success, the resume answers moved and the op ends moved_out", async () => {
  const r = await landedThenForgotten(1n);
  assert.equal(r.again.kind, "moved");
  assert.equal((r.again as { hash: string }).hash, r.hash);
  assert.equal(r.sentAfter, 0, "nothing sent");
  assert.equal(seedOpens, 0, "no seed opened");
  assert.equal(r.op.follow.why, "moved_out", "the op ends moved_out");
  assert.equal(r.op.follow.out?.hash, r.hash);
  assert.equal(r.op.follow.out_past, undefined);
});

test("R4b a landed move both of the pair forgot, U now holds more than it moved (new USDC): open, never failed and never Moved; a tap moves what U holds", async () => {
  const r = await landedThenForgotten(5_000_000n);
  assert.deepEqual(r.again, { kind: "open" }, "the page never draws 'Not moved · Retry', and never hides U's USDC behind Moved");
  assert.equal(r.sentAfter, 0);
  assert.equal(seedOpens, 0);
  assert.notEqual(r.op.follow.why, "moved_out");
  assert.equal(r.op.follow.out, undefined, "the record is history");
  assert.equal(r.op.follow.out_past?.[0]?.hash, r.hash);
  r.chain.onSend = (_s, h) => r.chain.land(h);
  const tap = await moveOutHeld("op1", TO, deps(r.ops, r.chain));
  assert.equal(tap.kind, "moved");
  assert.equal((tap as { amount: bigint }).amount, 4_999_999n, "what U holds, less one base unit");
  assert.equal(seedOpens, 1);
});

test("M1 archival FINAL success is landed only while the pair reads U at most 1 base unit (a move leaves exactly 1): U holding what it moved, or 2, is open", async () => {
  // delta review item 2: money in U is always movable; the archival word only names an empty U's end
  assert.equal((await landedThenForgotten(1n)).again.kind, "moved");
  for (const usdc of [2n, 2_499_999n, 2_500_000n]) {
    const r = await landedThenForgotten(usdc);
    assert.deepEqual(r.again, { kind: "open" }, `U at ${usdc}`);
    assert.notEqual(r.op.follow.why, "moved_out");
    assert.equal(r.op.follow.out_past?.[0]?.hash, r.hash, "the record is history");
  }
});

test("F3 a forgotten landed move, then a late 2,000,000 reaches U: open, and a tap moves it", async () => {
  const r = await landedThenForgotten(2_000_001n);
  assert.deepEqual(r.again, { kind: "open" });
  r.chain.onSend = (_s, h) => r.chain.land(h);
  const tap = await moveOutHeld("op1", TO, deps(r.ops, r.chain));
  // the late 2,000,000 is under op1's need (2,500,000), so the tap's move, which took it, marks no op: op1 stays held, the
  // record its history (the X8 limit of delta review 6); the tap moved money, so the page answers moved, never empty
  // (delta review 8, point 3 fold)
  assert.equal(tap.kind, "moved");
  assert.equal((tap as { amount: bigint }).amount, 2_000_000n);
  assert.notEqual(await whyOf(r.ops, "op1"), "moved_out");
  assert.equal(((await r.ops.get("ops", "op1")) as DepositOp).follow.out_past?.at(-1)?.amount, "2000000");
  assert.equal(seedOpens, 1);
});

test("F3 an op already moved_out, then a late 2,000,000 reaches U: a resume answers open (the record is history), a tap moves it; while U holds 1, or with no equal read of U, it stays moved", async () => {
  const r = await landedThenForgotten(1n);
  assert.equal(r.again.kind, "moved");
  assert.equal((await moveOutHeld("op1", null, deps(r.ops, r.chain))).kind, "moved", "U at 1: moved");
  r.chain.usdc = 2_000_001n;
  r.chain.skewB = { usdc: 1n };
  assert.equal((await moveOutHeld("op1", null, deps(r.ops, r.chain))).kind, "moved", "no equal read of U: kept moved");
  r.chain.skewB = {};
  assert.deepEqual(await moveOutHeld("op1", null, deps(r.ops, r.chain)), { kind: "open" });
  const op = (await r.ops.get("ops", "op1")) as DepositOp;
  assert.equal(op.follow.out, undefined);
  assert.equal(op.follow.out_past?.[0]?.hash, r.hash);
  r.chain.onSend = (_s, h) => r.chain.land(h);
  const tap = await moveOutHeld("op1", TO, deps(r.ops, r.chain));
  assert.equal(tap.kind, "moved");
  assert.equal((tap as { amount: bigint }).amount, 2_000_000n);
  const after = (await r.ops.get("ops", "op1")) as DepositOp;
  assert.equal(after.follow.why, "moved_out");
  assert.equal(after.follow.out?.hash, (tap as { hash: string }).hash);
});

test("F3 a move the pair still keeps FINAL success, with U holding more than 1 when it is read (a late deposit): open, its op reopened (follow, delta review item 2; delta review 8, ruling 2)", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("sender_struck");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "sent");
  chain.land((first as { hash: string }).hash);
  chain.usdc = 2_000_001n;
  chain.skewB = { usdc: 1n };
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "unread" }, "no equal read of U: no word yet");
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.out?.hash, (first as { hash: string }).hash, "the record kept");
  assert.notEqual(((await ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
  chain.skewB = {};
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "open" });
  // the record carried op1's money: landed() marks op1, then it reopens (delta review 8, ruling 2): its why kept, no
  // record, so it reads Held with its Withdraw while the late deposit is in U, and its next tap carries `later`
  const op = (await ops.get("ops", "op1")) as DepositOp;
  assert.equal(op.follow.why, "moved_out");
  assert.equal(op.follow.out, undefined);
  assert.equal(op.follow.out_past?.[0]?.hash, (first as { hash: string }).hash);
});

// delta review item 1: a record that never landed and whose nonce another tx of U took, U holding money
const takenWithMoney = async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("note");
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
  chain.nonce = 8n; // another tx of U used nonce 8; U still holds 2,500,000
  chain.nonceAt = (h) => (h >= 1050 ? 8n : 7n);
  chain.a.height = chain.b.height = 1050 + SETTLE_BLOCKS + 1;
  return { chain, ops };
};

test("F1 never landed, nonce used, U at 2,500,000; one archival host answers 429, the other UNKNOWN_TRANSACTION serving the block: open, and the tap signs", async () => {
  const { chain, ops } = await takenWithMoney();
  const archival = [{ ...chain.archival(), tx: async () => Promise.reject(new Error("HTTP 429")) }, chain.archival(NET.archival[1])];
  seedOpens = 0;
  assert.deepEqual(await moveOutHeld("op1", null, { ...deps(ops, chain), archival }), { kind: "open" });
  assert.equal(seedOpens, 0);
  chain.onSend = (_s, h) => chain.land(h);
  const tap = await moveOutHeld("op1", TO, { ...deps(ops, chain), archival });
  assert.equal(tap.kind, "moved");
  assert.equal(seedOpens, 1);
  assert.deepEqual([...new Set(chain.sent)].map((x) => decode(x).nonce), [8n, 9n]);
});

test("F1b the same with no archival RPC listed: open, and the tap signs", async () => {
  const { chain, ops } = await takenWithMoney();
  const { archival: _none, ...bare } = deps(ops, chain);
  assert.deepEqual(await moveOutHeld("op1", null, bare), { kind: "open" });
  chain.onSend = (_s, h) => chain.land(h);
  assert.equal((await moveOutHeld("op1", TO, bare)).kind, "moved");
});

test("F2 an op follow.ts ended moved_out with no move of its own: its tap's send is lost, and a resume follows that move (sends the same bytes again), never moved", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("moved_out");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "sent");
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.why, undefined, "held again from this move on");
  const n = chain.sent.length;
  seedOpens = 0;
  const again = await moveOutHeld("op1", null, deps(ops, chain));
  assert.equal(again.kind, "sent");
  assert.ok(chain.sent.length > n && chain.sent.slice(n).every((x) => x === chain.sent[0]), "the same bytes sent again");
  assert.equal(seedOpens, 0);
  chain.onSend = (_s, h) => chain.land(h);
  chain.land((first as { hash: string }).hash);
  assert.equal((await moveOutHeld("op1", null, deps(ops, chain))).kind, "moved");
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
  // any other held reason is kept while its move is followed
  const c2 = new Chain();
  c2.registered.add(TO);
  c2.onSend = () => {};
  const ops2 = await heldOp("note");
  assert.equal((await moveOutHeld("op1", TO, deps(ops2, c2))).kind, "sent");
  assert.equal(((await ops2.get("ops", "op1")) as DepositOp).follow.why, "note");
});

test("a forgotten record with no archival answer stays as it is: followed, never settled", async () => {
  const r = await landedThenForgotten(1n, "down");
  assert.equal(r.again.kind, "sent");
  assert.equal(seedOpens, 0);
  assert.notEqual(r.op.follow.why, "moved_out");
  assert.equal(r.op.follow.out?.hash, r.hash);
  assert.equal(r.op.follow.out_past, undefined);
  // no archival RPC given at all: the same
  const { archival: _none, ...bare } = deps(r.ops, r.chain);
  assert.equal((await moveOutHeld("op1", null, bare)).kind, "sent");
});

test("a forgotten record the archival RPC reads FINAL failed, U empty: failed, and only the tap signs again; with U holding more it is open whatever the archival hosts say", async () => {
  const r = await landedThenForgotten(1n, "failed");
  assert.equal(r.again.kind, "failed");
  assert.equal(seedOpens, 0);
  assert.notEqual(r.op.follow.why, "moved_out");
  const more = await landedThenForgotten(5_000_000n, "failed");
  assert.deepEqual(more.again, { kind: "open" });
});

test("another op's forgotten record that landed: that op ends moved_out (not cleared), and so does this op, whose tap reads moved and signs nothing (delta review item 8)", async () => {
  const chain = new Chain();
  chain.usdc = 5_000_000n; // both ops' 2,500,000 in U: U's move carries both (delta review 6, F2: Moved capped by it)
  chain.registered.add(TO);
  chain.registered.add("bob.testnet");
  chain.onSend = () => {};
  const ops = await heldOp("note");
  await ops.put("ops", "op2", { ...((await ops.get("ops", "op1")) as DepositOp), created_ms: 2 });
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  const hash = (first as { hash: string }).hash;
  chain.land(hash);
  chain.nonceAt = (h) => (h >= 1001 ? 8n : 7n);
  chain.a.height = chain.b.height = 1000 + 230_000;
  chain.forgot.add(hash);
  seedOpens = 0;
  const tap = await moveOutHeld("op2", "bob.testnet", deps(ops, chain));
  assert.equal(tap.kind, "moved");
  assert.equal((tap as { hash: string }).hash, hash);
  assert.equal(seedOpens, 0);
  const op2 = (await ops.get("ops", "op2")) as DepositOp;
  assert.equal(op2.follow.why, "moved_out", "the tapped op reads Moved too");
  assert.equal(op2.follow.out?.hash, hash);
  const op1 = (await ops.get("ops", "op1")) as DepositOp;
  assert.equal(op1.follow.why, "moved_out", "op1's landed move is kept as moved, not cleared as gone");
  assert.equal(op1.follow.out?.hash, hash);
  assert.equal(op1.follow.out_past, undefined);
});

test("each archival RPC must be one of the op's network's: another is refused before anything is read", async () => {
  const chain = new Chain();
  const other = { ...chain.archival(), name: "https://archival-rpc.mainnet.fastnear.com" };
  const [h0, h1] = [chain.archival(), chain.archival(NET.archival[1])];
  // delta review L4: none, or exactly the network's list, each host once; a part of it settles on fewer words
  for (const archival of [[h0, other], [h0], [h1], [h0, h0], [h0, h1, h1], [h0, h1, other]]) {
    await assert.rejects(moveOutHeld("op1", TO, { ...deps(await heldOp("note"), chain), archival }), /an archival RPC is not the op's network's/, archival.map((h) => h.name).join(" "));
  }
  assert.equal(chain.sent.length, 0);
  for (const pick of [[0, 1], [1, 0], []]) {
    const c = new Chain();
    c.registered.add(TO);
    const archival = pick.map((i) => c.archival(NET.archival[i]));
    assert.equal((await moveOutHeld("op1", TO, { ...deps(await heldOp("note"), c), archival })).kind, "moved", pick.join(" "));
  }
});

// M1 (review of ff7fcc56): every listed archival host is asked, and only an equal word from all settles the record
const twoHosts = (r: Awaited<ReturnType<typeof landedThenForgotten>>, first: (p: Parameters<MoveOutRpc["tx"]>[0]) => Promise<unknown>) => {
  r.chain.archDown = false;
  const keeps = { ...r.chain.archival(), name: NET.archival[1] };
  return [{ ...r.chain.archival(), tx: first }, keeps] as MoveOutRpc[];
};
const UNKNOWN_TX = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } };

test("M1 both archival hosts read the forgotten move FINAL success: moved", async () => {
  const r = await landedThenForgotten(1n, "down");
  r.chain.archDown = false;
  const out = await moveOutHeld("op1", null, { ...deps(r.ops, r.chain), archival: [r.chain.archival(), { ...r.chain.archival(), name: NET.archival[1] }] });
  assert.equal(out.kind, "moved");
  assert.equal(((await r.ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
});

test("M1 the first archival host gives no answer, the next reads FINAL success: the record stays as it is", async () => {
  const r = await landedThenForgotten(1n, "down");
  const out = await moveOutHeld("op1", null, { ...deps(r.ops, r.chain), archival: twoHosts(r, async () => Promise.reject(new Error("HTTP 503"))) });
  assert.equal(out.kind, "sent");
  const op = (await r.ops.get("ops", "op1")) as DepositOp;
  assert.notEqual(op.follow.why, "moved_out");
  assert.equal(op.follow.out?.hash, r.hash);
});

test("M1 the first archival host answers UNKNOWN_TRANSACTION (serving the record's block), the next FINAL success: never replaced, never moved; the record stays", async () => {
  const r = await landedThenForgotten(1n, "down");
  const out = await moveOutHeld("op1", null, { ...deps(r.ops, r.chain), archival: twoHosts(r, async () => UNKNOWN_TX) });
  assert.equal(out.kind, "sent");
  const op = (await r.ops.get("ops", "op1")) as DepositOp;
  assert.notEqual(op.follow.why, "moved_out");
  assert.equal(op.follow.out?.hash, r.hash, "not cleared as replaced");
  assert.equal(op.follow.out_past, undefined);
  // the other order too
  const r2 = await landedThenForgotten(1n, "down");
  const [first, second] = twoHosts(r2, async () => UNKNOWN_TX);
  assert.equal((await moveOutHeld("op1", null, { ...deps(r2.ops, r2.chain), archival: [second!, first!] })).kind, "sent");
});

test("M1 an archival UNKNOWN_TRANSACTION counts only from a host that serves the record's block: another header hash, another height or no block answer leaves the record as it is", async () => {
  // a record no tx of U ever landed with: the archival host keeps no such tx (replaced, when its word counts)
  const fresh = async () => {
    const r = await landedThenForgotten(1n, "down");
    r.chain.archDown = false;
    r.chain.archTxs = new Map();
    return r;
  };
  const r = await fresh();
  assert.deepEqual(await moveOutHeld("op1", null, deps(r.ops, r.chain)), { kind: "empty" }, "both hosts' word counts: replaced, U holds 1");
  for (const [why, block] of [
    ["another hash", async (p: { block_id?: number }) => ({ result: { header: { height: p.block_id, hash: "11111111111111111111111111111111" } } })],
    ["another height", async (p: { block_id?: number }) => ({ result: { header: { height: (p.block_id ?? 0) + 1, hash: base58.encode(sha256(new TextEncoder().encode(`b${p.block_id}`))) } } })],
    ["no block", async () => Promise.reject(new Error("HTTP 422"))],
  ] as const) {
    const q = await fresh();
    const pruned = { ...q.chain.archival(), block: block as MoveOutRpc["block"] };
    assert.equal((await moveOutHeld("op1", null, { ...deps(q.ops, q.chain), archival: [pruned, q.chain.archival(NET.archival[1])] })).kind, "sent", why);
    const op = (await q.ops.get("ops", "op1")) as DepositOp;
    assert.equal(op.follow.out?.hash, q.hash, `${why}: the record is kept`);
    assert.equal(op.follow.out_past, undefined, why);
  }
});

test("signedBlockHash reads the block hash a move's signed bytes name, for their own signer only", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("note");
  await moveOutHeld("op1", TO, deps(ops, chain));
  const rec = ((await ops.get("ops", "op1")) as DepositOp).follow.out!;
  assert.equal(signedBlockHash(rec.signed, U), base58.encode(sha256(new TextEncoder().encode(`b${rec.height}`))));
  assert.equal(signedBlockHash(rec.signed, "b".repeat(64)), null, "another signer");
  assert.equal(signedBlockHash("AAAA", U), null, "not a transaction");
  assert.equal(signedBlockHash("AA==", U), null, "one byte (the real vector's)");
  // crafted bytes (delta review L5): the key type byte, a secp256k1 key, the block hash's bounds
  const b = base64.decode(rec.signed);
  const keyAt = 4 + U.length;
  const typed = b.slice();
  typed[keyAt] = 1;
  assert.equal(signedBlockHash(base64.encode(typed), U), null, "key type 1 with the ed25519 layout");
  const secp = new Uint8Array(b.length + 32);
  secp.set(b.subarray(0, keyAt));
  secp[keyAt] = 1;
  secp.set(new Uint8Array(64).fill(9), keyAt + 1);
  secp.set(b.subarray(keyAt + 33), keyAt + 65);
  assert.equal(signedBlockHash(base64.encode(secp), U), null, "a secp256k1 signer key (64 bytes)");
  const rcv = keyAt + 33 + 8;
  const hashAt = rcv + 4 + new DataView(b.buffer, b.byteOffset).getUint32(rcv, true);
  for (const cut of [hashAt, hashAt + 1, hashAt + 31]) assert.equal(signedBlockHash(base64.encode(b.subarray(0, cut)), U), null, `cut at ${cut}: no whole block hash`);
  assert.equal(signedBlockHash(base64.encode(b.subarray(0, hashAt + 32)), U), base58.encode(sha256(new TextEncoder().encode(`b${rec.height}`))), "the 32 bytes are enough");
});

test("B6 a record whose signed bytes do not decode (the real vector's AA==): an archival UNKNOWN_TRANSACTION is no word, the record stays", async () => {
  const r = await landedThenForgotten(1n, "down");
  r.chain.archDown = false;
  r.chain.archTxs = new Map();
  await r.ops.update("ops", "op1", (v) => ({ ...(v as DepositOp), follow: { ...(v as DepositOp).follow, out: { ...(v as DepositOp).follow.out!, signed: "AA==" } } }));
  const out = await moveOutHeld("op1", null, deps(r.ops, r.chain));
  assert.equal(out.kind, "sent");
  const op = (await r.ops.get("ops", "op1")) as DepositOp;
  assert.equal(op.follow.out?.hash, r.hash, "never replaced on a host's UNKNOWN with no block to check it against");
  assert.equal(op.follow.out_past, undefined);
});

// ---- delta review 2 of c3e71713: the split window, one tap signs, item 8's scope (the reviewer's X1-X9, as tests) ----
const landedMove = async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("sender_struck");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "sent");
  const hash = (first as { hash: string }).hash;
  chain.land(hash);
  chain.nonceAt = (h) => (h >= 1001 ? 8n : 7n);
  chain.a.height = chain.b.height = 1000 + 150_000; // one of the pair has forgotten it, the other not yet
  return { chain, ops, hash };
};

test("X1 the split window: the move landed long ago, one RPC forgot it, the other reads it FINAL success; a late 2,000,000 in U: open, and the tap moves it", async () => {
  const { chain, ops, hash } = await landedMove();
  chain.txsB = new Map();
  chain.usdc = 2_000_001n;
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "open" });
  assert.deepEqual(((await ops.get("ops", "op1")) as DepositOp).follow.out_past?.map((r) => r.hash), [hash]);
  chain.txsB = null;
  chain.onSend = (_s, h) => chain.land(h);
  seedOpens = 0;
  const tap = await moveOutHeld("op1", TO, deps(ops, chain));
  // the late 2,000,000 is under op1's need (2,500,000), so the tap's move, which took it, marks no op: op1 stays held, the
  // record its history (the X8 limit of delta review 6); the tap moved money, so the page answers moved, never empty
  // (delta review 8, point 3 fold)
  assert.equal(tap.kind, "moved");
  assert.equal((tap as { amount: bigint }).amount, 2_000_000n);
  assert.notEqual(await whyOf(ops, "op1"), "moved_out");
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.out_past?.at(-1)?.amount, "2000000");
  assert.equal(seedOpens, 1);
  // U at 1 in the same split: the archival hosts' word settles it as moved
  const q = await landedMove();
  q.chain.txsB = new Map();
  assert.equal((await moveOutHeld("op1", null, deps(q.ops, q.chain))).kind, "moved");
  assert.equal(((await q.ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
});

test("X2 both of the pair forgot it, one RPC's tx read fails (429) while its other reads work; a late 2,000,000 in U: open", async () => {
  const { chain, ops, hash } = await landedMove();
  chain.forgot.add(hash);
  chain.usdc = 2_000_001n;
  const [a, b] = chain.rpcs();
  const rpcs = [a, { ...b, tx: async () => Promise.reject(new Error("HTTP 429")) }] as const;
  assert.deepEqual(await moveOutHeld("op1", null, { ...deps(ops, chain), rpcs }), { kind: "open" });
});

test("X3 both ops of U read Moved on one record; 2,000,000 more reaches U: each op's resume is open, a tap moves it, and the other op reads that move", async () => {
  const chain = new Chain();
  chain.usdc = 5_000_000n; // both ops' 2,500,000 in U: U's move carries both (delta review 6, F2: Moved capped by it)
  chain.registered.add(TO);
  const ops = await heldOp("note");
  await ops.put("ops", "op2", { ...((await ops.get("ops", "op1")) as DepositOp), created_ms: 2 });
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "moved");
  assert.equal(((await ops.get("ops", "op2")) as DepositOp).follow.why, "moved_out");
  chain.usdc = 2_000_001n;
  assert.deepEqual(await moveOutHeld("op2", null, deps(ops, chain)), { kind: "open" }, "op2 resume");
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "open" }, "op1 resume");
  for (const k of ["op1", "op2"]) assert.equal(((await ops.get("ops", k)) as DepositOp).follow.out, undefined, k);
  const tap = await moveOutHeld("op2", TO, deps(ops, chain));
  assert.equal(tap.kind, "moved");
  assert.equal((tap as { amount: bigint }).amount, 2_000_000n);
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.out?.hash, (tap as { hash: string }).hash, "op1 marked by op2's landed move");
});

test("X4 an op with its own moved record is never overwritten by another op's landed move", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.registered.add("bob.testnet");
  const ops = await heldOp("note");
  const m1 = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(m1.kind, "moved");
  const one = (await ops.get("ops", "op1")) as DepositOp;
  const { out: _o, why: _w, ...rest } = one.follow;
  await ops.put("ops", "op2", { ...one, created_ms: 2, follow: { ...rest, why: "note" } });
  chain.usdc = 3_000_001n;
  const m2 = await moveOutHeld("op2", "bob.testnet", deps(ops, chain));
  assert.equal(m2.kind, "moved");
  const o1 = (await ops.get("ops", "op1")) as DepositOp;
  assert.equal(o1.follow.out?.hash, (m1 as { hash: string }).hash, "op1 keeps its own record");
  assert.equal(o1.follow.why, "moved_out");
});

test("X5 an op follow.ts ended moved_out with no move, marked by another op's landed move, then a later deposit: its resume is open and a tap signs", async () => {
  const chain = new Chain();
  chain.usdc = 5_000_000n; // both ops' 2,500,000 in U: U's move carries both (delta review 6, F2: Moved capped by it)
  chain.registered.add(TO);
  const ops = await heldOp("note");
  const one = (await ops.get("ops", "op1")) as DepositOp;
  await ops.put("ops", "op2", { ...one, created_ms: 2, follow: { ...one.follow, why: "moved_out" } });
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "moved");
  assert.ok(((await ops.get("ops", "op2")) as DepositOp).follow.out);
  chain.usdc = 2_000_001n;
  assert.deepEqual(await moveOutHeld("op2", null, deps(ops, chain)), { kind: "open" });
  assert.equal(((await ops.get("ops", "op2")) as DepositOp).follow.out, undefined);
  const tap = await moveOutHeld("op2", TO, deps(ops, chain));
  assert.equal(tap.kind, "moved");
  assert.equal(((await ops.get("ops", "op2")) as DepositOp).follow.out?.hash, (tap as { hash: string }).hash);
});

test("X6 (L5) one tap signs: the pair keeps the op's record FINAL success and a late 2,000,000 sits in U; the first tap moves it", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("note");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  chain.land((first as { hash: string }).hash);
  chain.usdc = 2_000_001n;
  chain.onSend = (_s, h) => chain.land(h);
  seedOpens = 0;
  const tap = await moveOutHeld("op1", TO, deps(ops, chain));
  // the first record landed with the late 2,000,000 in U: it marks op1, which reopens (delta review 8, ruling 2), so this
  // tap signs the late money with `later` and op1 reads Moved on it, never Held forever
  assert.equal(tap.kind, "moved");
  assert.equal((tap as { amount: bigint }).amount, 2_000_000n);
  assert.equal(seedOpens, 1);
  const o1 = ((await ops.get("ops", "op1")) as DepositOp).follow;
  assert.equal(o1.why, "moved_out");
  assert.equal(o1.out?.hash, (tap as { hash: string }).hash);
  assert.equal(o1.out?.later, true);
  assert.deepEqual(o1.out_past?.map((r) => r.hash), [(first as { hash: string }).hash]);
  // a pair that keeps reading every new move landed with U full again signs once more at most, never in a loop
  const c2 = new Chain();
  c2.registered.add(TO);
  c2.onSend = (_s, h) => void c2.txs.set(h, "ok"); // reads FINAL success, U's USDC never moves
  const ops2 = await heldOp("note");
  await moveOutHeld("op1", TO, deps(ops2, c2));
  seedOpens = 0;
  assert.deepEqual(await moveOutHeld("op1", TO, deps(ops2, c2)), { kind: "open" });
  assert.equal(seedOpens, 1, "one new signature per tap");
});

test("X7 item 8's scope: an op inside intents.near, an op whose money never reached U (1Click not yet delivered), an op whose refund move is through but whose USDC never read in U, and a done op of U are never marked by U's move", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const ops = await heldOp("note");
  const one = (await ops.get("ops", "op1")) as DepositOp;
  const { delivered: _d, ...undelivered } = one.follow;
  await ops.put("ops", "op3", { ...one, created_ms: 0, follow: { ...one.follow, why: "sender_struck", intents_struck: true } });
  await ops.put("ops", "op4", { ...one, created_ms: 0, follow: { ...undelivered, why: "under_min" } });
  await ops.put("ops", "op5", { ...one, created_ms: 0, stage: "done" });
  await ops.put("ops", "op6", { ...one, created_ms: 0, follow: { ...undelivered, why: "note", moved: true } });
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "moved");
  // op6 (delta review 3, F3): follow.moved is set once the refund intent's debit inside intents.near lands, before its
  // USDC reaches U, and a swap held in flight may yet be refunded there: it stays held, what reaches U later is open to
  // a tap (delta review 5, item 1: R5-MOVED-INFLIGHT)
  for (const k of ["op3", "op4", "op5", "op6"]) {
    const o = (await ops.get("ops", k)) as DepositOp;
    assert.notEqual(o.follow.why, "moved_out", k);
    assert.equal(o.follow.out, undefined, k);
  }
  assert.equal(((await ops.get("ops", "op6")) as DepositOp).follow.why, "note", "op6 stays held as it was");
});

// Delta review 5, item 1 (reopens delta review 3, F3): a refund move's follow.moved is set on its debit inside
// intents.near; 1Click delivers its USDC to U in its own later tx (a quote lives 30 minutes, refund.ts), or refunds it
// into intents.near if the swap fails, so no count of blocks since says its USDC was in U when U's move took all of it.
// Such an op is never marked Moved by another op's move (R4-MOVED marked it at SETTLE_BLOCKS); an op 1Click delivered
// to U is. Once its USDC does reach U, a tap on it moves it and it reads Moved on its own record.
test("R5-MOVED-INFLIGHT a held op whose refund move is through, its swap still in flight, never reads Moved with U's move; once its USDC reaches U a tap moves it and it reads Moved", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const ops = await heldOp("note");
  const one = (await ops.get("ops", "op1")) as DepositOp;
  const { delivered: _d, ...undelivered } = one.follow;
  // through 100 blocks before U's move (R4-MOVED's line), and long before (prior_height 0): neither says the USDC arrived
  await ops.put("ops", "op7", { ...one, created_ms: 0, follow: { ...undelivered, why: "leaf", moved: true, prior_height: 1000 - SETTLE_BLOCKS } });
  await ops.put("ops", "op8", { ...one, created_ms: 0, follow: { ...undelivered, why: "leaf", moved: true, prior_height: 0 } });
  // U holds op1's 2,500,000 only
  const moved = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(moved.kind, "moved");
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
  for (const k of ["op7", "op8"]) {
    const o = (await ops.get("ops", k)) as DepositOp;
    assert.equal(o.follow.why, "leaf", `${k} stays held as it was`);
    assert.equal(o.follow.out, undefined, k);
  }
  // op7's swap delivers to U after the move: a tap on op7 moves it, on op7's own record
  chain.usdc = 2_000_001n;
  const tap = await moveOutHeld("op7", TO, deps(ops, chain));
  // no status read (none): op7 and op8 are walked at their min_out after the delivered and in-flight ops (delta review
  // 8, ruling 1); the 2,000,000 carried both floors, so both read Moved on op7's record and the page answers moved
  assert.equal(tap.kind, "moved");
  for (const k of ["op7", "op8"]) {
    const o = (await ops.get("ops", k)) as DepositOp;
    assert.equal(o.follow.why, "moved_out", k);
    assert.equal(o.follow.out?.hash, (tap as { hash: string }).hash, k);
  }
});

// Delta review 8, ruling 1, with R5's ops as holdAll now stores them: a refund move through, its status read REFUNDED (the
// USDC went into intents.near; delta review 3, F3; delta review 5, item 1) needs nothing, whatever its move's height:
// never Moved by U's move, nor by a tap on its own record, which stays its history.
test("R8-REFUNDED a held op whose refund move is through and whose status read REFUNDED never reads Moved with U's move, even on its own tap, which answers moved", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const ops = await heldOp("note");
  const one = (await ops.get("ops", "op1")) as DepositOp;
  const { delivered: _d, ...undelivered } = one.follow;
  const refunded = { ...undelivered, why: "leaf", sent: true, status: "REFUNDED" as const, moved: true };
  await ops.put("ops", "op7", { ...one, created_ms: 0, follow: { ...refunded, prior_height: 1000 - SETTLE_BLOCKS } });
  await ops.put("ops", "op8", { ...one, created_ms: 0, follow: { ...refunded, prior_height: 0 } });
  chain.usdc = 4_500_000n; // op1's 2,500,000 and 2,000,000 more: room for both floors past op1's need
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "moved");
  assert.equal(await whyOf(ops, "op1"), "moved_out");
  for (const k of ["op7", "op8"]) assert.equal(await whyOf(ops, k), "leaf", `${k} stays held`);
  chain.usdc = 2_000_001n;
  // no op of U reads this move, but the tap moved money: the page answers moved, never empty (delta review 8, point 3
  // fold)
  const tap = await moveOutHeld("op7", TO, deps(ops, chain));
  assert.equal(tap.kind, "moved");
  assert.equal((tap as { amount: bigint }).amount, 2_000_000n);
  const o7 = (await ops.get("ops", "op7")) as DepositOp;
  assert.equal(o7.follow.why, "leaf");
  assert.deepEqual(o7.follow.out_past?.map((r) => r.amount), ["2000000"], "its own move's record, history");
});

// the boundary of the point 3 fold: a tap at U 2 moves 1 base unit, which marks no op (op1 needs 2,500,000); a move of
// at most 1 carried nothing to show, so the page answers nothing to move
test("R8-DUST a landed tap move of 1 base unit that marks no op answers empty", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.usdc = 2n;
  const ops = await heldOp("note");
  assert.deepEqual(await moveOutHeld("op1", TO, deps(ops, chain)), { kind: "empty" });
  assert.equal(chain.sent.length > 0, true, "the 1 base unit move was sent");
  assert.equal(chain.usdc, 1n);
  assert.notEqual(await whyOf(ops, "op1"), "moved_out");
});

// Delta review 10, F1: a stranger's 3 base units in U, op1's own delivery still in flight: the tap moves 2, which marks
// no op and is under MIN_DEPOSIT, so the page answers nothing to move, never Moved while op1 stays held
test("R8-DUST3 a landed tap move of 2 base units (a stranger's dust) that marks no op answers empty", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.usdc = 3n;
  const ops = await heldOp("sender_struck", { sent: true, status: "PROCESSING" });
  const one = (await ops.get("ops", "op1")) as DepositOp;
  const { delivered: _d, ...f } = one.follow;
  await ops.put("ops", "op1", { ...one, follow: f });
  assert.deepEqual(await moveOutHeld("op1", TO, deps(ops, chain)), { kind: "empty" });
  assert.equal(chain.usdc, 1n, "the 2 base units moved");
  const o = ((await ops.get("ops", "op1")) as DepositOp).follow;
  assert.equal(o.why, "sender_struck");
  assert.equal(o.out, undefined);
});

// Delta review 11, F1: the floor is on what U held (the move's amount + 1), as the cap and follow.ts needOf's floor
// are. An op whose status reads REFUNDED (a refund-moved op, or a paid op the helper calls REFUNDED: delta review 9,
// ruling 3) needs nothing, so its tap marks no op: with exactly MIN_DEPOSIT in U the tap moves MIN_DEPOSIT - 1 and the
// page answers moved; with MIN_DEPOSIT - 1 in U it is a stranger's dust, nothing to move
test("R11-FLOOR U held exactly MIN_DEPOSIT, no op marked: the landed tap answers moved; MIN_DEPOSIT - 1 answers empty", async () => {
  for (const moved of [true, false])
    for (const [usdc, kind] of [[VAULT_CONSTANTS.MIN_DEPOSIT, "moved"], [VAULT_CONSTANTS.MIN_DEPOSIT - 1n, "empty"]] as const) {
      const at = `U ${usdc}, moved ${moved}`;
      const chain = new Chain();
      chain.registered.add(TO);
      chain.usdc = usdc;
      const ops = await heldOp("sender_struck");
      const one = (await ops.get("ops", "op1")) as DepositOp;
      const { delivered: _d, ...rest } = one.follow;
      await ops.put("ops", "op1", { ...one, follow: { ...rest, sent: true, status: "REFUNDED", ...(moved ? { moved: true } : {}) } });
      const t = await moveOutHeld("op1", TO, deps(ops, chain));
      assert.equal(chain.usdc, 1n, `${at}: the move landed`);
      const o = ((await ops.get("ops", "op1")) as DepositOp).follow;
      assert.notEqual(o.why, "moved_out", `${at}: no op marked`);
      const r = o.out_past?.at(-1);
      assert.equal(r?.amount, (usdc - 1n).toString(), `${at}: its own move, history`);
      assert.deepEqual(t, kind === "moved" ? { kind, to: TO, amount: usdc - 1n, hash: r!.hash } : { kind }, at);
    }
});

// Delta review 10, F3 (the reviewer's PROBE-F7J): the resume of a forgotten landed record of 1 base unit (U held 2 when
// it was signed) whose op needs none of it answers nothing to move, never Moved
test("R10-F7J a forgotten landed record of 1 base unit, its op needing none of it: the resume answers empty", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.usdc = 2n;
  chain.onSend = () => {};
  const ops = await heldOp("sender_struck");
  const o0 = (await ops.get("ops", "op1")) as DepositOp;
  const { delivered: _d, ...rest } = o0.follow;
  await ops.put("ops", "op1", { ...o0, follow: { ...rest, sent: true, status: "REFUNDED" } });
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "sent");
  const hash = (first as { hash: string }).hash;
  chain.land(hash);
  chain.nonceAt = (h) => (h >= 1001 ? 8n : 7n);
  chain.a.height = chain.b.height = 1000 + 230_000;
  chain.forgot.add(hash);
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "empty" });
});

// Delta review 10, F2: the tap's re-reads run at once under one budget, inside U's lock: ten stale ops whose reads stall
// until their signal aborts (the budget cut to 50 ms here) all end within one budget, each a failed read, and the tap
// signs with the ranks it has
test("R10-BUDGET ten stale ops whose status reads stall: read at once, all within one budget, and the tap signs", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const ops = await heldOp("sender_struck", { sent: true, status: "SUCCESS" });
  const one = (await ops.get("ops", "op1")) as DepositOp;
  for (let k = 2; k <= 11; k++) await ops.put("ops", `op${k}`, { ...one, created_ms: k, follow: (({ delivered: _x, sent: _s, ...r }) => ({ ...r, address: `dep-addr-${k}`, status: "PENDING_DEPOSIT" as const }))(one.follow) });
  let inFlight = 0;
  let most = 0;
  const stall = (async (_url: string, init?: RequestInit) => {
    // as fetch does: an aborted signal rejects at once, a later abort rejects the stalled read
    const signal = init!.signal!;
    if (signal.aborted) throw signal.reason;
    most = Math.max(most, ++inFlight);
    await new Promise((_, no) => signal.addEventListener("abort", () => no(signal.reason), { once: true }));
  }) as unknown as typeof fetch;
  // only the first timeout made is cut: the tap's budget, made before any read's own 10 s timeout (follow.ts
  // readDepositStatus), which stays as it is (delta review 11, F2)
  const timeout = AbortSignal.timeout;
  let made = 0;
  AbortSignal.timeout = (ms: number) => (made++ === 0 ? timeout(50) : timeout(ms));
  let held = 0;
  try {
    const uLock = async <T,>(fn: () => Promise<T>) => {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        held = Date.now() - t0;
      }
    };
    assert.equal((await moveOutHeld("op1", TO, { ...deps(ops, chain), fetchFn: stall, uLock })).kind, "moved");
  } finally {
    AbortSignal.timeout = timeout;
  }
  assert.equal(most, 10, "the ten reads at once");
  assert.ok(held < 400, `U's lock held ${held} ms: one budget, not ten`);
  for (let k = 2; k <= 11; k++) assert.equal(((await ops.get("ops", `op${k}`)) as DepositOp).follow.status, "PENDING_DEPOSIT", `op${k}: a failed read keeps it`);
});

// Delta review 10, F2: a tap that follows another op's record and runs again (`again`, delta review 2 of c3e71713, L5)
// reads each stale op once in all, never once a pass
test("R10-ONCE a tap's two passes read each stale op once", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await twoOps({ status: "PENDING_DEPOSIT" }, { sent: true, status: "SUCCESS", delivered: "2500000" });
  const r = await moveOutHeld("op2", TO, deps(ops, chain));
  assert.equal(r.kind, "sent");
  chain.land((r as { hash: string }).hash);
  chain.usdc = 2_000_001n; // a later deposit: op2's followed record turns out landed with money in U, so the tap runs again
  chain.onSend = (_s, h) => chain.land(h);
  statusReads.length = 0;
  const t = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(t.kind, "moved");
  assert.deepEqual(statusReads, ["dep-addr"], "op1, the one stale op, read once over both passes");
});

// Delta review 11, F2: one budget over both of a tap's passes. Pass 1 reads op1 (stale) until the budget ends (only the
// first timeout made, the budget, is cut to 50 ms; each read's own 10 s timeout stays); op3, written while pass 1 reads
// (INCOMPLETE_DEPOSIT: pass 1's walk needs nothing of it), is new by pass 2 and read on the same budget, already ended,
// so its read aborts at once, never on a fresh budget or its own 10 s alone
test("R11-BUDGET2 a stale op new on a tap's second pass is read on the tap's one budget, already ended: it aborts at once", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await twoOps({ status: "PENDING_DEPOSIT" }, { sent: true, status: "SUCCESS", delivered: "2500000" });
  const r = await moveOutHeld("op2", TO, deps(ops, chain));
  assert.equal(r.kind, "sent");
  chain.land((r as { hash: string }).hash);
  chain.usdc = 2_000_001n; // a later deposit: op2's followed record turns out landed with money in U, so the tap runs again
  chain.onSend = (_s, h) => chain.land(h);
  const one = (await ops.get("ops", "op1")) as DepositOp;
  const asked: [string, boolean][] = [];
  const stall = (async (url: string, init?: RequestInit) => {
    const address = decodeURIComponent(url.split("depositAddress=")[1] ?? "");
    const signal = init!.signal!;
    asked.push([address, signal.aborted]);
    if (signal.aborted) throw signal.reason;
    if (address === "dep-addr-3") throw new Error("op3 read on a signal not yet ended"); // never a 10 s wait under a plant
    await ops.put("ops", "op3", { ...one, created_ms: 3, follow: { ...one.follow, address: "dep-addr-3", status: "INCOMPLETE_DEPOSIT" } });
    await new Promise((_, no) => signal.addEventListener("abort", () => no(signal.reason), { once: true }));
  }) as unknown as typeof fetch;
  const timeout = AbortSignal.timeout;
  let made = 0;
  AbortSignal.timeout = (ms: number) => (made++ === 0 ? timeout(50) : timeout(ms));
  try {
    assert.equal((await moveOutHeld("op1", TO, { ...deps(ops, chain), fetchFn: stall })).kind, "moved");
  } finally {
    AbortSignal.timeout = timeout;
  }
  assert.deepEqual(asked, [["dep-addr", false], ["dep-addr-3", true]], "op1 on pass 1, op3 on pass 2 with the budget already ended");
  assert.equal(((await ops.get("ops", "op3")) as DepositOp).follow.status, "INCOMPLETE_DEPOSIT", "a failed read keeps it");
});

// Delta review 10, F4: the re-read happens inside U's lock: a tap that cannot take it (another tab follows U) reads no
// status and signs nothing
test("R10-LOCK a tap whose U lock is held elsewhere reads no status", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const ops = await twoOps({ status: "PENDING_DEPOSIT" }, {});
  statusReads.length = 0;
  assert.deepEqual(await moveOutHeld("op1", TO, { ...deps(ops, chain), uLock: async () => null }), { kind: "unread" });
  assert.deepEqual(statusReads, []);
  assert.equal(chain.sent.length, 0);
});

// Delta review 10, order: the re-read runs before the other ops' records are read, so landed() at the tap walks fresh
// ranks: op2's own landed record (2,499,999), op2 stored INCOMPLETE_DEPOSIT (no need) but 1Click delivered its top-up;
// op1's tap reads op2 again first, so op2 reads Moved on its record instead of keeping it as history
test("R10-ORDER the tap's re-read comes before another op's landed record is walked", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await twoOps({ sent: true, status: "REFUNDED" }, { sent: true, status: "INCOMPLETE_DEPOSIT" });
  const r = await moveOutHeld("op2", TO, deps(ops, chain));
  assert.equal(r.kind, "sent");
  const hash = (r as { hash: string }).hash;
  chain.land(hash);
  assert.equal(chain.usdc, 1n);
  statusReads.length = 0;
  const t = await moveOutHeld("op1", TO, deps(ops, chain, { "dep-addr-2": ["SUCCESS", "2500000"] }));
  assert.deepEqual(t, { kind: "moved", to: TO, amount: 2_499_999n, hash }, "the tap follows op2's record: it reads Moved on it");
  assert.deepEqual(statusReads, ["dep-addr-2"]);
  const o2 = ((await ops.get("ops", "op2")) as DepositOp).follow;
  assert.equal(o2.why, "moved_out", "op2 reads Moved on its own landed record");
  assert.equal(o2.out?.hash, hash);
  assert.equal(await whyOf(ops, "op1"), "sender_struck");
});

// Delta review 6, F1: the page picks the owner by key order (heldOpFor), not by whose money is in U. op7's refund move
// is through (moved, no delivered), op1 was delivered and its USDC is in U: Withdraw from op7 moves op1's USDC, and
// op1 reads Moved, never op7 (ZZ-OWNER).
test("R6-OWNER a tap from an op with no need moves the money of the op that has it: that op reads Moved, the owner stays held", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const ops = await heldOp("note");
  const one = (await ops.get("ops", "op1")) as DepositOp;
  const { delivered: _d, ...undelivered } = one.follow;
  await ops.put("ops", "op7", { ...one, created_ms: 0, follow: { ...undelivered, why: "leaf", moved: true, prior_height: 1000 - SETTLE_BLOCKS } });
  const t = await moveOutHeld("op7", TO, deps(ops, chain));
  // the tap marked op1 Moved: the page answers moved, as the app's rows show it (delta review 8, ruling 3)
  assert.equal(t.kind, "moved");
  const o7 = (await ops.get("ops", "op7")) as DepositOp;
  assert.notEqual(o7.follow.why, "moved_out", "op7's money was never in U");
  assert.equal(o7.follow.out, undefined);
  assert.equal(o7.follow.out_past?.length, 1);
  const moved = o7.follow.out_past![0]!;
  const o1 = (await ops.get("ops", "op1")) as DepositOp;
  assert.equal(o1.follow.why, "moved_out");
  assert.equal(o1.follow.out?.hash, moved.hash, "op1 reads the move op7's tap signed");
  assert.equal((t as { hash: string }).hash, moved.hash, "the page's answer is the app's row");
});

// Delta review 6, F2: `delivered` is 1Click's status through the helper, so it never marks an op past what U's move
// carried: op9 says delivered 2,500,000, U holds op1's 2,500,000 only, and op9 stays held; with both in U (5,000,000)
// both read Moved.
test("R6-CAP an op 1Click names delivered reads Moved with U's move only while the move carried every op's need, oldest first", async () => {
  // U at 4,999,999: one base unit short of both needs, the move's amount + 1 its cap
  for (const [usdc, nine] of [[2_500_000n, false], [4_999_999n, false], [5_000_000n, true]] as const) {
    const chain = new Chain();
    chain.registered.add(TO);
    chain.usdc = usdc;
    const ops = await heldOp("note");
    const one = (await ops.get("ops", "op1")) as DepositOp;
    await ops.put("ops", "op9", { ...one, created_ms: 9, follow: { ...one.follow, why: "leaf" } });
    const m = await moveOutHeld("op1", TO, deps(ops, chain));
    assert.equal(m.kind, "moved", `U ${usdc}`);
    assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out", `U ${usdc}: op1, the oldest`);
    const o9 = (await ops.get("ops", "op9")) as DepositOp;
    assert.equal(o9.follow.why === "moved_out", nine, `U ${usdc}: op9`);
    assert.equal(o9.follow.out?.hash, nine ? (m as { hash: string }).hash : undefined, `U ${usdc}`);
  }
});

// Delta review 7, item 1 and delta review 8, ruling 1: holdAll reads every op's status before it holds it, and an op
// with no delivered needs its min_out while its last status read a send in flight (sent, KNOWN_DEPOSIT_TX or
// PROCESSING), or, walked last, while it reads none or PENDING_DEPOSIT (a read that never came); one REFUNDED (into
// intents.near), FAILED or INCOMPLETE_DEPOSIT needs nothing and never reads Moved.
// A: the older op; B: the younger, PROCESSING when U's bind stopped, its real delivery in U.
async function twoOps(aExtra: Partial<FollowRecord>, bExtra: Partial<FollowRecord>) {
  const ops = await heldOp("sender_struck");
  const one = (await ops.get("ops", "op1")) as DepositOp;
  const { delivered: _d, ...undelivered } = one.follow;
  await ops.put("ops", "op1", { ...one, created_ms: 1, follow: { ...undelivered, ...aExtra } });
  await ops.put("ops", "op2", { ...one, created_ms: 2, follow: { ...undelivered, address: "dep-addr-2", ...bExtra } });
  return ops;
}
const whyOf = async (ops: WalletStore, k: string) => ((await ops.get("ops", k)) as DepositOp).follow.why;
for (const owner of ["op1", "op2"])
  test(`Q1a the older op REFUNDED, the younger in flight with 1,100,000 in U, the tap from ${owner}: the younger reads Moved, the refunded one stays held`, async () => {
    const chain = new Chain();
    chain.registered.add(TO);
    chain.usdc = 1_100_000n;
    const ops = await twoOps({ sent: true, status: "REFUNDED" }, { sent: true, status: "PROCESSING" });
    const m = await moveOutHeld(owner, TO, deps(ops, chain));
    // the tap marked op2 Moved: the page answers moved whichever op it tapped from (delta review 8, ruling 3)
    assert.equal(m.kind, "moved");
    assert.equal(await whyOf(ops, "op1"), "sender_struck", "the refunded op: its money waits inside intents.near");
    assert.equal(await whyOf(ops, "op2"), "moved_out");
    assert.equal((await moveOutHeld("op2", TO, deps(ops, chain))).kind, "moved", "the paid op's next tap reads Moved, never empty");
  });
// Delta review 11 (R8i re-killed): a move under the floor that marks another op of U answers moved from any op's tap.
// U holds 600,000 (under MIN_DEPOSIT); op2's send is in flight at min_out 500,000, within the cap (599,999 + 1); the tap
// from op1 (REFUNDED, no need) marks op2 alone, so the page answers moved by op2's mark, never by the floor or by
// whether its own op ended marked (delta review 8, ruling 3)
test("R11-MARKED a tap's move under MIN_DEPOSIT that marks another op of U answers moved, the tapped op left held", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.usdc = 600_000n;
  const ops = await twoOps({ sent: true, status: "REFUNDED" }, { sent: true, status: "PROCESSING", min_out: "500000" });
  const m = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(chain.usdc, 1n, "the move landed");
  const o2 = ((await ops.get("ops", "op2")) as DepositOp).follow;
  assert.equal(o2.why, "moved_out", "op2 reads Moved");
  assert.deepEqual(m, { kind: "moved", to: TO, amount: 599_999n, hash: o2.out!.hash });
  assert.equal(await whyOf(ops, "op1"), "sender_struck", "the tapped op stays held");
});
test("Q1b the older op REFUNDED, the younger in flight, 2,100,000 in U: only the younger reads Moved", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.usdc = 2_100_000n;
  const ops = await twoOps({ sent: true, status: "REFUNDED" }, { sent: true, status: "PROCESSING" });
  assert.equal((await moveOutHeld("op2", TO, deps(ops, chain))).kind, "moved");
  assert.equal(await whyOf(ops, "op1"), "sender_struck");
  assert.equal(await whyOf(ops, "op2"), "moved_out");
});
test("Q1c the older quote never paid (PENDING_DEPOSIT, nothing sent), the younger in flight with 1,000,000 in U: only the younger reads Moved", async () => {
  for (const a of [{ status: "PENDING_DEPOSIT" }, {}, { sent: true, status: "FAILED" }, { sent: true, status: "INCOMPLETE_DEPOSIT" }, { status: "PROCESSING" }] as Partial<FollowRecord>[]) {
    const chain = new Chain();
    chain.registered.add(TO);
    chain.usdc = 1_000_000n;
    const ops = await twoOps(a, { sent: true, status: "PROCESSING" });
    assert.equal((await moveOutHeld("op2", TO, deps(ops, chain))).kind, "moved", JSON.stringify(a));
    assert.equal(await whyOf(ops, "op1"), "sender_struck", JSON.stringify(a));
    assert.equal(await whyOf(ops, "op2"), "moved_out", JSON.stringify(a));
  }
  // a known send in flight counts as PROCESSING does
  const chain = new Chain();
  chain.registered.add(TO);
  chain.usdc = 1_000_000n;
  const ops = await twoOps({ status: "PENDING_DEPOSIT" }, { sent: true, status: "KNOWN_DEPOSIT_TX" });
  assert.equal((await moveOutHeld("op2", TO, deps(ops, chain))).kind, "moved");
  assert.equal(await whyOf(ops, "op2"), "moved_out");
});

// Delta review 6: an op 1Click named delivered is walked before any op held while its send was in flight, whatever their
// ages, so a min_out floor never takes the cap before a delivered need: the older in-flight op (1,000,000) and the
// younger delivered one (2,500,000), with U at 2,500,000: the delivered one reads Moved, the in-flight one stays held
test("R7-ORDER an op 1Click named delivered takes the cap before an older op held with its send in flight", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const ops = await twoOps({ sent: true, status: "PROCESSING" }, { sent: true, status: "SUCCESS", delivered: "2500000" });
  assert.equal((await moveOutHeld("op2", TO, deps(ops, chain))).kind, "moved");
  assert.equal(await whyOf(ops, "op2"), "moved_out");
  assert.equal(await whyOf(ops, "op1"), "sender_struck");
});

// Delta review 8, ruling 1: holdAll holds an op the moment U's bind stops, often before any status read past
// PENDING_DEPOSIT, and a failed read there keeps the stored status (follow.ts holdAll; deposit-follow.test.ts R8-HOLD):
// the only op of U, its own USDC in U, reads none or PENDING_DEPOSIT. Its tap moves its money, it reads Moved on that
// move, the page answers moved, and every next tap and resume reads the same.
for (const extra of [{ status: "PENDING_DEPOSIT" }, {}] as Partial<FollowRecord>[])
  test(`R8 the only op of U, its USDC in U, held with status ${JSON.stringify(extra)}: its tap reads Moved, never Held`, async () => {
    const chain = new Chain();
    chain.registered.add(TO);
    const ops = await heldOp("sender_struck");
    const one = (await ops.get("ops", "op1")) as DepositOp;
    const { delivered: _d, ...undelivered } = one.follow;
    await ops.put("ops", "op1", { ...one, follow: { ...undelivered, ...extra } });
    const t = await moveOutHeld("op1", TO, deps(ops, chain));
    assert.equal(t.kind, "moved", "the page answers moved");
    assert.equal(chain.usdc, 1n, "U's money moved");
    const o1 = ((await ops.get("ops", "op1")) as DepositOp).follow;
    assert.equal(o1.why, "moved_out", "op1 reads Moved");
    assert.equal(o1.out?.hash, (t as { hash: string }).hash);
    const sent = chain.sent.length;
    assert.deepEqual(await moveOutHeld("op1", TO, deps(ops, chain)), t, "the next tap reads the same move");
    assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), t, "the resume reads the same move");
    assert.equal(chain.sent.length, sent, "no new send");
  });

// Delta review 8, ruling 2 (X6, X8): the page closes before FINAL, the move lands, a later 2,000,000 reaches U before
// the next sign-in. The resume finds U above 1: landed() marks op1 on the landed record, which reopens (no record, why
// kept); the next tap moves the later money with `later` and op1 reads Moved on it. No op is Held forever, and no tap
// answers empty while U held money.
test("R8-X6 a landed move read with a later 2,000,000 in U: the resume is open, the next tap moves it, and op1 reads Moved", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("sender_struck");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "sent");
  chain.land((first as { hash: string }).hash);
  chain.usdc = 2_000_001n;
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "open" }, "the resume at the next sign-in");
  const open = ((await ops.get("ops", "op1")) as DepositOp).follow;
  assert.equal(open.why, "moved_out");
  assert.equal(open.out, undefined, "reopened: Held with its Withdraw while U holds money");
  assert.deepEqual(open.out_past?.map((r) => r.hash), [(first as { hash: string }).hash]);
  chain.onSend = (_s, h) => chain.land(h);
  const tap = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(tap.kind, "moved");
  assert.equal((tap as { amount: bigint }).amount, 2_000_000n);
  assert.equal(chain.usdc, 1n);
  const o1 = ((await ops.get("ops", "op1")) as DepositOp).follow;
  assert.equal(o1.why, "moved_out", "op1 reads Moved");
  assert.equal(o1.out?.hash, (tap as { hash: string }).hash);
  assert.equal(o1.out?.later, true);
  assert.deepEqual(await moveOutHeld("op1", TO, deps(ops, chain)), tap, "the next tap reads the same move");
  assert.equal([...chain.txs.values()].filter((v) => v === "ok").length, 2, "two moves landed, no third");
});

// Delta review 9, ruling 1: holdAll's one status read failed, so the paid op reads PENDING_DEPOSIT or none as the
// unpaid older quote does (S1), or stays INCOMPLETE_DEPOSIT after 1Click delivered its top-up (S2). The tap reads each
// such op of U once again before it signs: the paid op reads Moved, the unpaid one stays held, whichever op taps.
for (const b of [{ status: "PENDING_DEPOSIT" }, {}] as Partial<FollowRecord>[])
  test(`S1 the older quote unpaid, the younger paid with its holdAll read failed (${JSON.stringify(b)}), U at its 1,000,000: the tap reads both again, the paid one reads Moved`, async () => {
    for (const owner of ["op1", "op2"]) {
      const chain = new Chain();
      chain.registered.add(TO);
      chain.usdc = 1_000_000n;
      const ops = await twoOps({ status: "PENDING_DEPOSIT" }, b);
      statusReads.length = 0;
      const t = await moveOutHeld(owner, TO, deps(ops, chain, { "dep-addr-2": ["SUCCESS", "1000000"] }));
      assert.equal(t.kind, "moved", owner);
      // the unpaid quote's read fails (HTTP 503): it keeps PENDING_DEPOSIT, and the paid op is still read
      assert.deepEqual(statusReads, ["dep-addr", "dep-addr-2"], `${owner}: each read once`);
      assert.equal(await whyOf(ops, "op1"), "sender_struck", `${owner}: the unpaid quote stays held`);
      assert.equal(await whyOf(ops, "op2"), "moved_out", `${owner}: the paid op reads Moved`);
      const o2 = ((await ops.get("ops", "op2")) as DepositOp).follow;
      assert.deepEqual([o2.status, o2.sent, o2.delivered], ["SUCCESS", true, "1000000"]);
    }
  });
test("S2 the only op stored INCOMPLETE_DEPOSIT, its top-up then delivered, holdAll's read failed: the tap reads it again and it reads Moved", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const ops = await heldOp("sender_struck");
  const one = (await ops.get("ops", "op1")) as DepositOp;
  const { delivered: _d, ...u } = one.follow;
  await ops.put("ops", "op1", { ...one, follow: { ...u, sent: true, status: "INCOMPLETE_DEPOSIT" } });
  statusReads.length = 0;
  const t = await moveOutHeld("op1", TO, deps(ops, chain, { "dep-addr": ["SUCCESS", "2500000"] }));
  assert.equal(t.kind, "moved");
  assert.deepEqual(statusReads, ["dep-addr"]);
  assert.equal(await whyOf(ops, "op1"), "moved_out");
  assert.deepEqual(await moveOutHeld("op1", TO, deps(ops, chain)), t, "the next tap reads the same move");
});
test("S1b the tap's read fails (HTTP 503) or the op is not stale: the tap signs with the ranks it has, each stale op asked once", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.usdc = 1_000_000n;
  const ops = await twoOps({ status: "PENDING_DEPOSIT" }, { sent: true, status: "PROCESSING" });
  statusReads.length = 0;
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "moved");
  assert.deepEqual(statusReads, ["dep-addr"], "PROCESSING is never asked; the failed read once");
  assert.equal(await whyOf(ops, "op2"), "moved_out");
  assert.equal(await whyOf(ops, "op1"), "sender_struck");
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.status, "PENDING_DEPOSIT", "a failed read keeps it");
});

// Delta review 7, item 2: a second landed() on one record (two SIGN_HOST tabs, settleHeld on every load) counts the ops
// this record already marked at their own needs, never at 0: three ops of 1,000,000, one move of 2,000,000, a tab whose
// tx read lags until the other tab's landed() is done: two read Moved, never three
test("Q3c two tabs land one record: the lagging tab's landed() never marks past the move's amount", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.usdc = 2_000_001n;
  chain.onSend = () => {};
  const ops = await heldOp("sender_struck", { delivered: "1000000" });
  const one = (await ops.get("ops", "op1")) as DepositOp;
  await ops.put("ops", "op2", { ...one, created_ms: 2 });
  await ops.put("ops", "op3", { ...one, created_ms: 3 });
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  chain.land((first as { hash: string }).hash);
  let gate!: () => void;
  const open = new Promise<void>((ok) => (gate = ok));
  const slow = chain.rpcs().map((r) => ({ ...r, tx: async (p: Parameters<MoveOutRpc["tx"]>[0]) => (await open, r.tx(p)) })) as unknown as readonly [MoveOutRpc, MoveOutRpc];
  const tabB = moveOutHeld("op1", null, { ...deps(ops, chain), rpcs: slow });
  await new Promise((ok) => setTimeout(ok, 20)); // tab B has read op1 and waits on its tx read
  assert.equal((await moveOutHeld("op1", null, deps(ops, chain))).kind, "moved");
  gate();
  assert.equal((await tabB).kind, "moved");
  assert.deepEqual(await Promise.all(["op1", "op2", "op3"].map((k) => whyOf(ops, k))), ["moved_out", "moved_out", "sender_struck"]);
});

// Delta review 7, item 3: the marking write re-checks the walk's filter, so an op a follower moved on between the walk's
// read and the write (follow.ts:934, held to in_transit) never gets moved_out and the record
test("Q4 an op moved on by its follower between the walk and the write is never marked", async () => {
  const chain = new Chain();
  chain.usdc = 5_000_000n; // both ops' 2,500,000 in U
  chain.registered.add(TO);
  // their status read SUCCESS, so the tap reads neither again (delta review 9, ruling 1): op2's first write is the mark
  const base = await heldOp("note", { sent: true, status: "SUCCESS" });
  await base.put("ops", "op2", { ...((await base.get("ops", "op1")) as DepositOp), created_ms: 2 });
  let moved = false;
  const ops = new Proxy(base, {
    get(t, k) {
      if (k !== "update") return Reflect.get(t, k).bind(t);
      return async (store: string, key: string, fn: (v: unknown) => unknown) => {
        if (key === "op2" && !moved) {
          moved = true;
          await t.update("ops", "op2", (v) => ({ ...(v as DepositOp), stage: "in_transit" }));
        }
        return t.update(store as never, key, fn as never);
      };
    },
  }) as WalletStore;
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "moved");
  assert.ok(moved, "the follower's write ran inside the walk");
  const o2 = (await base.get("ops", "op2")) as DepositOp;
  assert.equal(o2.stage, "in_transit");
  assert.notEqual(o2.follow.why, "moved_out");
  assert.equal(o2.follow.out, undefined);
});

test("X8 a tap that follows another op's landed record with a late 2,000,000 in U: that owner's record is history and the same tap signs", async () => {
  const chain = new Chain();
  chain.usdc = 5_000_000n; // both ops' 2,500,000 in U: U's move carries both (delta review 6, F2: Moved capped by it)
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("note");
  await ops.put("ops", "op2", { ...((await ops.get("ops", "op1")) as DepositOp), created_ms: 2 });
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  const hash = (first as { hash: string }).hash;
  chain.land(hash);
  chain.usdc = 2_000_001n;
  chain.onSend = (_s, h) => chain.land(h);
  seedOpens = 0;
  const t = await moveOutHeld("op2", TO, deps(ops, chain));
  // op1's record landed with the late deposit in U: it carried both ops' money, so it marks both, which reopen (delta
  // review 8, ruling 2); op2's tap signs the late 2,000,000 with `later` and both read Moved on it
  assert.equal(t.kind, "moved");
  assert.equal((t as { amount: bigint }).amount, 2_000_000n);
  assert.equal(seedOpens, 1);
  for (const k of ["op1", "op2"]) {
    const o = ((await ops.get("ops", k)) as DepositOp).follow;
    assert.equal(o.why, "moved_out", k);
    assert.equal(o.out?.hash, (t as { hash: string }).hash, k);
    assert.deepEqual(o.out_past?.map((r) => r.hash), [hash], k);
  }
});

test("X9 the boundary: U at 2 after a landed move is open in follow() and in a moved op's resume", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("note");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  chain.land((first as { hash: string }).hash);
  chain.usdc = 2n;
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "open" }, "follow()");
  const c2 = new Chain();
  c2.registered.add(TO);
  const ops2 = await heldOp("note");
  assert.equal((await moveOutHeld("op1", TO, deps(ops2, c2))).kind, "moved");
  c2.usdc = 2n;
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops2, c2)), { kind: "open" }, "moved op's resume");
});

test("the tap keeps every held reason but moved_out (sender_struck, under_min)", async () => {
  for (const why of ["sender_struck", "under_min"]) {
    const chain = new Chain();
    chain.registered.add(TO);
    chain.onSend = () => {};
    const ops = await heldOp(why);
    assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
    assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.why, why);
  }
});

test("a move both of the pair read FINAL success is moved on their word, its nonce long settled: the archival hosts are never asked (their UNKNOWN never reads it empty)", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {};
  const ops = await heldOp("note");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  chain.land((first as { hash: string }).hash);
  chain.nonceAt = (h) => (h >= 1001 ? 8n : 7n);
  chain.a.height = chain.b.height = 1000 + 10 * SETTLE_BLOCKS;
  chain.archTxs = new Map(); // the archival hosts answer UNKNOWN_TRANSACTION, serving its block
  let asked = 0;
  const archival = NET.archival.map((n) => {
    const h = chain.archival(n);
    return { ...h, tx: async (p: Parameters<MoveOutRpc["tx"]>[0]) => (asked++, h.tx(p)) };
  });
  const out = await moveOutHeld("op1", null, { ...deps(ops, chain), archival });
  assert.equal(out.kind, "moved");
  assert.equal(asked, 0);
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
});
