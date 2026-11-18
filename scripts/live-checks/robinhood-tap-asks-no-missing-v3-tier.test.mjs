// node --test scripts/live-checks/robinhood-tap-asks-no-missing-v3-tier.test.mjs: the live check replays recorded
// answers (robinhood-tap-asks-no-missing-v3-tier.answers.json). bad: SIGN_HOST as deployed before this card, whose
// /app.js holds no v3 factory pin: FAIL, each missing pin named. good: this card's build, as SIGN_HOST serves it once
// deployed, with each quoter's factory() read on two providers: PASS. Planted on the good one: a served /app.js that is
// not the pinned one, no pinned /app.js, a pin gone, a quoter that reads another factory or was read on one provider:
// FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, MARKERS, judge } from "./robinhood-tap-asks-no-missing-v3-tier.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./robinhood-tap-asks-no-missing-v3-tier.answers.json", import.meta.url), "utf8"));

test("recorded bad answer: SIGN_HOST before this card, no v3 factory pin in its /app.js: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, MARKERS.map((m) => `BAD the served /app.js holds no v3 tier read (${m})`));
});

test("recorded good answer: the pinned /app.js with both pins, each the factory its chain's quoter reads: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("planted: another /app.js, no pin, a factory pin gone, a quoter on another factory or read once: FAIL", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, app: { ...g.app, sha384: "sha384-other" } }).lines.includes("BAD the served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD index.html pins no /app.js"));
  for (const m of MARKERS) assert.equal(judge({ ...g, app: { ...g.app, markers: MARKERS.filter((x) => x !== m) } }).ok, false, m);
  for (const chain of Object.keys(CHAINS)) {
    const other = { ...g, factories: { ...g.factories, [chain]: [g.factories[chain][0], "0x" + "12".repeat(20)] } };
    assert.ok(judge(other).lines.some((l) => l.startsWith(`BAD ${chain}: the v3 quoter reads its pools from`)), chain);
    const once = { ...g, factories: { ...g.factories, [chain]: [g.factories[chain][0]] } };
    assert.ok(judge(once).lines.includes(`BAD ${chain}: the v3 quoter's factory was not read on two providers`), chain);
    const err = { ...g, factories: { ...g.factories, [chain]: [g.factories[chain][0], "error 429"] } };
    assert.equal(judge(err).ok, false, chain);
  }
});
