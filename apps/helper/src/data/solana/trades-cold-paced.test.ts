// node --test apps/helper/src/data/solana/trades-cold-paced.test.ts: card helper-fresh-tapes-whole-from-the-first-minute.
// helper-25's live run 45032297159 (ee5c7dac4, 22 Nov 14:39:3xZ) read two listed Solana tapes (DMrHhifZ...AEfZL and
// HhgVYyNA...NqyFh) "still filling 45944 ms after its first read (21 reads)": each a coin whose trades no venue here
// decodes, served the vendor's rows, filling while its own walk stays cold (trades: reading). The helper's saved log
// names what the walks read on: the trades key answered spent at boot ("solana trades fallback (credits)", as on every
// helper since 10:57Z), so the walks drew the remaining providers' background budget, a borrowed key's share of a second
// and the public endpoint's, held 10 s at a time in the minutes the check ran ("rpc hold solana-public background 10 s",
// 104 in the log). A cold walk reads its newest COLD_SIGS transactions TX_PARALLEL at once, and one read our own budget
// kept from every provider failed the whole walk, which began again from its first page after 1, 2, 4, 8, 16, then 30 s.
// A fresh helper opens every tape cold; a warm one's are live and walk only what the stream misses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { COLD_SIGS, createSolanaTrades, PYTH_RECEIVER, PYTH_SOL_USD } from "./trades.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-trades-txs.json"), "utf8")) as { txs: Record<string, { signature: string; result: { slot: number; meta: { logMessages: string[] } } }> };
const BUY = F.txs["pump-buy"]!;
const MINT = "4Tdj8MDuQ7Nx1drP1fkf1H4FVvUDrgZ3kbgQpHWXpump";
const TS = 1793739241;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
/** The live checks' bound (scripts/live-checks/tape-read.mjs FILLED_MS). */
const FILLED_MS = 45_000;
/** The background reads our budget lets go a second, every provider together. */
const PER_S = 3;

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

test(`a cold walk of ${COLD_SIGS} transactions on a background budget of ${PER_S} reads a second: a read the budget holds waits its turn, never failing the walk, and the tape is no longer filling inside 45 s (red at ee5c7dac4: still filling)`, async () => {
  const start = TS * 1000;
  const sigs = Array.from({ length: COLD_SIGS }, (_, i) => ({ signature: `${BUY.signature.slice(0, 80)}${String(i).padStart(8, "1")}`, slot: BUY.result.slot - i, err: null, blockTime: TS - i }));
  const { value } = await onVirtualTime(start, async () => {
    const mintData = Buffer.alloc(82);
    mintData[44] = 6;
    mintData[45] = 1;
    let sent = 0;
    const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
      sent++;
      const req = JSON.parse(String(init.body)) as { method: string; params: [string, Record<string, unknown>] };
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
      const acct = (owner: string, data: Buffer) => ok({ context: { slot: BUY.result.slot }, value: { owner, data: [data.toString("base64"), "base64"] } });
      if (req.method === "getAccountInfo" && req.params[0] === PYTH_SOL_USD) return acct(PYTH_RECEIVER, pyth(9_342_267_796n, Math.floor(Date.now() / 1000)));
      if (req.method === "getAccountInfo" && req.params[0] === MINT) return acct(TOKEN_PROGRAM, mintData);
      // the mint's COLD_SIGS signatures and one more page with none: the list ran out
      if (req.method === "getSignaturesForAddress") return ok(req.params[1]?.before === undefined ? sigs : []);
      if (req.method === "getTransaction") {
        const s = sigs.find((x) => x.signature === req.params[0]);
        return ok(s === undefined ? null : { ...BUY.result, slot: s.slot, blockTime: s.blockTime, transaction: { signatures: [s.signature] } });
      }
      throw new Error(`unexpected ${req.method}`);
    };
    // the reads let go in the last second, every provider together (rpc.ts background draws one budget a chain)
    const drawn: number[] = [];
    const budget = (): number => {
      const t = Date.now();
      while (drawn.length > 0 && t - drawn[0]! >= 1_000) drawn.shift();
      if (drawn.length >= PER_S) return 1;
      drawn.push(t);
      return 0;
    };
    const t = createSolanaTrades({
      fetch: fetch as never,
      now: () => Date.now(),
      listed: async (m) => m === MINT,
      rpcs: ["https://keyed.test", "https://public.test"],
      budget,
      source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
      tickMs: 0,
    });
    const reads: { at: number; filling: boolean; n: number }[] = [];
    // the page's reads, 3 s apart (as the live check reads), until the tape is no longer filling or well past the bound
    for (;;) {
      const a = JSON.parse((await t.trades(MINT, 50)).body) as { trades: unknown[]; filling?: boolean };
      reads.push({ at: Date.now() - start, filling: a.filling === true, n: a.trades.length });
      if (a.filling !== true || Date.now() - start > FILLED_MS + 30_000) break;
      await new Promise((go) => setTimeout(go, 3_000));
    }
    t.stop();
    return { reads, sent };
  });
  const last = value.reads.at(-1)!;
  const line = `${value.reads.map((r) => `${r.at} ms ${r.filling ? "filling" : "done"} n${r.n}`).join(", ")}; ${value.sent} sent`;
  console.log(line);
  assert.equal(last.filling, false, `still filling: ${line}`);
  assert.ok(last.at <= FILLED_MS, `done ${last.at} ms after the first read, past ${FILLED_MS}: ${line}`);
});
