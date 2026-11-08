// Card held-deposit-way-out: a held deposit's U moves its USDC to the typed account by its own transaction
// (src/deposit/moveout.ts). A fake chain answers both RPCs of the testnet release pair; the signed bytes are decoded
// and checked against nearcore's borsh by hand.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { VAULT_TOKEN_CODE_HASH } from "@blindfill/kit";
import { IDBFactory } from "fake-indexeddb";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import type { DepositOp, FollowRecord } from "../src/deposit/follow.ts";
import { checkMoveCalls, GAS_PRICE_MARGIN, MOVE_GAS, moveCalls, type MoveOutRecord, MoveOutRefused, type MoveOutRpc, moveOutHeld, SETTLE_BLOCKS, TX_VALIDITY_BLOCKS } from "../src/deposit/moveout.ts";
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
  skewB: Partial<{ nonce: bigint; usdc: bigint; registered: boolean; gas: bigint; hash: string; near: bigint; code: string }> = {};
  /** the second RPC's own tx states (default: the same as the first's) */
  txsB: Map<string, "ok" | "failed"> | null = null;
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
        if (p.method_name === "storage_balance_bounds") return view({ min: STORAGE_MIN.toString(), max: STORAGE_MIN.toString() }, h);
        throw new Error(`unexpected ${String(p.method_name)}`);
      },
      // the release RPCs, read 8 Nov 2026: a hash nobody sent answers UNKNOWN_TRANSACTION (HTTP 200) only to wait_until
      // NONE; to FINAL fastnear times out (10 s, or no answer in 30 s) and dRPC answers HTTP 408, which the client throws
      tx: async ({ tx_hash, sender_account_id, wait_until }) => {
        const st = (k === "b" && this.txsB !== null ? this.txsB : this.txs).get(tx_hash);
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
  // a split read is never "unknown on both": with U's nonce taken long ago the record is still followed, not settled
  chain.nonce = 8n;
  chain.a.height = chain.b.height = 1000 + 2 * SETTLE_BLOCKS;
  assert.equal((await moveOutHeld("op1", null, deps(ops, chain))).kind, "sent");
  assert.equal(seedOpens, 0);
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

test("M1 a record whose nonce another tx of U took: settled once the nonce is taken SETTLE_BLOCKS back; a resume answers empty, a tap signs anew for new USDC", async () => {
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
  // new USDC reaches U: a resume answers failed (Retry), and the tap signs anew at U's next nonce
  chain.usdc = 5_000_000n;
  assert.equal((await moveOutHeld("op1", null, deps(ops, chain))).kind, "failed");
  assert.equal(seedOpens, 0);
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

test("M1 two held ops of one U: the second op's tap follows the first's live record, one set of bytes, its account named", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.registered.add("bob.testnet");
  chain.onSend = () => {};
  const ops = await heldOp("note");
  await ops.put("ops", "op2", { ...((await ops.get("ops", "op1")) as DepositOp), created_ms: 2 });
  assert.equal((await moveOutHeld("op1", TO, deps(ops, chain))).kind, "sent");
  seedOpens = 0;
  const b = await moveOutHeld("op2", "bob.testnet", deps(ops, chain));
  assert.equal(b.kind, "sent");
  assert.equal((b as { to: string }).to, TO);
  assert.equal(seedOpens, 0);
  assert.equal(new Set(chain.sent).size, 1);
  // it lands: the first op ends moved_out, and the second finds nothing to move
  chain.txs.set((b as { hash: string }).hash, "ok");
  chain.usdc = 1n;
  assert.equal((await moveOutHeld("op2", "bob.testnet", deps(ops, chain))).kind, "moved");
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
  assert.deepEqual(await moveOutHeld("op2", "bob.testnet", deps(ops, chain)), { kind: "empty" });
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
  assert.equal(op1.follow.out, undefined, "op1's gone record is cleared");
  assert.deepEqual(op1.follow.out_past?.map((r) => r.hash), [(first as { hash: string }).hash], "and kept as op1's history");
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

test("L1 taken needs UNKNOWN_TRANSACTION on both RPCs: absent on one and a 408 on the other, U's nonce taken long ago, the record stays followed", async () => {
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
  assert.equal((await moveOutHeld("op1", null, { ...deps(ops, chain), rpcs: [a, mute] })).kind, "sent", "one RPC's UNKNOWN_TRANSACTION alone never settles a record");
  assert.equal(seedOpens, 0);
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.out_past, undefined);
  // both answer UNKNOWN_TRANSACTION: taken, a resume answers empty
  assert.deepEqual(await moveOutHeld("op1", null, deps(ops, chain)), { kind: "empty" });
});

test("L1 one RPC reads the tx ok, the other absent, and both read U's nonce below it past the window (hostile reads): never settled, the record stays followed", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.txsB = new Map();
  chain.onSend = (_s, h) => void chain.txs.set(h, "ok"); // the first RPC says it landed; U's nonce never moves
  const ops = await heldOp("sender_struck");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "sent");
  chain.a.height = chain.b.height = 1000 + Number(TX_VALIDITY_BLOCKS) + 1;
  seedOpens = 0;
  assert.equal((await moveOutHeld("op1", null, deps(ops, chain))).kind, "sent", "a tx one RPC reads is never settled as expired");
  assert.equal(seedOpens, 0);
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.out_past, undefined);
});
