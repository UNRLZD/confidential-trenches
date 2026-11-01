// The wallet's derivations: WU-01 and WU-03 (docs/plan1/wallet.md:1040, :1042 at research ffcba5e).
//   node --test test/derive.test.ts      (from packages/wallet)
// WU-01: the published BIP-39, SLIP-10 ed25519 and BIP-32 vectors. WU-03: the vector set test/vectors/a8.json, which is
// wallet.md §A.8 transcribed line by line (two implementations that share no crypto code made those values). No
// assertion here prints a mnemonic: words are compared with assert.ok and a message that names the vector, not its words.
import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import * as d from "../src/derive/index.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));
const big = (h: string): bigint => BigInt(`0x${h}`);
const be32 = (x: bigint): Uint8Array => fromHex(x.toString(16).padStart(64, "0"));
const keccakMod = (b: Uint8Array): bigint => big(hex(keccak_256(b))) % d.P;

// trezor/python-mnemonic master b57a5ad vectors.json (sha256 fa3b937b…30f8, read 2026-11-01), the 12-word English ones,
// [entropy, words, seed with passphrase "TREZOR"] (the passphrase is the file's, its README).
const BIP39 = [
  ["00000000000000000000000000000000",
   "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
   "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"],
  ["7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
   "legal winner thank year wave sausage worth useful legal winner thank yellow",
   "2e8905819b8723fe2c1d161860e5ee1830318dbf49a83bd451cfb8440c28bd6fa457fe1296106559a3c80937a1c1069be3a3a5bd381ee6260e8d9739fce1f607"],
  ["80808080808080808080808080808080",
   "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
   "d71de856f81a8acc65e6fc851a38d4d7ec216fd0796d0a6827a3ad6ed5511a30fa280f12eb2e47ed2ac03b5c462a0358d18d69fe4f985ec81778c1b370b652a8"],
  ["ffffffffffffffffffffffffffffffff",
   "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
   "ac27495480225222079d7be181583751e86f571027b0497b5b5d11218e0a8a13332572917f0f8e5a589620c6f15b11c61dee327651a14c34e18231052e48c069"],
  ["9e885d952ad362caeb4efe34a8e91bd2",
   "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic",
   "274ddc525802f7c828d8ef7ddbcdc5304e87ac3535913611fbbfa986d0c9e5476c91689f9c8a54fd55bd38606aa6a8595ad213d4c9c9f9aca3fb217069a41028"],
  ["c0ba5a8e914111210f2bd131f3d5e08d",
   "scheme spot photo card baby mountain device kick cradle pact join borrow",
   "ea725895aaae8d4c1cf682c1bfd2d358d52ed9f0f0591131b559e2724bb234fca05aa9c02c57407e04ee9dc3b454aa63fbff483a8b11de949624b9f1831a9612"],
  ["23db8160a31d3e0dca3688ed941adbf3",
   "cat swing flag economy stadium alone churn speed unique patch report train",
   "deb5f45449e615feff5640f2e49f933ff51895de3b4381832b3139941c57b59205a42480c52175b6efcffaa58a2503887c1e8b363a707256bdd2b587b46541f5"],
  ["f30f8c1da665478f49b001d94c5fc452",
   "vessel ladder alter error federal sibling chat ability sun glass valve picture",
   "2aaa9242daafcee6aa9d7269f17d4efe271e1b9a529178d7dc139cd18747090bf9d60295d0ce74309a78852a9caadf0af48aae1c6253839624076224374bc63f"],
];

test("WU-01 BIP-39: entropy to words to seed, every 12-word published vector", () => {
  assert.equal(BIP39.length, 8);
  BIP39.forEach(([entropy, words, seed], n) => {
    assert.ok(d.entropyToWords(fromHex(entropy)) === words, `vector ${n}: the words differ`);
    assert.equal(hex(mnemonicToSeedSync(words, "TREZOR")), seed, `vector ${n}: the seed differs`);
  });
});

test("WU-01 BIP-39: a bad checksum or a wrong word count is refused before anything else", () => {
  const words = BIP39[0]![1].split(" ");
  const swapped = [...words.slice(0, 11), words[0]].join(" ");
  assert.throws(() => d.wordsToSeed64(swapped), /not 12 valid BIP-39 English words/);
  assert.throws(() => d.wordsToSeed64(BIP39[0]![1] + " " + words[0]), /not 12 valid/);
  assert.throws(() => d.entropyToWords(new Uint8Array(32)), /16 bytes/);
});

// satoshilabs/slips master e2824d0 slip-0010.md (sha256 dbd5a324…1ce7) :235-268, "Test vector 1 for ed25519".
const SLIP10_SEED = "000102030405060708090a0b0c0d0e0f";
const SLIP10 = [
  [[], "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb", "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7", "a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed"],
  [[0], "8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69", "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3", "8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c"],
  [[0, 1], "a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14", "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2", "1932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187"],
  [[0, 1, 2], "2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c", "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9", "ae98736566d30ed0e9d2f4486a64bc95740d89c7db33f52121f8ea8f76ff0fc1"],
  [[0, 1, 2, 2], "8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc", "30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662", "8abae2d66361c879b900d204ad2cc4984fa2aa344dd7ddc46007329ac76c429c"],
  [[0, 1, 2, 2, 1000000000], "68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230", "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793", "3c24da049451555d51a7014a37337aa4e12d41e485abccfa46b47dfb2af54b7a"],
] as const;

test("WU-01 SLIP-10 ed25519: test vector 1, every chain", async () => {
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  for (const [steps, cc, k, pub] of SLIP10) {
    const r = d.slip10Ed25519(fromHex(SLIP10_SEED), steps.map((x) => x + 0x80000000));
    assert.equal(hex(r.chainCode), cc, `m/${steps.join("'/")}`);
    assert.equal(hex(r.key), k, `m/${steps.join("'/")}`);
    assert.equal(hex(ed25519.getPublicKey(r.key)), pub, `m/${steps.join("'/")}`);
  }
});

test("SLIP-10 ed25519 refuses an unhardened step", () => {
  assert.throws(() => d.slip10Ed25519(fromHex(SLIP10_SEED), [0x80000000, 1]), /hardened steps only/);
});

// bitcoin/bips master 5aadddb bip-0032.mediawiki (sha256 e5e00a82…f11f) :218-238, "Test vector 1", the ext pub lines.
const BIP32 = [
  ["m", "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8"],
  ["m/0'", "xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw"],
  ["m/0'/1", "xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ"],
  ["m/0'/1/2'", "xpub6D4BDPcP2GT577Vvch3R8wDkScZWzQzMMUm3PWbmWvVJrZwQY4VUNgqFJPMM3No2dFDFGTsxxpG5uJh7n7epu4trkrX7x7DogT5Uv6fcLW5"],
  ["m/0'/1/2'/2", "xpub6FHa3pjLCk84BayeJxFW2SP4XRrFd1JYnxeLeU8EqN3vDfZmbqBqaGJAyiLjTAwm6ZLRQUMv1ZACTj37sR62cfN7fe5JnJ7dh8zL4fiyLHV"],
  ["m/0'/1/2'/2/1000000000", "xpub6H1LXWLaKsWFhvm6RVpEL9P4KfRZSW7abD2ttkWP3SSQvnyA8FSVqNTEcYFgJS2UaFcxupHiYkro49S8yGasTvXEYBVPamhGW6cFJodrTHy"],
] as const;

test("WU-01 BIP-32 secp256k1: test vector 1, every chain", () => {
  const root = HDKey.fromMasterSeed(fromHex(SLIP10_SEED));
  for (const [path, xpub] of BIP32) assert.equal(root.derive(path).publicExtendedKey, xpub, path);
});

// ---------- WU-03: the vector set ----------
const A8 = JSON.parse(readFileSync(new URL("./vectors/a8.json", import.meta.url), "utf8"));
const SEED = d.wordsToSeed64(d.entropyToWords(fromHex(A8.inputs.entropy)));

test("WU-03 inputs: p, the scope s and the label l (n = 1, the first n with l >= 2^253)", () => {
  assert.equal(A8.inputs.passphrase, "");
  assert.equal(big(A8.p), d.P);
  const s = keccakMod(new TextEncoder().encode(A8.inputs.scope));
  assert.equal(s, big(A8.s));
  let n = 1n;
  while (keccakMod(new Uint8Array([...be32(s), ...be32(n)])) < 1n << 253n) n++;
  assert.equal(n, BigInt(A8.inputs.labelNonce));
  const l = keccakMod(new Uint8Array([...be32(s), ...be32(n)]));
  assert.equal(l, big(A8.l));
  assert.equal(l.toString(2).length, A8.bitlenL);
});

test("WU-03 the set covers every one-time id kind, all six tags for j = 0 and 1, and T_0, T_1", () => {
  const kinds = A8.ids.map((e: { kind: string }) => e.kind);
  for (const k of ["in", "return", "refund", "arm", "profile"]) assert.ok(kinds.includes(k), k);
  for (const j of [0, 1])
    for (const c of Object.keys(d.CHAINS)) {
      assert.ok(A8.wallets.some((w: { c: string; j: number }) => w.c === c && w.j === j), `W_{${c},l,${j}}`);
      assert.ok(A8.ids.some((e: { kind: string; c?: string; j?: number }) => e.kind === "return" && e.c === c && e.j === j), `R_{${c},l,${j}}`);
    }
  assert.deepEqual([A8.ids.length, A8.wallets.length, A8.notes.length], [22, 12, 14]);
});

type Id = { name: string; kind: string; s?: string; i?: number; c?: d.Chain; l?: string; j?: number; k?: number; info?: string; id: string };
function deriveId(e: Id): d.OneTime {
  switch (e.kind) {
    case "in": return d.depositId(SEED, big(e.s!), e.i!);
    case "return": return d.returnId(SEED, e.c!, big(e.l!), e.j!);
    case "refund": return d.refundId(SEED, big(e.l!), e.j!);
    case "arm": return d.armAccount(SEED, big(e.l!), e.j!);
    case "profile": return d.profileKey(SEED, e.k!);
  }
  throw new Error(`unknown kind ${e.kind}`);
}

test("WU-03 every one-time id U, R, V, A and profile key T, and its info bytes, byte for byte", () => {
  for (const e of A8.ids as Id[]) {
    const r = deriveId(e);
    if (e.info) assert.equal(r.info, e.info, `info ${e.name}`);
    assert.equal(r.id, e.id, e.name);
  }
});

test("WU-03 every fresh wallet W on all six tags: info, path and address, byte for byte", () => {
  for (const w of A8.wallets as { name: string; c: d.Chain; l: string; j: number; info?: string; path: string; address: string }[]) {
    const r = d.freshWallet(SEED, w.c, big(w.l), w.j);
    if (w.info) assert.equal(r.info, w.info, `info ${w.name}`);
    assert.equal(r.path, w.path, `${w.name} path`);
    assert.match(r.path, /^m\/44'\/(501|60|397)'\/\d+'\/\d+'$/, `${w.name}: every step hardened`);
    // an EVM address in the set is lowercase hex; the kit gives it in EIP-55 form, the same 20 bytes
    assert.equal(w.c.endsWith("evm") ? r.address.toLowerCase() : r.address, w.address, w.name);
    if (w.c.endsWith("evm")) assert.equal(r.address, d.toChecksum(w.address), `${w.name} EIP-55`);
  }
});

const fe = (x: bigint): string => x.toString(16).padStart(64, "0");
type Note = { name: string; note: string; s?: string; i?: number; l?: string; j?: number; c?: d.Chain; id?: string; n?: number; precommitment: string; nullifierHash: string; value?: string; label?: string; commitment?: string };
function deriveNote(e: Note): d.NoteSecrets {
  switch (e.note) {
    case "deposit": return d.depositNote(SEED, big(e.s!), e.i!);
    case "change": return d.changeNote(SEED, big(e.l!), e.j!);
    case "return": return d.returnNote(SEED, e.c!, big(e.l!), e.j!);
    case "move": return d.moveNote(SEED, big(e.l!), e.j!);
    case "refund": return d.refundNote(SEED, big(e.l!), e.j!);
    case "second": {
      const who = e.id === "U" ? { id: "U" as const, s: big(e.s!), i: e.i! } : e.id === "R" ? { id: "R" as const, c: e.c!, l: big(e.l!), j: e.j! } : { id: e.id as "V" | "A", l: big(e.l!), j: e.j! };
      return d.secondNote(SEED, who, e.n!);
    }
  }
  throw new Error(`unknown note ${e.note}`);
}

test("WU-03 the note masters and every note: precommitment, nullifier hash and the deposit's commitment", () => {
  for (const e of A8.notes as Note[]) {
    const r = deriveNote(e);
    assert.equal(fe(r.precommitment), e.precommitment, `${e.name} precommitment`);
    assert.equal(fe(r.nullifierHash), e.nullifierHash, `${e.name} nullifierHash`);
    if (e.commitment) assert.equal(fe(d.commitment(BigInt(e.value!), big(e.label!), r.precommitment)), e.commitment, `${e.name} commitment`);
  }
});

test("WU-03 the j rule: A_{l,0} for a deposit note, A_{l,1} for change note 0", () => {
  const l = big(A8.l);
  const want = (name: string) => A8.ids.find((e: Id) => e.name === name).id;
  assert.equal(d.changeIndex({ kind: "deposit" }), 0);
  assert.equal(d.changeIndex({ kind: "refund" }), 0);
  assert.equal(d.armAccount(SEED, l, d.changeIndex({ kind: "deposit" })).id, want("A_{l,0}"));
  assert.equal(d.armAccount(SEED, l, d.changeIndex({ kind: "change", j: 0 })).id, want("A_{l,1}"));
  assert.equal(d.changeIndex({ kind: "change", j: 41 }), 42);
  assert.throws(() => d.changeIndex({ kind: "change", j: 0xffffffff }), /out of range/);
});

test("the encodings: info lengths by kind (wallet.md:79-85), and no two kinds share a length", () => {
  const l = big(A8.l), s = big(A8.s);
  const lengths = {
    in: d.info.in(s, 0).length, return: d.info.return("sol", l, 0).length, refund: d.info.refund(l, 0).length,
    arm: d.info.arm(l, 0).length, wallet: d.info.wallet("sol", l, 0).length, profile: d.info.profile(0).length,
  };
  assert.deepEqual(lengths, { in: 46, return: 51, refund: 50, arm: 47, wallet: 43, profile: 11 });
  assert.equal(new Set(Object.values(lengths)).size, 6);
  const masters = (["deposit", "return", "move", "refund", "second"] as const).flatMap((k) => [d.masterInfo(k, "nullifier"), d.masterInfo(k, "secret")]);
  assert.deepEqual(masters.slice(0, 2), ["notes/nullifier", "notes/secret"]);
  assert.ok(masters.every((m) => m.length >= 12 && m.length <= 22), masters.join(", "));
  assert.equal(new Set(masters).size, 10);
});

test("the chain and kind tags (wallet.md:91-100, :111-114)", () => {
  assert.deepEqual(Object.entries(d.CHAINS).map(([c, v]) => [c, v.tag, v.coin]), [
    ["sol", 1, 501], ["evm", 2, 60], ["near", 3, 397], ["hop-sol", 4, 501], ["hop-evm", 5, 60], ["hop-near", 6, 397],
  ]);
  assert.deepEqual([d.KIND_U, d.KIND_V, d.KIND_A], [1, 2, 3]);
  assert.deepEqual(Object.keys(d.CHAINS).map((c) => d.kindR(c as d.Chain)), [0x11, 0x12, 0x13, 0x14, 0x15, 0x16]);
});

test("every input is checked: a field element >= p, a counter >= 2^32, an unknown tag, a short seed", () => {
  assert.throws(() => d.armAccount(SEED, d.P, 0), /not a field element/);
  assert.throws(() => d.armAccount(SEED, -1n, 0), /not a field element/);
  assert.throws(() => d.armAccount(SEED, 1n, 2 ** 32), /not a counter/);
  assert.throws(() => d.armAccount(SEED, 1n, 1.5), /not a counter/);
  assert.throws(() => d.freshWallet(SEED, "btc" as d.Chain, 1n, 0), /unknown chain tag/);
  assert.throws(() => d.returnId(SEED, "toString" as d.Chain, 1n, 0), /unknown chain tag/);
  assert.throws(() => d.armAccount(SEED.slice(0, 32), 1n, 0), /seed64 must be 64 bytes/);
  assert.throws(() => d.commitment(1n << 128n, 1n, 1n), /u128/);
});

// ---------- the frozen identifiers ----------
test("SIGN_HOST and the PRF input are the frozen ones (owner-decisions.md:263; wallet.md:47)", () => {
  assert.equal(d.SIGN_HOST, "sign.confidential.unrealized.trade");
  assert.equal(d.PRF_INPUT, "confidential-trenches/v1/seed");
  assert.equal(d.HKDF_SALT, "blindfill/v1");
  // the PRF output to the entropy, against node:crypto's own HKDF
  const prf = fromHex("11".repeat(32));
  const want = new Uint8Array(hkdfSync("sha256", prf, "confidential-trenches/v1", "wallet/entropy", 16));
  assert.equal(hex(d.entropyFromPrf(prf)), hex(want));
  assert.throws(() => d.entropyFromPrf(new Uint8Array(16)), /32 bytes/);
});

// A fixture address: the A.8 set's W_{evm,l,0} and W_{sol,l,0} (a public test seed, never funded).
test("the wallet sign-in bytes: EIP-4361 and Sign In With Solana, frozen but for the address line", () => {
  const evm = d.toChecksum("0x48966d6e92ec496d9dbb37974d531cdc3a68ae35");
  assert.equal(
    d.evmSignIn(evm),
    "sign.confidential.unrealized.trade wants you to sign in with your Ethereum account:\n" + evm + "\n\n" +
      d.SIGNIN_STATEMENT + "\n\nURI: https://sign.confidential.unrealized.trade/\nVersion: 1\nChain ID: 1\n" +
      "Nonce: blindfillv1signin\nIssued At: 2026-11-01T06:00:00Z",
  );
  assert.throws(() => d.evmSignIn(evm.toLowerCase()), /EIP-55/);
  const sol = "7z2kxnsPwHTWkdY6fet53R1b3Bw2hwJ4URqP3rHR1cq";
  assert.equal(
    d.solanaSignIn(sol),
    "sign.confidential.unrealized.trade wants you to sign in with your Solana account:\n" + sol + "\n\n" +
      d.SIGNIN_STATEMENT + "\n\nURI: https://sign.confidential.unrealized.trade/\nVersion: 1\nNonce: blindfillv1signin",
  );
  assert.throws(() => d.solanaSignIn("0x00"), /base58/);
  assert.match(d.SIGNIN_NONCE, /^[A-Za-z0-9]{8,}$/); // EIP-4361 nonce: 8 or more alphanumerics
  assert.doesNotMatch(d.SIGNIN_STATEMENT, /\n/);
});
