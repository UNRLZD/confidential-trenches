// node --test scripts/live-checks/near-buy-works-on-live.test.mjs: the live check replays its recorded answers
// (near-buy-works-on-live.answers.json). good: this card's SIGN_HOST build (scripts/signpage-built.mjs on its branch):
// PASS. bad: SIGN_HOST as served at release 144 (read 14 Nov 21:30Z), whose hand-off sends past the quote's window:
// FAIL, the fact named. Planted on the good one: another /app.js, no pin, no mark: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, MARK, read } from "./near-buy-works-on-live.mjs";

const A = JSON.parse(readFileSync(new URL("./near-buy-works-on-live.answers.json", import.meta.url), "utf8"));
const WINDOW = `BAD SIGN_HOST's hand-off sends a request past its fee quote's window (${JSON.stringify(MARK)} not in the bundle): a payout refused fee_too_low holds its note`;

test("recorded good answer: the card's build holds the quote's window before RESERVED: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST at release 144: FAIL, the window named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [WINDOW]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  const planted = [
    [{ ...g, sha384: "sha384-other" }, "BAD SIGN_HOST's served /app.js is not the one index.html pins"],
    [{ ...g, index: "<html></html>" }, "BAD SIGN_HOST's index.html pins no /app.js"],
    [{ ...g, window_held: false }, WINDOW],
  ];
  for (const [a, line] of planted) {
    const v = judge(a);
    assert.equal(v.ok, false, line);
    assert.ok(v.lines.includes(line), `${line}\n${v.lines.join("\n")}`);
  }
  assert.equal(judge({}).ok, false, "an empty answer");
});

test("read() asks SIGN_HOST's / and /app.js and nothing else", async () => {
  const asked = [];
  const fetchFn = async (url) => (asked.push(url), new Response(url.endsWith("/app.js") ? `x${MARK}` : A.good.index));
  const a = await read(fetchFn);
  assert.deepEqual(asked, ["https://confidential.unrealized.trade/", "https://confidential.unrealized.trade/app.js"]);
  assert.equal(a.window_held, true);
});
