// node --test scripts/live-checks/near-seat-pace-fits-one-quote.test.mjs: card near-seat-pace-fits-one-quote's live
// check, replayed. near-seat-pace-fits-one-quote.answers.json holds a real run on the deployed helper before the card
// (bad, 2026-11-18 03:00:58Z: one quote's 29 reads at once on the seat, 21 met the helper's 429 on their first try) and
// a good run derived from it until the next helper deploy is recorded (each refused read answered as the first was).
// Good passes, bad fails on the 429s; planted cases hold a read's retry, a 5xx, a spread burst and a short burst.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, QUOTE_READS, read, SEAT } from "./near-seat-pace-fits-one-quote.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "near-seat-pace-fits-one-quote.answers.json"), "utf8"));

test("the check reads the seat the page names, one quote's reads (29, the app lead's count with every list kept)", () => {
  // read as text: a file outside the kit imports only its entry, which does not export the table
  const table = readFileSync(path.join(HERE, "../../packages/kit/src/near/networks.ts"), "utf8");
  const mainnet = table.slice(table.indexOf("  mainnet: {"), table.indexOf("  testnet: {"));
  assert.ok(mainnet.includes(`    seat: "${SEAT}",`), "the page's mainnet seat");
  assert.equal(QUOTE_READS, 29);
});

test("the recorded good run passes: every read of the burst served on its first try", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.startsWith(`OK the burst: ${QUOTE_READS} of ${QUOTE_READS} reads`)), v.lines.join("\n"));
});

test("the recorded bad run (the deployed helper before the card, 18 Nov 03:00:58Z) fails: 21 of 29 reads met 429", () => {
  const v = judge(A.bad);
  assert.equal(v.verdict, "FAIL", v.lines.join("\n"));
  assert.deepEqual(v.lines.filter((l) => l.startsWith("BAD")), ["BAD the burst: 21 of 29 reads met 429 (first read 2): one quote's reads do not fit the seat's burst"]);
});

const one = (i, extra = {}) => ({ i, sentMs: 0, doneMs: 300, statuses: [200], status: 200, acao: "https://confidential.unrealized.trade", ok: true, ...extra });
const run = (burst, final = A.good.final) => ({ final, burst });
const all = (f = () => ({})) => Array.from({ length: QUOTE_READS }, (_, i) => one(i, f(i)));

test("planted: a read whose first try met 429 and whose retry answered still FAILs; a 5xx is INCONCLUSIVE; a burst spread or short FAILs", () => {
  assert.equal(judge(run(all((i) => (i === 7 ? { statuses: [429, 200], ok: false, why: "HTTP 429, then 200" } : {})))).verdict, "FAIL");
  assert.equal(judge(run(all((i) => (i === 7 ? { statuses: [503, 503], status: 503, ok: false, why: "HTTP 503" } : {})))).verdict, "INCONCLUSIVE");
  assert.equal(judge(run(all((i) => (i === 28 ? { sentMs: 1_000 } : {})))).verdict, "FAIL", "a burst spread over a second is the pace's turns");
  assert.equal(judge(run(all().slice(0, 18))).verdict, "FAIL", "fewer reads than one quote");
  assert.equal(judge(run(all())).verdict, "PASS");
});

test("planted: the final block read meeting 429 FAILs, its no answer is INCONCLUSIVE", () => {
  assert.equal(judge({ final: { ...A.good.final, statuses: [429, 429], noAnswer: "x HTTP 429" } }).verdict, "FAIL");
  assert.equal(judge({ final: { statuses: [], status: null, acao: null, noAnswer: "x: no answer" } }).verdict, "INCONCLUSIVE");
});

test("read() sends the burst's reads at once at the final block and keeps a first-try 429 that a retry answered", async () => {
  const sent = [];
  let n = 0;
  const fetchFn = async (url, init) => {
    const p = JSON.parse(init.body).params;
    sent.push(p);
    const h = { "content-type": "application/json", "access-control-allow-origin": "https://confidential.unrealized.trade" };
    if (p.finality === "final") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { block_height: 100, block_hash: "h", result: [] } }), { status: 200, headers: h });
    if (++n === 3) return new Response("{}", { status: 429, headers: h });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { block_height: 100, block_hash: "h", result: [] } }), { status: 200, headers: h });
  };
  const { RETRY } = await import("./provider-answer.mjs");
  const ms = RETRY.ms;
  RETRY.ms = 0;
  try {
    const r = await read(fetchFn);
    assert.equal(r.burst.length, QUOTE_READS);
    assert.ok(sent.slice(1).every((p) => p.block_id === 100), "every read at the final block");
    assert.equal(r.burst.filter((x) => x.statuses.includes(429)).length, 1);
    assert.equal(judge(r).verdict, "FAIL");
  } finally {
    RETRY.ms = ms;
  }
});
