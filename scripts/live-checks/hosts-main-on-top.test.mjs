// node --test scripts/live-checks/hosts-main-on-top.test.mjs: the live check's verdict replays recorded runs
// (hosts-main-on-top.answers.json):
//   bad:  the real run on 2026-11-06 from the Mac, before the owner's DNS clicks: SIGN_HOST still the terminal's
//         project, api. and sign. answering, ct-app and ct-api not made yet: FAIL on exactly those lines;
//   good: that run's own answers, each moved to the name it answers once the clicks are done: PASS.
// Planted on the good answer: a wildcard, a child with a record of another type, a resolver that disagrees or does not
// answer, SIGN_HOST on the terminal's project, the helper on another address: each FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_TARGET, HELPER_HOST, HELPER_IP, judge, read, SIGN_HOST, SIGN_TARGET } from "./hosts-main-on-top.mjs";

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
  assert.equal(r.lines.length, 7);
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

test("read asks both resolvers for SIGN_HOST, each child label, a random one and both siblings", async () => {
  const asked = [];
  const rec = await read({ label: "xrand", fetchFn: async (url) => (asked.push(url), new Response('{"Status":3}', { status: 200 })) });
  const names = asked.map((u) => new URL(u).searchParams.get("name"));
  assert.deepEqual([...new Set(names)], [SIGN_HOST, `api.${SIGN_HOST}`, `app.${SIGN_HOST}`, `sign.${SIGN_HOST}`, `xrand.${SIGN_HOST}`, "ct-app.unrealized.trade", HELPER_HOST]);
  assert.equal(asked.length, 14);
  assert.deepEqual([...new Set(asked.map((u) => new URL(u).host))], ["cloudflare-dns.com", "dns.google"]);
  assert.equal(rec.answers.length, 14);
});
