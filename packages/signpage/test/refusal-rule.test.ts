// The rule word on a refused trade (src/refusal-rule.ts, card evm-buy-and-sell-on-mainnet): a fixed word from the rule
// lists, never an address, an amount or a message, and every rule the device's rules refuse with is on the list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { EvmQuoteError } from "../../kit/src/checks/evm/quote.ts";
import { EvmBuyTapRefused } from "../../kit/src/trade/evm/buy-tap.ts";
import { EvmPoolBuyError } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { KIT_CODE_WORDS, POOL_RULE_WORDS, refusalRule } from "../src/refusal-rule.ts";
import { PoolRuleRefused } from "../src/rules/pool.ts";

// every literal rule word in the page's sources: refuse("x") in rules/pool.ts and new PoolRuleRefused("x") anywhere
const sourceWords = (): Set<string> => {
  const words = new Set<string>();
  const read = (f: string, re: RegExp) => {
    for (const m of readFileSync(new URL(f, import.meta.url), "utf8").matchAll(re)) words.add(m[1]!);
  };
  read("../src/rules/pool.ts", /\brefuse\("([^"]*)"\)/g);
  for (const dir of ["../src/", "../src/rules/"]) {
    for (const f of readdirSync(new URL(dir, import.meta.url))) if (f.endsWith(".ts")) read(dir + f, /new PoolRuleRefused\("([^"]*)"\)/g);
  }
  return words;
};

test("the list is the rules' own words: each literal rule in the page's sources is on it, and nothing else", () => {
  assert.deepEqual([...sourceWords()].sort(), [...POOL_RULE_WORDS].sort());
});

test("every listed word is a plain word: no address, amount, hex or message can be one", () => {
  for (const w of [...POOL_RULE_WORDS, ...KIT_CODE_WORDS]) assert.match(w, /^[a-z][a-z0-9_]{0,30}[a-z]$/, w);
});

test("a refusal names its rule, the kit's code, or the tap's last refusal's; anything else is other", () => {
  assert.equal(refusalRule(new PoolRuleRefused("deadline_past")), "deadline_past");
  assert.equal(refusalRule(new EvmQuoteError("stale_quote", "the quote's block is more than 30 s old")), "stale_quote");
  assert.equal(refusalRule(new EvmPoolBuyError("not_pinned", "the adapter is not base's pinned uniswap-v3 adapter")), "not_pinned");
  assert.equal(refusalRule(new EvmBuyTapRefused("quote_check_failed", new EvmQuoteError("no_quote", "x"))), "no_quote");
  assert.equal(refusalRule(new EvmBuyTapRefused("quote_check_failed", null)), "other");
  // a tap refusal inside a tap refusal is not read through
  assert.equal(refusalRule(new EvmBuyTapRefused("quote_check_failed", new EvmBuyTapRefused("quote_check_failed", new EvmQuoteError("no_quote", "x")))), "other");
  for (const e of [new Error("deadline_past"), null, undefined, "deadline_past", 7, { name: "Other", rule: "min_out" }]) assert.equal(refusalRule(e), "other");
});

test("no address, amount or message rides in the word, whatever the error carries", () => {
  const hostile = ["0x4611338bf66389a2d2d3e67301dbb7ac9fb1fb9d", "4611338bf66389a2d2d3e67301dbb7ac9fb1fb9d", "1000000000000000", "pool request not allowed: min_out", "min_out 0x46", "MIN_OUT", ""];
  for (const v of hostile) {
    assert.equal(refusalRule(new PoolRuleRefused(v)), "other", v);
    assert.equal(refusalRule(Object.assign(new EvmQuoteError("no_quote", v), { code: v })), "other", v);
    assert.equal(refusalRule({ name: "PoolRuleRefused", rule: v }), "other", v);
    assert.equal(refusalRule({ name: "EvmPoolBuyError", code: v }), "other", v);
  }
});
