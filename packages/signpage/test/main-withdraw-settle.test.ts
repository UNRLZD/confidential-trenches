// src/main.ts booted top-level as the testnet build (card signpage-withdraw-handoff): a sign-in that lands runs the
// vault withdrawals' settle pass (src/withdraw/handoff.ts withdrawSettle), and the signal that pass waits on aborts on
// another tab's sign out (heard on the wallet's channel). This tab's own sign out is test/main-withdraw-settle-own.test.ts:
// a landed sign out reloads the page (card sign-out-stops-the-pages-reads), so each has a document of its own. The
// page, its hooks and its stubs are test/main-withdraw-settle-page.ts.
//   node --test test/main-withdraw-settle.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { openWalletStore } from "@blindfill/wallet/store";
import { gl, reloads, settles, until } from "./main-withdraw-settle-page.ts";

test("the testnet page: a landing runs the withdrawals' settle pass, and its wait stops on another tab's sign out, which reloads the page; that tab's next sign in runs no pass here", async () => {
  const w = await openWalletStore({});
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "code", code_saved: true, created_ms: 1 });
  w.close();

  await import("../src/main.ts");
  await until("the boot landing's settle pass", () => settles.length >= 1);
  const first = settles[0];
  assert.ok(first instanceof AbortSignal, "the pass waits on the page's sign-out signal");
  assert.equal(first.aborted, false);

  // another tab signs out: the wallet's channel carries it
  const other = new (globalThis.BroadcastChannel as typeof BroadcastChannel)("ct-wallet");
  other.postMessage({ kind: "signout" });
  await until("another tab's sign out stops the wait", () => first.aborted);
  await until("another tab's sign out reloads the page", () => reloads.n > 0);
  other.close();

  // that tab signs in again: this document, kept by the stub, lands on a closed gate, which reloads and runs no pass
  const atSignIn = reloads.n;
  const again = await openWalletStore({});
  await again.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7e), source: "code", code_saved: true, created_ms: 2 });
  again.close();
  await until("the landing on a closed gate reloads", () => reloads.n > atSignIn);
  assert.equal(settles.length, 1, "a landing on a closed gate ran a settle pass");
});

// card wallet-withdraw-move-out: main.ts keeps the pass's outcome, no longer dropping it: the form's deps count its drifts
test("the settle pass's unmatched outcomes reach the withdraw form's deps", async () => {
  await import("../src/main.ts");
  await until("a settle pass", () => settles.length >= 1);
  const deps = () => (gl.__ctWithdrawDeps as () => { unmatched?: () => number })();
  await until("the pass's outcomes kept", () => deps().unmatched?.() === 1);
  assert.equal(deps().unmatched?.(), 1);
});
