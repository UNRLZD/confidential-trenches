// node --test scripts/live-checks/relayer-cost-guards.test.mjs: the live check replays recorded runs
// (relayer-cost-guards.answers.json). good: api.confidential.unrealized.trade read 2026-11-07, the token minimum equal
// to the pin on FastNEAR and dRPC on both networks, mainnet withdrawals not carried, the testnet token quoted, the
// devnet pool refusing a zero-fee release and a release whose program fails in the simulation, neither signed: PASS.
// bad_cap: the same run with the testnet minimum one yocto above the pin: FAIL. bad_signed: the same run with the
// zero-fee release answered 200 with a signature: FAIL. Made from the good run: other faults, each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, PIN, read } from "./relayer-cost-guards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "relayer-cost-guards.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const copy = (x) => JSON.parse(JSON.stringify(x));

test("recorded good run: the quote at or under the pin, a zero-fee and a failing release refused unsigned: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(PIN, 1_250_000_000_000_000_000_000n, "the pin this checkout's fee.ts holds");
});

test("recorded bad run: the token's minimum moved off the pin: FAIL", () => {
  const r = judge(A.bad_cap);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.startsWith("BAD [near testnet] the token's minimum 1250000000000000000001 equals the pinned")), bad(r).join("\n"));
});

test("recorded bad run: a zero-fee release co-signed: FAIL", () => {
  const r = judge(A.bad_signed);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes("zero_fee: 200")), bad(r).join("\n"));
  assert.ok(bad(r).some((l) => l.includes("zero_fee: no signature in the answer")), bad(r).join("\n"));
});

test("made from the good run: a held quote off the pin, a minimum under the pin, a failing release signed, one stopped at its blockhash, RPCs that disagree, no pool, another commit: each FAIL", () => {
  const held = copy(A.bad_cap);
  held.near.testnet.quote = { ...held.near.testnet.quote, status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };
  assert.equal(judge(held).ok, false, "a minimum off the pin is an alarm even while the helper holds");
  const under = copy(A.good);
  for (const b of under.near.mainnet.bounds) b.result = JSON.stringify({ min: "1", max: "1" });
  assert.equal(judge(under).ok, false);
  const signed = copy(A.good);
  Object.assign(signed.solana[0].posts.find((x) => x.asked === "program_fails"), { status: 200, body: JSON.stringify({ signature: "5".repeat(88) }) });
  assert.equal(judge(signed).ok, false);
  const stale = copy(A.good);
  Object.assign(stale.solana[0].posts.find((x) => x.asked === "program_fails"), { body: JSON.stringify({ error: { code: "simulation_failed", detail: '"BlockhashNotFound"' } }) });
  assert.equal(judge(stale).ok, false, "a simulation that never ran the program proves nothing about it");
  const split = copy(A.good);
  split.near.mainnet.bounds[1].result = JSON.stringify({ min: "1", max: "1" });
  assert.equal(judge(split).ok, false);
  const notCarried = copy(A.good);
  notCarried.near.testnet.quote = { ...notCarried.near.testnet.quote, status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };
  assert.equal(judge(notCarried).ok, false, "at a minimum under the pin the quote is given");
  assert.equal(judge({ ...A.good, solana: [] }).ok, false);
  assert.equal(judge({ ...A.good, commit: "0".repeat(40) }).ok, false);
  assert.equal(judge({ ...A.good, commit: A.good.near.mainnet.quote.headers["x-helper-commit"] }).ok, true);
});

test("read() asks both quotes with Origin APP_HOST and posts the two releases for each pool (replayed helper, RPCs replayed)", async () => {
  const asked = [];
  const pool = A.good.solana[0].pool;
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === "api.confidential.unrealized.trade") {
      assert.equal(init.headers.origin, "https://confidential.unrealized.trade");
      if (u.pathname === "/v1/withdraw/fee") {
        asked.push(`fee ${u.searchParams.get("token").slice(0, 6)}`);
        const n = u.searchParams.get("token").endsWith(".testnet") ? "testnet" : "mainnet";
        return new Response(A.good.near[n].quote.body, { status: A.good.near[n].quote.status, headers: A.good.near[n].quote.headers });
      }
      if (u.pathname === "/v1/pool/fee") return new Response(A.good.solana[0].fee.body, { status: 200, headers: A.good.solana[0].fee.headers });
      const tx = Buffer.from(JSON.parse(init.body).tx, "base64");
      // relay_fee starts 1 + 16 + 4 x 8 bytes from the end (the byte helper-pool-senders plant's "changed" flips): 0 for zero_fee
      const fee = tx.readBigUInt64LE(tx.length - 1 - 16 - 8 * 4);
      asked.push(`send ${fee}`);
      const p = A.good.solana[0].posts.find((x) => x.asked === (fee === 0n ? "zero_fee" : "program_fails"));
      return new Response(p.body, { status: p.status, headers: p.headers });
    }
    const body = JSON.parse(init.body);
    if (body.method === "getLatestBlockhash") {
      asked.push("blockhash");
      return Response.json({ result: { value: { blockhash: "8kUmvtLLTpCgZswtbccUeDq4PmgQ4p5W68WudkpkgTUe", lastValidBlockHeight: 1 } } });
    }
    const n = url.includes("test") ? "testnet" : "mainnet";
    const b = A.good.near[n].bounds[0];
    if (body.method === "block") return Response.json({ result: { header: { height: b.block_height } } });
    return Response.json({ result: { block_height: b.block_height, block_hash: b.block_hash, result: [...Buffer.from(b.result)] } });
  };
  const run = await read("https://api.confidential.unrealized.trade", { fetchFn, pools: { devnet: pool, mainnet: null } });
  assert.deepEqual(asked, ["fee 172086", "fee bf-usd", "blockhash", "send 0", "send 1300000"]);
  assert.equal(judge(run).ok, true, judge(run).lines.join("\n"));
});
