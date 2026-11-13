// The device's NEAR sell against the relayer's own handler (apps/helper/src/bind/trade.ts carryTrade): the device's run
// (src/near-sell.ts nearSellFlow), its real signer (signNearSwapDelegates, the published all-zero seed of
// packages/wallet/test/vectors/a8.json), its wire client (src/near-buy.ts sendNearTrade) and the relayer's real handler,
// joined by a fetch that hands the body to carryTrade and answers its status and body. The chain is one fake for both
// sides; the vault's notes and moves are fakes (their own suites hold them).
//   node --test packages/signpage/test/near-sell-relayer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA, type RheaQuote } from "../../kit/src/near/rhea.ts";
import { NEAR_TOKEN_NO_FEE } from "../../kit/src/near/token-fee.ts";
import type { NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import type { HelperBindTradeRequest } from "../../kit/src/helper/v1.ts";
import { nearSwapWallet, signNearSwapDelegates } from "../../wallet/src/near/swap-delegate.ts";
import { carryTrade, type TradeDeps, type TradeRecord } from "../../../apps/helper/src/bind/trade.ts";
import type { Relayer, TxOutcome, TxRef } from "../../../apps/helper/src/bind/send.ts";
import type { KindContext } from "../src/api.ts";
import { sendNearTrade } from "../src/near-buy.ts";
import { nearSellFlow, type NearSellAnswer, type NearSellDeps, type NearTradeSigned } from "../src/near-sell.ts";
import { fakePair, type WithQuote } from "./near-pair-fake.ts";

const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero vector (a8.json)
const USDC = NEAR_NETWORKS.mainnet.usdc;
const TOKEN = "token.rhealab.near";
const L = 5n;
const J = 0;
const W = nearSwapWallet(SEED, L, J).id;
const HELD = 5_000_000n;
const OUT = 3_000_000n;
const MIN = 1_250_000_000_000_000_000_000n;
const ctx: KindContext = { id: "00000000-0000-4000-8000-000000000000", sha: "0".repeat(64), progress: () => {} };
const tx = (n: number) => `${"6".repeat(40)}${String(n).padStart(4, "0").replace(/\d/g, (d) => "ABCDEFGHJK"[Number(d)]!)}`;

type Chain = { usdcRegistered: boolean; nonce: bigint; height: number; usdc: bigint; token: bigint };

/** W bought the token before: the handler's record holds the buy's registration on the token, carried and landed. */
function world(o: { start?: Partial<Chain>; lag?: number; rec?: TradeRecord } = {}) {
  const chain: Chain = { usdcRegistered: true, nonce: 40n, height: 1_000, usdc: 0n, token: HELD, ...o.start };
  const recs = new Map<string, TradeRecord>([[W, structuredClone(o.rec ?? { w: W, creation: null, adopted: true, token: TOKEN, carried: [] })]]);
  const methodOf = new Map<string, string>();
  const sent: string[] = [];
  const answers: { status: number; body: unknown }[] = [];
  let reads = 0;
  let n = 0;
  const helper: TradeDeps = {
    cfg: { network: "mainnet", marginK: 30n },
    reads: {
      finalHeight: async () => BigInt(chain.height),
      newestFinalHeight: async () => BigInt(chain.height),
      account: async (id) => (id === W ? { kind: "account" } : { kind: "absent" }),
      accessKey: async (id) => (id === W ? { kind: "key", permission: "FullAccess", nonce: chain.nonce } : { kind: "no_account" }),
      ftBalance: async (t) => (t === USDC ? chain.usdc : chain.token),
      storageMin: async () => MIN,
      registered: async (tokens) => tokens.map((t) => (t === USDC ? chain.usdcRegistered : true)),
      payoutLanded: async (id) => id === W,
      hopsReal: async () => true,
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
        if (action.kind === "delegate") {
          const m = methodOf.get(Buffer.from(action.signed).toString("base64")) ?? "?";
          sent.push(m);
          chain.nonce += 1n;
          if (m === "storage_deposit") chain.usdcRegistered = true;
          if (m === "ft_transfer_call") (chain.token = 0n), (chain.usdc += OUT);
        }
        chain.height += 2;
        return { kind: "final", tx_hash: t.tx_hash, receipts: [{ executor: W, ok: true, failure: "", height: BigInt(chain.height) }] } as TxOutcome;
      },
      resolve: async (t) => ({ kind: "final", tx_hash: t.tx_hash, receipts: [{ executor: W, ok: true, failure: "", height: BigInt(chain.height) }] }) as TxOutcome,
    } as Relayer,
    held: async () => false,
  };
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const a = await carryTrade(JSON.parse(String(init.body)) as HelperBindTradeRequest, helper);
    answers.push(structuredClone(a));
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // the sale's notes: each lands with what it is given
  const notes: { id: string; state: string; amount: bigint | null }[] = [];
  let trade: NearTradeSigned | null = null;
  const deps: NearSellDeps & WithQuote = {
    network: "mainnet",
    wallet: () => ({ id: W, l: L, j: J, token: TOKEN }),
    helper: (body) => sendNearTrade(body, fetchFn),
    readWallet: async (a): Promise<NearSwapWalletState> => {
      reads++;
      chain.height += 1;
      return { account: a.wallet, height: chain.height, blockHash: "b", nonce: chain.nonce, held: a.side === "sell" ? chain.token : chain.usdc, registered: chain.usdcRegistered && reads > (o.lag ?? 0), storageMin: MIN, lostfound: 0n };
    },
    pair: fakePair(() => deps),
    quote: async (a): Promise<RheaQuote> => ({
      network: "mainnet",
      exchange: NEAR_RHEA.mainnet.exchange,
      height: chain.height,
      blockHash: "q",
      side: "sell",
      token: a.token,
      tokenIn: a.token,
      tokenOut: USDC,
      amountIn: a.amountIn!,
      venueIn: a.amountIn!,
      hops: [{ pool: 7, tokenIn: a.token, tokenOut: USDC, amountIn: a.amountIn!, amountOut: OUT, feeBps: 30 }],
      venueOut: OUT,
      amountOut: OUT,
      fee: NEAR_TOKEN_NO_FEE,
    }),
    sign: (l, j, given, request, q, s, bound) => {
      const signed = signNearSwapDelegates(SEED, l, j, given, request, q, s, bound);
      for (const x of signed) methodOf.set(x.signed_delegate, x.method_name);
      return signed;
    },
    note: async (_w, k, create) => {
      if (notes[k] === undefined) {
        if (!create) return null;
        notes[k] = { id: `n${k}`, state: "PLANNED", amount: null };
      }
      return { ...notes[k]! };
    },
    move: async (_w, id, amount) => {
      const x = notes.find((y) => y.id === id)!;
      if (amount === 0n) return { kind: "absent" };
      if (x.state !== "UNSPENT") (x.state = "UNSPENT"), (x.amount = amount), (chain.usdc -= amount);
      return { kind: "deposited", txs: [tx(900)], height: chain.height };
    },
    wait: async () => {},
    log: () => {},
    lastTrade: () => trade,
    traded: (t) => void (trade = { ...t }),
  };
  const run = async (): Promise<NearSellAnswer | null> => {
    const r = nearSellFlow(deps)({ token: TOKEN, slippageBps: 100 }, ctx);
    assert.ok("running" in r);
    await r.after;
    return r.answer() as NearSellAnswer | null;
  };
  return { run, chain, recs, sent, answers };
}

const codes = (answers: { body: unknown }[]) => answers.map((a) => ((a.body as { error?: { code: string } }).error?.code ?? "ok"));

test("the sell through the relayer's handler: W already registered on USDC, the swap carried by W's signed bytes, the USDC home, filled", async () => {
  const v = world();
  const a = await v.run();
  assert.ok(a !== null && "result" in a && a.result.stage === "filled", JSON.stringify(a));
  assert.deepEqual(v.sent, ["ft_transfer_call"]);
  assert.deepEqual(codes(v.answers), ["ok"]);
  assert.equal(v.chain.usdc, 0n);
});

test("a second registration (a provider behind shows W unregistered on USDC, the handler reads it registered): already_registered, the read decides, the swap goes on", async () => {
  // behind for W's first two reads: the light read, and the W read of the quote's pair the registration is signed from
  const v = world({ lag: 2 });
  const a = await v.run();
  assert.deepEqual(codes(v.answers), ["already_registered", "ok"]);
  assert.equal(v.answers[0]!.status, 409);
  assert.deepEqual(v.sent, ["ft_transfer_call"], "no registration sent");
  assert.ok(a !== null && "result" in a && a.result.stage === "filled", JSON.stringify(a));
});
