// node --test apps/helper/test/quote-index-sign.test.ts (card index-evm-swaps-v4-route-tape): the helper reads the
// device's Base pool index as the sign release serves it, through the kit's entry (server.ts quoteIndexFromSign), and
// answers a currency's v4 pools from it; a snapshot of another chain, or not the index's shape, gives none. The good
// answer is the snapshot the sign release ships (the bytes https://confidential.unrealized.trade/evm-index/base.json
// served 21 Nov 23:2xZ, 7,315 pools over blocks 59,429,513 to 60,429,038), cut to cbBTC's 20 pools and the first 20
// others in its order, every other field as served (fixtures/evm-index-base-cbbtc.json; the import gate keeps this
// file from reading the sign package's own copy).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { quoteIndexFromSign } from "../src/server.ts";

const BASE = readFileSync(new URL("./fixtures/evm-index-base-cbbtc.json", import.meta.url), "utf8");
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const served = (body: string, asked: string[]) => (async (url: string) => (asked.push(url), new Response(body, { status: 200, headers: { "content-type": "application/json" } }))) as typeof fetch;
const settled = async (f: (t: string) => readonly unknown[], t: string) => {
  for (let i = 0; i < 200 && f(t).length === 0; i++) await new Promise((go) => setImmediate(go));
  return f(t);
};

test("the shipped Base snapshot: cbBTC's 20 v4 pools, three of them against WETH or USDC, each id its key's; asked at the sign origin", async () => {
  const asked: string[] = [];
  const of = quoteIndexFromSign("base", served(BASE, asked));
  const ps = (await settled(of, CBBTC)) as { id: string; key: { currency0: string; currency1: string } }[];
  assert.deepEqual(asked, ["https://confidential.unrealized.trade/evm-index/base.json"]);
  assert.equal(ps.length, 20);
  assert.equal(ps.filter((p) => [p.key.currency0, p.key.currency1].some((c) => c === "0x4200000000000000000000000000000000000006" || c === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")).length, 3);
});

test("guard: a snapshot of another chain (chainId 84532) is none, never pools", async () => {
  const of = quoteIndexFromSign("base", served(BASE.replace('"chainId":8453,', '"chainId":84532,'), []));
  for (let i = 0; i < 200; i++) await new Promise((go) => setImmediate(go));
  assert.deepEqual(of(CBBTC), []);
});
