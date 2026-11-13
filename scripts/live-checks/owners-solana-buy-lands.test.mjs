// node --test scripts/live-checks/owners-solana-buy-lands.test.mjs: the live check replays its recorded answers
// (owners-solana-buy-lands.answers.json). good: this card's tree (owners-solana-buy-lands.record-local.mjs: a local
// signing page build, the helper sender in process): one tip for every set, the tight plant reaching the reads: PASS.
// bad: the live hosts before the card (13 Nov 09:21Z, helper 6de76338d): the tip by the count of pieces, the tight plant
// refused fee_below_cost: FAIL, each named. Planted on the good one: another /app.js, the rule not read, a tip at the
// minimum, a fee_below_cost answer, no commit: each FAIL. And the reads of the minified rule.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, tightPrice, tipRule } from "./owners-solana-buy-lands.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./owners-solana-buy-lands.answers.json", import.meta.url), "utf8"));
const edit = (f) => f(structuredClone(ANSWERS.good));

test("recorded good answer: this card's tree: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: the live hosts before the card: FAIL, the tip rule and the tight plant named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.ok(v.lines.some((l) => l.startsWith("BAD the tip rule tips by the count of pieces")), v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.startsWith("BAD the tight plant") && l.includes("fee_below_cost")), v.lines.join("\n"));
});

test("planted on the good answer: each FAILs", () => {
  const plants = [
    (a) => ((a.sign.sha384 = "sha384-other"), a),
    (a) => ((a.sign.rule = { found: false }), a),
    (a) => ((a.sign.rule.tip = "1000"), a),
    (a) => ((a.sign.rule.tip = "1000001"), a),
    (a) => ((a.helper.tight.body = '{"error":{"code":"fee_below_cost","detail":"the relay fees pay no tip Jito takes"}}'), a),
    (a) => ((a.helper.tight.status = 200), a),
    (a) => (delete a.helper.tight, a),
    (a) => ((a.helper.tight.commit = null), a),
  ];
  for (const [i, p] of plants.entries()) assert.equal(judge(edit(p)).ok, false, `plant ${i}`);
});

test("the minified tip rule: one tip for every set read, the rule by count told apart, none read when absent; the tight price", () => {
  const head = "var bc=1000n,xc=100000n;function Tm(e,t){if(!Number.isSafeInteger(t)||t<1||t>4)throw Error(`pieces: 1 to 4`);return e===`devnet`?0n:";
  assert.deepEqual(tipRule(`${head}xc}`), { found: true, byCount: false, tip: "100000" });
  assert.deepEqual(tipRule(`${head}t===1?xc:bc}`), { found: true, byCount: true });
  assert.deepEqual(tipRule("let v=e.cluster===`mainnet`?Sd:0n;"), { found: false });
  // 1,000 lamports under the kit's priority budget at mainnet rent and fee (207,245): 400,000 CU at 515,612 micro-lamports
  assert.equal(tightPrice(207_245n), 515_612n);
  assert.ok((400_000n * tightPrice(207_245n)) / 1_000_000n <= 207_245n - 1_000n);
  assert.equal(tightPrice(1_000n), null);
});
