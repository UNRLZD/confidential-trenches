// node --test apps/helper/src/data/evm/swaps-read-sliced.test.ts: a cold open's answers are handled a turn's slice at a
// time (card helper-loop-never-held-by-a-read). A mainnet copy's profile under the jupiter-budget page checks, after
// card helper-loop-never-held-by-a-write, still held one turn 155 ms in findPool's answer handling: two providers' logs
// parsed and checked log by log (parseLogs), the token's transfers counted (findPool 28%), each pair of answers compared
// again every round (agreed and pick 17%, sameLogs' two key strings a log 11%), all in the turn the answers landed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, open, REC, timeAt } from "../../../test/evm-swaps/robinhood.ts";
import { callsIn, pocketRefusal } from "../../../test/pocket.ts";
import { ROBINHOOD_VENUES, sameLogs, TOPIC, type Log } from "./swaps.ts";
import { turnSlicer } from "../../limits/turn.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";

const w = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const int = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");
const hash = (k: string) => `0x${Buffer.from(keccak_256(Buffer.from(k.slice(2), "hex"))).toString("hex")}`;
const ZERO = `0x${"0".repeat(40)}`;
const PM = ROBINHOOD_VENUES.poolManager;
const USDG = ROBINHOOD_VENUES.usdg;
const TOKEN = "0x00000000000000000000000000000000c0de0002";
const MAIN_KEY = `0x${w(TOKEN).slice(2)}${w(USDG).slice(2)}${int(3000n)}${int(60n)}${w(ZERO).slice(2)}`;
const MAIN = hash(MAIN_KEY);
/** A busy coin: a swap and its transfer in each of the cold window's last 2,900 blocks. */
const SWAPS = 2_900;

function rig() {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const head = REC.lastHead;
  type L = { b: number; i: number; tx: string; a: string; t: string[]; d: string };
  const transfers: L[] = [];
  const swaps: L[] = [];
  const receipts = new Map<string, L[]>();
  for (let k = 0; k < SWAPS; k++) {
    const b = head - SWAPS + 1 + k;
    const tx = `0x${"ce".repeat(30)}${k.toString(16).padStart(4, "0")}`;
    const trader = `0x${tx.slice(26, 66)}`;
    const amt = 1_000n * 10n ** 18n + BigInt(k);
    const t: L = { b, i: 12, tx, a: TOKEN, t: [TOPIC.transfer, w(PM), w(trader)], d: `0x${int(amt)}` };
    const s: L = { b, i: 11, tx, a: PM, t: [TOPIC.swap4, MAIN, w(trader)], d: `0x${int(amt)}${int(-(5_000_000n + BigInt(k)))}${int(1n << 96n)}${int(10n ** 18n)}${int(0n)}${int(3000n)}` };
    transfers.push(t);
    swaps.push(s);
    receipts.set(tx, [s, t]);
  }
  const wire = (l: L) => ({ address: l.a, topics: l.t, data: l.d, blockNumber: `0x${l.b.toString(16)}`, logIndex: `0x${l.i.toString(16)}`, transactionHash: l.tx, blockTimestamp: `0x${timeAt(l.b).toString(16)}`, removed: false });
  const local = (r: { method: string; params: unknown[] }): unknown => {
    if (r.method === "eth_getLogs") {
      const q = r.params[0] as { address?: string; topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
      const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
      const in_ = (l: L) => l.b >= from && l.b <= to;
      if (q.address === TOKEN) return { result: transfers.filter(in_).map(wire) };
      if (q.address === PM && q.topics?.[1] === MAIN) return { result: swaps.filter(in_).map(wire) };
      return undefined;
    }
    if (r.method === "eth_getTransactionReceipt") {
      const l = receipts.get(r.params[0] as string);
      return l === undefined ? undefined : { result: { transactionHash: r.params[0], logs: l.map(wire) } };
    }
    if (r.method === "eth_call") {
      const c = r.params[0] as { to: string; data: string };
      if (c.to === ROBINHOOD_VENUES.positionManager && c.data === `0x86b6be7d${MAIN.slice(2, 52).padEnd(64, "0")}`) return { result: MAIN_KEY };
      return undefined;
    }
    return undefined;
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const pocket = pocketRefusal(url, callsIn(init.body));
    if (pocket) return pocket;
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map(local);
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...(mine[i] as object) } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { chain, fetch };
}

/** Work counted a turn of the loop: a slicer on a counting clock (each log handled asks it once, one unit), and the most
 *  items asked between two turns, read by an immediate that sets itself again every turn (as swaps-v4key.test.ts). */
function turnsCounted(turnItems: number) {
  let items = 0;
  let atTick = 0;
  let most = 0;
  let on = true;
  const tick = (): void => {
    most = Math.max(most, items - atTick);
    atTick = items;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  const s = turnSlicer(() => items++, turnItems);
  return { pass: () => s.pass(), done: () => ((on = false), { items, most }) };
}

test("card helper-loop-never-held-by-a-read: a busy coin's cold open (2,900 swaps and their transfers, read of two providers) handles its answers a turn's slice at a time: every log parsed, counted and scored asks the loop's slicer, and no turn holds more than a slice (red at c6711e2c3: findPool's answers were handled in the turn they landed, no slicer asked)", async () => {
  const r = rig();
  const t = turnsCounted(20);
  const s = open(r.chain, { get t() { return Date.now(); } }, { pools: new Map(), fetch: r.fetch as never, pass: t.pass });
  const a = await s.trades(TOKEN, 50);
  s.stop();
  const c = t.done();
  assert.equal(a.status, 200, a.body);
  assert.ok((JSON.parse(a.body) as { trades: unknown[] }).trades.length > 0, "the coin's own tape, from its USDG pool");
  // two providers' transfers and swaps parsed (2 x 2 x 2,900), the transfers counted and the swaps scored (2 x 2,900)
  assert.ok(c.items >= 6 * SWAPS, `every log asked the slicer: ${c.items} items`);
  assert.ok(c.most <= 2 * 22, `${c.most} items in one turn`);
});

test("card helper-loop-never-held-by-a-read: sameLogs compares log by log, field by field, as the key strings did (the same logs alike; a log's block, index, tx, address, topic, data, or with times its time apart is no match)", () => {
  const l: Log = { block: 7, index: 2, tx: `0x${"aa".repeat(32)}`, address: `0x${"bb".repeat(20)}`, topics: [`0x${"cc".repeat(32)}`, `0x${"dd".repeat(32)}`], data: "0x", t: 99 };
  assert.ok(sameLogs([l], [{ ...l, topics: [...l.topics] }], true));
  assert.ok(sameLogs([{ ...l, t: null }], [{ ...l, t: undefined }], true), "no time and an unknown time alike, as the key's - was");
  assert.ok(sameLogs([l], [{ ...l, t: 100 }]), "times not compared unless asked");
  assert.ok(!sameLogs([l], [{ ...l, t: 100 }], true));
  for (const d of [{ block: 8 }, { index: 3 }, { tx: `0x${"ab".repeat(32)}` }, { address: `0x${"bc".repeat(20)}` }, { topics: [l.topics[0]!] }, { topics: [l.topics[0]!, `0x${"de".repeat(32)}`] }, { data: `0x${"00".repeat(32)}` }]) assert.ok(!sameLogs([l], [{ ...l, ...d }]), JSON.stringify(d));
  assert.ok(!sameLogs([l], [l, l]), "a different count");
});
