// node --test scripts/live-checks/app-no-blank-pages.test.mjs: the live check's verdict replays recorded runs
// (app-no-blank-pages.answers.json), each read on 3 Nov by app-no-blank-pages.mjs collect() in headless Chromium, signed out:
//   good: this card's build served at APP_HOST's name inside the stand-in shell (--harness --build): every link at 390
//         and 1440 opens a page with text, no Orders link, Account and Portfolio draw Sign in that opens the sheet,
//         /verify draws over the Trenches page: PASS;
//   bad:  the deployed APP_HOST before this card: Orders in the top bar opens an empty page, Account and Portfolio are
//         empty, /verify draws its panel over an empty page: FAIL.
// Planted from the good run: an empty page behind a link, an Orders link, a Sign in that opens no sheet, /verify over an
// empty page, a signed-in header, a missing width, a tap that leaves the address, the Account tab gone, a page drawing
// another route.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, WAITING } from "./app-no-blank-pages.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-no-blank-pages.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const run = (rec, w) => rec.runs.find((r) => r.width === w);
const link = (rec, w, href) => run(rec, w).links.find((l) => l.href === href);
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: every link opens a page, Account and Portfolio draw Sign in, /verify draws over Trenches: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(run(ANSWERS.good, "phone").links.map((l) => l.href).sort(), ["/", "/discover", "/portfolio", "/profile"]);
  assert.deepEqual(run(ANSWERS.good, "desktop").links.map((l) => l.href).sort(), ["/", "/discover", "/portfolio", "/privacy", "/terms", "/verify"]);
  // the links that wait on their own card are named, not passed silently
  for (const href of Object.keys(WAITING)) assert.ok(r.lines.some((l) => l.startsWith(`ok  desktop ${href}: waiting on card ${WAITING[href]}`)), href);
});

test("recorded bad answer: the deployed app before this card (Orders, Account, Portfolio empty; /verify over nothing): FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.ok(b.some((l) => /^BAD desktop: links to \/orders/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /^BAD desktop \/orders: an empty page/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /^BAD phone \/profile: an empty page; no Sign in/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /^BAD phone \/portfolio: an empty page; no Sign in/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /^BAD desktop \/verify opened directly: .*not the Verify panel over the Trenches page/.test(l)), r.lines.join("\n"));
});

test("planted: a link that opens an empty page fails", () => {
  fails(mut((rec) => (link(rec, "desktop", "/discover").main.text = 0)), /^BAD desktop \/discover: an empty page/);
});

test("planted: a link to Orders fails, and so does its empty page", () => {
  const r = mut((rec) => run(rec, "desktop").links.push({ href: "/orders", main: { path: "/orders", route: "orders", text: 0, panel: false, token: null, signedOut: false }, sheet: null }));
  fails(r, /^BAD desktop: links to \/orders/);
  assert.ok(bad(r).some((l) => /^BAD desktop \/orders: an empty page/.test(l)));
});

test("planted: Account or Portfolio without Sign in, or a Sign in that opens no sheet, fails", () => {
  fails(mut((rec) => (link(rec, "phone", "/profile").main.signedOut = false)), /^BAD phone \/profile: no Sign in/);
  fails(mut((rec) => (link(rec, "desktop", "/portfolio").sheet = null)), /^BAD desktop \/portfolio: its Sign in opens nothing/);
});

test("planted: /verify over an empty page, opened directly or from the pill, fails", () => {
  fails(mut((rec) => (run(rec, "phone").direct.token = null)), /^BAD phone \/verify opened directly/);
  fails(mut((rec) => (run(rec, "desktop").direct = null)), /^BAD desktop \/verify opened directly: not read/);
  fails(mut((rec) => Object.assign(link(rec, "desktop", "/verify").main, { text: 0, token: null })), /^BAD desktop \/verify: an empty page; the Verify panel not over the Trenches page/);
});

test("planted: a signed-in header, a missing width, or the shell not around the app fails", () => {
  fails(mut((rec) => (run(rec, "phone").header = "S1.4")), /^BAD phone: the header is S1.4/);
  fails(mut((rec) => rec.runs.pop()), /^BAD 1 run\(s\) of 2/);
  fails(mut((rec) => (run(rec, "desktop").framed = false)), /^BAD desktop: not inside SIGN_HOST's shell/);
});

test("planted: a tap that leaves the address, a page drawing another route, or no Account tab fails", () => {
  fails(mut((rec) => (link(rec, "phone", "/discover").main.path = "/")), /^BAD phone \/discover: the tap left the address at \//);
  fails(mut((rec) => (link(rec, "desktop", "/discover").main.route = "token")), /^BAD desktop \/discover: drew token, not discover/);
  fails(mut((rec) => (run(rec, "phone").links = run(rec, "phone").links.filter((l) => l.href !== "/profile"))), /^BAD phone: the Account tab \(\/profile\) is not drawn/);
});

test("a waiting link is named either way, and a link not waiting is never let off", () => {
  const filled = mut((rec) => Object.assign(link(rec, "desktop", "/terms").main, { text: 120 }));
  assert.equal(filled.ok, true, filled.lines.join("\n"));
  assert.ok(filled.lines.some((l) => /^ok {2}desktop \/terms: waiting on card app-legal-pages: has content/.test(l)));
  fails(mut((rec) => Object.assign(link(rec, "desktop", "/portfolio").main, { text: 0, signedOut: false })), /^BAD desktop \/portfolio: an empty page/);
});
