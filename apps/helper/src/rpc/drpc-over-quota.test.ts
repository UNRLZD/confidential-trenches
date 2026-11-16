// node --test apps/helper/src/rpc/drpc-over-quota.test.ts (card drpc-over-quota-falls-over): a dRPC key whose plan is
// spent moves a caller's Base or Robinhood read to the next provider, and the caller is never answered an error.
// dRPC's own error table (github.com/drpcorg/drpc-agent-skills skills/drpc-rpc/errors.md, commit ccb130ef 2026-04-06,
// read 2026-11-16 07:05Z): "53 | 403 | Free monthly limit reached", "10 | 403 | User balance exceeded", "52 | 403 |
// Subscription limit exceeded", "24 | 403 | Daily key limit exceeded"; its docs say only "If the plan's CU are used up and
// the balance is empty, requests stop until you top up" (drpc.org/docs/pricing/plans, read 07:00Z). dRPC also answers
// its own codes inside an HTTP 200 (its NEAR throttle, code 15 in a 200: card restore-waits-out-a-near-throttle), so
// both forms are planted. Every URL is made up; the keys are planted strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpc } from "./rpc.ts";
import * as rpcModule from "./rpc.ts";
import { providerHolds, type Pace } from "../limits/limits.ts";

const { keyedPaces } = rpcModule as unknown as { keyedPaces: (env: Record<string, string>) => Record<string, Pace> };
const KEYS = {
  base: ["BASE_RPC_URL_DRPC_1", "BASE_RPC_URL_DRPC_2", "BASE_RPC_URL_DRPC_3"].map((n, i) => [n, `https://lb.drpc.test/base/plantedBASEdrpc${i + 1}key0123456789`]),
  robinhood: ["ROBINHOOD_RPC_URL_DRPC_1", "ROBINHOOD_RPC_URL_DRPC_2", "ROBINHOOD_RPC_URL_DRPC_3"].map((n, i) => [n, `https://lb.drpc.test/robinhood/plantedRHdrpc${i + 1}key00123456789`]),
} as const;
const SPARE = "https://spare.test";
const READ = { jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] };
const BATCH = [READ, { jsonrpc: "2.0", id: 8, method: "eth_chainId", params: [] }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (req: { id: unknown }, who: string) => ({ jsonrpc: "2.0", id: req.id, result: who });
/** dRPC's spent-plan answers, one request or each of a batch: its code and words, as an HTTP 403 and inside a 200. */
const SPENT: [string, number, string][] = [
  ["53 Free monthly limit reached", 53, "Free monthly limit reached"],
  ["10 User balance exceeded", 10, "User balance exceeded"],
  ["52 Subscription limit exceeded", 52, "Subscription limit exceeded"],
  ["24 Daily key limit exceeded", 24, "Daily key limit exceeded"],
];
const spent = (body: unknown, code: number, message: string, status: number): Response => {
  const one = (r: { id: unknown }) => ({ jsonrpc: "2.0", id: r.id, error: { code, message } });
  return json(Array.isArray(body) ? body.map(one) : one(body as { id: unknown }), status);
};
const clock = () => {
  const t = { v: 1_800_000_000_000 };
  return { now: () => t.v, sleep: async (ms: number) => void (t.v += ms) };
};

for (const chain of ["base", "robinhood"] as const) {
  for (const [what, code, message] of SPENT) {
    for (const status of [403, 200]) {
      for (const [shape, body] of [["a read", READ], ["a batch", BATCH]] as const) {
        test(`${chain}: dRPC's key 1 spent (${what}, HTTP ${status}), ${shape} is answered by key 2, and with all three spent by the next provider, never an error`, async () => {
          const env = Object.fromEntries(KEYS[chain]) as Record<string, string>;
          const urls = KEYS[chain].map(([, u]) => u as string);
          for (const out of [1, 3]) {
            const asked: string[] = [];
            const fetch = async (url: string, init: RequestInit): Promise<Response> => {
              asked.push(url);
              const req = JSON.parse(String(init.body)) as { id: unknown } | { id: unknown }[];
              if (urls.indexOf(url) >= 0 && urls.indexOf(url) < out) return spent(req, code, message, status);
              const who = url === SPARE ? "spare" : `key${urls.indexOf(url) + 1}`;
              return json(Array.isArray(req) ? req.map((r) => ok(r, who)) : ok(req, who));
            };
            const c = clock();
            const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces(env)), pinned: { [chain]: [SPARE] }, now: c.now, sleep: c.sleep, log: () => undefined });
            const a = await r.handle(chain, "application/json", JSON.stringify(body), "198.51.100.9");
            assert.equal(a.status, 200, `${out} key(s) spent: ${a.status} ${a.body}`);
            const answer = JSON.parse(a.body) as { result?: unknown; error?: unknown } | { result?: unknown; error?: unknown }[];
            const results = (Array.isArray(answer) ? answer : [answer]).map((x) => x.result);
            const want = out === 1 ? "key2" : "spare";
            assert.deepEqual(results, (Array.isArray(body) ? body : [body]).map(() => want), `${out} key(s) spent: ${a.body}`);
            assert.ok(!a.body.includes(message), "dRPC's refusal never reaches the caller");
            assert.equal(asked[0], urls[0], "key 1 was asked first");
            if (out === 1) assert.equal(asked[1], urls[1], "then key 2");
          }
        });
      }
    }
  }
}
