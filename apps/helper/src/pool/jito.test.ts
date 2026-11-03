// node --test apps/helper/src/pool/jito.test.ts: the bundle-only sender's answers from a block engine, each hostile
// input bounded (M362 (4)). The sender's use of it is in solana-attacks.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jitoSender, SOLANA_JITO_BLOCK_ENGINES, SOLANA_JITO_TIP_MIN } from "./jito.ts";

const SIG = "5".repeat(88);
const answer = (body: string, status = 200) => async () => new Response(body, { status });

test("the block engines are Jito's nine mainnet regions, each bundle-only; the least tip is 1,000 lamports", () => {
  assert.equal(SOLANA_JITO_BLOCK_ENGINES.length, 9);
  assert.equal(new Set(SOLANA_JITO_BLOCK_ENGINES).size, 9);
  for (const r of SOLANA_JITO_BLOCK_ENGINES) {
    const u = new URL(r);
    assert.equal(u.protocol, "https:");
    assert.match(u.host, /^([a-z]+\.)?mainnet\.block-engine\.jito\.wtf$/);
    assert.equal(u.pathname, "/api/v1/transactions");
    assert.equal(u.search, "?bundleOnly=true");
  }
  assert.ok(Object.isFrozen(SOLANA_JITO_BLOCK_ENGINES));
  assert.equal(SOLANA_JITO_TIP_MIN, 1_000n);
});

test("an answer that is not this transaction's signature, not JSON, or a 4xx is a refusal that ends the try", async () => {
  let n = 0;
  const count = (f: () => Promise<Response>) => async () => (n++, f());
  for (const [f, what] of [
    [answer(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "another" })), "another signature"],
    [answer("<html>"), "not JSON"],
    [answer(JSON.stringify({ jsonrpc: "2.0", id: 1, result: SIG }), 403), "a 403"],
  ] as const) {
    n = 0;
    const r = await jitoSender({ fetch: count(f) }).send("AA==", SIG);
    assert.equal(r.kind, "refused", what);
    assert.equal(n, 1, `${what}: one region asked`);
  }
});

test("an answer over 16 KB, a timeout or a 5xx is a transport failure: every region is tried, then transport", async () => {
  let n = 0;
  const big = async () => (n++, new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: SIG, pad: "x".repeat(20_000) })));
  assert.equal((await jitoSender({ fetch: big }).send("AA==", SIG)).kind, "transport");
  assert.equal(n, 9);
  const slow = (_u: string, init: RequestInit) => new Promise<Response>((_, no) => init.signal!.addEventListener("abort", () => no(new Error("timeout"))));
  const t0 = Date.now();
  assert.equal((await jitoSender({ fetch: slow, timeoutMs: 20 }).send("AA==", SIG)).kind, "transport");
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal((await jitoSender({ fetch: answer("", 502) }).send("AA==", SIG)).kind, "transport");
});

test("the request: POST sendTransaction, base64, no redirect followed", async () => {
  const seen: RequestInit[] = [];
  await jitoSender({ fetch: async (_u, init) => (seen.push(init), new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: SIG }))) }).send("AQID", SIG);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.redirect, "error");
  assert.deepEqual(JSON.parse(String(seen[0]!.body)), { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["AQID", { encoding: "base64" }] });
});
