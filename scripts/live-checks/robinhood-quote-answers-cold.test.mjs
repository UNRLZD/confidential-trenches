// node --test scripts/live-checks/robinhood-quote-answers-cold.test.mjs: card robinhood-quote-answers-cold. The live
// check replays its recorded answers (robinhood-quote-answers-cold.answers.json). good: this card's branch, its committed
// snapshots read from the build folder and every quote provider answering a batch of the venue's reads.maxBytes: PASS.
// bad: the live SIGN_HOST before the card's deploy, whose /evm-index/<chain>.json is the page's index: FAIL. badProvider:
// main's Robinhood quote list, Globalstake answering that batch HTTP 500 with no allow-origin: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { bodyOf, check, committed } from "./robinhood-quote-answers-cold.mjs";

const A = JSON.parse(readFileSync(new URL("./robinhood-quote-answers-cold.answers.json", import.meta.url), "utf8"));
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes", () => {
  const r = check(A.good.run, A.want);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer fails: SIGN_HOST answered the snapshot paths with its index", () => {
  const r = check(A.bad.run, A.want);
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r).map((l) => l.split(",").slice(0, 2).join(",")), ["BAD [base] snapshot HTTP 200, 382 bytes", "BAD [robinhood] snapshot HTTP 200, 382 bytes"]);
});

test("the recorded Globalstake answer fails on main's list, and the kit's Robinhood quote list no longer names it", () => {
  const v = evmPoolVenues();
  const venues = { ...v, robinhood: { ...v.robinhood, providers: A.badProvider.providers.map((p) => p.url) } };
  const r = check(A.badProvider.run, A.want, venues);
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r).map((l) => l.split(":")[0] + ":" + l.split(":")[1]), ["BAD [robinhood] https://rpc-robinhood.globalstake.io"]);
  assert.ok(!v.robinhood.providers.includes("https://rpc-robinhood.globalstake.io"));
});

test("a provider not asked, one that answers past its bytes, and a snapshot past the head each fail", () => {
  const run = structuredClone(A.good.run);
  run.providers.robinhood.pop();
  assert.equal(check(run, A.want).ok, false, "a provider not asked");
  const small = structuredClone(A.good.run);
  small.providers.base[0].bytes = 8_000;
  assert.equal(check(small, A.want).ok, false, "a batch well under reads.maxBytes");
  const ahead = structuredClone(A.good.run);
  ahead.snapshots.robinhood.through = ahead.snapshots.robinhood.head + 1;
  assert.equal(check(ahead, A.want).ok, false, "a snapshot past the head");
});

test("the batch body is as near each venue's reads.maxBytes as fits, and the committed snapshots are what the good run read", () => {
  for (const c of ["base", "robinhood"]) {
    const max = evmPoolVenues()[c].reads.maxBytes;
    const b = bodyOf(max);
    assert.ok(b.length <= max && b.length > max - 400, `${c}: ${b.length} of ${max}`);
    assert.equal(JSON.parse(b).length, 3);
  }
  assert.deepEqual(committed(), A.want, "the committed snapshots changed: record the good run again (--site packages/signpage/public --record)");
});
