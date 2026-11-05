// node --test scripts/live-checks/signpage-buy-own-spend.test.mjs: the live check replays its recorded answers
// (signpage-buy-own-spend.answers.json). good: this card's testnet build, the pool send with the loaded keys read: PASS.
// live: SIGN_HOST's mainnet build, no pool send: PASS. bad: the testnet build of main 8791c3d, the pool send with no
// loaded-key read: FAIL. mutant: main's pool-buy.ts with this card's spend reader: PASS, the check's stated limit (the
// buy's owner rule is pool-buy.test.ts's). Planted on the good one: another /app.js, no pin, no loaded-key read, facts
// not read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./signpage-buy-own-spend.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-buy-own-spend.answers.json", import.meta.url), "utf8"));

test("recorded good answer: the testnet build sends pool transactions and reads the loaded keys: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded live answer: SIGN_HOST's mainnet build, its pin held, no pool send: PASS with its note", () => {
  const v = judge(ANSWERS.live);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, ["NOTE the bundle sends no pool transaction (no pinned pool on this build)"]);
});

test("recorded bad answer: main 8791c3d's testnet build, the pool send with no loaded-key read: FAIL, that fact named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["BAD the bundle sends pool transactions and never reads a landed transaction's loaded keys: a buy's own tag 3 never reads as its own spend"]);
});

test("recorded mutant answer: main's pool-buy.ts with this card's spend reader PASSES, the limit the check's header states", () => {
  const v = judge(ANSWERS.mutant);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
  assert.notEqual(ANSWERS.mutant.sha384, ANSWERS.good.sha384, "another bundle than this card's");
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  assert.equal(judge({ ...g, loadedKeys: false }).ok, false, "no loaded-key read");
  for (const k of ["poolSend", "loadedKeys"]) assert.equal(judge({ ...g, [k]: undefined }).ok, false, `${k} not read`);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  const js = 'fetch(`/v1/pool/solana/send`);m.loadedAddresses;';
  assert.deepEqual([facts("", js).poolSend, facts("", js).loadedKeys], [true, true]);
  assert.equal(facts("", js.replace("m.loadedAddresses;", "")).loadedKeys, false);
  assert.equal(facts("", js.replace("fetch(`/v1/pool/solana/send`);", "")).poolSend, false);
});
