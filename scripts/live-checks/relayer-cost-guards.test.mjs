// node --test scripts/live-checks/relayer-cost-guards.test.mjs: the live check replays recorded runs
// (relayer-cost-guards.answers.json). good: ct-api.unrealized.trade read 2026-11-07, the token minimum equal
// to the pin on FastNEAR and dRPC on both networks, mainnet withdrawals not carried, the testnet token quoted, the
// devnet pool refusing a zero-fee release and a release whose program fails in the simulation, neither signed: PASS.
// bad_cap: the same run with the testnet minimum one yocto above the pin: FAIL. bad_signed: the same run with the
// zero-fee release answered 200 with a signature: FAIL. Made from the good run: other faults, each FAIL.
// The live check reads NEAR mainnet only (card live-checks-read-mainnet-only); the recordings read NEAR testnet too and
// replay whole under WITH_TESTNET. Their mainnet half (NEAR mainnet's bounds and quote, real) with their Solana half is
// judged as the live check judges: good PASS, bad_signed FAIL. That Solana half is the devnet pool's (2S5wpE7U, read 7
// Nov): no run is recorded on a mainnet pool yet (it posts releases, so it is not re-recorded here), so as a mainnet
// answer it is MADE; the mainnet minimum one yocto over the pin is MADE from it too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, PIN, read } from "./relayer-cost-guards.mjs";
import { TOKENS } from "./relayer-withdraw-fee.mjs";
import { RENT_RPCS } from "./helper-pool-senders.mjs";

// The recorded Solana pool is the devnet one: replays read its cluster on the devnet pair; the live check reads
// mainnet alone (RENT_RPCS), card live-checks-read-mainnet-only.
const RPCS = { ...RENT_RPCS, devnet: ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"] };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "relayer-cost-guards.answers.json"), "utf8"));
/** The tokens the recordings were read with: mainnet USDC and the testnet token the check read before. */
const WITH_TESTNET = { ...TOKENS, testnet: "bf-usdc-20261101t022248.testnet" }; // gitleaks:allow (a public account id)
/** A recording's NEAR mainnet half, with its Solana half (MADE as a mainnet answer: that pool is devnet's). */
const mainnetHalf = (run) => ({ ...run, near: { mainnet: run.near.mainnet } });

test("the live check reads NEAR mainnet only: good's mainnet half PASSes, bad_signed's FAILs, made: mainnet's minimum off the pin FAILs", () => {
  assert.deepEqual(Object.keys(TOKENS), ["mainnet"]);
  const g = judge(mainnetHalf(A.good));
  assert.equal(g.ok, true, g.lines.join("\n"));
  assert.ok(!g.lines.some((l) => l.includes("testnet")));
  assert.equal(judge(mainnetHalf(A.bad_signed)).ok, false);
  const off = structuredClone(mainnetHalf(A.good));
  for (const b of off.near.mainnet.bounds) b.result = b.result.replace(/"min":"(\d+)"/, (_, m) => `"min":"${BigInt(m) + 1n}"`);
  const r = judge(off);
  assert.ok(r.lines.some((l) => l.startsWith("BAD [near mainnet] the token's minimum ")), r.lines.join("\n"));
});
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const copy = (x) => JSON.parse(JSON.stringify(x));

test("recorded good run: the quote at or under the pin, a zero-fee and a failing release refused unsigned: PASS", () => {
  const r = judge(A.good, PIN, WITH_TESTNET);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(PIN, 1_250_000_000_000_000_000_000n, "the pin this checkout's fee.ts holds");
});

test("recorded bad run: the token's minimum moved off the pin: FAIL", () => {
  const r = judge(A.bad_cap, PIN, WITH_TESTNET);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.startsWith("BAD [near testnet] the token's minimum 1250000000000000000001 equals the pinned")), bad(r).join("\n"));
});

test("recorded bad run: a zero-fee release co-signed: FAIL", () => {
  const r = judge(A.bad_signed, PIN, WITH_TESTNET);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes("zero_fee: 200")), bad(r).join("\n"));
  assert.ok(bad(r).some((l) => l.includes("zero_fee: no signature in the answer")), bad(r).join("\n"));
});

test("made from the good run: a held quote off the pin, a minimum under the pin, a failing release signed, one stopped at its blockhash, RPCs that disagree, no pool, another commit: each FAIL", () => {
  const held = copy(A.bad_cap);
  held.near.testnet.quote = { ...held.near.testnet.quote, status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };
  assert.equal(judge(held, PIN, WITH_TESTNET).ok, false, "a minimum off the pin is an alarm even while the helper holds");
  const under = copy(A.good);
  for (const b of under.near.mainnet.bounds) b.result = JSON.stringify({ min: "1", max: "1" });
  assert.equal(judge(under, PIN, WITH_TESTNET).ok, false);
  const signed = copy(A.good);
  Object.assign(signed.solana[0].posts.find((x) => x.asked === "program_fails"), { status: 200, body: JSON.stringify({ signature: "5".repeat(88) }) });
  assert.equal(judge(signed, PIN, WITH_TESTNET).ok, false);
  const stale = copy(A.good);
  Object.assign(stale.solana[0].posts.find((x) => x.asked === "program_fails"), { body: JSON.stringify({ error: { code: "simulation_failed", detail: '"BlockhashNotFound"' } }) });
  assert.equal(judge(stale, PIN, WITH_TESTNET).ok, false, "a simulation that never ran the program proves nothing about it");
  const split = copy(A.good);
  split.near.mainnet.bounds[1].result = JSON.stringify({ min: "1", max: "1" });
  assert.equal(judge(split, PIN, WITH_TESTNET).ok, false);
  const notCarried = copy(A.good);
  notCarried.near.testnet.quote = { ...notCarried.near.testnet.quote, status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };
  assert.equal(judge(notCarried, PIN, WITH_TESTNET).ok, false, "at a minimum under the pin the quote is given");
  assert.equal(judge({ ...A.good, solana: [] }, PIN, WITH_TESTNET).ok, false);
  assert.equal(judge({ ...A.good, commit: "0".repeat(40) }, PIN, WITH_TESTNET).ok, false);
  assert.equal(judge({ ...A.good, commit: A.good.near.mainnet.quote.headers["x-helper-commit"] }, PIN, WITH_TESTNET).ok, true);
});

test("read() asks mainnet USDC's quote (no testnet token) with Origin APP_HOST and posts the two releases for each pool (replayed helper, RPCs replayed)", async () => {
  const asked = [];
  const pool = A.good.solana[0].pool;
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === "ct-api.unrealized.trade") {
      assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
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
  const run = await read("https://ct-api.unrealized.trade", { fetchFn, pools: { devnet: pool, mainnet: null }, rentRpcs: RPCS });
  assert.deepEqual(asked, ["fee 172086", "blockhash", "send 0", "send 1300000"]);
  assert.deepEqual(Object.keys(run.near), ["mainnet"]);
  assert.equal(judge(run).ok, true, judge(run).lines.join("\n"));
  // the live defaults read no devnet cluster: the same devnet pool gets no blockhash read and no post, and fails
  asked.length = 0;
  const live = await read("https://ct-api.unrealized.trade", { fetchFn, pools: { devnet: pool, mainnet: null } });
  assert.deepEqual(asked, ["fee 172086"]);
  assert.equal(judge(live).ok, false);
});
