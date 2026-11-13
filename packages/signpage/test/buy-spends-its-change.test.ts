// Card buy-spends-its-change-in-the-same-tap: a buy bigger than the ready pieces releases a piece, waits for it to land,
// proves its change and carries that change in the same tap, to the same W; so Max is all the pool holds less the tap's
// costs. The end state on the owner's account as the QA browser read it (13 Nov 18:23Z): notes of 0.005547107 (its own
// W's), 0.003502518 and a 0.012 sale's return whose piece is 0.005 (packages/wallet/src/pool/pieces.ts pieceChunk), the
// 0.007 change carried as a fourth piece.
//   node --test test/buy-spends-its-change.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { solanaPoolFee, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { fx, replay } from "../../kit/test/solana-pool-buy-fx.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { poolBalances, solanaBalancePool, type BalanceProof } from "../../wallet/src/pool/balances.ts";
import { SOL_TIP_CAP } from "../../wallet/src/pool/solana.ts";
import { poolBuyDryKind, withSolanaRent } from "../src/pools.ts";

const RENT: SolanaRent = { lamportsPerByte: 5_080n, factor: 1n };
const FEE = solanaPoolFee(RENT);
const SOL = solanaBalancePool("sol:p", 11n);
const note = (id: string, label: bigint, value: bigint): NoteRecord => ({ id, ref: { kind: "deposit", s: 11n, i: Number(label) }, scope: 11n, precommitment: label, state: "HELD", attempt: `a-${id}`, deadlineMs: 1n, leaf: { value, label, commitment: label, leafIndex: label } });
const notes = [note("own", 1n, 5_547_107n), note("ret", 2n, 3_502_518n), note("big", 3n, 12_000_000n)];
const chunks = [5_547_107n, 3_502_518n, 5_000_000n];
const ready: BalanceProof[] = notes.map((n, i) => ({ noteId: n.id, attempt: n.attempt!, poolId: SOL.id, chunk: chunks[i]!, wallet: { l: 1n, j: 0, address: "W" }, binding: { feeCap: FEE, request: { tipCap: SOL_TIP_CAP } } }));
const pair = (): readonly [SolanaRpc, SolanaRpc] => [replay(fx.pump, 0), replay(fx.pump, 1)];

test("state.pools' Max counts the 0.007 change the tap carries: four pieces, 21,049,625 less four relay fees, the tip and W's worst-venue keep", () => {
  const e = poolBalances(notes, withSolanaRent([SOL], RENT), ready, new Set([SOL.id]))[0]!;
  // 21,049,625 - 4 x 1,300,000 - 100,000 - (1,640,840 + 1,346,200 + 4,328,080) = 8,434,505 ($0.676 at $80.1)
  assert.equal(e.tap_max, "0.008434505");
});

test("pool.buy.dry on a curve coin (Token-2022 at 170 bytes, no cashback): Max 0.011396145, and a buy of it is the four pieces, the carried change among them", async () => {
  const kind = poolBuyDryKind({ pools: [SOL], rpcs: pair, rent: () => RENT, ready: async () => ({ notes, ready, open: new Set([SOL.id]) }), trading: () => false });
  const ask = (params: Record<string, unknown>) => {
    const r = kind(params);
    return r.after.then(() => r.answer() as { result?: Record<string, unknown>; error?: string });
  };
  const max = await ask({ chain: "solana", token: fx.pump.mint });
  // 21,049,625 - 4 x 1,300,000 - 100,000 - (1,513,840 + 1,346,200 + 1,493,440) = 11,396,145 ($0.913 at $80.1)
  assert.equal(max.result?.tap_max, "0.011396145");
  const at = await ask({ chain: "solana", token: fx.pump.mint, amount: "0.011396145" });
  assert.equal(at.result?.pieces, 4);
});
