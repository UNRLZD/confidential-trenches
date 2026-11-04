// The one console collector every live check that listens to a page's console writes through (card live-console-url):
// a console message kept as its text and the address it names (m.location().url, the resource that failed to load or
// the script that logged it), so a BAD line for "Failed to load resource: ... 429 ()" names its host in one read.
// The address is written as its origin and path only: the query and the fragment never reach a line, a record or a log.
// A message with no address is kept as its text alone, and it still fails the check that reads it.
// Not a check of its own; scripts/live-checks/console-errors.test.mjs holds it.

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

/** One kept line: the text, then the address in brackets when there is one. */
export function consoleLine(text, url) {
  const at = resourceOf(url);
  return at === "" ? String(text) : `${text} (${at})`;
}

/** A Playwright ConsoleMessage as a kept line. */
export function consoleError(m) {
  return consoleLine(m.text(), m.location()?.url ?? "");
}
