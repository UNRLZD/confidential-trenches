// The reads one NEAR buy asks of each provider, step by step (card near-quote-under-the-pace): the page's own binding of
// the reads (src/near-buy.ts nearReads: the kit's readNearSwapWallet, rheaQuote, readNearSwapPair and readNearHeld) on
// two fake providers of one fake chain, the buy's run (src/near-trade.ts runNearBuy) with the payout, the helper and the
// signer stubbed. Each registration and swap shows on the chain two final heights after it is sent, so each wait reads
// twice, as on mainnet. Before this card one buy asked 69 reads of each provider (create 11, register 29, swap 17,
// receive 12; read 12 Nov at 697d6b72f with this file's world); a change that adds reads fails here.
//   node --test test/near-reads-count.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { NEAR_NETWORKS, type NearRpc } from "../../kit/src/near/networks.ts";
import type { NearSwapCall } from "../../kit/src/trade/near/swap.ts";
import type { SignedNearSwapDelegate } from "../../wallet/src/near/swap-delegate.ts";
import { nearReads } from "../src/near-buy.ts";
import { runNearBuy, type NearBuyDeps, type NearBuyStep } from "../src/near-trade.ts";
import { AMOUNT, chain, TOKEN, USDC } from "./near-chain-fake.ts";

const W = "0".repeat(64);
const FAST = NEAR_NETWORKS.mainnet.fastnear[0];
const DRPC = NEAR_NETWORKS.mainnet.drpc;

test("one buy's reads of each provider, step by step: 69 before this card, now at most these", async () => {
  const k = chain();
  let step = "payout";
  const asked: Record<string, Record<string, number>> = { [FAST]: {}, [DRPC]: {} };
  // reads go to the step logged next (a "quote" line is inside the step that follows it)
  let since: Record<string, number> = { [FAST]: 0, [DRPC]: 0 };
  const rpc = (name: string): NearRpc => ({
    name,
    async query(params) {
      // FastNEAR's final read moves the chain on: each pair of final heights is one moment
      if (name === FAST && "finality" in params) k.tick();
      since[name]!++;
      return k.answer(params);
    },
  });
  const pair = [rpc(FAST), rpc(DRPC)] as const;
  const page = { network: "mainnet" as const, rpcs: () => pair, pools: async () => [9, 4512] };
  const deps: NearBuyDeps = {
    network: "mainnet",
    ...nearReads(page),
    begin: async (ask) => ({ ask, w: { id: W, l: 1n, j: 0 }, txs: [] }),
    progress: async () => {},
    payout: async () => ({ kind: "landed", tx: null }),
    helper: async (body) => {
      const n = body.signed_delegates.length;
      if (n === 0) return (k.c.exists = true), { ok: true, tx_hashes: ["11111111111111111111111111111111"] };
      const method = JSON.parse(atob(body.signed_delegates[0]!)).method as string;
      if (method === "storage_deposit") k.later(() => (k.c.reg.add(TOKEN), (k.c.nonce += 1)));
      else k.later(() => (k.c.bal.set(USDC, 0n), k.c.bal.set(TOKEN, BigInt(body.trade.venue_out)), (k.c.nonce += n)));
      return { ok: true, tx_hashes: body.signed_delegates.map(() => "11111111111111111111111111111111") };
    },
    sign: (given: readonly NearSwapCall[], _r, _q, s) =>
      given.map((call, i): SignedNearSwapDelegate => ({
        signed_delegate: btoa(JSON.stringify({ method: call.actions[0].FunctionCall.method_name })),
        sender_id: call.sender_id,
        receiver_id: call.receiver_id,
        method_name: call.actions[0].FunctionCall.method_name,
        nonce: s.nonce + 1n + BigInt(i),
        max_block_height: BigInt(s.height) + 120n,
        public_key: "ed25519:x",
      })),
    wait: async () => void k.tick(),
    log: (s: NearBuyStep, outcome: string) => {
      if (s !== "quote") {
        step = s;
        for (const n of [FAST, DRPC]) asked[n]![step] = (asked[n]![step] ?? 0) + since[n]!;
        since = { [FAST]: 0, [DRPC]: 0 };
      }
      void outcome;
    },
  };
  const a = await runNearBuy(deps, { token: TOKEN, amount: AMOUNT, slippageBps: 1000 });
  assert.ok("result" in a && a.result.stage === "filled", JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  for (const n of [FAST, DRPC]) {
    const per = asked[n]!;
    const total = Object.values(per).reduce((x, y) => x + y, 0);
    // create: W read (absent: its six asked at once) and the quote for the helper's body; register: W's light read,
    // the round's pair, two light reads back; swap: the pair and its baseline; receive: two light reads
    assert.deepEqual(per, { payout: 0, create: 11, register: 19, swap: 11, receive: 6 }, `${n}: ${JSON.stringify(per)}`);
    assert.equal(total, 47, n);
  }
});
