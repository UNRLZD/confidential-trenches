// node --test scripts/live-checks/app-shell.test.mjs: the live check's verdict replays recorded runs
// (app-shell.answers.json), the hosts' real names answered by route (APP_HOST: a terminal build under its own _headers;
// SIGN_HOST: app-in-shell's stand-in shell):
//   good:         card app-shell-tabbar-cls's build, read on 2026-11-04 by apps/terminal/test/bar10/run.mjs --record (its
//                 answers-at-once pass: the helper's reads answered, signed in) in Chrome 157 on the Mac, the 4th BAR-10
//                 PASS in a row: every load inside the shell, every phone load at CLS 0: PASS;
// the two bad answers read on 2026-11-01 by app-shell.mjs --harness --record in headless Chromium 153 on the Mac:
//   bad:          main cf7b85a's build, before app-in-shell: APP_HOST stays top-level and frames SIGN_HOST, which the
//                 shell's frame-ancestors 'none' refuses: FAIL on every load;
//   badIntegrity: app-in-shell's build with the script tag's integrity taken out: FAIL on the integrity
//                 (Integrity-Policy then blocks the script, so nothing moves to the shell and no route draws).
// Layout shifts are planted on the good answer: any shift on a load at either width fails, as BAR-10's 0.0806 phone tab
// bar and 0.0008 Verify reads did (card app-shell-tabbar-cls).
// Screenshot paths are kept as <shots>/<file>, a build's path as <build>.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { consoleError, judge, ROUTES, WIDTHS } from "./app-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-shell.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer: every route at both widths, integrity equal, CLS 0, no violation: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], /^ok  served with a CSP and an Integrity-Policy: CSP, Integrity-Policy blocked-destinations=\(script\)$/);
  assert.ok(r.lines.some((l) => /^ok  \S+\/assets\/index-[\w-]+\.js integrity equals the sha384 of the bytes served$/.test(l)));
  assert.ok(r.lines.includes(`ok  ${ROUTES.length * WIDTHS.length} loads of ${ROUTES.length * WIDTHS.length} (every route at both widths)`));
  // every phone load holds still; a desktop load moved 0.0009 at most
  for (const w of WIDTHS) for (const [id, p] of ROUTES) assert.ok(r.lines.some((l) => new RegExp(`^ok  ${w.name} ${p} \\(${id}\\): CLS 0\\.000${w.name === "phone" ? "0" : "\\d"}, no violation, no error$`).test(l)), `${w.name} ${p}`);
  assert.ok(r.lines.some((l) => /^ok  phone inside the shell, 4 link\(s\): CLS 0, no reload$/.test(l)));
  assert.ok(r.lines.some((l) => /^ok  desktop inside the shell, 5 link\(s\): CLS 0, no reload$/.test(l)));
});

test("recorded bad answer: today's APP_HOST stays top-level, not inside SIGN_HOST's shell: FAIL on every load", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const w of WIDTHS) {
    for (const [id, p] of ROUTES) assert.ok(bad(r.lines).some((l) => l.startsWith(`BAD ${w.name} ${p} (${id}): not inside SIGN_HOST's shell (top window at https://confidential.unrealized.trade${p})`)), `${w.name} ${p}`);
    assert.ok(bad(r.lines).some((l) => l.startsWith(`BAD ${w.name} inside the shell, `) && l.includes("not inside SIGN_HOST's shell")), w.name);
  }
});

test("planted on the good answer: a late shift on a desktop load, and inside the shell: FAIL", () => {
  const rec = structuredClone(ANSWERS.good);
  const desk = rec.loads.findIndex((l) => l.width === "desktop");
  rec.loads[desk].cls = 0.1422;
  rec.inShell[0].cls = 0.05;
  const b = bad(judge(rec).lines);
  assert.deepEqual(b, [`BAD desktop ${rec.loads[desk].path} (${rec.loads[desk].expect}): CLS 0.1422 above 0`, "BAD phone inside the shell, 4 link(s): CLS 0.0500 inside the shell"]);
});

test("planted on the good answer: any shift on a load at either width, BAR-10's 0.0806 tab bar and 0.0008 Verify reads: FAIL", () => {
  const rec = structuredClone(ANSWERS.good);
  const at = (p) => rec.loads.findIndex((l) => l.width === "phone" && l.path === p);
  Object.assign(rec.loads[at("/profile")], { cls: 0.0806, shifts: [{ at: 28, value: 0.0806, input: false, sources: ["div.tabbar 0,0 0x0 -> 0,776 390x68"] }] });
  Object.assign(rec.loads[at("/verify")], { cls: 0.0008, shifts: [{ at: 65, value: 0.0008, input: false, sources: ["dd.num 282,212 90x14 -> 365,212 7x14"] }] });
  assert.deepEqual(bad(judge(rec).lines), [
    "BAD phone /profile (profile): CLS 0.0806 above 0 [+28ms 0.0806: div.tabbar 0,0 0x0 -> 0,776 390x68]",
    "BAD phone /verify (verify): CLS 0.0008 above 0 [+65ms 0.0008: dd.num 282,212 90x14 -> 365,212 7x14]",
  ]);
  // the same shift on a desktop load fails too
  const d = structuredClone(ANSWERS.good);
  Object.assign(d.loads.find((l) => l.width === "desktop" && l.path === "/verify"), { cls: 0.0008, shifts: [{ at: 65, value: 0.0008, input: false, sources: ["dd.num 1170,212 90x14 -> 1253,212 7x14"] }] });
  assert.deepEqual(bad(judge(d).lines), ["BAD desktop /verify (verify): CLS 0.0008 above 0 [+65ms 0.0008: dd.num 1170,212 90x14 -> 1253,212 7x14]"]);
});

test("planted on the good answer: a shift inside the shell names its element and its rects", () => {
  const rec = structuredClone(ANSWERS.good);
  rec.inShell[1].cls = 0.0047;
  rec.inShell[1].shifts = [{ at: 490, value: 0.0047, input: false, sources: ["div.tkp-strip 234,50 861x49 -> 548,50 547x49", "div.tkp-idtext 59,59 165x30 -> 59,56 479x37"] }];
  assert.deepEqual(bad(judge(rec).lines), ["BAD desktop inside the shell, 5 link(s): CLS 0.0047 inside the shell [+490ms 0.0047: div.tkp-strip 234,50 861x49 -> 548,50 547x49 | div.tkp-idtext 59,59 165x30 -> 59,56 479x37]"]);
});

test("recorded bad answer: one script without its integrity: FAIL", () => {
  const r = judge(ANSWERS.badIntegrity);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /^BAD \S+\/assets\/index-[\w-]+\.js has no sha384 integrity$/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r.lines).some((l) => l.startsWith("BAD phone / (token): not inside SIGN_HOST's shell") && l.includes("drew nothing")), r.lines.join("\n"));
});

test("planted on the good answer: served bytes that differ from the integrity, an inline script, a missing header: FAIL", () => {
  const mut = (f) => {
    const rec = structuredClone(ANSWERS.good);
    f(rec);
    return judge(rec);
  };
  let r = mut((rec) => (rec.scripts[0].served = "sha384-AAAA"));
  assert.ok(bad(r.lines).some((l) => / integrity differs from the sha384 of the bytes served$/.test(l)));
  r = mut((rec) => rec.scripts.push({ src: "", integrity: "", served: null }));
  assert.ok(bad(r.lines).includes("BAD an inline script"));
  r = mut((rec) => (rec.headers.integrityPolicy = ""));
  assert.match(bad(r.lines)[0], /no Integrity-Policy/);
  r = mut((rec) => rec.loadedScripts.push({ url: `${rec.url}/assets/late.js`, frame: `${rec.url}/`, app: true }));
  assert.ok(bad(r.lines).some((l) => /not a tag: \S+\/assets\/late\.js/.test(l)));
  r = mut((rec) => (rec.loads[3].route = "token"));
  assert.ok(bad(r.lines).some((l) => /drew token/.test(l)));
});

test("scripts: only APP_HOST's documents' count; the shell's are left to SIGN_HOST's own checks", () => {
  const frame = (rec, url, app) => ({ url, frame: app ? `${rec.url}/` : "https://sign.confidential.unrealized.trade/", app });
  const mut = (f) => {
    const rec = structuredClone(ANSWERS.good);
    f(rec);
    return judge(rec);
  };
  // the shell's own script is not a tag of APP_HOST's page: PASS
  let r = mut((rec) => rec.loadedScripts.push(frame(rec, "https://sign.confidential.unrealized.trade/shell.js", false)));
  assert.equal(r.ok, true, r.lines.join("\n"));
  // an untagged script of an APP_HOST document still FAILs
  r = mut((rec) => rec.loadedScripts.push(frame(rec, `${rec.url}/assets/late.js`, true)));
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /not a tag: \S+\/assets\/late\.js/.test(l)), r.lines.join("\n"));
  // the same file loaded by the shell does not hide one from APP_HOST's document
  r = mut((rec) => rec.loadedScripts.push(frame(rec, `${rec.url}/assets/late.js`, false), frame(rec, `${rec.url}/assets/late.js`, true)));
  assert.ok(bad(r.lines).some((l) => /not a tag: \S+\/assets\/late\.js/.test(l)));
  // a record in the old shape (a bare address) or with no app mark counts as APP_HOST's, so it never passes loosely
  r = mut((rec) => rec.loadedScripts.push(`${rec.url}/assets/late.js`));
  assert.ok(bad(r.lines).some((l) => /not a tag: \S+\/assets\/late\.js/.test(l)), r.lines.join("\n"));
  r = mut((rec) => rec.loadedScripts.push({ url: `${rec.url}/assets/late.js` }));
  assert.ok(bad(r.lines).some((l) => /not a tag: \S+\/assets\/late\.js/.test(l)), r.lines.join("\n"));
});

test("planted on the good answer: a console error names the resource that failed (card app-console-429: run 41816576115 said only 'a status of 429')", () => {
  const url = "https://api.confidential.unrealized.trade/v1/market/candles?chain=solana&token=6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN&tf=15m&limit=500";
  const msg = (text, u) => ({ type: () => "error", text: () => text, location: () => ({ url: u }) });
  const failed = consoleError(msg("Failed to load resource: the server responded with a status of 429 ()", url));
  assert.equal(failed, `Failed to load resource: the server responded with a status of 429 () (${url})`);
  assert.equal(consoleError(msg("Uncaught boom", "")), "Uncaught boom", "no address: the text alone");
  assert.equal(consoleError({ text: () => "x", location: () => undefined }), "x");
  const rec = structuredClone(ANSWERS.good);
  rec.loads.find((l) => l.width === "phone" && l.path === "/").consoleErrors.push(failed);
  rec.inShell.find((s) => s.width === "desktop").consoleErrors.push(failed);
  const r = judge(rec);
  assert.equal(r.ok, false);
  const esc = url.replace(/[.?&/]/g, "\\$&");
  assert.ok(bad(r.lines).some((l) => new RegExp(`^BAD phone / \\(token\\): console error: .*status of 429 \\(\\) \\(${esc}\\)$`).test(l)), r.lines.join("\n"));
  assert.ok(bad(r.lines).some((l) => new RegExp(`^BAD desktop inside the shell, 5 link\\(s\\): 0 CSP violation\\(s\\), 1 console error\\(s\\): .*\\(${esc}\\)$`).test(l)), r.lines.join("\n"));
});
