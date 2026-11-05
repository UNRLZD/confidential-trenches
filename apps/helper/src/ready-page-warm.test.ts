// node --test apps/helper/src/ready-page-warm.test.ts (card helper-ready-page-warm): a new helper turns ready only once
// one warm-up read has answered on each upstream a cold token page uses: Jupiter's search, and both Solana RPC operators
// (the configured provider and, when it is keyed, the public endpoint its reads fall back to). Helper live run
// 42078439435 (787f2a4, 17:50Z): the first run of helper-token-page-cold after the deploy read p95 1672 ms, max 2784 ms,
// n=32; its rerun passed.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as server from "./server.ts";
import * as rpcMod from "./rpc/rpc.ts";
import * as tokenMod from "./data/solana/token.ts";

// read off the modules, so this file loads at a base without the new parts and each test fails on the behaviour
const S = server as unknown as Record<string, any>;
const R = rpcMod as unknown as Record<string, any>;
const T = tokenMod as unknown as Record<string, any>;

const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body), asOfMs: 1 });
const MINT = "4Tdj8MDuQ7Nx1drP1fkf1H4FVvUDrgZ3kbgQpHWXpump";

test("card helper-ready-page-warm: ready stays false until the Solana RPC operators' and Jupiter search's warm-up reads answer (red at 787f2a4: ready with neither asked)", async () => {
  const asked: string[] = [];
  const parts = (rpcWarm: boolean, searchWarm: boolean) => ({
    lists: { get: async () => ok({ lists: { new: [{ token: MINT }] } }) },
    evmLists: { base: { get: async () => ok({}) }, robinhood: { get: async () => ok({}) } },
    token: { page: async () => ok({}), holders: async () => ok({}), warmSearch: async () => (asked.push("search"), searchWarm) },
    rpc: { warm: async () => (asked.push("rpc"), rpcWarm) },
  });
  assert.equal(await S.isReady(parts(false, true)), false, "a Solana RPC operator not answered yet");
  assert.equal(await S.isReady(parts(true, false)), false, "Jupiter's search not answered yet");
  asked.length = 0;
  assert.equal(await S.isReady(parts(true, true)), true);
  assert.deepEqual(asked.sort(), ["rpc", "search"], "each warm-up read asked");
});

test("card helper-ready-page-warm: rpc.warm reads both Solana operators once, the keyed provider and the public endpoint, and is true only once both answer (red at 787f2a4: no warm)", async () => {
  const KEYED = "https://solana.keyed.example/ct-proof-0123456789abcdef";
  let publicUp = false;
  const sent: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push(url);
    const id = (JSON.parse(String(init.body)) as { id: number }).id;
    if (url === R.SOLANA_PUBLIC && !publicUp) return new Response("bad gateway", { status: 502 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const rpc = R.createRpc({ SOLANA_RPC_URL: KEYED }, { fetch, log: () => undefined });
  assert.equal(typeof rpc.warm, "function", "rpc.warm");
  assert.equal(await rpc.warm(), false, "the public endpoint has not answered");
  assert.deepEqual([...new Set(sent)].sort(), [KEYED, R.SOLANA_PUBLIC].sort(), "both operators asked");
  publicUp = true;
  sent.length = 0;
  assert.equal(await rpc.warm(), true);
  assert.deepEqual(sent.sort(), [KEYED, R.SOLANA_PUBLIC].sort(), "one read each");

  // one operator only (no key set): its one read is the warm-up
  const one: string[] = [];
  const pub = R.createRpc({}, { fetch: async (u: string, i: RequestInit) => (one.push(u), fetch(u, i)), log: () => undefined });
  assert.equal(await pub.warm(), true);
  assert.deepEqual(one, [R.SOLANA_PUBLIC]);
});

test("card helper-ready-page-warm: token.warmSearch sends one Jupiter search as a caller's cold page does, true once Jupiter answers (red at 787f2a4: no warmSearch)", async () => {
  let up = false;
  const searched: string[] = [];
  const proxy = {
    handle: async (vendor: string, path: string, query: string) => {
      searched.push(`${vendor} ${path} ${query.slice(0, 6)}`);
      return up ? { status: 200, headers: {}, body: "[]" } : { status: 503, headers: {}, body: "{}" };
    },
  };
  const rpc = { handle: async () => ({ status: 503, body: "{}" }) };
  let t = 1_000_000;
  const token = T.createSolanaToken(proxy, rpc, { now: () => t });
  assert.equal(typeof token.warmSearch, "function", "token.warmSearch");
  assert.equal(await token.warmSearch(), false, "Jupiter down");
  t += T.JUP_GAP_MS; // a failed search's next waits JUP_GAP_MS from it
  up = true;
  assert.equal(await token.warmSearch(), true);
  assert.deepEqual(searched, ["jupiter /tokens/v2/search query=", "jupiter /tokens/v2/search query="]);
});
