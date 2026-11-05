// node --test scripts/live-checks/app-export-every-wallet.test.mjs: the live check's verdict replays recorded runs
// (app-export-every-wallet.answers.json), each read on 4 Nov by app-export-every-wallet.mjs collect() in headless
// Chromium, the stand-in shell sending the fixed signed-in account (ACCOUNT):
//   good: this card's build served at APP_HOST's name (--harness): at 1440 and 390 every position wallet, the ready
//         wallet and the deposit wallet with money left has an export, and each asks for export.open with its own chain
//         and address: PASS;
//   bad:  main's build (b07b71a) served the same way, ACCOUNT less deposit_wallets (main's kit has no such field and
//         refuses the whole state with it): desktop rows have no export in their icon row (it is in the overflow
//         menu), the phone sheet's one Export names no wallet and asks for a position's first wallet only, and the
//         ready and deposit wallets have none: FAIL.
// Planted from the good run: an export that asks for another wallet, for nothing or for another kind; a wallet with no
// export; an export of a wallet that holds no money; a missing run; a terminal outside the shell; no Portfolio.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { moneyWallets } from "../../packages/kit/src/index.ts";
import { ACCOUNT, judge, WALLETS } from "./app-export-every-wallet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-export-every-wallet.answers.json"), "utf8"));
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

test("the check's wallets are the kit's: moneyWallets(ACCOUNT), positions on two chains, one on two wallets, a ready wallet and a deposit wallet with money left", () => {
  assert.deepEqual(moneyWallets(ACCOUNT).map((w) => `${w.chain}:${w.address}`), WALLETS);
  assert.deepEqual([...new Set(ACCOUNT.positions.map((p) => p.chain))], ["solana", "base"]);
  assert.ok(ACCOUNT.positions.some((p) => p.wallets.length === 2));
  assert.ok(moneyWallets(ACCOUNT).some((w) => w.role === "deposit"));
});

test("recorded good answer: every wallet that holds money has an export at both widths, each for its own chain and address: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const x of ANSWERS.good.runs) {
    assert.deepEqual([...new Set(x.taps.map((t) => `${t.chain}:${t.address}`))].sort(), [...WALLETS].sort(), x.width);
    assert.ok(x.taps.some((t) => t.from.startsWith("Wallets ")), `${x.width}: the Wallets rows were tapped`);
  }
});

test("recorded bad answer: main's build before this card leaves wallets with no export: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /^BAD desktop: no export opens solana:Fixture1\S+, solana:Fixture2\S+, solana:Fixture3\S+, solana:Fixture4\S+, base:0x\S+$/.test(l)), r.lines.join("\n"));
  // the phone sheet's one Export names no wallet of its own: it asks for the position's first wallet, never the second
  assert.ok(bad(r).some((l) => /^BAD phone: position solana:\S+ \(sheet 1 of 1\)'s export \(null:null\) asks for export\.open solana:Fixture1\S+$/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD phone: no export opens solana:Fixture1\S+, solana:Fixture2\S+, solana:Fixture3\S+, solana:Fixture4\S+, base:0x\S+$/.test(l)), r.lines.join("\n"));
});

test("planted: an export that asks for another wallet, for nothing, or for another kind fails", () => {
  fails(mut((rec) => (run(rec, "desktop").taps[0].asked[0].address = "SomeoneElse")), /^BAD desktop: position .*'s export \(solana:Fixture1\S+\) asks for export\.open solana:SomeoneElse/);
  fails(mut((rec) => (run(rec, "phone").taps.at(-1).asked = [])), /^BAD phone: Wallets \S+'s export \(solana:Fixture4\S+\) asks for nothing/);
  fails(mut((rec) => (run(rec, "phone").taps[0].asked = [{ type: "backup.open" }])), /^BAD phone: position .*'s export \(solana:Fixture1\S+\) asks for backup\.open/);
  fails(mut((rec) => run(rec, "desktop").taps[2].asked.push({ type: "withdraw.open" })), /^BAD desktop: position base:\S+'s export \(base:0x\S+\) asks for export\.open base:0x\S+, withdraw\.open/);
});

test("planted: a wallet with no export, or an export of a wallet that holds no money, fails", () => {
  fails(mut((rec) => (run(rec, "desktop").taps = run(rec, "desktop").taps.filter((t) => !t.address.startsWith("Fixture4")))), /^BAD desktop: no export opens solana:Fixture4\S+$/);
  fails(mut((rec) => (run(rec, "phone").taps = run(rec, "phone").taps.filter((t) => !t.address.startsWith("Fixture2")))), /^BAD phone: no export opens solana:Fixture2\S+$/);
  fails(
    mut((rec) => run(rec, "phone").taps.push({ from: "Wallets x", chain: "solana", address: "NotHeld", asked: [{ type: "export.open", chain: "solana", address: "NotHeld", return_key: "export" }] })),
    /^BAD phone: Wallets x's export names solana:NotHeld, no wallet that holds money/,
  );
});

test("planted: a missing run, a terminal outside the shell, or no Portfolio fails", () => {
  fails(mut((rec) => rec.runs.pop()), /^BAD 1 run\(s\) of 2/);
  fails(mut((rec) => (run(rec, "desktop").framed = false)), /^BAD desktop: not inside SIGN_HOST's shell/);
  fails(mut((rec) => Object.assign(run(rec, "phone"), { screen: null, state: null, taps: [] })), /^BAD phone: \/portfolio draws no Portfolio/);
});
