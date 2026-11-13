// node --test scripts/live-checks/deposit-takes-each-pools-own-coin.test.mjs: the live check replays its recorded answers
// (deposit-takes-each-pools-own-coin.answers.json, its _note says where each was read).
//   good: this card's signing page: the USDC rows, then SOL on Solana, ETH on Base and ETH on Robinhood at each pool's
//     floor: PASS.
//   bad: main 6de76338d's signing page: the USDC rows alone: FAIL.
// Planted on good: a pool coin missing, listed twice or before a USDC row, another chain, symbol or decimals, a min at
// or under the rung or of two rungs, another max_usd, no USDC row, a 1Click ask about a pool coin, no ready, a refusal:
// FAIL each.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, POOL_COINS, judge, units } from "./deposit-takes-each-pools-own-coin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "deposit-takes-each-pools-own-coin.answers.json"), "utf8"));
const answerOf = (a) => a.log.find((m) => m.data?.id === a.ids.assets).data;
const rows = (a) => answerOf(a).result.assets;
const plant = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return judge(a);
};
const row = (a, id) => rows(a).find((x) => x.origin_asset === id);

test("recorded good answer: the USDC rows, then each pool's own coin at its floor: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(EXIT[v.verdict], 0);
  assert.deepEqual(rows(A.good).map((x) => `${x.symbol} ${x.chain}`), ["USDC near", "USDC solana", "USDC base", "SOL solana", "ETH base", "ETH robinhood"]);
});

test("recorded bad answer: main's page lists the USDC rows alone: FAIL, naming each pool coin", () => {
  const v = judge(A.bad);
  assert.equal(v.verdict, "FAIL");
  assert.equal(EXIT[v.verdict], 1);
  assert.deepEqual(v.lines, POOL_COINS.map((c) => `BAD deposit.assets ${c.symbol} on ${c.chain} (${c.id}) is not listed`));
});

test("units: exact base units, or null", () => {
  assert.equal(units("0.0135864", 9), 13_586_400n);
  assert.equal(units("1", 18), 10n ** 18n);
  assert.equal(units("0.0000000001", 9), null);
  assert.equal(units("1e-3", 18), null);
});

test("planted on good: each way the rows can be wrong: FAIL each", () => {
  const [sol, base, hood] = POOL_COINS.map((c) => c.id);
  const cases = {
    "SOL missing": (a) => (answerOf(a).result.assets = rows(a).filter((x) => x.origin_asset !== sol)),
    "Robinhood ETH missing": (a) => (answerOf(a).result.assets = rows(a).filter((x) => x.origin_asset !== hood)),
    "Base ETH twice": (a) => rows(a).push(structuredClone(row(a, base))),
    "a pool coin before a USDC row": (a) => rows(a).unshift(rows(a).splice(rows(a).findIndex((x) => x.origin_asset === sol), 1)[0]),
    "another chain": (a) => (row(a, base).chain = "robinhood"),
    "another symbol": (a) => (row(a, sol).symbol = "WSOL"),
    "other decimals": (a) => (row(a, hood).decimals = 9),
    "a min at the rung": (a) => (row(a, sol).min = "0.01"),
    "a min under the rung": (a) => (row(a, base).min = "0.0005"),
    "a min of two rungs": (a) => (row(a, hood).min = "0.002"),
    "a min that is no amount": (a) => (row(a, sol).min = "0.0000000001"),
    "another max_usd": (a) => (row(a, base).max_usd = "500"),
    "no USDC row": (a) => (answerOf(a).result.assets = rows(a).filter((x) => x.symbol !== "USDC")),
    "a 1Click ask about a pool coin": (a) => a.helper.push({ phase: "assets", url: "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote", method: "POST", body: { dry: true, originAsset: sol }, status: 201 }),
    "a 1Click ask into a pool coin": (a) => a.helper.push({ phase: "assets", url: "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote", method: "POST", body: { dry: true, destinationAsset: base }, status: 201 }),
    "no ready": (a) => (a.ready = false),
    "a refusal": (a) => Object.assign(answerOf(a), { ok: false, error: { code: "busy" }, result: undefined }),
    "no answer": (a) => (a.log = a.log.filter((m) => m.data?.id !== a.ids.assets)),
  };
  for (const [name, f] of Object.entries(cases)) assert.equal(plant(f).verdict, "FAIL", name);
});
