// The no-PRF way in and the typed 12 words (card wallet-typed-words; docs/plan1/wallet.md §2.2 :47-49, rows W:888 and
// W:914 at research ffcba5e; 06b ses.4, ses.5, ses.12).
//   node --test test/words.test.ts      (from packages/wallet)
// IndexedDB is fake-indexeddb; WebCrypto, Web Locks and BroadcastChannel are Node's own. The browser run of the same
// path (a virtual authenticator with hasPrf false landing on the backup screen) is test/passkey.e2e.mjs.
// No assertion prints a word: words are compared with assert.ok and a message that names the case, not its words.
// WORDS_SRC=<path> runs the same cases on another copy of words.ts (the planted bad copies of the red runs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import * as d from "../src/derive/index.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";
import type { Opener, Seed } from "../src/signin/words.ts";

const SRC = process.env.WORDS_SRC ? pathToFileURL(process.env.WORDS_SRC).href : "../src/signin/words.ts";
const w: typeof import("../src/signin/words.ts") = await import(SRC);
const { backupWords, checkSeed, depositQuoteAllowed, noPrfSeed, saveWords, signInNoPrf, signInPrf, signInTyped, storeSeed, typedSeed, WordsRefused } = w;

const opened: WalletStore[] = [];
after(() => opened.forEach((s) => s.close()));
const open = async (): Promise<WalletStore> => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  opened.push(s);
  return s;
};
const ON_SIGN_HOST = { hostname: d.SIGN_HOST, topLevel: true };
const opener = (s: WalletStore): Opener => () => Promise.resolve(s);
// 1..16: never zero, so a test of zeroing tells a wiped buffer from one that was zero already
const ONE_TO_16 = (): Uint8Array => Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const zeroed = (b: Uint8Array): boolean => b.every((x) => x === 0);

const A8 = JSON.parse(readFileSync(new URL("./vectors/a8.json", import.meta.url), "utf8"));
const big = (h: string): bigint => BigInt(`0x${h}`);
type Id = { name: string; kind: string; s?: string; i?: number; c?: d.Chain; l?: string; j?: number; k?: number; id: string };
function idOf(seed64: Uint8Array, e: Id): string {
  switch (e.kind) {
    case "in": return d.depositId(seed64, big(e.s!), e.i!).id;
    case "return": return d.returnId(seed64, e.c!, big(e.l!), e.j!).id;
    case "refund": return d.refundId(seed64, big(e.l!), e.j!).id;
    case "arm": return d.armAccount(seed64, big(e.l!), e.j!).id;
    case "profile": return d.profileKey(seed64, e.k!).id;
  }
  throw new Error(`unknown kind ${e.kind}`);
}
// every A.8 address and id from a stored seed, the way the page derives them: entropy -> 12 words -> seed64
function assertA8(seed: Seed, how: string): void {
  const seed64 = d.wordsToSeed64(d.entropyToWords(seed.entropy));
  for (const e of A8.ids as Id[]) assert.equal(idOf(seed64, e), e.id, `${how}: ${e.name}`);
  for (const w of A8.wallets as { name: string; c: d.Chain; l: string; j: number; address: string }[]) {
    const a = d.freshWallet(seed64, w.c, big(w.l), w.j).address;
    assert.equal(w.c.endsWith("evm") ? a.toLowerCase() : a, w.address, `${how}: ${w.name}`);
  }
}
const A8_WORDS = d.entropyToWords(new Uint8Array(Buffer.from(A8.inputs.entropy, "hex")));

test("typed words give kit-freeze-keys' vector addresses, stored as a code seed with code_saved true (ses.12)", async () => {
  const s = await open();
  const typed = typedSeed(A8_WORDS, { now: () => 7 });
  assert.equal(typed.source, "code");
  assert.equal(typed.code_saved, true);
  assert.equal(typed.created_ms, 7);
  const { inserted, seed: stored } = await storeSeed(opener(s), typed);
  assert.equal(inserted, true);
  assertA8(stored, "typed and stored");
  // read back from the store on a reload: the same seed, the same keys
  assertA8(checkSeed(await s.get("meta", "seed"))!, "read back");
  assert.equal(depositQuoteAllowed(await s.get("meta", "seed")), true, "typed words are saved words");
});

test("typed words are normalized as BIP-39 says: case, spaces, line breaks and NFKD forms give the same seed", () => {
  const want = Buffer.from(typedSeed(A8_WORDS).entropy).toString("hex");
  const list = A8_WORDS.split(" ");
  const forms = [
    `  ${list.join("   ")}  `,
    list.join("\n"),
    list.join("\t"),
    A8_WORDS.toUpperCase(),
    list.map((w, i) => (i % 2 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" "),
    A8_WORDS.normalize("NFC"),
    // full-width letters fold to ASCII under NFKD
    A8_WORDS.replace(/a/g, "ａ"),
  ];
  for (const [i, f] of forms.entries()) assert.equal(Buffer.from(typedSeed(f).entropy).toString("hex"), want, `form ${i}`);
});

test("typed words that are not 12 valid BIP-39 English words are refused before anything else (CN-41)", () => {
  const list = A8_WORDS.split(" ");
  const bad: unknown[] = [
    "",
    list.slice(0, 11).join(" "), // 11 words
    [...list, "about"].join(" "), // 13 words
    [...list.slice(0, 11), "abandon"].join(" "), // checksum fails
    [...list.slice(0, 11), "abou"].join(" "), // not on the list
    [...list.slice(0, 11), "zzzz"].join(" "),
    `${list.slice(0, 11).join(" ")}about`, // two words run together
    // the 24-word form is valid BIP-39 but not this wallet's 12 words (VN-01)
    "abandon ".repeat(23) + "art",
    42,
    null,
  ];
  for (const [i, b] of bad.entries()) assert.throws(() => typedSeed(b as string), WordsRefused, `case ${i}`);
});

test("a no-PRF seed (ses.4) is random, not saved, and gets no deposit quote until Saved (W:888, OD:20)", async () => {
  const s = await open();
  const n = noPrfSeed({ random: (b) => b.set(Uint8Array.from({ length: 16 }, (_, i) => i + 1)), now: () => 9 });
  assert.deepEqual([n.source, n.code_saved, n.created_ms], ["random", false, 9]);
  assert.deepEqual(Array.from(n.entropy), Array.from({ length: 16 }, (_, i) => i + 1));
  const { seed: stored } = await storeSeed(opener(s), n);
  assert.deepEqual([stored.source, stored.code_saved], ["random", false]);
  // no deposit quote while the 12 words are the only copy and not saved; sign out refuses too (the store's own gate)
  assert.equal(depositQuoteAllowed(await s.get("meta", "seed")), false);
  await assert.rejects(s.signOut(), /back up the 12 words/);
  // Saved: code_saved goes to true and nothing else changes; the deposit quote is then allowed
  await saveWords(s, stored);
  const after = checkSeed(await s.get("meta", "seed"))!;
  assert.deepEqual([after.source, after.code_saved, Buffer.from(after.entropy).toString("hex")],
    ["random", true, Buffer.from(stored.entropy).toString("hex")]);
  assert.equal(depositQuoteAllowed(after), true);
});

test("a stuck random source never makes a no-PRF account (the A.8 seed's keys are published)", () => {
  assert.throws(() => noPrfSeed({ random: () => {} }), /one byte repeated/);
  assert.throws(() => noPrfSeed({ random: (b) => b.fill(0xab) }), /one byte repeated/);
});

test("the deposit quote gate: no seed, a broken record and every unsaved non-PRF source are refused", () => {
  const e = new Uint8Array(16);
  assert.equal(depositQuoteAllowed(undefined), false);
  assert.equal(depositQuoteAllowed(null), false);
  assert.equal(depositQuoteAllowed({}), false);
  for (const source of ["random", "code", "wallet"]) {
    assert.equal(depositQuoteAllowed({ v: 1, entropy: e, source, code_saved: false }), false, `${source} unsaved`);
    assert.equal(depositQuoteAllowed({ v: 1, entropy: e, source, code_saved: true }), true, `${source} saved`);
  }
  assert.equal(depositQuoteAllowed({ v: 1, entropy: e, source: "random" }), false, "a missing code_saved is not saved");
  assert.equal(depositQuoteAllowed({ v: 1, entropy: e, source: "random", code_saved: "true" }), false, "only true is saved");
  // the passkey gives a PRF seed's words back, so its gate is open with code_saved false (backupFirst)
  assert.equal(depositQuoteAllowed({ v: 1, entropy: e, source: "prf", code_saved: false }), true);
});

test("the 12 words are drawn on SIGN_HOST's top-level page only, never in a frame or on another host (W:914)", () => {
  const seed = typedSeed(A8_WORDS);
  assert.ok(backupWords(seed, ON_SIGN_HOST) === A8_WORDS, "the backup shows the seed's own 12 words");
  assert.throws(() => backupWords(seed, { hostname: d.SIGN_HOST, topLevel: false }), /never in a frame/);
  assert.throws(() => backupWords(seed, { hostname: "confidential.unrealized.trade", topLevel: true }), /only/);
  assert.throws(() => backupWords(seed, { hostname: `evil.${d.SIGN_HOST}`, topLevel: true }), /only/);
  // in Node there is no window and no location: refused
  assert.throws(() => backupWords(seed), /only/);
  assert.throws(() => backupWords({ ...seed, entropy: new Uint8Array(15) }, ON_SIGN_HOST), /broken/);
});

test("insert-only: a second sign-in (no-PRF or typed) never replaces the stored seed; the stored one comes back", async () => {
  const s = await open();
  const first = (await storeSeed(opener(s), noPrfSeed())).seed;
  const firstHex = Buffer.from(first.entropy).toString("hex");
  const got = await storeSeed(opener(s), typedSeed(A8_WORDS));
  assert.equal(got.inserted, false);
  assert.equal(Buffer.from(got.seed.entropy).toString("hex"), firstHex);
  assert.equal(got.seed.source, "random");
  const again = await storeSeed(opener(s), noPrfSeed());
  assert.equal(Buffer.from(again.seed.entropy).toString("hex"), firstHex);
});

test("a seed's entropy is zeroed on every path: written, lost to another tab's seed, and an open that fails", async () => {
  const s = await open();
  const won = { v: 1 as const, entropy: ONE_TO_16(), source: "random" as const, code_saved: false, created_ms: 1 };
  assert.equal((await storeSeed(opener(s), won)).inserted, true);
  assert.ok(zeroed(won.entropy), "the written seed's entropy");
  const lost = { ...won, entropy: ONE_TO_16().reverse() };
  assert.equal((await storeSeed(opener(s), lost)).inserted, false);
  assert.ok(zeroed(lost.entropy), "the losing seed's entropy");
  // another tab signed out during the passkey sheet: the store's open fails, and the entropy is still wiped
  const closed = { ...won, entropy: ONE_TO_16() };
  await assert.rejects(storeSeed(() => Promise.reject(new Error("the wallet store is closed")), closed), /closed/);
  assert.ok(zeroed(closed.entropy), "the entropy of a seed whose store did not open");
  const prf = ONE_TO_16();
  await assert.rejects(signInPrf(() => Promise.reject(new Error("the wallet store is closed")), prf), /closed/);
  assert.ok(zeroed(prf), "a PRF entropy whose store did not open");
  const prf2 = ONE_TO_16();
  assert.equal((await signInPrf(opener(s), prf2)).screen, "signed-in");
  assert.ok(zeroed(prf2), "a PRF entropy that lost to the stored seed");
});

test("where a sign-in lands: the backup only for a no-PRF seed this sign-in made; a lost race lands signed in", async () => {
  // no-PRF create on an empty store: its own backup
  const a = await open();
  const r = await signInNoPrf(opener(a));
  assert.deepEqual([r.screen, r.seed.source, r.seed.code_saved], ["backup", "random", false]);
  // typed words that lose to another tab's unsaved random seed: signed in on that seed, never its backup
  const t = await signInTyped(opener(a), A8_WORDS);
  assert.deepEqual([t.screen, t.seed.source, t.seed.code_saved], ["signed-in", "random", false]);
  // a second no-PRF create that loses: signed in too, no words of a seed it did not make
  assert.equal((await signInNoPrf(opener(a))).screen, "signed-in");
  // typed words on an empty store: signed in on the code seed, A.8's keys
  const b = await open();
  const u = await signInTyped(opener(b), A8_WORDS);
  assert.deepEqual([u.screen, u.seed.source, u.seed.code_saved], ["signed-in", "code", true]);
  assertA8(u.seed, "signInTyped");
  // bad words are refused before the store is opened
  let opened = 0;
  await assert.rejects(signInTyped(() => (opened++, Promise.resolve(b)), "abandon ".repeat(12)), WordsRefused);
  assert.equal(opened, 0);
  // a PRF seed lands signed in (the passkey gives its words back)
  const c = await open();
  assert.equal((await signInPrf(opener(c), ONE_TO_16())).screen, "signed-in");
});

test("checkSeed refuses anything but a whole seed record", () => {
  const e = new Uint8Array(16);
  assert.equal(checkSeed(undefined), undefined);
  for (const bad of [null, {}, { entropy: e, source: "x", code_saved: false }, { entropy: new Uint8Array(15), source: "prf", code_saved: false },
    { entropy: Array.from(e), source: "prf", code_saved: false }, { entropy: e, source: "prf" }])
    assert.throws(() => checkSeed(bad), /broken/);
});
