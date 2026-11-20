// node --test scripts/live-checks/helper-solana-slots-off-a-spent-key.test.mjs: the live check replays its recorded
// answers (helper-solana-slots-off-a-spent-key.answers.json). good: this card's helper in-process in the live host's
// shape (SOLANA_RPC_URL = SOLANA_TRADES_RPC_URL spent, the holders key and QuickNode answering): rpc, holders and trades
// keyed: PASS. bad: the deployed helper before the card, read 20 Nov 11:37Z: trades fallback while the holders key
// serves: FAIL. Planted from the good one: rpc fallback, trades fallback, no solana object, a 503: FAIL; nothing serving:
// INCONCLUSIVE; a slot not set ("public"): PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, read, run } from "./helper-solana-slots-off-a-spent-key.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-solana-slots-off-a-spent-key.answers.json", import.meta.url), "utf8"));
const replay = (a) => async (url, init) => {
  assert.equal(new URL(url).pathname, "/v1/health");
  assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
  return new Response(a.body, { status: a.status });
};
const bodyOf = () => JSON.parse(A.good.body);
const withBody = (b, status = 200) => ({ status, body: JSON.stringify(b) });
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer (rpc, holders and trades keyed past the spent key): PASS", async () => {
  const r = judge(await read("http://127.0.0.1:18741", replay(A.good)));
  assert.deepEqual(bad(r), []);
  assert.equal(r.verdict, "PASS");
});

test("recorded bad answer (the deployed helper before the card: trades fallback while the holders key serves): FAIL", async () => {
  const r = judge(await read("http://127.0.0.1:18741", replay(A.bad)));
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => /solana\.trades "fallback"/.test(l)), r.lines.join("\n"));
});

test("planted: each rule FAILs on its own; nothing serving is INCONCLUSIVE; a slot not set passes", () => {
  const planted = {
    "rpc fallback": (b) => (b.solana.rpc = "fallback"),
    "trades fallback": (b) => (b.solana.trades = "fallback"),
    "trades missing": (b) => delete b.solana.trades,
    "no solana object": (b) => delete b.solana,
  };
  for (const [name, plant] of Object.entries(planted)) {
    const b = bodyOf();
    plant(b);
    assert.equal(judge(withBody(b)).verdict, "FAIL", name);
  }
  assert.equal(judge(withBody(bodyOf(), 503)).verdict, "FAIL", "a 503");
  const none = bodyOf();
  Object.assign(none.solana, { rpc: "fallback", trades: "fallback", holders: "fallback" });
  none.rpc.solana = ["helius-rpc.com spent", "quiknode.pro down"];
  assert.equal(judge(withBody(none)).verdict, "INCONCLUSIVE");
  const unset = bodyOf();
  unset.solana.trades = "public";
  assert.equal(judge(withBody(unset)).verdict, "PASS");
});

test("a run that fails only on a slot's state reads again: cleared, it PASSes; still so after 3 min, FAIL; any other failure ends at once", async () => {
  const sleeps = [];
  const sleep = async (ms) => void sleeps.push(ms);
  const seq = (answers) => {
    let i = 0;
    return async () => answers[Math.min(i++, answers.length - 1)];
  };
  const cleared = await run(seq([A.bad, A.good]), sleep);
  assert.equal(cleared.verdict, "PASS");
  assert.equal(cleared.waited, 30_000);
  const stuck = await run(seq([A.bad]), sleep);
  assert.equal(stuck.verdict, "FAIL");
  assert.equal(stuck.waited, 180_000);
  sleeps.length = 0;
  const other = await run(seq([withBody(bodyOf(), 503)]), sleep);
  assert.equal(other.verdict, "FAIL");
  assert.equal(sleeps.length, 0);
});
