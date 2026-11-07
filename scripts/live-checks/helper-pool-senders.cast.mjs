#!/usr/bin/env node
// Writes scripts/live-checks/helper-pool-senders.cast.json from cast alone (card helper-evm-sender-2), so the EVM plants
// of helper-pool-senders are held to the pools' contracts, never to the check's own encoder: the Withdraw, Buy and
// EIP712Domain type strings are read out of contracts/pool-evm/src/PrivacyPool.sol and PrivacyPoolSimple.sol, and for
// one fixed release cast makes RelayData's bytes (cast abi-encode), W's signature of the Withdraw and of the Buy over
// the typed data (cast wallet sign --data, cast's own EIP-712) and over the digest made with cast keccak and cast
// abi-encode (cast wallet sign --no-hash: the two must be equal), and the calldata of PrivacyPool.withdraw and
// PrivacyPoolSimple.buy (cast calldata). W is the Hardhat/anvil test mnemonic's index 0, a published test key, and its
// address (cast wallet address) is recorded so the check's own derivation is held to it.
//   node scripts/live-checks/helper-pool-senders.cast.mjs [--check]   (--check: exit 1 unless the file on disk is equal)
// Runs: once, no check: the tool that recorded helper-pool-senders.cast.json from cast for the check's unit test
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = join(ROOT, "scripts/live-checks/helper-pool-senders.cast.json");
const MNEMONIC = "test test test test test test test test test test test junk";
const cast = (...a) => execFileSync("cast", a, { encoding: "utf8" }).trim();
const src = (f) => readFileSync(join(ROOT, "contracts/pool-evm/src", f), "utf8");
const domainString = /'(EIP712Domain\([^']*\))'/.exec(src("PrivacyPool.sol"))?.[1];
const withdrawString = /'(Withdraw\([^']*\))'/.exec(src("PrivacyPool.sol"))?.[1];
const buyString = /'(Buy\([^']*\))'/.exec(src("PrivacyPoolSimple.sol"))?.[1];
if (!domainString || !withdrawString || !buyString) throw new Error("PrivacyPool.sol or PrivacyPoolSimple.sol has no EIP712Domain, Withdraw or Buy type string");
const fieldsOf = (t) => t.slice(t.indexOf("(") + 1, -1).split(",").map((f) => ({ type: f.split(" ")[0], name: f.split(" ")[1] }));

const w = cast("wallet", "address", "--mnemonic", MNEMONIC, "--mnemonic-index", "0").toLowerCase();
// One release on the Base Sepolia pool (pool-evm-deploy.base-sepolia.json), every proof word under the BN254 field
const c = {
  chainId: 84532,
  pool: "0xb239a38af69b68e6c5c305df64985f283b5d5fe5",
  feeRecipient: "0x6c830ac1b22d96baf692af4dd17d822ba61c32ec",
  feeCap: "20000000000000",
  fee: "10000000000000",
  deadlineMs: "1794013800000",
  refundPrecommitment: "12345678901234567890123456789",
  salt: "0x0102030405060708090a0b0c0d0e0f10",
  pA: ["1", "2"],
  pB: [["3", "4"], ["5", "6"]],
  pC: ["7", "8"],
  pubSignals: ["11", "8234104122482341265491137074636836252947884782870784360943022469005013929455", "10000000000000000", "13", "20", "15", "20", "4352341234123412341234123412341234123412341234123412341234123412341"],
  buy: { adapter: "0x706b3f75e80be70494d1414b85788462bfeb7eb1", data: "0x1234", minOut: "1000", token: "0x0000000000000000000000000000000000007070" },
};
const [nullifier, value, context] = [c.pubSignals[1], c.pubSignals[2], c.pubSignals[7]];
const relayData = cast("abi-encode", "f(address,address,uint256,uint64,uint256,bytes16)", w, c.feeRecipient, c.feeCap, c.deadlineMs, c.refundPrecommitment, c.salt);
const domainSeparator = cast("keccak", cast("abi-encode", "f(bytes32,bytes32,bytes32,uint256,address)", cast("keccak", domainString), cast("keccak", "Blindfill"), cast("keccak", "1"), String(c.chainId), c.pool));
const withdrawStruct = cast("keccak", cast("abi-encode", "f(bytes32,uint256,uint256,uint256)", cast("keccak", withdrawString), nullifier, context, value));
const buyStruct = cast("keccak", cast("abi-encode", "f(bytes32,address,bytes32,uint256,address,uint256,uint256,uint256)", cast("keccak", buyString), c.buy.adapter, cast("keccak", c.buy.data), c.buy.minOut, c.buy.token, nullifier, context, value));
const digest = (s) => cast("keccak", `0x1901${domainSeparator.slice(2)}${s.slice(2)}`);
const withdrawDigest = digest(withdrawStruct);
const buyDigest = digest(buyStruct);
const signDigest = (d) => cast("wallet", "sign", "--no-hash", "--mnemonic", MNEMONIC, "--mnemonic-index", "0", d);

const tmp = mkdtempSync(join(tmpdir(), "pool-senders-cast-"));
const typedSign = (name, primaryType, typeString, message) => {
  const file = join(tmp, `${name}.json`);
  const typed = {
    types: { EIP712Domain: fieldsOf(domainString), [primaryType]: fieldsOf(typeString) },
    primaryType,
    domain: { name: "Blindfill", version: "1", chainId: c.chainId, verifyingContract: c.pool },
    message,
  };
  writeFileSync(file, JSON.stringify(typed));
  return cast("wallet", "sign", "--data", "--from-file", "--mnemonic", MNEMONIC, "--mnemonic-index", "0", file);
};
let withdrawSignature;
let buySignature;
try {
  withdrawSignature = typedSign("withdraw", "Withdraw", withdrawString, { nullifier, context, value });
  buySignature = typedSign("buy", "Buy", buyString, { ...c.buy, nullifier, context, value });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (withdrawSignature !== signDigest(withdrawDigest)) throw new Error("cast's EIP-712 Withdraw signature is not its signature over the digest made with cast keccak");
if (buySignature !== signDigest(buyDigest)) throw new Error("cast's EIP-712 Buy signature is not its signature over the digest made with cast keccak");

const withdrawal = `(${c.pool},${relayData})`;
const proof = `([${c.pA.join(",")}],[${c.pB.map((r) => `[${r.join(",")}]`).join(",")}],[${c.pC.join(",")}],[${c.pubSignals.join(",")}])`;
const withdrawCallData = cast("calldata", "withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)", withdrawal, proof, c.fee, withdrawSignature);
const buyCallData = cast("calldata", "buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)", withdrawal, proof, c.fee, `(${c.buy.adapter},${c.buy.data},${c.buy.minOut},${c.buy.token})`, buySignature);

const out = `${JSON.stringify({
  source: `scripts/live-checks/helper-pool-senders.cast.mjs: the type strings of contracts/pool-evm/src/PrivacyPool.sol and PrivacyPoolSimple.sol, every hash, signature and calldata made by ${cast("--version").split("\n")[0]}; W is anvil's account 0 (m/44'/60'/0'/0/0 of the published test mnemonic)`,
  w,
  domainString,
  withdrawString,
  buyString,
  release: c,
  relayData,
  domainSeparator,
  withdrawDigest,
  buyDigest,
  withdrawSignature,
  buySignature,
  withdrawCallData,
  buyCallData,
}, null, 1)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== out) {
    console.error(`FAIL: ${OUT} is not what cast makes`);
    process.exit(1);
  }
  console.log(`PASS: ${OUT} is what cast makes`);
} else {
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}`);
}
