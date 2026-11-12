// src/main.ts booted top-level as the testnet build (card signpage-withdraw-handoff): the signal the boot landing's
// settle pass waits on aborts on this tab's own sign out before the store posts it (not only once its own broadcast
// comes back), and the landed sign out reloads the page (card sign-out-stops-the-pages-reads). Another tab's sign out is
// test/main-withdraw-settle.test.ts, each in a document of its own; the page is test/main-withdraw-settle-page.ts.
//   node --test test/main-withdraw-settle-own.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { openWalletStore } from "@blindfill/wallet/store";
import { gl, reloads, settles, until } from "./main-withdraw-settle-page.ts";

test("the testnet page: this tab's sign out stops the boot landing's settle wait before the store signs out, then reloads the page", async () => {
  const w = await openWalletStore({});
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "code", code_saved: true, created_ms: 1 });
  w.close();

  await import("../src/main.ts");
  await until("the boot landing's settle pass", () => settles.length >= 1);
  const first = settles[0]!;
  assert.equal(first.aborted, false);
  let atPost: boolean | null = null;
  gl.__ctAtSignoutPost = () => (atPost ??= first.aborted);
  await (gl.__ctSignOut as () => Promise<void>)();
  assert.equal(atPost, true, "this tab's sign out stops the wait before the store signs out (not only once its own broadcast comes back)");
  assert.ok(reloads.n > 0, "the landed sign out reloads the page");
  assert.equal(settles.length, 1);
});
