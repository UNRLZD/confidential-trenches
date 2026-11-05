// The recorded Robinhood logs and a fake chain behind three providers that replays them: shared by
// src/data/evm/swaps-robinhood.test.ts and the Robinhood route test. Not a test itself, and outside src/ so the helper
// image never holds it.
//
// The recording (src/data/evm/fixtures/swaps-robinhood.json.gz, read 2026-11-03 19:2xZ from
// robinhood.daybreak-rpc.network, the curve's logs checked log for log against robinhood.drpc.org): 2,000 blocks of a
// Pons v2 curve's CurveBuy and CurveSell logs (the busiest curve of the window, its factory record read with them), the
// busiest v4 pool's Swap logs (native ETH and Mag, its key read from the PositionManager), and the ETH / USDG price
// pool's, each with the block time the provider logged.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createSwaps, ROBINHOOD_VENUES, ROBINHOOD_REF_POOL_ID, TOPIC, type Log, type Pool } from "../../src/data/evm/swaps.ts";

type RecLog = { b: number; i: number; tx: string; t: string[]; d: string; a: string; ts: number };
export type Rec = { firstHead: number; lastHead: number; curve: string; token: string; launchedRecord: string; v4id: string; blockTimes: Record<string, number>; logs: Record<"curve" | "v4" | "ref", RecLog[]>; recordedAt: string };
export const REC = JSON.parse(gunzipSync(readFileSync(new URL("../../src/data/evm/fixtures/swaps-robinhood.json.gz", import.meta.url))).toString("utf8")) as Rec;
export const toLog = (l: RecLog): Log => ({ block: l.b, index: l.i, tx: l.tx, address: l.a, topics: l.t, data: l.d, t: l.ts });

/** The curve's token, and the v4 pool's (Mag, currency1 of a native ETH pool: poolKeys on the PositionManager). */
export const CURVE_TOKEN = REC.token;
export const MAG = "0xb059dbe25234f54264a20b2baf03090453e97198";
export const POOL_CURVE: Pool = { venue: "curve", id: REC.curve, token: CURVE_TOKEN, tokenIs0: false, quote: { kind: "eth", decimals: 18 } };
export const POOL_MAG: Pool = { venue: "v4", id: REC.v4id, token: MAG, tokenIs0: false, quote: { kind: "eth", decimals: 18 } };
export const KNOWN = new Map([[CURVE_TOKEN, { pool: POOL_CURVE, decimals: 18 }], [MAG, { pool: POOL_MAG, decimals: 18 }]]);

/** A block's time: the newest logged time at or before it (the chain's times never go back). */
export function timeAt(n: number): number {
  let t = REC.blockTimes[String(REC.firstHead)]!;
  for (const l of [...REC.logs.curve, ...REC.logs.v4, ...REC.logs.ref]) if (l.b <= n && l.ts > t) t = l.ts;
  return t;
}

export const URLS = ["https://a.test", "https://b.test", "https://c.test"];
/** `zeroTime`: logs `blockTimestamp` 0x0, as rpc.mainnet.chain.robinhood.com does; `skewTime`: a second later;
 *  `backTime`: an hour earlier for the logs of every other block, so time goes back; `window`: logs only of the newest
 *  this many blocks, older ones refused -32011, as api.blockvectra.com's public endpoint (about 850, 2026-11-04 14:38Z);
 *  `span`: the widest `eth_getLogs` it takes (100 unless set: the wide providers of swaps.ts WIDE_SPAN take 1,000);
 *  `addressOnly`: refuses an `eth_getLogs` with no address (-32602), as pocket and blockvectra do;
 *  `refuse`: a refusal it answers instead, when it returns one (a 429, a throttle). */
type Fault = { zeroTime?: boolean; skewTime?: boolean; backTime?: boolean; down?: boolean; window?: number; span?: number; addressOnly?: boolean; refuse?: () => Response | null };
export function fakeChain() {
  // `own`: eth_getLogs of one address's swap events (a token's own read); `wide`: of no address (the index's)
  const st = { head: REC.firstHead, calls: new Map<string, number>(), faults: new Map<string, Fault>(), spans: [] as number[], own: 0, wide: 0 };
  const sources = [
    { addr: REC.curve, t1: null as string | null, logs: REC.logs.curve },
    { addr: ROBINHOOD_VENUES.poolManager, t1: REC.v4id as string | null, logs: REC.logs.v4 },
    { addr: ROBINHOOD_VENUES.poolManager, t1: ROBINHOOD_REF_POOL_ID as string | null, logs: REC.logs.ref },
  ];
  const wire = (l: RecLog, f: Fault) => ({
    address: l.a,
    topics: l.t,
    data: l.d,
    blockNumber: `0x${l.b.toString(16)}`,
    logIndex: `0x${l.i.toString(16)}`,
    transactionHash: l.tx,
    blockTimestamp: `0x${(f.zeroTime ? 0 : l.ts + (f.skewTime ? 1 : 0) - (f.backTime && l.b % 2 === 1 ? 3_600 : 0)).toString(16)}`,
    removed: false,
  });
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    st.calls.set(url, (st.calls.get(url) ?? 0) + 1);
    const f = st.faults.get(url) ?? {};
    if (f.down) return new Response("down", { status: 503 });
    const no = f.refuse?.();
    if (no) return no;
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const out = reqs.map((r) => {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
      if (r.method === "eth_getBlockByNumber") {
        const n = r.params[0] === "latest" ? st.head : parseInt(r.params[0] as string, 16);
        return ok(n > st.head ? null : { number: `0x${n.toString(16)}`, timestamp: `0x${timeAt(n).toString(16)}` });
      }
      if (r.method === "eth_getLogs") {
        const q = r.params[0] as { address: string; topics: (string | string[])[]; fromBlock: string; toBlock: string };
        const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
        st.spans.push(to - from + 1);
        if (to > st.head || to - from + 1 > (f.span ?? 100)) return { jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "eth_getLogs block range exceeds 100 blocks" } };
        if (f.window !== undefined && from < st.head - f.window) return { jsonrpc: "2.0", id: r.id, error: { code: -32011, message: "block reference is outside the public history window" } };
        if (q.topics[0] === TOPIC.transfer) return ok([]);
        // a filter with no address (the chain's swap index, index.ts): every source's logs of its topics, as
        // daybreak, blockmachine and drpc answer one; `addressOnly` refuses it, as pocket and blockvectra do
        if (q.address === undefined) {
          st.wide++;
          if (f.addressOnly) return { jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "missing required field 'address'" } };
          const want = [q.topics[0]].flat();
          const all = sources.flatMap((s) => s.logs).filter((l) => l.b >= from && l.b <= to && want.includes(l.t[0]!));
          return ok(all.sort((x, y) => x.b - y.b || x.i - y.i).map((l) => wire(l, f)));
        }
        st.own++;
        const src = sources.find((s) => s.addr === q.address && (s.t1 === null || s.t1 === q.topics[1]));
        if (src === undefined) return ok([]);
        return ok(src.logs.filter((l) => l.b >= from && l.b <= to && (Array.isArray(q.topics[0]) ? q.topics[0].includes(l.t[0]!) : q.topics[0] === l.t[0])).map((l) => wire(l, f)));
      }
      if (r.method === "eth_call") {
        const c = r.params[0] as { to: string; data: string };
        // the Pons v2 factory's getLaunchedToken(token): the record read on chain with the recording
        if (c.to === ROBINHOOD_VENUES.ponsV2 && c.data === `0x3cf28b5a${CURVE_TOKEN.slice(2).padStart(64, "0")}`) return ok(REC.launchedRecord);
        if (c.to === ROBINHOOD_VENUES.ponsV2) return ok(`0x${"0".repeat(960)}`);
        if (c.data === "0x313ce567") return ok(`0x${(18).toString(16).padStart(64, "0")}`);
        return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "execution reverted" } };
      }
      if (r.method === "eth_getTransactionByHash") return ok({ hash: r.params[0], from: `0x${(r.params[0] as string).slice(26, 66)}` });
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "no" } };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { st, fetch };
}
export const open = (c: ReturnType<typeof fakeChain>, clock = { t: 1_000_000 }, over: Partial<Parameters<typeof createSwaps>[1]> = {}) =>
  createSwaps("robinhood", { fetch: c.fetch, now: () => clock.t, listed: async () => true, rpcs: URLS, pools: KNOWN, tickMs: 0, ...over });
