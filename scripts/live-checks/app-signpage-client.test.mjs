// node --test scripts/live-checks/app-signpage-client.test.mjs: the live check's verdict replays recorded runs
// (app-signpage-client.answers.json), each read on 2026-11-01 by app-signpage-client.mjs --record in headless
// Chromium 153 on the owner's PC box (scripts/heavy.sh):
//   good:      --harness, the review round 2 build (ef8d248): the terminal's build at APP_HOST and a test frame that
//              speaks the frozen ready and state shapes at SIGN_HOST, the real names mapped to the app's browser
//              harness, each under its own _headers: PASS (READY in about 105 ms; down at about 5,090 ms when blocked;
//              READY again about 9,700 ms after SIGN_HOST is let through, with no reload);
//   badSilent: --harness --silent, the same build with SIGN_HOST's real page (no script yet, so no ready): FAIL on READY;
//   badLive:   the live APP_HOST before this card's deploy (no iframe at all): FAIL on the iframe, READY and down.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, WIDTHS } from "./app-signpage-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-signpage-client.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer: the hidden iframe, READY within 5 s, down when blocked, back with no reload: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const w of WIDTHS) {
    for (const kind of ["served", "blocked"]) {
      assert.ok(r.lines.includes(`ok  ${w.name} ${kind}: 1 iframe(s), src https://sign.confidential.unrealized.trade/, the hidden iframe's attributes`), `${w.name} ${kind}`);
    }
    assert.ok(r.lines.some((l) => new RegExp(`^ok  ${w.name} served: READY at \\d+ ms, limit 5000 ms$`).test(l)));
    assert.ok(r.lines.includes(`ok  ${w.name} served: no CSP violation, no console error`));
    assert.ok(r.lines.some((l) => new RegExp(`^ok  ${w.name} blocked: down at 5\\d{3} ms, limit 6500 ms$`).test(l)));
    assert.ok(r.lines.includes(`ok  ${w.name} blocked: the down toast shows ("Couldn't load. Your funds are safe.Retry")`));
    assert.ok(r.lines.some((l) => new RegExp(`^ok  ${w.name} blocked: SIGN_HOST let through, READY again \\d+ ms later, no reload, limit 15000 ms$`).test(l)));
  }
});

test("recorded bad answer: SIGN_HOST's page posts no ready: FAIL on READY only", () => {
  const r = judge(ANSWERS.badSilent);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.deepEqual(b, [
    "BAD phone served: READY never (last state down), limit 5000 ms",
    "BAD phone blocked: SIGN_HOST let through, READY again never, no reload, limit 15000 ms",
    "BAD desktop served: READY never (last state down), limit 5000 ms",
    "BAD desktop blocked: SIGN_HOST let through, READY again never, no reload, limit 15000 ms",
  ]);
});

test("recorded bad answer: an APP_HOST with no iframe: FAIL", () => {
  const r = judge(ANSWERS.badLive);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  for (const w of WIDTHS) {
    assert.ok(b.includes(`BAD ${w.name} served: 0 iframe(s)`));
    assert.ok(b.includes(`BAD ${w.name} blocked: the down toast does not show`));
  }
});

test("planted cases: a wrong attribute, an extra attribute, a query on the src, a slow READY and a reload each FAIL", () => {
  const g = ANSWERS.good;
  const plant = (f) => {
    const rec = structuredClone(g);
    f(rec.runs.find((x) => x.width === "phone" && x.kind === "served"), rec.runs.find((x) => x.width === "phone" && x.kind === "blocked"));
    return judge(rec);
  };
  const cases = [
    ["sandbox gains allow-top-navigation", (s) => (s.frames[0].attrs.sandbox += " allow-top-navigation"), /wrong sandbox/],
    ["an allow attribute delegating passkeys", (s) => (s.frames[0].attrs.allow = "publickey-credentials-get"), /wrong allow/],
    ["an extra attribute", (s) => (s.frames[0].attrs.name = "x"), /extra name/],
    ["a query on the src", (s) => (s.frames[0].src += "?flow=deposit"), /src https:\/\/sign\.confidential\.unrealized\.trade\/\?flow=deposit/],
    ["READY at 5,001 ms", (s) => (s.timeline.find((e) => e.s === "ready").t = 5_001), /READY at 5001 ms/],
    ["a CSP violation", (s) => s.violations.push({ directive: "frame-src", blocked: "https://sign.confidential.unrealized.trade/" }), /CSP frame-src/],
    ["a reload to recover", (_s, b) => (b.reloaded = true), /after a reload/],
  ];
  for (const [name, f, re] of cases) {
    const r = plant(f);
    assert.equal(r.ok, false, name);
    assert.ok(bad(r.lines).some((l) => re.test(l)), `${name}: ${bad(r.lines).join("; ")}`);
  }
});
