// node --test scripts/live-checks/deposit-to-pool.test.mjs: the live check's verdict replays recorded runs
// (deposit-to-pool.answers.json), each read by deposit-to-pool.mjs collect() in headless Chromium, the stand-in shell of
// app-deposit-mount.mjs sending a signed-in account and answering the deposit reads:
//   good: card deposit-to-pool-pools' build served at APP_HOST's name (--harness --build): at 390 and 1440, dark and
//         light, Portfolio reads $0.00, the header's Deposit opens the one sheet, whose To row reads NEAR, Solana, Base,
//         Robinhood with each chain's own mark, the vault picked, the vault and Solana fundable (the stand-in answers
//         Solana's pool.address, refuses Base's and Robinhood's); Base and Robinhood picked draw pool-off with Get address
//         off and ask nothing; the vault picked back sends one deposit.dry and deposit.quote for 15 only and draws the
//         quote's address; every follower stage draws its own state, Deposited only at done, the balance moving only
//         then; Done closes the sheet and Portfolio reads $73.18; the sheet again, Solana picked draws the form with Get
//         address on, which sends one pool.address for Solana, the asset and 15, draws the pool quote's address, every
//         pool stage its own state, the pool's Balance (`.damt-done[data-balance]`) only at in_pool, with the label Balance and
//         no Ready or Pending; Done closes it and Portfolio's Solana row reads the pool's balance: PASS (re-recorded 13 Nov on
//         card screens-never-say-proof's build; 13 Nov 07:53Z: removed, the app names no proof);
//   main:  main's build 4c1826a75 (--harness --build), which still draws the in-pool state's Ready and Pending and Portfolio's
//         data-ready: FAIL;
//   bad:  main's build before this card (--harness --build of main 56bcd0d0): Solana is Not available, never
//         fundable, its Get address off, no pool.address quote, no pool stage: FAIL.
// Planted from the good run: a closed pool that sends a quote or keeps Get address on, a tile with another chain's mark,
// a row out of order, the sheet opening on a pool, Deposited before done, a balance that moves early, Portfolio not
// updated; Solana's quote sent to another chain or as a vault quote, another address, a pool stage out of turn, the
// pool's Balance before in_pool, a Ready or Pending mark in the in-pool state, Portfolio's Solana row not updated.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./deposit-to-pool.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "deposit-to-pool.answers.json"), "utf8"));
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

test("recorded good answer: the To row, the closed pools asking nothing, the vault's deposit and Solana's pool deposit through every stage, Portfolio updated: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const x of ANSWERS.good.runs) assert.deepEqual([x.tiles.map((t) => t.dest), x.tiles.map((t) => t.fundable), x.totalAfter, x.open.stages.at(-1), x.open.rowAfter], [["near", "solana", "base", "robinhood"], ["yes", "yes", "no", "no"], "$73.18", "pool-in", { balance: "410000000" }], `${x.width} ${x.scheme}`);
});

test("recorded bad answer: main's build before this card keeps Solana Not available: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const n of ["phone dark", "phone light", "desktop dark", "desktop light"]) {
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${n}: fundable tiles ["yes","no","no","no"]`)), `${n}\n${r.lines.join("\n")}`);
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${n}: solana picked draws pool-off, Get address OFF`)), `${n}\n${r.lines.join("\n")}`);
  }
  // what main got right stays right: the closed pools and the vault's deposit
  assert.ok(!bad(r).some((l) => /base picked|robinhood picked|the follower's stages|Portfolio's total/.test(l)), r.lines.join("\n"));
});

test("planted: a pool that asks a quote, draws another state or keeps Get address on fails", () => {
  fails(mut((rec) => (run(rec, "desktop", "dark").pools.base.asked = ["deposit.dry"])), /^BAD desktop dark: base picked asks deposit\.dry/);
  fails(mut((rec) => (run(rec, "phone", "dark").pools.robinhood.asked = ["pool.address"])), /^BAD phone dark: robinhood picked asks pool\.address/);
  fails(mut((rec) => (run(rec, "phone", "light").pools.robinhood.state = "S4.3")), /^BAD phone light: robinhood picked draws S4\.3/);
  fails(mut((rec) => (run(rec, "desktop", "light").pools.base.getOff = false)), /^BAD desktop light: base picked draws pool-off, Get address ON/);
  fails(mut((rec) => (run(rec, "desktop", "dark").pools.base.pressed = "near")), /^BAD desktop dark: base picked draws pool-off, Get address off, pressed near/);
});

test("planted: a tile with another chain's mark or none, a row out of order, opening on a pool, a pool drawn fundable fail", () => {
  fails(mut((rec) => (run(rec, "desktop", "dark").tiles[1].img = "/assets/base-Cq6sCJBo.svg")), /^BAD desktop dark: the tile\(s\) solana .* draw another chain's mark or none/);
  fails(mut((rec) => (run(rec, "phone", "dark").tiles[3].loaded = false)), /^BAD phone dark: the tile\(s\) robinhood .*not loaded/);
  fails(mut((rec) => run(rec, "phone", "light").tiles.reverse()), /^BAD phone light: the To row reads \["Robinhood","Base","Solana","NEAR"\]/);
  fails(mut((rec) => { const t = run(rec, "desktop", "light").tiles; t[0].on = "false"; t[1].on = "true"; }), /^BAD desktop light: the To row opens on solana/);
  fails(mut((rec) => (run(rec, "desktop", "dark").tiles[2].fundable = "yes")), /^BAD desktop dark: fundable tiles/);
});

test("planted: Deposited before done, a stage out of turn, a balance that moves before done, Portfolio not updated fail", () => {
  fails(mut((rec) => (run(rec, "phone", "dark").stages[2] = "S4.16")), /^BAD phone dark: the follower's stages draw/);
  fails(mut((rec) => (run(rec, "desktop", "dark").balances[3] = "$73.18")), /^BAD desktop dark: the sheet's balance per stage/);
  fails(mut((rec) => (run(rec, "desktop", "light").totalAfter = "$0.00")), /^BAD desktop light: Portfolio's total after reads \$0\.00/);
  fails(mut((rec) => (run(rec, "phone", "light").credited = "0")), /^BAD phone light: Deposited draws 0/);
});

test("planted: a quote with an extra field, a dry quote per key, another address, two sheets, a missing run, a terminal outside the shell fail", () => {
  fails(mut((rec) => (run(rec, "phone", "dark").quote.recipient = "x.near")), /^BAD phone dark: Get address sends deposit\.quote/);
  fails(mut((rec) => run(rec, "desktop", "dark").dry.unshift({ origin_asset: "nep141:wrap.near", amount: "1" })), /^BAD desktop dark: the vault picked back, typing 15 sends 2 deposit\.dry/);
  fails(mut((rec) => (run(rec, "phone", "light").address = "0xdead")), /^BAD phone light: the address state S4\.13 draws 0xdead/);
  fails(mut((rec) => (run(rec, "desktop", "dark").opened = 2)), /^BAD desktop dark: the header's Deposit opens 2 deposit sheets/);
  fails(mut((rec) => rec.runs.pop()), /^BAD 3 run\(s\) of 4/);
  fails(mut((rec) => (run(rec, "desktop", "light").framed = false)), /^BAD desktop light: not inside SIGN_HOST's shell/);
});

test("main's build before the screens named no proof: the in-pool state draws Ready (data-ready) and Pending: FAIL", () => {
  const r = judge(ANSWERS.main);
  assert.equal(r.ok, false);
  for (const n of ["phone dark", "phone light", "desktop dark", "desktop light"]) {
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${n}: the pool's Balance per pool stage`)), `${n}\n${r.lines.join("\n")}`);
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${n}: the in-the-pool state's label "Ready"`)), `${n}\n${r.lines.join("\n")}`);
  }
  // what main got right stays right: the stages, the vault's deposit, the pool's quote
  assert.ok(!bad(r).some((l) => /pool stages draw|Get address sends|fundable tiles/.test(l)), bad(r).join("\n"));
});

test("planted: Solana's quote to another chain, as a vault quote or twice, another address, a pool stage out of turn, the pool's Balance before in_pool, Portfolio's row not updated fail", () => {
  fails(mut((rec) => (run(rec, "phone", "dark").open.asked[0].chain = "base")), /^BAD phone dark: solana's Get address sends/);
  fails(mut((rec) => run(rec, "desktop", "dark").open.asked.push({ type: "deposit.quote" })), /^BAD desktop dark: solana's Get address sends/);
  fails(mut((rec) => run(rec, "phone", "light").open.asked.push({ ...run(rec, "phone", "light").open.asked[0] })), /^BAD phone light: solana's Get address sends/);
  fails(mut((rec) => (run(rec, "desktop", "light").open.address = "0xdead")), /^BAD desktop light: solana's address state S4\.13 draws 0xdead/);
  fails(mut((rec) => (run(rec, "phone", "dark").open.stages[1] = "pool-in")), /^BAD phone dark: solana's pool stages draw/);
  fails(mut((rec) => (run(rec, "desktop", "dark").open.poolBalances[2] = "0.41")), /^BAD desktop dark: the pool's Balance per pool stage/);
  fails(mut((rec) => (run(rec, "phone", "light").open.poolBalances[7] = null)), /^BAD phone light: the pool's Balance per pool stage/);
  fails(mut((rec) => (run(rec, "phone", "light").open.poolBalances[7] = "0.4")), /^BAD phone light: the pool's Balance per pool stage/);
  fails(mut((rec) => (run(rec, "desktop", "dark").open.inPool.marks = 1)), /^BAD desktop dark: the in-the-pool state's label "Balance" with 1 data-ready or data-pending marks/);
  fails(mut((rec) => (run(rec, "desktop", "dark").open.inPool.label = "Ready")), /^BAD desktop dark: the in-the-pool state's label "Ready"/);
  fails(mut((rec) => delete run(rec, "desktop", "dark").open.inPool), /^BAD desktop dark: the in-the-pool state's label null with unread/);
  fails(mut((rec) => (run(rec, "desktop", "light").open.rowAfter = null)), /^BAD desktop light: Portfolio's solana row after reads null/);
  fails(mut((rec) => (run(rec, "desktop", "light").open.rowBefore = { balance: "1" })), /^BAD desktop light: Portfolio's solana row before/);
  fails(mut((rec) => (run(rec, "phone", "dark").open.getOn = false)), /^BAD phone dark: solana picked draws S4\.3, Get address OFF/);
  fails(mut((rec) => (run(rec, "phone", "dark").open.closed = false)), /^BAD phone dark: solana's Done leaves the sheet open/);
});
