// The signing page's replays (card held-move-replay-any-build): each replay of "the committed build in this tree"
// reads the tree's index.html and public/app.js with the check's own reader and judges them with the live rule, so any
// build of the tree that keeps the rule passes with no re-record. This module plants a build for those replays to read:
// the tree's /app.js with one edit, and / with its integrity set to the edited bytes' sha384, as
// packages/signpage/scripts/build-app.mjs writes it on a rebuild. Every other path is the tree's, headers included.
// Runs: once, no check: a module the signing page's replays share (held-move-forgotten-tx, wallet-restore-id-reader,
// held-deposit-way-out and wallet-withdraw-move-out .test.mjs hold it)
import { createHash } from "node:crypto";

/** An unrelated copy change, as a signing page card makes one: a button's word. */
export const COPY_CHANGE = Object.freeze({ from: "`Sign out`", to: "`Log out`" });

/** Replaces `from` once in `text`; throws when the tree's bundle no longer holds it, so a plant never silently plants nothing. */
export function replaceOnce(text, from, to) {
  const at = text.indexOf(from);
  if (at < 0) throw new Error(`planted-build: the tree's /app.js holds no ${JSON.stringify(from)}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** Drops every occurrence of `rule` (a string or a global pattern) from `text`; throws when it holds none. */
export function dropRule(text, rule) {
  const out = rule instanceof RegExp ? text.replace(rule, "") : text.split(rule).join("");
  if (out === text) throw new Error(`planted-build: the tree's /app.js holds no ${String(rule)}`);
  return out;
}

/** A fetch over `localFetch` (the check's own reader of the tree) that serves the tree's /app.js through `edit` and /
 *  with its integrity naming the edited bytes. */
export function plantedFetch(localFetch, edit) {
  return async (url, init) => {
    const p = new URL(url).pathname;
    const res = await localFetch(url, init);
    if (p !== "/" && p !== "/app.js") return res;
    const js = edit(await (await localFetch(new URL("/app.js", url), init)).text());
    if (p === "/app.js") return new Response(js, { status: res.status, headers: res.headers });
    const sri = `sha384-${createHash("sha384").update(js).digest("base64")}`;
    const html = (await res.text()).replace(/(<script\b[^>]*\sintegrity=")[^"]*"/, `$1${sri}"`);
    return new Response(html, { status: res.status, headers: res.headers });
  };
}
