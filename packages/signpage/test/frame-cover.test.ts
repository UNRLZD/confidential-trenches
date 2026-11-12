// The screens the frame leaves the page before (src/frame-cover.ts SEALED): every screen src/main.ts draws a field on,
// and the 12 words shown. Each State of main.ts is named here as sealed or not, so a new screen fails this test until it
// is placed; a screen drawn with a field that is not sealed fails it.
//   node --test test/frame-cover.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SEALED } from "../src/frame-cover.ts";

const src = (p: string): string => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const main = src("main.ts");

// the screens with no field and no 12 words: buttons and lines only
const KEPT = ["loading", "signed-out", "signed-in", "no-prf", "cancelled", "unsupported", "error", "choose", "existing", "signout"];

test("every screen of main.ts is placed: sealed or kept, none left out", () => {
  const union = /type State =([^;]*);/.exec(main)?.[1];
  assert.ok(union, "main.ts's State type");
  const states = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
  assert.deepEqual([...SEALED, ...KEPT].sort(), states, "each State in exactly one list");
  for (const s of KEPT) assert.ok(!SEALED.has(s), s);
});

test("sealed: the screens with a field typed into, and the 12 words shown", () => {
  assert.deepEqual([...SEALED].sort(), ["backup", "held", "invalid-code", "pool-withdraw", "withdraw", "words"]);
  // the field each typed screen draws: the 12 words' textarea in main.ts, To and the amount in the two withdraw forms,
  // the account in the held deposit's way out
  assert.match(main, /state === "words" \|\| state === "invalid-code"\)\) \{\s*const box = document\.createElement\("textarea"\)/);
  for (const [state, file, draw] of [["withdraw", "withdraw/form.ts", "drawWithdrawForm"], ["pool-withdraw", "withdraw/pool-form.ts", "drawPoolWithdrawForm"], ["held", "withdraw/held.ts", "drawHeldMoveOut"]] as const) {
    assert.match(main, new RegExp(`state === "${state}"[^\\n]*\\) \\{[\\s\\S]{0,600}?${draw}\\(`), `main.ts draws ${state} with ${draw}`);
    assert.match(src(file), /createElement\("input"\)/, `${file} draws a field`);
    assert.ok(SEALED.has(state), state);
  }
});

test("main.ts seals by this set alone: the open and each screen drawn on a shown sheet", () => {
  assert.ok(!/const TYPED\b/.test(main), "no set of its own");
  assert.match(main, /shell\?\.open\(SEALED\.has\(/);
  assert.match(main, /function show\([^)]*\): void \{\s*(\/\/[^\n]*\n\s*)*if \(SEALED\.has\(state\)\) shell\?\.seal\(\);/, "the seal is show()'s first step");
});
