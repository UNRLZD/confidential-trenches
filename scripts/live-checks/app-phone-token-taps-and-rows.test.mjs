// node --test scripts/live-checks/app-phone-token-taps-and-rows.test.mjs: the live check's verdict replays recorded runs
// (app-phone-token-taps-and-rows.answers.json), both app-shell.mjs collect() reads with the token page's tape planted
// (plantTape), in Chrome 157 on the Mac:
//   good: this card's build, read by apps/terminal/test/bar10/run.mjs --record (the hosts' real names answered from
//         local files, the helper's lists, token and candles answered): marks at 12 x 12 px with a 44 px tap area, rows
//         holding still as trades arrive: PASS;
//   bad:  the deployed APP_HOST, read on 10 Nov by app-phone-token-taps-and-rows.mjs --record (the app the app-shell run
//         42773072293 read as main 09a5f2f6, before this card): "tap under 44 px:
//         button.tm:12x12" on phone / and /verify, and the trades rows moved by each arriving trade: FAIL.
// The other cases plant one fact on the good answer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, LOADS } from "./app-phone-token-taps-and-rows.mjs";

const A = JSON.parse(readFileSync(new URL("./app-phone-token-taps-and-rows.answers.json", import.meta.url), "utf8"));
const bad = (r) => judge(r).lines.filter((l) => l.startsWith("BAD"));
const load = (rec, w, p) => rec.loads.find((l) => l.width === w && l.path === p);
const mutate = (f) => {
  const r = structuredClone(A.good);
  f(r);
  return r;
};

test("recorded good answer: marks 12 x 12 px with no tap under 44 px, rows arriving at CLS 0: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, LOADS.length);
  assert.match(r.lines[0], /^ok  phone \/ \(token\): \d+ mark\(s\) at 12x12 px, every tap 44 px or more, \d+ row\(s\), \d+ trade\(s\) arrived, CLS 0$/);
  assert.match(r.lines[1], /^ok  phone \/verify \(verify\): \d+ mark\(s\) at 12x12 px, every tap 44 px or more, CLS 0$/);
  assert.match(r.lines[2], /^ok  desktop \/ \(token\): \d+ mark\(s\), \d+ row\(s\), \d+ trade\(s\) arrived, CLS 0$/);
});

test("recorded bad answer: the deployed page's 12 px marks and moving rows: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const b = bad(A.bad);
  for (const p of ["/", "/verify"]) assert.ok(b.some((l) => l.startsWith(`BAD phone ${p} `) && l.includes("tap under 44 px: button.tm:12x12")), `${p}: ${b.join("\n")}`);
  assert.ok(b.some((l) => l.startsWith("BAD phone / (token): ") && /CLS 0\.\d+ above 0 \[.*div\.tkl-trow\.tkl-tr /.test(l)), b.join("\n"));
  // the marks were drawn at 12 px and trades arrived: the page was judged with its tape, not on an empty one
  const t = load(A.bad, "phone", "/").tape;
  assert.ok(t.marks > 0 && t.pushed >= 2 && t.markPx.join("x") === "12x12", JSON.stringify(t));
});

test("planted on the good answer: a 12 px mark's tap area, a row moved by an arriving trade (run 42773072293): FAIL", () => {
  assert.deepEqual(bad(mutate((r) => (load(r, "phone", "/verify").smallTaps = ["button.tm:12x12"]))), ["BAD phone /verify (verify): tap under 44 px: button.tm:12x12"]);
  const shift = { at: 1407, value: 0.0039, input: false, sources: ["div.tkl-trow.tkl-tr 0,781 390x44 -> 0,825 390x19", "div.tkl-trow.tkl-tr 0,825 390x19 -> 0,0 0x0"] };
  assert.deepEqual(bad(mutate((r) => Object.assign(load(r, "phone", "/"), { cls: 0.0039, shifts: [shift] }))), [
    "BAD phone / (token): CLS 0.0039 above 0 [+1407ms 0.0039: div.tkl-trow.tkl-tr 0,781 390x44 -> 0,825 390x19 | div.tkl-trow.tkl-tr 0,825 390x19 -> 0,0 0x0]",
  ]);
  // the desktop's rows too
  assert.equal(bad(mutate((r) => (load(r, "desktop", "/").cls = 0.0036))).length, 1);
});

test("planted on the good answer: a mark grown past 12 px to pass the tap rule, no marks, no rows, under 2 trades: FAIL", () => {
  assert.deepEqual(bad(mutate((r) => (load(r, "phone", "/").tape.markPx = [44, 44]))), ["BAD phone / (token): a mark drawn 44x44 px, want 12x12"]);
  assert.deepEqual(bad(mutate((r) => (load(r, "phone", "/verify").tape.marks = 0))), ["BAD phone /verify (verify): no trade mark on the chart"]);
  assert.deepEqual(bad(mutate((r) => (load(r, "desktop", "/").tape.rows = 0))), ["BAD desktop / (token): no trade row"]);
  assert.deepEqual(bad(mutate((r) => (load(r, "phone", "/").tape.pushed = 1))), ["BAD phone / (token): 1 trade(s) arrived while it settled, want 2 or more"]);
  assert.deepEqual(bad(mutate((r) => delete load(r, "phone", "/").tape)), ["BAD phone / (token): no trade mark on the chart; no trade row; 0 trade(s) arrived while it settled, want 2 or more"]);
});

test("planted on the good answer: a load missing, not inside the shell, the wrong screen: FAIL", () => {
  assert.deepEqual(bad(mutate((r) => (r.loads = r.loads.filter((l) => !(l.width === "phone" && l.path === "/verify"))))), ["BAD phone /verify: not loaded"]);
  assert.match(bad(mutate((r) => (load(r, "desktop", "/").framed = false)))[0], /^BAD desktop \/ \(token\): not inside SIGN_HOST's shell/);
  assert.match(bad(mutate((r) => (load(r, "phone", "/").route = "discover")))[0], /^BAD phone \/ \(token\): drew discover$/);
  assert.equal(judge({ loads: [] }).ok, false);
});

// goodOneBar: APP_HOST live, 11 Nov 06:42Z, the top Trending token with one 15m bar (a Base token two hours old): the tape
// planted on that bar, marks 12 x 12 px with every tap 44 px or more, rows and pushed trades: PASS
test("recorded good answer on a one-bar top token: PASS", () => {
  const r = judge(A.goodOneBar);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, LOADS.length);
});
