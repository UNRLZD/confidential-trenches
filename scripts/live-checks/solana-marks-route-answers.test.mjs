// node --test scripts/live-checks/solana-marks-route-answers.test.mjs: route B's burst check replays its recorded runs
// (solana-marks-route-answers.answers.json): the live helper after 00:00Z 17 Nov, its provider's day new, PASSes; the
// live helper at 23:48Z 16 Nov, that day spent, every scan 503 at 0 ms, FAILs; planted runs fail on each rule, and a
// scan with no answer is INCONCLUSIVE, never a PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BURST, judge, read } from "./solana-marks-route-answers.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;
const A = JSON.parse(readFileSync(new URL("./solana-marks-route-answers.answers.json", import.meta.url), "utf8"));
const copy = (x) => JSON.parse(JSON.stringify(x));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good run: the live helper with its provider's day new, every scan of the burst listed by route B's provider: PASS", () => {
  const r = judge(A.good);
  assert.deepEqual(bad(r), []);
  assert.equal(r.verdict, "PASS");
});

test("recorded bad run: the live helper at 23:48Z 16 Nov, route B's one provider past its day, every scan 503 at 0 ms: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.equal(bad(r).filter((l) => /a list with its slot: HTTP 503/.test(l)).length, BURST, bad(r).join("\n"));
  assert.ok(bad(r).some((l) => /answered by no named provider/.test(l)));
});

test("planted: each rule FAILs on its own", () => {
  const planted = {
    "a scan missing": (r) => r.reads.pop(),
    "a 503": (r) => Object.assign(r.reads[1], { status: 503, answer: { error: { code: "upstream" } } }),
    "route A's provider": (r) => (r.reads[0].headers["server-timing"] = 'rpc-wait;dur=0, rpc;dur=55;desc="SOLANA_RPC_URL"'),
    "no commit": (r) => delete r.reads[2].headers["x-helper-commit"],
    "no slot": (r) => delete r.reads[3].answer.result.context,
  };
  for (const [what, plant] of Object.entries(planted)) {
    const run = copy(A.good);
    plant(run);
    assert.equal(judge(run).verdict, "FAIL", what);
  }
});

test("a scan with no usable answer is named and not judged: INCONCLUSIVE, and FAIL beside a 503", () => {
  const run = copy(A.good);
  run.reads[0] = { size: 13, status: 429, headers: {}, answer: { noAnswer: "HTTP 429 twice" } };
  assert.equal(judge(run).verdict, "INCONCLUSIVE");
  Object.assign(run.reads[1], { status: 503, answer: { error: { code: "upstream" } } });
  assert.equal(judge(run).verdict, "FAIL");
});

test("live read on fakes: the burst is sent at once, each the wallet lister's exact scan with Origin SIGN_HOST", async () => {
  let open = 0;
  let most = 0;
  const seen = [];
  const fetchFn = async (url, init) => {
    open++;
    most = Math.max(most, open);
    seen.push({ url, origin: init.headers.origin, body: JSON.parse(init.body) });
    await new Promise((go) => setTimeout(go, 5));
    open--;
    const id = JSON.parse(init.body).id;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: [] } }), { status: 200, headers: { "content-type": "application/json", "x-helper-commit": "a".repeat(40), "server-timing": 'rpc;dur=9;desc="SOLANA_RPC_URL_QUICKNODE"' } });
  };
  const run = await read("https://helper.example/", fetchFn, "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF");
  assert.equal(most, BURST);
  assert.ok(seen.every((s) => s.url === "https://helper.example/v1/rpc/solana-marks" && s.origin === "https://confidential.unrealized.trade" && s.body.method === "getProgramAccounts"));
  assert.deepEqual(seen.map((s) => s.body.params[1].filters[0].dataSize).sort(), [13, 13, 17, 17]);
  assert.equal(judge(run).verdict, "PASS");
});

// card solana-marks-route-answers, reopened. bad_day_486d732: the deployed helper at 486d73262, 20 Nov 19:0xZ, its one
// route B provider (QuickNode) past the day the helper allows it, every scan 503 at 0 ms naming no provider: FAIL.
// good_keyless: a local helper at this card with no key at all (route B its keyless pair, rpc.ts MARKS_KEYLESS) and the
// mainnet pool program, on mainnet: every scan listed (14 and 26 accounts) by SOLANA_MARKS_FOUNDATION: PASS.
test("recorded runs of the reopened card: the deployed helper with QuickNode past its day FAILs, a keyless helper at this card PASSes on the Foundation's endpoint", () => {
  const b = judge(A.bad_day_486d732);
  assert.equal(b.verdict, "FAIL");
  assert.equal(bad(b).filter((l) => /a list with its slot: HTTP 503/.test(l)).length, BURST, bad(b).join("\n"));
  const g = judge(A.good_keyless);
  assert.deepEqual(bad(g), [], g.lines.join("\n"));
  assert.equal(g.verdict, "PASS");
  assert.equal(g.lines.filter((l) => l.endsWith("answered by SOLANA_MARKS_FOUNDATION")).length, BURST);
});
