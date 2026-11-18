// main.ts's New account (card wallet-signin-wallet; docs/plan1/wallet.md §2.2 :50, OD:271, OD:349): offered only with a
// wallet in the window, guarded like Sign out, and run by signInByWallet, which reads the store before the wallet is asked
// (a stored seed is the account, never replaced) and makes the seed only through newAccountByWallet's checked path.
// The browser run of the same path with a stand-in wallet is scripts/live-checks/signpage-signin-kinds.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("main.ts: New account runs signInByWallet, offered only with a wallet in the window, and is a guarded control", () => {
  assert.ok(/button\("new-account", WORDS\["new-account"\], \(\) => void run\(signInByWallet\)\)/.test(src), "New account runs the wallet sign-in");
  assert.ok(/if \(!walletFound\(\)\) \{\s*fresh\.disabled = true;\s*fresh\.dataset\.pending = "no-wallet";/.test(src), "no wallet: drawn, not offered");
  assert.ok(!/wallet-signature/.test(src), "the old pending marker is gone");
  assert.ok(/const GUARDED = new Set\(\[[^\]]*"new-account"[^\]]*\]\)/.test(src), "New account is a guarded control");
});

test("main.ts: signInByWallet reads the store before the wallet is asked, and lands on a stored seed", () => {
  const body = src.slice(src.indexOf("async function signInByWallet"), src.indexOf("// ses.10-12: the typed 12 words"));
  assert.ok(body.length > 0, "signInByWallet is in main.ts");
  const read = body.indexOf("const had = await readSeed();");
  const ask = body.indexOf("await newAccountByWallet(open)");
  assert.ok(body.indexOf("topLevelOnly();") >= 0 && read > 0 && ask > read, "top-level only, the store read, then the wallet");
  assert.ok(/if \(had\) return landed\(\{ screen: "signed-in", seed: had \}\);/.test(body), "a stored seed is the account");
  assert.ok(/show\(r\.kind === "cancelled" \? "choose" : "error"\)/.test(body), "the wallet's no goes back to the two choices");
});
