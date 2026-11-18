// scripts/lag-hosts.ts: which providers a live check's child records as not knowing a fresh block yet (INCONCLUSIVE),
// and which failures stay a FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { laggingHosts, pageRpc, UNKNOWN_BLOCK, walkLag, WalkLagError } from "../scripts/lag-hosts.ts";
import { EvmLagError } from "../src/pool/evm.ts";

const PAIR = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];
const unanswered = (m: string) => Object.assign(new Error(m), { name: "EvmOperatorsUnanswered" });

test("UNKNOWN_BLOCK is the wallet's own", () => {
  const src = readFileSync(new URL("../src/pool/evm.ts", import.meta.url), "utf8");
  assert.equal(/const UNKNOWN_BLOCK = (\/.*\/[a-z]*);/.exec(src)?.[1], String(UNKNOWN_BLOCK));
});

test("the pair's seat that does not know a fresh block is named", () => {
  assert.deepEqual(laggingHosts(new EvmLagError("rpc 1 does not know block 56057679 yet"), PAIR), ["base-rpc.publicnode.com"]);
  assert.deepEqual(laggingHosts(new EvmLagError("rpc 0 does not know block 7 yet"), PAIR), ["mainnet.base.org"]);
  assert.deepEqual(laggingHosts(new EvmLagError("an RPC has no latest block"), PAIR), ["mainnet.base.org", "base-rpc.publicnode.com"]);
});

test("a wrong answer about a known block is no lag", () => {
  assert.equal(laggingHosts(new EvmLagError("the two RPCs hold different blocks at 9"), PAIR), null);
  assert.equal(laggingHosts(new EvmLagError("block 9 moved under the search (a reorg)"), PAIR), null);
  assert.equal(laggingHosts(new Error("the two RPCs differ on block 9 (0xab)"), PAIR), null);
  assert.equal(laggingHosts(Object.assign(new Error("a and b answered differently"), { name: "EvmOperatorsDiffer" }), PAIR), null);
  assert.equal(laggingHosts(new Error("rpc 1 does not know block 9 yet"), PAIR), null, "only the wallet's lag error");
});

test("a walk whose every refusing seat did not know the block is a lag naming them", () => {
  const refused = new Map([["https://base.api.pocket.network", "RPC error -32000: header not found"], ["https://base.gateway.tenderly.co/x", "unknown block"]]);
  const e = walkLag(unanswered("no two operators answered"), refused);
  assert.ok(e instanceof WalkLagError && e instanceof EvmLagError, "evmRetryLag reads it again");
  assert.deepEqual(laggingHosts(e, PAIR), ["base.api.pocket.network", "base.gateway.tenderly.co"]);
});

test("a walk with one seat refusing for another reason stays as it is", () => {
  const u = unanswered("no two operators answered");
  assert.equal(walkLag(u, new Map([["https://a.example", "header not found"], ["https://b.example", "historical state 0xab is not available"]])), u, "a pruned state is the check's subject");
  assert.equal(walkLag(u, new Map()), u, "no seat refused: no answers, judged as before");
  const other = new Error("header not found");
  assert.equal(walkLag(other, new Map([["https://a.example", "header not found"]])), other, "not a walk's failure");
});

// card device-evm-read-residuals (delta review of 1d895550, item 5): the live checks' children read every seat through
// the page's retry (SOLANA_RPC_RETRY), as the signing page does, so one throttle the page would ask again is no FAIL
test("a child's seat client asks a provider's throttle again once, as the page does, and keeps a refusal's words", async () => {
  let n = 0;
  const id = (init: RequestInit) => JSON.parse(String(init.body)).id;
  const once429 = async (_: string, init: RequestInit) => (n++ === 0 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : new Response(JSON.stringify({ jsonrpc: "2.0", id: id(init), result: "0x2105" }), { status: 200 }));
  assert.equal(await pageRpc("https://mainnet.base.org", once429)("eth_chainId", []), "0x2105");
  assert.equal(n, 2);
  const unknown = async (_: string, init: RequestInit) => new Response(JSON.stringify({ jsonrpc: "2.0", id: id(init), error: { code: -32000, message: "header not found" } }), { status: 200 });
  await assert.rejects(pageRpc("https://mainnet.base.org", unknown)("eth_call", []), (e: Error) => UNKNOWN_BLOCK.test(e.message));
  for (const child of ["bind-fee-live.ts", "no-old-state-live.ts"]) {
    const src = readFileSync(new URL(`../scripts/${child}`, import.meta.url), "utf8");
    assert.ok(/const rpc = pageRpc\(url\);/.test(src) && !/solanaJsonRpc\(/.test(src), `${child}: every seat through pageRpc`);
  }
});
