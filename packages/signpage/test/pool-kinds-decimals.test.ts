// Card sell-first-read-waits-out-a-throttle: the app's paid devnet run 5 (11 Nov 02:24Z), where the buy filled and one tap
// on Sell 2.26 s later answered down at +2206 ms with nothing signed: getAccountInfo of the mint on the devnet provider
// came back HTTP 429 four times inside the page client's own retry (kit send.ts SOLANA_RPC_RETRY, 3.5 s), the buy's
// settle having sent it about 40 reads, and the sell's first read answered down at once (src/pool-kinds.ts). Here:
//   (a) a decimals read that fails past the page's retry on one provider, then answers: the sell goes on, never down;
//   (b) one that fails for good: down only after the bound (the page's one rule, src/read-waits.ts readWaits: the
//       wallet's throttleWaitMs from 1 s, doubling, to 10 s, 30 s in all), the failing provider asked once per wait and
//       never again at once; any other error is down at once (card start-reads-wait-out-a-throttle, review of 49efdb0c);
//   (f) a sign out ends the wait, and the sell asked before it never runs (the same review);
//   (c) a token's decimals kept for the session: a second sell, and a sell after a buy's own read, ask no decimals read;
//   (d) two providers that disagree are still refused, and nothing of theirs is kept;
//   (e) the same on Base and Robinhood.
// Every wait is the test's own (deps.wait): no test reads the clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import type { EvmRpc } from "../../wallet/src/pool/evm.ts";
import { evmBuyHost, type EvmBuyPage } from "../src/pool-buy-evm.ts";
import { poolKinds, type PoolKindsDeps, type PoolRpc } from "../src/pool-kinds.ts";
import { testnetPoolDeps } from "../src/pool-testnet.ts";
import type { PoolAsk, PoolChain } from "../src/rules/pool.ts";

const SOL_TOKEN = "So11111111111111111111111111111111111111112";
const EVM_TOKEN = "0xF111111111111111111111111111111111111111";
// each request its own id, as the page's are: a request's one bound (src/read-waits.ts tapWaits) is by its id
let requests = 0;
const ctx = { get id() { return `r${++requests}`; }, sha: "00", progress: () => {} };
const mint = (dec: number) => {
  const d = new Uint8Array(82);
  d[44] = dec;
  d[45] = 1;
  return { context: { slot: 1 }, value: { owner: SOLANA_TOKEN_PROGRAM, data: [Buffer.from(d).toString("base64"), "base64"] } };
};
const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const CHAINS: readonly (readonly [PoolChain, string, unknown, number])[] = [
  ["solana", SOL_TOKEN, mint(6), 6],
  ["base", EVM_TOKEN, word(18), 18],
  ["robinhood", EVM_TOKEN, word(18), 18],
];
const settle = async (a: unknown) => {
  const d = a as { after?: Promise<unknown>; answer?: () => unknown };
  if (d.after) {
    await d.after;
    return d.answer!();
  }
  return a;
};
// what the page client throws once its own retry is spent on a provider's 429s (kit send.ts SolanaRpcTransportError)
const throttle = (afterMs: number | null = null) => new SolanaRpcTransportError("http_429", "HTTP 429", 4, "api.devnet.solana.com", afterMs);

/** Provider `bad` fails its first `fails` reads (Infinity: every read), then answers `ok`; the other always answers. */
function pair(ok: unknown, bad: 0 | 1, fails: number, afterMs: number | null = null) {
  const asks: [number, number] = [0, 0];
  const rpc =
    (i: 0 | 1): PoolRpc =>
    async () => {
      asks[i]++;
      if (i === bad && asks[i] <= fails) throw throttle(afterMs);
      return ok;
    };
  return { asks, pair: [rpc(0), rpc(1)] as const };
}

/** A sell's deps with the test's own wait, its flow logging every ask. */
function deps(rpcs: readonly [PoolRpc, PoolRpc]) {
  const waits: number[] = [];
  const flows: PoolAsk[] = [];
  const d = { pinned: () => true, rpcs: () => rpcs, flow: (ask: PoolAsk) => (flows.push(ask), { error: "busy" as const }), wait: async (ms: number) => void waits.push(ms) };
  return { waits, flows, deps: d as PoolKindsDeps };
}
const SELL = (chain: PoolChain, token: string) => ({ chain, token, amount: "1", slippage_bps: 100 });

for (const [chain, token, ok, decimals] of CHAINS)
  for (const bad of [0, 1] as const) {
    test(`(a) ${chain}: the decimals read throttled past the page's retry on provider ${bad}, then answering: the sell goes on to its flow, never down`, async () => {
      const p = pair(ok, bad, 2);
      const s = deps(p.pair);
      assert.deepEqual(await settle(poolKinds(s.deps)["pool.sell"](SELL(chain, token), ctx)), { error: "busy" }, "the flow's own answer");
      assert.deepEqual(s.flows.map((a) => [a.chain, a.decimals, a.amount]), [[chain, decimals, 10n ** BigInt(decimals)]]);
      // the wallet's one rule (throttleWaitMs) from POOL_SELL_WAIT_MS, doubling; only the provider that failed asked again
      assert.deepEqual(s.waits, [1_000, 2_000]);
      assert.deepEqual(p.asks, bad === 0 ? [3, 1] : [1, 3]);
    });
  }

test("(a) a Retry-After longer than the pause is the wait (the pause doubles from it), held to 10 s", async () => {
  const p = pair(mint(6), 0, 2, 4_500);
  const s = deps(p.pair);
  assert.deepEqual(await settle(poolKinds(s.deps)["pool.sell"](SELL("solana", SOL_TOKEN), ctx)), { error: "busy" });
  assert.deepEqual(s.waits, [4_500, 9_000]);
  const q = pair(mint(6), 1, 1, 60_000);
  const t = deps(q.pair);
  assert.deepEqual(await settle(poolKinds(t.deps)["pool.sell"](SELL("solana", SOL_TOKEN), ctx)), { error: "busy" });
  assert.deepEqual(t.waits, [10_000]);
});

for (const [chain, token, ok] of CHAINS)
  test(`(b) ${chain}: a decimals read throttled for good answers down only after the bound, its provider asked once per wait`, async () => {
    const p = pair(ok, 0, Infinity);
    const s = deps(p.pair);
    const k = poolKinds(s.deps);
    assert.deepEqual(await settle(k["pool.sell"](SELL(chain, token), ctx)), { error: "down" });
    // the rule's waits (doubling to 10 s, 30 s in all), each on throttleWaitMs; the failing provider asked once at first
    // and once after each wait, never twice at once; the provider that answered asked once
    assert.deepEqual(s.waits, [1_000, 2_000, 4_000, 8_000, 10_000]);
    assert.deepEqual(p.asks, [6, 1]);
    assert.equal(s.flows.length, 0, "nothing ran, nothing signed");
    // nothing was kept: the same request again reads again
    assert.deepEqual(await settle(k["pool.sell"](SELL(chain, token), ctx)), { error: "down" });
    assert.deepEqual(p.asks, [12, 2]);
  });

test("(b) a 5xx past the page's retry waits as a 429 does; both providers failing count as one round", async () => {
  let n = 0;
  const failing: PoolRpc = async () => {
    n++;
    throw new SolanaRpcTransportError("http_5xx", "HTTP 503", 4, "sepolia.base.org", null);
  };
  const s = deps([failing, failing]);
  assert.deepEqual(await settle(poolKinds(s.deps)["pool.sell"](SELL("base", EVM_TOKEN), ctx)), { error: "down" });
  assert.deepEqual(s.waits, [1_000, 2_000, 4_000, 8_000, 10_000]);
  assert.equal(n, 12, "both asked once a round, six rounds");
});

test("(b) any error but a provider's fault (a revert, a TypeError, a plain throw) is down at once: no wait, no second ask", async () => {
  for (const e of [new Error("execution reverted"), new TypeError("x is not a function"), new Error("HTTP 503")]) {
    let n = 0;
    const failing: PoolRpc = async () => {
      n++;
      throw e;
    };
    const s = deps([failing, failing]);
    assert.deepEqual(await settle(poolKinds(s.deps)["pool.sell"](SELL("base", EVM_TOKEN), ctx)), { error: "down" }, e.message);
    assert.deepEqual(s.waits, [], e.message);
    assert.equal(n, 2, e.message);
    // one provider's fault beside another's plain error: the plain error answers, no wait
    const t = deps([async () => Promise.reject(throttle()), failing]);
    assert.deepEqual(await settle(poolKinds(t.deps)["pool.sell"](SELL("base", EVM_TOKEN), ctx)), { error: "down" });
    assert.deepEqual(t.waits, []);
  }
});

test("(f) a sign out during the decimals wait ends it at once, and the sell asked before it never runs (also when the wait ends and a new sign in follows)", async () => {
  for (const how of ["held", "ends"] as const)
    for (const [chain, token, ok] of CHAINS) {
      const p = pair(ok, 0, 1);
      const s = deps(p.pair);
      let out = new AbortController();
      const d: PoolKindsDeps = {
        ...s.deps,
        stop: () => out.signal,
        // the sign out comes during the wait; "held": the wait never ends by itself; "ends": it ends, and a new session
        // (sign in) has its own signal by then
        wait: (ms) => {
          s.waits.push(ms);
          out.abort();
          out = new AbortController();
          return how === "held" ? new Promise<void>(() => {}) : Promise.resolve();
        },
      };
      const a = await Promise.race([settle(poolKinds(d)["pool.sell"](SELL(chain, token), ctx)), new Promise<"held">((r) => setTimeout(() => r("held"), 5_000))]);
      assert.deepEqual(a, { error: "failed" }, `${how} ${chain}`);
      assert.deepEqual(s.waits, [1_000]);
      assert.equal(s.flows.length, 0, `${how} ${chain}: the flow never ran`);
    }
});

for (const [chain, token, ok, decimals] of CHAINS)
  test(`(c) ${chain}: a token's decimals are kept for the session: a second sell asks no decimals read`, async () => {
    const p = pair(ok, 0, 0);
    const s = deps(p.pair);
    const k = poolKinds(s.deps);
    assert.deepEqual(await settle(k["pool.sell"](SELL(chain, token), ctx)), { error: "busy" });
    assert.deepEqual(p.asks, [1, 1]);
    assert.deepEqual(await settle(k["pool.sell"](SELL(chain, token), ctx)), { error: "busy" });
    if (chain !== "solana") assert.deepEqual(await settle(k["pool.sell"](SELL(chain, token.toLowerCase()), ctx)), { error: "busy" }, "an EVM address in any case is one token");
    assert.deepEqual(p.asks, [1, 1], "no read after the first");
    assert.ok(s.flows.every((a) => a.decimals === decimals));
  });

for (const chain of ["base", "robinhood"] as const)
  test(`(c) ${chain}: a sell after the page's EVM buy read the token's decimals asks no decimals read`, async () => {
    const reads: string[] = [];
    const rpc: EvmRpc = async (method) => (reads.push(method), word(18));
    // the EVM buy's own read, as its host makes it before W signs (src/pool-buy-evm.ts evmBuyHost)
    const host = evmBuyHost(chain, { network: chain, pool: "0x" + "11".repeat(20), feeRecipient: "0x" + "22".repeat(20), fromBlock: 1n }, [rpc, rpc], new Set(), {} as EvmBuyPage);
    assert.equal(await host.decimals(EVM_TOKEN), 18);
    assert.deepEqual(reads, ["eth_call", "eth_call"]);
    // the sell, on the page's own deps (src/pool-testnet.ts testnetPoolDeps) with providers that count every ask
    const p = pair(word(18), 0, 0);
    const flows: PoolAsk[] = [];
    const k = poolKinds({ ...testnetPoolDeps((ask) => (flows.push(ask), { error: "busy" })), pinned: () => true, rpcs: () => p.pair });
    assert.deepEqual(await settle(k["pool.sell"](SELL(chain, EVM_TOKEN), ctx)), { error: "busy" });
    assert.deepEqual(p.asks, [0, 0], "the buy's read counts: no decimals read");
    assert.deepEqual(flows.map((a) => a.decimals), [18]);
  });

for (const [chain, token] of CHAINS)
  test(`(d) ${chain}: two providers that disagree are refused not_allowed, after a throttle too, and nothing of theirs is kept`, async () => {
    const answers = chain === "solana" ? [mint(6), mint(9)] : [word(6), word(18)];
    let throttled = false;
    const asks: [number, number] = [0, 0];
    const rpc =
      (i: 0 | 1): PoolRpc =>
      async () => {
        asks[i]++;
        if (i === 0 && !throttled) {
          throttled = true;
          throw throttle();
        }
        return answers[i];
      };
    const s = deps([rpc(0), rpc(1)]);
    const k = poolKinds(s.deps);
    assert.deepEqual(await settle(k["pool.sell"](SELL(chain, token), ctx)), { error: "not_allowed" });
    assert.deepEqual(s.waits, [1_000]);
    assert.deepEqual(await settle(k["pool.sell"](SELL(chain, token), ctx)), { error: "not_allowed" });
    assert.deepEqual(asks, [3, 2], "read again: a disagreement is never kept");
    assert.equal(s.flows.length, 0);
  });

test("(g) one bound per request: the sell's flow goes on from the waits its decimals read took (card start-reads-wait-out-a-throttle)", async () => {
  const { tapWaits } = await import("../src/read-waits.ts");
  const p = pair(mint(6), 0, 2);
  const s = deps(p.pair);
  let next: number | null = -1;
  const one = { id: "r-shared-bound", sha: "00", progress: () => {} };
  const d: PoolKindsDeps = { ...s.deps, flow: (_ask, c) => ((next = tapWaits(c).next(throttle())), { error: "busy" as const }) };
  assert.deepEqual(await settle(poolKinds(d)["pool.sell"](SELL("solana", SOL_TOKEN), one)), { error: "busy" });
  assert.deepEqual(s.waits, [1_000, 2_000]);
  assert.equal(next, 4_000, "the flow's next wait doubles on from the decimals read's");
});
