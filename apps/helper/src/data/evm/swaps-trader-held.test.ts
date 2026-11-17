// node --test apps/helper/src/data/evm/swaps-trader-held.test.ts: card evm-tape-trader-never-null. The chain tape
// served a row whose trader lookup had not landed by OPEN_BOUND_MS with trader null (live run 43977576335: Robinhood
// 0x6a3c037a's trade 0x8d950a97, a bundle whose user operation's account 0x3e9741fd three providers name, served null
// under load; helper-tape-4337-trader BAD). Now such a row is held back and the answer says filling, as the vendor
// path holds a row whose receipt is not read (swaps.ts exactOf); a lookup answered TRADER_TRIES times with no trader
// ("can never be read") is served as it is, so no tape stays filling for it. On the virtual clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, ICNT, open, REC } from "../../../test/evm-swaps/base.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { HOLD_MS, OPEN_BOUND_MS, TRADER_TRIES } from "./swaps.ts";

type Row = { tx: string; trader: string | null };
type Body = { trades: Row[]; filling?: boolean; whole_ms?: number };

/** The Base fake with its transaction reads answered `lateMs` after the post, or with no transaction (`never`), or
 *  refused 429 every time (`refused`: no lookup is ever answered). */
function rig(lateMs: number, never = false, refused = false) {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  let txReads = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    if (!reqs.some((r) => r.method === "eth_getTransactionByHash")) return chain.fetch(url, init);
    txReads++;
    await new Promise((go) => setTimeout(go, lateMs));
    if (refused) return new Response("{}", { status: 429, headers: { "retry-after": "5" } });
    if (!never) return chain.fetch(url, init);
    return new Response(JSON.stringify(reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: null }))), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { chain, fetch, reads: () => txReads };
}

test("a row whose trader lookup lands after OPEN_BOUND_MS is held back, the answer filling, then served with its trader (red at 47de338c4: served with trader null)", async () => {
  const r = rig(OPEN_BOUND_MS + 4_000);
  const { value } = await onVirtualTime(5_000_000, async () => {
    const clock = { get t() { return Date.now(); } };
    const s = open(r.chain, clock, { fetch: r.fetch as never });
    try {
      const first = JSON.parse((await s.trades(ICNT, 50)).body) as Body;
      await new Promise((go) => setTimeout(go, 10_000));
      const later = JSON.parse((await s.trades(ICNT, 50)).body) as Body;
      return { first, later };
    } finally {
      s.stop();
    }
  });
  const nulls = (b: Body) => b.trades.filter((t) => t.trader === null).length;
  assert.equal(nulls(value.first), 0, `served with no trader: ${JSON.stringify(value.first.trades.slice(0, 2))}`);
  assert.equal(value.first.filling, true, "rows held back with no filling");
  assert.equal(value.first.whole_ms, undefined, "a reach claimed while rows are held");
  assert.ok(value.later.trades.length > value.first.trades.length, `the held rows never served: ${value.first.trades.length} then ${value.later.trades.length}`);
  assert.equal(nulls(value.later), 0);
  assert.ok(value.later.trades.every((t) => /^0x[0-9a-f]{40}$/.test(t.trader!)));
});

test("guard: a trader no provider can give (answered TRADER_TRIES times with no transaction) is served as it is, never held for ever", async () => {
  const r = rig(10, true);
  const { value } = await onVirtualTime(5_000_000, async () => {
    const clock = { get t() { return Date.now(); } };
    const s = open(r.chain, clock, { fetch: r.fetch as never });
    try {
      const seen: Body[] = [];
      for (let i = 0; i <= TRADER_TRIES; i++) {
        seen.push(JSON.parse((await s.trades(ICNT, 50)).body) as Body);
        await new Promise((go) => setTimeout(go, 1_000));
      }
      return seen;
    } finally {
      s.stop();
    }
  });
  const last = value.at(-1)!;
  assert.ok(value[0]!.trades.length === 0 && value[0]!.filling === true, `the first answer: ${JSON.stringify(value[0]).slice(0, 200)}`);
  assert.ok(last.trades.length > 0, `held for ever: ${value.map((b) => b.trades.length).join(", ")}`);
  assert.ok(r.reads() >= TRADER_TRIES);
});

test("guard: a row whose lookup is never answered (every transaction read refused, no try counted) waits HOLD_MS at most, then is served with trader null: no tape stays filling for it (red at b95fe35db: held for ever)", async () => {
  const r = rig(10, false, true);
  const { value } = await onVirtualTime(5_000_000, async () => {
    const clock = { get t() { return Date.now(); } };
    const s = open(r.chain, clock, { fetch: r.fetch as never });
    try {
      // the page's reads of a filling tape, 3 s apart, past HOLD_MS and OPEN_BOUND_MS together
      const seen: Body[] = [];
      for (let i = 0; i < Math.ceil((HOLD_MS + 2 * OPEN_BOUND_MS) / 3_000); i++) {
        seen.push(JSON.parse((await s.trades(ICNT, 50)).body) as Body);
        await new Promise((go) => setTimeout(go, 3_000));
      }
      return seen;
    } finally {
      s.stop();
    }
  });
  const shown = value.map((b) => b.trades.length);
  assert.ok(value[0]!.trades.length === 0 && value[0]!.filling === true, `the first answer did not hold its rows: ${shown.join(", ")}`);
  const last = value.at(-1)!;
  assert.ok(last.trades.length > 0, `held past HOLD_MS: ${shown.join(", ")}`);
  assert.ok(last.trades.every((t) => t.trader === null), "a trader named with no lookup answered");
  assert.ok(r.reads() > 0);
});
