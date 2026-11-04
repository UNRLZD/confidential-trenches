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
const inspect = (what, contract = "PrivacyPoolSimple") =>
  JSON.parse(execFileSync("forge", ["inspect", contract, what, "--json"], { cwd: ROOT, encoding: "utf8" }));

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

// The sell delegate (card pool-evm-sell) runs in W's account: it declares no storage slot at all (W's sell nonce sits at
// its ERC-7201 slot, test/Sell.t.sol), and its ABI is exactly WETH, POOL_MANAGER, nonce, sell, unlockCallback (the v4
// sell's callback, card evm-sell-v4) and a receive for the sale's ether.
test("the sell delegate declares no storage", () => {
  assert.deepEqual(inspect("storageLayout", "SellDelegate").storage, []);
});

// Its two transient slots, the reentrancy guard and the v4 sell's one-shot flag, are the ERC-7201 slots of
// "blindfill.sell.guard" and "blindfill.sell.v4" (cast computes them): every TLOAD and TSTORE in its deployed code takes
// one of those two slots straight from a PUSH32, so none reads or writes transient slot 0, where a smart account that
// runs it as a module may keep its own guard, and both slots are read and written.
test("the sell delegate's only transient slots are its two ERC-7201 slots", () => {
  const erc7201 = (name) => execFileSync("cast", ["index-erc7201", name], { encoding: "utf8" }).trim().replace(/^0x/, "");
  const slots = ["blindfill.sell.guard", "blindfill.sell.v4"].map(erc7201);
  const hex = execFileSync("forge", ["inspect", "SellDelegate", "deployedBytecode"], { cwd: ROOT, encoding: "utf8" }).trim();
  const code = Buffer.from(hex.replace(/^0x/, ""), "hex");
  const ops = [];
  let prev = null;
  for (let i = 0; i < code.length; ) {
    const op = code[i];
    if (op === 0x5c || op === 0x5d) ops.push({ op: op === 0x5c ? "TLOAD" : "TSTORE", after: prev });
    if (op >= 0x60 && op <= 0x7f) {
      prev = { push: op - 0x5f, data: code.subarray(i + 1, i + 1 + op - 0x5f).toString("hex") };
      i += 1 + op - 0x5f;
    } else {
      prev = { op };
      i += 1;
    }
  }
  for (const slot of slots) {
    for (const op of ["TLOAD", "TSTORE"]) {
      assert.ok(ops.some((o) => o.op === op && o.after?.data === slot), `${op} on ${slot}`);
    }
  }
  for (const o of ops) {
    assert.ok(o.after?.push === 32 && slots.includes(o.after.data), `${o.op} takes one of the two slots: ${JSON.stringify(o.after)}`);
  }
});

test("the sell delegate's ABI is exactly the listed functions and a receive; only sell and unlockCallback write", () => {
  const abi = inspect("abi", "SellDelegate");
  assert.deepEqual(abi.filter((e) => e.type === "receive" || e.type === "fallback").map((e) => e.type), ["receive"]);
  const fns = abi.filter((e) => e.type === "function");
  assert.deepEqual(fns.map((f) => `${f.name} ${f.stateMutability}`).sort(), [
    "POOL_MANAGER view", "WETH view", "nonce view", "sell nonpayable", "unlockCallback nonpayable",
  ]);
});
