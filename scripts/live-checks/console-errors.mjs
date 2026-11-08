// The one console collector every live check that listens to a page's console writes through (card live-console-url):
// a console message kept as its text and the address it names (m.location().url, the resource that failed to load or
// the script that logged it), so a BAD line for "Failed to load resource: ... 429 ()" names its host in one read.
// The address is written as its origin and path only: the query and the fragment never reach a line, a record or a log.
// A message with no address is kept as its text alone, and it still fails the check that reads it. An address inside the
// text is cut the same way. A page error (an uncaught exception, from any frame of the page) is kept the same way, named
// by the address of its stack's top frame (card live-pageerror-hooks); watchErrors() hooks both on a page.
// Not a check of its own; scripts/live-checks/console-errors.test.mjs holds it.
// Runs: once, no check of its own: the console collector the browser checks share (console-errors.test.mjs holds it)

/** The address a console line names: origin and path for http(s) and ws(s), the scheme (and a blob's origin) for any
 *  other, "" for none or one that does not parse. */
export function resourceOf(url) {
  if (typeof url !== "string" || url === "") return "";
  let u;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return `${u.origin}${u.pathname}`;
  return u.origin === "null" ? u.protocol : `${u.protocol}${u.origin}`;
}

// an http(s) or ws(s) address written inside a line's text
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'`()<>]+/g;

// The one query a line keeps: the footer's block read marks its own request ?ct=footer (apps/terminal/src/shell/footer.ts
// FOOTER_QUERY), so a failed one is told from Verify's reads of the same RPC (card app-shell-rpc-outage-judge). A line
// whose address, or an address in its text, carries that param ends " [footer read]"; no other query reaches a line.
const FOOTER_QUERY = /[?&]ct=footer(?![\w%.-])/;
export const FOOTER_READ = " [footer read]";

/** One kept line: the text, any address in it cut to origin and path, then the address in brackets when there is one,
 *  and the footer read's tag when the failed request was the footer's. */
export function consoleLine(text, url) {
  const at = resourceOf(url);
  const said = String(text).replace(URL_IN_TEXT, (u) => resourceOf(u) || u.split(/[?#]/)[0]);
  const line = at === "" ? said : `${said} (${at})`;
  return FOOTER_QUERY.test(String(url ?? "")) || FOOTER_QUERY.test(String(text)) ? `${line}${FOOTER_READ}` : line;
}

/** A Playwright ConsoleMessage as a kept line. */
export function consoleError(m) {
  return consoleLine(m.text(), m.location()?.url ?? "");
}

/** The address of a page error's top stack frame ("    at fn (url:line:col)" or "    at url:line:col"), "" for none. */
export function pageErrorUrl(e) {
  const top = String(e?.stack ?? "").split("\n").find((l) => /^\s+at /.test(l));
  const m = top && /^\s+at (?:[^(]*\()?(.+?):\d+:\d+\)?\s*$/.exec(top);
  return m ? m[1] : "";
}

/** A Playwright page error (the Error of page.on("pageerror")) as a kept line. */
export function pageError(e) {
  return consoleLine(`pageerror ${String(e)}`, pageErrorUrl(e));
}

/** Hooks a page's console errors and its page errors into `errors`, each as a kept line. `keep(url)` picks the ones of
 *  the frame the check watches by their address; one with no address is always kept, since Playwright names no frame
 *  for a console message or a page error (1.63: ConsoleMessage has location(), page() and worker(), a page error is
 *  an Error), and an error nobody can place must fail the check rather than pass it. */
export function watchErrors(page, errors, keep = () => true) {
  const kept = (url) => resourceOf(url) === "" || keep(url);
  page.on("console", (m) => m.type() === "error" && kept(m.location()?.url ?? "") && errors.push(consoleError(m)));
  page.on("pageerror", (e) => kept(pageErrorUrl(e)) && errors.push(pageError(e)));
}
