// The sign-in page's words the owner picked (card words-final-nov2; owner 2 Nov 06:08Z, all approved): Continue and Cancel
// from the Nov 2 words page, and New account and I already have one, which that page left out as already kept. Each
// must read its text byte for byte in src/main.ts's WORDS, name its pick on its own line, and no longer be called a
// draft in the note above the table or in src/pages/open.ts. The page draws no draft mark (no data-draft-copy).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PICK = "owner 2 Nov 06:08Z, all approved";
const FINAL = [
  ["next", "Continue"],
  ["cancel", "Cancel"],
  ["new-account", "New account"],
  ["have-one", "I already have one"],
] as const;

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8").split("\n");
const open = readFileSync(new URL("../src/pages/open.ts", import.meta.url), "utf8");
const start = main.findIndex((l) => l === "const WORDS = {");
const end = main.findIndex((l, i) => i > start && l === "} as const;");
let noteAt = start;
while (main[noteAt - 1]?.startsWith("// ")) noteAt--;
const note = main.slice(noteAt, start).map((l) => l.slice(3)).join(" ");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the table and its note are where this test reads them", () => {
  assert.ok(start > 0 && end > start, "const WORDS = { ... } as const;");
  assert.ok(note.startsWith("DRAFT COPY:"), note);
});

test("each picked word: its text unchanged and its pick on its line", () => {
  const bad: string[] = [];
  for (const [key, text] of FINAL) {
    const re = new RegExp(`^  ("${esc(key)}"|${esc(key)}): ${esc(JSON.stringify(text))},(.*)$`);
    const at = main.slice(start + 1, end).filter((l) => re.test(l));
    if (at.length !== 1) bad.push(`${key}: ${at.length} lines with ${JSON.stringify(text)}`);
    else if (re.exec(at[0])![2] !== ` // ${PICK}`) bad.push(`${key}: no pick: ${at[0].trim()}`);
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});

test("no note calls a picked word a draft", () => {
  // the note's sentences and clauses that speak of drafts name none of the four, by key or by text
  const draftClauses = note.split(/[.;] /).filter((c) => /draft/i.test(c));
  for (const [key, text] of FINAL) {
    for (const c of draftClauses) {
      assert.ok(!new RegExp(`(^|[^\\w-])${esc(key)}([^\\w-]|$)`).test(c), `${key} in: ${c}`);
      assert.ok(!c.includes(text), `${text} in: ${c}`);
    }
    assert.ok(!open.includes(`[draft copy: ${text}]`), `src/pages/open.ts: [draft copy: ${text}]`);
  }
});
