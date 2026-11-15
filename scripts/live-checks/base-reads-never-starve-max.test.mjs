// node --test scripts/live-checks/base-reads-never-starve-max.test.mjs: the live check replays recorded answers
// (base-reads-never-starve-max.answers.json). good: the live helper, both EVM routes 200 inside SHOWN_MS: PASS.
// bad_busy: the live helper's base route answering 429 rate_limited (16:24:48Z): FAIL. Planted from them: a 503, a
// JSON-RPC error, an answer past SHOWN_MS, another origin: FAIL; a route that answers nothing: INCONCLUSIVE.
// The answers hold the helper's HTTP answers as recorded; each replays through the check's read (rpcAnswer), so the
// judged run is what --record writes. The sign part: sign_good (this card's build served locally): PASS; sign_bad_pre_card (SIGN_HOST before this card):
// FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAINS, judge, judgeSign, METHOD, PARAMS, read, SHOWN_MS, SIGN } from "./base-reads-never-starve-max.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "base-reads-never-starve-max.answers.json"), "utf8"));

/** A fetch that answers each route with its recorded read (its ms on the planted clock), and checks the ask is the
 *  positions pass's shown read with Origin SIGN_HOST. */
const replay = (run) => {
  let t = 0;
  const clock = () => t;
  const fetchFn = async (url, init) => {
    const chain = new URL(url).pathname.split("/").pop();
    const r = run.reads.find((x) => x.chain === chain);
    assert.ok(r, `asked ${url}`);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.origin, SIGN);
    const ask = JSON.parse(init.body);
    assert.equal(ask.method, METHOD);
    assert.deepEqual(ask.params, PARAMS);
    if (r.noAnswer !== undefined) throw new TypeError("fetch failed");
    t += r.ms;
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  return { fetchFn, clock };
};
const replayed = async (run) => {
  const { fetchFn, clock } = replay(run);
  return judge(await read(run.base, fetchFn, clock));
};
const edit = (run, chain, f) => ({ ...run, reads: run.reads.map((r) => (r.chain === chain ? f(structuredClone(r)) : r)) });

test("the check reads both EVM routes, base and robinhood", () => {
  assert.deepEqual(CHAINS, ["base", "robinhood"]);
  assert.deepEqual(A.good.reads.map((r) => r.chain), CHAINS);
});

test("recorded good answer (the live helper, both routes 200 inside SHOWN_MS): PASS", async () => {
  const r = await replayed(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("recorded bad answer (the live helper's base route 429 rate_limited): FAIL", async () => {
  const r = await replayed(A.bad_busy);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD [base] answers 429")), r.lines.join("\n"));
});

test("planted from the good answer: a 503, a JSON-RPC error, an answer past SHOWN_MS, another origin: FAIL; no answer: INCONCLUSIVE", async () => {
  for (const chain of CHAINS) {
    const cases = [
      ["503", (r) => ((r.status = 503), (r.body = '{"error":{"code":"upstream"}}'), r)],
      ["a JSON-RPC error", (r) => ((r.body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit" } })), r)],
      ["slow", (r) => ((r.ms = SHOWN_MS + 1), r)],
      ["another origin", (r) => ((r.headers["access-control-allow-origin"] = "https://other.test"), r)],
      ["not a word", (r) => ((r.body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" })), r)],
    ];
    for (const [what, f] of cases) {
      const r = await replayed(edit(A.good, chain, f));
      assert.equal(r.verdict, "FAIL", `${chain} ${what}: ${r.lines.join("\n")}`);
    }
    const quiet = await replayed(edit(A.good, chain, (r) => ({ chain: r.chain, noAnswer: "no answer" })));
    assert.equal(quiet.verdict, "INCONCLUSIVE", quiet.lines.join("\n"));
  }
});

test("the sign part: this card's build served PASS; SIGN_HOST before this card FAIL", () => {
  assert.equal(judgeSign(A.sign_good).verdict, "PASS", judgeSign(A.sign_good).lines.join("\n"));
  assert.equal(judgeSign(A.sign_bad_pre_card).verdict, "FAIL");
});
