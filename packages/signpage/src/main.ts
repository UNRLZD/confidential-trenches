// SIGN_HOST's sign-in screen, top-level (docs/plan1/wallet.md §2.2 :47-56 and "Storage and unlock" :151-160 at research
// ffcba5e). Card wallet-passkey-prf: the passkey with PRF way in.
//
// - On open the page reads its own store first (wallet.md:50): with a seed there it is signed in, with no passkey sheet
//   (wallet.md:155); with none it offers the passkey ways in.
// - Create passkey / Use passkey run the ceremony (@blindfill/wallet/signin/passkey); a PRF result becomes the seed's
//   entropy, kept only in the store under K_wrap with the way in and code_saved (wallet.md:152-153). A PRF account's
//   12 words come back from the passkey, so it is not behind the backup gate (OD:20 is the no-PRF one's).
// - A passkey without PRF makes nothing here and shows its own state, "no-prf", which the no-PRF path takes over
//   (card wallet-typed-words); never a silent fallback to another seed.
// - Sign out deletes the store (wallet.md:156).
// - The page shows public values only: the account's profile key T_0 (wallet.md:68, a public key, never a NEAR account
//   or money), in data-account, so a check can compare it. The entropy, the words and seed64 never reach the DOM.
// - DOM by createElement and textContent only: the page's CSP requires Trusted Types for every script sink.
import { entropyToWords, profileKey, wordsToSeed64 } from "@blindfill/wallet/derive";
import { createPasskey, getPasskey, type PasskeyOutcome } from "@blindfill/wallet/signin/passkey";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";

type Seed = { entropy: Uint8Array; way: "passkey"; code_saved: boolean };
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

const root = document.createElement("main");
root.id = "signin";
document.body.append(root);

function button(action: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.action = action;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function show(state: State, account?: string): void {
  root.dataset.signin = state;
  if (account) root.dataset.account = account;
  else delete root.dataset.account;
  const parts: HTMLElement[] = [];
  if (state !== "loading" && state !== "signed-out" && state !== "signed-in") {
    const p = document.createElement("p");
    p.textContent = WORDS[state];
    parts.push(p);
  }
  if (state === "signed-in") {
    const p = document.createElement("p");
    p.textContent = WORDS["signed-in"];
    parts.push(p, button("signout", WORDS.signout, () => void run(signOut)));
  } else if (state !== "loading" && state !== "unsupported") {
    parts.push(button("create", WORDS.create, () => void run(() => signIn(createPasskey))));
    parts.push(button("use", WORDS.use, () => void run(() => signIn(getPasskey))));
  }
  root.replaceChildren(...parts);
}

// The account's public id from its entropy: entropy -> 12 words -> seed64 -> T_0 (wallet.md:47, :54, :68).
function accountOf(entropy: Uint8Array): string {
  return profileKey(wordsToSeed64(entropyToWords(entropy)), 0).id;
}

let store: WalletStore | null = null;
const open = async (): Promise<WalletStore> => (store ??= await openWalletStore());

async function readSeed(): Promise<Seed | undefined> {
  const s = (await (await open()).get("meta", "seed")) as Seed | undefined;
  if (s !== undefined && !(s.entropy instanceof Uint8Array && s.entropy.length === 16)) throw new Error("the stored seed is broken");
  return s;
}

async function signIn(ceremony: () => Promise<PasskeyOutcome>): Promise<void> {
  // never replace a seed already stored here: sign out first (wallet.md:919)
  const had = await readSeed();
  if (had) return show("signed-in", accountOf(had.entropy));
  const r = await ceremony();
  if (r.kind !== "prf") return show(r.kind);
  const seed: Seed = { entropy: r.entropy, way: "passkey", code_saved: true };
  await (await open()).put("meta", "seed", seed);
  show("signed-in", accountOf(r.entropy));
}

async function signOut(): Promise<void> {
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
  if (s) show("signed-in", accountOf(s.entropy));
  else show(typeof PublicKeyCredential === "undefined" ? "unsupported" : "signed-out");
});
