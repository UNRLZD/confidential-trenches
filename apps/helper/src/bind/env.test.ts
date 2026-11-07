// node --test apps/helper/src/bind/env.test.ts: POST /v1/bind's sender from the host's environment (env.ts), with the
// same refusals at start as the withdrawal relayer's (withdraw/send.ts withdrawSenderFromEnv). The carry itself, per
// network under its own watch, is networks.test.ts's.
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { base58 } from "./checks.ts";
import { BIND_ENV, bindSenderFromEnv, createLine, MARGIN_K_ENV } from "./env.ts";
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
  // MAINNET_VAULT is the record's by the kit's rule (withdraw/send.test.ts holds it to mainnet-v1.json or mainnet-test.json)
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
  const fetchFn = (async (url: string) => {
    reads.push(String(url));
    throw new Error("provider down");
  }) as unknown as typeof fetch;
  const env = { BIND_VAULT_MAINNET: "vault.test.near", BIND_RELAYER_MAINNET: "bind.test.near", BIND_RELAYER_KEY_MAINNET: key, BIND_MARGIN_K: "20", HELPER_RELEASE: "1", HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "benv-")) };
  const logged: string[] = [];
  t.mock.method(console, "error", (line: string) => void logged.push(line));
  const s = bindSenderFromEnv(env, {}, fetchFn, env.BIND_VAULT_MAINNET); // a stand-in vault: its own pin
  assert.ok(s.delivered);
  assert.equal(s.delivered(JSON.stringify(recorded.answers.success_sol)), undefined);
  assert.equal(s.delivered("not json"), undefined);
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(reads, [], "an answer that names no carried delivery reads nothing");
  assert.equal(s.delivered(JSON.stringify(recorded.answers.success_usdc)), undefined);
  for (let i = 0; i < 100 && logged.length === 0; i++) await new Promise((ok) => setTimeout(ok, 10));
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
