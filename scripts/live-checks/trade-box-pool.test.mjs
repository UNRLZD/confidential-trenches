// node --test scripts/live-checks/trade-box-pool.test.mjs: the live check's verdict replays recorded runs
// (trade-box-pool.answers.json), each read on 4 Nov by trade-box-pool.mjs collect() in headless Chromium, the stand-in
// shell sending a signed-in state with the devnet Solana pool (one 0.01 SOL note), its proof ready and still making:
//   good (4 Nov; the 10 Nov record below replaces it): the deployed APP_HOST at main 27d7ce0 (entry /assets/index-D2sAQfy_.js), read at 12:03Z: at 1440 and 390 the
//         token page's box is on the pool path, its proof label is the state's, and a tap asks for no vault buy: PASS;
//   bad:  the deployed APP_HOST on 4 Nov, before this card: the box is on the vault's path with no proof label: FAIL.
// Recorded again on 10 Nov (card live-check-pool-price-own-token), on the token's own page /token/solana/<DJT>, which
// also reads the token and chain the page drew:
//   good: the deployed APP_HOST (entry /assets/index-XvbkxnaR.js), read at 03:27Z: DJT on Solana at both widths, the box
//         on the pool path, the proof label the state's, a tap asks for no vault buy: PASS;
//   wrongChain: the same check opening / (its old path) at 03:27Z, when the live Trending column's top was "Anthropic"
//         (0xecc4...1627) on Robinhood: the box is on the vault path, and the verdict names the token and chain: FAIL.
// Planted from the good run: a tap that sends the vault's buy, a proof label that is not the state's or has no words, a
// box off the pool path, a missing run, a terminal outside the shell, no entry script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAIN, judge, POOL } from "./trade-box-pool.mjs";
import { MINT } from "./app-sell-mount.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "trade-box-pool.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w, p) => rec.runs.find((r) => r.width === w && r.proof === p);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("the state's pool is the devnet one: a 0.01 SOL note, one tap's most by the kit's rule (1,736,080 lamports)", () => {
  assert.deepEqual(POOL.ready, { chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0.00173608" });
  // the making state names a proof being made: without `making` the box draws no label (red on release 125, live run 43328445607)
  assert.deepEqual(POOL.making, { chain: "solana", asset: "SOL", balance: "0.01", ready: "0", making: "0.01" });
});

test("recorded good answer: the pool path, the state's proof label, no vault buy, at both widths: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 4);
});

test("recorded bad answer: the deployed app before this card keeps the vault's path with no proof label: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /^BAD desktop ready: .*the box is on the (vault|unmarked) path/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD phone making: .*its proof label is none/.test(l)), r.lines.join("\n"));
});

test("planted: a tap that sends the vault's buy, or anything but pool.buy, fails", () => {
  fails(mut((rec) => (run(rec, "desktop", "ready").sent = ["buy"])), /^BAD desktop ready: a tap asked the shell for the vault's buy/);
  fails(mut((rec) => (run(rec, "phone", "ready").sent = ["withdraw.open"])), /^BAD phone ready: a tap asked the shell for withdraw\.open/);
  fails(mut((rec) => (run(rec, "phone", "making").sent = null)), /^BAD phone making: the tap was not read/);
});

test("planted: a proof label that is not the state's, or has no words, and a box off the pool path fail", () => {
  fails(mut((rec) => (run(rec, "desktop", "making").box.proof = "ready")), /^BAD desktop making: its proof label is ready, the state's is making/);
  fails(mut((rec) => (run(rec, "phone", "ready").box.proofText = null)), /^BAD phone ready: its proof label has no words/);
  fails(mut((rec) => (run(rec, "desktop", "ready").box.path = "vault")), /^BAD desktop ready: the box is on the vault path/);
  fails(mut((rec) => (run(rec, "phone", "ready").box = null)), /^BAD phone ready: no trade box/);
});

test("planted: a missing run, a terminal outside the shell, no screenshot, no entry script fail", () => {
  fails(mut((rec) => rec.runs.pop()), /^BAD 3 run\(s\) of 4/);
  fails(mut((rec) => (run(rec, "desktop", "ready").framed = false)), /^BAD desktop ready: not inside SIGN_HOST's shell/);
  fails(mut((rec) => (run(rec, "desktop", "making").shot = null)), /^BAD desktop making: no screenshot/);
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
  fails(mut((rec) => (run(rec, "desktop", "ready").chain = "base")), /^BAD desktop ready: the token page drew DJT\w+ on base, not the Solana token DJT\w+ on solana/);
  fails(mut((rec) => (run(rec, "phone", "making").mint = "So11111111111111111111111111111111111111112")), /^BAD phone making: the token page drew So1\w+ on solana, not the Solana token DJT/);
  fails(mut((rec) => (run(rec, "desktop", "making").chain = null)), /^BAD desktop making: the token page drew DJT\w+ on no chain/);
  fails(mut((rec) => (run(rec, "phone", "ready").mint = null)), /^BAD phone ready: the token page drew no token on solana/);
});
