// What each filled Solana trade moved, from its own transaction (card portfolio-shows-pool-trades): the rules on the
// owner's four mainnet transactions of 12 Nov (fixtures/trade-fill, getTransaction "json" at finalized on a public RPC,
// its logs and the message's lookup-table entries left out, meta.loadedAddresses kept), and the fill of the ops records
// release 118 wrote for them.
//   node --test packages/signpage/test/trade-fill.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { FEED_READS_MAX, FILL_OPS_MAX, feedWritePrice, fillTradeOps, solanaTradeLeg, type FillStore } from "../src/trade-fill.ts";
import { POOL_USD_FEEDS } from "../../kit/src/price/pool-usd.ts";

const MINT = "78GaXFTJzkCWpdxkNHMSP3TXEKbhQTpb3EqMt7Uupump";
const fx = (f: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/trade-fill/${f}.json`, import.meta.url), "utf8"));
const SIG = {
  buy1: "5Qn5LtHiu7xb7irPaPTSpcwPoreem1toPSYT3XvVBPDfH42CU3hMWmKP3AMXg3ag3qdoQb3Rnxrfo6dXVGXtvB8Q",
  sell1: "32CSJ1GSPrJScgPxyF41zuszLjosxgiDbeFWFRM5p7G6DzbxHjeFWihPjqhQqCLobXhkn3aqBD6WxmenAXLu7Kwn",
  buy2: "3sPawpfvAdoYLHa9i5MRKZVv6xEGLCmRXjJTKxEMHpNYqPMSX22QZ6eyLbdyJDNA7T6TTpWWaKamEA1LiAMaDoQr",
  sell2: "3aUiLLSmj1oHFot7bPLp1VewwqHZ1eNsJnTyZvLnDFKyubfqmwK6iCq7AsSXmt497Vjx8o6AxwEbRzxeEjQr52bd",
};
const TX: Record<string, Record<string, unknown>> = { [SIG.buy1]: fx("5Qn5Lt"), [SIG.sell1]: fx("32CSJ1"), [SIG.buy2]: fx("3sPawp"), [SIG.sell2]: fx("3aUiLL") };
const W1 = "TcYd32AdSHY5zuqSK2a7PvkDv8FQvafyTs2uS1ztkZX";
const W2 = "8e8RsnpnL6Toqsa2Q1YPLvopDqPa3HFTdwEikCkqpQ7p";

test("each of the four: W, the token it got or sold, and the SOL into or out of the venue", () => {
  // buys: pump's BuyExactSolIn spend (1,205,887 and 1,204,552, its instruction's own argument)
  assert.deepEqual(solanaTradeLeg(TX[SIG.buy1], "buy", MINT), { wallet: W1, units: 16041923776n, decimals: 6, lamports: 1205887n });
  assert.deepEqual(solanaTradeLeg(TX[SIG.buy2], "buy", MINT), { wallet: W2, units: 34154038071n, decimals: 6, lamports: 1204552n });
  // sales: the curve's 581,910 and 1,189,536 less pump's fees (7,275 and 14,870)
  assert.deepEqual(solanaTradeLeg(TX[SIG.sell1], "sell", MINT), { wallet: W1, units: 16041923776n, decimals: 6, lamports: 574635n });
  assert.deepEqual(solanaTradeLeg(TX[SIG.sell2], "sell", MINT), { wallet: W2, units: 34154038071n, decimals: 6, lamports: 1174666n });
});

test("never a guess: the wrong side, another token, a failed transaction, an unknown system instruction of W's", () => {
  assert.equal(solanaTradeLeg(TX[SIG.buy1], "sell", MINT), null);
  assert.equal(solanaTradeLeg(TX[SIG.sell1], "sell", "So11111111111111111111111111111111111111112"), null);
  const failed = structuredClone(TX[SIG.sell1]) as { meta: { err: unknown } };
  failed.meta.err = { InstructionError: [2, "Custom"] };
  assert.equal(solanaTradeLeg(failed, "sell", MINT), null);
  // W's transfer to the pool as a transfer with seed (tag 11): its lamports are not read, so the figure is unknown
  const odd = structuredClone(TX[SIG.sell1]) as { meta: { innerInstructions: { instructions: { data: string; programIdIndex: number; accounts: number[] }[] }[] }; transaction: { message: { accountKeys: string[] } } };
  const keys = odd.transaction.message.accountKeys;
  const ix = odd.meta.innerInstructions.flatMap((g) => g.instructions).find((i) => keys[i.programIdIndex] === "11111111111111111111111111111111" && keys[i.accounts[0]!] === W1 && base58.decode(i.data)[0] === 2)!;
  const d = base58.decode(ix.data);
  d[0] = 11;
  ix.data = base58.encode(d);
  assert.equal(solanaTradeLeg(odd, "sell", MINT), null);
  assert.equal(solanaTradeLeg(null, "buy", MINT), null);
});

/** The ops store with release 118's records of the four trades. */
function store118(): FillStore & { ops: Map<string, Record<string, unknown>> } {
  const ops = new Map<string, Record<string, unknown>>([
    ["b1", { kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: SIG.buy1 }], created_ms: 1, chain: "solana", token: MINT, amount_usd: "0.10002700069283141" }],
    ["s1", { kind: "sell", pool: "sol", sha: "x", stage: "filled", txs: [{ chain: "solana", hash: SIG.sell1 }], created_ms: 2, chain: "solana", token: MINT, units: "16041.923776", legs: [{ wallet: W1, units: "16041.923776", tx: SIG.sell1, stage: "filled" }] }],
    ["b2", { kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: SIG.buy2 }], created_ms: 3, chain: "solana", token: MINT, amount_usd: "0.0999999427770536" }],
    ["s2", { kind: "sell", pool: "sol", sha: "y", stage: "filled", txs: [{ chain: "solana", hash: SIG.sell2 }], created_ms: 4, chain: "solana", token: MINT, units: "34154.038071" }],
    ["d1", { kind: "pool_deposit", stage: "in_pool", txs: [] }],
    ["r1", { kind: "sell", pool: "sol", stage: "refused", txs: [], code: "failed", chain: "solana", token: MINT }],
  ]);
  return {
    ops,
    keys: async () => [...ops.keys()],
    get: async (_s, k) => ops.get(k),
    update: async (_s, k, f) => void ops.set(k, f(ops.get(k)) as Record<string, unknown>),
  };
}
const PRICE = { price: "16000000000", expo: -8, published_s: 1, read_ms: 0 };
const OLD = 10 * 86_400_000;

test("release 118's records filled from the chain on one reader: units and SOL on each, every other field kept", async () => {
  const s = store118();
  const reads: string[] = [];
  const wrote = await fillTradeOps({ store: s, read: async (sig) => (reads.push(sig), TX[sig]), price: () => ({ ...PRICE, read_ms: OLD }), now: () => OLD });
  assert.equal(wrote, true);
  assert.deepEqual(reads.sort(), Object.values(SIG).sort(), "each trade's own signature, once, nothing else");
  assert.deepEqual(s.ops.get("b1"), { kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: SIG.buy1 }], created_ms: 1, chain: "solana", token: MINT, amount_usd: "0.10002700069283141", units: "16041.923776", pool_amount: "0.001205887" });
  assert.equal(s.ops.get("s1")!.pool_amount, "0.000574635");
  assert.equal(s.ops.get("s1")!.amount_usd, undefined, "a sale days old with no feed reader: the price now is not its price");
  assert.equal((s.ops.get("s1")!.legs as unknown[]).length, 1);
  assert.equal(s.ops.get("b2")!.pool_amount, "0.001204552");
  assert.equal(s.ops.get("s2")!.pool_amount, "0.001174666");
  assert.equal(s.ops.get("r1")!.pool_amount, undefined, "a refused sale moved nothing");
  // filled once: a second pass reads nothing
  reads.length = 0;
  assert.equal(await fillTradeOps({ store: s, read: async (sig) => (reads.push(sig), TX[sig]), price: () => null, now: () => OLD }), false);
  assert.equal(reads.length, 0);
});

test("a young sale at its end gets its USD at the page's fresh price; with none, and none at its block, it waits for the next run (review R2)", async () => {
  const s = store118();
  await fillTradeOps({ store: s, read: async (sig) => TX[sig], price: () => ({ ...PRICE, read_ms: 4 }), now: () => 60_000 });
  assert.equal(s.ops.get("s1")!.amount_usd, "0.0919416");
  assert.equal(s.ops.get("s1")!.usd_from, "live");
  // R2: the end's read fails; a reload before the price is read; then a run with a fresh price
  const t = store118();
  assert.equal(await fillTradeOps({ store: t, read: async () => { throw new Error("429"); }, price: () => ({ ...PRICE, read_ms: 4 }), now: () => 5_000 }), false);
  await fillTradeOps({ store: t, read: async (sig) => TX[sig], price: () => null, now: () => 60_000 });
  assert.equal(t.ops.get("s1")!.pool_amount, undefined, "not marked done with no USD while young");
  assert.equal(t.ops.get("b1")!.pool_amount, "0.001205887", "a buy needs no price");
  await fillTradeOps({ store: t, read: async (sig) => TX[sig], price: () => ({ ...PRICE, read_ms: 69_000 }), now: () => 70_000 });
  assert.equal(t.ops.get("s1")!.amount_usd, "0.0919416");
  // past SALE_USD_MS with no price at its block: written with no USD, the app's dash
  const u = store118();
  await fillTradeOps({ store: u, read: async (sig) => TX[sig], price: () => null, now: () => 700_000 });
  assert.equal(u.ops.get("s1")!.pool_amount, "0.000574635");
  assert.equal(u.ops.get("s1")!.amount_usd, undefined);
});

test("refused: a read that fails, an answer for another signature, a sale whose W is none of its legs' wallets", async () => {
  const s = store118();
  s.ops.set("s1", { ...s.ops.get("s1")!, legs: [{ wallet: W2, units: "16041.923776", tx: SIG.sell1, stage: "filled" }] });
  await fillTradeOps({
    store: s,
    read: async (sig) => {
      if (sig === SIG.buy2) throw new Error("429");
      if (sig === SIG.sell2) return TX[SIG.sell1]; // the answer for another signature
      return TX[sig];
    },
    price: () => null,
    now: () => OLD,
  });
  assert.equal(s.ops.get("s1")!.pool_amount, undefined, "W1 sold, the op names W2");
  assert.equal(s.ops.get("b2")!.pool_amount, undefined);
  assert.equal(s.ops.get("s2")!.pool_amount, undefined);
  assert.equal(s.ops.get("b1")!.pool_amount, "0.001205887");
});

test("pool ops only: a trade-box buy (its quote's sha) and a sale with no pool are left alone (review P3-5)", async () => {
  const s = store118();
  s.ops.set("b1", { ...s.ops.get("b1")!, sha: "q" });
  const { pool: _p, ...noPool } = s.ops.get("s1")!;
  s.ops.set("s1", noPool);
  const reads: string[] = [];
  await fillTradeOps({ store: s, read: async (sig) => (reads.push(sig), TX[sig]), price: () => null, now: () => OLD });
  assert.ok(!reads.includes(SIG.buy1) && !reads.includes(SIG.sell1), reads.join(","));
  assert.equal(s.ops.get("b1")!.pool_amount, undefined);
  assert.equal(s.ops.get("s1")!.pool_amount, undefined);
});

test("a sale over several legs: each leg's W, units and SOL summed; one leg unread or of other decimals writes nothing", async () => {
  const two = (): FillStore & { ops: Map<string, Record<string, unknown>> } => {
    const s = store118();
    for (const k of ["b1", "b2", "s2"]) s.ops.delete(k);
    s.ops.set("s1", { ...s.ops.get("s1")!, txs: [{ chain: "solana", hash: SIG.sell1 }, { chain: "solana", hash: SIG.sell2 }], legs: [{ wallet: W1 }, { wallet: W2 }] });
    return s;
  };
  const s = two();
  await fillTradeOps({ store: s, read: async (sig) => TX[sig], price: () => null, now: () => OLD });
  assert.equal(s.ops.get("s1")!.units, "50195.961847");
  assert.equal(s.ops.get("s1")!.pool_amount, "0.001749301");
  const t = two();
  await fillTradeOps({ store: t, read: async (sig) => (sig === SIG.sell2 ? null : TX[sig]), price: () => null, now: () => OLD });
  assert.equal(t.ops.get("s1")!.pool_amount, undefined, "the first leg alone is not the sale");
  const u = two();
  const nine = structuredClone(TX[SIG.sell2]) as { meta: { preTokenBalances: { uiTokenAmount: { decimals: number } }[]; postTokenBalances: { uiTokenAmount: { decimals: number } }[] } };
  for (const b of [...nine.meta.preTokenBalances, ...nine.meta.postTokenBalances]) b.uiTokenAmount.decimals = 9;
  await fillTradeOps({ store: u, read: async (sig) => (sig === SIG.sell2 ? nine : TX[sig]), price: () => null, now: () => OLD });
  assert.equal(u.ops.get("s1")!.pool_amount, undefined, "legs of other decimals are not summed");
});

test("a fill written meanwhile (another tab) is kept: the update re-checks the op", async () => {
  const s = store118();
  const update = s.update;
  s.update = async (st, k, f) => {
    const v = s.ops.get(k)!;
    s.ops.set(k, { ...v, pool_amount: "9" });
    return update(st, k, f);
  };
  await fillTradeOps({ store: s, read: async (sig) => TX[sig], price: () => null, now: () => OLD });
  assert.equal(s.ops.get("b1")!.pool_amount, "9");
  assert.equal(s.ops.get("b1")!.units, undefined);
});

test("at most FILL_OPS_MAX ops a run, newest first (review P3-1)", async () => {
  const ops = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < FILL_OPS_MAX + 5; i++) ops.set(`b${i}`, { kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: SIG.buy1 }], created_ms: i, chain: "solana", token: MINT });
  const s: FillStore = { keys: async () => [...ops.keys()], get: async (_s, k) => ops.get(k), update: async (_s, k, f) => void ops.set(k, f(ops.get(k)) as Record<string, unknown>) };
  let reads = 0;
  await fillTradeOps({ store: s, read: async (sig) => (reads++, TX[sig]), price: () => null, now: () => OLD });
  assert.equal(reads, FILL_OPS_MAX);
  assert.equal(ops.get(`b${FILL_OPS_MAX + 4}`)!.pool_amount, "0.001205887");
  assert.equal(ops.get("b0")!.pool_amount, undefined, "the oldest wait for the next run");
});

// R1 (review P2-1): a PumpSwap sale as the kit builds it (pool-buy.ts solanaPoolSellSteps): W makes its wrapped-SOL
// account (a system CreateAccount of rent(165) = 2,039,280 from W), PumpSwap pays the proceeds into it, and the close
// gives W the proceeds and that rent back. Modelled on the real curve sale 32CSJ1 (no PumpSwap sale of ours is on
// record: the devnet runs of scripts/live-checks/sol-pool-venue-tables.md hold no swap of W's); its proceeds reach W by
// the close instead of the curve, W's lamports after the same, the wrapped account's create and close added.
test("R1: a PumpSwap sale's wrapped-SOL account, made and closed in the sale, is not counted out of W", () => {
  const t = structuredClone(TX[SIG.sell1]) as { transaction: { message: { accountKeys: string[] } }; meta: { preBalances: number[]; postBalances: number[]; innerInstructions: { index: number; instructions: unknown[] }[] } };
  const keys = t.transaction.message.accountKeys;
  const at = keys.length;
  keys.push("Wsoi1AtaWsoi1AtaWsoi1AtaWsoi1AtaWsoi1AtaWso");
  t.meta.preBalances.splice(at, 0, 0);
  t.meta.postBalances.splice(at, 0, 0); // closed in the same transaction
  const data = new Uint8Array(52);
  const v = new DataView(data.buffer);
  v.setUint32(0, 0, true);
  v.setBigUint64(4, 2_039_280n, true);
  v.setBigUint64(12, 165n, true);
  t.meta.innerInstructions.push({ index: 2, instructions: [{ programIdIndex: keys.indexOf("11111111111111111111111111111111"), accounts: [keys.indexOf(W1), at], data: base58.encode(data), stackHeight: 2 }] });
  assert.equal(solanaTradeLeg(t, "sell", MINT)!.lamports, 574_635n);
  // the same account still open after (a rent W paid for good) is counted out of W, as the mark's is
  t.meta.postBalances[at] = 2_039_280;
  assert.equal(solanaTradeLeg(t, "sell", MINT)!.lamports, 574_635n + 2_039_280n + 2_039_280n - 2_039_280n);
});

test("a PumpSwap buy (W's wrapped-SOL balance in its meta) gets no SOL from here: its transfer goes to W's own account", () => {
  const t = structuredClone(TX[SIG.buy1]) as { meta: { preTokenBalances: unknown[]; postTokenBalances: unknown[] } };
  t.meta.postTokenBalances.push({ accountIndex: 0, mint: "So11111111111111111111111111111111111111112", owner: W1, uiTokenAmount: { amount: "0", decimals: 9 } });
  assert.equal(solanaTradeLeg(t, "buy", MINT), null);
});

// ------------------------------------------------------------------------------------------------ an old sale's USD
// An old sale's dollar value from the SOL price at its own block, read from the page's own SOL/USD
// feed (the kit's POOL_USD_FEEDS.solana, Pyth's sponsored account): the newest write of it before the sale, its signed
// price message (fixtures feed-*.json: getTransaction "json" at finalized, 12 Nov; feed-before-*.json: the account's
// getSignaturesForAddress before each sale, finalized, limit 20 and 60).
const FEED_BEFORE: Record<string, { signature: string; err: unknown }[]> = { [SIG.sell1]: fx("feed-before-32CSJ1") as never, [SIG.sell2]: fx("feed-before-3aUiLL") as never };
const WRITES: Record<string, Record<string, unknown>> = { "5yEBxDX1FsLJBBRoj47D95QCH6xDQxNW45P1Wyqo8g9QAEmPT6WiXZiCuCM9zyv7ay9YHjN5pyQgRaghxKvzJxcD": fx("feed-5yEBxD"), "4JFB6zkT6UBujxAi7ToPNbSw32RiSLe2tFeL3UN5Z4GCmbtWAjAMBB3QoVroRAp8BzMuJmnhifWNVAMTXewfeizx": fx("feed-4JFB6z") };
const ALL: Record<string, Record<string, unknown>> = { ...TX, ...WRITES };
const feedBefore = async (sig: string) => (FEED_BEFORE[sig] ?? []).filter((s) => s.err === null).map((s) => s.signature);
/** A read of `sig` on the helper: a feed reader's transaction (not recorded) answers null, as a version-1 one does. */
const both = async (sig: string) => ALL[sig] ?? null;

test("a feed write's signed SOL/USD: price, confidence, exponent and publish time from its message; any other transaction none", () => {
  assert.deepEqual(feedWritePrice(WRITES["5yEBxDX1FsLJBBRoj47D95QCH6xDQxNW45P1Wyqo8g9QAEmPT6WiXZiCuCM9zyv7ay9YHjN5pyQgRaghxKvzJxcD"]), { price: 8298770947n, conf: 2770833n, expo: -8, publishedS: 1794461905, blockS: 1794461908 });
  assert.equal(feedWritePrice(TX[SIG.sell1]), null, "a trade is no feed write");
  const failed = structuredClone(WRITES["5yEBxDX1FsLJBBRoj47D95QCH6xDQxNW45P1Wyqo8g9QAEmPT6WiXZiCuCM9zyv7ay9YHjN5pyQgRaghxKvzJxcD"]) as { meta: { err: unknown } };
  failed.meta.err = { InstructionError: [0, "Custom"] };
  assert.equal(feedWritePrice(failed), null, "a write that failed proves nothing");
});

test("release 118's sales get their USD at the SOL price of their own block, marked as read later; the live path is marked live", async () => {
  const s = store118();
  await fillTradeOps({ store: s, read: both, feedBefore, price: () => null, now: () => 10 * 86_400_000 });
  // 574,635 lamports at $82.98770947 (published 7 s before the sale's block); 1,174,666 at the write 13 s before its block
  assert.equal(s.ops.get("s1")!.amount_usd, "0.04768764243129345");
  assert.equal(s.ops.get("s1")!.usd_from, "block");
  assert.match(String(s.ops.get("s2")!.amount_usd), /^0\.09\d+$/);
  assert.equal(s.ops.get("s2")!.usd_from, "block");
  assert.equal(s.ops.get("b1")!.usd_from, undefined, "a buy keeps the USD it was written with");
  const t = store118();
  await fillTradeOps({ store: t, read: both, feedBefore, price: () => ({ ...PRICE, read_ms: 4 }), now: () => 60_000 });
  assert.equal(t.ops.get("s1")!.usd_from, "live");
  // a young sale with no fresh price takes its block's
  const y = store118();
  await fillTradeOps({ store: y, read: both, feedBefore, price: () => null, now: () => 60_000 });
  assert.equal(y.ops.get("s1")!.usd_from, "block");
});

test("never a guess: no write within a minute of the sale's block, no write in the list, or an answer for another signature: no USD", async () => {
  const late = store118();
  // the sale read as 2 minutes after its block: the write before it is too old to be that minute's price
  const shifted = (sig: string) => {
    const t = structuredClone(ALL[sig] ?? null) as { blockTime?: number } | null;
    if (t && (sig === SIG.sell1 || sig === SIG.sell2)) t.blockTime! += 120;
    return t;
  };
  await fillTradeOps({ store: late, read: async (sig) => shifted(sig), feedBefore, price: () => null, now: () => 1e12 });
  assert.equal(late.ops.get("s1")!.amount_usd, undefined);
  assert.equal(late.ops.get("s1")!.pool_amount, "0.000574635", "the SOL still written");
  const none = store118();
  await fillTradeOps({ store: none, read: both, feedBefore: async () => [], price: () => null, now: () => 1e12 });
  assert.equal(none.ops.get("s1")!.amount_usd, undefined);
  // a feed answer for another signature than the one asked is refused
  const other = store118();
  await fillTradeOps({ store: other, read: async (sig) => (sig in WRITES ? Object.values(WRITES).find((w) => w !== WRITES[sig]) : both(sig)), feedBefore, price: () => null, now: () => 1e12 });
  assert.equal(other.ops.get("s1")!.amount_usd, undefined);
});

// The delta review of 7821afea9..30bd5fcd5: one test per guard of the block price, each on the real write 5yEBxD
// changed in one place (its push-oracle instruction's price message, or the transaction around it), and a sale of two
// legs with one leg unpriced. The sale is 32CSJ1 (block 1794461912; the write's block 1794461908, published 1794461905).
const W5 = "5yEBxDX1FsLJBBRoj47D95QCH6xDQxNW45P1Wyqo8g9QAEmPT6WiXZiCuCM9zyv7ay9YHjN5pyQgRaghxKvzJxcD";
const FEED = POOL_USD_FEEDS.solana;
type WIx = { programIdIndex: number; accounts: number[]; data: string };
type WTx = { blockTime: number; transaction: { message: { accountKeys: string[]; instructions: WIx[] } }; meta: { innerInstructions: { instructions: WIx[] }[] } };
const write5 = (): WTx => structuredClone(WRITES[W5]) as unknown as WTx;
const pushIx = (w: WTx): WIx => [...w.transaction.message.instructions, ...w.meta.innerInstructions.flatMap((g) => g.instructions)].find((i) => w.transaction.message.accountKeys[i.programIdIndex] === FEED.pushOracle)!;
/** 5yEBxD with its price message changed by `f` (at: the message's type byte; price +33, conf +41, expo +49, publish +53). */
function forged(f: (v: DataView, at: number, d: Uint8Array) => void, w: WTx = write5()): WTx {
  const ix = pushIx(w);
  const d = base58.decode(ix.data);
  const at = Buffer.from(d).toString("hex").indexOf("00" + FEED.feedId.slice(2)) / 2;
  assert.ok(Number.isInteger(at) && at >= 4, "the message found");
  f(new DataView(d.buffer, d.byteOffset, d.byteLength), at, d);
  ix.data = base58.encode(d);
  return w;
}
/** Sale s1's block USD when the feed's newest write before it answers `write` (the list as recorded). */
async function blockUsd(write: unknown, list: (sig: string) => Promise<string[]> = feedBefore): Promise<unknown> {
  const s = store118();
  await fillTradeOps({ store: s, read: async (sig) => (sig === W5 ? write : both(sig)), feedBefore: list, price: () => null, now: () => 1e12 });
  assert.equal(s.ops.get("s1")!.pool_amount, "0.000574635", "the SOL always written");
  return s.ops.get("s1")!.amount_usd;
}
const SALE_BLOCK = (TX[SIG.sell1] as { blockTime: number }).blockTime;

test("the forging helper: 5yEBxD unchanged gives the replay's USD", async () => {
  assert.equal(await blockUsd(forged(() => {})), "0.04768764243129345");
});

test("D20: a sale of two legs with one leg unpriced writes no USD at all, never the priced leg's alone; both priced, their sum", async () => {
  const two = () => {
    const ops = new Map<string, Record<string, unknown>>([["s", { kind: "sell", pool: "sol", stage: "filled", txs: [{ chain: "solana", hash: SIG.sell1 }, { chain: "solana", hash: SIG.sell2 }], created_ms: 2, chain: "solana", token: MINT, legs: [{ wallet: W1 }, { wallet: W2 }] }]]);
    return { ops, keys: async () => [...ops.keys()], get: async (_s: string, k: string) => ops.get(k), update: async (_s: string, k: string, f: (v: unknown) => unknown) => void ops.set(k, f(ops.get(k)) as Record<string, unknown>) } as FillStore & { ops: Map<string, Record<string, unknown>> };
  };
  const one = two();
  await fillTradeOps({ store: one, read: both, feedBefore: async (sig) => (sig === SIG.sell2 ? [] : feedBefore(sig)), price: () => null, now: () => 1e12 });
  assert.equal(one.ops.get("s")!.pool_amount, "0.001749301", "both legs' SOL");
  assert.equal(one.ops.get("s")!.amount_usd, undefined, "one leg unpriced: no USD");
  assert.equal(one.ops.get("s")!.usd_from, undefined);
  const all = two();
  await fillTradeOps({ store: all, read: both, feedBefore, price: () => null, now: () => 1e12 });
  assert.equal(all.ops.get("s")!.amount_usd, "0.14518367436909397", "each leg at its own block, summed");
  assert.equal(all.ops.get("s")!.usd_from, "block");
});

test("D3: a push-oracle write to another account than the feed's is no price", async () => {
  const w = write5();
  const keys = w.transaction.message.accountKeys;
  keys[keys.indexOf(FEED.account)] = "So11111111111111111111111111111111111111112";
  assert.equal(feedWritePrice(w), null);
  assert.equal(await blockUsd(w), undefined);
});

test("D4: a price message for another feed id is no price", async () => {
  const w = forged((_v, at, d) => void (d[at + 1] = d[at + 1]! ^ 1));
  assert.equal(feedWritePrice(w), null);
  assert.equal(await blockUsd(w), undefined);
});

test("D12: a message published after the sale's block is no price for it", async () => {
  const w = forged((v, at) => v.setBigInt64(at + 53, BigInt(SALE_BLOCK + 1), false));
  assert.equal(feedWritePrice(w)!.publishedS, SALE_BLOCK + 1, "a price of its own");
  assert.equal(await blockUsd(w), undefined);
});

test("D14: a write landed after the sale's block is no price for it", async () => {
  const w = write5();
  w.blockTime = SALE_BLOCK + 1;
  assert.ok(feedWritePrice(w), "a price of its own");
  assert.equal(await blockUsd(w), undefined);
});

test("D8 to D10: a price of zero or below, an exponent above zero or below -18, or a confidence past the feed's bound is no price", async () => {
  // D8: zero, its confidence zero too so only the price's own bound refuses it; and below zero
  for (const p of [0n, -1n]) assert.equal(feedWritePrice(forged((v, at) => (v.setBigInt64(at + 33, p, false), v.setBigUint64(at + 41, 0n, false)))), null, `price ${p}`);
  // D9
  for (const e of [1, -19]) assert.equal(feedWritePrice(forged((v, at) => v.setInt32(at + 49, e, false))), null, `expo ${e}`);
  // D10: at the bound it stands, one past it is refused
  const price = feedWritePrice(write5())!.price;
  const bound = (price * BigInt(FEED.maxConfBps)) / 10_000n;
  assert.ok(feedWritePrice(forged((v, at) => v.setBigUint64(at + 41, bound, false))), "at the bound");
  const past = forged((v, at) => v.setBigUint64(at + 41, bound + 1n, false));
  assert.equal(feedWritePrice(past), null, "past the bound");
  assert.equal(await blockUsd(past), undefined);
});

test("D7: one transaction with two different price messages for the feed is no price; the same message twice is", async () => {
  const twice = (change: boolean) => {
    const w = write5();
    const copy = structuredClone(pushIx(w));
    w.transaction.message.instructions.push(copy);
    if (change) {
      const d = base58.decode(copy.data);
      const at = Buffer.from(d).toString("hex").indexOf("00" + FEED.feedId.slice(2)) / 2;
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      v.setBigInt64(at + 33, v.getBigInt64(at + 33, false) * 2n, false);
      copy.data = base58.encode(d);
    }
    return w;
  };
  assert.ok(feedWritePrice(twice(false)), "the same message twice");
  assert.equal(feedWritePrice(twice(true)), null);
  assert.equal(await blockUsd(twice(true)), undefined);
});

test("D17: at most FEED_READS_MAX feed transactions are read for one sale: the write past them is not reached", async () => {
  const readers = (n: number) => Array.from({ length: n }, (_, i) => `Reader${i}`);
  assert.equal(await blockUsd(write5(), async () => [...readers(FEED_READS_MAX - 1), W5]), "0.04768764243129345", "the write the last read");
  assert.equal(await blockUsd(write5(), async () => [...readers(FEED_READS_MAX), W5]), undefined, "one read past");
});
