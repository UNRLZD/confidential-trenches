// node --test apps/helper/src/bind/env.test.ts: POST /v1/bind's sender from the host's environment (env.ts), with the
// same refusals at start as the withdrawal relayer's (withdraw/send.ts withdrawSenderFromEnv). The carry itself, per
// network under its own watch, is networks.test.ts's.
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { base58 } from "./checks.ts";
import { BIND_ENV, bindSenderFromEnv, MARGIN_K_ENV } from "./env.ts";

const key = (() => {
  const seed = Buffer.alloc(32, 5);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  return `ed25519:${base58(Buffer.concat([seed, pub]))}`;
})();
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
