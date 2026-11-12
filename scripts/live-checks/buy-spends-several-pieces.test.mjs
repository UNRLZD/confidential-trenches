// Replays buy-spends-several-pieces.answers.json: the good answer (this card's helper, in process) passes and the bad
// one (the helper before the card: no /v1/pool/solana/pieces, 404 for each plant) fails, with cases made from the good one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judgeAll, plants, WANT } from "./buy-spends-several-pieces.mjs";
import { SOLANA_JITO_TIP_MIN, solanaPoolFee, solanaPoolPriorityBudget } from "../../packages/kit/src/index.ts";

const A = JSON.parse(readFileSync(new URL("./buy-spends-several-pieces.answers.json", import.meta.url), "utf8"));
const edit = (runs, asked, f) => runs.map((run) => ({ ...run, reads: run.reads.map((x) => (x.asked === asked ? f(x) : x)) }));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer: two wallets refused wallets_differ, one tx bad_shape, one wallet reaches the reads: PASS", () => {
  const r = judgeAll(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer, the helper before the card: 404 for every plant: FAIL on each, on every pool", () => {
  const r = judgeAll(A.bad_before_card);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, Object.keys(WANT).length * A.bad_before_card.length, b.join("\n"));
  assert.ok(b.every((l) => l.includes(" 404 ")), b.join("\n"));
});

test("made from the good answer: two wallets let through, a signature answered, a plant missing, a pool not read, no commit: each FAIL", () => {
  const g = A.good;
  assert.equal(judgeAll(edit(g, "two_wallets", (x) => ({ ...x, status: 200, body: '{"signatures":["a","b"]}' }))).ok, false);
  assert.equal(judgeAll(edit(g, "two_wallets", (x) => ({ ...x, status: 422, body: '{"error":{"code":"blockhash_not_found"}}' }))).ok, false);
  assert.equal(judgeAll(edit(g, "one_wallet", (x) => ({ ...x, body: JSON.stringify({ error: { code: "blockhash_not_found" }, signatures: ["x"] }) }))).ok, false);
  assert.equal(judgeAll(edit(g, "one_tx", (x) => ({ ...x, status: 422, body: '{"error":{"code":"simulation_failed"}}' }))).ok, false);
  assert.equal(judgeAll(g.map((run) => ({ ...run, reads: run.reads.filter((x) => x.asked !== "two_wallets") }))).ok, false);
  assert.equal(judgeAll(g.slice(1)).ok, false);
  assert.equal(judgeAll(edit(g, "fee", (x) => ({ ...x, headers: {} }))).ok, false);
  assert.equal(judgeAll([]).ok, false);
});

test("the plants: two wallets sign the two_wallets pair, one W both of one_wallet, one tx alone; every release first", () => {
  const p = plants({ program: A.good[0].program, pool: A.good[0].pool, feePayer: JSON.parse(A.good[0].reads[0].body).fee_payer, relayFee: 1_300_000n });
  const w = (b64) => Buffer.from(b64, "base64").subarray(1 + 64 * 2 + 4 + 32, 1 + 64 * 2 + 4 + 64).toString("hex");
  assert.notEqual(w(p.two_wallets[0]), w(p.two_wallets[1]));
  assert.equal(w(p.one_wallet[0]), w(p.one_wallet[1]));
  assert.equal(p.one_tx.length, 1);
});

test("the one_wallet plant reaches the helper's reads on mainnet: at the epoch fee, no priority, the bundle's tip cap is over SOLANA_JITO_TIP_MIN at any rent up to 100 times today's (3,480 a byte); a fee_below_cost answer FAILs", () => {
  // the helper's cap (apps/helper/src/pool/solana-pieces.ts piecesTipCap): each W-signed transaction's budget less its
  // priority fee (the plant sets none), less the tip transaction's 5,000
  for (const lamportsPerByte of [1n, 3_480n, 5_080n, 348_000n]) {
    const rent = { lamportsPerByte, factor: 2n };
    const cap = 2n * solanaPoolPriorityBudget(rent, solanaPoolFee(rent)) - 5_000n;
    assert.ok(cap >= SOLANA_JITO_TIP_MIN, `${lamportsPerByte} a byte: cap ${cap}`);
  }
  assert.equal(judgeAll(edit(A.good, "one_wallet", (x) => ({ ...x, status: 422, body: '{"error":{"code":"fee_below_cost"}}' }))).ok, false);
});
