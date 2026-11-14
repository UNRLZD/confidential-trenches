// Card closed-positions-show-every-trade: a buy of several pieces, then a full sale, shows as a closed position on a
// device that rebuilds its trades from the chain (signed in again, or restored from the 12 words). The fresh wallet's
// history is mainnet's own, 13 Nov 18:05Z (fixtures/trade-fill: getTransaction "json" at finalized, the same on
// api.mainnet-beta.solana.com and solana-rpc.publicnode.com; the wallet's address swapped for this test seed's): the
// pool's plain release of one piece to W (33SLRx, tag 2), the buy (55LqP9, tag 3, PumpSwap), W's sale of all of it
// (2tmaLQ), its token account's close (4YDmgm), its volume account's close (2zXwLp) and its deposit back (2m39tv).
// The rebuild read stopped at the tag 2 and marked W "no buy" for good: no buy record, no trades, Closed empty.
//   node --test test/closed-pieces-buy.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore } from "@blindfill/wallet/store";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { onTestClock } from "../../kit/test/test-clock.ts";
import type { Operation } from "../../kit/src/signpage/messages.ts";
import { testnetPool } from "../src/pool-testnet.ts";
import { opOf } from "../src/state.ts";
import { closedRows, tradeBook, type PortfolioData } from "../../../apps/terminal/src/screens/portfolio/model.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN = { program: "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF", feePayer: "CPWhFyFL8naX5W8DEB5XTrEUR2XtkHv7kyXdavpqDTTU" };
const SCOPE = solanaPoolOf(PIN.program).scope;
const DIR = new URL("./fixtures/trade-fill/", import.meta.url);
const MINT = "4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump";
const OWNER_W = "3RrvTxXabDkApBYNuKijcNJDMkVVkkHcG1qR3sLVEQfn";
const realFetch = globalThis.fetch;
after(() => void (globalThis.fetch = realFetch));

for (const marked of [false, true])
test(`a buy of several pieces and its full sale, rebuilt from the chain: one closed position, its buy and its sale${marked ? "; a device the old read marked no buy reads W again" : ""}`, { timeout: 300_000 }, () => onTestClock(async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  after(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  const ref = { kind: "deposit" as const, s: SCOPE, i: 0 };
  const pre = noteSecrets(SEED64, ref).precommitment;
  const label = 311n;
  const r = await ns.add({ ref, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value: 10_000_000n, label, commitment: noteCommitment(10_000_000n, label, pre), leafIndex: 0n } });
  await ns.move(r.id, "UNSPENT", "SPENT");
  const fw = freshWallet(SEED64, "sol", label, jOf(ref));
  fw.secretKey.fill(0);
  const W = fw.address;
  ns.close();
  // the old read's mark (`true`), left by a device that read W before this card
  if (marked) await w.update("meta", "owed/buy-sol-none", () => ({ [W]: true }));

  const tx = (f: string): { sig: string; tx: { blockTime: number } } => {
    const t = JSON.parse(readFileSync(new URL(`${f}.json`, DIR), "utf8").split(OWNER_W).join(W)) as { blockTime: number; transaction: { signatures: string[] } };
    return { sig: t.transaction.signatures[0]!, tx: t };
  };
  // oldest first
  const history = ["33SLRx", "55LqP9", "2tmaLQ", "4YDmgm", "2zXwLp", "2m39tv"].map(tx);
  const txs = new Map(history.map((x) => [x.sig, x.tx] as const));
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    const p0 = b.params[0] as string;
    if (b.method === "getSignaturesForAddress") {
      if (p0 !== W) return ok([]);
      const until = (b.params[1] as { until?: string }).until;
      const all = [...history].reverse();
      const to = until === undefined ? -1 : all.findIndex(({ sig }) => sig === until);
      return ok((to < 0 ? all : all.slice(0, to)).map(({ sig }) => ({ signature: sig, err: null, slot: 5, blockTime: txs.get(sig)!.blockTime })));
    }
    if (b.method === "getTransaction") return ok(txs.get(p0) ?? null);
    if (b.method === "getTokenAccountsByOwner") return ok({ context: { slot: 100 }, value: [] });
    if (b.method === "getBalance") return ok({ context: { slot: 100 }, value: 0 });
    return ok(null);
  }) as typeof fetch;

  const tp = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED64.slice() }, { pin: PIN, positions: { setTimer: () => 0, clearTimer: () => {} } } as never);
  const ops = async (): Promise<Operation[]> => (await Promise.all((await w.keys("ops")).map(async (k) => opOf(k, await w.get("ops", k))))).filter((o): o is Operation => o !== null);
  await tp.positions();
  await tp.settle();
  // the rebuild and the figures run in the background: until the sale's units are in, or the rebuild's read is final
  let o: Operation[] = [];
  for (let i = 0; i < 400; i++) {
    o = await ops();
    const none = (await w.get("meta", "owed/buy-sol-none")) as Record<string, unknown> | undefined;
    if ((none?.[W] !== undefined && none[W] !== true) || o.some((x) => x.kind === "sell" && x.units !== undefined)) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const closed = tradeBook(o, []).closed;
  const rows = closedRows({ closed, market: () => null } as unknown as PortfolioData);
  assert.equal(rows.length, 1, `one closed position, not ${rows.length}: ops ${JSON.stringify(o.map((x) => [x.id, x.kind, x.stage, x.units]))}`);
  assert.equal(rows[0]!.token, MINT);
  assert.deepEqual(o.filter((x) => x.kind === "buy" || x.kind === "sell").map((x) => [x.kind, x.txs[0]?.hash.slice(0, 6)]).sort(), [["buy", "55LqP9"], ["sell", "2tmaLQ"]], "the buy is the tag 3, the sale W's own; the piece is no trade");
  assert.equal(closed[0]!.opened_at, history[1]!.tx.blockTime * 1000, "opened at the buy's block");
  assert.equal(closed[0]!.closed_at, history[2]!.tx.blockTime * 1000, "closed at the sale's block");
  assert.deepEqual((await w.get("meta", "owed/buy-sol-none")) as unknown, marked ? { [W]: true } : undefined, "W is not marked no buy by this read");
}));
