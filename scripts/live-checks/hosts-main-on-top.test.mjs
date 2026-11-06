// node --test scripts/live-checks/hosts-main-on-top.test.mjs: the live check's verdict replays recorded runs
// (hosts-main-on-top.answers.json):
//   bad:  the real run on 2026-11-07 from the Mac, before the owner's DNS clicks: SIGN_HOST still the terminal's
//         project, api. and sign. answering, ct-app and ct-api not made yet: FAIL on exactly those lines; its CT reads
//         as they came (crt.sh's list without its canary, certspotter's api., ctwatch-test. and sign.);
//   good: that run's own answers, each moved to the name it answers once the clicks are done: PASS.
// Planted on the good answer: a wildcard, a child with a record of another type, a resolver that disagrees or does not
// answer, SIGN_HOST on the terminal's project, the helper on another address, a child in the CT logs that answers or
// was not read, no CT source whole: each FAILs; one CT source whole is enough.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_TARGET, CT_PAGES_MAX, ctNames, HELPER_HOST, HELPER_IP, judge, read, SIGN_HOST, SIGN_TARGET } from "./hosts-main-on-top.mjs";

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
  assert.equal(r.lines.filter((l) => !l.startsWith("--")).length, 9);
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
      `BAD ct-app.unrealized.trade is the terminal's project ${APP_TARGET}`,
      `BAD ${HELPER_HOST} is ct-helper's ${HELPER_IP}`,
    ],
  );
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
  assert.deepEqual(bad(r).map((l) => l.split(":")[0]), ["BAD the CT logs are read"]);
  assert.ok(r.lines.includes("--  certspotter: unread (HTTP 429), so its names are not judged"), r.lines.join("\n"));
  // certspotter's list without SIGN_HOST's own certificate is not whole
  assert.match(ctNames(withCt(ANSWERS.good, "certspotter", [page([issuance(2, [WWW])]), page([])]), "certspotter").error, /does not name confidential\.unrealized\.trade/);
  // a source past the page bound is unread
  const many = Array.from({ length: CT_PAGES_MAX }, (_, i) => page([issuance(i + 1, [SIGN_HOST])]));
  assert.match(ctNames(withCt(ANSWERS.good, "certspotter", many), "certspotter").error, /more than 20 pages/);
  // crt.sh whole and certspotter unread: one whole source is enough
  const crt = withCt(withCt(ANSWERS.good, "certspotter", [{ url: "https://ct.example/", error: "ETIMEDOUT" }]), "crt.sh", [page([{ common_name: ["sign", SIGN_HOST].join("."), name_value: `${["sign", SIGN_HOST].join(".")}\n${["api", SIGN_HOST].join(".")}` }])]);
  r = judge(crt);
  assert.equal(r.ok, true, r.lines.join("\n"));
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
    `https://api.certspotter.com/v1/issuances?domain=${SIGN_HOST}&include_subdomains=true&expand=dns_names`,
    `https://api.certspotter.com/v1/issuances?domain=${SIGN_HOST}&include_subdomains=true&expand=dns_names&after=5`,
  ]);
  const dns = asked.slice(3);
  const names = dns.map((u) => new URL(u).searchParams.get("name"));
  assert.deepEqual([...new Set(names)], [SIGN_HOST, `api.${SIGN_HOST}`, `app.${SIGN_HOST}`, `sign.${SIGN_HOST}`, `xrand.${SIGN_HOST}`, "ct-app.unrealized.trade", HELPER_HOST, WWW]);
  assert.equal(dns.length, 16);
  assert.deepEqual([...new Set(dns.map((u) => new URL(u).host))], ["cloudflare-dns.com", "dns.google"]);
  assert.equal(rec.answers.length, 16);
  assert.deepEqual(rec.ct.map((c) => [c.source, c.pages.length]), [["crt.sh", 1], ["certspotter", 2]]);
});
