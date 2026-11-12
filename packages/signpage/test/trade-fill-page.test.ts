// Card portfolio-shows-pool-trades, review T1 to T3: the page fills each filled pool trade from its own transaction
// (src/trade-fill.ts) at the three moments src/pool-testnet.ts fillTrades names: at a signed-in load (settle), at a
// sale's filled end, and once a buy's end has written its records. Each test reads the trade's signature off the page's
// pair; cutting that one fillTrades call leaves the read out and fails it.
//   node --test test/trade-fill-page.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { testnetPool } from "../src/pool-testnet.ts";

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
/** The page's pair: every getTransaction's signature logged (answered null: the fill leaves the op as it is). */
function pair(read: string[]): readonly [SolanaRpc, SolanaRpc] {
  return [0, 1].map(() => (async (method: string, params: readonly unknown[]) => {
    if (method === "getTransaction") return void read.push(params[0] as string), null;
    if (method === "getSignaturesForAddress") return [];
    throw new Error(`not asked here: ${method}`);
  }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
}
function page(w: WalletStore, read: string[], kinds: Record<string, unknown> = {}) {
  return testnetPool(
    { store: async () => w, seed64: async () => SEED64.slice(), price: () => PRICE },
    { pin: PIN, rpcs: pair(read), table: "Table111111111111111111111111111111111111111", holdings: () => ({ chain: "sol", read: async () => ({ native: 0n, tokens: new Map(), unreadable: [] }) }), tradeKinds: kinds, positions: { setTimer: () => {}, clearTimer: () => {} } } as never,
  );
}
const saleOp = (hash: string) => ({ kind: "sell", pool: "sol", stage: "filled", chain: "solana", token: MINT, txs: [{ chain: "solana", hash }], created_ms: 1, legs: [{ wallet: W }] });

test("T1: a signed-in load (settle) fills a pool sale a page before it left with no units", async () => {
  const w = await store();
  await w.put("ops", "ps-old", saleOp("SigOld"));
  const read: string[] = [];
  const tp = page(w, read);
  await tick();
  assert.equal(read.join(), "", "nothing read before the load's settle");
  await tp.settle();
  await until(() => read.includes("SigOld"), "the sale's own transaction read at the load");
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
