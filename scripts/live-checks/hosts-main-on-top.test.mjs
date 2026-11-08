// node --test scripts/live-checks/hosts-main-on-top.test.mjs: the live check's verdict replays recorded runs
// (hosts-main-on-top.answers.json):
//   bad:  the real run on 2026-11-07 23:5xZ from the Mac, before the cutover: SIGN_HOST still the terminal's project
//         and serving the terminal, api. and sign. answering, the helper with no certificate for ct-api yet: FAIL on
//         exactly those lines; its CT reads as they came (crt.sh's list without its canary, certspotter's api.,
//         ctwatch-test. and sign.);
//   good: DNS and CT from the 2026-11-06 run's own answers, each moved to the name it answers once the clicks are done;
//         HTTPS from release-92's own list and build; certspotter's list as read on 2026-11-08 01:33Z with the four
//         Let's Encrypt child certificates revoked as the cutover revokes them (the answers' about says each part): PASS;
//   bad_cert: the good answer with that certspotter list as read, api.'s and ctwatch-test.'s certificates unrevoked:
//         FAIL on the certificate line alone;
//   bad_cors: the good answer with a helper that echoes any origin: FAIL on the two refusal lines alone.
// Planted on the good answer: a wildcard, a child with a record of another type, a resolver that disagrees or does not
// answer, SIGN_HOST on the terminal's project, the helper on another address, a child in the CT logs that answers or
// was not read, no CT source whole: each FAILs; one CT source whole is enough. And over HTTPS: SIGN_HOST serving
// another page or another bundle, a bundle with a second bare host or a child's origin, each CSP directive wrong or
// naming a child, a webauthn file, the helper's CORS missing an origin, a retired child that answers: each FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_ORIGIN, APP_TARGET, CT_PAGES_MAX, ctCerts, ctNames, REFUSED_ORIGINS, HELPER_HOST, HELPER_IP, hostsIn, judge, read, SIGN_HOST, SIGN_ORIGIN, SIGN_TARGET, WEBAUTHN } from "./hosts-main-on-top.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "hosts-main-on-top.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const clone = (x) => JSON.parse(JSON.stringify(x));
/** The good answer with one name's answer from one resolver (or both) changed by `edit` on its parsed body. */
function planted(name, edit, resolvers = ["cloudflare", "google"]) {
  const rec = clone(ANSWERS.good);
  for (const a of rec.answers) if (a.name === name && resolvers.includes(a.resolver)) a.body = JSON.stringify(edit(JSON.parse(a.body)));
  return rec;
}
const NOERROR_EMPTY = (j) => ({ ...j, Status: 0, Answer: undefined });
const WILDCARD = (name) => (j) => ({ ...j, Status: 0, Answer: [{ name, type: 5, TTL: 300, data: "confidential-trenches-app.pages.dev." }, { name: "confidential-trenches-app.pages.dev", type: 1, TTL: 300, data: "172.66.47.14" }] });

test("the pins equal the deploy scripts' projects and the helper's primary IP", async () => {
  const sign = readFileSync(path.join(HERE, "../../packages/signpage/scripts/deploy.mjs"), "utf8").match(/^export const PROJECT = "([^"]+)";$/m)[1];
  const app = readFileSync(path.join(HERE, "../../apps/terminal/scripts/deploy.mjs"), "utf8").match(/^export const PROJECT = "([^"]+)";$/m)[1];
  assert.equal(SIGN_TARGET, `${sign}.pages.dev`);
  assert.equal(APP_TARGET, `${app}.pages.dev`);
  const { HOST, PRIMARY_IP } = await import("../../apps/helper/deploy/create-server.mjs");
  assert.equal(HOST, HELPER_HOST);
  assert.equal(PRIMARY_IP.ip, HELPER_IP);
});

test("recorded good answer: SIGN_HOST on the signing page's project, no child, no wildcard, the siblings in place: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => !l.startsWith("--")).length, 21);
  assert.ok(r.lines.some((l) => l.startsWith("ok  child certificates: 6 unexpired, each revoked or allowed")), r.lines.join("\n"));
  assert.ok(r.lines.includes(`ok  the CT logs are read: certspotter`), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("--  crt.sh: unread (the list does not name sign.")), "crt.sh's list without its canary is said so");
  assert.ok(r.lines.some((l) => l.startsWith(`ok  ctwatch-test.${SIGN_HOST}, in the CT logs: NXDOMAIN on both`)), r.lines.join("\n"));
  assert.match(r.lines[0], new RegExp(`^ok  ${SIGN_HOST.replaceAll(".", "\\.")} is the signing page's project`));
  for (const l of ["api", "app", "sign", ANSWERS.good.label]) assert.ok(r.lines.some((x) => x.startsWith(`ok  ${l}.${SIGN_HOST}, `) && x.includes("cloudflare status 3; google status 3")), l);
});

test("recorded bad answer, today's DNS: SIGN_HOST is the terminal's, api. and sign. answer, the siblings missing: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.deepEqual(
    bad(r).map((l) => l.split(":")[0]),
    [
      `BAD ${SIGN_HOST} is the signing page's project ${SIGN_TARGET}`,
      `BAD api.${SIGN_HOST}, api.`,
      `BAD sign.${SIGN_HOST}, sign.`,
      "BAD child certificates",
      "BAD https",
      "BAD rp.id",
      `BAD ${SIGN_HOST}'s CSP`,
      "BAD ct-app.unrealized.trade's CSP (HTTP 200)",
      "BAD https",
      "BAD https",
      "BAD https",
      "BAD https",
      "BAD https",
      "BAD https",
    ],
  );
  const lines = bad(r).join("\n");
  assert.match(lines, /BAD https:\/\/confidential\.unrealized\.trade\/ is the signing page: \/ HTTP 200 pins no \/app\.js/);
  assert.match(lines, /BAD https:\/\/ct-api\.unrealized\.trade\/v1\/health with Origin https:\/\/confidential\.unrealized\.trade: unread \(ERR_SSL/);
  assert.match(lines, /BAD https:\/\/sign\.confidential\.unrealized\.trade\/ gives no answer: HTTP 200/);
  assert.match(lines, /BAD https:\/\/api\.confidential\.unrealized\.trade\/ gives no answer: HTTP 404/);
});

test("recorded bad answer (review F1), certspotter's list on 2026-11-08: api.'s and ctwatch-test.'s certificates unexpired and not revoked: FAIL on that line alone", () => {
  const r = judge(ANSWERS.bad_cert);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r).map((l) => l.split(":")[0]), ["BAD child certificates"]);
  const line = bad(r)[0];
  for (const id of ["18102517185", "17921097554", "17921221760", "17921365530"]) assert.ok(line.includes(`${id} for `) && line.includes("is not revoked"), id);
  // sign.'s Google Trust Services certificates are allowed by name
  for (const id of ["18096830193", "18096839733"]) assert.ok(!line.includes(id), id);
});

test("recorded bad answer (review F6), a helper that echoes any origin: FAIL on the two refusal lines alone", () => {
  const r = judge(ANSWERS.bad_cors);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r).map((l) => l.split(" Origin ")[1]?.split(":")[0] + ":" + l.split(" Origin ")[1]?.split(":")[1]), REFUSED_ORIGINS);
});

test("planted certificate cases: an unexpired child certificate passes only revoked, or allowed by name and issuer", () => {
  const at = Date.parse(ANSWERS.good.at);
  const cert = (names, over = {}) => ({ id: "9", dns_names: names, not_after: "2027-01-30T03:40:46Z", issuer: { friendly_name: "Let's Encrypt" }, revoked: false, ...over });
  const spot = (...cs) => withCt(ANSWERS.good, "certspotter", [page([issuance(1, [SIGN_HOST]), ...cs]), page([])]);
  const api = ["api", SIGN_HOST].join(".");
  const sign = ["sign", SIGN_HOST].join(".");
  assert.deepEqual(ctCerts(spot(cert([api])), at).bad.length, 1, "api., revoked false");
  assert.deepEqual(ctCerts(spot(cert([api], { revoked: true })), at).bad, [], "api., revoked true");
  assert.deepEqual(ctCerts(spot(cert([api], { revoked: undefined })), at).bad.length, 1, "api., revocation not read");
  assert.deepEqual(ctCerts(spot(cert([api], { not_after: "2026-11-01T00:00:00Z" })), at).bad, [], "api., expired");
  assert.deepEqual(ctCerts(spot(cert([sign], { issuer: { friendly_name: "Google Trust Services" } })), at).bad, [], "sign. by Google");
  assert.equal(ctCerts(spot(cert([sign])), at).bad.length, 1, "sign. by another CA");
  assert.equal(ctCerts(spot(cert([sign, api], { issuer: { friendly_name: "Google Trust Services" } })), at).bad.length, 1, "sign. and api. by Google");
  assert.equal(ctCerts(spot(cert([SIGN_HOST])), at).bad.length, 0, "SIGN_HOST alone is no child");
  // the record's own line
  const r = judge(spot(cert([api])));
  assert.deepEqual(bad(r).map((l) => l.split(":")[0]), ["BAD child certificates"]);
  // certspotter unread: the certificates are not judged, and the line fails
  const un = judge(withCt(ANSWERS.good, "certspotter", [page({ message: "rate limited" }, 429)]));
  assert.ok(bad(un).some((l) => l.startsWith("BAD child certificates: certspotter unread (HTTP 429)")), bad(un).join("\n"));
});

test("no line prints the helper's address", () => {
  for (const k of ["good", "bad", "bad_cert", "bad_cors"]) for (const l of judge(ANSWERS[k]).lines) assert.ok(!l.includes(HELPER_IP), `${k}: ${l}`);
});

/** The good answer with its HTTPS part changed by `edit`. */
function http(edit) {
  const rec = clone(ANSWERS.good);
  edit(rec.http);
  return rec;
}
const csp = (r, from, to) => {
  assert.ok(r.csp.includes(from), from);
  r.csp = r.csp.replace(from, to);
};

test("planted HTTPS cases: each fails on its own line, and only there", () => {
  const CHILD = ["x", SIGN_HOST].join(".");
  const cases = [
    ["SIGN_HOST serves another page", (h) => (h.sign_index.body = "<!doctype html><script type=module src=/assets/x.js></script>"), "BAD https"],
    ["SIGN_HOST's /app.js is not the one its index pins", (h) => (h.sign_bundle.sha384 = "sha384-other"), "BAD https"],
    ["/app.js not served", (h) => (h.sign_bundle = { url: h.sign_bundle.url, error: "ETIMEDOUT" }), ["BAD https", "BAD rp.id"]],
    ["the bundle holds a second bare host", (h) => h.sign_bundle.hosts.push("ct-app.unrealized.trade"), "BAD rp.id"],
    ["the bundle names a child's origin", (h) => h.sign_bundle.hosts.push(`https://${CHILD}`), "BAD rp.id"],
    ["the bundle's bare host is a parent", (h) => (h.sign_bundle.hosts = h.sign_bundle.hosts.map((x) => (x === SIGN_HOST ? "unrealized.trade" : x))), "BAD rp.id"],
    ["SIGN_HOST may be framed", (h) => csp(h.sign_index, "frame-ancestors 'none'", `frame-ancestors ${APP_ORIGIN}`), `BAD ${SIGN_HOST}'s CSP`],
    ["SIGN_HOST frames more than APP_HOST", (h) => csp(h.sign_index, `frame-src ${APP_ORIGIN}`, `frame-src ${APP_ORIGIN} https://${CHILD}`), `BAD ${SIGN_HOST}'s CSP`],
    ["SIGN_HOST's connect-src lacks the helper", (h) => csp(h.sign_index, `connect-src 'self' https://${HELPER_HOST}`, "connect-src 'self'"), `BAD ${SIGN_HOST}'s CSP`],
    ["SIGN_HOST's connect-src names a child", (h) => csp(h.sign_index, "connect-src 'self'", `connect-src 'self' https://${CHILD}`), `BAD ${SIGN_HOST}'s CSP`],
    ["APP_HOST may be framed by another", (h) => csp(h.app_index, `frame-ancestors ${SIGN_ORIGIN}`, `frame-ancestors ${SIGN_ORIGIN} https://${CHILD}`), "BAD ct-app.unrealized.trade's CSP (HTTP 200)"],
    ["APP_HOST frames a page", (h) => csp(h.app_index, "frame-src 'none'", `frame-src ${SIGN_ORIGIN}`), "BAD ct-app.unrealized.trade's CSP (HTTP 200)"],
    ["APP_HOST's connect-src lacks the helper's socket", (h) => csp(h.app_index, ` wss://${HELPER_HOST}`, ""), "BAD ct-app.unrealized.trade's CSP (HTTP 200)"],
    ["APP_HOST's connect-src lacks SIGN_HOST", (h) => csp(h.app_index, ` ${SIGN_ORIGIN} `, " "), "BAD ct-app.unrealized.trade's CSP (HTTP 200)"],
    ["a webauthn file on SIGN_HOST", (h) => (h.webauthn.sha256 = "0".repeat(64)), `BAD ${SIGN_HOST}${WEBAUTHN} is refused`],
    ["webauthn unread", (h) => (h.webauthn = { url: h.webauthn.url, error: "ETIMEDOUT" }), `BAD ${SIGN_HOST}${WEBAUTHN} is refused`],
    ["the helper does not echo SIGN_HOST", (h) => (h.helper_sign.acao = null), "BAD https"],
    ["the helper echoes the wrong origin for APP_HOST", (h) => (h.helper_app.acao = SIGN_ORIGIN), "BAD https"],
    ["a retired child answers", (h) => (h.retired[1] = { url: h.retired[1].url, status: 200 }), "BAD https"],
    ["a retired child not read", (h) => h.retired.pop(), "BAD https"],
  ];
  for (const [what, edit, want] of cases) {
    const r = judge(http(edit));
    assert.equal(r.ok, false, what);
    assert.deepEqual(bad(r).map((l) => l.split(":")[0].replace(/^(BAD https).*/, "$1")), [want].flat(), `${what}: ${bad(r).join("\n")}`);
  }
  // a 404 for the webauthn path passes, as Pages' fallback page does
  assert.equal(judge(http((h) => (h.webauthn = { url: h.webauthn.url, status: 404, sha256: "1".repeat(64) }))).ok, true);
  // a record with no HTTPS part fails
  const none = clone(ANSWERS.good);
  delete none.http;
  assert.deepEqual(bad(judge(none)), ["BAD the hosts over HTTPS: not read"]);
});

test("hostsIn reads origins and bare host names out of a bundle", () => {
  const text = `a="https://ct-api.unrealized.trade/v1",b=\x60confidential.unrealized.trade\x60,c='wss://ct-api.unrealized.trade'`;
  assert.deepEqual(hostsIn(text), ["confidential.unrealized.trade", "https://ct-api.unrealized.trade", "wss://ct-api.unrealized.trade"]);
});

test("planted: each broken name fails on its own line", () => {
  const rnd = `${ANSWERS.good.label}.${SIGN_HOST}`;
  const cases = [
    ["a wildcard answers the random label", planted(rnd, WILDCARD(rnd)), `BAD ${rnd}`],
    ["a child with a record of another type (NOERROR, no A)", planted(`app.${SIGN_HOST}`, NOERROR_EMPTY), `BAD app.${SIGN_HOST}`],
    ["one resolver sees a child the other does not", planted(`api.${SIGN_HOST}`, WILDCARD(`api.${SIGN_HOST}`), ["google"]), `BAD api.${SIGN_HOST}`],
    ["SIGN_HOST on the terminal's project", planted(SIGN_HOST, (j) => ({ ...j, Answer: j.Answer.map((x) => (x.type === 5 ? { ...x, data: `${APP_TARGET}.` } : x)) })), `BAD ${SIGN_HOST}`],
    ["the helper on another address", planted(HELPER_HOST, (j) => ({ ...j, Answer: [{ ...j.Answer[0], data: "203.0.113.7" }] })), `BAD ${HELPER_HOST}`],
    ["the helper behind a second address too", planted(HELPER_HOST, (j) => ({ ...j, Answer: [...j.Answer, { ...j.Answer[0], data: "203.0.113.7" }] })), `BAD ${HELPER_HOST}`],
  ];
  for (const [what, rec, line] of cases) {
    const r = judge(rec);
    assert.equal(r.ok, false, what);
    assert.deepEqual(bad(r).map((l) => l.split(":")[0].split(",")[0].split(" is ")[0]), [line], `${what}: ${bad(r).join("\n")}`);
  }
  const unread = clone(ANSWERS.good);
  unread.answers.find((a) => a.name === `sign.${SIGN_HOST}` && a.resolver === "cloudflare").error = "ETIMEDOUT";
  assert.equal(judge(unread).ok, false, "a resolver that does not answer");
  const missing = clone(ANSWERS.good);
  missing.answers = missing.answers.filter((a) => !(a.name === `api.${SIGN_HOST}` && a.resolver === "google"));
  assert.equal(judge(missing).ok, false, "a name one resolver was not asked");
});

// The CT logs: a certspotter page with these names (and the record's other pages kept), a crt.sh list.
const WWW = ["www", SIGN_HOST].join(".");
const issuance = (id, names) => ({ id: String(id), dns_names: names });
function withCt(rec, source, pages) {
  const out = clone(rec);
  out.ct = out.ct.map((c) => (c.source === source ? { source, pages } : c));
  return out;
}
const page = (body, status = 200) => ({ url: "https://ct.example/", status, body: JSON.stringify(body) });
const nx = (name) => ANSWERS.good.answers.filter((a) => a.name === `app.${SIGN_HOST}`).map((a) => ({ ...a, name, body: a.body.replaceAll(`app.${SIGN_HOST}`, name) }));
const answering = (name) => ANSWERS.good.answers.filter((a) => a.name === HELPER_HOST).map((a) => ({ ...a, name, body: a.body.replaceAll(HELPER_HOST, name) }));

test("planted CT log cases: a child the logs name must be NXDOMAIN on both, and one whole source is needed", () => {
  const spotter = (names) => [page([issuance(1, [SIGN_HOST]), issuance(2, names)]), page([])];
  // a child in the logs that answers fails on its own line
  const live = withCt(ANSWERS.good, "certspotter", spotter([WWW]));
  live.answers.push(...answering(WWW));
  let r = judge(live);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r).map((l) => l.split(":")[0]), [`BAD ${WWW}, in the CT logs`]);
  // the same child with no record passes
  const gone = withCt(ANSWERS.good, "certspotter", spotter([WWW]));
  gone.answers.push(...nx(WWW));
  r = judge(gone);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes(`--  certspotter: 1 name(s) under ${SIGN_HOST}: ${WWW}`), r.lines.join("\n"));
  // a child in the logs that the run did not ask DNS about fails
  r = judge(withCt(ANSWERS.good, "certspotter", spotter([WWW])));
  assert.deepEqual(bad(r).map((l) => l.split(":")[0]), [`BAD ${WWW}, in the CT logs`]);
  // no source whole: certspotter limited and crt.sh's list without its canary
  r = judge(withCt(ANSWERS.good, "certspotter", [page({ message: "rate limited" }, 429)]));
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r).map((l) => l.split(":")[0]), ["BAD the CT logs are read", "BAD child certificates"]);
  assert.ok(r.lines.includes("--  certspotter: unread (HTTP 429), so its names are not judged"), r.lines.join("\n"));
  // certspotter's list without SIGN_HOST's own certificate is not whole
  assert.match(ctNames(withCt(ANSWERS.good, "certspotter", [page([issuance(2, [WWW])]), page([])]), "certspotter").error, /does not name confidential\.unrealized\.trade/);
  // a source past the page bound is unread
  const many = Array.from({ length: CT_PAGES_MAX }, (_, i) => page([issuance(i + 1, [SIGN_HOST])]));
  assert.match(ctNames(withCt(ANSWERS.good, "certspotter", many), "certspotter").error, /more than 20 pages/);
  // crt.sh whole and certspotter unread: one whole source is enough
  const crt = withCt(withCt(ANSWERS.good, "certspotter", [{ url: "https://ct.example/", error: "ETIMEDOUT" }]), "crt.sh", [page([{ common_name: ["sign", SIGN_HOST].join("."), name_value: `${["sign", SIGN_HOST].join(".")}\n${["api", SIGN_HOST].join(".")}` }])]);
  r = judge(crt);
  // the names are judged on crt.sh alone; the certificates' revocation is certspotter's only, so that line fails
  assert.deepEqual(bad(r).map((l) => l.split(":")[0]), ["BAD child certificates"], r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  the CT logs are read: crt.sh"), r.lines.join("\n"));
  assert.ok(r.lines.includes("--  certspotter: unread (ETIMEDOUT), so its names are not judged"), r.lines.join("\n"));
  // a record with no CT reads fails
  const none = clone(ANSWERS.good);
  delete none.ct;
  assert.equal(judge(none).ok, false);
});

test("read asks the CT logs first (certspotter page by page), then both resolvers for SIGN_HOST, each child label, a random one, both siblings and each child the logs name", async () => {
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    const u = new URL(url);
    if (u.host === "crt.sh") return new Response("[]", { status: 200 });
    if (u.host === "api.certspotter.com") return new Response(JSON.stringify(u.searchParams.get("after") ? [] : [issuance(5, [SIGN_HOST, WWW, ["sign", SIGN_HOST].join(".")])]), { status: 200 });
    return new Response('{"Status":3}', { status: 200 });
  };
  const rec = await read({ label: "xrand", fetchFn });
  assert.deepEqual(asked.slice(0, 3), [
    `https://crt.sh/?q=%25.${SIGN_HOST}&output=json`,
    `https://api.certspotter.com/v1/issuances?domain=${SIGN_HOST}&include_subdomains=true&expand=dns_names&expand=issuer&expand=revocation`,
    `https://api.certspotter.com/v1/issuances?domain=${SIGN_HOST}&include_subdomains=true&expand=dns_names&expand=issuer&expand=revocation&after=5`,
  ]);
  const dns = asked.slice(3, 19);
  const names = dns.map((u) => new URL(u).searchParams.get("name"));
  assert.deepEqual([...new Set(names)], [SIGN_HOST, `api.${SIGN_HOST}`, `app.${SIGN_HOST}`, `sign.${SIGN_HOST}`, `xrand.${SIGN_HOST}`, "ct-app.unrealized.trade", HELPER_HOST, WWW]);
  assert.equal(dns.length, 16);
  assert.deepEqual([...new Set(dns.map((u) => new URL(u).host))], ["cloudflare-dns.com", "dns.google"]);
  assert.equal(rec.answers.length, 16);
  assert.deepEqual(rec.ct.map((c) => [c.source, c.pages.length]), [["crt.sh", 1], ["certspotter", 2]]);
  assert.ok(Date.parse(rec.at) > 0, "the run's time, the certificates' expiry is judged against");
  assert.deepEqual(asked.slice(19), [
    `${SIGN_ORIGIN}/`,
    `${SIGN_ORIGIN}/app.js`,
    `${SIGN_ORIGIN}${WEBAUTHN}`,
    `${APP_ORIGIN}/`,
    `https://${HELPER_HOST}/v1/health`,
    `https://${HELPER_HOST}/v1/health`,
    `https://${HELPER_HOST}/v1/health`,
    `https://${HELPER_HOST}/v1/health`,
    `https://${["api", SIGN_HOST].join(".")}/`,
    `https://${["sign", SIGN_HOST].join(".")}/`,
  ]);
});
