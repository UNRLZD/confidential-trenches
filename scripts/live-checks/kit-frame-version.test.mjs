// node --test scripts/live-checks/kit-frame-version.test.mjs: the live check replays its recorded answers
// (kit-frame-version.answers.json). good: this card's SIGN_HOST build (packages/signpage/scripts/build-app.mjs bundle(),
// mainnet, at the card's head), which reads the kit's hello, maps every deposit stage down for kit-v1.4 and keeps
// kit-v1.4's twelve state fields: PASS. bad: SIGN_HOST as served on 6 Nov 2026 (release-60, /app.js
// sha384-3AiaXoHZ...), which sends every app everything: FAIL. Planted on the good one: another /app.js, no pin, no
// hello, each later stage mapped elsewhere, a refund move mapped to done, a stage kit-v1.4 lacks, a field list with
// pools: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MAP, V1_4, V1_4_KEYS, facts, judge } from "./kit-frame-version.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./kit-frame-version.answers.json", import.meta.url), "utf8"));
const BEFORE = [
  "BAD the bundle reads no kit hello: an app on any kit is sent everything, which kit-v1.4 refuses whole",
  "BAD the bundle has no kit-v1.4 deposit stage map over every deposit stage",
  "BAD the bundle has no kit-v1.4 state field list of exactly its twelve fields",
];

test("recorded good answer: this card's build reads the hello, maps every deposit stage for kit-v1.4, keeps its fields: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST as served before this card (release-60): FAIL, each missing piece named", () => {
  assert.equal(ANSWERS.bad.sha384, "sha384-3AiaXoHZZZPztfVU6l2AM+6GVfeK5xynH7RgNbaxwpY8EpHpJ+BcZgqTFpPRSfFj");
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, BEFORE);
});

test("planted on the good answer: each piece taken away or moved FAILs", () => {
  const g = ANSWERS.good;
  const map = g.maps.find((m) => Object.hasOwn(m, "refund_move"));
  const withMap = (patch) => ({ ...g, maps: [{ ...map, ...patch }] });
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  assert.equal(judge({ ...g, hello: false }).ok, false, "no hello");
  for (const from of ["failed", "short", "expired", "refund_move"])
    for (const to of V1_4.filter((s) => s !== MAP[from])) assert.equal(judge(withMap({ [from]: to })).ok, false, `${from} -> ${to}`);
  assert.ok(judge(withMap({ refund_move: "done" })).lines.includes("BAD the map sends a refund still moving as done"));
  assert.ok(judge(withMap({ failed: "failed" })).lines.includes("BAD the map sends kit-v1.4 failed as failed, a stage it does not have"));
  const { refund_move: _r, ...short } = map;
  assert.equal(judge({ ...g, maps: [short] }).ok, false, "a stage missing from the map");
  assert.equal(judge({ ...g, keys: [[...V1_4_KEYS, "pools"]] }).ok, false, "pools sent to kit-v1.4");
  assert.equal(judge({}).ok, false, "an empty answer");
});

test("facts() reads the map, the field list and the hello from a minified bundle", () => {
  const pairs = Object.entries(MAP).map(([k, v]) => `${k}:\`${v}\``).join(",");
  const js = `var a=Object.freeze({${pairs}}),b=new Set([${V1_4_KEYS.map((k) => `\`${k}\``).join(",")}]);n.type!==\`hello\`;return\`1.4\``;
  const f = facts("", js);
  assert.deepEqual(f.maps, [MAP]);
  assert.deepEqual(f.keys, [V1_4_KEYS]);
  assert.equal(f.hello, true);
});
