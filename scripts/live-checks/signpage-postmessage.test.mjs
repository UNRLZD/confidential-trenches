// node --test scripts/live-checks/signpage-postmessage.test.mjs: the live check replays recorded runs
// (signpage-postmessage.answers.json). good: packages/signpage's build at this card, answered by `--local` (no
// network): PASS. emptypage: SIGN_HOST as it was served before this card (the skeleton's empty body, no script): FAIL.
// planted: the same build with the page's origin check taken out and its answers posted to "*": FAIL. The rest are the
// good run with one thing changed each.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_HOST, headersOf, judge } from "./signpage-postmessage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-postmessage.answers.json"), "utf8"));
const GOOD = ANSWERS.good;
const clone = (x) => JSON.parse(JSON.stringify(x));
const appRun = (rec) => rec.runs.find((r) => r.parent === APP_HOST && r.headers === "served");

test("recorded good run (local build): PASS", () => {
  const r = judge(GOOD);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith('ok  from APP_HOST: 1 ready {"v":1,"type":"ready","release":"unreleased","api":1}')), r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  from https://example.com: the frame is blocked"));
  assert.ok(r.lines.includes("ok  from https://evil.ct.test with frame-ancestors lifted: the frame loads and its script runs"));
  assert.ok(r.lines.includes("ok  from https://app.other.test with frame-ancestors lifted: 0 message(s) reached the parent, want none"));
});

test("recorded bad run: SIGN_HOST's empty page before this card: FAIL, no ready, nothing answered", () => {
  const r = judge(ANSWERS.emptypage);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("BAD from APP_HOST: no ready")), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD from APP_HOST: unknown")), r.lines.join("\n"));
});

test("recorded bad run: a page that answers every origin: FAIL on every stranger with frame-ancestors lifted", () => {
  const r = judge(ANSWERS.planted);
  assert.equal(r.ok, false);
  for (const s of ["https://example.com", "https://evil.ct.test", "https://app.other.test"]) {
    assert.ok(r.lines.some((l) => l.startsWith(`BAD from ${s} with frame-ancestors lifted: `) && /message\(s\) reached the parent/.test(l)), `${s}\n${r.lines.join("\n")}`);
  }
});

test("the good run with one change each: FAIL", () => {
  const cases = {
    "unknown kind not answered": (rec) => {
      const a = appRun(rec);
      a.messages = a.messages.filter((m) => m.data?.id !== a.sent.unknown.id);
    },
    "wrong source answered": (rec) => {
      const a = appRun(rec);
      a.messages.push({ t: 1, origin: "https://sign.confidential.unrealized.trade", fromFrame: true, data: { v: 1, id: a.sent.wrongSource.id, ok: true, result: {} } });
    },
    "ready too late": (rec) => {
      const a = appRun(rec);
      a.messages.find((m) => m.data?.type === "ready").t = 6_000;
    },
    "state answered late": (rec) => {
      const a = appRun(rec);
      a.sentAt = a.messages.find((m) => m.data?.id === a.sent.state.id).t - 2_000;
    },
    "a state with an extra key": (rec) => {
      const a = appRun(rec);
      for (const m of a.messages) if (m.data?.id === a.sent.state.id) m.data.result.seed = "x";
    },
    "refused with another code": (rec) => {
      const a = appRun(rec);
      a.messages.find((m) => m.data?.id === a.sent.buy.id).data.error.code = "quote_check_failed";
    },
    "a stranger's frame loads under the served headers": (rec) => {
      rec.runs.find((r) => r.parent === "https://example.com" && r.headers === "served").loaded = true;
    },
    "a stranger run missing": (rec) => {
      rec.runs = rec.runs.filter((r) => r.parent !== "https://app.other.test");
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    const rec = clone(GOOD);
    change(rec);
    assert.equal(judge(rec).ok, false, name);
  }
});

test("headersOf reads the /* rule of SIGN_HOST's _headers", () => {
  const h = headersOf(readFileSync(path.join(HERE, "../../packages/signpage/public/_headers"), "utf8"));
  assert.match(h["content-security-policy"], /frame-ancestors https:\/\/confidential\.unrealized\.trade;/);
  assert.equal(h["integrity-policy"], "blocked-destinations=(script)");
  assert.deepEqual(headersOf("/x\n  A: 1\n/*\n  B: 2\n"), { b: "2" });
});
