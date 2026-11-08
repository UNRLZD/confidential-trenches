// node --test scripts/live-checks/signpage-postmessage.test.mjs: the live check replays recorded runs
// (signpage-postmessage.answers.json). good: packages/signpage's build at card signpage-shell (frame-ancestors 'none'),
// answered by `--local` (no network): PASS, APP_HOST blocked like every stranger. framed: SIGN_HOST as deployed before
// card signpage-shell (frame-ancestors APP_HOST): FAIL, APP_HOST frames it and its ready arrives. planted: an earlier
// build with the page's origin check taken out and its answers posted to "*": FAIL on every stranger with
// frame-ancestors lifted. The rest are the good run with one thing changed each.
// The deposit.quote round trip (card signpage-deposit-quote-wire): good (this card's build, its release's /app.js) answers
// a fresh browser not_allowed with no request sent: PASS. liveRelease3: SIGN_HOST as deployed before this card's
// release, refused the same way but serving release-3's /app.js: FAIL on the pin alone. plantedDeposit: this card's
// build with an address answered while no seed is stored and nothing was asked: FAIL. The runs before this card have
// no deposit run: FAIL on that line alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_HOST, headersOf, judge as judgeAt, onConsole, releasePin } from "./signpage-postmessage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-postmessage.answers.json"), "utf8"));
const GOOD = ANSWERS.good;
// every recording is judged against the newest release list, but the good run against the list it was recorded with
// (its /app.js is that release's; a later release must not turn it red)
const judge = (rec) => judgeAt(rec, releasePin());
const clone = (x) => JSON.parse(JSON.stringify(x));
const run = (rec, parent, headers) => rec.runs.find((r) => r.parent === parent && r.headers === headers);
const STRANGERS = ["https://example.com", "https://evil.ct.test", "https://app.other.test"];

test("recorded good run (local build): PASS, APP_HOST blocked by frame-ancestors", () => {
  const r = judgeAt(GOOD, releasePin(GOOD.pin.release));
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  from APP_HOST: the frame is blocked by frame-ancestors"), r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  from APP_HOST: 0 message(s) reached the parent, want none"), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.startsWith("ok  from APP_HOST with frame-ancestors lifted")));
  assert.ok(r.lines.includes("ok  from https://example.com: the frame is blocked by frame-ancestors"));
  assert.ok(r.lines.includes("ok  from https://evil.ct.test with frame-ancestors lifted: the frame loads and its script runs"));
  assert.ok(r.lines.includes("ok  from https://app.other.test with frame-ancestors lifted: 0 message(s) reached the parent, want none"));
  assert.ok(r.lines.includes('ok  deposit.quote with no seed stored: "not_allowed", want not_allowed'), r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  deposit.quote refused not_allowed: 0 request(s) to the helper, want none"), r.lines.join("\n"));
});

test("recorded live run on release-3 (SIGN_HOST before this card's deploy): FAIL on the /app.js pin alone", () => {
  const rec = ANSWERS.liveRelease3;
  assert.equal(rec.source, "live");
  assert.equal(rec.deposit.appJs.sha256, releasePin("release-3").sha256, "the recording is release-3's /app.js");
  const r = judge(rec);
  assert.equal(r.ok, false);
  const b = r.lines.filter((l) => l.startsWith("BAD"));
  assert.equal(b.length, 1, r.lines.join("\n"));
  assert.match(b[0], /^BAD deposit\.quote: SIGN_HOST served \/app\.js sha256 5b8d5780/);
  // against release-3's own pin it passes: the refusal itself was right
  assert.equal(judgeAt(rec, releasePin("release-3")).ok, true);
});

test("recorded bad run: an address answered with no seed stored and no request sent: FAIL", () => {
  const r = judge(ANSWERS.plantedDeposit);
  assert.equal(r.ok, false);
  const b = r.lines.filter((l) => l.startsWith("BAD"));
  assert.ok(b.includes("BAD deposit.quote answered ok with no seed stored: an address for a U the store has not recorded"), r.lines.join("\n"));
  assert.ok(b.includes("BAD deposit.quote: 0 request(s) to the helper, want 1 naming one id as recipient and refundTo"), r.lines.join("\n"));
  // judged against its own build's /app.js, those two lines alone
  const own = judgeAt(ANSWERS.plantedDeposit, { release: "planted", sha256: ANSWERS.plantedDeposit.deposit.appJs?.sha256 ?? "" });
  assert.equal(own.lines.filter((l) => l.startsWith("BAD")).length, ANSWERS.plantedDeposit.deposit.appJs ? 2 : 3);
});

test("deposit.quote: the good run with one change each: FAIL; a signed-in address after one request to U: PASS", () => {
  const quoteAnswer = (rec) => rec.deposit.log.find((m) => m.data?.id === rec.deposit.ids.quote);
  const stateAnswer = (rec) => rec.deposit.log.find((m) => m.data?.id === rec.deposit.ids.state);
  const U = "5d".repeat(32);
  const asked = (rec, over = {}) => ({ url: "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote", method: "POST", body: { recipient: U, refundTo: U, ...over } });
  const signedInOk = (rec) => {
    stateAnswer(rec).data.result.signed_in = true;
    quoteAnswer(rec).data = { v: 1, id: rec.deposit.ids.quote, ok: true, result: { deposit_address: "addr", origin_asset: rec.deposit.asked.origin_asset, amount_in: "25", min_amount_out: "24.7", deadline: "2026-11-05T00:00:00.000Z", time_estimate_s: 20 } };
  };
  const pin = releasePin(GOOD.pin.release);
  const ok = clone(GOOD);
  signedInOk(ok);
  ok.deposit.helper.push(asked(ok));
  assert.equal(judgeAt(ok, pin).ok, true, judgeAt(ok, pin).lines.join("\n"));
  const cases = {
    "no deposit run": (rec) => delete rec.deposit,
    "no ready": (rec) => (rec.deposit.ready = false),
    "no answer": (rec) => (rec.deposit.log = rec.deposit.log.filter((m) => m.data?.id !== rec.deposit.ids.quote)),
    "two answers": (rec) => rec.deposit.log.push(clone(quoteAnswer(rec))),
    "an answer from another origin only": (rec) => (quoteAnswer(rec).origin = "https://evil.ct.test"),
    "a request sent on a not_allowed refusal": (rec) => rec.deposit.helper.push(asked(rec)),
    "busy with no seed stored": (rec) => (quoteAnswer(rec).data.error.code = "busy"),
    "a code not in the list": (rec) => (quoteAnswer(rec).data.error.code = "id_reused"),
    "a refusal carrying more than its code": (rec) => (quoteAnswer(rec).data.deposit_address = "addr"),
    "signed in, an address with no request": (rec) => signedInOk(rec),
    "signed in, an address after two requests": (rec) => (signedInOk(rec), rec.deposit.helper.push(asked(rec), asked(rec))),
    "signed in, the refund to another id": (rec) => (signedInOk(rec), rec.deposit.helper.push(asked(rec, { refundTo: "ab".repeat(32) }))),
    "signed in, another asset answered": (rec) => (signedInOk(rec), rec.deposit.helper.push(asked(rec)), (quoteAnswer(rec).data.result.origin_asset = "nep141:other")),
    "another /app.js served": (rec) => (rec.deposit.appJs.sha256 = "0".repeat(64)),
    "no /app.js read": (rec) => delete rec.deposit.appJs,
  };
  for (const [name, change] of Object.entries(cases)) {
    const rec = clone(GOOD);
    change(rec);
    assert.equal(judgeAt(rec, pin).ok, false, name);
  }
});

test("recorded bad run: SIGN_HOST before card signpage-shell, framed by APP_HOST: FAIL, the frame loads and its ready arrives", () => {
  const r = judge(ANSWERS.framed);
  assert.equal(r.ok, false);
  const b = r.lines.filter((l) => l.startsWith("BAD") && !l.startsWith("BAD deposit.quote"));
  assert.equal(b.length, 2, r.lines.join("\n"));
  assert.ok(r.lines.includes("BAD deposit.quote: no run"));
  assert.equal(b[0], "BAD from APP_HOST: the frame is loaded");
  assert.match(b[1], /^BAD from APP_HOST: [1-9]\d* message\(s\) reached the parent \(\[\{"v":1,"type":"ready",/);
});

test("recorded bad run: a page that answers every origin: FAIL on every stranger with frame-ancestors lifted", () => {
  const r = judge(ANSWERS.planted);
  assert.equal(r.ok, false);
  for (const s of STRANGERS) {
    assert.ok(r.lines.some((l) => l.startsWith(`BAD from ${s} with frame-ancestors lifted: `) && /message\(s\) reached the parent/.test(l)), `${s}\n${r.lines.join("\n")}`);
  }
});

test("the good run with one change each: FAIL", () => {
  const cases = {
    "APP_HOST's frame loads": (rec) => (run(rec, APP_HOST, "served").loaded = true),
    "a message reaches APP_HOST": (rec) => run(rec, APP_HOST, "served").messages.push({ t: 1, origin: "https://confidential.unrealized.trade", fromFrame: true, data: { v: 1, type: "ready", release: "x", api: 1 } }),
    "the APP_HOST run missing": (rec) => (rec.runs = rec.runs.filter((r) => r.parent !== APP_HOST)),
    "a stranger's frame loads under the served headers": (rec) => (run(rec, "https://example.com", "served").loaded = true),
    "a stranger's lifted frame runs no script": (rec) => (run(rec, "https://evil.ct.test", "lifted").scriptRan = false),
    "a message reaches a lifted stranger": (rec) => run(rec, "https://app.other.test", "lifted").messages.push({ t: 1, origin: "https://confidential.unrealized.trade", fromFrame: true, data: { v: 1, type: "ready" } }),
    "a stranger run missing": (rec) => (rec.runs = rec.runs.filter((r) => r.parent !== "https://app.other.test")),
  };
  for (const [name, change] of Object.entries(cases)) {
    const rec = clone(GOOD);
    change(rec);
    assert.equal(judge(rec).ok, false, name);
  }
});

test("headersOf reads the /* rule of SIGN_HOST's _headers", () => {
  const h = headersOf(readFileSync(path.join(HERE, "../../packages/signpage/public/_headers"), "utf8"));
  // SIGN_HOST is the top window since card signpage-shell: nothing may frame it
  assert.match(h["content-security-policy"], /frame-ancestors 'none';/);
  assert.equal(h["integrity-policy"], "blocked-destinations=(script)");
  assert.deepEqual(headersOf("/x\n  A: 1\n/*\n  B: 2\n"), { b: "2" });
});

test("planted on the good answer: a frame whose script was refused names the refusal and its resource's origin and path in the BAD line, and one with no location still fails (card live-console-url)", () => {
  const text = "Failed to find a valid digest in the 'integrity' attribute for resource";
  const kept = [];
  const hook = onConsole(kept);
  const msg = (t, location) => ({ type: () => "error", text: () => t, location: () => location });
  hook(msg(text, { url: "https://confidential.unrealized.trade/app.js?v=9" }));
  hook(msg("Refused to load the script because it violates the following Content Security Policy directive", undefined));
  hook({ type: () => "log", text: () => "a log line", location: () => ({ url: "https://x.example/" }) });
  assert.deepEqual(kept, [`${text} (https://confidential.unrealized.trade/app.js)`, "Refused to load the script because it violates the following Content Security Policy directive"]);
  for (const line of kept) {
    const rec = clone(GOOD);
    const s = run(rec, "https://evil.ct.test", "lifted");
    s.scriptRan = false;
    s.errors.push(line);
    const r = judge(rec);
    assert.equal(r.ok, false);
    assert.ok(r.lines.includes(`BAD from https://evil.ct.test with frame-ancestors lifted: the frame loads and its script does not run: ${line}`), r.lines.join("\n"));
    assert.ok(!r.lines.some((l) => l.includes("?v=9")), "no query in a line");
  }
});
