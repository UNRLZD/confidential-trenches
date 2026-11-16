// node --test scripts/live-checks/tape-read.test.mjs: the tape reader the checks share (tape-read.mjs, card
// token-page-data-complete-and-fast): a filling tape is read again until its mark goes, a read fails, or FILLED_MS, and
// only a 200 tape with no mark within FILLED_MS passes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FILLED_MS, fillingOf, filledVerdict, readFilled, tapeFieldsFault } from "./tape-read.mjs";

const shape = (b) => (Array.isArray(JSON.parse(b).trades) ? "tape" : "no trades list");
const tape = (filling) => ({ status: 200, body: JSON.stringify({ trades: [], ...(filling ? { filling: true } : {}), src: "chain", as_of_ms: 1 }) });
const answers = (...xs) => {
  let i = 0;
  return async () => xs[Math.min(i++, xs.length - 1)];
};

test("fillingOf: only filling true", () => {
  assert.equal(fillingOf(tape(true).body), true);
  assert.equal(fillingOf(tape(false).body), false);
  assert.equal(fillingOf('{"filling":"true"}'), false);
  assert.equal(fillingOf("not json"), false);
});

test("readFilled reads again until the mark goes, or a read fails, or its bound; filledVerdict passes only the filled tape", async () => {
  const o = { sleep: async () => {}, pollMs: 0 };
  let f = await readFilled(answers(tape(true), tape(false)), shape, o);
  assert.deepEqual([f.status, f.filling, f.shape, f.reads], [200, false, "tape", 2]);
  assert.equal(filledVerdict(f).ok, true);
  f = await readFilled(answers({ status: 503, body: '{"error":{"code":"upstream"}}' }), shape, o);
  assert.deepEqual([f.status, f.reads], [503, 1]);
  assert.match(filledVerdict(f).text, /^503 \{"error":\{"code":"upstream"\}\} on read 1 after filling$/);
  assert.equal(filledVerdict(f).ok, false);
  f = await readFilled(answers(tape(true)), shape, { sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)), pollMs: 1, filledMs: 5 });
  assert.equal(f.filling, true, "still filling at its bound");
  assert.equal(filledVerdict({ ...f, ms: FILLED_MS + 1 }).ok, false);
  assert.match(filledVerdict({ ...f, ms: FILLED_MS + 1 }).text, /still filling \d+ ms after its first read \(\d+ reads\), past 45000 ms$/);
  assert.equal(filledVerdict(undefined).ok, false);
  assert.equal(filledVerdict({ status: 200, filling: false, shape: "tape", ms: FILLED_MS + 1, reads: 3 }).ok, false, "filled past the bound");
});

test("tapeFieldsFault: the trades fields in wire order, whole_ms only on a settled tape and within its read (card trades-checks-pass-on-177: release 177's answers pass, the lists the checks froze before it are no longer the rule)", () => {
  // live run 43977576335's answers, release 177 (ad9337504): a settled tape with its reach, a filling one without
  assert.equal(tapeFieldsFault({ trades: [], whole_ms: 1794871805000, src: "chain", as_of_ms: 1794872356048 }), null);
  assert.equal(tapeFieldsFault({ trades: [], filling: true, src: "chain", as_of_ms: 1 }), null);
  assert.equal(tapeFieldsFault({ trades: [], src: "coingecko", as_of_ms: 1 }), null);
  assert.equal(tapeFieldsFault({ trades: [], whole_ms: 0, src: "chain", as_of_ms: 1 }), null);
  // planted: a reach on a filling tape, a reach past the read, not a whole ms, a field out of order or unknown, filling false
  assert.equal(tapeFieldsFault({ trades: [], filling: true, whole_ms: 1, src: "chain", as_of_ms: 1 }), "whole_ms on a filling tape");
  assert.match(tapeFieldsFault({ trades: [], whole_ms: 60_002, src: "chain", as_of_ms: 1 }), /^whole_ms 60002$/);
  assert.match(tapeFieldsFault({ trades: [], whole_ms: 1.5, src: "chain", as_of_ms: 10 }), /^whole_ms 1.5$/);
  assert.match(tapeFieldsFault({ trades: [], whole_ms: -1, src: "chain", as_of_ms: 10 }), /^whole_ms -1$/);
  assert.match(tapeFieldsFault({ whole_ms: 1, trades: [], src: "chain", as_of_ms: 10 }), /^keys /);
  assert.match(tapeFieldsFault({ trades: [], src: "chain", as_of_ms: 10, extra: 1 }), /^keys /);
  assert.match(tapeFieldsFault({ trades: [], filling: false, src: "chain", as_of_ms: 10 }), /^keys /);
  assert.match(tapeFieldsFault({ trades: [], src: "chain", as_of_ms: "1" }), /^as_of_ms /);
  assert.equal(tapeFieldsFault([]), "no JSON object");
});
