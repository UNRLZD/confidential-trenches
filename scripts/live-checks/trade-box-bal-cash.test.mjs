// node --test scripts/live-checks/trade-box-bal-cash.test.mjs: the live check's verdict replays recorded runs
// (trade-box-bal-cash.answers.json), each read on 4 Nov by trade-box-bal-cash.mjs collect() in headless Chromium, the
// stand-in shell sending app-portfolio-mount's account (Cash $67.87) without and with its Solana pool:
//   good (4 Nov; the 10 Nov record below replaces it): this card's build served at APP_HOST's name (--harness --build): with no pool the box's Bal is the header's
//         $67.87; with the pool it is the pool's (none until it is priced), at 1440 and 390: PASS;
//   bad:  the deployed APP_HOST on 4 Nov, before this card: with no pool the box's Bal is the vault's $40.50 against the
//         header's $67.87: FAIL.
// Recorded again on 10 Nov (card live-check-pool-price-own-token), on the token's own page /token/solana/<DJT>, which
// also reads the token and chain the page drew:
//   good: the deployed APP_HOST (entry /assets/index-XvbkxnaR.js), read at 03:28Z: DJT on Solana at both widths; cash
//         and pool as above: PASS;
//   wrongChain: the same check opening / (its old path) at 03:28Z, when the live Trending column's top was "Anthropic"
//         (0xecc4...1627) on Robinhood: the verdict names the token and chain: FAIL.
// Recorded again on 12 Nov (UNRLZD parity, owner 12 Nov: the box's balance line reads `<USD> available`, was `Bal <USD>`):
//   good: this tree's build (--harness --build apps/terminal/dist, entry /assets/index-DD8B9y2i.js), at 2026-11-12T22:35Z: cash
//         `$67.87 available`, the header's $67.87; pool `— available` on the pool path: PASS.
// Planted from the good run: a Bal that differs from the header, a header that is not the account's Cash, a pool run
// whose Bal is the Cash or that is off the pool path, a cash run on the pool path, a missing run, no entry script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { account, CASH, CHAIN, judge } from "./trade-box-bal-cash.mjs";
import { MINT } from "./app-sell-mount.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "trade-box-bal-cash.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w, k) => rec.runs.find((r) => r.width === w && r.kind === k);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("the accounts: Cash $67.87 both ways; the cash run sends no Solana pool, the pool run sends it", () => {
  assert.equal(CASH, "$67.87");
  assert.equal(account("cash").pools.some((p) => p.chain === "solana"), false);
  assert.equal(account("pool").pools.some((p) => p.chain === "solana"), true);
  assert.equal(account("cash").vault_balance, "40.50");
});

test("recorded good answer: the box's Bal is the header's Cash with no pool, the pool's with one, at both widths: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 4);
  for (const x of ANSWERS.good.runs.filter((x) => x.kind === "cash")) assert.equal(x.box.bal, `${CASH} available`, x.width);
});

test("recorded bad answer: the deployed app before this card draws the vault's $40.50 against the header's $67.87: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /^BAD desktop cash: .*the box's Bal is "Bal \$40\.50", the header's \$67\.87/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD phone cash: .*the box's Bal is "Bal \$40\.50"/.test(l)), r.lines.join("\n"));
});

test("planted: a Bal that differs from the header, or a header that is not the account's Cash, fails", () => {
  fails(mut((rec) => (run(rec, "desktop", "cash").box.bal = "$40.50 available")), /^BAD desktop cash: the box's Bal is "\$40\.50 available", the header's \$67\.87/);
  fails(mut((rec) => Object.assign(run(rec, "phone", "cash"), { header: "$40.50", box: { ...run(rec, "phone", "cash").box, bal: "$40.50 available" } })), /^BAD phone cash: the header's balance is \$40\.50, not the account's Cash \$67\.87/);
  fails(mut((rec) => (run(rec, "desktop", "cash").box.path = "pool")), /^BAD desktop cash: the box is on the pool path with no pool/);
});

test("planted: a pool run whose Bal is the Cash, that draws none, or that is off the pool path fails", () => {
  fails(mut((rec) => (run(rec, "desktop", "pool").box.bal = `${CASH} available`)), /^BAD desktop pool: the box's Bal is the header's Cash/);
  fails(mut((rec) => (run(rec, "phone", "pool").box.bal = null)), /^BAD phone pool: the box draws no Bal/);
  fails(mut((rec) => (run(rec, "phone", "pool").box.path = "vault")), /^BAD phone pool: the box is on the vault path/);
});

test("planted: a missing run, a terminal outside the shell, no box, no entry script fail", () => {
  fails(mut((rec) => rec.runs.pop()), /^BAD 3 run\(s\) of 4/);
  fails(mut((rec) => (run(rec, "desktop", "cash").framed = false)), /^BAD desktop cash: not inside SIGN_HOST's shell/);
  fails(mut((rec) => (run(rec, "phone", "cash").box = null)), /^BAD phone cash: no trade box/);
  fails(mut((rec) => (rec.entry = null)), /^BAD the served \/ names its entry script none/);
});

test("recorded good answer: the check drew the Solana token it opened (DJT), on solana, in every run", () => {
  assert.ok(ANSWERS.good.runs.every((r) => r.mint === MINT && r.chain === CHAIN), JSON.stringify(ANSWERS.good.runs.map((r) => [r.mint, r.chain])));
});

test("recorded wrong-chain answer: the old open path drew the live Trending top on Robinhood, and the verdict names the token and chain: FAIL", () => {
  const r = judge(ANSWERS.wrongChain);
  assert.equal(r.ok, false);
  const named = bad(r).filter((l) => /the token page drew 0x\w+ on robinhood, not the Solana token DJT\w+ on solana/.test(l));
  assert.equal(named.length, ANSWERS.wrongChain.runs.length, r.lines.join("\n"));
});

test("planted: a page of another token or chain, or one that names neither, fails with a line that says so", () => {
  fails(mut((rec) => (run(rec, "desktop", "pool").chain = "base")), /^BAD desktop pool: the token page drew DJT\w+ on base, not the Solana token DJT\w+ on solana/);
  fails(mut((rec) => (run(rec, "phone", "cash").mint = "So11111111111111111111111111111111111111112")), /^BAD phone cash: the token page drew So1\w+ on solana, not the Solana token DJT/);
  fails(mut((rec) => (run(rec, "desktop", "cash").chain = null)), /^BAD desktop cash: the token page drew DJT\w+ on no chain/);
  fails(mut((rec) => (run(rec, "phone", "pool").mint = null)), /^BAD phone pool: the token page drew no token on solana/);
});
