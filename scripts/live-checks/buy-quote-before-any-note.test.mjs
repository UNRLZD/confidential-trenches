// node --test scripts/live-checks/buy-quote-before-any-note.test.mjs: the live check judges recorded runs
// (buy-quote-before-any-note.answers.json), each a record the check's own --record wrote. good: this card's signing
// page build served at SIGN_HOST's name, a new account: every chain answers tap_max "0", no Cash Max and an out: PASS.
// bad: SIGN_HOST before this card, the same steps: Solana, Base and Robinhood answer not_funded and NEAR no out: FAIL.
// Planted from good: one chain's answer with no out, a tap_max other than "0", a with_cash above 0, no sign in: FAIL;
// every coin of a chain refused quote_check_failed, or no coin listed: INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAINS, COINS_MAX, coinsOf, judge } from "./buy-quote-before-any-note.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "buy-quote-before-any-note.answers.json"), "utf8"));
const copy = (x) => JSON.parse(JSON.stringify(x));
/** good with the last answer of `chain` changed by `f`. */
const planted = (chain, f) => {
  const r = copy(A.good);
  const a = r.asks.filter((x) => x.chain === chain).at(-1);
  f(a);
  return r;
};

test("the recorded good run (this card's build, a new account) passes on every chain", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  for (const chain of CHAINS) assert.ok(v.lines.some((l) => l.startsWith("ok ") && l.includes(`[${chain}]`) && l.includes(" out ")), chain);
});

test("the recorded bad run (SIGN_HOST before this card) fails: not_funded, or no out", () => {
  const v = judge(A.bad);
  assert.equal(v.verdict, "FAIL", v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.startsWith("BAD") && l.includes("not_funded")), v.lines.join("\n"));
});

test("planted from good: no out, a tap_max other than 0, Cash Max above 0, no sign in: FAIL", () => {
  for (const chain of CHAINS) {
    assert.equal(judge(planted(chain, (a) => delete a.result.out)).verdict, "FAIL", `${chain} no out`);
    assert.equal(judge(planted(chain, (a) => (a.result.out = "0"))).verdict, "FAIL", `${chain} out 0`);
    assert.equal(judge(planted(chain, (a) => (a.result.tap_max = "0.01"))).verdict, "FAIL", `${chain} tap_max`);
    assert.equal(judge(planted(chain, (a) => (a.result.with_cash = "0.5"))).verdict, "FAIL", `${chain} with_cash`);
    assert.equal(judge(planted(chain, (a) => Object.assign(a, { ok: false, code: "not_funded", result: undefined }))).verdict, "FAIL", `${chain} not_funded`);
  }
  assert.equal(judge({ ...copy(A.good), signedIn: false }).verdict, "FAIL");
});

test("a chain whose every coin's venue is not read, or with no coin listed: INCONCLUSIVE, never PASS", () => {
  const r = copy(A.good);
  for (const a of r.asks.filter((x) => x.chain === "solana")) Object.assign(a, { ok: false, code: "quote_check_failed", result: undefined });
  assert.equal(judge(r).verdict, "INCONCLUSIVE");
  // one coin with no quote (no out) beside one with an out: the coin with the out is judged, PASS
  const two = copy(A.good);
  const ok = two.asks.find((x) => x.chain === "base");
  two.asks.splice(two.asks.indexOf(ok), 0, { ...copy(ok), coin: "0x" + "ab".repeat(20), result: { tap_max: "0", with_cash: "0" } });
  assert.equal(judge(two).verdict, "PASS");
  // no out on every coin asked: FAIL
  const noOut = copy(A.good);
  for (const a of noOut.asks.filter((x) => x.chain === "base")) delete a.result.out;
  assert.equal(judge(noOut).verdict, "FAIL");
  const none = copy(A.good);
  none.lists.base.coins = [];
  none.asks = none.asks.filter((a) => a.chain !== "base");
  assert.equal(judge(none).verdict, "INCONCLUSIVE");
});

test("coinsOf: the chain's coins, trending then graduating then new, each once, at most COINS_MAX; Solana's pump mints first", () => {
  const row = (chain, token) => ({ chain, token });
  const many = Array.from({ length: COINS_MAX + 2 }, (_, i) => row("base", `n${i}`));
  const lists = { lists: { trending_1h: [row("base", "a"), row("solana", "x")], trending: [row("base", "a"), row("base", "b")], graduating: [row("solana", "ypump")], new: many } };
  assert.deepEqual(coinsOf(lists, "base"), ["a", "b", ...many.map((r) => r.token)].slice(0, COINS_MAX));
  assert.deepEqual(coinsOf(lists, "solana"), ["ypump", "x"]);
  assert.deepEqual(coinsOf(null, "base"), []);
});
