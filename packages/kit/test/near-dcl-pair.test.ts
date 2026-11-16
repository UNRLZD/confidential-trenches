// W and the better of Rhea classic and Rhea DCL at one block (src/trade/near/wallet.ts readNearSwapPair with dclPools),
// card near-dcl-sell.
// - DCL's side is the recorded mainnet sell of 1,000 hoodl (fixtures/near-dcl-quotes.json, block 224792744, both
//   providers); W's reads and the classic pool are answered at that same block and hash, the classic pool's reserves
//   set so classic pays more, or less, than DCL's own quote view.
// - The venue that pays more is the pair's quote; a venue refused for no pool or no liquidity is skipped; both refused
//   is refused; any other refusal (two providers apart) refuses the pair, never hands it to the other venue.
//   node --test test/near-dcl-pair.test.ts      (from packages/kit)
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dclQuote, rheaQuote, RheaQuoteRefused } from "@blindfill/kit";
import { isDclQuote, nearQuote, readNearSwapPair } from "../src/trade/near/wallet.ts";

const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const HOODL = "hoodl-95275b.launchpad.justhoot.near";
const EX = "v2.ref-finance.near";
const WID = "0".repeat(64);
type Logged = { url: string; params: Record<string, unknown>; answer: { result: { block_height: number; block_hash: string; result?: number[] } } };
type Run = { side: "buy" | "sell"; token: string; amountIn: string; pools: string[]; height: number; poolIds: string[]; amountOut: string; log: Logged[] };
const { runs } = JSON.parse(readFileSync(new URL("./fixtures/near-dcl-quotes.json", import.meta.url), "utf8")) as { runs: Run[] };
const SELL = runs.find((r) => r.side === "sell" && r.token === HOODL)!;
const H = SELL.height;
const HASH = SELL.log.find((l) => l.params.method_name === "get_metadata")!.answer.result.block_hash;
const enc = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
const argsOf = (p: Record<string, unknown>) => JSON.parse(atob(p.args_base64 as string));

/** The classic pool 7: hoodl / USDC with `usdc` units of USDC against 1,000 hoodl (0.3%). */
const classicRow = (usdc: bigint) => ({ pool_kind: "SIMPLE_POOL", token_account_ids: [HOODL, USDC], amounts: ["1000000000000000000000", usdc.toString()], total_fee: 30, shares_total_supply: "1", amp: 0 });
type Edit = (url: string, p: Record<string, unknown>, v: unknown) => unknown;
/** The two providers: DCL's recorded answers, W's and Rhea classic's made at the same block. */
function chain(usdc: bigint, edit: Edit = (_u, _p, v) => v) {
  const made = (p: Record<string, unknown>): unknown => {
    if (p.request_type === "view_access_key_list") return { keys: [{ public_key: `ed25519:${"1".repeat(32)}`, access_key: { nonce: 40, permission: "FullAccess" } }] };
    const m = `${String(p.account_id)}.${String(p.method_name)}`;
    const views: Record<string, unknown> = {
      [`${HOODL}.ft_balance_of`]: SELL.amountIn,
      [`${USDC}.ft_balance_of`]: "0",
      [`${USDC}.storage_balance_of`]: { total: "1250000000000000000000", available: "0" },
      [`${USDC}.storage_balance_bounds`]: { min: "1250000000000000000000", max: "1250000000000000000000" },
      [`${EX}.get_lostfound_token`]: "0",
      [`${EX}.metadata`]: { state: "Running" },
      [`${EX}.get_frozenlist_tokens`]: [],
    };
    if (m === `${EX}.get_pool_by_ids`) return (argsOf(p).pool_ids as number[]).map(() => classicRow(usdc));
    if (!(m in views)) throw new Error(`not made: ${m}`);
    return views[m];
  };
  return [FAST, DRPC].map((url) => ({
    name: url,
    async query(params: Record<string, unknown>) {
      const key = JSON.stringify(params);
      const hit = SELL.log.find((l) => l.url === url && JSON.stringify(l.params) === key);
      if (hit) {
        const a = structuredClone(hit.answer);
        if (Array.isArray(a.result.result)) a.result.result = enc(edit(url, params, JSON.parse(new TextDecoder().decode(Uint8Array.from(a.result.result)))));
        return a;
      }
      if (params.block_id !== H) throw new Error(`not at the recorded block: ${key}`);
      const v = edit(url, params, made(params));
      const result = params.request_type === "view_access_key_list" ? { ...(v as object), block_height: H, block_hash: HASH } : { result: enc(v), logs: [], block_height: H, block_hash: HASH };
      return { jsonrpc: "2.0", id: "1", result };
    },
  })) as unknown as Parameters<typeof rheaQuote>[0]["rpcs"];
}
const ask = (rpcs: ReturnType<typeof chain>) => ({ network: "mainnet" as const, rpcs, wallet: WID, side: "sell" as const, token: HOODL, amountIn: BigInt(SELL.amountIn), pools: [7], dclPools: SELL.pools });
const DCL_OUT = BigInt(SELL.amountOut); // 15451: DCL's own quote view, two pools through wNEAR

test("V1 DCL pays more than classic: the pair's quote is DCL's, its pool ids and amount DCL's own quote view at W's block", async () => {
  const rpcs = chain(20_000n); // classic pays about 9,970
  const classic = await rheaQuote({ network: "mainnet", rpcs, side: "sell", token: HOODL, amountIn: BigInt(SELL.amountIn), pools: [7] });
  assert.ok(classic.amountOut < DCL_OUT, `classic ${classic.amountOut}`);
  const p = await readNearSwapPair(ask(rpcs));
  assert.ok(isDclQuote(p.quote));
  if (!isDclQuote(p.quote)) return;
  assert.equal(p.quote.venue, "dcl");
  assert.deepEqual(p.quote.poolIds, SELL.poolIds);
  assert.equal(p.quote.amountOut, DCL_OUT);
  assert.deepEqual([p.state.height, p.state.blockHash, p.quote.height, p.quote.blockHash], [H, HASH, H, HASH]);
  assert.equal(p.state.held, BigInt(SELL.amountIn));
});

test("V2 classic pays more than DCL: the pair's quote is classic's, exactly the classic quote alone", async () => {
  const rpcs = chain(100_000n); // classic pays about 49,850
  const classic = await rheaQuote({ network: "mainnet", rpcs, side: "sell", token: HOODL, amountIn: BigInt(SELL.amountIn), pools: [7] });
  assert.ok(classic.amountOut > DCL_OUT);
  const p = await readNearSwapPair(ask(rpcs));
  assert.ok(!isDclQuote(p.quote));
  assert.equal(p.quote.amountOut, classic.amountOut);
  assert.equal(p.quote.exchange, EX);
});

test("V3 one venue refused for no pool or no liquidity is skipped; both refused is refused; another refusal is never skipped", async () => {
  // DCL: no pool at any id (get_pool null): classic, though it pays less
  const noDcl = chain(20_000n, (_u, p, v) => (p.method_name === "get_pool" ? null : v));
  const a = await readNearSwapPair(ask(noDcl));
  assert.equal(a.quote.exchange, EX);
  // DCL: a path that pays 0 (liquidity): classic
  const dry = chain(20_000n, (_u, p, v) => (p.method_name === "quote" ? { amount: "0", tag: null } : v));
  assert.equal((await readNearSwapPair(ask(dry))).quote.exchange, EX);
  // classic: no pool of the token (another pair's row): DCL, though classic was asked first
  const noClassic = chain(100_000n, (_u, p, v) => (p.method_name === "get_pool_by_ids" ? [{ ...classicRow(1n), token_account_ids: ["a.near", "b.near"] }] : v));
  const b = await readNearSwapPair(ask(noClassic));
  assert.ok(isDclQuote(b.quote));
  // both: refused, nothing to sign
  const none = chain(100_000n, (_u, p, v) => (p.method_name === "get_pool" ? null : p.method_name === "get_pool_by_ids" ? [{ ...classicRow(1n), token_account_ids: ["a.near", "b.near"] }] : v));
  await assert.rejects(readNearSwapPair(ask(none)), (e: unknown) => e instanceof RheaQuoteRefused && e.code === "no-pool");
  // DCL's two providers apart: refused, never the classic quote in its place
  const apart = chain(20_000n, (u, p, v) => (u === DRPC && p.method_name === "quote" ? { amount: "15452", tag: null } : v));
  await assert.rejects(readNearSwapPair(ask(apart)), (e: unknown) => e instanceof RheaQuoteRefused && e.code === "disagree");
  // no classic candidates at all: DCL alone
  const only = await readNearSwapPair({ ...ask(chain(20_000n)), pools: [] });
  assert.ok(isDclQuote(only.quote));
});

test("V4 with no DCL pools the pair is classic alone, as before: one quote, no DCL read", async () => {
  const asked: string[] = [];
  const rpcs = chain(20_000n, (_u, p, v) => (asked.push(String(p.account_id)), v));
  const { dclPools: _d, ...classicOnly } = ask(rpcs);
  const p = await readNearSwapPair(classicOnly);
  assert.equal(p.quote.exchange, EX);
  assert.ok(!asked.includes("dclv2.ref-labs.near"));
  // DCL's quote alone at this block is what V1 took
  assert.equal((await dclQuote({ network: "mainnet", rpcs, side: "sell", token: HOODL, amountIn: BigInt(SELL.amountIn), pools: SELL.pools })).amountOut, DCL_OUT);
});

test("V5 nearQuote, the quote with no W (a buy's dry, its creation body, a fee read; card near-dcl-route): the pair's own pick and refusals", async () => {
  const q = (rpcs: ReturnType<typeof chain>, pools = [7]) => nearQuote({ network: "mainnet", rpcs, side: "sell", token: HOODL, amountIn: BigInt(SELL.amountIn), pools, dclPools: SELL.pools });
  // DCL pays more: DCL's quote, as the pair read takes it
  const d = await q(chain(20_000n));
  assert.ok(isDclQuote(d));
  assert.equal(d.amountOut, DCL_OUT);
  assert.deepEqual([d.height, d.blockHash], [H, HASH]);
  // classic pays more: the classic quote, exactly
  const rpcs = chain(100_000n);
  const c = await q(rpcs);
  assert.ok(!isDclQuote(c));
  assert.equal(c.amountOut, (await rheaQuote({ network: "mainnet", rpcs, side: "sell", token: HOODL, amountIn: BigInt(SELL.amountIn), pools: [7] })).amountOut);
  // a DCL-only coin (no classic candidates): DCL alone
  assert.ok(isDclQuote(await q(chain(20_000n), [])));
  // both venues with no pool: the coin's own refusal (no-pool), which a dry reads as no out
  const none = chain(100_000n, (_u, p, v) => (p.method_name === "get_pool" ? null : p.method_name === "get_pool_by_ids" ? [{ ...classicRow(1n), token_account_ids: ["a.near", "b.near"] }] : v));
  await assert.rejects(q(none), (e: unknown) => e instanceof RheaQuoteRefused && e.code === "no-pool");
  // DCL's providers apart: the providers' fault (disagree), which a dry reads as down, never the classic quote instead
  const apart = chain(20_000n, (u, p, v) => (u === DRPC && p.method_name === "quote" ? { amount: "15452", tag: null } : v));
  await assert.rejects(q(apart), (e: unknown) => e instanceof RheaQuoteRefused && e.code === "disagree");
});

test("V6 a venue's own chain state skips it (card near-dcl-route): DCL not Running or the token frozen on DCL, classic serves; classic not Running, DCL serves; a provider's fault still refuses", async () => {
  const dclPaused = chain(20_000n, (_u, p, v) => (String(p.account_id) === "dclv2.ref-labs.near" && p.method_name === "get_metadata" ? { ...(v as object), state: "Paused" } : v));
  const a = await readNearSwapPair(ask(dclPaused));
  assert.equal(a.quote.exchange, EX, "DCL paused: classic, though DCL would pay more");
  const dclFrozen = chain(20_000n, (_u, p, v) => (String(p.account_id) === "dclv2.ref-labs.near" && p.method_name === "get_frozenlist_tokens" ? [HOODL] : v));
  assert.equal((await nearQuote({ network: "mainnet", rpcs: dclFrozen, side: "sell", token: HOODL, amountIn: BigInt(SELL.amountIn), pools: [7], dclPools: SELL.pools })).exchange, EX);
  const classicPaused = chain(100_000n, (_u, p, v) => (String(p.account_id) === EX && p.method_name === "metadata" ? { state: "Paused" } : v));
  assert.ok(isDclQuote((await readNearSwapPair(ask(classicPaused))).quote), "classic paused: DCL, though classic would pay more");
  // both venues paused: the classic refusal, the coin's own
  const both = chain(20_000n, (_u, p, v) => (p.method_name === "metadata" ? { state: "Paused" } : String(p.account_id) === "dclv2.ref-labs.near" && p.method_name === "get_metadata" ? { ...(v as object), state: "Paused" } : v));
  await assert.rejects(readNearSwapPair(ask(both)), (e: unknown) => e instanceof RheaQuoteRefused && e.code === "paused" && e.message.includes(EX));
});
