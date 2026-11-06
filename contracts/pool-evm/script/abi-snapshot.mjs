// The EVM pool's ABI as it compiles (card helper-evm-abi-tie): for each contract the helper, the kit, the wallet and the
// signing page call or read, the functions, events and errors forge emits (forge inspect methodIdentifiers, events,
// errors), and the EIP-712 strings it signs over (each keccak256('...') constant in its source, with the domain's name
// and version, where it has a domain), each with its selector, topic or hash. contracts/pool-evm/abi.json is this, committed:
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
  // the address a sell pays the server's fee to; its Paid log is the helper's proof of payment (card evm-fee-collector)
  FeeCollector: ["src/FeeCollector.sol"],
});

const keccakHex = (s) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(s))).toString("hex")}`;
const inspect = (contract, what) => execFileSync("forge", ["inspect", contract, what, "--json"], { cwd: ROOT, encoding: "utf8" });
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * The strings a contract's EIP-712 hashes are made of, read from its source `src` (comments left out): each
 * `bytes32 [internal|private|public] constant NAME = keccak256('...')` (either quote). A keccak256 of a string literal
 * anywhere else, or of one this does not know, throws, so no hashed string goes unread. NAME_HASH and VERSION_HASH
 * are the domain's name and version; a contract with neither has no domain (FeeCollector), one with only one throws.
 */
export function typedStringsOfText(src, label) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const types = new Set();
  const domain = {};
  const read = new Set();
  for (const m of code.matchAll(/bytes32\s+(?:(?:internal|private|public)\s+)?constant\s+(\w+)\s*=\s*(keccak256\(\s*(['"])([^'"]*)\3\s*\))/g)) {
    const [, name, , , value] = m;
    read.add(m.index + m[0].indexOf(m[2]));
    if (name === "NAME_HASH") domain.name = value;
    else if (name === "VERSION_HASH") domain.version = value;
    else if (/^[A-Z]\w*\([^)]*\)$/.test(value)) types.add(value);
    else throw new Error(`${label}: ${name} is a keccak256 constant this snapshot does not know`);
  }
  for (const m of code.matchAll(/keccak256\(\s*['"]/g)) if (!read.has(m.index)) throw new Error(`${label}: a keccak256 of a string outside a bytes32 constant: ${code.slice(m.index, m.index + 60)}`);
  if ((domain.name === undefined) !== (domain.version === undefined)) throw new Error(`${label}: an EIP-712 domain name with no version, or a version with no name`);
  if (domain.name === undefined && types.size > 0) throw new Error(`${label}: EIP-712 types with no domain`);
  return {
    types: sorted(Object.fromEntries([...types].map((t) => [t, keccakHex(t)]))),
    domain: domain.name === undefined ? null : { name: domain.name, nameHash: keccakHex(domain.name), version: domain.version, versionHash: keccakHex(domain.version) },
  };
}
export const typedStringsOf = (files) => typedStringsOfText(files.map((f) => readFileSync(path.join(ROOT, f), "utf8")).join("\n"), files.join(", "));

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
