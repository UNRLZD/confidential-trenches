// node --test scripts/live-checks/near-dcl-route.test.mjs: the live check replays recorded runs (near-dcl-route.answers.json).
// good: the branch's NEAR lists (engineFirst over the live engine and the branch's pool reads, Rhea classic and DCL)
// answered at HELPER_HOST's name at 2026-11-16 08:43Z, the pools and the device's DCL quote read live on both RPCs: 36
// coins each with a route of at least $1000, 19 of them on DCL alone, the quote of mlc.nearlytrade.near paying: PASS.
// bad: the deployed helper at 08:44Z, before this card and before near-listed-coin-quotes, 57 coins of which 21 have
// no route even with DCL counted: FAIL. Made from the good run: the DCL coins off the lists (classic routes only, as
// near-listed-coin-quotes left them), the DCL quote refused or paying 0, a coin with no route and the lists not
// answered each FAIL; the pages differing, a provider refusing the quote and no coin listed INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./near-dcl-route.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "near-dcl-route.answers.json"), "utf8"));
const edit = (fn) => {
  const r = structuredClone(A.good.run);
  fn(r);
  return judge(r);
};

test("good: the branch's lists, every NEAR coin routed, DCL coins back on them, the device's DCL quote paying: PASS", () => {
  const j = judge(A.good.run);
  assert.equal(j.verdict, "PASS", j.lines.join("\n"));
  assert.ok(A.good.run.dcl_only.length >= 1 && A.good.run.quote.path.length >= 1);
});

test("bad: the deployed helper before this card lists coins no NEAR buy quotes: FAIL, naming each", () => {
  const j = judge(A.bad.run);
  assert.equal(j.verdict, "FAIL");
  assert.equal(j.lines.filter((l) => l.startsWith("BAD")).length, 21, j.lines.join("\n"));
});

test("planted: the DCL coins off the lists, the DCL quote refused or 0, a coin with no route, or the lists not answered FAIL", () => {
  const offDcl = edit((r) => {
    r.coins = r.coins.filter((c) => !r.dcl_only.includes(c));
    r.dcl_only = [];
  });
  assert.equal(offDcl.verdict, "FAIL");
  assert.ok(offDcl.lines.some((l) => l.startsWith("BAD") && l.includes("still off the lists")));
  assert.equal(edit((r) => ((r.quote = { ...r.quote, venue_out: "0" }), 0)).verdict, "FAIL");
  assert.equal(edit((r) => ((r.quote = { ...r.quote, venue_out: null, refused: "Rhea quote refused (liquidity): none", code: "liquidity" }), 0)).verdict, "FAIL");
  assert.equal(edit((r) => ((r.quote = { ...r.quote, token: "other.near" }), 0)).verdict, "FAIL", "a quote of another coin");
  assert.equal(edit((r) => ((r.routes[r.coins[0]] = null), 0)).verdict, "FAIL");
  assert.equal(edit((r) => ((r.routes[r.coins[0]] = "999.99"), 0)).verdict, "FAIL");
  assert.equal(edit((r) => ((r.lists.status = 503), 0)).verdict, "FAIL");
});

test("planted: the RPCs' pages differ, a provider refuses the quote, or no NEAR coin listed: INCONCLUSIVE", () => {
  assert.equal(edit((r) => ((r.error = { differ: true, message: "list_pools: the RPCs' answers differ" }), (r.block = null))).verdict, "INCONCLUSIVE");
  assert.equal(edit((r) => ((r.quote = { ...r.quote, venue_out: null, refused: "Rhea quote refused (rpc): 429", code: "rpc" }), 0)).verdict, "INCONCLUSIVE");
  assert.equal(edit((r) => ((r.coins = []), (r.routes = {}))).verdict, "INCONCLUSIVE");
});
