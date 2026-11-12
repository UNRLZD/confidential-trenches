// trade.ts createTradeReads and carryTrade's creation path on a stand-in of testnet's two providers that answers from
// recorded real answers (fixtures/trade-reads-testnet.json, test/record-trade-reads.ts: test.rpc.fastnear.com and
// near-testnet.drpc.org, the testnet vault's spends list, wrap.testnet's storage bounds, two accounts). The good record
// replays to what the chain said; a payout row changed on one provider is a disagreement (nothing decided), and on both
// is no payout (nothing created).
//   node --test apps/helper/src/bind/trade-reads.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RpcError, type Rpc } from "./send.ts";
import { carryTrade, createTradeReads, type TradeDeps } from "./trade.ts";

type Call = { url: string; method: string; params: unknown; result?: unknown; error?: unknown };
type Rec = { now: number; pair: [string, string]; vault: string; usdc: string; got: Record<string, unknown>; answers: Record<string, unknown>; calls: Call[] };
const REC = JSON.parse(readFileSync(new URL("./fixtures/trade-reads-testnet.json", import.meta.url), "utf8")) as Rec;
const PAID = "4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a";
const FRESH = "c0ffee".padEnd(64, "0");
const OUT = "wrap.testnet";

/**
 * The stand-in: each provider answers a call it was recorded answering, byte for byte, the same call's answers in the
 * order recorded (a final block moves between reads), the last one again once they run out; any other call throws.
 */
function standIn(calls: Call[]): readonly [Rpc, Rpc] {
  const seen = new Map<string, number>();
  return REC.pair.map((url) => async (method: string, params: unknown) => {
    const key = JSON.stringify([url, method, params]);
    const hits = calls.filter((c) => c.url === url && c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
    const i = seen.get(key) ?? 0;
    seen.set(key, i + 1);
    const hit = hits[Math.min(i, hits.length - 1)];
    if (hit === undefined) throw new Error(`${url} ${method}: not recorded ${JSON.stringify(params)}`);
    if (hit.error !== undefined) throw new RpcError(method, hit.error);
    return structuredClone(hit.result);
  }) as unknown as readonly [Rpc, Rpc];
}

type Row = { index: number; recipient: string; status: string; refund_value: string };
/** The record with every spends row of PAID changed by `change`, on the providers named. */
function rewritten(urls: readonly string[], change: (row: Row) => void): Call[] {
  return REC.calls.map((c) => {
    const p = c.params as { method_name?: string } | undefined;
    if (!urls.includes(c.url) || c.method !== "query" || p?.method_name !== "spends") return c;
    const r = c.result as { result: number[] };
    const rows = JSON.parse(Buffer.from(r.result).toString("utf8")) as Row[];
    for (const row of rows) if (row.recipient === PAID) change(row);
    return { ...c, result: { ...r, result: [...Buffer.from(JSON.stringify(rows))] } };
  });
}
/** Every paid or settled spends row of PAID read as refund_pending, on the providers named. */
const bounced = (urls: readonly string[]) => rewritten(urls, (row) => void (row.status = "refund_pending"));

const relayer = {
  account: "standin.testnet",
  key: "standin.testnet/ed25519:none",
  balance: async () => 10n ** 27n,
  send: async () => assert.fail("nothing is sent"),
  resolve: async () => assert.fail("nothing is sent"),
};
const store = { get: () => null, create: (rec: never) => ({ created: true, rec }), put() {}, close() {} };
const depsOn = (rpcs: readonly [Rpc, Rpc]) => ({ cfg: { network: "testnet", marginK: 30n }, reads: createTradeReads(rpcs, REC.vault, REC.usdc, () => REC.now, "ref-finance-101.testnet"), store, relayer, held: async () => false }) as unknown as TradeDeps;
const trade = (wallet: string) => ({ network: "testnet", side: "buy", token: OUT, wallet, amount_in: "1000000", slippage_bps: 100, venue_out: "1", hops: [{ pool: 0, token_in: REC.usdc, token_out: OUT }] });

test("good answer: the real reads replay to what both providers said: PAID's payout landed, FRESH none; the storage minimum; the creation path takes PAID as it is and refuses FRESH, nothing sent", async () => {
  const deps = depsOn(standIn(REC.calls));
  const r = deps.reads;
  const got = {
    paidLanded: await r.payoutLanded(PAID),
    freshLanded: await r.payoutLanded(FRESH),
    paidAccount: await r.account(PAID),
    freshAccount: await r.account(FRESH),
    storageMin: (await r.storageMin(OUT)).toString(),
    freshRegistered: (await r.registered([OUT], FRESH))[0],
    paidUsdc: (await r.ftBalance(REC.usdc, PAID)).toString(),
    hopUsdcWrap: await r.hopsReal([{ pool: 0, tokenIn: REC.usdc, tokenOut: OUT }]),
  };
  assert.deepEqual(got, REC.got);
  assert.deepEqual(got, { paidLanded: true, freshLanded: false, paidAccount: { kind: "account" }, freshAccount: { kind: "absent" }, storageMin: "1250000000000000000000", freshRegistered: false, paidUsdc: "587365", hopUsdcWrap: false });
  // the creation path next, on the same stand-in, as the recorder ran it
  // PAID exists and was paid: taken as it is, nothing sent
  assert.deepEqual(await carryTrade({ trade: trade(PAID), signed_delegates: [] }, deps), { status: 200, body: { tx_hashes: [] } });
  assert.deepEqual(await carryTrade({ trade: trade(FRESH), signed_delegates: [] }, deps), { status: 409, body: { error: { code: "no_payout" } } });
  assert.deepEqual(REC.answers, { paid: { status: 200, body: { tx_hashes: [] } }, fresh: { status: 409, body: { error: { code: "no_payout" } } } });
});

test("bad answer: PAID's payout rows read refund_pending on one provider is a disagreement, nothing decided; on both, no payout", async () => {
  const one = depsOn(standIn(bounced([REC.pair[1]])));
  await assert.rejects(one.reads.payoutLanded(PAID), /disagree/);
  const both = depsOn(standIn(bounced(REC.pair)));
  assert.equal(await both.reads.payoutLanded(PAID), false);
});

test("bad answer: PAID's rows read settled with part of the payout sent back (refund_value not 0) on both providers is no payout", async () => {
  const both = depsOn(standIn(rewritten(REC.pair, (row) => {
    row.status = "settled";
    row.refund_value = "5";
  })));
  assert.equal(await both.reads.payoutLanded(PAID), false);
});

test("bad answer: a row of PAID's read again at a later block that names another recipient is refused, not taken as a payout", async () => {
  // the first read sees PAID's rows still refund_pending (not landed); the second reads each one again by its index at
  // the newer final block, and both providers answer that row with another recipient, paid
  const calls = bounced(REC.pair);
  const first = (JSON.parse(Buffer.from((calls.find((c) => (c.params as { method_name?: string }).method_name === "spends")!.result as { result: number[] }).result).toString("utf8")) as Row[]);
  const inner = standIn(calls);
  const rpcs = inner.map((rpc) => (async (method: string, params: unknown) => {
    const p = params as { method_name?: string; args_base64?: string; block_id?: number } | undefined;
    const args = p?.method_name === "spends" ? (JSON.parse(Buffer.from(p.args_base64!, "base64").toString("utf8")) as { from: number; limit: number }) : null;
    if (args === null || args.limit !== 1) return rpc(method, params);
    const at = (await rpc(method, { ...p, args_base64: Buffer.from(JSON.stringify({ from: 8, limit: 100 })).toString("base64") })) as Record<string, unknown>;
    const row = { ...first.find((r) => r.index === args.from)!, recipient: FRESH, status: "paid", refund_value: "0" };
    return { ...at, result: [...Buffer.from(JSON.stringify([row]))] };
  }) as Rpc) as unknown as readonly [Rpc, Rpc];
  const r = depsOn(rpcs).reads;
  assert.equal(await r.payoutLanded(PAID), false);
  await assert.rejects(r.payoutLanded(PAID), /not this recipient's/);
});

test("hops: pool 0 as both providers read it (wrap.testnet and rft.tokenfactory.testnet) holds a hop of its two tokens; a hop whose output it does not hold, one token to itself, or a pool past the exchange's count is not real", async () => {
  // every final-block read answers the block the pool reads were recorded at
  const H = 277329668;
  const blockAt = (url: string) => REC.calls.find((c) => c.url === url && c.method === "block" && (c.result as { header: { height: number } }).header.height === H)!.result;
  const rpcs = REC.pair.map((url) => async (method: string, params: unknown) => {
    if (method === "block") return structuredClone(blockAt(url));
    const hit = REC.calls.find((c) => c.url === url && c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
    if (hit === undefined) throw new Error(`${url} ${method}: not recorded ${JSON.stringify(params)}`);
    return structuredClone(hit.result);
  }) as unknown as readonly [Rpc, Rpc];
  const r = createTradeReads(rpcs, REC.vault, REC.usdc, () => REC.now, "ref-finance-101.testnet");
  const A = "wrap.testnet";
  const B = "rft.tokenfactory.testnet";
  assert.equal(await r.hopsReal([{ pool: 0, tokenIn: A, tokenOut: B }]), true);
  assert.equal(await r.hopsReal([{ pool: 0, tokenIn: B, tokenOut: A }]), true);
  assert.equal(await r.hopsReal([{ pool: 0, tokenIn: A, tokenOut: REC.usdc }]), false); // the output not in the pool
  assert.equal(await r.hopsReal([{ pool: 0, tokenIn: A, tokenOut: A }]), false); // one token to itself
  assert.equal(await r.hopsReal([{ pool: 2952, tokenIn: A, tokenOut: B }]), false); // past the count: no get_pool read
});
