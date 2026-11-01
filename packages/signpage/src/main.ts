// SIGN_HOST's sign-in screen, top-level (docs/plan1/wallet.md §2.2 :47-56 and "Storage and unlock" :151-160 at research
// ffcba5e). Card wallet-passkey-prf: the passkey with PRF way in.
//
// - On open the page reads its own store first (wallet.md:50): with a seed there it is signed in, with no passkey sheet
//   (wallet.md:155); with none it offers the passkey ways in.
// - Sign-in and sign-out run top-level only (wallet.md:921-922). In a frame (APP_HOST may frame this page) it shows
//   neither control and both steps refuse, so a framing page cannot get a click on them. In the frame the page speaks
//   the postMessage API (src/api.ts, card signpage-postmessage), started below, with the state the store holds
//   (src/state.ts, card signpage-frame-state): signed in, words saved, the way in and the ops, posted again on each change.
//   The frame never opens the seed record and opens the store read-only: it reads the seed's key and the status record
//   meta/"status" { v, source, code_saved }, which the store writes in the seed's own transaction. A database from
//   before the status record gets it on the next top-level load (syncStatus, below).
// - Create passkey / Use passkey run the ceremony (@blindfill/wallet/signin/passkey). A PRF result becomes the seed's
//   entropy, written by the store's insertSeed only if no seed is stored (two tabs never write one over the other); the
//   record is 06b:459's { v, entropy, source: "prf", code_saved: false, created_ms } (ses.2, ses.7, 06b:776, :781), so
//   the Backup dot shows (data-code-saved="false"). A no-PRF gate keys on source, never on code_saved.
// - A seed already stored is never replaced and no ceremony runs (wallet.md:919: sign out first).
// - The no-PRF path and the typed words (card wallet-typed-words, @blindfill/wallet/signin/words; wallet.md:48-49, W:914;
//   06b ses.4, ses.5, ses.8, ses.10-12). Create passkey with a passkey that has no PRF makes a random seed { source:
//   "random", code_saved: false } (ses.4) and goes on, in the same top-level visit, to the backup screen
//   (data-signin="backup"): the 12 words, Copy and Saved. Saved sets code_saved (ses.5); leaving without it keeps the
//   Backup dot, and the signed-in screen then offers Backup again. Use passkey with a passkey that has no PRF makes
//   nothing (ses.8) and offers the 12 words. Recovery code takes typed words: the BIP-39 checksum is checked on the
//   device first, a failure shows "Invalid code" (CN-41) and stores nothing, and good words store { source: "code",
//   code_saved: true } (ses.12). Words are drawn and typed on the top-level page only, never in a frame (W:914).
// - Sign out deletes the store (wallet.md:156); another tab's sign out shows signed-out here too. It is not drawn, and the
//   store refuses it, while the 12 words are the only copy and not saved (backupFirst: source not "prf" and code_saved
//   false; wallet.md:922). Its activation guard is Chromium's own rule for its permission and payment sheets (./guard.ts):
//   a press is ignored when it is a repeated key, when it comes within 500 ms of the window's previous pointerdown or
//   keydown, or within 500 ms of Sign out being drawn, the page becoming visible (visibilitychange, pageshow) or the
//   window gaining focus; the same for mouse, touch, pen and keyboard. A click that a cross-site page lined up before
//   sending this window here (a double-click trick, a burst of clicks, a held Enter) does nothing; a press after a
//   500 ms pause works on every input. It guards every control that acts with no sheet of the browser's own (GUARDED):
//   Sign out; the backup's Saved, which opens the deposit gate of a seed whose 12 words are the only copy (W:888), so a
//   lined-up click cannot mark words saved that the user never saw; Backup, which draws the 12 words; and Copy, which
//   puts them on the clipboard, so a lined-up burst cannot draw the words and copy them for a paste the page asks for.
//   Create passkey and Use passkey open the browser's own passkey sheet, which carries the browser's protection.
// - The page shows public values only, but for the backup screen's 12 words: the account's profile key T_0 (wallet.md:68,
//   a public key, never a NEAR account or money), in data-account, so a check can compare it. The entropy and seed64
//   are zeroed once used; the 12 words are a JS string, which cannot be zeroed, and reach the DOM only on the backup
//   screen, top-level, and leave it only by the user's own tap on Copy (W:914).
// - Top-level, the page is the shell (src/shell.ts, card signpage-shell): it frames APP_HOST with this URL's path and
//   query and answers the kit's API to that frame alone, with the state src/state.ts reads from this document's own
//   store (the read-only reader: the state needs the seed's key, the status record and the ops, never the seed, and
//   it makes no database before a sign-in). These screens draw in the shell's layer over the frame: shown while there
//   is a step to take here (signed out, the words, the backup, an error) and hidden once signed in, so the terminal
//   shows. Opening the layer from the app (signin.open, backup.open, signout) is card signpage-signin-kinds.
// - DOM by createElement and textContent only: the page's CSP requires Trusted Types for every script sink.
import { entropyToWords, profileKey, wordsToSeed64 } from "@blindfill/wallet/derive";
import { createPasskey, getPasskey, type PasskeyOutcome } from "@blindfill/wallet/signin/passkey";
import { backupFirst, openWalletStore, openWalletStoreReader, WALLET_CHANNEL, type WalletStore } from "@blindfill/wallet/store";
import { backupWords, checkSeed, saveWords, signInNoPrf, signInPrf, signInTyped, WordsRefused, type Landing, type Seed } from "@blindfill/wallet/signin/words";
import { activationGuard, type Press } from "./guard.ts";
import { startApi } from "./api.ts";
import { frameState } from "./state.ts";
import { mountShell } from "./shell.ts";

type State = "loading" | "signed-out" | "signed-in" | "no-prf" | "cancelled" | "unsupported" | "error" | "backup" | "words" | "invalid-code";

// DRAFT COPY: the final words are not set yet, but for copy and saved (S3.1's labels, 09-design-brief.md:801) and
// "invalid-code" (CN-41, signed, 09-design-brief.md:2335). recovery is S2.1's [draft copy: Recovery code]
// (09-design-brief.md:1811); backup is 06b ses.17's menu item; next is a draft for S2.5's submit, which has no words yet.
const WORDS = {
  create: "Create passkey",
  use: "Use passkey",
  signout: "Sign out",
  "signed-in": "Signed in",
  "no-prf": "This passkey can't unlock an account here. Use your 12 words.",
  cancelled: "Cancelled",
  unsupported: "This browser has no passkeys. Use your 12 words.",
  error: "Something went wrong. Try again.",
  recovery: "Recovery code",
  backup: "Backup",
  copy: "Copy",
  saved: "Saved",
  next: "Continue",
  "invalid-code": "Invalid code",
} as const;

const framed = window.top !== window;
const root = document.createElement("main");
root.id = "signin";
if (framed) root.dataset.framed = "true";
// top-level: the shell, with these screens in its layer over the APP_HOST frame
let layer: HTMLElement | null = null;
if (framed) document.body.append(root);
else {
  // the shell's own channel: it hears this document's store and other tabs' (a sign-in, Saved, a sign out)
  const channel = new BroadcastChannel(WALLET_CHANNEL);
  const fs = frameState(
    (onEvent) => openWalletStoreReader({ onEvent }),
    (fn) => channel.addEventListener("message", (m) => fn(m.data)),
  );
  layer = mountShell(document, location, { state: fs.state, watch: fs.watch });
  layer.append(root);
}

// The activation guard of the GUARDED controls (./guard.ts). Every trusted pointerdown and keydown in the window reaches it first
// (capture phase), so the gap to the previous input is known when Sign out sees its press.
const guard = activationGuard(performance.now());
const reshown = (): void => guard.shown(performance.now());
addEventListener("pageshow", reshown);
addEventListener("focus", (e) => e.target === window && reshown());
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reshown());
let last: { e: Event; press: Press } | null = null;
const input = (e: Event): void => {
  if (e.isTrusted) last = { e, press: guard.input(e.timeStamp, e instanceof KeyboardEvent && e.repeat) };
};
addEventListener("pointerdown", input, true);
addEventListener("keydown", input, true);

const GUARDED = new Set(["signout", "saved", "backup", "copy"]);
function button(action: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.action = action;
  b.textContent = label;
  if (!GUARDED.has(action)) {
    b.addEventListener("click", onClick);
    return b;
  }
  // drawn now, and on screen by the next frame
  reshown();
  requestAnimationFrame(reshown);
  // the press is the pointerdown or Enter or Space keydown that starts the click, with the verdict the window's capture
  // listener just gave it; a click with none seen (an assistive tool's click) is its own press
  let press: Press | null = null;
  const pressed = (e: Event): void => {
    if (e.isTrusted && last?.e === e) press = last.press;
  };
  b.addEventListener("pointerdown", pressed);
  b.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && pressed(e));
  b.addEventListener("click", (e) => {
    const p = press;
    press = null;
    if (!e.isTrusted || !guard.allows(p, e.timeStamp)) return;
    onClick();
  });
  return b;
}

function show(state: State, seed?: { account: string; code_saved: boolean; signout: boolean }, words?: string): void {
  root.dataset.signin = state;
  if (layer) layer.hidden = state === "signed-in" || state === "loading";
  if (seed) {
    root.dataset.account = seed.account;
    root.dataset.codeSaved = String(seed.code_saved);
  } else {
    delete root.dataset.account;
    delete root.dataset.codeSaved;
  }
  const parts: HTMLElement[] = [];
  if (state !== "loading" && state !== "signed-out" && state !== "signed-in" && state !== "backup" && state !== "words") {
    const p = document.createElement("p");
    p.textContent = WORDS[state];
    parts.push(p);
  }
  if (state === "signed-in") {
    const p = document.createElement("p");
    p.textContent = WORDS["signed-in"];
    parts.push(p);
    if (!framed && seed?.signout) parts.push(button("signout", WORDS.signout, () => void run(signOut)));
    // the Backup dot: the 12 words are the only copy and not saved (ses.17, ses.18)
    if (!framed && seed && !seed.signout) parts.push(button("backup", WORDS.backup, () => void run(openBackup)));
  } else if (state === "backup") {
    // the 12 words, top-level only (W:914): show() is never asked for them in a frame, and backupWords refuses there
    if (!framed && words) {
      const list = document.createElement("ol");
      list.dataset.words = "12";
      for (const w of words.split(" ")) {
        const li = document.createElement("li");
        li.textContent = w;
        list.append(li);
      }
      parts.push(list);
      parts.push(button("copy", WORDS.copy, () => void navigator.clipboard?.writeText(words).catch(() => {})));
      parts.push(button("saved", WORDS.saved, () => void run(saved)));
    }
  } else if (!framed && (state === "words" || state === "invalid-code")) {
    const box = document.createElement("textarea");
    box.dataset.input = "words";
    box.rows = 3;
    box.autocomplete = "off";
    box.spellcheck = false;
    box.setAttribute("autocapitalize", "none");
    box.setAttribute("autocorrect", "off");
    parts.push(box);
    parts.push(button("next", WORDS.next, () => {
      const typed = box.value;
      box.value = "";
      void run(() => signInWords(typed));
    }));
  } else if (!framed && state !== "loading") {
    if (state !== "unsupported") {
      parts.push(button("create", WORDS.create, () => void run(() => signIn(createPasskey, true))));
      parts.push(button("use", WORDS.use, () => void run(() => signIn(getPasskey, false))));
    }
    parts.push(button("recovery", WORDS.recovery, () => show("words")));
  }
  root.replaceChildren(...parts);
}

// The account's public id from its entropy: entropy -> 12 words -> seed64 -> T_0 (wallet.md:47, :54, :68). seed64 is
// zeroed here, and so is T_0's secret key, which only its id is wanted from; the caller zeroes the entropy.
function accountOf(entropy: Uint8Array): string {
  const seed64 = wordsToSeed64(entropyToWords(entropy));
  try {
    const t = profileKey(seed64, 0);
    t.secretKey.fill(0);
    return t.id;
  } finally {
    seed64.fill(0);
  }
}
// What the screen shows of a seed, the seed's entropy zeroed after.
function shown(s: Seed): { account: string; code_saved: boolean; signout: boolean } {
  try {
    return { account: accountOf(s.entropy), code_saved: s.code_saved, signout: !backupFirst(s) };
  } finally {
    s.entropy.fill(0);
  }
}

let store: WalletStore | null = null;
const open = async (): Promise<WalletStore> =>
  (store ??= await openWalletStore({
    // another tab signed out: its store closed ours; drop it and show signed-out
    onEvent: (e) => {
      // a delete or upgrade closed our connection: the next step opens the store again
      if (e.kind === "closed") store = null;
      if (e.kind !== "signout") return;
      store = null;
      show("signed-out");
    },
  }));

const readSeed = async (): Promise<Seed | undefined> => checkSeed(await (await open()).get("meta", "seed"));

const topLevelOnly = (): void => {
  if (framed) throw new Error("sign-in and sign-out run top-level only, never in a frame");
};

// Where a sign-in landed (words.ts): the backup screen for a no-PRF seed this sign-in made, else signed in on the seed
// stored, which may be another tab's (never its words then).
async function landed(l: Landing): Promise<void> {
  if (l.screen === "backup") return void showBackup(l.seed);
  show("signed-in", shown(l.seed));
}

async function signIn(ceremony: () => Promise<PasskeyOutcome>, create: boolean): Promise<void> {
  topLevelOnly();
  // never replace a seed already stored here, and run no ceremony: sign out first (wallet.md:919)
  const had = await readSeed();
  if (had) return landed({ screen: "signed-in", seed: had });
  const r = await ceremony();
  // ses.4: a random seed, and the backup screen in the same visit; insert-only, so another tab's seed stays
  if (r.kind === "no-prf" && create) return landed(await signInNoPrf(open));
  if (r.kind !== "prf") return show(r.kind);
  // insert-only: when another tab stored a seed meanwhile, that one stays and is the account shown; the entropy is
  // zeroed on every path, an open that fails included (words.ts storeSeed)
  await landed(await signInPrf(open, r.entropy));
}

// ses.10-12: the typed 12 words, checked on the device before anything else; a failure stores nothing
async function signInWords(typed: string): Promise<void> {
  topLevelOnly();
  const had = await readSeed();
  if (had) return landed({ screen: "signed-in", seed: had });
  let l: Landing;
  try {
    l = await signInTyped(open, typed);
  } catch (e) {
    if (e instanceof WordsRefused) return show("invalid-code");
    throw e;
  }
  await landed(l);
}

// The backup screen (S3.1): the stored seed's 12 words, top-level only; the entropy is zeroed once they are made.
function showBackup(s: Seed): void {
  topLevelOnly();
  const seen = shown({ ...s, entropy: s.entropy.slice() });
  try {
    show("backup", seen, backupWords(s));
  } finally {
    s.entropy.fill(0);
  }
}
async function openBackup(): Promise<void> {
  const s = await readSeed();
  if (!s) return show("signed-out");
  showBackup(s);
}
// Saved (ses.5): code_saved becomes true; the Backup dot clears and Sign out is drawn
async function saved(): Promise<void> {
  topLevelOnly();
  await saveWords(await open());
  const s = await readSeed();
  if (!s) return show("signed-out");
  show("signed-in", shown(s));
}

async function signOut(): Promise<void> {
  topLevelOnly();
  const s = await open();
  // the handle is dropped only once the store has signed out: a refused sign out leaves it open and still held
  await s.signOut();
  store = null;
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
// top-level only: the frame never opens the seed record (src/state.ts reads the status instead); it draws nothing
if (framed) root.dataset.signin = "framed";
else
  void run(async () => {
    // one backfill: a database from before the status record gets it from the seed (the store writes it itself since);
    // a failed one leaves the frame reading the seed's key alone (signed in, the Backup dot) until the next load
    await open()
      .then((st) => st.syncStatus())
      .catch(() => {});
    const s = await readSeed();
    if (s) await landed({ screen: "signed-in", seed: s });
    else show(typeof PublicKeyCredential === "undefined" ? "unsupported" : "signed-out");
  });

if (framed) {
  // the frame's own channel: it hears another tab's sign-in even when no database exists yet to open
  const channel = new BroadcastChannel(WALLET_CHANNEL);
  const fs = frameState(
    (onEvent) => openWalletStoreReader({ onEvent }),
    (fn) => channel.addEventListener("message", (m) => fn(m.data)),
  );
  startApi({ parent: window.parent, listen: (fn) => window.addEventListener("message", fn), state: fs.state, watch: fs.watch });
}
