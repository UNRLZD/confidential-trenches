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
import { AGAIN, CHAINS, COINS_MAX, coinsOf, judge } from "./buy-quote-before-any-note.mjs";

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

// card buy-quote-check-skips-an-unpinned-venue: the sign live run 45066381643 (22 Nov 20:40Z) failed on the first
// trending Solana coin, answered venue_not_pinned: mainnet pins pool tables for pump-curve and pumpswap only, and the page
// refuses an unpinned venue before any note is read, so that answer says nothing of a buy priced with no note
test("a coin the page cannot trade yet (venue_not_pinned, no_table_fits) moves on to the next coin; not_funded still FAILs", () => {
  /** good with Solana's coins answering `codes` in turn ("out": good's priced answer), each a coin of its own. */
  const solana = (codes) => {
    const r = copy(A.good);
    const priced = r.asks.find((x) => x.chain === "solana" && x.ok);
    const rest = r.asks.filter((x) => x.chain !== "solana");
    const asks = codes.map((c, i) => (c === "out" ? { ...copy(priced), coin: r.lists.solana.coins[i] } : { chain: "solana", coin: r.lists.solana.coins[i], amount: priced.amount, ok: false, code: c }));
    r.asks = [...asks, ...rest];
    return judge(r);
  };
  for (const skip of ["venue_not_pinned", "no_table_fits"]) {
    assert.equal(solana([skip, "out"]).verdict, "PASS", `${skip} then a priced coin`);
    const all = solana([skip, skip, skip]);
    assert.equal(all.verdict, "INCONCLUSIVE", `every coin ${skip}: ${all.lines.join("\n")}`);
    assert.ok(all.lines.some((l) => l.startsWith("no-answer [solana]") && l.includes(skip)), all.lines.join("\n"));
    assert.equal(solana([skip, "not_funded"]).verdict, "FAIL", `${skip} then not_funded`);
  }
  assert.equal(solana(["not_funded", "out"]).verdict, "FAIL", "not_funded on the first coin");
  assert.equal(solana(["venue_not_pinned", "quote_check_failed", "down"]).verdict, "INCONCLUSIVE", "every coin refused for its own reads");
});

// card buy-quote-check-skips-a-coins-market-gap: release 200's sign live run 45396972380 (24 Nov 12:5xZ) failed on its
// first Solana coin, B34nXKzC...pump, answered below_reference: its pumpswap pool priced under its Meteora DLMM SOL pool
// (3.7% on DexScreener, 13:0xZ), the rule of card solana-buy-never-below-a-hidden-market, which a pool note changes not
test("a coin whose tradable pool prices under its own market (below_reference) moves on to the next coin, as the run 45396972380 needed; every coin so is INCONCLUSIVE, not_funded after it still FAILs (red at be72fcf9e: below_reference FAILed at once)", () => {
  const solana = (codes) => {
    const r = copy(A.good);
    const priced = r.asks.find((x) => x.chain === "solana" && x.ok);
    const rest = r.asks.filter((x) => x.chain !== "solana");
    const asks = codes.map((c, i) => (c === "out" ? { ...copy(priced), coin: r.lists.solana.coins[i] } : { chain: "solana", coin: r.lists.solana.coins[i], amount: priced.amount, ok: false, code: c }));
    r.asks = [...asks, ...rest];
    return judge(r);
  };
  // the run's own first answer, as its log names it
  const run = solana(["below_reference", "out"]);
  assert.equal(run.verdict, "PASS", run.lines.join("\n"));
  const all = solana(["below_reference", "below_reference", "below_reference"]);
  assert.equal(all.verdict, "INCONCLUSIVE", all.lines.join("\n"));
  assert.ok(all.lines.some((l) => l.startsWith("no-answer [solana]") && l.includes("below_reference")), all.lines.join("\n"));
  assert.equal(solana(["below_reference", "not_funded"]).verdict, "FAIL", "below_reference then not_funded");
  assert.ok(AGAIN.has("below_reference"));
});

test("the recorded skip run (the live SIGN_HOST, 22 Nov 21:15Z): Solana's venue_not_pinned coin moves the check on to the coin priced after it, PASS", () => {
  const solana = A.skip.asks.filter((x) => x.chain === "solana");
  assert.ok(solana.some((x) => x.code === "venue_not_pinned"), "the run holds a venue_not_pinned coin");
  const v = judge(A.skip);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.startsWith("ok ") && l.includes("[solana]") && l.includes(" out ")), v.lines.join("\n"));
});
