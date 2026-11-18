// node --test apps/helper/src/data/evm/swaps-index-restart.test.ts: card helper-evm-tapes-survive-a-restart, on the
// Robinhood swap reader (swaps.ts with the chain's swap index on disk, index-store.ts). A restarted helper serves a
// coin's tape and chart from the copy the old one wrote, with no chain-wide read of the window it holds; a copy behind
// the head reads only the blocks since, and gives the tape and chart a fresh helper's reads give.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CURVE_TOKEN, fakeChain, MAG, open, REC, URLS } from "../../../test/evm-swaps/robinhood.ts";

const follow = (s: ReturnType<typeof open>) => (s as { follow?: () => Promise<boolean> }).follow?.();
const bodyOf = async (a: Promise<{ status: number; body: string }>) => {
  const r = await a;
  assert.equal(r.status, 200, r.body);
  return JSON.parse(r.body) as { trades?: { tx: string; t_ms: number; usd: string }[]; candles?: unknown[]; filling?: boolean };
};
const rows = (b: { trades?: { tx: string; t_ms: number; usd: string }[] }) => (b.trades ?? []).map((t) => [t.tx, t.t_ms, t.usd]);

function file(t: { after: (f: () => void) => void }): string {
  const d = mkdtempSync(join(tmpdir(), "swaps-index-restart-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return join(d, "swap-index-robinhood.sqlite");
}

/** The old helper: its index read to `head` and written to `indexFile`, then stopped. */
async function oldHelper(indexFile: string, head: number) {
  const chain = fakeChain();
  chain.st.head = head;
  const s = open(chain, undefined, { index: URLS, indexFile });
  assert.equal(await follow(s), true);
  const tapes = { mag: await bodyOf(s.trades(MAG, 50)), curve: await bodyOf(s.trades(CURVE_TOKEN, 50)) };
  s.stop();
  assert.ok(chain.st.wide > 0);
  return tapes;
}

test("a restarted helper serves a coin's tape and chart from the saved index: no chain-wide read, no read of the coin's own", async (t) => {
  const f = file(t);
  const was = await oldHelper(f, REC.lastHead);
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const s = open(chain, undefined, { index: URLS, indexFile: f });
  const mag = await bodyOf(s.trades(MAG, 50));
  const curve = await bodyOf(s.trades(CURVE_TOKEN, 50));
  const bars = await bodyOf(s.candles(MAG, "1m", null, 500));
  s.stop();
  assert.ok(rows(mag).length > 5);
  assert.deepEqual(rows(mag), rows(was.mag));
  assert.deepEqual(rows(curve), rows(was.curve));
  assert.ok((bars.candles ?? []).length > 0);
  assert.equal(chain.st.wide, 0, "the window held on disk is not read again");
  assert.equal(chain.st.own, 0, "no eth_getLogs of one token's swaps");
});

test("a copy behind the head reads only the blocks since, and serves what a fresh helper's reads serve", async (t) => {
  const f = file(t);
  const GAP = 30;
  await oldHelper(f, REC.lastHead - GAP);
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const s = open(chain, undefined, { index: URLS, indexFile: f });
  assert.equal(await follow(s), true);
  const mag = await bodyOf(s.trades(MAG, 50));
  s.stop();
  assert.equal(chain.st.own, 0, "no eth_getLogs of one token's swaps");
  assert.ok(chain.st.wide > 0 && chain.st.spans.every((n) => n <= GAP), `only the ${GAP} blocks since: spans ${chain.st.spans.join(",")}`);
  const fresh = fakeChain();
  fresh.st.head = REC.lastHead;
  const p = open(fresh, undefined, { index: URLS });
  await follow(p);
  const want = await bodyOf(p.trades(MAG, 50));
  p.stop();
  assert.ok(fresh.st.spans.some((n) => n > GAP), "a fresh helper reads the window");
  assert.deepEqual(rows(mag), rows(want));
});
