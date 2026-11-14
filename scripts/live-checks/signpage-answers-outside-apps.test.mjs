// node --test scripts/live-checks/signpage-answers-outside-apps.test.mjs: card signpage-answers-outside-apps' live check,
// replayed. signpage-answers-outside-apps.answers.json, each built from one live read of SIGN_HOST on 14 Nov (/ and
// /connect, both the 382-byte index under the site's CSP and COOP same-origin):
//   good: that read with /connect served COOP unsafe-none, as this card's _headers rule serves it: PASS;
//   bad:  the read as it was, before the /connect rule (/connect COOP same-origin); the /connect COOP joined to /*'s by a
//         comma (no detach); /connect without frame-ancestors; / served COOP unsafe-none: each FAIL on its own line.
// The real public/_headers' /connect rule is held to CONNECT_COOP.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CONNECT_COOP, CONNECT_PATH, judge, read, SITE_COOP } from "./signpage-answers-outside-apps.mjs";
import { SIGN } from "./signpage-skeleton.mjs";
import { SIGN_PKG } from "../signpage-built.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-answers-outside-apps.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const C = CONNECT_PATH;

test("the recorded good run passes: / COOP same-origin, /connect unsafe-none, one CSP framed by none on both, the same index", () => {
  const r = judge(A.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 10);
});

test("each recorded bad run fails, on its own line", () => {
  const want = {
    "connect COOP same-origin (live before this card)": [`BAD ${C} COOP: "${SITE_COOP}", want "${CONNECT_COOP}"`],
    "missing detach": [`BAD ${C} COOP: "${SITE_COOP}, ${CONNECT_COOP}", want "${CONNECT_COOP}" (two joined by a comma: the rule sets it without detaching the site's)`],
    "connect frame-ancestors missing": [`BAD ${C} frame-ancestors: none, want "'none'"`, `BAD ${C} CSP is not /'s`],
    "site COOP unsafe-none": [`BAD / COOP: "${CONNECT_COOP}", want "${SITE_COOP}"`],
  };
  assert.deepEqual(Object.keys(A.bad).sort(), Object.keys(want).sort());
  for (const [name, rec] of Object.entries(A.bad)) {
    const r = judge(rec);
    assert.equal(r.pass, false, name);
    assert.deepEqual(bad(r), want[name], name);
  }
});

test("planted on the good run: /connect not the index, a 404, no COOP, no CSP, a CSP joined on, / framed or framing more: each FAIL", () => {
  const plant = (f) => {
    const rec = structuredClone(A.good);
    f(rec.answers["/"], rec.answers[C]);
    return judge(rec);
  };
  assert.ok(bad(plant((_, c) => (c.sha256 = "0".repeat(64)))).some((l) => l.includes("not /'s body")));
  assert.ok(bad(plant((_, c) => Object.assign(c, { status: 404, type: "text/plain" }))).some((l) => l.startsWith(`BAD ${C}: 404`)));
  assert.ok(bad(plant((_, c) => (c.coop = null))).includes(`BAD ${C} COOP: none, want "${CONNECT_COOP}"`));
  assert.ok(bad(plant((_, c) => (c.coop = "same-origin-allow-popups"))).includes(`BAD ${C} COOP: "same-origin-allow-popups", want "${CONNECT_COOP}"`));
  assert.ok(bad(plant((_, c) => (c.csp = null))).includes(`BAD ${C} CSP: none sent`));
  assert.ok(bad(plant((_, c) => (c.csp = `${c.csp}, frame-ancestors *`))).includes(`BAD ${C} CSP is one policy: two joined by a comma`));
  assert.ok(bad(plant((s, c) => (s.csp = c.csp = s.csp.replace("frame-ancestors 'none'", "frame-ancestors *")))).includes(`BAD / frame-ancestors: "*", want "'none'"`));
  assert.ok(bad(plant((s, c) => (s.csp = c.csp = s.csp.replace("frame-src https://ct-app.unrealized.trade", "frame-src https:")))).some((l) => l.startsWith("BAD / frame-src:")));
  assert.equal(plant(() => {}).pass, true);
});

test("the real public/_headers' /connect rule detaches COOP and sets CONNECT_COOP, after /*", () => {
  const text = readFileSync(path.join(SIGN_PKG, "public", "_headers"), "utf8");
  const rule = `\n${C}\n  ! Cross-Origin-Opener-Policy\n  Cross-Origin-Opener-Policy: ${CONNECT_COOP}\n`;
  assert.ok(text.includes(rule), "no /connect rule as written");
  assert.ok(text.indexOf(rule) > text.indexOf("\n/*\n"));
  assert.match(text, new RegExp(`\\n/\\*\\n(?:  .*\\n)*?  Cross-Origin-Opener-Policy: ${SITE_COOP}\\n`));
});

test("the read asks SIGN_HOST's / and /connect, keeping each header as fetch joins it", async () => {
  const site = A.good.answers["/"];
  const asked = [];
  const f = async (url) => {
    asked.push(url);
    const h = new Headers({ "content-type": "text/html; charset=utf-8", "content-security-policy": site.csp, "cross-origin-opener-policy": SITE_COOP });
    if (url.endsWith(C)) h.append("cross-origin-opener-policy", CONNECT_COOP);
    return new Response("<!doctype html><title>x</title>", { status: 200, headers: h });
  };
  const rec = await read(f);
  assert.deepEqual(asked, [`${SIGN}/`, `${SIGN}${C}`]);
  assert.equal(rec.answers[C].coop, `${SITE_COOP}, ${CONNECT_COOP}`);
  assert.deepEqual(bad(judge(rec)), [`BAD ${C} COOP: "${SITE_COOP}, ${CONNECT_COOP}", want "${CONNECT_COOP}" (two joined by a comma: the rule sets it without detaching the site's)`]);
});
