// node --test scripts/live-checks/helper-rpc-takes-batches.test.mjs: the live check replays recorded runs
// (helper-rpc-takes-batches.answers.json). good: this card's relay run on a Mac against the chains' public RPCs: PASS.
// bad: the live helper at release 146 (f2da399dd), eth_chainId and eth_getBlockByHash refused 400 on both routes: FAIL.
// Made from the good run: another chain's id, a block by hash that is another block, a missing read: each FAIL; a 429:
// INCONCLUSIVE, never PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RETRY } from "./provider-answer.mjs";
import { CHAINS, KINDS, ROUTES, SIGN, judge, read } from "./helper-rpc-takes-batches.mjs";

RETRY.ms = 0;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-rpc-takes-batches.answers.json"), "utf8"));
const METHOD = { chainId: "eth_chainId", finalized: "eth_getBlockByNumber", byHash: "eth_getBlockByHash" };

// a fetch that answers each call with the recorded read for it, after checking the check asked the right thing
const replay = (run) => async (url, init) => {
  const m = url.match(/\/v1\/rpc\/([a-z]+)(\?keyed=only)?$/);
  assert.ok(m, url);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.origin, SIGN);
  const body = JSON.parse(init.body);
  const kind = KINDS.find((k) => METHOD[k] === body.method);
  assert.ok(kind, body.method);
  const r = run.reads.findLast((x) => x.chain === m[1] && x.route === (m[2] ? "keyed" : "plain") && x.kind === kind);
  return new Response(r.body, { status: r.status });
};
const run = async (rec) => judge(await read("https://ct-api.unrealized.trade", replay(rec)));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (chain, route, kind, f) => ({ ...A.good, reads: A.good.reads.map((x) => (x.chain === chain && x.route === route && x.kind === kind ? f(structuredClone(x)) : x)) });

test("recorded good run: eth_chainId, the finalized block and that block by hash on each chain and route: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.length, Object.keys(CHAINS).length * ROUTES.length * 3);
});

test("recorded bad run: release 146 refuses eth_chainId and eth_getBlockByHash: FAIL on every chain and route", async () => {
  const r = await run(A.bad);
  assert.equal(r.verdict, "FAIL");
  for (const c of Object.keys(CHAINS))
    for (const route of ROUTES) for (const k of ["chainId", "byHash"]) assert.ok(bad(r).some((l) => l.startsWith(`BAD [${c} ${route}] ${k}: the helper refuses it, 400`)), `${c} ${route} ${k}`);
});

test("made from the good run: another chain's id, another block by hash, a missing read: each FAIL; a 429: INCONCLUSIVE", async () => {
  const id = edit("robinhood", "keyed", "chainId", (x) => ((x.body = x.body.replace('"0x1237"', '"0x2105"')), x));
  assert.deepEqual(bad(await run(id)), ['BAD [robinhood keyed] eth_chainId is 0x1237: "0x2105"']);
  const other = edit("base", "keyed", "byHash", (x) => {
    const j = JSON.parse(x.body);
    j.result.hash = "0x" + "12".repeat(32);
    x.body = JSON.stringify(j);
    return x;
  });
  assert.equal((await run(other)).verdict, "FAIL");
  const missing = judge({ reads: A.good.reads.filter((x) => !(x.chain === "robinhood" && x.route === "keyed" && x.kind === "byHash")) });
  assert.equal(missing.verdict, "FAIL");
  assert.ok(missing.lines.includes("BAD [robinhood keyed] byHash: no read"));
  const busy = edit("base", "plain", "chainId", (x) => ((x.status = 429), (x.body = '{"error":{"code":"rate_limited"}}'), x));
  assert.equal((await run(busy)).verdict, "INCONCLUSIVE");
});
