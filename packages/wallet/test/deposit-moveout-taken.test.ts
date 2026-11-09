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
import * as M from "../src/deposit/moveout.ts";
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
  // held by holdAll while its send was in flight (1Click PROCESSING, no SUCCESS read yet): its USDC in U, needing its
  // min_out of a landed move (delta review 7, item 1)
  const follow: FollowRecord = { network: "testnet", s: "1", i: 0, u: U, address: "dep-addr", deadline_ms: 1, origin: "nep141:x", min_out: "1000000", sent: true, status: "PROCESSING", why, ...extra };
  const op: DepositOp = { kind: "deposit", stage: "held", txs: [], created_ms: 1, follow, held_id: U };
  await ops.put("ops", "op1", op);
  return ops;
}
let seedOpens = 0;
const deps = (ops: WalletStore, chain: Chain) => ({ ops, rpcs: chain.rpcs(), archival: NET.archival.map((n) => chain.archival(n)), seed64: async () => (seedOpens++, SEED.slice()), sleep: async () => {}, pollMs: 0 , fetchFn: (async () => new Response("{}", { status: 503 })) as typeof fetch });

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

// Delta review 2 of c3e71713 (M1): once U's nonce is settled past a record on both RPCs, U holding more than 1 base unit
// is open whatever the tx reads say, so a tap moves it. A receipt still running that far back is the one case where
// that signs a second move of the same USDC; the token's ft_transfer moves only what U holds, so of the two at most one
// moves it and the other fails at the token (nothing moves twice).
test("U's own move included 101 blocks ago, U still holding its USDC (the tx read times out on both): open, and the tap signs at the next nonce, the first kept as history", async () => {
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
  assert.deepEqual(resume, { kind: "open" }, "money in U is movable");
  seedOpens = 0;
  const tap = await moveOutHeld("op1", TO, d1);
  assert.equal(tap.kind, "sent");
  assert.equal(seedOpens, 1, "the tap signs anew");
  const distinct = [...new Set(chain.sent)].map((x) => decode(x));
  assert.deepEqual(distinct.map((t) => t.nonce), [8n, 9n]);
  assert.deepEqual(distinct.map((t) => t.actions.at(-1)!.args.amount), ["2499999", "2499999"], "each moves at most what U holds less 1");
  const op = (await ops.get("ops", "op1")) as DepositOp;
  assert.notEqual(op.follow.out?.hash, first);
  assert.deepEqual(op.follow.out_past?.map((r) => r.hash), [first], "the first move is history");
});

test("U's own move landed 101 blocks ago, both RPCs time out on the tx read, U at 1: the archival hosts read it FINAL success, moved at once, never filed as gone", async () => {
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
  assert.deepEqual([resume.kind, tap.kind, later], ["moved", "moved", "moved"]);
  const op = (await ops.get("ops", "op1")) as DepositOp;
  assert.equal(op.follow.why, "moved_out", "a landed move ends moved_out once it reads FINAL");
  assert.equal(op.follow.out?.hash, first);
  assert.equal(op.follow.out_past, undefined, "nothing filed as gone");
});

// ---- delta review 3 of held-move-forgotten-tx ----
// F1: a tx whose receipts still run answers wait_until NONE, on the release RPCs, with its transaction, its outcomes so
// far and a final_execution_status short of FINAL (rpc.mainnet.fastnear.com and near.drpc.org, a just-included mainnet
// tx read at once on both, 8 Nov 2026 13:57-13:58Z: INCLUDED with status "Started", EXECUTED_OPTIMISTIC, INCLUDED_FINAL,
// EXECUTED). Such a record can still move U's USDC: it is followed, never filed, and no tap signs a second move.
const RUNNING = ["INCLUDED", "EXECUTED_OPTIMISTIC", "INCLUDED_FINAL", "EXECUTED"] as const;
type Read = { tx_hash: string; sender_account_id: string; wait_until: string };
// the RPCs at `sides` answer each hash in `slow` as running (status S, as read); the others (and any hash not slow)
// answer as before, the others' tx read of a slow hash timing out
function runningOn(rpcs: readonly [MoveOutRpc, MoveOutRpc], slow: Set<string>, S: string, sides: readonly number[] = [0, 1], shape: (p: Read) => Record<string, unknown> = (p) => ({ hash: p.tx_hash, signer_id: p.sender_account_id })): readonly [MoveOutRpc, MoveOutRpc] {
  return rpcs.map((r, k) => ({ ...r, tx: async (p: Read) => {
    if (!slow.has(p.tx_hash)) return r.tx(p as never);
    if (!sides.includes(k)) throw new Error("TimeoutError: no answer in time");
    return { result: { final_execution_status: S, status: S === "INCLUDED" ? "Started" : { SuccessValue: "" }, transaction: shape(p), transaction_outcome: { id: p.tx_hash, outcome: {} }, receipts_outcome: [] } };
  } })) as unknown as readonly [MoveOutRpc, MoveOutRpc];
}
// U's move included at once (U's nonce 8 from height 1000) whose receipt has not run: USDC still at U, and the read
// height past SETTLE_BLOCKS, so U's nonce is settled past the record on both
async function includedNotRun() {
  const chain = new Chain();
  chain.registered.add(TO);
  const slow = new Set<string>();
  const hashes: string[] = [];
  chain.onSend = (_s, h) => { if (!hashes.includes(h)) { hashes.push(h); slow.add(h); chain.nonce += 1n; const n = chain.nonce; const at = chain.a.height; const prev = chain.nonceAt; chain.nonceAt = (x) => (x >= at ? n : prev(x)); } };
  const ops = await heldOp("note");
  const o0 = await moveOutHeld("op1", TO, { ...deps(ops, chain), rpcs: timingOut(chain.rpcs(), slow) });
  assert.equal(o0.kind, "sent");
  chain.a.height = chain.b.height = 1000 + SETTLE_BLOCKS + 1;
  return { chain, ops, slow, hashes };
}

for (const S of RUNNING)
  test(`F1 a receipt still running past SETTLE_BLOCKS (the tx answered ${S} on both, U still holding its USDC): followed, never filed, no tap signs again; once it runs: Moved`, async () => {
    const { chain, ops, slow, hashes } = await includedNotRun();
    const dd = () => ({ ...deps(ops, chain), rpcs: runningOn(chain.rpcs(), slow, S) });
    assert.equal((await moveOutHeld("op1", null, dd())).kind, "sent", "the resume follows it");
    seedOpens = 0;
    assert.equal((await moveOutHeld("op1", TO, dd())).kind, "sent", "a tap follows it too");
    assert.equal(seedOpens, 0, "nothing signed anew");
    assert.equal(hashes.length, 1);
    let op = (await ops.get("ops", "op1")) as DepositOp;
    assert.equal(op.follow.out?.hash, hashes[0]);
    assert.equal(op.follow.out_past, undefined, "never filed as history");
    // the receipt runs: 2,499,999 reaches TO, U at 1
    chain.txs.set(hashes[0]!, "ok");
    chain.usdc = 1n;
    slow.clear();
    assert.equal((await moveOutHeld("op1", null, dd())).kind, "moved");
    op = (await ops.get("ops", "op1")) as DepositOp;
    assert.equal(op.follow.why, "moved_out", "a held deposit that moved out reads Moved");
  });

test("F1 one RPC reads the receipt still running, the other times out: followed, no tap signs again (either RPC's running word keeps it)", async () => {
  for (const side of [0, 1]) {
    const { chain, ops, slow, hashes } = await includedNotRun();
    const dd = () => ({ ...deps(ops, chain), rpcs: runningOn(chain.rpcs(), slow, "EXECUTED_OPTIMISTIC", [side]) });
    assert.equal((await moveOutHeld("op1", null, dd())).kind, "sent", `side ${side}`);
    seedOpens = 0;
    assert.equal((await moveOutHeld("op1", TO, dd())).kind, "sent", `side ${side}`);
    assert.equal(seedOpens, 0, `side ${side}`);
    assert.equal(hashes.length, 1, `side ${side}`);
  }
});

test("F1 a running answer that names another tx or another signer is no word: U's USDC open as before (a timeout on both: review 2's M1)", async () => {
  for (const shape of [(p: Read) => ({ hash: "11111111111111111111111111111111", signer_id: p.sender_account_id }), (p: Read) => ({ hash: p.tx_hash, signer_id: "mallory.testnet" }), () => ({})]) {
    const { chain, ops, slow } = await includedNotRun();
    const dd = { ...deps(ops, chain), rpcs: runningOn(chain.rpcs(), slow, "INCLUDED_FINAL", [0, 1], shape) };
    assert.deepEqual(await moveOutHeld("op1", null, dd), { kind: "open" });
  }
});

test("GAP-R10 a record still in flight (tx unknown on both), U's reads unequal on the pair: followed, never filed, nothing signed", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  chain.onSend = () => {}; // lost in flight: no RPC knows it yet
  const ops = await heldOp("note");
  const first = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(first.kind, "sent");
  chain.skewB = { usdc: 2_400_000n }; // the second RPC reads U apart
  seedOpens = 0;
  const resume = await moveOutHeld("op1", null, deps(ops, chain));
  assert.equal(resume.kind, "sent");
  assert.equal(seedOpens, 0);
  const op = (await ops.get("ops", "op1")) as DepositOp;
  assert.equal(op.follow.out?.hash, (first as { hash: string }).hash, "the record stays the op's out");
  assert.equal(op.follow.out_past, undefined);
});

test("GAP-R20 a record read landed on the archival hosts while another tab replaces it with a new live record: the new record is never marked moved_out", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const ops = await heldOp("note");
  // R1 lands, then both of the pair forget it; U at 1, nonce settled
  const r1 = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(r1.kind, "moved");
  const o = (await ops.get("ops", "op1")) as DepositOp;
  const { why: _w, ...rest } = o.follow;
  await ops.put("ops", "op1", { ...o, follow: { ...rest, why: "note" } }); // as if not yet marked (the resume that marks it)
  chain.forgot.add((r1 as { hash: string }).hash);
  chain.nonceAt = (h) => (h >= 1001 ? 8n : 7n);
  chain.a.height = chain.b.height = 1000 + 2 * SETTLE_BLOCKS;
  const R2: MoveOutRecord = { ...o.follow.out!, hash: "R2hash", nonce: "99" };
  let swapped = false;
  const archival = NET.archival.map((n) => {
    const h = chain.archival(n);
    return { ...h, tx: async (p: Parameters<MoveOutRpc["tx"]>[0]) => {
      if (!swapped) { swapped = true; const cur = (await ops.get("ops", "op1")) as DepositOp; const { out: _o, ...f } = cur.follow; await ops.put("ops", "op1", { ...cur, follow: { ...f, out_past: [cur.follow.out!], out: R2 } }); }
      return h.tx(p);
    } };
  });
  await moveOutHeld("op1", null, { ...deps(ops, chain), archival });
  const end = (await ops.get("ops", "op1")) as DepositOp;
  assert.equal(end.follow.out?.hash, "R2hash");
  assert.notEqual(end.follow.why, "moved_out", "a live record is never marked moved");
});

// F4: the page's archival hosts over HTTP (moveout.ts archivalRpc; before it the page read them with moveOutRpc, one
// ask each), each host's answers the fake chain's archival RPC gives
function archivalHttp(chain: Chain, answer: (url: string, ask: number) => Response | null, waits: number[]) {
  const asks = new Map<string, number>();
  const fetchFn = (async (url: string, init: RequestInit) => {
    const n = (asks.get(url) ?? 0) + 1;
    asks.set(url, n);
    const planted = answer(url, n);
    if (planted !== null) return planted;
    const { method, params } = JSON.parse(String(init.body));
    const h = chain.archival(url);
    return Response.json(await (method === "tx" ? h.tx(params) : h.block(params)));
  }) as typeof fetch;
  const make = (M as { archivalRpc?: typeof M.archivalRpc }).archivalRpc;
  const sleep = async (ms: number) => void waits.push(ms);
  return { rpcs: NET.archival.map((u) => (make ? make(u, fetchFn, 10_000, sleep) : M.moveOutRpc(u, fetchFn))), asks };
}
// U's move landed, both of the pair forgot it, U at 1 and its nonce settled past it
async function landedForgotten() {
  const chain = new Chain();
  chain.registered.add(TO);
  const ops = await heldOp("note");
  const r1 = await moveOutHeld("op1", TO, deps(ops, chain));
  assert.equal(r1.kind, "moved");
  const o = (await ops.get("ops", "op1")) as DepositOp;
  const { why: _w, ...rest } = o.follow;
  await ops.put("ops", "op1", { ...o, follow: { ...rest, why: "note" } });
  chain.forgot.add((r1 as { hash: string }).hash);
  chain.nonceAt = (h) => (h >= 1001 ? 8n : 7n);
  chain.a.height = chain.b.height = 1000 + 2 * SETTLE_BLOCKS;
  return { chain, ops };
}

test("F4 near.org's archival host answers HTTP 429 (Retry-After 2) once, then the tx: the landed forgotten move reads Moved in that same resume, never Sending", async () => {
  const { chain, ops } = await landedForgotten();
  const waits: number[] = [];
  const { rpcs, asks } = archivalHttp(chain, (url, n) => (url === NET.archival[0] && n === 1 ? new Response("Too Many Requests", { status: 429, headers: { "retry-after": "2" } }) : null), waits);
  assert.equal((await moveOutHeld("op1", null, { ...deps(ops, chain), archival: rpcs })).kind, "moved");
  assert.equal(((await ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
  assert.deepEqual(waits, [2000], "the host's own Retry-After");
  assert.equal(asks.get(NET.archival[0]), 2);
});

test("F4 one archival host down (HTTP 503, then a JSON-RPC -429 as fastnear answers a rate limit), then answering: Moved in that resume, 1 s then 2 s between asks", async () => {
  const { chain, ops } = await landedForgotten();
  const waits: number[] = [];
  const { rpcs } = archivalHttp(chain, (url, n) => (url !== NET.archival[1] ? null : n === 1 ? new Response("", { status: 503 }) : n === 2 ? Response.json({ jsonrpc: "2.0", id: "blindfill", error: { code: -429, message: "Rate limits exceeded" } }) : null), waits);
  assert.equal((await moveOutHeld("op1", null, { ...deps(ops, chain), archival: rpcs })).kind, "moved");
  assert.deepEqual(waits, [1000, 2000]);
});

test("F4 the asks are bounded: a host that throttles every ask is asked 4 times, each wait at most 10 s (Retry-After 120 capped), then no word: the record stays as it is", async () => {
  const { chain, ops } = await landedForgotten();
  const waits: number[] = [];
  const { rpcs, asks } = archivalHttp(chain, (url) => (url === NET.archival[0] ? new Response("", { status: 429, headers: { "retry-after": "120" } }) : null), waits);
  const out = await moveOutHeld("op1", null, { ...deps(ops, chain), archival: rpcs });
  assert.equal(out.kind, "sent", "no equal word from every host: followed");
  assert.equal(asks.get(NET.archival[0]), M.ARCHIVAL_ASKS);
  assert.equal(M.ARCHIVAL_ASKS, 4);
  assert.deepEqual(waits, [10_000, 10_000, 10_000]);
  assert.notEqual(((await ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
});

test("F4 an answer that is no throttle is never asked again: HTTP 400, or no answer in time", async () => {
  for (const planted of [() => new Response("", { status: 400 }), () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }]) {
    const { chain, ops } = await landedForgotten();
    const waits: number[] = [];
    const { rpcs, asks } = archivalHttp(chain, (url) => (url === NET.archival[0] ? planted() : null), waits);
    assert.equal((await moveOutHeld("op1", null, { ...deps(ops, chain), archival: rpcs })).kind, "sent");
    assert.equal(asks.get(NET.archival[0]), 1);
    assert.deepEqual(waits, []);
  }
});

// Delta review 4 (on 28018b8c), item 1: recordState read U, then waited for the archival hosts (up to about 70 s with
// archivalRpc's asks again), then decided on the old read, so a deposit that reached U during a 429 wait was marked
// Moved while U held it. U is read again once the hosts answered.
test("R4-STALE a late 2,000,000 reaches U while near.org's archival host makes the page wait (429, Retry-After 10): the resume never marks Moved with U holding it; with U's second read failing it stays as it is", async () => {
  const { chain, ops } = await landedForgotten();
  const waits: number[] = [];
  const asks = new Map<string, number>();
  const fetchFn = (async (url: string, init: RequestInit) => {
    const n = (asks.get(url) ?? 0) + 1;
    asks.set(url, n);
    if (url === NET.archival[0] && n === 1) return new Response("", { status: 429, headers: { "retry-after": "10" } });
    const { method, params } = JSON.parse(String(init.body));
    const h = chain.archival(url);
    return Response.json(await (method === "tx" ? h.tx(params) : h.block(params)));
  }) as typeof fetch;
  const sleep = async (ms: number) => {
    waits.push(ms);
    chain.usdc = 2_000_001n; // the late deposit lands during the wait
  };
  const rpcs = NET.archival.map((u) => M.archivalRpc(u, fetchFn, 10_000, sleep));
  assert.deepEqual(await moveOutHeld("op1", null, { ...deps(ops, chain), archival: rpcs }), { kind: "open" });
  assert.deepEqual(waits, [10_000]);
  const op = (await ops.get("ops", "op1")) as DepositOp;
  assert.notEqual(op.follow.why, "moved_out", "Moved only while U holds at most 1");
  assert.equal(op.follow.out, undefined, "the landed record is history");
  // with U's second read failing, the record stays as it is: never Moved on the first read
  const again = await landedForgotten();
  let asked = false; // U's reads fail once the archival hosts were asked
  const failing = again.chain.rpcs().map((r) => ({ ...r, query: async (p: Parameters<MoveOutRpc["query"]>[0]) => {
    if (asked && p.request_type === "call_function" && p.method_name === "ft_balance_of") throw new Error("HTTP 503");
    return r.query(p);
  } })) as unknown as readonly [MoveOutRpc, MoveOutRpc];
  const hosts = NET.archival.map((n) => {
    const h = again.chain.archival(n);
    return { ...h, tx: async (p: Parameters<MoveOutRpc["tx"]>[0]) => ((asked = true), h.tx(p)) };
  });
  const out = await moveOutHeld("op1", null, { ...deps(again.ops, again.chain), rpcs: failing, archival: hosts });
  assert.equal(out.kind, "sent", "followed as it was");
  assert.notEqual(((await again.ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
});

test("R4-NOCONN no connection (fetch rejects with a TypeError) is asked again", async () => {
  const { chain, ops } = await landedForgotten();
  const waits: number[] = [];
  const { rpcs } = archivalHttp(chain, (u, n) => {
    if (u === NET.archival[0] && n === 1) throw new TypeError("fetch failed");
    return null;
  }, waits);
  assert.equal((await moveOutHeld("op1", null, { ...deps(ops, chain), archival: rpcs })).kind, "moved");
  assert.deepEqual(waits, [1000]);
});

test("R4-DATE a Retry-After HTTP date is read as its wait", async () => {
  const { chain, ops } = await landedForgotten();
  const waits: number[] = [];
  const at = new Date(Date.now() + 6_000).toUTCString();
  const { rpcs } = archivalHttp(chain, (u, n) => (u === NET.archival[0] && n === 1 ? new Response("", { status: 503, headers: { "retry-after": at } }) : null), waits);
  assert.equal((await moveOutHeld("op1", null, { ...deps(ops, chain), archival: rpcs })).kind, "moved");
  assert.equal(waits.length, 1);
  assert.ok(waits[0]! > 4_000 && waits[0]! <= 6_000, String(waits[0]));
});

// Delta review 4, item 2: with U holding more than 1 the hosts' word is not read, and their asks (with waits) would run
// inside U's lock during a tap's scan, so they are not asked
test("R4-NOASK a landed forgotten move with a late 2,000,000 in U: the archival hosts are never asked, U's money open", async () => {
  const { chain, ops } = await landedForgotten();
  chain.usdc = 2_000_001n;
  let asked = 0;
  const archival = NET.archival.map((n) => {
    const h = chain.archival(n);
    return { ...h, tx: async (p: Parameters<MoveOutRpc["tx"]>[0]) => (asked++, h.tx(p)), block: async (p: Parameters<MoveOutRpc["block"]>[0]) => (asked++, h.block(p)) };
  });
  assert.deepEqual(await moveOutHeld("op1", null, { ...deps(ops, chain), archival }), { kind: "open" });
  assert.equal(asked, 0);
});

// Delta review 4, item 3: a record whose tx was never included (U's nonce below it at a height past its validity window)
// is expired even when a side reads it running (a tx index that is wrong): an exit, never a hold with no end
test("R4-EXPIRED a record never included, read running on both past its validity window: expired, never followed on", async () => {
  for (const sides of [[0, 1], [0], [1]]) {
    const chain = new Chain();
    chain.registered.add(TO);
    const slow = new Set<string>();
    chain.onSend = (_s, h) => void slow.add(h); // never included: U's nonce stays at 7
    const ops = await heldOp("sender_struck");
    assert.equal((await moveOutHeld("op1", TO, { ...deps(ops, chain), rpcs: timingOut(chain.rpcs(), slow) })).kind, "sent");
    chain.a.height = chain.b.height = 1000 + Number(TX_VALIDITY_BLOCKS) + 1;
    seedOpens = 0;
    const out = await moveOutHeld("op1", null, { ...deps(ops, chain), rpcs: runningOn(chain.rpcs(), slow, "INCLUDED", sides) });
    assert.equal(out.kind, "failed", `sides ${sides}`);
    assert.equal(seedOpens, 0, "a resume never signs");
    // only the tap signs again (L6), at the same nonce: the first was never included
    const n = chain.sent.length;
    assert.equal((await moveOutHeld("op1", TO, { ...deps(ops, chain), rpcs: runningOn(chain.rpcs(), slow, "INCLUDED", sides) })).kind, "sent", `sides ${sides}`);
    assert.equal(seedOpens, 1, `sides ${sides}`);
    assert.ok(chain.sent.length > n, `sides ${sides}`);
  }
});

// Delta review 6, F4: nearcore refuses a tx only once the including block's parent height is above its base block's
// height + V (chain/chain/src/store/utils.rs:74), so at a read height of exactly base + V the old bytes can still land:
// not expired, its same bytes sent again, nothing signed
test("R6-WINDOW a record never included, read at exactly its base height + TX_VALIDITY_BLOCKS: still live, never expired, nothing signed", async () => {
  const chain = new Chain();
  chain.registered.add(TO);
  const slow = new Set<string>();
  chain.onSend = (_s, h) => void slow.add(h); // never included: U's nonce stays at 7
  const ops = await heldOp("sender_struck");
  assert.equal((await moveOutHeld("op1", TO, { ...deps(ops, chain), rpcs: timingOut(chain.rpcs(), slow) })).kind, "sent");
  const had = ((await ops.get("ops", "op1")) as DepositOp).follow.out!;
  chain.a.height = chain.b.height = had.height + Number(TX_VALIDITY_BLOCKS);
  seedOpens = 0;
  const n = chain.sent.length;
  assert.equal((await moveOutHeld("op1", null, { ...deps(ops, chain), rpcs: timingOut(chain.rpcs(), slow) })).kind, "sent");
  assert.equal(seedOpens, 0, "a resume never signs");
  assert.ok(chain.sent.slice(n).every((x) => x === had.signed), "only its same bytes sent again");
  const now = ((await ops.get("ops", "op1")) as DepositOp).follow;
  assert.equal(now.out?.hash, had.hash);
  assert.equal(now.out_past, undefined);
});

// Delta review 5, item 2: one side's fabricated FINAL word (ok or failed, with an outcome) for a tx never included, the
// other UNKNOWN_TRANSACTION, held the record at Sending forever (the expired test asked that no side read the tx)
function finalOn(rpcs: readonly [MoveOutRpc, MoveOutRpc], slow: Set<string>, word: "ok" | "failed", side: number): readonly [MoveOutRpc, MoveOutRpc] {
  return rpcs.map((r, k) => ({
    ...r,
    tx: async (p: Read) => {
      if (!slow.has(p.tx_hash)) return r.tx(p as never);
      if (k !== side) return { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } };
      const status = word === "ok" ? { SuccessValue: "" } : { Failure: { ActionError: {} } };
      return { result: { final_execution_status: "FINAL", status, transaction: { hash: p.tx_hash, signer_id: p.sender_account_id }, receipts_outcome: [{ id: "r", outcome: { status } }] } };
    },
  })) as unknown as readonly [MoveOutRpc, MoveOutRpc];
}
test("R5-EXPIRED-FINAL a record never included, past its validity window, one side lying FINAL ok or failed, the other UNKNOWN_TRANSACTION: expired, and the tap signs at the same nonce", async () => {
  for (const word of ["ok", "failed"] as const)
    for (const side of [0, 1]) {
      const at = `${word} on side ${side}`;
      const chain = new Chain();
      chain.registered.add(TO);
      const slow = new Set<string>();
      chain.onSend = (_s, h) => void slow.add(h); // never included: U's nonce stays at 7
      const ops = await heldOp("sender_struck");
      assert.equal((await moveOutHeld("op1", TO, { ...deps(ops, chain), rpcs: timingOut(chain.rpcs(), slow) })).kind, "sent");
      const had = ((await ops.get("ops", "op1")) as DepositOp).follow.out!;
      chain.a.height = chain.b.height = 1000 + Number(TX_VALIDITY_BLOCKS) + 1;
      seedOpens = 0;
      assert.equal((await moveOutHeld("op1", null, { ...deps(ops, chain), rpcs: finalOn(chain.rpcs(), slow, word, side) })).kind, "failed", at);
      assert.equal(seedOpens, 0, `${at}: a resume never signs`);
      const n = chain.sent.length;
      assert.equal((await moveOutHeld("op1", TO, { ...deps(ops, chain), rpcs: finalOn(chain.rpcs(), slow, word, side) })).kind, "sent", at);
      assert.equal(seedOpens, 1, at);
      assert.ok(chain.sent.length > n, at);
      const now = ((await ops.get("ops", "op1")) as DepositOp).follow.out!;
      assert.equal(now.nonce, had.nonce, `${at}: the same nonce, so at most one of the two lands`);
      assert.notEqual(now.hash, had.hash, at);
    }
});

// Delta review 4, mutants P1h, P5 and H11 (none killed before): a NONE answer is no word even when it names the tx; an
// archival host's running answer is no word; a throttled archival block read is asked again like its tx read
test("R4-NONE a NONE answer naming the tx is no word: U's USDC open as with a timeout on both (review 2's M1)", async () => {
  const { chain, ops, slow } = await includedNotRun();
  assert.deepEqual(await moveOutHeld("op1", null, { ...deps(ops, chain), rpcs: runningOn(chain.rpcs(), slow, "NONE") }), { kind: "open" });
});

test("R4-ARCHRUN both archival hosts answer the forgotten move as running: no word, never Moved", async () => {
  const { chain, ops } = await landedForgotten();
  const archival = NET.archival.map((n) => {
    const h = chain.archival(n);
    return { ...h, tx: async (p: Read) => ({ result: { final_execution_status: "EXECUTED_OPTIMISTIC", status: { SuccessValue: "" }, transaction: { hash: p.tx_hash, signer_id: p.sender_account_id }, receipts_outcome: [] } }) };
  });
  const out = await moveOutHeld("op1", null, { ...deps(ops, chain), archival: archival as unknown as MoveOutRpc[] });
  assert.notEqual(out.kind, "moved");
  assert.notEqual(((await ops.get("ops", "op1")) as DepositOp).follow.why, "moved_out");
});

test("R4-BLOCK an archival host that throttles its block read once (HTTP 429) is asked again: the same word as with no throttle", async () => {
  const run = async (throttle: boolean) => {
    const { chain, ops } = await landedForgotten();
    chain.archTxs = new Map(); // UNKNOWN_TRANSACTION on both hosts, each serving the record's block
    const waits: number[] = [];
    const { rpcs } = archivalHttp(chain, () => null, waits);
    const planted = throttle ? archivalHttp(chain, (url, n) => (url === NET.archival[0] && n === 2 ? new Response("", { status: 429 }) : null), waits).rpcs : rpcs;
    const out = await moveOutHeld("op1", null, { ...deps(ops, chain), archival: planted });
    return { out, waits, op: (await ops.get("ops", "op1")) as DepositOp };
  };
  const plain = await run(false);
  const slowed = await run(true);
  assert.deepEqual(slowed.waits, [1000], "the block read, asked again after 1 s");
  assert.deepEqual(slowed.out, plain.out);
  assert.deepEqual(plain.out, { kind: "empty" }, "both hosts' UNKNOWN_TRANSACTION, serving its block: replaced, U empty");
});
