// The one judgment of a down RPC that every browser check reading the Verify panel's RPCs shares (card
// app-shell-rpc-outage-judge): app-shell.mjs, app-verify-mount.mjs and verify-pools.mjs call outages() on their load's
// console errors and the evidence the same load's DOM gave. Chrome writes a console error for every failed load, so a
// down RPC the page reads failed every check that listens to the console, and a failing live check undoes the deploy.
// A failed load of an RPC is let through, never failed on, in two cases, and in no other:
//   - a Verify read: the origin is one the release names (VERIFY_RELEASES: the NEAR pair, each pool's pair) and the same
//     load's Verify panel shows the rows that read it amber (Unverified: data-status "warn"), the NEAR pair's Code and
//     Funds rows both, a pool's pair its chain's row. A row shown ok, danger, loading or not drawn fails it: that is an
//     outage the page does not show;
//   - a footer read: the footer reads the NEAR pair's final block every 3 s on desktop, FastNEAR first and drpc when it
//     does not answer (src/shell/footer.ts), so a down RPC logs a failed load on every desktop route while the footer
//     shows Stable and draws its block. The collector tags a line of that read "[footer read]" (console-errors.mjs: the
//     request's own ?ct=footer, pinned by app-shell.test.mjs to footerUrl). It is let through when the footer's DOM
//     shows data-conn "on" with a block drawn, the pair answered by its other RPC. A footer showing anything else
//     (Offline, still waiting, no block) fails it.
// A double outage fails closed: both RPCs of the NEAR pair failing a footer read in one load, or the app's own
// console.error for a pair that gave no answer ("Verify read no final height on either RPC", "Verify read no head on A
// or B"), is a FAIL, and the deploy is retried. Any other console error, a failed load of an origin the release does not
// name, a 4xx other than 429, a block (ERR_BLOCKED_BY_*), a page error, still fails whatever the page shows.
// Not a check of its own; scripts/live-checks/app-shell.test.mjs holds it.
// Runs: once, no check of its own: the shared judgment of a down RPC (app-shell.test.mjs holds it)
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

export { VERIFY_RELEASES };

/** Each RPC origin the network's release names, to the Verify rows that read it: the NEAR pair feeds the Code and Funds
 *  rows, a pool's pair its chain's row. Derived from VERIFY_RELEASES, the lists the page itself reads. */
export function rpcRows(network = "mainnet") {
  const rows = new Map();
  const add = (url, row) => {
    const o = originOf(url);
    if (o) rows.set(o, [...(rows.get(o) ?? []), row]);
  };
  const release = VERIFY_RELEASES[network];
  for (const u of release?.rpcs ?? []) for (const row of ["code", "funds"]) add(u, row);
  for (const [chain, pool] of Object.entries(release?.pools ?? {})) for (const u of pool?.rpcs ?? []) add(u, chain);
  return rows;
}

// Chrome's own words for a failed load of one RPC, in the two forms a down RPC takes (console-errors.mjs keeps each text
// with any address cut to its origin and path, and a footer read's line tagged):
//   - the load itself: "Failed to load resource: ..." with the failed address in brackets (Chrome's own location of the
//     line, read from m.location().url): the network refused it (net::ERR_*, but not one that blocked it:
//     ERR_BLOCKED_BY_CSP, _ORB, _CLIENT stay errors), or the server answered 5xx or 429. A 4xx other than 429 is the
//     page's own fault and stays an error;
//   - its preflight: the app's reads POST JSON, so an RPC that answers the preflight with a 5xx or 429 (no HTTP ok
//     status) or without Access-Control-Allow-Origin, as a CDN's error page does, also gets "Access to fetch at '<url>'
//     ... blocked by CORS policy: Response to preflight request doesn't pass access control check: ...", which Chrome
//     locates at the page and names the failed address in its text. Any other CORS refusal (a header, a method, a
//     credentials rule) stays an error. Read 8 Nov in Chrome against a local server answering 503 and 429 each with and
//     without the header: both forms, in that order, for each.
const TAG = "(?: \\[footer read\\])?";
const FAILED_LOAD = new RegExp(`^Failed to load resource: (?:net::ERR_(?!BLOCKED_)[A-Z0-9_]+|the server responded with a status of (?:5\\d\\d|429)(?: \\([^()]*\\))?) \\((https?:\\/\\/[^\\s()]+)\\)${TAG}$`);
const FAILED_PREFLIGHT = new RegExp(`^Access to fetch at '(https?:\\/\\/[^'\\s]+)' from origin '[^'\\s]+' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: (?:It does not have HTTP ok status|No 'Access-Control-Allow-Origin' header is present on the requested resource)\\.(?: \\([^()]*\\))?${TAG}$`);
const FOOTER_TAGGED = / \[footer read\]$/;

/** The origin a failed-load line names, "" for any other line. */
const failedOrigin = (line) => originOf((FAILED_LOAD.exec(line) ?? FAILED_PREFLIGHT.exec(line))?.[1] ?? "") ?? "";

/** What the same load's DOM shows for one row: its data-status (ok, warn, danger, loading), or "not drawn". */
const shownRow = (verify, row) => (row === "code" || row === "funds" ? verify?.[row] : verify?.pools?.[row]) ?? "not drawn";

/** What the footer shows: the pair answered (data-conn "on") and a block drawn (data-block a height). */
const footerAnswered = (footer) => footer?.conn === "on" && /^\d+$/.test(footer?.block ?? "");

/** A load's console errors split: `kept` are the errors that fail it, `down` the release RPC origins that failed and the
 *  page shows (Unverified rows, or a footer that the other RPC answered), `refused` the failed loads of a release RPC
 *  the DOM does not show (each is also in `kept`, saying what the DOM shows). `verify` and `footer` are the same load's
 *  DOM (VERIFY_DOM, FOOTER_DOM). */
export function outages(lines, verify, network = "mainnet", footer = null) {
  const rows = rpcRows(network);
  const near = new Set((VERIFY_RELEASES[network]?.rpcs ?? []).map(originOf));
  const footerFailed = new Set(lines.filter((l) => FOOTER_TAGGED.test(l)).map(failedOrigin).filter((o) => near.has(o)));
  const pairDown = near.size > 0 && [...near].every((o) => footerFailed.has(o));
  const kept = [];
  const refused = [];
  const down = new Set();
  const refuse = (line, origin, why) => {
    refused.push(`${line} [${origin} is a release RPC, ${why}]`);
    kept.push(refused.at(-1));
  };
  for (const line of lines) {
    const origin = failedOrigin(line);
    const named = origin && rows.get(origin);
    if (!named) kept.push(line);
    else if (FOOTER_TAGGED.test(line) && near.has(origin)) {
      if (pairDown) refuse(line, origin, "a footer read, and both RPCs of the pair failed it");
      else if (!footerAnswered(footer)) refuse(line, origin, `a footer read, and the footer shows ${footer ? `${footer.conn ?? "no connection"}, block ${footer.block || "not drawn"}` : "not drawn"}, not the pair answered`);
      else down.add(origin);
    } else if (named.every((r) => shownRow(verify, r) === "warn")) down.add(origin);
    else refuse(line, origin, `not shown Unverified: ${named.map((r) => `${r} ${shownRow(verify, r)}`).join(", ")}`);
  }
  return { kept, down: [...down], refused };
}

/** The line a check ends a load's verdict with for the outages it let through, or "". */
export const downNote = (down) => (down.length ? `; RPC down, shown: ${down.map((o) => o.replace(/^https?:\/\//, "")).join(", ")}` : "");

// ------------------------------------------------------------------------------------------------ the evidence
/** Runs in the page: Verify's reads have ended (the panel is drawn, not loading, and its pools, when it draws them, are read). */
export const VERIFY_SETTLED = () => {
  const panel = document.querySelector(".vfy");
  const pools = document.querySelector(".vpools");
  return !!panel && panel.dataset.state !== "loading" && (!pools || pools.dataset.pools === "read");
};

/** Runs in the page: what the Verify panel shows, row by row (data-status: ok, warn, danger or loading); null with no panel. */
export const VERIFY_DOM = () => {
  const panel = document.querySelector(".vfy");
  if (!panel) return null;
  const status = (sel) => panel.querySelector(sel)?.dataset.status ?? null;
  const pools = {};
  for (const e of panel.querySelectorAll("[data-pool]")) pools[e.dataset.pool] = e.dataset.status;
  return { state: panel.dataset.state, code: status("[data-row=code]"), funds: status("[data-row=funds]"), pools };
};

/** Runs in the page: what the footer shows, its connection (data-conn: wait, on, off) and its block (data-block, "" with
 *  none); null with no footer. */
export const FOOTER_DOM = () => {
  const footer = document.querySelector(".ft");
  if (!footer) return null;
  return { conn: footer.querySelector(".health")?.dataset.conn ?? null, block: footer.querySelector("[data-block]")?.dataset.block ?? "" };
};

/** How long the panel's reads may take before the DOM is read as it stands (each read ends within the app's 10 s). */
export const VERIFY_SETTLE_MS = 20_000;

/** The Verify panel of this load, read from its DOM once its reads have ended: the evidence outages() judges a failed
 *  load of a release RPC by. A panel still loading when the wait ends is read as loading, which is no evidence. */
export async function verifyEvidence(doc) {
  await doc.waitForFunction(VERIFY_SETTLED, null, { timeout: VERIFY_SETTLE_MS }).catch(() => {});
  return doc.evaluate(VERIFY_DOM);
}

/** The footer of this load, read from its DOM (the phone draws none). */
export const footerEvidence = (doc) => doc.evaluate(FOOTER_DOM);
