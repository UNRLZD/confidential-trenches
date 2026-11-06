// Writes apps/helper/src/pool/fixtures/sell-cast.json from cast alone (card helper-sell-fee-recipient), so the helper's
// sell digest is held to SellDelegate's, never to the helper's own code: the Sell and EIP712Domain type strings are
// read out of contracts/pool-evm/src/SellDelegate.sol at the pool-review-3 merge (7dfb6336), and per case cast makes
// the type hash (cast keccak), the struct hash (cast keccak of cast abi-encode, the data as its keccak), the domain
// separator, the digest (keccak256(0x1901 ‖ domain ‖ struct)), W's signature over that digest (cast wallet sign
// --no-hash) and over the typed data (cast wallet sign --data, cast's own EIP-712: the two must be equal), and
// SellDelegate.sell's calldata (cast calldata) with fee = feeCap. W is the Hardhat/anvil test mnemonic's index 0, a
// published test key. The Sells are packages/kit/test/evm-pool-sell.cast.json's (the kit's cast vectors).
//   node apps/helper/test/pool-evm/make-sell-cast.mjs [--check]   (--check: exit 1 unless the file on disk is equal)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OUT = join(ROOT, "apps/helper/src/pool/fixtures/sell-cast.json");
const AT = "7dfb6336cd821ce264dc4730bef26dd1ae07986d"; // Card pool-review-3: merge
const MNEMONIC = "test test test test test test test test test test test junk";
const cast = (...a) => execFileSync("cast", a, { encoding: "utf8" }).trim();
const sol = execFileSync("git", ["-C", ROOT, "show", `${AT}:contracts/pool-evm/src/SellDelegate.sol`], { encoding: "utf8" });
const typeString = /'(Sell\(address token,[^']*\))'/.exec(sol)?.[1];
const domainString = /'(EIP712Domain\([^']*\))'/.exec(sol)?.[1];
if (!typeString || !domainString) throw new Error("SellDelegate.sol has no Sell or EIP712Domain type string");
const kit = JSON.parse(readFileSync(join(ROOT, "packages/kit/test/evm-pool-sell.cast.json"), "utf8")).sells;

const w = cast("wallet", "address", "--mnemonic", MNEMONIC, "--mnemonic-index", "0").toLowerCase();
const typeHash = cast("keccak", typeString);
const tmp = mkdtempSync(join(tmpdir(), "sell-cast-"));
const sells = {};
try {
  for (const name of ["baseOneHop", "robinhoodTwoHop"]) {
    const k = kit[name];
    const c = { chainId: k.chainId, sells: k.sells, amount: k.amount, target: k.target, data: k.data, minOut: k.minOut, pool: k.pool, precommitment: k.precommitment, feeCap: k.feeCap, feeRecipient: k.feeRecipient, deadline: k.deadline, nonce: k.nonce };
    const dataHash = cast("keccak", c.data);
    const structHash = cast("keccak", cast("abi-encode", "f(bytes32,address,uint256,address,bytes32,uint256,address,uint256,uint256,address,uint256,uint256)", typeHash, c.sells, c.amount, c.target, dataHash, c.minOut, c.pool, c.precommitment, c.feeCap, c.feeRecipient, c.deadline, c.nonce));
    const domainSeparator = cast("keccak", cast("abi-encode", "f(bytes32,bytes32,bytes32,uint256,address)", cast("keccak", domainString), cast("keccak", "Blindfill"), cast("keccak", "1"), String(c.chainId), w));
    const digest = cast("keccak", `0x1901${domainSeparator.slice(2)}${structHash.slice(2)}`);
    const sellSignature = cast("wallet", "sign", "--no-hash", "--mnemonic", MNEMONIC, "--mnemonic-index", "0", digest);
    const typed = {
      types: {
        EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
        Sell: typeString.slice(5, -1).split(",").map((f) => ({ type: f.split(" ")[0], name: f.split(" ")[1] })),
      },
      primaryType: "Sell",
      domain: { name: "Blindfill", version: "1", chainId: c.chainId, verifyingContract: w },
      message: { token: c.sells, amount: c.amount, target: c.target, data: c.data, minOut: c.minOut, pool: c.pool, precommitment: c.precommitment, feeCap: c.feeCap, feeRecipient: c.feeRecipient, deadline: c.deadline, nonce: c.nonce },
    };
    const file = join(tmp, `${name}.json`);
    writeFileSync(file, JSON.stringify(typed));
    const typedSignature = cast("wallet", "sign", "--data", "--from-file", "--mnemonic", MNEMONIC, "--mnemonic-index", "0", file);
    if (typedSignature !== sellSignature) throw new Error(`${name}: cast's EIP-712 signature is not its signature over the digest made here`);
    const tuple = `(${[c.sells, c.amount, c.target, c.data, c.minOut, c.pool, c.precommitment, c.feeCap, c.feeRecipient, c.deadline, c.nonce].join(",")})`;
    const sellCallData = cast("calldata", "sell((address,uint256,address,bytes,uint256,address,uint256,uint256,address,uint256,uint256),uint256,bytes)", tuple, c.feeCap, sellSignature);
    sells[name] = { ...c, dataHash, structHash, domainSeparator, digest, sellSignature, sellCallData };
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const out = `${JSON.stringify({ source: `apps/helper/test/pool-evm/make-sell-cast.mjs: SellDelegate.sol's type strings at ${AT}, every hash, signature and calldata made by ${cast("--version").split("\n")[0]}; the Sells are packages/kit/test/evm-pool-sell.cast.json's; W is anvil's account 0`, w, typeString, typeHash, sells }, null, 1)}\n`;
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
