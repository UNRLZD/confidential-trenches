// Card held-deposit-way-out: a held deposit's U moves its USDC to the typed account by its own transaction
// (src/deposit/moveout.ts). A fake chain answers both RPCs of the testnet release pair; the signed bytes are decoded
// and checked against nearcore's borsh by hand.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import type { DepositOp, FollowRecord } from "../src/deposit/follow.ts";
import { checkMoveCalls, GAS_PRICE_MARGIN, MOVE_GAS, moveCalls, MoveOutRefused, type MoveOutRpc, moveOutHeld, TX_VALIDITY_BLOCKS } from "../src/deposit/moveout.ts";
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
  registered = new Set<string>();
  keys = 1;
  sent: string[] = [];
  txs = new Map<string, "ok" | "failed">();
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
    return {
      name,
      block: async (p) => {
        const h = "block_id" in p ? p.block_id : this[k].height;
        return { result: { header: { height: h, hash: base58.encode(sha256(new TextEncoder().encode(`b${h}`))), timestamp_nanosec: "1" } } };
      },
      query: async (p) => {
        const h = at(p);
        if (p.request_type === "view_access_key_list") {
          const own = `ed25519:${base58.encode(Uint8Array.from(U.match(/../g)!, (x) => parseInt(x, 16)))}`;
          const keys = [{ public_key: own, access_key: { nonce: Number(this.nonce), permission: "FullAccess" } }];
          if (this.keys > 1) keys.push({ public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 0, permission: "FullAccess" } });
          return { result: { block_height: h, keys } };
        }
        if (p.request_type === "view_account") return { result: { block_height: h, amount: this.near.toString(), locked: "0", storage_usage: Number(this.usage), code_hash: "11111111111111111111111111111111" } };
        const args = JSON.parse(Buffer.from(p.args_base64 as string, "base64").toString());
        if (p.method_name === "ft_balance_of") return view(this.usdc.toString(), h);
        if (p.method_name === "storage_balance_of") return view(this.registered.has(args.account_id) ? { total: STORAGE_MIN.toString(), available: "0" } : null, h);
        if (p.method_name === "storage_balance_bounds") return view({ min: STORAGE_MIN.toString(), max: STORAGE_MIN.toString() }, h);
        throw new Error(`unexpected ${String(p.method_name)}`);
      },
      tx: async ({ tx_hash, sender_account_id }) => {
        const st = this.txs.get(tx_hash);
        if (st === undefined) return { error: { cause: { name: "UNKNOWN_TRANSACTION" } } };
        const status = st === "ok" ? { SuccessValue: "" } : { Failure: { ActionError: {} } };
        return { result: { final_execution_status: "FINAL", status, transaction: { hash: tx_hash, signer_id: sender_account_id }, receipts_outcome: [{ id: "r", outcome: { status } }] } };
      },
      call: async (method, params) => {
        if (method === "gas_price") return { result: { gas_price: GAS_PRICE.toString() } };
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
}

async function heldOp(why: string, extra: Partial<FollowRecord> = {}) {
  const ops = await openWalletStore({ indexedDB: new IDBFactory() });
  opened.push(ops);
  const follow: FollowRecord = { network: "testnet", s: "1", i: 0, u: U, address: "dep-addr", deadline_ms: 1, origin: "nep141:x", min_out: "1000000", why, ...extra };
  const op: DepositOp = { kind: "deposit", stage: "held", txs: [], created_ms: 1, follow, held_id: U };
  await ops.put("ops", "op1", op);
  return ops;
}
let seedOpens = 0;
const deps = (ops: WalletStore, chain: Chain) => ({ ops, rpcs: chain.rpcs(), seed64: async () => (seedOpens++, SEED.slice()), sleep: async () => {}, pollMs: 0 });

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
