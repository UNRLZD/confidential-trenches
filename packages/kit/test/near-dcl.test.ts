// The Rhea DCL quote and its Swap (src/near/dcl.ts), card near-dcl-route.
// - Replayed on real mainnet answers of both providers (fixtures/near-dcl-quotes.json, 2026-11-16, each view cut to the
//   fields dcl.ts reads): the path and the output are DCL's own quote view for the best path at the quote's block, and
//   the hoot token's 2% fee (its get_config, scoped to dclv2) comes off the buyer's amount.
// - Two providers that disagree or answer another block refuse; so do a paused DCL, a frozen token, a pool that is taxed,
//   whitelisted, not Running or not the id's own row, and a path that pays 0.
// - The Swap's msg is the exact bytes of mainnet tx BU6Jy6p55mi22kT64noFGN2xfm269JzhfwXz92wJcpNw's shape (no referral),
//   with the quote's pool ids, fee tiers and the device's own minimum; dclSwapCheck refuses every other one.
//   node --test test/near-dcl.test.ts      (from packages/kit)
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dclPoolOf, dclQuote, dclSwapCalls, dclSwapCheck, dclSwapMsg, NEAR_DCL, type DclQuote } from "@blindfill/kit";
import { RheaQuoteRefused, type RheaRefusalCode } from "@blindfill/kit";
import { NEAR_SWAP_GAS, NearSwapRefused, type NearSwapCall, type NearSwapRequest } from "@blindfill/kit";

const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const HOODL = "hoodl-95275b.launchpad.justhoot.near";
const DCL = "dclv2.ref-labs.near";
const W = "a".repeat(64);
type Logged = { url: string; params: Record<string, unknown>; answer: { result?: { result?: number[]; block_height: number; block_hash: string; error?: string } } };
type Run = { name: string; side: "buy" | "sell"; token: string; amountIn: string; pools: string[]; height: number; poolIds: string[]; venueIn: string; venueOut: string; amountOut: string; feeBps: [number, number]; log: Logged[] };
const { runs } = JSON.parse(readFileSync(new URL("./fixtures/near-dcl-quotes.json", import.meta.url), "utf8")) as { runs: Run[] };
const run = (side: "buy" | "sell", token: string) => runs.find((r) => r.side === side && r.token === token) as Run;

const enc = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
const dec = (b: number[]) => JSON.parse(new TextDecoder().decode(Uint8Array.from(b)));
/** The run's two providers replayed, `edit` changing an answer of one (or both) before it is given. */
function replay(log: Logged[], edit?: (url: string, params: Record<string, unknown>, answer: Logged["answer"]) => void) {
  const key = (p: Record<string, unknown>) => JSON.stringify(p);
  return [FAST, DRPC].map((url) => ({
    name: url,
    async query(params: Record<string, unknown>) {
      const hit = log.find((l) => l.url === url && key(l.params) === key(params));
      if (!hit) throw new Error(`not recorded: ${url} ${key(params)}`);
      const a = structuredClone(hit.answer);
      edit?.(url, params, a);
      return a;
    },
  })) as unknown as Parameters<typeof dclQuote>[0]["rpcs"];
}
const args = (r: Run, edit?: Parameters<typeof replay>[1]) => ({ network: "mainnet" as const, rpcs: replay(r.log, edit), side: r.side, token: r.token, amountIn: BigInt(r.amountIn), pools: r.pools });
const viewArgs = (p: Record<string, unknown>) => JSON.parse(atob(p.args_base64 as string));
async function refused(p: Promise<unknown>, code: RheaRefusalCode) {
  await assert.rejects(p, (e: unknown) => e instanceof RheaQuoteRefused && e.code === code);
}

// ---------- real quotes, replayed ----------
test("D1 replayed on real mainnet answers of both providers, the quote is DCL's own quote view for the best path at its block", async () => {
  assert.ok(runs.length >= 3);
  for (const r of runs) {
    const q = await dclQuote(args(r));
    assert.equal(q.venue, "dcl");
    assert.equal(q.exchange, DCL);
    assert.equal(q.height, r.height);
    assert.deepEqual(q.poolIds, r.poolIds, r.name);
    assert.equal(String(q.venueOut), r.venueOut, r.name);
    assert.equal(String(q.amountOut), r.amountOut, r.name);
    // independent of dcl.ts: the largest amount any quote view in the log answered, and its path
    const quotes = r.log.filter((l) => l.url === FAST && l.params.method_name === "quote").map((l) => ({ path: viewArgs(l.params).pool_ids, amount: BigInt(dec(l.answer.result!.result!).amount) }));
    const top = quotes.reduce((a, b) => (b.amount > a.amount ? b : a));
    assert.deepEqual([q.poolIds, q.venueOut], [top.path, top.amount], `${r.name}: the best of DCL's own quotes`);
  }
  // the hoot launchpad's fee: 200 bps, scoped to DCL, comes off what the buyer receives
  const buy = await dclQuote(args(run("buy", HOODL)));
  assert.deepEqual([buy.fee.buyBps, buy.fee.scope, buy.fee.unknown], [200, [DCL], false]);
  assert.equal(buy.amountOut, (buy.venueOut * 9_800n) / 10_000n);
  assert.deepEqual(buy.poolIds, [`${USDC}|wrap.near|100`, `${HOODL}|wrap.near|10000`], "USDC to wNEAR, then wNEAR to the token");
  // a pool id with no pool (get_pool null) is left out, not refused
  assert.ok(run("buy", HOODL).pools.includes(`${HOODL}|wrap.near|400`));
  const sell = await dclQuote(args(run("sell", HOODL)));
  assert.equal(sell.venueIn, (sell.amountIn * 9_800n) / 10_000n, "the sell's fee comes off what DCL receives");
});

// ---------- refusals ----------
test("D2 two providers that disagree on a quote, a pool or DCL's state refuse; an answer at another block refuses", async () => {
  const r = run("buy", HOODL);
  const bump = (m: string) => (url: string, p: Record<string, unknown>, a: Logged["answer"]) => {
    if (url !== DRPC || p.method_name !== m) return;
    const v = dec(a.result!.result!);
    if (m === "quote") v.amount = String(BigInt(v.amount) + 1n);
    else v.state = v.state + " ";
    a.result!.result = enc(v);
  };
  await refused(dclQuote(args(r, bump("quote"))), "disagree");
  await refused(dclQuote(args(r, bump("get_pool"))), "disagree");
  await refused(dclQuote(args(r, bump("get_metadata"))), "disagree");
  await refused(dclQuote(args(r, (url, p, a) => void (url === DRPC && p.method_name === "quote" && (a.result!.block_height += 1)))), "rpc");
  await refused(dclQuote(args(r, (url, p, a) => void (url === FAST && p.method_name === "get_pool" && (a.result!.block_hash = "x")))), "disagree");
});

test("D3 a paused DCL, a frozen token, a pool not open to W, not Running or not its id's row, and a path that pays 0 refuse", async () => {
  const r = run("buy", HOODL);
  const both = (m: string, f: (v: any, p: Record<string, unknown>) => unknown) => (_u: string, p: Record<string, unknown>, a: Logged["answer"]) => {
    if (p.method_name === m) a.result!.result = enc(f(dec(a.result!.result!), p));
  };
  await refused(dclQuote(args(r, both("get_metadata", (v) => ({ ...v, state: "Paused" })))), "paused");
  await refused(dclQuote(args(r, both("get_frozenlist_tokens", () => [HOODL]))), "frozen");
  const tokenPool = (f: (v: any) => unknown) => both("get_pool", (v) => (v !== null && v.token_x === HOODL ? f(v) : v));
  await refused(dclQuote(args(r, tokenPool((v) => ({ ...v, tax: { rate: 1 } })))), "no-pool");
  await refused(dclQuote(args(r, tokenPool((v) => ({ ...v, whitelist: ["intents.near"] })))), "no-pool");
  await refused(dclQuote(args(r, tokenPool((v) => ({ ...v, state: "Paused" })))), "no-pool");
  await refused(dclQuote(args(r, tokenPool((v) => ({ ...v, fee: 400 })))), "pool");
  await refused(dclQuote(args(r, tokenPool((v) => ({ ...v, token_y: "evil.near" })))), "pool");
  await refused(dclQuote(args(r, both("quote", () => ({ amount: "0", tag: null })))), "liquidity");
  await refused(dclQuote(args(r, both("quote", () => ({ amount: "-1", tag: null })))), "rpc");
  await refused(dclQuote(args(r, both("quote", () => ({ amount: "5", tag: "x" })))), "rpc");
});

test("D4 the request: mainnet only, the network's pair, 1 to 8 distinct DCL pool ids, the token not USDC", async () => {
  const r = run("buy", HOODL);
  await refused(dclQuote({ ...args(r), network: "testnet" }), "input");
  await refused(dclQuote({ ...args(r), rpcs: [args(r).rpcs[0], args(r).rpcs[0]] as never }), "input");
  await refused(dclQuote({ ...args(r), pools: [] }), "input");
  await refused(dclQuote({ ...args(r), pools: [r.pools[0]!, r.pools[0]!] }), "input");
  await refused(dclQuote({ ...args(r), pools: Array.from({ length: 9 }, (_, i) => `a${i}.near|wrap.near|100`) }), "input");
  await refused(dclQuote({ ...args(r), pools: ["wrap.near|a.near|100"] }), "input"); // not lower first
  await refused(dclQuote({ ...args(r), pools: ["a.near|wrap.near"] }), "input");
  await refused(dclQuote({ ...args(r), token: USDC }), "input");
  await refused(dclQuote({ ...args(r), amountIn: 0n }), "input");
  assert.deepEqual(dclPoolOf(`${HOODL}|wrap.near|10000`), { x: HOODL, y: "wrap.near", fee: 10000 });
  assert.equal(dclPoolOf("a.near|b.near|0"), null);
  assert.equal(dclPoolOf("a.near|b.near|1000000"), null);
  assert.equal(NEAR_DCL.mainnet.exchange, DCL);
});

// ---------- the Swap ----------
const req = (q: DclQuote, slippageBps = 100): NearSwapRequest => ({ network: "mainnet", side: q.side, token: q.token, amountIn: q.amountIn, wallet: W, slippageBps });

test("D5 the buy's Swap: exact msg bytes, pool ids and fee tiers of the quote, the device's own minimum, into DCL from W", async () => {
  const q = await dclQuote(args(run("buy", HOODL)));
  const floor = (q.venueOut * 9_900n) / 10_000n;
  const msg = `{"Swap":{"pool_ids":["${USDC}|wrap.near|100","${HOODL}|wrap.near|10000"],"output_token":"${HOODL}","min_output_amount":"${floor}","skip_unwrap_near":true}}`;
  assert.equal(dclSwapMsg(q, floor), msg);
  assert.equal(String(floor), "61514920860214997360555");
  const calls = dclSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: true, storageMin: 1n }, req(q));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { sender_id: W, receiver_id: USDC, actions: [{ FunctionCall: { method_name: "ft_transfer_call", args: { receiver_id: DCL, amount: "1000000", msg }, gas: NEAR_SWAP_GAS.ft_transfer_call, deposit: "1" } }] },
  ]);
  // not registered on the output token: its registration alone
  const reg = dclSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: false, storageMin: 1_250_000_000_000_000_000_000n }, req(q));
  assert.deepEqual(JSON.parse(JSON.stringify(reg)), [
    { sender_id: W, receiver_id: HOODL, actions: [{ FunctionCall: { method_name: "storage_deposit", args: { account_id: W, registration_only: true }, gas: NEAR_SWAP_GAS.storage_deposit, deposit: "1250000000000000000000" } }] },
  ]);
});

test("D6 the sell's Swap: the token into DCL, USDC out, the minimum from the quote of what DCL receives", async () => {
  const q = await dclQuote(args(run("sell", HOODL)));
  const floor = (q.venueOut * 9_900n) / 10_000n;
  const msg = `{"Swap":{"pool_ids":["${HOODL}|wrap.near|10000","${USDC}|wrap.near|100"],"output_token":"${USDC}","min_output_amount":"${floor}","skip_unwrap_near":true}}`;
  const [c] = dclSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: true, storageMin: 1n }, req(q));
  assert.equal(c!.receiver_id, HOODL);
  assert.deepEqual(c!.actions[0].FunctionCall.args, { receiver_id: DCL, amount: run("sell", HOODL).amountIn, msg });
  assert.equal(String(floor), "15296");
});

test("D7 dclSwapCheck refuses every other Swap: another pool, fee tier, order, output, minimum, key, receiver, amount, gas or signer", async () => {
  const q = await dclQuote(args(run("buy", HOODL)));
  const good = dclSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: true, storageMin: 1n }, req(q));
  const ctx = { quote: q, storageMin: 1n, registered: true };
  const floor = (q.venueOut * 9_900n) / 10_000n;
  const withMsg = (f: (s: Record<string, unknown>) => void): NearSwapCall[] => {
    const c = structuredClone(good) as NearSwapCall[];
    const m = JSON.parse(c[0]!.actions[0].FunctionCall.args.msg as string);
    f(m.Swap);
    c[0]!.actions[0].FunctionCall.args.msg = JSON.stringify(m);
    return c;
  };
  const no = (calls: NearSwapCall[], code: string, r = req(q)) => assert.throws(() => dclSwapCheck(calls, r, ctx), (e: unknown) => e instanceof NearSwapRefused && e.code === code);
  dclSwapCheck(good, req(q), ctx);
  no(withMsg((s) => void ((s.pool_ids as string[])[1] = `${HOODL}|wrap.near|2000`)), "N4"); // another fee tier
  no(withMsg((s) => void ((s.pool_ids as string[])[0] = `${USDC}|wrap.near|2000`)), "N4");
  no(withMsg((s) => void (s.pool_ids as string[]).reverse()), "N4");
  no(withMsg((s) => void (s.pool_ids = [(s.pool_ids as string[])[1]])), "N4");
  no(withMsg((s) => void (s.output_token = "wrap.near")), "N4");
  no(withMsg((s) => void (s.min_output_amount = String(floor - 1n))), "N4");
  no(withMsg((s) => void (s.min_output_amount = "0")), "N4");
  no(withMsg((s) => void (s.referral_id = "x.near")), "N4");
  no(withMsg((s) => void (s.skip_unwrap_near = false)), "N4");
  no(withMsg((s) => void (s.client_echo = "x")), "N4");
  const edit = (f: (c: NearSwapCall) => void) => {
    const c = structuredClone(good) as NearSwapCall[];
    f(c[0]!);
    return c;
  };
  no(edit((c) => void (c.actions[0].FunctionCall.args.msg = (c.actions[0].FunctionCall.args.msg as string).replace(":true}}", ": true}}"))), "N4"); // same meaning, other bytes
  no(edit((c) => void (c.actions[0].FunctionCall.args.receiver_id = "v2.ref-finance.near")), "N2");
  no(edit((c) => void (c.receiver_id = "evil.near")), "N2");
  no(edit((c) => void (c.actions[0].FunctionCall.args.amount = "1000001")), "N1");
  no(edit((c) => void (c.actions[0].FunctionCall.gas += 1)), "N7");
  no(edit((c) => void (c.actions[0].FunctionCall.deposit = "2")), "N3");
  no(edit((c) => void (c.sender_id = "b".repeat(64))), "N1");
  no([...good, ...good], "N3");
  no(good, "N1", { ...req(q), amountIn: 2n });
  no(good, "N1", { ...req(q), token: "other.near" });
  assert.throws(() => dclSwapCheck(good, req(q), { ...ctx, registered: false }), (e: unknown) => e instanceof NearSwapRefused && e.code === "N3");
  // a classic quote is never a DCL one
  assert.throws(() => dclSwapCheck(good, req(q), { ...ctx, quote: { ...q, venue: "rhea" } as unknown as DclQuote }), (e: unknown) => e instanceof NearSwapRefused && e.code === "N1");
});
