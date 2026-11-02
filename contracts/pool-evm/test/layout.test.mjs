// The EVM pool's storage and ABI, read from the compiler (forge inspect): exactly the listed slots, so no owner, admin,
// pause or implementation slot exists; exactly the listed functions (buy added by card pool-evm-buy), with no receive, fallback or payable function but
// deposit. Needs forge (Foundry) on the PATH.
//   node --test contracts/pool-evm/test/layout.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inspect = (what) =>
  JSON.parse(execFileSync("forge", ["inspect", "PrivacyPoolSimple", what, "--json"], { cwd: ROOT, encoding: "utf8" }));

test("the pool's storage is exactly the listed slots", () => {
  const got = inspect("storageLayout").storage.map((s) => `${s.slot} ${s.label}`);
  assert.deepEqual(got, [
    "0 nonce",
    "1 stateRootTimes",
    "2 labelRootTimes",
    "3 _merkleTree",
    "7 _labelTree",
    "11 nullifierHashes",
    "12 usedPrecommitments",
  ]);
});

test("the pool's ABI is exactly the listed functions; only deposit takes value", () => {
  const abi = inspect("abi");
  assert.equal(abi.filter((e) => e.type === "receive" || e.type === "fallback").length, 0, "no receive, no fallback");
  const fns = abi.filter((e) => e.type === "function");
  assert.deepEqual(fns.map((f) => f.name).sort(), [
    "ASSET", "MAX_RELAY_FEE_BPS", "MAX_TREE_DEPTH", "MIN_DEPOSIT", "SCOPE", "WITHDRAWAL_VERIFIER", "buy",
    "currentLabelRoot", "currentLabelTreeDepth", "currentLabelTreeSize", "currentRoot", "currentTreeDepth",
    "currentTreeSize", "deposit", "labelRootTimes", "nonce", "nullifierHashes", "stateRootTimes",
    "usedPrecommitments", "withdraw",
  ]);
  const writes = fns.filter((f) => f.stateMutability !== "view" && f.stateMutability !== "pure").map((f) => `${f.name} ${f.stateMutability}`);
  assert.deepEqual(writes.sort(), ["buy nonpayable", "deposit payable", "withdraw nonpayable"]);
});
