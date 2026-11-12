// The NEAR sell across runs: notes another deposit took in a run before, the trade delegate a run before signed, and
// the in-run claim gate, on a chain whose notes, nonce and heights the runs share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA, type RheaQuote } from "../../kit/src/near/rhea.ts";
import { NEAR_TOKEN_NO_FEE } from "../../kit/src/near/token-fee.ts";
import type { NearSwapCall } from "../../kit/src/trade/near/swap.ts";
import type { NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import type { HelperBindTradeRequest } from "../../kit/src/helper/v1.ts";
import type { SignedNearSwapDelegate } from "../../wallet/src/near/swap-delegate.ts";
import type { KindContext } from "../src/api.ts";
import { nearSellFlow, type NearMoveEnd, type NearSellAnswer, type NearSellDeps, type NearTradeSigned } from "../src/near-sell.ts";

const USDC = NEAR_NETWORKS.mainnet.usdc;
const EXCHANGE = NEAR_RHEA.mainnet.exchange;
const TOKEN = "token.rhealab.near";
const W = "ab".repeat(32);
const ctx: KindContext = { id: "00000000-0000-4000-8000-000000000000", sha: "0".repeat(64), progress: () => {} };
const tx = (n: number) => `${"4".repeat(40)}${String(n).padStart(4, "0").replace(/\d/g, (d) => "ABCDEFGHJK"[Number(d)]!)}`;
const quoteOf = (amountIn: bigint, venueOut: bigint): RheaQuote => ({
  network: "mainnet", exchange: EXCHANGE, height: 100, blockHash: "b", side: "sell", token: TOKEN, tokenIn: TOKEN, tokenOut: USDC, amountIn, venueIn: amountIn,
  hops: [{ pool: 7, tokenIn: TOKEN, tokenOut: USDC, amountIn, amountOut: venueOut, feeBps: 30 }], venueOut, amountOut: venueOut, fee: NEAR_TOKEN_NO_FEE,
});

type Note = { id: string; state: string; amount: bigint | null; takenBy?: "stranger" };
type Chain = { token: bigint; usdc: bigint; nonce: bigint; lostfound: bigint; height: number; notes: Note[]; trade?: NearTradeSigned | null };
type Opts = { claimLands?: boolean; swap?: (body: HelperBindTradeRequest) => { ok: false; code: string; tx_hashes?: string[] } | null; read?: (chain: Chain, side: "buy" | "sell") => Partial<NearSwapWalletState> | void };
function deps(chain: Chain, ev: unknown[][], opts: Opts = {}): NearSellDeps {
  return {
    network: "mainnet",
    wallet: () => ({ id: W, l: 5n, j: 2, token: TOKEN }),
    helper: async (body: HelperBindTradeRequest) => {
      ev.push(["helper", body.signed_delegates.length]);
      const refused = opts.swap?.(body) ?? null;
      if (refused !== null) return refused;
      chain.token -= BigInt(body.trade.amount_in);
      chain.usdc += 3_000_000n;
      chain.nonce += 1n;
      if (body.signed_delegates.length === 2 && opts.claimLands) (chain.usdc += chain.lostfound), (chain.lostfound = 0n), (chain.nonce += 1n);
      return { ok: true, tx_hashes: body.signed_delegates.map((_, i) => tx(10 + i)) };
    },
    readWallet: async (a): Promise<NearSwapWalletState> => {
      chain.height += 1;
      const over = opts.read?.(chain, a.side) ?? {};
      return { ...over, account: a.wallet, height: chain.height, blockHash: "b", nonce: chain.nonce, held: a.side === "sell" ? chain.token : chain.usdc, registered: true, storageMin: 1n, lostfound: a.side === "sell" ? chain.lostfound : 0n, ...over };
    },
    quote: async (a) => quoteOf(a.amountIn!, 3_000_000n),
    sign: (_l, _j, given, _r, _q, st) => {
      ev.push(["sign", given.map((c: NearSwapCall, k) => [c.actions[0].FunctionCall.method_name, st.nonce + 1n + BigInt(k)])]);
      return given.map((c: NearSwapCall, k): SignedNearSwapDelegate => ({ signed_delegate: "AA==", sender_id: c.sender_id, receiver_id: c.receiver_id, method_name: c.actions[0].FunctionCall.method_name, nonce: st.nonce + 1n + BigInt(k), max_block_height: BigInt(st.height) + 120n, public_key: "ed25519:x" }));
    },
    note: async (_w, k, create) => {
      if (chain.notes[k] === undefined) {
        if (!create) return null;
        chain.notes[k] = { id: `n${k}`, state: "PLANNED", amount: null };
      }
      const n = chain.notes[k]!;
      return { id: n.id, state: n.state, amount: n.amount };
    },
    move: async (_w, id, amount): Promise<NearMoveEnd> => {
      const n = chain.notes.find((x) => x.id === id)!;
      ev.push(["move", id, amount, chain.nonce]);
      if (n.takenBy === "stranger") return { kind: "front_run", height: chain.height };
      if (amount === 0n) return { kind: "absent" };
      if (n.state !== "UNSPENT") {
        n.amount = amount;
        n.state = "UNSPENT";
        chain.usdc -= amount;
      }
      return { kind: "deposited", txs: [tx(90)], height: chain.height };
    },
    wait: async () => {},
    log: (s, o) => void ev.push(["log", s, o]),
    stop: (s, c) => void ev.push(["stop", s, c]),
    // the sell's record, shared by the runs
    lastTrade: () => chain.trade ?? null,
    traded: (t) => void (chain.trade = { ...t }),
  };
}
const run = async (d: NearSellDeps): Promise<NearSellAnswer | null> => {
  const r = nearSellFlow(d)({ token: TOKEN, slippageBps: 100 }, ctx);
  assert.ok("running" in r);
  await r.after;
  return r.answer() as NearSellAnswer | null;
};

test("R1: W's return note already landed and W holds the token again: the sale's USDC goes on R note 0 and the run is filled with W empty (closed)", async () => {
  const chain: Chain = { token: 5_000n, usdc: 0n, nonce: 50n, lostfound: 0n, height: 1000, notes: [{ id: "n0", state: "UNSPENT", amount: 2_000_000n }] };
  const ev: unknown[][] = [];
  const a = await run(deps(chain, ev));
  assert.ok(a !== null && "result" in a && a.result.stage === "filled", JSON.stringify(a, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
  assert.equal(chain.usdc, 0n);
  assert.deepEqual(ev.filter((e) => e[0] === "move").map((e) => [e[1], e[2]]), [["n0", 2_000_000n], ["n1", 3_000_000n]]);
});

test("D2: three notes another deposit took in a run before are read again but never counted again: the next note is planned and W's USDC moves on it, filled", async () => {
  const notes: Note[] = [0, 1, 2].map((k) => ({ id: `n${k}`, state: "UNSPENT", amount: 1_000_000n, takenBy: "stranger" as const }));
  const chain: Chain = { token: 0n, usdc: 900_000_000n, nonce: 50n, lostfound: 0n, height: 1000, notes };
  const ev: unknown[][] = [];
  const a = await run(deps(chain, ev));
  assert.deepEqual(ev.filter((e) => e[0] === "move").map((e) => [e[1], e[2]]), [["n0", 1_000_000n], ["n1", 1_000_000n], ["n2", 1_000_000n], ["n3", 900_000_000n]]);
  assert.equal(ev.find((e) => e[0] === "stop"), undefined);
  assert.deepEqual(a, { result: { stage: "filled", txs: [{ chain: "near", hash: tx(90) }] } });
  assert.equal(chain.usdc, 0n);
});

test("D2: front-runs found in this run still stop it past NEAR_SELL_TAKEN_MAX (sent), and the next run goes on past them", async () => {
  const notes: Note[] = [0, 1, 2].map((k) => ({ id: `n${k}`, state: "PLANNED", amount: 1_000_000n, takenBy: "stranger" as const }));
  const chain: Chain = { token: 0n, usdc: 900_000_000n, nonce: 50n, lostfound: 0n, height: 1000, notes };
  const first: unknown[][] = [];
  const a = await run(deps(chain, first));
  assert.deepEqual(first.find((e) => e[0] === "stop"), ["stop", "move", "p_used"]);
  assert.deepEqual(a, { result: { stage: "sent", txs: [] } });
  for (const n of notes) n.state = "UNSPENT"; // each landed on the stranger's deposit
  const second: unknown[][] = [];
  const b = await run(deps(chain, second));
  assert.deepEqual(second.filter((e) => e[0] === "move").map((e) => e[1]), ["n0", "n1", "n2", "n3"]);
  assert.ok(b !== null && "result" in b && b.result.stage === "filled");
});

test("D3: a run that finds no token gates its move on the trade delegate a run before signed: no move at W's nonce while that claim is held in its window", async () => {
  // an earlier run signed swap 51 and claim 52; the swap landed (nonce 51), the claim is still held
  const chain: Chain = { token: 0n, usdc: 3_000_000n, nonce: 51n, lostfound: 10_000n, height: 1000, notes: [], trade: { nonce: 52n, mbh: 1_000_000n } };
  const ev: unknown[][] = [];
  const a = await run(deps(chain, ev));
  assert.equal(ev.filter((e) => e[0] === "move").length, 0, "nothing is signed at 52, the held claim's nonce");
  assert.deepEqual(a, { error: "read_failed" });
  assert.deepEqual(ev.find((e) => e[0] === "stop"), ["stop", "note", "read_failed"]);
});

test("D3: once the claim lands (W's nonce at 52) the move goes; once its window passed, it goes at W's nonce", async () => {
  {
    const chain: Chain = { token: 0n, usdc: 3_000_000n, nonce: 52n, lostfound: 0n, height: 1000, notes: [], trade: { nonce: 52n, mbh: 1_000_000n } };
    const ev: unknown[][] = [];
    const a = await run(deps(chain, ev));
    assert.deepEqual(ev.filter((e) => e[0] === "move").map((e) => [e[1], e[2], e[3]]), [["n0", 3_000_000n, 52n]]);
    assert.ok(a !== null && "result" in a && a.result.stage === "filled");
  }
  {
    // the claim's window ends at 1003: the reads at 1001-1003 wait, the read at 1004 is past it
    const chain: Chain = { token: 0n, usdc: 3_000_000n, nonce: 51n, lostfound: 0n, height: 1000, notes: [], trade: { nonce: 52n, mbh: 1003n } };
    const ev: unknown[][] = [];
    const a = await run(deps(chain, ev));
    const move = ev.find((e) => e[0] === "move")!;
    assert.deepEqual([move[1], move[3]], ["n0", 51n]);
    assert.ok(chain.height > 1003);
    assert.ok(a !== null && "result" in a && a.result.stage === "filled");
  }
});

test("D3: a run keeps the last trade delegate it signed on the sell's record before sending it, and a read of it that fails stops the run before anything is signed", async () => {
  const chain: Chain = { token: 5_000n, usdc: 0n, nonce: 50n, lostfound: 10_000n, height: 1000, notes: [] };
  const ev: unknown[][] = [];
  await run(deps(chain, ev, { claimLands: true }));
  assert.equal(chain.trade!.nonce, 52n, "the claim, the swap round's last delegate");
  const broken = deps({ ...chain, token: 5_000n }, (ev.length = 0, ev));
  broken.lastTrade = () => {
    throw new Error("the store is closed");
  };
  assert.deepEqual(await run(broken), { error: "read_failed" });
  assert.equal(ev.filter((e) => e[0] === "sign").length, 0);
  const lost = deps({ ...chain, token: 5_000n, trade: null }, (ev.length = 0, ev));
  lost.traded = () => {
    throw new Error("the store is full");
  };
  assert.deepEqual(await run(lost), { error: "not_known" });
  assert.equal(ev.filter((e) => e[0] === "helper").length, 0, "a delegate not kept is never sent");
});

test("R3: in one run, with a claim signed at 52 and not landed, no move is asked while W's nonce is 51 inside the claim's window (closed in-run)", async () => {
  const chain: Chain = { token: 5_000n, usdc: 0n, nonce: 50n, lostfound: 10_000n, height: 1000, notes: [] };
  const ev: unknown[][] = [];
  const a = await run(deps(chain, ev, { claimLands: false }));
  assert.deepEqual(ev.find((e) => e[0] === "sign")![1], [["ft_transfer_call", 51n], ["claim_lostfound", 52n]]);
  assert.equal(ev.filter((e) => e[0] === "move").length, 0);
  assert.ok(a !== null && "result" in a && a.result.stage === "sent");
});

test("N8: USDC of at least the least deposit in W at the done read (it came in after the last note): sent, never filled", async () => {
  const chain: Chain = { token: 0n, usdc: 3_000_000n, nonce: 50n, lostfound: 0n, height: 1000, notes: [] };
  const ev: unknown[][] = [];
  let after = 0;
  // the notes' reads see W's 3 USDC, then none after it landed; the done read sees 2 USDC sent in after the last note
  const a = await run(deps(chain, ev, { read: (c, side) => (side === "buy" && c.notes[0]?.state === "UNSPENT" && after++ >= 1 ? { held: 2_000_000n } : undefined) }));
  assert.deepEqual(ev.filter((e) => e[0] === "move").map((e) => [e[1], e[2]]), [["n0", 3_000_000n]]);
  assert.deepEqual(ev.find((e) => e[0] === "stop"), ["stop", "done", "not_empty"]);
  assert.deepEqual(a, { result: { stage: "sent", txs: [{ chain: "near", hash: tx(90) }] } });
});

test("N9: a sale whose note another deposit took, with W's USDC then under the least deposit: part_filled (sold, nothing of W's landed), never filled", async () => {
  const chain: Chain = { token: 0n, usdc: 999_999n, nonce: 50n, lostfound: 0n, height: 1000, notes: [{ id: "n0", state: "INCOMING", amount: 2_000_000n, takenBy: "stranger" }] };
  const ev: unknown[][] = [];
  const a = await run(deps(chain, ev));
  assert.deepEqual(ev.filter((e) => e[0] === "move").map((e) => e[1]), ["n0"]);
  assert.deepEqual(a, { result: { stage: "part_filled", txs: [] } });
});

test("N11: after a swap the chain failed (carry_failed), the swap is asked again only once W's nonce is past the failed one, never at its nonce from a read behind it", async () => {
  const chain: Chain = { token: 5_000n, usdc: 0n, nonce: 50n, lostfound: 0n, height: 1000, notes: [] };
  const ev: unknown[][] = [];
  let failed = false;
  let behind = 0;
  const a = await run(
    deps(chain, ev, {
      swap: (body) => {
        if (failed || body.signed_delegates.length !== 1) return null;
        // the swap ran and failed on chain: the token back in W, its nonce used; the next two reads are behind it
        failed = true;
        chain.nonce += 1n;
        behind = 2;
        return { ok: false, code: "carry_failed", tx_hashes: [tx(11)] };
      },
      read: (c) => (behind > 0 ? (behind--, { nonce: c.nonce - 1n }) : undefined),
    }),
  );
  const swaps = ev.filter((e) => e[0] === "sign").map((e) => (e[1] as [string, bigint][])[0]![1]);
  assert.deepEqual(swaps, [51n, 52n], "the second swap at the nonce past the failed one");
  assert.ok(a !== null && "result" in a && a.result.stage === "filled");
});

test("in_flight: a swap the helper holds signed with its outcome not read yet answers sent (it may have sold), never an error", async () => {
  const chain: Chain = { token: 5_000n, usdc: 0n, nonce: 50n, lostfound: 0n, height: 1000, notes: [] };
  const ev: unknown[][] = [];
  const a = await run(deps(chain, ev, { swap: () => ({ ok: false, code: "in_flight" }) }));
  assert.deepEqual(ev.find((e) => e[0] === "stop"), ["stop", "swap", "in_flight"]);
  assert.deepEqual(a, { result: { stage: "sent", txs: [] } });
});
