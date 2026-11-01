// node --test scripts/live-checks/kit-freeze-keys.test.mjs: the live check replays recorded answers of GitHub's raw file
// server (kit-freeze-keys.answers.json). The good answer is packages/wallet/test/vectors/a8.json as this branch holds it,
// which main serves once the card merges: PASS. The bad answers fail: the same set with one unhardened W path step
// (W_{evm,l,0} at m/44'/60'/a'/b with its address at that path), and the whole set made with salt "blindfill/v0".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, urlOf } from "./kit-freeze-keys.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "kit-freeze-keys.answers.json"), "utf8"));
const A8 = readFileSync(path.join(HERE, "../../packages/wallet/test/vectors/a8.json"), "utf8");

// every ref gets the recorded body of the named answer
const replay = (answer, status = 200) => async (url) => {
  assert.ok(url.startsWith("https://raw.githubusercontent.com/UNRLZD/confidential-trenches/"), url);
  return { status, text: async () => ANSWERS[answer][0].body };
};

test("the recorded good answer is the committed vector set, byte for byte", () => {
  assert.equal(ANSWERS.good[0].url, urlOf("main"));
  assert.equal(ANSWERS.good[0].body, A8);
});

test("recorded good answer, on main and on the freeze tag: PASS", async () => {
  const r = await check({ refs: ["main", "kit-freeze"], fetchFn: replay("good") });
  assert.equal(r.ok, true, r.lines.filter((l) => l.startsWith("BAD")).join("\n"));
  assert.equal(r.lines.filter((l) => l.startsWith("ok ")).length, 2 * 37);
  assert.ok(r.lines.includes("ok  main: W_{evm,l,0} m/44'/60'/511322703'/752971108' and address"));
});

test("recorded bad answer, one unhardened W path step: FAIL on that wallet", async () => {
  const r = await check({ refs: ["main"], fetchFn: replay("bad-unhardened") });
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), ["BAD main: W_{evm,l,0} m/44'/60'/511322703'/752971108 differs in path, address"]);
});

test("recorded bad answer, the set made with salt blindfill/v0: FAIL on every key, address and note", async () => {
  const r = await check({ refs: ["main"], fetchFn: replay("bad-salt-v0") });
  assert.equal(r.ok, false);
  const bad = r.lines.filter((l) => l.startsWith("BAD"));
  assert.equal(bad.length, 22 + 12 + 1, bad.join("\n"));
  assert.ok(bad.some((l) => /^BAD main: the 14 note lines match the frozen set/.test(l)));
});

test("a missing file (the tag not yet made, or the file gone): FAIL", async () => {
  const r = await check({ refs: ["main", "kit-freeze"], fetchFn: async (url) => (url.includes("/main/") ? replay("good")(url) : { status: 404, text: async () => "404: Not Found" }) });
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes(`BAD kit-freeze: ${urlOf("kit-freeze")} answered 404`));
});
