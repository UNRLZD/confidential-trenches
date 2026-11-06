// The EVM pool's ABI as it compiles (card helper-evm-abi-tie): for each contract the helper, the kit, the wallet and the
// signing page call or read, the functions, events and errors forge emits (forge inspect methodIdentifiers, events,
// errors), and the EIP-712 strings it signs over (each keccak256('...') constant in its source, with the domain's name
// and version), each with its selector, topic or hash. contracts/pool-evm/abi.json is this, committed:
// test/abi-snapshot.test.mjs fails when the build and the file differ, and test/abi-tie.test.mjs fails when a string in
// the helper, the kit, the wallet or the signing page differs from the file. Needs forge (Foundry) on the PATH.
//   node contracts/pool-evm/script/abi-snapshot.mjs           print the build's snapshot
//   node contracts/pool-evm/script/abi-snapshot.mjs --write   write it to contracts/pool-evm/abi.json
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// @noble/hashes from the kit's own dependencies (contracts/ has no package.json); a static name, so check:imports reads it
const { keccak_256 } = createRequire(new URL("../../../packages/kit/package.json", import.meta.url))("@noble/hashes/sha3.js");

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT = path.join(ROOT, "abi.json");
/** Each contract and the source files whose constants it compiles in. */
export const CONTRACTS = Object.freeze({
  PrivacyPoolSimple: ["src/PrivacyPool.sol", "src/PrivacyPoolSimple.sol"],
  SellDelegate: ["src/SellDelegate.sol"],
});

const keccakHex = (s) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(s))).toString("hex")}`;
const inspect = (contract, what) => execFileSync("forge", ["inspect", contract, what, "--json"], { cwd: ROOT, encoding: "utf8" });
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The strings a contract's EIP-712 hashes are made of, read from its source (comments left out). */
export function typedStringsOf(files) {
  const src = files.map((f) => readFileSync(path.join(ROOT, f), "utf8").replace(/\/\/[^\n]*/g, "")).join("\n");
  const types = new Set();
  const domain = {};
  for (const m of src.matchAll(/bytes32\s+internal\s+constant\s+(\w+)\s*=\s*keccak256\(\s*'([^']*)'\s*\)/g)) {
    const [, name, value] = m;
    if (name === "NAME_HASH") domain.name = value;
    else if (name === "VERSION_HASH") domain.version = value;
    else if (/^[A-Z]\w*\([^)]*\)$/.test(value)) types.add(value);
    else throw new Error(`${name}: a keccak256 constant this snapshot does not know`);
  }
  if (domain.name === undefined || domain.version === undefined) throw new Error(`${files}: no EIP-712 domain name and version`);
  return { types: sorted(Object.fromEntries([...types].map((t) => [t, keccakHex(t)]))), domain: { name: domain.name, nameHash: keccakHex(domain.name), version: domain.version, versionHash: keccakHex(domain.version) } };
}

/** The snapshot of the build forge makes now. */
export function snapshotOf() {
  const out = { about: "contracts/pool-evm's ABI as forge v1.7.1 compiles it (solc 0.8.28), written by script/abi-snapshot.mjs --write; test/abi-snapshot.test.mjs holds it to the build, test/abi-tie.test.mjs holds the helper's, the kit's, the wallet's and the signing page's strings to it" };
  for (const [contract, files] of Object.entries(CONTRACTS)) {
    const functions = JSON.parse(inspect(contract, "methodIdentifiers"));
    const events = JSON.parse(inspect(contract, "events"));
    const errors = JSON.parse(inspect(contract, "errors"));
    out[contract] = { functions: sorted(functions), events: sorted(events), errors: sorted(errors), ...typedStringsOf(files) };
  }
  return out;
}

/** The deployed code forge builds for `contract`, as hex without 0x. */
export const deployedCodeOf = (contract) => execFileSync("forge", ["inspect", contract, "deployedBytecode"], { cwd: ROOT, encoding: "utf8" }).trim().replace(/^0x/, "");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = `${JSON.stringify(snapshotOf(), null, 2)}\n`;
  if (process.argv.includes("--write")) writeFileSync(SNAPSHOT, text);
  else process.stdout.write(text);
}
