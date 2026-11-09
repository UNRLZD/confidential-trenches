// The signing page's replays (card held-move-replay-any-build): each replay of "the committed build in this tree"
// reads the tree's index.html and public/app.js with the check's own reader and judges them with the live rule, so any
// build of the tree that keeps the rule passes with no re-record. This module plants a build for those replays to read:
// the tree's /app.js with one edit, and / with its integrity set to the edited bytes' sha384, as
// packages/signpage/scripts/build-app.mjs writes it on a rebuild. Every other path is the tree's, headers included.
// Runs: once, no check: a module the signing page's replays share (held-move-forgotten-tx, wallet-restore-id-reader,
// held-deposit-way-out and wallet-withdraw-move-out .test.mjs hold it)
import { createHash } from "node:crypto";

/** An unrelated copy change, as a signing page card makes one: the first words in the bundle (a literal such as
 *  `Sign out`) that no string of `avoid` (the check's marks) holds or is held by, written in capitals. Any build has
 *  such words, so the plant names none of today's; it throws when there are none, so a plant never plants nothing. */
export function copyChange(text, avoid = []) {
  const marks = avoid.filter((a) => typeof a === "string");
  for (const m of text.matchAll(/`([A-Z][a-z]+(?: [a-z]+)+)`/g)) {
    if (marks.some((a) => a.includes(m[1]) || m[1].includes(a))) continue;
    return text.slice(0, m.index) + `\`${m[1].toUpperCase()}\`` + text.slice(m.index + m[0].length);
  }
  throw new Error("planted-build: the tree's /app.js holds no words to change");
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
