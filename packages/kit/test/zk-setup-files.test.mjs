// node --test packages/kit/test/zk-setup-files.test.mjs: every file of packages/kit/zk/ that the kit's constants name
// has the pinned size and sha256, and the folder holds no other setup file, so a changed byte fails CI before main.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ZK_SETUP_FILES } from "../src/zk/setup-files.ts";

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
