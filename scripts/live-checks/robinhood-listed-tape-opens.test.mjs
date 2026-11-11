// node --test scripts/live-checks/robinhood-listed-tape-opens.test.mjs: the live check's verdict replays recorded runs
// (robinhood-listed-tape-opens.answers.json):
//   good: the branch helper at 61f16646 on the Mac: 14 tokens dropped from the three chains' lists, every tape 200: PASS;
//   bad:  the helper at 358d8f4f (what is deployed) beside it: 7 dropped tokens' tapes 404 not_found: FAIL;
//   good_filling: the good answer with three of its Base tapes as the route answers a cold tape at its bound (card
//     token-page-data-complete-and-fast), each first answer and fill time the ones read for the three of ten cold Base
//     tapes that answered filling when opened at once by the branch's createSwaps on the public providers from the Mac,
//     2026-11-11 17:58Z: PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ANSWER_MS, CHAINS, FILLED_MS, judge, read, tokensOf } from "./robinhood-listed-tape-opens.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "robinhood-listed-tape-opens.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (f) => {
  const run = structuredClone(A.good);
  f(run);
  return judge(run);
};

test("the recorded good answer passes: tokens dropped from each chain's lists, every one's tape 200", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  for (const c of CHAINS) assert.ok(A.good.chains[c].dropped.length > 0, c);
  assert.equal(r.lines.filter((l) => / \(dropped\): 200 tape in \d+ ms$/.test(l)).length, 14, r.lines.join("\n"));
});

test("the recorded bad answer (the helper before the card) fails, each dropped token's 404 named", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.equal(bad(r).length, 7, r.lines.join("\n"));
  assert.ok(bad(r).every((l) => / \(dropped\): 404 \{"error":\{"code":"not_found"\}\} in \d+ ms$/.test(l)), bad(r).join("\n"));
  assert.equal(bad(r).filter((l) => l.startsWith("BAD robinhood ")).length, 1);
  assert.equal(bad(r).filter((l) => l.startsWith("BAD solana ")).length, 6);
});

test("planted on the good answer: a 503 or a body without trades fails; no chain dropping a token is INCONCLUSIVE, never a PASS; one chain dropping none still passes on the others; a failed lists read fails", () => {
  let r = edit((run) => Object.assign(run.chains.base.dropped[0], { status: 503, shape: null, body: '{"error":{"code":"upstream"}}' }));
  assert.equal(r.verdict, "FAIL");
  assert.match(bad(r)[0], /^BAD base trades 0x[0-9a-f]{40} \(dropped\): 503 /);
  r = edit((run) => (run.chains.solana.dropped[2].shape = "no trades list"));
  assert.equal(r.verdict, "FAIL");
  r = edit((run) => {
    for (const c of CHAINS) run.chains[c].dropped = [];
  });
  assert.equal(r.verdict, "INCONCLUSIVE");
  assert.equal(r.lines.filter((l) => l.startsWith("--  ") && l.endsWith("proves nothing")).length, 3);
  r = edit((run) => (run.chains.robinhood.dropped = []));
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  r = edit((run) => (run.chains.base.lists = { status: 503, tokens: 0 }));
  assert.deepEqual(bad(r), ["BAD base: GET /v1/market/lists?chain=base answers 503, 0 tokens"]);
});

test("card token-page-data-complete-and-fast: a cold tape that answers 200 filling inside ANSWER_MS and fills within FILLED_MS passes", () => {
  const r = judge(A.good_filling);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => /^ok  base trades 0x[0-9a-f]{40} \(dropped\): 200 tape filling in 8001 ms$/.test(l)).length, 3, r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => /^ok  base trades 0x[0-9a-f]{40} \(dropped\): filled \d+ ms after its first read \(\d+ reads\)$/.test(l)).length, 3, r.lines.join("\n"));
});

test("card token-page-data-complete-and-fast: planted on the filling answer: a 200 past ANSWER_MS, a tape still filling at FILLED_MS, a 503 after filling, a filling tape never read again each fail", () => {
  const plant = (f) => {
    const run = structuredClone(A.good_filling);
    f(run.chains.base.dropped[0]);
    return judge(run);
  };
  let r = plant((d) => (d.ms = ANSWER_MS + 1));
  assert.equal(r.verdict, "FAIL");
  assert.match(bad(r)[0], new RegExp(`\\(dropped\\): 200 tape filling in ${ANSWER_MS + 1} ms, past ${ANSWER_MS} ms$`));
  r = edit((run) => (run.chains.robinhood.dropped[0].ms = ANSWER_MS + 1));
  assert.equal(r.verdict, "FAIL", "a whole tape past the bound fails too");
  r = plant((d) => Object.assign(d.filled, { filling: true, ms: FILLED_MS + 1_500, reads: 23 }));
  assert.equal(r.verdict, "FAIL");
  assert.match(bad(r)[0], new RegExp(`still filling ${FILLED_MS + 1_500} ms after its first read \\(23 reads\\), past ${FILLED_MS} ms$`));
  r = plant((d) => Object.assign(d.filled, { ms: FILLED_MS + 1 }));
  assert.equal(r.verdict, "FAIL", "filled past FILLED_MS");
  r = plant((d) => Object.assign(d.filled, { status: 503, filling: false, shape: null, body: '{"error":{"code":"upstream"}}' }));
  assert.equal(r.verdict, "FAIL");
  assert.match(bad(r)[0], /503 \{"error":\{"code":"upstream"\}\} on read \d+ after filling$/);
  r = plant((d) => delete d.filled);
  assert.equal(r.verdict, "FAIL");
  assert.match(bad(r)[0], /filling, never read again$/);
});

test("tokensOf takes every list's tokens once and refuses what is not the chain's address", () => {
  const body = JSON.stringify({ lists: { new: [{ token: `0x${"ab".repeat(20)}` }, { token: "0xNOT" }], trending: [{ token: `0x${"ab".repeat(20)}` }, { token: `0x${"cd".repeat(20)}` }] } });
  assert.deepEqual(tokensOf("robinhood", body), [`0x${"ab".repeat(20)}`, `0x${"cd".repeat(20)}`]);
  assert.deepEqual(tokensOf("solana", body), []);
  assert.deepEqual(tokensOf("base", "not json"), []);
});

test("read() reads each chain's lists with the app's Origin until a token leaves them, then only those tokens' tapes", async () => {
  const T = (n) => `0x${n.repeat(40)}`;
  const M = (n) => n.repeat(43);
  const calls = [];
  const reads = { robinhood: 0, base: 0, solana: 0 };
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    calls.push(`${u.pathname}?${u.searchParams}`);
    assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
    const chain = u.searchParams.get("chain");
    if (u.pathname === "/v1/market/lists") {
      reads[chain]++;
      const all = chain === "solana" ? [M("A"), M("B")] : [T("1"), T("2")];
      // Robinhood drops its first token on the third read, Base never, Solana on the second
      const rows = (chain === "robinhood" && reads[chain] >= 3) || (chain === "solana" && reads[chain] >= 2) ? all.slice(1) : all;
      return new Response(JSON.stringify({ lists: { new: rows.map((token) => ({ token })) } }), { status: 200 });
    }
    return new Response(JSON.stringify({ trades: [], src: "chain", as_of_ms: 1 }), { status: 200 });
  };
  const run = await read("https://h.test", fetchFn, { waitMs: 50, pollMs: 0, sleep: async () => {} });
  assert.equal(run.chains.robinhood.dropped[0].filling, undefined, "a whole tape is read once");
  assert.deepEqual(run.chains.robinhood.dropped.map((d) => [d.address, d.status, d.shape]), [[T("1"), 200, "tape"]]);
  assert.deepEqual(run.chains.solana.dropped.map((d) => d.address), [M("A")]);
  assert.deepEqual(run.chains.base.dropped, []);
  assert.deepEqual(calls.filter((c) => c.startsWith("/v1/market/trades")).sort(), [`/v1/market/trades?chain=robinhood&token=${T("1")}&limit=50`, `/v1/market/trades?chain=solana&token=${M("A")}&limit=50`]);
  assert.equal(judge(run).verdict, "PASS");
});

test("card token-page-data-complete-and-fast: read() reads a filling tape again until its mark goes, and stops at FILLED_MS", async () => {
  const T = `0x${"1".repeat(40)}`;
  const lists = (rows) => new Response(JSON.stringify({ lists: { new: rows.map((token) => ({ token })) } }), { status: 200 });
  const tape = (filling) => new Response(JSON.stringify({ trades: [], ...(filling ? { filling: true } : {}), src: "chain", as_of_ms: 1 }), { status: 200 });
  for (const [what, fills, verdict] of [["filled on the third read", 3, "PASS"], ["never filled", Infinity, "FAIL"]]) {
    const reads = { lists: 0, tape: 0 };
    const fetchFn = async (url) => {
      const u = new URL(url);
      // Robinhood lists T on its first read and another token in its place on the next; the other chains list nothing
      if (u.pathname === "/v1/market/lists") return lists(u.searchParams.get("chain") !== "robinhood" ? [] : reads.lists++ === 0 ? [T] : [`0x${"2".repeat(40)}`]);
      reads.tape++;
      return tape(reads.tape < fills);
    };
    const run = await read("https://h.test", fetchFn, { waitMs: 50, pollMs: 0, filledMs: 5, fillPollMs: 1, sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)) });
    const d = run.chains.robinhood.dropped[0];
    assert.equal(d.filling, true, what);
    assert.equal(d.filled.filling, fills === Infinity, what);
    if (fills !== Infinity) assert.equal(d.filled.reads, 2, what);
    const r = judge({ ...run, chains: { ...run.chains, base: A.good.chains.base, solana: A.good.chains.solana } });
    assert.equal(r.verdict, verdict, `${what}: ${r.lines.join("\n")}`);
  }
});
