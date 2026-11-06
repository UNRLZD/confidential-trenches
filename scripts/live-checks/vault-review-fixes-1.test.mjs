// node --test scripts/live-checks/vault-review-fixes-1.test.mjs: the live check replays recorded runs
// (vault-review-fixes-1.answers.json). good: the deployed helper on 2026-11-06, mainnet answering 404 (no relayer quoted
// there yet) and testnet quoting f-2b700409.bf-vt-20261102t071444.testnet, registered on the testnet token and not
// blocklisted on FastNEAR and dRPC: PASS. bad: a stand-in helper quoting a fee account never registered, every RPC
// answer the real testnet's: FAIL. Each block answer is recorded as its header's height and hash, the two fields
// the check reads (vault-review-fixes-1.mjs recordedText). Made from the good run: the fee account blocklisted, the RPCs' bytes apart, a view
// answered at another block, the quote not naming a fee_recipient, a 503, and no network quoted: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check } from "./vault-review-fixes-1.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "vault-review-fixes-1.answers.json"), "utf8"));

// each request gets its recorded answer, by url and (for an RPC) its method and params; one never made is an error
function replay(answers) {
  const key = (url, m, req) => `${url} ${m} ${req ? JSON.stringify([req.method, req.params]) : ""}`;
  const full = (a) => (a.asked ? `${a.url}?token=${encodeURIComponent(a.asked)}` : a.url);
  const by = new Map(answers.map((a) => [key(full(a), a.method, a.request), a]));
  return async (url, init) => {
    const a = by.get(key(url, init.method, init.method === "POST" ? JSON.parse(init.body) : null));
    if (!a) throw new Error(`no recorded answer for ${init.method} ${url} ${init.body ?? ""}`);
    return new Response(a.text, { status: a.status });
  };
}
const run = (rec, edit = (x) => x) => check({ base: rec.base, fetchFn: replay(rec.answers.map((a) => edit(structuredClone(a)))) });
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const view = (a, m) => a.request?.method === "query" && a.request.params.method_name === m;
const withResult = (a, v) => {
  const j = JSON.parse(a.text);
  j.result.result = [...Buffer.from(JSON.stringify(v))];
  return { ...a, text: JSON.stringify(j) };
};

test("recorded good run: the deployed helper's testnet fee account registered and not blocklisted on both RPCs, mainnet not quoted: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("na  [mainnet]")));
  assert.equal(r.lines.filter((l) => l.startsWith("ok  [testnet]")).length, 2);
});

test("recorded bad run: a fee account never registered on the token: FAIL", async () => {
  const r = await run(A.bad_unregistered);
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r).map((l) => l.replace(/block \d+/, "block H")), ["BAD [testnet] storage_balance_of(f-unregistered.bf-vt-20261102t071444.testnet) on bf-usdc-20261101t022248.testnet at block H: null on both RPCs: not registered, the token refuses its fee"]);
});

test("made from the good run: blocklisted, bytes apart, another block, no fee_recipient, a 503, nothing quoted: each FAIL", async () => {
  const listed = await run(A.good, (a) => (view(a, "is_blocklisted") ? withResult(a, true) : a));
  assert.equal(listed.ok, false);
  assert.ok(bads(listed).some((l) => l.includes("is_blocklisted(") && l.endsWith("true on both RPCs: the token refuses its fee")), listed.lines.join("\n"));
  const apart = await run(A.good, (a) => (view(a, "storage_balance_of") && a.url.includes("drpc") ? withResult(a, null) : a));
  assert.ok(bads(apart).some((l) => l.endsWith("storage_balance_of: the RPCs' bytes differ")), apart.lines.join("\n"));
  const other = await run(A.good, (a) => {
    if (!view(a, "is_blocklisted") || !a.url.includes("fastnear")) return a;
    const j = JSON.parse(a.text);
    j.result.block_height -= 1;
    return { ...a, text: JSON.stringify(j) };
  });
  assert.ok(bads(other).some((l) => l.includes("is_blocklisted: not answered at block")), other.lines.join("\n"));
  const nameless = await run(A.good, (a) => (a.method === "GET" && a.status === 200 ? { ...a, text: JSON.stringify({ ...JSON.parse(a.text), fee_recipient: undefined }) } : a));
  assert.ok(bads(nameless).some((l) => l.startsWith("BAD [testnet] GET /v1/withdraw/fee answers 200")), nameless.lines.join("\n"));
  const down = await run(A.good, (a) => (a.method === "GET" && a.status === 200 ? { ...a, status: 503, text: '{"error":{"code":"upstream"}}' } : a));
  assert.equal(down.ok, false);
  assert.ok(bads(down).some((l) => l.startsWith("BAD [testnet] GET /v1/withdraw/fee answers 503")));
  const none = await run(A.good, (a) => (a.method === "GET" ? { ...a, status: 404, text: '{"error":{"code":"not_found"}}' } : a));
  assert.equal(none.ok, false);
  assert.deepEqual(bads(none), ["BAD no network quoted a relayer: no fee account read"]);
  for (const r of [listed, apart, other, nameless, down]) assert.equal(r.ok, false);
});
