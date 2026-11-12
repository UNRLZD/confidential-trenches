// node --test scripts/live-checks/pool-tree-read-waits-for-its-second.test.mjs: the live check replays its recorded
// answers (pool-tree-read-waits-for-its-second.answers.json, its _note says where each was read). good: this card's
// signing page build with mainnet's cadence read on two providers: PASS. bad: SIGN_HOST as served before the card:
// FAIL, every mark named. planted: the good answer with one thing changed each: FAIL on it, or INCONCLUSIVE for a
// provider that gave no answer. And the reads through rpcAnswer: a provider that throttles or never answers is a
// no-answer (INCONCLUSIVE), one that answers and never reaches the cut is FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXIT, RETRY } from "./provider-answer.mjs";
import { MARKS, PROVIDERS, REACH_WAITS, WAIT, judge, readChain } from "./pool-tree-read-waits-for-its-second.mjs";

RETRY.ms = 0;
WAIT.ms = 0;
const A = JSON.parse(readFileSync(new URL("./pool-tree-read-waits-for-its-second.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const no = (k) => `BAD the served bundle does not carry: ${k}`;
const KEYS = Object.keys(MARKS);

test("recorded good answer: this card's build, and mainnet reaching now + 1 s within the cap on both providers: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(v.lines.filter((l) => l.startsWith("ok ")).length, 2);
});

test("recorded bad answer: SIGN_HOST before the card carries none of the marks: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(bads(v), KEYS.map(no));
});

test("planted on good: another /app.js, no pin, each mark missing, a provider past the cap, one provider: FAIL; a provider with no answer: INCONCLUSIVE", () => {
  const g = A.good;
  const b = g.bundle;
  assert.deepEqual(bads(judge({ ...g, bundle: { ...b, sha384: "sha384-x" } })), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(bads(judge({ ...g, bundle: { ...b, index: "<html></html>" } })), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of KEYS) assert.deepEqual(bads(judge({ ...g, bundle: { ...b, carries: { ...b.carries, [k]: false } } })), [no(k)], k);
  const stalled = { ...g.chain[0], reached: false, waits: REACH_WAITS };
  const s = judge({ ...g, chain: [stalled, g.chain[1]] });
  assert.equal(s.verdict, "FAIL");
  assert.deepEqual(bads(s), [`BAD ${stalled.provider}: its confirmed block did not reach now + 1 s within ${REACH_WAITS} waits`]);
  assert.deepEqual(bads(judge({ ...g, chain: [g.chain[0]] })), ["BAD no mainnet read on two providers"]);
  const quiet = judge({ ...g, chain: [{ provider: g.chain[0].provider, noAnswer: "api.mainnet-beta.solana.com HTTP 429: 429 Too Many Requests" }, g.chain[1]] });
  assert.equal(quiet.verdict, "INCONCLUSIVE", quiet.lines.join("\n"));
  assert.deepEqual(bads(quiet), []);
  // a missing mark is FAIL even when a provider gave no answer
  assert.equal(judge({ ...g, bundle: { ...b, carries: { ...b.carries, [KEYS[0]]: false } }, chain: [{ provider: g.chain[0].provider, noAnswer: "y" }, g.chain[1]] }).verdict, "FAIL");
});

/** Two providers answering getSlot and getBlockTime from `time(provider, call)`; `deaf` gives no answer (HTTP 429). */
const chainFetch = (time, deaf = new Set()) => {
  const calls = new Map();
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (deaf.has(url)) return new Response("", { status: 429 });
    const n = (calls.get(url) ?? 0) + 1;
    calls.set(url, n);
    const result = method === "getSlot" ? 1_000 + n : time(url, n);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
};

test("reads through rpcAnswer: the next second reached: PASS; a provider that never reaches it: FAIL; one throttled: INCONCLUSIVE", async () => {
  // the block time moves to the next second after the first confirmed read
  const ok = await readChain(chainFetch((_u, n) => 1_800_000_000 + (n > 3 ? 1 : 0)));
  assert.equal(judge({ ...A.good, chain: ok }).verdict, "PASS");
  assert.ok(ok.every((p) => p.reached && p.waits <= 1));
  const stuck = await readChain(chainFetch(() => 1_800_000_000));
  const v = judge({ ...A.good, chain: stuck });
  assert.equal(v.verdict, "FAIL");
  assert.equal(bads(v).length, 2);
  const deaf = await readChain(chainFetch(() => 1_800_000_000, new Set([PROVIDERS[1]])));
  const q = judge({ ...A.good, chain: deaf });
  assert.equal(q.verdict, "INCONCLUSIVE", q.lines.join("\n"));
  assert.match(deaf[1].noAnswer, /429/);
});

test("a chain read that fails in transport or answers an error is INCONCLUSIVE (exit 3), never ERROR", async () => {
  const time = () => 1_800_000_000;
  const ok = chainFetch(time);
  // a fetch that throws (a dropped connection) on one provider
  const dropped = await readChain(async (url, init) => {
    if (url === PROVIDERS[0]) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    return ok(url, init);
  });
  assert.equal(judge({ ...A.good, chain: dropped }).verdict, "INCONCLUSIVE");
  assert.match(dropped[0].noAnswer, /ECONNRESET/);
  // a 503 whose body is a JSON-RPC error, and a 200 with an error answer that is not -32004
  for (const [status, code] of [[503, -32603], [200, -32603]]) {
    const erring = await readChain(async (url, init) => {
      if (url !== PROVIDERS[1]) return ok(url, init);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message: "Internal error" } }), { status });
    });
    const v = judge({ ...A.good, chain: erring });
    assert.equal(v.verdict, "INCONCLUSIVE", `${status} ${code}: ${v.lines.join("\n")}`);
    assert.match(erring[1].noAnswer, new RegExp(String(code)));
  }
  // the command's own exit for that verdict
  assert.equal(EXIT[judge({ ...A.good, chain: dropped }).verdict], 3);
});

test("a provider that answers -32004 for the block time through the whole cap is BAD, the refusal the sync makes", async () => {
  const ok = chainFetch(() => 1_800_000_000);
  const stuck = await readChain(async (url, init) => {
    if (url !== PROVIDERS[1] || JSON.parse(init.body).method !== "getBlockTime") return ok(url, init);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32004, message: "Block not available for slot 1" } }), { status: 200 });
  });
  const v = judge({ ...A.good, chain: stuck });
  assert.equal(v.verdict, "FAIL", v.lines.join("\n"));
  assert.deepEqual(bads(v), [`BAD ${PROVIDERS[1]}: its confirmed block did not reach now + 1 s within ${REACH_WAITS} waits`]);
});
