#!/usr/bin/env node
// Checks from outside that SIGN_HOST and APP_HOST serve exactly a release's files (wallet.md §2.7 item 4, W:868-871;
// E2E-22). It reads both hosts over HTTPS and trusts nothing they say about themselves: the release list
// (packages/signpage/releases/release-<N>.json, made by release-list.mjs from the tagged commit's own builds) is the
// only reference. For each host it GETs:
//   - every listed file twice, as a navigation and as a plain fetch (a host could answer the two differently): each
//     answer must be 200 with exactly the listed size and sha256, and each header the release's _headers rules give
//     that path must be served with exactly the listed value;
//   - /.well-known/webauthn and a path no release names: each must answer 404, or the release's own fallback page
//     (Pages answers an unknown path with /, byte for byte, under /'s headers); anything else is a file the release
//     does not name, and a webauthn file would let another origin use the host's passkeys;
//   - and in every page it reads, each script, worker preload, module preload and stylesheet must be a listed file of
//     that host; one that is not is a script the release does not name.
// It prints one line per read and MATCH only when every line is ok.
//   node packages/signpage/scripts/check-signpage.mjs [--release release-<N>] [--list <file>] [--record <file>]
//   node packages/signpage/scripts/check-signpage.mjs [--release ... | --list ...] --answer <file>
//     MATCH exit 0, no match exit 1, error exit 2. The newest release by default. --record writes what the run read
//     (sizes, hashes and the listed headers per path and mode, no bodies); --answer judges such a record instead of
//     reading the hosts, against the release it names unless --list or --release is given.
import "../../../scripts/net-window.mjs";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readList } from "./release-list.mjs";

/** The two ways a file is asked for: as a navigation, and as a plain fetch() from a page (mode cors, destination empty). */
export const MODES = Object.freeze({
  navigate: { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none", "upgrade-insecure-requests": "1" },
  fetch: { accept: "*/*", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin" },
});
export const WEBAUTHN = "/.well-known/webauthn";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** What a page loads as a script, worker, preload or stylesheet: every script src and link href with such a rel. */
export function namesOf(html) {
  const out = [];
  for (const m of html.matchAll(/<(script|link)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attrs = new Map();
    for (const a of m[2].matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
      if (!attrs.has(a[1].toLowerCase())) attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
    if (m[1].toLowerCase() === "script") out.push(attrs.has("src") ? attrs.get("src") : "(inline)");
    else if ((attrs.get("rel") ?? "").toLowerCase().split(/\s+/).some((r) => ["stylesheet", "preload", "modulepreload", "prefetch"].includes(r))) out.push(attrs.get("href") ?? "");
  }
  return out;
}

/** Reads one host: every listed file in both modes, and the probes. fetchFn is fetch, or a test's stand-in. */
async function readHost(host, fetchFn, probes) {
  const names = [...new Set(host.files.flatMap((f) => Object.keys(f.headers)))].sort();
  const get = async (path, mode) => {
    const r = await fetchFn(new URL(path, host.origin).href, { redirect: "manual", cache: "no-store", headers: { ...MODES[mode], "cache-control": "no-cache" } });
    const bytes = Buffer.from(await r.arrayBuffer());
    const headers = {};
    for (const n of names) if (r.headers.get(n) !== null) headers[n] = r.headers.get(n);
    const out = { status: r.status, bytes: bytes.length, sha256: sha256(bytes), headers };
    if (/^text\/html\b/i.test(r.headers.get("content-type") ?? "")) out.names = namesOf(bytes.toString("utf8"));
    return out;
  };
  const files = {};
  for (const f of host.files) files[f.path] = { navigate: await get(f.path, "navigate"), fetch: await get(f.path, "fetch") };
  const probed = {};
  for (const p of probes) probed[p] = { navigate: await get(p, "navigate"), fetch: await get(p, "fetch") };
  return { origin: host.origin, files, probes: probed };
}

/** Reads both hosts of `list`: { release, hosts: { [name]: { origin, files, probes } } }. */
export async function read(list, fetchFn = fetch, probe = `/release-check-${randomBytes(8).toString("hex")}`) {
  const hosts = {};
  for (const [name, host] of Object.entries(list.hosts)) hosts[name] = await readHost(host, fetchFn, [WEBAUTHN, probe]);
  return { release: list.release, hosts };
}

/** The check of one answer against the list: { ok, lines }, the last line MATCH or NO MATCH. */
export function judge(list, answer) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  // one answer against one listed file: [problems]
  const against = (want, got) => {
    const p = [];
    if (got.status !== 200) return [`answers ${got.status}, want 200`];
    if (got.bytes !== want.bytes || got.sha256 !== want.sha256) p.push(`${got.bytes} B sha256 ${got.sha256}, the release's ${want.bytes} B ${want.sha256}`);
    for (const [k, v] of Object.entries(want.headers)) {
      const g = got.headers?.[k];
      if (g === undefined) p.push(`${k} none, the release's ${JSON.stringify(v)}`);
      else if (g.trim() !== v) p.push(`${k} ${JSON.stringify(g)}, the release's ${JSON.stringify(v)}`);
    }
    return p;
  };
  for (const [name, host] of Object.entries(list.hosts)) {
    const a = answer.hosts?.[name];
    if (!a || a.origin !== host.origin) {
      say(false, `${name} ${host.origin}: not read`);
      continue;
    }
    const listed = new Map(host.files.map((f) => [f.path, f]));
    const pages = [];
    for (const f of host.files) {
      for (const mode of Object.keys(MODES)) {
        const got = a.files?.[f.path]?.[mode];
        if (!got) {
          say(false, `${name} ${f.path} (${mode}): not read`);
          continue;
        }
        const p = against(f, got);
        say(!p.length, `${name} ${f.path} (${mode}): ${p.length ? p.join("; ") : `${f.bytes} B sha256 ${f.sha256}, ${Object.keys(f.headers).length} headers as the release's`}`);
        if (got.names) pages.push([f.path, mode, got.names]);
      }
    }
    const fallback = listed.get("/");
    for (const [path, modes] of Object.entries(a.probes ?? {})) {
      for (const mode of Object.keys(MODES)) {
        const got = modes[mode];
        if (!got) {
          say(false, `${name} ${path} (${mode}): not read`);
          continue;
        }
        if (got.names) pages.push([path, mode, got.names]);
        if (got.status === 404) {
          say(true, `${name} ${path} (${mode}): 404`);
          continue;
        }
        const p = fallback ? against(fallback, got) : ["no fallback page listed"];
        say(!p.length, `${name} ${path} (${mode}): ${p.length ? `${got.status}, ${got.bytes} B sha256 ${got.sha256}: a file the release does not name (${p.join("; ")})` : "the release's fallback page /"}`);
      }
    }
    if (![WEBAUTHN].every((w) => a.probes?.[w])) say(false, `${name} ${WEBAUTHN}: not read`);
    if (Object.keys(a.probes ?? {}).length < 2) say(false, `${name}: no unlisted path was read`);
    for (const [page, mode, names] of pages) {
      for (const src of names) {
        let u = null;
        try {
          u = new URL(src, new URL(page, host.origin));
        } catch {}
        const path = u?.origin === host.origin ? u.pathname : null;
        if (path === null || !listed.has(path)) say(false, `${name} ${page} (${mode}) loads ${src}, which the release does not name`);
      }
    }
  }
  const bad = lines.filter((l) => l.startsWith("BAD")).length;
  lines.push(bad ? `NO MATCH ${list.release}: ${bad} line(s) differ` : `MATCH ${list.release}`);
  return { ok: bad === 0, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  try {
    const recorded = opt("--answer") ? JSON.parse(readFileSync(opt("--answer"), "utf8")) : null;
    const list = opt("--list") ? JSON.parse(readFileSync(opt("--list"), "utf8")) : readList(opt("--release") ?? recorded?.release);
    const answer = recorded ?? { ...(await read(list)), read_at: new Date().toISOString() };
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(list, answer);
    for (const l of lines) console.log(l);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`check-signpage: ERROR: ${e.message}`);
    process.exit(2);
  }
}
