// W's state before it signs a swap (src/trade/near/wallet.ts), replayed on both providers' recorded mainnet answers
// (fixtures/near-wallet-reads.json: an implicit account that once claimed its lost-found through a relayer, read
// 11 Nov; its balance of purge-558 is the amount that claim paid). Each bad case is the recording with one answer
// changed, refused with its code.
//   node --test test/near-wallet.test.ts      (from packages/kit)
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RheaQuoteRefused, type RheaRefusalCode } from "../src/near/rhea.ts";
import { readNearSwapWallet } from "../src/trade/near/wallet.ts";

const W = "c71ba7bd78110d8470d534684cde3fb61c17997349e8430e7bd37e55f97b3f5b";
type Entry = { url: string; params: Record<string, unknown>; answer: Record<string, unknown> };
type Run = { side: "buy" | "sell"; asset: string; state: Record<string, string | number | boolean>; log: Entry[] };
const runs: Record<string, Run> = JSON.parse(readFileSync(new URL("./fixtures/near-wallet-reads.json", import.meta.url), "utf8"));

function replay(run: Run, edit?: (url: string, params: Record<string, unknown>, answer: Record<string, unknown>) => Record<string, unknown>) {
  return [...new Set(run.log.map((l) => l.url))].map((url) => ({
    name: url,
    async query(params: Record<string, unknown>) {
      const hit = run.log.find((l) => l.url === url && JSON.stringify(l.params) === JSON.stringify(params));
      if (!hit) throw new Error("not recorded");
      const a = structuredClone(hit.answer);
      return edit ? edit(url, params, a) : a;
    },
  })) as unknown as Parameters<typeof readNearSwapWallet>[0]["rpcs"];
}
const read = (run: Run, edit?: Parameters<typeof replay>[1], wallet = W) => readNearSwapWallet({ network: "mainnet", rpcs: replay(run, edit), wallet, side: run.side, token: run.asset });
async function refused(p: Promise<unknown>, code: RheaRefusalCode, re?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RheaQuoteRefused, String(e));
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}
const SECOND = "https://near.drpc.org";
/** An answer's result, typed for the edits below. */
const R = (a: Record<string, unknown>) => a.result as { block_height: number; block_hash: string; result: number[]; keys: { public_key: string; access_key: { nonce: number; permission: unknown } }[] };
const viewBytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];

test("W1 a sell and a buy: W's key nonce, what it holds, its registration, the bounds' min and its lost-found, at one block", async () => {
  for (const run of Object.values(runs)) {
    const s = await read(run);
    assert.deepEqual(
      { ...s, nonce: String(s.nonce), held: String(s.held), storageMin: String(s.storageMin), lostfound: String(s.lostfound) },
      run.state,
    );
    assert.ok(Object.isFrozen(s));
  }
  assert.equal(runs["sell purge-558"]!.state.held, "425792036131893646726");
});

test("W2 a key list that is not W's own key alone, or a W not created yet, is refused", async () => {
  const run = runs["sell purge-558"]!;
  const keys = (f: (r: Record<string, unknown>) => void) => (_u: string, p: Record<string, unknown>, a: Record<string, unknown>) => {
    if (p.request_type === "view_access_key_list") f(a.result as Record<string, unknown>);
    return a;
  };
  await refused(read(run, keys((r) => (r.keys as unknown[]).push({ access_key: { nonce: 1, permission: "FullAccess" }, public_key: "ed25519:11111111111111111111111111111111" }))), "rpc", /own key alone/);
  await refused(read(run, keys((r) => (R({ result: r }).keys[0]!.public_key = "ed25519:11111111111111111111111111111111"))), "rpc", /own key alone/);
  await refused(read(run, keys((r) => (R({ result: r }).keys[0]!.access_key.permission = { FunctionCall: {} }))), "rpc", /own key alone/);
  await refused(read(run, (_u, p, a) => (p.request_type === "view_access_key_list" ? { jsonrpc: "2.0", id: "r", error: { name: "HANDLER_ERROR", message: "UNKNOWN_ACCOUNT" } } : a)), "rpc", /UNKNOWN_ACCOUNT/);
});

test("W3 the providers must agree: the nonce, a view's bytes, the block", async () => {
  const run = runs["sell purge-558"]!;
  await refused(read(run, (u, p, a) => {
    if (u === SECOND && p.request_type === "view_access_key_list") R(a).keys[0]!.access_key.nonce = 219833572000002;
    return a;
  }), "disagree", /nonce/);
  await refused(read(run, (u, p, a) => {
    if (u === SECOND && p.method_name === "ft_balance_of") R(a).result = viewBytes("1");
    return a;
  }), "disagree");
  await refused(read(run, (u, p, a) => {
    if (u === SECOND && p.method_name === "get_lostfound_token") R(a).block_hash = "11111111111111111111111111111111";
    return a;
  }), "disagree");
  // both providers answering one read at another block than the pinned one
  await refused(read(run, (_u, p, a) => {
    if (p.method_name === "get_lostfound_token") R(a).block_height += 1;
    return a;
  }), "rpc", /not at block/);
  await refused(read(run, (u, p, a) => {
    if (u === SECOND && p.finality === "final") R(a).block_height += 4;
    return a;
  }), "lag");
});

test("W4 hostile values: a balance not a u128, a registration not one, a min over the cap, a lost-found not a u128", async () => {
  const run = runs["sell purge-558"]!;
  const set = (method: string, v: unknown) => (_u: string, p: Record<string, unknown>, a: Record<string, unknown>) => {
    if (p.method_name === method) R(a).result = viewBytes(v);
    return a;
  };
  await refused(read(run, set("ft_balance_of", "-1")), "rpc", /ft_balance_of/);
  await refused(read(run, set("storage_balance_of", { total: 5 })), "rpc", /storage_balance_of/);
  await refused(read(run, set("storage_balance_bounds", { min: "12500000000000000000001", max: null })), "rpc", /over the cap/);
  await refused(read(run, set("get_lostfound_token", 3)), "rpc", /get_lostfound_token/);
  const reg = await read(run, set("storage_balance_of", { total: "1250000000000000000000", available: "0" }));
  assert.equal(reg.registered, true);
});

test("W5 the inputs: W a 64-hex implicit id, a known network, the pair's providers, a token other than USDC", async () => {
  const run = runs["sell purge-558"]!;
  await refused(read(run, undefined, "alice.near"), "input");
  await refused(readNearSwapWallet({ network: "mainnet", rpcs: replay(run), wallet: W, side: "sell", token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" }), "input");
  await refused(readNearSwapWallet({ network: "testnet", rpcs: replay(run), wallet: W, side: "sell", token: run.asset }), "input");
  await refused(readNearSwapWallet({ network: "mainnet", rpcs: replay(run), wallet: W, side: "swap" as "buy", token: run.asset }), "input");
});
