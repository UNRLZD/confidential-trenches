// scripts/lag-hosts.ts: which providers a live check's child records as not knowing a fresh block yet (INCONCLUSIVE),
// and which failures stay a FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { laggingHosts, UNKNOWN_BLOCK, walkLag, WalkLagError } from "../scripts/lag-hosts.ts";
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
