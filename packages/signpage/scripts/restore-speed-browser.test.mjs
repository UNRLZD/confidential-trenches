// card ci-queue-races-gone: a top-level visit to APP_HOST replaces itself with SIGN_HOST's shell at once
// (apps/terminal/src/shell/in-shell.ts moveToShell), and Firefox can report that move's commit before the visit's own, so
// goto threw "interrupted by another navigation" to the shell and the run never started (merge queue run 43665465254,
// firefox-rpc-blocked.mjs). openInShell ends at the shell in either order and throws on anything else.
//   node --test packages/signpage/scripts/restore-speed-browser.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { REAL } from "../../../apps/terminal/test/harness/harness.mjs";
import { openInShell } from "./restore-speed-browser.mjs";

const VISIT = `https://${REAL.app}/discover`;
const SHELL = `https://${REAL.sign}/discover`;
// Playwright's error when another navigation commits first (its frames.ts, Firefox 155 in run 43665465254)
const interrupted = (to) => () => {
  throw new Error(`page.goto: Navigation to "${VISIT}" is interrupted by another navigation to "${to}"\nCall log:\n  - navigating to "${VISIT}", waiting until "commit"`);
};
// a page whose goto ends as `goto` does and whose address reaches `at` (null: never, the wait times out)
const page = (goto, at) => ({
  goto: async () => goto(),
  waitForURL: async (match, { timeout, waitUntil }) => {
    assert.equal(waitUntil, "commit", "the wait ends at the shell's commit");
    if (at && match(new URL(at))) return;
    throw new Error(`page.waitForURL: Timeout ${timeout}ms exceeded.`);
  },
});

test("planted: the shell's commit reported before the visit's (Firefox) ends at the shell, where main's goto threw", async () => {
  const p = page(interrupted(SHELL), SHELL);
  // main's two lines, as oneRun had them at b1c340561
  await assert.rejects(async () => {
    await p.goto(VISIT, { waitUntil: "commit" });
    await p.waitForURL((x) => x.hostname === REAL.sign, { timeout: 60_000 });
  }, /is interrupted by another navigation to/);
  await openInShell(p, VISIT, 60_000);
});

test("the visit's commit reported first (Chrome) ends at the shell", async () => {
  await openInShell(page(() => null, SHELL), VISIT, 60_000);
});

test("planted: a visit interrupted by a move anywhere but the shell at the same path is thrown", async () => {
  for (const to of [`https://${REAL.sign}/portfolio`, `https://${REAL.app}/discover`, "https://evil.example/discover"])
    await assert.rejects(openInShell(page(interrupted(to), SHELL), VISIT, 60_000), (e) => e.message.includes(`another navigation to "${to}"`));
});

test("planted: a visit that fails, or never reaches the shell, is thrown", async () => {
  await assert.rejects(openInShell(page(() => {
    throw new Error("page.goto: NS_ERROR_CONNECTION_REFUSED");
  }, null), VISIT, 60_000), /NS_ERROR_CONNECTION_REFUSED/);
  await assert.rejects(openInShell(page(() => null, null), VISIT, 60_000), /Timeout 60000ms exceeded/);
});
