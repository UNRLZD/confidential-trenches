// node --test packages/kit/test/zk-setup-files.test.mjs: every file of packages/kit/zk/ that the kit's constants name
// has the pinned size and sha256, and the folder holds no other setup file, so a changed byte fails CI before main.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ZK_SETUP_FILES, ZK_SETUP_SOURCE } from "../src/zk/setup-files.ts";

const ZK = new URL("../zk/", import.meta.url);

test("the six setup files on disk equal the kit's constants", () => {
  const names = Object.keys(ZK_SETUP_FILES);
  assert.equal(names.length, 6);
  for (const [name, pin] of Object.entries(ZK_SETUP_FILES)) {
    const b = readFileSync(new URL(name, ZK));
    assert.equal(b.length, pin.bytes, `${name} size`);
    assert.equal(createHash("sha256").update(b).digest("hex"), pin.sha256, `${name} sha256`);
  }
  const onDisk = readdirSync(ZK).filter((f) => /\.(wasm|zkey|vkey)$/.test(f)).sort();
  assert.deepEqual(onDisk, [...names].sort());
});

test("the pins are frozen: no code at run time can swap a hash", () => {
  assert.ok(Object.isFrozen(ZK_SETUP_FILES) && Object.isFrozen(ZK_SETUP_SOURCE));
  for (const pin of Object.values(ZK_SETUP_FILES)) assert.ok(Object.isFrozen(pin));
  assert.throws(() => {
    ZK_SETUP_FILES["withdraw.zkey"].sha256 = "0".repeat(64);
  }, TypeError);
  assert.throws(() => {
    ZK_SETUP_FILES["other.zkey"] = ZK_SETUP_FILES["withdraw.zkey"];
  }, TypeError);
});

test("setupFileURL reads ZK_SETUP_FILES only by an own key: a polluted Object.prototype names no file (card oneclick-fee-path-own-key)", async () => {
  const { setupFileURL } = await import("../src/prover/client.ts");
  const P = Object.prototype;
  try {
    P["evil.zkey"] = { sha256: "f".repeat(64) };
    for (const name of ["evil.zkey", "toString", "__proto__"]) assert.throws(() => setupFileURL(name, "https://sign.example"), /no such setup file/, name);
  } finally {
    delete P["evil.zkey"];
  }
  assert.equal(setupFileURL("withdraw.zkey", "https://sign.example"), `https://sign.example/assets/zk/${ZK_SETUP_FILES["withdraw.zkey"].sha256}.zkey`);
});
