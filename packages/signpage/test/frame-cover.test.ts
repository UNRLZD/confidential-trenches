// The frame's cover under each sheet screen (src/frame-cover.ts): only the two withdraw forms keep the app in the page
// (watched); every other screen with a field typed into, or the 12 words shown, takes it out (sealed).
//   node --test test/frame-cover.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { coverOf, SEALED, WATCHED } from "../src/frame-cover.ts";

test("watched: the withdraw forms and nothing else", () => {
  assert.deepEqual([...WATCHED].sort(), ["pool-withdraw", "withdraw"]);
  assert.equal(coverOf("withdraw"), "watched");
  assert.equal(coverOf("pool-withdraw"), "watched");
});

test("sealed: the 12 words typed or shown and the held deposit's way out; a sealed screen that keeps the frame fails", () => {
  for (const s of ["words", "invalid-code", "held", "backup"]) assert.equal(coverOf(s), "sealed", s);
  assert.deepEqual([...SEALED].sort(), ["backup", "held", "invalid-code", "words"]);
  for (const s of ["signin", "signed-out", "signed-in", "choose", "existing", "signout", "loading"]) assert.equal(coverOf(s), "kept", s);
});

test("main.ts opens the layer and draws each screen by coverOf, with no set of its own", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.ok(!/const TYPED\b/.test(main), "the old TYPED set is gone");
  assert.match(main, /shell\?\.open\(coverOf\(/);
});
