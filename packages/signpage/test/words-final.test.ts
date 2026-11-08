// The sign-in page's words the owner picked (card words-final-nov2): Continue and Cancel from the Nov 2 words page, New
// account and I already have one, which that page left out as already kept (owner 2 Nov 06:08Z, all approved), and
// Recovery code and Backup, the sign-in words kept on 1 Nov 16:45Z (owner 1 Nov 16:45Z, keep). Each
// must read its text byte for byte in src/main.ts's WORDS, name its pick on its own line, and no longer be called a
// draft in the note above the table or in src/pages/open.ts. The page draws no draft mark (no data-draft-copy).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const APPROVED = "owner 2 Nov 06:08Z, all approved";
const KEEP = "owner 1 Nov 16:45Z, keep";
const FINAL = [
  ["next", "Continue", APPROVED],
  ["cancel", "Cancel", APPROVED],
  ["new-account", "New account", APPROVED],
  ["have-one", "I already have one", APPROVED],
  ["recovery", "Recovery code", KEEP],
  ["backup", "Backup", KEEP],
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
  for (const [key, text, pick] of FINAL) {
    const re = new RegExp(`^  ("${esc(key)}"|${esc(key)}): ${esc(JSON.stringify(text))},(.*)$`);
    const at = main.slice(start + 1, end).filter((l) => re.test(l));
    if (at.length !== 1) bad.push(`${key}: ${at.length} lines with ${JSON.stringify(text)}`);
    else if (re.exec(at[0])![2] !== ` // ${pick}`) bad.push(`${key}: no pick: ${at[0].trim()}`);
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

// Card words-nov8-final: the signing page's held-deposit and withdraw words the owner kept on the 8 Nov words page
// (owner 8 Nov 07:55Z, held.* and pw.*). Each reads its text byte for byte, names its pick on its own line, and no element
// that draws it carries data-draft-copy: the only marks left in these three files are To and Amount (not on the page),
// Min $ and the unmatched notice (the vault form's own).
const NOV8 = "owner 8 Nov 07:55Z, kept";
const nov8 = await Promise.all([import("../src/withdraw/held.ts"), import("../src/withdraw/form.ts"), import("../src/withdraw/pool-form.ts")]);
const [held, form, pool] = nov8;
const NOV8_ROWS: readonly (readonly [string, Record<string, string>, string, string])[] = [
  ["held.moveOut", held.HELD_WORDS, "move-out", "Move out"],
  ["held.links", held.HELD_WORDS, "link", "This links your deposit to this account."],
  ["held.moved", held.HELD_WORDS, "moved", "Moved"],
  ["held.sending", held.HELD_WORDS, "sent", "Sending"],
  ["held.nothing", held.HELD_WORDS, "empty", "Nothing to move"],
  ["held.notMoved", held.HELD_WORDS, "failed", "Not moved · Retry"],
  ["held.gas", held.HELD_WORDS, "gas", "Send NEAR to the deposit account from the account you typed:"],
  ["pw.withdraw", form.WITHDRAW_WORDS, "withdraw", "Withdraw"],
  ["pw.invalidAddress", form.WITHDRAW_WORDS, "invalid-address", "Invalid address"],
  ["pw.invalidAmount", form.WITHDRAW_WORDS, "invalid-amount", "Invalid amount"],
  ["pw.insufficient", form.WITHDRAW_WORDS, "insufficient", "Insufficient"],
  ["pw.busy", form.WITHDRAW_WORDS, "busy", "Busy · Retry"],
  ["pw.maxFee", pool.POOL_WITHDRAW_WORDS, "max-fee", "Max fee"],
  ["pw.min", pool.POOL_WITHDRAW_WORDS, "min", "Min "],
  ["pw.tryTwo", pool.POOL_WITHDRAW_WORDS, "try", "Try "],
  ["pw.tryTwo", pool.POOL_WITHDRAW_WORDS, "or", " or "],
  ["pw.feeRose", pool.POOL_WITHDRAW_WORDS, "fee-rose", "Network fee rose. New max fee: "],
  ["pw.feeRoseSend", pool.POOL_WITHDRAW_WORDS, "fee-redraw", "Send at new fee"],
];

test("words-nov8-final: each kept word reads its text, and its source line names the pick", () => {
  const srcOf = (t: Record<string, string>) => readFileSync(new URL(t === held.HELD_WORDS ? "../src/withdraw/held.ts" : t === form.WITHDRAW_WORDS ? "../src/withdraw/form.ts" : "../src/withdraw/pool-form.ts", import.meta.url), "utf8").split("\n");
  const bad: string[] = [];
  for (const [id, table, key, text] of NOV8_ROWS) {
    if (table[key] !== text) bad.push(`${id}: ${key} reads ${JSON.stringify(table[key])}, want ${JSON.stringify(text)}`);
    const re = new RegExp(`^  ("${esc(key)}"|${esc(key)}): .*// .*${esc(NOV8)}`);
    if (!srcOf(table).some((l) => re.test(l))) bad.push(`${id}: no line for ${key} naming ${NOV8}`);
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});

test("words-nov8-final: no draft mark is written for a kept word, in any of the three screens' sources", () => {
  const marks = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8").split("\n").filter((l) => /draftCopy\s*=/.test(l));
  // held.ts writes none itself (its To label goes through markDraft); form.ts's and pool-form.ts's only write is markDraft's
  assert.deepEqual(marks("../src/withdraw/held.ts"), []);
  assert.deepEqual(marks("../src/withdraw/pool-form.ts"), []);
  assert.deepEqual(marks("../src/withdraw/form.ts").map((l) => l.trim()), ["if (drafts.has(key)) el.dataset.draftCopy = key;"]);
  assert.deepEqual([...form.WITHDRAW_DRAFT].sort(), ["amount", "min", "to", "unmatched"]);
  assert.deepEqual([...pool.POOL_DRAFT].sort(), ["amount", "to"]);
  for (const [id, , key] of NOV8_ROWS) {
    assert.ok(!form.WITHDRAW_DRAFT.has(key) || key === "min", `${id}: ${key} is marked a draft`);
    assert.ok(!pool.POOL_DRAFT.has(key), `${id}: ${key} is marked a draft`);
  }
});
