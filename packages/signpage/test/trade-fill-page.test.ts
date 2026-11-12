// Card portfolio-shows-pool-trades, review T1 to T3: the page fills each filled pool trade from its own transaction
// (src/trade-fill.ts) at the three moments src/pool-testnet.ts fillTrades names: at a signed-in load (settle), at a
// sale's filled end, and once a buy's end has written its records. Each test reads the trade's signature off the page's
// pair; cutting that one fillTrades call leaves the read out and fails it.
//   node --test test/trade-fill-page.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { testnetPool } from "../src/pool-testnet.ts";
import { TRADE_HELPER } from "../src/trade.ts";
import { POOL_USD_FEEDS } from "../../kit/src/price/pool-usd.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN = { program: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" }; // the devnet pool
const MINT = "Mint2222222222222222222222222222222222222222";
const W = "W111111111111111111111111111111111111111111";
const PRICE = { price: "15000000000", expo: -8, published_s: 1, read_ms: 1 };
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
const until = async (f: () => boolean | Promise<boolean>, what = "the condition") => {
  for (let i = 0; i < 400 && !(await f()); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(await f(), what);
};
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function store(): Promise<WalletStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  return w;
}
/** The page's pair: every getTransaction's signature logged (answered null: the fill leaves the op as it is), and each
 *  read of the fill's in `on` with the RPC it went to: 1 the helper's seat (the mainnet build's second), 0 the other. */
function pair(read: string[], on: string[] = []): readonly [SolanaRpc, SolanaRpc] {
  return [0, 1].map((k) => (async (method: string, params: readonly unknown[]) => {
    if (method === "getTransaction") return void read.push(params[0] as string), on.push(`${k} ${params[0]}`), null;
    if (method === "getSignaturesForAddress") return [];
    throw new Error(`not asked here: ${method}`);
  }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
}
function page(w: WalletStore, read: string[], kinds: Record<string, unknown> = {}, on: string[] = []) {
  return testnetPool(
    { store: async () => w, seed64: async () => SEED64.slice(), price: () => PRICE },
    { pin: PIN, rpcs: pair(read, on), table: "Table111111111111111111111111111111111111111", holdings: () => ({ chain: "sol", read: async () => ({ native: 0n, tokens: new Map(), unreadable: [] }) }), tradeKinds: kinds, positions: { setTimer: () => {}, clearTimer: () => {} } } as never,
  );
}
const saleOp = (hash: string) => ({ kind: "sell", pool: "sol", stage: "filled", chain: "solana", token: MINT, txs: [{ chain: "solana", hash }], created_ms: 1, legs: [{ wallet: W }] });

test("T1: a signed-in load (settle) fills a pool sale a page before it left with no units", async () => {
  const w = await store();
  await w.put("ops", "ps-old", saleOp("SigOld"));
  const read: string[] = [];
  const on: string[] = [];
  const tp = page(w, read, {}, on);
  await tick();
  assert.equal(read.join(), "", "nothing read before the load's settle");
  await tp.settle();
  await until(() => read.includes("SigOld"), "the sale's own transaction read at the load");
  // review P2-5: on the helper's seat alone, never the pair's other provider
  assert.deepEqual(on.filter((x) => x.endsWith(" SigOld")), ["1 SigOld"]);
});

test("T2: a sale's filled end fills it, whether the end comes as the run's progress or as its answer", async () => {
  for (const via of ["progress", "answer"] as const) {
    const w = await store();
    const read: string[] = [];
    const run = { end: () => {} };
    const sell = () => (_ask: unknown, ctx: { id: string; progress: (s: string) => void }) => {
      let answered!: () => void;
      let answer: unknown = { result: { stage: "sent" } };
      const after = new Promise<void>((r) => (answered = r));
      run.end = () =>
        void w.put("ops", ctx.id, saleOp(`Sig-${via}`)).then(() => {
          if (via === "progress") ctx.progress("filled");
          else answer = { result: { stage: "filled", txs: [{ chain: "solana", hash: `Sig-${via}` }] } };
          answered();
        });
      return { running: true as const, after, answer: () => answer };
    };
    const tp = page(w, read, { sell });
    const r = tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 0n, shareBps: 10_000, slippageBps: 1000, decimals: 6 }, { id: `ps-${via}`, sha: "00", progress: () => {}, route: () => {} } as never);
    assert.ok("running" in r, `${via}: the sale runs: ${JSON.stringify(r)}`);
    await tick();
    assert.equal(read.join(), "", `${via}: nothing read before the end`);
    run.end();
    await until(() => read.includes(`Sig-${via}`), `${via}: the sale's own transaction read at its end`);
  }
});

test("T3: a buy's end fills it once its records are written (the ops record the fill reads is the end's)", async () => {
  const w = await store();
  const read: string[] = [];
  const run = { end: (_s: string) => {} };
  const buy = () => (_ask: unknown, ctx: { route?: (r: unknown) => void; progress: (s: string) => void }) => {
    let answered!: () => void;
    let answer: unknown = null;
    const after = new Promise<void>((r) => (answered = r));
    void (async () => {
      ctx.route?.({ wallet: W });
      answer = { result: { stage: "sent", txs: [{ chain: "solana", hash: "SigB" }] } };
      answered(); // no amount out told (its read-back did not answer): the end's record has no units, the fill reads them
    })();
    run.end = (stage) => ctx.progress(stage);
    return { running: true as const, after, answer: () => answer };
  };
  const tp = page(w, read, { buy });
  const r = tp.flow({ kind: "pool.buy", chain: "solana", token: MINT, amount: 10_000_000n, slippageBps: 100, decimals: 9 }, { id: "pb1", sha: "00", progress: () => {}, route: () => {} } as never);
  assert.ok("running" in r, `the buy runs: ${JSON.stringify(r)}`);
  await tick();
  assert.equal(await w.get("ops", "pb1"), undefined, "no ops record before the end");
  assert.equal(read.join(), "", "nothing read before the end");
  run.end("filled");
  await until(async () => (await w.get("ops", "pb1")) !== undefined, "the end's ops record");
  assert.equal((await w.get("ops", "pb1") as { pool_amount?: string }).pool_amount, undefined, "its figures not told: left to the fill");
  await until(() => read.includes("SigB"), "the buy's own transaction read after its records");
});

// Review P2-5 of 30bd5fcd5: the mainnet build's fill reads on one reader, the helper's /v1/rpc/solana, never a public
// provider (no read names a W or a signature to one), and leaves a failed feed transaction unread. No `rpcs` given: the
// page's own wiring, every fetch logged. Release 118's sale 32CSJ1 and its feed's recorded list, a failed entry first.
const fx = (f: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/trade-fill/${f}.json`, import.meta.url), "utf8"));
const SELL1 = "32CSJ1GSPrJScgPxyF41zuszLjosxgiDbeFWFRM5p7G6DzbxHjeFWihPjqhQqCLobXhkn3aqBD6WxmenAXLu7Kwn";
const ICM = "78GaXFTJzkCWpdxkNHMSP3TXEKbhQTpb3EqMt7Uupump"; // the pump coin of release 118's round trips
const W5 = "5yEBxDX1FsLJBBRoj47D95QCH6xDQxNW45P1Wyqo8g9QAEmPT6WiXZiCuCM9zyv7ay9YHjN5pyQgRaghxKvzJxcD";
const FAILED = "FailedFeedTx1111111111111111111111111111111111111111111111111111111111111111111111111111";
test("T4: on the mainnet wiring the fill reads only on the helper's route, and never a failed feed transaction", async () => {
  const w = await store();
  await w.put("ops", "s1", { kind: "sell", pool: "sol", stage: "filled", chain: "solana", token: ICM, txs: [{ chain: "solana", hash: SELL1 }], created_ms: 2, legs: [{ wallet: "TcYd32AdSHY5zuqSK2a7PvkDv8FQvafyTs2uS1ztkZX" }] });
  const list = [{ signature: FAILED, err: { InstructionError: [0, "Custom"] } }, ...(fx("feed-before-32CSJ1") as unknown as unknown[])];
  const answers: Record<string, unknown> = { [SELL1]: fx("32CSJ1"), [W5]: fx("feed-5yEBxD") };
  const fill: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown; method?: string; params?: unknown[] };
    const p0 = body.params?.[0];
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
    if (body.method === "getTransaction" && typeof p0 === "string" && (p0 in answers || p0 === FAILED)) return fill.push(`${new URL(url).origin}${new URL(url).pathname} getTransaction ${p0}`), ok(answers[p0] ?? null);
    if (body.method === "getSignaturesForAddress" && p0 === POOL_USD_FEEDS.solana.account) return fill.push(`${new URL(url).origin}${new URL(url).pathname} getSignaturesForAddress`), ok(list);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not here" } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const tp = testnetPool({ store: async () => w, seed64: async () => SEED64.slice(), price: () => PRICE }, { pin: PIN, table: "Table111111111111111111111111111111111111111", holdings: () => ({ chain: "sol", read: async () => ({ native: 0n, tokens: new Map(), unreadable: [] }) }), positions: { setTimer: () => {}, clearTimer: () => {} } } as never);
    void tp.settle().catch(() => {});
    await until(async () => (await w.get("ops", "s1") as { usd_from?: string }).usd_from === "block", "the sale's block USD written");
  } finally {
    globalThis.fetch = real;
  }
  assert.equal((await w.get("ops", "s1") as { amount_usd?: string }).amount_usd, "0.04768764243129345");
  const route = `${TRADE_HELPER}/v1/rpc/solana`;
  assert.ok(fill.length >= 3, fill.join("\n"));
  assert.deepEqual(fill.filter((x) => !x.startsWith(`${route} `)), [], "every fill read on the helper's route");
  assert.ok(!fill.some((x) => x.endsWith(FAILED)), "the failed feed transaction never read");
});
