// node --test scripts/live-checks/rpc-keyed-lists.test.mjs: the live check replays recorded answers
// (rpc-keyed-lists.answers.json; the keys are on the helper box only). good: this card's helper in-process with made-up
// QuickNode, three dRPC keys, FastNear and Helius URLs and a keyless NEAR_RPC_URL at FastNear, every probe answering its
// chain, Solana on Helius and QuickNode (dRPC's free plan serves no Solana): PASS. deploy: the deployed helper after the
// owner's keys, recorded with --record: PASS. bad_pre_card: the helper before the card with the same URLs set, no rpc in
// /v1/health: FAIL. Planted
// from the good one: a company missing, two keys at one company, the order swapped, a key down or on another chain, a
// URL in an entry, a 503: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as check from "./rpc-keyed-lists.mjs";
// read off the module, so this file loads at a commit without `run` and its tests fail on the behaviour (red runs)
const { judge, read } = check;
const run = check.run ?? (async () => assert.fail("no re-read at this commit"));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "rpc-keyed-lists.answers.json"), "utf8"));
const replay = (a) => async (url, init) => {
  assert.equal(new URL(url).pathname, "/v1/health");
  assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
  return new Response(a.body, { status: a.status });
};
const rpcOf = () => JSON.parse(A.good.body).rpc;
const withRpc = (rpc) => ({ ...A.good, body: JSON.stringify({ ...JSON.parse(A.good.body), rpc }) });

test("recorded good answer (every chain's keyed companies in order, each answering its chain): PASS", async () => {
  const r = judge(await read("http://127.0.0.1:18741", replay(A.good)));
  assert.ok(r.ok, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  near: fastnear.com answers"), r.lines.join("\n"));
});

test("recorded deploy answer (af75100a after the owner's keys: Solana on Helius and QuickNode, Base and Robinhood on QuickNode and dRPC's three keys, NEAR on FastNear): PASS", async () => {
  const r = judge(await read("https://ct-api.unrealized.trade", replay(A.deploy)));
  assert.ok(r.ok, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  solana: in the order helius-rpc.com, quiknode.pro"), r.lines.join("\n"));
});

test("recorded bad answer (the helper before the card, no rpc in its health): FAIL", async () => {
  const r = judge(await read(undefined, replay(A.bad_pre_card)));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD rpc is not an object"), r.lines.join("\n"));
});

test("planted: a company missing, two keys at one company, the order swapped, a key down or on another chain, a URL in an entry, a chain missing, a 503: FAIL", () => {
  const g = rpcOf();
  for (const [what, a] of [
    ["dRPC missing on Base", withRpc({ ...g, base: ["quiknode.pro answers"] })],
    ["dRPC's key 3 missing on Base", withRpc({ ...g, base: g.base.slice(0, 3) })],
    ["two keys at one company", withRpc({ ...g, robinhood: ["quiknode.pro answers", "quiknode.pro answers", ...g.robinhood.slice(1)] })],
    ["one dRPC key twice", withRpc({ ...g, base: ["quiknode.pro answers", "drpc.live key1 answers", "drpc.live key1 answers", "drpc.live key3 answers"] })],
    ["dRPC before QuickNode", withRpc({ ...g, base: [...g.base.slice(1, 2), g.base[0], ...g.base.slice(2)] })],
    ["Helius missing on Solana", withRpc({ ...g, solana: ["quiknode.pro answers"] })],
    ["QuickNode before Helius on Solana", withRpc({ ...g, solana: ["quiknode.pro answers", "helius-rpc.com answers"] })],
    ["a key down", withRpc({ ...g, base: [...g.base.slice(0, 3), "drpc.live key3 down"] })],
    ["a key on another chain", withRpc({ ...g, robinhood: ["quiknode.pro wrong chain", ...g.robinhood.slice(1)] })],
    ["a key not probed yet", withRpc({ ...g, near: ["fastnear.com unread"] })],
    ["a URL in an entry", withRpc({ ...g, near: ["rpc.mainnet.fastnear.com?apiKey=x answers"] })],
    ["a chain missing", withRpc({ solana: g.solana, base: g.base, robinhood: g.robinhood })],
    ["a 503", { ...A.good, status: 503 }],
  ]) assert.equal(judge(a).ok, false, what);
});

test("review M3: one key per company counts keyed entries only: FastNear's keyless public endpoint beside its key passes, a second FastNear key fails", () => {
  const g = rpcOf();
  assert.deepEqual(g.near, ["fastnear.com answers", "fastnear.com keyless answers"], "the recorded good answer holds the keyless case");
  assert.ok(judge(withRpc({ ...g, near: ["fastnear.com answers", "fastnear.com keyless answers", "lava.build keyless answers"] })).ok);
  const two = judge(withRpc({ ...g, near: ["fastnear.com answers", "fastnear.com answers"] }));
  assert.equal(two.ok, false);
  assert.ok(two.lines.includes("BAD near: one key per keyed provider (fastnear.com, fastnear.com)"), two.lines.join("\n"));
  // a keyless entry never stands in for the keyed one WANT names
  assert.equal(judge(withRpc({ ...g, near: ["fastnear.com keyless answers"] })).ok, false);
});

test("review L6: a run that fails only on a URL's state reads the health again: a passing 429 clears and the run passes; one still held after 3 min fails; any other failure fails at once", async () => {
  const g = rpcOf();
  const held = withRpc({ ...g, base: ["quiknode.pro held", ...g.base.slice(1)] });
  const naps = [];
  const sleep = async (ms) => void naps.push(ms);
  const seq = (answers) => { let i = 0; return async () => answers[Math.min(i++, answers.length - 1)]; };
  const cleared = await run(seq([held, held, A.good]), sleep);
  assert.ok(cleared.ok, cleared.lines.join("\n"));
  assert.deepEqual(naps, [30_000, 30_000]);
  naps.length = 0;
  const stuck = await run(seq([held]), sleep);
  assert.equal(stuck.ok, false);
  assert.equal(naps.length, 6, "re-read for 3 min, then FAIL");
  naps.length = 0;
  const other = await run(seq([A.bad_pre_card, A.good]), sleep);
  assert.equal(other.ok, false);
  assert.deepEqual(naps, [], "a shape failure is not waited on");
});
