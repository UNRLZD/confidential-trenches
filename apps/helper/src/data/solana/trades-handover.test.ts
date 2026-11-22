// node --test apps/helper/src/data/solana/trades-handover.test.ts: card helper-tape-handover. A deploy's new helper takes
// over each Solana tape the old one held (its book, its unsettled trades, the signature it is held to, its rows'
// traders), through the warm file (../warm.ts), and walks on from that signature as after a dropped stream: before this
// every Solana tape opened cold after a deploy, and a flooded coin's first answer held 0 rows (helper update 22, live run
// 45011614034, solana-tape-rows-at-first-answer: 1 of 30 newest signatures successful, 0 rows at 3,198 ms). The one
// handover the Base and Robinhood books take (../evm/swaps-books-handover.test.ts). The state is hostile input: bounded,
// checked whole, one bad part restores nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSolanaTrades, HANDED_TIMING, PYTH_RECEIVER, PYTH_SOL_USD } from "./trades.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-trades-txs.json"), "utf8")) as { txs: Record<string, { signature: string; result: { slot: number; meta: { logMessages: string[] } } }> };
const BUY = F.txs["pump-buy"]!;
const MINT = "4Tdj8MDuQ7Nx1drP1fkf1H4FVvUDrgZ3kbgQpHWXpump";
const TS = 1793739241;
const FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

function pyth(price: bigint, pub: number): Buffer {
  const b = Buffer.alloc(134);
  Buffer.from("22f123639d7ef4cd", "hex").copy(b, 0);
  b[40] = 1;
  Buffer.from(FEED, "hex").copy(b, 41);
  b.writeBigInt64LE(price, 73);
  b.writeInt32LE(-8, 89);
  b.writeBigInt64LE(BigInt(pub), 93);
  return b;
}
function mintData(decimals: number): Buffer {
  const b = Buffer.alloc(82);
  b[44] = decimals;
  b[45] = 1;
  return b;
}
/** Eight signatures (base58, as an RPC lists them), the mint's whole list, each the recorded pump.fun buy, newest first,
 *  50 slots apart: the newest three inside SETTLE_SLOTS (held), the rest settled. */
const SIGS = Array.from({ length: 8 }, (_, i) => ({ signature: `${"5".repeat(80)}${"ABCDEFGH"[i]}`, slot: 465_000_100 - 50 * i, err: null, blockTime: TS - 100 - 4 * i }));

/** An RPC that counts each method and the gap walks (`until`) it was asked. */
function chain() {
  const asked: string[] = [];
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string, Record<string, unknown>] };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    const acct = (owner: string, data: Buffer) => ok({ context: { slot: 100 }, value: { owner, data: [data.toString("base64"), "base64"] } });
    asked.push(req.method === "getSignaturesForAddress" ? `sigs ${req.params[1].until === undefined ? "cold" : `until ${String(req.params[1].until)}`}` : req.method === "getAccountInfo" ? `account ${req.params[0]}` : req.method);
    if (req.method === "getAccountInfo" && req.params[0] === PYTH_SOL_USD) return acct(PYTH_RECEIVER, pyth(9_342_267_796n, TS));
    if (req.method === "getAccountInfo" && req.params[0] === MINT) return acct("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mintData(6));
    if (req.method === "getSignaturesForAddress") return ok(req.params[1].until === undefined ? SIGS : []);
    if (req.method === "getTransaction") {
      const s = SIGS.find((x) => x.signature === req.params[0]);
      return ok(s === undefined ? null : { ...BUY.result, slot: s.slot, blockTime: s.blockTime });
    }
    throw new Error(`unexpected ${req.method}`);
  };
  return { asked, fetch };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

function helper(c: ReturnType<typeof chain>, clock: { ms: number }) {
  const watched: string[] = [];
  const t = createSolanaTrades({
    fetch: c.fetch as never,
    now: () => clock.ms,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async (m: string) => void watched.push(m), unwatch: () => undefined, close: () => undefined, heard: () => ({ at: clock.ms, slot: 465_000_200 }) }),
    tickMs: 0,
  });
  return { t, watched };
}
const view = async (t: ReturnType<typeof createSolanaTrades>) => ({
  trades: (JSON.parse((await t.trades(MINT, 50)).body) as { trades: unknown[] }).trades,
  bars: await Promise.all((["1s", "1m", "1h"] as const).map(async (tf) => (JSON.parse((await t.candles(MINT, tf, null, 500)).body) as { candles: unknown[] }).candles)),
});

async function warmOld() {
  const clock = { ms: TS * 1000 };
  const old = helper(chain(), clock);
  await old.t.trades(MINT, 50);
  await settle();
  const was = await view(old.t);
  const st = JSON.parse(JSON.stringify(old.t.state())) as { tapes: [string, Record<string, unknown>][]; traders: unknown[] };
  old.t.stop();
  return { clock, was, st };
}

test("card helper-tape-handover: a second helper restored from the first one's Solana tapes answers the same trades and candles with no cold walk, no transaction read and no mint read; it walks on from the signature the tape was held to (red at main a2458a619: trades.ts hands no tape over)", async () => {
  const { clock, was, st } = await warmOld();
  assert.equal(was.trades.length, SIGS.length, "the old helper held every trade");
  assert.ok((st.tapes[0]![1].held as unknown[]).length > 0 && ((st.tapes[0]![1].book as { tape: unknown[] }).tape.length > 0), "settled and unsettled trades both handed over");
  clock.ms += 30_000;
  const c = chain();
  const next = helper(c, clock);
  assert.equal(next.t.restore(st), true);
  await settle();
  const now = await view(next.t);
  assert.deepEqual(now.trades, was.trades);
  assert.deepEqual(now.bars, was.bars);
  assert.deepEqual(next.watched, [MINT], "the restored tape is watched on the stream");
  assert.deepEqual(c.asked.filter((m) => m !== `account ${PYTH_SOL_USD}`), [`sigs until ${SIGS[0]!.signature}`], "only the gap from the newest signature held is walked");
  next.t.stop();
});

test("card helper-tape-handover (hostile): a Solana tape whose book, held trades, signature or traders are off restores nothing, and the coin opens cold", async () => {
  const { clock, st } = await warmOld();
  const bad = (f: (s: { tapes: [string, Record<string, unknown>][]; traders: unknown[][] }) => void) => {
    const s = JSON.parse(JSON.stringify(st)) as { tapes: [string, Record<string, unknown>][]; traders: unknown[][] };
    f(s);
    return s;
  };
  const tape = (s: { tapes: [string, Record<string, unknown>][] }) => s.tapes[0]![1];
  const cases: [string, unknown][] = [
    ["a held trade at the settled slot", bad((s) => ((tape(s).held as unknown[][])[0]![1] = (tape(s).book as { settledTo: number }).settledTo))],
    ["a held trade's leg of zero", bad((s) => (((tape(s).held as unknown[][])[0]![3] as unknown[][])[0]![2] = "0"))],
    ["a venue this tape never reads", bad((s) => (((tape(s).held as unknown[][])[0]![3] as unknown[][])[0]![0] = "jupiter"))],
    ["a signature that is not base58", bad((s) => (tape(s).from = "0x" + "ab".repeat(40)))],
    ["USDC priced as SOL", bad((s) => (tape(s).quoteMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))],
    ["a fold from the future", bad((s) => (tape(s).readAt = clock.ms + 60_000))],
    ["a bar whose high is under its close", bad((s) => (((tape(s).book as { bars: Record<string, string[][]> }).bars["1m"]![0]![2] = "1")))],
    ["a trader that is no address", bad((s) => (s.traders[0]![1] = ["not-an-address"]))],
  ];
  for (const [what, s] of cases) {
    const c = chain();
    const next = helper(c, clock);
    assert.equal(next.t.restore(s), false, what);
    await next.t.trades(MINT, 50);
    assert.ok(c.asked.includes("sigs cold"), `${what}: the coin opened cold`);
    next.t.stop();
  }
});

test("card helper-tape-handover-judges-handed-books: a restored Solana tape's trades answer names the handover in its Server-Timing, and a cold one names nothing (red at main 5d7c3a99d: no answer said where its tape came from)", async () => {
  const clock = { ms: TS * 1000 };
  const old = helper(chain(), clock);
  const coldAnswer = await old.t.trades(MINT, 50);
  await settle();
  const again = await old.t.trades(MINT, 50);
  assert.ok(!(coldAnswer.timing ?? "").includes("handed") && !(again.timing ?? "").includes("handed"), `a cold tape is not named: ${coldAnswer.timing} / ${again.timing}`);
  const st = JSON.parse(JSON.stringify(old.t.state()));
  old.t.stop();
  clock.ms += 30_000;
  const next = helper(chain(), clock);
  assert.equal(next.t.restore(st), true);
  await settle();
  const handedOver = await next.t.trades(MINT, 50);
  assert.ok((JSON.parse(handedOver.body).trades as unknown[]).length > 0, "the restored tape answers its rows");
  assert.ok((handedOver.timing ?? "").includes(HANDED_TIMING), `a handed tape is named: ${handedOver.timing}`);
  next.t.stop();
});
