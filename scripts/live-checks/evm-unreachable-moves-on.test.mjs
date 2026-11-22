// node --test scripts/live-checks/evm-unreachable-moves-on.test.mjs: the live check replays its recorded answers
// (evm-unreachable-moves-on.answers.json). good: this card's SIGN_HOST build (scripts/signpage-built.mjs on its branch):
// PASS. bad: SIGN_HOST as served on 18 Nov before this card, whose ask asks a refused connection of the same provider
// again while another is left: FAIL, named. Planted on the good one: another /app.js, no pin, no mark: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, NO_MOVE, read } from "./evm-unreachable-moves-on.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-unreachable-moves-on.answers.json", import.meta.url), "utf8"));

test("recorded good answer: the card's build moves a refused connection to the next provider: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, the move named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_MOVE]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  const planted = [
    [{ ...g, sha384: "sha384-other" }, "BAD SIGN_HOST's served /app.js is not the one index.html pins"],
    [{ ...g, index: "<html></html>" }, "BAD SIGN_HOST's index.html pins no /app.js"],
    [{ ...g, moves: false }, NO_MOVE],
  ];
  for (const [a, line] of planted) {
    const v = judge(a);
    assert.equal(v.ok, false, line);
    assert.ok(v.lines.includes(line), `${line}\n${v.lines.join("\n")}`);
  }
  assert.equal(judge({}).ok, false, "an empty answer");
});

test("the mark as the build minifies it, and not the code before the card", () => {
  assert.equal(facts("", "if(!(e instanceof wS||e instanceof TS)||i===3||n?.spare?.()===!0)throw new Oy(`rpc_error`").moves, true);
  // before: the spare read for a throttle alone
  assert.equal(facts("", "if(!(e instanceof wS||e instanceof TS)||i===3||e instanceof wS&&n?.spare?.()===!0)throw new Oy(`rpc_error`").moves, false);
  // card evm-warm-tap-ends-inside-two-seconds: the spare clause still alone, then the round's done clause
  assert.equal(facts("", "if(!(e instanceof wS||e instanceof TS)||i===3||n?.spare?.()===!0||n?.done?.()===!0)throw new Oy(`rpc_error`").moves, true);
  // the spare read for a throttle alone, with the done clause after it: still the code before the card
  assert.equal(facts("", "if(!(e instanceof wS||e instanceof TS)||i===3||e instanceof wS&&n?.spare?.()===!0||n?.done?.()===!0)throw new Oy(`rpc_error`").moves, false);
});

test("read() asks SIGN_HOST's / and /app.js and nothing else", async () => {
  const asked = [];
  const fetchFn = async (url) => (asked.push(url), new Response(url.endsWith("/app.js") ? "x" : A.good.index));
  const a = await read(fetchFn);
  assert.deepEqual(asked, ["https://confidential.unrealized.trade/", "https://confidential.unrealized.trade/app.js"]);
  assert.equal(a.moves, false);
});
