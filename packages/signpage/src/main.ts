// SIGN_HOST's sign-in screen, top-level (docs/plan1/wallet.md §2.2 :47-56 and "Storage and unlock" :151-160 at research
// ffcba5e). Card wallet-passkey-prf: the passkey with PRF way in.
//
// - On open the page reads its own store first (wallet.md:50): with a seed there it is signed in, with no passkey sheet
//   (wallet.md:155); with none it offers the passkey ways in.
// - Sign-in and sign-out run top-level only (wallet.md:921-922). In a frame (APP_HOST may frame this page) it shows
//   neither control and both steps refuse, so a framing page cannot get a click on them.
// - Create passkey / Use passkey run the ceremony (@blindfill/wallet/signin/passkey). A PRF result becomes the seed's
//   entropy, written by the store's insertSeed only if no seed is stored (two tabs never write one over the other); the
//   record is 06b:459's { v, entropy, source: "prf", code_saved: false, created_ms } (ses.2, ses.7, 06b:776, :781), so
//   the Backup dot shows (data-code-saved="false"). A no-PRF gate keys on source, never on code_saved.
// - A seed already stored is never replaced and no ceremony runs (wallet.md:919: sign out first).
// - A passkey without PRF makes nothing here and shows its own state, "no-prf", which the no-PRF path takes over
//   (card wallet-typed-words); never a silent fallback to another seed.
// - Sign out deletes the store (wallet.md:156); another tab's sign out shows signed-out here too.
// - The page shows public values only: the account's profile key T_0 (wallet.md:68, a public key, never a NEAR account
//   or money), in data-account, so a check can compare it. The entropy and seed64 are zeroed once used; the 12 words
//   are a JS string, which cannot be zeroed, and never reach the DOM.
// - DOM by createElement and textContent only: the page's CSP requires Trusted Types for every script sink.
import { entropyToWords, profileKey, wordsToSeed64 } from "@blindfill/wallet/derive";
import { createPasskey, getPasskey, type PasskeyOutcome } from "@blindfill/wallet/signin/passkey";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";

type Seed = { v: 1; entropy: Uint8Array; source: "prf" | "random" | "code" | "wallet"; code_saved: boolean; created_ms: number };
type State = "loading" | "signed-out" | "signed-in" | "no-prf" | "cancelled" | "unsupported" | "error";

// DRAFT COPY: every visible word below waits for the owner's words pass.
const WORDS = {
  create: "Create passkey",
  use: "Use passkey",
  signout: "Sign out",
  "signed-in": "Signed in",
  "no-prf": "This passkey can't unlock an account here. Use your 12 words.",
  cancelled: "Cancelled",
  unsupported: "This browser has no passkeys. Use your 12 words.",
  error: "Something went wrong. Try again.",
} as const;

const framed = window.top !== window;
const root = document.createElement("main");
root.id = "signin";
if (framed) root.dataset.framed = "true";
document.body.append(root);

function button(action: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.action = action;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function show(state: State, seed?: { account: string; code_saved: boolean }): void {
  root.dataset.signin = state;
  if (seed) {
    root.dataset.account = seed.account;
    root.dataset.codeSaved = String(seed.code_saved);
  } else {
    delete root.dataset.account;
    delete root.dataset.codeSaved;
  }
  const parts: HTMLElement[] = [];
  if (state !== "loading" && state !== "signed-out" && state !== "signed-in") {
    const p = document.createElement("p");
    p.textContent = WORDS[state];
    parts.push(p);
  }
  if (state === "signed-in") {
    const p = document.createElement("p");
    p.textContent = WORDS["signed-in"];
    parts.push(p);
    if (!framed) parts.push(button("signout", WORDS.signout, () => void run(signOut)));
  } else if (!framed && state !== "loading" && state !== "unsupported") {
    parts.push(button("create", WORDS.create, () => void run(() => signIn(createPasskey))));
    parts.push(button("use", WORDS.use, () => void run(() => signIn(getPasskey))));
  }
  root.replaceChildren(...parts);
}

// The account's public id from its entropy: entropy -> 12 words -> seed64 -> T_0 (wallet.md:47, :54, :68). seed64 is
// zeroed here; the caller zeroes the entropy.
function accountOf(entropy: Uint8Array): string {
  const seed64 = wordsToSeed64(entropyToWords(entropy));
  try {
    return profileKey(seed64, 0).id;
  } finally {
    seed64.fill(0);
  }
}
// What the screen shows of a seed, the seed's entropy zeroed after.
function shown(s: Seed): { account: string; code_saved: boolean } {
  try {
    return { account: accountOf(s.entropy), code_saved: s.code_saved };
  } finally {
    s.entropy.fill(0);
  }
}

let store: WalletStore | null = null;
const open = async (): Promise<WalletStore> =>
  (store ??= await openWalletStore({
    // another tab signed out: its store closed ours; drop it and show signed-out
    onEvent: (e) => {
      if (e.kind !== "signout") return;
      store = null;
      show("signed-out");
    },
  }));

const SOURCES = ["prf", "random", "code", "wallet"];
function checkSeed(s: unknown): Seed | undefined {
  if (s === undefined) return undefined;
  const x = s as Seed;
  if (!(x?.entropy instanceof Uint8Array && x.entropy.length === 16 && SOURCES.includes(x.source) && typeof x.code_saved === "boolean"))
    throw new Error("the stored seed is broken");
  return x;
}
const readSeed = async (): Promise<Seed | undefined> => checkSeed(await (await open()).get("meta", "seed"));

const topLevelOnly = (): void => {
  if (framed) throw new Error("sign-in and sign-out run top-level only, never in a frame");
};

async function signIn(ceremony: () => Promise<PasskeyOutcome>): Promise<void> {
  topLevelOnly();
  // never replace a seed already stored here, and run no ceremony: sign out first (wallet.md:919)
  const had = await readSeed();
  if (had) return show("signed-in", shown(had));
  const r = await ceremony();
  if (r.kind !== "prf") return show(r.kind);
  try {
    const seed: Seed = { v: 1, entropy: r.entropy, source: "prf", code_saved: false, created_ms: Date.now() };
    // insert-only: when another tab stored a seed meanwhile, that one stays and is the account shown
    const { seed: stored } = await (await open()).insertSeed(seed);
    show("signed-in", shown(checkSeed(stored)!));
  } finally {
    r.entropy.fill(0);
  }
}

async function signOut(): Promise<void> {
  topLevelOnly();
  const s = await open();
  store = null;
  await s.signOut();
  show("signed-out");
}

let busy = false;
async function run(step: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await step();
  } catch {
    show("error");
  } finally {
    busy = false;
  }
}

show("loading");
void run(async () => {
  const s = await readSeed();
  if (s) show("signed-in", shown(s));
  else show(typeof PublicKeyCredential === "undefined" ? "unsupported" : "signed-out");
});
