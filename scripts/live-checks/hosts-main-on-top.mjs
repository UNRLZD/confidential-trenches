#!/usr/bin/env node
// Live check of card hosts-main-on-top: the main address is the signing page's, and nothing else lives under it.
// SIGN_HOST, confidential.unrealized.trade, is the passkey's rp.id; WebAuthn takes an rp.id that is a registrable domain
// suffix of the calling page's domain, so a page on any child host could run the PRF ceremony on it and get the seed
// (packages/wallet/src/signin/passkey.ts). This check reads DNS over HTTPS from two resolvers run by two operators
// (Cloudflare's and Google's JSON APIs), which must agree, and checks:
//   - SIGN_HOST answers, by a CNAME to the signing page's Pages project (confidential-trenches-sign.pages.dev) and on
//     to A records;
//   - no name under SIGN_HOST answers: api., app., sign. (the old helper's and signing page's names) and a random label
//     each answer NXDOMAIN (status 3), so there is no child record of any type and no wildcard;
//   - nor does any name under SIGN_HOST the certificate transparency logs hold: WebAuthn runs only on https, so a child
//     that could claim SIGN_HOST's passkeys has a certificate in them. Two sources are read (crt.sh's JSON and
//     certspotter's issuances, every page), at least one must answer, and a source that does not is said so on its
//     line; every name found must be NXDOMAIN on both resolvers now. The old sign. and api. are in the logs and are the
//     fixed labels' own lines, which fail until their records are deleted (the switch's last DNS step);
//   - APP_HOST, ct-app.unrealized.trade, answers by a CNAME to the terminal's Pages project
//     (confidential-trenches-app.pages.dev), and HELPER_HOST, ct-api.unrealized.trade, answers the helper server's
//     primary IP (apps/helper/deploy/create-server.mjs PRIMARY_IP): siblings, which cannot claim SIGN_HOST. No line
//     prints an address: an A answer is shown as a count.
// And it reads the hosts over HTTPS:
//   - the signing page's origin: SIGN_HOST's / is the signing page, its index pinning /app.js by sha384 and SIGN_HOST
//     serving that very /app.js;
//   - the rp.id: the one bare host name that bundle holds is SIGN_HOST (packages/wallet/src/signin/passkey.ts passes it
//     as rp.id to create and get, and runs only where the page's hostname is SIGN_HOST), and every origin it names is
//     SIGN_HOST's, APP_HOST's or HELPER_HOST's (the ceremony itself is wallet-passkey-prf's, after every sign deploy);
//   - both CSPs: SIGN_HOST's frame-ancestors 'none' and frame-src APP_HOST alone (the shell frames the terminal),
//     APP_HOST's frame-ancestors SIGN_HOST alone and frame-src 'none'; each connect-src names HELPER_HOST (and
//     APP_HOST's SIGN_HOST and wss HELPER_HOST), and no source in either names a child of SIGN_HOST;
//   - /.well-known/webauthn on SIGN_HOST is refused: 404, or Pages' fallback page (byte for byte SIGN_HOST's /), never
//     a file that could let another origin use SIGN_HOST's passkeys;
//   - the helper at HELPER_HOST echoes each of SIGN_HOST's and APP_HOST's origins (its CORS, the kit's HELPER_CORS), and
//     echoes neither the retired sign.'s origin nor another site's (REFUSED_ORIGINS): it answers them with no
//     access-control-allow-origin;
//   - the two retired children, sign. and api., give no answer at all;
//   - no certificate for a child of SIGN_HOST is still good: every unexpired one certspotter lists is revoked
//     (certspotter's revoked, read from the CA's revocation lists), but sign.'s Google Trust Services certificates
//     (CERTS_ALLOWED), whose keys Cloudflare holds, and Cloudflare serves SIGN_HOST itself. A child's certificate whose
//     key someone kept would let a page on that child, on a network that steers its lookup, run SIGN_HOST's passkeys.
//     certspotter alone gives revocation, so the line fails when it is unread.
// The tree holds no child either: scripts/ci/host-children.mjs, in test:gates.
//   node scripts/live-checks/hosts-main-on-top.mjs [--record <file>]     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every answer the run read to <file>, so the check's test can replay it.
import "../net-window.mjs";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const KEY = "hosts-main-on-top";
export const SIGN_HOST = "confidential.unrealized.trade";
export const APP_HOST = "ct-app.unrealized.trade";
export const HELPER_HOST = "ct-api.unrealized.trade";
// the Pages projects' own names (packages/signpage/scripts/deploy.mjs and apps/terminal/scripts/deploy.mjs PROJECT;
// the check's test holds them equal)
export const SIGN_TARGET = "confidential-trenches-sign.pages.dev";
export const APP_TARGET = "confidential-trenches-app.pages.dev";
// ct-helper's primary IPv4 (apps/helper/deploy/create-server.mjs PRIMARY_IP; the check's test holds them equal)
export const HELPER_IP = "91.99.5.177";
export const SIGN_ORIGIN = `https://${SIGN_HOST}`;
export const APP_ORIGIN = `https://${APP_HOST}`;
export const HELPER_ORIGIN = `https://${HELPER_HOST}`;
export const WEBAUTHN = "/.well-known/webauthn";
/** Origins the helper must not echo: the retired signing page's, and another site's. */
export const REFUSED_ORIGINS = [`https://sign.${SIGN_HOST}`, "https://evil.example"];
/** Child certificates that may stay good, each with its reason. */
export const CERTS_ALLOWED = [
  { names: [`sign.${SIGN_HOST}`], issuer: "Google Trust Services", why: "Pages' certificate for the old sign.: Cloudflare holds its key, and Cloudflare serves SIGN_HOST itself" },
];
/** The child labels read, a random one last (a wildcard answers it). */
export const LABELS = ["api", "app", "sign"];
/** The children the switch retired: the old helper's and signing page's names, each read over HTTPS for no answer. */
export const RETIRED = ["api", "sign"].map((l) => `${l}.${SIGN_HOST}`);
export const RESOLVERS = [
  { name: "cloudflare", url: (n) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=A`, headers: { accept: "application/dns-json" } },
  { name: "google", url: (n) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=A`, headers: {} },
];
// The CT log sources: each url(after) is a page (after: the last id read, or null for the first), names(json) its names,
// next(json) the next page's after, or null when there is none. A source answers a whole list only when it names its
// canary, a name with a certificate logged for good: crt.sh keeps expired certificates (it has an exclude=expired
// option, off here), so the old sign.'s (certspotter issuance 18096830193, 2026-10-31) stays in it; certspotter's list
// holds SIGN_HOST itself, whose certificate Pages keeps renewing. crt.sh answered [] for the name and for SIGN_HOST
// alone on 2026-11-07 while certspotter named three children, so an answer without its canary is unread.
export const CT_SOURCES = [
  {
    name: "crt.sh",
    canary: `sign.${SIGN_HOST}`,
    url: () => `https://crt.sh/?q=${encodeURIComponent(`%.${SIGN_HOST}`)}&output=json`,
    names: (j) => j.flatMap((c) => [c?.common_name, ...String(c?.name_value ?? "").split("\n")]),
    next: () => null,
  },
  {
    name: "certspotter",
    canary: SIGN_HOST,
    url: (after) => `https://api.certspotter.com/v1/issuances?domain=${SIGN_HOST}&include_subdomains=true&expand=dns_names&expand=issuer&expand=revocation${after ? `&after=${after}` : ""}`,
    names: (j) => j.flatMap((c) => (Array.isArray(c?.dns_names) ? c.dns_names : [])),
    next: (j) => (j.length ? String(j.at(-1).id) : null),
  },
];
// past this many pages a source counts as unread: its list may go on
export const CT_PAGES_MAX = 20;
const TIMEOUT_MS = 10_000;
const A = 1;
const CNAME = 5;
const NOERROR = 0;
const NXDOMAIN = 3;

const bare = (n) => String(n ?? "").toLowerCase().replace(/\.$/, "");

/** One name's answer from one resolver: { status, cnames, as } or { error }. */
export function parse(body) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return { error: "not JSON" };
  }
  if (!j || typeof j.Status !== "number") return { error: "no Status" };
  const ans = Array.isArray(j.Answer) ? j.Answer : [];
  return {
    status: j.Status,
    cnames: ans.filter((r) => r.type === CNAME).map((r) => bare(r.data)),
    as: ans.filter((r) => r.type === A).map((r) => String(r.data)),
  };
}

/** The fixed names: SIGN_HOST, the child labels and the random one, the siblings. */
const fixed = (label) => [SIGN_HOST, ...[...LABELS, label].map((l) => `${l}.${SIGN_HOST}`), APP_HOST, HELPER_HOST];

/** One CT source's pages as read: { source, pages: [{ url, status, body } | { url, error }] }. */
async function readCt(src, fetchFn) {
  const pages = [];
  let after = null;
  for (let i = 0; i < CT_PAGES_MAX; i++) {
    const url = src.url(after);
    try {
      const res = await fetchFn(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS * 3) });
      pages.push({ url, status: res.status, body: await res.text() });
    } catch (e) {
      pages.push({ url, error: String(e?.cause?.code ?? e?.name ?? e?.message) });
      break;
    }
    const got = ctPage(src, pages.at(-1));
    if (got.error || !(after = src.next(got.json))) break;
  }
  return { source: src.name, pages };
}

/** One page: { json } or { error }. */
function ctPage(src, p) {
  if (p.error) return { error: p.error };
  if (p.status !== 200) return { error: `HTTP ${p.status}` };
  let json;
  try {
    json = JSON.parse(p.body);
  } catch {
    return { error: "not JSON" };
  }
  return Array.isArray(json) ? { json } : { error: "not a list" };
}

/** A source's names under SIGN_HOST, lowercased and sorted: { names } or { error }. */
export function ctNames(rec, name) {
  const src = CT_SOURCES.find((s) => s.name === name);
  const read = rec.ct?.find((c) => c.source === name);
  if (!src || !read?.pages?.length) return { error: "not read" };
  const all = new Set();
  for (const [i, p] of read.pages.entries()) {
    const got = ctPage(src, p);
    if (got.error) return { error: got.error };
    for (const n of src.names(got.json)) all.add(bare(String(n ?? "").trim()));
    if (i === read.pages.length - 1 && src.next(got.json)) return { error: `more than ${CT_PAGES_MAX} pages` };
  }
  if (!all.has(src.canary)) return { error: `the list does not name ${src.canary}, whose certificate is logged, so it is not whole` };
  return { names: [...all].filter((n) => n.endsWith(`.${SIGN_HOST}`)).sort() };
}

/** certspotter's unexpired certificates naming a child of SIGN_HOST that are neither revoked nor allowed:
 *  { bad: [line], count } or { error }. `now` is the run's time. */
export function ctCerts(rec, now) {
  const src = CT_SOURCES.find((s) => s.name === "certspotter");
  const read = rec.ct?.find((c) => c.source === "certspotter");
  if (!ctNames(rec, "certspotter").names) return { error: ctNames(rec, "certspotter").error };
  const out = [];
  let count = 0;
  for (const p of read.pages) {
    for (const c of ctPage(src, p).json) {
      const names = (Array.isArray(c?.dns_names) ? c.dns_names : []).map(bare);
      const kids = names.filter((n) => n.endsWith(`.${SIGN_HOST}`));
      if (!kids.length || !(Date.parse(c.not_after) > now)) continue;
      count++;
      const issuer = String(c.issuer?.friendly_name ?? c.issuer?.name ?? "");
      if (c.revoked === true) continue;
      if (CERTS_ALLOWED.some((a) => kids.every((n) => a.names.includes(n)) && names.every((n) => n === SIGN_HOST || a.names.includes(n)) && issuer.includes(a.issuer))) continue;
      out.push(`${c.id} for ${kids.join(", ")} (${issuer || "issuer unread"}, to ${c.not_after}) ${c.revoked === false ? "is not revoked" : "has no revocation read"}`);
    }
  }
  return { bad: out, count };
}

const sha = (alg, text, enc) => createHash(alg).update(text).digest(enc);
// a host name in a bundle: in an https or wss origin, or bare in a string (the quote before it)
const HOSTS_IN = /(?:https?|wss):\/\/[a-z0-9*.-]*unrealized\.trade(?![a-z0-9-])|(?<=["'\x60])[a-z0-9*.-]*unrealized\.trade(?![a-z0-9-])/gi;
/** Every unrealized.trade origin and bare host name in a text, lowercased, sorted, once each. */
export const hostsIn = (text) => [...new Set((String(text).match(HOSTS_IN) ?? []).map((h) => h.toLowerCase()))].sort();

/** One HTTPS read: { url, status, csp, acao, body } or { url, error }. */
async function get(fetchFn, url, headers = {}) {
  try {
    const res = await fetchFn(url, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { url, status: res.status, csp: res.headers.get("content-security-policy"), acao: res.headers.get("access-control-allow-origin"), body: await res.text() };
  } catch (e) {
    return { url, error: String(e?.cause?.code ?? e?.name ?? e?.message) };
  }
}
const kept = ({ body, ...r }) => r;

/** The hosts over HTTPS. Small bodies are kept whole; of the bundle and the webauthn path, what is judged. */
export async function readHttp(fetchFn = fetch) {
  const index = await get(fetchFn, `${SIGN_ORIGIN}/`);
  const bundle = await get(fetchFn, `${SIGN_ORIGIN}/app.js`);
  const webauthn = await get(fetchFn, `${SIGN_ORIGIN}${WEBAUTHN}`);
  const app = await get(fetchFn, `${APP_ORIGIN}/`);
  const helperSign = await get(fetchFn, `${HELPER_ORIGIN}/v1/health`, { origin: SIGN_ORIGIN });
  const helperApp = await get(fetchFn, `${HELPER_ORIGIN}/v1/health`, { origin: APP_ORIGIN });
  const refused = [];
  for (const origin of REFUSED_ORIGINS) refused.push({ origin, ...kept(await get(fetchFn, `${HELPER_ORIGIN}/v1/health`, { origin })) });
  const retired = [];
  for (const n of RETIRED) retired.push(kept(await get(fetchFn, `https://${n}/`)));
  const digest = (r) => (r.error ? kept(r) : { ...kept(r), sha256: sha("sha256", r.body, "hex") });
  return {
    sign_index: index.error ? index : { ...index, sha256: sha("sha256", index.body, "hex") },
    sign_bundle: bundle.error ? bundle : { ...kept(bundle), sha384: `sha384-${sha("sha384", bundle.body, "base64")}`, hosts: hostsIn(bundle.body) },
    webauthn: digest(webauthn),
    app_index: kept(app),
    helper_sign: kept(helperSign),
    helper_app: kept(helperApp),
    helper_refused: refused,
    retired,
  };
}

/** A CSP's directives: { name: [sources] }. */
export function directives(csp) {
  const out = {};
  for (const d of String(csp ?? "").split(";")) {
    const [name, ...src] = d.trim().split(/\s+/);
    if (name) out[name.toLowerCase()] = src;
  }
  return out;
}
const CHILD = new RegExp(`[a-z0-9*-]\\.${SIGN_HOST.replaceAll(".", "\\.")}(?![a-z0-9-])`, "i");

// fetchFn(url, init) as fetch; the CT logs first, then the names read, each from every resolver: the fixed ones and
// every child the logs name; then the hosts over HTTPS
export async function read({ fetchFn = fetch, label = `x${randomBytes(8).toString("hex")}` } = {}) {
  const ct = [];
  for (const src of CT_SOURCES) ct.push(await readCt(src, fetchFn));
  const names = fixed(label);
  for (const src of CT_SOURCES) for (const n of ctNames({ ct }, src.name).names ?? []) if (!names.includes(n)) names.push(n);
  const answers = [];
  for (const name of names) {
    for (const r of RESOLVERS) {
      const url = r.url(name);
      try {
        const res = await fetchFn(url, { headers: r.headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
        answers.push({ resolver: r.name, name, url, status: res.status, body: await res.text() });
      } catch (e) {
        answers.push({ resolver: r.name, name, url, error: String(e?.cause?.code ?? e?.name ?? e?.message) });
      }
    }
  }
  return { at: new Date().toISOString(), label, ct, answers, http: await readHttp(fetchFn) };
}

export function judge(rec) {
  const lines = [];
  let ok = true;
  const add = (good, line) => {
    ok &&= good;
    lines.push(`${good ? "ok " : "BAD"} ${line}`);
  };
  const of = (name) => {
    const got = RESOLVERS.map((r) => {
      const a = rec.answers.find((x) => x.name === name && x.resolver === r.name);
      if (!a) return { resolver: r.name, error: "not read" };
      if (a.error) return { resolver: r.name, error: a.error };
      if (a.status !== 200) return { resolver: r.name, error: `HTTP ${a.status}` };
      return { resolver: r.name, ...parse(a.body) };
    });
    return got;
  };
  const say = (g) => (g.error ? `${g.resolver} unread (${g.error})` : `${g.resolver} status ${g.status}${g.cnames.length ? ` CNAME ${g.cnames.join(" > ")}` : ""}${g.as.length ? ` A x${g.as.length}` : ""}`);

  const sign = of(SIGN_HOST);
  add(sign.every((g) => !g.error && g.status === NOERROR && g.cnames[0] === SIGN_TARGET && g.as.length > 0), `${SIGN_HOST} is the signing page's project ${SIGN_TARGET}: ${sign.map(say).join("; ")}`);
  for (const l of [...LABELS, rec.label]) {
    const name = `${l}.${SIGN_HOST}`;
    const g = of(name);
    const what = l === rec.label ? "a random label (no wildcard)" : `${l}.`;
    add(g.every((x) => !x.error && x.status === NXDOMAIN), `${name}, ${what}: NXDOMAIN on both: ${g.map(say).join("; ")}`);
  }
  // the CT logs: each source's line, then every child they name past the fixed ones
  const fixedNames = fixed(rec.label);
  const found = new Set();
  const read = CT_SOURCES.map((src) => [src.name, ctNames(rec, src.name)]);
  for (const [name, got] of read) {
    if (got.error) {
      lines.push(`--  ${name}: unread (${got.error}), so its names are not judged`);
      continue;
    }
    for (const n of got.names) found.add(n);
    lines.push(`--  ${name}: ${got.names.length} name(s) under ${SIGN_HOST}${got.names.length ? `: ${got.names.join(", ")}` : ""}`);
  }
  add(read.some(([, got]) => !got.error), `the CT logs are read: ${read.filter(([, g]) => !g.error).map(([n]) => n).join(", ") || "no source answered"}`);
  for (const name of [...found].filter((n) => !fixedNames.includes(n)).sort()) {
    const g = of(name);
    add(g.every((x) => !x.error && x.status === NXDOMAIN), `${name}, in the CT logs: NXDOMAIN on both: ${g.map(say).join("; ")}`);
  }
  const certs = ctCerts(rec, Date.parse(rec.at ?? "") || Date.now());
  add(!certs.error && !certs.bad.length, certs.error ? `child certificates: certspotter unread (${certs.error}), so their revocation is not judged` : `child certificates: ${certs.count} unexpired, ${certs.bad.length ? `still good: ${certs.bad.join("; ")}` : `each revoked or allowed (${CERTS_ALLOWED.map((a) => `${a.names.join(", ")} by ${a.issuer}: ${a.why}`).join("; ")})`}`);
  const app = of(APP_HOST);
  add(app.every((g) => !g.error && g.status === NOERROR && g.cnames[0] === APP_TARGET && g.as.length > 0), `${APP_HOST} is the terminal's project ${APP_TARGET}: ${app.map(say).join("; ")}`);
  const helper = of(HELPER_HOST);
  add(helper.every((g) => !g.error && g.status === NOERROR && g.cnames.length === 0 && g.as.length === 1 && g.as[0] === HELPER_IP), `${HELPER_HOST} is ct-helper's primary IP: ${helper.map(say).join("; ")}`);
  judgeHttp(rec.http, add);
  return { ok, lines };
}

/** The HTTPS lines: the signing page's origin, the rp.id, both CSPs, the webauthn path, the helper's CORS, the
 *  retired children. */
function judgeHttp(h, add) {
  if (!h) return add(false, "the hosts over HTTPS: not read");
  const st = (r) => (!r ? "not read" : r.error ? `unread (${r.error})` : `HTTP ${r.status}`);
  const idx = h.sign_index;
  const b = h.sign_bundle;
  const pin = idx && !idx.error ? /<script type="module" src="\/app\.js" integrity="(sha384-[A-Za-z0-9+/=]+)"><\/script>/.exec(idx.body ?? "")?.[1] : undefined;
  add(idx?.status === 200 && !!pin && b?.status === 200 && b.sha384 === pin, `${SIGN_ORIGIN}/ is the signing page: / ${st(idx)}${pin ? ` pins /app.js ${pin.slice(0, 19)}...` : " pins no /app.js"}, /app.js ${st(b)}${b?.sha384 ? ` ${b.sha384 === pin ? "is" : "is not"} that file` : ""}`);
  const hosts = b?.hosts ?? [];
  const bareHosts = hosts.filter((x) => !x.includes("://"));
  const origins = hosts.filter((x) => x.includes("://"));
  const known = [SIGN_ORIGIN, APP_ORIGIN, HELPER_ORIGIN, `wss://${HELPER_HOST}`];
  add(b?.status === 200 && bareHosts.length === 1 && bareHosts[0] === SIGN_HOST && origins.every((o) => known.includes(o)), `rp.id: the signing page's bundle holds the one bare host ${bareHosts.join(", ") || "none"} (want ${SIGN_HOST}) and the origins ${origins.join(", ") || "none"}`);
  const sd = directives(idx?.csp);
  const named = (d) => Object.values(d).flat().filter((x) => CHILD.test(x));
  add(idx?.status === 200 && sd["frame-ancestors"]?.join(" ") === "'none'" && sd["frame-src"]?.join(" ") === APP_ORIGIN && (sd["connect-src"] ?? []).includes(HELPER_ORIGIN) && !named(sd).length, `${SIGN_HOST}'s CSP: frame-ancestors ${sd["frame-ancestors"]?.join(" ") ?? "none"} (want 'none'), frame-src ${sd["frame-src"]?.join(" ") ?? "none"} (want ${APP_ORIGIN}), connect-src ${(sd["connect-src"] ?? []).includes(HELPER_ORIGIN) ? "names" : "does not name"} ${HELPER_ORIGIN}${named(sd).length ? `, names a child: ${named(sd).join(", ")}` : ""}`);
  const a = h.app_index;
  const ad = directives(a?.csp);
  const ac = ad["connect-src"] ?? [];
  const wants = [HELPER_ORIGIN, `wss://${HELPER_HOST}`, SIGN_ORIGIN];
  add(a?.status === 200 && ad["frame-ancestors"]?.join(" ") === SIGN_ORIGIN && ad["frame-src"]?.join(" ") === "'none'" && wants.every((w) => ac.includes(w)) && !named(ad).length, `${APP_HOST}'s CSP (${st(a)}): frame-ancestors ${ad["frame-ancestors"]?.join(" ") ?? "none"} (want ${SIGN_ORIGIN}), frame-src ${ad["frame-src"]?.join(" ") ?? "none"} (want 'none'), connect-src ${wants.filter((w) => !ac.includes(w)).length ? `lacks ${wants.filter((w) => !ac.includes(w)).join(", ")}` : `names ${wants.join(", ")}`}${named(ad).length ? `, names a child: ${named(ad).join(", ")}` : ""}`);
  const w = h.webauthn;
  add(w?.status === 404 || (w?.status === 200 && !!idx?.sha256 && w.sha256 === idx.sha256), `${SIGN_HOST}${WEBAUTHN} is refused: ${st(w)}${w?.status === 200 ? (w.sha256 === idx?.sha256 ? ", Pages' fallback page (/ byte for byte)" : ", a file that is not /") : ""}`);
  for (const [r, origin] of [[h.helper_sign, SIGN_ORIGIN], [h.helper_app, APP_ORIGIN]]) {
    add(r?.status === 200 && r.acao === origin, `${HELPER_ORIGIN}/v1/health with Origin ${origin}: ${st(r)}, access-control-allow-origin ${r?.acao ?? "none"}`);
  }
  for (const origin of REFUSED_ORIGINS) {
    const r = (h.helper_refused ?? []).find((x) => x.origin === origin);
    add(!!r && !r.error && r.status > 0 && !r.acao, `${HELPER_ORIGIN}/v1/health refuses Origin ${origin}: ${st(r)}, access-control-allow-origin ${r?.acao ?? "none"}`);
  }
  for (const n of RETIRED) {
    const r = (h.retired ?? []).find((x) => x.url === `https://${n}/`);
    add(!!r?.error, `https://${n}/ gives no answer: ${r ? (r.error ? `none (${r.error})` : `HTTP ${r.status}`) : "not read"}`);
  }
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const rec = await read();
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    if (rec.answers.every((x) => x.error)) throw new Error(`no resolver answered: ${rec.answers[0]?.error}`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
