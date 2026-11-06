// node --test scripts/live-checks/pool-buy-send-fast.test.mjs: the live check replays recorded runs
// (pool-buy-send-fast.answers.json). good_local: apps/helper at this card run on a Mac: PASS. bad_deployed: HELPER_HOST
// before this card, with no /v1/rpc/solana-devnet route and the pool path's reads refused: FAIL. bad_open_scan: this
// card's helper with no devnet pool pinned, refusing the restore's scan: FAIL. Made from the good run: a devnet
// route that throttles like the public endpoint it replaces (1 request a second: every other read 429), one that reads
// mainnet (no devnet pool), a pool read refused 400, the open scan forwarded, a slow median, a missing read, a CORS echo
// of "*": each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BASE, judge, PACE_P50_MS, POOL_READS, read, SIGN } from "./pool-buy-send-fast.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "pool-buy-send-fast.answers.json"), "utf8"));

// a fetch that answers each call with the recorded read for it, after checking the check asked the right thing
const replay = (run) => async (url, init) => {
  const route = url.match(/\/v1\/rpc\/([a-z-]+)$/)?.[1];
  const body = JSON.parse(init.body);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.origin, SIGN);
  assert.equal(init.headers["content-type"], "application/json");
  const r = run.reads.find((x) => x.route === route && x.id === body.id);
  assert.ok(r, `a recorded read for ${route} id ${body.id}`);
  assert.equal(body.method, r.method);
  return new Response(r.body, { status: r.status, headers: r.headers });
};
const run = async (rec) => judge(await read(BASE, replay(rec)));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (rec, f) => ({ ...rec, reads: rec.reads.map((x, i) => f(x, i) ?? x) });

test("recorded good run: the devnet route reads the devnet pool, forwards the pool path's reads on both routes, paces under 1 s: PASS", async () => {
  const r = await run(A.good_local);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 3 + 2 * POOL_READS.length * 3 + 3 + 4);
});

test("recorded bad run: HELPER_HOST before this card (no devnet route, the pool reads refused 400): FAIL", async () => {
  const r = await run(A.bad_deployed);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.ok(b.some((l) => l.startsWith("BAD [solana-devnet getAccountInfo]")), b.join("\n"));
  assert.ok(b.some((l) => l.startsWith("BAD [solana getSlot] forwarded: 400")), b.join("\n"));
  assert.ok(b.some((l) => l.startsWith("BAD [solana getBlockTime] forwarded: 400")), b.join("\n"));
  assert.ok(b.some((l) => l.startsWith("BAD [solana-devnet pace] every read a slot")), b.join("\n"));
});

test("recorded bad run: this card's helper with no devnet pool pinned, the restore's scan refused 400: FAIL", async () => {
  const r = await run(A.bad_unpinned);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.ok(b[0]?.startsWith("BAD [solana-devnet restore scan] forwarded, a list of the pool's marks: 400"), b.join("\n"));
  assert.equal(b.length, 1, b.join("\n"));
});

test("made from the good run: a 1-request-a-second provider, a mainnet read, a refused read, a slow median, a missing read, a CORS *: each FAIL", () => {
  const g = A.good_local;
  // every other pace read answered 429 by the provider, as the public devnet endpoint did on 5 Nov
  const throttled = edit(g, (x) => (x.kind === "pace" && x.id % 2 === 0 ? { ...x, status: 429, body: '{"error":{"code":"rate_limited"}}' } : undefined));
  assert.equal(judge(throttled).ok, false);
  assert.ok(bad(judge(throttled)).some((l) => l.includes("no 429")));
  // the route reads mainnet: no devnet pool account
  const mainnet = edit(g, (x) => (x.kind === "owner" ? { ...x, body: JSON.stringify({ jsonrpc: "2.0", id: x.id, result: { context: { slot: 1 }, value: null } }) } : undefined));
  assert.equal(judge(mainnet).ok, false);
  for (const { method, refused: open } of POOL_READS)
    for (const route of ["solana", "solana-devnet"]) {
      // a read the pool path needs refused, or the open scan forwarded (review L-2): each FAIL
      const flipped = edit(g, (x) =>
        x.route === route && x.kind === "pool" && x.method === method
          ? open
            ? { ...x, status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: x.id, result: [] }) }
            : { ...x, status: 400, body: '{"error":{"code":"method_not_allowed"}}' }
          : undefined,
      );
      assert.equal(judge(flipped).ok, false, `${route} ${method} ${open ? "forwarded" : "refused"}`);
      assert.equal(judge({ ...g, reads: g.reads.filter((x) => !(x.route === route && x.kind === "pool" && x.method === method)) }).ok, false, `${route} ${method} missing`);
    }
  // the restore's scan refused, answered with no list, or missing (review L-2 re-review): each FAIL
  for (const body of ['{"error":{"code":"method_not_allowed"}}', JSON.stringify({ jsonrpc: "2.0", id: 0, result: { context: { slot: 1 }, value: null } })]) {
    const off = edit(g, (x) => (x.kind === "restore" ? { ...x, status: body.includes("error") ? 400 : 200, body: body.replace('"id":0', `"id":${x.id}`) } : undefined));
    assert.equal(judge(off).ok, false, body);
  }
  assert.equal(judge({ ...g, reads: g.reads.filter((x) => x.kind !== "restore") }).ok, false, "the restore's scan missing");
  const slow = edit(g, (x) => (x.kind === "pace" ? { ...x, ms: PACE_P50_MS + 1 } : undefined));
  assert.equal(judge(slow).ok, false);
  assert.equal(judge({ ...g, reads: g.reads.filter((x) => x.kind !== "pace" || x.id !== 2) }).ok, false, "a pace read missing");
  const star = edit(g, (x, i) => (i === 8 ? { ...x, headers: { ...x.headers, "access-control-allow-origin": "*" } } : undefined));
  assert.equal(judge(star).ok, false);
  const noCommit = edit(g, (x, i) => (i === 0 ? { ...x, headers: { ...x.headers, "x-helper-commit": "dev" } } : undefined));
  assert.equal(judge(noCommit).ok, false);
});
