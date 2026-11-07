// node --test scripts/live-checks/app-deposit-mount.test.mjs: the live check's verdict replays recorded runs
// (app-deposit-mount.answers.json), each read by app-deposit-mount.mjs collect() in headless Chromium, the stand-in
// shell sending a signed-in account and answering the deposit reads:
//   good: this card's build served at APP_HOST's name (--harness --build): at 390 and 1440, dark and light, the header's
//         Deposit opens the one sheet, which asks deposit.assets, sends one deposit.dry for 15, draws its lines, keeps
//         Get address's box its own, takes the phone's touch on the button itself, sends deposit.quote with the asset and 15 only, draws the quote's address under the heading NEAR, draws Waiting,
//         Processing and Deposited $73.18 from the op's stages, Recent empty before and the Deposited row after, and
//         closes on Done: PASS;
//   bad:  main's build before this card (--harness --build of main): the header's Deposit opens nothing: FAIL.
// Planted from the good run: a phone tap on the amount field or on nothing, a body layer under Get address, a dry
// quote per key, a quote with an extra field, the heading NEAR NEAR, a stage drawn out of turn, a Done that leaves the
// sheet, two sheets, a missing run, a terminal outside the shell.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./app-deposit-mount.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-deposit-mount.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w, s) => rec.runs.find((r) => r.width === w && r.scheme === s);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: the header's Deposit opens the sheet, which runs the deposit reads end to end, every width and scheme: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const x of ANSWERS.good.runs) assert.deepEqual([x.opened, x.heading, x.credited], [1, ["NEAR"], "73.18"], `${x.width} ${x.scheme}`);
});

test("recorded bad answer: main's build before this card opens nothing from the header's Deposit: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /^BAD desktop dark: the header's Deposit opens nothing/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD phone light: the header's Deposit opens nothing/.test(l)), r.lines.join("\n"));
});

test("planted: a dry quote per key, a dry or checked quote that carries more than the asset and the amount, fail", () => {
  fails(mut((rec) => run(rec, "desktop", "dark").dry.unshift({ origin_asset: "nep141:wrap.near", amount: "1" })), /^BAD desktop dark: typing 15 sends 2 deposit\.dry/);
  fails(mut((rec) => (run(rec, "phone", "dark").dry[0].refund_to = "u.near")), /^BAD phone dark: typing 15 sends 1 deposit\.dry/);
  fails(mut((rec) => (run(rec, "phone", "light").quote.recipient = "x.near")), /^BAD phone light: Get address sends deposit\.quote/);
  fails(mut((rec) => (run(rec, "desktop", "light").assetsAsked = false)), /^BAD desktop light: the sheet never asks deposit\.assets/);
  fails(mut((rec) => (run(rec, "desktop", "dark").youGet = null)), /^BAD desktop dark: the dry quote draws S4\.3, You get nothing/);
});

test("planted: the heading NEAR NEAR, another address, a stage out of turn or a wrong credit fail", () => {
  fails(mut((rec) => (run(rec, "desktop", "dark").heading = ["NEAR", "NEAR"])), /^BAD desktop dark: the address heading reads \["NEAR","NEAR"\]/);
  fails(mut((rec) => (run(rec, "phone", "dark").address = "0xdead")), /^BAD phone dark: the address state S4\.13 draws 0xdead/);
  fails(mut((rec) => (run(rec, "phone", "light").stages = ["S4.14", "S4.16", "S4.16"])), /^BAD phone light: the deposit's stages draw/);
  fails(mut((rec) => (run(rec, "desktop", "light").credited = "0")), /^BAD desktop light: Deposited draws 0/);
  fails(mut((rec) => (run(rec, "phone", "dark").recentBefore = 1)), /^BAD phone dark: Recent under the form shows 1 row/);
  fails(mut((rec) => (run(rec, "desktop", "dark").recentDone = ["Processing"])), /^BAD desktop dark: Recent on the done screen reads \["Processing"\]/);
});

test("planted: two sheets, a Done that leaves the sheet, a missing run, or a terminal outside the shell fail", () => {
  fails(mut((rec) => (run(rec, "desktop", "dark").opened = 2)), /^BAD desktop dark: the header's Deposit opens 2 deposit sheets/);
  fails(mut((rec) => (run(rec, "phone", "dark").closed = false)), /^BAD phone dark: Done leaves the sheet open/);
  fails(mut((rec) => rec.runs.pop()), /^BAD 3 run\(s\) of 4/);
  fails(mut((rec) => (run(rec, "desktop", "dark").framed = false)), /^BAD desktop dark: not inside SIGN_HOST's shell/);
});

test("planted: a phone tap that lands on the amount field or reaches nothing, or a body layer under Get address, fail", () => {
  const onField = ["pointerdown 98,398 input.v.num vv 0,0,1 dpr 1", "touchstart 98,398 input.v.num vv 0,0,1 dpr 1"];
  fails(mut((rec) => (run(rec, "phone", "dark").tapGet.presses = onField)), /^BAD phone dark: the tap on Get address lands on pointerdown 98,398 input\.v\.num/);
  fails(mut((rec) => (run(rec, "phone", "light").tapGet.presses = [])), /^BAD phone light: the tap on Get address reaches nothing/);
  fails(mut((rec) => (run(rec, "phone", "light").tapGet = {})), /^BAD phone light: the tap on Get address reaches nothing/);
  fails(mut((rec) => (run(rec, "desktop", "dark").clear = { ok: false, first: "the button", under: ["input.v.num"] })), /^BAD desktop dark: the element at Get address's centre is the button, and the body's input\.v\.num lies under it/);
  fails(mut((rec) => (run(rec, "phone", "dark").clear = { ok: false, first: "input.v.num", under: ["input.v.num"] })), /^BAD phone dark: the element at Get address's centre is input\.v\.num/);
});
