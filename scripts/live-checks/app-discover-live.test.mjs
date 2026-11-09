// node --test scripts/live-checks/app-discover-live.test.mjs: the live check's verdict replays recorded runs
// (app-discover-live.answers.json), each read on 2026-11-01 by app-discover-live.mjs collect() in headless Chromium 153
// from the terminal's build served on 127.0.0.1 under the shipped _headers (APP_HOST has no Discover route deployed yet).
// The page read the helper's real answer from HELPER_HOST: the run passes each GET /v1/market/lists?chain=solana
// through (Playwright route.fetch, Origin APP_HOST) and puts its own origin in Access-Control-Allow-Origin, since
// HELPER_HOST answers APP_HOST's origin only; SIGN_HOST's frame is answered with an empty page, since it refuses a
// 127.0.0.1 parent.
//   good:      the build of this card: Discover ready at both widths, 38 fields a row as read live: PASS;
//   badKeys:   the same build, the helper's answer with every row's sells_1h taken out and a buys_15m put in: FAIL on the
//              keys (the live shape no longer equals the fixtures') and on Trending's 1h buys and sells;
//   notRouted: the build of main before this card (Screen.tsx draws an empty main for /discover): FAIL, nothing drawn and
//              no lists read.
// Screenshot paths are kept as <shots>/<file>.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROW_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";
import { consoleLine } from "./console-errors.mjs";
import { footerUrl } from "../../apps/terminal/src/shell/footer.ts";
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";
import { allowed, APP_HOST, COLUMNS, frameErrors, HELPER_HOST, judge, keysFault, LISTS_URL, parseCsp, WIDTHS } from "./app-discover-live.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-discover-live.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: Discover ready at both widths, rows in every column, the lists read with the fixtures' 38 fields, no violation, requests on the CSP: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines[0], `ok  ${WIDTHS.length} loads of ${WIDTHS.length} (every width)`);
  for (const w of WIDTHS) {
    assert.ok(r.lines.some((l) => new RegExp(`^ok  ${w.name} /discover: ready, new \\d+, trending \\d+, hot \\d+, graduating \\d+; \\d+ request\\(s\\), all on the CSP; no violation, no error$`).test(l)), w.name);
    assert.ok(r.lines.some((l) => new RegExp(`^ok  ${w.name} /discover: the lists read at HELPER_HOST 200, \\d+ rows each with exactly the 38 fields of the fixtures$`).test(l)), w.name);
  }
  assert.equal(ROW_FIELDS.length, 38);
  // the page read the lists from HELPER_HOST, and its own requests include that read
  for (const l of ANSWERS.good.loads) {
    assert.equal(l.lists.url, LISTS_URL);
    assert.ok(l.requests.some((q) => q.url === LISTS_URL && q.type === "fetch"));
    assert.deepEqual(l.columns.map((c) => c.key).sort(), [...COLUMNS].sort());
  }
});

test("recorded bad answer: the helper's rows lose sells_1h and gain buys_15m, so the live shape differs from the fixtures': FAIL", () => {
  const r = judge(ANSWERS.badKeys);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /differ from ROW_FIELDS, first new\[0\]: missing sells_1h; extra buys_15m/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r.lines).some((l) => /desktop \/discover: Trending draws no 1h buys and sells/.test(l)), r.lines.join("\n"));
});

test("recorded bad answer: a build whose /discover route draws an empty main: FAIL", () => {
  const r = judge(ANSWERS.notRouted);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).includes("BAD phone /discover: state none, not ready; 0 of 4 columns read"), r.lines.join("\n"));
  assert.ok(bad(r.lines).includes("BAD phone /discover: the lists read at HELPER_HOST the page read no lists answer"), r.lines.join("\n"));
});

test("planted on the good answer: a CSP violation, a console error, a request off the CSP, a row count that disagrees with its header: FAIL", () => {
  let r = mut((rec) => rec.loads[1].violations.push({ directive: "connect-src", blocked: "https://evil.example" }));
  assert.ok(bad(r.lines).some((l) => /desktop \/discover: CSP violation: connect-src https:\/\/evil\.example/.test(l)), r.lines.join("\n"));
  r = mut((rec) => rec.loads[0].consoleErrors.push("Failed to fetch"));
  assert.ok(bad(r.lines).some((l) => /phone \/discover: console error: Failed to fetch/.test(l)));
  r = mut((rec) => rec.loads[1].requests.push({ url: "https://tracker.example/p.js", type: "script" }));
  assert.ok(bad(r.lines).some((l) => /desktop \/discover: 1 request\(s\) off the CSP: script https:\/\/tracker\.example/.test(l)), r.lines.join("\n"));
  r = mut((rec) => rec.loads[1].requests.push({ url: "https://tracker.example/q", type: "fetch" }));
  assert.ok(bad(r.lines).some((l) => /off the CSP: fetch https:\/\/tracker\.example/.test(l)));
  r = mut((rec) => (rec.loads[1].columns[1].rows = 0));
  assert.ok(bad(r.lines).some((l) => /trending says \d+, draws 0; trending draws no rows/.test(l)), r.lines.join("\n"));
  r = mut((rec) => (rec.loads[0].state = "error"));
  assert.ok(bad(r.lines).some((l) => /phone \/discover: state error, not ready/.test(l)));
  r = mut((rec) => (rec.loads[0].csp = null));
  assert.ok(bad(r.lines).some((l) => /no CSP on Discover's document/.test(l)));
  r = mut((rec) => (rec.loads[1].lists.status = 503));
  assert.ok(bad(r.lines).some((l) => /desktop \/discover: the lists read at HELPER_HOST 503/.test(l)));
  r = mut((rec) => (rec.loads[1].lists.url = "https://other.example/v1/market/lists?chain=solana"));
  assert.ok(bad(r.lines).some((l) => /read https:\/\/other\.example/.test(l)));
  r = mut((rec) => rec.loads.pop());
  assert.ok(bad(r.lines).some((l) => /1 loads of 2/.test(l)));
});

test("framed: Discover found in a frame of another page is judged by its own document's CSP and requests, not the outer page's", () => {
  const r = mut((rec) => {
    for (const l of rec.loads) {
      for (const q of l.requests) q.url = q.url.replace(l.origin, "https://ct-app.unrealized.trade");
      l.framed = true;
      l.origin = "https://ct-app.unrealized.trade";
    }
  });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^ok  phone \/discover \(framed\): ready/.test(l)));
});

test("keysFault: the fixtures' keys exactly, in order", () => {
  const row = Object.fromEntries(ROW_FIELDS.map((f) => [f, null]));
  assert.equal(keysFault(row), null);
  assert.match(keysFault({ ...row, extra: 1 }), /extra extra/);
  const { buys_1h, ...less } = row;
  assert.match(keysFault(less), /missing buys_1h/);
  assert.equal(keysFault({ sells_1h: null, ...row }), "keys in another order");
  assert.equal(keysFault(null), "not an object");
  assert.equal(keysFault([]), "not an object");
});

test("allowed: a request must be on the host its kind of request is allowed to reach", () => {
  const csp = parseCsp("default-src 'none'; script-src 'self'; img-src 'self' data: https://ct-api.unrealized.trade; connect-src 'self' https://ct-api.unrealized.trade wss://ct-api.unrealized.trade; frame-src https://confidential.unrealized.trade");
  const self = "https://ct-app.unrealized.trade";
  assert.equal(allowed(csp, "script", `${self}/assets/index.js`, self), true);
  assert.equal(allowed(csp, "script", "https://ct-api.unrealized.trade/x.js", self), false);
  assert.equal(allowed(csp, "fetch", LISTS_URL, self), true);
  assert.equal(allowed(csp, "fetch", "https://confidential.unrealized.trade/", self), false);
  assert.equal(allowed(csp, "image", "data:image/png;base64,AAAA", self), true);
  assert.equal(allowed(csp, "image", "https://ct-api.unrealized.trade/v1/logo/solana/x", self), true);
  assert.equal(allowed(csp, "image", "https://evil.example/x.png", self), false);
  assert.equal(allowed(csp, "font", `${self}/f.woff2`, self), false, "font-src falls back to default-src 'none'");
  assert.equal(allowed(csp, "document", "https://confidential.unrealized.trade/", self), true);
  assert.equal(allowed(csp, "document", "https://evil.example/", self), false);
});

test("planted on the good answer: a recorded 429 names its resource's origin and path in the BAD line, and an error with no location still fails (card live-console-url)", () => {
  const text = "Failed to load resource: the server responded with a status of 429 ()";
  const kept = frameErrors(
    [
      { text, src: `${HELPER_HOST}/v1/market/lists?chain=solana` },
      { text: "from another site", src: "https://cdn.example/x.js" },
      { text: "Uncaught boom", src: "" },
    ],
    APP_HOST,
  );
  assert.deepEqual(kept, [`${text} (${HELPER_HOST}/v1/market/lists)`, "Uncaught boom"]);
  let r = mut((rec) => rec.loads[0].consoleErrors.push(kept[0]));
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => l.startsWith("BAD phone /discover: console error: ") && l.endsWith(`status of 429 () (${HELPER_HOST}/v1/market/lists)`)), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.includes("chain=solana)")), "no query in a console line");
  r = mut((rec) => rec.loads[1].consoleErrors.push(kept[1]));
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => l === "BAD desktop /discover: console error: Uncaught boom"), r.lines.join("\n"));
});

test("planted on the good answer: Discover's failed footer read of a release NEAR RPC passes only beside a desktop footer showing the pair answered, any other failed load of a release RPC fails (card app-shell-rpc-outage-judge)", () => {
  const near = new URL(VERIFY_RELEASES.mainnet.rpcs[0]).origin;
  const cors = (url) => consoleLine(`Access to fetch at '${url}' from origin '${APP_HOST}' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: It does not have HTTP ok status.`, `${APP_HOST}/`);
  const tagged = cors(footerUrl(VERIFY_RELEASES.mainnet.rpcs[0]));
  assert.ok(tagged.endsWith(" [footer read]"));
  const on = { conn: "on", block: "223500000", ms: 5000 };
  const plant = (errors, footer, width = "desktop") => {
    return bad(mut((rec) => {
      const x = rec.loads.find((l) => l.width === width);
      x.consoleErrors.push(...errors);
      x.footer = footer;
    }).lines);
  };
  assert.deepEqual(plant([tagged], on), []);
  assert.match(plant([tagged], { ...on, conn: "off" }).join("\n"), /a footer read, and the footer shows off/);
  assert.match(plant([tagged], null).join("\n"), /a footer read, and /);
  assert.match(plant([tagged], { conn: "wait", block: "", ms: 5000 }, "phone").join("\n"), /a footer read, and the footer shows wait/);
  assert.match(plant([cors(`${near}/`)], on).join("\n"), /is a release RPC, not shown Unverified: code not drawn/);
  assert.match(plant([tagged, "Uncaught boom"], on).join("\n"), /Uncaught boom/);
});
