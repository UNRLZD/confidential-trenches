// node --test scripts/live-checks/helper-usdc-pending-pause.test.mjs: the live check replays recorded runs
// (helper-usdc-pending-pause.answers.json). good: a real run on 2026-11-07, mainnet USDC on FastNEAR and dRPC at one
// final H and the deployed helper: N is the pin on both, no Pause pending: PASS. bad_pending: request 218 stored on both
// (each provider's real answer for stored request 46) while the helper reports caught up and not halted: FAIL. Made
// from them: N disagreeing, below the pin or unread, a request answer unread or stored on one provider only: each FAIL;
// a stored request while the helper holds: PASS; a stored request the archive proves expired (N above it at a block at
// least 432000 s before H) while the helper frees it: PASS, and not proven (N 218 there, or the block too recent): FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ARCHIVE, judge, nextOf, read, storedOf, trimBlock } from "./helper-usdc-pending-pause.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-usdc-pending-pause.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const withNext = (run, i, n) => {
  const r = clone(run);
  const j = JSON.parse(r.chain[i].next);
  j.result.result = [...Buffer.from(String(n))];
  r.chain[i].next = JSON.stringify(j);
  return r;
};
const withHelper = (run, f) => {
  const r = clone(run);
  r.helper.body = JSON.stringify(f(JSON.parse(r.helper.body)));
  return r;
};

/** A fetch that answers from a recorded run: each provider's block, N and request answers, and the helper's status. */
const replay = (run) => async (url, init) => {
  if (url.includes("/v1/token-status")) {
    assert.equal(init.headers.origin, "https://confidential.unrealized.trade");
    return new Response(run.helper.body, { status: run.helper.status, headers: run.helper.headers });
  }
  const body = JSON.parse(init.body);
  if (url === ARCHIVE) {
    const old = JSON.parse(run.archive.old).result.header.height;
    if (body.method === "block") return new Response(body.params.block_id === run.h ? run.archive.h : body.params.block_id === old ? run.archive.old : "{}");
    assert.equal(body.params.block_id, old, "N read at the old block");
    return new Response(run.archive.oldNext);
  }
  const c = run.chain.find((x) => x.rpc === url);
  if (body.method === "block") return new Response(JSON.stringify({ result: { header: { height: run.h } } }));
  assert.equal(body.params.block_id, run.h, "every view at H");
  const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
  if (body.params.method_name === "get_next_multisig_request_id") return new Response(c.next);
  return new Response(c.stored.find((x) => x.id === args.request_id).body);
};

test("recorded good run: N 218 on both at H, no new request: no Pause pending, PASS", async () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.pending, false);
  assert.ok(r.lines.some((l) => l.startsWith("ok  no Pause pending")));
  const again = judge(await read("https://api.example", replay(A.good)));
  assert.equal(again.ok, true, "read() over the replay judges the same");
});

test("recorded bad run: request 218 stored on both while the helper reports caught up and not halted: FAIL", async () => {
  const r = judge(A.bad_pending);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD a new request is stored, so the helper holds: caught_up true, halted false"]);
  const again = judge(await read("https://api.example", replay(A.bad_pending)));
  assert.equal(again.ok, false, "read() asks request 218 at H on both and judges the same");
});

test("a stored request while the helper holds (not caught up, or halted): PASS", () => {
  assert.equal(judge(withHelper(A.bad_pending, (b) => ({ ...b, caught_up: false, halted: null, vault_blocked: null, code_hash_ok: null }))).ok, true);
  assert.equal(judge(withHelper(A.bad_pending, (b) => ({ ...b, halted: true }))).ok, true);
});

test("made from the runs: N disagreeing, below the pin, over 16 new ids or unread; a request unread or stored on one only: FAIL", () => {
  assert.equal(judge(withNext(A.good, 1, 219)).ok, false, "N differs");
  assert.equal(judge(withNext(withNext(A.good, 0, 217), 1, 217)).ok, false, "below the pin");
  assert.equal(judge(withNext(withNext(A.good, 0, 235), 1, 235)).ok, false, "over 16 new ids");
  const unread = clone(A.good);
  unread.chain[0].next = "";
  assert.equal(judge(unread).ok, false, "N unread");
  const other = clone(A.bad_pending);
  other.chain[1].stored[0].body = A.none_answer[1].body.replace("627:87", "647:87");
  assert.equal(judge(other).ok, false, "another panic");
  const one = clone(A.bad_pending);
  one.chain[1].stored[0].body = A.none_answer[1].body;
  assert.equal(judge(one).ok, false, "stored on A only, the helper caught up");
  const gone = clone(A.bad_pending);
  gone.chain[0].stored[0].body = A.none_answer[0].body;
  gone.chain[1].stored[0].body = A.none_answer[1].body;
  assert.equal(judge(gone).ok, true, "the request removed or executed on both: no Pause pending");
  const off = clone(A.good);
  off.h += 1;
  assert.equal(judge(off).ok, false, "answers of another block");
});

test("the recorded answers parse as the watch reads them", () => {
  for (const c of A.good.chain) assert.equal(nextOf(c.next, A.good.h), 218);
  for (const c of A.bad_pending.chain) assert.equal(storedOf(c.stored[0].body, A.bad_pending.h), true);
  for (const x of A.none_answer) assert.equal(storedOf(x.body, A.bad_pending.h), false);
});

test("a stored request the archive proves expired frees the helper: PASS; N not above it there, or the old block too recent: FAIL", () => {
  const r = judge(A.bad_pending);
  assert.ok(r.lines.some((l) => l.includes("request 218: not proven expired")), "the real archive's N at the old block is 218");
  const proven = clone(A.bad_pending);
  const j = JSON.parse(proven.archive.oldNext);
  j.result.result = [...Buffer.from("219")];
  proven.archive.oldNext = JSON.stringify(j);
  const ok = judge(proven);
  assert.equal(ok.ok, true, ok.lines.join("\n"));
  assert.ok(ok.lines.some((l) => /request 218: expired \(N 219 at \d+, \d+ s before H\)/.test(l)));
  const recent = clone(proven);
  const o = JSON.parse(recent.archive.old);
  o.result.header.timestamp_nanosec = (BigInt(JSON.parse(recent.archive.h).result.header.timestamp_nanosec) - 431_999_000_000_000n).toString();
  recent.archive.old = JSON.stringify(o);
  assert.equal(judge(recent).ok, false, "less than the validity before H");
  const noArchive = clone(proven);
  delete noArchive.archive;
  assert.equal(judge(noArchive).ok, false, "no archive read: not proven");
});

test("the recorder keeps only the header fields the check reads: no approval or signature reaches a record", () => {
  const full = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { author: "v.poolv1.near", chunks: [{ signature: "sig" }], header: { height: 7, hash: "H", timestamp_nanosec: "1", approvals: ["ed25519:x", null], signature: "ed25519:y", prev_hash: "P" } } });
  assert.equal(trimBlock(full), JSON.stringify({ result: { header: { height: 7, hash: "H", timestamp_nanosec: "1" } } }));
  assert.equal(trimBlock("{"), "");
  for (const b of [A.bad_pending.archive.h, A.bad_pending.archive.old]) assert.deepEqual(Object.keys(JSON.parse(b).result.header), ["height", "hash", "timestamp_nanosec"]);
});
