// node --test scripts/live-checks/evm-quote-reads-need-no-old-state.test.mjs: the live check replays its recorded reads
// (evm-quote-reads-need-no-old-state.answers.json), each written by its own --record:
//   good: this card's build (build-app.mjs --out at the card's tip): PASS, both marks;
//   bad: SIGN_HOST at release 170 (main b82022875, read 17 Nov 22:39Z): FAIL, neither mark.
// Then cases planted on the good read, one end state undone each, and pageFacts on planted bundles.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, MARK_EVIDENCE, MARK_INDEX, pageFacts } from "./evm-quote-reads-need-no-old-state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "evm-quote-reads-need-no-old-state.answers.json"), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const bad = (rec, start) => {
  const r = judge(rec);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith(`BAD ${start}`)), `${start}\n${r.lines.join("\n")}`);
};

test("recorded good answer: this card's build reads no old block in the index's state read and walks the keepers for a ban: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST at release 170 carries neither: FAIL", () => {
  assert.match(ANSWERS.bad.source, /^live https:\/\/confidential\.unrealized\.trade$/);
  bad(ANSWERS.bad, "the pool index reads one-reader pools' state at the newest block both readers agree on");
  bad(ANSWERS.bad, "a ban's evidence walks the operators that keep the trade's block");
});

test("planted on the good answer: an unpinned bundle, no index mark, or no evidence mark: FAIL", () => {
  let r = clone(ANSWERS.good);
  r.facts.pin = "sha384-other";
  bad(r, "the served /app.js is the one index.html pins");
  r = clone(ANSWERS.good);
  r.facts.marks.index = 0;
  bad(r, "the pool index reads one-reader pools' state at the newest block both readers agree on");
  r = clone(ANSWERS.good);
  r.facts.marks.evidence = 0;
  bad(r, "a ban's evidence walks the operators that keep the trade's block");
  bad({}, "the served /app.js is the one index.html pins");
});

test("pageFacts: each mark counted as minified, a pin that is not the bundle's is kept apart", () => {
  const js = `throw new Ge("rpc_error","${MARK_INDEX}");X(\`${MARK_EVIDENCE}\${t}\`)`;
  const index = `<script src="/app.js" integrity="${pageFacts("", js).sha384}"></script>`;
  const f = pageFacts(index, js);
  assert.deepEqual(f.marks, { index: 1, evidence: 1 });
  assert.equal(f.pin, f.sha384);
  assert.deepEqual(pageFacts(index, "nothing").marks, { index: 0, evidence: 0 });
  assert.notEqual(pageFacts(index, "nothing").pin, pageFacts(index, "nothing").sha384);
});
