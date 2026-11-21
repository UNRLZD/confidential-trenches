// node --test scripts/live-checks/index-evm-swaps-v4-route-tape.test.mjs: the live check replays its recorded answers
// (index-evm-swaps-v4-route-tape.answers.json). bad_run_44942886709: live run 44942886709's tape of Base 0x86fb3335, its
// USDC side pool's rows while its cbBTC pool traded 214 swaps over the scan: FAIL by name. good_*: a helper with the
// card's change, the coin the scan picked, its whole third-quoted pool's tape and index-evm-swaps's own verdict on it:
// PASS. Made from the answers: a scan whose busiest third-quoted coin trades more in a v2 or v3 pool, whose pool is near
// a tie with the coin's other trading (Base 0x95669a65's two third-quoted pools, 5 against 14 swaps over 1,500 blocks and
// 65 against 53 over 12,000, read 21 Nov 23:4xZ), or with none at all, judges no coin (INCONCLUSIVE); a run that judged another coin than the scan picks, a tape from the vendor, or
// index-evm-swaps's FAIL: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { candidates, DOMINANCE, judge, pick } from "./index-evm-swaps-v4-route-tape.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "index-evm-swaps-v4-route-tape.answers.json"), "utf8"));
const BAD = A.bad_run_44942886709;
const GOOD = Object.entries(A).filter(([k]) => k.startsWith("good"));
const copy = (x) => JSON.parse(JSON.stringify(x));

test("bad_run_44942886709: the cbBTC pool's swaps are not on the tape, its USDC side pool's are: FAIL by name", () => {
  const v = judge(BAD);
  assert.equal(v.verdict, "FAIL", v.lines.join("\n"));
  assert.ok(v.lines.some((l) => /^BAD \d+ of \d+ swap transactions of the coin's busiest pool 0xc265b42f/.test(l)), v.lines.join("\n"));
});

test("the bad answer's own tape made whole (every swap of the cbBTC pool in its range on it) passes this check's rule", () => {
  const r = copy(BAD);
  const p = r.scan.pools.find((x) => x.id === r.pool);
  const tms = (b) => 1793901601000 + (b - 53556127) * 200;
  r.trades.body = JSON.stringify({ trades: [...p.txs].sort((a, b) => b[1] - a[1]).map(([tx, b]) => ({ t_ms: tms(b), tx })), src: "chain" });
  const v = judge(r);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
});

test("pick: a coin a v2 or v3 pool outtrades is never judged; a scan with no third-quoted coin judges none (INCONCLUSIVE)", () => {
  const r = copy(BAD);
  assert.deepEqual(pick(r.scan), { coin: r.coin, pool: r.pool });
  r.scan.elsewhere[r.coin] = { pool: `0x${"aa".repeat(20)}`, transfers: 999 };
  assert.equal(pick(r.scan), null);
  assert.equal(judge(r).verdict, "INCONCLUSIVE");
  const tie = copy(BAD);
  tie.scan.others[tie.coin] = Math.floor(tie.scan.pools.find((p) => p.id === tie.pool).n / DOMINANCE) + 1;
  assert.equal(pick(tie.scan), null, "a pool near a tie with the coin's other trading is not judged");
  tie.scan.others[tie.coin]--;
  assert.deepEqual(pick(tie.scan), { coin: tie.coin, pool: tie.pool });
  const none = copy(BAD);
  none.scan.pools = none.scan.pools.filter((p) => p.id !== none.pool);
  assert.equal(candidates(none.scan).length, 0);
  assert.equal(judge(none).verdict, "INCONCLUSIVE");
});

test("a run that judged another coin than the scan picks, or whose tape is the vendor's: FAIL", () => {
  const other = copy(BAD);
  other.coin = `0x${"bb".repeat(20)}`;
  assert.equal(judge(other).verdict, "FAIL");
  const vendor = copy(BAD);
  vendor.trades.headers["x-helper-source"] = "coingecko";
  assert.ok(judge(vendor).lines.some((l) => /^BAD trades: 200 coingecko/.test(l)));
});

for (const [name, run] of GOOD)
  test(`${name}: a helper with the card's change, the scan's coin on its third-quoted pool's whole tape and index-evm-swaps's PASS: PASS; its index-evm-swaps FAIL: FAIL`, () => {
    const v = judge(run);
    assert.equal(v.verdict, "PASS", v.lines.join("\n"));
    const r = copy(run);
    r.swaps = { ...r.swaps, reads: {} };
    assert.equal(judge(r).verdict, "FAIL");
  });
