// node --test scripts/live-checks/signpage-positions-evm.test.mjs: the live check replays its recorded reads of SIGN_HOST
// (signpage-positions-evm.answers.json). mainnet_good: a real read of SIGN_HOST (16 Nov, card
// live-checks-read-mainnet-only), its /app.js the pinned one, joining the EVM positions and carrying the EVM pass: PASS.
// bad: SIGN_HOST as it served before the card (a real read, 11 Nov 04:56Z), no join and no pass: FAIL. Made from the good
// read: a bundle that is not the pinned one, no join, no pass: each FAIL. The card's testnet run is
// signpage-positions-evm-testnet.test.mjs's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, pageFacts, read, SIGN } from "./signpage-positions-evm.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-positions-evm.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good read (SIGN_HOST, 16 Nov): the pinned bundle joins the EVM positions and carries the EVM pass: PASS", () => {
  const r = judge(A.mainnet_good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.length, 3);
});

test("recorded bad read (SIGN_HOST before the card): no join, no pass: FAIL on those two lines", () => {
  const r = judge({ page: A.bad.page });
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(bad(r).map((l) => /\(([a-z]+) /.exec(l)?.[1] ?? l), ["join", "both"], bad(r).join("\n"));
});

test("made from the good read: another bundle than the pinned one, no join, no pass, no page: each FAIL", () => {
  const g = A.mainnet_good.page;
  const at = (page) => judge({ page }).ok;
  assert.equal(at({ ...g, sha384: "sha384-x" }), false, "another bundle");
  assert.equal(at({ ...g, marks: { ...g.marks, join: 0 } }), false, "no join");
  assert.equal(at({ ...g, marks: { ...g.marks, pass: 0 } }), false, "no pass");
  assert.equal(at(undefined), false, "no page");
});

test("read() asks SIGN_HOST's index and /app.js alone, and pageFacts counts the marks the bundle holds", async () => {
  const asked = [];
  const js = "x positions:async()=>{let[e,...t]=await Promise.all([c.read(),...[`base`,`robinhood`].map( balanceOf: the two RPCs differ";
  const fetchFn = async (url) => {
    asked.push(url);
    return new Response(url.endsWith("/app.js") ? js : '<script src="/app.js" integrity="sha384-y"></script>', { status: 200 });
  };
  const r = await read(fetchFn);
  assert.deepEqual(asked, [`${SIGN}/`, `${SIGN}/app.js`]);
  assert.deepEqual(r.page.marks, { pass: 1, join: 1 });
  assert.deepEqual(pageFacts("", "").marks, { pass: 0, join: 0 });
});
