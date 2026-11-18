// node --test apps/helper/src/data/evm/swaps-behind-head.test.ts: card base-tape-never-complete-behind-the-index. A
// book's tape is served as complete (no `filling`, its `whole_ms`) only while the book is read to within BEHIND_MAX of
// the newest head the helper has read, and that head was read within BEHIND_MAX's ms. Live run 44228233209 (18 Nov
// 03:21Z) read Base 0x60858a4b's tape served at 03:21:36.95Z without swap 0x0323e3ae in block 58908377, 231 blocks
// behind the providers' head 58908608, and not filling: the page and index-evm-swaps took it as every trade. Here the
// providers keep answering heads while every log read is refused, so the book stays behind the heads read.
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
type Tape = { status: number; body: { trades: { tx: string }[]; filling?: true; whole_ms?: number; as_of_ms: number }; timing: string };
const read = async (s: { trades(t: string, n: number): Promise<{ status: number; body: string; timing?: string }> }, token: string): Promise<Tape> => {
  const a = await s.trades(token, 50);
  return { status: a.status, body: JSON.parse(a.body), timing: a.timing ?? "" };
};

type Over = Partial<Parameters<typeof createSwaps>[1]>;
/** A chain's fake providers: its head, its fetch, and the swaps opened on them. */
type Rig = { st: { head: number }; fetch: (url: string, init: RequestInit) => Promise<Response>; open: (clock: { t: number }, over: Over) => EvmSwaps };
const CHAINS = [
  { chain: "base" as const, token: base.ICNT, start: base.REC.firstHead + 200, rig: (): Rig => ((c) => ({ st: c.st, fetch: c.fetch, open: (clock, over) => base.open(c, clock, over) }))(base.fakeChain()) },
  // Robinhood's books read their blocks from the chain's index (INDEX_RPCS), the same rule on its tapes
  { chain: "robinhood" as const, token: rh.MAG, start: rh.REC.lastHead - 200, rig: (): Rig => ((c) => ({ st: c.st, fetch: c.fetch, open: (clock, over) => rh.open(c, clock, { index: rh.URLS, ...over }) }))(rh.fakeChain()) },
];

for (const c of CHAINS) {
  const { blocks, ms } = BEHIND_MAX[c.chain];
  test(`${c.chain}: an index held behind the head serves filling, never complete: ${blocks} blocks behind the newest head read is complete, ${blocks + 1} is filling with no whole_ms, and read up to it again it is complete`, async () => {
    const chain = c.rig();
    const net = refusingLogs(chain.fetch);
    const clock = { t: 5_000_000 };
    chain.st.head = c.start;
    const s = chain.open(clock, { fetch: net.fetch as never });
    try {
      for (let i = 0; i < 4 && (await read(s, c.token)).body.filling === true; i++) await s.tick();
      const first = await read(s, c.token);
      assert.equal(first.status, 200);
      assert.equal(first.body.filling, undefined, `the tape read to the head is complete: ${JSON.stringify(first.body).slice(0, 200)}`);
      assert.ok(Number.isSafeInteger(first.body.whole_ms), "with its reach");
      assert.match(first.timing, new RegExp(`evm-read-to;desc="block ${c.start} of head ${c.start}, read 0 s ago"`), first.timing);

      // the providers answer heads, never logs: the tick reads the head, the book stays at its block
      net.st.refuse = true;
      chain.st.head = c.start + blocks;
      await s.tick();
      const edge = await read(s, c.token);
      assert.equal(edge.body.filling, undefined, `${blocks} blocks behind the head read is still complete`);
      assert.deepEqual(edge.body, first.body, "the same complete tape");

      chain.st.head = c.start + blocks + 1;
      await s.tick();
      const late = await read(s, c.token);
      assert.equal(late.status, 200, "held rows are still served, never a 503");
      assert.equal(late.body.filling, true, `${blocks + 1} blocks behind the head read: filling, never complete`);
      assert.equal(late.body.whole_ms, undefined, "no reach: the rows are not every trade to the head");
      assert.deepEqual(late.body.trades, first.body.trades, "the rows it holds");
      assert.equal(late.body.as_of_ms, first.body.as_of_ms, "dated by its last read");
      assert.match(late.timing, new RegExp(`evm-read-to;desc="block ${c.start} of head ${c.start + blocks + 1}`), late.timing);

      // the providers answer logs again: read up to the head, complete
      net.st.refuse = false;
      await s.tick();
      const back = await read(s, c.token);
      assert.equal(back.body.filling, undefined, `read up to the head again: complete ${JSON.stringify(back.body).slice(0, 200)}`);
      assert.ok(Number.isSafeInteger(back.body.whole_ms));
    } finally {
      s.stop();
    }
  });

  test(`${c.chain}: a book whose head was read more than ${ms} ms ago serves filling, never complete, however near that head it is; read again it is complete`, async () => {
    const chain = c.rig();
    const clock = { t: 5_000_000 };
    chain.st.head = c.start;
    const s = chain.open(clock, {});
    try {
      for (let i = 0; i < 4 && (await read(s, c.token)).body.filling === true; i++) await s.tick();
      const first = await read(s, c.token);
      assert.equal(first.body.filling, undefined, "complete when read");
      clock.t += ms;
      assert.equal((await read(s, c.token)).body.filling, undefined, `${ms} ms after its head's read: complete`);
      clock.t += 1;
      const late = await read(s, c.token);
      assert.equal(late.body.filling, true, `${ms + 1} ms after its head's read, no head read since: filling`);
      assert.equal(late.body.whole_ms, undefined);
      assert.deepEqual(late.body.trades, first.body.trades);
      await s.tick();
      const back = await read(s, c.token);
      assert.equal(back.body.filling, undefined, "read again: complete");
      assert.ok(Number.isSafeInteger(back.body.whole_ms));
    } finally {
      s.stop();
    }
  });
}
