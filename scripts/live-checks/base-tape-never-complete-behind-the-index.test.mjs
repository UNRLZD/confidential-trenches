// node --test scripts/live-checks/base-tape-never-complete-behind-the-index.test.mjs: the live check replays its recorded
// runs (base-tape-never-complete-behind-the-index.answers.json). good: the card's swaps on the real Base and Robinhood
// providers, each complete tape naming its block within BEHIND_MAX: PASS. bad: the deployed helper before the card,
// complete tapes naming no block: FAIL. Made from the good run: live run 44228233209's Base tape (complete, 232 blocks
// behind the providers' head), a tape past BEHIND_MAX by the helper's own words, every tape filling: each judged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BEHIND_MAX } from "../../apps/helper/src/data/evm/swaps.ts";
import { judge, readToOf } from "./base-tape-never-complete-behind-the-index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "base-tape-never-complete-behind-the-index.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good run with `chain`'s judged (last) answer changed by `f`, and its head by `h`. */
const made = (chain, f, h = (x) => x) => {
  const run = structuredClone(A.good.run);
  const t = run.chains[chain].tapes.at(-1);
  t.answers[t.answers.length - 1] = f(t.answers.at(-1));
  t.head = h(t.head);
  return run;
};
const timingOf = (block, head, ageS) => `evm-open;dur=0, evm-queue;dur=0;desc="0 posts: pace 0 ms, in flight 0 ms", evm-read-to;desc="block ${block} of head ${head}, read ${ageS} s ago"`;

test("recorded good run: the card's complete tapes on Base and Robinhood name their block, within BEHIND_MAX of the heads: PASS", () => {
  const r = judge(A.good.run);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => l.startsWith("GOOD")).length, 4, r.lines.join("\n"));
});

test("recorded bad run: the deployed helper before the card serves complete tapes naming no block they are read to: FAIL on both chains", () => {
  const r = judge(A.bad.run);
  assert.equal(r.verdict, "FAIL");
  for (const chain of ["base", "robinhood"]) assert.ok(bad(r).some((l) => l.startsWith(`BAD [${chain} `) && / naming no block it is read to /.test(l)), bad(r).join("\n"));
});

test("live run 44228233209's Base tape, complete at 03:21:36.952Z read to block 58908376 while the providers' head was 58908608 (read 0.43 s after): FAIL on the providers' head", () => {
  const run = made(
    "base",
    (a) => ({ ...a, at: 1794972096952, as_of_ms: 1794972096952, filling: false, whole_ms: 1794971000000, timing: timingOf(58908376, 58908376, 0) }),
    () => ({ n: 58908608, at: 1794972097386 }),
  );
  const r = judge(run);
  assert.equal(r.verdict, "FAIL");
  assert.equal(bad(r).length, 1, r.lines.join("\n"));
  assert.match(bad(r)[0], /^BAD \[base 0x\S+\] served complete read to block 58908376, 232 blocks behind the providers' head 58908608/);
});

for (const chain of ["base", "robinhood"]) {
  const { blocks, ms } = BEHIND_MAX[chain];
  test(`${chain}: a complete tape the helper says is ${blocks + 1} blocks behind its newest head, or whose head was read ${ms / 1_000 + 1} s before, FAILs; at the bound it PASSes`, () => {
    const at = (b, ageS) => made(chain, (a) => ({ ...a, timing: timingOf(readToOf(a.timing).head - b, readToOf(a.timing).head, ageS) }), (h) => ({ ...h, n: h.n }));
    assert.equal(judge(at(blocks, 0)).verdict, "PASS", judge(at(blocks, 0)).lines.join("\n"));
    assert.equal(judge(at(0, ms / 1_000)).verdict, "PASS");
    const far = judge(at(blocks + 1, 0));
    assert.equal(far.verdict, "FAIL");
    assert.ok(bad(far).some((l) => l.includes(`${blocks + 1} blocks behind the newest head the helper read (at most ${blocks})`)), far.lines.join("\n"));
    assert.equal(judge(at(0, ms / 1_000 + 1)).verdict, "FAIL");
  });

  test(`${chain}: a tape filling on every read claims no complete list: INCONCLUSIVE, never FAIL, though it names no block`, () => {
    const run = made(chain, (a) => ({ ...a, filling: true, whole_ms: null, timing: "evm-open;dur=0" }));
    const r = judge(run);
    assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith(`--  [${chain}] every tape read was filling`)));
  });
}

test("a complete tape with no reach (a coin our reads find no pool of) is not judged; the providers' head not read is INCONCLUSIVE", () => {
  const none = made("base", (a) => ({ ...a, whole_ms: null, src: "geckoterminal", timing: "" }));
  assert.equal(judge(none).verdict, "INCONCLUSIVE", judge(none).lines.join("\n"));
  const unread = made("robinhood", (a) => a, () => ({ noAnswer: "a.test HTTP 503" }));
  assert.equal(judge(unread).verdict, "INCONCLUSIVE", judge(unread).lines.join("\n"));
});

test("readToOf reads the card's Server-Timing entry and nothing else", () => {
  assert.deepEqual(readToOf(timingOf(5, 9, 2)), { block: 5, head: 9, ageS: 2 });
  assert.equal(readToOf('evm-open;dur=0, evm-queue;dur=0;desc="0 posts"'), null);
  assert.equal(readToOf('x-evm-read-to;desc="block 5 of head 9, read 2 s ago"'), null);
  assert.equal(readToOf(null), null);
});
