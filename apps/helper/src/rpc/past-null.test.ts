// node --test apps/helper/src/rpc/past-null.test.ts (card helper-receipts-past-retention): an upstream that no longer
// keeps an old transaction answers its receipt null, and that null is never the device's answer while another upstream
// keeps it. Read 19 Nov 02:20Z (a run of scripts/live-checks/evm-pool-index.mjs at main f1bb364ad): the helper's
// /v1/rpc/robinhood?keyed=only answered 0 of 10 Initialize receipts of span 116376549-116876548 null, where
// rpc.mainnet.chain.robinhood.com answered 10 of 10. A null receipt, transaction or numbered block from one upstream is
// asked of the next (at most PAST_NULL_TRIES more), single and batched, on Base and Robinhood, plain and keyed; the
// fewest-null answer is the device's when none keeps it (a transaction still pending). Every URL is made up or the
// chain's public fallback; the keys are planted strings. A transaction its client sent through the route lately
// (SENT_KEEP_MS) is pending: its null is passed on after one send, so a page's poll of its own buy costs what it did.
// SIGNED: Base mainnet transaction 0xa82ea366...06e5 (block 57831088), its raw bytes as base-rpc.publicnode.com's
// eth_getRawTransactionByHash answered them on 19 Nov 02:55Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpc, RPC_UPSTREAMS } from "./rpc.ts";
import { providerHolds } from "../limits/limits.ts";
import { batchSizes } from "./batch-sizes.ts";

/** rpc.ts PAST_NULL_TRIES: not imported, so this file runs at main too (red there by its assertions). */
const PAST_NULL_TRIES = 2;
const SENT_KEEP_MS = 10 * 60 * 1000;
const SIGNED = { hash: "0xa82ea3669a4f69824740f5a6c72216a4e2c60b6baa68604438c33b36a83006e5", raw: "0x02f8cf822105835a210c808398968082d6d89419f45175e813338fc79e972601a0cec7182bddc880b864b67c5c79000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000012ee0bb89c427102009c40000110c000000000019b3ebdb8e7800000dc9bc9801c080a0aefcb089d90f755676ab035f6dac5bc0491e9c5b69717eaaebd9a3dc7d6b2635a04f886a030f904dafddac72ae07a64c6dc13093fc0514bd1f553b4b6c5ab50adc" };
const KEEPS = "https://keeps.test";
const ALSO = "https://also.test";
const TX = (i: number) => `0x${i.toString(16).padStart(64, "a")}`;
const clock = () => {
  const t = { v: 1_800_000_000_000 };
  return { now: () => t.v, sleep: async (ms: number) => void (t.v += ms) };
};
type Req = { id: number; method: string; params: unknown[] };
/** Upstreams answering each call; `forgets` answer null for every receipt, transaction and numbered block. */
function upstreams(forgets: ReadonlySet<string>) {
  const posts: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    posts.push(url);
    const body = JSON.parse(String(init.body)) as Req | Req[];
    const one = (r: Req) => {
      if (r.method === "eth_blockNumber") return { jsonrpc: "2.0", id: r.id, result: "0x7000000" };
      if (r.method === "eth_getBlockByNumber" && (r.params[0] === "latest" || !forgets.has(url))) return { jsonrpc: "2.0", id: r.id, result: { number: r.params[0], hash: `0x${"b".repeat(64)}` } };
      if (forgets.has(url)) return { jsonrpc: "2.0", id: r.id, result: null };
      return { jsonrpc: "2.0", id: r.id, result: { transactionHash: r.params[0], blockNumber: "0x6efc4b9", from: new URL(url).host } };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, posts };
}
let ip = 0;
const client = () => `198.51.100.${++ip}`;
const call = (method: string, params: unknown[], id = 1) => ({ jsonrpc: "2.0", id, method, params });
const open = (chain: string, u: ReturnType<typeof upstreams>, env: Record<string, string> = {}, c = clock()) => {
  return createRpc(env, { fetch: u.fetch as never, holds: providerHolds(c.now, {}), pinned: { [chain]: [KEEPS, ALSO] }, now: c.now, sleep: c.sleep, log: () => undefined, batch: batchSizes() });
};

for (const chain of ["base", "robinhood"] as const) {
  const OWN = RPC_UPSTREAMS[chain].fallback!;
  for (const [what, req] of [
    ["a receipt", call("eth_getTransactionReceipt", [TX(1)])],
    ["a transaction", call("eth_getTransactionByHash", [TX(2)])],
    ["a numbered block", call("eth_getBlockByNumber", ["0x6efc4b9", false])],
  ] as const) {
    test(`${chain}, ${what} its first upstream answers null: the next one that keeps it answers, never null`, async () => {
      const u = upstreams(new Set([OWN]));
      const a = await open(chain, u).handle(chain, "application/json", JSON.stringify(req), client());
      assert.equal(a.status, 200, a.body);
      const got = JSON.parse(a.body) as { id: number; result: unknown };
      assert.equal(got.id, 1);
      assert.notEqual(got.result, null, `posts ${u.posts.join(",")}`);
      assert.deepEqual(u.posts, [OWN, KEEPS]);
    });
  }

  test(`${chain}, a batch of 10 receipts its first upstream answers null: all 10 from the next, in the device's order`, async () => {
    const u = upstreams(new Set([OWN]));
    const body = JSON.stringify(Array.from({ length: 10 }, (_, i) => call("eth_getTransactionReceipt", [TX(10 + i)], i + 1)));
    const a = await open(chain, u).handle(chain, "application/json", body, client());
    assert.equal(a.status, 200, a.body);
    const got = JSON.parse(a.body) as { id: number; result: { transactionHash: string } | null }[];
    assert.deepEqual(got.map((x) => x.id), Array.from({ length: 10 }, (_, i) => i + 1));
    assert.deepEqual(got.map((x) => x.result?.transactionHash), Array.from({ length: 10 }, (_, i) => TX(10 + i)));
  });

  test(`${chain}, keyed only: the first keyed upstream's null receipt goes to the next keyed one`, async () => {
    const env = { [RPC_UPSTREAMS[chain].keyed[0]!]: `https://first.keyed.test/plantedFIRSTkey0123456789abcd`, [RPC_UPSTREAMS[chain].keyed[1]!]: `https://second.keyed.test/plantedSECONDkey0123456789ab` };
    const u = upstreams(new Set([env[RPC_UPSTREAMS[chain].keyed[0]!]!]));
    const a = await open(chain, u, env).handle(chain, "application/json", JSON.stringify(call("eth_getTransactionReceipt", [TX(3)])), client(), false, true);
    assert.equal(a.status, 200, a.body);
    assert.notEqual((JSON.parse(a.body) as { result: unknown }).result, null, `posts ${u.posts.join(",")}`);
  });

  test(`${chain}, a transaction no upstream keeps (still pending): null, after at most ${PAST_NULL_TRIES} more upstreams`, async () => {
    const u = upstreams(new Set([OWN, KEEPS, ALSO]));
    const a = await open(chain, u).handle(chain, "application/json", JSON.stringify(call("eth_getTransactionReceipt", [TX(4)])), client());
    assert.equal(a.status, 200, a.body);
    assert.equal((JSON.parse(a.body) as { result: unknown }).result, null);
    assert.ok(u.posts.length <= 1 + PAST_NULL_TRIES, `posts ${u.posts.join(",")}`);
  });

  test(`${chain}, the head's block by tag answered null is passed on as it is, asked once`, async () => {
    const u = upstreams(new Set([OWN]));
    const a = await open(chain, u).handle(chain, "application/json", JSON.stringify(call("eth_getBlockByNumber", ["latest", false])), client());
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(u.posts, [OWN]);
  });

  test(`${chain}, a receipt of a transaction its client sent through the route: pending, its null passed on after one send`, async () => {
    const u = upstreams(new Set([OWN]));
    const c = clock();
    const r = open(chain, u, {}, c);
    const me = client();
    await r.handle(chain, "application/json", JSON.stringify(call("eth_sendRawTransaction", [SIGNED.raw])), me);
    for (const method of ["eth_getTransactionReceipt", "eth_getTransactionByHash"]) {
      u.posts.length = 0;
      const a = await r.handle(chain, "application/json", JSON.stringify(call(method, [SIGNED.hash])), me);
      assert.equal((JSON.parse(a.body) as { result: unknown }).result, null, method);
      assert.deepEqual(u.posts, [OWN], method);
    }
    // in a batch: the pending one's null stays, a past one beside it is asked of the next upstream
    u.posts.length = 0;
    const b = await r.handle(chain, "application/json", JSON.stringify([call("eth_getTransactionReceipt", [SIGNED.hash.toUpperCase().replace("0X", "0x")], 1)]), me);
    assert.equal((JSON.parse(b.body) as { result: unknown }[])[0]!.result, null);
    assert.deepEqual(u.posts, [OWN], "a hash in upper case is the same transaction");
    // another client's read of the same hash: not its send, so the next upstream is asked
    u.posts.length = 0;
    const o = await r.handle(chain, "application/json", JSON.stringify(call("eth_getTransactionReceipt", [SIGNED.hash])), client());
    assert.notEqual((JSON.parse(o.body) as { result: unknown }).result, null);
    assert.deepEqual(u.posts, [OWN, KEEPS]);
    // past SENT_KEEP_MS the send is past too
    await c.sleep(SENT_KEEP_MS);
    u.posts.length = 0;
    const late = await r.handle(chain, "application/json", JSON.stringify(call("eth_getTransactionReceipt", [SIGNED.hash])), me);
    assert.notEqual((JSON.parse(late.body) as { result: unknown }).result, null);
    assert.deepEqual(u.posts, [OWN, KEEPS]);
  });
}

test("sentHash: a signed transaction's hash is keccak-256 of its raw bytes, the chain's own (Base mainnet, a type-2 transaction)", async () => {
  const { sentHash } = await import("./rpc.ts");
  assert.equal(sentHash(SIGNED.raw), SIGNED.hash);
  for (const bad of [undefined, 1, "", "0x", "0x0", "0xzz", "f86c"]) assert.equal(sentHash(bad), null, String(bad));
});
