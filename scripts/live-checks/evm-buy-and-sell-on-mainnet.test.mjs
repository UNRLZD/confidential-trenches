// node --test scripts/live-checks/evm-buy-and-sell-on-mainnet.test.mjs: the live check evm-buy-and-sell-on-mainnet,
// replayed. evm-buy-and-sell-on-mainnet.answers.json holds two real runs from the Mac (`--record`), none edited:
// - good: `--local`, this change's SIGN_HOST build in SIGN_HOST's place: PASS;
// - bad_live_before: SIGN_HOST as served before this change (no EVM buy, no carry, no Sell typed data): FAIL.
// And plants on the good run: a buy with no carry, a sale with no open record, no withdraw, a testnet pool, an unpinned
// bundle: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, MARKS, pageFacts } from "./evm-buy-and-sell-on-mainnet.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-buy-and-sell-on-mainnet.answers.json", import.meta.url), "utf8"));
const spoil = (f) => {
  const a = structuredClone(A.good);
  f(a.page);
  return judge(a);
};
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good run passes: this change's build carries the EVM buy with its carry and the sale with its open record, under the one rule", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.from, "local build");
});

test("the recorded bad run fails: SIGN_HOST before this change, no buy, no carry, no sale", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.verdict, "FAIL");
  const b = bad(v).join("\n");
  for (const part of ["the EVM pool buy", "the carry", "the EVM pool sale"]) assert.ok(b.includes(part), `${part}: ${b}`);
});

test("plants on the good run each fail", () => {
  const cases = {
    "a buy with no carry": (p) => (p.carry = []),
    "a buy with half its carry": (p) => (p.carry = p.carry.slice(1)),
    "a sale with no open record": (p) => (p.sell = p.sell.filter((m) => m !== "owed/sell-evm")),
    "no EVM withdraw": (p) => (p.withdraw = 0),
    "no rule": (p) => (p.rule = false),
    "a testnet pool": (p) => (p.testnet = ["0xeb967dfc1b4ffb22942f833c76866ea85fc42266"]),
    "one mainnet pool": (p) => (p.pools = p.pools.slice(0, 1)),
    "not the pinned bundle": (p) => (p.sha384 = "sha384-other"),
  };
  for (const [name, f] of Object.entries(cases)) assert.equal(spoil(f).verdict, "FAIL", name);
  assert.equal(judge({}).verdict, "FAIL", "nothing read");
});

test("pageFacts finds each part's marks in a bundle's text", () => {
  const js = [...MARKS.buy, ...MARKS.carry, ...MARKS.sell].join(";");
  const f = pageFacts('<script src="/app.js" integrity="sha384-AAAA"></script>', js);
  assert.equal(f.pin, "sha384-AAAA");
  assert.deepEqual([f.buy, f.carry, f.sell], [[...MARKS.buy], [...MARKS.carry], [...MARKS.sell]]);
  assert.deepEqual(pageFacts("", "plain").buy, []);
});
