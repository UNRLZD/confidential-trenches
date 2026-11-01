// node --test scripts/live-checks/helper-rpc-proxy.test.mjs: the live check replays recorded runs
// (helper-rpc-proxy.answers.json). good: apps/helper at 0c8f86c run on the owner's Mac against the public providers:
// PASS. bad_open: the same source with the allowlist check removed (a planted open RPC), so every unlisted method
// reached its provider: FAIL. bad_base: main ba6dc21, before this card, with no /v1/rpc route: FAIL. Made from the good
// run: a listed read answered with a JSON-RPC error, an answer for another id, a CORS echo of "*", a missing read: each
// FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CASES, judge, read } from "./helper-rpc-proxy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-rpc-proxy.answers.json"), "utf8"));

// a fetch that answers each call with the recorded read for it, after checking the check asked the right thing
const replay = (run) => async (url, init) => {
  const chain = url.match(/\/v1\/rpc\/([a-z]+)$/)?.[1];
  const body = JSON.parse(init.body);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.origin, "https://confidential.unrealized.trade");
  assert.equal(init.headers["content-type"], "application/json");
  const c = CASES.find((x) => x.chain === chain);
  const kind = body.method === c.listed.method ? "listed" : "unlisted";
  if (kind === "unlisted") assert.equal(body.method, c.unlisted);
  const r = run.reads.find((x) => x.chain === chain && x.kind === kind);
  assert.equal(body.id, r.id);
  return new Response(r.body, { status: r.status, headers: r.headers });
};
const run = async (rec) => judge(await read("https://api.confidential.unrealized.trade", replay(rec)));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good run: each chain's listed read answered, each unlisted method refused 400: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 28);
  assert.ok(r.lines.includes('ok  [near EXPERIMENTAL_changes] refused 400 method_not_allowed: 400 {"error":{"code":"method_not_allowed"}}'));
});

test("recorded bad run: an open RPC that forwards unlisted methods: FAIL, on each chain's unlisted method", async () => {
  const r = await run(A.bad_open);
  assert.equal(r.ok, false);
  assert.deepEqual(
    bad(r).map((l) => l.slice(0, l.indexOf("]") + 1)),
    ["BAD [solana getProgramAccounts]", "BAD [base debug_traceTransaction]", "BAD [robinhood eth_accounts]", "BAD [near EXPERIMENTAL_changes]"],
  );
});

test("recorded bad run: a helper with no /v1/rpc route (main before this card): FAIL", async () => {
  const r = await run(A.bad_base);
  assert.equal(r.ok, false);
  assert.ok(bad(r).includes("BAD [solana getBlockHeight] answers 404"));
});

test("made from the good run: a JSON-RPC error, another id, a * origin, a missing read: each FAIL", async () => {
  const edit = (chain, kind, f) => ({ ...A.good, reads: A.good.reads.map((x) => (x.chain === chain && x.kind === kind ? f(structuredClone(x)) : x)) });
  const err = edit("base", "listed", (x) => ((x.body = JSON.stringify({ jsonrpc: "2.0", id: x.id, error: { code: -32601, message: "x" } })), x));
  assert.equal((await run(err)).ok, false);
  const id = edit("solana", "listed", (x) => ((x.body = JSON.stringify({ ...JSON.parse(x.body), id: 99 })), x));
  assert.equal((await run(id)).ok, false);
  const star = edit("near", "unlisted", (x) => ((x.headers["access-control-allow-origin"] = "*"), x));
  assert.equal((await run(star)).ok, false);
  const missing = judge({ reads: A.good.reads.filter((x) => !(x.chain === "robinhood" && x.kind === "unlisted")) });
  assert.equal(missing.ok, false);
  assert.ok(missing.lines.includes("BAD [robinhood eth_accounts] no read"));
});
