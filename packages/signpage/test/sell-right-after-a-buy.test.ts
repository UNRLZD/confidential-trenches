// Card sell-right-after-a-buy: a sale tapped right after a Solana pool buy's Filled (its route's amount out, read back on
// both RPCs at confirmed) finds W, its token and the amount W received from that moment: the sale's wallet plan, the
// sell box's preview and the page's positions. The finder reads at finalized, and the buy's note turns SPENT only at
// its settle, so neither knows W's token yet. W's buy record (meta owed/cost-sol) is written at the read-back, not at
// the run's end; it is only where to look: every sale reads W's token on both RPCs before it signs. Devnet runs 11 and
// 12 (11 Nov): the preview answered not_funded for 54 s after the buy's Filled.
//   node --test test/sell-right-after-a-buy.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { base58, base64 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { fx, providers, rent as RENT } from "../../kit/test/solana-pool-buy-fx.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { solanaAta } from "../../kit/src/checks/solana/message.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import type { Holdings, HoldingsReader } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { POSITION_COSTS_KEY, positionsPass, type FoundWallet } from "../src/positions.ts";
import { testnetPool } from "../src/pool-testnet.ts";
import { planPoolSell, runPoolSell, type PoolSellHost } from "../src/pool-sell.ts";
import { poolSellDry } from "../src/pool-sell-dry.ts";
import { tokenDecimalsKept } from "../src/pool-kinds.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN = { program: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" }; // the devnet pool
const SCOPE = solanaPoolOf(PIN.program).scope;
/** The recorded pump coin (6 decimals): the preview's quote replays both providers' recorded reads of it. */
const MINT = fx.pump.mint as string;
const STRANGER = "Mint3333333333333333333333333333333333333333";
const OUT = "4000000"; // what W received, as the buy's read-back tells it
const OUT_UNITS = 4_000_000_000_000n;
const PRICE = { price: "15000000000", expo: -8, published_s: 1, read_ms: 1 };
const REF: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const LABEL = 77n;
const W = ((): string => {
  const fw = freshWallet(SEED64, "sol", LABEL, jOf(REF));
  fw.secretKey.fill(0);
  return fw.address;
})();
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
const until = async (f: () => boolean | Promise<boolean>, what = "the condition") => {
  for (let i = 0; i < 400 && !(await f()); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(await f(), what);
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A wallet store whose one note a buy took and sent: RESERVED, its proof gone (the state at the buy's "sent"). */
async function sentWallet(): Promise<WalletStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  const precommitment = noteSecrets(SEED64, REF).precommitment;
  let n = await ns.add({ ref: REF, scope: SCOPE, precommitment, state: "UNSPENT", leaf: { value: 10_000_000n, label: LABEL, commitment: noteCommitment(10_000_000n, LABEL, precommitment), leafIndex: 0n } });
  n = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 1_000n, context: "1" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt! });
  ns.close();
  return w;
}
/** The note freed (both RPCs' block time past its deadline with no spent mark: solana-restore.ts solanaSettleReserved). */
async function freed(w: WalletStore): Promise<void> {
  const ns = await openNoteStore(w);
  const n = (await ns.list())[0]!;
  await ns.move(n.id, "RESERVED", "UNSPENT", { blockTimeMs: 2_000n });
  ns.close();
}

/** The finder, which reads at finalized: W known (its note RESERVED), its token not listed until `listed` is set. */
function finder() {
  const st = { listed: null as bigint | null, fail: false, failW: false, reads: 0, held: null as Promise<void> | null };
  const reader: HoldingsReader = {
    chain: "sol",
    read: async (address) => {
      st.reads++;
      if (st.held !== null) await st.held;
      if (st.fail) throw new Error("the finder did not answer");
      if (st.failW) throw new Error("its reads drew the provider's 429");
      assert.equal(address, W);
      const tokens = new Map([[STRANGER, { amount: 1n, frozen: false }], ...(st.listed === null ? [] : [[MINT, { amount: st.listed, frozen: false }] as const])]);
      return { native: 0n, tokens, unreadable: [] } as Holdings;
    },
  };
  return { st, reader };
}

const mintData = (() => {
  const d = new Uint8Array(82);
  d[44] = 6;
  d[45] = 1;
  return d;
})();
const tokenAccount = (amount: bigint): Uint8Array => {
  const d = new Uint8Array(165);
  d.set(base58.decode(MINT), 0);
  d.set(base58.decode(W), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  return d;
};
const ATA = solanaAta(W, MINT, SOLANA_TOKEN_PROGRAM);
/** The page's pair at confirmed: the mint, and W's token account holding `held[k]` on RPC k (null: no account). Every
 *  call logged. Answers getAccountInfo and getMultipleAccounts, so a sale reading W's accounts either way reads them. */
function pair(held: [bigint | null, bigint | null], log: string[] = [], behind?: { rpc: 0 | 1; reads: number }): readonly [SolanaRpc, SolanaRpc] {
  // `behind`: that RPC a slot or two behind the other, so it holds no token account of W's for its first `reads` reads of it
  let ataReads = 0;
  const lags = (k: number) => behind !== undefined && behind.rpc === k && ataReads++ < behind.reads;
  const acct = (k: number, a: string) =>
    a === MINT ? { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: [base64.encode(mintData), "base64"] }
    : a === ATA ? (held[k] === null || lags(k) ? null : { owner: SOLANA_TOKEN_PROGRAM, lamports: 2_039_280, data: [base64.encode(tokenAccount(held[k]!)), "base64"] })
    : a === W ? { owner: "11111111111111111111111111111111", lamports: 50_000_000, data: ["", "base64"] }
    : null;
  return [0, 1].map((k) => (async (method: string, params: readonly unknown[]) => {
    log.push(`${k} ${method}`);
    if (method === "getAccountInfo") return { context: { slot: 10 }, value: acct(k, params[0] as string) };
    if (method === "getMultipleAccounts") return { context: { slot: 10 }, value: (params[0] as string[]).map((a) => acct(k, a)) };
    throw new Error(`not asked here: ${method}`);
  }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
}

/** A stand-in pool buy run, as pool-buy.ts runs one: W's buy mint written before the send, W told once bound, then at
 *  the read-back the early answer "sent" (the app's Filled), the token's decimals and the amount W received; its end
 *  only when `end` is called, as progress (poolBuyKind posts its end stage so). */
function buyKind() {
  const run = { end: (_stage: string) => {}, told: false };
  const kind = (host: () => { bought?: { put(a: string, m: { mint: string; program: string }): Promise<void> }; outDecimals?(w: string, d: number, mint: string): void }) => (_ask: unknown, ctx: { route?: (r: unknown) => void; progress: (s: string) => void }) => {
    let answered!: () => void;
    let answer: unknown = null;
    const after = new Promise<void>((r) => (answered = r));
    void (async () => {
      const h = host();
      await h.bought?.put(W, { mint: MINT, program: SOLANA_TOKEN_PROGRAM });
      ctx.route?.({ wallet: W });
      answer = { result: { stage: "sent", txs: [{ chain: "solana", hash: "SigB" }] } };
      answered();
      h.outDecimals?.(W, 6, MINT);
      ctx.route?.({ out: OUT });
      run.told = true;
    })();
    run.end = (stage) => ctx.progress(stage);
    return { running: true as const, after, answer: () => answer };
  };
  return { run, kind };
}

type Page = ReturnType<typeof testnetPool>;
function page(w: WalletStore, f: ReturnType<typeof finder>, rpcs: readonly [SolanaRpc, SolanaRpc], kinds: Record<string, unknown> = {}): Page {
  return testnetPool(
    { store: async () => w, seed64: async () => SEED64.slice(), price: () => PRICE },
    { pin: PIN, rpcs, table: "Table111111111111111111111111111111111111111", holdings: () => f.reader, tradeKinds: kinds, positions: { setTimer: () => {}, clearTimer: () => {} } } as never,
  );
}
const tapBuy = (tp: Page, id = "pb1") => tp.flow({ kind: "pool.buy", chain: "solana", token: MINT, amount: 10_000_000n, slippageBps: 100, decimals: 9 }, { id, sha: "00", progress: () => {}, route: () => {} } as never);
const rowOf = async (tp: Page) => ((await tp.positions()) ?? []).find((p) => p.token === MINT);

/** The sell box's preview on the page's held positions, its quote on the recorded pair, W's lamports read. */
function preview(tp: Page) {
  const mintRead = Object.entries(fx.pump.reads[0]).find(([k]) => JSON.parse(k)[0] === MINT)![1] as { context: unknown; value: unknown[] };
  const rec = providers("pump").map((rpc) => (async (method: string, params: readonly unknown[]) => {
    if (method === "getAccountInfo") return { context: mintRead.context, value: mintRead.value[0] };
    const list = params[0] as string[];
    if (list.includes(W)) return { context: { slot: 1 }, value: list.map((a) => (a === W ? { lamports: 1_000_000_000, owner: "11111111111111111111111111111111", data: ["", "base64"] } : null)) };
    return rpc(method, params);
  }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
  return poolSellDry({ pinned: () => true, rpcs: () => rec, positions: () => tp.positionsNow(), rent: () => RENT, decimals: tokenDecimalsKept(), trading: () => false }, { chain: "solana", token: MINT, share_bps: 10_000, slippage_bps: 1000 });
}

test("from the buy's read-back, before its end: W's record is written, the positions show W's token at the amount it received, and the preview answers a number; no ops record says the buy ended", async () => {
  const w = await sentWallet();
  const f = finder();
  const b = buyKind();
  const tp = page(w, f, pair([OUT_UNITS, OUT_UNITS]), { buy: b.kind });
  await until(async () => (await tp.positions()) !== null);
  assert.equal((await preview(tp) as { error?: string }).error, "not_funded", "nothing bought yet");
  assert.ok("running" in tapBuy(tp));
  await until(() => b.run.told, "the run told its amount");
  await until(async () => (await rowOf(tp)) !== undefined, "the row from the read-back, the finder still listing no token");
  assert.deepEqual(await rowOf(tp), { chain: "solana", token: MINT, amount: OUT, cost: "1.5", wallets: [W], decimals: 6 });
  assert.deepEqual(((await w.get("meta", POSITION_COSTS_KEY)) as Record<string, unknown>)[W], { mint: MINT, received: OUT, decimals: 6, cost_usd: "1.5" }, "the record a filled end writes, the same fields");
  assert.equal(await w.get("ops", "pb1"), undefined, "no ops record: nothing says the buy is Final");
  const a = (await preview(tp)) as { result?: { out: string } };
  assert.ok(a.result && /^\d+\.\d+$/.test(a.result.out) && Number(a.result.out) > 0, `the preview answers a number: ${JSON.stringify(a)}`);
});

test("a reload between the read-back and Final keeps the holding: the record is stored, the next page's positions and preview have it", async () => {
  const w = await sentWallet();
  const f = finder();
  const b = buyKind();
  const tp = page(w, f, pair([OUT_UNITS, OUT_UNITS]), { buy: b.kind });
  await until(async () => (await tp.positions()) !== null);
  tapBuy(tp);
  await until(() => b.run.told);
  await until(async () => (await rowOf(tp)) !== undefined);
  // the tab closes before the buy's end: a new page on the same store, the finder still at the state before the buy
  const again = page(w, f, pair([OUT_UNITS, OUT_UNITS]));
  await again.positions();
  await until(async () => (await rowOf(again))?.amount === OUT, "the reloaded page's row");
  assert.ok("result" in (await preview(again)), "its preview answers a number");
});

test("the holding ends when the finalized finder lists W's token: the finder's amount, one row, never the two added", async () => {
  const w = await sentWallet();
  const f = finder();
  const b = buyKind();
  const tp = page(w, f, pair([OUT_UNITS, OUT_UNITS]), { buy: b.kind });
  await until(async () => (await tp.positions()) !== null);
  tapBuy(tp);
  await until(async () => (await rowOf(tp)) !== undefined);
  f.st.listed = 3_500_000_000_000n; // a share sold meanwhile: the chain's word, not the record's
  b.run.end("filled");
  await until(async () => (await rowOf(tp))?.amount === "3500000", "the finder's amount");
  assert.equal(((await tp.positions()) ?? []).filter((p) => p.token === MINT).length, 1);
});

test("a buy that did not stay: a not_landed end (both RPCs' verdict) drops W's record, a run that ended unknown (reads failed, throttled or out of time: sent) keeps it", async () => {
  for (const end of ["not_landed", "sent"] as const) {
    const w = await sentWallet();
    const f = finder();
    const b = buyKind();
    const tp = page(w, f, pair([OUT_UNITS, OUT_UNITS]), { buy: b.kind });
    await until(async () => (await tp.positions()) !== null);
    tapBuy(tp);
    await until(async () => (await rowOf(tp)) !== undefined);
    b.run.end(end);
    await tick(60);
    await until(async () => ((await w.get("ops", "pb1")) !== undefined) === (end === "not_landed"), `${end}: its ops record`);
    const recW = ((await w.get("meta", POSITION_COSTS_KEY)) as Record<string, unknown> | undefined)?.[W];
    if (end === "not_landed") {
      assert.equal(recW, undefined, "not_landed: W's record dropped");
      await until(async () => (await rowOf(tp)) === undefined, "and its row gone");
    } else {
      assert.deepEqual(recW, { mint: MINT, received: OUT, decimals: 6, cost_usd: "1.5" }, "sent: the record stays");
      assert.equal((await rowOf(tp))?.amount, OUT, "and its row");
    }
  }
});

test("a W whose note went back UNSPENT (never landed) is no row; a finder that fails, or a W read that fails, keeps the row", async () => {
  const w = await sentWallet();
  const f = finder();
  const b = buyKind();
  const tp = page(w, f, pair([OUT_UNITS, OUT_UNITS]), { buy: b.kind });
  await until(async () => (await tp.positions()) !== null);
  tapBuy(tp);
  await until(async () => (await rowOf(tp)) !== undefined);
  // the pass itself, on the page's reads: each case from the record and W's buy mint
  const st = { costs: (await w.get("meta", POSITION_COSTS_KEY)) as Record<string, never>, bought: { [W]: { mint: MINT, program: SOLANA_TOKEN_PROGRAM } } };
  const pass = (wallets: () => Promise<readonly FoundWallet[]>) => positionsPass({ wallets: async () => wallets(), decimals: async () => 6, bought: async () => st.bought, costs: async () => st.costs });
  const amountOf = (r: Awaited<ReturnType<typeof pass>>) => r.positions.find((p) => p.token === MINT)?.amount;
  assert.equal(amountOf(await pass(async () => Promise.reject(new Error("the finder did not answer")))), OUT, "the finder down: the row stays");
  assert.equal(amountOf(await pass(async () => [{ address: W, tokens: null }])), OUT, "W's read failed: the row stays");
  assert.equal(amountOf(await pass(async () => [])), undefined, "a whole list without W: its note is not spent, no row");
  // the page: the note freed, the next pass has no row for it
  await freed(w);
  tapBuy(tp, "pb2"); // any trade's end reads the positions again; this stand-in run tells W again, its record kept
  await until(async () => (await rowOf(tp)) === undefined, "freed: no row");
});

test("the sale's plan right after the read-back: the finder lists no token in W, W's buy mint names it, and both RPCs' read of W decides; gone on both: not_funded, nothing signed", async () => {
  const w = await sentWallet();
  const f = finder();
  let made!: () => PoolSellHost;
  const b = buyKind();
  page(w, f, pair([OUT_UNITS, OUT_UNITS]), { buy: b.kind, sell: (mk: () => PoolSellHost) => ((made = mk), () => ({ error: "busy" })) });
  await buyKindMint(w);
  const ask = { kind: "pool.sell", chain: "solana", token: MINT, amount: 0n, shareBps: 10_000, slippageBps: 1000, decimals: 6 } as const;
  const plan = await planPoolSell(made(), ask);
  assert.deepEqual(plan.legs.map((l) => [l.w.address, l.units]), [[W, OUT_UNITS]], "W found, its units both RPCs' read");
  assert.equal(f.st.reads >= 1, true, "the finder was read, and listed no token in W");
  // the buy did not stay: both RPCs read no token account of W's
  const log: string[] = [];
  const gone = Object.assign(Object.create(made()) as PoolSellHost, { rpcs: pair([null, null], log) });
  assert.deepEqual(await runPoolSell(gone, ask), { error: "not_funded" });
  assert.ok(!log.some((x) => /simulateTransaction|sendTransaction|getLatestBlockhash|getFeeForMessage/.test(x)), `nothing built or sent: ${log.join(", ")}`);
});
/** W's buy mint, as the buy writes it before its send (pool-buy.ts h.bought.put). */
async function buyKindMint(w: WalletStore): Promise<void> {
  await w.update("meta", "owed/buy-sol", (v) => ({ ...((v as object) ?? {}), [W]: { mint: MINT, program: SOLANA_TOKEN_PROGRAM } }));
}

// Item 5 of this card: a sale tapped about 1 s after Filled, its two providers a slot apart (one holds no token account of W's
// yet). Today pool-sell.ts ataHeld reads both twice back to back and refuses "failed" (on this branch, and as wHeld on the
// legs branch at 9871e0ea: two getMultipleAccounts on both, `continue` with no wait, then no()). It should wait the gap
// out, bounded, as the reference read does (card solana-reference-read-holds-a-slot-apart). Fixed once that branch lands.
test("item 5: a sale planned while one provider is a slot behind on W's token account waits it out, bounded, and plans W", { todo: "after card pool-sell-legs-side-by-side lands (its wHeld)" }, async () => {
  const w = await sentWallet();
  let made!: () => PoolSellHost;
  page(w, finder(), pair([OUT_UNITS, OUT_UNITS]), { sell: (mk: () => PoolSellHost) => ((made = mk), () => ({ error: "busy" })) });
  await buyKindMint(w);
  const ask = { kind: "pool.sell", chain: "solana", token: MINT, amount: 0n, shareBps: 10_000, slippageBps: 1000, decimals: 6 } as const;
  const log: string[] = [];
  // RPC 1 holds no token account of W's for its first 2 reads of it, as a provider a slot behind does for about 400 ms
  const lagging = Object.assign(Object.create(made()) as PoolSellHost, { rpcs: pair([OUT_UNITS, OUT_UNITS], log, { rpc: 1, reads: 2 }) });
  const plan = await planPoolSell(lagging, ask).catch((e: unknown) => ({ refused: String((e as Error)?.message ?? e), reads: log.length }));
  assert.ok("legs" in plan, `refused: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.legs.map((l) => [l.w.address, l.units]), [[W, OUT_UNITS]]);
});

// The review of 29a9e506 (P3): the end's records are written after W's early record, never beside it. A store slow on
// that write (another tab's transaction ahead of it) and an end told right after the amount out: a not_landed end still
// takes the record back, since its take-back runs once the early write is done.
test("the end's records wait for the early write: a not_landed end told at once after the amount out, the early write slow, leaves no record of W", async () => {
  const w = await sentWallet();
  let slow = true;
  const slowed = new Proxy(w, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (k !== "update") return typeof v === "function" ? v.bind(t) : v;
      return async (store: string, key: string, f: (v: unknown) => unknown) => {
        // the first write of W's record waits 50 ms before its transaction
        if (key === POSITION_COSTS_KEY && slow) (slow = false), await tick(50);
        return t.update(store as never, key, f as never);
      };
    },
  }) as WalletStore;
  const b = buyKind();
  const tp = page(slowed, finder(), pair([OUT_UNITS, OUT_UNITS]), { buy: b.kind });
  await until(async () => (await tp.positions()) !== null);
  tapBuy(tp);
  await until(() => b.run.told);
  b.run.end("not_landed");
  await until(async () => (await w.get("ops", "pb1")) !== undefined, "the end's ops record");
  await tick(120);
  assert.equal(((await w.get("meta", POSITION_COSTS_KEY)) as Record<string, unknown> | undefined)?.[W], undefined, "W's record taken back after the early write");
});

// Card app-sell-shows-what-you-receive, devnet run 116 (11 Nov): the sell box's preview answered not_funded 7.6 s past a
// buy's Filled, as long as the positions pass's finder read of W waited on its lane, while a sale planned W at once. With
// the page's own source for the Ws bought since the last pass (pool-testnet.ts boughtSince, as the sale's plan finds W:
// its buy mint), the preview reads W itself as the sale does: a number on its first ask, the finder still not answering,
// and no finder read of its own; W's token account gone on both (a buy that did not stay): not_funded, as the sale.
test("the preview right after a buy's read-back, the pass's finder read still held: a number for W's amount on the first ask, no finder read; W empty on both: not_funded", async () => {
  const w = await sentWallet();
  const f = finder();
  const b = buyKind();
  const tp = page(w, f, pair([OUT_UNITS, OUT_UNITS]), { buy: b.kind });
  await until(async () => (await tp.positions()) !== null);
  // the finder's next read waits (a pass read held on its host's lane)
  let free!: () => void;
  f.st.held = new Promise<void>((r) => (free = r));
  assert.ok("running" in tapBuy(tp));
  await until(() => b.run.told, "the run told its amount");
  assert.equal((tp.positionsNow() ?? []).find((p) => p.token === MINT), undefined, "the pass has not listed W's token yet");
  const mintRead = Object.entries(fx.pump.reads[0]).find(([k]) => JSON.parse(k)[0] === MINT)![1] as { context: unknown; value: unknown[] };
  const ask = (held: [bigint | null, bigint | null]) => {
    const own = pair(held);
    const rec = providers("pump").map((rpc, k) => (async (method: string, params: readonly unknown[]) => {
      if (method === "getAccountInfo") return { context: mintRead.context, value: mintRead.value[0] };
      const list = params[0] as string[];
      // W's own read, as the sale's plan reads it: its token account first
      if (list[0] === ATA) return own[k as 0 | 1]!(method, params);
      if (list.length === 1 && list[0] === solanaPoolOf(PIN.program).pool) return { context: { slot: 1 }, value: [null] };
      return rpc(method, params);
    }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
    return poolSellDry({ pinned: () => true, rpcs: () => rec, positions: () => tp.positionsNow(), bought: (t) => tp.boughtSince(t), pin: () => PIN, rent: () => RENT, decimals: tokenDecimalsKept(), trading: () => false }, { chain: "solana", token: MINT, share_bps: 10_000, slippage_bps: 1000 });
  };
  const reads = f.st.reads;
  const a = (await ask([OUT_UNITS, OUT_UNITS])) as { result?: { out: string } };
  assert.ok(a.result && Number(a.result.out) > 0, `a number on the first ask: ${JSON.stringify(a)}`);
  assert.equal(f.st.reads, reads, "the preview reads no finder");
  assert.deepEqual(await ask([null, null]), { error: "not_funded" }, "W holds nothing on both: as the sale, nothing");
  free();
});
