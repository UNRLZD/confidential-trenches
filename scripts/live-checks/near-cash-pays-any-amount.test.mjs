// node --test scripts/live-checks/near-cash-pays-any-amount.test.mjs: the live check replays its recorded answers
// (near-cash-pays-any-amount.answers.json). good: this card's helper quoter on the live mainnet pair and its SIGN_HOST
// build: PASS. bad: HELPER_HOST and SIGN_HOST at release 146 (a 98-block quote, no planned pick): FAIL, both named.
// Planted on the good one: a quote one block short, another /app.js, no pin, no mark: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HELPER, judge, MARK, MIN_LEFT, read, SIGN, USDC } from "./near-cash-pays-any-amount.mjs";

const A = JSON.parse(readFileSync(new URL("./near-cash-pays-any-amount.answers.json", import.meta.url), "utf8"));
const PLANNED = `BAD SIGN_HOST's NEAR buy does not plan its payout over notes (${JSON.stringify(MARK)} not in the bundle): an amount no one note covers is refused`;
const windowLine = (left) => `BAD HELPER_HOST's quote closes ${left} blocks past the final height, under ${MIN_LEFT}: a slow device's request is priced at the fee now and let go`;
const withUntil = (a, until) => ({ ...a, quote: JSON.stringify({ ...JSON.parse(a.quote), valid_until_block: until }) });

test("recorded good answer: the card's quote window and SIGN_HOST build: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: release 146: FAIL, the 98-block window and the unplanned pick named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [windowLine(98), PLANNED]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  assert.equal(judge(withUntil(g, g.height + MIN_LEFT)).ok, true, "MIN_LEFT blocks left is enough");
  const planted = [
    [withUntil(g, g.height + MIN_LEFT - 1), windowLine(MIN_LEFT - 1)],
    [{ ...g, quote: "{}" }, "BAD HELPER_HOST's quote or the pair's final height is not a height"],
    [{ ...g, sha384: "sha384-other" }, "BAD SIGN_HOST's served /app.js is not the one index.html pins"],
    [{ ...g, index: "<html></html>" }, "BAD SIGN_HOST's index.html pins no /app.js"],
    [{ ...g, planned: false }, PLANNED],
  ];
  for (const [a, line] of planted) {
    const v = judge(a);
    assert.equal(v.ok, false, line);
    assert.ok(v.lines.includes(line), `${line}\n${v.lines.join("\n")}`);
  }
  assert.equal(judge({}).ok, false, "an empty answer");
});

test("read() asks HELPER_HOST's fee quote, the pair's two finals, SIGN_HOST's / and /app.js, and nothing else", async () => {
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    if (url.startsWith(HELPER)) return new Response(JSON.stringify({ valid_until_block: 2_200 }));
    if (url.startsWith(SIGN)) return new Response(url.endsWith("/app.js") ? `x${MARK}` : A.good.index);
    return new Response(JSON.stringify({ result: { header: { height: 1_000 } } }));
  };
  const a = await read(fetchFn);
  assert.deepEqual(asked, [`${HELPER}/v1/withdraw/fee?token=${USDC}`, "https://rpc.mainnet.fastnear.com", "https://near.drpc.org", `${SIGN}/`, `${SIGN}/app.js`]);
  assert.equal(a.planned, true);
  assert.equal(a.height, 1_000);
});
