// The no-PRF way in and the typed 12 words (docs/plan1/wallet.md §2.2 :47-49 and "Storage and unlock" :151-158, §2.8
// rows deposit quote :888 and backup.open :914 at research ffcba5e; the seed record and its states are
// docs/spec/06b-wallet-webapp.md §1.1 :361-363, §1.2 :458-460 and ses.4, ses.5, ses.12 :776-786; owner q10, OD:20).
// Runs on SIGN_HOST only.
//
// - A passkey without PRF gives no seed: the account's entropy is 16 random bytes (newEntropy, wallet.md:48), stored as
//   { source: "random", code_saved: false } (ses.4). Its 12 words are then the only copy, so the backup screen comes
//   next and the account takes no deposit quote until the user taps Saved there (OD:20, W:888).
// - Typed words (restore, another device): normalized (NFKD, lower case, one space between words, BIP-39 §"From
//   mnemonic to seed"), exactly 12 English words, and the checksum checked here before anything else (wallet.md:49).
//   They are stored as { source: "code", code_saved: true } (ses.12): the user has just typed the only copy. What they
//   give is the kit's own derivation of their entropy, so they open the same keys as kit-freeze-keys' vectors.
// - The 12 words are drawn only on SIGN_HOST's top-level page (W:914): backupWords refuses anywhere else.
// - Every seed is written through the store's insert-only insertSeed under its seed lock, so two tabs never write one
//   over the other; code_saved only goes to true, through setCodeSaved. The sign-in steps (signInPrf, signInNoPrf,
//   signInTyped) take the store's opener, so a seed's entropy is zeroed on every path, an open that fails included.
// - Where a sign-in lands: the backup screen only for a seed this sign-in made whose 12 words are the only copy (ses.4).
//   A sign-in that loses the insert to another tab's seed lands signed in on that seed and never shows its words: the
//   user did not ask for them, and typed words that lost are not silently turned into another account's backup.
// - Nothing here sends anything: the words, the entropy and the seed never leave this page (wallet.md:162-164).
import { entropyToWords, newEntropy, SIGN_HOST } from "../derive/index.ts";
import { backupFirst, type WalletStore } from "../store/index.ts";
import { mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const SEED_SOURCES = ["prf", "random", "code", "wallet"] as const; // 06b:458
export type SeedSource = (typeof SEED_SOURCES)[number];
/** The seed record (06b:458-460): the entropy, the way in, and whether the 12 words are saved. */
export interface Seed {
  v: 1;
  entropy: Uint8Array;
  source: SeedSource;
  code_saved: boolean;
  created_ms: number;
}

export interface WordsEnv {
  random?: (b: Uint8Array<ArrayBuffer>) => unknown; // crypto.getRandomValues unless a test says
  hostname?: string; // location.hostname unless a test says
  topLevel?: boolean; // window.top === window unless a test says
  now?: () => number; // Date.now unless a test says
}

/** Typed words that are not 12 valid BIP-39 English words (CN-41's "Invalid code"). */
export class WordsRefused extends Error {
  constructor() {
    super("not 12 valid BIP-39 English words");
    this.name = "WordsRefused";
  }
}

/** A stored seed read back: anything but a whole seed record is refused. */
export function checkSeed(s: unknown): Seed | undefined {
  if (s === undefined) return undefined;
  const x = s as Seed;
  if (!(x?.entropy instanceof Uint8Array && x.entropy.length === 16 && (SEED_SOURCES as readonly unknown[]).includes(x.source) &&
      typeof x.code_saved === "boolean"))
    throw new Error("the stored seed is broken");
  return x;
}

/** The no-PRF way in (ses.4): 16 random bytes, the 12 words not saved yet. */
export function noPrfSeed(env: WordsEnv = {}): Seed {
  return { v: 1, entropy: newEntropy(env.random), source: "random", code_saved: false, created_ms: (env.now ?? Date.now)() };
}

/** Typed 12 words (ses.12): the checksum is checked before anything else; a failure throws WordsRefused. */
export function typedSeed(typed: string, env: WordsEnv = {}): Seed {
  if (typeof typed !== "string") throw new WordsRefused();
  const list = typed.normalize("NFKD").toLowerCase().trim().split(/\s+/);
  if (list.length !== 12) throw new WordsRefused();
  let entropy: Uint8Array;
  try {
    entropy = mnemonicToEntropy(list.join(" "), wordlist);
  } catch {
    throw new WordsRefused();
  }
  return { v: 1, entropy, source: "code", code_saved: true, created_ms: (env.now ?? Date.now)() };
}

export type Opener = () => Promise<WalletStore>;
/** Where a sign-in lands, and the seed stored afterwards (the caller zeroes its entropy once used). */
export type Landing = { screen: "signed-in" | "backup"; seed: Seed };

/**
 * Opens the store and writes `seed` only if no seed is stored (insertSeed). Resolves to whether this seed was written
 * and the seed stored afterwards: this one, or the one another tab stored first. The given entropy is zeroed on every
 * path, an open or a write that fails included.
 */
export async function storeSeed(open: Opener, seed: Seed): Promise<{ inserted: boolean; seed: Seed }> {
  try {
    const r = await (await open()).insertSeed(seed);
    return { inserted: r.inserted, seed: checkSeed(r.seed)! };
  } finally {
    seed.entropy.fill(0);
  }
}

function land(r: { inserted: boolean; seed: Seed }): Landing {
  return { screen: r.inserted && backupFirst(r.seed) ? "backup" : "signed-in", seed: r.seed };
}

/** A passkey's PRF entropy (ses.2, ses.7): stored as a PRF seed; the entropy is zeroed on every path. */
export async function signInPrf(open: Opener, entropy: Uint8Array): Promise<Landing> {
  return land(await storeSeed(open, { v: 1, entropy, source: "prf", code_saved: false, created_ms: Date.now() }));
}

/** A passkey without PRF on create (ses.4): a random seed, then its backup screen when this seed is the one stored. */
export async function signInNoPrf(open: Opener, env: WordsEnv = {}): Promise<Landing> {
  return land(await storeSeed(open, noPrfSeed(env)));
}

/** Typed words (ses.10-12): refused with WordsRefused before the store is opened; a code seed lands signed in. */
export async function signInTyped(open: Opener, typed: string, env: WordsEnv = {}): Promise<Landing> {
  return land(await storeSeed(open, typedSeed(typed, env)));
}

/**
 * The backup's Saved (ses.5): the stored seed's code_saved becomes true, and nothing else changes, only while the stored
 * seed is `shown`, the one whose 12 words the screen drew (else the store refuses with SeedChanged).
 */
export function saveWords(store: WalletStore, shown: { entropy: Uint8Array }): Promise<void> {
  return store.setCodeSaved(shown);
}

/** The 12 words for the backup screen: on SIGN_HOST's top-level page only, never in a frame (W:914). */
export function backupWords(seed: Seed, env: WordsEnv = {}): string {
  const hostname = env.hostname ?? globalThis.location?.hostname;
  if (hostname !== SIGN_HOST) throw new Error(`the 12 words are drawn on ${SIGN_HOST} only`);
  const w = globalThis as { window?: { top?: unknown } };
  const topLevel = env.topLevel ?? (w.window !== undefined && w.window.top === w.window);
  if (!topLevel) throw new Error("the 12 words are drawn top-level only, never in a frame");
  return entropyToWords(checkSeed(seed)!.entropy);
}

/**
 * The deposit quote gate (W:888, OD:20): never with no seed, and never while the seed's 12 words are its only copy and
 * not saved (a no-PRF seed whose code_saved is false), so a swapped app cannot skip the backup.
 */
export function depositQuoteAllowed(seed: unknown): boolean {
  return seed !== undefined && seed !== null && !backupFirst(seed);
}
