// node --test scripts/live-checks/helper-start-residuals.test.mjs: the live check replays its recorded runs
// (helper-start-residuals.answers.json). good: a helper ready with both mainnet pools' fees named: PASS. bad: the
// deployed helper before the card, ready true on every read and naming no pool's fee: FAIL. Made from the good run:
// ready true while a pool names none, a pool not named, a malformed header, a fee of 0, the wrong commit, health down,
// and reads that never complete: each FAIL; a minute's first read "reading" then a complete read: PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { feesOf, judge, read, READS } from "./helper-start-residuals.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-start-residuals.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const C = A.good.commit;
const one = A.good.run.reads[0];
/** The good run's read with its header and `ready` set. */
const readWith = (fees, ready = true) => ({ ...one, fees, body: JSON.stringify({ ...JSON.parse(one.body), ready }) });
const runOf = (...reads) => ({ base: A.good.run.base, reads });

test("recorded good run: the helper ready with both mainnet pools' fees for the running minute named: PASS", () => {
  const r = judge(A.good.run, C);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("recorded bad run: the deployed helper before the card, ready true with no pool's fee named on every read: FAIL", () => {
  const r = judge(A.bad.run, A.bad.commit);
  assert.equal(r.verdict, "FAIL");
  assert.equal(A.bad.run.reads.length, READS);
  assert.ok(A.bad.run.reads.every((h) => JSON.parse(h.body).ready === true && h.fees === null), "ready true, no header, on every read");
  assert.ok(bad(r).some((l) => l.includes("X-Helper-Pool-Fees absent")), bad(r).join("\n"));
});

test("made from the good run: each break of the end state FAILs", () => {
  const cases = {
    "ready true while Robinhood holds none": runOf(readWith("base 20000000000000, robinhood none"), readWith("base 20000000000000, robinhood 60000000000000")),
    "ready true while both hold none": runOf(readWith("base none, robinhood none")),
    "Base not named": runOf(readWith("robinhood 60000000000000")),
    "no pool named": runOf(readWith("")),
    "a malformed header": runOf(readWith("base=20000000000000;robinhood=60000000000000")),
    "a pool named twice": runOf(readWith("base 1, base 2, robinhood 3")),
    "a fee of 0": runOf(readWith("base 0, robinhood 60000000000000")),
    "health down": runOf({ at: one.at, error: "fetch failed" }),
    "never complete: reading on every read": runOf(...Array.from({ length: READS }, () => readWith("base 20000000000000, robinhood reading"))),
    "never ready": runOf(readWith("base none, robinhood 60000000000000", false)),
    "no read": runOf(),
  };
  for (const [name, run] of Object.entries(cases)) assert.equal(judge(run, C).verdict, "FAIL", name);
  assert.equal(judge(A.good.run, "ff65a0403").verdict, "FAIL", "a short commit");
  assert.equal(judge(A.good.run, "0".repeat(40)).verdict, "FAIL", "another commit");
});

test("made from the good run: a minute's first read 'reading', or not ready with a pool naming none, then a complete read: PASS", () => {
  const r = judge(runOf(readWith("base 20000000000000, robinhood reading"), readWith("base none, robinhood 60000000000000", false), readWith("base 20000000000000, robinhood 60000000000000")), C);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("the header's parts: '<network> <wei|reading|none>' joined by ', ', anything else null", () => {
  assert.deepEqual(feesOf("base 1, robinhood reading"), { base: "1", robinhood: "reading" });
  assert.deepEqual(feesOf(""), {});
  for (const h of [null, undefined, "base", "base 1,robinhood 2", "base -1", "base 1.5", "Base 1", "base 1, "]) assert.equal(feesOf(h), null, String(h));
});

test("a read stops at its first complete answer, waits between reads on the clock it is given, and records a failed read without throwing", async () => {
  const answers = [readWith("base 1, robinhood reading"), readWith("base 1, robinhood 2"), readWith("base 1, robinhood 2")];
  let n = 0;
  const waits = [];
  const fetchOf = async () => {
    const h = answers[n++];
    return new Response(h.body, { status: 200, headers: { "x-helper-commit": C, "x-helper-pool-fees": h.fees } });
  };
  const run = await read("https://helper.invalid/", fetchOf, async (ms) => void waits.push(ms));
  assert.deepEqual([run.reads.length, waits.length, run.base], [2, 1, "https://helper.invalid"]);
  assert.equal(judge(run, C).verdict, "PASS");
  const down = await read("https://helper.invalid", async () => {
    throw new Error("fetch failed");
  }, async () => {});
  assert.deepEqual([down.reads.length, down.reads[0].error], [READS, "fetch failed"]);
  assert.equal(judge(down, C).verdict, "FAIL");
});
