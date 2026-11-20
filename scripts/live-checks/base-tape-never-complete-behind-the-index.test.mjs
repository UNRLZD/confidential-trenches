// node --test scripts/live-checks/base-tape-never-complete-behind-the-index.test.mjs: the live check replays its recorded
// runs (base-tape-never-complete-behind-the-index.answers.json). good: the card's swaps on the real Base and Robinhood
// providers, each complete tape naming its block within BEHIND_MAX: PASS. bad: the deployed helper before the card,
// complete tapes naming no block: FAIL. Made from the good run: live run 44228233209's Base tape (complete, 232 blocks
// behind the providers' head), a tape past BEHIND_MAX by the helper's own words, every tape filling: each judged.
// vendorGood: card evm-vendor-tape-names-its-reach's branch on the real providers and GeckoTerminal, Base 0x1668cd48 (a coin
// our reads find no pool of) served the vendor's rows complete, naming their read: PASS. vendorStale: the deployed helper
// before that card, the same coin's vendor rows served complete naming no read, 1,094 s old: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BEHIND_MAX } from "../../apps/helper/src/data/evm/swaps.ts";
import { judge, readToOf, vendorReadOf } from "./base-tape-never-complete-behind-the-index.mjs";
import { SKEW_MS } from "./index-evm-swaps.mjs";

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

// card evm-vendor-tape-names-its-reach: a coin our reads find no pool of is served the vendor's rows (src not "chain")
const vendorTape = (run) => run.chains.base.tapes.find((t) => t.coin === "0x1668cd48f31d869fca21eb826ca60e94cffc018c");
const vendorTiming = (ageMs) => `evm-open;dur=0, evm-queue;dur=0;desc="0 posts: pace 0 ms, in flight 0 ms", evm-vendor-read;desc="rows read ${ageMs} ms ago", total;dur=9`;
/** The vendor good run with its Base vendor tape's last answer changed by `f`. */
const vendorMade = (f) => {
  const run = structuredClone(A.vendorGood.run);
  const t = vendorTape(run);
  t.answers[t.answers.length - 1] = f(t.answers.at(-1));
  return run;
};

test("recorded vendorGood run: Base 0x1668cd48's vendor tape on the card's branch, complete, names its rows read 1,449 ms before, its as_of_ms after its request: PASS", () => {
  const a = vendorTape(A.vendorGood.run).answers.at(-1);
  assert.deepEqual([a.status, a.src, a.filling, a.whole_ms !== null], [200, "geckoterminal", false, true]);
  const r = judge(A.vendorGood.run);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => l.startsWith("GOOD [base 0x1668cd48") && l.includes("the vendor's rows")).length, 2, r.lines.join("\n"));
});

test("recorded vendorStale run: the deployed helper before the card serves Base 0x1668cd48's vendor rows complete, naming no read, 1,094 s old: FAIL on both", () => {
  const r = judge(A.vendorStale.run);
  assert.equal(r.verdict, "FAIL");
  const b = bad(r);
  assert.equal(b.length, 2, r.lines.join("\n"));
  assert.match(b[0], /^BAD \[base 0x1668cd48\S+\] served the vendor's rows \(src coingecko, 3 trades\) complete \(whole_ms 1795000605000\) naming no read they reach to/);
  assert.match(b[1], /^BAD \[base 0x1668cd48\S+\] .* its as_of_ms 1094482 ms before its request/);
});

{
  const { ms } = BEHIND_MAX.base;
  test(`base: a vendor tape the helper says was read ${ms + 1} ms before FAILs, at ${ms} it PASSes; one whose as_of_ms is past ${ms} ms and SKEW_MS before its request FAILs though the helper names it fresh`, () => {
    const named = (ageMs) => judge(vendorMade((a) => ({ ...a, timing: vendorTiming(ageMs) })));
    assert.equal(named(ms).verdict, "PASS", named(ms).lines.join("\n"));
    const far = named(ms + 1);
    assert.equal(far.verdict, "FAIL");
    assert.deepEqual(bad(far).map((l) => l.replace(/^.*, read /, "")), [`${ms + 1} ms before by the helper's word (at most ${ms})`]);
    const dated = (behind) => judge(vendorMade((a) => ({ ...a, timing: vendorTiming(0), as_of_ms: a.at - behind })));
    assert.equal(dated(ms + SKEW_MS).verdict, "PASS");
    const old = dated(ms + SKEW_MS + 1);
    assert.equal(old.verdict, "FAIL");
    assert.ok(bad(old).length === 1 && bad(old)[0].includes(`its as_of_ms ${ms + SKEW_MS + 1} ms before its request`), old.lines.join("\n"));
  });
}

test("a chain tape is never judged by the vendor's rule: complete with evm-vendor-read and no evm-read-to, it FAILs as naming no block", () => {
  const run = made("robinhood", (a) => ({ ...a, src: "chain", timing: vendorTiming(0) }));
  const r = judge(run);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => l.startsWith("BAD [robinhood ") && / naming no block it is read to /.test(l)), r.lines.join("\n"));
});

test("a vendor tape with no whole_ms (its rows read past the bound) claims no complete list: not judged, INCONCLUSIVE when it is the chain's only tape", () => {
  const run = vendorMade((a) => ({ ...a, whole_ms: null, timing: vendorTiming(600_000) }));
  const r = judge(run);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("--  [base 0x1668cd48") && l.includes("no complete list claimed")));
  assert.ok(r.lines.some((l) => l.startsWith("--  [base] every tape read was filling") && l.includes("or claimed no reach")));
});

test("vendorReadOf reads the card's Server-Timing entry and nothing else", () => {
  assert.deepEqual(vendorReadOf(vendorTiming(1449)), { ageMs: 1449 });
  assert.equal(vendorReadOf(timingOf(5, 9, 2)), null);
  assert.equal(vendorReadOf('x-evm-vendor-read;desc="rows read 2 ms ago"'), null);
  assert.equal(vendorReadOf(null), null);
});

test("readToOf reads the card's Server-Timing entry and nothing else", () => {
  assert.deepEqual(readToOf(timingOf(5, 9, 2)), { block: 5, head: 9, ageS: 2 });
  assert.equal(readToOf('evm-open;dur=0, evm-queue;dur=0;desc="0 posts"'), null);
  assert.equal(readToOf('x-evm-read-to;desc="block 5 of head 9, read 2 s ago"'), null);
  assert.equal(readToOf(null), null);
});
