// node --test scripts/live-checks/app-faults-seen-on-122.test.mjs: the live check's verdict replays recorded runs
// (app-faults-seen-on-122.answers.json), each read by app-faults-seen-on-122.mjs collect() in headless Chromium, the
// stand-in shell sending 73.18 USDC in the vault, the priced Solana pool and the open buy holding 0.008478835 SOL:
//   good: this card's build served at APP_HOST's name (--harness): at 390 and 1440 NEAR's vault is Private balance's
//         first row, the Positions tile opens to Coins and Reserve (69 cents on Solana) adding up to the tile, the
//         desktop's Allocation draws Reserve, the phone has one Open and one Closed control and Closed turns on, and
//         the page load asks no deposit.assets, pressing Deposit asks it and the sheet's first read draws the asset: PASS;
//   bad:  main's build before this card (2498306e9, --harness --build): no NEAR row, a Positions tile with no parts, no
//         phone Closed control, the sheet's first read the loading skeleton: FAIL;
//   beforeFault9: the build before card app-faults-seen-on-124's fault 9 (24caa6cdc, --harness --build), which asks
//         deposit.assets at the page load: FAIL.
// Planted from the good run: Reserve a cent off, parts that do not add up to the tile, a pool list without NEAR first,
// the loading skeleton on the sheet's first read, a list asked by the page load, a list never asked, a missing Closed
// control, a run missing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./app-faults-seen-on-122.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-faults-seen-on-122.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w) => rec.runs.find((r) => r.width === w);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: NEAR's row, Coins and Reserve, the phone's Closed control and the deposit list asked on Deposit, none at load, both widths: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: main's build before this card draws none of them: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  for (const re of [/first row/, /Positions tile/, /first read after it opens is S4\.1/]) assert.ok(bad(r).some((l) => re.test(l)), `${re}\n${r.lines.join("\n")}`);
});

test("recorded beforeFault9 answer: the build that asks the deposit list at the page load: FAIL, on that line alone", () => {
  const r = judge(ANSWERS.beforeFault9);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).length > 0 && bad(r).every((l) => /is asked 1 time\(s\) by the page load/.test(l)), r.lines.join("\n"));
});

test("planted: Reserve a cent off fails, and so do parts that do not add up to the tile", () => {
  fails(mut((rec) => (run(rec, "desktop").parts.parts.find((p) => p.part === "reserve").cents = "70")), /Reserve is 70/);
  fails(mut((rec) => (run(rec, "phone").parts.tile = "$9.99")), /the tile reads \$9\.99/);
  fails(mut((rec) => (run(rec, "desktop").alloc = null)), /Allocation's Reserve tile is missing/);
});

test("planted: a pool list without NEAR's vault first fails", () => {
  fails(mut((rec) => run(rec, "phone").pools.shift()), /first row/);
});

test("planted: the loading skeleton on the sheet's first read, a list asked by the page load or never, and a missing Closed control fail", () => {
  fails(mut((rec) => (run(rec, "desktop").firstState = "S4.1")), /first read after it opens is S4\.1, the assets' loading skeleton/);
  fails(mut((rec) => (run(rec, "phone").loadAsks = 1)), /asked 1 time\(s\) by the page load/);
  fails(mut((rec) => (run(rec, "desktop").asks = 0)), /asked 0 time\(s\) once Deposit is pressed/);
  fails(mut((rec) => (run(rec, "phone").control.closed = 0)), /0 Closed control/);
});

test("planted: a run missing or outside the shell fails", () => {
  fails(mut((rec) => rec.runs.pop()), /run\(s\) of 2/);
  fails(mut((rec) => (run(rec, "phone").framed = false)), /not inside SIGN_HOST's shell/);
});
