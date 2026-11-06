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

// fetchFn(url, init) as fetch; the names read, each from every resolver
export async function read({ fetchFn = fetch, label = `x${randomBytes(8).toString("hex")}` } = {}) {
  const names = [SIGN_HOST, ...[...LABELS, label].map((l) => `${l}.${SIGN_HOST}`), APP_HOST, HELPER_HOST];
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
  return { label, answers };
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
