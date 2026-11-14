// node --test scripts/live-checks/solana-buy-reaches-raydium-and-meteora.test.mjs: the live check's verdict replays
// recorded runs (solana-buy-reaches-raydium-and-meteora.answers.json), each read on 14 Nov by its .mjs with --record:
//   good: this branch's helper RPC route (createRpc) on a local port, route A the public mainnet endpoint: the kit's scan
//         answers 200 with NEARKAT's four DLMM SOL pairs, B8BH6ZKr… and J3wZVx37… among them, and the one-mint scan 400: PASS;
//   bad:  the deployed helper (ct-api.unrealized.trade, main before this card) refuses the kit's scan 400
//         method_not_allowed, so the page finds no pair: FAIL.
// Planted from the good run: a list without one of the pairs, an entry that is no address, a wide scan let through, an
// upstream error, and a missing answer (ERROR, not FAIL).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NEARKAT_PAIRS, judge, requests } from "./solana-buy-reaches-raydium-and-meteora.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "solana-buy-reaches-raydium-and-meteora.answers.json"), "utf8"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r) => r.lines.filter((l) => l.startsWith("FAIL"));

test("recorded good answer: the kit's scan names NEARKAT's two SOL pairs, the one-mint scan is refused: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  const keys = ANSWERS.good.scan.json.result.value.map((e) => e.pubkey);
  for (const p of NEARKAT_PAIRS) assert.ok(keys.includes(p));
});

test("recorded bad answer: the deployed helper refuses the kit's scan: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.verdict, "FAIL");
  assert.equal(ANSWERS.bad.scan.status, 400);
  assert.match(fails(r)[0], /answers 200 with a list \(status 400, error .*method_not_allowed/);
});

test("planted: a pair missing, an entry that is no address, a wide scan let through, an upstream error: FAIL", () => {
  for (const [name, f, want] of [
    ["pair missing", (r) => (r.scan.json.result.value = r.scan.json.result.value.filter((e) => e.pubkey !== NEARKAT_PAIRS[1])), /names NEARKAT's SOL pair J3wZ/],
    ["not an address", (r) => r.scan.json.result.value.push({ pubkey: "0xdead" }), /every entry is an address/],
    ["wide let through", (r) => (r.wide = structuredClone(r.scan)), /one mint alone is refused 400 \(status 200\)/],
    ["upstream error", (r) => (r.scan = { status: 200, json: { jsonrpc: "2.0", id: 1, error: { code: -32010, message: "excluded from account secondary indexes" } } }), /answers 200 with a list/],
  ]) {
    const r = mut(f);
    assert.equal(r.verdict, "FAIL", name);
    assert.ok(fails(r).some((l) => want.test(l)), `${name}: ${r.lines.join("\n")}`);
  }
});

test("no answer to a request is an ERROR, never a PASS", () => {
  assert.equal(mut((r) => delete r.wide).verdict, "ERROR");
  assert.equal(mut((r) => (r.scan = null)).verdict, "ERROR");
});

test("the requests: the kit's scan as the page sends it, and the same with the wSOL filter dropped", () => {
  const q = requests();
  assert.equal(q.scan.method, "getProgramAccounts");
  assert.equal(q.scan.params[1].filters.length, 3);
  assert.deepEqual(q.wide.params[1].filters, q.scan.params[1].filters.slice(0, 2));
});
