// node --test contracts/pool-evm/test/abi-snapshot.test.mjs (card helper-evm-abi-tie): contracts/pool-evm/abi.json is
// forge's build. Every function, event and error forge emits for the pool, the sell delegate and the fee collector, with
// its selector or topic, equals the committed file; every EIP-712 hash the file names (each type, the domain's name and
// version) is a PUSH32 in the runtime code forge builds (forge inspect deployedBytecode, not a chain read: the live
// check helper-evm-abi-tie reads the deployed pools), so a type string the build does not compile in fails; and the
// source reader refuses a keccak256 of a string it cannot place, so no hashed string goes unread. Rebuild the file with
// `node contracts/pool-evm/script/abi-snapshot.mjs --write`. Needs forge (Foundry) on the PATH: CI's test-scripts job
// runs it after forge test (ci.yml, "the EVM pool's tests").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONTRACTS, deployedCodeOf, SNAPSHOT, snapshotOf, typedStringsOfText } from "../script/abi-snapshot.mjs";

const COMMITTED = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const BUILT = snapshotOf();
const CODE = Object.fromEntries(Object.keys(CONTRACTS).map((c) => [c, deployedCodeOf(c)]));
/** A 32-byte constant the code pushes whole: PUSH32 (0x7f), then the word. */
const pushed = (code, hash) => code.includes(`7f${hash.replace(/^0x/, "")}`);

test("abi.json is the build: each contract's functions, events, errors, EIP-712 types and domain, with their hashes", () => {
  assert.deepEqual(Object.keys(COMMITTED).sort(), ["FeeCollector", "PrivacyPoolSimple", "SellDelegate", "about"]);
  for (const c of Object.keys(CONTRACTS)) assert.deepEqual(COMMITTED[c], BUILT[c], `${c}: run node contracts/pool-evm/script/abi-snapshot.mjs --write`);
});

test("every EIP-712 hash abi.json names is a PUSH32 in the runtime code forge builds", () => {
  for (const [c, { types, domain }] of Object.entries(BUILT).filter(([k]) => k !== "about")) {
    for (const [t, h] of Object.entries(types)) assert.ok(pushed(CODE[c], h), `${c}: ${t} is compiled in`);
    if (domain === null) {
      assert.deepEqual(types, {}, `${c}: no domain, no types`);
      continue;
    }
    assert.ok(pushed(CODE[c], domain.nameHash), `${c}: the domain's name`);
    assert.ok(pushed(CODE[c], domain.versionHash), `${c}: the domain's version`);
  }
  assert.equal(BUILT.FeeCollector.domain, null, "the fee collector signs nothing");
  assert.ok(Object.hasOwn(BUILT.FeeCollector.events, "Paid(address,uint256)"), "the fee collector's Paid");
});

test("the source reader takes every constant form and refuses a hashed string it cannot place", () => {
  const D = "bytes32 internal constant NAME_HASH = keccak256('Blindfill');\nbytes32 internal constant VERSION_HASH = keccak256('1');\n";
  const read = (body) => typedStringsOfText(D + body, "planted");
  assert.deepEqual(Object.keys(read('bytes32 private constant A = keccak256("Foo(uint256 a)");\nbytes32 public constant B = keccak256(\n  \'Bar(address b)\'\n);').types), ["Bar(address b)", "Foo(uint256 a)"]);
  assert.deepEqual(Object.keys(read("bytes32 constant C = keccak256('Baz(bool c)');").types), ["Baz(bool c)"]);
  // planted: a type hashed where no constant holds it
  assert.throws(() => read("function f() returns (bytes32) { return keccak256('Withdraw(uint256 nullifier)'); }"), /outside a bytes32 constant/);
  assert.throws(() => read('bytes32 x = keccak256(  "Withdraw(uint256 nullifier)");'), /outside a bytes32 constant/);
  // a commented-out one is not code
  assert.deepEqual(read("// bytes32 constant Q = keccak256('Old(uint256 q)');\n/* keccak256('Older()') */").types, {});
  assert.throws(() => typedStringsOfText("bytes32 internal constant NAME_HASH = keccak256('Blindfill');", "planted"), /no version/);
  assert.throws(() => typedStringsOfText("bytes32 internal constant T = keccak256('T(uint256 t)');", "planted"), /no domain/);
  assert.equal(typedStringsOfText("contract C {}", "planted").domain, null);
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
