// The unplug drill's network guard (card vault-drill-script): every server of ours off, made true inside the process it
// is loaded into, and every request it makes written down.
//   node --import ./scripts/drill/net-guard.mjs <script>      DRILL_HOSTS=<file> names where each request is appended
// It wraps the process's ways out: globalThis.fetch (undici, which the exit tool and the kit read through), and
// node:http and node:https request() and get(). Each request appends one JSON line { url, ours } to DRILL_HOSTS before
// anything leaves; a request to a host of ours is refused there, so it never leaves (a thrown error, as an unplugged
// server answers nothing).
// Ours: any host under our domain, unrealized.trade, the same rule as scripts/ci/exit-no-server.mjs (the helper
// ct-api., APP_HOST ct-app., SIGN_HOST confidential.), with no exception: the setup files' mirror on SIGN_HOST
// (exit-no-server's MIRROR), which the exit tool reads only when the pinned commit on GitHub fails, is off too, so a
// run that needs it does not pass the drill.
import "../net-window.mjs";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

export const OUR_DOMAINS = Object.freeze(["unrealized.trade"]);

/** The host of a request's target (a URL, a string, a Request or http's options), lowercased, or "" when none is read. */
export function hostOf(target) {
  try {
    if (typeof target === "string" || target instanceof URL) return new URL(String(target)).hostname.toLowerCase();
    if (target && typeof target.url === "string") return new URL(target.url).hostname.toLowerCase();
    if (target && typeof target === "object") return String(target.hostname ?? target.host ?? "").replace(/:\d+$/, "").toLowerCase();
  } catch {}
  return "";
}

/** Whether a host is one of ours: our domain or any name under it, in any case, a trailing dot read away. */
export function ourHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  return OUR_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** What a target names, for the log: its URL with no query or fragment (a query may carry a key: never written). */
function shown(target) {
  try {
    const u = typeof target === "string" || target instanceof URL ? new URL(String(target)) : target && typeof target.url === "string" ? new URL(target.url) : null;
    if (u) return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {}
  return `//${hostOf(target)}`;
}

export function installGuard(logFile) {
  const note = (target) => {
    const host = hostOf(target);
    const ours = host === "" || ourHost(host);
    appendFileSync(logFile, `${JSON.stringify({ url: shown(target), ours })}\n`);
    // a request whose host cannot be read is refused as ours: the drill cannot say where it would go
    if (ours) throw new Error(`unplug drill: a request to ${host || "an unread host"} is refused: every server of ours is off`);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    try {
      note(input);
    } catch (e) {
      return Promise.reject(e);
    }
    return realFetch.call(this, input, init);
  };
  for (const mod of [http, https]) {
    for (const name of ["request", "get"]) {
      const real = mod[name];
      mod[name] = function guarded(target, ...rest) {
        note(target);
        return real.call(this, target, ...rest);
      };
    }
  }
}

if (process.env.DRILL_HOSTS) installGuard(process.env.DRILL_HOSTS);
