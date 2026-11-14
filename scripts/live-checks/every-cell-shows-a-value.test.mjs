// node --test scripts/live-checks/every-cell-shows-a-value.test.mjs: the check replays its recorded answers
// (every-cell-shows-a-value.answers.json, each part's source in its _about): the card's cells pass; the deployed helper
// before the card (NEAR rows blank, the Base page's GoPlus cells none) and a cell with no source fail; the read polls
// the Base page until its GoPlus cells land, at most READ_MS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GOPLUS_CELLS, judge, POLL_MS, read, READ_MS } from "./every-cell-shows-a-value.mjs";

const A = JSON.parse(readFileSync(new URL("./every-cell-shows-a-value.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer: every NEAR row has a market cap, holders and a launch time; the Base page's five cells from GoPlus: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answers: the deployed helper before the card, a cell with no source: FAIL", () => {
  assert.deepEqual(
    bad(judge(A.bad_deployed)).map((l) => l.split(":")[0]),
    ["BAD every NEAR row has a market cap, holders and a launch time", ...GOPLUS_CELLS.map((k) => `BAD ${k} from GoPlus`)],
  );
  assert.deepEqual(bad(judge(A.bad_guess)).map((l) => l.split(":")[0]), ["BAD honeypot from GoPlus"]);
});

test("read: the NEAR lists, the Base Trending list's first token, its page read every POLL_MS until the GoPlus cells land, READ_MS at most", async () => {
  let t = 0;
  let reads = 0;
  const cell = (src) => ({ v: src === "goplus" ? false : null, src, as_of_ms: 1 });
  const fetchFn = async (url) => {
    const u = new URL(url);
    const body =
      u.pathname === "/v1/market/lists" && u.searchParams.get("chain") === "near"
        ? { lists: { new: [{ token: "a.near", mc_usd: "1", holders: 2, created_s: 3, src: "unrealized", name: "dropped" }], trending_1h: [] } }
        : u.pathname === "/v1/market/lists"
          ? { lists: { trending_1h: [{ token: "0xaa" }, { token: "0xbb" }] } }
          : ((src) => ({ risk: Object.fromEntries(GOPLUS_CELLS.map((k) => [k, cell(src)])) }))(++reads < 3 ? "none" : "goplus");
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const r = await read("https://h.test", fetchFn, async (ms) => void (t += ms), () => t);
  assert.deepEqual(r.near.new, [{ account: "a.near", mc_usd: "1", holders: 2, created_s: 3, src: "unrealized" }]);
  assert.equal(r.address, "0xaa");
  assert.equal(r.pages.length, 3);
  assert.equal(t, 2 * POLL_MS);
  // never landing: READ_MS of reads, then the last read judged
  reads = -1e9;
  t = 0;
  const never = await read("https://h.test", fetchFn, async (ms) => void (t += ms), () => t);
  assert.equal(never.pages.length, READ_MS / POLL_MS + 1);
  assert.equal(judge(never).ok, false);
});
