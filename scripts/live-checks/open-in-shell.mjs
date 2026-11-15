// The one visit to APP_HOST that every browser run makes as a user does (card app-in-shell-visit-race): a top-level
// visit replaces itself with SIGN_HOST's shell at the same path and query at once (apps/terminal/src/shell/in-shell.ts
// moveToShell, from the app's start). Firefox can report that move's commit before the visit's own, and Playwright's
// goto then throws "interrupted by another navigation" to the shell (merge queue runs 43665465254 and 43669414912,
// 8 of 100 visits under load on the box). Used by scripts/live-checks/app-in-shell.mjs and
// packages/signpage/scripts/restore-speed-browser.mjs; scripts/live-checks/open-in-shell.test.mjs plants each end.
// Runs: once, a module the checks share (app-in-shell's visit and the restore runs'), no check of its own

/**
 * Visits `url` (on APP_HOST) and waits for its move to the shell at `shellOrigin` with the same path and query. The
 * wait for the shell is armed before the visit, and the visit ends at its own commit or at that move; any other error,
 * or a move anywhere else, is thrown. The wait ends at the shell's commit, not its load: a load state read across
 * Firefox's two reports can wait for a load that already fired, and each caller's next step waits for the framed
 * terminal itself. A shell that does not commit within `timeout` throws Playwright's "page.waitForURL: Timeout".
 * @param {import("playwright").Page} page
 * @param {string} url
 * @param {string} shellOrigin
 * @param {number} timeout
 */
export async function openInShell(page, url, shellOrigin, timeout) {
  const origin = new URL(shellOrigin).origin;
  const at = new URL(url);
  const shell = `${origin}${at.pathname}${at.search}`;
  const moved = page.waitForURL((x) => x.origin === origin, { timeout, waitUntil: "commit" });
  try {
    await page.goto(url, { waitUntil: "commit" });
  } catch (e) {
    if (!String(e?.message).includes(`is interrupted by another navigation to "${shell}"`)) {
      moved.catch(() => {});
      throw e;
    }
  }
  await moved;
}
