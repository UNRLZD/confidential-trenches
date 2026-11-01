// checks.ts, one case per check in H4.3's order (M:1707-1754), V 2.10 (e)'s message clauses (V:693-703), the beta cap
// (OD:262) and R1-R3 (M:1816-1834). Every delegate is signed here with real ed25519 by a key made in the test; one is
// recorded from near-api-js 7.3.1 (fixtures/near-api-js-deposit.json), an encoder outside the helper.
//   node --test apps/helper/src/bind/checks.test.ts
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HELPER_BIND_DEPOSIT_CODES,
  HELPER_V1_PATHS,
  VAULT_CONSTANTS,
  VAULT_DEPOSIT_CARRIER,
  VAULT_DEPOSIT_MESSAGE_FIELDS,
  VAULT_DEPOSIT_MESSAGE_MAX_BYTES,
  VAULT_DEPOSIT_SIGNERS,
  VAULT_FIELD_P,
  vaultAccountId,
  vaultDepositMessage,
} from "../../../../packages/kit/src/index.ts";
import {
  BETA_CAP,
  BIND_DEPOSIT_CODES,
  BIND_MAX_BYTES,
  CAP_CODE,
  CARRIER,
  DEPOSIT_MESSAGE_FIELDS,
  DEPOSIT_MESSAGE_MAX_BYTES,
  FIELD_P,
  G_BIND_CAP,
  MIN_DEPOSIT,
  NEP366_PREFIX,
  VAULT_TOKEN,
  base58,
  checkBindDeposit,
  isAccountId,
  type BindConfig,
  type BindLedger,
  type BindReads,
  type BindVerdict,
  type KeyRead,
} from "./checks.ts";

const VAULT = "vault.confidential.unrlzd.near";
const CFG: BindConfig = { vault: VAULT, token: VAULT_TOKEN, marginK: 30n };
const FINAL = 180_000_000n;
const T = 1_000_000_000_000n;

// ---- A test-side borsh encoder and signer ----

type Act = { fc: { method: string; args: string | Uint8Array; gas: bigint; deposit: bigint } } | { del: string } | { raw: Uint8Array };
type Spec = { sender: string; receiver: string; actions: Act[]; nonce: bigint; mbh: bigint; keyTag?: number; sigTag?: number };

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

function encode(s: Spec, k: Key): Buffer {
  const acts = s.actions.map((a) => {
    if ("fc" in a) return Buffer.concat([Buffer.from([2]), str(a.fc.method), str(a.fc.args), le(a.fc.gas, 8), le(a.fc.deposit, 16)]);
    if ("del" in a) return Buffer.concat([Buffer.from([7]), str(a.del)]);
    return Buffer.from(a.raw);
  });
  const delegate = Buffer.concat([
    str(s.sender),
    str(s.receiver),
    le(BigInt(acts.length), 4),
    ...acts,
    le(s.nonce, 8),
    le(s.mbh, 8),
    Buffer.from([s.keyTag ?? 0]),
    k.pub,
  ]);
  const hash = createHash("sha256").update(le(BigInt(NEP366_PREFIX), 4)).update(delegate).digest();
  return Buffer.concat([delegate, Buffer.from([s.sigTag ?? 0]), sign(null, hash, k.priv)]);
}

const U = newKey();
const P = 1234567890123456789012345678901234567890n;
const args = (o: Partial<{ receiver_id: string; amount: string; msg: string }> = {}, id = U.id): string =>
  JSON.stringify({ receiver_id: VAULT, amount: "25000000", msg: vaultDepositMessage(P, id), ...o });
const fc = (o: Partial<{ method: string; args: string | Uint8Array; gas: bigint; deposit: bigint }> = {}, id = U.id): Act => ({
  fc: { method: "ft_transfer_call", args: args({}, id), gas: 180n * T, deposit: 1n, ...o },
});
const spec = (o: Partial<Spec> = {}, k = U): Spec => ({ sender: k.id, receiver: VAULT_TOKEN, actions: [fc({}, k.id)], nonce: 101n, mbh: FINAL + 120n, ...o });
const body = (s: Spec, k = U): { signed_delegate: string } => ({ signed_delegate: encode(s, k).toString("base64") });
const withMsg = (msg: string): Spec => spec({ actions: [fc({ args: args({ msg }) })] });

// ---- Reads and ledger that record every call ----

type World = {
  key?: KeyRead;
  balance?: bigint;
  used?: boolean;
  struck?: boolean;
  bound?: string | null;
  open?: bigint | null;
  inFlight?: boolean;
  final?: bigint;
};
function run(req: unknown, w: World = {}, cfg = CFG): Promise<BindVerdict> & { calls: string[] } {
  const calls: string[] = [];
  const reads: BindReads = {
    accessKey: async (a, pk) => (calls.push(`accessKey ${a} ${pk}`), w.key ?? { kind: "key", fullAccess: true, nonce: 100n }),
    finalHeight: async () => (calls.push("finalHeight"), w.final ?? FINAL),
    ftBalance: async (a) => (calls.push(`ftBalance ${a}`), w.balance ?? 50_000_000_000n),
    pUsed: async (p) => (calls.push(`pUsed ${p}`), w.used ?? false),
  };
  const ledger: BindLedger = {
    struck: async (u) => (calls.push(`struck ${u}`), w.struck ?? false),
    boundTo: async (p) => (calls.push(`boundTo ${p}`), w.bound ?? null),
    openP: async (u) => (calls.push(`openP ${u}`), w.open ?? null),
    inFlight: async (u, p) => (calls.push(`inFlight ${u} ${p}`), w.inFlight ?? false),
  };
  const out = checkBindDeposit(req, cfg, reads, ledger) as Promise<BindVerdict> & { calls: string[] };
  out.calls = calls;
  return out;
}
async function refused(req: unknown, code: string, why: string, w: World = {}): Promise<string[]> {
  const r = run(req, w);
  assert.deepEqual(await r, { ok: false, code, why });
  return r.calls;
}
async function passes(req: unknown, w: World = {}): Promise<void> {
  const v = await run(req, w);
  assert.equal(v.ok, true, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)));
}

// ---- The kit's values, compared through its public entry ----

test("every value copied from the kit equals the kit's public entry", () => {
  assert.deepEqual([...BIND_DEPOSIT_CODES], [...HELPER_BIND_DEPOSIT_CODES]);
  assert.equal(BIND_MAX_BYTES, HELPER_V1_PATHS.find((p) => p.path === "/v1/bind")!.limitBytes);
  assert.equal(VAULT_TOKEN, VAULT_CONSTANTS.TOKEN);
  assert.equal(MIN_DEPOSIT, VAULT_CONSTANTS.MIN_DEPOSIT);
  assert.equal(FIELD_P, VAULT_FIELD_P);
  assert.deepEqual([...DEPOSIT_MESSAGE_FIELDS], [...VAULT_DEPOSIT_MESSAGE_FIELDS]);
  assert.equal(DEPOSIT_MESSAGE_MAX_BYTES, VAULT_DEPOSIT_MESSAGE_MAX_BYTES);
  assert.deepEqual(
    { method: CARRIER.method, args: [...CARRIER.args], deposit_yocto: CARRIER.deposit_yocto, gas_tgas: CARRIER.gas_tgas },
    { method: VAULT_DEPOSIT_CARRIER.method, args: [...VAULT_DEPOSIT_CARRIER.args], deposit_yocto: VAULT_DEPOSIT_CARRIER.deposit_yocto, gas_tgas: VAULT_DEPOSIT_CARRIER.gas_tgas },
  );
  assert.equal(VAULT_DEPOSIT_CARRIER.receiver_id, "TOKEN");
  for (const s of ["ab", "a", "vault.confidential.unrlzd.near", U.id, "Upper.near", "a..b", "a-", "-a", "a_b-c.d", "x".repeat(64), "x".repeat(65), "intents.near", "a.b.", ""]) {
    let kit = true;
    try {
      vaultAccountId(s, "t");
    } catch {
      kit = false;
    }
    assert.equal(isAccountId(s), kit, s);
  }
});

test("the codes this file answers are the kit's, in the kit's order, with the cap after amount_too_low", () => {
  const src = readFileSync(new URL("./checks.ts", import.meta.url), "utf8");
  const used = [...src.matchAll(/no\("([a-z_0-9]+)"|no\(CAP_CODE/g)].map((m) => m[1] ?? CAP_CODE);
  const order = [...BIND_DEPOSIT_CODES.slice(0, 16), CAP_CODE, ...BIND_DEPOSIT_CODES.slice(16)];
  const pos = used.map((c) => order.indexOf(c as (typeof order)[number]));
  assert.ok(pos.every((p) => p >= 0), used.join());
  const firsts = [...new Set(used)].filter((c) => c !== "bad_shape").map((c) => order.indexOf(c as (typeof order)[number]));
  assert.deepEqual(firsts, [...firsts].sort((a, b) => a - b));
  // CAP_CODE is the one code outside the kit's frozen list (card kit-deposit-cap adds it to the kit).
  assert.deepEqual([...new Set(used)].filter((c) => !(HELPER_BIND_DEPOSIT_CODES as readonly string[]).includes(c)), [CAP_CODE]);
});

// ---- The good call, ours and an outside encoder's ----

test("the frozen deposit call passes, and the verdict carries the signed bytes as sent", async () => {
  const b = body(spec());
  const v = await run(b);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(Buffer.from(v.deposit.signed_delegate).toString("base64"), b.signed_delegate);
  assert.deepEqual([v.deposit.sender_id, v.deposit.amount, v.deposit.precommitment, v.deposit.depositor, v.deposit.nonce, v.deposit.max_block_height], [U.id, 25_000_000n, P, U.id, 101n, FINAL + 120n]);
});

test("a delegate recorded from near-api-js 7.3.1 decodes, verifies and passes; one byte changed fails its signature", async () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/near-api-js-deposit.json", import.meta.url), "utf8"));
  const w: World = { key: { kind: "key", fullAccess: true, nonce: BigInt(f.nonce) - 1n }, final: BigInt(f.max_block_height) - 120n };
  const r = run({ signed_delegate: f.signed_delegate }, w, { ...CFG, vault: f.vault });
  const v = await r;
  assert.equal(v.ok, true, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)));
  if (!v.ok) return;
  assert.equal(v.deposit.public_key, f.public_key); // base58 of the key, as near-api-js writes it
  assert.deepEqual([v.deposit.sender_id, String(v.deposit.nonce), String(v.deposit.max_block_height), String(v.deposit.gas), String(v.deposit.amount), String(v.deposit.precommitment)], [f.sender_id, f.nonce, f.max_block_height, f.gas, f.amount, f.precommitment]);
  assert.ok(r.calls.includes(`accessKey ${f.sender_id} ${f.public_key}`));
  const bad = Buffer.from(f.signed_delegate, "base64");
  bad[bad.indexOf(Buffer.from("25000000"))] = "3".charCodeAt(0);
  assert.deepEqual(await run({ signed_delegate: bad.toString("base64") }, w, { ...CFG, vault: f.vault }), { ok: false, code: "bad_signature", why: "signature: does not verify over the delegate" });
});

test("R's and V's moves are the same call: three ids, the same verdicts, read by the id and P only", async () => {
  for (const k of [U, newKey(), newKey()]) {
    await passes(body(spec({}, k), k));
    const r = run(body(spec({}, k), k), { struck: true });
    assert.equal((await r).ok, false);
    assert.deepEqual(r.calls, [`accessKey ${k.id} ed25519:${base58(k.pub)}`, `struck ${k.id}`]);
  }
  assert.equal(VAULT_DEPOSIT_SIGNERS.R, VAULT_DEPOSIT_SIGNERS.U);
  assert.equal(VAULT_DEPOSIT_SIGNERS.V, VAULT_DEPOSIT_SIGNERS.U);
  const r = run(body(spec()));
  await r;
  const keyed = r.calls.filter((c) => /^(struck|boundTo|openP|inFlight) /.test(c));
  assert.deepEqual(keyed, [`struck ${U.id}`, `boundTo ${P}`, `openP ${U.id}`, `inFlight ${U.id} ${P}`]);
});

test("marginK must be pinned: no interim value", async () => {
  for (const marginK of [0n, 601n, 30 as unknown as bigint]) await assert.rejects(run(body(spec()), {}, { ...CFG, marginK }), /marginK/);
});

// ---- 1. Decoding ----

test("check 1: decoding refuses before any read", async () => {
  const good = encode(spec(), U);
  const cases: [unknown, string][] = [
    [null, "body: not an object"],
    [[good.toString("base64")], "body: not an object"],
    [{ signed_delegate: good.toString("base64"), ip: "1.2.3.4" }, "body: not {signed_delegate} alone"],
    [{ signed_delegate: 7 }, "signed_delegate: not a string"],
    [{ signed_delegate: "A".repeat(5468) }, "signed_delegate: over 4 KB of base64"],
    [{ signed_delegate: good.toString("base64url") + "-" }, "signed_delegate: not standard base64"],
    [{ signed_delegate: good.toString("base64").slice(0, -1) }, "signed_delegate: not standard base64"],
    [{ signed_delegate: "QR==" }, "signed_delegate: not canonical base64"],
    [{ signed_delegate: good.subarray(0, good.length - 1).toString("base64") }, "borsh: short"],
    [{ signed_delegate: Buffer.concat([good, Buffer.from([0])]).toString("base64") }, "borsh: bytes after the signature"],
    [body(spec({ actions: [{ raw: Buffer.concat([Buffer.from([3]), le(1n, 16)]) }] })), "borsh: action: tag 3 is not carried"],
    [body(spec({ keyTag: 1 })), "borsh: public_key: not ed25519"],
    [body(spec({ sigTag: 1 })), "borsh: signature: not ed25519"],
    [{ signed_delegate: badUtf8() }, "borsh: The encoded data was not valid for encoding utf-8"],
  ];
  for (const [req, why] of cases) assert.deepEqual(await refused(req, "bad_shape", why), [], why);
});

function badUtf8(): string {
  const b = encode(spec(), U);
  b[4] = 0xff; // the first byte of sender_id
  return b.toString("base64");
}

test("check 1: a NEP-413 signed message alone is bad_shape", async () => {
  const nep413 = { message: "deposit", recipient: "vault.confidential.unrlzd.near", nonce: Buffer.alloc(32).toString("base64"), publicKey: `ed25519:${base58(U.pub)}`, signature: "x" };
  await refused({ signed_delegate: Buffer.from(JSON.stringify(nep413)).toString("base64") }, "bad_shape", "borsh: short");
  await refused({ signed_message: nep413 }, "bad_shape", "body: not {signed_delegate} alone");
});

test("check 1: at most 4 KB decoded: 4,096 bytes are read on, 4,097 refused", async () => {
  const sized = (n: number): { signed_delegate: string } => {
    const base = encode(withMsg("x"), U).length - 1;
    return body(withMsg("x".repeat(n - base)));
  };
  assert.equal(Buffer.from(sized(4096).signed_delegate, "base64").length, 4096);
  await refused(sized(4096), "bad_msg", "msg: over 1,024 bytes");
  await refused(sized(4097), "bad_shape", "signed_delegate: over 4 KB");
});

// ---- 2. Signature ----

test("check 2: a byte changed after signing, or another key's signature, is bad_signature before any read", async () => {
  const b = encode(spec(), U);
  b[b.indexOf(Buffer.from("25000000"))] = "9".charCodeAt(0);
  assert.deepEqual(await refused({ signed_delegate: b.toString("base64") }, "bad_signature", "signature: does not verify over the delegate"), []);
  const other = newKey();
  const forged = encode(spec(), other);
  forged.set(U.pub, forged.length - 65 - 32); // U's key in the delegate, other's signature
  assert.deepEqual(await refused({ signed_delegate: forged.toString("base64") }, "bad_signature", "signature: does not verify over the delegate"), []);
});

// ---- 3. Sender ----

test("check 3: sender a 64-hex account that holds the key as full access, nonce above the key's", async () => {
  assert.deepEqual(await refused(body(spec({ sender: "alice.near" })), "no_account", "sender_id: not a 64-hex implicit account"), []);
  await refused(body(spec({ sender: U.id.toUpperCase() })), "no_account", "sender_id: not a 64-hex implicit account");
  await refused(body(spec()), "no_account", "sender_id: no such account", { key: { kind: "no_account" } });
  await refused(body(spec()), "bad_key", "public_key: not on the sender", { key: { kind: "no_key" } });
  await refused(body(spec()), "bad_key", "public_key: not a full-access key", { key: { kind: "key", fullAccess: false, nonce: 1n } });
  await refused(body(spec()), "bad_nonce", "nonce: not above the key's nonce", { key: { kind: "key", fullAccess: true, nonce: 101n } });
  await passes(body(spec()), { key: { kind: "key", fullAccess: true, nonce: 100n } });
});

test("R3: a struck sender gets sender_struck right after checks 1-3, before expiry", async () => {
  const calls = await refused(body(spec({ mbh: FINAL })), "sender_struck", "R3: sender struck", { struck: true });
  assert.ok(!calls.includes("finalHeight"));
});

// ---- 4. Expiry ----

test("check 4: ahead of final, at most 600 blocks ahead, at least K ahead", async () => {
  await refused(body(spec({ mbh: FINAL })), "expired", "max_block_height: not ahead of the final height");
  await refused(body(spec({ mbh: FINAL + 601n })), "expired", "max_block_height: over 600 blocks ahead");
  await passes(body(spec({ mbh: FINAL + 600n })));
  await refused(body(spec({ mbh: FINAL + 29n })), "resign_needed", "R4: under the margin K");
  await passes(body(spec({ mbh: FINAL + 30n })));
});

// ---- 5. The inner action ----

test("check 5: one FunctionCall ft_transfer_call on the token, 1 yocto, 180 Tgas to G_bind_cap", async () => {
  await refused(body(spec({ actions: [fc(), fc()] })), "not_one_action", "actions: not exactly one");
  await refused(body(spec({ actions: [] })), "not_one_action", "actions: not exactly one");
  await refused(body(spec({ receiver: U.id, actions: [{ del: "bind.confidential.unrlzd.near" }] })), "not_one_action", "action: not a FunctionCall");
  const plain = JSON.stringify({ receiver_id: "alice.near", amount: "25000000" });
  await refused(body(spec({ actions: [fc({ method: "ft_transfer", args: plain })] })), "not_ft_transfer_call", "method_name: not ft_transfer_call");
  await refused(body(spec({ receiver: "usdc.fakes.near" })), "token_not_accepted", "receiver_id: not the vault's token");
  await refused(body(spec({ actions: [fc({ deposit: 0n })] })), "deposit_not_1_yocto", "deposit: not 1 yocto");
  await refused(body(spec({ actions: [fc({ deposit: 2n })] })), "deposit_not_1_yocto", "deposit: not 1 yocto");
  await refused(body(spec({ actions: [fc({ gas: 180n * T - 1n })] })), "gas_too_low", "gas: under 180 Tgas");
  await refused(body(spec({ actions: [fc({ gas: G_BIND_CAP + 1n })] })), "gas_too_high", "gas: over G_bind_cap");
  await passes(body(spec({ actions: [fc({ gas: G_BIND_CAP })] })));
  assert.equal(G_BIND_CAP, 203_126n * 1_000_000_000n);
});

// ---- 6. Arguments ----

test("check 6: the args are exactly the carrier's {receiver_id, amount, msg}", async () => {
  const why = "args: not the frozen {receiver_id, amount, msg}";
  const m = vaultDepositMessage(P, U.id);
  for (const a of [
    JSON.stringify({ receiver_id: VAULT, amount: "25000000", msg: m, memo: "x" }),
    JSON.stringify({ amount: "25000000", receiver_id: VAULT, msg: m }),
    JSON.stringify({ receiver_id: VAULT, amount: "25000000", msg: m }, null, 1),
    `{"receiver_id":"${VAULT}","receiver_id":"${VAULT}","amount":"25000000","msg":${JSON.stringify(m)}}`,
    JSON.stringify({ receiver_id: VAULT, amount: 25000000, msg: m }),
    "null",
    JSON.stringify([VAULT, "25000000", m]),
    "not json",
    new Uint8Array([0xff]),
  ]) {
    await refused(body(spec({ actions: [fc({ args: a })] })), "bad_shape", why);
  }
});

test("check 6: receiver the vault (an onward delegate to intents.near is refused here)", async () => {
  await refused(body(spec({ actions: [fc({ args: args({ receiver_id: "intents.near" }) })] })), "bad_receiver", "args.receiver_id: not the vault");
});

test("check 6: the amount: a u128 decimal, at least MIN_DEPOSIT, at most the $1,000 cap, at most the balance", async () => {
  const amt = (amount: string): { signed_delegate: string } => body(spec({ actions: [fc({ args: args({ amount }) })] }));
  for (const a of ["01", "-1", "1e6", "340282366920938463463374607431768211456"]) await refused(amt(a), "bad_shape", "args.amount: not a u128 decimal");
  await refused(amt("999999"), "amount_too_low", "amount: under MIN_DEPOSIT");
  await passes(amt("1000000"));
  await passes(amt(String(BETA_CAP)));
  assert.equal(BETA_CAP, 1_000n * MIN_DEPOSIT);
  await refused(amt(String(BETA_CAP + 1n)), CAP_CODE, "amount: over the $1,000 beta cap");
  await refused(amt("25000000"), "amount_above_balance", "amount: over the sender's balance", { balance: 24_999_999n });
  await passes(amt("25000000"), { balance: 25_000_000n });
});

test("check 6: msg keeps every clause of the vault's row 2 (V 2.10 (e))", async () => {
  const dep = U.id;
  const cases: [string, string][] = [
    [`{"precommitment":"1","depositor":"${"a".repeat(1000)}"}`, "msg: over 1,024 bytes"],
    ["{precommitment:1}", "msg: not JSON"],
    [`["1","${dep}"]`, "msg: not an object"],
    ["null", "msg: not an object"],
    [JSON.stringify({ precommitment: "1", depositor: dep, memo: "x" }), "msg: not exactly {precommitment, depositor}"],
    [JSON.stringify({ precommitment: "1" }), "msg: not exactly {precommitment, depositor}"],
    [JSON.stringify({ depositor: dep, precommitment: "1" }), "msg: not exactly {precommitment, depositor}"],
    [`{"precommitment":"1", "depositor":"${dep}"}`, "msg: not written as the kit writes it"],
    [`{"precommitment":"2","precommitment":"1","depositor":"${dep}"}`, "msg: not written as the kit writes it"],
    [`{"precommitment":12345678901234567890123,"depositor":"${dep}"}`, "msg: not written as the kit writes it"],
    [JSON.stringify({ precommitment: 1, depositor: dep }), "msg.precommitment: not one canonical decimal"],
    [JSON.stringify({ precommitment: "01", depositor: dep }), "msg.precommitment: not one canonical decimal"],
    [JSON.stringify({ precommitment: String(FIELD_P), depositor: dep }), "msg.precommitment: not below p"],
    [JSON.stringify({ precommitment: "1", depositor: "Alice.near" }), "msg.depositor: not a NEAR account id"],
    [JSON.stringify({ precommitment: "1", depositor: 7 }), "msg.depositor: not a NEAR account id"],
    [JSON.stringify({ precommitment: "1", depositor: VAULT }), "msg.depositor: the vault"],
  ];
  for (const [msg, why] of cases) await refused(body(withMsg(msg)), "bad_msg", why);
  await passes(body(withMsg(JSON.stringify({ precommitment: String(FIELD_P - 1n), depositor: dep }))));
  await passes(body(withMsg(JSON.stringify({ precommitment: "0", depositor: "alice.near" }))));
});

test("check 6: P not in the deposits pages", async () => {
  await refused(body(spec()), "p_used", "P: in the vault's deposits pages", { used: true });
});

// ---- 7. R1-R3 ----

test("check 7: R1 p_bound, R2 prepay_open, R7 in_flight; the same U on its own open P passes", async () => {
  const other = newKey().id;
  await refused(body(spec()), "p_bound", "R1: P prepaid for another sender", { bound: other });
  await passes(body(spec()), { bound: U.id, open: P });
  await refused(body(spec()), "prepay_open", "R2: the sender has another open P", { open: P + 1n });
  await refused(body(spec()), "in_flight", "R7: a send of (U, P) is out", { inFlight: true });
});

test("the first failing check answers: an expired call with too little gas and a bad msg is expired", async () => {
  await refused(body(spec({ mbh: FINAL, actions: [fc({ gas: 1n, args: args({ msg: "x" }) })] })), "expired", "max_block_height: not ahead of the final height");
  await refused(body(spec({ actions: [fc({ gas: 1n, args: args({ receiver_id: "intents.near" }) })] })), "gas_too_low", "gas: under 180 Tgas");
});

// ---- A byte-order mark is read as nearcore reads it, never dropped ----

const BOM = "\uFEFF";
test("a leading U+FEFF in sender_id is kept and refused", async () => {
  const sender = spec({ sender: BOM + U.id });
  assert.equal(encode(sender, U).subarray(4, 7).toString("hex"), "efbbbf"); // the BOM's bytes are in the signed delegate
  await refused(body(sender), "no_account", "sender_id: not a 64-hex implicit account");
});
test("a leading U+FEFF in receiver_id is kept and refused", async () => {
  await refused(body(spec({ receiver: BOM + VAULT_TOKEN })), "token_not_accepted", "receiver_id: not the vault's token");
});
test("a leading U+FEFF in method_name is kept and refused", async () => {
  await refused(body(spec({ actions: [fc({ method: BOM + "ft_transfer_call" })] })), "not_ft_transfer_call", "method_name: not ft_transfer_call");
});
test("a leading U+FEFF in args is kept and refused", async () => {
  await refused(body(spec({ actions: [fc({ args: BOM + args() })] })), "bad_shape", "args: not the frozen {receiver_id, amount, msg}");
});
