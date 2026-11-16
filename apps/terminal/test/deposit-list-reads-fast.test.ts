// node --test apps/terminal/test/deposit-list-reads-fast.test.ts: the deposit sheet asks each pool coin's row on its own
// and draws it as it lands (card deposit-list-reads-fast). One ask of the list sends deposit.assets (the USDC rows, about
// 0.9 s) and one deposit.coin per pool chain (SOL on Solana, ETH on Base and Robinhood, each from its pool's floor, 1-3 s)
// all at once; the USDC rows are drawn as they land and each coin row in its own turn, in POOL_CHAINS order; an older
// signing page refuses deposit.coin not_allowed and lists the pool rows inside deposit.assets, which stay as it gave them;
// a held list's pool row stays until this ask's read of that coin answers; a superseded ask's late row is dropped. No real
// time is read: order and counts only.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DepositAsset, PoolChain } from "@blindfill/kit";
import * as Assets from "../src/screens/deposit/assets.ts";
import type { AssetsAsk } from "../src/screens/deposit/assets.ts";
import { assetOf } from "../src/screens/deposit/model.ts";
import type { Asset } from "../src/screens/deposit/model.ts";

const { ASSETS_FRESH_MS, createAssetsStore } = Assets;
const tick = () => new Promise((r) => setTimeout(r, 0));

// the kit's rows as the signing page answers them
const row = (origin_asset: string, chain: DepositAsset["chain"], symbol: string, min: string): DepositAsset => ({ origin_asset, chain, symbol, decimals: 6, min, max_usd: "1000" });
const USDC_K = [row("nep141:sol-usdc", "solana", "USDC", "1.02"), row("nep141:base-usdc", "base", "USDC", "1.03"), row("nep141:near-usdc", "near", "USDC", "1.01")];
const COIN_K: Record<PoolChain, DepositAsset> = {
  solana: row("nep141:sol.omft.near", "solana", "SOL", "0.008"),
  base: row("nep141:base.omft.near", "base", "ETH", "0.0004"),
  robinhood: row("nep141:rh.omft.near", "robinhood", "ETH", "0.0005"),
};
// the same rows as the sheet draws them
const USDC = USDC_K.map(assetOf);
const COIN: Record<PoolChain, Asset> = { solana: assetOf(COIN_K.solana), base: assetOf(COIN_K.base), robinhood: assetOf(COIN_K.robinhood) };
const withMin = (a: Asset, min: string): Asset => ({ ...a, min });

/** A signing page client the test answers by hand: every request is recorded as it is sent, before any answer. */
function fakeClient() {
  const sent: { kind: string; params: unknown; answer: (o: unknown) => void }[] = [];
  const client = {
    request(kind: string, params: unknown) {
      let answer!: (o: unknown) => void;
      const outcome = new Promise((r) => (answer = r));
      sent.push({ kind, params, answer });
      return { id: `r${sent.length}`, outcome };
    },
  };
  const of = (kind: string, chain?: PoolChain) => sent.filter((s) => s.kind === kind && (chain === undefined || (s.params as { chain?: string }).chain === chain));
  return { client, sent, of };
}

/** An ask the test answers by hand, with the late-row callback the store hands it. */
function asker() {
  const pending: ((v: Awaited<ReturnType<AssetsAsk>>) => void)[] = [];
  const coins: ((chain: PoolChain, row: Asset | null) => void)[] = [];
  const ask: AssetsAsk = (coin) => {
    coins.push(coin);
    return new Promise((r) => pending.push(r));
  };
  return { ask, pending, coins };
}

/** A tab's session store the test can read. */
function store() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
const saved = (s: ReturnType<typeof store>) => (JSON.parse(s.m.get("ct.deposit.assets") ?? "null") as { list: Asset[] | null } | null)?.list ?? null;

test("(a) one ask sends deposit.assets and one deposit.coin per pool chain at once, before any answer: the sheet's ask and a control's intent alike", () => {
  const ask = (Assets as Record<string, unknown>).assetsAsk as ((c: unknown) => AssetsAsk) | undefined;
  assert.equal(typeof ask, "function", "assets.ts exports the list's ask");
  for (const how of ["ask", "intent"] as const) {
    const f = fakeClient();
    const s = createAssetsStore({ now: () => 1_000_000 });
    s[how](ask!(f.client));
    assert.deepEqual(
      f.sent.map((x) => [x.kind, x.params]),
      [
        ["deposit.assets", {}],
        ["deposit.coin", { chain: "solana" }],
        ["deposit.coin", { chain: "base" }],
        ["deposit.coin", { chain: "robinhood" }],
      ],
      how,
    );
  }
});

test("(b) the USDC rows are drawn before any coin answers; each coin row then lands in its own turn, in POOL_CHAINS order whatever the arrival order", async () => {
  const storage = store();
  const s = createAssetsStore({ now: () => 2_000_000, storage });
  const a = asker();
  let heard = 0;
  s.subscribe(() => heard++);
  s.ask(a.ask);
  a.pending[0]!({ ok: true, list: USDC });
  await tick();
  assert.deepEqual(s.view(), { list: USDC, refused: null }, "the USDC rows wait on no coin");
  assert.equal(heard, 1);
  a.coins[0]?.("robinhood", COIN.robinhood);
  assert.deepEqual(s.view().list, [...USDC, COIN.robinhood]);
  assert.equal(heard, 2, "Robinhood's row is drawn as it lands");
  assert.deepEqual(saved(storage), [...USDC, COIN.robinhood], "and held in the session store");
  a.coins[0]?.("solana", COIN.solana);
  assert.deepEqual(s.view().list, [...USDC, COIN.solana, COIN.robinhood]);
  assert.equal(heard, 3);
  a.coins[0]?.("base", COIN.base);
  assert.deepEqual(s.view(), { list: [...USDC, COIN.solana, COIN.base, COIN.robinhood], refused: null });
  assert.equal(heard, 4);
  assert.deepEqual(saved(storage), [...USDC, COIN.solana, COIN.base, COIN.robinhood]);
});

test("(b) a coin row that lands before deposit.assets is in the list the moment deposit.assets answers", async () => {
  const s = createAssetsStore({ now: () => 2_500_000 });
  const a = asker();
  let heard = 0;
  s.subscribe(() => heard++);
  s.ask(a.ask);
  a.coins[0]?.("base", COIN.base);
  assert.deepEqual(s.view(), { list: null, refused: null }, "no list yet: a coin row alone draws nothing");
  assert.equal(heard, 0);
  a.pending[0]!({ ok: true, list: USDC });
  await tick();
  assert.deepEqual(s.view().list, [...USDC, COIN.base]);
  assert.equal(heard, 1, "one draw: the USDC rows and the landed coin together");
});

test("(c) an older signing page: deposit.coin refused not_allowed, deposit.assets carrying the pool rows: those rows kept as it gave them, none twice", async () => {
  const ask = (Assets as Record<string, unknown>).assetsAsk as ((c: unknown) => AssetsAsk) | undefined;
  assert.equal(typeof ask, "function", "assets.ts exports the list's ask");
  const f = fakeClient();
  const s = createAssetsStore({ now: () => 3_000_000 });
  s.ask(ask!(f.client));
  const all = [...USDC_K, COIN_K.solana, COIN_K.base, COIN_K.robinhood];
  for (const chain of ["solana", "base"] as const) f.of("deposit.coin", chain)[0]!.answer({ ok: false, error: { code: "not_allowed" } });
  f.of("deposit.assets")[0]!.answer({ ok: true, result: { assets: all } });
  await tick();
  assert.deepEqual(s.view(), { list: all.map(assetOf), refused: null }, "every row as deposit.assets gave it");
  f.of("deposit.coin", "robinhood")[0]!.answer({ ok: false, error: { code: "not_allowed" } });
  await tick();
  assert.deepEqual(s.view(), { list: all.map(assetOf), refused: null }, "a refused coin read never drops or doubles a row, nor sets a refusal");
  // a page whose deposit.assets still lists a pool row and whose deposit.coin answers it: the coin's row replaces it
  const g = fakeClient();
  const s2 = createAssetsStore({ now: () => 3_500_000 });
  s2.ask(ask!(g.client));
  g.of("deposit.assets")[0]!.answer({ ok: true, result: { assets: all } });
  await tick();
  g.of("deposit.coin", "base")[0]!.answer({ ok: true, result: { asset: { ...COIN_K.base, min: "0.0009" } } });
  await tick();
  assert.deepEqual(s2.view().list, [...USDC, COIN.solana, withMin(COIN.base, "0.0009"), COIN.robinhood], "one Base ETH row, the coin read's floor");
});

test("(d) a held list's pool row stays on screen until this ask's read of that coin answers, also after a page load", async () => {
  let t = 4_000_000;
  const storage = store();
  const s = createAssetsStore({ now: () => t, storage });
  const a = asker();
  s.ask(a.ask);
  a.pending[0]!({ ok: true, list: USDC });
  await tick();
  for (const chain of ["solana", "base", "robinhood"] as const) a.coins[0]?.(chain, COIN[chain]);
  const held = [...USDC, COIN.solana, COIN.base, COIN.robinhood];
  assert.deepEqual(s.view().list, held);
  t += ASSETS_FRESH_MS;
  // the sheet opening again, and the next page load (the held list read from the session store), each ask again
  const reloaded = createAssetsStore({ now: () => t, storage });
  for (const s2 of [s, reloaded]) {
    const b = asker();
    s2.ask(b.ask);
    assert.deepEqual(s2.view().list, held, "the held list is drawn while the ask is out");
    const usdc2 = USDC.map((x) => withMin(x, "1.05"));
    b.pending[0]!({ ok: true, list: usdc2 });
    await tick();
    assert.deepEqual(s2.view().list, [...usdc2, COIN.solana, COIN.base, COIN.robinhood], "the SOL and ETH rows never flicker away while their reads are out");
    b.coins[0]?.("solana", withMin(COIN.solana, "0.009"));
    assert.deepEqual(s2.view().list, [...usdc2, withMin(COIN.solana, "0.009"), COIN.base, COIN.robinhood], "Solana's answer replaces its row");
    b.coins[0]?.("base", null);
    assert.deepEqual(s2.view().list, [...usdc2, withMin(COIN.solana, "0.009"), COIN.robinhood], "Base refused, and deposit.assets did not list it: its row goes");
    assert.deepEqual(s2.view().refused, null);
  }
});

test("(e) a late coin row from a superseded ask is dropped; a coin row with no list held draws nothing and never sets a refusal", async () => {
  let t = 5_000_000;
  const storage = store();
  const s = createAssetsStore({ now: () => t, storage });
  const a = asker();
  s.ask(a.ask);
  a.pending[0]!({ ok: true, list: USDC });
  await tick();
  t += ASSETS_FRESH_MS;
  s.ask(a.ask);
  assert.equal(a.pending.length, 2, "a second ask is out");
  let heard = 0;
  s.subscribe(() => heard++);
  const before = storage.m.get("ct.deposit.assets");
  a.coins[0]?.("solana", withMin(COIN.solana, "0.5"));
  assert.deepEqual(s.view().list, USDC, "the first ask's late row is dropped");
  assert.equal(heard, 0);
  assert.equal(storage.m.get("ct.deposit.assets"), before, "and never saved");
  a.pending[1]!({ ok: true, list: USDC });
  await tick();
  a.coins[0]?.("base", COIN.base);
  a.coins[1]?.("solana", COIN.solana);
  assert.deepEqual(s.view().list, [...USDC, COIN.solana], "only the newest ask's rows land");
  // deposit.assets busy with no list held: the busy state stands, coin rows draw nothing over it
  const s3 = createAssetsStore({ now: () => 6_000_000 });
  const c = asker();
  s3.ask(c.ask);
  c.pending[0]!({ ok: false, code: "busy" });
  await tick();
  c.coins[0]?.("solana", COIN.solana);
  assert.deepEqual(s3.view(), { list: null, refused: "busy" });
  s3.stop();
});
