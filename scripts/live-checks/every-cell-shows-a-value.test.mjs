// node --test scripts/live-checks/every-cell-shows-a-value.test.mjs: the check replays its recorded answers
// (every-cell-shows-a-value.answers.json, each part's source in its _about): the card's NEAR cells pass; the deployed
// helper before the card (NEAR rows blank) fails. The recordings' Base page cells are no longer judged here: Base's
// contract cells are risk-cells-show-what-goplus-gives.mjs's (card risk-cells-show-what-goplus-gives).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, read } from "./every-cell-shows-a-value.mjs";

const A = JSON.parse(readFileSync(new URL("./every-cell-shows-a-value.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer: every NEAR row has a market cap, holders and a launch time: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer, the deployed helper before the card (NEAR rows blank): FAIL", () => {
  assert.deepEqual(
    bad(judge(A.bad_deployed)).map((l) => l.split(":")[0]),
    ["BAD every NEAR row has a market cap, holders and a launch time"],
  );
});

test("read: the NEAR lists, each row's market cap, holders, launch time and source", async () => {
  const fetchFn = async (url) => {
    const u = new URL(url);
    assert.deepEqual([u.pathname, u.searchParams.get("chain")], ["/v1/market/lists", "near"]);
    return new Response(JSON.stringify({ lists: { new: [{ token: "a.near", mc_usd: "1", holders: 2, created_s: 3, src: "unrealized", name: "dropped" }], trending_1h: [] } }), { status: 200 });
  };
  const r = await read("https://h.test", fetchFn, () => 0);
  assert.deepEqual(r.near.new, [{ account: "a.near", mc_usd: "1", holders: 2, created_s: 3, src: "unrealized" }]);
  assert.equal(judge(r).ok, false, "Trending (1h) has no row");
});
