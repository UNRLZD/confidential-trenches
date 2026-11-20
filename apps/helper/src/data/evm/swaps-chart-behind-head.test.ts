// node --test apps/helper/src/data/evm/swaps-chart-behind-head.test.ts: card every-tape-and-chart-says-filling-behind-
// the-head. A Base or Robinhood live chart (no `to`) is served as current only while its book is read to within
// BEHIND_MAX of the newest head the helper has read and that head was read within BEHIND_MAX's ms, as the tape is (card
// base-tape-never-complete-behind-the-index); otherwise it says filling, its bars as held, and names the block it is
// read to (Server-Timing evm-read-to). A page of older bars (`to` set) is history, judged by nothing here. Before the
// card a chart's last bar was drawn as current however far its book was behind (live run 44228233209's tape was 232
// blocks behind). Here the providers answer heads while every log read is refused, so the book stays behind.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as base from "../../../test/evm-swaps/base.ts";
import * as rh from "../../../test/evm-swaps/robinhood.ts";
import { BEHIND_MAX, type createSwaps, type EvmSwaps } from "./swaps.ts";

/** The fake chain's fetch, every batch that asks eth_getLogs refused (503) while `st.refuse` is set; heads answer. */
function refusingLogs(fetch: (url: string, init: RequestInit) => Promise<Response>) {
  const st = { refuse: false };
  return { st, fetch: (url: string, init: RequestInit): Promise<Response> => (st.refuse && String(init.body).includes("eth_getLogs") ? Promise.resolve(new Response("busy", { status: 503 })) : fetch(url, init)) };
}
type Chart = { status: number; body: { candles: number[][]; filling?: true; as_of_ms: number }; timing: string };
const chart = async (s: EvmSwaps, token: string, to: number | null = null): Promise<Chart> => {
  const a = await s.candles(token, "1m", to, 2);
  return { status: a.status, body: JSON.parse(a.body), timing: a.timing ?? "" };
};

type Over = Partial<Parameters<typeof createSwaps>[1]>;
type Rig = { st: { head: number }; fetch: (url: string, init: RequestInit) => Promise<Response>; open: (clock: { t: number }, over: Over) => EvmSwaps };
const CHAINS = [
  { chain: "base" as const, token: base.ICNT, start: base.REC.firstHead + 200, rig: (): Rig => ((c) => ({ st: c.st, fetch: c.fetch, open: (clock, over) => base.open(c, clock, over) }))(base.fakeChain()) },
  { chain: "robinhood" as const, token: rh.MAG, start: rh.REC.lastHead - 200, rig: (): Rig => ((c) => ({ st: c.st, fetch: c.fetch, open: (clock, over) => rh.open(c, clock, { index: rh.URLS, ...over }) }))(rh.fakeChain()) },
];

for (const c of CHAINS) {
  const { blocks, ms } = BEHIND_MAX[c.chain];
  test(`${c.chain}: a live chart whose book is held behind the head says filling, never current: ${blocks} blocks behind is current, ${blocks + 1} filling with its bars, a page with \`to\` never; read up to the head again it is current`, async () => {
    const chain = c.rig();
    const net = refusingLogs(chain.fetch);
    const clock = { t: 5_000_000 };
    chain.st.head = c.start;
    const s = chain.open(clock, { fetch: net.fetch as never });
    try {
      for (let i = 0; i < 4 && (await chart(s, c.token)).body.filling === true; i++) await s.tick();
      const first = await chart(s, c.token);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.filling, undefined, `the chart read to the head is current: ${JSON.stringify(first.body).slice(0, 200)}`);
      assert.equal(first.body.candles.length, 2);
      assert.match(first.timing, new RegExp(`evm-read-to;desc="block ${c.start} of head ${c.start}, read 0 s ago"`), first.timing);
      const to = first.body.candles[0]![0]!;

      net.st.refuse = true;
      chain.st.head = c.start + blocks;
      await s.tick();
      assert.deepEqual((await chart(s, c.token)).body, first.body, `${blocks} blocks behind the head read: current, as it was`);

      chain.st.head = c.start + blocks + 1;
      await s.tick();
      const late = await chart(s, c.token);
      assert.equal(late.status, 200, "held bars are still served, never a 503");
      assert.equal(late.body.filling, true, `${blocks + 1} blocks behind the head read: filling, never current`);
      assert.deepEqual(late.body.candles, first.body.candles, "the bars it holds");
      assert.equal(late.body.as_of_ms, first.body.as_of_ms, "dated by its last read");
      assert.match(late.timing, new RegExp(`evm-read-to;desc="block ${c.start} of head ${c.start + blocks + 1}`), late.timing);
      const page = await chart(s, c.token, to);
      assert.equal(page.body.filling, undefined, "a page of bars before `to` is history: not filling for the book's lag");

      net.st.refuse = false;
      await s.tick();
      assert.equal((await chart(s, c.token)).body.filling, undefined, "read up to the head again: current");
    } finally {
      s.stop();
    }
  });

  test(`${c.chain}: a live chart whose head was read more than ${ms} ms ago says filling; read again it is current`, async () => {
    const chain = c.rig();
    const clock = { t: 5_000_000 };
    chain.st.head = c.start;
    const s = chain.open(clock, {});
    try {
      for (let i = 0; i < 4 && (await chart(s, c.token)).body.filling === true; i++) await s.tick();
      const first = await chart(s, c.token);
      assert.equal(first.body.filling, undefined, "current when read");
      clock.t += ms;
      assert.equal((await chart(s, c.token)).body.filling, undefined, `${ms} ms after its head's read: current`);
      clock.t += 1;
      const late = await chart(s, c.token);
      assert.equal(late.body.filling, true, `${ms + 1} ms after its head's read: filling`);
      assert.deepEqual(late.body.candles, first.body.candles);
      await s.tick();
      assert.equal((await chart(s, c.token)).body.filling, undefined, "read again: current");
    } finally {
      s.stop();
    }
  });
}
