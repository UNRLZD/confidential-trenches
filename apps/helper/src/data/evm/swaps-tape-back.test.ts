// node --test apps/helper/src/data/evm/swaps-tape-back.test.ts: card every-cell-shows-a-value. A tape read only the cold
// window (VENUES.base.cold, 1,500 blocks: 5 minutes of Base's 200 ms blocks), so a token whose newest trade was older
// opened with none: 16 of the 41 listed Base tokens answered an empty tape on the live helper 2026-11-14 05:0xZ, REVVY's
// 31 swaps and PEACEFROG's 32 in the hour before all past the window. Here a short tape reads back (readBack) in the
// background, step after step, to TRADES_MAX trades or VENUES[chain].tapeBack blocks, each trade priced by the one rule (an ETH-quoted one at
// the ETH price in force before it, read with it). Every chain answer is the recorded Base fake (test/evm-swaps/base.ts)
// with the pool's planted in front; the logs are real (fixtures/swaps-pancake-base.json, swaps-univ2-base.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as B from "../../../test/evm-swaps/base.ts";
import { fixed } from "../candles.ts";
import * as S from "./swaps.ts";
import { VENUES } from "./swaps.ts";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const sel = (s: string) => hex(keccak_256(new TextEncoder().encode(s))).slice(0, 10);
const w = (a: string) => a.slice(2).padStart(64, "0");
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
type Filter = { address?: string; topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
type Fx = { pool: string; factory: string; asset0: string; asset1: string; log: Record<string, unknown> & { topics: string[]; transactionHash: string } };
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Fx & { fee?: number };
const PCS = fx("swaps-pancake-base.json");
const UNI2 = fx("swaps-univ2-base.json");
/** Base's VENUES sizes, read through the namespace so the file loads where tapeBack is missing (red at cd426e5b9). */
const TAPE_BACK = (VENUES.base as unknown as Record<string, number>).tapeBack ?? 18_000;

/** The fake chain at `head`, the pool's confirming calls planted, its one recorded swap moved to block `at`; `asked`
 *  collects each pool logs read's first block. */
function rig(p: Fx & { fee?: number }, getPool: string, head: number, at: number, failBefore?: number) {
  const chain = B.fakeChain();
  chain.st.head = head;
  const calls = new Map<string, string>([
    [`${p.asset0} 0x313ce567`, word(18n)],
    [`${p.pool} 0xc45a0155`, word(BigInt(p.factory))],
    [`${p.pool} 0x0dfe1681`, word(BigInt(p.asset0))],
    [`${p.pool} 0xd21220a7`, word(BigInt(p.asset1))],
    ...(p.fee === undefined ? [] : [[`${p.pool} ${sel("fee()")}`, word(BigInt(p.fee))] as [string, string]]),
    [getPool, word(BigInt(p.pool))],
  ]);
  const log = { ...p.log, blockNumber: `0x${at.toString(16)}`, blockTimestamp: `0x${B.timeOf(at).toString(16)}` };
  const asked: number[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map((r): object | undefined => {
      if (r.method === "eth_call") {
        const c = r.params[0] as { to: string; data: string };
        return { result: calls.get(`${c.to} ${c.data}`) ?? "0x" };
      }
      if (r.method !== "eth_getLogs") return undefined;
      const q = r.params[0] as Filter;
      if (q.address === p.asset0) return { result: [] };
      if (q.address === p.pool) {
        asked.push(parseInt(q.fromBlock, 16));
        if (failBefore !== undefined && parseInt(q.fromBlock, 16) < failBefore) return { error: { code: -32603, message: "internal error" } };
        return { result: q.topics?.[0] === p.log.topics[0] && at >= parseInt(q.fromBlock, 16) && at <= parseInt(q.toBlock, 16) ? [log] : [] };
      }
      return undefined;
    });
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...mine[i] } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  const s = B.open(chain, undefined, { fetch: fetch as never, pools: new Map(), hint: async () => p.pool });
  return { s, asked };
}
/** Ticks, each followed by the read back it starts settling (its own background read, never the tick's wait). */
const ticks = async (s: ReturnType<typeof B.open>, n: number) => {
  for (let i = 0; i < n; i++) {
    await s.tick();
    for (let k = 0; k < 40; k++) await new Promise((ok) => setTimeout(ok, 5));
  }
};
/** Whether the tape's answer says it is filling (its older trades still being read). */
const filling = async (s: ReturnType<typeof B.open>, tok: string) => JSON.parse((await s.trades(tok, 50)).body).filling === true;
const rows = async (s: ReturnType<typeof B.open>, tok: string) => {
  const a = await s.trades(tok, 50);
  assert.equal(a.status, 200, a.body);
  return (JSON.parse(a.body).trades as { side: string; usd: string; amt: string; tx: string }[]).map((x) => [x.side, x.usd, x.amt, x.tx]);
};

test("a token whose only trade lies past the cold window: its first open has none, and the tape read back finds it within TAPE_BACK blocks, in the background, then reads no further (red at cd426e5b9: never found)", async () => {
  const head = B.REC.firstHead + 200;
  const V = VENUES.base;
  // 300 blocks before the first read's window: the first step back holds it
  const at = head - V.cold - 300;
  const { s, asked } = rig(PCS, `${PCS.factory} ${sel("getPool(address,address,uint24)")}${w(PCS.asset0)}${w(PCS.asset1)}${w(word(BigInt(PCS.fee!)))}`, head, at);
  assert.deepEqual(await rows(s, PCS.asset0), [], "the cold window holds no trade");
  assert.equal(await filling(s, PCS.asset0), true, "short and reading back: filling, so the page shows it loading");
  await ticks(s, 2);
  assert.deepEqual(await rows(s, PCS.asset0), [["b", "57.137132", "868.503865188635487108", PCS.log.transactionHash]]);
  // the read back went to TAPE_BACK blocks before the first read (one trade is short of TRADES_MAX), never past it
  const first = head - V.cold + 1;
  assert.equal(Math.min(...asked), first - TAPE_BACK);
  const n = asked.length;
  await ticks(s, 3);
  assert.equal(asked.filter((b) => b < first).length, asked.slice(0, n).filter((b) => b < first).length, "done: no step back once TAPE_BACK is read");
  assert.equal(await filling(s, PCS.asset0), false, "done: not filling");
  s.stop();
});

test("an ETH-quoted trade read back is priced at the ETH price in force before it, read in the same step (Uniswap v2 SPCX / WETH) (red at cd426e5b9: never found)", async () => {
  const V = VENUES.base;
  // the swap 400 blocks into the recording, the head past it by the cold window and 100 blocks: the recorded ETH price
  // swaps before it lie in the same step back
  const at = B.REC.firstHead + 400;
  const head = at + V.cold + 100;
  const { s } = rig(UNI2, `${UNI2.factory} ${sel("getPair(address,address)")}${w(UNI2.asset0)}${w(UNI2.asset1)}`, head, at);
  assert.deepEqual(await rows(s, UNI2.asset0), []);
  await ticks(s, 2);
  const ref = B.REC.logs.ref.filter((x) => x.b < at).map(B.toLog).map((x) => S.decodeRef(x)).filter((x) => x !== null).at(-1)!;
  assert.deepEqual(await rows(s, UNI2.asset0), [["b", fixed((3_577_223_829n * ref.ethUsd) / 10n ** 18n, 18), "123989.534258606247275177", UNI2.log.transactionHash]]);
  s.stop();
});

test("guard: a trade read back with no ETH price before it in what was read is not on the tape (never priced by a later price)", async () => {
  const V = VENUES.base;
  // before the recording's first ETH price swap: nothing read prices it
  const at = B.REC.firstHead + 5;
  const head = at + V.cold + 100;
  const { s } = rig(UNI2, `${UNI2.factory} ${sel("getPair(address,address)")}${w(UNI2.asset0)}${w(UNI2.asset1)}`, head, at);
  await ticks(s, 2);
  assert.deepEqual(await rows(s, UNI2.asset0), []);
  s.stop();
});

test("guard: a read back whose steps fail BACK_FAILS_MAX times in a row ends: the tape is what it holds and no longer filling", async () => {
  const head = B.REC.firstHead + 200;
  const first = head - VENUES.base.cold + 1;
  const { s, asked } = rig(PCS, `${PCS.factory} ${sel("getPool(address,address,uint24)")}${w(PCS.asset0)}${w(PCS.asset1)}${w(word(BigInt(PCS.fee!)))}`, head, head - VENUES.base.cold - 300, first);
  assert.equal(await filling(s, PCS.asset0), true);
  const max = (S as unknown as Record<string, number>).BACK_FAILS_MAX ?? 3;
  await ticks(s, max + 2);
  assert.equal(await filling(s, PCS.asset0), false);
  assert.deepEqual(await rows(s, PCS.asset0), []);
  // one step a tick while failing, then none: each failed step asked its spans of both providers, max times
  const n = asked.filter((b) => b < first).length;
  await ticks(s, 2);
  assert.equal(asked.filter((b) => b < first).length, n);
  s.stop();
});
