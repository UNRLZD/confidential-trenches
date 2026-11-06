// A cold token page fills after (card token-page-fills-after, M384): the helper answers a token nobody opened yet with
// its row named on chain (src "chain": symbol and name from the mint, every Jupiter field null; helper card
// helper-page-jup-429, token.ts chainRow) and holds Jupiter's row for the next read. Its TokenPage `filling` is true
// while that row is still coming: the page draws the row with its null fields loading. A chain-named page that is not
// filling (a mint Jupiter does not list) draws the dash. Either way the page reads again every FILL_MS while the row is
// named on chain, until it is Jupiter's or the page closes. A row with no symbol is still the error state. The clock is
// a fake one handed in (FillDeps.later), as the chart's live reads are tested.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROW_FIELDS } from "../src/screens/discover/fields.ts";
import type { MarketRow } from "../src/screens/discover/fields.ts";
import { tokenView } from "../src/screens/token/model.ts";
import { FILL_MS, followToken, following, loadToken, TOKEN_URL } from "../src/screens/token/source.ts";
import type { TokenData } from "../src/screens/token/source.ts";

const MINT = "DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF";
const NOW_MS = Date.UTC(2026, 10, 6, 5, 0, 0);

/** The helper's chain-named row: every field null but the identity (token.ts chainRow on helper-page-jup-429). */
const chainRow = (o: Partial<MarketRow> = {}): MarketRow =>
  ({ ...Object.fromEntries(ROW_FIELDS.map((f) => [f, null])), chain: "solana", token: MINT, symbol: "ABC", name: "Abc Coin", icon: false, src: "chain", as_of_ms: NOW_MS, ...o }) as MarketRow;
/** The same token once Jupiter's row is in. */
const jupRow = (o: Partial<MarketRow> = {}): MarketRow =>
  chainRow({ src: "jupiter", price_usd: "0.00273", mc_usd: "27300", vol_24h_usd: "132700", liq_usd: "9810", holders: 2680, created_s: NOW_MS / 1000 - 2460, chg_24h_bps: 802, top10_bps: 2100, dev_bps: 300, ...o });

/** A helper that answers the token reads in turn (the last one again once they run out), counting them. */
function helper(answers: { status?: number; row?: unknown; filling?: unknown }[]) {
  let n = 0;
  const fetchFn: typeof fetch = async (input) => {
    assert.equal(String(input), TOKEN_URL(MINT, "solana"));
    const a = answers[Math.min(n, answers.length - 1)]!;
    n++;
    return new Response(JSON.stringify({ row: a.row, ...("filling" in a ? { filling: a.filling } : {}) }), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetchFn, reads: () => n };
}

/** A fake clock: `later` keeps each wait, `tick` runs the ones due and lets their reads land. */
function clock() {
  let at = 0;
  const waits: { due: number; fn: () => void; off: boolean }[] = [];
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    later: (fn: () => void, ms: number) => {
      const w = { due: at + ms, fn, off: false };
      waits.push(w);
      return () => void (w.off = true);
    },
    pending: () => waits.filter((w) => !w.off && w.due > at).map((w) => w.due - at),
    settle,
    async tick(ms: number) {
      const end = at + ms;
      for (;;) {
        const next = waits.filter((w) => !w.off && w.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        at = next.due;
        next.off = true;
        next.fn();
        await settle();
      }
      at = end;
    },
  };
}

type Ready = Extract<TokenData, { status: "ready" }>;
/** The page's values as TokenPage draws them: the row with the answer's `filling`. */
const viewOf = (d: TokenData) => tokenView((d as Ready).row, NOW_MS, (d as Ready).filling === true);

function follow(h: ReturnType<typeof helper>, c: ReturnType<typeof clock>, hidden = () => false) {
  const seen: TokenData[] = [];
  const stop = followToken(() => loadToken("solana", MINT, h.fetchFn), (d) => seen.push(d), { later: c.later, hidden });
  return { seen, stop };
}

test("a filling chain-named page with price_usd null draws the name and the price loading; a read 5 s later fills it, and reading stops", async () => {
  const h = helper([{ row: chainRow(), filling: true }, { row: jupRow(), filling: false }]);
  const c = clock();
  const { seen } = follow(h, c);
  await c.settle();
  assert.equal(h.reads(), 1);
  assert.equal(seen.length, 1);
  const first = seen[0]!;
  assert.equal(first.status, "ready");
  assert.equal(following(first), true);
  const v = viewOf(first);
  assert.equal(v.symbol, "ABC");
  assert.equal(v.name, "Abc Coin");
  assert.equal(v.filling, true);
  // null: the page draws the value's skeleton (TokenPage.tsx SkLine), not the dash of a value no source has
  for (const k of ["price", "priceTile", "mc", "vol", "liq", "holders", "age", "chg", "chgTile"] as const) assert.equal(v[k], null, k);
  assert.deepEqual(c.pending(), [FILL_MS]);
  assert.equal(FILL_MS, 5_000);

  await c.tick(FILL_MS - 1);
  assert.equal(h.reads(), 1, "no read before 5 s");
  await c.tick(1);
  assert.equal(h.reads(), 2, "the second read at 5 s");
  assert.equal(seen.length, 2);
  const filled = seen[1] as Extract<TokenData, { status: "ready" }>;
  assert.equal(following(filled), false);
  const w = viewOf(filled);
  assert.equal(w.price, "$0.00273");
  assert.equal(w.mc, "$27.3K");
  assert.equal(w.filling, false);
  assert.deepEqual(c.pending(), [], "reading stopped");
  await c.tick(60_000);
  assert.equal(h.reads(), 2);
});

test("a chain-named row keeps reading every 5 s while it fills; a held price draws, the rest still loading", async () => {
  const held = { row: chainRow({ price_usd: "0.0031", mc_usd: "31000" }), filling: true };
  const h = helper([{ row: chainRow(), filling: true }, held, held, { row: jupRow(), filling: false }]);
  const c = clock();
  const { seen } = follow(h, c);
  await c.settle();
  await c.tick(FILL_MS);
  const v = viewOf(seen[1]!);
  assert.equal(v.price, "$0.0031");
  assert.equal(v.holders, null);
  await c.tick(FILL_MS);
  await c.tick(FILL_MS);
  assert.equal(h.reads(), 4);
  assert.equal(following(seen.at(-1)!), false);
  await c.tick(60_000);
  assert.equal(h.reads(), 4);
});

test("a filled row reads once; its null fields are the dash (a value no source has), not loading", async () => {
  const h = helper([{ row: jupRow({ holders: null }) }]);
  const c = clock();
  const { seen } = follow(h, c);
  await c.settle();
  await c.tick(60_000);
  assert.equal(h.reads(), 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(c.pending(), []);
  const v = viewOf(seen[0]!);
  assert.equal(v.holders, "—");
});

test("a mint Jupiter does not list (chain-named, filling false) draws the dash, not loading, and still reads again every 5 s until Jupiter lists it", async () => {
  const h = helper([{ row: chainRow(), filling: false }, { row: chainRow(), filling: false }, { row: jupRow(), filling: false }]);
  const c = clock();
  const { seen } = follow(h, c);
  await c.settle();
  const v = viewOf(seen[0]!);
  assert.equal(v.filling, false);
  for (const k of ["price", "priceTile", "mc", "vol", "liq", "holders", "age", "chgTile"] as const) assert.equal(v[k], "—", k);
  assert.deepEqual(c.pending(), [FILL_MS], "it reads again");
  await c.tick(FILL_MS);
  assert.equal(h.reads(), 2);
  await c.tick(FILL_MS);
  assert.equal(h.reads(), 3);
  assert.equal(viewOf(seen.at(-1)!).price, "$0.00273", "listed later: filled without a reload");
  assert.deepEqual(c.pending(), []);
});

test("a helper that sends no filling field: no skeleton (the dash), and a chain-named row is still read again", async () => {
  const h = helper([{ row: chainRow() }, { row: jupRow() }]);
  const c = clock();
  const { seen } = follow(h, c);
  await c.settle();
  assert.equal((seen[0] as Ready).filling, false);
  assert.equal(viewOf(seen[0]!).price, "—");
  await c.tick(FILL_MS);
  assert.equal(h.reads(), 2);
  assert.deepEqual(c.pending(), []);
});

test("a row with no symbol is the error state, read once", async () => {
  for (const symbol of [null, ""]) {
    const h = helper([{ row: chainRow({ symbol: symbol as unknown as string }) }]);
    const c = clock();
    const { seen } = follow(h, c);
    await c.settle();
    await c.tick(60_000);
    assert.deepEqual(seen, [{ status: "error" }]);
    assert.equal(h.reads(), 1);
  }
});

test("closing the page stops the reads: before the next read, and during one in flight", async () => {
  const h = helper([{ row: chainRow(), filling: true }]);
  const c = clock();
  const { seen, stop } = follow(h, c);
  await c.settle();
  stop();
  await c.tick(60_000);
  assert.equal(h.reads(), 1);
  assert.equal(seen.length, 1);

  let release: () => void = () => undefined;
  let n = 0;
  const slow: typeof fetch = async () => {
    n++;
    if (n === 2) await new Promise<void>((r) => (release = r));
    return new Response(JSON.stringify({ row: n === 1 ? chainRow() : jupRow(), filling: n === 1 }), { status: 200 });
  };
  const c2 = clock();
  const seen2: TokenData[] = [];
  const stop2 = followToken(() => loadToken("solana", MINT, slow), (d) => seen2.push(d), { later: c2.later, hidden: () => false });
  await c2.settle();
  await c2.tick(FILL_MS);
  assert.equal(n, 2);
  stop2();
  release();
  await c2.settle();
  assert.equal(seen2.length, 1, "no answer handed on after the page closed");
  assert.deepEqual(c2.pending(), []);
});

test("a read again that answers another token is not drawn; the page keeps its own and reads again", async () => {
  const other = "So11111111111111111111111111111111111111112";
  let n = 0;
  const rows = [chainRow(), chainRow({ token: other, symbol: "XYZ" }), jupRow()];
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({ row: rows[Math.min(n++, rows.length - 1)] }), { status: 200 });
  const c = clock();
  const seen: TokenData[] = [];
  // a load that reads whatever token the helper answers for (as / does from its Trending column)
  followToken(async () => {
    const r = (await (await fetchFn("x")).json()) as { row: MarketRow };
    return { status: "ready", row: r.row };
  }, (d) => seen.push(d), { later: c.later, hidden: () => false });
  await c.settle();
  await c.tick(FILL_MS);
  assert.equal(n, 2);
  assert.equal(seen.length, 1, "the other token is not drawn");
  await c.tick(FILL_MS);
  assert.equal(n, 3);
  assert.equal(seen.length, 2);
  assert.equal((seen[1] as Extract<TokenData, { status: "ready" }>).row.token, MINT);
  assert.deepEqual(c.pending(), []);
});

test("a failed read again keeps the row drawn and tries 5 s later; a hidden page reads nothing", async () => {
  const h = helper([{ row: chainRow(), filling: true }, { status: 503 }, { row: jupRow(), filling: false }]);
  const c = clock();
  let away = false;
  const { seen } = follow(h, c, () => away);
  await c.settle();
  await c.tick(FILL_MS);
  assert.equal(h.reads(), 2);
  assert.equal(seen.length, 1, "the failed read is not drawn");
  away = true;
  await c.tick(FILL_MS * 3);
  assert.equal(h.reads(), 2, "no read while hidden");
  away = false;
  await c.tick(FILL_MS);
  assert.equal(h.reads(), 3);
  assert.equal(following(seen.at(-1)!), false);
  assert.deepEqual(c.pending(), []);
});
