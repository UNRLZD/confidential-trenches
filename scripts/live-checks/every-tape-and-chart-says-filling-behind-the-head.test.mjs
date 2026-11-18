// node --test scripts/live-checks/every-tape-and-chart-says-filling-behind-the-head.test.mjs: the live check replays its
// recorded runs (every-tape-and-chart-says-filling-behind-the-head.answers.json). good: the card's Base and Robinhood
// charts and Solana tape and chart, each current answer naming its read-to within its chain's bound: PASS. bad: the
// deployed helper before the card, every current answer naming none: FAIL on all four paths. Made from the good run: a
// chart or tape past its bound by its own words or by the providers' head, a Solana stream refilling or unheard, every
// read filling or a vendor's: each judged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BEHIND_MAX } from "../../apps/helper/src/data/evm/swaps.ts";
import { SOL_BEHIND_MS } from "../../apps/helper/src/data/solana/trades.ts";
import { judge, PATHS, readToOf } from "./every-tape-and-chart-says-filling-behind-the-head.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "every-tape-and-chart-says-filling-behind-the-head.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good run with one path's judged (last) answer changed by `f`, and its providers' head by `h`. */
const made = (chain, what, f, h = (x) => x) => {
  const run = structuredClone(A.good.run);
  const r = run.paths.find((p) => p.chain === chain && p.what === what).reads.at(-1);
  r.answers[r.answers.length - 1] = f(r.answers.at(-1));
  r.head = h(r.head);
  return run;
};
const evmTiming = (block, head, ageS) => `evm-open;dur=0, evm-read-to;desc="block ${block} of head ${head}, read ${ageS} s ago"`;
const solTiming = (slot, head, heard, state) => `sol-read-to;desc="slot ${slot} of head ${head}, heard ${heard}${state ? `, ${state}` : ""}"`;

test("recorded good run: Base and Robinhood charts and the Solana tape and chart, current and naming their read-to within each bound: PASS", () => {
  const r = judge(A.good.run);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  for (const { chain, what } of PATHS) assert.ok(r.lines.some((l) => l.startsWith(`GOOD [${chain} ${what} `)), `${chain} ${what} judged: ${r.lines.join("\n")}`);
});

test("recorded bad run: the deployed helper before the card serves each path current naming no read-to: FAIL on all four", () => {
  const r = judge(A.bad.run);
  assert.equal(r.verdict, "FAIL");
  for (const { chain, what } of PATHS) assert.ok(bad(r).some((l) => l.startsWith(`BAD [${chain} ${what} `) && / naming no read-to /.test(l)), `${chain} ${what}: ${bad(r).join("\n")}`);
});

for (const chain of ["base", "robinhood"]) {
  const { blocks, ms } = BEHIND_MAX[chain];
  test(`${chain} chart: current ${blocks + 1} blocks behind the helper's newest head, or its head read ${ms / 1_000 + 1} s before, or ${blocks + ms / (chain === "base" ? 200 : 100) + 200} blocks behind the providers' head: FAIL; at the bound PASS`, () => {
    const at = (b, ageS) => made(chain, "candles", (a) => ({ ...a, timing: evmTiming(readToOf(chain, a.timing).head - b, readToOf(chain, a.timing).head, ageS) }));
    assert.equal(judge(at(blocks, ms / 1_000)).verdict, "PASS", judge(at(blocks, ms / 1_000)).lines.join("\n"));
    assert.equal(judge(at(blocks + 1, 0)).verdict, "FAIL");
    assert.equal(judge(at(0, ms / 1_000 + 1)).verdict, "FAIL");
    const far = made(chain, "candles", (a) => a, (h) => ({ ...h, n: h.n + blocks + ms / (chain === "base" ? 200 : 100) + 200 }));
    const r = judge(far);
    assert.equal(r.verdict, "FAIL");
    assert.ok(bad(r).some((l) => l.startsWith(`BAD [${chain} candles `) && / behind the providers' head /.test(l)), r.lines.join("\n"));
  });
}

for (const what of ["trades", "candles"]) {
  test(`solana ${what}: current while the stream is refilling, unheard ${SOL_BEHIND_MS / 1_000 + 1} s, never heard, or its head 100 slots behind the providers': FAIL; heard at the bound PASS`, () => {
    const set = (heard, state, dHead = 0) => made("solana", what, (a) => ({ ...a, timing: solTiming(1, readToOf("solana", a.timing).head - dHead, heard, state) }));
    assert.equal(judge(set(`${SOL_BEHIND_MS / 1_000} s ago`)).verdict, "PASS", judge(set(`${SOL_BEHIND_MS / 1_000} s ago`)).lines.join("\n"));
    assert.equal(judge(set("0 s ago", "refilling")).verdict, "FAIL");
    assert.equal(judge(set(`${SOL_BEHIND_MS / 1_000 + 1} s ago`)).verdict, "FAIL");
    assert.equal(judge(set("never")).verdict, "FAIL");
    assert.equal(judge(set("0 s ago", undefined, 100)).verdict, "FAIL");
  });
}

test("every read filling, a vendor's chart, a chart with no bar or a tape with no reach claims nothing: INCONCLUSIVE, never FAIL; the providers' head unread: INCONCLUSIVE", () => {
  for (const [chain, what, f] of [
    ["base", "candles", (a) => ({ ...a, filling: true, timing: "" })],
    ["robinhood", "candles", (a) => ({ ...a, src: "geckoterminal", timing: "" })],
    ["base", "candles", (a) => ({ ...a, rows: 0, timing: "" })],
    ["solana", "trades", (a) => ({ ...a, whole_ms: null, timing: "" })],
  ]) {
    const r = judge(made(chain, what, f));
    assert.equal(r.verdict, "INCONCLUSIVE", `${chain} ${what}: ${r.lines.join("\n")}`);
  }
  const r = judge(made("base", "candles", (a) => a, () => ({ noAnswer: "a.test HTTP 503" })));
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
});

test("readToOf reads each chain's entry and nothing else", () => {
  assert.deepEqual(readToOf("base", evmTiming(5, 9, 2)), { block: 5, head: 9, ageS: 2, state: "live" });
  assert.deepEqual(readToOf("solana", solTiming(5, 9, "2 s ago")), { block: 5, head: 9, ageS: 2, state: "live" });
  assert.deepEqual(readToOf("solana", solTiming(5, "none", "never", "refilling")), { block: 5, head: null, ageS: null, state: "refilling" });
  assert.equal(readToOf("base", solTiming(5, 9, "2 s ago")), null);
  assert.equal(readToOf("solana", evmTiming(5, 9, 2)), null);
  assert.equal(readToOf("base", 'x-evm-read-to;desc="block 5 of head 9, read 2 s ago"'), null);
});
