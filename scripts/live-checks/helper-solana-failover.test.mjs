// node --test scripts/live-checks/helper-solana-failover.test.mjs: the live check replays recorded answers
// (helper-solana-failover.answers.json). good: this card's helper run locally with a made-up Helius key in every Solana
// slot, its RPC slot fallen back: PASS (a fallback is a note). bad_pre_card: the deployed helper before the card, no
// solana in /v1/health: FAIL. Planted from the good one: a slot missing, a state off the list, a URL in a value: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read } from "./helper-solana-failover.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-solana-failover.answers.json"), "utf8"));
const replay = (a) => async (url, init) => {
  assert.equal(new URL(url).pathname, "/v1/health");
  assert.equal(init.headers.origin, "https://confidential.unrealized.trade");
  return new Response(a.body, { status: a.status });
};
const withSolana = (s) => ({ ...A.good, body: JSON.stringify({ ...JSON.parse(A.good.body), solana: s }) });

test("recorded good answer (a made-up key in every slot, the RPC slot fallen back): PASS, the fallback a note", async () => {
  const r = judge(await read("http://127.0.0.1:18741", replay(A.good)));
  assert.ok(r.ok, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("note rpc: fallback")));
});

test("recorded bad answer (the helper before the card, no solana in its health): FAIL", async () => {
  const r = judge(await read(undefined, replay(A.bad_pre_card)));
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("BAD solana is not an object")), r.lines.join("\n"));
});

test("planted: a slot missing, an unknown state, a URL in a value, a 503: FAIL", () => {
  const s = JSON.parse(A.good.body).solana;
  for (const [what, a] of [
    ["a slot missing", withSolana({ rpc: s.rpc, trades: s.trades, holders: s.holders })],
    ["an unknown state", withSolana({ ...s, stream: "down" })],
    ["a URL in a value", withSolana({ ...s, rpc: "https://mainnet.helius-rpc.com/?api-key=x" })],
    ["a 503", { ...A.good, status: 503 }],
  ]) assert.equal(judge(a).ok, false, what);
  assert.equal(judge(withSolana({ rpc: "public" }), ["rpc"]).ok, true, "a host that sets only the RPC slot, with --want rpc");
});
