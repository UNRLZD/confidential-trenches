// node --test scripts/live-checks/open-in-shell.test.mjs: the shared visit to APP_HOST (card app-in-shell-visit-race,
// first card ci-queue-races-gone) ends at SIGN_HOST's shell in either order Firefox reports the two commits, and throws
// on a move anywhere else, a failed visit or a shell that never commits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openInShell } from "./open-in-shell.mjs";

const APP = "https://ct-app.unrealized.trade";
const SHELL = "https://confidential.unrealized.trade";

// Playwright's error when another navigation commits first (its frames.ts; Firefox 155 in run 43665465254)
const interrupted = (visit, to) => () => {
  throw new Error(`page.goto: Navigation to "${visit}" is interrupted by another navigation to "${to}"\nCall log:\n  - navigating to "${visit}", waiting until "commit"`);
};
// a page whose goto ends as `goto` does and whose address reaches `at` (null: never, the wait times out); `waits`
// keeps each wait's options
const fakePage = (goto, at, waits = []) => ({
  goto: async () => goto(),
  waitForURL: async (match, opts) => {
    waits.push(opts);
    if (at && match(new URL(at))) return;
    throw new Error(`page.waitForURL: Timeout ${opts.timeout}ms exceeded.`);
  },
});

for (const where of ["/discover", "/discover?ref=app-in-shell"]) {
  const visit = `${APP}${where}`;
  const shell = `${SHELL}${where}`;

  test(`planted: ${where}: the shell's commit reported before the visit's (Firefox) ends at the shell, where a bare goto threw`, async () => {
    const p = fakePage(interrupted(visit, shell), shell);
    await assert.rejects(p.goto(visit, { waitUntil: "commit" }), /is interrupted by another navigation to/);
    const waits = [];
    await openInShell(fakePage(interrupted(visit, shell), shell, waits), visit, SHELL, 8_000);
    assert.deepEqual(waits, [{ timeout: 8_000, waitUntil: "commit" }], "one wait, armed before the visit, ending at the shell's commit");
  });

  test(`${where}: the visit's commit reported first (Chrome) ends at the shell`, async () => {
    await openInShell(fakePage(() => null, shell), visit, SHELL, 8_000);
  });

  test(`planted: ${where}: a visit interrupted by a move anywhere but the shell at the same path and query is thrown`, async () => {
    for (const to of [`${SHELL}/portfolio`, `${SHELL}/discover?ref=other`, visit, `https://evil.example${where}`])
      if (to !== shell) await assert.rejects(openInShell(fakePage(interrupted(visit, to), shell), visit, SHELL, 8_000), (e) => e.message.includes(`another navigation to "${to}"`));
  });

  test(`planted: ${where}: a visit that fails, or a shell that never commits, is thrown`, async () => {
    await assert.rejects(openInShell(fakePage(() => {
      throw new Error("page.goto: NS_ERROR_CONNECTION_REFUSED");
    }, null), visit, SHELL, 8_000), /NS_ERROR_CONNECTION_REFUSED/);
    await assert.rejects(openInShell(fakePage(() => null, null), visit, SHELL, 8_000), /^Error: page\.waitForURL: Timeout 8000ms exceeded/);
  });
}
