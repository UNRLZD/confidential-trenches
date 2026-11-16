// node --test apps/helper/src/data/evm/swaps-own-third.test.ts: card robinhood-trades-finish-filling. The chain's own
// RPC (rpc.mainnet.chain.robinhood.com) answers one post a second, shared by every tape and /v1/rpc/robinhood's callers,
// and its logs carry no block time, so each answer costs it header posts too (HEADER_TIMED). Live 16 Nov, eight cold
// tapes at once in the helper's container: it sent 0.86-0.97 posts a second in every run, 85-90% of its calls ordinary
// logs and their headers, and the slowest tape waited on it. So it is asked a head last and never joins the head's
// `with`, and an ordinary log read asks it only as the third, the tie-break when the first two disagree; drpc (100
// blocks a read) and blockvectra (a narrow window that 429s) stay last.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, MAG, open, POOL_MAG, REC } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { INDEX_RPCS, SWAP_RPCS } from "./swaps.ts";

const [DAYBREAK, BLOCKMACHINE, POCKET, DRPC, BLOCKVECTRA, OWN] = SWAP_RPCS.robinhood as [string, string, string, string, string, string];
const LAST = Math.max(...REC.logs.v4.map((l) => l.b));
/** The day read (locate, BACK_LOCATE) is the own RPC's by design; an ordinary log read spans this many blocks at most. */
const DAY = 100_000;

type Count = { heads: number; logs: number; first: number };
/** `skew`: pocket logs each swap a second late, so it and daybreak disagree; `busy`: daybreak's bucket reads as spent at
 *  every ask, as eight cold tapes at once keep it (the own RPC's is full, so its expected wait is the shorter); `down`:
 *  daybreak answers nothing (503); `ticks`: the most ticks waited for the tape to fill. */
async function tape(o: { skew?: boolean; busy?: boolean; down?: boolean; ticks: number }) {
  const { value } = await onVirtualTime(1_000_000_000, async () => {
    const chain = fakeChain();
    chain.st.head = LAST + 7_200;
    chain.st.faults.set(OWN, { zeroTime: true, span: 1_000_000 });
    chain.st.faults.set(POCKET, { span: 10_000, addressOnly: true, skewTime: o.skew === true });
    chain.st.faults.set(BLOCKMACHINE, { span: 1_000 });
    chain.st.faults.set(DAYBREAK, { span: 2_000, down: o.down === true });
    const by = new Map<string, Count>();
    let seq = 0;
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      const reqs = JSON.parse(String(init.body)) as { method: string; params: (string | { fromBlock?: string; toBlock?: string })[] }[];
      const c = by.get(url) ?? { heads: 0, logs: 0, first: Infinity };
      for (const r of reqs) {
        const q = r.params[0];
        if (r.method === "eth_getBlockByNumber" && q === "latest") c.heads++;
        // a token's own read names its pool's address; the chain-wide index read (INDEX_RPCS) names none
        if (r.method === "eth_getLogs" && typeof q === "object" && "address" in q && q.fromBlock !== undefined && parseInt(q.toBlock!, 16) - parseInt(q.fromBlock, 16) + 1 <= DAY) c.logs++, (c.first = Math.min(c.first, seq++));
      }
      by.set(url, c);
      await new Promise((go) => setTimeout(go, 200));
      return chain.fetch(url, init);
    };
    const paced = providerHolds(() => Date.now());
    const holds = o.busy === true ? { ...paced, room: (u: string) => (u === DAYBREAK ? 0 : paced.room(u)) } : paced;
    const s = open(chain, { t: 0 }, { rpcs: SWAP_RPCS.robinhood, index: INDEX_RPCS.robinhood, pools: new Map([[MAG, { pool: POOL_MAG, decimals: 18 }]]), fetch: fetch as never, holds, now: () => Date.now() });
    try {
      let last = JSON.parse((await s.trades(MAG, 50)).body);
      for (let i = 0; i < o.ticks && (last.filling === true || last.trades.length === 0); i++) {
        await new Promise((go) => setTimeout(go, 1_500));
        await s.tick();
        last = JSON.parse((await s.trades(MAG, 50)).body);
      }
      return { last, by };
    } finally {
      s.stop();
    }
  });
  const of = (u: string) => value.by.get(u) ?? { heads: 0, logs: 0, first: Infinity };
  const show = [...value.by].map(([u, c]) => `${new URL(u).host} ${c.heads}h ${c.logs}l`).join(", ");
  return { last: value.last, of, show };
}

test("a cold Robinhood tape never asks the chain's own RPC an ordinary log while two other providers can answer, even with daybreak's bucket spent", async () => {
  const r = await tape({ busy: true, ticks: 40 });
  assert.equal(r.last.src, "chain");
  assert.ok(r.last.trades.length > 0, `its trades (${r.show})`);
  assert.equal(r.of(OWN).logs, 0, `the own RPC's ordinary eth_getLogs (${r.show})`);
});

test("the chain's own RPC is asked a head last: with daybreak down, the head is read of the other providers", async () => {
  const r = await tape({ down: true, ticks: 3 });
  assert.ok(r.of(POCKET).heads > 0 && r.of(BLOCKMACHINE).heads > 0, `the heads read (${r.show})`);
  assert.equal(r.of(OWN).heads, 0, `the own RPC's heads (${r.show})`);
});

test("when pocket and daybreak disagree, the chain's own RPC is the third ask, the tie-break, ahead of blockmachine, drpc and blockvectra", async () => {
  const r = await tape({ skew: true, ticks: 3 });
  assert.ok(r.of(OWN).logs > 0, `the own RPC asked as the tie-break (${r.show})`);
  for (const u of [BLOCKMACHINE, DRPC, BLOCKVECTRA]) assert.ok(r.of(OWN).first < r.of(u).first, `the own RPC asked before ${new URL(u).host} (${r.show})`);
});
