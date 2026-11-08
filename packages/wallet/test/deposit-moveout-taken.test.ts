// Card held-deposit-way-out: a record of U's own move is taken (gone) only when both RPCs answer UNKNOWN_TRANSACTION for
// its tx, never when a read times out, is rate-limited or finds the receipts still running (src/deposit/moveout.ts
// recordState, the way scripts/ci/money-gate.mjs reads "missing"). The fake chain is deposit-moveout.test.ts's.
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
        return { result: { header: { height: h, hash: sk.hash ?? base58.encode(sha256(new TextEncoder().encode(`b${h}`))), timestamp_nanosec: "1" } } };
      },
      query: async (p) => {
        const h = at(p);
        if (p.request_type === "view_access_key_list") {
          const own = `ed25519:${base58.encode(Uint8Array.from(U.match(/../g)!, (x) => parseInt(x, 16)))}`;
          const keys = [{ public_key: this.foreignKey ?? own, access_key: { nonce: Number(sk.nonce ?? this.nonceAt(h)), permission: "FullAccess" } }];
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
      tx: async ({ tx_hash, sender_account_id }) => {
        const st = (k === "b" && this.txsB !== null ? this.txsB : this.txs).get(tx_hash);
        if (st === undefined) return { error: { cause: { name: "UNKNOWN_TRANSACTION" } } };
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


// The tx read of `hash` on both RPCs throws (a wait_until FINAL that times out: receipts still run, or a rate limit).
function timingOut(rpcs: readonly [MoveOutRpc, MoveOutRpc], slow: Set<string>): readonly [MoveOutRpc, MoveOutRpc] {
  return rpcs.map((r) => ({ ...r, tx: async (p: { tx_hash: string; sender_account_id: string; wait_until: string }) => {
    if (slow.has(p.tx_hash)) throw new Error("TimeoutError: the RPC's wait for FINAL ran out");
    return r.tx(p as never);
  } })) as unknown as readonly [MoveOutRpc, MoveOutRpc];
}

test("U's own move included 101 blocks ago, its receipt still running (the tx read times out): followed, never taken, the tap signs no second move", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const slow = new Set<string>();
  let first = "";
  // the send is included at once (U's nonce 8 from height 1000) but its receipt waits: USDC still at U
  chain.onSend = (_s, h) => { if (first === "") { first = h; slow.add(h); chain.nonceAt = (x) => (x >= 1000 ? 8n : 7n); chain.nonce = 8n; } };
  const ops = await heldOp("note");
  const d0 = { ...deps(ops, chain), rpcs: timingOut(chain.rpcs(), slow) };
  const o0 = await moveOutHeld("op1", TO, d0);
  assert.equal(o0.kind, "sent");
  chain.a.height = chain.b.height = 1000 + SETTLE_BLOCKS + 1;
  const d1 = { ...deps(ops, chain), rpcs: timingOut(chain.rpcs(), slow) };
  const resume = await moveOutHeld("op1", null, d1);
  seedOpens = 0;
  const tap = await moveOutHeld("op1", TO, d1);
  assert.equal(resume.kind, "sent", "a move whose tx is not answered FINAL is still followed");
  assert.equal(tap.kind, "sent", "the tap follows the same move");
  assert.equal(seedOpens, 0, "the tap never opens the seed: nothing is signed anew");
  const distinct = [...new Set(chain.sent)].map((x) => decode(x));
  assert.deepEqual(distinct.map((t) => t.nonce), [8n], "one move only, at nonce 8");
  const op = (await ops.get("ops", "op1")) as DepositOp;
  assert.equal(op.follow.out?.hash, first, "the first move is still the op's out");
  assert.equal(op.follow.out_past, undefined, "nothing filed as gone");
});

test("U's own move landed 101 blocks ago, both RPCs time out on the tx read: followed, never filed as gone, shown moved once the tx reads FINAL", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const slow = new Set<string>();
  let first = "";
  chain.onSend = (_s, h) => { if (first === "") { first = h; chain.txs.set(h, "ok"); chain.nonce = 8n; chain.usdc = 1n; chain.nonceAt = (x) => (x >= 1000 ? 8n : 7n); slow.add(h); } };
  const ops = await heldOp("note");
  const o0 = await moveOutHeld("op1", TO, { ...deps(ops, chain), rpcs: timingOut(chain.rpcs(), slow) });
  assert.equal(o0.kind, "sent");
  chain.a.height = chain.b.height = 1000 + SETTLE_BLOCKS + 1;
  const d1 = { ...deps(ops, chain), rpcs: timingOut(chain.rpcs(), slow) };
  const resume = await moveOutHeld("op1", null, d1);
  const tap = await moveOutHeld("op1", TO, d1);
  slow.delete(first); // the RPCs answer again: FINAL, success, on both
  const later = await moveOutHeld("op1", null, deps(ops, chain)).then((o) => o.kind, (e) => `refused: ${(e as Error).message}`);
  assert.deepEqual([resume.kind, tap.kind, later], ["sent", "sent", "moved"]);
  const op = (await ops.get("ops", "op1")) as DepositOp;
  assert.equal(op.follow.why, "moved_out", "a landed move ends moved_out once it reads FINAL");
  assert.equal(op.follow.out?.hash, first);
  assert.equal(op.follow.out_past, undefined, "nothing filed as gone");
});
