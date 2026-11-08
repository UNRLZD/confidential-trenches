// node --test apps/helper/src/bind/env.test.ts: POST /v1/bind's sender from the host's environment (env.ts), with the
// same refusals at start as the withdrawal relayer's (withdraw/send.ts withdrawSenderFromEnv). The carry itself, per
// network under its own watch, is networks.test.ts's.
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, promises as fsPromises, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { base58 } from "./checks.ts";
import { BIND_ENV, bindSenderFromEnv, createLine, MARGIN_K_ENV, registerLine } from "./env.ts";
import { MAINNET_VAULT } from "../withdraw/send.ts";

const keyOf = (fill: number) => {
  const seed = Buffer.alloc(32, fill);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  return `ed25519:${base58(Buffer.concat([seed, pub]))}`;
};
const key = keyOf(5);
const good = () => ({
  BIND_VAULT_TESTNET: "vault.test.testnet",
  BIND_RELAYER_TESTNET: "bind.test.testnet",
  BIND_RELAYER_KEY_TESTNET: key,
  BIND_MARGIN_K: "20",
  HELPER_RELEASE: "1",
  HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "benv-")),
});
const code = (a: { body: unknown }) => ((a.body as { error?: { code?: string } }).error?.code ?? "ok");

test("the names: per network a vault, a gas account and its one key, then the margin K", () => {
  assert.deepEqual(BIND_ENV, {
    mainnet: ["BIND_VAULT_MAINNET", "BIND_RELAYER_MAINNET", "BIND_RELAYER_KEY_MAINNET"],
    testnet: ["BIND_VAULT_TESTNET", "BIND_RELAYER_TESTNET", "BIND_RELAYER_KEY_TESTNET"],
  });
  assert.equal(MARGIN_K_ENV, "BIND_MARGIN_K");
});

test("mainnet deposits are carried only for the vault of the mainnet deploy record: bind set alone with any other vault stops the helper at start", () => {
  // MAINNET_VAULT is the record's by the helper's pin rule (withdraw/send.test.ts holds it to mainnet-v1.json, else
  // mainnet-test.json; the kit names mainnet-v1.json's or null)
  const record = { account_id: MAINNET_VAULT };
  // bind alone: no WITHDRAW_VAULT_MAINNET, so the same-vault rule has nothing to compare with
  const env = { BIND_RELAYER_MAINNET: "bind.test.near", BIND_RELAYER_KEY_MAINNET: key, BIND_MARGIN_K: "20", HELPER_RELEASE: "1", HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "bpin-")) };
  assert.doesNotThrow(() => bindSenderFromEnv({ ...env, BIND_VAULT_MAINNET: record.account_id }, {}).stop());
  const pin = MAINNET_VAULT.replaceAll(".", "\\.");
  for (const other of ["vault.confidential.unrlzd.near", "vault-test.confidential.unrlzd.near", "vault-test2.confidential.unrlzd.near", "evil.near", `${MAINNET_VAULT}.evil.near`, `x.${MAINNET_VAULT}`, "vault.bf-vt-20261102t071444.testnet"].filter((v) => v !== MAINNET_VAULT)) {
    assert.throws(() => bindSenderFromEnv({ ...env, BIND_VAULT_MAINNET: other }, {}), new RegExp(`BIND_VAULT_MAINNET must be ${pin},`), other);
  }
  // testnet is not pinned here (its vault is the testnet deploy's)
  assert.doesNotThrow(() => bindSenderFromEnv(good(), {}).stop());
});

test("nothing set: the helper starts and carries nothing (bad_shape for a body that does not decode, token_not_accepted for a delegate on no carried token)", async () => {
  const none = bindSenderFromEnv({}, {});
  assert.deepEqual([(await none.carry({})).status, code(await none.carry({}))], [400, "bad_shape"]);
  assert.equal(code(await none.carry({ signed_delegate: "AAAA" })), "bad_shape");
  assert.equal(code(await none.carry([])), "bad_shape");
  none.warm(); // nothing to start
  none.stop();
});

test("a network half set, a key that does not parse, a vault that is not the withdrawal's, no release, no store or no margin K stops the helper at start", () => {
  assert.doesNotThrow(() => bindSenderFromEnv(good(), {}));
  for (const name of BIND_ENV.testnet) assert.throws(() => bindSenderFromEnv({ ...good(), [name]: "" }, {}), /BIND_VAULT_TESTNET, BIND_RELAYER_TESTNET, BIND_RELAYER_KEY_TESTNET must be/, name);
  assert.throws(() => bindSenderFromEnv({ ...good(), BIND_RELAYER_KEY_TESTNET: `${key},${key}` }, {}), /one ed25519 key/);
  assert.throws(() => bindSenderFromEnv({ ...good(), BIND_RELAYER_KEY_TESTNET: `ed25519:${"1".repeat(88)}` }, {}), /relayer key/);
  assert.throws(() => bindSenderFromEnv({ ...good(), WITHDRAW_VAULT_TESTNET: "other.test.testnet" }, {}), /BIND_VAULT_TESTNET and WITHDRAW_VAULT_TESTNET must name the same vault/);
  assert.doesNotThrow(() => bindSenderFromEnv({ ...good(), WITHDRAW_VAULT_TESTNET: "vault.test.testnet" }, {}));
  assert.throws(() => bindSenderFromEnv({ ...good(), HELPER_RELEASE: "" }, {}), /HELPER_RELEASE/);
  assert.throws(() => bindSenderFromEnv({ ...good(), HELPER_STORE_DIR: "" }, {}), /HELPER_STORE_DIR/);
  for (const k of ["", "0", "601", "20.5", "-1", "1e2"]) assert.throws(() => bindSenderFromEnv({ ...good(), BIND_MARGIN_K: k }, {}), /BIND_MARGIN_K/, k);
  for (const k of ["1", "600"]) assert.doesNotThrow(() => bindSenderFromEnv({ ...good(), BIND_MARGIN_K: k }, {}), k);
  // errors name the variables only, never a value
  try {
    bindSenderFromEnv({ ...good(), BIND_RELAYER_KEY_TESTNET: "ed25519:secret" }, {});
    assert.fail("no refusal");
  } catch (e) {
    assert.ok(!(e as Error).message.includes("secret"));
  }
});

test("one key on one account in both relayers is refused at start (two nonce counters for one key); another key, or the same key on another account, is not", () => {
  const other = keyOf(6);
  const withdraw = { WITHDRAW_RELAYER_TESTNET: "bind.test.testnet", WITHDRAW_FEE_RECIPIENT_TESTNET: "fees.test.testnet", WITHDRAW_VAULT_TESTNET: "vault.test.testnet" };
  for (const keys of [key, `${other},${key}`]) {
    assert.throws(() => bindSenderFromEnv({ ...good(), ...withdraw, WITHDRAW_RELAYER_KEYS_TESTNET: keys }, {}), /BIND_RELAYER_KEY_TESTNET must not be one of WITHDRAW_RELAYER_KEYS_TESTNET on the same account/, keys);
  }
  assert.doesNotThrow(() => bindSenderFromEnv({ ...good(), ...withdraw, WITHDRAW_RELAYER_KEYS_TESTNET: other }, {}));
  assert.doesNotThrow(() => bindSenderFromEnv({ ...good(), ...withdraw, WITHDRAW_RELAYER_TESTNET: "relay.test.testnet", WITHDRAW_RELAYER_KEYS_TESTNET: key }, {}));
  // the other network's withdrawal keys are not this network's
  assert.doesNotThrow(() => bindSenderFromEnv({ ...good(), WITHDRAW_RELAYER_MAINNET: "bind.test.testnet", WITHDRAW_RELAYER_KEYS_MAINNET: key }, {}));
});

test("delivered (card helper-create-u): the recorded 1Click SUCCESS on mainnet USDC starts mainnet's creation, one on a token no network carries reads nothing; it returns at once and a failed start is logged, never thrown", async (t) => {
  const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/oneclick-status.json"), "utf8")) as { answers: Record<string, unknown> };
  const reads: string[] = [];
  // card helper-intents-test-race: each provider read fails only after 1.5 s (a loaded runner; the old 1 s poll gave up);
  // the hook's promise is awaited
  const fetchFn = (async (url: string) => {
    reads.push(String(url));
    await new Promise((ok) => setTimeout(ok, 1_500));
    throw new Error("provider down");
  }) as unknown as typeof fetch;
  const env = { BIND_VAULT_MAINNET: "vault.test.near", BIND_RELAYER_MAINNET: "bind.test.near", BIND_RELAYER_KEY_MAINNET: key, BIND_MARGIN_K: "20", HELPER_RELEASE: "1", HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "benv-")) };
  const logged: string[] = [];
  t.mock.method(console, "error", (line: string) => void logged.push(line));
  const s = bindSenderFromEnv(env, {}, fetchFn, env.BIND_VAULT_MAINNET); // a stand-in vault: its own pin
  assert.ok(s.delivered);
  assert.equal(await s.delivered(JSON.stringify(recorded.answers.success_sol)), undefined);
  assert.equal(await s.delivered("not json"), undefined);
  assert.deepEqual(reads, [], "an answer that names no carried delivery reads nothing");
  const run = s.delivered(JSON.stringify(recorded.answers.success_usdc));
  assert.deepEqual(logged, [], "it returns before the start's reads end");
  assert.equal(await run, undefined, "a failed start resolves, never rejects");
  assert.ok(reads.length > 0, "mainnet's start read its providers");
  assert.deepEqual([...new Set(logged)], ["helper: create start_failed"]);
  s.stop();
});

test("fold 4: a creation's log line names its code and our Transfer's hash only: no id, no address, no why or RPC text, for every code", () => {
  const id = "386aeb3286b4a6548d1ed2a84557073858cf1b696310359c5100cb06ed233ef8";
  const address = "a998c6585100ca4bccbc0e0bcceb9abd66e59666e87bd03b1d83bb9544f7ce2f";
  const tx = "4Kb2sUpEofHZao7aRzhjNPvzxgLHoaG75Vg1BNM3mwnY";
  const whys = [`view_account ${id}: the two providers disagree`, `RpcError query: UNKNOWN_ACCOUNT ${id} at ${address}`, `fetch failed ${address}`];
  const lines: string[] = [];
  for (const code of ["not_implicit", "no_delivery", "under_min", "exists", "created", "in_flight", "create_failed", "relayer_low", "unread", "delivery_used"]) {
    for (const why of whys) for (const tx_hash of [tx, undefined, id, `${tx} ${id}`]) {
      const l = createLine({ code, why, ...(tx_hash === undefined ? {} : { tx_hash }) } as { code: string; tx_hash?: string });
      if (l !== null) lines.push(l);
    }
  }
  assert.ok(lines.includes(`helper: create created ${tx}`) && lines.includes("helper: create unread") && lines.includes(`helper: create relayer_low`));
  for (const l of lines) {
    assert.ok(!l.includes(id) && !l.includes(address) && !/disagree|RpcError|fetch|UNKNOWN/.test(l), l);
    assert.match(l, /^helper: create [a-z_]+( [1-9A-HJ-NP-Za-km-z]{43,44})?$/);
  }
  assert.equal(createLine(null), null);
});

test("POST /v1/intents with mainnet carried (card helper-id-intents): the gate answers before the relayer starts or any chain is read; a quote and a status the proxy carried make a signer seen", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "benv-intents-"));
  const env = { BIND_VAULT_MAINNET: MAINNET_VAULT, BIND_RELAYER_MAINNET: "bind.test.near", BIND_RELAYER_KEY_MAINNET: key, BIND_MARGIN_K: "20", HELPER_RELEASE: "1", HELPER_STORE_DIR: dir };
  let fetched = 0;
  const s = bindSenderFromEnv(env, {}, (async () => (fetched++, new Response("{}", { status: 500 }))) as typeof fetch);
  const u = "c".repeat(64);
  const body = (to: string) => ({ signed_intent: { standard: "raw_ed25519", payload: JSON.stringify({ signer_id: u, verifying_contract: "intents.near", deadline: "2026-11-07T18:02:00.000Z", nonce: Buffer.alloc(32).toString("base64"), intents: [{ intent: "ft_withdraw", token: "usdc.near", receiver_id: to, amount: "1" }] }), public_key: `ed25519:${"1".repeat(32)}`, signature: `ed25519:${"1".repeat(64)}` } });
  const a = await s.intents!(body("alice.near"));
  assert.deepEqual([a.status, code(a)], [403, "id_not_ours"]);
  // the proxy's hooks: our quote with U as refundTo, then 1Click's REFUNDED status for it
  const q = { timestamp: "2026-11-07T18:00:00Z", quoteRequest: { dry: false, recipient: u, recipientType: "DESTINATION_CHAIN", refundTo: u, refundType: "INTENTS", depositType: "ORIGIN_CHAIN" }, quote: { depositAddress: "d".repeat(64), deadline: "2026-11-07T18:30:00.000Z" } };
  // card helper-intents-test-race: the record's write lands after 150 ms (a loaded runner); the hook's promise is awaited
  const link = fsPromises.link;
  t.mock.method(fsPromises, "link", (a: string, b: string) => new Promise<void>((ok, no) => setTimeout(() => link(a, b).then(ok, no), 150)));
  syncBuiltinESMExports();
  t.after(() => (t.mock.restoreAll(), syncBuiltinESMExports()));
  await s.quoted!(JSON.stringify(q)); // the quote record is written off the event loop
  // card intents-u-registered-first: the status that makes U seen also starts U's registration on USDC, which reads
  // the chain first (here every read answers 500: nothing is sent, the hook logs upstream and resolves)
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => void errors.push(line));
  await s.delivered!(JSON.stringify({ status: "REFUNDED", quoteResponse: q, swapDetails: {} }));
  const seenReads = fetched;
  assert.ok(seenReads > 0, "the seen id's registration read storage_balance_of");
  assert.deepEqual(errors, ["helper: intents register upstream"]);
  const v = await s.intents!(body(MAINNET_VAULT));
  assert.deepEqual([v.status, code(v)], [403, "receiver_is_vault"]);
  // the gate's second path: a mainnet withdrawal landed to an arming account A (withdraw/send.ts onLanded)
  const armedA = "e".repeat(64);
  const bodyA = { signed_intent: { ...body(MAINNET_VAULT).signed_intent, payload: body(MAINNET_VAULT).signed_intent.payload.replace(u, armedA) } };
  assert.equal(code(await s.intents!(bodyA)), "id_not_ours");
  s.armed!(armedA);
  assert.equal(code(await s.intents!(bodyA)), "receiver_is_vault");
  assert.equal(fetched, seenReads, "no chain read and no relayer start by /v1/intents");
  s.stop();
});

test("card helper-intents-test-race: a quote record whose write fails resolves the quoted hook, never rejects, and logs quote_record_failed", async (t) => {
  const env = { BIND_VAULT_MAINNET: MAINNET_VAULT, BIND_RELAYER_MAINNET: "bind.test.near", BIND_RELAYER_KEY_MAINNET: key, BIND_MARGIN_K: "20", HELPER_RELEASE: "1", HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "benv-qfail-")) };
  const s = bindSenderFromEnv(env, {}, (async () => new Response("{}", { status: 500 })) as typeof fetch);
  const logged: string[] = [];
  t.mock.method(console, "error", (line: string) => void logged.push(line));
  t.mock.method(fsPromises, "link", async () => Promise.reject(Object.assign(new Error("disk gone"), { code: "EIO" })));
  syncBuiltinESMExports();
  t.after(() => (t.mock.restoreAll(), syncBuiltinESMExports()));
  const u = "c".repeat(64);
  const q = { timestamp: "2026-11-07T18:00:00Z", quoteRequest: { dry: false, recipient: u, recipientType: "DESTINATION_CHAIN", refundTo: u, refundType: "INTENTS", depositType: "ORIGIN_CHAIN" }, quote: { depositAddress: "d".repeat(64), deadline: "2026-11-07T18:30:00.000Z" } };
  assert.equal(await s.quoted!(JSON.stringify(q)), undefined);
  assert.deepEqual(logged, ["helper: intents quote_record_failed"]);
  s.stop();
});

test("card intents-u-registered-first: a seen id's registration logs its code only: never the id, an account or any text the code is not", () => {
  const u = "c".repeat(64);
  assert.equal(registerLine("registered"), null);
  assert.equal(registerLine("in_flight"), null);
  for (const c of ["relayer_low", "registration_failed", "sender_struck", "upstream", "id_not_ours"]) assert.equal(registerLine(c), `helper: intents register ${c}`);
  for (const t of [u, `upstream ${u}`, "alice.near", `relayer_low ${u}`]) assert.equal(registerLine(t), "helper: intents register upstream", t);
  // env.ts logs a registration only through registerLine, on its answer and on a rejection alike
  const src = readFileSync(new URL("./env.ts", import.meta.url), "utf8");
  const lines = src.split("\n").filter((l) => l.includes("intents register") || (l.includes("console.") && l.includes("register")));
  assert.ok(lines.length >= 2 && lines.every((l) => /registerLine\(/.test(l) || /return `helper: intents register \$\{listed \? code : "upstream"\}`/.test(l)), lines.join("\n"));
});
