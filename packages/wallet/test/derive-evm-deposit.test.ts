// The one-time EVM deposit wallet U^evm_{s,i} (card pool-deposits slice 3): HKDF-SHA512(seed64, "blindfill/v1",
// "onetime/in/evm" ‖ s ‖ i, 32 B) as a secp256k1 key, try k the stream's bytes [32k, 32k + 32) when a try is 0 or at
// least n. The vectors (test/vectors/evm-deposit-id.json) are computed apart from src/derive by
// test/record-evm-deposit-id.mjs, on the A.8 public test seed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as d from "../src/derive/index.ts";

const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const big = (h: string): bigint => BigInt("0x" + h);
const V = JSON.parse(readFileSync(new URL("./vectors/evm-deposit-id.json", import.meta.url), "utf8")) as { ids: { name: string; s: string; i: number; info: string; publicKey: string; address: string }[] };
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const N = secp256k1.Point.CURVE().n;
const be = (x: bigint): Uint8Array => fromHex(x.toString(16).padStart(64, "0"));

test("U^evm_{s,i}: every vector's info, public key and EIP-55 address, byte for byte", () => {
  assert.equal(V.ids.length, 5);
  for (const e of V.ids) {
    const u = d.depositIdEvm(SEED, big(e.s), e.i);
    assert.equal(u.info, e.info, `${e.name} info`);
    assert.equal(hex(u.publicKey), e.publicKey, `${e.name} public key`);
    assert.equal(u.address, e.address, `${e.name} address`);
    // the key is the one the public key names
    assert.equal(hex(secp256k1.getPublicKey(u.secretKey, true)), e.publicKey, `${e.name} key`);
    assert.equal(u.secretKey.length, 32);
  }
});

test("U^evm is its own key: never U's ed25519 seed, never another index's", () => {
  const s = big(V.ids[2]!.s);
  const evm = d.depositIdEvm(SEED, s, 0);
  assert.notEqual(hex(evm.secretKey), hex(d.depositId(SEED, s, 0).secretKey));
  assert.notEqual(hex(evm.secretKey), hex(d.depositIdEvm(SEED, s, 1).secretKey));
  // try 0 is the brief's 32-byte output, the first 32 bytes of any longer stream of the same info
  assert.equal(hex(evm.secretKey), hex(d.hkdfSeed(SEED, d.infoInEvm(s, 0), 64).subarray(0, 32)));
});

test("a try at 0 or at least n is refused and try k + 1 taken from the same stream; no valid try throws", () => {
  const cat = (...p: Uint8Array[]): Uint8Array => Uint8Array.from(p.flatMap((x) => [...x]));
  const ok = be(5n);
  assert.deepEqual(d.secpKeyOfStream(cat(be(N - 1n), ok)), { k: 0, key: be(N - 1n) });
  assert.deepEqual(d.secpKeyOfStream(cat(be(N), ok)), { k: 1, key: ok });
  assert.deepEqual(d.secpKeyOfStream(cat(be(0n), ok)), { k: 1, key: ok });
  assert.deepEqual(d.secpKeyOfStream(cat(be((1n << 256n) - 1n), be(0n), be(N + 1n), ok)), { k: 3, key: ok });
  assert.throws(() => d.secpKeyOfStream(cat(be(N), be(0n))), /no secp256k1 key/);
  // a partial last try is never read
  assert.throws(() => d.secpKeyOfStream(cat(be(N), ok.subarray(0, 31))), /no secp256k1 key/);
  // the key is a copy: zeroing the stream leaves it
  const stream = cat(be(N), ok);
  const { key } = d.secpKeyOfStream(stream);
  stream.fill(0);
  assert.equal(hex(key), hex(ok));
});

test("U^evm refuses what U refuses: a seed not 64 bytes, s outside [0, p), i outside [0, 2^32)", () => {
  assert.throws(() => d.depositIdEvm(new Uint8Array(32), 0n, 0), /seed64/);
  assert.throws(() => d.depositIdEvm(SEED, d.P, 0), /field element/);
  assert.throws(() => d.depositIdEvm(SEED, -1n, 0), /field element/);
  assert.throws(() => d.depositIdEvm(SEED, 0n, 2 ** 32), /counter/);
  assert.throws(() => d.depositIdEvm(SEED, 0n, -1), /counter/);
});
