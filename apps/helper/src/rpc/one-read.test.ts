// node --test apps/helper/src/rpc/one-read.test.ts (card helper-rpc-one-read-many-pages): a crowd of pages reading the
// SOL price on the helper's keyed Solana route costs one upstream read a slot, not one a page. The signing page reads
// Pyth's SOL/USD account (the kit's POOL_USD_FEEDS.solana) with getMultipleAccounts at confirmed, every 3 s near the
// feed's write (packages/signpage/src/pool-price.ts POOL_PRICE_WRITE_POLL_MS), and every shown page polls in the same
// seconds: the price fix's review counted 2.5 429s a minute for 3 pages behind one address against the route's
// default budgets. Here: 200 pages on 67 addresses (3 a household), each reading the price every 3 s within the same
// 300 ms, for a minute, on virtual time, against a keyed provider in memory that answers in 120 ms and keeps 50
// requests a second. The route's budgets are its defaults (RPC_BUDGETS solana).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { POOL_USD_FEEDS } from "@blindfill/kit";
import { onVirtualTime } from "../../test/evm-swaps/virtual-time.ts";
import { createRpc, SHARED_ACCOUNTS, SHARED_HOLD_MS } from "./rpc.ts";

const KEY = "fake-helius-key-0123456789abcdef";
const URL_KEYED = `https://mainnet.helius-rpc.invalid/?api-key=${KEY}`;
const JSON_T = "application/json";
const PYTH = POOL_USD_FEEDS.solana.account;
/** A one-time account of a user's (any address the route holds no word for). */
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const config = { encoding: "base64", commitment: "confirmed" };
const priceRead = (id: number | string, account = PYTH, method = "getMultipleAccounts") =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params: [method === "getMultipleAccounts" ? [account] : account, config] });

/** A keyed provider in memory: answers in `lateMs`, 429 past `perSecond` requests in any 1 s. Each answer carries the
 *  slot it was read at, one a 400 ms slot on the clock. */
function provider(perSecond: number, lateMs: number) {
  const p = { calls: 0, throttled: 0, sent: [] as number[], bodies: [] as string[] };
  const fetch = async (_u: string, init: RequestInit): Promise<Response> => {
    const t = Date.now();
    p.sent = p.sent.filter((x) => x > t - 1000);
    p.sent.push(t);
    p.calls++;
    p.bodies.push(String(init.body));
    await new Promise((go) => setTimeout(go, lateMs));
    if (p.sent.length > perSecond) return (p.throttled++, new Response("slow down", { status: 429 }));
    const r = JSON.parse(String(init.body)) as { id: unknown; method: string; params: unknown[] };
    const slot = Math.floor(Date.now() / 400);
    const acc = { lamports: 1, owner: POOL_USD_FEEDS.solana.owner, data: [Buffer.from(`price at ${slot}`).toString("base64"), "base64"], executable: false, rentEpoch: 0, space: 16 };
    const result = { context: { slot, apiVersion: "2.2.0" }, value: r.method === "getMultipleAccounts" ? [acc] : acc };
    return new Response(JSON.stringify({ jsonrpc: "2.0", result, id: r.id }), { status: 200, headers: { "content-type": JSON_T } });
  };
  return { p, fetch };
}

/** 200 pages on 67 addresses reading the price every 3 s for `ms`: the answers by status, and the provider's count. */
async function crowd(ms = 60_000) {
  const pv = provider(50, 120);
  const { value } = await onVirtualTime(9_000_000, async () => {
    const r = createRpc({ SOLANA_RPC_URL: URL_KEYED }, { fetch: pv.fetch as never, log: () => {} });
    const status = new Map<number, number>();
    const bad: string[] = [];
    const end = Date.now() + ms;
    const page = async (i: number): Promise<void> => {
      // each page's own phase inside the same 300 ms of each 3 s (every shown page polls in the same seconds)
      await new Promise((go) => setTimeout(go, (i * 37) % 300));
      for (let n = 0; Date.now() < end; n++) {
        const at = Date.now();
        const a = await r.handle("solana", JSON_T, priceRead(`p${i}-${n}`), `198.51.100.${Math.floor(i / 3)}`);
        status.set(a.status, (status.get(a.status) ?? 0) + 1);
        if (a.status === 200) {
          const j = JSON.parse(a.body) as { id: unknown; result?: { value?: unknown[] } };
          if (j.id !== `p${i}-${n}` || j.result?.value?.length !== 1) bad.push(a.body.slice(0, 120));
        }
        await new Promise((go) => setTimeout(go, Math.max(0, at + 3_000 - Date.now())));
      }
    };
    await Promise.all(Array.from({ length: 200 }, (_, i) => page(i)));
    return { status, bad };
  });
  return { ...value, upstream: pv.p.calls, providerThrottled: pv.p.throttled };
}

test("card helper-rpc-one-read-many-pages: 200 pages on 67 addresses reading the SOL price every 3 s in the same seconds cost the keyed provider about one read a slot, and no page is refused: a hit draws nothing of the route's total (red at 4a449c499: 4,000 asks a minute, 100 sent upstream within the route's budget and 3,900 refused 429)", async () => {
  const c = await crowd();
  const line = `upstream ${c.upstream} reads a minute (provider 429 ${c.providerThrottled}), answers ${[...c.status].map(([s, n]) => `${s} x${n}`).join(", ")}`;
  console.log(line);
  assert.deepEqual(c.bad, [], "an answer not the caller's own id, or not the account");
  assert.equal([...c.status.keys()].filter((s) => s !== 200).length, 0, `a page refused: ${line}`);
  // 20 rounds of 3 s, each in one 300 ms burst: one upstream read joins the burst, and a burst crossing a held answer's
  // end at most one more
  assert.ok(c.upstream <= 2 * 20, `more than one read a slot: ${line}`);
});

test("card helper-rpc-one-read-many-pages: a request naming any account the route holds no word for (a user's one-time account) is never held or joined: each is its own upstream read, at once or a moment apart", async () => {
  for (const method of ["getMultipleAccounts", "getAccountInfo"]) {
    const pv = provider(1_000, 120);
    await onVirtualTime(9_000_000, async () => {
      const r = createRpc({ SOLANA_RPC_URL: URL_KEYED }, { fetch: pv.fetch as never, log: () => {} });
      // three at once, the same bytes but the id
      await Promise.all([1, 2, 3].map((i) => r.handle("solana", JSON_T, priceRead(i, WALLET, method), `198.51.100.${i}`)));
      // and one within the hold of the first
      await r.handle("solana", JSON_T, priceRead(4, WALLET, method), "198.51.100.4");
      // the feed beside the wallet in one request: not every account is public, so it is the wallet's read
      const both = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "getMultipleAccounts", params: [[PYTH, WALLET], config] });
      await Promise.all([5, 6].map((i) => r.handle("solana", JSON_T, both.replace('"id":5', `"id":${i}`), `198.51.100.${i}`)));
    });
    assert.equal(pv.p.calls, 6, `${method}: ${pv.p.calls} upstream reads for 6 wallet reads`);
  }
});

test("card helper-rpc-one-read-many-pages: only the named reads are held: a batch, another method, or a read with any other option or param goes upstream each time", async () => {
  const pv = provider(1_000, 120);
  const asks = [
    JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[PYTH], config] }]),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [PYTH, config] }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[PYTH], { ...config, dataSlice: { offset: 0, length: 8 } }] }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[PYTH], config, "x"] }),
  ];
  await onVirtualTime(9_000_000, async () => {
    const r = createRpc({ SOLANA_RPC_URL: URL_KEYED }, { fetch: pv.fetch as never, log: () => {} });
    for (const body of asks) await Promise.all([1, 2].map((i) => r.handle("solana", JSON_T, body, `198.51.100.${i}`)));
  });
  assert.equal(pv.p.calls, asks.length * 2);
});

test("card helper-rpc-one-read-many-pages: a held answer is the provider's result with the caller's id, kept SHARED_HOLD_MS and no longer: a read past it goes upstream and sees the newer slot", async () => {
  const pv = provider(1_000, 120);
  const got: { slot: number; id: unknown }[] = [];
  await onVirtualTime(9_000_000, async () => {
    const r = createRpc({ SOLANA_RPC_URL: URL_KEYED }, { fetch: pv.fetch as never, log: () => {} });
    const ask = async (id: string) => {
      const a = await r.handle("solana", JSON_T, priceRead(id), "198.51.100.1");
      const j = JSON.parse(a.body) as { id: unknown; result: { context: { slot: number } } };
      got.push({ slot: j.result.context.slot, id: j.id });
    };
    await ask("a");
    await new Promise((go) => setTimeout(go, SHARED_HOLD_MS - 130));
    await ask("b"); // inside the hold: the same answer
    await new Promise((go) => setTimeout(go, 200));
    await ask("c"); // past it: read again
  });
  assert.deepEqual(got.map((g) => g.id), ["a", "b", "c"]);
  assert.equal(got[0]!.slot, got[1]!.slot);
  assert.ok(got[2]!.slot > got[0]!.slot);
  assert.equal(pv.p.calls, 2);
});

test("card helper-rpc-one-read-many-pages: the named public accounts are the kit's Pyth SOL/USD feed and the mainnet pool its deploy record names, and nothing else", () => {
  const rec = JSON.parse(readFileSync(new URL("../../../../contracts/pool-solana/deployments/mainnet.json", import.meta.url), "utf8")) as { pool: string };
  assert.deepEqual([...SHARED_ACCOUNTS].sort(), [PYTH, rec.pool].sort());
});

test("card helper-rpc-one-read-many-pages: a hit still draws a small share of its caller's: one address asking the price 400 times at once is served up to its share and refused past it, while the provider is read once", async () => {
  const pv = provider(1_000, 120);
  const { value } = await onVirtualTime(9_000_000, async () => {
    const r = createRpc({ SOLANA_RPC_URL: URL_KEYED }, { fetch: pv.fetch as never, log: () => {} });
    return Promise.all(Array.from({ length: 400 }, (_, i) => r.handle("solana", JSON_T, priceRead(i), "198.51.100.7")));
  });
  const ok = value.filter((a) => a.status === 200).length;
  const refused = value.filter((a) => a.status === 429);
  console.log(`one address, 400 at once: ${ok} served, ${refused.length} refused (${refused[0]?.why}), upstream ${pv.p.calls}`);
  assert.equal(pv.p.calls, 1);
  assert.ok(ok > 100 && refused.length > 0, `${ok} served, ${refused.length} refused`);
  assert.match(refused[0]!.why ?? "", /share/);
});
