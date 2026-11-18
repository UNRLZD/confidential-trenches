// Card robinhood-fee-read-old-blocks-own-rpc: the signing page's fee list on SIGN_HOST's build marks
// robinhood-rpc.publicnode.com as a member that keeps a block's state about 10 s (HTTP 403 "Archive requests require a
// personal token" from then, read 2026-11-18 14:49Z and 15:36Z), so the wallet's fee read at a block 10 s or more behind
// the head walks Robinhood's list without it, Robinhood's own first, and asks it only at the head
// (../../wallet/test/pool-evm.test.ts holds that walk on the four providers' recorded answers). Base's four answered at
// 1 to 244 s back (15:36Z): none marked. Nothing here reaches a network.
//   node --test test/evm-fee-old-blocks.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvmFeeRpc } from "../../wallet/src/pool/evm.ts";
import { EVM_FEE_STATE_MS, MAINNET_EVM_FEE_RPCS, pageEvmFeeRpcs } from "../src/pool-testnet.ts";

const marks = (chain: "base" | "robinhood") => (pageEvmFeeRpcs(chain) as readonly EvmFeeRpc[]).map((r) => [new URL(r.url!).host, r.stateMs ?? null]);

test("Robinhood's fee list: its own first, publicnode a seat for 10 s behind the head alone, the rest for any block", () => {
  assert.deepEqual(EVM_FEE_STATE_MS, { "https://robinhood-rpc.publicnode.com": 10_000 });
  assert.equal(MAINNET_EVM_FEE_RPCS.robinhood[0], "https://rpc.mainnet.chain.robinhood.com");
  assert.deepEqual(marks("robinhood"), [
    ["rpc.mainnet.chain.robinhood.com", null],
    ["robinhood.drpc.org", null],
    ["robinhood.api.pocket.network", null],
    ["robinhood-rpc.publicnode.com", 10_000],
  ]);
});

test("Base's fee list: no member marked (each answered 244 s back)", () => {
  assert.deepEqual(marks("base").map(([, s]) => s), [null, null, null, null]);
});
