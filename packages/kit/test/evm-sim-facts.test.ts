// The two provider facts the device's trade simulation rests on (card evm-quote-exec-sim, step 1), on the answers each
// chain's two pinned providers gave, recorded by test/evm-sim-facts-record.ts into fixtures/evm-sim-facts.json:
// an eth_call at a block hash runs with that block's own timestamp (NUMBER on Robinhood Chain, an Arbitrum chain, is
// the L1 block number, as on chain), and a 7702 designator given as override code runs the delegate in the account's
// own context, the pinned SellDelegate included.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { A_ADDR, CHAINS, D_ADDR, factCalls, SELL_STORAGE, T_ADDR } from "./evm-sim-facts-record.ts";

type Rec = { block: { number: string; hash: string; timestamp: string }; exchanges: [{ calls: unknown[]; answers: { result?: string }[] }[], { calls: unknown[]; answers: { result?: string }[] }[]] };
const F: Record<string, Rec> = JSON.parse(readFileSync(new URL("./fixtures/evm-sim-facts.json", import.meta.url), "utf8"));
const word = (h: string, i: number) => BigInt("0x" + h.slice(2 + 64 * i, 66 + 64 * i));

test("each chain's two providers: a block hash's own timestamp, and a 7702 designator followed in the account's context", () => {
  void SELL_STORAGE;
  for (const chain of CHAINS) {
    const r = F[chain]!;
    for (const ex of r.exchanges) {
      const facts = ex.find((e) => JSON.stringify(e.calls).includes(T_ADDR))!;
      // the facts were asked exactly as factCalls asks them
      const delegate = (facts.calls[2] as { params?: unknown[] } | undefined)?.params?.[0] as string | undefined;
      const code = facts.answers[2]?.result;
      assert.equal(JSON.stringify(facts.calls), JSON.stringify(factCalls(r.block.hash, delegate, code)), chain);
      const [ts, designator] = facts.answers.map((a) => a.result!);
      assert.equal(word(ts!, 0), BigInt(r.block.timestamp), `${chain}: TIMESTAMP is the block's own`);
      if (!chain.startsWith("robinhood")) assert.equal(word(ts!, 1), BigInt(r.block.number), `${chain}: NUMBER is the block's own`);
      assert.equal(word(designator!, 0), BigInt(A_ADDR), `${chain}: the delegate runs as the account`);
      assert.equal(word(designator!, 1), 5n, `${chain}: with the account's own balance`);
      assert.notEqual(BigInt(A_ADDR), BigInt(D_ADDR));
      if (delegate !== undefined) {
        assert.equal(word(facts.answers[3]!.result!, 0), 7n, `${chain}: SellDelegate.nonce() through the designator reads the account's slot`);
        assert.equal(word(facts.answers[4]!.result!, 0), 7n, `${chain}: and through its runtime code`);
      }
    }
    // the two providers answered the same, byte for byte
    const [a, b] = r.exchanges.map((ex) => ex.find((e) => JSON.stringify(e.calls).includes(T_ADDR))!.answers.map((x) => x.result));
    assert.deepEqual(a, b, chain);
  }
});
