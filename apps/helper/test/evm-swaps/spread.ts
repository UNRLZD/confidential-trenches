// The spread coins' fake Robinhood chain behind the real provider list (card robinhood-tapes-read-ahead): shared by
// src/data/evm/swaps-tapes-ahead.test.ts and the read ahead's burst replay (burst-read-ahead.ts). Not a test itself,
// and outside src/ so the helper image never holds it.
import { fakeChain, REC, timeAt } from "./robinhood.ts";
import { ROBINHOOD_VENUES, TOPIC } from "../../src/data/evm/swaps.ts";

export const CHAIN_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const POCKET = "https://robinhood.api.pocket.network";
export const WIDE = ["https://robinhood.daybreak-rpc.network", "https://rpc-robinhood.blockmachine.io", POCKET, CHAIN_RPC];
/** Each provider's answer, this many virtual ms after its post (swaps-search.test.ts: the live answers under load). */
export const LATE_MS = 700;

const w = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const int = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");
const ROUTER = `0x${"7e".repeat(20)}`;
const FEE = 3000n;
/** Thirteen tokens, each traded only on its own Uniswap v3 pool against USDG: 20 swaps, spread over the hour before the
 *  head (a spread coin: its tape is short of TRADES_MAX, so a cold open reads the day back before it is whole). The
 *  first twelve are the lists'; the last is a coin a page opens that no list carries yet. */
/** `count` spread coins, each traded only on its own pool. */
export const spreadTokens = (count: number) => Array.from({ length: count }, (_, i) => ({ token: `0x${(0xa4ead00 + i).toString(16).padStart(40, "0")}`, pool: `0x${(0x9a4ead00 + i).toString(16).padStart(40, "0")}` }));
export const TOKENS = spreadTokens(13);
export const LISTED = TOKENS.slice(0, 12);
export const PAGE = TOKENS[12]!;
export const SWAPS = 20;
const http429 = (s = 20) => new Response("{}", { status: 429, headers: { "retry-after": String(s) } });

/** The fake chain behind the real Robinhood provider list (swaps-search.test.ts's rig: the wide providers take 1,000
 *  blocks, the chain's own RPC the day in one read), every answer LATE_MS late. Counts each post, each 429 and each
 *  pool's swap reads; `limit` refuses a provider's posts past that many in a second (429, its Retry-After 1 s). */
export function rig(o: { limit?: number; tokens?: readonly { token: string; pool: string }[] } = {}) {
  const TOKENS_ = o.tokens ?? TOKENS;
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  // each provider as live (swaps-back-resume.test.ts): the chain's own RPC the day in one read, untimed; pocket and
  // daybreak old blocks in their BACK_SPAN; blockmachine the newest 5,000 blocks
  for (const u of WIDE) chain.st.faults.set(u, { span: 1_000 });
  chain.st.faults.set(CHAIN_RPC, { zeroTime: true, span: 1_000_000 });
  chain.st.faults.set(POCKET, { span: 10_000, addressOnly: true });
  chain.st.faults.set("https://rpc-robinhood.blockmachine.io", { span: 1_000, window: 5_000 });
  chain.st.faults.set("https://robinhood.daybreak-rpc.network", { span: 2_000 });
  const head = REC.lastHead;
  const tHead = timeAt(head);
  /** A block's time at Robinhood's 10 blocks a second, back from the head. */
  const at = (b: number) => tHead - Math.ceil((head - b) / 10);
  type L = { b: number; i: number; tx: string; a: string; t: string[]; d: string };
  const transfers = new Map<string, L[]>();
  const swaps = new Map<string, L[]>();
  TOKENS_.forEach(({ token, pool }, n) => {
    const tl: L[] = [];
    const sl: L[] = [];
    for (let k = 0; k < SWAPS; k++) {
      // one swap every 1,700 blocks (about 3 minutes) back from the head: the newest in the cold window, the rest older
      const b = head - 100 - k * 1_700 - n;
      const tx = `0x${"cd".repeat(30)}${n.toString(16).padStart(2, "0")}${k.toString(16).padStart(2, "0")}`;
      const trader = `0x${tx.slice(26, 66)}`;
      const amt = 1_000n * 10n ** 18n + BigInt(k);
      tl.push({ b, i: 0, tx, a: token, t: [TOPIC.transfer, w(pool), w(ROUTER)], d: `0x${int(amt)}` });
      sl.push({ b, i: 1, tx, a: pool, t: [TOPIC.swap3, w(ROUTER), w(ROUTER)], d: `0x${int(-amt)}${int(5_000_000n + BigInt(k))}${int(1n << 96n)}${int(10n ** 18n)}${int(0n)}` });
      tl.push({ b, i: 2, tx, a: token, t: [TOPIC.transfer, w(ROUTER), w(trader)], d: `0x${int(amt)}` });
    }
    transfers.set(token, tl.reverse());
    swaps.set(pool, sl.reverse());
  });
  const n = { posts: 0, refused: 0, poolReads: new Map<string, number>(), answeredAt: new Set<number>() };
  const sent = new Map<string, number[]>();
  const wire = (l: L, zero: boolean) => ({ address: l.a, topics: l.t, data: l.d, blockNumber: `0x${l.b.toString(16)}`, logIndex: `0x${l.i.toString(16)}`, transactionHash: l.tx, blockTimestamp: `0x${(zero ? 0 : at(l.b)).toString(16)}`, removed: false });
  const local = (url: string, r: { method: string; params: unknown[] }): unknown => {
    const f = chain.st.faults.get(url) ?? {};
    if (r.method === "eth_getBlockByNumber" && r.params[0] !== "latest" && parseInt(r.params[0] as string, 16) < REC.firstHead) {
      const b = parseInt(r.params[0] as string, 16);
      return { result: { number: `0x${b.toString(16)}`, timestamp: `0x${at(b).toString(16)}` } };
    }
    if (r.method === "eth_getTransactionByHash") return { result: { hash: r.params[0], from: `0x${(r.params[0] as string).slice(26, 66)}` } };
    if (r.method === "eth_getLogs") {
      const q = r.params[0] as { address?: string | string[]; topics?: (string | string[])[]; fromBlock: string; toBlock: string };
      const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
      const addrs = [q.address].flat().filter((a): a is string => typeof a === "string");
      if (addrs.length === 0 || !addrs.some((a) => transfers.has(a) || swaps.has(a))) return undefined;
      if (to > head || to - from + 1 > (f.span ?? 100)) return { error: { code: -32602, message: "eth_getLogs block range exceeds 100 blocks" } };
      if (f.window !== undefined && from < head - f.window) return { error: { code: -32011, message: "block reference is outside the public history window" } };
      for (const a of addrs) if (swaps.has(a)) n.poolReads.set(a, (n.poolReads.get(a) ?? 0) + 1);
      const want = (q.topics?.[0] === undefined || q.topics[0] === null ? null : [q.topics[0]].flat());
      return { result: addrs.flatMap((a) => transfers.get(a) ?? swaps.get(a) ?? []).filter((l) => l.b >= from && l.b <= to && (want === null || want.includes(l.t[0]!))).sort((x, y) => x.b - y.b || x.i - y.i).map((l) => wire(l, f.zeroTime === true)) };
    }
    if (r.method !== "eth_call") return undefined;
    const c = r.params[0] as { to: string; data: string };
    const p = TOKENS_.find((x) => x.pool === c.to);
    if (p !== undefined) {
      if (c.data === "0xc45a0155") return { result: w(ROBINHOOD_VENUES.uniswapV3) };
      if (c.data === "0x0dfe1681") return { result: w(p.token) };
      if (c.data === "0xd21220a7") return { result: w(ROBINHOOD_VENUES.usdg) };
      if (c.data === "0xddca3f43") return { result: `0x${int(FEE)}` };
      return { error: { code: 3, message: "execution reverted" } };
    }
    if (c.to === ROBINHOOD_VENUES.uniswapV3 && c.data.startsWith("0x1698ee82")) {
      const q = TOKENS_.find((x) => c.data === `0x1698ee82${w(x.token).slice(2)}${w(ROBINHOOD_VENUES.usdg).slice(2)}${int(FEE)}`);
      return { result: w(q?.pool ?? `0x${"0".repeat(40)}`) };
    }
    return undefined;
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    n.posts++;
    if (o.limit !== undefined) {
      const t = Date.now();
      const mine = (sent.get(url) ?? []).filter((x) => t - x < 1_000);
      mine.push(t);
      sent.set(url, mine);
      if (mine.length > o.limit) {
        n.refused++;
        return http429(1);
      }
    }
    await new Promise((go) => setTimeout(go, LATE_MS));
    // the virtual ms each answer lands at: the turns of that ms are the helper's work on it (spans)
    n.answeredAt.add(Date.now());
    const reqs = [JSON.parse(String(init.body))].flat() as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map((r) => local(url, r));
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...(mine[i] as object) } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { chain, fetch, n };
}
