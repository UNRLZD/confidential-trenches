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
//     primary IP (apps/helper/deploy/create-server.mjs PRIMARY_IP): siblings, which cannot claim SIGN_HOST.
// The tree holds no child either: scripts/ci/host-children.mjs, in test:gates.
//   node scripts/live-checks/hosts-main-on-top.mjs [--record <file>]     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every answer the run read to <file>, so the check's test can replay it.
import "../net-window.mjs";
import { randomBytes } from "node:crypto";
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
/** The child labels read, a random one last (a wildcard answers it). */
export const LABELS = ["api", "app", "sign"];
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
    url: (after) => `https://api.certspotter.com/v1/issuances?domain=${SIGN_HOST}&include_subdomains=true&expand=dns_names${after ? `&after=${after}` : ""}`,
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

// fetchFn(url, init) as fetch; the CT logs first, then the names read, each from every resolver: the fixed ones and
// every child the logs name
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
  return { label, ct, answers };
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
  const say = (g) => (g.error ? `${g.resolver} unread (${g.error})` : `${g.resolver} status ${g.status}${g.cnames.length ? ` CNAME ${g.cnames.join(" > ")}` : ""}${g.as.length ? ` A ${g.as.join(", ")}` : ""}`);

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
  const app = of(APP_HOST);
  add(app.every((g) => !g.error && g.status === NOERROR && g.cnames[0] === APP_TARGET && g.as.length > 0), `${APP_HOST} is the terminal's project ${APP_TARGET}: ${app.map(say).join("; ")}`);
  const helper = of(HELPER_HOST);
  add(helper.every((g) => !g.error && g.status === NOERROR && g.cnames.length === 0 && g.as.length === 1 && g.as[0] === HELPER_IP), `${HELPER_HOST} is ct-helper's ${HELPER_IP}: ${helper.map(say).join("; ")}`);
  return { ok, lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const rec = await read();
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ at: new Date().toISOString(), ...rec }, null, 1)}\n`);
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
