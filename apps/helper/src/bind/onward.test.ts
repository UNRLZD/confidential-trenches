// node --test apps/helper/src/bind/onward.test.ts: POST /v1/bind's onward move (card relayer-onward-move): a fresh A's
// one ft_transfer of its whole USDC to a 1Click deposit address our helper quoted (depositType ORIGIN_CHAIN), checked
// by onward.ts and carried by intents/carry.ts onward. Every delegate is signed here with real ed25519 by a key made in
// the test; the chain is two providers answering in the RPC's own shape and a relayer whose outcomes the test names.
// main refused this delegate before any of it (checks.ts: not_ft_transfer_call, method_name not ft_transfer_call); the
// first test holds that the deposit carry still refuses it, so the onward kind is the only path that carries it.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HELPER_BIND_ONWARD_CODES, HELPER_CODE_STATUS } from "@blindfill/kit";
import { base58, checkBindDeposit, NEP366_PREFIX, VAULT_TOKEN, type BindReads, type KeyRead } from "./checks.ts";
import { checkOnward, isOnward, ONWARD_GAS_CAP, type OnwardGate, type OnwardMove } from "./onward.ts";
import type { Relayer, RelayerAction, Rpc, TxOutcome, TxRef } from "./send.ts";
import { decodeSignedDelegate } from "./checks.ts";
import { createIntentsCarry, INTENTS_FLOOR_YOCTO, INTENTS_SENDS_MAX, REGISTRATION_YOCTO, type IntentsAnswer } from "../intents/carry.ts";
import { intentsReads } from "../intents/reads.ts";
import { createIntentsStore, STRUCK_AT, type QuoteRecord } from "../intents/records.ts";

const USDC = VAULT_TOKEN;
const VAULT = "vault.confidential.unrlzd.near";
const RELAYER = "bind.confidential.unrlzd.near";
const CFG = { token: USDC, vault: VAULT, relayer: RELAYER };
const FINAL = 221_603_850n;
const NOW = Date.parse("2026-11-23T10:00:00.000Z");
const T = 1_000_000_000_000n;
const BAL = 4_870_123n; // A's whole USDC: the withdrawal less its fee
const hex = () => randomBytes(32).toString("hex");

// ---- a test-side borsh encoder and signer (checks.test.ts's) ----
const le = (n: bigint, len: number): Buffer => {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
};
const str = (s: string | Uint8Array): Buffer => {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s);
  return Buffer.concat([le(BigInt(b.length), 4), b]);
};
type Key = { priv: KeyObject; pub: Buffer; id: string };
function newKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { priv: privateKey, pub, id: pub.toString("hex") };
}
type Fc = { method: string; args: string; gas: bigint; deposit: bigint };
type Spec = { receiver?: string; actions?: Fc[]; nonce?: bigint; mbh?: bigint };
function signed(k: Key, s: Spec = {}): { signed_delegate: string } {
  const acts = (s.actions ?? [move(DEP)]).map((a) => Buffer.concat([Buffer.from([2]), str(a.method), str(a.args), le(a.gas, 8), le(a.deposit, 16)]));
  const delegate = Buffer.concat([str(k.id), str(s.receiver ?? USDC), le(BigInt(acts.length), 4), ...acts, le(s.nonce ?? 11n, 8), le(s.mbh ?? FINAL + 300n, 8), Buffer.from([0]), k.pub]);
  const hash = createHash("sha256").update(le(BigInt(NEP366_PREFIX), 4)).update(delegate).digest();
  return { signed_delegate: Buffer.concat([delegate, Buffer.from([0]), sign(null, hash, k.priv)]).toString("base64") };
}
/** The move as the device writes it: TOKEN.ft_transfer({receiver_id, amount}), 1 yocto, 30 Tgas. */
const move = (to: string, amount = BAL.toString(), o: Partial<Fc> = {}): Fc => ({ method: "ft_transfer", args: JSON.stringify({ receiver_id: to, amount }), gas: 30n * T, deposit: 1n, ...o });
const DEP = hex(); // the 1Click deposit address the default delegate pays

// ---- the reads and the store's gate ----
function readsFor(k: Key, o: { nonce?: bigint; balance?: bigint } = {}): Pick<BindReads, "accessKey" | "finalHeight" | "ftBalance"> & { balanceReads: number } {
  const r = {
    balanceReads: 0,
    async accessKey(account: string, publicKey: string): Promise<KeyRead> {
      if (account !== k.id) return { kind: "no_account" };
      if (publicKey !== `ed25519:${base58(k.pub)}`) return { kind: "no_key" };
      return { kind: "key", permission: "FullAccess", nonce: o.nonce ?? 10n };
    },
    finalHeight: async () => FINAL,
    async ftBalance(account: string) {
      r.balanceReads++;
      return account === k.id ? (o.balance ?? BAL) : 0n;
    },
  };
  return r;
}
const quoteFor = (a: string, o: Partial<QuoteRecord> = {}): QuoteRecord => ({
  deposit_address: DEP,
  recipient: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", // the user's wallet on the destination chain
  recipient_type: "DESTINATION_CHAIN",
  refund_to: a,
  refund_type: "ORIGIN_CHAIN",
  deposit_type: "ORIGIN_CHAIN",
  deadline_ms: NOW + 30 * 60_000,
  ...o,
});
function gateFor(a: string, quotes: QuoteRecord[] = [quoteFor(a)], seen = true): OnwardGate {
  const q = new Map(quotes.map((x) => [x.deposit_address, x]));
  return { seen: (x) => seen && x === a, quote: (x) => q.get(x) ?? null };
}
const at = () => NOW;
const codeOf = (v: Awaited<ReturnType<typeof checkOnward>>) => (v.ok ? "ok" : v.code);

// ---- the checks ----

test("main's path still refuses the move (not_ft_transfer_call): the onward kind is the only one that carries it, and isOnward names it", async () => {
  const k = newKey();
  const body = signed(k);
  const ledger = { struck: async () => false, boundTo: async () => null, openP: async () => null, inFlight: async () => false };
  const dep = await checkBindDeposit(body, { vault: VAULT, token: USDC, marginK: 30n }, { ...readsFor(k), pUsed: async () => false }, ledger);
  assert.deepEqual(dep.ok ? "ok" : dep.code, "not_ft_transfer_call");
  const d = decodeSignedDelegate(new Uint8Array(Buffer.from(body.signed_delegate, "base64")));
  assert.equal(isOnward(d.actions), true);
  const deposit = decodeSignedDelegate(new Uint8Array(Buffer.from(signed(k, { actions: [{ method: "ft_transfer_call", args: "{}", gas: 180n * T, deposit: 1n }] }).signed_delegate, "base64")));
  assert.equal(isOnward(deposit.actions), false, "the deposit's ft_transfer_call stays the deposit carry's");
});

test("the good move: A's whole USDC to our live ORIGIN_CHAIN quote refunding to A passes, its bytes carried byte for byte", async () => {
  const k = newKey();
  const body = signed(k);
  const v = await checkOnward(body, CFG, readsFor(k), gateFor(k.id), at);
  assert.ok(v.ok, v.ok ? "" : v.code);
  const m = (v as { move: OnwardMove }).move;
  assert.deepEqual([m.sender, m.receiver, m.amount, m.nonce, m.max_block_height], [k.id, DEP, BAL, 11n, FINAL + 300n]);
  assert.equal(Buffer.from(m.signed_delegate).toString("base64"), body.signed_delegate);
});

test("checks 1-3 come first, so an unseen id learns nothing: a bad signature, no account, a key not on A, a used nonce", async () => {
  const k = newKey();
  const other = newKey();
  const raw = Buffer.from(signed(k).signed_delegate, "base64");
  raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
  const unseen = gateFor("someone-else");
  assert.equal(codeOf(await checkOnward({ signed_delegate: raw.toString("base64") }, CFG, readsFor(k), unseen, at)), "bad_signature");
  assert.equal(codeOf(await checkOnward(signed(k), CFG, readsFor(other), unseen, at)), "no_account");
  assert.equal(codeOf(await checkOnward(signed(k, { nonce: 10n }), CFG, readsFor(k), unseen, at)), "bad_nonce");
  assert.equal(codeOf(await checkOnward({ signed_delegate: "!" }, CFG, readsFor(k), unseen, at)), "bad_shape");
  // past them, the gate: an id no withdrawal of ours paid, before any read of its money
  const r = readsFor(k);
  assert.equal(codeOf(await checkOnward(signed(k), CFG, r, unseen, at)), "id_not_ours");
  assert.equal(r.balanceReads, 0);
});

test("the move's shape is judged from its own bytes before the signature and any read: amount 0, a second action, args that are no object are bad_shape for anyone", async () => {
  const k = newKey();
  const none = {
    accessKey: async (): Promise<KeyRead> => assert.fail("no key read for a misshapen move"),
    finalHeight: async (): Promise<bigint> => assert.fail("no height read"),
    ftBalance: async (): Promise<bigint> => assert.fail("no balance read"),
  };
  const unseen = gateFor("someone-else");
  const flip = (b: { signed_delegate: string }) => {
    const raw = Buffer.from(b.signed_delegate, "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    return { signed_delegate: raw.toString("base64") };
  };
  for (const s of [{ actions: [move(DEP, "0")] }, { actions: [move(DEP), move(DEP)] }, { actions: [{ ...move(DEP), args: "[1]" }] }, { actions: [move(DEP, (1n << 128n).toString())] }])
    for (const body of [signed(k, s), flip(signed(k, s))]) assert.equal(codeOf(await checkOnward(body, CFG, none, unseen, at)), "bad_shape");
});

test("not_paid while A holds nothing yet; expired at or past the final height and over 600 blocks ahead", async () => {
  const k = newKey();
  assert.equal(codeOf(await checkOnward(signed(k), CFG, readsFor(k, { balance: 0n }), gateFor(k.id), at)), "not_paid");
  assert.equal(codeOf(await checkOnward(signed(k, { mbh: FINAL }), CFG, readsFor(k), gateFor(k.id), at)), "expired");
  assert.equal(codeOf(await checkOnward(signed(k, { mbh: FINAL + 601n }), CFG, readsFor(k), gateFor(k.id), at)), "expired");
  assert.equal(codeOf(await checkOnward(signed(k, { mbh: FINAL + 600n }), CFG, readsFor(k), gateFor(k.id), at)), "ok");
});

test("the shape: one ft_transfer on the release's USDC, 1 yocto, at most 100 Tgas; a second transfer is refused", async () => {
  const k = newKey();
  const g = gateFor(k.id);
  const c = async (s: Spec) => codeOf(await checkOnward(signed(k, s), CFG, readsFor(k), g, at));
  assert.equal(await c({ actions: [move(DEP), move(DEP)] }), "bad_shape");
  assert.equal(await c({ actions: [move(DEP, BAL.toString(), { method: "ft_transfer_call" })] }), "bad_shape");
  assert.equal(await c({ receiver: "usdt.tether-token.near" }), "token_not_accepted");
  assert.equal(await c({ actions: [move(DEP, BAL.toString(), { deposit: 0n })] }), "deposit_not_1_yocto");
  assert.equal(await c({ actions: [move(DEP, BAL.toString(), { deposit: 2n })] }), "deposit_not_1_yocto");
  assert.equal(await c({ actions: [move(DEP, BAL.toString(), { gas: ONWARD_GAS_CAP + 1n })] }), "gas_too_high");
  assert.equal(await c({ actions: [move(DEP, BAL.toString(), { gas: ONWARD_GAS_CAP })] }), "ok");
});

test("the args: exactly {receiver_id, amount} as JSON.stringify writes them; a memo, another order or a space is bad_msg", async () => {
  const k = newKey();
  const g = gateFor(k.id);
  const c = async (args: string) => codeOf(await checkOnward(signed(k, { actions: [{ ...move(DEP), args }] }), CFG, readsFor(k), g, at));
  const amt = BAL.toString();
  assert.equal(await c(JSON.stringify({ receiver_id: DEP, amount: amt, memo: "hi" })), "bad_msg");
  assert.equal(await c(JSON.stringify({ amount: amt, receiver_id: DEP })), "bad_msg");
  assert.equal(await c(`{"receiver_id": "${DEP}","amount":"${amt}"}`), "bad_msg");
  assert.equal(await c(JSON.stringify({ receiver_id: DEP, amount: Number(amt) })), "bad_msg");
  assert.equal(await c("not json"), "bad_shape");
  assert.equal(await c(JSON.stringify({ receiver_id: DEP, amount: "0" })), "bad_shape");
  assert.equal(await c(JSON.stringify({ receiver_id: DEP, amount: "01" })), "bad_shape");
});

test("the receiver: only our live ORIGIN_CHAIN quote refunding to A, delivered on the destination chain; intents.near and the vault never", async () => {
  const k = newKey();
  const a = k.id;
  const c = async (to: string, quotes: QuoteRecord[]) => codeOf(await checkOnward(signed(k, { actions: [move(to)] }), CFG, readsFor(k), gateFor(a, quotes), at));
  assert.equal(await c(hex(), [quoteFor(a)]), "not_helper_quote", "an address our helper did not quote");
  assert.equal(await c("intents.near", [quoteFor(a)]), "not_helper_quote", "intents.near is never a quote's deposit address");
  assert.equal(await c(DEP, [quoteFor(a, { deposit_type: "INTENTS" })]), "not_helper_quote");
  assert.equal(await c(DEP, [quoteFor(a, { refund_to: hex() })]), "not_helper_quote", "a refund that would go to another id");
  assert.equal(await c(DEP, [quoteFor(a, { refund_type: "INTENTS" })]), "not_helper_quote", "a refund into an intents balance");
  assert.equal(await c(DEP, [quoteFor(a, { deadline_ms: NOW })]), "not_helper_quote", "a quote past its deadline");
  assert.equal(await c(DEP, [quoteFor(a, { recipient: VAULT })]), "bad_receiver");
  assert.equal(await c(DEP, [quoteFor(a, { recipient: "intents.near" })]), "bad_receiver");
  assert.equal(await c(DEP, [quoteFor(a, { recipient: RELAYER })]), "bad_receiver");
  assert.equal(await c(DEP, [quoteFor(a, { recipient_type: "INTENTS" })]), "bad_receiver", "delivered into an intents.near balance");
  assert.equal(await c(VAULT, [quoteFor(a, { deposit_address: VAULT })]), "bad_receiver");
});

test("the amount: A's whole USDC, never less (amount_not_whole) and never more (amount_above_balance)", async () => {
  const k = newKey();
  const g = gateFor(k.id);
  const c = async (amount: bigint) => codeOf(await checkOnward(signed(k, { actions: [move(DEP, amount.toString())] }), CFG, readsFor(k), g, at));
  assert.equal(await c(BAL - 1n), "amount_not_whole");
  assert.equal(await c(BAL + 1n), "amount_above_balance");
  assert.equal(await c(BAL), "ok");
});

test("the codes onward.ts answers are the kit's onward codes, first answered in the kit's order", () => {
  const src = readFileSync(new URL("./onward.ts", import.meta.url), "utf8");
  const used = [...src.matchAll(/\bno\("([a-z_0-9]+)"/g)].map((m) => m[1]!);
  const order = HELPER_BIND_ONWARD_CODES as readonly string[];
  assert.ok(used.length > 0 && used.every((c) => order.includes(c)), used.join());
  const firsts = [...new Set(used)].filter((c) => c !== "bad_shape").map((c) => order.indexOf(c));
  assert.deepEqual(firsts, [...firsts].sort((a, b) => a - b));
  // the statuses the device reads (kit helper/v1.ts HELPER_CODE_STATUS; a code it does not list answers 400)
  assert.deepEqual([HELPER_CODE_STATUS.id_not_ours, HELPER_CODE_STATUS.not_paid, HELPER_CODE_STATUS.receiver_not_registered], [403, 409, 409]);
});

// ---- the carry: the deposit address's registration, then A's delegate from the relayer ----

type Sent = { action: RelayerAction; tx: TxRef };
function world(o: { registered?: boolean; paused?: boolean; moveFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "onward-"));
  const store = createIntentsStore(dir, undefined, () => NOW);
  const storage = new Set<string>(o.registered === true ? [DEP] : []);
  const HASH = base58(Buffer.alloc(32, 7));
  const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
  const provider: Rpc = async (method, params) => {
    const p = params as Record<string, unknown>;
    if (method === "block") return { header: { height: Number(FINAL), hash: HASH, gas_price: "100000000", timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString(), prev_height: Number(FINAL) - 1 } };
    if (method === "query" && p.request_type === "call_function" && p.method_name === "storage_balance_of") {
      const args = JSON.parse(Buffer.from(p.args_base64 as string, "base64").toString());
      return { block_height: Number(FINAL), block_hash: HASH, logs: [], result: bytes(p.account_id === USDC && storage.has(args.account_id) ? { total: REGISTRATION_YOCTO.toString(), available: "0" } : null) };
    }
    throw new Error(`unexpected ${method}`);
  };
  const sent: Sent[] = [];
  const outs = new Map<string, TxOutcome>();
  const r = {
    sent,
    funds: 10n ** 25n,
    balance: async () => r.funds,
    async send(action: RelayerAction, guard: () => Promise<string | null>, before: (tx: TxRef) => void) {
      const code = await guard();
      if (code !== null) return { kind: "guarded" as const, code };
      const tx: TxRef = { tx_hash: base58(randomBytes(32)), nonce: String(sent.length + 1), height: String(FINAL), block_hash: HASH, signed_tx: "" };
      before(tx);
      sent.push({ action, tx });
      if (action.kind === "call" && action.method === "storage_deposit") {
        storage.add(JSON.parse(action.args).account_id);
        const out: TxOutcome = { kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: USDC, ok: true, failure: "", height: 1n }] };
        outs.set(tx.tx_hash, out);
        return out;
      }
      const ok = o.moveFails !== true;
      outs.set(tx.tx_hash, { kind: "final", tx_hash: tx.tx_hash, receipts: [{ executor: USDC, ok, failure: ok ? "" : '{"Failure":"x"}', height: 1n }] });
      return { kind: "unknown" as const, tx_hash: tx.tx_hash, why: "sent; not read yet" };
    },
    async resolve(tx: TxRef) {
      return outs.get(tx.tx_hash)!;
    },
  };
  const carry = createIntentsCarry({ vault: VAULT, usdc: USDC, store, reads: intentsReads([provider, provider], () => NOW), relayer: r as unknown as Pick<Relayer, "send" | "resolve" | "balance">, held: async () => o.paused === true, now: () => NOW, resolveEveryMs: 1 });
  return { store, r, carry, storage };
}
const answer = (a: IntentsAnswer) => ("error" in a.body ? a.body.error.code : "sent");
const moveOf = (k: Key, o: { receiver?: string; nonce?: bigint } = {}): OnwardMove => {
  const to = o.receiver ?? DEP;
  const b = signed(k, { actions: [move(to)], nonce: o.nonce ?? 11n });
  return { sender: k.id, nonce: o.nonce ?? 11n, max_block_height: FINAL + 300n, receiver: to, amount: BAL, signed_delegate: new Uint8Array(Buffer.from(b.signed_delegate, "base64")) };
};
const height = async () => FINAL;

test("carried: the relayer registers the 1Click deposit address on USDC (0.00125 N, once), then sends A's delegate as signed, paying gas only", async () => {
  const w = world();
  const k = newKey();
  const m = moveOf(k);
  const a = await w.carry.onward(m, height);
  assert.equal(answer(a), "sent", JSON.stringify(a.body));
  assert.equal(a.status, 200);
  assert.equal(w.r.sent.length, 2);
  const [reg, mv] = w.r.sent;
  assert.deepEqual(reg!.action, { kind: "call", receiver: USDC, method: "storage_deposit", args: JSON.stringify({ account_id: DEP, registration_only: true }), gas: (reg!.action as { gas: bigint }).gas, deposit: REGISTRATION_YOCTO });
  assert.equal(mv!.action.kind, "delegate");
  assert.equal(Buffer.from((mv!.action as { signed: Uint8Array }).signed).toString("base64"), Buffer.from(m.signed_delegate).toString("base64"), "byte for byte");
  await w.carry.idle();
  assert.equal(w.store.signer(k.id).failed, 0);
  // sent again (the device's same bytes after a lost answer): the address reads registered, no second registration
  const again = await w.carry.onward(moveOf(k, { nonce: 12n }), height);
  assert.equal(answer(again), "sent");
  assert.equal(w.r.sent.filter((s) => s.action.kind === "call").length, 1);
  await w.carry.idle();
  w.store.close();
});

test("an address already registered on USDC: no registration, the delegate only", async () => {
  const w = world({ registered: true });
  const k = newKey();
  assert.equal(answer(await w.carry.onward(moveOf(k), height)), "sent");
  assert.deepEqual(w.r.sent.map((s) => s.action.kind), ["delegate"]);
  await w.carry.idle();
  w.store.close();
});

test("one deposit address per A: after its registration landed, a move to a second unregistered address is receiver_not_registered", async () => {
  const w = world();
  const k = newKey();
  assert.equal(answer(await w.carry.onward(moveOf(k), height)), "sent");
  await w.carry.idle();
  const a = await w.carry.onward(moveOf(k, { receiver: hex(), nonce: 12n }), height);
  assert.equal(answer(a), "receiver_not_registered");
  assert.equal(a.status, 409);
  assert.equal(w.r.sent.length, 2, "nothing more paid");
  w.store.close();
});

test("held USDC: token_halted, nothing sent; a low gas account: relayer_low; a struck A: sender_struck; expired at the final height", async () => {
  const held = world({ registered: true, paused: true });
  const k = newKey();
  const h = await held.carry.onward(moveOf(k), height);
  assert.deepEqual([answer(h), h.status], ["token_halted", 503]);
  assert.equal(held.r.sent.length, 0);
  held.store.close();

  const low = world({ registered: true });
  low.r.funds = INTENTS_FLOOR_YOCTO - 1n;
  assert.equal(answer(await low.carry.onward(moveOf(k), height)), "relayer_low");
  assert.equal(low.r.sent.length, 0);
  low.store.close();

  const struck = world({ registered: true });
  struck.store.putSigner({ ...struck.store.signer(k.id), failed: STRUCK_AT });
  assert.equal(answer(await struck.carry.onward(moveOf(k), height)), "sender_struck");
  assert.equal(struck.r.sent.length, 0);
  struck.store.close();

  const late = world({ registered: true });
  assert.equal(answer(await late.carry.onward(moveOf(k), async () => FINAL + 300n)), "expired");
  assert.equal(late.r.sent.length, 0);
  late.store.close();
});

test("the same signed move twice at once: one is sent, the other in_flight", async () => {
  const w = world({ registered: true });
  const k = newKey();
  const [x, y] = await Promise.all([w.carry.onward(moveOf(k), height), w.carry.onward(moveOf(k), height)]);
  assert.deepEqual([answer(x), answer(y)].sort(), ["in_flight", "sent"]);
  assert.equal(w.r.sent.length, 1);
  await w.carry.idle();
  w.store.close();
});

test("a move that fails on chain counts toward A's three; A's sends stay under the cap", async () => {
  const w = world({ registered: true, moveFails: true });
  const k = newKey();
  assert.equal(answer(await w.carry.onward(moveOf(k), height)), "sent");
  await w.carry.idle();
  assert.equal(w.store.signer(k.id).failed, 1);
  for (let i = 1; i < INTENTS_SENDS_MAX; i++) {
    await w.carry.onward(moveOf(k, { nonce: 11n + BigInt(i) }), height);
    await w.carry.idle();
  }
  const capped = await w.carry.onward(moveOf(k, { nonce: 99n }), height);
  assert.ok(["sender_struck", "signer_cap"].includes(answer(capped)), answer(capped));
  assert.ok(w.r.sent.length <= INTENTS_SENDS_MAX);
  w.store.close();
});
