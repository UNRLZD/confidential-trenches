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
import { createIntentsCarry, INTENTS_FLOOR_YOCTO, INTENTS_SENDS_MAX, REGISTRATION_YOCTO, SIGNER_CAP_STATUS, type IntentsAnswer } from "./carry.ts";
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
type Chain = { refuseSimulateOn: number | null; executed?: number; storage: Map<string, "null" | "registered">; finalMs: number; finalMsOf?: [number, number]; paused?: boolean; sims?: number };
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
  const r = relayer(o.outcome ?? (() => "ran"));
  const carry = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads(providers(chain), () => NOW), relayer: r, now: () => NOW, resolveEveryMs: 1 });
  return { dir, store, chain, r, carry };
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

test("RT10 (14) the storage_deposit failing: registration_failed, no intent sent, the signer's count at 1", async () => {
  const s = setup({ outcome: (a) => (a.method === "storage_deposit" ? "failed" : "ran") });
  const u = hex();
  await seeSigner(s.store, u);
  s.chain.storage.set(`${USDC}/fresh.near`, "null");
  count("registration_failed", await s.carry.carry(signedIntent(u, withdraw("fresh.near"))), "registration_failed");
  assert.deepEqual(s.r.sent.map((x) => x.action.method), ["storage_deposit"]);
  assert.equal(s.store.signer(u).failed, 1);
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

test("H1: the two caps bound one signer's cost: 4 execute_intents and 1 storage_deposit, whatever it sends", async () => {
  const s = setup();
  const u = hex();
  await seeSigner(s.store, u);
  for (let k = 0; k < 8; k++) {
    s.chain.storage.set(`${USDC}/fresh${k}.near`, "null");
    await s.carry.carry(signedIntent(u, withdraw(`fresh${k}.near`)));
    await s.carry.carry(signedIntent(u, withdraw("alice.near")));
    await s.carry.idle();
  }
  const m = s.r.sent.map((x) => x.action.method);
  assert.equal(m.filter((x) => x === "storage_deposit").length, 1);
  assert.equal(m.filter((x) => x === "execute_intents").length, 4);
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
      if (a.method === "storage_deposit") s.chain.finalMs = Date.parse("2026-11-07T18:02:00.000Z"); // the chain reached the deadline meanwhile
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
