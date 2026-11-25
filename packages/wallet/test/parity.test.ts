// Card wallet-path-parity (W1.1, WU-02): every A.8 fresh wallet is the wallet a user's own wallet app opens. Each of the
// twelve (six tags, j 0 and 1) is derived from the A.8 words and its path by the wallet libraries' own code, pinned
// exactly in package.json, and our derived key is imported into the same code; both give the vector's address:
//   - EVM (evm, hop-evm): MetaMask's @metamask/key-tree, BIP-32 on secp256k1 from the words (`bip39:` then four
//     hardened `bip32:` steps), and the address of our private key as a key-tree node of its own;
//   - Solana (sol, hop-sol): ed25519-hd-key's derivePath (SLIP-0010, the derivation Phantom's import of the words
//     runs), its key's tweetnacl keypair, the base58 of the public key; our 32-byte seed imported the same way;
//   - NEAR (near, hop-near): near-hd-key's derivePath (the near-seed-phrase derivation NEAR wallets run) and tweetnacl,
//     the implicit account (hex of the public key); our seed imported the same way.
// The words' seed for the two ed25519 libraries is BIP-39's (PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic"), made by
// node:crypto, so no byte of it comes from our code. A library that differs by one step opens another wallet, and the
// user's money would sit where their wallet app does not look.
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SLIP10Node } from "@metamask/key-tree";
import { base58 } from "@scure/base";
import { derivePath as solDerivePath } from "ed25519-hd-key";
import { derivePath as nearDerivePath } from "near-hd-key";
import nacl from "tweetnacl";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../src/derive/keys.ts";

type Vector = { name: string; c: string; l: string; j: number; path: string; address: string };
const A8 = JSON.parse(readFileSync(new URL("./vectors/a8.json", import.meta.url), "utf8")) as { inputs: { entropy: string; passphrase: string }; wallets: Vector[] };
const words = entropyToWords(Buffer.from(A8.inputs.entropy, "hex"));
const seedHex = pbkdf2Sync(words.normalize("NFKD"), `mnemonic${A8.inputs.passphrase}`.normalize("NFKD"), 2048, 64, "sha512").toString("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const steps = (path: string) => path.split("/").slice(1);

test("the A.8 set holds twelve fresh wallets, the six tags at j 0 and 1, each path four hardened steps", () => {
  assert.equal(A8.wallets.length, 12);
  assert.deepEqual([...new Set(A8.wallets.map((w) => w.c))].sort(), ["evm", "hop-evm", "hop-near", "hop-sol", "near", "sol"]);
  for (const w of A8.wallets) assert.match(w.path, /^m(\/\d+'){4}$/, w.name);
  // the words' seed here is BIP-39's, as the wallet apps make it, and ours is the same
  assert.equal(seedHex, hex(wordsToSeed64(words)));
});

for (const w of A8.wallets) {
  test(`${w.name}: the wallet's own library gives its address from the words and its path, and from our key`, async () => {
    const ours = freshWallet(wordsToSeed64(words), w.c as never, BigInt(`0x${w.l}`), w.j);
    assert.equal(ours.path, w.path);
    if (w.c === "evm" || w.c === "hop-evm") {
      const fromWords = await SLIP10Node.fromDerivationPath({ curve: "secp256k1", derivationPath: [`bip39:${words}`, ...steps(w.path).map((s) => `bip32:${s}` as const)] as never });
      assert.equal(fromWords.address.toLowerCase(), w.address.toLowerCase(), "MetaMask's key-tree from the words");
      // key-tree refuses an all-zero chain code; the chain code never enters the address, so any non-zero one does
      const fromKey = await SLIP10Node.fromExtendedKey({ curve: "secp256k1", privateKey: `0x${hex(ours.secretKey)}`, chainCode: `0x${"01".repeat(32)}`, depth: 0, parentFingerprint: 0, index: 0 });
      assert.equal(fromKey.address.toLowerCase(), w.address.toLowerCase(), "MetaMask's key-tree from our private key");
      return;
    }
    const derive = w.c === "sol" || w.c === "hop-sol" ? solDerivePath : nearDerivePath;
    const show = (pub: Uint8Array) => (w.c === "sol" || w.c === "hop-sol" ? base58.encode(pub) : hex(pub));
    const { key } = derive(w.path, seedHex);
    assert.equal(show(nacl.sign.keyPair.fromSeed(new Uint8Array(key)).publicKey), w.address, "the wallet's derivation from the words");
    assert.equal(show(nacl.sign.keyPair.fromSeed(ours.secretKey).publicKey), w.address, "our key imported");
  });
}
