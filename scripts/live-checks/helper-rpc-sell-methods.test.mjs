// node --test scripts/live-checks/helper-rpc-sell-methods.test.mjs: the live check replays recorded runs
// (helper-rpc-sell-methods.answers.json). good: the deployed helper at ea97ceff (7 Nov 04:08Z), every method on the
// kit's Solana list answered: PASS. bad_before: apps/helper at c297f617, the commit before card pool-buy-send-fast put
// the pool path's reads on the list, run on a Mac with no env (the public endpoint) and read by this check: getSlot,
// getSignaturesForAddress, getFeeForMessage, getBlockTime and getEpochInfo refused 400 method_not_allowed, and
// getTokenLargestAccounts 429 from the public endpoint, which answers that method 429 to that Mac: FAIL. Made from the
// good run: a refusal, another id, a * origin, a missing read, a 429 left after its wait: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HELPER_RPC_METHODS } from "../../packages/kit/src/index.ts";
import { PARAMS, SIGN, judge, read } from "./helper-rpc-sell-methods.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-rpc-sell-methods.answers.json"), "utf8"));
const BASE = "https://ct-api.unrealized.trade";

// a fetch that answers each call with the recorded read for its method, after checking the check asked the right thing
const replay = (rec, sent = []) => async (url, init) => {
  assert.equal(url, `${BASE}/v1/rpc/solana`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.origin, SIGN);
  const body = JSON.parse(init.body);
  sent.push(body);
  const r = rec.reads.find((x) => x.method === body.method);
  assert.equal(body.id, r.id);
  return new Response(r.body, { status: r.status, headers: r.headers });
};
const run = async (rec, opts = {}) => judge(await read(BASE, replay(rec), { methods: rec.methods, program: rec.program, wait: async () => {}, ...opts }));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD")).map((l) => l.slice(0, l.indexOf("]") + 1));
const edit = (method, f) => ({ ...A.good, reads: A.good.reads.map((x) => (x.method === method ? f(structuredClone(x)) : x)) });

test("recorded good run: the deployed helper answers every method on the kit's Solana list: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.good.methods, [...HELPER_RPC_METHODS.solana]);
  assert.equal(r.lines.length, 1 + 18 * 3 + 1);
  assert.ok(r.lines.some((l) => l.startsWith('ok  [getFeeForMessage] answered: 200 {"jsonrpc":"2.0","id":16,"result":"object"}')));
});

test("recorded bad run: the helper before the pool path's reads were listed refuses getFeeForMessage, getSlot and getEpochInfo: FAIL", async () => {
  const r = await run(A.bad_before);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD [getTokenLargestAccounts]", "BAD [getSlot]", "BAD [getSignaturesForAddress]", "BAD [getFeeForMessage]", "BAD [getBlockTime]", "BAD [getEpochInfo]"]);
  assert.ok(r.lines.includes('BAD [getFeeForMessage] answered: 400 {"error":{"code":"method_not_allowed"}}'));
});

test("made from the good run: a refusal, an answer for another id, a * origin, a missing read: each FAIL", async () => {
  const refused = edit("getEpochInfo", (x) => ((x.status = 400), (x.body = '{"error":{"code":"method_not_allowed"}}'), x));
  assert.deepEqual(bad(await run(refused)), ["BAD [getEpochInfo]"]);
  const id = edit("getSlot", (x) => ((x.body = JSON.stringify({ ...JSON.parse(x.body), id: 99 })), x));
  assert.deepEqual(bad(await run(id)), ["BAD [getSlot]"]);
  const star = edit("sendTransaction", (x) => ((x.headers["access-control-allow-origin"] = "*"), x));
  assert.deepEqual(bad(await run(star)), ["BAD [sendTransaction]"]);
  const missing = judge({ ...A.good, reads: A.good.reads.filter((x) => x.method !== "getFeeForMessage") });
  assert.ok(missing.lines.includes("BAD [getFeeForMessage] no read"));
  // a mainnet pool on record: getProgramAccounts is then read, and a run without it fails
  assert.ok(judge({ ...A.good, program: "11111111111111111111111111111111" }).lines.includes("BAD [getProgramAccounts] no read"));
});

test("a 429 is waited out once for its Retry-After and sent again; a second 429 is recorded and fails", async () => {
  const once = (n429) => {
    let left = n429;
    const waits = [];
    const f = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "getSlot" && left-- > 0) return new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: { ...A.good.reads[0].headers, "retry-after": "3" } });
      return replay(A.good)(url, init);
    };
    return { f, waits, wait: async (ms) => void waits.push(ms) };
  };
  const a = once(1);
  const r1 = judge(await read(BASE, a.f, { methods: A.good.methods, program: null, wait: a.wait }));
  assert.equal(r1.ok, true, r1.lines.join("\n"));
  assert.deepEqual(a.waits, [3100]);
  const b = once(2);
  const r2 = judge(await read(BASE, b.f, { methods: A.good.methods, program: null, wait: b.wait }));
  assert.deepEqual(bad(r2), ["BAD [getSlot]"]);
  assert.deepEqual(b.waits, [3100]);
});

test("every method on the kit's Solana list has its request, and getProgramAccounts is the restore's shape on the record's program", async () => {
  for (const m of HELPER_RPC_METHODS.solana) assert.ok(PARAMS[m] !== undefined, `no params for ${m}`);
  const sent = [];
  const rec = { ...A.good, program: "11111111111111111111111111111111", reads: [...A.good.reads, { method: "getProgramAccounts", id: 19, status: 200, headers: A.good.reads[0].headers, body: '{"jsonrpc":"2.0","id":19,"result":"object"}' }] };
  const r = judge(await read(BASE, replay(rec, sent), { methods: rec.methods, program: rec.program, wait: async () => {} }));
  assert.equal(r.ok, true, r.lines.join("\n"));
  // apps/helper/src/rpc/rpc.test.ts SPENT less minContextSlot, which the helper forwards with or without it
  assert.deepEqual(sent.find((b) => b.method === "getProgramAccounts").params, [rec.program, { commitment: "finalized", encoding: "base64", withContext: true, filters: [{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1112" } }] }]);
});
