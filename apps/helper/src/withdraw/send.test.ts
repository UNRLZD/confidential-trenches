// send.ts, POST /v1/withdraw's checks 7-10, the claimed send, the outcome rounds and the settle. The request is the
// real proof of fixtures/withdraw-request.json (checks 1-4 pass on it); the chain is two fake providers answering
// `block` and call_function as nearcore does; the store is a real directory; the relayer is a fake that runs the
// guard, takes n from the counter, calls `before` and records what it would broadcast. Each test names its rule.
//   node --test apps/helper/src/withdraw/send.test.ts
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VAULT_CONSTANTS, vaultWithdrawYocto } from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import { encodeAction, encodeTransaction, RpcError, type Relayer, type RelayerAction, type Rpc, type TxOutcome, type TxRef } from "../bind/send.ts";
import { USDC_CODE_HASH, type HoldAt, type TokenStatus } from "../token-status/status.ts";
import { checkWithdraw, type CheckedWithdraw, type WithdrawConfig } from "./checks.ts";
import { TESTNET_TOKEN } from "./fee.ts";
import { createWithdrawSendStore, nullifierKey, TREE_CAPACITY, type LeavesIndex, type SpendsIndex } from "./index.ts";
import {
  A_STORE_YOCTO,
  FEE_ACCOUNT_NOT_READY,
  FUND_MARGIN_MS,
  INTENTS,
  MAINNET_VAULT,
  SEND_MARGIN_MS,
  SETTLE_FLOOR_YOCTO,
  SETTLE_REFUND_ATTACH,
  WITHDRAW_GAS,
  accountAt,
  carryWithdraw,
  check5,
  checkFunded,
  checks7to9,
  feeAccountReady,
  idKeyOf,
  withdrawFloor,
  newestFinalMs,
  outcomeOf,
  outcomeRound,
  recipientOfSigned,
  readChecks,
  withdrawSenderFromEnv,
  type ChainReads,
  type WithdrawSendDeps,
} from "./send.ts";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/withdraw-request.json"), "utf8")) as {
  vault: string;
  scope: string;
  fee_recipient: string;
  request: Record<string, unknown> & { withdrawal: Record<string, unknown>; public_signals: string[] };
};
// the fixture leaves the token out (a 64-hex id reads as a key to the secret scan): it is the kit's mainnet USDC
fixture.request.token = VAULT_CONSTANTS.TOKEN;
const CFG: WithdrawConfig = { vault: fixture.vault, token: VAULT_CONSTANTS.TOKEN, scope: BigInt(fixture.scope), feeRecipient: fixture.fee_recipient };
const W = fixture.request.withdrawal as { recipient: string; register_deposit: string; relay_fee: string; deadline_ms: number };
const NF = BigInt(fixture.request.public_signals[1]!);
const MIN = BigInt(W.register_deposit); // the fixture's register_deposit is the token's minimum
const DEADLINE = BigInt(W.deadline_ms);
const req = () => structuredClone(fixture.request);

// ---- The chain: two providers ----

const hashOf = (h: number) => base58(createHash("sha256").update(`block ${h}`).digest());
type Chain = {
  height: number;
  /** The final block's time in ms (the header's timestamp_nanosec = ms x 10^6 + 999,999: the sub-ms part is dropped). */
  ms: bigint;
  /** recipient's storage_balance_of, per provider (null: not registered). */
  registered: [boolean, boolean];
  min: bigint;
  spendStatus: string;
  spendIndex: number;
  /** The nullifier the spends row at spendIndex names (NF unless a test plants another). */
  spendNf?: bigint;
  /** Check 5's views: is_known_state_root, is_known_label_root, totals (deposited, spent, returned). */
  stateKnown: unknown;
  labelKnown: unknown;
  totals: [bigint, bigint, bigint];
  /** The recipient A, per provider: absent, or its NEAR and its key list. */
  account: ("absent" | { amount: bigint; keys: { public_key: string; permission: unknown }[] })[];
  /** Check 7b: the fee account's storage_balance_of (set or null) and is_blocklisted answer, per provider. */
  feeRegistered: [boolean, boolean];
  feeListed: [unknown, unknown];
  /** The fee account's storage_balance_of answer on both providers, overriding feeRegistered (a malformed one). */
  feeBalanceAnswer?: unknown;
  /** Check 8: the recipient's is_blocklisted answer, per provider. */
  recipientListed: [unknown, unknown];
  /** Answers to storage_balance_of, overriding `registered` (a malformed one, for the shape check). */
  balanceAnswer?: unknown;
  /** view_account's or view_access_key_list's answered block, per provider, when it is not the block asked. */
  accountAt?: ({ block_height: number; block_hash: string } | undefined)[];
  listAt?: ({ block_height: number; block_hash: string } | undefined)[];
  /** The second provider's final height, when it is not `height`. */
  height1?: number;
  down?: boolean;
};
const A_OK = { amount: A_STORE_YOCTO, keys: [{ public_key: idKeyOf(W.recipient), permission: "FullAccess" }] };
const chain = (over: Partial<Chain> = {}): Chain => ({
  height: 1000,
  ms: DEADLINE - SEND_MARGIN_MS - 60_000n,
  registered: [false, false],
  min: MIN,
  spendStatus: "in_flight",
  spendIndex: 0,
  stateKnown: true,
  labelKnown: true,
  totals: [10n ** 12n, 0n, 0n],
  account: [A_OK, A_OK],
  feeRegistered: [true, true],
  feeListed: [false, false],
  recipientListed: [false, false],
  ...over,
});

function provider(c: Chain, i: 0 | 1): Rpc {
  const header = (h: number) => ({
    header: {
      height: h,
      hash: hashOf(h),
      prev_height: h - 1,
      gas_price: "100000000",
      timestamp_nanosec: (c.ms * 1_000_000n + 999_999n).toString(),
      // a JSON number past 2^53, as nearcore writes it: never read
      timestamp: 9_007_199_254_740_993_000,
    },
  });
  return async (method, params) => {
    if (c.down) throw new Error("fetch failed");
    const p = params as Record<string, unknown>;
    if (method === "block") return header(p.finality === "final" ? (i === 1 && c.height1 !== undefined ? c.height1 : c.height) : Number(p.block_id));
    if (method === "query" && (p.request_type === "view_account" || p.request_type === "view_access_key_list")) {
      const h = Number(p.block_id);
      const a = c.account[i]!;
      const at = { block_height: h, block_hash: hashOf(h) };
      // an absent account as nearcore answers it: view_account UNKNOWN_ACCOUNT, view_access_key_list an empty list
      if (a === "absent" && p.request_type === "view_account") throw new RpcError("query", { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} } });
      if (a === "absent") return { keys: [], ...(c.listAt?.[i] ?? at) };
      if (p.request_type === "view_account" && c.accountAt?.[i]) return { amount: a.amount.toString(), locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, ...c.accountAt[i] };
      if (p.request_type === "view_account") return { amount: a.amount.toString(), locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, ...at };
      return { keys: a.keys.map((k) => ({ public_key: k.public_key, access_key: { nonce: 0, permission: k.permission } })), ...at };
    }
    if (method === "query" && p.request_type === "call_function") {
      const h = Number(p.block_id);
      const args = JSON.parse(Buffer.from(String(p.args_base64), "base64").toString("utf8")) as Record<string, unknown>;
      let v: unknown;
      if (p.method_name === "storage_balance_of" && args.account_id === CFG.feeRecipient) v = c.feeBalanceAnswer !== undefined ? c.feeBalanceAnswer : c.feeRegistered[i] ? { total: MIN.toString(), available: "0" } : null;
      else if (p.method_name === "is_blocklisted" && args.account_id === CFG.feeRecipient) v = c.feeListed[i];
      else if (p.method_name === "is_blocklisted" && args.account_id === W.recipient) v = c.recipientListed[i];
      else if (p.method_name === "storage_balance_of") v = c.balanceAnswer !== undefined ? c.balanceAnswer : c.registered[i] ? { total: MIN.toString(), available: "0" } : null;
      else if (p.method_name === "storage_balance_bounds") v = { min: c.min.toString(), max: c.min.toString() };
      else if (p.method_name === "spends") v = args.from === c.spendIndex ? [{ index: c.spendIndex, nullifier_hash: (c.spendNf ?? NF).toString(), status: c.spendStatus }] : [];
      else if (p.method_name === "is_known_state_root") v = c.stateKnown;
      else if (p.method_name === "is_known_label_root") v = c.labelKnown;
      else if (p.method_name === "totals") v = { deposited: c.totals[0].toString(), spent: c.totals[1].toString(), returned: c.totals[2].toString() };
      else throw new Error(`no view ${String(p.method_name)}`);
      return { result: [...Buffer.from(JSON.stringify(v))], block_height: h, block_hash: hashOf(h), logs: [] };
    }
    throw new Error(`no method ${method}`);
  };
}

// ---- The relayer, the index, the watch ----

type Sent = { action: RelayerAction; tx: TxRef };
const counters = new Map<string, bigint>();
const nonceStore = { nonceNext: (k: string) => counters.get(k) ?? null };

function fakeRelayer(name: string, outcomes: Map<string, TxOutcome>): Relayer & { sent: Sent[]; resolved: string[]; resends: boolean[]; near: bigint } {
  const key = `${name}/ed25519:test`;
  const r = {
    account: name,
    key,
    sent: [] as Sent[],
    resolved: [] as string[],
    resends: [] as boolean[],
    near: 10n ** 24n,
    balance: async () => r.near,
    async send<C extends string>(action: RelayerAction, guard: () => Promise<C | null>, before: (tx: TxRef) => void) {
      const code = await guard();
      if (code !== null) return { kind: "guarded" as const, code };
      const n = counters.get(key) ?? 1n;
      counters.set(key, n + 1n);
      // a call's bytes as the relayer signs them (bind/send.ts encodeTransaction), a zero signature after them
      const bytes = action.kind === "call" ? Buffer.concat([encodeTransaction({ signer: name, publicKey: new Uint8Array(32), nonce: n, receiver: action.receiver, blockHash: new Uint8Array(32), action: encodeAction(action) }), Buffer.alloc(65)]) : Buffer.from(`${key} ${n}`);
      const tx: TxRef = { tx_hash: base58(createHash("sha256").update(`${key} ${n}`).digest()), nonce: n.toString(), height: "999", block_hash: hashOf(999), signed_tx: bytes.toString("base64") };
      before(tx); // a throw here drops the bytes: nothing is recorded as sent
      r.sent.push({ action, tx });
      return { kind: "unknown" as const, tx_hash: tx.tx_hash, why: "sent" };
    },
    async resolve(tx: TxRef, opts: { resend: boolean; fromBlocks?: boolean }) {
      assert.equal(opts.fromBlocks, true, "a vault call's outcome is read from blocks only");
      r.resolved.push(tx.tx_hash);
      r.resends.push(opts.resend);
      return outcomes.get(tx.tx_hash) ?? { kind: "unknown" as const, tx_hash: tx.tx_hash, why: "not yet" };
    },
  };
  return r;
}

function fakeIndex(spent = false): SpendsIndex {
  return { finalHeight: async () => 1000n, reach: async () => true, holds: () => spent, at: () => 1000n, indexOf: () => 0 };
}

function fakeLeaves(leaves: bigint[] = [], count?: bigint, caught = true): LeavesIndex {
  return { reach: async () => caught, has: (x) => leaves.includes(x), count: () => count ?? BigInt(leaves.length) };
}

const open: TokenStatus = { token: VAULT_CONSTANTS.TOKEN, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: 1000, last_event: null };
const halted: TokenStatus = { ...open, halted: true };

function setup(c = chain(), opts: { status?: () => TokenStatus; release?: number; feeMin?: bigint } = {}) {
  const outcomes = new Map<string, TxOutcome>();
  const relayer = fakeRelayer("relay.test.near", outcomes);
  const store = createWithdrawSendStore(mkdtempSync(join(tmpdir(), "wsend-")), { release: opts.release ?? 1, keys: nonceStore });
  const deps: WithdrawSendDeps = {
    cfg: CFG,
    rpcs: [provider(c, 0), provider(c, 1)],
    reads: { feeMin: async () => opts.feeMin ?? BigInt(W.relay_fee) },
    index: fakeIndex(),
    leaves: fakeLeaves(),
    store,
    relayers: [relayer],
    tokenStatus: async () => (opts.status ?? (() => open))(),
    now: () => Number(c.ms),
  };
  return { c, deps, relayer, store, outcomes };
}

const code = (a: Awaited<ReturnType<typeof carryWithdraw>>) => ("error" in a.body ? a.body.error.code : "ok");

/** What readChecks returns, for the checks on what was read. */
const reads = (over: Partial<ChainReads> = {}): ChainReads => ({ registered: true, registerMin: MIN, finalMs: 0n, stateKnown: true, labelKnown: true, totals: { deposited: 10n ** 12n, spent: 0n, returned: 0n }, feeAccount: { registered: true, blocklisted: false }, recipientListed: false, ...over });

// ---- The send ----

test("a request that passes checks 1-10 is sent once: one withdraw call on the vault, 300 Tgas, the storage the vault asks, the request's fields as received, the record claimed before the bytes go", async () => {
  const { deps, relayer, store } = setup();
  const a = await carryWithdraw(req(), deps);
  assert.equal(a.status, 200);
  assert.deepEqual(Object.keys(a.body), ["tx_hash", "state"]);
  assert.equal((a.body as { state: string }).state, "submitted");
  assert.equal(relayer.sent.length, 1);
  const { action, tx } = relayer.sent[0]!;
  assert.equal(action.kind, "call");
  if (action.kind !== "call") return;
  assert.equal(action.receiver, CFG.vault);
  assert.equal(action.method, "withdraw");
  assert.equal(action.gas, WITHDRAW_GAS);
  assert.equal(action.deposit, vaultWithdrawYocto(MIN, BigInt(W.relay_fee), true));
  const args = JSON.parse(action.args) as Record<string, unknown>;
  assert.deepEqual(args, { withdrawal: fixture.request.withdrawal, proof: fixture.request.proof, public_signals: fixture.request.public_signals });
  const rec = store.get(NF);
  assert.ok(rec !== null && rec !== "unreadable");
  assert.equal(rec.outcome, "open");
  assert.equal(rec.tx_hash, tx.tx_hash);
  assert.equal(rec.key, relayer.key);
  assert.equal(rec.deadline_ms, W.deadline_ms);
  assert.equal((a.body as { tx_hash: string }).tx_hash, tx.tx_hash);
});

test("check 10's H for a withdrawal: every hold asks at the lower of the two finals (markets.md check 10), before the send and at the relayer's turn", async () => {
  const { deps } = setup();
  const holds: HoldAt[] = [];
  const open = deps.tokenStatus;
  deps.tokenStatus = (at) => (holds.push(at), open(at));
  assert.equal((await carryWithdraw(req(), deps)).status, 200);
  assert.ok(holds.length >= 2, String(holds.length));
  assert.deepEqual([...new Set(holds)], ["lower"]);
});

test("check 9 after check 10 at the relayer's turn: a hold that waits while the chain passes the deadline's margin answers deadline_too_close, nothing sent or claimed", async () => {
  const { c, deps, relayer, store } = setup();
  const open = deps.tokenStatus;
  let asks = 0;
  deps.tokenStatus = async (at) => {
    if (++asks === 2) c.ms += 60_001n; // the relayer's turn: the hold waited (a lagging provider, a 429) past the margin
    return open(at);
  };
  const a = await carryWithdraw(req(), deps);
  assert.equal(asks, 2);
  assert.deepEqual([a.status, code(a)], [400, "deadline_too_close"]);
  assert.equal(relayer.sent.length, 0);
  assert.equal(store.get(NF), null);
});

test("check 6 after a send: the same note again answers in_flight and nothing more is signed; two at once send once", async () => {
  const { deps, relayer } = setup();
  const [x, y] = await Promise.all([carryWithdraw(req(), deps), carryWithdraw(req(), deps)]);
  assert.deepEqual([code(x), code(y)].sort(), ["in_flight", "ok"]);
  assert.equal(relayer.sent.length, 1);
  assert.equal(code(await carryWithdraw(req(), deps)), "in_flight");
  assert.equal(relayer.sent.length, 1);
});

test("check 5: a spent nullifier answers spent and sends nothing", async () => {
  const { deps, relayer } = setup();
  deps.index = fakeIndex(true);
  assert.equal(code(await carryWithdraw(req(), deps)), "spent");
  assert.equal(relayer.sent.length, 0);
});

// ---- Check 5: the roots, totals and leaves (rows 5, 6, 9 and 12) ----

test("check 5 at the chain: a state root or a label root the vault never had is unknown_root, nothing signed", async () => {
  for (const over of [{ stateKnown: false }, { labelKnown: false }]) {
    const x = setup(chain(over));
    const a = await carryWithdraw(req(), x.deps);
    assert.deepEqual([a.status, code(a)], [400, "unknown_root"], JSON.stringify(over));
    assert.equal(x.relayer.sent.length, 0);
    assert.equal(x.store.get(NF), null);
  }
});

test("check 5 on what was read: stateRoot 0 is unknown_root; withdrawnValue above deposited - spent + returned is bad_proof (row 9), at it passes", () => {
  const w = { stateRoot: 5n, ASPRoot: 6n, withdrawnValue: 100n } as CheckedWithdraw;
  const t = (deposited: bigint, spent: bigint, returned: bigint) => reads({ totals: { deposited, spent, returned } });
  assert.equal(check5(w, t(100n, 0n, 0n)), null);
  assert.equal(check5({ ...w, stateRoot: 0n }, t(100n, 0n, 0n)), "unknown_root");
  assert.equal(check5(w, reads({ stateKnown: false })), "unknown_root");
  assert.equal(check5(w, reads({ labelKnown: false })), "unknown_root");
  assert.equal(check5(w, t(150n, 60n, 10n)), null);
  assert.equal(check5(w, t(150n, 60n, 9n)), "bad_proof");
  assert.equal(check5(w, t(99n, 0n, 0n)), "bad_proof");
});

test("check 5, row 9 at the chain: a pool that holds less than withdrawnValue is bad_proof; totals or root views that do not read are 503 upstream", async () => {
  const withdrawn = BigInt(fixture.request.public_signals[2]!); // snarkjs order: newCommitmentHash, existingNullifierHash, withdrawnValue, stateRoot, ...
  const thin = setup(chain({ totals: [withdrawn - 1n, 0n, 0n] }));
  assert.equal(code(await carryWithdraw(req(), thin.deps)), "bad_proof");
  const exact = setup(chain({ totals: [withdrawn, 0n, 0n] }));
  assert.equal(code(await carryWithdraw(req(), exact.deps)), "ok");
  for (const over of [{ stateKnown: "true" }, { labelKnown: 1 }, { stateKnown: null }]) {
    const x = setup(chain(over)); // a root view that answers anything but a boolean
    const b = await carryWithdraw(req(), x.deps);
    assert.deepEqual([b.status, code(b), x.relayer.sent.length], [503, "upstream", 0], JSON.stringify(over));
  }
  const off = setup(chain({ totals: [1n << 128n, 0n, 0n] })); // not a u128
  const a = await carryWithdraw(req(), off.deps);
  assert.deepEqual([a.status, code(a)], [503, "upstream"]);
  assert.equal(thin.relayer.sent.length + off.relayer.sent.length, 0);
});

test("check 5, row 12: newCommitmentHash already a leaf, or a full tree, is bad_proof; a leaves index that cannot catch up is 503 index_behind; nothing signed", async () => {
  const leaf = BigInt(fixture.request.public_signals[0]!); // newCommitmentHash
  const known = setup();
  known.deps.leaves = fakeLeaves([leaf]);
  assert.equal(code(await carryWithdraw(req(), known.deps)), "bad_proof");
  const full = setup();
  full.deps.leaves = fakeLeaves([], TREE_CAPACITY);
  assert.equal(code(await carryWithdraw(req(), full.deps)), "bad_proof");
  const room = setup();
  room.deps.leaves = fakeLeaves([], TREE_CAPACITY - 1n);
  assert.equal(code(await carryWithdraw(req(), room.deps)), "ok");
  const behind = setup();
  behind.deps.leaves = fakeLeaves([], 0n, false);
  const a = await carryWithdraw(req(), behind.deps);
  assert.deepEqual([a.status, code(a)], [503, "index_behind"]);
  assert.equal(known.relayer.sent.length + full.relayer.sent.length + behind.relayer.sent.length, 0);
});

// ---- fund_recipient (until H3.7 funds A) ----

test("fund_recipient true: carried only for an implicit A that exists with key list exactly [its own id key, full access] and at least A_store; else recipient_refused, nothing signed", async () => {
  const idKey = idKeyOf(W.recipient);
  const cases: [string, Chain["account"][number], string][] = [
    ["absent", "absent", "recipient_refused"],
    ["below A_store", { amount: A_STORE_YOCTO - 1n, keys: [{ public_key: idKey, permission: "FullAccess" }] }, "recipient_refused"],
    ["a second key", { amount: A_STORE_YOCTO, keys: [{ public_key: idKey, permission: "FullAccess" }, { public_key: idKeyOf("11".repeat(32)), permission: "FullAccess" }] }, "recipient_refused"],
    ["another key", { amount: A_STORE_YOCTO, keys: [{ public_key: idKeyOf("11".repeat(32)), permission: "FullAccess" }] }, "recipient_refused"],
    ["a function-call key", { amount: A_STORE_YOCTO, keys: [{ public_key: idKey, permission: { FunctionCall: { allowance: null, receiver_id: "x.near", method_names: [] } } }] }, "recipient_refused"],
    ["no key", { amount: A_STORE_YOCTO, keys: [] }, "recipient_refused"],
    ["A_store exactly", { amount: A_STORE_YOCTO, keys: [{ public_key: idKey, permission: "FullAccess" }] }, "ok"],
  ];
  for (const [name, a, want] of cases) {
    const x = setup(chain({ account: [a, a] }));
    const got = await carryWithdraw(req(), x.deps);
    assert.equal(code(got), want, name);
    assert.equal(x.relayer.sent.length, want === "ok" ? 1 : 0, name);
  }
  // the two providers disagree on A: 503 upstream
  const split = setup(chain({ account: [A_OK, "absent"] }));
  assert.deepEqual([(await carryWithdraw(req(), split.deps)).status, split.relayer.sent.length], [503, 0]);
  // fund_recipient false (a plain send) reads no account: an absent recipient is not refused for it
  const plain = setup(chain({ account: ["absent", "absent"] }));
  assert.equal(code(await carryWithdraw({ ...req(), fund_recipient: false }, plain.deps)), "ok");
  // a named recipient is never an A
  assert.equal(checkFunded({ fund_recipient: true, recipient: "a.near" } as CheckedWithdraw, reads({ recipient: A_OK && { kind: "account", ...A_OK } })), "recipient_refused");
  assert.equal(checkFunded({ fund_recipient: undefined, recipient: "a.near" } as CheckedWithdraw, reads()), null);
});

test("an absent A reads as nearcore answers it (view_account UNKNOWN_ACCOUNT, an empty key list) and is recipient_refused; any other mix, or an answer at another block, is 503 with nothing signed", async () => {
  const b = { height: 1000n, hash: hashOf(1000), gasPrice: 100_000_000n, ms: 0n } as unknown as Parameters<typeof accountAt>[1];
  const absent = chain({ account: ["absent", "absent"] });
  assert.deepEqual(await accountAt([provider(absent, 0), provider(absent, 1)], b, W.recipient), { kind: "absent" });
  const unknown = new RpcError("query", { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} } });
  const at = { block_height: 1000, block_hash: hashOf(1000) };
  const mix = (acc: "unknown" | "ok", list: "unknown" | "empty" | "one"): Rpc => async (_m, params) => {
    const p = params as { request_type: string };
    if (p.request_type === "view_account") {
      if (acc === "unknown") throw unknown;
      return { amount: A_STORE_YOCTO.toString(), locked: "0", storage_usage: 182, ...at };
    }
    if (list === "unknown") throw unknown;
    return { keys: list === "empty" ? [] : [{ public_key: idKeyOf(W.recipient), access_key: { nonce: 0, permission: "FullAccess" } }], ...at };
  };
  for (const [acc, list] of [["unknown", "unknown"], ["unknown", "one"], ["ok", "unknown"]] as const) {
    await assert.rejects(accountAt([mix(acc, list), mix(acc, list)], b, W.recipient), /neither absent nor an account/, `${acc} / ${list}`);
  }
  const route = setup(absent);
  const a = await carryWithdraw(req(), route.deps);
  assert.deepEqual([a.status, code(a), route.relayer.sent.length], [400, "recipient_refused", 0]);
  // one provider answers view_account, or the key list, at another block (another height, or the height on another hash)
  const other = { block_height: 999, block_hash: hashOf(999) };
  const fork = { block_height: 1000, block_hash: hashOf(1001) }; // the height asked, another block's hash
  for (const over of [{ accountAt: [undefined, other] }, { accountAt: [undefined, fork] }, { listAt: [undefined, other], account: ["absent", "absent"] as Chain["account"] }]) {
    const x = setup(chain(over));
    const r = await carryWithdraw(req(), x.deps);
    assert.deepEqual([r.status, code(r), x.relayer.sent.length], [503, "upstream", 0], JSON.stringify(over));
    assert.equal(x.store.get(NF), null);
  }
});

test("check 5, row 12: the spends index's final height read again for the leaves fails: 503 index_behind, nothing signed", async () => {
  const x = setup();
  let reads = 0;
  x.deps.index = { ...fakeIndex(), finalHeight: async () => {
    if (reads++ === 0) return 1000n;
    throw new Error("the two finals stand 11 blocks apart");
  } };
  const a = await carryWithdraw(req(), x.deps);
  assert.deepEqual([a.status, code(a), x.relayer.sent.length], [503, "index_behind", 0]);
  assert.equal(reads, 2, "checkNullifier's read passed, leafCheck's threw");
  assert.equal(x.store.get(NF), null);
});

// ---- relayer_low ----

test("relayer_low: under one withdraw's gas bought up front, its attachment and a settle's worst, 503 relayer_low in the queue with nothing signed; at the floor it sends; a settle under its floor is not signed", async () => {
  const deposit = vaultWithdrawYocto(MIN, BigInt(W.relay_fee), true);
  assert.equal(withdrawFloor(deposit), WITHDRAW_GAS * 1_000_000_000n + deposit + SETTLE_FLOOR_YOCTO);
  const low = setup();
  low.relayer.near = withdrawFloor(deposit) - 1n;
  const a = await carryWithdraw(req(), low.deps);
  assert.deepEqual([a.status, code(a)], [503, "relayer_low"]);
  assert.equal(low.relayer.sent.length, 0);
  assert.equal(low.store.get(NF), null);
  const at = setup();
  at.relayer.near = withdrawFloor(deposit);
  assert.equal(code(await carryWithdraw(req(), at.deps)), "ok");
  // the settle's own floor
  const tx = at.relayer.sent[0]!.tx.tx_hash;
  at.outcomes.set(tx, final(tx, true, DEADLINE - 1n));
  at.c.spendStatus = "paid";
  at.relayer.near = SETTLE_FLOOR_YOCTO - 1n;
  await outcomeRound(at.deps);
  assert.equal(at.relayer.sent.length, 1, "no settle under its floor");
  at.relayer.near = SETTLE_FLOOR_YOCTO;
  await outcomeRound(at.deps);
  assert.equal(at.relayer.sent.length, 2);
});

// ---- card helper-id-intents: the arming account A a valid proof landed to ----

test("a withdrawal read succeeded hands its signed recipient to onLanded (the gate's second path on POST /v1/intents); a failed one does not", async () => {
  const ok = setup();
  const heard: string[] = [];
  ok.deps.onLanded = (to) => void heard.push(to);
  assert.equal(code(await carryWithdraw(req(), ok.deps)), "ok");
  const tx = ok.relayer.sent[0]!.tx;
  assert.equal(recipientOfSigned(tx.signed_tx), W.recipient);
  await outcomeRound(ok.deps);
  assert.deepEqual(heard, [], "not before its outcome is read");
  ok.outcomes.set(tx.tx_hash, final(tx.tx_hash, true, DEADLINE - 1n));
  await outcomeRound(ok.deps);
  assert.deepEqual(heard, [W.recipient]);
  const bad = setup();
  const none: string[] = [];
  bad.deps.onLanded = (to) => void none.push(to);
  assert.equal(code(await carryWithdraw(req(), bad.deps)), "ok");
  const t2 = bad.relayer.sent[0]!.tx.tx_hash;
  bad.outcomes.set(t2, final(t2, false, DEADLINE - 1n));
  await outcomeRound(bad.deps);
  assert.deepEqual(none, []);
  assert.equal(recipientOfSigned(Buffer.from("not a transaction").toString("base64")), null);
});

// ---- Check 7b: the fee account (card vault-review-fixes-1, review F-1) ----

// The vault pays the relay fee in the recipient's own payout receipt (review A-01): a fee account the token refuses fails
// the whole payout, so the relayer never signs one while its fee account is unregistered or blocklisted.
test("check 7b: a fee account unregistered or blocklisted (on either provider) answers 503 relayer_low with its own log line, nothing signed; a registered one not blocklisted sends", async () => {
  const cases: [Partial<Chain>, string][] = [
    [{ feeRegistered: [false, false] }, "registered false, blocklisted false"],
    [{ feeListed: [true, true] }, "registered true, blocklisted true"],
    [{ feeRegistered: [false, false], feeListed: [true, true] }, "registered false, blocklisted true"],
  ];
  for (const [over, why] of cases) {
    const s = setup(chain(over));
    const lines: string[] = [];
    s.deps.log = (l) => lines.push(l);
    const a = await carryWithdraw(req(), s.deps);
    assert.deepEqual([a.status, code(a)], [503, "relayer_low"], why);
    assert.equal(s.relayer.sent.length, 0, why);
    assert.equal(s.store.get(NF), null, why);
    assert.deepEqual(lines, [`withdraw 503 relayer_low: ${FEE_ACCOUNT_NOT_READY} (${CFG.feeRecipient} on ${CFG.token}: ${why})`]);
  }
  // the providers disagree, or one answers neither shape: the read fails, 503 with nothing signed
  for (const over of [{ feeRegistered: [true, false] }, { feeListed: [false, true] }, { feeListed: ["false", "false"] }, { feeListed: [null, null] }] as Partial<Chain>[]) {
    const s = setup(chain(over));
    const a = await carryWithdraw(req(), s.deps);
    assert.equal(a.status, 503, JSON.stringify(over));
    assert.equal(s.relayer.sent.length, 0, JSON.stringify(over));
  }
  // check 10 first: a halted token answers token_halted whatever the fee account reads (relayer_withdraw.rs step 2)
  const both = setup(chain({ feeRegistered: [false, false] }), { status: () => halted });
  assert.deepEqual(code(await carryWithdraw(req(), both.deps)), "token_halted");
  assert.equal(both.relayer.sent.length, 0);
  const ok = setup();
  const lines: string[] = [];
  ok.deps.log = (l) => lines.push(l);
  assert.equal(code(await carryWithdraw(req(), ok.deps)), "ok");
  assert.equal(ok.relayer.sent.length, 1);
  assert.deepEqual(lines, []);
});

test("check 7b again in the queue: a fee account blocklisted, or unregistered, after the reads and before signing holds at a fresh block, 503 relayer_low, nothing signed", async () => {
  for (const [flip, why] of [
    [(c: Chain) => (c.feeListed = [true, true]), "registered true, blocklisted true"],
    [(c: Chain) => (c.feeRegistered = [false, false]), "registered false, blocklisted false"],
    [(c: Chain) => (c.down = true), "not read (fee read refused: rpc 0: block did not answer (fetch failed))"],
  ] as [(c: Chain) => void, string][]) {
    let asked = 0;
    const c = chain();
    // check 10 is asked once after the reads and once in the queue, right before check 7b's second read
    const s = setup(c, { status: () => (++asked === 2 && flip(c), open) });
    const lines: string[] = [];
    s.deps.log = (l) => lines.push(l);
    const a = await carryWithdraw(req(), s.deps);
    assert.equal(asked, 2, why);
    assert.deepEqual([a.status, code(a)], [503, "relayer_low"], why);
    assert.equal(s.relayer.sent.length, 0, why);
    assert.equal(s.store.get(NF), null, why);
    assert.deepEqual(lines, [`withdraw 503 relayer_low: ${FEE_ACCOUNT_NOT_READY} (${CFG.feeRecipient} on ${CFG.token}: ${why})`], why);
  }
});

test("readChecks reads check 7b's two views of fee_recipient (not the recipient's) at check 7's block", async () => {
  const c = chain({ registered: [false, false], feeRegistered: [true, true], feeListed: [true, true] });
  const s = setup(c);
  const v = await checkWithdraw(req(), CFG, s.deps.reads);
  assert.ok(v.ok);
  const r = await readChecks(s.deps.rpcs, CFG.vault, CFG.token, v.withdraw, s.deps.now);
  assert.equal(r.registered, false);
  assert.deepEqual(r.feeAccount, { registered: true, blocklisted: true });
  assert.equal(feeAccountReady(r.feeAccount), false);
  assert.equal(feeAccountReady({ registered: true, blocklisted: false }), true);
});

// ---- The review of the fee check (card vault-review-fixes-1, 08:18Z) ----

// Finding 1: a payout is one receipt (A-01), so a recipient the token blocklists fails it whole into refund_pending, and
// the settle pays the refund note's storage: check 8 reads is_blocklisted(recipient) at check 7's block, and again in
// the queue. Exactly true is bad_recipient; anything but a boolean, or two providers apart, is 503 with nothing signed.
test("check 8 reads is_blocklisted(recipient): true on both is 400 bad_recipient, nothing signed, fund_recipient true or false; apart or not a boolean is 503; false sends", async () => {
  for (const body of [req(), { ...req(), fund_recipient: false }]) {
    const s = setup(chain({ recipientListed: [true, true] }));
    const a = await carryWithdraw(body, s.deps);
    assert.deepEqual([a.status, code(a)], [400, "bad_recipient"], `fund_recipient ${body.fund_recipient}`);
    assert.equal(s.relayer.sent.length, 0);
    assert.equal(s.store.get(NF), null);
  }
  for (const recipientListed of [[true, false], ["true", "true"], [null, null]] as [unknown, unknown][]) {
    const s = setup(chain({ recipientListed }));
    const a = await carryWithdraw(req(), s.deps);
    assert.equal(a.status, 503, JSON.stringify(recipientListed));
    assert.equal(s.relayer.sent.length, 0, JSON.stringify(recipientListed));
  }
  assert.equal(code(await carryWithdraw(req(), setup().deps)), "ok");
});

test("check 8 again in the queue: a recipient blocklisted after the reads and before signing is 400 bad_recipient, nothing signed", async () => {
  let asked = 0;
  const c = chain();
  const s = setup(c, { status: () => (++asked === 2 && (c.recipientListed = [true, true]), open) });
  const a = await carryWithdraw(req(), s.deps);
  assert.equal(asked, 2);
  assert.deepEqual([a.status, code(a)], [400, "bad_recipient"]);
  assert.equal(s.relayer.sent.length, 0);
  assert.equal(s.store.get(NF), null);
});

// Findings 4 and 5: the fee balance's shape is checked (a {} is no balance), a failed 7b read at check 7 answers 503
// relayer_low with its own log line, and the hold at check 7 stands on its own: the queue is never reached.
test("check 7b at check 7: a malformed fee balance ({}) or a blocklist answer that is no boolean is 503 relayer_low with a \"not read\" log line, nothing signed", async () => {
  for (const over of [{ feeBalanceAnswer: {} }, { feeBalanceAnswer: { total: "1.5" } }, { feeListed: [null, null] }, { feeRegistered: [true, false] }] as Partial<Chain>[]) {
    const s = setup(chain(over));
    const lines: string[] = [];
    s.deps.log = (l) => lines.push(l);
    const a = await carryWithdraw(req(), s.deps);
    assert.deepEqual([a.status, code(a)], [503, "relayer_low"], JSON.stringify(over));
    assert.equal(s.relayer.sent.length, 0, JSON.stringify(over));
    assert.equal(lines.length, 1, JSON.stringify(over));
    assert.ok(lines[0]!.startsWith(`withdraw 503 relayer_low: ${FEE_ACCOUNT_NOT_READY} (${CFG.feeRecipient} on ${CFG.token}: not read (`), lines[0]);
  }
});

test("check 7b's hold at check 7 stands on its own: a fee account unregistered at the reads, registered before the queue, is 503 relayer_low and the queue's guard never runs", async () => {
  let asked = 0;
  const c = chain({ feeRegistered: [false, false] });
  // check 10 is asked first at the entry; the account is registered right after, so only the entry's own hold can hold it
  const s = setup(c, { status: () => (++asked === 1 && (c.feeRegistered = [true, true]), open) });
  const a = await carryWithdraw(req(), s.deps);
  assert.deepEqual([a.status, code(a)], [503, "relayer_low"]);
  assert.equal(asked, 1, "the queue's guard (check 10 again) never ran");
  assert.equal(s.relayer.sent.length, 0);
});

// ---- Check 7 ----

test("check 7: an unregistered recipient takes exactly the token's minimum; a registered one 0, else register_deposit_wrong", async () => {
  // through the route: the fixture's register_deposit is the minimum
  const reg = setup(chain({ registered: [true, true] }));
  const a = await carryWithdraw(req(), reg.deps);
  assert.equal(a.status, 400);
  assert.equal(code(a), "register_deposit_wrong");
  assert.equal(reg.relayer.sent.length, 0);
  const moved = setup(chain({ min: MIN + 1n }));
  assert.equal(code(await carryWithdraw(req(), moved.deps)), "register_deposit_wrong");
  // on what was read
  const w = { register_deposit: 0n, recipient: "a.near", fee_recipient: CFG.feeRecipient, deadline_ms: Number(DEADLINE) } as CheckedWithdraw;
  const r = reads();
  assert.equal(checks7to9(w, CFG.vault, r), null);
  assert.equal(checks7to9({ ...w, register_deposit: 1n }, CFG.vault, r), "register_deposit_wrong");
  assert.equal(checks7to9(w, CFG.vault, { ...r, registered: false }), "register_deposit_wrong");
  assert.equal(checks7to9({ ...w, register_deposit: MIN }, CFG.vault, { ...r, registered: false }), null);
});

test("check 7's exception: a stored withdrawal's minimum stands for a recipient registered since; a fresh request's does not", () => {
  const w = { register_deposit: MIN, recipient: "a.near", fee_recipient: CFG.feeRecipient, deadline_ms: Number(DEADLINE) } as CheckedWithdraw;
  const r = reads();
  assert.equal(checks7to9(w, CFG.vault, r), "register_deposit_wrong");
  assert.equal(checks7to9(w, CFG.vault, r, { stored: true }), null);
  assert.equal(checks7to9({ ...w, register_deposit: MIN - 1n }, CFG.vault, r, { stored: true }), "register_deposit_wrong");
});

test("check 7's reads: the two providers disagree on the registration, or one is down: 503 upstream, nothing sent", async () => {
  const split = setup(chain({ registered: [true, false] }));
  const a = await carryWithdraw(req(), split.deps);
  assert.equal(a.status, 503);
  assert.equal(code(a), "upstream");
  assert.equal(split.relayer.sent.length, 0);
});

// ---- Check 8 ----

test("check 8: recipient or fee_recipient the vault or intents.near is bad_recipient", () => {
  const w = { register_deposit: 0n, recipient: "a.near", fee_recipient: CFG.feeRecipient, deadline_ms: Number(DEADLINE) } as CheckedWithdraw;
  const r = reads();
  assert.equal(checks7to9({ ...w, recipient: CFG.vault }, CFG.vault, r), "bad_recipient");
  assert.equal(checks7to9({ ...w, recipient: INTENTS }, CFG.vault, r), "bad_recipient");
  assert.equal(checks7to9({ ...w, fee_recipient: CFG.vault }, CFG.vault, r), "bad_recipient");
  assert.equal(checks7to9({ ...w, fee_recipient: INTENTS }, CFG.vault, r), "bad_recipient");
  // check 7 comes first
  assert.equal(checks7to9({ ...w, recipient: INTENTS, register_deposit: 5n }, CFG.vault, r), "register_deposit_wrong");
});

// ---- Check 9 ----

test("check 9 pins the time: header.timestamp_nanosec (a decimal string) / 10^6 of the newest final, never header.timestamp, never the helper's clock", async () => {
  // deadline exactly at the newest final's ms + 30 s passes; 1 ms less is deadline_too_close
  const at = setup(chain({ ms: DEADLINE - SEND_MARGIN_MS }));
  at.deps.now = () => Number(DEADLINE - SEND_MARGIN_MS);
  assert.equal(code(await carryWithdraw(req(), at.deps)), "ok");
  const late = setup(chain({ ms: DEADLINE - SEND_MARGIN_MS + 1n }));
  const a = await carryWithdraw(req(), late.deps);
  assert.equal(a.status, 400);
  assert.equal(code(a), "deadline_too_close");
  assert.equal(late.relayer.sent.length, 0);
  // the higher of the two finals' times
  const c0 = chain({ ms: 5_000n });
  const c1 = chain({ ms: 7_000n });
  assert.equal(await newestFinalMs([provider(c0, 0), provider(c1, 1)]), 7_000n);
  // a final with no timestamp_nanosec, or one written as a number, is refused (never read from timestamp)
  const noNs: Rpc = async () => ({ header: { height: 1000, timestamp: 1 } });
  await assert.rejects(newestFinalMs([noNs, provider(c0, 1)]), /timestamp_nanosec/);
  const numNs: Rpc = async () => ({ header: { height: 1000, timestamp_nanosec: 1_000_000 } });
  await assert.rejects(newestFinalMs([numNs, provider(c0, 1)]), /timestamp_nanosec/);
});

test("check 9's margin: 30 s for a send, 120 s for a request that funds A", () => {
  const w = { register_deposit: 0n, recipient: "a.near", fee_recipient: CFG.feeRecipient, deadline_ms: 1_000_000 } as CheckedWithdraw;
  const r = (finalMs: bigint) => reads({ finalMs });
  assert.equal(checks7to9(w, CFG.vault, r(1_000_000n - SEND_MARGIN_MS)), null);
  assert.equal(checks7to9(w, CFG.vault, r(1_000_000n - SEND_MARGIN_MS + 1n)), "deadline_too_close");
  assert.equal(checks7to9(w, CFG.vault, r(1_000_000n - FUND_MARGIN_MS), { funds: true }), null);
  assert.equal(checks7to9(w, CFG.vault, r(1_000_000n - FUND_MARGIN_MS + 1n), { funds: true }), "deadline_too_close");
});

// ---- Check 10 ----

test("check 10: a halted token answers 503 token_halted, nothing signed; a halt that lands between the check and the signing is caught in the queue", async () => {
  const h = setup(chain(), { status: () => halted });
  const a = await carryWithdraw(req(), h.deps);
  assert.equal(a.status, 503);
  assert.equal(code(a), "token_halted");
  assert.equal(h.relayer.sent.length, 0);
  assert.equal(h.store.get(NF), null);
  // not caught up (the watch's answer while the event watch is not built) holds too
  const unknown = setup(chain(), { status: () => ({ ...open, caught_up: false, halted: null }) });
  assert.equal(code(await carryWithdraw(req(), unknown.deps)), "token_halted");
  // open at check 10, halted at the queue's guard
  let asks = 0;
  const race = setup(chain(), { status: () => (asks++ === 0 ? open : halted) });
  const b = await carryWithdraw(req(), race.deps);
  assert.equal(code(b), "token_halted");
  assert.equal(b.status, 503);
  assert.equal(race.relayer.sent.length, 0);
  assert.equal(race.store.get(NF), null);
  // a watch that throws holds
  const broken = setup(chain());
  broken.deps.tokenStatus = async () => {
    throw new Error("down");
  };
  assert.equal(code(await carryWithdraw(req(), broken.deps)), "token_halted");
});

test("checks 1-4 still lead: a body off shape is bad_shape before any chain read", async () => {
  const { deps, relayer, c } = setup();
  c.down = true;
  const body = req();
  delete (body as Record<string, unknown>).token;
  assert.equal(code(await carryWithdraw(body, deps)), "bad_shape");
  const low = setup(chain(), { feeMin: BigInt(W.relay_fee) + 1n });
  assert.equal(code(await carryWithdraw(req(), low.deps)), "fee_too_low");
  assert.equal(relayer.sent.length + low.relayer.sent.length, 0);
});

// ---- The outcome ----

const final = (tx: string, ok: boolean, ms?: bigint): TxOutcome => ({ kind: "final", tx_hash: tx, receipts: [{ executor: CFG.vault, ok, failure: ok ? "" : "receipt failed (read from blocks)", height: 1010n, ...(ms !== undefined && { ms }) }] });

test("the outcome from blocks: succeeded; failed past deadline_ms at E's time is the deadline's; failed at or before it is kept; dropped is never applied; E's time unread keeps", () => {
  assert.deepEqual(outcomeOf(final("t", true), 1000), { kind: "succeeded" });
  assert.deepEqual(outcomeOf(final("t", false, 1001n), 1000), { kind: "deadline" });
  assert.deepEqual(outcomeOf(final("t", false, 1000n), 1000), { kind: "failed", error: "receipt failed (read from blocks)" });
  assert.equal(outcomeOf(final("t", false), 1000), null);
  assert.deepEqual(outcomeOf({ kind: "dropped", tx_hash: "t", why: "(a2)" }, 1000), { kind: "never_applied" });
  assert.equal(outcomeOf({ kind: "unknown", tx_hash: "t", why: "" }, 1000), null);
  assert.equal(outcomeOf({ kind: "final", tx_hash: "t", receipts: [] }, 1000), null);
});

test("a round resends the open send and reads it from blocks; a deadline failure deletes the row and the note goes again", async () => {
  const { deps, relayer, store, outcomes } = setup();
  const first = await carryWithdraw(req(), deps);
  const tx = (first.body as { tx_hash: string }).tx_hash;
  await outcomeRound(deps);
  assert.deepEqual(relayer.resolved, [tx]);
  assert.equal((store.get(NF) as { outcome: string }).outcome, "open");
  outcomes.set(tx, final(tx, false, DEADLINE + 1n));
  await outcomeRound(deps);
  assert.equal(store.get(NF), null);
  assert.equal(code(await carryWithdraw(req(), deps)), "ok");
});

test("a failure other than the deadline's is kept with its error: withdraw_failed under the same release", async () => {
  const { deps, store, outcomes } = setup();
  const tx = ((await carryWithdraw(req(), deps)).body as { tx_hash: string }).tx_hash;
  outcomes.set(tx, final(tx, false, DEADLINE));
  await outcomeRound(deps);
  assert.equal((store.get(NF) as { outcome: string }).outcome, "failed");
  assert.equal(code(await carryWithdraw(req(), deps)), "withdraw_failed"); // release 2's carry is index.test.ts's (the claim's rule)
});

test("settle after a success: nothing while the callback has not run; then settle(nullifier_hash) once, 0 attached for paid; its success ends it", async () => {
  const { deps, relayer, store, outcomes, c } = setup();
  const tx = ((await carryWithdraw(req(), deps)).body as { tx_hash: string }).tx_hash;
  outcomes.set(tx, final(tx, true, DEADLINE - 1n));
  c.spendStatus = "in_flight";
  await outcomeRound(deps);
  assert.equal((store.get(NF) as { outcome: string }).outcome, "succeeded");
  assert.equal(relayer.sent.length, 1, "no settle while the spend is in_flight");
  assert.equal(code(await carryWithdraw(req(), deps)), "spent");
  c.spendStatus = "paid";
  await outcomeRound(deps);
  assert.equal(relayer.sent.length, 2);
  const s = relayer.sent[1]!;
  assert.ok(s.action.kind === "call");
  if (s.action.kind !== "call") return;
  assert.equal(s.action.method, "settle");
  assert.equal(s.action.receiver, CFG.vault);
  assert.deepEqual(JSON.parse(s.action.args), { nullifier_hash: NF.toString() });
  assert.equal(s.action.deposit, 0n);
  const rec = store.get(NF) as { settle: { tx: TxRef; done: boolean } };
  assert.equal(rec.settle.tx.tx_hash, s.tx.tx_hash);
  assert.equal(rec.settle.done, false);
  await outcomeRound(deps); // its outcome not known yet: resent, nothing new signed
  assert.equal(relayer.sent.length, 2);
  outcomes.set(s.tx.tx_hash, final(s.tx.tx_hash, true));
  await outcomeRound(deps);
  assert.equal((store.get(NF) as { settle: { done: boolean } }).settle.done, true);
  assert.deepEqual(store.toSettle(), []);
  await outcomeRound(deps);
  assert.equal(relayer.sent.length, 2);
});

test("settle of a refund note attaches 148 B x 1e19; a dropped settle is signed again; one settled by another caller ends with no transaction of ours", async () => {
  const { deps, relayer, store, outcomes, c } = setup();
  const tx = ((await carryWithdraw(req(), deps)).body as { tx_hash: string }).tx_hash;
  outcomes.set(tx, final(tx, true, DEADLINE - 1n));
  c.spendStatus = "refund_pending";
  await outcomeRound(deps);
  const s1 = relayer.sent[1]!;
  assert.ok(s1.action.kind === "call" && s1.action.deposit === SETTLE_REFUND_ATTACH);
  outcomes.set(s1.tx.tx_hash, { kind: "dropped", tx_hash: s1.tx.tx_hash, why: "(b)" });
  await outcomeRound(deps); // never applied while the spend is not settled: cleared
  assert.equal((store.get(NF) as { settle: unknown }).settle, null);
  await outcomeRound(deps); // signed again
  assert.equal(relayer.sent.length, 3);
  const s2 = relayer.sent[2]!;
  outcomes.set(s2.tx.tx_hash, { kind: "dropped", tx_hash: s2.tx.tx_hash, why: "(b)" });
  c.spendStatus = "settled"; // another caller settled it meanwhile
  await outcomeRound(deps);
  assert.equal((store.get(NF) as { settle: { done: boolean } }).settle.done, true);
  // a fresh success whose spend another caller settled first: done with no transaction of ours
  const other = setup(chain({ spendStatus: "settled" }));
  const t2 = ((await carryWithdraw(req(), other.deps)).body as { tx_hash: string }).tx_hash;
  other.outcomes.set(t2, final(t2, true, DEADLINE - 1n));
  await outcomeRound(other.deps);
  assert.deepEqual((other.store.get(NF) as { settle: unknown }).settle, { tx: null, done: true });
  assert.equal(other.relayer.sent.length, 1);
});

test("a settle that fails on chain is kept with its release: N failing rounds sign exactly one settle", async () => {
  const { deps, relayer, store, outcomes, c } = setup();
  const tx = ((await carryWithdraw(req(), deps)).body as { tx_hash: string }).tx_hash;
  outcomes.set(tx, final(tx, true, DEADLINE - 1n));
  c.spendStatus = "paid";
  await outcomeRound(deps);
  assert.equal(relayer.sent.length, 2);
  const s1 = relayer.sent[1]!;
  outcomes.set(s1.tx.tx_hash, final(s1.tx.tx_hash, false));
  for (let i = 0; i < 6; i++) await outcomeRound(deps);
  assert.equal(relayer.sent.length, 2, "one settle signed in six rounds of a settle that fails on chain");
  const rec = store.get(NF) as { settle: { tx: TxRef; done: boolean; failed: { release: number; error: string } } };
  assert.equal(rec.settle.done, false);
  assert.equal(rec.settle.tx.tx_hash, s1.tx.tx_hash);
  assert.deepEqual(rec.settle.failed, { release: 1, error: "receipt failed (read from blocks)" });
  assert.deepEqual(store.toSettle(), []);
});

test("a settle failure kept under release 1: a restart under release 1 signs none, a restart under release 2 signs one more", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wsettle-"));
  const one = setup();
  one.store.close();
  const s1store = createWithdrawSendStore(dir, { release: 1, keys: nonceStore });
  one.deps.store = s1store;
  const tx = ((await carryWithdraw(req(), one.deps)).body as { tx_hash: string }).tx_hash;
  one.outcomes.set(tx, final(tx, true, DEADLINE - 1n));
  one.c.spendStatus = "paid";
  await outcomeRound(one.deps);
  const st = one.relayer.sent[1]!.tx.tx_hash;
  one.outcomes.set(st, final(st, false));
  await outcomeRound(one.deps);
  s1store.close();
  const again = createWithdrawSendStore(dir, { release: 1, keys: nonceStore });
  assert.deepEqual(again.toSettle(), [], "the same release does not settle it again after a restart");
  one.deps.store = again;
  await outcomeRound(one.deps);
  assert.equal(one.relayer.sent.length, 2);
  again.close();
  const next = createWithdrawSendStore(dir, { release: 2, keys: nonceStore });
  assert.deepEqual(next.toSettle(), [NF]);
  one.deps.store = next;
  await outcomeRound(one.deps);
  assert.equal(one.relayer.sent.length, 3, "a higher release signs one more settle");
  const s3 = one.relayer.sent[2]!;
  assert.ok(s3.action.kind === "call" && s3.action.method === "settle");
  assert.equal((next.get(NF) as { settle: { failed?: unknown } }).settle.failed, undefined);
  next.close();
});

test("a send never applied deletes its row; a row whose key is no longer served stays open", async () => {
  const { deps, store, outcomes } = setup();
  const tx = ((await carryWithdraw(req(), deps)).body as { tx_hash: string }).tx_hash;
  const keep = deps.relayers;
  deps.relayers = [fakeRelayer("other.test.near", outcomes)];
  outcomes.set(tx, { kind: "dropped", tx_hash: tx, why: "(a2)" });
  await outcomeRound(deps);
  assert.equal((store.get(NF) as { outcome: string }).outcome, "open");
  deps.relayers = keep;
  await outcomeRound(deps);
  assert.equal(store.get(NF), null);
  assert.equal(nullifierKey(NF).length, 64);
});

test("the host's configuration: nothing set carries nothing (bad_shape); a network half set, a key that does not parse, no release or no store stops the helper at start", async () => {
  const quoter = { networkOf: () => null, quote: async () => { throw new Error("no"); }, reads: () => ({ feeMin: async () => 0n }) };
  const none = withdrawSenderFromEnv({}, quoter, {});
  const a = await none.carry(req());
  assert.equal(a.status, 400);
  assert.equal(code(a), "bad_shape");
  const base = { WITHDRAW_RELAYER_TESTNET: "relay.test.testnet", WITHDRAW_FEE_RECIPIENT_TESTNET: "relay.test.testnet", HELPER_RELEASE: "1", HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "wenv-")) };
  assert.throws(() => withdrawSenderFromEnv({ ...base, WITHDRAW_VAULT_TESTNET: "vault.test.testnet" }, quoter, {}), /ed25519 keys/);
  assert.throws(() => withdrawSenderFromEnv({ ...base, WITHDRAW_VAULT_TESTNET: "vault.test.testnet", WITHDRAW_RELAYER_KEYS_TESTNET: `ed25519:${"1".repeat(88)}` }, quoter, {}), /relayer key/);
  const key = (() => {
    const seed = Buffer.alloc(32, 7);
    const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
    return `ed25519:${base58(Buffer.concat([seed, pub]))}`;
  })();
  const good = { ...base, WITHDRAW_VAULT_TESTNET: "vault.test.testnet", WITHDRAW_RELAYER_KEYS_TESTNET: key };
  assert.doesNotThrow(() => withdrawSenderFromEnv(good, quoter, {}));
  assert.throws(() => withdrawSenderFromEnv({ ...good, HELPER_RELEASE: "" }, quoter, {}), /HELPER_RELEASE/);
  assert.throws(() => withdrawSenderFromEnv({ ...good, HELPER_STORE_DIR: "" }, quoter, {}), /HELPER_STORE_DIR/);
  assert.throws(() => withdrawSenderFromEnv({ ...good, WITHDRAW_RELAYER_TESTNET: "" }, quoter, {}), /WITHDRAW_RELAYER_TESTNET/);
  // a token of another network, or none, is check 1's bad_shape, with nothing read
  assert.equal(code(await withdrawSenderFromEnv(good, quoter, {}).carry({ ...req(), token: VAULT_CONSTANTS.TOKEN })), "bad_shape");
});

// The pin follows the kit's rule (packages/wallet/test/deposit-delegate.test.ts): mainnet-v1.json's account_id once the
// mainnet deploy writes that file, else mainnet-test.json's; one case for each, the other skipped.
const DEPLOYMENTS = join(import.meta.dirname, "../../../../contracts/vault/deployments");
const recordOf = (name: string) => JSON.parse(readFileSync(join(DEPLOYMENTS, `${name}.json`), "utf8")) as { network: string; account_id: string };
const HAS_V1 = existsSync(join(DEPLOYMENTS, "mainnet-v1.json"));

test("while mainnet-v1.json is absent, MAINNET_VAULT is mainnet-test.json's account_id", { skip: HAS_V1 && "mainnet-v1.json exists" }, () => {
  const record = recordOf("mainnet-test");
  assert.equal(record.network, "mainnet");
  assert.equal(MAINNET_VAULT, record.account_id);
});

test("once mainnet-v1.json exists, MAINNET_VAULT is its account_id, never the test vault's", { skip: !HAS_V1 && "mainnet-v1.json does not exist yet" }, () => {
  const record = recordOf("mainnet-v1");
  assert.equal(record.network, "mainnet");
  assert.equal(MAINNET_VAULT, record.account_id);
  assert.notEqual(MAINNET_VAULT, recordOf("mainnet-test").account_id);
});

test("mainnet carries only the vault its deploy record names: any other WITHDRAW_VAULT_MAINNET stops the helper at start", async () => {
  const record = { account_id: MAINNET_VAULT };
  const quoter = { networkOf: () => null, quote: async () => { throw new Error("no"); }, reads: () => ({ feeMin: async () => 0n }) };
  const seed = Buffer.alloc(32, 5);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  const relayer = pub.toString("hex"); // an implicit account, as deploy/withdraw-relayer-key.mjs makes it
  const env = {
    WITHDRAW_RELAYER_MAINNET: relayer,
    WITHDRAW_FEE_RECIPIENT_MAINNET: relayer,
    HELPER_RELEASE: "1",
    HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "wpin-")),
    WITHDRAW_RELAYER_KEYS_MAINNET: `ed25519:${base58(Buffer.concat([seed, pub]))}`,
  };
  assert.doesNotThrow(() => withdrawSenderFromEnv({ ...env, WITHDRAW_VAULT_MAINNET: record.account_id }, quoter, {}).stop());
  const pin = MAINNET_VAULT.replaceAll(".", "\\.");
  for (const other of ["vault.confidential.unrlzd.near", "vault-test.confidential.unrlzd.near", "vault-test2.confidential.unrlzd.near", "evil.near", `${MAINNET_VAULT}.evil.near`, `x.${MAINNET_VAULT}`, "vault.bf-vt-20261102t071444.testnet"].filter((v) => v !== MAINNET_VAULT)) {
    assert.throws(() => withdrawSenderFromEnv({ ...env, WITHDRAW_VAULT_MAINNET: other }, quoter, {}), new RegExp(`WITHDRAW_VAULT_MAINNET must be ${pin},`), other);
  }
  // testnet is not pinned here: its vault is the testnet deploy's (VT-T02), read from config() as before
  assert.doesNotThrow(() => withdrawSenderFromEnv({ ...env, WITHDRAW_VAULT_MAINNET: "", WITHDRAW_RELAYER_KEYS_MAINNET: "", WITHDRAW_RELAYER_TESTNET: "relay.test.testnet", WITHDRAW_FEE_RECIPIENT_TESTNET: "relay.test.testnet", WITHDRAW_VAULT_TESTNET: "vault.test.testnet", WITHDRAW_RELAYER_KEYS_TESTNET: env.WITHDRAW_RELAYER_KEYS_MAINNET }, quoter, {}).stop());
});

test("a relayer key the account does not hold (or an account that does not exist) answers 503 upstream at every carry, nothing signed", async () => {
  const seed = Buffer.alloc(32, 11);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  const quoter = { networkOf: () => null, quote: async () => { throw new Error("no"); }, reads: () => ({ feeMin: async () => 0n }) };
  for (const answer of ["no_key", "no_account", "function_call"] as const) {
    const env = {
      WITHDRAW_RELAYER_TESTNET: "relay.test.testnet",
      WITHDRAW_FEE_RECIPIENT_TESTNET: "relay.test.testnet",
      HELPER_RELEASE: "1",
      HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "wkey-")),
      WITHDRAW_VAULT_TESTNET: "vault.test.testnet",
      WITHDRAW_RELAYER_KEYS_TESTNET: `ed25519:${base58(Buffer.concat([seed, pub]))}`,
    };
    const sent: string[] = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
      const h = 1000;
      const head = { header: { height: h, hash: hashOf(h), prev_height: h - 1, gas_price: "100000000", timestamp_nanosec: (BigInt(Date.now()) * 1_000_000n).toString() } };
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "r", result }));
      if (method === "send_tx") sent.push(method);
      if (method === "block") return ok(head);
      if (method === "query" && params.method_name === "config") return ok({ result: [...Buffer.from(JSON.stringify({ scope: "7", asset: TESTNET_TOKEN }))], block_height: h, block_hash: hashOf(h), logs: [] });
      if (method === "EXPERIMENTAL_protocol_config") return ok({ transaction_validity_period: 86400 });
      if (method === "query" && params.request_type === "view_access_key") {
        if (answer === "no_account") return new Response(JSON.stringify({ jsonrpc: "2.0", id: "r", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }));
        if (answer === "no_key") return ok({ block_height: h, block_hash: hashOf(h), error: `access key ${String(params.public_key)} does not exist while viewing`, logs: [] });
        return ok({ nonce: 5, permission: { FunctionCall: { allowance: null, receiver_id: "vault.test.testnet", method_names: [] } }, block_height: h, block_hash: hashOf(h) });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "r", error: { name: "HANDLER_ERROR", cause: { name: "NOT_SERVED" } } }));
    }) as unknown as typeof fetch;
    const sender = withdrawSenderFromEnv(env, quoter, {}, fetchFn);
    for (let i = 0; i < 2; i++) {
      const a = await sender.carry({ ...req(), token: TESTNET_TOKEN });
      assert.deepEqual([a.status, code(a)], [503, "upstream"], `${answer}, try ${i}`);
    }
    assert.deepEqual(sent, [], answer);
    sender.stop();
  }
});

// ---- Planted removals that survived the review, each held here ----

test("check 9's time: two finals more than 30 blocks apart are refused; 30 apart is read", async () => {
  await assert.rejects(newestFinalMs([provider(chain(), 0), provider(chain({ height1: 1031 }), 1)]), /31 blocks apart/);
  assert.equal(await newestFinalMs([provider(chain(), 0), provider(chain({ height1: 1030 }), 1)]), chain().ms);
});

test("storage_balance_of answered as anything but null or a balance is 503 upstream, nothing signed", async () => {
  for (const bad of [{ total: "x" }, { available: "0" }, 5, true, []]) {
    const x = setup(chain({ balanceAnswer: bad }));
    const a = await carryWithdraw(req(), x.deps);
    assert.deepEqual([a.status, code(a)], [503, "upstream"], JSON.stringify(bad));
    assert.equal(x.relayer.sent.length, 0);
  }
});

test("the rounds resend: an open send's stored bytes and our own open settle's go out again each round (resend true)", async () => {
  const { deps, relayer, outcomes, c } = setup();
  const tx = ((await carryWithdraw(req(), deps)).body as { tx_hash: string }).tx_hash;
  await outcomeRound(deps);
  assert.deepEqual([relayer.resolved, relayer.resends], [[tx], [true]]);
  outcomes.set(tx, final(tx, true, DEADLINE - 1n));
  c.spendStatus = "paid";
  await outcomeRound(deps); // succeeded, settle signed
  const st = relayer.sent[1]!.tx.tx_hash;
  await outcomeRound(deps); // the settle's outcome unknown: resent
  const i = relayer.resolved.lastIndexOf(st);
  assert.ok(i >= 0, "the settle was read");
  assert.equal(relayer.resends[i], true, "our own settle's bytes are resent");
});

test("the settle reads the spends row of its own nullifier: a row at the index naming another nullifier settles nothing", async () => {
  const { deps, relayer, store, outcomes, c } = setup(chain({ spendNf: NF + 1n }));
  const tx = ((await carryWithdraw(req(), deps)).body as { tx_hash: string }).tx_hash;
  outcomes.set(tx, final(tx, true, DEADLINE - 1n));
  c.spendStatus = "paid";
  await outcomeRound(deps);
  await outcomeRound(deps);
  assert.equal(relayer.sent.length, 1, "no settle on another nullifier's row");
  assert.equal((store.get(NF) as { settle?: unknown }).settle, undefined);
  c.spendNf = NF;
  await outcomeRound(deps);
  assert.equal(relayer.sent.length, 2);
});

test("a start that fails after the stores open closes them: the next try starts", async () => {
  const seed = Buffer.alloc(32, 9);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  const env = {
    WITHDRAW_RELAYER_TESTNET: "relay.test.testnet",
    WITHDRAW_FEE_RECIPIENT_TESTNET: "relay.test.testnet",
    HELPER_RELEASE: "1",
    HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "wstart-")),
    WITHDRAW_VAULT_TESTNET: "vault.test.testnet",
    WITHDRAW_RELAYER_KEYS_TESTNET: `ed25519:${base58(Buffer.concat([seed, pub]))}`,
  };
  let protocolReads = 0;
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    const h = 1000;
    const head = { header: { height: h, hash: hashOf(h), prev_height: h - 1, gas_price: "100000000", timestamp_nanosec: (BigInt(Date.now()) * 1_000_000n).toString() } };
    let result: unknown;
    if (method === "block") result = head;
    else if (method === "query" && params.method_name === "config") result = { result: [...Buffer.from(JSON.stringify({ scope: "7", asset: TESTNET_TOKEN }))], block_height: h, block_hash: hashOf(h), logs: [] };
    else if (method === "query" && params.request_type === "view_access_key") result = { nonce: 5, permission: "FullAccess", block_height: h, block_hash: hashOf(h) };
    else if (method === "EXPERIMENTAL_protocol_config") {
      if (protocolReads++ === 0) return new Response(JSON.stringify({ jsonrpc: "2.0", id: "r", error: { name: "INTERNAL_ERROR", cause: { name: "INTERNAL_ERROR" } } }));
      result = { transaction_validity_period: 86400 };
    } else return new Response(JSON.stringify({ jsonrpc: "2.0", id: "r", error: { name: "HANDLER_ERROR", cause: { name: "NOT_SERVED" } } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "r", result }));
  }) as unknown as typeof fetch;
  const quoter = { networkOf: () => null, quote: async () => { throw new Error("no"); }, reads: () => ({ feeMin: async () => 0n }) };
  const sender = withdrawSenderFromEnv(env, quoter, {}, fetchFn);
  const body = { ...req(), token: TESTNET_TOKEN };
  const first = await sender.carry(body);
  assert.deepEqual([first.status, code(first)], [503, "upstream"], "the first start fails at the protocol read");
  const second = await sender.carry(body);
  assert.notEqual(code(second), "upstream", `the second start takes the stores' locks again: ${JSON.stringify(second.body)}`);
  sender.stop();
});
