// node --test contracts/pool-evm/test/abi-snapshot.test.mjs (card helper-evm-abi-tie): contracts/pool-evm/abi.json is
// the build. Every function, event and error forge emits for the pool and the sell delegate, with its selector or topic,
// equals the committed file, and every EIP-712 hash the file names (each type, the domain's name and version) is a
// PUSH32 in the code forge builds, so a string in the source that the contract does not compile in, or one it compiles
// in that the file does not name, fails. Rebuild the file with `node contracts/pool-evm/script/abi-snapshot.mjs --write`.
// Needs forge (Foundry) on the PATH: CI's test-scripts job runs it after forge test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONTRACTS, deployedCodeOf, SNAPSHOT, snapshotOf } from "../script/abi-snapshot.mjs";

const COMMITTED = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const BUILT = snapshotOf();
const CODE = Object.fromEntries(Object.keys(CONTRACTS).map((c) => [c, deployedCodeOf(c)]));
/** A 32-byte constant the code pushes whole: PUSH32 (0x7f), then the word. */
const pushed = (code, hash) => code.includes(`7f${hash.replace(/^0x/, "")}`);

test("abi.json is the build: each contract's functions, events, errors, EIP-712 types and domain, with their hashes", () => {
  assert.deepEqual(Object.keys(COMMITTED).sort(), ["PrivacyPoolSimple", "SellDelegate", "about"]);
  for (const c of Object.keys(CONTRACTS)) assert.deepEqual(COMMITTED[c], BUILT[c], `${c}: run node contracts/pool-evm/script/abi-snapshot.mjs --write`);
});

test("every EIP-712 hash abi.json names is a PUSH32 in the deployed code forge builds", () => {
  for (const [c, { types, domain }] of Object.entries(BUILT).filter(([k]) => k !== "about")) {
    for (const [t, h] of Object.entries(types)) assert.ok(pushed(CODE[c], h), `${c}: ${t} is compiled in`);
    assert.ok(pushed(CODE[c], domain.nameHash), `${c}: the domain's name`);
    assert.ok(pushed(CODE[c], domain.versionHash), `${c}: the domain's version`);
  }
});

test("planted: a changed type, name or function is not the build", () => {
  const t = BUILT.PrivacyPoolSimple.types;
  const withdraw = Object.keys(t).find((k) => k.startsWith("Withdraw("));
  const other = { ...BUILT.PrivacyPoolSimple, types: { ...t, [withdraw.replace(",uint256 value", "")]: t[withdraw] } };
  assert.notDeepEqual(other, COMMITTED.PrivacyPoolSimple);
  // the hash of a type string the source does not hold is not in the code
  assert.equal(pushed(CODE.PrivacyPoolSimple, "0x" + "ab".repeat(32)), false);
  const fns = { ...BUILT.PrivacyPoolSimple.functions };
  delete fns["withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)"];
  fns["withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256)"] = "8a3bff22";
  assert.notDeepEqual({ ...BUILT.PrivacyPoolSimple, functions: fns }, COMMITTED.PrivacyPoolSimple);
});
