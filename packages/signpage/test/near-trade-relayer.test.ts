// The device's NEAR buy against the relayer's own handler (apps/helper/src/bind/trade.ts carryTrade), end to end: the
// device's run (src/near-trade.ts nearBuyFlow), its real signer (signNearSwapDelegates, the published all-zero seed of
// packages/wallet/test/vectors/a8.json), its wire client (src/near-buy.ts sendNearTrade) and the relayer's real handler,
// joined by a fetch that hands the body to carryTrade and answers its status and body. Only the chain is a fake, one for
// both sides: what the relayer's reads see and what the device reads, and a relayer that applies what it is given.
//   node --test packages/signpage/test/near-trade-relayer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA, type RheaQuote } from "../../kit/src/near/rhea.ts";
import { NEAR_TOKEN_NO_FEE } from "../../kit/src/near/token-fee.ts";
import { nearSwapFloor } from "../../kit/src/trade/near/swap.ts";
import type { NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import type { HelperBindTradeRequest } from "../../kit/src/helper/v1.ts";
import { nearSwapWallet, signNearSwapDelegates } from "../../wallet/src/near/swap-delegate.ts";
import { carryTrade, TRADE_SWAP_FAILS_MAX, type TradeDeps, type TradeRecord } from "../../../apps/helper/src/bind/trade.ts";
import type { Relayer, TxOutcome, TxRef } from "../../../apps/helper/src/bind/send.ts";
import type { KindContext } from "../src/api.ts";
import { sendNearTrade } from "../src/near-buy.ts";
import { NEAR_BUY_SWAP_ROUNDS, nearBuyFlow, type NearBuyAnswer, type NearBuyBegun, type NearBuyDeps, type NearBuyProgress } from "../src/near-trade.ts";
import { fakePair } from "./near-pair-fake.ts";

const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero vector (a8.json)
const USDC = NEAR_NETWORKS.mainnet.usdc;
const TOKEN = "token.rhealab.near";
const L = 5n;
const J = 0;
const W = nearSwapWallet(SEED, L, J).id;
const AMOUNT = 1_000_000n;
const ASK = { token: TOKEN, amount: AMOUNT, slippageBps: 100 };
const MIN = 1_250_000_000_000_000_000_000n;
const ctx: KindContext = { id: "00000000-0000-4000-8000-000000000000", sha: "0".repeat(64), progress: () => {} };
// a base58 tx hash, 44 characters
const tx = (n: number) => `${"5".repeat(40)}${String(n).padStart(4, "0").replace(/\d/g, (d) => "ABCDEFGHJK"[Number(d)]!)}`;

type Chain = { exists: boolean; registered: boolean; nonce: bigint; height: number; usdc: bigint; token: bigint };
type Opts = {
  start?: Partial<Chain>;
  /** the device's reads see W registered only from this many reads on (a provider behind) */
  lag?: number;
  hopsReal?: boolean;
  /** the handler's record of W from an earlier run (as carryTrade wrote it) */
  rec?: TradeRecord;
  /** answers lost on the way back for these methods: the handler ran, the device hears a timeout */
  lose?: string[];
  /** someone else's Transfer makes W right after the device read it absent (W's id is public once its payout lands) */
  othersTransfer?: boolean;
  /** the first this many swaps fail on chain: W's nonce taken, its USDC back (the exchange refunds it), no token */
  failSwaps?: number;
  /** after a swap failed, the device's next this many reads of W show its nonce from before it (a provider behind) */
  staleNonce?: number;
  /** venueOut per quote, in order (the last repeats) */
  outs?: bigint[];
};

function world(o: Opts = {}) {
  const chain: Chain = { exists: false, registered: false, nonce: 40n, height: 1_000, usdc: 0n, token: 0n, ...o.start };
  const recs = new Map<string, TradeRecord>(o.rec ? [[W, structuredClone(o.rec)]] : []);
  const methodOf = new Map<string, string>(); // signed bytes (base64) -> method, from the device's signer
  const sent: string[] = [];
  const answers: { status: number; body: unknown }[] = [];
  const records: NearBuyProgress[] = [];
  let reads = 0;
  let n = 0;
  let fails = o.failSwaps ?? 0;
  let stale = 0;
  let quotes = 0;
  const bodies: string[] = [];
  const helper: TradeDeps = {
    cfg: { network: "mainnet", marginK: 30n },
    reads: {
      finalHeight: async () => BigInt(chain.height),
      newestFinalHeight: async () => BigInt(chain.height),
      account: async (id) => (id === W && chain.exists ? { kind: "account" } : { kind: "absent" }),
      accessKey: async (id) => (id === W && chain.exists ? { kind: "key", permission: "FullAccess", nonce: chain.nonce } : { kind: "no_account" }),
      ftBalance: async (t) => (t === USDC ? chain.usdc : chain.token),
      storageMin: async () => MIN,
      registered: async (tokens) => tokens.map((t) => t === USDC || chain.registered),
      payoutLanded: async (id) => id === W,
      hopsReal: async () => o.hopsReal ?? true,
    },
    store: {
      get: (id) => (recs.has(id) ? structuredClone(recs.get(id)!) : null),
      create(rec) {
        if (recs.has(rec.w)) return { created: false, rec: structuredClone(recs.get(rec.w)!) };
        recs.set(rec.w, structuredClone(rec));
        return { created: true, rec };
      },
      put: (rec) => void recs.set(rec.w, structuredClone(rec)),
      close() {},
    },
    relayer: {
      account: "relayer.near",
      key: "relayer.near/ed25519:x",
      balance: async () => 10n ** 26n,
      async send(action, guard, before) {
        const code = await guard();
        if (code !== null) return { kind: "guarded", code };
        const t: TxRef = { tx_hash: tx(n++), nonce: String(n), height: String(chain.height), block_hash: "h", signed_tx: "" };
        before(t);
        if (action.kind === "transfer") (chain.exists = true), sent.push("transfer");
        else if (action.kind === "delegate") {
          const m = methodOf.get(Buffer.from(action.signed).toString("base64")) ?? "?";
          sent.push(m);
          chain.nonce += 1n;
          if (m === "storage_deposit") chain.registered = true;
          if (m === "ft_transfer_call" && fails > 0) {
            fails--;
            stale = o.staleNonce ?? 0;
            chain.height += 2;
            return { kind: "final", tx_hash: t.tx_hash, receipts: [{ executor: W, ok: true, failure: "", height: BigInt(chain.height) }, { executor: "v2.ref-finance.near", ok: false, failure: "E68: slippage error", height: BigInt(chain.height) }] } as TxOutcome;
          }
          if (m === "ft_transfer_call") (chain.usdc -= AMOUNT), (chain.token += 5_000_000n);
        }
        chain.height += 2;
        return { kind: "final", tx_hash: t.tx_hash, receipts: [{ executor: W, ok: true, failure: "", height: BigInt(chain.height) }] } as TxOutcome;
      },
      resolve: async (t) => ({ kind: "final", tx_hash: t.tx_hash, receipts: [{ executor: W, ok: true, failure: "", height: BigInt(chain.height) }] }) as TxOutcome,
    } as Relayer,
    held: async () => false,
  };
  // the wire: the device's own client, its fetch answered by the relayer's handler
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as HelperBindTradeRequest;
    bodies.push(...body.signed_delegates);
    const a = await carryTrade(body, helper);
    answers.push(structuredClone(a));
    const m = body.signed_delegates.length === 0 ? "create" : (methodOf.get(body.signed_delegates[0]!) ?? "?");
    if (o.lose?.includes(m)) throw new Error("timed out");
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const deps = (begun: Partial<NearBuyBegun> = {}): NearBuyDeps => {
    const d: NearBuyDeps = {
    pair: fakePair(() => d),
    network: "mainnet",
    begin: async (ask) => ({ ask, w: { id: W, l: L, j: J }, txs: [], ...begun }),
    progress: async (p) => void records.push(structuredClone(p)),
    payout: async () => {
      if (!begun.txs) chain.usdc += AMOUNT;
      return { kind: "landed", tx: tx(900) };
    },
    helper: (body) => sendNearTrade(body, fetchFn),
    readWallet: async (a): Promise<NearSwapWalletState> => {
      if (!chain.exists) {
        if (o.othersTransfer) chain.exists = true;
        throw new Error("W's keys: not a key list");
      }
      reads++;
      const behind = stale > 0;
      if (behind) stale--;
      return {
        account: a.wallet,
        height: chain.height,
        blockHash: "b",
        nonce: behind ? chain.nonce - 1n : chain.nonce,
        held: a.side === "buy" ? chain.usdc : chain.token,
        registered: chain.registered && reads > (o.lag ?? 0),
        storageMin: MIN,
        lostfound: 0n,
      };
    },
    quote: async (a): Promise<RheaQuote> => {
      const venueOut = o.outs?.[Math.min(quotes++, o.outs.length - 1)] ?? 5_000_000n;
      return {
      network: "mainnet",
      exchange: NEAR_RHEA.mainnet.exchange,
      height: chain.height,
      blockHash: "q",
      side: "buy",
      token: a.token,
      tokenIn: USDC,
      tokenOut: a.token,
      amountIn: a.amountIn,
      venueIn: a.amountIn,
      hops: [{ pool: 7, tokenIn: USDC, tokenOut: a.token, amountIn: a.amountIn, amountOut: venueOut, feeBps: 30 }],
      venueOut,
      amountOut: venueOut,
      fee: NEAR_TOKEN_NO_FEE,
      };
    },
    sign: (given, request, q, s, bound) => {
      const signed = signNearSwapDelegates(SEED, L, J, given, request, q, s, bound);
      for (const x of signed) methodOf.set(x.signed_delegate, x.method_name);
      return signed;
    },
    wait: async () => {},
    log: () => {},
    };
    return d;
  };
  const run = async (begun?: Partial<NearBuyBegun>): Promise<NearBuyAnswer | null> => {
    const r = nearBuyFlow(deps(begun))(ASK, ctx);
    assert.ok("running" in r);
    await r.after;
    return r.answer() as NearBuyAnswer | null;
  };
  return { run, chain, recs, sent, answers, records, fetchFn, bodies };
}

const stage = (a: NearBuyAnswer | null) => (a !== null && "result" in a ? a.result.stage : JSON.stringify(a));
const codes = (answers: { body: unknown }[]) => answers.map((a) => ((a.body as { error?: { code: string } }).error?.code ?? "ok"));

test("the happy path through the relayer's handler: created, registered, swapped, filled, each by the device's signed bytes", async () => {
  const v = world();
  assert.equal(stage(await v.run()), "filled");
  assert.deepEqual(v.sent, ["transfer", "storage_deposit", "ft_transfer_call"]);
  assert.deepEqual(codes(v.answers), ["ok", "ok", "ok"]);
});

test("an adopted W (someone else's Transfer made it): the handler answers 200 with no tx, and the device reads on to filled", async () => {
  const v = world({ othersTransfer: true });
  assert.equal(stage(await v.run()), "filled");
  assert.deepEqual(v.answers[0], { status: 200, body: { tx_hashes: [] } });
  assert.deepEqual(v.sent, ["storage_deposit", "ft_transfer_call"], "nothing sent to create W");
  assert.equal(v.recs.get(W)!.adopted, true);
});

test("a second registration (the first carried, its answer lost, a provider behind on resume): already_registered, the read decides, the swap goes on", async () => {
  const v = world({ lose: ["storage_deposit"] });
  const first = await v.run();
  assert.equal(stage(first), "sent", "the registration's answers lost: the run ends sent, to resume");
  assert.equal(v.sent.filter((m) => m === "storage_deposit").length, 1);
  // the resume: the device's reads still show W unregistered (its existence read, its state read, the fresh pair's), so
  // it signs a new registration, which the handler refuses as W's second
  const w = world({ start: { ...v.chain }, rec: v.recs.get(W)!, lag: 3 });
  assert.equal(stage(await w.run({ txs: [{ chain: "near", hash: tx(900) }] })), "filled");
  assert.deepEqual(codes(w.answers), ["already_registered", "ok"]);
  assert.deepEqual(w.answers[0]!.status, 409);
  assert.deepEqual(w.sent, ["ft_transfer_call"], "no second registration sent");
});

test("a provider that catches up between W's state read and the fresh pair: no registration signed, the read decides, the swap goes on", async () => {
  const v = world({ lose: ["storage_deposit"] });
  assert.equal(stage(await v.run()), "sent");
  const w = world({ start: { ...v.chain }, rec: v.recs.get(W)!, lag: 2 });
  assert.equal(stage(await w.run({ txs: [{ chain: "near", hash: tx(900) }] })), "filled");
  assert.deepEqual(codes(w.answers), ["ok"]);
  assert.deepEqual(w.sent, ["ft_transfer_call"]);
});

test("token_mismatch: W bound to another token by its first carried call: the buy ends with the code, nothing more sent", async () => {
  const bound: TradeRecord = { w: W, creation: null, adopted: true, token: "other.near", carried: [] };
  const v = world({ start: { exists: true }, rec: bound });
  const a = await v.run();
  assert.equal(stage(a), "sent");
  assert.equal(v.records.at(-1)!.code, "token_mismatch");
  assert.deepEqual(codes(v.answers).at(-1), "token_mismatch");
  assert.equal(v.answers.at(-1)!.status, 409);
  assert.deepEqual(v.sent, []);
});

test("token_untrusted: the token's hops are not Rhea pools: the buy ends with the code, nothing sent, never asked again", async () => {
  const v = world({ start: { exists: true }, hopsReal: false });
  const a = await v.run();
  assert.equal(stage(a), "sent");
  assert.equal(v.records.at(-1)!.code, "token_untrusted");
  assert.deepEqual(codes(v.answers), ["token_untrusted"]);
  assert.equal(v.answers.at(-1)!.status, 400);
  assert.deepEqual(v.sent, []);
});

test("no_account: a sell's creation is refused 400 by the handler and the device's client reads it as that code", async () => {
  const v = world();
  const body = { trade: { network: "mainnet", side: "sell", token: TOKEN, wallet: W, amount_in: "1000", slippage_bps: 100, venue_out: "900", hops: [{ pool: 7, token_in: TOKEN, token_out: USDC }] }, signed_delegates: [] } as HelperBindTradeRequest;
  assert.deepEqual(await sendNearTrade(body, v.fetchFn), { ok: false, code: "no_account" });
  assert.deepEqual(v.answers, [{ status: 400, body: { error: { code: "no_account" } } }]);
  assert.deepEqual(v.sent, []);
});

test("F6 a swap that failed on chain (carry_failed, the USDC back on W) is signed again in the same run on a fresh quote and its own floor, and fills", async () => {
  const v = world({ failSwaps: 1, outs: [5_000_000n, 5_000_000n, 5_000_000n, 4_900_000n] });
  assert.equal(stage(await v.run()), "filled");
  assert.deepEqual(v.sent, ["transfer", "storage_deposit", "ft_transfer_call", "ft_transfer_call"]);
  assert.deepEqual(codes(v.answers), ["ok", "ok", "carry_failed", "ok"]);
  assert.equal(v.answers[2]!.status, 502);
  assert.equal(new Set(v.bodies).size, v.bodies.length, "no signed bytes sent twice");
  // each round's floor in the record before its swap left: the second from the fresh quote and the user's slippage
  const floors = v.records.flatMap((r) => (r.swap ? [r.swap.floor] : []));
  assert.deepEqual(floors, [nearSwapFloor(5_000_000n, ASK.slippageBps).toString(), nearSwapFloor(4_900_000n, ASK.slippageBps).toString()]);
  assert.equal(v.recs.get(W)!.carried.filter((x) => x.method === "ft_transfer_call" && x.state === "failed" && x.refunded === true).length, 1);
});

test("F6 the retry waits for a read of W that has the failed swap's nonce (a provider behind is read again), never signing below it", async () => {
  const v = world({ failSwaps: 1, staleNonce: 3 });
  assert.equal(stage(await v.run()), "filled", JSON.stringify(codes(v.answers)));
  assert.deepEqual(codes(v.answers), ["ok", "ok", "carry_failed", "ok"]);
  assert.deepEqual(v.sent.filter((m) => m === "ft_transfer_call").length, 2);
});

test("F6 at the relayer's bound (TRADE_SWAP_FAILS_MAX swaps failed) the buy ends carry_failed with the USDC on W, sent (the sell's load pass sends it home)", async () => {
  assert.equal(NEAR_BUY_SWAP_ROUNDS, TRADE_SWAP_FAILS_MAX);
  const v = world({ failSwaps: TRADE_SWAP_FAILS_MAX });
  assert.equal(stage(await v.run()), "sent");
  assert.equal(v.sent.filter((m) => m === "ft_transfer_call").length, TRADE_SWAP_FAILS_MAX);
  assert.deepEqual(codes(v.answers).slice(2), Array(TRADE_SWAP_FAILS_MAX).fill("carry_failed"));
  assert.equal(v.records.at(-1)!.stage, "sent");
  assert.equal(v.records.at(-1)!.code, "carry_failed");
  assert.equal(v.chain.usdc, AMOUNT, "the USDC is W's");
  assert.equal(v.chain.token, 0n);
  // every failed swap's transaction is on the answer
  assert.equal(v.records.at(-1)!.txs.length, 1 + 1 + 1 + TRADE_SWAP_FAILS_MAX);
});
