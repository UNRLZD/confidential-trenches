/**
 * APP_HOST's deploy gate: refuses a build whose headers break the app's header policy (docs: the app paper, 2.3), or
 * whose pages load a script the policy would block (AX-11). It checks invariants and an allow-list per directive; it
 * does not hold a copy of the policy to compare against (the card's live checks do that on the served answer).
 * Every page of the build: each script and stylesheet tag (and each modulepreload or script/style preload) names a
 * file of the build and carries exactly one sha384 equal to that file's bytes, since Integrity-Policy
 * (blocked-destinations=(script)) blocks a script without one and the browser blocks one whose bytes differ; no inline
 * script, no CSP meta tag; index.html loads at least one script; and no .js file sits in the build unloaded by a tag
 * (a chunk fetched by import() carries no integrity, so Integrity-Policy would block it).
 *
 *   node apps/terminal/scripts/check-deploy.ts <buildDir>     exit 0 ok, 1 refused, 2 usage
 *
 * The build dir is what Cloudflare Pages serves: its _headers file sets every response's headers. Pages applies no
 * _headers rule to a response made by a Pages Function, so a build that carries _worker.js is refused too.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SIGN_HOST = "https://confidential.unrealized.trade";
export const HELPER_HOST = "ct-api.unrealized.trade";
export const RPCS = ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org", "https://near.drpc.org"];

const HELPER = [`https://${HELPER_HOST}`, `wss://${HELPER_HOST}`];

// every directive the policy may hold, and the sources each may list (a subset passes; anything else is refused)
const ALLOWED: Record<string, string[]> = {
  "default-src": ["'none'"],
  "script-src": ["'self'"],
  "style-src": ["'self'"],
  "img-src": ["'self'", "data:", HELPER[0]!],
  "font-src": ["'self'"],
  "connect-src": ["'self'", ...HELPER, SIGN_HOST, ...RPCS],
  "manifest-src": ["'self'"],
  "worker-src": ["'none'"],
  "frame-src": ["'none'"],
  "frame-ancestors": [SIGN_HOST],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "require-trusted-types-for": ["'script'"],
  "trusted-types": ["'none'"],
  "upgrade-insecure-requests": [],
};

// directives that must be present with exactly this value
const EXACT: Record<string, string> = {
  "default-src": "'none'",
  "script-src": "'self'",
  "worker-src": "'none'",
  // the terminal frames nothing and runs only inside SIGN_HOST's shell (src/shell/in-shell.ts)
  "frame-src": "'none'",
  "frame-ancestors": SIGN_HOST,
  "object-src": "'none'",
  "base-uri": "'none'",
  "form-action": "'none'",
  "require-trusted-types-for": "'script'",
  "trusted-types": "'none'",
};

// the other headers, each exactly this value (names lower case)
const HEADERS: Record<string, string> = {
  "integrity-policy": "blocked-destinations=(script)",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

// headers that must not be sent: COEP (the app needs no cross-origin isolation), a report-only policy, and
// X-Frame-Options (no value of it lets SIGN_HOST's shell frame the terminal; frame-ancestors says who may)
const ABSENT = ["cross-origin-embedder-policy", "content-security-policy-report-only", "x-frame-options"];

// Permissions-Policy: each feature exactly this; a feature not listed may only be ()
const PERMISSIONS: Record<string, string> = {
  accelerometer: "()",
  autoplay: "()",
  bluetooth: "()",
  camera: "()",
  "clipboard-read": "()",
  "clipboard-write": "(self)",
  "display-capture": "()",
  geolocation: "()",
  gyroscope: "()",
  hid: "()",
  magnetometer: "()",
  microphone: "()",
  midi: "()",
  payment: "()",
  "publickey-credentials-create": "()",
  "publickey-credentials-get": "()",
  serial: "()",
  usb: "()",
  "xr-spatial-tracking": "()",
};

/** The policy headers: the gate refuses one set, or removed, on any rule other than /*. */
export const POLICY_HEADERS = ["content-security-policy", "permissions-policy", ...Object.keys(HEADERS), ...ABSENT];

const ws = (s: string) => s.trim().replace(/\s+/g, " ");

/** Problems with one CSP string (empty = fine). */
export function checkCsp(csp: string): string[] {
  const p: string[] = [];
  if (csp.includes(",")) p.push("CSP holds more than one policy (a comma)");
  const d = new Map<string, string[]>();
  for (const part of csp.split(/[;,]/)) {
    const [name, ...v] = part.trim().split(/\s+/);
    if (!name) continue;
    const k = name.toLowerCase();
    if (d.has(k)) p.push(`CSP ${k} given twice (a browser reads only the first)`);
    else d.set(k, v);
  }
  for (const [k, want] of Object.entries(EXACT)) {
    const got = d.get(k);
    if (!got) p.push(`CSP ${k} missing (must be ${want})`);
    else if (got.join(" ") !== want) p.push(`CSP ${k} must be exactly ${want} (got ${got.join(" ") || "nothing"})`);
  }
  for (const [k, v] of d) {
    const allowed = ALLOWED[k];
    if (!allowed) {
      p.push(`CSP directive ${k} is not in the policy`);
      continue;
    }
    for (const src of v) {
      if (src.includes("*")) p.push(`CSP ${k} contains ${src}: a wildcard`);
      else if (/^'(unsafe-|wasm-unsafe-eval')/i.test(src)) p.push(`CSP ${k} contains ${src}`);
      else if (/^[a-z][a-z0-9+.-]*:$/i.test(src) && !allowed.includes(src)) p.push(`CSP ${k} contains ${src}: a bare scheme`);
      else if (!allowed.includes(src)) p.push(`CSP ${k}: ${src} is not allowed there`);
    }
  }
  return p;
}

/** Problems with one Permissions-Policy string (empty = fine). */
export function checkPermissions(pp: string): string[] {
  const p: string[] = [];
  const got = new Map<string, string>();
  for (const item of pp.split(",")) {
    const m = /^\s*([a-z0-9-]+)=(.*?)\s*$/i.exec(item);
    if (!m) {
      if (item.trim()) p.push(`Permissions-Policy: cannot read ${item.trim()}`);
      continue;
    }
    const k = m[1]!.toLowerCase();
    if (got.has(k)) p.push(`Permissions-Policy ${k} given twice`);
    got.set(k, ws(m[2]!));
  }
  for (const [k, want] of Object.entries(PERMISSIONS)) {
    const v = got.get(k);
    if (v === undefined) p.push(`Permissions-Policy ${k} missing (must be ${want})`);
    else if (v !== want) p.push(`Permissions-Policy ${k} must be ${want} (got ${v})`);
  }
  for (const [k, v] of got) if (!(k in PERMISSIONS) && v !== "()") p.push(`Permissions-Policy ${k} must be () (got ${v})`);
  return p;
}

/** Problems with a set of response headers (names in any case; empty = fine). */
export function checkHeaders(headers: Record<string, string>): string[] {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const p: string[] = [];
  const csp = h.get("content-security-policy");
  if (csp === undefined) p.push("Content-Security-Policy missing");
  else p.push(...checkCsp(csp));
  const pp = h.get("permissions-policy");
  if (pp === undefined) p.push("Permissions-Policy missing");
  else p.push(...checkPermissions(pp));
  for (const [k, want] of Object.entries(HEADERS)) {
    const v = h.get(k);
    if (v === undefined) p.push(`${k} missing (must be ${want})`);
    else if (ws(v) !== want) p.push(`${k} must be ${want} (got ${ws(v)})`);
  }
  for (const k of ABSENT) if (h.has(k)) p.push(`${k} must not be sent`);
  return p;
}

export interface Rule {
  path: string;
  headers: [string, string][];
  removes: string[];
}

/** Cloudflare Pages' _headers format: a URL line, then indented `name: value` lines or `! name` removals. */
export function parseHeadersFile(text: string): { rules: Rule[]; problems: string[] } {
  const rules: Rule[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.length > 2000) problems.push(`_headers line ${i + 1} is over Pages' 2,000 character limit`);
    if (!line.trim() || line.trim().startsWith("#")) return;
    if (!/^\s/.test(line)) {
      rules.push({ path: line.trim(), headers: [], removes: [] });
      return;
    }
    const rule = rules.at(-1);
    if (!rule) return void problems.push(`_headers line ${i + 1} is a header before any URL line`);
    const rm = /^\s+!\s*(\S+)\s*$/.exec(line);
    const kv = /^\s+([^:\s]+):\s*(.*)$/.exec(line);
    if (rm) rule.removes.push(rm[1]!.toLowerCase());
    else if (kv) rule.headers.push([kv[1]!, kv[2]!]);
    else problems.push(`_headers line ${i + 1} cannot be read`);
  });
  if (rules.length > 100) problems.push(`_headers has ${rules.length} rules, over Pages' 100`);
  return { rules, problems };
}

/** Problems with a _headers file's text (empty = fine). */
export function checkHeadersFile(text: string): string[] {
  const { rules, problems: p } = parseHeadersFile(text);
  const all = rules.filter((r) => r.path === "/*");
  if (all.length !== 1) p.push(`_headers must hold exactly one /* rule (has ${all.length})`);
  for (const r of rules) {
    for (const [k] of r.headers)
      if (r.path !== "/*" && POLICY_HEADERS.includes(k.toLowerCase())) p.push(`_headers rule ${r.path} sets ${k}: the policy is set on /* only`);
    for (const k of r.removes) if (POLICY_HEADERS.includes(k)) p.push(`_headers rule ${r.path} removes ${k}`);
  }
  if (all.length !== 1) return p;
  const seen = new Map<string, string>();
  for (const [k, v] of all[0]!.headers) {
    const lk = k.toLowerCase();
    if (seen.has(lk)) p.push(`_headers /* sets ${k} twice (Pages joins the two with a comma)`);
    else seen.set(lk, v);
  }
  return [...p, ...checkHeaders(Object.fromEntries(seen))];
}

export const sha384 = (bytes: Uint8Array) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

/** Every `<name ...>` start tag of `html` (any case), as its attributes: names lower case, values as written. */
export function tagsOf(html: string, name: string): Map<string, string>[] {
  const out: Map<string, string>[] = [];
  for (const m of html.matchAll(new RegExp(`<${name}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>`, "gi"))) {
    const attrs = new Map<string, string>();
    for (const a of m[1]!.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
      if (!attrs.has(a[1]!.toLowerCase())) attrs.set(a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
    out.push(attrs);
  }
  return out;
}

/** The build's files, as paths relative to it with / between parts. */
function filesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(relative(dir, f).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Problems with the build's pages: every script and stylesheet a page loads carries its file's sha384 (empty = fine). */
export function checkPages(buildDir: string): string[] {
  const dir = resolve(buildDir);
  const p: string[] = [];
  const files = filesOf(dir);
  const loaded = new Set<string>();
  const BASE = "https://build.invalid";
  for (const page of files.filter((f) => f.endsWith(".html"))) {
    const html = readFileSync(join(dir, page), "utf8");
    const check = (what: string, url: string | undefined, integrity: string | undefined) => {
      if (url === undefined || url === "") return void p.push(`${page}: a ${what} tag with no ${what === "script" ? "src" : "href"}`);
      let u: URL;
      let rel = "";
      try {
        u = new URL(url, `${BASE}/${page}`);
        rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
      } catch {
        return void p.push(`${page}: ${what} ${url}: not a URL`);
      }
      if (u.origin !== BASE) return void p.push(`${page}: ${what} ${url} is not a file of this build (script-src and style-src are 'self')`);
      const file = join(dir, rel);
      if (!rel || !file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) return void p.push(`${page}: ${what} ${url}: no such file in the build`);
      loaded.add(rel);
      if (integrity === undefined) return void p.push(`${page}: ${what} ${url} has no integrity (Integrity-Policy blocks it)`);
      const want = integrity.trim().split(/\s+/).filter(Boolean);
      if (want.length !== 1 || !/^sha384-[A-Za-z0-9+/]{64}$/.test(want[0]!))
        return void p.push(`${page}: ${what} ${url}: integrity must be exactly one sha384 (got ${integrity.trim() || "nothing"})`);
      const got = sha384(readFileSync(file));
      if (got !== want[0]) p.push(`${page}: ${what} ${url}: integrity ${want[0]} is not the sha384 of its file (${got})`);
    };
    const scripts = tagsOf(html, "script");
    if (page === "index.html" && scripts.length === 0) p.push("index.html loads no script");
    for (const s of scripts) {
      if (!s.has("src")) p.push(`${page}: an inline script (script-src 'self' and Integrity-Policy block it)`);
      else check("script", s.get("src"), s.get("integrity"));
    }
    for (const l of tagsOf(html, "link")) {
      const rel = (l.get("rel") ?? "").toLowerCase().split(/\s+/);
      const as = (l.get("as") ?? "").toLowerCase();
      if (rel.includes("stylesheet")) check("stylesheet", l.get("href"), l.get("integrity"));
      else if (rel.includes("modulepreload")) check("modulepreload", l.get("href"), l.get("integrity"));
      else if (rel.includes("preload") && (as === "script" || as === "style")) check(`${as} preload`, l.get("href"), l.get("integrity"));
    }
    for (const m of tagsOf(html, "meta"))
      if ((m.get("http-equiv") ?? "").toLowerCase().startsWith("content-security-policy")) p.push(`${page}: a CSP meta tag (the policy is the _headers one only)`);
  }
  for (const f of files)
    if (/\.m?js$/.test(f) && f !== "_worker.js" && !loaded.has(f))
      p.push(`${f} is in the build but no page loads it with its integrity (Integrity-Policy blocks a script loaded any other way)`);
  return p;
}

/** Problems with a build dir (empty = fine). */
export function checkDir(dir: string): string[] {
  const p: string[] = [];
  const f = join(dir, "_headers");
  if (!existsSync(join(dir, "index.html"))) p.push(`${dir} has no index.html`);
  if (existsSync(join(dir, "_worker.js"))) p.push(`${dir} carries _worker.js: Pages applies no _headers rule to a Function's response`);
  p.push(...checkPages(dir));
  if (!existsSync(f)) return [...p, `${dir} has no _headers file`];
  return [...p, ...checkHeadersFile(readFileSync(f, "utf8"))];
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir || process.argv.length > 3) {
    console.error("check-deploy: usage: node apps/terminal/scripts/check-deploy.ts <buildDir>");
    process.exit(2);
  }
  const p = checkDir(dir);
  for (const x of p) console.error(`check-deploy: REFUSED ${x}`);
  if (p.length) process.exit(1);
  console.log(`check-deploy: ok ${dir}: the header policy holds and every script and stylesheet carries its sha384`);
}
