// A new account from a wallet's sign-in (card wallet-signin-wallet; docs/plan1/wallet.md §2.2 :50 at research ffcba5e,
// owner picks walletsignin "New 12 words" OD:271 and "Ask first" OD:349).
//   node --test test/signin-wallet.test.ts      (from packages/wallet)
// The wallet signs derive/signin.ts's exact bytes with personal_sign (EVM) or signMessage (Solana); the device checks
// the answer with an EIP-191 recover or an ed25519 verify against the address the wallet named, and only then makes the
// account's seed: 16 random bytes, never from the signature, stored as { source: "wallet", code_saved: false }, so the
// backup comes first. Every key here is a published vector: RFC 8032 §7.1 TEST 1 and TEST 2 (ed25519), web3.js's
// web3.eth.accounts.sign example (secp256k1, its published signature of "Some data") and the secp256k1 key 1.
// WALLET_SRC=<path> runs the same cases on another copy of wallet.ts (the planted bad copies of the red runs).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as d from "../src/derive/index.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";
import { checkSeed, noPrfSeed, storeSeed, typedSeed, type Opener } from "../src/signin/words.ts";

const SRC = process.env.WALLET_SRC ? pathToFileURL(process.env.WALLET_SRC).href : "../src/signin/wallet.ts";
const w: typeof import("../src/signin/wallet.ts") = await import(SRC);

const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const toHex = (b: Uint8Array): string => `0x${Buffer.from(b).toString("hex")}`;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// RFC 8032 §7.1 (ed25519)
const RFC1 = {
  secret: fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"), // gitleaks:allow (RFC 8032 test 1)
  pub: fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
  msg: new Uint8Array(0),
  sig: fromHex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
};
const RFC2 = {
  secret: fromHex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"), // gitleaks:allow (RFC 8032 test 2)
  pub: fromHex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"),
  msg: fromHex("72"),
  sig: fromHex("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
};
// web3.js 1.x docs, web3.eth.accounts.sign("Some data", key): its messageHash, signature and the key's address
const WEB3 = {
  secret: fromHex("4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"), // gitleaks:allow (web3.js docs example key)
  address: "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23",
  message: "Some data",
  hash: "0x1da44b586eb0729ff70a73c326926f6ed5a25f5b056e7f47fbc6e58d86871655",
  sig: "0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c",
};
// secp256k1 private key 1: the generator's address
const ONE = { secret: fromHex("00".repeat(31) + "01"), address: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" };

// personal_sign as a wallet does it: the EIP-191 digest, r ‖ s ‖ v with v = 27 + recovery
function personalSign(secret: Uint8Array, message: string): string {
  const digest = w.eip191Digest(utf8(message));
  const sig = secp256k1.sign(digest, secret, { prehash: false, format: "recovered" });
  // noble's recovered form is recovery ‖ r ‖ s
  return toHex(Uint8Array.from([...sig.slice(1), 27 + sig[0]]));
}
const SOL1 = base58.encode(RFC1.pub);
const SOL2 = base58.encode(RFC2.pub);

test("the published vectors: RFC 8032 TEST 1 and 2 verify, and web3.js's personal_sign of 'Some data' recovers its address", () => {
  assert.equal(ed25519.verify(RFC1.sig, RFC1.msg, RFC1.pub), true);
  assert.equal(w.solanaSignatureValid(SOL1, RFC1.msg, RFC1.sig), true);
  assert.equal(w.solanaSignatureValid(SOL2, RFC2.msg, RFC2.sig), true);
  assert.equal(toHex(w.eip191Digest(utf8(WEB3.message))), WEB3.hash);
  assert.equal(w.evmSignatureValid(WEB3.address, WEB3.message, WEB3.sig), true);
  assert.equal(d.evmAddress(secp256k1.getPublicKey(WEB3.secret, false)), WEB3.address);
  assert.equal(d.evmAddress(secp256k1.getPublicKey(ONE.secret, false)), ONE.address);
  // the same signature, made here with the published key, is the published one (RFC 6979 is deterministic)
  assert.equal(personalSign(WEB3.secret, WEB3.message), WEB3.sig);
});

test("the sign-in bytes signed by their own signer pass: EVM personal_sign (v 27/28 and 0/1) and Solana signMessage", () => {
  const sig = personalSign(WEB3.secret, d.evmSignIn(WEB3.address));
  assert.equal(w.evmSignInValid(WEB3.address, sig), true);
  // v as 0/1 (Ledger and some hardware wallets answer so)
  const raw = fromHex(sig);
  raw[64] -= 27;
  assert.equal(w.evmSignInValid(WEB3.address, toHex(raw)), true);
  const solSig = ed25519.sign(utf8(d.solanaSignIn(SOL1)), RFC1.secret);
  assert.equal(w.solanaSignInValid(SOL1, solSig), true);
});

test("a wrong signer is refused: another key's signature of this address's sign-in bytes", () => {
  assert.equal(w.evmSignInValid(WEB3.address, personalSign(ONE.secret, d.evmSignIn(WEB3.address))), false);
  assert.equal(w.solanaSignInValid(SOL1, ed25519.sign(utf8(d.solanaSignIn(SOL1)), RFC2.secret)), false);
});

test("wrong bytes are refused: one byte changed, the raw message with no EIP-191 prefix, the wallet-built (signIn) form", () => {
  const msg = d.evmSignIn(WEB3.address);
  assert.equal(w.evmSignInValid(WEB3.address, personalSign(WEB3.secret, msg.replace("Version: 1", "Version: 2"))), false);
  // eth_sign of the message's keccak with no prefix: a signature made for another purpose
  const bare = secp256k1.sign(fromHex(toHex(w.eip191Digest(utf8(msg)))), WEB3.secret, { prehash: false, format: "recovered" });
  const noPrefix = secp256k1.sign(keccak_256(utf8(msg)), WEB3.secret, { prehash: false, format: "recovered" });
  assert.equal(w.evmSignInValid(WEB3.address, toHex(Uint8Array.from([...noPrefix.slice(1), 27 + noPrefix[0]]))), false);
  assert.equal(w.evmSignInValid(WEB3.address, toHex(Uint8Array.from([...bare.slice(1), 27 + bare[0]]))), true, "the control: the prefixed digest passes");
  // Sign In With Solana as a wallet's signIn builds it (an Issued At line added): not the frozen bytes
  const built = `${d.solanaSignIn(SOL1)}\nIssued At: 2026-11-18T00:00:00Z`;
  assert.equal(w.solanaSignInValid(SOL1, ed25519.sign(utf8(built), RFC1.secret)), false);
  // a signature of any length but 65 (EVM) or 64 (Solana) bytes, a v that is no recovery, and a high s are refused
  const good = fromHex(personalSign(WEB3.secret, msg));
  for (const bad of [good.slice(0, 64), Uint8Array.from([...good, 0]), Uint8Array.from([...good.slice(0, 64), 29])])
    assert.equal(w.evmSignInValid(WEB3.address, toHex(bad)), false, `a ${bad.length}-byte signature, v ${bad[64]}`);
  const N = secp256k1.Point.CURVE().n;
  const s = BigInt(toHex(good.slice(32, 64)));
  const highS = Uint8Array.from([...good.slice(0, 32), ...fromHex((N - s).toString(16).padStart(64, "0")), good[64] === 27 ? 28 : 27]);
  assert.equal(w.evmSignInValid(WEB3.address, toHex(highS)), false, "the same signature with s flipped high");
  assert.equal(w.evmSignInValid(WEB3.address, "not hex"), false);
  const solSig = ed25519.sign(utf8(d.solanaSignIn(SOL1)), RFC1.secret);
  assert.equal(w.solanaSignInValid(SOL1, solSig.slice(0, 63)), false);
});

test("a replayed message is refused: another address's sign-in, another page's (APP_HOST) form, another scheme's answer", () => {
  // the signer's sign-in for its own address, replayed under another address the wallet names
  assert.equal(w.evmSignInValid(ONE.address, personalSign(WEB3.secret, d.evmSignIn(WEB3.address))), false);
  assert.equal(w.evmSignInValid(ONE.address, personalSign(ONE.secret, d.evmSignIn(WEB3.address))), false);
  assert.equal(w.solanaSignInValid(SOL2, ed25519.sign(utf8(d.solanaSignIn(SOL1)), RFC2.secret)), false);
  // the same form signed for another page (APP_HOST's sign-in): the bytes bind SIGN_HOST, so it opens nothing here
  const other = d.evmSignIn(WEB3.address).replaceAll(d.SIGN_HOST, "ct-app.unrealized.trade");
  assert.equal(w.evmSignInValid(WEB3.address, personalSign(WEB3.secret, other)), false);
  const otherSol = d.solanaSignIn(SOL1).replaceAll(d.SIGN_HOST, "ct-app.unrealized.trade");
  assert.equal(w.solanaSignInValid(SOL1, ed25519.sign(utf8(otherSol), RFC1.secret)), false);
  // the published vectors' own signatures, replayed as a sign-in
  assert.equal(w.evmSignInValid(WEB3.address, WEB3.sig), false);
  assert.equal(w.solanaSignInValid(SOL1, RFC1.sig), false);
});

// ---------- the wallet request ----------
const ON_SIGN_HOST = { hostname: d.SIGN_HOST, topLevel: true };
type Call = { method: string; params?: unknown[] };
function evmWallet(secret: Uint8Array, address: string, over: Partial<{ accounts: unknown; sign: (c: Call) => unknown }> = {}) {
  const calls: Call[] = [];
  return {
    calls,
    request: async (c: Call) => {
      calls.push(c);
      if (c.method === "eth_requestAccounts") return "accounts" in over ? over.accounts : [address.toLowerCase()];
      if (c.method === "personal_sign") {
        if (over.sign) return over.sign(c);
        return personalSign(secret, Buffer.from(fromHex(c.params![0] as string)).toString("utf8"));
      }
      throw Object.assign(new Error("unsupported"), { code: 4200 });
    },
  };
}
function solWallet(secret: Uint8Array, pub: Uint8Array, over: Partial<{ sign: (m: Uint8Array) => unknown }> = {}) {
  const calls: string[] = [];
  return {
    calls,
    connect: async () => (calls.push("connect"), { publicKey: { toBytes: () => pub, toString: () => base58.encode(pub) } }),
    signMessage: async (m: Uint8Array, display?: string) => {
      calls.push(`signMessage:${display}`);
      return over.sign ? over.sign(m) : { signature: ed25519.sign(m, secret), publicKey: { toBytes: () => pub } };
    },
  };
}

test("the request: EVM asks eth_requestAccounts then one personal_sign of the exact bytes, hex, with the EIP-55 address", async () => {
  const e = evmWallet(WEB3.secret, WEB3.address);
  assert.deepEqual(await w.walletSignIn({ ...ON_SIGN_HOST, ethereum: e }), { kind: "signed", family: "evm" });
  assert.deepEqual(e.calls.map((c) => c.method), ["eth_requestAccounts", "personal_sign"]);
  assert.deepEqual(e.calls[1].params, [toHex(utf8(d.evmSignIn(WEB3.address))), WEB3.address]);
});

test("the request: Solana asks connect then one signMessage of the exact bytes, never signIn", async () => {
  const seen: Uint8Array[] = [];
  const s = solWallet(RFC1.secret, RFC1.pub, { sign: (m) => (seen.push(Uint8Array.from(m)), { signature: ed25519.sign(m, RFC1.secret) }) });
  const signIn = () => assert.fail("signIn is never asked");
  assert.deepEqual(await w.walletSignIn({ ...ON_SIGN_HOST, solana: { ...s, signIn } }), { kind: "signed", family: "solana" });
  assert.deepEqual(s.calls, ["connect", "signMessage:utf8"]);
  assert.equal(Buffer.from(seen[0]).toString("utf8"), d.solanaSignIn(SOL1));
});

test("the request refuses a wrong signer, wrong bytes and a replayed answer from the wallet", async () => {
  // a wallet that names one address and signs with another key
  await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, ethereum: evmWallet(ONE.secret, WEB3.address) }), w.WalletRefused);
  await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, solana: solWallet(RFC2.secret, RFC1.pub) }), w.WalletRefused);
  // a wallet that signs other bytes than the ones asked
  const tweaked = evmWallet(WEB3.secret, WEB3.address, { sign: () => personalSign(WEB3.secret, d.evmSignIn(WEB3.address) + " ") });
  await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, ethereum: tweaked }), w.WalletRefused);
  const solTweaked = solWallet(RFC1.secret, RFC1.pub, { sign: (m) => ({ signature: ed25519.sign(Uint8Array.from([...m, 10]), RFC1.secret) }) });
  await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, solana: solTweaked }), w.WalletRefused);
  // a replayed answer: another account's sign-in signature, kept and handed back for this one
  const kept = personalSign(ONE.secret, d.evmSignIn(ONE.address));
  await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, ethereum: evmWallet(WEB3.secret, WEB3.address, { sign: () => kept }) }), w.WalletRefused);
  const keptSol = ed25519.sign(utf8(d.solanaSignIn(SOL2)), RFC2.secret);
  await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, solana: solWallet(RFC1.secret, RFC1.pub, { sign: () => ({ signature: keptSol }) }) }), w.WalletRefused);
  // a Solana answer that names another public key than the one connected
  const other = solWallet(RFC1.secret, RFC1.pub, { sign: (m) => ({ signature: ed25519.sign(m, RFC1.secret), publicKey: { toBytes: () => RFC2.pub } }) });
  await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, solana: other }), w.WalletRefused);
});

test("the wallet's answers are hostile: bad accounts, a bad address checksum, a non-hex or short signature are refused", async () => {
  for (const accounts of [[], null, "0xabc", [42], ["0x" + "zz".repeat(20)], ["0x2c7536E3605D9C16a7a3D7b1898e529396a65C23"]])
    await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, ethereum: evmWallet(WEB3.secret, WEB3.address, { accounts }) }), w.WalletRefused, JSON.stringify(accounts));
  for (const answer of [null, 42, "0x1234", { signature: "0x" }])
    await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, ethereum: evmWallet(WEB3.secret, WEB3.address, { sign: () => answer }) }), w.WalletRefused, JSON.stringify(answer));
  for (const answer of [null, {}, { signature: new Uint8Array(63) }, { signature: "sig" }])
    await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, solana: solWallet(RFC1.secret, RFC1.pub, { sign: () => answer }) }), w.WalletRefused, JSON.stringify(answer));
  const badKey = { connect: async () => ({ publicKey: { toBytes: () => new Uint8Array(31) } }), signMessage: async () => ({}) };
  await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, solana: badKey }), w.WalletRefused);
});

test("the user's no in the wallet is cancelled (4001), with nothing made; no wallet in the window is no-wallet", async () => {
  const no = Object.assign(new Error("User rejected the request."), { code: 4001 });
  const e = { request: async () => { throw no; } };
  assert.deepEqual(await w.walletSignIn({ ...ON_SIGN_HOST, ethereum: e }), { kind: "cancelled" });
  const s = { connect: async () => ({ publicKey: { toBytes: () => RFC1.pub } }), signMessage: async () => { throw no; } };
  assert.deepEqual(await w.walletSignIn({ ...ON_SIGN_HOST, solana: s }), { kind: "cancelled" });
  assert.deepEqual(await w.walletSignIn({ ...ON_SIGN_HOST, ethereum: null, solana: null }), { kind: "no-wallet" });
  assert.equal(w.walletFound({ ethereum: null, solana: null }), false);
  assert.equal(w.walletFound({ ethereum: e }), true);
  // any other wallet error is not a cancel
  const broke = { request: async () => { throw Object.assign(new Error("internal"), { code: -32603 }); } };
  await assert.rejects(w.walletSignIn({ ...ON_SIGN_HOST, ethereum: broke }), /internal/);
});

test("the request runs on SIGN_HOST's top-level page only: another host or a frame refuses before the wallet is asked", async () => {
  const e = evmWallet(WEB3.secret, WEB3.address);
  await assert.rejects(w.walletSignIn({ hostname: "ct-app.unrealized.trade", topLevel: true, ethereum: e }), /confidential\.unrealized\.trade only/);
  await assert.rejects(w.walletSignIn({ hostname: d.SIGN_HOST, topLevel: false, ethereum: e }), /top-level only/);
  assert.equal(e.calls.length, 0);
});

// ---------- the account it makes ----------
const opened: WalletStore[] = [];
after(() => opened.forEach((s) => s.close()));
const open = async (): Promise<WalletStore> => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  opened.push(s);
  return s;
};
const opener = (s: WalletStore): Opener => () => Promise.resolve(s);

test("a signed sign-in makes a new random seed with source wallet, never from the signature, and opens the backup first", async () => {
  const s = await open();
  const e = evmWallet(WEB3.secret, WEB3.address);
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => 100 + i);
  const l = await w.newAccountByWallet(opener(s), { ...ON_SIGN_HOST, ethereum: e, random: (b) => b.set(bytes), now: () => 5 });
  assert.equal(l.kind, "landed");
  if (l.kind !== "landed") return;
  assert.deepEqual([l.landing.screen, l.landing.seed.source, l.landing.seed.code_saved, l.landing.seed.created_ms], ["backup", "wallet", false, 5]);
  assert.deepEqual(Array.from(l.landing.seed.entropy), Array.from(bytes), "the seed is the random source's bytes");
  const stored = checkSeed(await s.get("meta", "seed"))!;
  assert.deepEqual([stored.source, stored.code_saved], ["wallet", false]);
  // the same wallet and the same signature on a new store give another seed: the signature is no seed source
  const s2 = await open();
  const l2 = await w.newAccountByWallet(opener(s2), { ...ON_SIGN_HOST, ethereum: evmWallet(WEB3.secret, WEB3.address) });
  assert.equal(l2.kind, "landed");
  if (l2.kind === "landed") assert.notDeepEqual(Array.from(l2.landing.seed.entropy), Array.from(bytes));
  // a refused, cancelled or absent wallet makes no seed, and the store is never opened
  let opens = 0;
  const counted: Opener = () => (opens++, open());
  await assert.rejects(w.newAccountByWallet(counted, { ...ON_SIGN_HOST, ethereum: evmWallet(ONE.secret, WEB3.address) }), w.WalletRefused);
  const no = { request: async () => { throw Object.assign(new Error("no"), { code: 4001 }); } };
  assert.deepEqual(await w.newAccountByWallet(counted, { ...ON_SIGN_HOST, ethereum: no }), { kind: "cancelled" });
  assert.deepEqual(await w.newAccountByWallet(counted, { ...ON_SIGN_HOST, ethereum: null, solana: null }), { kind: "no-wallet" });
  assert.equal(opens, 0);
});

test("a stored seed is never replaced: a wallet sign-in over it lands signed in on that seed, its entropy and source kept", async () => {
  for (const first of [() => noPrfSeed(), () => typedSeed(d.entropyToWords(Uint8Array.from({ length: 16 }, (_, i) => i + 1)))]) {
    const s = await open();
    const had = (await storeSeed(opener(s), first())).seed;
    const hadHex = Buffer.from(had.entropy).toString("hex");
    const l = await w.newAccountByWallet(opener(s), { ...ON_SIGN_HOST, solana: solWallet(RFC1.secret, RFC1.pub) });
    assert.equal(l.kind, "landed");
    if (l.kind !== "landed") return;
    assert.equal(l.landing.screen, "signed-in");
    assert.equal(Buffer.from(l.landing.seed.entropy).toString("hex"), hadHex);
    assert.equal(l.landing.seed.source, had.source);
    const stored = checkSeed(await s.get("meta", "seed"))!;
    assert.equal(Buffer.from(stored.entropy).toString("hex"), hadHex);
    assert.equal(stored.source, had.source);
  }
});
