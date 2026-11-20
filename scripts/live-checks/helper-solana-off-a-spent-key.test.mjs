// node --test scripts/live-checks/helper-solana-off-a-spent-key.test.mjs: the live check replays its recorded answers
// (helper-solana-off-a-spent-key.answers.json). good: this card's helper in-process in the live host's shape (a spent
// SOLANA_RPC_URL, QuickNode answering): solana.rpc "keyed", Helius "spent": PASS. bad: the deployed helper before the
// card, read 20 Nov 09:14Z: solana.rpc "fallback" while QuickNode answers, Helius "held": FAIL. Planted from the good one:
// fallback while one answers, a held entry, a malformed entry, no list, a 503: FAIL; nothing answering: INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, read, run } from "./helper-solana-off-a-spent-key.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-solana-off-a-spent-key.answers.json", import.meta.url), "utf8"));
const replay = (a) => async (url, init) => {
  assert.equal(new URL(url).pathname, "/v1/health");
  assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
  return new Response(a.body, { status: a.status });
};
const bodyOf = () => JSON.parse(A.good.body);
const withBody = (b, status = 200) => ({ status, body: JSON.stringify(b) });
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer (Helius spent, QuickNode answering, solana.rpc keyed): PASS", async () => {
  const r = judge(await read("http://127.0.0.1:18741", replay(A.good)));
  assert.deepEqual(bad(r), []);
  assert.equal(r.verdict, "PASS");
});

test("recorded bad answer (the deployed helper before the card: fallback while QuickNode answers, Helius held): FAIL", async () => {
  const r = judge(await read("http://127.0.0.1:18741", replay(A.bad)));
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => /solana\.rpc fallback while quiknode\.pro answers/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /helius-rpc\.com held/.test(l)), r.lines.join("\n"));
});

test("planted: each rule FAILs on its own; nothing answering is INCONCLUSIVE", () => {
  const planted = {
    "fallback while one answers": (b) => (b.solana.rpc = "fallback"),
    "a held entry": (b) => (b.rpc.solana = ["helius-rpc.com held", "quiknode.pro answers"]),
    "a malformed entry": (b) => (b.rpc.solana = ["https://x.helius-rpc.com/?api-key=k answers"]),
    "no list": (b) => delete b.rpc.solana,
    "no slot state": (b) => delete b.solana.rpc,
  };
  for (const [name, plant] of Object.entries(planted)) {
    const b = bodyOf();
    plant(b);
    assert.equal(judge(withBody(b)).verdict, "FAIL", name);
  }
  assert.equal(judge(withBody(bodyOf(), 503)).verdict, "FAIL", "a 503");
  const none = bodyOf();
  none.solana.rpc = "fallback";
  none.rpc.solana = ["helius-rpc.com spent", "quiknode.pro down"];
  assert.equal(judge(withBody(none)).verdict, "INCONCLUSIVE");
});

test("a run that fails only on the slot's state or a held entry reads again: cleared, it PASSes; still so after 3 min, FAIL; any other failure ends at once", async () => {
  const sleeps = [];
  const sleep = async (ms) => void sleeps.push(ms);
  const seq = (answers) => {
    let i = 0;
    return async () => answers[Math.min(i++, answers.length - 1)];
  };
  const cleared = await run(seq([A.bad, A.bad, A.good]), sleep);
  assert.equal(cleared.verdict, "PASS");
  assert.equal(cleared.waited, 60_000);
  const stuck = await run(seq([A.bad]), sleep);
  assert.equal(stuck.verdict, "FAIL");
  assert.equal(stuck.waited, 180_000);
  sleeps.length = 0;
  const other = await run(seq([withBody(bodyOf(), 503)]), sleep);
  assert.equal(other.verdict, "FAIL");
  assert.equal(sleeps.length, 0);
});
