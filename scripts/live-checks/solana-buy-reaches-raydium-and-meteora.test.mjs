// node --test scripts/live-checks/solana-buy-reaches-raydium-and-meteora.test.mjs: the live check's verdict replays
// recorded runs (solana-buy-reaches-raydium-and-meteora.answers.json), each read on 15 Nov by its .mjs with --record:
//   good: this branch's helper RPC route (createRpc) on a local port, route A the public mainnet endpoint: each kit scan,
//         the coin on either side, answers 200 and together they name NEARKAT's DLMM pairs B8BH6ZKr… and J3wZVx37…,
//         HIGH's CPMM pool CqvMZmWD… and CzLSuj's AMM v4 pool 9Tb2ohu5…; each one-mint scan is 400: PASS;
//   bad:  the deployed helper (ct-api.unrealized.trade, main before this card) refuses every kit scan 400
//         method_not_allowed, so the page finds no pool: FAIL.
// Planted from the good run: a list without one of the pools, an entry that is no address, a wide scan let through, an
// upstream error, and a missing answer (ERROR, not FAIL).
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
const keys = (a) => a.json.result.value.map((e) => e.pubkey);

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
  for (const k of Object.keys(VENUES)) assert.equal(ANSWERS.bad[k].scan.status, 400, k);
  assert.ok(fails(r).some((l) => /Raydium CPMM pool scan for HIGH, wSOL first, answers 200 with a list \(status 400, error .*method_not_allowed/.test(l)), r.lines.join("\n"));
  assert.ok(fails(r).some((l) => /Raydium AMM v4 pool scan for CzLSuj, wSOL first, answers 200 with a list \(status 400/.test(l)), r.lines.join("\n"));
});

test("planted: a pool missing, an entry that is no address, a wide scan let through, an upstream error: FAIL", () => {
  for (const [name, f, want] of [
    ["pair missing", (r) => (r.dlmm.scan.json.result.value = r.dlmm.scan.json.result.value.filter((e) => e.pubkey !== NEARKAT_PAIRS[1])), /names NEARKAT's SOL pool J3wZ/],
    ["CPMM pool missing", (r) => (r.cpmm.flip.json.result.value = []), /names HIGH's SOL pool CqvMZmWD/],
    ["AMM v4 pool missing", (r) => (r.ammV4.flip.json.result.value = []), /names CzLSuj's SOL pool 9Tb2ohu5/],
    ["not an address", (r) => r.cpmm.scan.json.result.value.push({ pubkey: "0xdead" }), /every Raydium CPMM pool entry, the coin first, is an address/],
    ["wide let through", (r) => (r.ammV4.wide = structuredClone(r.ammV4.scan)), /AMM v4 pool scan with one mint alone is refused 400 \(status 200\)/],
    ["upstream error", (r) => (r.cpmm.flip = { status: 200, json: { jsonrpc: "2.0", id: 1, error: { code: -32010, message: "excluded from account secondary indexes" } } }), /CPMM pool scan for HIGH, wSOL first, answers 200 with a list/],
  ]) {
    const r = mut(f);
    assert.equal(r.verdict, "FAIL", name);
    assert.ok(fails(r).some((l) => want.test(l)), `${name}: ${r.lines.join("\n")}`);
  }
});

test("no answer to a request is an ERROR, never a PASS", () => {
  assert.equal(mut((r) => delete r.dlmm.wide).verdict, "ERROR");
  assert.equal(mut((r) => (r.cpmm.flip = null)).verdict, "ERROR");
  assert.equal(mut((r) => delete r.ammV4).verdict, "ERROR");
});

test("the requests: each kit scan as the page sends it, both orders, and the coin-first one with the wSOL filter dropped", () => {
  const q = requests();
  assert.deepEqual(Object.keys(q), ["dlmm", "cpmm", "ammV4"]);
  for (const r of Object.values(q)) {
    assert.equal(r.scan.method, "getProgramAccounts");
    assert.equal(r.scan.params[1].filters.length, 3);
    assert.deepEqual(r.flip.params[1].filters.map((f) => f.memcmp?.bytes), [undefined, r.scan.params[1].filters[2].memcmp.bytes, r.scan.params[1].filters[1].memcmp.bytes]);
    assert.deepEqual(r.wide.params[1].filters, r.scan.params[1].filters.slice(0, 2));
  }
});
