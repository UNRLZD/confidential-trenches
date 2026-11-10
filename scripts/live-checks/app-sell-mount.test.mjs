// node --test scripts/live-checks/app-sell-mount.test.mjs: the live check's verdict replays recorded runs
// (app-sell-mount.answers.json), each read on 10 Nov by app-sell-mount.mjs collect() --harness in headless Chrome on the
// PC, at /token/solana/<DJT>, the stand-in shell sending app-portfolio-mount's account with its Solana pool and 1000 DJT
// held (with the mint's decimals, as the signing page sends a position):
//   good: this branch's build (9eca59e6) at APP_HOST's name: the page draws DJT, the switch's Sell (desktop) and the
//         phone bar's Sell draw the sell side, ready, `1K DJT held`; a double tap of 25% asks one pool.sell of 250 on
//         solana and the box draws S8.32 (the shell refuses it); 100% then asks 1000, at 1440 and 390: PASS;
//   bad:  main just before this card's merge (681147d0), same check and shell: the switch's Sell is off, no sell side,
//         no pool.sell: FAIL.
// Planted from the good run: a pool.sell of another amount, chain or token, two for a double tap, a stray buy or
// pool.buy, a 100% that is not the whole, a sell side not ready or naming another holding, a box that leaves
// States.tsx's states, a page that draws another token or none, a missing run, no entry script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, MINT, PATH, STATE, WANT, WANT_ALL } from "./app-sell-mount.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-sell-mount.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w) => rec.runs.find((r) => r.width === w);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("the account holds 1000 of the opened page's token on Solana as the signing page sends it, with a Solana pool, and the tap wants 25% of it", () => {
  const p = STATE.positions.find((x) => x.token === MINT);
  assert.deepEqual([p.chain, p.amount, p.decimals], ["solana", "1000", 6]);
  assert.deepEqual(Object.keys(p).toSorted(), ["amount", "chain", "cost", "decimals", "token", "wallets"]);
  assert.equal(PATH, `/token/solana/${MINT}`);
  assert.ok(STATE.pools.some((x) => x.chain === "solana"));
  assert.equal(MINT, "DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF"); // gitleaks:allow (a public Solana mint)
  assert.deepEqual(WANT, { chain: "solana", mint: MINT, amount: "250", slippage_bps: 1000 });
  assert.deepEqual(WANT_ALL, { ...WANT, amount: "1000" });
});

test("recorded good answer: Sell draws the sell side and 25% asks one pool.sell of 250 on solana, at both widths: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 2);
  for (const x of ANSWERS.good.runs) assert.deepEqual(x.asked, [{ type: "pool.sell", params: WANT }, { type: "pool.sell", params: WANT_ALL }], x.width);
});

test("recorded bad answer: main before this card, on the held token's own page, has Sell off and no sell side: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const x of ANSWERS.bad.runs) assert.equal(x.mint, MINT, `${x.width}: the bad run drew the held token, so Sell off is the app's`);
  assert.ok(bad(r).some((l) => /^BAD desktop: the switch's Sell is off with a position held; Sell drew no sell side/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD phone: Sell drew no sell side/.test(l)), r.lines.join("\n"));
});

test("planted: a pool.sell of another amount, chain or token, a double tap sent twice, a stray kind, or a 100% not the whole fails", () => {
  fails(mut((rec) => (run(rec, "desktop").asked[0].params.amount = "1000")), /^BAD desktop: the 25% pool\.sell asked .*"amount":"1000"/);
  fails(mut((rec) => (run(rec, "phone").asked[0].params.chain = "base")), /^BAD phone: the 25% pool\.sell asked .*"chain":"base"/);
  fails(mut((rec) => (run(rec, "desktop").asked[0].params.mint = "Fixture1Token1111111111111111111111111111111")), /^BAD desktop: the 25% pool\.sell asked/);
  fails(mut((rec) => run(rec, "phone").asked.splice(1, 0, structuredClone(run(rec, "phone").asked[0]))), /^BAD phone: 3 pool\.sell request\(s\)/);
  fails(mut((rec) => run(rec, "desktop").asked.push({ type: "buy", params: { ...WANT } })), /^BAD desktop: the taps asked buy, not pool\.sell/);
  fails(mut((rec) => run(rec, "phone").asked.push({ type: "pool.buy", params: { ...WANT } })), /^BAD phone: the taps asked pool\.buy, not pool\.sell/);
  fails(mut((rec) => (run(rec, "desktop").asked[1].params.amount = "750")), /^BAD desktop: the 100% pool\.sell asked .*"amount":"750"/);
  fails(mut((rec) => run(rec, "phone").asked.pop()), /^BAD phone: 1 pool\.sell request\(s\)/);
});

test("planted: a sell side not ready, naming another holding, or leaving States.tsx's states fails", () => {
  fails(mut((rec) => (run(rec, "desktop").before.state = "S8.33")), /^BAD desktop: the sell side is S8\.33, not ready/);
  fails(mut((rec) => (run(rec, "phone").before.held = "5 Fixture2 held")), /^BAD phone: the held line reads "5 Fixture2 held"/);
  fails(mut((rec) => (run(rec, "desktop").after = null)), /^BAD desktop: after the tap the box is gone/);
  fails(mut((rec) => (run(rec, "phone").after.state = "S8.3")), /^BAD phone: after the tap the box is S8\.3/);
});

test("planted: a missing run, Sell off, a terminal outside the shell, no screenshot, no entry script fail", () => {
  fails(mut((rec) => rec.runs.pop()), /^BAD 1 run\(s\) of 2/);
  fails(mut((rec) => (run(rec, "desktop").sellOn = false)), /^BAD desktop: the switch's Sell is off/);
  fails(mut((rec) => (run(rec, "phone").framed = false)), /^BAD phone: not inside SIGN_HOST's shell/);
  fails(mut((rec) => (run(rec, "desktop").mint = "B3rm7c2s6wBRe3H6ZxSuFJ1BLmBK3TjGp5jXdDP4pump")), /^BAD desktop: the token page drew B3rm7c2s6wBRe3H6ZxSuFJ1BLmBK3TjGp5jXdDP4pump, not the held /); // gitleaks:allow (a made-up mint)
  fails(mut((rec) => (run(rec, "phone").mint = null)), /^BAD phone: the token page drew no token, not the held /);
  fails(mut((rec) => (run(rec, "desktop").shot = null)), /^BAD desktop: no screenshot/);
  fails(mut((rec) => (rec.entry = null)), /^BAD the served \/ names its entry script none/);
});
