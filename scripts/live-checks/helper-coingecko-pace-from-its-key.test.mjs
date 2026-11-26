// node --test scripts/live-checks/helper-coingecko-pace-from-its-key.test.mjs: the live check replays its runs
// (helper-coingecko-pace-from-its-key.answers.json, see its `about`). good: the helper names a pace from the key's plan:
// PASS, the settings' differing copy named. bad (helper 245, before the card, read live): no header: FAIL. Planted on the
// good run: a pace from the settings FAILs, "none" FAILs, an answer that is not 200 FAILs. The good run's header is what
// the helper's own code writes (coingeckoNamed), so the check reads the helper's words, not a copy of them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { coingeckoNamed } from "../../apps/helper/src/data/coingecko.ts";
import { HEADER, judge } from "./helper-coingecko-pace-from-its-key.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-coingecko-pace-from-its-key.answers.json"), "utf8"));
const KEY = ["CG", "planted", "test", "key", "only"].join("-");
const BASIC = { plan: "Basic", perMin: 300, month: 100_000 };
const withHeader = (v) => ({ ...A.good, headers: { ...A.good.headers, [HEADER]: v } });

test("recorded good run: the helper paces CoinGecko from the key's plan: PASS, the settings' copy named", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes("GOOD CoinGecko paced from the key's plan Basic: 300 calls a minute, 3225 a day"), r.lines.join("\n"));
  assert.ok(r.lines.includes("NOTE the settings' copy says 100 a minute, the key's plan 300"), r.lines.join("\n"));
});

test("the good run's header is the helper's own words for the key's plan, so the check reads what a deploy writes", () => {
  assert.equal(A.good.headers[HEADER], coingeckoNamed({ COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: "100" }, BASIC));
  // the settings equal to the key's rate: no note, still a PASS
  const same = judge(withHeader(coingeckoNamed({ COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: "300" }, BASIC)));
  assert.equal(same.ok, true, same.lines.join("\n"));
  assert.ok(!same.lines.some((l) => l.startsWith("NOTE")), same.lines.join("\n"));
});

test("recorded bad run (helper 245 before the card): no pace header: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes(`BAD no CoinGecko pace named (${HEADER}: none)`), r.lines.join("\n"));
});

test("planted: a pace from the settings FAILs, no key FAILs, an answer that is not 200 FAILs", () => {
  const settings = judge(withHeader(coingeckoNamed({ COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: "100" }, null)));
  assert.equal(settings.ok, false);
  assert.ok(settings.lines.includes('BAD CoinGecko paced from the settings, not the key\'s plan: "100 a minute, 3225 a day, from the settings"'), settings.lines.join("\n"));
  const none = judge(withHeader(coingeckoNamed({}, null)));
  assert.equal(none.ok, false);
  assert.ok(none.lines.includes("BAD the helper names no CoinGecko key: every chart read is keyless"), none.lines.join("\n"));
  const down = judge({ ...A.good, status: 502 });
  assert.equal(down.ok, false);
  assert.ok(down.lines.includes("BAD GET /v1/health answers 502"), down.lines.join("\n"));
  const odd = judge(withHeader("300 a minute"));
  assert.equal(odd.ok, false, "a header in no shape the helper writes");
});
