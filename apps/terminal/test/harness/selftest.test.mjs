// node --test apps/terminal/test/harness/selftest.test.mjs: the self-test's verdict replays recorded runs
// (selftest.answers.json), each read on 2026-11-01 at 01:44Z by selftest.mjs --record in headless Chromium
// 153.0.8010.12 (Playwright 1.63.0) from the terminal's and the signing page's builds at main
// f4df583 (signpage-skeleton's _headers on sign.ct.test):
//   good:             PASS (every host serves, a passkey with PRF registers, both logs name every host);
//   badAuthenticator: --plant no-authenticator, no virtual authenticator on the page: FAIL on the passkey lines only;
//   badSibling:       --plant no-sibling, evil.ct.test left out of the server: FAIL on that host's line only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOSTS } from "./harness.mjs";
import { judge } from "./selftest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "selftest.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer: every host serves, an authenticator registers, both logs name every host: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const [role, name] of Object.entries(HOSTS)) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${role} ${name} serves: 200 at https://${name}, secure`)), role);
  assert.ok(r.lines.includes(`ok  ${HOSTS.sibling} to ${HOSTS.sign} is same-site (want same-site)`));
  assert.ok(r.lines.includes(`ok  ${HOSTS.cross} to ${HOSTS.sign} is cross-site (want cross-site)`));
  assert.ok(r.lines.includes("ok  https://example.com/ from the harness: not reached (net::ERR_NAME_NOT_RESOLVED)"));
  assert.ok(r.lines.includes(`ok  the virtual authenticator holds 1 credential(s) for ${HOSTS.sign}`));
  assert.ok(r.lines.includes("ok  the authenticator still holds 1 credential(s) at the end of the run"));
  assert.ok(r.lines.includes("ok  PRF output 32 bytes, equal on two gets"));
  assert.ok(r.lines.some((l) => /^ok  the request log names every host \(\d+ requests\)$/.test(l)));
  assert.ok(r.lines.some((l) => /^ok  the server's log names every host \(\d+ requests\)$/.test(l)));
  // APP_HOST and SIGN_HOST were each served under its own build's policy headers, the three the self-test compares
  for (const role of ["app", "sign"]) {
    const h = ANSWERS.good.hosts.find((x) => x.role === role);
    assert.deepEqual(Object.keys(h.served).sort(), ["content-security-policy", "integrity-policy", "permissions-policy"], role);
  }
  assert.match(ANSWERS.good.hosts.find((x) => x.role === "sign").served["content-security-policy"], /frame-ancestors https:\/\/ct-app\.unrealized\.trade/);
});

test("recorded bad answer: no virtual authenticator, so no passkey registers: FAIL", () => {
  const r = judge(ANSWERS.badAuthenticator);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.length > 0 && b.every((l) => /passkey|authenticator|PRF/.test(l)), b.join("\n"));
  assert.ok(b.includes(`BAD a passkey made on ${HOSTS.sign}: NotSupportedError: Resident credentials or empty 'allowCredentials' lists are not supported at this time.`), b.join("\n"));
});

test("recorded bad answer: the same-site sibling is not served: FAIL", () => {
  const r = judge(ANSWERS.badSibling);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r.lines), [`BAD sibling ${HOSTS.sibling} serves: status 421`]);
});

test("a record with a host missing from the request log: FAIL", () => {
  const rec = structuredClone(ANSWERS.good);
  rec.requests = rec.requests.filter((x) => x.host !== HOSTS.cross);
  assert.deepEqual(bad(judge(rec).lines), [`BAD the request log names every host: missing ${HOSTS.cross}`]);
});

test("a record that reached a name outside the harness: FAIL", () => {
  const rec = structuredClone(ANSWERS.good);
  rec.outside = { reached: true, failure: null };
  assert.deepEqual(bad(judge(rec).lines), ["BAD https://example.com/ from the harness: REACHED"]);
});
