// The sheet's number font (src/sheet.ts T.num; owner ask 14 Nov ~06:00Z, the withdraw form drew its numbers in Courier).
// The signing page ships no font file, so Chivo Mono never loads there, and Chrome has no ui-monospace: before this, a
// number on Chrome fell through to the generic monospace, which is Courier on macOS and Windows. The stack must name a
// mono face each system's Chrome has (macOS Menlo, Windows Consolas, Linux DejaVu or Liberation) before the generic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { T } from "../src/sheet.ts";

const families = (stack: string): string[] => stack.split(",").map((f) => f.trim().replace(/^"|"$/g, ""));

test("the number font names a mono face on macOS, Windows and Linux before the generic monospace", () => {
  const f = families(T.num);
  assert.equal(f.at(-1), "monospace");
  const named = f.slice(0, -1);
  for (const face of ["Menlo", "Consolas"]) assert.ok(named.includes(face), face);
  assert.ok(named.includes("DejaVu Sans Mono") || named.includes("Liberation Mono"), "a Linux mono face");
  assert.equal(f[0], "Chivo Mono", "the app's own face first, for a device that has it");
});
