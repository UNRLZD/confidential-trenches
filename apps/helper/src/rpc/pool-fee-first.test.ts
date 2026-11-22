// node --test apps/helper/src/rpc/pool-fee-first.test.ts (cards helper-pool-fee-first-in-the-solana-budget and
// helper-pool-fee-never-a-client-429): the pool's
// fee read (the Rent sysvar on its two providers, pool/solana.ts readRent) answers while the helper's market reads load
// the same public Solana providers. helper-24 on 47d3aa851 (live run 45022630048) answered GET /v1/pool/fee 429
// "provider limit" to five checks: the pool's providers are api.mainnet-beta.solana.com and solana-rpc.publicnode.com
// (the host's POOL_SOLANA_RPCS_MAINNET, read by host name 22 Nov 13:4xZ), the trade walks' TRADES_RPCS, and the
// container's log held 314 "rpc hold solana-public background 10 s" lines with the trades key fallen back (credits).
// At 47d3aa851 a market read a page waits on (rpc.caller, card sol-follow-round-draws-the-callers-share) was sent
// through the public endpoint's own wait named in its 429, and publicnode, which has no budget of its own, was never
// held at all: the market kept both refusing the helper's address, and the pool's reads with it.
// Planted: each provider refuses (429, Retry-After 10) while it was asked more than LIMIT times in the last second, as
// a public endpoint limits one address. Four pages' market rounds every 50 ms, each provider in turn as trades.ts rpc()
// asks them (draw, send, a 429 told to backgroundThrottled); 5 s on, the pool's rent read on the two providers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readSolanaRent, solanaJsonRpc } from "@blindfill/kit";
import { createRpc } from "./rpc.ts";

const KEYED = "https://mainnet.helius-rpc.invalid/?api-key=fake-helius-key-0123456789abcdef";
const BETA = "https://api.mainnet-beta.solana.com";
const NODE = "https://solana-rpc.publicnode.com";
const LIMIT = 10;
const CLIENTS = ["198.51.100.7", "198.51.100.8", "198.51.100.9", "198.51.100.10"];
/** The Rent sysvar's 17 bytes: 3,480 lamports a byte-year, an exemption factor of 2, burn 50. */
const RENT = (() => {
  const b = new Uint8Array(17);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, 3_480n, true);
  v.setFloat64(8, 2, true);
  b[16] = 50;
  return Buffer.from(b).toString("base64");
})();

function world() {
  let t = 1_795_000_000_000;
  const asked = new Map<string, number[]>();
  const refused = new Map<string, number>();
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = url.startsWith(BETA) ? BETA : url.startsWith(NODE) ? NODE : url;
    const a = asked.get(u) ?? [];
    a.push(t);
    while (a.length > 0 && a[0]! <= t - 1_000) a.shift();
    asked.set(u, a);
    if (a.length > LIMIT) {
      refused.set(u, (refused.get(u) ?? 0) + 1);
      return new Response("Too many requests", { status: 429, headers: { "retry-after": "10" } });
    }
    const req = JSON.parse(String(init?.body)) as { id: number; method: string };
    const result = req.method === "getAccountInfo" ? { context: { slot: 1 }, value: { owner: "Sysvar1111111111111111111111111111111111111", lamports: 1, executable: false, rentEpoch: 0, data: [RENT, "base64"] } } : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, now: () => t, step: (ms: number) => void (t += ms), refused };
}

/** The market's rounds for `ms` (4 pages every 50 ms), then the pool's rent read: its rent, or why it failed. */
async function run() {
  const w = world();
  const r = createRpc({ SOLANA_RPC_URL: KEYED }, { fetch: w.fetch as never, now: w.now, log: () => {} });
  const market = async (ms: number) => {
    for (let at = 0; at < ms; at += 50) {
      w.step(50);
      for (const client of CLIENTS)
        for (const url of [BETA, NODE]) {
          if (r.caller("solana", url, "getTransaction", client) > 0) continue;
          const a = await w.fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [] }) });
          if (a.status === 429) r.backgroundThrottled("solana", url, a.headers);
          else break;
        }
    }
  };
  await market(5_000);
  const providers = [BETA, NODE].map((u) => solanaJsonRpc(u, { fetch: w.fetch as never })) as unknown as Parameters<typeof readSolanaRent>[0];
  const rent = await readSolanaRent(providers).then(
    (x) => `rent ${x.lamportsPerByte} x${x.factor}`,
    (e: unknown) => `failed: ${e instanceof Error ? e.message : String(e)}`,
  );
  await market(2_000);
  return { rent, refused: Object.fromEntries(w.refused) };
}

test("card helper-pool-fee-first-in-the-solana-budget: with the market's reads loading the pool's two public Solana providers, the pool's rent read answers: the market waits out each provider's 429, page-waited rounds and the budgetless provider included (red at 47d3aa851: both providers refusing)", async () => {
  const got = await run();
  assert.equal(got.rent, "rent 3480 x2", `the pool's fee read under the market's load: ${got.rent}; refused ${JSON.stringify(got.refused)}`);
});

test("card helper-pool-fee-first-in-the-solana-budget: a market hold ends at the provider's named wait, and a later shorter 429 never cuts it", () => {
  const w = world();
  const r = createRpc({ SOLANA_RPC_URL: KEYED }, { fetch: w.fetch as never, now: w.now, log: () => {} });
  assert.equal(r.caller("solana", NODE, "getTransaction", CLIENTS[0]!), 0, "free before any refusal");
  r.backgroundThrottled("solana", NODE, new Headers({ "retry-after": "10" }));
  w.step(1_000);
  r.backgroundThrottled("solana", NODE, new Headers({ "retry-after": "2" }));
  assert.ok(r.background("solana", NODE, "getTransaction") > 0 && r.caller("solana", NODE, "getTransaction", CLIENTS[0]!) > 0, "held for the market");
  w.step(9_100);
  assert.equal(r.caller("solana", NODE, "getTransaction", CLIENTS[0]!), 0, "free at the first wait's end");
  r.backgroundThrottled("solana", BETA, new Headers({ "retry-after": "3" }));
  assert.ok(r.caller("solana", BETA, "getTransaction", CLIENTS[1]!) > 0, "the public endpoint's hold holds a page-waited round too");
  w.step(3_100);
  assert.equal(r.caller("solana", BETA, "getTransaction", CLIENTS[1]!), 0);
});

test("card helper-pool-fee-never-a-client-429: a 429 to the pool's own read (its URL as the host spells it, a trailing slash or none) holds the market's and the background's reads of that provider for its wait, so the pool's next read finds the window its own (red at ee5c7dac4: the market drew on, held only by its own refusals)", async () => {
  const { poolFetchAhead } = await import("../server.ts");
  const w = world();
  const r = createRpc({ SOLANA_RPC_URL: KEYED }, { fetch: w.fetch as never, now: w.now, log: () => {} });
  const refusing = async () => new Response("Too many requests", { status: 429, headers: { "retry-after": "10" } });
  const pool = poolFetchAhead(r, refusing as never);
  for (const url of [BETA, NODE]) assert.equal(r.caller("solana", url, "getTransaction", CLIENTS[0]!), 0, `${url} free before the pool's refusal`);
  for (const url of [`${BETA}/`, NODE]) assert.equal((await pool(url, { method: "POST", body: "{}" })).status, 429, "the pool's read is answered as the provider answered it");
  w.step(1_000);
  for (const url of [BETA, NODE]) assert.ok(r.background("solana", url, "getTransaction") > 0 && r.caller("solana", url, "getTransaction", CLIENTS[0]!) > 0, `${url}: the market's reads held`);
  w.step(9_100);
  for (const url of [BETA, NODE]) assert.equal(r.caller("solana", url, "getTransaction", CLIENTS[0]!), 0, `${url} free at the wait's end`);
});
