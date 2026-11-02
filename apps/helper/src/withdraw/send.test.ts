// send.ts, POST /v1/withdraw's checks 7-10, the claimed send, the outcome rounds and the settle. The request is the
// real proof of fixtures/withdraw-request.json (checks 1-4 pass on it); the chain is two fake providers answering
// `block` and call_function as nearcore does; the store is a real directory; the relayer is a fake that runs the
// guard, takes n from the counter, calls `before` and records what it would broadcast. Each test names its rule.
//   node --test apps/helper/src/withdraw/send.test.ts
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VAULT_CONSTANTS, vaultWithdrawYocto } from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import type { Relayer, RelayerAction, Rpc, TxOutcome, TxRef } from "../bind/send.ts";
import { USDC_CODE_HASH, type TokenStatus } from "../token-status/status.ts";
import type { CheckedWithdraw, WithdrawConfig } from "./checks.ts";
import { createWithdrawSendStore, nullifierKey, type SpendsIndex } from "./index.ts";
import {
  FUND_MARGIN_MS,
  INTENTS,
  SEND_MARGIN_MS,
  SETTLE_REFUND_ATTACH,
  WITHDRAW_GAS,
  carryWithdraw,
  checks7to9,
  newestFinalMs,
  outcomeOf,
  outcomeRound,
  withdrawSenderFromEnv,
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
  down?: boolean;
};
const chain = (over: Partial<Chain> = {}): Chain => ({ height: 1000, ms: DEADLINE - SEND_MARGIN_MS - 60_000n, registered: [false, false], min: MIN, spendStatus: "in_flight", spendIndex: 0, ...over });

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
    if (method === "block") return header(p.finality === "final" ? c.height : Number(p.block_id));
    if (method === "query" && p.request_type === "call_function") {
      const h = Number(p.block_id);
      const args = JSON.parse(Buffer.from(String(p.args_base64), "base64").toString("utf8")) as Record<string, unknown>;
      let v: unknown;
      if (p.method_name === "storage_balance_of") v = c.registered[i] ? { total: MIN.toString(), available: "0" } : null;
      else if (p.method_name === "storage_balance_bounds") v = { min: c.min.toString(), max: c.min.toString() };
      else if (p.method_name === "spends") v = args.from === c.spendIndex ? [{ index: c.spendIndex, nullifier_hash: NF.toString(), status: c.spendStatus }] : [];
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

function fakeRelayer(name: string, outcomes: Map<string, TxOutcome>): Relayer & { sent: Sent[]; resolved: string[] } {
  const key = `${name}/ed25519:test`;
  const r = {
    account: name,
    key,
    sent: [] as Sent[],
    resolved: [] as string[],
    balance: async () => 10n ** 24n,
    async send<C extends string>(action: RelayerAction, guard: () => Promise<C | null>, before: (tx: TxRef) => void) {
      const code = await guard();
      if (code !== null) return { kind: "guarded" as const, code };
      const n = counters.get(key) ?? 1n;
      counters.set(key, n + 1n);
      const tx: TxRef = { tx_hash: base58(createHash("sha256").update(`${key} ${n}`).digest()), nonce: n.toString(), height: "999", block_hash: hashOf(999), signed_tx: Buffer.from(`${key} ${n}`).toString("base64") };
      before(tx); // a throw here drops the bytes: nothing is recorded as sent
      r.sent.push({ action, tx });
      return { kind: "unknown" as const, tx_hash: tx.tx_hash, why: "sent" };
    },
    async resolve(tx: TxRef, opts: { resend: boolean; fromBlocks?: boolean }) {
      assert.equal(opts.fromBlocks, true, "a vault call's outcome is read from blocks only");
      r.resolved.push(tx.tx_hash);
      return outcomes.get(tx.tx_hash) ?? { kind: "unknown" as const, tx_hash: tx.tx_hash, why: "not yet" };
    },
  };
  return r;
}

function fakeIndex(spent = false): SpendsIndex {
  return { finalHeight: async () => 1000n, reach: async () => true, holds: () => spent, at: () => 1000n, indexOf: () => 0 };
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
    store,
    relayers: [relayer],
    tokenStatus: async () => (opts.status ?? (() => open))(),
    now: () => Number(c.ms),
  };
  return { c, deps, relayer, store, outcomes };
}

const code = (a: Awaited<ReturnType<typeof carryWithdraw>>) => ("error" in a.body ? a.body.error.code : "ok");

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
  const r = { registered: true, registerMin: MIN, finalMs: 0n };
  assert.equal(checks7to9(w, CFG.vault, r), null);
  assert.equal(checks7to9({ ...w, register_deposit: 1n }, CFG.vault, r), "register_deposit_wrong");
  assert.equal(checks7to9(w, CFG.vault, { ...r, registered: false }), "register_deposit_wrong");
  assert.equal(checks7to9({ ...w, register_deposit: MIN }, CFG.vault, { ...r, registered: false }), null);
});

test("check 7's exception: a stored withdrawal's minimum stands for a recipient registered since; a fresh request's does not", () => {
  const w = { register_deposit: MIN, recipient: "a.near", fee_recipient: CFG.feeRecipient, deadline_ms: Number(DEADLINE) } as CheckedWithdraw;
  const r = { registered: true, registerMin: MIN, finalMs: 0n };
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
  const r = { registered: true, registerMin: MIN, finalMs: 0n };
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
  const r = (finalMs: bigint) => ({ registered: true, registerMin: MIN, finalMs });
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

test("settle of a refund note attaches 148 B x 1e19; a settle that failed is signed again; one settled by another caller ends with no transaction of ours", async () => {
  const { deps, relayer, store, outcomes, c } = setup();
  const tx = ((await carryWithdraw(req(), deps)).body as { tx_hash: string }).tx_hash;
  outcomes.set(tx, final(tx, true, DEADLINE - 1n));
  c.spendStatus = "refund_pending";
  await outcomeRound(deps);
  const s1 = relayer.sent[1]!;
  assert.ok(s1.action.kind === "call" && s1.action.deposit === SETTLE_REFUND_ATTACH);
  outcomes.set(s1.tx.tx_hash, final(s1.tx.tx_hash, false));
  await outcomeRound(deps); // failed while the spend is not settled: cleared
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
