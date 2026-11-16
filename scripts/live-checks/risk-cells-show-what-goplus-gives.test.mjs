// node --test scripts/live-checks/risk-cells-show-what-goplus-gives.test.mjs: the check replays its recorded answers
// (risk-cells-show-what-goplus-gives.answers.json, each part's source in its _about): the card's answers pass; the
// deployed helper before the card, which served no cell of a partial (code 3) GoPlus answer, fails; a cell served src
// goplus that GoPlus names nothing for fails; the check reads GoPlus's fields itself (named) and paces its calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GAP_MS, judge, named, read } from "./risk-cells-show-what-goplus-gives.mjs";

const A = JSON.parse(readFileSync(new URL("./risk-cells-show-what-goplus-gives.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(":")[0]);

test("the recorded good answer: every cell GoPlus names is served src goplus, and no other: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer, the deployed helper before the card: SNDKc's and its sibling's tax, named by a code 3 answer, not served: FAIL", () => {
  assert.deepEqual(bad(judge(A.bad_deployed)), [
    "BAD base 0xb200000000000000000000397293cb8cda9a10c5 serves every cell GoPlus names (tax) src goplus (page 200)",
    "BAD base 0xb2000000000000000000004884b426556b92883d serves every cell GoPlus names (tax) src goplus (page 200)",
  ]);
});

test("planted: an inferred cell, and a chain GoPlus answered nothing for, each fail", () => {
  const r = structuredClone(A.good);
  r.chains.base.coins[0].pages.at(-1).cells.honeypot = "goplus";
  assert.deepEqual(bad(judge(r)), ["BAD base 0xb200000000000000000000397293cb8cda9a10c5 serves no cell src goplus that GoPlus names nothing for"]);
  const none = structuredClone(A.good);
  for (const x of none.chains.robinhood.coins) x.goplus.has_result = false;
  assert.deepEqual(bad(judge(none)), ["BAD robinhood"]);
});

test("named: the cells GoPlus's own fields give, as the SNDKc answer of 16 Nov names them (its taxes only); nothing from an absent field", () => {
  const sndkc = JSON.parse(readFileSync(new URL("../../apps/helper/src/data/evm/fixtures/goplus-base-sndkc-2026-11-16.json", import.meta.url), "utf8"));
  assert.deepEqual(named(sndkc.result["0xb200000000000000000000397293cb8cda9a10c5"]), ["tax"]);
  assert.deepEqual(named({ is_mintable: "0", transfer_pausable: "0", is_blacklisted: "0", creator_percent: "0.01", buy_tax: "0", sell_tax: "0.05", is_honeypot: "1" }), ["mint_auth", "freeze_auth", "dev_bps", "tax", "honeypot"]);
  assert.deepEqual(named({ transfer_pausable: "0", buy_tax: "0" }), [], "one freeze flag or one tax is no value");
  assert.deepEqual(named({ is_blacklisted: "1" }), ["freeze_auth"]);
});

test("read: GoPlus asked once a coin, GAP_MS apart; the page read until it holds a GoPlus cell", async () => {
  let t = 0;
  const goplusAt = [];
  let pageReads = 0;
  const fetchFn = async (url) => {
    const u = new URL(url);
    let body;
    if (u.host === "api.gopluslabs.io") {
      goplusAt.push(t);
      const a = u.searchParams.get("contract_addresses");
      body = { code: 3, result: { [a]: { buy_tax: "0", sell_tax: "0" } } };
    } else if (u.pathname === "/v1/market/lists") body = { lists: { trending_1h: [{ token: `0x${"a".repeat(40)}` }] } };
    else body = { risk: { tax: { v: 1, src: ++pageReads < 2 ? "none" : "goplus" } } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const r = await read("https://h.test", fetchFn, async (ms) => void (t += ms), () => t);
  assert.equal(goplusAt.length, 2);
  assert.ok(goplusAt[1] - goplusAt[0] >= GAP_MS, String(goplusAt));
  assert.deepEqual(r.chains.base.coins[0].goplus, { status: 200, code: 3, has_result: true, named: ["tax"] });
  assert.equal(r.chains.base.coins[0].pages.length, 2);
  assert.equal(judge(r).ok, true);
});
