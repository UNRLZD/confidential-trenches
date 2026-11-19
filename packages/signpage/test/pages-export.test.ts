// The export of one key (src/pages/export.ts, card signpage-backup-export; wallet.md §2.8 row export.open, W:938, at
// research ffcba5e), on the published A.8 test seed only (../../wallet/test/vectors/a8.json, the all-zero entropy): each
// chain's key is the one its standard path gives, in the form its wallets import, and an address the seed does not
// derive, or a chain it has no wallet on, gets no key.   node --test test/pages-export.test.ts   (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { exportChain, exportKey, exportRefs, ownsWallet, shortAddress } from "../src/pages/export.ts";

type Vec = { name: string; c?: string; l?: string; j?: number; path?: string; address?: string; s?: string; i?: number; id?: string };
const A8 = JSON.parse(readFileSync(new URL("../../wallet/test/vectors/a8.json", import.meta.url), "utf8")) as { l: string; s: string; wallets: Vec[]; ids: Vec[] };
const EVM_U = JSON.parse(readFileSync(new URL("../../wallet/test/vectors/evm-deposit-id.json", import.meta.url), "utf8")) as { ids: (Vec & { address: string; publicKey: string })[] };
const seed64 = () => wordsToSeed64(entropyToWords(new Uint8Array(16)));
const L = BigInt(`0x${A8.l}`);
const S = BigInt(`0x${A8.s}`);
const wallet = (name: string) => A8.wallets.find((w) => w.name === name)!;
// the note store's records whose Ws are W_{c,l,0} (a deposit note: change index 0) and W_{c,l,1} (change note 0)
const NOTES = [
  { ref: { kind: "deposit" as const, s: S, i: 0 }, leaf: { label: L } },
  { ref: { kind: "change" as const, l: L, j: 0 }, leaf: { label: L } },
];
// a pool deposit op of U_{s,0} on Solana and one of U^evm_{s,0} on Base, as the page's ops store keeps them
const OPS = [
  { kind: "pool_deposit", follow: { chain: "solana", s: S.toString(), i: 0, u: "x" }, stage: "in_pool", created_ms: 1 },
  { kind: "pool_deposit", follow: { chain: "base", s: S.toString(), i: 0, u: "y" }, stage: "in_pool", created_ms: 1 },
];
const refs = () => exportRefs(NOTES, OPS);

// SLIP-10 ed25519 along hardened steps, written here apart from src/derive (the standard's own steps)
function slip10(seed: Uint8Array, path: string): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  for (const p of path.slice(2).split("/")) {
    const n = (Number(p.replace("'", "")) + 0x80000000) >>> 0;
    const data = new Uint8Array(37);
    data.set(I.subarray(0, 32), 1);
    new DataView(data.buffer).setUint32(33, n);
    I = hmac(sha512, I.subarray(32), data);
  }
  return I.slice(0, 32);
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

test("Solana: the base58 of the 64-byte secret key at W's standard path, as Phantom imports it", () => {
  for (const name of ["W_{sol,l,0}", "W_{sol,l,1}", "W_{hop-sol,l,0}"]) {
    const v = wallet(name);
    const s = seed64();
    const key = exportKey(s, "solana", v.address!, refs());
    const raw = base58.decode(key!);
    assert.equal(raw.length, 64, name);
    assert.equal(hex(raw.slice(0, 32)), hex(slip10(s, v.path!)), `${name}: the path's own key`);
    assert.equal(base58.encode(raw.slice(32)), v.address, `${name}: the public half is the vector's address`);
    assert.equal(base58.encode(ed25519.getPublicKey(raw.slice(0, 32))), v.address, `${name}: the key opens the vector's address`);
  }
});

test("Base and Robinhood: the 32-byte private key as 0x hex, as MetaMask imports it, for W and U^evm", () => {
  for (const chain of ["base", "robinhood"] as const) {
    for (const name of ["W_{evm,l,0}", "W_{evm,l,1}", "W_{hop-evm,l,1}"]) {
      const v = wallet(name);
      const key = exportKey(seed64(), chain, v.address!, refs());
      assert.match(key!, /^0x[0-9a-f]{64}$/, name);
      const pub = secp256k1.getPublicKey(Buffer.from(key!.slice(2), "hex"), false);
      assert.equal(`0x${hex(keccak_256(pub.slice(1)).slice(12))}`, v.address!.toLowerCase(), `${chain} ${name}: the key opens the vector's address`);
      // the app may name the address in EIP-55 or lower case: the same wallet
      assert.equal(exportKey(seed64(), chain, v.address!.toUpperCase().replace("0X", "0x"), refs()), key, `${chain} ${name}: any case`);
    }
  }
  const u = EVM_U.ids.find((x) => x.name === "U^evm_{s,0}")!;
  const key = exportKey(seed64(), "base", u.address, refs());
  const pub = secp256k1.getPublicKey(Buffer.from(key!.slice(2), "hex"), true);
  assert.equal(hex(pub), u.publicKey, "U^evm_{s,0}: the vector's public key");
  // U^evm_{s,0}'s op is Base's: Robinhood's records name no U there
  assert.equal(exportKey(seed64(), "robinhood", u.address, refs()), null);
});

test("NEAR: ed25519: and the base58 of the 64-byte secret key, as NEAR wallets import it", () => {
  for (const name of ["W_{near,l,0}", "W_{near,l,1}", "W_{hop-near,l,0}"]) {
    const v = wallet(name);
    const s = seed64();
    const key = exportKey(s, "near", v.address!, refs());
    assert.ok(key!.startsWith("ed25519:"), name);
    const raw = base58.decode(key!.slice("ed25519:".length));
    assert.equal(raw.length, 64, name);
    assert.equal(hex(raw.slice(0, 32)), hex(slip10(s, v.path!)), `${name}: the path's own key`);
    assert.equal(hex(raw.slice(32)), v.address, `${name}: the public half is the implicit account`);
  }
});

test("Solana U_{s,0}: the key of the pool deposit op's U_X", () => {
  const id = A8.ids.find((x) => x.name === "U_{s,0}")!.id!;
  const address = base58.encode(Buffer.from(id, "hex"));
  const raw = base58.decode(exportKey(seed64(), "solana", address, refs())!);
  assert.equal(hex(raw.slice(32)), id);
  assert.equal(hex(ed25519.getPublicKey(raw.slice(0, 32))), id);
});

test("a foreign address, an address of another chain, no records and an unknown chain: no key, not owned", () => {
  const sol = wallet("W_{sol,l,0}").address!;
  const evm = wallet("W_{evm,l,0}").address!;
  const near = wallet("W_{near,l,0}").address!;
  const foreign: [string, string][] = [
    ["solana", "11111111111111111111111111111111"],
    ["solana", wallet("W_{sol,l,0}").address!.slice(0, -1) + "x"],
    ["base", "0x0000000000000000000000000000000000000001"],
    ["base", `${evm}00`],
    ["near", "a".repeat(64)],
    ["near", near.toUpperCase()],
    // the seed's own address on the wrong chain
    ["solana", near],
    ["near", sol],
    ["base", sol],
    ["solana", evm],
    ["solana", ""],
  ];
  for (const [chain, address] of foreign) {
    assert.equal(exportKey(seed64(), chain as "solana", address, refs()), null, `${chain} ${address}`);
    assert.equal(ownsWallet(seed64(), chain as "solana", address, refs()), false, `${chain} ${address}`);
  }
  // the seed's own W with no record naming it is not looked for
  assert.equal(exportKey(seed64(), "solana", sol, []), null);
  // a chain no wallet of this seed is on
  for (const chain of ["ethereum", "sol", "evm", "hop-sol", "bitcoin", "", "__proto__", "toString"]) {
    assert.equal(exportChain(chain), false, chain);
    assert.equal(exportKey(seed64(), chain as "solana", sol, refs()), null, chain);
  }
  for (const chain of ["solana", "base", "robinhood", "near"]) assert.equal(exportChain(chain), true, chain);
  assert.equal(ownsWallet(seed64(), "solana", sol, refs()), true);
});

test("the records: each W once from a note with a leaf, each U from a pool op or refund record of a pool chain; nothing from any other shape", () => {
  const got = exportRefs(
    [...NOTES, ...NOTES, { ref: { kind: "deposit", s: S, i: 1 } }, { ref: { kind: "nope" } as never, leaf: { label: L } }],
    [...OPS, { kind: "deposit", follow: { chain: "solana", s: "1", i: 0 } }, { kind: "pool_deposit", follow: { chain: "near", s: "1", i: 0 } }, { kind: "pool_deposit", follow: { chain: "solana", s: "0x1", i: 0 } }, { kind: "pool_deposit", follow: { chain: "solana", s: "1", i: -1 } }, null, 7],
    [{ kind: "refund", chain: "robinhood", address: "z", s: "5", i: 2, deadline_ms: 1 }, { kind: "refund", chain: "near", address: "z", s: "5", i: 2, deadline_ms: 1 }],
  );
  assert.deepEqual(got, [
    { kind: "w", l: L, j: 0 },
    { kind: "w", l: L, j: 1 },
    { kind: "u", chain: "solana", s: S, i: 0 },
    { kind: "u", chain: "base", s: S, i: 0 },
    { kind: "u", chain: "robinhood", s: 5n, i: 2 },
  ]);
});

test("the address drawn shortened: its first and last 4", () => {
  assert.equal(shortAddress("7z2kxnsPwHTWkdY6fet53R1b3Bw2hwJ4URqP3rHR1cq"), "7z2k…R1cq");
  assert.equal(shortAddress("0x48966d6e92ec496d9dbb37974d531cdc3a68ae35"), "0x48…ae35");
});
