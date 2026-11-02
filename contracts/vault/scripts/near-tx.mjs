// SPDX-License-Identifier: Apache-2.0
// The vault scripts' NEAR transaction encoding: base58 (Bitcoin alphabet) and nearcore's Transaction in its V0 layout
// (Borsh, no version tag). No network, no key: callers sign the bytes. Used by deploy.mjs and testnet-usdc.mjs.
// Action enum indexes: CreateAccount 0, DeployContract 1, FunctionCall 2, Transfer 3; PublicKey and Signature tag
// ED25519 = 0.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes) {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of bytes) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("base58: bad character");
    n = n * 58n + BigInt(i);
  }
  const hex = n === 0n ? "" : n.toString(16);
  const body = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  const zeros = s.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

export class Borsh {
  parts = [];
  u8(x) { this.parts.push(Buffer.from([x])); return this; }
  u32(x) { const b = Buffer.alloc(4); b.writeUInt32LE(x); this.parts.push(b); return this; }
  u64(x) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(x)); this.parts.push(b); return this; }
  u128(x) { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(x) & 0xffffffffffffffffn); b.writeBigUInt64LE(BigInt(x) >> 64n, 8); this.parts.push(b); return this; }
  fixed(bytes) { this.parts.push(Buffer.from(bytes)); return this; }
  bytes(bytes) { return this.u32(bytes.length).fixed(bytes); }
  string(s) { return this.bytes(Buffer.from(s, "utf8")); }
  done() { return Buffer.concat(this.parts); }
}

const header = ({ signer, publicKey, nonce, receiver, blockHash }, actions) =>
  new Borsh().string(signer).u8(0).fixed(publicKey).u64(nonce).string(receiver).fixed(blockHash).u32(actions);

// The vault.md 2.8 recipe and nothing else: [CreateAccount, Transfer, DeployContract, FunctionCall(config, {}, 0)].
export function recipeTx({ signer, publicKey, nonce, receiver, blockHash, wasm, transfer, configGas }) {
  const w = header({ signer, publicKey, nonce, receiver, blockHash }, 4);
  w.u8(0); // CreateAccount
  w.u8(3).u128(transfer); // Transfer
  w.u8(1).bytes(wasm); // DeployContract
  w.u8(2).string("config").bytes(Buffer.from("{}")).u64(configGas).u128(0n); // FunctionCall
  return w.done();
}

// One FunctionCall: `method` with JSON text `args`, `gas` and `deposit`.
export function functionCallTx({ signer, publicKey, nonce, receiver, blockHash, method, args, gas, deposit }) {
  return header({ signer, publicKey, nonce, receiver, blockHash }, 1).u8(2).string(method).bytes(Buffer.from(args, "utf8")).u64(gas).u128(deposit).done();
}
