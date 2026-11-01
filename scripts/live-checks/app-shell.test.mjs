// node --test scripts/live-checks/app-shell.test.mjs: the live check's verdict replays recorded runs
// (app-shell.answers.json), each read on 2026-11-01 by app-shell.mjs --record in headless Chromium 153 from the shell's
// build on 127.0.0.1, before APP_HOST's first deploy:
//   good:         the build with app-host-gate's _headers (card/app-host-gate d889fb4), served by wrangler 4.151.1
//                 pages dev: PASS;
//   badCls:       the same build with a 120 px banner put above the shell 1 s after load, served with the same policy
//                 (app.md:636-649) by a plain Node server: FAIL on CLS (the phone's 0.1422; the desktop's shift stays
//                 under 0.1);
//   badIntegrity: the same build with the script tag's integrity taken out, served the same way: FAIL on the
//                 integrity (Integrity-Policy then blocks the script, so no route draws).
// Screenshot paths are kept as <shots>/<file>.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, ROUTES, WIDTHS } from "./app-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-shell.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer: every route at both widths, integrity equal, CLS 0, no violation: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], /^ok  served with a CSP and an Integrity-Policy: CSP, Integrity-Policy blocked-destinations=\(script\)$/);
  assert.ok(r.lines.some((l) => /^ok  \S+\/assets\/index-[\w-]+\.js integrity equals the sha384 of the bytes served$/.test(l)));
  assert.ok(r.lines.includes(`ok  ${ROUTES.length * WIDTHS.length} loads of ${ROUTES.length * WIDTHS.length} (every route at both widths)`));
  for (const w of WIDTHS) for (const [id, p] of ROUTES) assert.ok(r.lines.includes(`ok  ${w.name} ${p} (${id}): CLS 0.0000, no violation, no error`), `${w.name} ${p}`);
  assert.ok(r.lines.some((l) => /^ok  phone inside the shell, 4 link\(s\): CLS 0, no reload$/.test(l)));
  assert.ok(r.lines.some((l) => /^ok  desktop inside the shell, 6 link\(s\): CLS 0, no reload$/.test(l)));
});

test("recorded bad answer: a late banner moves the layout, CLS above 0.1: FAIL", () => {
  const r = judge(ANSWERS.badCls);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.length > 0);
  assert.ok(b.every((l) => /CLS \d\.\d{4} (above 0\.1|inside the shell)/.test(l)), b.join("\n"));
  assert.ok(b.some((l) => /^BAD phone \/ \(token\): CLS 0\.1422 above 0\.1$/.test(l)), b.join("\n"));
});

test("recorded bad answer: one script without its integrity: FAIL", () => {
  const r = judge(ANSWERS.badIntegrity);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /^BAD \S+\/assets\/index-[\w-]+\.js has no sha384 integrity$/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r.lines).includes("BAD phone / (token): drew nothing"));
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
  r = mut((rec) => rec.loadedScripts.push({ url: `${rec.url}/assets/late.js`, frame: `${rec.url}/`, top: true }));
  assert.ok(bad(r.lines).some((l) => /not a tag: \S+\/assets\/late\.js/.test(l)));
  r = mut((rec) => (rec.loads[3].route = "token"));
  assert.ok(bad(r.lines).some((l) => /drew token/.test(l)));
});

test("scripts: only the top frame's count; the signing page's frame is left to SIGN_HOST's own checks", () => {
  const frame = (rec, url, top) => ({ url, frame: top ? `${rec.url}/` : "https://sign.confidential.unrealized.trade/", top });
  const mut = (f) => {
    const rec = structuredClone(ANSWERS.good);
    f(rec);
    return judge(rec);
  };
  // the hidden SIGN_HOST iframe's own script is not a tag of APP_HOST's page: PASS
  let r = mut((rec) => rec.loadedScripts.push(frame(rec, "https://sign.confidential.unrealized.trade/app.js", false)));
  assert.equal(r.ok, true, r.lines.join("\n"));
  // an untagged script of APP_HOST's own top frame still FAILs
  r = mut((rec) => rec.loadedScripts.push(frame(rec, `${rec.url}/assets/late.js`, true)));
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /not a tag: \S+\/assets\/late\.js/.test(l)), r.lines.join("\n"));
  // the same file loaded by the iframe does not hide one from the top frame
  r = mut((rec) => rec.loadedScripts.push(frame(rec, `${rec.url}/assets/late.js`, false), frame(rec, `${rec.url}/assets/late.js`, true)));
  assert.ok(bad(r.lines).some((l) => /not a tag: \S+\/assets\/late\.js/.test(l)));
});
