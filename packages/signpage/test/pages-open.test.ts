// The account's open kinds (src/pages/open.ts; wallet.md §2.8 W:912-914 and §2.2 W:50 at research ffcba5e): which page
// each kind draws, from the page's own state and store.   node --test test/pages-open.test.ts   (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { afterSaved, pageFor, takes } from "../src/pages/open.ts";

const PRF = { source: "prf", code_saved: false }; // a passkey with PRF: the words are not the only copy
const SAVED = { source: "random", code_saved: true };
const UNSAVED = { source: "random", code_saved: false }; // no PRF, the 12 words the only copy and not saved
const TYPED = { source: "code", code_saved: true };
const WALLET_UNSAVED = { source: "wallet", code_saved: false };

test("signin.open never replaces a seed: refused while one is stored, and a seed stored meanwhile is the account shown", () => {
  for (const st of ["signed-in", "backup", "signout"]) assert.equal(takes("signin.open", st, false), false, st);
  for (const st of ["signed-out", "unsupported", "words", "invalid-code", "choose", "existing", "cancelled", "error", "no-prf"])
    assert.equal(takes("signin.open", st, false), true, st);
  for (const way of ["passkey", "words", "wallet"]) assert.equal(pageFor("signin.open", way, PRF, true), "signed-in");
});

test("signin.open draws the way's page; the wallet way draws the two choices first, before any wallet request or seed", () => {
  assert.equal(pageFor("signin.open", "passkey", undefined, true), "passkey");
  assert.equal(pageFor("signin.open", "passkey", undefined, false), "unsupported");
  assert.equal(pageFor("signin.open", "words", undefined, true), "words");
  assert.equal(pageFor("signin.open", "wallet", undefined, true), "choose");
  assert.equal(pageFor("signin.open", "wallet", undefined, false), "choose");
});

test("signout: only with a seed; the backup first while the 12 words are the only copy and not saved", () => {
  for (const st of ["signed-out", "unsupported", "words", "choose", "existing", "backup", "signout", "loading"])
    assert.equal(takes("signout", st, false), false, st);
  assert.equal(takes("signout", "signed-in", false), true);
  assert.equal(pageFor("signout", undefined, PRF, true), "signout");
  assert.equal(pageFor("signout", undefined, SAVED, true), "signout");
  assert.equal(pageFor("signout", undefined, TYPED, true), "signout");
  assert.equal(pageFor("signout", undefined, UNSAVED, true), "backup");
  assert.equal(pageFor("signout", undefined, WALLET_UNSAVED, true), "backup");
  assert.equal(pageFor("signout", undefined, undefined, true), "signed-out");
  // Saved on a backup that sign-out opened goes on to Sign out; any other goes back to the app
  assert.equal(afterSaved("signout"), "signout");
  assert.equal(afterSaved("backup.open"), "signed-in");
  assert.equal(afterSaved("signin.open"), "signed-in");
  assert.equal(afterSaved(null), "signed-in");
});

test("backup.open: only with a seed, and it draws the backup", () => {
  assert.equal(takes("backup.open", "signed-in", false), true);
  for (const st of ["signed-out", "words", "choose", "backup", "signout"]) assert.equal(takes("backup.open", st, false), false, st);
  for (const s of [PRF, SAVED, UNSAVED]) assert.equal(pageFor("backup.open", undefined, s, true), "backup");
  assert.equal(pageFor("backup.open", undefined, undefined, true), "signed-out");
});

test("no kind is taken while a step runs or before the store is read", () => {
  for (const k of ["signin.open", "signout", "backup.open"] as const) {
    assert.equal(takes(k, "signed-in", true), false);
    assert.equal(takes(k, "signed-out", true), false);
    assert.equal(takes(k, "loading", false), false);
    assert.equal(takes(k, undefined, false), false);
  }
});
