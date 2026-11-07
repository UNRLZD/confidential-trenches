// node --test scripts/live-checks/rpc-keyed-lists.test.mjs: the live check replays recorded answers
// (rpc-keyed-lists.answers.json, recorded in-process until the deploy's own run is recorded: the keys are on the helper
// box only). good: this card's helper with made-up QuickNode, dRPC, FastNear and Helius URLs, every probe answering its
// chain: PASS. bad_pre_card: the helper before the card with the same URLs set, no rpc in /v1/health: FAIL. Planted
// from the good one: a company missing, two keys at one company, the order swapped, a key down or on another chain, a
// URL in an entry, a 503: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read } from "./rpc-keyed-lists.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "rpc-keyed-lists.answers.json"), "utf8"));
const replay = (a) => async (url, init) => {
  assert.equal(new URL(url).pathname, "/v1/health");
  assert.equal(init.headers.origin, "https://confidential.unrealized.trade");
  return new Response(a.body, { status: a.status });
};
const rpcOf = () => JSON.parse(A.good.body).rpc;
const withRpc = (rpc) => ({ ...A.good, body: JSON.stringify({ ...JSON.parse(A.good.body), rpc }) });

test("recorded good answer (every chain's keyed companies in order, each answering its chain): PASS", async () => {
  const r = judge(await read("http://127.0.0.1:18741", replay(A.good)));
  assert.ok(r.ok, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  near: fastnear.com answers"), r.lines.join("\n"));
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
    ["two keys at one company", withRpc({ ...g, robinhood: ["quiknode.pro answers", "quiknode.pro answers", "drpc.org answers"] })],
    ["dRPC before QuickNode", withRpc({ ...g, solana: ["helius-rpc.com answers", "drpc.org answers", "quiknode.pro answers"] })],
    ["a key down", withRpc({ ...g, base: ["quiknode.pro answers", "drpc.org down"] })],
    ["a key on another chain", withRpc({ ...g, robinhood: ["quiknode.pro wrong chain", "drpc.org answers"] })],
    ["a key not probed yet", withRpc({ ...g, near: ["fastnear.com unread"] })],
    ["a URL in an entry", withRpc({ ...g, near: ["rpc.mainnet.fastnear.com?apiKey=x answers"] })],
    ["a chain missing", withRpc({ solana: g.solana, base: g.base, robinhood: g.robinhood })],
    ["a 503", { ...A.good, status: 503 }],
  ]) assert.equal(judge(a).ok, false, what);
});
