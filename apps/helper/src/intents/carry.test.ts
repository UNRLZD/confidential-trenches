// node --test apps/helper/src/intents/carry.test.ts: RT10 (markets.md RT10; H4.3's paragraph "The ids' intents on
// /v1/intents"; H7's /v1/intents row): the handler fed the helper's 1Click quote records and status reads (shaped as
// bind/fixtures/oneclick-status.json's recorded answers, with the fields each case names changed), the two NEAR
// providers' answers to block, simulate_intents and storage_balance_of (constructed in the RPC's own shape: a view's
// result as bytes, a refusal as an error), and the relayer's own send and storage_deposit outcomes. intents.near
// itself is not run, so execute_intents end to end is not covered here. 15 cases, 17 requests.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HELPER_INTENTS_CODES } from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import type { Relayer, RelayerAction, Rpc, TxOutcome, TxRef } from "../bind/send.ts";
import { createIntentsCarry, REGISTRATION_YOCTO, type IntentsAnswer } from "./carry.ts";
import { intentsReads } from "./reads.ts";
import { createIntentsStore, onQuoteAnswer, onStatusAnswer, type IntentsStore } from "./records.ts";

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
function seeSigner(store: IntentsStore, u: string) {
  const q = quoteAnswer({ address: hex(), recipient: u, refundTo: u, depositType: "ORIGIN_CHAIN" });
  assert.ok(onQuoteAnswer(q, store));
  assert.equal(onStatusAnswer(statusAnswer("REFUNDED", q), store), u);
}
/** The refund move's quote (wallet refund.ts refundMoveRequest), carried: its deposit address. */
function moveQuote(store: IntentsStore, o: { refundTo: string; recipient: string }) {
  const address = hex();
  assert.ok(onQuoteAnswer(quoteAnswer({ address, ...o }), store));
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
type Chain = { refuseSimulateOn: number | null; storage: Map<string, "null" | "registered">; finalMs: number };
const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
const SIM_OK = { intents_executed: [{ intent_hash: "x", account_id: "u", nonce: "n" }], logs: [], min_deadline: "2026-11-07T18:02:00Z", invariant_violated: null, state: { fee: 1, current_salt: "5628f6c6" } };
function providers(chain: Chain): [Rpc, Rpc] {
  const HASH = base58(Buffer.alloc(32, 7));
  const make =
    (i: number): Rpc =>
    async (method, params) => {
      const p = params as Record<string, unknown>;
      if (method === "block") return { header: { height: 221_603_850, hash: HASH, gas_price: "100000000", timestamp_nanosec: (BigInt(chain.finalMs) * 1_000_000n).toString(), prev_height: 221_603_849 } };
      if (method === "query" && p.request_type === "call_function") {
        const args = JSON.parse(Buffer.from(p.args_base64 as string, "base64").toString());
        const at = { block_height: 221_603_850, block_hash: HASH, logs: [] };
        if (p.method_name === "simulate_intents") {
          if (chain.refuseSimulateOn === i) throw new Error("Server error: Smart contract panicked: invalid signature");
          return { ...at, result: bytes(SIM_OK) };
        }
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
function relayer(outcome: (a: Extract<RelayerAction, { kind: "call" }>) => "ran" | "failed" | "held"): Pick<Relayer, "send" | "resolve" | "balance"> & { sent: Sent[]; release(): void } {
  const sent: Sent[] = [];
  const outs = new Map<string, TxOutcome>();
  let release: () => void = () => {};
  const gate = new Promise<void>((ok) => (release = ok));
  return {
    sent,
    release: () => release(),
    balance: async () => 10n ** 25n,
    async send(action, guard, before) {
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
    async resolve(tx) {
      return outs.get(tx.tx_hash)!;
    },
  };
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
  onQuoteAnswer(quoteAnswer({ address: hex(), recipient: u, refundTo: u }), s.store);
  assert.equal(code(await s.carry.carry(signedIntent(u, withdraw("alice.near")))), "id_not_ours");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (2), (3) a receiver that is the vault: receiver_is_vault, 403, for an ft_withdraw and a transfer", async () => {
  const s = setup();
  const u = hex();
  seeSigner(s.store, u);
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
  seeSigner(s.store, u);
  count("bad_shape", await s.carry.carry(signedIntent(u, withdraw("alice.near", { msg: "" }))), "bad_shape");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (5) a transfer to a deposit address our helper did not quote: not_helper_quote", async () => {
  const s = setup();
  const u = hex();
  seeSigner(s.store, u);
  count("not_helper_quote", await s.carry.carry(signedIntent(u, transfer(hex()))), "not_helper_quote");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (6) an intent past its deadline: expired", async () => {
  const s = setup();
  const u = hex();
  seeSigner(s.store, u);
  const to = moveQuote(s.store, { refundTo: u, recipient: u });
  count("expired", await s.carry.carry(signedIntent(u, transfer(to), { deadline: "2026-11-07T17:59:59.000Z" })), "expired");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (7) simulate_intents refusing the intent on one of the two providers: simulation_refused", async () => {
  const s = setup({ chain: { refuseSimulateOn: 1 } });
  const u = hex();
  seeSigner(s.store, u);
  const to = moveQuote(s.store, { refundTo: u, recipient: u });
  count("simulation_refused", await s.carry.carry(signedIntent(u, transfer(to))), "simulation_refused");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (8) USDC halted: a good transfer and a good ft_withdraw to a registered typed account are both sent, never token_halted", async () => {
  // the carry takes no token watch at all (carry.ts IntentsDeps): a halt cannot hold it. USDC's pause is read here as
  // its FiatToken views would answer it, and only storage_balance_of is read, which a pause does not refuse.
  const s = setup();
  const u = hex();
  seeSigner(s.store, u);
  const to = moveQuote(s.store, { refundTo: u, recipient: u });
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
  seeSigner(s.store, u);
  for (let k = 0; k < 3; k++) {
    const to = moveQuote(s.store, { refundTo: u, recipient: u });
    assert.equal(code(await s.carry.carry(signedIntent(u, transfer(to)))), "sent"); // out, then failed on chain
    await s.carry.idle();
  }
  assert.equal(s.store.signer(u).failed, 3);
  allSent.push(...s.r.sent);
  s.store.close();
  // a restart: the same store reopened by a new carry
  const t = setup({ dir: s.dir });
  const to = moveQuote(t.store, { refundTo: u, recipient: u });
  const a = await t.carry.carry(signedIntent(u, transfer(to)));
  assert.equal(a.status, 403);
  count("sender_struck", a, "sender_struck");
  assert.equal(t.r.sent.length, 0);
  t.store.close();
});

test("RT10 (10) the same intent twice at once: one sent, one in_flight", async () => {
  const s = setup({ outcome: () => "held" });
  const u = hex();
  seeSigner(s.store, u);
  const to = moveQuote(s.store, { refundTo: u, recipient: u });
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
  seeSigner(s.store, u);
  const to = moveQuote(s.store, { refundTo: u, recipient: "So1anaTypedAddress111111111111111111111111" });
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
  seeSigner(s.store, u);
  const to = moveQuote(s.store, { refundTo: hex(), recipient: u });
  count("not_helper_quote", await s.carry.carry(signedIntent(u, transfer(to))), "not_helper_quote");
  assert.equal(s.r.sent.length, 0);
  s.store.close();
});

test("RT10 (13), (15) an ft_withdraw to an unregistered typed account: one storage_deposit from the relayer, then the intent; a second receiver for that signer: receiver_not_registered", async () => {
  const s = setup();
  const u = hex();
  seeSigner(s.store, u);
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
  seeSigner(s.store, u);
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

test("the gate's records: a status answer names a signer only through our own quote record, and only SUCCESS or REFUNDED", () => {
  const s = setup();
  const u = hex();
  const other = hex();
  const q = quoteAnswer({ address: hex(), recipient: u, refundTo: u });
  // a status for an address we never quoted names nobody
  assert.equal(onStatusAnswer(statusAnswer("SUCCESS", q), s.store), null);
  onQuoteAnswer(q, s.store);
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
  assert.equal(onQuoteAnswer(JSON.stringify(dry), s.store), null);
  const addr = JSON.parse(q).quote.depositAddress;
  assert.equal(onQuoteAnswer(quoteAnswer({ address: addr, recipient: other, refundTo: other }), s.store), null);
  assert.equal(s.store.quote(addr)?.refund_to, u);
  s.store.close();
});

test("a payload that is not its own canonical JSON is bad_shape: a repeated key cannot show this file one receiver and intents.near another", async () => {
  const s = setup();
  const u = hex();
  seeSigner(s.store, u);
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
  seeSigner(s.store, u);
  for (const o of [{ depositType: "ORIGIN_CHAIN" }, { refundType: "ORIGIN_CHAIN" }, { deadline: "2026-11-07T17:00:00.000Z" }]) {
    const address = hex();
    onQuoteAnswer(quoteAnswer({ address, recipient: u, refundTo: u, ...o }), s.store);
    assert.equal(code(await s.carry.carry(signedIntent(u, transfer(address)))), "not_helper_quote", JSON.stringify(o));
  }
  s.store.close();
});

test("a registration claimed but never signed (the process stopped between the claim and the signing) is free again after a restart", async () => {
  const s = setup();
  const u = hex();
  seeSigner(s.store, u);
  s.store.putSigner({ signer: u, failed: 0, registration: { receiver: "fresh.near", state: "pending", tx: null } });
  s.store.close();
  const t = setup({ dir: s.dir });
  t.chain.storage.set(`${USDC}/fresh.near`, "null");
  assert.equal(code(await t.carry.carry(signedIntent(u, withdraw("fresh.near")))), "sent");
  await t.carry.idle();
  assert.deepEqual(t.r.sent.map((x) => x.action.method), ["storage_deposit", "execute_intents"]);
  t.store.close();
});
