#!/usr/bin/env node
// Live check of card sign-out-stops-the-pages-reads: on what SIGN_HOST serves, a sign out that lands stops every read of
// the account that went. The run is signpage-shell.mjs's own (its collect, on Chromium, whose virtual authenticator makes
// the passkey accounts), and its verdict is the sign-out part of that check's judge, imported, not copied:
//   - this tab's own Sign out (the app's signout, answered pending, then the sign-out page's button) reloads the top
//     window: a new document begun after the tap, whose new frame posts ready within RELOAD_MS and answers exactly
//     signed out; the same for a sign out in another tab (the store's post and the database's delete, in one task);
//   - a second passkey account lands after the words' account signed out, and signs out by this tab's button the same way;
//   - from the words' sign out's new document on, no request names an address or id that account's requests to the
//     pinned hosts carried (none that the first account's requests or the page's own code carry; a live run must find
//     at least one, the restore's reads naming the account's ids);
//   - signed out, no request leaves SIGN_HOST and APP_HOST, and a state asked at the end answers signed out.
// A line missing from the shell check's verdict is BAD: a build before the card signs out with no reload, so its run has
// no such line (or the line is BAD).
// After: sign --engine chromium --live --width phone
//   node scripts/live-checks/sign-out-stops-the-pages-reads.mjs --engine chromium --live --width phone [--record <f>]
//   node scripts/live-checks/sign-out-stops-the-pages-reads.mjs --engine chromium [--site <dir>] [--record <f>]
//     the harness: SIGN_HOST from this checkout's build, or from <dir>
// PASS exit 0, FAIL exit 1, error exit 2. No money; the words are the published vector's, the passkeys the virtual
// authenticator's, thrown away with the profile.
import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect, judge as shellJudge } from "./signpage-shell.mjs";

const KEY = "sign-out-stops-the-pages-reads";
/** The shell check's lines this card's end state is: each must be in its verdict, and ok. */
export const SIGN_OUT_LINES = Object.freeze([
  "Sign out in this tab, by its own Sign out button: the top window reloads and its new frame answers exactly signed out",
  "Sign out in another tab: the top window reloads and its new frame answers exactly signed out",
  "the second passkey account's Sign out in this tab: the top window reloads and its new frame answers exactly signed out",
  "after the words' account signs out and a second account lands, no request names the words' account",
  "signed out, no request goes past SIGN_HOST and APP_HOST",
  "a state asked again answers signed out",
]);

/** The verdict on one recorded run: { ok, lines }. */
export function judge(rec) {
  const all = shellJudge(rec).lines;
  const lines = [
    `${rec?.engine === "chromium" ? "ok " : "BAD"} the run is Chromium's, whose virtual authenticator makes the passkey accounts (${rec?.engine ?? "none"})`,
    ...SIGN_OUT_LINES.map((p) => all.find((l) => l.slice(4).startsWith(p)) ?? `BAD ${p} (no such line in the shell check's verdict: a build that does not reload on a sign out)`),
  ];
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    const engine = arg("--engine") ?? "chromium";
    if (engine !== "chromium") throw new Error("--engine must be chromium (the passkey accounts are its virtual authenticator's)");
    const site = arg("--site");
    const rec = await collect({ engine, site: site && path.resolve(site), live: process.argv.includes("--live"), width: arg("--width") ?? "phone" });
    const out = arg("--record");
    if (out) writeFileSync(out, `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    if (rec.errors.length) console.log(`errors: ${rec.errors.join(" | ")}`);
    console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, ${rec.browser}, ${rec.view.name} ${rec.view.width} x ${rec.view.height}, ${rec.at})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
