// The recorded Base logs and a fake chain behind three providers that replays them: shared by
// src/data/evm/swaps.test.ts and swaps-route.test.ts. Not a test itself, and outside src/ so the helper image never
// holds it.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { BLOCK_CLOCK } from "../../src/data/evm/lists.ts";
import { BASE_VENUES, createSwaps, REF_POOL_ID, type Log, type Pool } from "../../src/data/evm/swaps.ts";

// -- the recorded logs -----------------------------------------------------------------------------------------------

export type Rec = { firstHead: number; lastHead: number; blockTimes: Record<string, number>; logs: Record<"icnt" | "vvv" | "ref", { b: number; i: number; tx: string; t: string[]; d: string; a: string }[]>; recordedAt: string };
export const REC = JSON.parse(gunzipSync(readFileSync(new URL("../../src/data/evm/fixtures/swaps-base-hour.json.gz", import.meta.url))).toString("utf8")) as Rec;
export const CLOCK = BLOCK_CLOCK.base!;
export const timeOf = (n: number) => CLOCK.genesisS + CLOCK.blockS * n;
export const toLog = (l: Rec["logs"]["icnt"][number]): Log => ({ block: l.b, index: l.i, tx: l.tx, address: l.a, topics: l.t, data: l.d });

export const ICNT = "0xe0cd4cacddcbf4f36e845407ce53e87717b6601d";
export const VVV = "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf";
// token0 of each pool read on chain (probe of 2026-11-03 17:0xZ): ICNT's pool has USDC as token0, VVV's has WETH
export const POOL_ICNT: Pool = { venue: "v3", id: "0x9331f571f79d1e186a095c93756b5680a43932ac", token: ICNT, tokenIs0: false, quote: { kind: "usd", decimals: 6 } };
export const POOL_VVV: Pool = { venue: "v2", id: "0x01784ef301d79e4b2df3a21ad9a536d4cf09a5ce", token: VVV, tokenIs0: false, quote: { kind: "eth", decimals: 18 } };
export const KNOWN = new Map([[ICNT, { pool: POOL_ICNT, decimals: 18 }], [VVV, { pool: POOL_VVV, decimals: 18 }]]);

// -- a fake chain behind three providers -----------------------------------------------------------------------------

/** The log's second word with its last hex digit changed: a different amount, the same sign and shape. */
export const tamper = (d: string): string => `${d.slice(0, 2 + 64 + 63)}${d[2 + 64 + 63] === "7" ? "3" : "7"}${d.slice(2 + 64 + 64)}`;
export const URLS = ["https://a.test", "https://b.test", "https://c.test"];
type Fault = { lag?: number; status?: number; limit?: number; corrupt?: boolean; down?: boolean; badClock?: boolean; fork?: boolean };
export function fakeChain() {
  const st = { head: REC.firstHead, calls: new Map<string, number>(), faults: new Map<string, Fault>(), fork: null as null | { from: number } };
  const sources = [
    { addr: POOL_ICNT.id, t1: null as string | null, logs: REC.logs.icnt },
    { addr: POOL_VVV.id, t1: null as string | null, logs: REC.logs.vvv },
    { addr: BASE_VENUES.poolManager, t1: REF_POOL_ID as string | null, logs: REC.logs.ref },
  ];
  const wire = (l: Rec["logs"]["icnt"][number], corrupt: boolean, fork: boolean) => ({
    address: l.a,
    topics: l.t,
    data: corrupt || fork ? tamper(l.d) : l.d,
    blockNumber: `0x${l.b.toString(16)}`,
    logIndex: `0x${l.i.toString(16)}`,
    transactionHash: l.tx,
    removed: false,
  });
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    st.calls.set(url, (st.calls.get(url) ?? 0) + 1);
    const f = st.faults.get(url) ?? {};
    if (f.down) return new Response("down", { status: 503 });
    if (f.status !== undefined) return new Response("{}", { status: f.status, headers: { "retry-after": "7" } });
    const head = st.head - (f.lag ?? 0);
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const out = reqs.map((r) => {
      if (f.limit !== undefined) return { jsonrpc: "2.0", id: r.id, error: { code: -32005, message: "rate limited", data: { backoff_seconds: f.limit } } };
      if (r.method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id: r.id, result: { number: `0x${head.toString(16)}`, timestamp: `0x${(timeOf(head) + (f.badClock ? 1 : 0)).toString(16)}` } };
      if (r.method === "eth_getLogs") {
        const q = r.params[0] as { address: string; topics: string[]; fromBlock: string; toBlock: string };
        const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
        const src = sources.find((s) => s.addr === q.address && (s.t1 === null || s.t1 === q.topics[1]));
        if (src === undefined || to > head) return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "bad range" } };
        const forkFrom = st.fork?.from ?? Infinity;
        return { jsonrpc: "2.0", id: r.id, result: src.logs.filter((l) => l.b >= from && l.b <= to).map((l, k) => wire(l, f.corrupt === true && k % 5 === 0, l.b >= forkFrom)) };
      }
      if (r.method === "eth_getTransactionByHash") return { jsonrpc: "2.0", id: r.id, result: { hash: r.params[0], from: `0x${(r.params[0] as string).slice(26, 66)}` } };
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "no" } };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { st, fetch };
}
export const open = (c: ReturnType<typeof fakeChain>, clock = { t: 1_000_000 }, over: Partial<Parameters<typeof createSwaps>[1]> = {}) => createSwaps("base", { fetch: c.fetch, now: () => clock.t, listed: async () => true, rpcs: URLS, pools: KNOWN, tickMs: 0, ...over });
