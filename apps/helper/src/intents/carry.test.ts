// node --test apps/helper/src/intents/carry.test.ts: RT10 (markets.md RT10; H4.3's paragraph "The ids' intents on
// /v1/intents"; H7's /v1/intents row): the handler fed the helper's 1Click quote records and status reads (shaped as
// bind/fixtures/oneclick-status.json's recorded answers, with the fields each case names changed), the two NEAR
// providers' answers to block, simulate_intents and storage_balance_of (constructed in the RPC's own shape: a view's
// result as bytes, a refusal as an error), and the relayer's own send and storage_deposit outcomes. intents.near
// itself is not run, so execute_intents end to end is not covered here. 15 cases, 17 requests.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HELPER_INTENTS_CODES } from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import type { Relayer, RelayerAction, Rpc, TxOutcome, TxRef } from "../bind/send.ts";
import { createIntentsCarry, INTENTS_FLOOR_YOCTO, INTENTS_SENDS_MAX, OWN_SETTLE_MS, REGISTRATION_YOCTO, SIGNER_CAP_STATUS, SWEEP_MS, type IntentsAnswer } from "./carry.ts";
import { RELAYER_FLOOR_YOCTO, USDC_PAUSED } from "../bind/send.ts";
import { tokenHeld, type TokenStatus } from "../token-status/status.ts";
import { intentsReads } from "./reads.ts";
import { createIntentsStore, onArmed, onQuoteAnswer, onStatusAnswer, QUOTE_KEEP_MS, type IntentsStore } from "./records.ts";

const VAULT = "vault.confidential.unrlzd.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const FIXTURE = JSON.parse(readFileSync(new URL("../bind/fixtures/oneclick-status.json", import.meta.url), "utf8")).answers.success_usdc;
const NOW = Date.parse("2026-11-07T18:00:00.000Z");
const hex = () => randomBytes(32).toString("hex");

// ---- the 1Click answers our proxy carried ----
function quoteAnswer(o: { address: string; recipient: string; refundTo: string; depositType?: string; refundType?: string; deadline?: string }) {
  const q = structuredClone(FIXTURE.quoteResponse);
  Object.assign(q.quoteRequest, { recipient: o.recipient, refundTo: o.refundTo, depositType: o.depositType ?? "INTENTS", refundType: o.refundType ?? "INTENTS" });
  Object.assign(q.quote, { depositAddress: o.address, deadline: o.deadline ?? "2026-11-07T18:30:00.000Z" });
  return JSON.stringify(q);
}
function statusAnswer(status: "SUCCESS" | "REFUNDED", quote: string) {
  return JSON.stringify({ ...structuredClone(FIXTURE), status, quoteResponse: JSON.parse(quote) });
}
/** A signer our helper saw: its deposit quote carried, then a REFUNDED status read for it (the refund under U). */
async function seeSigner(store: IntentsStore, u: string) {
  const q = quoteAnswer({ address: hex(), recipient: u, refundTo: u, depositType: "ORIGIN_CHAIN" });
  assert.ok(await onQuoteAnswer(q, store));
  assert.equal(onStatusAnswer(statusAnswer("REFUNDED", q), store), u);
}
/** The refund move's quote (wallet refund.ts refundMoveRequest), carried: its deposit address. */
async function moveQuote(store: IntentsStore, o: { refundTo: string; recipient: string }) {
  const address = hex();
  assert.ok(await onQuoteAnswer(quoteAnswer({ address, ...o }), store));
  return address;
}

// ---- the device's signed intent (wallet refund.ts transferPayload's spelling) ----
const nonce = () => randomBytes(32).toString("base64");
function signedIntent(signer: string, intent: Record<string, unknown>, o: { deadline?: string; nonce?: string } = {}) {
  const payload = JSON.stringify({ signer_id: signer, verifying_contract: "intents.near", deadline: o.deadline ?? "2026-11-07T18:02:00.000Z", nonce: o.nonce ?? nonce(), intents: [intent] });
  return { signed_intent: { standard: "raw_ed25519", payload, public_key: `ed25519:${base58(randomBytes(32))}`, signature: `ed25519:${base58(randomBytes(64))}` } };
}
const transfer = (to: string, amount = "2003610") => ({ intent: "transfer", receiver_id: to, tokens: { [`nep141:${USDC}`]: amount } });
const withdraw = (to: string, extra: Record<string, unknown> = {}) => ({ intent: "ft_withdraw", token: USDC, receiver_id: to, amount: "2003610", ...extra });

// ---- the two providers ----
type Chain = { refuseSimulateOn: number | null; executed?: number; storage: Map<string, "null" | "registered">; finalMs: number; finalMsOf?: [number, number]; paused?: boolean; sims?: number; storageReads?: number };
const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
const SIM_OK = { intents_executed: [{ intent_hash: "x", account_id: "u", nonce: "n" }], logs: [], min_deadline: "2026-11-07T18:02:00Z", invariant_violated: null, state: { fee: 1, current_salt: "5628f6c6" } };
function providers(chain: Chain): [Rpc, Rpc] {
  const HASH = base58(Buffer.alloc(32, 7));
  const make =
    (i: number): Rpc =>
    async (method, params) => {
      const p = params as Record<string, unknown>;
      if (method === "block") return { header: { height: 221_603_850, hash: HASH, gas_price: "100000000", timestamp_nanosec: (BigInt(chain.finalMsOf?.[i] ?? chain.finalMs) * 1_000_000n).toString(), prev_height: 221_603_849 } };
      if (method === "query" && p.request_type === "call_function") {
        const args = JSON.parse(Buffer.from(p.args_base64 as string, "base64").toString());
        const at = { block_height: 221_603_850, block_hash: HASH, logs: [] };
        if (p.method_name === "simulate_intents") {
          chain.sims = (chain.sims ?? 0) + 1;
          if (chain.refuseSimulateOn === i) throw new Error("Server error: Smart contract panicked: invalid signature");
          return { ...at, result: bytes({ ...SIM_OK, intents_executed: SIM_OK.intents_executed.slice(0, chain.executed ?? 1) }) };
        }
        // a halted USDC: its FiatToken views refuse with its paused error (bind/send.ts USDC_PAUSED); storage_balance_of
        // is NEP-145's and a pause does not gate it
        if (chain.paused === true && p.account_id === USDC && p.method_name !== "storage_balance_of") throw new Error(`Server error: Smart contract panicked: ${USDC_PAUSED}`);
        if (p.method_name === "storage_balance_of") {
          chain.storageReads = (chain.storageReads ?? 0) + 1;
          const s = chain.storage.get(`${p.account_id}/${args.account_id}`) ?? "registered";
          return { ...at, result: bytes(s === "null" ? null : { total: REGISTRATION_YOCTO.toString(), available: "0" }) };
        }
      }
      throw new Error(`unexpected ${method}`);
    };
  return [make(0), make(1)];
}

// ---- the relayer: its own send outcomes ----
type Sent = { action: Extract<RelayerAction, { kind: "call" }>; tx: TxRef };
function relayer(outcome: (a: Extract<RelayerAction, { kind: "call" }>) => "ran" | "failed" | "held"): Pick<Relayer, "send" | "resolve" | "balance"> & { sent: Sent[]; release(): void; funds: bigint } {
  const sent: Sent[] = [];
  const outs = new Map<string, TxOutcome>();
  let release: () => void = () => {};
  const gate = new Promise<void>((ok) => (release = ok));
  const r = {
    sent,
    funds: 10n ** 25n,
    release: () => release(),
    balance: async () => r.funds,
    async send(action: RelayerAction, guard: () => Promise<string | null>, before: (tx: TxRef) => void) {
      const code = await guard();
      if (code !== null) return { kind: "guarded" as const, code };
      assert.equal(action.kind, "call");
      const a = action as Extract<RelayerAction, { kind: "call" }>;
      const tx: TxRef = { tx_hash: base58(randomBytes(32)), nonce: String(sent.length + 1), height: "221603850", block_hash: base58(Buffer.alloc(32, 7)), signed_tx: "" };
      before(tx);
      sent.push({ action: a, tx });
      const kind = outcome(a);
      if (kind === "held") {
        // an outcome read only once the test releases it: the send stays out meanwhile
        outs.set(tx.tx_hash, { kind: "unknown", tx_hash: tx.tx_hash, why: "held" });
        void gate.then(() => outs.set(tx.tx_hash, { kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: "intents.near", ok: true, failure: "", height: 1n }] }));
      } else {
        outs.set(tx.tx_hash, { kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: a.receiver, ok: kind === "ran", failure: kind === "ran" ? "" : '{"Failure":"x"}', height: 1n }] });
      }
      // the storage_deposit is waited on; execute_intents answers once sent (carry.ts { wait: false })
      return a.method === "storage_deposit" ? outs.get(tx.tx_hash)! : { kind: "unknown" as const, tx_hash: tx.tx_hash, why: "sent; not read yet" };
    },
    async resolve(tx: TxRef) {
      return outs.get(tx.tx_hash)!;
    },
  };
  return r as typeof r & Pick<Relayer, "send" | "resolve" | "balance">;
}

function setup(o: { outcome?: (a: Extract<RelayerAction, { kind: "call" }>) => "ran" | "failed" | "held"; chain?: Partial<Chain>; dir?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "intents-"));
  const store = createIntentsStore(dir, undefined, () => NOW);
  const chain: Chain = { refuseSimulateOn: null, storage: new Map(), finalMs: NOW, ...o.chain };
  // by default the chain is honest: a storage_deposit that ran registers its account (a lying lookup is a test's own)
  const r = relayer(
    o.outcome ??
      ((a) => {
        if (a.method === "storage_deposit") chain.storage.set(`${a.receiver}/${JSON.parse(a.args).account_id}`, "registered");
        return "ran";
      }),
  );
  // the helper's clock (a test moves it); the token watch holds while the chain's USDC is paused
  const clock = { ms: NOW };
  const carry = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(chain), () => NOW), relayer: r, held: async () => chain.paused === true, now: () => clock.ms, resolveEveryMs: 1 });
  return { dir, store, chain, r, carry, clock };
}
const code = (a: IntentsAnswer) => ("error" in a.body ? a.body.error.code : "sent");

// the tally RT10's output line is read from
const tally = new Map<string, number>();
let requests = 0;
const count = (name: string, a: IntentsAnswer, want: string) => {
  requests++;
  assert.equal(code(a), want, `${name}: answered ${JSON.stringify(a.body)}`);
  tally.set(name, (tally.get(name) ?? 0) + 1);
};
const allSent: Sent[] = [];

test("RT10 (1) a signer our helper never saw receive money: id_not_ours, 403, before any chain read", async () => {
  const s = setup();
  s.chain.finalMs = Number.NaN; // any chain read would throw: the gate answers before one
  const u = hex();
  const a = await s.carry.carry(signedIntent(u, withdraw("alice.near")));
  assert.equal(a.status, 403);
  count("id_not_ours", a, "id_not_ours");
  // a quote alone is not the gate: no status read showed money to it
  await onQuoteAnswer(quoteAnswer({ address: hex(), recipient: u, refundTo: u }), s.store);
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("alice.near")))), "id_not_ours");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (2), (3) a receiver that is the vault: receiver_is_vault, 403, for an ft_withdraw and a transfer", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  const a = await s.carry.carry(signedIntent(u, withdraw(VAULT)));
  assert.equal(a.status, 403);
  count("receiver_is_vault", a, "receiver_is_vault");
  count("receiver_is_vault", await s.carry.carry(signedIntent(u, transfer(VAULT))), "receiver_is_vault");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (4) an ft_withdraw carrying a msg: bad_shape", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  count("bad_shape", await s.carry.carry(signedIntent(u, withdraw("alice.near", { msg: "" }))), "bad_shape");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (5) a transfer to a deposit address our helper did not quote: not_helper_quote", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  count("not_helper_quote", await s.carry.carry(signedIntent(u, transfer(hex()))), "not_helper_quote");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (6) an intent past its deadline: expired", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  const to = await moveQuote(s.store, { refundTo: u, recipient: u });
  count("expired", await s.carry.carry(signedIntent(u, transfer(to), { deadline: "2026-11-07T17:59:59.000Z" })), "expired");
  assert.equal(s.r.sent.length, 0);
  assert.equal(s.chain.sims ?? 0, 0, "refused before the simulation: no simulate_intents read");
  s.store.close();
});

test("RT10 (7) simulate_intents refusing the intent on one of the two providers: simulation_refused", async () => {
  const s = setup({ chain: { refuseSimulateOn: 1 } });
  const u = hex();
  await seeSigner(s.store, u);
  const to = await moveQuote(s.store, { refundTo: u, recipient: u });
  count("simulation_refused", await s.carry.carry(signedIntent(u, transfer(to))), "simulation_refused");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (8) USDC halted: a good transfer and a good ft_withdraw to a registered typed account are both sent, never token_halted", async () => {
  // the halt, set: the token watch's answer that holds every move into the vault on /v1/bind, and USDC paused on both
  // providers (its FiatToken views refuse). The carry takes no watch (carry.ts IntentsDeps) and reads only
  // storage_balance_of, which a pause does not gate.
  const halted: TokenStatus = { token: USDC, caught_up: true, halted: true, vault_blocked: false, code_hash_ok: true, code_hash: "", block_height: 221_603_850, last_event: null } as TokenStatus;
  assert.equal(tokenHeld(halted), true, "/v1/bind holds on this status");
  const s = setup({ chain: { paused: true } });
  const u = hex();
  await seeSigner(s.store, u);
  const to = await moveQuote(s.store, { refundTo: u, recipient: u });
  count("sent under a halt", await s.carry.carry(signedIntent(u, transfer(to))), "sent");
  count("sent under a halt", await s.carry.carry(signedIntent(u, withdraw("alice.near"))), "sent");
  await s.carry.idle();
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["execute_intents", "execute_intents"]);
  allSent.push(...s.r.sent);
  s.store.close();
});

test("RT10 (9) three failed sends on one signer, then its next request: sender_struck, 403, kept across a restart", async () => {
  const s = setup({ outcome: () => "failed" });
  const u = hex();
  await seeSigner(s.store, u);
  for (let k = 0; k < 3; k++) {
    const to = await moveQuote(s.store, { refundTo: u, recipient: u });
    assert.equal(code(await s.carry.carry(signedIntent(u, transfer(to)))), "sent"); // out, then failed on chain
    await s.carry.idle();
  }
  assert.equal(s.store.signer(u).failed, 3);
  allSent.push(...s.r.sent);
  s.store.close();
  // a restart: the same store reopened by a new carry
  const t = setup({ dir: s.dir });
  const to = await moveQuote(t.store, { refundTo: u, recipient: u });
  const a = await t.carry.carry(signedIntent(u, transfer(to)));
  assert.equal(a.status, 403);
  count("sender_struck", a, "sender_struck");
  assert.equal(t.r.sent.length, 0);
  t.store.close();
});

test("RT10 (10) the same intent twice at once: one sent, one in_flight", async () => {
  const s = setup({ outcome: () => "held" });
  const u = hex();
  await seeSigner(s.store, u);
  const to = await moveQuote(s.store, { refundTo: u, recipient: u });
  const body = signedIntent(u, transfer(to));
  const [a, b] = await Promise.all([s.carry.carry(body), s.carry.carry(structuredClone(body))]);
  const codes = [code(a), code(b)].sort();
  assert.deepEqual(codes, ["in_flight", "sent"]);
  count("sent beside in_flight", code(a) === "sent" ? a : b, "sent");
  count("in_flight", code(a) === "sent" ? b : a, "in_flight");
  // still out until its outcome is read: the same intent again is in_flight
  assert.equal(code(await s.carry.carry(structuredClone(body))), "in_flight");
  s.r.release();
  await s.carry.idle();
  assert.equal(s.r.sent.length, 1);
  allSent.push(...s.r.sent);
  s.store.close();
});

test("RT10 (11) a transfer to a helper-quoted address whose refundTo is the signer and whose recipient is another address (withdraw.open to another chain): sent", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  const to = await moveQuote(s.store, { refundTo: u, recipient: "So1anaTypedAddress111111111111111111111111" });
  const body = signedIntent(u, transfer(to));
  count("sent to a typed recipient", await s.carry.carry(body), "sent");
  await s.carry.idle();
  // the device's signed intent, carried as signed: one entry, its four fields byte for byte
  assert.deepEqual(JSON.parse(s.r.sent[0]!.action.args), { signed: [body.signed_intent] });
  assert.equal(s.r.sent[0]!.action.deposit, 0n);
  assert.equal(s.r.sent[0]!.action.receiver, "intents.near");
  allSent.push(...s.r.sent);
  s.store.close();
});

test("RT10 (12) a transfer to a helper-quoted address whose refundTo is not the signer: not_helper_quote", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  const to = await moveQuote(s.store, { refundTo: hex(), recipient: u });
  count("not_helper_quote", await s.carry.carry(signedIntent(u, transfer(to))), "not_helper_quote");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (13), (15) an ft_withdraw to an unregistered typed account: one storage_deposit from the relayer, then the intent; a second receiver for that signer: receiver_not_registered", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  count("sent after a registration", await s.carry.carry(signedIntent(u, withdraw("fresh.near"))), "sent");
  await s.carry.idle();
  const [reg, ex] = s.r.sent;
  assert.equal(reg!.action.method, "storage_deposit");
  assert.equal(reg!.action.receiver, USDC);
  assert.deepEqual(JSON.parse(reg!.action.args), { account_id: "fresh.near", registration_only: true });
  assert.equal(reg!.action.deposit, REGISTRATION_YOCTO);
  assert.equal(REGISTRATION_YOCTO, 1_250_000_000_000_000_000_000n); // 0.00125 N
  assert.equal(ex!.action.method, "execute_intents");
  assert.equal(s.store.signer(u).registration?.state, "landed");
  // (15) after its paid registration, an ft_withdraw to another account that reads null
  s.chain.storage.set(`${USDC}/other.near`, "null");
  const a = await s.carry.carry(signedIntent(u, withdraw("other.near")));
  assert.equal(a.status, 409);
  count("receiver_not_registered", a, "receiver_not_registered");
  assert.equal(s.r.sent.length, 2, "no second storage_deposit");
  allSent.push(...s.r.sent);
  s.store.close();
});

test("RT10 (14) the storage_deposit failing: registration_failed, no intent sent, never counted toward the signer's strikes (review F1: its receipt refunds the deposit)", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "failed" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  count("registration_failed", await s.carry.carry(signedIntent(u, withdraw("fresh.near"))), "registration_failed");
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["storage_deposit"]);
  assert.equal(s.store.signer(u).failed, 0);
  assert.equal(s.store.signer(u).registration, null, "free again: the device sends the same intent again");
  allSent.push(...s.r.sent);
  s.store.close();
});

test("RT10: 17 requests answered with their codes, no prepay, no token_halted", () => {
  const want = { id_not_ours: 1, receiver_is_vault: 2, bad_shape: 1, not_helper_quote: 2, expired: 1, simulation_refused: 1, "sent under a halt": 2, "sent to a typed recipient": 1, sender_struck: 1, "sent beside in_flight": 1, in_flight: 1, "sent after a registration": 1, registration_failed: 1, receiver_not_registered: 1 };
  assert.deepEqual(Object.fromEntries(tally), want);
  assert.equal(requests, 17);
  const prepays = allSent.filter((x) => x.action.method === "storage_prepay").length;
  const deposits = allSent.filter((x) => x.action.method === "storage_deposit");
  assert.equal(prepays, 0);
  for (const c of Object.keys(want)) assert.ok(!c.includes("token_halted"));
  assert.ok(!(HELPER_INTENTS_CODES as readonly string[]).includes("token_halted"));
  console.log(
    `intents: ${requests}/17 answered with their codes (${Object.entries(want)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}); ${prepays} prepays; 0 token_halted; ${deposits.length - 1} storage_deposit landed, 1 failed`,
  );
});

test("the gate's records: a status answer names a signer only through our own quote record, and only SUCCESS or REFUNDED", async () => {
  const s = setup();
  const u = hex();
  const other = hex();
  const q = quoteAnswer({ address: hex(), recipient: u, refundTo: u });
  // a status for an address we never quoted names nobody
  assert.equal(onStatusAnswer(statusAnswer("SUCCESS", q), s.store), null);
  await onQuoteAnswer(q, s.store);
  // a status whose own quoteRequest names another recipient: our record's recipient is the one seen
  const forged = JSON.parse(statusAnswer("SUCCESS", q));
  forged.quoteResponse.quoteRequest.recipient = other;
  assert.equal(onStatusAnswer(JSON.stringify(forged), s.store), u);
  assert.equal(s.store.seen(other), false);
  const pending = JSON.parse(statusAnswer("SUCCESS", q));
  pending.status = "PENDING_DEPOSIT";
  assert.equal(onStatusAnswer(JSON.stringify(pending), s.store), null);
  // a dry quote is never recorded, and the first record of an address is never replaced
  const dry = JSON.parse(quoteAnswer({ address: hex(), recipient: u, refundTo: u }));
  dry.quoteRequest.dry = true;
  assert.equal(await onQuoteAnswer(JSON.stringify(dry), s.store), null);
  const addr = JSON.parse(q).quote.depositAddress;
  assert.equal(await onQuoteAnswer(quoteAnswer({ address: addr, recipient: other, refundTo: other }), s.store), null);
  assert.equal(s.store.quote(addr)?.refund_to, u);
  s.store.close();
});

test("a payload that is not its own canonical JSON is bad_shape: a repeated key cannot show this file one receiver and intents.near another", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  const good = signedIntent(u, withdraw("alice.near"));
  const dup = structuredClone(good);
  dup.signed_intent.payload = dup.signed_intent.payload.replace('"receiver_id":"alice.near"', `"receiver_id":"${VAULT}","receiver_id":"alice.near"`);
  assert.equal(code(await s.carry.carry(dup)), "bad_shape");
  const spaced = structuredClone(good);
  spaced.signed_intent.payload = spaced.signed_intent.payload.replace(",", ", ");
  assert.equal(code(await s.carry.carry(spaced)), "bad_shape");
  const extra = structuredClone(good) as Record<string, unknown>;
  extra.other = 1;
  assert.equal(code(await s.carry.carry(extra)), "bad_shape");
  assert.equal(code(await s.carry.carry({})), "bad_shape"); // the device's probe (wallet refund.ts ask.probe)
  for (const i of [withdraw("intents.near"), withdraw("alice.near", { storage_deposit: "1" }), { ...transfer("a.near"), memo: "m" }, { intent: "transfer", receiver_id: "a.near", tokens: { [`nep141:${USDC}`]: "1", "nep141:wrap.near": "1" } }, { intent: "add_public_key", public_key: "ed25519:x" }]) {
    assert.equal(code(await s.carry.carry(signedIntent(u, i))), "bad_shape", JSON.stringify(i));
  }
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("a quote record that is not depositType INTENTS with an INTENTS refund to the signer, or past its deadline: not_helper_quote", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  for (const o of [{ depositType: "ORIGIN_CHAIN" }, { refundType: "ORIGIN_CHAIN" }, { deadline: "2026-11-07T17:00:00.000Z" }]) {
    const address = hex();
    await onQuoteAnswer(quoteAnswer({ address, recipient: u, refundTo: u, ...o }), s.store);
    assert.equal(code(await s.carry.carry(signedIntent(u, transfer(address)))), "not_helper_quote", JSON.stringify(o));
  }
  s.store.close();
});

test("a registration claimed but never signed (the process stopped between the claim and the signing) is free again after a restart", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.store.putSigner({ signer: u, failed: 0, registration: { receiver: "fresh.near", state: "pending", tx: null } });
  s.store.close();
  const t = setup({ dir: s.dir });
  t.chain.storage.set(`${USDC}/fresh.near`, "null");
  assert.equal(code(await t.carry.carry(signedIntent(u, withdraw("fresh.near")))), "sent");
  await t.carry.idle();
  assert.deepEqual(t.r.sent.map((x) => x.action.method), ["storage_deposit", "execute_intents"]);
  t.store.close();
});

test("a simulation that executed no intent is simulation_refused", async () => {
  const s = setup({ chain: { executed: 0 } });
  const u = hex();
  await seeSigner(s.store, u);
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("alice.near")))), "simulation_refused");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("a storage_deposit whose send throws after it was signed is never freed for a second one: read again until its outcome is known", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const send = s.r.send.bind(s.r);
  s.r.send = (async (action, guard, before, opts) => {
    await send(action, guard, before, opts);
    if ((action as { method?: string }).method === "storage_deposit") throw new Error("broadcast threw");
    return { kind: "unknown", tx_hash: "x", why: "sent" };
  }) as typeof s.r.send;
  s.r.resolve = (async () => ({ kind: "final", tx_hash: "x", receipts: [{ executor: USDC, ok: true, failure: "", height: 1n }] })) as typeof s.r.resolve;
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "sent");
  await s.carry.idle();
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["storage_deposit", "execute_intents"], "one storage_deposit, then the intent");
  assert.equal(s.store.signer(u).registration?.state, "landed");
  s.store.close();
});

// ---- the review's folds (H1, L3, L4, L5, L7) and the cases it found unpinned ----

test("H1: a signer's sends 1-4 are carried, landed or not, and its 5th is signer_cap (429), kept across a restart", async () => {
  assert.equal(INTENTS_SENDS_MAX, 4);
  assert.equal(SIGNER_CAP_STATUS, 429);
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  for (let k = 0; k < 4; k++) {
    assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("alice.near")))), "sent", `send ${k + 1}`);
    await s.carry.idle();
  }
  assert.equal(s.r.sent.length, 4);
  s.store.close();
  const t = setup({ dir: s.dir });
  const a = await t.carry.carry(signedIntent(u, withdraw("alice.near")));
  assert.deepEqual([a.status, code(a)], [429, "signer_cap"]);
  assert.equal(t.r.sent.length, 0);
  assert.equal(t.chain.sims ?? 0, 0, "refused before the simulation: no simulate_intents read");
  t.store.close();
});

test("H1: the caps bound one signer's cost: 2 storage_deposit (its own, one receiver's) and 3 execute_intents, the receiver's taking a slot under INTENTS_SENDS_MAX (P1 fold), whatever it sends", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  // its own registration reads registered once it ran; the receivers' do not
  const reg = s.r.send;
  s.r.send = async (a, g, b, ...rest) => {
    const out = await reg(a, g, b, ...rest);
    if (a.kind === "call" && a.method === "storage_deposit" && JSON.parse(a.args).account_id === u) s.chain.storage.set(`${USDC}/${u}`, "registered");
    return out;
  };
  for (let k = 0; k < 8; k++) {
    s.chain.storage.set(`${USDC}/fresh${k}.near`, "null");
    await s.carry.carry(signedIntent(u, withdraw(`fresh${k}.near`)));
    await s.carry.carry(signedIntent(u, withdraw("alice.near")));
    await s.carry.idle();
  }
  const m = s.r.sent.map((x) => x.action.method);
  assert.equal(m.filter((x) => x === "storage_deposit").length, 2);
  assert.equal(m.filter((x) => x === "execute_intents").length, INTENTS_SENDS_MAX - 1);
  assert.equal(s.store.signer(u).sent, INTENTS_SENDS_MAX, "the receiver's registration and the intents, under one cap");
  s.store.close();
});

test("H1: at the intents floor (1 NEAR above the deposits') /v1/intents answers relayer_low, while the deposits' floor still passes", async () => {
  assert.equal(INTENTS_FLOOR_YOCTO - RELAYER_FLOOR_YOCTO, 10n ** 24n);
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.r.funds = INTENTS_FLOOR_YOCTO - 1n;
  const a = await s.carry.carry(signedIntent(u, withdraw("alice.near")));
  assert.deepEqual([a.status, code(a)], [503, "relayer_low"]);
  // /v1/bind's own check (bind/send.ts carryDeposit step 1: relayer_low only under RELAYER_FLOOR_YOCTO) passes here
  assert.ok(!(s.r.funds < RELAYER_FLOOR_YOCTO), "a deposit is still carried at this balance");
  // and a registration needs its 0.00125 N above the intents floor
  s.r.funds = INTENTS_FLOOR_YOCTO + REGISTRATION_YOCTO - 1n;
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "relayer_low");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("L3: a registration that takes until the intent's deadline: expired, and no execute_intents goes out", async () => {
  const s = setup({
    outcome: (a) => {
      if (a.method === "storage_deposit") {
        s.chain.finalMs = Date.parse("2026-11-07T18:02:00.000Z"); // the chain reached the deadline meanwhile
        s.chain.storage.set(`${USDC}/fresh.near`, "registered");
      }
      return "ran";
    },
  });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "expired");
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["storage_deposit"]);
  s.store.close();
});

test("L4: a helper-quoted address whose quote's recipient is the vault, or intents.near: receiver_is_vault", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  for (const recipient of [VAULT, "intents.near"]) {
    const to = await moveQuote(s.store, { refundTo: u, recipient });
    const a = await s.carry.carry(signedIntent(u, transfer(to)));
    assert.deepEqual([a.status, code(a)], [403, "receiver_is_vault"], recipient);
  }
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("L5: only a 64-hex one-time id is seen: a named account a delivery or refund went to is not; the arming account A a withdrawal landed to is", async () => {
  const s = setup();
  for (const status of ["SUCCESS", "REFUNDED"] as const) {
    const q = quoteAnswer({ address: hex(), recipient: "alice.near", refundTo: "alice.near" });
    await onQuoteAnswer(q, s.store);
    assert.equal(onStatusAnswer(statusAnswer(status, q), s.store), null);
  }
  assert.equal(s.store.seen("alice.near"), false);
  assert.equal(onArmed("alice.near", s.store), null);
  const a = hex();
  assert.equal(onArmed(a, s.store), a);
  const v = await s.carry.carry(signedIntent(a, withdraw(VAULT)));
  assert.equal(code(v), "receiver_is_vault", "A passes the gate");
  s.store.close();
});

test("L7: a quote record is written off the event loop and durable; records past QUOTE_KEEP_MS are swept on the store's timer, not only at its open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-prune-"));
  let now = NOW;
  const store = createIntentsStore(dir, undefined, () => now, 20);
  const old = hex();
  const p = onQuoteAnswer(quoteAnswer({ address: old, recipient: hex(), refundTo: hex() }), store);
  assert.ok(p instanceof Promise, "the write is a promise: the proxy's answer never waits on its fsyncs");
  assert.ok(await p);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith(".tmp-")).length, 0, "no temp left");
  assert.notEqual(store.quote(old), null);
  now = NOW + QUOTE_KEEP_MS + 3_600_000;
  for (let k = 0; k < 50 && store.quote(old) !== null; k++) await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(store.quote(old), null, "swept by the timer while open");
  assert.equal(await store.prune(), 0);
  store.close();
});

test("two registrations at once for one signer, to two receivers: one storage_deposit, the other receiver_not_registered or in_flight", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/one.near`, "null");
  s.chain.storage.set(`${USDC}/two.near`, "null");
  const [a, b] = await Promise.all([s.carry.carry(signedIntent(u, withdraw("one.near"))), s.carry.carry(signedIntent(u, withdraw("two.near")))]);
  await s.carry.idle();
  const codes = [code(a), code(b)].sort();
  assert.equal(codes.filter((c) => c === "sent").length, 1, JSON.stringify(codes));
  assert.ok(codes.includes("receiver_not_registered") || codes.includes("in_flight"), JSON.stringify(codes));
  assert.equal(s.r.sent.filter((x) => x.action.method === "storage_deposit").length, 1);
  s.store.close();
});

test("expiry reads the newer of the two final block times", async () => {
  const s = setup({ chain: { finalMsOf: [NOW, Date.parse("2026-11-07T18:02:00.000Z")] } });
  const u = hex();
  await seeSigner(s.store, u);
  // ahead of one provider's final time, not of the other's: expired
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("alice.near")))), "expired");
  s.chain.finalMsOf = [Date.parse("2026-11-07T18:02:00.000Z"), NOW];
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("alice.near")))), "expired");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("an escape in any string of the payload is bad_shape: the payload must be its own JSON written back", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  const good = signedIntent(u, withdraw("alice.near"));
  const pairs: [string, string][] = [
    ['"receiver_id":"alice.near"', '"receiver_id":"\\u0061lice.near"'],
    ['"intent":"ft_withdraw"', '"intent":"ft\\u005fwithdraw"'],
    ['"verifying_contract":"intents.near"', '"verifying_contract":"intents\\u002enear"'],
  ];
  for (const [from, to] of pairs) {
    const b = structuredClone(good);
    b.signed_intent.payload = b.signed_intent.payload.replace(from, to);
    assert.ok(b.signed_intent.payload.includes("\\u00"), "an escape is in the payload");
    assert.deepEqual(JSON.parse(b.signed_intent.payload), JSON.parse(good.signed_intent.payload), "the same intent once read");
    assert.equal(code(await s.carry.carry(b)), "bad_shape", to);
  }
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

// ---- card intents-u-registered-first: every signer registered on USDC before its first intent ----

/** The relayer's storage_deposit that ran registers its account on the chain both providers read. */
const registersOn = (chain: () => Chain) => (a: Extract<RelayerAction, { kind: "call" }>) => {
  if (a.method === "storage_deposit") chain().storage.set(`${a.receiver}/${JSON.parse(a.args).account_id}`, "registered");
  return "ran" as const;
};

test("U registered first: the first intent of an unregistered U sends storage_deposit for U on USDC first; its second, even after a restart, sends none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  let chain!: Chain;
  const s = setup({ dir, outcome: registersOn(() => chain) });
  chain = s.chain;
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const to = await moveQuote(s.store, { refundTo: u, recipient: u });
  assert.equal(code(await s.carry.carry(signedIntent(u, transfer(to)))), "sent");
  await s.carry.idle();
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["storage_deposit", "execute_intents"]);
  const reg = s.r.sent[0]!.action;
  assert.equal(reg.receiver, USDC);
  assert.deepEqual(JSON.parse(reg.args), { account_id: u, registration_only: true });
  assert.equal(reg.deposit, REGISTRATION_YOCTO);
  assert.equal(s.store.signer(u).own?.read, true, "kept as read once it reads registered on both providers (review PROBE-1, PROBE-4)");
  assert.equal(s.store.owed(u), null, "nothing left owed");
  assert.equal(s.store.signer(u).registration, null, "its own is not the one paid receiver");
  // the second intent, from a restarted helper (no memory of this process): the chain reads U registered
  s.store.close();
  const store = createIntentsStore(dir, undefined, () => NOW);
  const r2 = relayer(() => "ran");
  const carry2 = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(chain), () => NOW), relayer: r2, held: async () => chain.paused === true, now: () => NOW, resolveEveryMs: 1 });
  assert.equal(code(await carry2.carry(signedIntent(u, withdraw("alice.near")))), "sent");
  await carry2.idle();
  assert.deepEqual(r2.sent.map((x) => x.action.method), ["execute_intents"], "no second storage_deposit");
  store.close();
});

test("U registered first: an ft_withdraw from an unregistered U to an unregistered receiver pays U's own, then the receiver's, then the intent; to U itself, one", async () => {
  let chain!: Chain;
  const s = setup({ outcome: registersOn(() => chain) });
  chain = s.chain;
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "sent");
  await s.carry.idle();
  assert.deepEqual(
    s.r.sent.map((x) => [x.action.method, x.action.method === "storage_deposit" ? JSON.parse(x.action.args).account_id : x.action.receiver]),
    [["storage_deposit", u], ["storage_deposit", "fresh.near"], ["execute_intents", "intents.near"]],
  );
  const v = hex();
  await seeSigner(s.store, v);
  s.chain.storage.set(`${USDC}/${v}`, "null");
  const n = s.r.sent.length;
  assert.equal(code(await s.carry.carry(signedIntent(v, withdraw(v)))), "sent");
  await s.carry.idle();
  assert.deepEqual(s.r.sent.slice(n).map((x) => x.action.method), ["storage_deposit", "execute_intents"], "its own registration covers itself as the receiver");
  assert.equal(s.store.signer(v).registration, null);
  s.store.close();
});

test("U registered first: its registration failing is registration_failed with no intent sent, never counted, and waits its backoff; its gate refusals send no storage_deposit", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "failed" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const to = await moveQuote(s.store, { refundTo: u, recipient: u });
  assert.equal(code(await s.carry.carry(signedIntent(u, transfer(to)))), "registration_failed");
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["storage_deposit"]);
  assert.equal(s.store.signer(u).failed, 0, "never a strike");
  assert.equal(s.store.signer(u).own, null, "free again");
  assert.deepEqual(s.store.owed(u), { signer: u, tries: 1, next_ms: NOW + 2 * SWEEP_MS }, "owed, its next try after the backoff");
  // within the backoff: nothing sent
  assert.equal(code(await s.carry.carry(signedIntent(u, transfer(to)))), "in_flight");
  assert.equal(s.r.sent.length, 1);
  // a signer never seen, and an intent the simulation refuses: nothing paid
  const w = hex();
  s.chain.storage.set(`${USDC}/${w}`, "null");
  assert.equal(code(await s.carry.carry(signedIntent(w, transfer(to)))), "id_not_ours");
  s.chain.refuseSimulateOn = 1;
  s.clock.ms = NOW + 2 * SWEEP_MS;
  assert.equal(code(await s.carry.carry(signedIntent(u, transfer(to)))), "simulation_refused");
  assert.equal(s.r.sent.length, 1);
  s.store.close();
});

test("U registered first: registerSeen (a status answer showed U money) registers a seen U once, before any intent; never an unseen one", async () => {
  let chain!: Chain;
  const s = setup({ outcome: registersOn(() => chain) });
  chain = s.chain;
  const u = hex();
  s.chain.storage.set(`${USDC}/${u}`, "null");
  assert.equal(await s.carry.registerSeen(u), "id_not_ours", "not seen yet");
  assert.equal(s.r.sent.length, 0);
  await seeSigner(s.store, u);
  const [a, b] = await Promise.all([s.carry.registerSeen(u), s.carry.registerSeen(u)]);
  assert.deepEqual([a, b].sort(), ["in_flight", "registered"], "two polls at once: one storage_deposit");
  const readsBefore = s.chain.storageReads ?? 0;
  assert.equal(await s.carry.registerSeen(u), "registered");
  assert.equal(s.chain.storageReads ?? 0, readsBefore, "a signer read registered here is never read again: a device's polls cost no RPC read");
  assert.deepEqual(s.r.sent.map((x) => [x.action.method, JSON.parse(x.action.args).account_id]), [["storage_deposit", u]]);
  // its first intent then sends no second one
  const to = await moveQuote(s.store, { refundTo: u, recipient: u });
  assert.equal(code(await s.carry.carry(signedIntent(u, transfer(to)))), "sent");
  await s.carry.idle();
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["storage_deposit", "execute_intents"]);
  // a seen signer already registered on USDC (1Click delivered to it on the token): read, nothing sent
  const v = hex();
  await seeSigner(s.store, v);
  assert.equal(await s.carry.registerSeen(v), "registered");
  assert.equal(s.r.sent.length, 2);
  s.store.close();
});

// ---- review FIX of f2292e77 (F1, F2, F4, surviving mutants) ----

/** USDC as the token runs it: storage_deposit refuses while paused (fiat_token.rs:839), else registers its account. */
const usdcOn = (chain: () => Chain) => (a: Extract<RelayerAction, { kind: "call" }>) => {
  if (a.method !== "storage_deposit") return "ran" as const;
  if (chain().paused === true) return "failed" as const;
  chain().storage.set(`${a.receiver}/${JSON.parse(a.args).account_id}`, "registered");
  return "ran" as const;
};

test("F1: while USDC is paused a seen U's registration sends nothing (in_flight), never strikes it; once unpaused it registers and its intent is carried", async () => {
  let chain!: Chain;
  const s = setup({ outcome: usdcOn(() => chain) });
  chain = s.chain;
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  s.chain.paused = true;
  // a 3-minute pause: the device's REFUNDED polls, and the sweep, each try
  for (let k = 0; k < 4; k++) {
    assert.equal(await s.carry.registerSeen(u), "in_flight", `poll ${k}`);
    s.clock.ms += 45_000;
    await s.carry.sweep();
  }
  assert.equal(s.r.sent.length, 0, "no storage_deposit while it holds");
  assert.equal(s.store.signer(u).failed, 0, "never struck");
  // an unregistered signer's intent under the halt (any id: U, R or V): in_flight, nothing sent
  const to = await moveQuote(s.store, { refundTo: u, recipient: u });
  assert.equal(code(await s.carry.carry(signedIntent(u, transfer(to)))), "in_flight");
  assert.equal(s.r.sent.length, 0);
  s.chain.paused = false;
  await s.carry.sweep();
  assert.deepEqual(s.r.sent.map((x) => [x.action.method, JSON.parse(x.action.args).account_id]), [["storage_deposit", u]]);
  assert.equal(await s.carry.registerSeen(u), "registered");
  assert.equal(code(await s.carry.carry(signedIntent(u, transfer(to)))), "sent");
  await s.carry.idle();
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["storage_deposit", "execute_intents"]);
  s.store.close();
});

test("F1: an ft_withdraw to an unregistered receiver under the halt: in_flight, no storage_deposit for it either", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u); // U itself reads registered
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  s.chain.paused = true;
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "in_flight");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("F2: one failed try is never final while U is seen: it is owed at first sight, and the helper's own sweep registers it after its backoff, across a restart, with no device poll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  let fail = true;
  let chain!: Chain;
  const s = setup({ dir, outcome: (a) => (fail && a.method === "storage_deposit" ? "failed" : usdcOn(() => chain)(a)) });
  chain = s.chain;
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  // the one poll the device makes (its op then ends held under_min, or 1Click stops answering)
  assert.equal(await s.carry.registerSeen(u), "registration_failed");
  assert.equal(s.store.owed(u)?.tries, 1, "owed, kept apart from the quote records");
  assert.equal(s.store.signer(u).failed, 0);
  fail = false;
  await s.carry.sweep();
  assert.equal(s.r.sent.length, 1, "within its backoff the sweep sends nothing");
  // a restart: the owed record is read back; the sweep tries it once due
  s.store.close();
  const store = createIntentsStore(dir, undefined, () => NOW);
  const r2 = relayer(usdcOn(() => chain));
  const clock = { ms: NOW + 2 * SWEEP_MS };
  const c2 = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(chain), () => NOW), relayer: r2, held: async () => false, now: () => clock.ms, resolveEveryMs: 1 });
  assert.deepEqual(store.owing().map((o) => o.signer), [u]);
  await c2.sweep();
  assert.deepEqual(r2.sent.map((x) => [x.action.method, JSON.parse(x.action.args).account_id]), [["storage_deposit", u]]);
  assert.equal(store.owed(u), null, "registered: owed no more");
  assert.equal(chain.storage.get(`${USDC}/${u}`), "registered");
  // a signer seen with no money shown (not seen): never owed, never paid
  const w = hex();
  assert.equal(await c2.registerSeen(w), "id_not_ours");
  assert.equal(store.owed(w), null);
  store.close();
});

test("F2: the sweep's pace backs off on each failure (doubling, capped) and sends nothing in between", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "failed" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const sends: number[] = [];
  for (let m = 0; m < 40 * 60; m++) {
    s.clock.ms = NOW + m * 60_000;
    await s.carry.sweep();
    if (m === 0) assert.equal(s.store.owed(u), null, "the sweep reads only owed signers");
    if (m === 0) await s.carry.registerSeen(u);
    sends.push(s.r.sent.length);
  }
  // first sight, then 2, 4, 8, 16, 32 minutes... (about 11 tries over 40 h, never one a minute)
  const tries = s.r.sent.length;
  assert.ok(tries >= 9 && tries <= 12, `tries ${tries}`);
  assert.ok((s.store.owed(u)?.next_ms ?? 0) - s.clock.ms <= 24 * 3_600_000);
  assert.equal(s.store.signer(u).failed, 0);
  s.store.close();
});

test("F4: a registration read as ran that does not read registered on both providers is no landing: in_flight, never a second payment within OWN_SETTLE_MS (a restart included); after it a failure, one new one after its backoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  let chain!: Chain;
  let lie = true;
  // a lying lookup: the first storage_deposit reads ran, but USDC never registered U
  const s = setup({ dir, outcome: (a) => (a.method === "storage_deposit" && lie ? "ran" : usdcOn(() => chain)(a)) });
  chain = s.chain;
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  assert.equal(await s.carry.registerSeen(u), "in_flight");
  assert.equal(s.r.sent.length, 1);
  assert.equal(await s.carry.registerSeen(u), "in_flight");
  assert.equal(s.r.sent.length, 1, "no second payment while it may still read");
  // M15: a restart within OWN_SETTLE_MS never pays twice
  s.store.close();
  const store = createIntentsStore(dir, undefined, () => NOW);
  const r2 = relayer(() => "ran");
  // the restarted helper reads the earlier tx as ran (r2 holds no outcome of it: resolve it as ran)
  r2.resolve = async (tx: TxRef) => ({ kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: USDC, ok: true, failure: "", height: 1n }] });
  lie = false;
  const clock = { ms: NOW + 1_000 };
  const c2 = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(chain), () => NOW), relayer: { ...r2, send: async (...a) => { const o = await s.r.send(...a); r2.sent.push(s.r.sent.at(-1)!); return o; } }, held: async () => false, now: () => clock.ms, resolveEveryMs: 1 });
  assert.equal(await c2.registerSeen(u), "in_flight");
  await c2.sweep();
  assert.equal(r2.sent.length, 0, "after a restart, within the settle time: nothing sent");
  // delta review F1: past the settle time a ran one still unregistered is a failure for the backoff, never paid at once
  clock.ms = NOW + 1_000 + OWN_SETTLE_MS + 1;
  assert.equal(await c2.registerSeen(u), "registration_failed");
  assert.equal(r2.sent.length, 0, "past the settle time: no payment before the backoff step");
  assert.deepEqual(store.owed(u), { signer: u, tries: 1, next_ms: clock.ms + 2 * SWEEP_MS });
  assert.equal(store.signer(u).failed, 0, "never a strike");
  clock.ms += 2 * SWEEP_MS;
  assert.equal(await c2.registerSeen(u), "registered");
  assert.deepEqual(r2.sent.map((x) => x.action.method), ["storage_deposit"], "one new one, after its backoff step");
  assert.equal(store.signer(u).own?.read, true);
  assert.equal(store.owed(u), null);
  store.close();
});

test("M14: after a restart, U's own registration whose tx is not read yet (unknown) sends nothing, past the settle time too; once it reads dropped, one new one goes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  const s = setup({ dir });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  // the helper died after its tx was written and sent, before its outcome was read
  s.store.putSigner({ ...s.store.signer(u), own: { receiver: u, state: "pending", tx: { tx_hash: "earlier", nonce: "1", height: "221603850", block_hash: base58(Buffer.alloc(32, 7)), signed_tx: "" } } });
  s.store.close();
  const store = createIntentsStore(dir, undefined, () => NOW);
  const r2 = relayer(usdcOn(() => s.chain));
  let earlier: "unknown" | "dropped" = "unknown";
  r2.resolve = async (tx: TxRef) => (tx.tx_hash === "earlier" ? { kind: earlier, tx_hash: tx.tx_hash, why: "not read yet" } : { kind: "unknown", tx_hash: tx.tx_hash, why: "x" });
  const clock = { ms: NOW + OWN_SETTLE_MS + 1 };
  const c2 = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(s.chain), () => NOW), relayer: r2, held: async () => false, now: () => clock.ms, resolveEveryMs: 1 });
  assert.equal(await c2.registerSeen(u), "in_flight");
  await c2.sweep();
  assert.equal(r2.sent.length, 0, "an unread tx may still land: never paid twice");
  earlier = "dropped";
  clock.ms += 10 * SWEEP_MS;
  assert.equal(await c2.registerSeen(u), "registered");
  assert.deepEqual(r2.sent.map((x) => x.action.method), ["storage_deposit"], "the dropped one replaced by one new one");
  store.close();
});

// the reviewer's probe (delta review F1), ported: each registration runs, then U's owner unregisters it (or a provider
// reports a final behind it), so U reads null on both after every landing
test("delta review F1: U's owner unregisters U after each landing: over 60 minutes of sweeps at most 5 storage_deposits, each one backoff step after the last, never a strike", async () => {
  const s = setup({ outcome: () => "ran" }); // every storage_deposit runs; U's storage stays null
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const paidAt: number[] = [];
  const send = s.r.send;
  s.r.send = async (...a) => (paidAt.push(s.clock.ms), send(...a));
  await s.carry.registerSeen(u);
  for (let m = 1; m <= 60; m++) {
    s.clock.ms = NOW + m * 60_000;
    await s.carry.sweep();
  }
  assert.ok(paidAt.length >= 2 && paidAt.length <= 5, `${paidAt.length} storage_deposits in 60 min`);
  for (let k = 1; k < paidAt.length; k++) assert.ok(paidAt[k]! - paidAt[k - 1]! >= OWN_SETTLE_MS + SWEEP_MS * 2 ** k, `pay ${k + 1} waited its backoff step`);
  assert.ok(s.store.owed(u)!.tries >= paidAt.length - 1, "each ran-but-unregistered landing is a try");
  assert.equal(s.store.signer(u).failed, 0);
  s.store.close();
});

test("H1 (moving clock): a U that never reads registered is paid once per backoff step, whatever it sends: no intent carried, at most 5 storage_deposits in 60 minutes", async () => {
  const s = setup({ outcome: () => "ran" }); // every storage_deposit's lookup reads ran; U's storage stays null
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  for (let m = 0; m < 60; m++) {
    s.clock.ms = NOW + m * 60_000;
    await s.carry.carry(signedIntent(u, withdraw("alice.near")));
    await s.carry.carry(signedIntent(u, withdraw("alice.near")));
    await s.carry.idle();
    await s.carry.sweep();
  }
  const m = s.r.sent.map((x) => x.action.method);
  assert.equal(m.filter((x) => x === "execute_intents").length, 0, "nothing carried for an unregistered U");
  const own = m.filter((x) => x === "storage_deposit").length;
  assert.ok(own >= 2 && own <= 5, `${own} storage_deposits in 60 min`);
  assert.equal(s.store.signer(u).failed, 0);
  s.store.close();
});

test("delta review F3: a claim written but never broadcast (a crash after before()), then a restart: the same signed bytes go out once, never while the token is held; no new registration is signed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  const s = setup({ dir });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const claimed: TxRef = { tx_hash: base58(randomBytes(32)), nonce: "9", height: "221603850", block_hash: base58(Buffer.alloc(32, 7)), signed_tx: "c2lnbmVk" };
  s.store.putSigner({ ...s.store.signer(u), own: { receiver: u, state: "pending", tx: claimed } });
  s.store.close();
  const store = createIntentsStore(dir, undefined, () => NOW);
  const chain = s.chain;
  const r2 = relayer(() => "ran");
  const resent: string[] = [];
  const resends: boolean[] = [];
  r2.resolve = async (tx: TxRef, o: { resend: boolean }) => {
    resends.push(o.resend);
    if (!o.resend || resent.length > 0) return resent.includes(tx.tx_hash) ? { kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: USDC, ok: true, failure: "", height: 1n }] } : { kind: "unknown", tx_hash: tx.tx_hash, why: "not found" };
    resent.push(tx.tx_hash); // the same bytes broadcast; they land
    chain.storage.set(`${USDC}/${u}`, "registered");
    return { kind: "unknown", tx_hash: tx.tx_hash, why: "sent again" };
  };
  const clock = { ms: NOW + 1_000 };
  const c2 = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(chain), () => NOW), relayer: r2, held: async () => chain.paused === true, now: () => clock.ms, resolveEveryMs: 1 });
  chain.paused = true;
  assert.equal(await c2.registerSeen(u), "in_flight");
  await c2.sweep();
  assert.deepEqual([resent, resends.every((x) => x === false)], [[], true], "held: read only, never sent again");
  chain.paused = false;
  assert.equal(await c2.registerSeen(u), "in_flight");
  assert.deepEqual(resent, [claimed.tx_hash], "the claimed bytes sent again once");
  assert.equal(await c2.registerSeen(u), "registered");
  assert.deepEqual(resent, [claimed.tx_hash], "once only");
  assert.equal(r2.sent.length, 0, "no new registration signed");
  store.close();
});

test("delta review F3 (every path): a receiver's registration claimed but never broadcast is sent again once after a restart, never while held, then the intent is carried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  const s = setup({ dir });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const claimed: TxRef = { tx_hash: base58(randomBytes(32)), nonce: "9", height: "221603850", block_hash: base58(Buffer.alloc(32, 7)), signed_tx: "c2lnbmVk" };
  s.store.putSigner({ ...s.store.signer(u), registration: { receiver: "fresh.near", state: "pending", tx: claimed } });
  s.store.close();
  const store = createIntentsStore(dir, undefined, () => NOW);
  const chain = s.chain;
  const r2 = relayer(() => "ran");
  const resent: string[] = [];
  r2.resolve = async (tx: TxRef, o: { resend: boolean }) => {
    if (tx.tx_hash !== claimed.tx_hash) return { kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: "intents.near", ok: true, failure: "", height: 1n }] };
    if (o.resend && resent.length === 0) {
      resent.push(tx.tx_hash);
      chain.storage.set(`${USDC}/fresh.near`, "registered");
    }
    return resent.length > 0 ? { kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: USDC, ok: true, failure: "", height: 1n }] } : { kind: "unknown", tx_hash: tx.tx_hash, why: "not found" };
  };
  const c2 = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(chain), () => NOW), relayer: r2, held: async () => chain.paused === true, now: () => NOW, resolveEveryMs: 1 });
  chain.paused = true;
  const a = await c2.carry(signedIntent(u, withdraw("fresh.near")));
  assert.equal(code(a), "in_flight");
  assert.deepEqual(resent, [], "held: never sent again");
  chain.paused = false;
  const b = await c2.carry(signedIntent(u, withdraw("fresh.near")));
  await c2.idle();
  assert.deepEqual(resent, [claimed.tx_hash], "the claimed bytes sent again once");
  assert.equal(code(b), "sent");
  assert.deepEqual(r2.sent.map((x) => x.action.method), ["execute_intents"], "no new registration; the intent carried");
  store.close();
});

test("a struck signer gets no registration from registerSeen or the sweep, and is owed no more", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  s.store.owe({ signer: u, tries: 0, next_ms: 0 });
  s.store.putSigner({ ...s.store.signer(u), failed: 3 });
  assert.equal(await s.carry.registerSeen(u), "sender_struck");
  await s.carry.sweep();
  assert.equal(s.r.sent.length, 0);
  assert.equal(s.store.owed(u), null);
  s.store.close();
});

// ---- the P1 fold (owner 8 Nov 20:25Z): one lying or broken provider never makes the helper pay at once or unbounded ----
const earlierTx = (): TxRef => ({ tx_hash: base58(randomBytes(32)), nonce: "9", height: "221603850", block_hash: base58(Buffer.alloc(32, 7)), signed_tx: "c2lnbmVk" });
const failedFinal = (tx: TxRef): TxOutcome => ({ kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: USDC, ok: false, failure: '{"Failure":"x"}', height: 1n }] });

test("P1 (own): an earlier registration one lookup reads failed is never paid again at once: the hold freed, registration_failed, the backoff; after it, both providers read U registered and nothing is paid", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const tx = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), own: { receiver: u, state: "pending", tx } });
  const resolve = s.r.resolve;
  // a lying lookup: the registration landed, one provider's lookup says it failed
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => (t.tx_hash === tx.tx_hash ? failedFinal(t) : resolve(t, o));
  assert.equal(await s.carry.registerSeen(u), "registration_failed");
  assert.equal(s.r.sent.length, 0, "no second payment on one lookup's word");
  assert.equal(s.store.signer(u).own ?? null, null, "the hold freed");
  assert.deepEqual(s.store.owed(u), { signer: u, tries: 1, next_ms: NOW + 2 * SWEEP_MS });
  assert.equal(s.store.signer(u).failed, 0, "never a strike");
  // the device's intent within the backoff: nothing paid either
  const to = await moveQuote(s.store, { refundTo: u, recipient: u });
  assert.equal(code(await s.carry.carry(signedIntent(u, transfer(to)))), "in_flight");
  assert.equal(s.r.sent.length, 0);
  // the truth reads on both providers: U registered; the sweep after the backoff pays nothing
  s.chain.storage.set(`${USDC}/${u}`, "registered");
  s.clock.ms = NOW + 2 * SWEEP_MS;
  await s.carry.sweep();
  assert.equal(s.r.sent.length, 0);
  assert.equal(s.store.owed(u), null, "read registered: owed no more");
  s.store.close();
});

test("P1 (receiver): an earlier receiver registration one lookup reads failed is never paid again at once: registration_failed, no storage_deposit; once both read it registered, the intent goes with none", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const tx = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), registration: { receiver: "fresh.near", state: "pending", tx } });
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => (t.tx_hash === tx.tx_hash ? failedFinal(t) : resolve(t, o));
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "registration_failed");
  assert.equal(s.r.sent.length, 0, "no second payment on one lookup's word");
  assert.equal(s.store.signer(u).registration, null, "the hold freed");
  s.chain.storage.set(`${USDC}/fresh.near`, "registered");
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "sent");
  await s.carry.idle();
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["execute_intents"]);
  s.store.close();
});

test("P1 (bound): a receiver registration every lookup reads failed takes a slot under INTENTS_SENDS_MAX each time, one kept for the intent: at most INTENTS_SENDS_MAX - 1 paid, then signer_cap", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "failed" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const codes: string[] = [];
  for (let k = 0; k < 10; k++) codes.push(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))));
  const regs = s.r.sent.filter((x) => x.action.method === "storage_deposit").length;
  assert.equal(regs, INTENTS_SENDS_MAX - 1, `${regs} receiver registrations paid`);
  assert.deepEqual(codes.slice(INTENTS_SENDS_MAX - 1), Array(10 - INTENTS_SENDS_MAX + 1).fill("signer_cap"));
  assert.equal(s.store.signer(u).failed, 0, "never a strike");
  // the slot kept for the intent: one to a registered account still goes, then the cap
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("alice.near")))), "sent");
  await s.carry.idle();
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("alice.near")))), "signer_cap");
  assert.equal(s.r.sent.length, INTENTS_SENDS_MAX);
  s.store.close();
});

test("P1 (hold, settle): a registration's outcome read while the token watch holds never sends its bytes again", async () => {
  let release!: () => void;
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  release = s.r.release;
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const send = s.r.send;
  s.r.send = async (...a) => {
    const o = await send(...a);
    s.chain.paused = true; // the hold starts once the registration is out
    return o;
  };
  const resends: boolean[] = [];
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    resends.push(o.resend);
    if (resends.length === 5) {
      s.chain.storage.set(`${USDC}/${u}`, "registered");
      release();
    }
    return resolve(t, o);
  };
  await s.carry.registerSeen(u);
  assert.ok(resends.length >= 5, `${resends.length} reads`);
  assert.deepEqual(resends.filter((x) => x), [], "never sent again while held");
  assert.equal(s.r.sent.length, 1);
  s.store.close();
});

test("P1 (hold, guard): a hold that starts between the endpoint's reads and the relayer's queue signs no registration, U's own or a receiver's; the claim and the slot freed, no backoff", async () => {
  const s: ReturnType<typeof setup> = setup({ outcome: (a) => usdcOn(() => s.chain)(a) });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const funds = s.r.funds;
  // the hold starts while the gas account's balance is read, after any check before the queue
  s.r.balance = async () => ((s.chain.paused = true), funds);
  assert.equal(await s.carry.registerSeen(u), "in_flight");
  assert.equal(s.r.sent.length, 0, "nothing signed while held");
  assert.equal(s.store.signer(u).own ?? null, null, "the claim freed");
  assert.deepEqual(s.store.owed(u), { signer: u, tries: 0, next_ms: 0 }, "no backoff: nothing failed");
  s.chain.paused = false;
  s.r.balance = async () => funds;
  assert.equal(await s.carry.registerSeen(u), "registered");
  assert.equal(s.r.sent.length, 1);
  // a receiver's
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  s.r.balance = async () => ((s.chain.paused = true), funds);
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "in_flight");
  assert.equal(s.r.sent.length, 1, "nothing signed while held");
  assert.equal(s.store.signer(u).registration, null, "the claim freed");
  assert.equal(s.store.signer(u).sent ?? 0, 0, "its slot given back: nothing was signed");
  s.store.close();
});

// ---- the fresh review of a9e9a898 (its probes PROBE-1 to PROBE-7, ported; and the survivors it named) ----
const gateP = () => {
  let open!: () => void;
  const p = new Promise<void>((ok) => (open = ok));
  return { p, open };
};

test("PROBE-1: a registerSeen waiting in its hold read while a second one registers U end to end never pays a second storage_deposit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  const store = createIntentsStore(dir, undefined, () => NOW);
  const chain: Chain = { refuseSimulateOn: null, storage: new Map(), finalMs: NOW };
  const r = relayer(registersOn(() => chain));
  const g = gateP();
  let heldCalls = 0;
  const carry = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(chain), () => NOW), relayer: r, held: async () => (++heldCalls === 1 && (await g.p), false), now: () => NOW, resolveEveryMs: 1 });
  const u = hex();
  await seeSigner(store, u);
  chain.storage.set(`${USDC}/${u}`, "null");
  const b = carry.registerSeen(u); // poll 1: its token-watch read answers late
  for (let i = 0; i < 100 && heldCalls === 0; i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(heldCalls, 1, "b waits in its hold read");
  assert.equal(await carry.registerSeen(u), "registered"); // poll 2 registers U end to end
  g.open();
  assert.equal(await b, "registered");
  assert.equal(r.sent.filter((x) => x.action.method === "storage_deposit").length, 1);
  store.close();
});

test("PROBE-2: a relayer send that throws before its signing is no failed try: no backoff, upstream, nothing signed", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  s.r.send = (async () => {
    throw new Error("relayer: the gas account's key is not a full-access key at final");
  }) as typeof s.r.send;
  const codes = new Set<string>();
  for (let k = 0; k < 12; k++) {
    s.clock.ms = Math.max(s.clock.ms, s.store.owed(u)?.next_ms ?? 0);
    codes.add(await s.carry.registerSeen(u));
  }
  assert.equal(s.r.sent.length, 0, "nothing ever signed");
  assert.deepEqual(s.store.owed(u), { signer: u, tries: 0, next_ms: 0 }, "no backoff charged");
  assert.deepEqual([...codes], ["upstream"]);
  assert.equal(s.store.signer(u).own ?? null, null, "the claim freed");
  s.store.close();
});

test("PROBE-3: the slot kept for a receiver registration's intent is reserved at its claim: a concurrent intent of the signer is signer_cap, the paid registration's intent is carried", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  for (let k = 0; k < 2; k++) {
    assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("alice.near")))), "sent");
    await s.carry.idle();
  }
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const x = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  for (let i = 0; i < 100 && !s.r.sent.some((t) => t.action.method === "storage_deposit"); i++) await new Promise((ok) => setTimeout(ok, 5));
  const y = await s.carry.carry(signedIntent(u, withdraw("alice.near")));
  assert.equal(code(y), "signer_cap", "the last slot is the registration's intent's");
  s.chain.storage.set(`${USDC}/fresh.near`, "registered");
  s.r.release();
  assert.equal(code(await x), "sent", "the paid registration's own intent");
  await s.carry.idle();
  const m = s.r.sent.map((t) => t.action.method);
  assert.deepEqual([m.filter((t) => t === "storage_deposit").length, m.filter((t) => t === "execute_intents").length], [1, 3]);
  assert.equal(s.store.signer(u).sent, INTENTS_SENDS_MAX);
  s.store.close();
});

test("PROBE-4: U read registered once is never paid again, after a restart too, even when it later reads unregistered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  const s = setup({ dir });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  assert.equal(await s.carry.registerSeen(u), "registered");
  s.chain.storage.set(`${USDC}/${u}`, "null"); // storage_unregister by U's owner
  assert.equal(await s.carry.registerSeen(u), "registered", "same process: never read again");
  s.store.close();
  const t = setup({ dir, chain: { storage: s.chain.storage } });
  assert.equal(await t.carry.registerSeen(u), "registered");
  await t.carry.sweep();
  assert.equal(t.r.sent.length, 0, "after a restart: nothing paid");
  t.store.close();
});

test("PROBE-5: a crash between a slot's take and its signing never leaks the slot: a receiver claim's and an intent's are given back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  const s = setup({ dir });
  const u = hex();
  await seeSigner(s.store, u);
  // what register() and step 11 write before relayer.send (the process then dies): a receiver claim with its two
  // slots and no tx, and an intent's slot in `taking`
  s.store.putSigner({ ...s.store.signer(u), sent: 3, taking: [nonce()], registration: { receiver: "fresh.near", state: "pending", tx: null, reserved: true } });
  s.store.close();
  const t = setup({ dir });
  t.chain.storage.set(`${USDC}/fresh.near`, "null");
  assert.equal(code(await t.carry.carry(signedIntent(u, withdraw("fresh.near")))), "sent");
  await t.carry.idle();
  assert.equal(t.store.signer(u).sent, t.r.sent.length, `sent ${t.store.signer(u).sent} for ${t.r.sent.length} signed`);
  assert.deepEqual(t.store.signer(u).taking, []);
  t.store.close();
});

test("PROBE-6: a U registered by anyone while its backoff runs reads so and its intent is carried; nothing is paid", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "failed" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.store.owe({ signer: u, tries: 10, next_ms: NOW + 12 * 3_600_000 });
  s.chain.storage.set(`${USDC}/${u}`, "registered"); // registered by another payer
  const to = await moveQuote(s.store, { refundTo: u, recipient: u });
  assert.equal(code(await s.carry.carry(signedIntent(u, transfer(to)))), "sent");
  await s.carry.idle();
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["execute_intents"]);
  assert.equal(s.store.owed(u), null, "owed no more");
  s.store.close();
});

test("PROBE-7: a receiver registration one lookup reads ran, while the receiver reads unregistered on both, is no landing: no intent goes to it", async () => {
  const s = setup({ outcome: () => "ran" }); // every lookup reads ran; the token never registers anyone
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "in_flight");
  await s.carry.idle();
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["storage_deposit"], "no execute_intents");
  assert.equal(s.store.signer(u).registration?.state, "pending", "never landed on one lookup's word");
  // a retry within the settle time: it may still read registered, so in flight, nothing paid
  s.clock.ms = NOW + 1_000;
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "in_flight");
  assert.equal(s.r.sent.length, 1);
  // past the settle time still unregistered: a failure, the reserved slot back, no strike; free for a new one
  s.clock.ms = NOW + OWN_SETTLE_MS + 1;
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near"), { deadline: "2026-11-07T18:10:00.000Z" }))), "registration_failed");
  assert.deepEqual([s.store.signer(u).registration, s.store.signer(u).sent, s.store.signer(u).failed], [null, 1, 0]);
  s.store.close();
});

test("survivor pins: a held receiver registration is refused before the balance read; a token watch that throws holds", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  let balances = 0;
  const balance = s.r.balance;
  s.r.balance = async () => (balances++, balance());
  s.chain.paused = true;
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "in_flight");
  assert.deepEqual([balances, s.r.sent.length], [0, 0], "held: no balance read, nothing signed");
  s.store.close();
  // a hold read that throws holds: nothing signed, no backoff
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  const store = createIntentsStore(dir, undefined, () => NOW);
  const chain: Chain = { refuseSimulateOn: null, storage: new Map(), finalMs: NOW };
  const r = relayer(registersOn(() => chain));
  const carry = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(chain), () => NOW), relayer: r, held: async () => { throw new Error("watch down"); }, now: () => NOW, resolveEveryMs: 1 });
  const w = hex();
  await seeSigner(store, w);
  chain.storage.set(`${USDC}/${w}`, "null");
  assert.equal(await carry.registerSeen(w), "in_flight");
  assert.equal(r.sent.length, 0);
  assert.deepEqual(store.owed(w), { signer: w, tries: 0, next_ms: 0 });
  store.close();
});

test("survivor pins: two intents at once to one unregistered receiver pay one storage_deposit; an ft_withdraw of another token to U itself is a receiver's (9b), never U's own", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const g = gateP();
  const send = s.r.send;
  let first = true;
  s.r.send = async (...a) => {
    if (first) {
      first = false;
      await g.p; // the first registration waits in the relayer's queue, its claim written, nothing signed yet
    }
    return send(...a);
  };
  const one = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  for (let i = 0; i < 100 && s.store.signer(u).registration === null; i++) await new Promise((ok) => setTimeout(ok, 5));
  const two = await s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  assert.equal(code(two), "in_flight", "the second waits on the first's claim");
  g.open();
  assert.equal(code(await one), "sent");
  await s.carry.idle();
  assert.equal(s.r.sent.filter((x) => x.action.method === "storage_deposit").length, 1);
  assert.equal(s.store.signer(u).sent, s.r.sent.length, "slots: the registration's and its intent's, as signed");
  // another token to U itself: U's own on USDC does not cover it; that token's registration is not ours to pay
  s.chain.storage.set(`other.near/${u}`, "null");
  const a = await s.carry.carry(signedIntent(u, { intent: "ft_withdraw", token: "other.near", receiver_id: u, amount: "5" }));
  assert.equal(code(a), "receiver_not_registered");
  s.store.close();
});

// ---- the delta review 3 of 46611eeb (its probes R3-1 to R3-6, ported): every write after an await is a compare-and-set on the
// registration it judged ----
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.ok(f(), "condition never reached");
};
const regsOf = (s: { r: { sent: Sent[] } }) => s.r.sent.filter((t) => t.action.method === "storage_deposit").length;
/** Intents to a registered account until the cap answers; the count carried. */
const fill = async (s: ReturnType<typeof setup>, u: string) => {
  for (let k = 0; k < 8; k++) {
    const a = await s.carry.carry(signedIntent(u, withdraw("alice.near")));
    await s.carry.idle();
    if (code(a) !== "sent") return code(a);
  }
  return "never capped";
};

test("R3-1 a reservation spent by a concurrent intent while its registration's outcome is read is not re-created: one signer gets at most INTENTS_SENDS_MAX sends", async () => {
  // every storage_deposit's outcome stays unknown until the test releases it
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const a = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  await until(() => regsOf(s) === 1);
  // the registration lands on chain; A's outcome read has not come back yet
  s.chain.storage.set(`${USDC}/fresh.near`, "registered");
  const b = await s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  assert.equal(code(b), "sent", "B reads the receiver registered and spends the reservation");
  assert.equal(s.store.signer(u).registration?.reserved, false, "spent");
  s.r.release();
  const aa = await a;
  await s.carry.idle();
  const last = await fill(s, u);
  const signed = s.r.sent.length;
  s.store.close();
  assert.ok(signed <= INTENTS_SENDS_MAX, `${signed} sends signed for one signer (A answered ${code(aa)}, then ${last}); INTENTS_SENDS_MAX ${INTENTS_SENDS_MAX}`);
});

test("R3-2 a stale earlier-tx read never frees a newer live claim: sent stays the slots held, and one signer gets at most INTENTS_SENDS_MAX sends", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  // an earlier receiver registration, signed (it failed on chain): its slot and its reservation, as register() writes them
  const T = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), sent: 2, registration: { receiver: "fresh.near", state: "pending", tx: T, reserved: true } });
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    if (t.tx_hash !== T.tx_hash) return resolve(t, o);
    if (++calls === 2) await g.p; // Y's read of T answers late
    return failedFinal(t);
  };
  const x = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  const y = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  assert.equal(code(await x), "registration_failed");
  await until(() => calls === 2);
  // Z: a new claim on the freed registration, its storage_deposit signed and out
  const z = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  await until(() => regsOf(s) === 1);
  const before = s.store.signer(u);
  g.open();
  // T's failure is X's, which freed it: Y's stale read reports none (delta review 4, P2-1)
  assert.equal(code(await y), "in_flight");
  const after = s.store.signer(u);
  s.chain.storage.set(`${USDC}/fresh.near`, "registered");
  s.r.release();
  const za = await z;
  await s.carry.idle();
  const mid = { sent: s.store.signer(u).sent, signed: 1 + s.r.sent.length };
  const last = await fill(s, u);
  const signed = 1 + s.r.sent.length; // T, then every send here
  s.store.close();
  assert.deepEqual(after.registration, before.registration, `Y's stale read of T wiped Z's live claim (${JSON.stringify(before.registration?.tx?.tx_hash?.slice(0, 6))} -> ${JSON.stringify(after.registration)}); sent ${before.sent} -> ${after.sent}`);
  assert.equal(mid.sent, mid.signed, `sent ${mid.sent} for ${mid.signed} signed (Z answered ${code(za)})`);
  assert.ok(signed <= INTENTS_SENDS_MAX, `${signed} sends signed for one signer, then ${last}`);
});

test("R3-3 two status polls at once, the first registration of U failing: the second pays nothing until the backoff step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  const store = createIntentsStore(dir, undefined, () => NOW);
  const chain: Chain = { refuseSimulateOn: null, storage: new Map(), finalMs: NOW };
  const r = relayer((a) => (a.method === "storage_deposit" ? "failed" : "ran"));
  const g = gateP();
  let heldCalls = 0;
  const carry = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(chain), () => NOW), relayer: r, held: async () => (++heldCalls === 1 && (await g.p), false), now: () => NOW, resolveEveryMs: 1 });
  const u = hex();
  await seeSigner(store, u);
  chain.storage.set(`${USDC}/${u}`, "null");
  const b = carry.registerSeen(u); // poll 1: its token-watch read answers late
  await until(() => heldCalls === 1);
  assert.equal(await carry.registerSeen(u), "registration_failed"); // poll 2: paid, failed, backoff written
  const owed = store.owed(u);
  g.open();
  const bb = await b;
  const regs = r.sent.filter((x) => x.action.method === "storage_deposit").length;
  store.close();
  assert.equal(regs, 1, `${regs} storage_deposits for U at one instant (poll 1 answered ${bb}; the backoff said next at +${(owed!.next_ms - NOW) / 1000}s)`);
});

test("R3-4 (old PROBE-5, honest chain, a legacy claim with no reserved field): after a restart sent equals the slots held", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  const s = setup({ dir });
  const u = hex();
  await seeSigner(s.store, u);
  s.store.putSigner({ ...s.store.signer(u), sent: 1, registration: { receiver: "fresh.near", state: "pending", tx: null } });
  s.store.close();
  const t = setup({ dir });
  t.chain.storage.set(`${USDC}/fresh.near`, "null");
  assert.equal(code(await t.carry.carry(signedIntent(u, withdraw("fresh.near")))), "sent");
  await t.carry.idle();
  const rec = t.store.signer(u);
  t.store.close();
  assert.equal(rec.sent, t.r.sent.length, `sent ${rec.sent} for ${t.r.sent.length} signed`);
});

test("R3-5 a reservation whose intent is answered relayer_low stays, and is spent by the retried intent (never twice, never lost)", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  // the gas account drops under the intents floor right after the registration
  const funds = s.r.funds;
  let n = 0;
  s.r.balance = async () => (++n >= 2 ? INTENTS_FLOOR_YOCTO - 1n : funds);
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "relayer_low");
  assert.deepEqual([s.store.signer(u).sent, s.store.signer(u).registration?.reserved, s.store.signer(u).registration?.state], [2, true, "landed"]);
  s.r.balance = async () => funds;
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "sent");
  await s.carry.idle();
  assert.deepEqual([s.store.signer(u).sent, s.store.signer(u).registration?.reserved], [2, false]);
  const last = await fill(s, u);
  assert.equal(last, "signer_cap");
  assert.equal(s.r.sent.length, INTENTS_SENDS_MAX);
  s.store.close();
});

test("R3-2b the stale free as a loop: a signer that owns its receiver (registered by us, unregistered by it before our read) gets receiver registrations paid with no bound", async () => {
  const s = setup({ outcome: () => "ran" }); // each storage_deposit lands; the receiver's owner unregisters it before our two-provider read
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const D = { deadline: "2026-11-08T18:00:00.000Z" };
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near"), D))), "in_flight"); // R0 paid
  const resolve = s.r.resolve;
  const send = s.r.send;
  const trail: string[] = [];
  for (let k = 0; k < 6; k++) {
    s.clock.ms += OWN_SETTLE_MS + 1;
    const T = s.store.signer(u).registration!.tx!;
    const gy = gateP();
    const gz = gateP();
    let calls = 0;
    s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
      if (t.tx_hash === T.tx_hash && ++calls === 2) await gy.p; // Y's read of the last registration answers late
      return resolve(t, o);
    };
    let zFirst = true;
    s.r.send = (async (...a: Parameters<typeof send>) => {
      if (zFirst) {
        zFirst = false;
        await gz.p; // Z's registration waits in the relayer's queue, its claim written
      }
      return send(...a);
    }) as typeof send;
    const x = s.carry.carry(signedIntent(u, withdraw("fresh.near"), D));
    const y = s.carry.carry(signedIntent(u, withdraw("fresh.near"), D));
    const xa = code(await x);
    await until(() => calls === 2);
    let zDone = false;
    const z = s.carry.carry(signedIntent(u, withdraw("fresh.near"), D)).finally(() => (zDone = true));
    await until(() => zDone || s.store.signer(u).registration !== null);
    gy.open();
    const ya = code(await y);
    gz.open();
    const za = code(await z);
    trail.push(`${xa}/${ya}/${za} sent=${s.store.signer(u).sent}`);
    if (s.store.signer(u).registration?.tx == null) break; // no new registration out: the loop is over
  }
  s.r.resolve = resolve;
  s.r.send = send;
  // the last registration is still tracked: a request at the same moment pays nothing new
  const paid = regsOf(s);
  await s.carry.carry(signedIntent(u, withdraw("fresh.near"), D));
  await s.carry.idle();
  assert.equal(regsOf(s), paid, "no claim lost: no second payment for it");
  const regs = regsOf(s);
  const rec = s.store.signer(u);
  s.store.close();
  assert.ok(regs <= INTENTS_SENDS_MAX - 1, `${regs} receiver registrations paid for one signer: ${trail.join(", ")}`);
  // the slots: every signed one counted, plus the live reservation (no stale free took a newer claim's)
  assert.equal(rec.sent, s.r.sent.length + (rec.registration?.reserved === true ? 1 : 0) + (rec.taking ?? []).length, `sent ${rec.sent} for ${s.r.sent.length} signed: ${trail.join(", ")}`);
});

test("R3-6 reclaim at step 6 never frees a live take: an intent waiting in the relayer's queue (in taking) and a receiver claim waiting there (no tx yet) keep their slots", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  const g = gateP();
  const send = s.r.send;
  let first = true;
  s.r.send = (async (...a: Parameters<typeof send>) => {
    if (first) {
      first = false;
      await g.p;
    }
    return send(...a);
  }) as typeof send;
  // A: an intent to a registered account, its slot taken, waiting before its signing
  const a = s.carry.carry(signedIntent(u, withdraw("alice.near")));
  await until(() => (s.store.signer(u).taking ?? []).length === 1);
  // B runs step 6's reclaim meanwhile
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("alice.near")))), "sent");
  assert.deepEqual([s.store.signer(u).sent, (s.store.signer(u).taking ?? []).length], [2, 1], "A's slot kept while it waits");
  g.open();
  assert.equal(code(await a), "sent");
  await s.carry.idle();
  assert.deepEqual([s.store.signer(u).sent, s.store.signer(u).taking], [2, []]);
  // C: a receiver claim waiting before its signing; D's reclaim must leave it
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const g2 = gateP();
  let first2 = true;
  s.r.send = (async (...x: Parameters<typeof send>) => {
    if (first2) {
      first2 = false;
      await g2.p;
    }
    return send(...x);
  }) as typeof send;
  const c = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  await until(() => s.store.signer(u).registration !== null);
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "in_flight");
  assert.deepEqual([s.store.signer(u).sent, s.store.signer(u).registration?.state, s.store.signer(u).registration?.tx], [4, "pending", null]);
  g2.open();
  assert.equal(code(await c), "sent");
  await s.carry.idle();
  assert.deepEqual([s.store.signer(u).sent, s.r.sent.length], [4, 4]);
  s.store.close();
});

// ---- the compare-and-set at each write site, one stale judge each (delta review 3's rule) ----
const dropped = (t: TxRef): TxOutcome => ({ kind: "dropped", tx_hash: t.tx_hash, why: "(b)" });

test("R3-2 (dropped): a stale read of an earlier receiver tx that reads dropped never frees the new claim made after it", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const T = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), sent: 2, registration: { receiver: "fresh.near", state: "pending", tx: T, reserved: true } });
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    if (t.tx_hash !== T.tx_hash) return resolve(t, o);
    if (++calls === 2) await g.p; // Y's read of T answers late
    return dropped(t);
  };
  const x = s.carry.carry(signedIntent(u, withdraw("fresh.near"))); // X: T dropped, both slots back, X claims anew
  const y = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  await until(() => calls === 2 && regsOf(s) === 1);
  const before = s.store.signer(u);
  assert.deepEqual([before.sent, before.registration?.reserved, before.registration?.tx === null], [2, true, false], "X's claim: its two slots, signed");
  g.open();
  assert.equal(code(await y), "in_flight", "Y finds X's claim out");
  assert.deepEqual(s.store.signer(u), before, "Y's stale read of T left X's claim alone");
  s.chain.storage.set(`${USDC}/fresh.near`, "registered");
  s.r.release();
  assert.equal(code(await x), "sent");
  await s.carry.idle();
  assert.equal(s.store.signer(u).sent, s.r.sent.length, "sent as signed here (T never landed: its slots back)");
  s.store.close();
});

test("R3-2 (at): a stale read of an earlier receiver tx never writes its settle time onto the new claim made after it", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const T = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), sent: 2, registration: { receiver: "fresh.near", state: "pending", tx: T, reserved: true } });
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  const ranT = (t: TxRef): TxOutcome => ({ kind: "final", tx_hash: t.tx_hash, receipts: [{ executor: USDC, ok: true, failure: "", height: 1n }] });
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    if (t.tx_hash !== T.tx_hash) return resolve(t, o);
    if (++calls === 1) await g.p; // Y: its read of T (no settle time yet) answers late
    return ranT(t);
  };
  const y = s.carry.carry(signedIntent(u, withdraw("fresh.near"), { deadline: "2026-11-07T18:10:00.000Z" }));
  await until(() => calls === 1);
  // X: ran, unregistered: its settle time written; past it, W frees T; Z claims anew, its storage_deposit out
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "in_flight");
  s.clock.ms = NOW + OWN_SETTLE_MS + 1;
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near"), { deadline: "2026-11-07T18:10:00.000Z" }))), "registration_failed");
  const z = s.carry.carry(signedIntent(u, withdraw("fresh.near"), { deadline: "2026-11-07T18:10:00.000Z" }));
  await until(() => regsOf(s) === 1);
  const before = s.store.signer(u);
  assert.equal(before.registration?.at, undefined, "Z has not run: no settle time");
  g.open();
  await y;
  assert.deepEqual(s.store.signer(u).registration, before.registration, "Y's stale judge of T left Z's claim alone");
  s.chain.storage.set(`${USDC}/fresh.near`, "registered");
  s.r.release();
  assert.equal(code(await z), "sent");
  await s.carry.idle();
  s.store.close();
});

test("R3-1 (in the queue): a reservation spent while its claim waits in the relayer's queue is not re-created by the signing", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const g = gateP();
  const send = s.r.send;
  let first = true;
  s.r.send = (async (...a: Parameters<typeof send>) => {
    if (first) {
      first = false;
      await g.p; // A's registration waits in the queue, its claim written, nothing signed
    }
    return send(...a);
  }) as typeof send;
  const a = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  await until(() => s.store.signer(u).registration !== null);
  // the receiver is registered by another payer meanwhile; B reads it so and spends A's reservation
  s.chain.storage.set(`${USDC}/fresh.near`, "registered");
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "sent");
  assert.equal(s.store.signer(u).registration?.reserved, false);
  g.open();
  await a;
  await s.carry.idle();
  assert.equal(s.store.signer(u).registration?.reserved, false, "the signing kept it spent");
  await fill(s, u);
  assert.ok(s.r.sent.length <= INTENTS_SENDS_MAX, `${s.r.sent.length} sends for one signer`);
  s.store.close();
});

test("R3-2 (own, dropped): a stale read of U's earlier tx that reads dropped never frees the new claim made after it", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const T = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), own: { receiver: u, state: "pending", tx: T } });
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    if (t.tx_hash !== T.tx_hash) return resolve(t, o);
    if (++calls === 2) await g.p;
    return dropped(t);
  };
  const x = s.carry.registerSeen(u); // T dropped: X claims anew
  const y = s.carry.registerSeen(u);
  await until(() => calls === 2 && regsOf(s) === 1);
  const before = s.store.signer(u).own;
  assert.ok(before?.tx != null && before.tx.tx_hash !== T.tx_hash, "X's new claim, signed");
  g.open();
  assert.equal(await y, "in_flight");
  assert.deepEqual(s.store.signer(u).own, before, "Y's stale read of T left X's claim alone");
  s.chain.storage.set(`${USDC}/${u}`, "registered");
  s.r.release();
  assert.equal(await x, "registered");
  assert.equal(regsOf(s), 1);
  s.store.close();
});

test("the slot invariant over a concurrent round: two requests on one signer at once on each path; after each step sent equals the signed slots plus the live reservation plus the live takes", async () => {
  let mode: "ran" | "failed" | "lie" = "ran";
  let chain!: Chain;
  const s = setup({
    outcome: (a) => {
      if (a.method !== "storage_deposit") return "ran";
      if (mode === "failed") return "failed";
      if (mode === "ran") chain.storage.set(`${a.receiver}/${JSON.parse(a.args).account_id}`, "registered");
      return "ran";
    },
  });
  chain = s.chain;
  const u = hex();
  await seeSigner(s.store, u);
  chain.storage.set(`${USDC}/${u}`, "null");
  const D = { deadline: "2026-11-07T18:10:00.000Z" };
  const check = (step: string) => {
    const r = s.store.signer(u);
    const signed = s.r.sent.filter((t) => t.action.method === "execute_intents" || JSON.parse(t.action.args).account_id !== u).length;
    const live = (r.registration?.reserved === true ? 1 : 0) + (r.taking ?? []).length;
    assert.equal(r.sent ?? 0, signed + live, `${step}: sent ${r.sent} for ${signed} signed + ${live} live (${JSON.stringify(r.registration)})`);
    assert.ok((r.sent ?? 0) <= INTENTS_SENDS_MAX, `${step}: sent ${r.sent}`);
  };
  const both = async (f: () => Promise<unknown>) => {
    await Promise.all([f(), f()]);
    await s.carry.idle();
  };
  await both(() => s.carry.registerSeen(u));
  check("U's own, two polls");
  assert.equal(regsOf(s), 1, "U's own paid once");
  mode = "failed";
  chain.storage.set(`${USDC}/bad.near`, "null");
  await both(() => s.carry.carry(signedIntent(u, withdraw("bad.near"), D)));
  check("a receiver failing on chain");
  mode = "lie";
  chain.storage.set(`${USDC}/gone.near`, "null");
  await both(() => s.carry.carry(signedIntent(u, withdraw("gone.near"), D)));
  check("a receiver that ran and reads unregistered");
  s.clock.ms = NOW + OWN_SETTLE_MS + 1;
  await both(() => s.carry.carry(signedIntent(u, withdraw("gone.near"), D)));
  check("the same, past the settle time");
  mode = "ran";
  chain.storage.set(`${USDC}/fresh.near`, "null");
  await both(() => s.carry.carry(signedIntent(u, withdraw("fresh.near"), D)));
  check("an honest receiver");
  for (let k = 0; k < 3; k++) {
    await both(() => s.carry.carry(signedIntent(u, withdraw("alice.near"), D)));
    check(`intents to a registered account, round ${k + 1}`);
  }
  const m = s.r.sent.map((t) => t.action.method);
  assert.ok(m.filter((t) => t === "execute_intents").length + m.filter((t) => t === "storage_deposit").length - 1 <= INTENTS_SENDS_MAX, "the cap, U's own aside");
  s.store.close();
});

test("R3-F4: a spent reservation whose intent is never signed goes back only to the registration it was spent from: freed and claimed again since, its slot is given back", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const gB = gateP();
  const send = s.r.send;
  let n = 0;
  s.r.send = (async (...a: Parameters<typeof send>) => {
    if (++n === 2) {
      await gB.p; // B's intent: its slot (R's reservation) spent, then the relayer refuses before the signing
      throw new Error("relayer: the gas account's key is not a full-access key at final");
    }
    return send(...a);
  }) as typeof send;
  // R's outcome is unknown until the test calls it failed (one lookup's word)
  let rFails = false;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => (t.tx_hash === s.r.sent[0]?.tx.tx_hash && rFails ? failedFinal(t) : resolve(t, o));
  const a = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  await until(() => regsOf(s) === 1);
  s.chain.storage.set(`${USDC}/fresh.near`, "registered"); // R landed, its outcome not read yet
  const b = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  await until(() => n === 2);
  assert.equal(s.store.signer(u).registration?.reserved, false, "B spent R's reservation");
  s.chain.storage.set(`${USDC}/fresh.near`, "null"); // its owner unregisters it
  rFails = true;
  assert.equal(code(await a), "registration_failed", "R read failed: freed");
  const c = s.carry.carry(signedIntent(u, withdraw("fresh.near"))); // R2: a new claim on the same receiver, out
  await until(() => regsOf(s) === 2);
  gB.open();
  assert.equal(code(await b), "upstream");
  const r = s.store.signer(u);
  assert.equal(r.sent, regsOf(s) + (r.registration?.reserved === true ? 1 : 0) + (r.taking ?? []).length, `sent ${r.sent} for R and R2 signed: ${JSON.stringify(r.registration)}`);
  s.chain.storage.set(`${USDC}/fresh.near`, "registered");
  s.r.release();
  await c;
  await s.carry.idle();
  s.store.close();
});

test("R3 (own, read): U read registered while an earlier claim's outcome is out; that claim then read failed (one lookup's word) never clears the read record", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  let lie = false;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => (lie && t.tx_hash === s.r.sent[0]?.tx.tx_hash ? failedFinal(t) : resolve(t, o));
  const b = s.carry.registerSeen(u); // B's registration out, its outcome unknown
  await until(() => regsOf(s) === 1);
  s.chain.storage.set(`${USDC}/${u}`, "registered"); // it landed
  assert.equal(await s.carry.registerSeen(u), "registered"); // A reads U registered on both: done
  lie = true;
  await b;
  assert.equal(s.store.signer(u).own?.read, true, "B's stale failure left the read record alone");
  s.store.close();
  const t = setup({ dir: s.dir, chain: { storage: new Map([[`${USDC}/${u}`, "null"]]) } });
  assert.equal(await t.carry.registerSeen(u), "registered", "after a restart: never paid again");
  assert.equal(t.r.sent.length, 0);
  t.store.close();
});

test("R3-2 (landed): a stale read of an earlier receiver tx that reads it registered never marks the new claim made after it landed", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const T = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), sent: 2, registration: { receiver: "fresh.near", state: "pending", tx: T, reserved: true, at: NOW } });
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  const ranT = (t: TxRef): TxOutcome => ({ kind: "final", tx_hash: t.tx_hash, receipts: [{ executor: USDC, ok: true, failure: "", height: 1n }] });
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    if (t.tx_hash !== T.tx_hash) return resolve(t, o);
    if (++calls === 1) await g.p; // Y: its read of T answers late
    return ranT(t);
  };
  const D = { deadline: "2026-11-07T18:10:00.000Z" };
  s.clock.ms = NOW + OWN_SETTLE_MS + 1;
  const y = s.carry.carry(signedIntent(u, withdraw("fresh.near"), D));
  await until(() => calls === 1);
  // W: T ran, unregistered past the settle time: freed; Z claims anew, waiting in the queue
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near"), D))), "registration_failed");
  const gz = gateP();
  const send = s.r.send;
  s.r.send = (async (...a: Parameters<typeof send>) => {
    if (a[0].kind === "call" && a[0].method === "storage_deposit") await gz.p; // Z's registration waits in the queue
    return send(...a);
  }) as typeof send;
  const z = s.carry.carry(signedIntent(u, withdraw("fresh.near"), D));
  await until(() => s.store.signer(u).registration !== null);
  const before = s.store.signer(u).registration;
  s.chain.storage.set(`${USDC}/fresh.near`, "registered"); // another payer registers it; Y reads it so
  g.open();
  assert.equal(code(await y), "sent");
  assert.equal(s.store.signer(u).registration?.state, before?.state, "Y's stale judge of T never marked Z landed");
  gz.open();
  s.r.release();
  await z;
  await s.carry.idle();
  s.store.close();
});

// ---- delta review 4: its probes PR4-1, PR4-2, PR4-2b and PR4-4 to PR4-10 (PR4-3 and PR4-3b are card helper-judge-two-agree's) ----
test("PR4-1 one failed own registration (honest: it did fail) judged by K concurrent polls counts one try for the backoff", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const T = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), own: { receiver: u, state: "pending", tx: T } });
  s.store.owe({ signer: u, tries: 0, next_ms: 0 });
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    if (t.tx_hash !== T.tx_hash) return resolve(t, o);
    calls++;
    await g.p;
    return failedFinal(t);
  };
  const K = 5;
  const polls = Array.from({ length: K }, () => s.carry.registerSeen(u));
  await until(() => calls === K);
  g.open();
  const answers = await Promise.all(polls);
  const owed = s.store.owed(u)!;
  s.store.close();
  assert.equal(owed.tries, 1, `one failed payment counted ${owed.tries} tries: the next payment waits ${(owed.next_ms - NOW) / 60000} min, not 2`);
  assert.equal(owed.next_ms - NOW, SWEEP_MS * 2, "one try's backoff");
  // only the poll that freed the claim reports its failure; the others read it judged
  assert.deepEqual([...answers].sort(), ["in_flight", "in_flight", "in_flight", "in_flight", "registration_failed"]);
});

test("PR4-2 (registerSeen) a stale own failure that lands after another poll read U registered: answer and owed record", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const T = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), own: { receiver: u, state: "pending", tx: T } });
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    if (t.tx_hash !== T.tx_hash) return resolve(t, o);
    calls++;
    await g.p;
    return failedFinal(t); // one lookup's word: it landed
  };
  const a = s.carry.registerSeen(u);
  await until(() => calls === 1);
  s.chain.storage.set(`${USDC}/${u}`, "registered");
  assert.equal(await s.carry.registerSeen(u), "registered");
  assert.equal(s.store.owed(u), null, "B: owed no more");
  g.open();
  const aa = await a;
  const owedAfter = s.store.owed(u);
  s.clock.ms = NOW + 100 * SWEEP_MS;
  await s.carry.sweep();
  const owedAfterSweep = s.store.owed(u);
  const sendsBefore = s.r.sent.length;
  s.store.close();
  const t = setup({ dir: s.dir, chain: { storage: new Map([[`${USDC}/${u}`, "null"]]) } });
  t.clock.ms = NOW + 200 * SWEEP_MS;
  await t.carry.sweep();
  await t.carry.sweep();
  const owedAfterRestart = t.store.owed(u);
  t.store.close();
  assert.equal(sendsBefore + t.r.sent.length, 0, "no gas");
  assert.equal(aa, "registered", "A answered for a U read registered");
  assert.equal(owedAfter, null, "a stray owed record for a U read registered");
});

test("PR4-2b (carry) the device's intent while a stale own failure lands after another poll read U registered", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const T = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), own: { receiver: u, state: "pending", tx: T } });
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    if (t.tx_hash !== T.tx_hash) return resolve(t, o);
    calls++;
    await g.p;
    return failedFinal(t);
  };
  const to = await moveQuote(s.store, { refundTo: u, recipient: u });
  const a = s.carry.carry(signedIntent(u, transfer(to)));
  await until(() => calls === 1);
  s.chain.storage.set(`${USDC}/${u}`, "registered");
  assert.equal(await s.carry.registerSeen(u), "registered");
  g.open();
  const aa = code(await a);
  await s.carry.idle();
  s.store.close();
  assert.equal(aa, "sent", "U read registered: the intent goes");
});

const ranFinal = (tx: TxRef): TxOutcome => ({ kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: USDC, ok: true, failure: "", height: 1n }] });

test("PR4-4 a spent reservation whose intent's send throws before its signing goes back to its registration and leaves no take behind: one signer still gets at most INTENTS_SENDS_MAX sends", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const send = s.r.send;
  let n = 0;
  s.r.send = (async (...a: Parameters<typeof send>) => {
    if (a[0].kind === "call" && a[0].method === "execute_intents" && ++n === 1) throw new Error("an RPC error before the signing");
    return send(...a);
  }) as typeof send;
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("fresh.near")))), "upstream");
  const r1 = s.store.signer(u);
  const codes: string[] = [];
  for (let k = 0; k < 6; k++) {
    codes.push(code(await s.carry.carry(signedIntent(u, withdraw(k === 0 ? "fresh.near" : "alice.near")))));
    await s.carry.idle();
  }
  s.store.close();
  assert.deepEqual([r1.sent, r1.taking, r1.registration?.reserved], [2, [], true], "the reservation back, no take left");
  assert.ok(s.r.sent.length <= INTENTS_SENDS_MAX, `${s.r.sent.length} sends for one signer`);
});

test("PR4-5 U's earlier tx read ran past the settle time by a stale poll, after another poll read U registered: the read record stays (a restart, U later unregistered: nothing paid)", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const T = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), own: { receiver: u, state: "landed", tx: T, at: NOW } });
  s.clock.ms = NOW + OWN_SETTLE_MS + 1;
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    if (t.tx_hash !== T.tx_hash) return resolve(t, o);
    calls++;
    await g.p;
    return ranFinal(t);
  };
  const a = s.carry.registerSeen(u);
  await until(() => calls === 1);
  s.chain.storage.set(`${USDC}/${u}`, "registered");
  assert.equal(await s.carry.registerSeen(u), "registered");
  g.open();
  const aa = await a;
  const read = s.store.signer(u).own?.read;
  s.store.close();
  const t = setup({ dir: s.dir, chain: { storage: new Map([[`${USDC}/${u}`, "null"]]) } });
  t.clock.ms = NOW + 100 * SWEEP_MS;
  const ta = await t.carry.registerSeen(u);
  t.store.close();
  assert.equal(read, true, "the read record kept");
  assert.equal(t.r.sent.length, 0, "never paid again");
});

test("PR4-6 U's claim refused by the queue's guard (held), after another poll read U registered: the read record stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  const store = createIntentsStore(dir, undefined, () => NOW);
  const chain: Chain = { refuseSimulateOn: null, storage: new Map(), finalMs: NOW };
  const r = relayer((a) => {
    if (a.method === "storage_deposit") chain.storage.set(`${a.receiver}/${JSON.parse(a.args).account_id}`, "registered");
    return "ran";
  });
  const g = gateP();
  let heldCalls = 0;
  const carry = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(chain), () => NOW), relayer: r, held: async () => (++heldCalls === 2 ? (await g.p, true) : false), now: () => NOW, resolveEveryMs: 1 });
  const u = hex();
  await seeSigner(store, u);
  chain.storage.set(`${USDC}/${u}`, "null");
  const a = carry.registerSeen(u);
  await until(() => heldCalls === 2);
  chain.storage.set(`${USDC}/${u}`, "registered");
  assert.equal(await carry.registerSeen(u), "registered");
  g.open();
  const aa = await a;
  const read = store.signer(u).own?.read;
  store.close();
  assert.equal(read, true, "the read record kept");
});

test("PR4-7 a receiver claim in flight freed by another request's lookup (final failed), its own read then ran and registered: the record stays well formed", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    const x = s.r.sent.find((y) => y.tx.tx_hash === t.tx_hash);
    if (x?.action.method !== "storage_deposit") return resolve(t, o);
    calls++;
    if (calls === 1) {
      await g.p; // A's settle read, parked
      return ranFinal(t);
    }
    return failedFinal(t); // B's read: one lookup says failed
  };
  const a = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  await until(() => calls === 1);
  const b = code(await s.carry.carry(signedIntent(u, withdraw("fresh.near"))));
  const mid = s.store.signer(u).registration;
  s.chain.storage.set(`${USDC}/fresh.near`, "registered");
  g.open();
  const aa = code(await a);
  await s.carry.idle();
  const rec = s.store.signer(u);
  s.store.close();
  assert.ok(rec.registration === null || typeof rec.registration.receiver === "string", `a record with no receiver: ${JSON.stringify(rec.registration)}`);
  assert.deepEqual([b, mid, aa], ["registration_failed", null, "sent"], "B freed it and reports the failure; A's claim, freed, writes nothing and its intent goes on the receiver read registered");
});

/** After `act`, a restart with U read unregistered (its owner unregistered it) and every backoff passed: what is paid. */
const afterRestart = async (s: ReturnType<typeof setup>, u: string) => {
  const read = s.store.signer(u).own?.read;
  s.store.close();
  const t = setup({ dir: s.dir, chain: { storage: new Map([[`${USDC}/${u}`, "null"]]) } });
  t.clock.ms = NOW + 1000 * SWEEP_MS;
  const a = await t.carry.registerSeen(u);
  const sends = t.r.sent.length;
  t.store.close();
  return { read, a, sends };
};

test("PR4-8 U's claim whose relayer send throws before its signing, after another poll read U registered: the read record stays", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const g = gateP();
  let entered = false;
  s.r.send = (async () => {
    entered = true;
    await g.p;
    throw new Error("an RPC error before the signing");
  }) as typeof s.r.send;
  const a = s.carry.registerSeen(u);
  await until(() => entered);
  s.chain.storage.set(`${USDC}/${u}`, "registered");
  assert.equal(await s.carry.registerSeen(u), "registered");
  g.open();
  const aa = await a;
  const r = await afterRestart(s, u);
  assert.equal(r.read, true, "the read record kept");
  assert.equal(r.sends, 0, "never paid again");
});

test("PR4-9 U's claim read ran after another poll read U registered: the read record stays", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const a = s.carry.registerSeen(u);
  await until(() => regsOf(s) === 1);
  s.chain.storage.set(`${USDC}/${u}`, "registered");
  assert.equal(await s.carry.registerSeen(u), "registered");
  s.r.release();
  const aa = await a;
  const r = await afterRestart(s, u);
  assert.equal(r.read, true, "the read record kept");
  assert.equal(r.sends, 0, "never paid again");
});

test("PR4-10 U's earlier tx (no settle time yet) read ran by a stale poll after another poll read U registered: the read record stays", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const T = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), own: { receiver: u, state: "pending", tx: T } });
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    if (t.tx_hash !== T.tx_hash) return resolve(t, o);
    calls++;
    await g.p;
    return ranFinal(t);
  };
  const a = s.carry.registerSeen(u);
  await until(() => calls === 1);
  s.chain.storage.set(`${USDC}/${u}`, "registered");
  assert.equal(await s.carry.registerSeen(u), "registered");
  g.open();
  const aa = await a;
  const r = await afterRestart(s, u);
  assert.equal(r.read, true, "the read record kept");
  assert.equal(r.sends, 0, "never paid again");
});

test("PR4-9b U's claim read ran after another poll read U registered, U then unregistered by its owner before the claim's own read: the read record stays", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  const a = s.carry.registerSeen(u);
  await until(() => regsOf(s) === 1);
  s.chain.storage.set(`${USDC}/${u}`, "registered");
  assert.equal(await s.carry.registerSeen(u), "registered");
  s.chain.storage.set(`${USDC}/${u}`, "null");
  s.r.release();
  const aa = await a;
  const read = s.store.signer(u).own?.read;
  s.store.close();
  const t = setup({ dir: s.dir, chain: { storage: new Map([[`${USDC}/${u}`, "null"]]) } });
  const resolve = t.r.resolve;
  t.r.resolve = async (x: TxRef, o: { resend: boolean }) => ((await resolve(x, o)) ?? ranFinal(x));
  t.clock.ms = NOW + 1000 * SWEEP_MS;
  const b1 = await t.carry.registerSeen(u);
  t.clock.ms = NOW + 3000 * SWEEP_MS;
  const b2 = await t.carry.registerSeen(u);
  const sends = t.r.sent.length;
  t.store.close();
  assert.equal(read, true, "the read record kept");
  assert.equal(sends, 0, "never paid again");
});

// ---- the fold's own pins: tries read at the write (N4), a read record never freed by a stale judge, the receiver's
// failures reported only by the request that freed the registration ----

test("R4-N4: a failure of U's own claim made after another poll's failure counts both tries (tries read at the write, not before the awaits)", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "failed" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/${u}`, "null");
  s.store.owe({ signer: u, tries: 0, next_ms: 0 });
  const g = gateP();
  let calls = 0;
  const balance = s.r.balance;
  s.r.balance = async () => {
    if (++calls === 1) await g.p; // A, parked before its claim
    return balance();
  };
  const a = s.carry.registerSeen(u);
  await until(() => calls === 1);
  assert.equal(await s.carry.registerSeen(u), "registration_failed", "B's claim failed");
  assert.equal(s.store.owed(u)!.tries, 1);
  s.clock.ms = s.store.owed(u)!.next_ms + 1; // B's backoff passed
  g.open();
  assert.equal(await a, "registration_failed", "A's own claim failed");
  const owed = s.store.owed(u)!;
  s.store.close();
  assert.equal(regsOf(s), 2, "two claims, two payments");
  assert.equal(owed.tries, 2, `two failed payments counted ${owed.tries}`);
});

test("R4-read: a poll whose own storage read was before another poll read U registered never frees the read record (no owed record, a restart with U unregistered pays nothing)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intents-"));
  const store = createIntentsStore(dir, undefined, () => NOW);
  const chain: Chain = { refuseSimulateOn: null, storage: new Map(), finalMs: NOW };
  const r = relayer(() => "ran");
  const reads = intentsReads(providers(chain), () => NOW);
  const storage = reads.storage;
  const g = gateP();
  let parked = false;
  // A's read is answered at the block it was asked at, before U read registered
  reads.storage = async (t, acct) => (parked ? storage(t, acct) : ((parked = true), await g.p, "none"));
  const carry = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads, relayer: r, held: async () => false, now: () => NOW, resolveEveryMs: 1 });
  const u = hex();
  await seeSigner(store, u);
  const T = earlierTx();
  store.putSigner({ ...store.signer(u), own: { receiver: u, state: "pending", tx: T } });
  r.resolve = async (t: TxRef) => failedFinal(t); // one lookup's word: it landed
  const a = carry.registerSeen(u);
  await until(() => parked);
  chain.storage.set(`${USDC}/${u}`, "registered");
  assert.equal(await carry.registerSeen(u), "registered");
  g.open();
  const aa = await a;
  const read = store.signer(u).own?.read;
  const owed = store.owed(u);
  store.close();
  const t = setup({ dir, chain: { storage: new Map([[`${USDC}/${u}`, "null"]]) } });
  t.clock.ms = NOW + 1000 * SWEEP_MS;
  const ta = await t.carry.registerSeen(u);
  const sends = t.r.sent.length;
  t.store.close();
  assert.deepEqual([aa, read, owed], ["registered", true, null], "A answers for a U read registered and leaves its record");
  assert.deepEqual([ta, sends], ["registered", 0], "never paid again");
});

test("R4-recv: one failed receiver registration judged by two requests: only the one that freed it answers registration_failed, its reserved slot back once", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const T = earlierTx();
  s.store.putSigner({ ...s.store.signer(u), sent: 2, registration: { id: "r1", receiver: "fresh.near", state: "pending", tx: T, reserved: true } });
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    if (t.tx_hash !== T.tx_hash) return resolve(t, o);
    calls++;
    await g.p;
    return failedFinal(t);
  };
  const both = [s.carry.carry(signedIntent(u, withdraw("fresh.near"))), s.carry.carry(signedIntent(u, withdraw("fresh.near")))];
  await until(() => calls === 2);
  g.open();
  const codes = (await Promise.all(both)).map(code).sort();
  const rec = s.store.signer(u);
  s.store.close();
  assert.deepEqual(codes, ["in_flight", "registration_failed"]);
  assert.deepEqual([rec.sent, rec.registration, s.r.sent.length], [1, null, 0]);
});

test("R4-recv-claim: a receiver claim freed by another request's lookup, its own read then final failed: it answers in_flight, the failure is the other's", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "held" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  const g = gateP();
  let calls = 0;
  const resolve = s.r.resolve;
  s.r.resolve = async (t: TxRef, o: { resend: boolean }) => {
    const x = s.r.sent.find((y) => y.tx.tx_hash === t.tx_hash);
    if (x?.action.method !== "storage_deposit") return resolve(t, o);
    if (++calls === 1) await g.p; // A's settle read, parked
    return failedFinal(t);
  };
  const a = s.carry.carry(signedIntent(u, withdraw("fresh.near")));
  await until(() => calls === 1);
  const b = code(await s.carry.carry(signedIntent(u, withdraw("fresh.near"))));
  g.open();
  const aa = code(await a);
  await s.carry.idle();
  const rec = s.store.signer(u);
  s.store.close();
  assert.deepEqual([b, aa], ["registration_failed", "in_flight"]);
  assert.deepEqual([rec.sent, rec.registration, regsOf(s)], [1, null, 1], "one paid slot counted, the reservation back once");
});
