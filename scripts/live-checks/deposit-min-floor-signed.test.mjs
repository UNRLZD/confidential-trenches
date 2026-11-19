// node --test scripts/live-checks/deposit-min-floor-signed.test.mjs: the live check replays its recorded answers
// (deposit-min-floor-signed.answers.json).
//   bad: SIGN_HOST as served before this card (release-172's page), each probe's withdrawFee rewritten to 0 by the run:
//     the minimum shown for each USDC asset is the bound no fee lowers, and deposit.dry at it answers below_min: FAIL.
//   good: this card's own build (branch card/deposit-min-floor-signed), recorded with
//     node scripts/live-checks/deposit-min-floor-signed.mjs --local --record <file>
//     under the same rewrite: deposit.dry at each shown minimum answers ok: PASS.
// Planted on the good answer, each FAILs: a probe answered with no rewrite, a dry asked at another amount than shown, a
// dry at the shown minimum answered below_min, an asset left out of deposit.assets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ASSETS, SOL_USDC } from "./kit-deposit-assets-dry.mjs";
import { judge } from "./deposit-min-floor-signed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "deposit-min-floor-signed.answers.json"), "utf8"));
const plant = (f) => {
  const a = structuredClone(ANSWERS.good);
  f(a);
  return a;
};
const answerOf = (a, id) => a.log.find((m) => m.fromParent && m.data?.id === id).data;

test("recorded good answer: the card's build under the rewrite, deposit.dry at every shown minimum ok: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  // the run did rewrite every probe, from 1Click's own fee above 0
  const probes = ANSWERS.good.helper.filter((r) => r.phase === "assets" && r.url.endsWith("/v0/quote"));
  assert.equal(probes.length, Object.keys(ASSETS).length);
  for (const p of probes) assert.ok(BigInt(p.rewrittenFrom) > 0n, JSON.stringify(p.rewrittenFrom));
});

test("recorded bad answer: the page before this card shows the bound under the rewrite, and deposit.dry at it is below_min: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.verdict, "FAIL");
  const below = v.lines.filter((l) => /^BAD deposit\.dry from \S+ at the minimum deposit\.assets showed, [0-9.]+, answered below_min/.test(l));
  assert.ok(below.length >= 1, v.lines.join("\n"));
  assert.ok(below.some((l) => l.includes(SOL_USDC)), v.lines.join("\n"));
});

test("planted on the good answer: each FAILs, named", () => {
  const cases = [
    ["a probe not rewritten", (a) => void delete a.helper.find((r) => r.phase === "assets" && r.url.endsWith("/v0/quote")).rewrittenFrom, /answered with no withdrawFee rewritten/],
    ["a dry at another amount", (a) => void (a.ids.dry[SOL_USDC].amount = "25"), /was not asked at the shown minimum/],
    ["a dry at the shown minimum refused below_min", (a) => {
      const d = answerOf(a, a.ids.dry[SOL_USDC].id);
      delete d.result;
      Object.assign(d, { ok: false, error: { code: "below_min" } });
    }, /answered below_min: the sheet showed a minimum the quote refuses/],
    ["an asset left out", (a) => {
      const r = answerOf(a, a.ids.assets).result;
      r.assets = r.assets.filter((x) => x.origin_asset !== SOL_USDC);
    }, /does not list/],
  ];
  for (const [name, f, line] of cases) {
    const v = judge(plant(f));
    assert.equal(v.verdict, "FAIL", name);
    assert.ok(v.lines.some((l) => line.test(l)), `${name}: ${v.lines.join(" | ")}`);
  }
});
