// node --test scripts/live-checks/solana-buy-reaches-raydium-and-meteora.test.mjs: the live check's verdict replays
// recorded runs (solana-buy-reaches-raydium-and-meteora.answers.json), each read on 15 Nov 05:45Z by its .mjs with
// --record, every answer as provider-answer.mjs's rpcAnswer gives it:
//   good: this branch's helper RPC route (createRpc) on a local port, route A the public mainnet endpoint: each kit scan,
//         the coin on either side, answers a list and together they name NEARKAT's DLMM pairs B8BH6ZKr… and J3wZVx37…,
//         HIGH's CPMM pool CqvMZmWD… and CzLSuj's AMM v4 pool 9Tb2ohu5…; each one-mint scan is refused
//         method_not_allowed: PASS;
//   bad:  the deployed helper (ct-api.unrealized.trade, main before this card) refuses every kit scan
//         method_not_allowed, so the page finds no pool: FAIL.
// Planted from the good run: a list without one of the pools, an entry that is no address, a wide scan let through, an
// upstream error (FAIL); a no-answer (INCONCLUSIVE, never PASS; FAIL still wins); a missing answer (ERROR).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NEARKAT_PAIRS, VENUES, judge, requests } from "./solana-buy-reaches-raydium-and-meteora.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "solana-buy-reaches-raydium-and-meteora.answers.json"), "utf8"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r) => r.lines.filter((l) => l.startsWith("FAIL"));
const keys = (a) => a.result.value.map((e) => e.pubkey);

test("recorded good answer: each venue's scans name its coin's SOL pools, each one-mint scan is refused: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  for (const [k, v] of Object.entries(VENUES)) {
    const all = [...keys(ANSWERS.good[k].scan), ...keys(ANSWERS.good[k].flip)];
    for (const p of v.pools) assert.ok(all.includes(p), `${k} ${p}`);
  }
  // HIGH's and CzLSuj's pools hold wSOL on the first side: only the wSOL-first scan names them
  assert.deepEqual(keys(ANSWERS.good.cpmm.flip), VENUES.cpmm.pools);
  assert.deepEqual(keys(ANSWERS.good.ammV4.flip), VENUES.ammV4.pools);
});

test("recorded bad answer: the deployed helper refuses the kit's scans: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.verdict, "FAIL");
  for (const k of Object.keys(VENUES)) assert.deepEqual(ANSWERS.bad[k].scan.error, { code: "method_not_allowed" }, k);
  assert.ok(fails(r).some((l) => /Raydium CPMM pool scan for HIGH, wSOL first, answers a list \(error .*method_not_allowed/.test(l)), r.lines.join("\n"));
  assert.ok(fails(r).some((l) => /Raydium AMM v4 pool scan for CzLSuj, wSOL first, answers a list \(error .*method_not_allowed/.test(l)), r.lines.join("\n"));
});

test("planted: a pool missing, an entry that is no address, a wide scan let through, an upstream error: FAIL", () => {
  for (const [name, f, want] of [
    ["pair missing", (r) => (r.dlmm.scan.result.value = r.dlmm.scan.result.value.filter((e) => e.pubkey !== NEARKAT_PAIRS[1])), /names NEARKAT's SOL pool J3wZ/],
    ["CPMM pool missing", (r) => (r.cpmm.flip.result.value = []), /names HIGH's SOL pool CqvMZmWD/],
    ["AMM v4 pool missing", (r) => (r.ammV4.flip.result.value = []), /names CzLSuj's SOL pool 9Tb2ohu5/],
    ["not an address", (r) => r.dlmm.scan.result.value.push({ pubkey: "0xdead" }), /every DLMM pair entry, the coin first, is an address/],
    ["wide let through", (r) => (r.ammV4.wide = structuredClone(r.ammV4.scan)), /AMM v4 pool scan with one mint alone is refused by the helper, method_not_allowed \(it answered a result\)/],
    ["wide refused another way", (r) => (r.cpmm.wide = { error: { code: -32602, message: "bad params" } }), /CPMM pool scan with one mint alone is refused by the helper, method_not_allowed \(error/],
    ["upstream error", (r) => (r.cpmm.flip = { error: { code: -32010, message: "excluded from account secondary indexes" } }), /CPMM pool scan for HIGH, wSOL first, answers a list \(error/],
  ]) {
    const r = mut(f);
    assert.equal(r.verdict, "FAIL", name);
    assert.ok(fails(r).some((l) => want.test(l)), `${name}: ${r.lines.join("\n")}`);
  }
});

test("a no-answer from the helper is INCONCLUSIVE, never a PASS; a FAIL elsewhere still FAILs; a missing answer is an ERROR", () => {
  const no = { noAnswer: "ct-api.unrealized.trade HTTP 429: 429 Too Many Requests" };
  for (const [k, q] of [["cpmm", "flip"], ["dlmm", "wide"], ["ammV4", "scan"]]) {
    const r = mut((x) => (x[k][q] = structuredClone(no)));
    assert.equal(r.verdict, "INCONCLUSIVE", `${k} ${q}: ${r.lines.join("\n")}`);
    assert.ok(r.lines.some((l) => l.startsWith("NO ") && l.includes("429")), r.lines.join("\n"));
  }
  assert.equal(mut((x) => { x.cpmm.flip = structuredClone(no); x.ammV4.flip.result.value = []; }).verdict, "FAIL");
  assert.equal(mut((r) => delete r.dlmm.wide).verdict, "ERROR");
  assert.equal(mut((r) => (r.cpmm.flip = null)).verdict, "ERROR");
  assert.equal(mut((r) => delete r.ammV4).verdict, "ERROR");
});

test("the requests: each kit scan as the page sends it, both orders, and the coin-first one with the wSOL filter dropped", () => {
  const q = requests();
  assert.deepEqual(Object.keys(q), ["dlmm", "cpmm", "ammV4"]);
  for (const r of Object.values(q)) {
    assert.deepEqual(Object.keys(r.scan), ["method", "params"]);
    assert.equal(r.scan.method, "getProgramAccounts");
    assert.equal(r.scan.params[1].filters.length, 3);
    assert.deepEqual(r.flip.params[1].filters.map((f) => f.memcmp?.bytes), [undefined, r.scan.params[1].filters[2].memcmp.bytes, r.scan.params[1].filters[1].memcmp.bytes]);
    assert.deepEqual(r.wide.params[1].filters, r.scan.params[1].filters.slice(0, 2));
  }
});
