// node --test scripts/live-checks/sol-buy-reads-side-by-side.test.mjs: the live check replays its recorded answers
// (sol-buy-reads-side-by-side.answers.json). good: this card's testnet build (the pool's time read beside the buy's
// first round on both clocks and handed to the take, used within 5 s on both): PASS. bad: the testnet build of the tree
// before it, 00c8b0c0 (the take reads the pool's time itself): FAIL, each fact named. Planted on the good one, each
// FAIL with its line: the read stamped on the wall clock or after its answer; the take's wall bound, monotonic bound or
// start check gone, the time since not the larger, a longer bound; the take not timed with its early read; the buy
// that never starts it or never hands it on; the send's take without it; the host that drops it, reads one RPC or
// another clock. Another /app.js, no pin. No pool send: PASS with its note.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./sol-buy-reads-side-by-side.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sol-buy-reads-side-by-side.answers.json", import.meta.url), "utf8"));
const CLOCK = "BAD the bundle's read of the pool's time for the take does not stamp the monotonic and the wall clock before it asks the pool";
const NOW = "BAD the bundle's take does not use an early read as its ms plus the larger of the two clocks' time since, only within 5 s on both, else a read of its own";
const TAKE = "BAD the bundle's take does not time itself with the early read it is handed";
const BUY = "BAD the bundle's buy does not start the pool's time read beside its first round and hand it to the send";
const SEND = "BAD the bundle's send does not hand the early read to the take";
const HOST = "BAD the page's buy host does not pass the early read to the queue and read it with the take's clock on the page's pool or both its RPCs";

test("recorded good answer: this card's testnet build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: the testnet build of 00c8b0c0, the take reading the pool's time itself: FAIL, each fact named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [CLOCK, NOW, BUY, SEND, HOST]);
});

const CASES = [
  ["the read's start on the wall clock alone", "clock", "n=performance.now(),r=Date.now()", "n=Date.now(),r=Date.now()", [CLOCK]],
  ["the read stamped after its answer", "clock", "let n=performance.now(),r=Date.now();return{ms:await e.now(t),at:n,wall:r}", "let m=await e.now(t),n=performance.now(),r=Date.now();return{ms:m,at:n,wall:r}", [CLOCK]],
  ["the take's wall clock bound gone (a sleep reused)", "now", "&&n<=5e3)", ")", [NOW]],
  ["the take's monotonic bound gone", "now", "&&e<=5e3&&", "&&", [NOW]],
  ["a start ahead of the monotonic clock used", "now", "e>=0&&", "", [NOW]],
  ["the time since the monotonic one only", "now", "Math.max(e,n)", "e", [NOW]],
  ["a bound of 60 s", "now", "e<=5e3&&n<=5e3", "e<=6e4&&n<=6e4", [NOW]],
  ["the time since dropped", "now", "return t.ms+BigInt(Math.ceil(Math.max(e,n)))", "return t.ms", [NOW]],
  ["the take not timed with its early read", "take", "await S(i),", "await S(),", [TAKE]],
  ["the buy never starts the read", "buy", "let p=e.chainNow?.();p?.catch(()=>{});", "", [BUY]],
  ["the buy never hands the read on", "buy", "early:p}", "early:void 0}", [BUY]],
  ["the send's take without the read", "send", "t.attempt,s?.early)", "t.attempt)", [SEND]],
  ["the host drops the read", "host", "take:async(e,t,n)=>(await l()).take(e,t,n)", "take:async(e,t)=>(await l()).take(e,t)", [HOST]],
  ["the host reads RPC 0 alone", "host", "wO(r(),e)", "wO([r()[0],r()[0]],e)", [HOST]],
  ["the host reads with another function", "host", "chainNow:()=>RT(", "chainNow:()=>zT(", [HOST]],
];
for (const [name, field, from, to, lines] of CASES) {
  test(`planted on the good answer, ${name}: FAIL, that fact named`, () => {
    assert.ok(ANSWERS.good[field].includes(from), "the recorded answer holds the planted text");
    const v = judge({ ...ANSWERS.good, [field]: ANSWERS.good[field].replace(from, to) });
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, lines);
  });
}

test("recorded reader answer: SIGN_HOST's build of card buy-spends-several-pieces, the take's own read through the queue's reader: PASS", () => {
  assert.equal(ANSWERS.reader.read !== null && ANSWERS.reader.now.endsWith("return s()}"), true, "the recorded answer is the reader shape");
  const v = judge(ANSWERS.reader);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

const READER_CASES = [
  ["the reader answering something else than the pool's time", "read", "i=await r.now(e)", "i=await r.then(e)", [NOW]],
  ["the reader dropping its signal", "read", "i=await r.now(e)", "i=await r.now()", [NOW]],
  ["the reader answering another value than its read", "read", "(o={ms:i,at:t,wall:n}),i}", "(o={ms:i,at:t,wall:n}),0n}", [NOW]],
  ["the take falling back to another function", "now", "return s()}", "return z()}", [NOW]],
  ["the take's wall clock bound gone, on the reader shape", "now", "&&n<=5e3)", ")", [NOW]],
  ["the take's monotonic bound gone, on the reader shape", "now", "&&e<=5e3&&", "&&", [NOW]],
];
for (const [name, field, from, to, lines] of READER_CASES) {
  test(`planted on the reader answer, ${name}: FAIL, that fact named`, () => {
    assert.ok(ANSWERS.reader[field].includes(from), "the recorded answer holds the planted text");
    const v = judge({ ...ANSWERS.reader, [field]: ANSWERS.reader[field].replace(from, to) });
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, lines);
  });
}

test("planted: the reader shape with no reader read: FAIL", () => {
  assert.deepEqual(judge({ ...ANSWERS.reader, read: null }).lines, [NOW]);
});

test("planted: a stretch not read at all: FAIL", () => {
  assert.deepEqual(judge({ ...ANSWERS.good, now: null }).lines, [NOW]);
  assert.deepEqual(judge({ ...ANSWERS.good, buy: null }).lines, [BUY]);
});

test("planted: another /app.js than index.html pins, or no pin: FAIL", () => {
  assert.deepEqual(judge({ ...ANSWERS.good, sha384: `sha384-${createHash("sha384").update("x").digest("base64")}` }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...ANSWERS.good, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
});

test("planted: a build that sends no pool transaction: PASS with its note", () => {
  const v = judge({ ...ANSWERS.good, poolSend: false });
  assert.equal(v.ok, true);
  assert.deepEqual(v.lines, ["NOTE the bundle sends no pool transaction (no pinned pool on this build)"]);
});
