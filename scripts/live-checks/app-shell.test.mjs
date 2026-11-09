// node --test scripts/live-checks/app-shell.test.mjs: the live check's verdict replays recorded runs
// (app-shell.answers.json), the hosts' real names answered by route (APP_HOST: a terminal build under its own _headers;
// SIGN_HOST: app-in-shell's stand-in shell):
//   good:         card app-shell-rpc-outage-judge's build, read on 2026-11-08 by apps/terminal/test/bar10/run.mjs --record
//                 (its answers-at-once pass: the helper's reads answered, signed in) in Chrome 157 on the Mac, re-recorded
//                 from this card's code (the Verify panel's rows read from its DOM): every load inside the shell, every
//                 phone load at CLS 0, no failed load: PASS;
// the two bad answers read on 2026-11-01 by app-shell.mjs --harness --record in headless Chromium 153 on the Mac:
//   bad:          main cf7b85a's build, before app-in-shell: APP_HOST stays top-level and frames SIGN_HOST, which the
//                 shell's frame-ancestors 'none' refuses: FAIL on every load;
//   badIntegrity: app-in-shell's build with the script tag's integrity taken out: FAIL on the integrity
//                 (Integrity-Policy then blocks the script, so nothing moves to the shell and no route draws).
// Layout shifts are planted on the good answer: any shift on a load at either width fails, as BAR-10's 0.0806 phone tab
// bar and 0.0008 Verify reads did (card app-shell-tabbar-cls).
// Card app-shell-rpc-outage-judge: three more real harness runs (bar10/run.mjs --record --outage ...), the good answer
// re-recorded by the same code:
//   outage:           Solana's first RPC answering every request 503 (--outage solana): the page logs the failed loads and
//                     draws the Solana row amber, every other row ok: PASS, the outage let through;
//   outageFooter:     the first NEAR RPC answering the footer's block reads 503 and the second answering them (--outage
//                     footer): the footer shows Stable with its block, the page logs a failed footer read on every desktop
//                     route while Verify's rows stay ok: PASS, the footer's failed read let through;
//   outageFooterPair: both NEAR RPCs answering the footer's block reads 503 (--outage footer-pair): the footer shows
//                     Offline: FAIL on every desktop route, a double outage failing closed.
// The other cases plant one fact on these answers. No RPC host is typed here: each is read from VERIFY_RELEASES.
// Screenshot paths are kept as <shots>/<file>, a build's path as <build>.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { consoleLine } from "./console-errors.mjs";
import { footerUrl, FOOTER_QUERY } from "../../apps/terminal/src/shell/footer.ts";
import { judge, onConsole, outages, rpcRows, ROUTES, WIDTHS } from "./app-shell.mjs";
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";

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
    for (const [id, p] of ROUTES) assert.ok(bad(r.lines).some((l) => l.startsWith(`BAD ${w.name} ${p} (${id}): not inside SIGN_HOST's shell (top window at https://ct-app.unrealized.trade${p})`)), `${w.name} ${p}`);
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
  const frame = (rec, url, app) => ({ url, frame: app ? `${rec.url}/` : "https://confidential.unrealized.trade/", app });
  const mut = (f) => {
    const rec = structuredClone(ANSWERS.good);
    f(rec);
    return judge(rec);
  };
  // the shell's own script is not a tag of APP_HOST's page: PASS
  let r = mut((rec) => rec.loadedScripts.push(frame(rec, "https://confidential.unrealized.trade/shell.js", false)));
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

test("planted on the good answer: a console error names the resource that failed, its origin and path with no query (cards app-console-429, live-console-url: run 41816576115 said only 'a status of 429')", () => {
  const url = "https://ct-api.unrealized.trade/v1/market/candles?chain=solana&token=6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN&tf=15m&limit=500";
  const at = "https://ct-api.unrealized.trade/v1/market/candles";
  const msg = (text, location) => ({ type: () => "error", text: () => text, location: () => location });
  const kept = [];
  const hook = onConsole(kept);
  hook(msg("Failed to load resource: the server responded with a status of 429 ()", { url }));
  hook(msg("from the shell", { url: "https://confidential.unrealized.trade/assets/shell.js" }));
  hook({ type: () => "warning", text: () => "a warning", location: () => ({ url }) });
  hook(msg("Uncaught boom", { url: "" }));
  hook(msg("Uncaught bang", undefined));
  assert.deepEqual(kept, [`Failed to load resource: the server responded with a status of 429 () (${at})`, "Uncaught boom", "Uncaught bang"]);
  const rec = structuredClone(ANSWERS.good);
  rec.loads.find((l) => l.width === "phone" && l.path === "/").consoleErrors.push(kept[0]);
  rec.inShell.find((s) => s.width === "desktop").consoleErrors.push(kept[0]);
  const r = judge(rec);
  assert.equal(r.ok, false);
  const esc = at.replace(/[.?&/]/g, "\\$&");
  assert.ok(bad(r.lines).some((l) => new RegExp(`^BAD phone / \\(token\\): console error: .*status of 429 \\(\\) \\(${esc}\\)$`).test(l)), r.lines.join("\n"));
  assert.ok(bad(r.lines).some((l) => new RegExp(`^BAD desktop inside the shell, 5 link\\(s\\): 0 CSP violation\\(s\\), 1 console error\\(s\\): .*\\(${esc}\\)$`).test(l)), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.includes("chain=solana")), "no query in any line");
});

test("planted on the good answer: an error with no location still fails the check (card live-console-url)", () => {
  const rec = structuredClone(ANSWERS.good);
  rec.loads.find((l) => l.width === "desktop" && l.path === "/").consoleErrors.push("Uncaught boom");
  const r = judge(rec);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /^BAD desktop \/ \(token\): console error: Uncaught boom$/.test(l)), r.lines.join("\n"));
});

// ------------------------------------------------------------------------------------------------ an RPC outage
const originOfUrl = (u) => new URL(u).origin;
const SOLANA = originOfUrl(VERIFY_RELEASES.mainnet.pools.solana.rpcs[0]);
const BASE = originOfUrl(VERIFY_RELEASES.mainnet.pools.base.rpcs[0]);
const NEAR = originOfUrl(VERIFY_RELEASES.mainnet.rpcs[0]);
const failed = (origin, reason = "net::ERR_FAILED") => `Failed to load resource: ${reason} (${origin}/)`;
const outage = () => structuredClone(ANSWERS.outage);
const verifyLoad = (rec, width) => rec.loads.find((l) => l.width === width && l.path === "/verify");

test("rpcRows: every RPC origin the release names, read from VERIFY_RELEASES, each to the rows that read it", () => {
  const rows = rpcRows("mainnet");
  const r = VERIFY_RELEASES.mainnet;
  const want = new Set([...r.rpcs, ...Object.values(r.pools).flatMap((p) => p.rpcs)].map(originOfUrl));
  assert.deepEqual([...rows.keys()].sort(), [...want].sort());
  assert.deepEqual(rows.get(NEAR), ["code", "funds"]);
  assert.deepEqual(rows.get(SOLANA), ["solana"]);
  assert.equal(rows.get("https://ct-api.unrealized.trade"), undefined);
  // a network the release does not have names none; testnet names its NEAR pair and no pool
  assert.equal(rpcRows("nowhere").size, 0);
  assert.deepEqual([...rpcRows("testnet").keys()].sort(), VERIFY_RELEASES.testnet.rpcs.map(originOfUrl).sort());
});

test("recorded outage answer: one pool RPC answering 503, its row amber, every other row ok: PASS", () => {
  const r = judge(ANSWERS.outage);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) {
    const l = verifyLoad(ANSWERS.outage, w);
    // the run made the outage: the page logged the failed loads, and drew only the Solana row amber
    assert.ok(l.consoleErrors.length > 0 && l.consoleErrors.every((e) => e.startsWith("Failed to load resource: ") && e.endsWith(`(${SOLANA}/)`)), `${w}: ${l.consoleErrors}`);
    assert.deepEqual(l.verify, { state: "read", code: "ok", funds: "ok", pools: { solana: "warn", base: "ok", robinhood: "ok" } });
    assert.ok(r.lines.some((x) => x.startsWith(`ok  ${w} /verify (verify): CLS`) && x.endsWith(`RPC down, shown: ${SOLANA.replace("https://", "")}`)), `${w}: ${r.lines.join("\n")}`);
  }
});

test("planted on the outage answer: a failed load of an origin the release does not name fails", () => {
  for (const [name, line] of [
    ["a made-up RPC", failed("https://rpc.example.org")],
    ["our own helper", failed("https://ct-api.unrealized.trade", "the server responded with a status of 503 ()")],
    ["the release's host on another scheme or port", failed(`${SOLANA.replace("https://", "http://")}`)],
    ["the release's host with another port", failed(`${SOLANA}:8443`)],
  ]) {
    const rec = outage();
    verifyLoad(rec, "desktop").consoleErrors.push(line);
    const b = judge(rec).lines.filter((l) => l.startsWith("BAD"));
    assert.equal(b.length, 1, name);
    assert.ok(b[0].startsWith("BAD desktop /verify (verify): console error: ") && b[0].endsWith(line), `${name}: ${b[0]}`);
    assert.ok(!b[0].includes("is a release RPC"), name);
  }
});

test("planted on the outage answer: a page error beside the outage fails, and the outage itself is still let through", () => {
  const rec = outage();
  verifyLoad(rec, "phone").consoleErrors.push("TypeError: Cannot read properties of undefined (reading 'rows')");
  const r = judge(rec);
  assert.equal(r.ok, false);
  const b = r.lines.filter((l) => l.startsWith("BAD"));
  assert.deepEqual(b, ["BAD phone /verify (verify): console error: TypeError: Cannot read properties of undefined (reading 'rows')"]);
  // a console error from the app beside a failed load of a release RPC is no failed load: it is never let through
  const rec2 = outage();
  verifyLoad(rec2, "desktop").consoleErrors.push("Verify read no head on https://a or https://b");
  assert.deepEqual(judge(rec2).lines.filter((l) => l.startsWith("BAD")), ["BAD desktop /verify (verify): console error: Verify read no head on https://a or https://b"]);
});

test("recorded outage-footer answer: the first NEAR RPC fails the footer's reads, the footer shows Stable with its block: PASS, on every desktop route", () => {
  const r = judge(ANSWERS.outageFooter);
  assert.equal(r.ok, true, r.lines.join("\n"));
  const desk = ANSWERS.outageFooter.loads.filter((l) => l.width === "desktop");
  assert.equal(desk.length, ROUTES.length);
  for (const l of desk) {
    // the run made the outage on every route (the footer reads on each), tagged as the footer's own, and the footer drew the pair answered
    assert.ok(l.consoleErrors.length > 0 && l.consoleErrors.every((e) => e.endsWith(`(${NEAR}/) [footer read]`)), `${l.path}: ${l.consoleErrors}`);
    assert.equal(l.footer.conn, "on");
    assert.match(l.footer.block, /^\d+$/);
  }
  // Verify's rows stay ok on /verify: only the footer's reads failed
  assert.deepEqual(verifyLoad(ANSWERS.outageFooter, "desktop").verify, { state: "read", code: "ok", funds: "ok", pools: { solana: "ok", base: "ok", robinhood: "ok" } });
  assert.ok(r.lines.some((l) => l.startsWith("ok  desktop /discover (discover): CLS") && l.endsWith(`RPC down, shown: ${NEAR.replace("https://", "")}`)), r.lines.join("\n"));
});

test("recorded outage-footer-pair answer: both NEAR RPCs fail the footer's reads and it shows Offline: FAIL on every desktop route, none on the phone", () => {
  const r = judge(ANSWERS.outageFooterPair);
  assert.equal(r.ok, false);
  const b = r.lines.filter((l) => l.startsWith("BAD"));
  for (const [id, p] of ROUTES) assert.ok(b.some((l) => l.startsWith(`BAD desktop ${p} (${id}): console error: Failed to load resource: `) && l.includes("[footer read] [") && l.includes("is a release RPC, and every RPC of its pair failed a load]")), `${p}: ${b.join("\n")}`);
  assert.ok(b.every((l) => l.startsWith("BAD desktop")), b.join("\n"));
  assert.equal(ANSWERS.outageFooterPair.loads.find((l) => l.width === "desktop").footer.conn, "off");
});

test("planted on the outage-footer answer: a footer read failing while the footer does not show the pair answered fails", () => {
  const plant = (f) => {
    const rec = structuredClone(ANSWERS.outageFooter);
    for (const l of rec.loads.filter((x) => x.width === "desktop")) f(l.footer);
    return judge(rec).lines.filter((l) => l.startsWith("BAD"));
  };
  for (const [name, f, shows] of [
    ["offline", (x) => (x.conn = "off"), "off, block"],
    ["still waiting", (x) => (x.conn = "wait"), "wait, block"],
    ["no block drawn", (x) => (x.block = ""), "on, block not drawn"],
    ["no connection", (x) => (x.conn = null), "no connection, block"],
  ]) {
    const b = plant(f);
    assert.equal(b.length, ROUTES.length, name);
    assert.ok(b.some((l) => l.startsWith("BAD desktop /discover (discover): console error: ") && l.includes(`a footer read, and the footer shows ${shows}`)), `${name}: ${b[0]}`);
  }
  // no footer in the DOM at all
  const rec = structuredClone(ANSWERS.outageFooter);
  rec.loads.find((l) => l.width === "desktop" && l.path === "/privacy").footer = null;
  assert.match(judge(rec).lines.find((l) => l.startsWith("BAD")), /^BAD desktop \/privacy \(privacy\): .*the footer shows not drawn, not the pair answered\]$/);
});

test("planted on the outage-footer answer: a failed load of the same origin that is not the footer's, on a route that is not Verify, fails", () => {
  const rec = structuredClone(ANSWERS.outageFooter);
  const orders = rec.loads.find((l) => l.width === "desktop" && l.path === "/orders");
  orders.consoleErrors = [failed(NEAR, "the server responded with a status of 503 ()")];
  const b = judge(rec).lines.filter((l) => l.startsWith("BAD"));
  assert.deepEqual(b, [`BAD desktop /orders (orders): console error: ${failed(NEAR, "the server responded with a status of 503 ()")} [${NEAR} is a release RPC, not shown Unverified: code not drawn, funds not drawn]`]);
  // and on Verify itself, with its rows ok: an untagged failed load of a NEAR RPC is a Verify read that failed and was not shown
  const v = structuredClone(ANSWERS.outageFooter);
  verifyLoad(v, "desktop").consoleErrors = [failed(NEAR)];
  assert.match(judge(v).lines.find((l) => l.startsWith("BAD")), /^BAD desktop \/verify \(verify\): .*not shown Unverified: code ok, funds ok\]$/);
});

test("planted on the outage-footer answer: both NEAR RPCs failing a footer read in one load fails, as does a footer read of a pool's RPC", () => {
  const other = [...rpcRows("mainnet").entries()].find(([o, r]) => o !== NEAR && r.includes("code"))[0];
  const rec = structuredClone(ANSWERS.outageFooter);
  rec.loads.find((l) => l.width === "desktop" && l.path === "/terms").consoleErrors.push(`${failed(other)} [footer read]`);
  const b = judge(rec).lines.filter((l) => l.startsWith("BAD"));
  assert.equal(b.length, 1, b.join("\n"));
  assert.ok(b[0].startsWith("BAD desktop /terms (terms): ") && b[0].includes("every RPC of its pair failed a load"), b[0]);
  // a footer read tagged on a pool's RPC is no footer read of the release: it is judged as a Verify read, by its row
  const p = structuredClone(ANSWERS.outageFooter);
  p.loads.find((l) => l.width === "desktop" && l.path === "/terms").consoleErrors.push(`${failed(SOLANA)} [footer read]`);
  assert.match(judge(p).lines.find((l) => l.startsWith("BAD")), /^BAD desktop \/terms \(terms\): .*not shown Unverified: solana not drawn\]$/);
});

test("the footer's own request carries the tag the collector reads: footerUrl is tagged, a Verify read of the same RPC is not", () => {
  const line = (url) => consoleLine("Failed to load resource: net::ERR_FAILED", url);
  const [first] = VERIFY_RELEASES.mainnet.rpcs;
  assert.equal(line(footerUrl(first)), `Failed to load resource: net::ERR_FAILED (${first}/) [footer read]`);
  assert.equal(line(first), `Failed to load resource: net::ERR_FAILED (${first}/)`);
  assert.ok(footerUrl(first).endsWith(`?${FOOTER_QUERY}`));
  // the preflight line names the address in its text: tagged the same
  const cors = (url) => consoleLine(`Access to fetch at '${url}' from origin 'https://ct-app.unrealized.trade' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: It does not have HTTP ok status.`, "https://ct-app.unrealized.trade/");
  assert.ok(cors(footerUrl(first)).endsWith(" [footer read]"));
  assert.ok(!cors(first).endsWith(" [footer read]"));
});

test("planted on the outage answer: the outage shown as verified, as loading or not drawn at all fails, naming what the page shows", () => {
  const shown = (f) => {
    const rec = outage();
    f(verifyLoad(rec, "phone"));
    return judge(rec).lines.filter((l) => l.startsWith("BAD"));
  };
  let b = shown((l) => (l.verify.pools.solana = "ok"));
  assert.equal(b.length, 1);
  assert.ok(b[0].startsWith("BAD phone /verify (verify): console error: Failed to load resource: ") && b[0].includes(`[${SOLANA} is a release RPC, not shown Unverified: solana ok]`), b[0]);
  b = shown((l) => (l.verify.pools.solana = "danger"));
  assert.ok(b[0].includes("solana danger]"), b[0]);
  b = shown((l) => (l.verify.pools.solana = "loading"));
  assert.ok(b[0].includes("solana loading]"), b[0]);
  b = shown((l) => (l.verify = null));
  assert.ok(b[0].includes("solana not drawn]"), b[0]);
  // a load that never drew the panel (any other route) lets nothing through
  b = shown((l) => ((l.verify = null), (l.expect = "discover")));
  assert.ok(b[0].includes("solana not drawn]"), b[0]);
});

test("a failed load is let through only for Chrome's own failed-load lines of 5xx, 429 and a network refusal, never a block or a 4xx", () => {
  const lines = (...ls) => outages(ls, { state: "read", code: "warn", funds: "warn", pools: { solana: "warn", base: "warn", robinhood: "warn" } });
  const status = (n) => failed(BASE, `the server responded with a status of ${n} ()`);
  // let through: a status of 5xx or 429, and each network refusal Chrome names
  assert.deepEqual(lines(status(503), status(500), status(429), failed(BASE, "net::ERR_CONNECTION_REFUSED"), failed(BASE, "net::ERR_NAME_NOT_RESOLVED"), failed(BASE, "net::ERR_TIMED_OUT")).kept, []);
  assert.deepEqual(lines(status(503)).down, [BASE]);
  // kept: a 4xx, a block by the CSP or the browser, an ordinary error that only names the release's host, no address
  for (const l of [status(403), status(404), failed(BASE, "net::ERR_BLOCKED_BY_CSP"), failed(BASE, "net::ERR_BLOCKED_BY_ORB"), failed(BASE, "net::ERR_BLOCKED_BY_CLIENT"), `Access to fetch at '${BASE}/' has been blocked by CORS policy`, `Error: ${BASE} said no (${BASE}/x.js)`, "Failed to load resource: net::ERR_FAILED"]) {
    assert.deepEqual(lines(l).kept.length, 1, l);
    assert.deepEqual(lines(l).down, [], l);
  }
});

test("the NEAR pair feeds the Code and Funds rows: both must show amber, not one", () => {
  const near = (code, funds) => outages([failed(NEAR)], { state: "read", code, funds, pools: {} });
  assert.deepEqual(near("warn", "warn").kept, []);
  assert.equal(near("warn", "ok").kept.length, 1);
  assert.equal(near("ok", "warn").kept.length, 1);
  assert.match(near("ok", "ok").kept[0], new RegExp(`\\[${NEAR.replace(/\./g, "\\.")} is a release RPC, not shown Unverified: code ok, funds ok\\]$`));
});

test("a down RPC's preflight: Chrome's CORS line names the failed address in its text, located at the page; it is let through on the same terms", () => {
  // the two texts Chrome wrote on 8 Nov for a POST of JSON to a server answering 503 or 429 to the preflight, with the
  // header (the status refused) and without it, kept through the collector as the check keeps them
  const page = "https://ct-app.unrealized.trade/verify";
  const cors = (url, why) => consoleLine(`Access to fetch at '${url}?s=503&c=' from origin 'https://ct-app.unrealized.trade' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: ${why}`, page);
  const down = { state: "read", code: "warn", funds: "warn", pools: { solana: "warn", base: "warn", robinhood: "warn" } };
  const okRows = { ...down, pools: { ...down.pools, base: "ok" } };
  const status = cors(`${BASE}/`, "It does not have HTTP ok status.");
  const noHeader = cors(`${BASE}/`, "No 'Access-Control-Allow-Origin' header is present on the requested resource.");
  assert.ok(!status.includes("?s=503"), "no query in the line");
  for (const line of [status, noHeader]) {
    assert.deepEqual(outages([line], down), { kept: [], down: [BASE], refused: [], verifyDown: [BASE] }, line);
    // shown ok: refused; an origin the release does not name: kept as any other error
    assert.equal(outages([line], okRows).refused.length, 1, line);
    assert.equal(outages([line.replace(BASE, "https://rpc.example.org")], down).kept.length, 1, line);
  }
  // any other CORS refusal stays an error, whatever the row shows
  for (const why of ["Request header field x-api-key is not allowed by Access-Control-Allow-Headers in preflight response.", "Method POST is not allowed by Access-Control-Allow-Methods in preflight response."]) {
    assert.equal(outages([cors(`${BASE}/`, why)], down).kept.length, 1, why);
  }
});

test("planted: a pair is down when every one of its RPCs failed a load, tagged or not, whichever way each failed: none of its failures is let through (card app-shell-rpc-outage-judge)", () => {
  const { rpcs, pools } = VERIFY_RELEASES.mainnet;
  const load = (u, tag = "") => `${consoleLine("Failed to load resource: the server responded with a status of 503 ()", tag ? footerUrl(u) : `${new URL(u).origin}/`)}`;
  const on = { conn: "on", block: "223500000", ms: 5000 };
  const rows = (code, funds, solana = "ok") => ({ state: "read", code, funds, pools: { solana, base: "ok", robinhood: "ok" } });
  const refused = (r, n) => r.kept.length === n && r.refused.every((x) => x.includes("and every RPC of its pair failed a load"));
  // (a) both NEAR RPCs fail Verify reads, Code and Funds warn: the app says it got no answer; neither is let through
  const a = outages([load(rpcs[0]), load(rpcs[1])], rows("warn", "warn"), "mainnet", on);
  assert.ok(refused(a, 2) && a.down.length === 0, JSON.stringify(a));
  assert.deepEqual(outages([load(rpcs[0])], rows("warn", "warn"), "mainnet", on).kept, [], "one of them alone is let through");
  // (b) FastNEAR fails a footer read and dRPC a Verify read, the footer on and the rows warn: the pair is down all the same
  const b = outages([load(rpcs[0], "footer"), load(rpcs[1])], rows("warn", "warn"), "mainnet", on);
  assert.ok(refused(b, 2) && b.down.length === 0, JSON.stringify(b));
  assert.equal(outages([load(rpcs[0], "footer")], rows("ok", "ok"), "mainnet", on).kept.length, 0, "the footer read alone is let through");
  // (c) both Solana pool RPCs fail with the solana row warn: refused; one alone is let through
  const c = outages([load(pools.solana.rpcs[0]), load(pools.solana.rpcs[1])], rows("ok", "ok", "warn"), "mainnet", on);
  assert.ok(refused(c, 2) && c.down.length === 0, JSON.stringify(c));
  assert.equal(outages([load(pools.solana.rpcs[1])], rows("ok", "ok", "warn"), "mainnet", on).kept.length, 0);
  // a failed preflight line counts toward the pair as well as a failed load
  const cors = (u) => consoleLine(`Access to fetch at '${new URL(u).origin}/' from origin 'https://ct-app.unrealized.trade' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: It does not have HTTP ok status.`, "https://ct-app.unrealized.trade/verify");
  assert.ok(refused(outages([cors(rpcs[0]), load(rpcs[1])], rows("warn", "warn"), "mainnet", on), 2));
  // pools of different chains are not one pair: one RPC each of two pairs down is two outages, each shown by its own row
  const two = outages([load(pools.solana.rpcs[0]), load(pools.base.rpcs[0])], { ...rows("ok", "ok", "warn"), pools: { solana: "warn", base: "warn", robinhood: "ok" } }, "mainnet", on);
  assert.deepEqual(two.kept, []);
});

test("planted: a footer makes one read in each BLOCK_EVERY_MS of the load, plus one; more failed footer reads of an origin than that are no outage the footer shows (card app-shell-rpc-outage-judge)", () => {
  const rpc = VERIFY_RELEASES.mainnet.rpcs[0];
  const tagged = consoleLine("Failed to load resource: the server responded with a status of 503 ()", footerUrl(rpc));
  const at = (ms) => ({ conn: "on", block: "223500000", ms });
  const n = (k, ms) => outages(Array(k).fill(tagged), null, "mainnet", at(ms)).kept.length;
  assert.equal(n(2, 5000), 0, "5 s of load: reads at 0 and 3 s");
  assert.equal(n(3, 5000), 3, "a third read within 5 s is a storm");
  assert.equal(n(1, 0), 0);
  assert.equal(n(2, 0), 2, "no time has passed: one read");
  assert.equal(n(7, 18000), 0, "18 s: seven reads");
  assert.equal(n(8, 18000), 8);
  assert.equal(outages([tagged], null, "mainnet", { conn: "on", block: "223500000" }).kept.length, 1, "no clock in the record: no read is allowed");
});
