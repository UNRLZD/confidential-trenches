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
// Since 12 Nov the phone's "/" is the Trenches list and its token page is app-shell's TOKEN_PAGE load (the first token
// "/" lists). The deployed reads (bad, goodOneBar) were taken while the phone's "/" drew the top token's page, so their
// phone "/" load is that page, read here under TOKEN_PAGE (onTokenPage).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TOKEN_PAGE } from "./app-shell.mjs";
import { judge, LOADS } from "./app-phone-token-taps-and-rows.mjs";

const RAW = JSON.parse(readFileSync(new URL("./app-phone-token-taps-and-rows.answers.json", import.meta.url), "utf8"));
const onTokenPage = (rec) => ({ ...rec, loads: rec.loads.map((l) => (l.width === "phone" && l.path === "/" ? { ...l, path: TOKEN_PAGE } : l)) });
const A = { ...RAW, bad: onTokenPage(RAW.bad), goodOneBar: onTokenPage(RAW.goodOneBar) };
const T = TOKEN_PAGE.replace(/[/<>]/g, (c) => `\\${c}`);
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
  assert.match(r.lines[0], new RegExp(`^ok  phone ${T} \\(token\\): \\d+ mark\\(s\\) at 12x12 px, every tap 44 px or more, \\d+ row\\(s\\), \\d+ trade\\(s\\) arrived, CLS 0$`));
  assert.match(r.lines[1], /^ok  desktop \/ \(token\): \d+ mark\(s\), \d+ row\(s\), \d+ trade\(s\) arrived, CLS 0$/);
});

test("recorded bad answer: the deployed page's 12 px marks and moving rows: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const b = bad(A.bad);
  assert.ok(b.some((l) => l.startsWith(`BAD phone ${TOKEN_PAGE} `) && l.includes("tap under 44 px: button.tm:12x12")), b.join("\n"));
  assert.ok(b.some((l) => l.startsWith(`BAD phone ${TOKEN_PAGE} (token): `) && /CLS 0\.\d+ above 0 \[.*div\.tkl-trow\.tkl-tr /.test(l)), b.join("\n"));
  // the marks were drawn at 12 px and trades arrived: the page was judged with its tape, not on an empty one
  const t = load(A.bad, "phone", TOKEN_PAGE).tape;
  assert.ok(t.marks > 0 && t.pushed >= 2 && t.markPx.join("x") === "12x12", JSON.stringify(t));
});

test("planted on the good answer: a 12 px mark's tap area, a row moved by an arriving trade (run 42773072293): FAIL", () => {
  assert.deepEqual(bad(mutate((r) => (load(r, "phone", TOKEN_PAGE).smallTaps = ["button.tm:12x12"]))), [`BAD phone ${TOKEN_PAGE} (token): tap under 44 px: button.tm:12x12`]);
  const shift = { at: 1407, value: 0.0039, input: false, sources: ["div.tkl-trow.tkl-tr 0,781 390x44 -> 0,825 390x19", "div.tkl-trow.tkl-tr 0,825 390x19 -> 0,0 0x0"] };
  assert.deepEqual(bad(mutate((r) => Object.assign(load(r, "phone", TOKEN_PAGE), { cls: 0.0039, shifts: [shift] }))), [
    `BAD phone ${TOKEN_PAGE} (token): CLS 0.0039 above 0 [+1407ms 0.0039: div.tkl-trow.tkl-tr 0,781 390x44 -> 0,825 390x19 | div.tkl-trow.tkl-tr 0,825 390x19 -> 0,0 0x0]`,
  ]);
  // the desktop's rows too
  assert.equal(bad(mutate((r) => (load(r, "desktop", "/").cls = 0.0036))).length, 1);
});

test("planted on the good answer: a mark grown past 12 px to pass the tap rule, no marks, no rows, under 2 trades: FAIL", () => {
  assert.deepEqual(bad(mutate((r) => (load(r, "phone", TOKEN_PAGE).tape.markPx = [44, 44]))), [`BAD phone ${TOKEN_PAGE} (token): a mark drawn 44x44 px, want 12x12`]);
  assert.deepEqual(bad(mutate((r) => (load(r, "phone", TOKEN_PAGE).tape.marks = 0))), [`BAD phone ${TOKEN_PAGE} (token): no trade mark on the chart`]);
  assert.deepEqual(bad(mutate((r) => (load(r, "desktop", "/").tape.rows = 0))), ["BAD desktop / (token): no trade row"]);
  assert.deepEqual(bad(mutate((r) => (load(r, "phone", TOKEN_PAGE).tape.pushed = 1))), [`BAD phone ${TOKEN_PAGE} (token): 1 trade(s) arrived while it settled, want 2 or more`]);
  assert.deepEqual(bad(mutate((r) => delete load(r, "phone", TOKEN_PAGE).tape)), [`BAD phone ${TOKEN_PAGE} (token): no trade mark on the chart; no trade row; 0 trade(s) arrived while it settled, want 2 or more`]);
});

test("planted on the good answer: a load missing, not inside the shell, the wrong screen: FAIL", () => {
  assert.deepEqual(bad(mutate((r) => (r.loads = r.loads.filter((l) => !(l.width === "phone" && l.path === TOKEN_PAGE))))), [`BAD phone ${TOKEN_PAGE}: not loaded`]);
  assert.match(bad(mutate((r) => (load(r, "desktop", "/").framed = false)))[0], /^BAD desktop \/ \(token\): not inside SIGN_HOST's shell/);
  assert.equal(bad(mutate((r) => (load(r, "phone", TOKEN_PAGE).route = "discover")))[0], `BAD phone ${TOKEN_PAGE} (token): drew discover`);
  assert.equal(judge({ loads: [] }).ok, false);
});

// goodOneBar: APP_HOST live, 11 Nov 06:42Z, the top Trending token with one 15m bar (a Base token two hours old): the tape
// planted on that bar, marks 12 x 12 px with every tap 44 px or more, rows and pushed trades: PASS
test("recorded good answer on a one-bar top token: PASS", () => {
  const r = judge(A.goodOneBar);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, LOADS.length);
});
