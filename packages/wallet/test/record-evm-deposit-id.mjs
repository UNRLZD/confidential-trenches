// Writes test/vectors/evm-deposit-id.json: the one-time EVM deposit wallet U^evm_{s,i} of the A.8 test seed (all-zero
// entropy, a public seed: never fund these addresses), computed apart from src/derive/keys.ts: the seed by Node's
// pbkdf2 (BIP-39), the HKDF by Node's hkdfSync, the public key by Node's ECDH on secp256k1. Only the address's keccak is
// noble's (Node has no keccak-256). Public values only: the info bytes, the compressed public key and the address.
// Run: node packages/wallet/test/record-evm-deposit-id.mjs
import { createECDH, hkdfSync, pbkdf2Sync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";

const A8 = JSON.parse(readFileSync(new URL("./vectors/a8.json", import.meta.url), "utf8"));
// the 12 words of 16 zero bytes: "abandon" x 11 and "about" (BIP-39's own first vector)
const words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
if (A8.inputs.entropy !== "00000000000000000000000000000000") throw new Error("not the A.8 seed");
const seed = pbkdf2Sync(words.normalize("NFKD"), "mnemonic", 2048, 64, "sha512");
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const hex = (b) => Buffer.from(b).toString("hex");
const u32 = (i) => { const b = Buffer.alloc(4); b.writeUInt32BE(i); return b; };
const checksum = (lower) => {
  const h = hex(keccak_256(Buffer.from(lower, "ascii")));
  return "0x" + [...lower].map((c, k) => (parseInt(h[k], 16) >= 8 ? c.toUpperCase() : c)).join("");
};
const rows = [];
for (const [name, s, i] of [["U^evm_{0,0}", "00".repeat(32), 0], ["U^evm_{0,1}", "00".repeat(32), 1], ["U^evm_{s,0}", A8.s, 0], ["U^evm_{s,1}", A8.s, 1], ["U^evm_{s,2^32-1}", A8.s, 0xffffffff]]) {
  const info = Buffer.concat([Buffer.from("onetime/in/evm", "ascii"), Buffer.from(s, "hex"), u32(i)]);
  const key = Buffer.from(hkdfSync("sha512", seed, Buffer.from("blindfill/v1", "ascii"), info, 32));
  const x = BigInt("0x" + hex(key));
  if (x === 0n || x >= N) throw new Error(`${name}: try 0 refused; this recorder covers try 0 only`);
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(key);
  const full = ecdh.getPublicKey(null, "uncompressed");
  key.fill(0);
  rows.push({ name, s, i, info: hex(info), publicKey: hex(ecdh.getPublicKey(null, "compressed")), address: checksum(hex(keccak_256(full.subarray(1)).subarray(12))) });
}
const out = { set: "card pool-deposits slice 3: U^evm_{s,i} = HKDF-SHA512(seed64, \"blindfill/v1\", \"onetime/in/evm\" ‖ s ‖ i, 32 B), secp256k1", note: "The A.8 public test seed: never fund any address below. Written by test/record-evm-deposit-id.mjs (Node crypto, apart from src/derive).", ids: rows };
writeFileSync(new URL("./vectors/evm-deposit-id.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
