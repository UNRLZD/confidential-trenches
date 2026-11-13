// The device's NEAR private sell (card near-private-trading, src/near-sell.ts nearSellFlow): W's token read, the
// device's own quote, the registration round on USDC when absent, the swap round, the USDC W received against the floor,
// W's return note written before the move, the move into the vault (in notes at most the deposit's cap each), and W
// read empty. Every dep is a fake here: no network, no key, no seed (the signer is a stand-in that records what it was
// asked). nearSellNote runs on the real note store (fake-indexeddb) with the all-zero published test seed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore } from "@blindfill/wallet/store";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA, RheaQuoteRefused, type RheaQuote } from "../../kit/src/near/rhea.ts";
import { NEAR_TOKEN_NO_FEE, type NearTokenFee } from "../../kit/src/near/token-fee.ts";
import { nearSwapFloor, type NearSwapCall } from "../../kit/src/trade/near/swap.ts";
import type { NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import type { HelperBindTradeRequest } from "../../kit/src/helper/v1.ts";
import type { SignedNearSwapDelegate } from "../../wallet/src/near/swap-delegate.ts";
import { entropyToWords, wordsToSeed64 } from "../../wallet/src/derive/index.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import type { KindContext } from "../src/api.ts";
import { NEAR_SELL_SWAPS_MAX, nearReturnMove, nearSellFlow, nearSellNote, noteAmount, type NearMoveEnd, type NearReturnNote, type NearSellAnswer, type NearSellDeps, type NearTradeSigned } from "../src/near-sell.ts";
import { HELPER_BIND_DEPOSIT_CAP } from "../../kit/src/helper/v1.ts";
import { VAULT_CONSTANTS } from "../../kit/src/vault/shapes.ts";
import { fakePair, type WithQuote } from "./near-pair-fake.ts";

const USDC = NEAR_NETWORKS.mainnet.usdc;
const EXCHANGE = NEAR_RHEA.mainnet.exchange;
const TOKEN = "token.rhealab.near";
const W = "ab".repeat(32);
const L = 5n;
const J = 2;
const HELD = 7_000_000_000_000_000_000n; // the token W holds
const SLIPPAGE = 100;
const STORAGE_MIN = 1_250_000_000_000_000_000_000n;
const tx = (n: number) => `${"4".repeat(40)}${String(n).padStart(4, "0").replace(/\d/g, (d) => "ABCDEFGHJK"[Number(d)]!)}`;
const ctx: KindContext = { id: "00000000-0000-4000-8000-000000000000", sha: "0".repeat(64), progress: () => {} };

const quoteOf = (amountIn: bigint, venueOut: bigint, n: number, fee: NearTokenFee = NEAR_TOKEN_NO_FEE): RheaQuote => ({
  network: "mainnet",
  exchange: EXCHANGE,
  height: 100 + n,
  blockHash: `block${n}`,
  side: "sell",
  token: TOKEN,
  tokenIn: TOKEN,
  tokenOut: USDC,
  amountIn,
  venueIn: amountIn,
  hops: [{ pool: 7, tokenIn: TOKEN, tokenOut: USDC, amountIn, amountOut: venueOut, feeBps: 30 }],
  venueOut,
  amountOut: venueOut,
  fee,
});

type Ev = [string, ...unknown[]];
type Round = "register" | "swap";
type World = {
  token?: bigint;
  usdc?: bigint;
  registered?: boolean;
  /** what the swap pays W in USDC */
  pays?: bigint;
  /** the venue out each quote names */
  venueOut?: bigint;
  fee?: NearTokenFee;
  refuse?: Partial<Record<Round, string>>;
  throws?: Partial<Record<Round, boolean>>;
  /** a refusal that carried the round's tx */
  carried?: Partial<Record<Round, boolean>>;
  /** what W holds in the exchange's lost-found (the swap round signs a claim after the swap) */
  lostfound?: bigint;
  /** the claim lands with the swap (else W's nonce stays short of it until its window passes) */
  claimLands?: boolean;
  /** the token the buy record binds W to (default: the request's) */
  bound?: string;
  /** what a look (a move of 0) finds in the vault's pages */
  look?: NearMoveEnd;
  /** the sale's first note as the store holds it at the start (absent: none yet) */
  note?: Partial<NearReturnNote> | "throw";
  /** every move's end; by default the note lands with W's amount */
  move?: NearMoveEnd | "throw";
  /** the k-th move only ends so (a stop: the page closed) */
  moveAt?: Record<number, NearMoveEnd | "throw">;
  /** the first swaps the chain fails, the token back in W (the helper's carry_failed) */
  swapFails?: number;
  /** each landing is at a block 2 past the next read's: that read lags, showing W's USDC before the landing */
  lag?: boolean;
  wallet?: null;
  /** a quote of another amount than asked */
  quoteAmountOff?: boolean;
  /** the last trade delegate a run before signed, as the sell's record keeps it */
  trade?: NearTradeSigned | "throw";
};

function world(o: World = {}) {
  const ev: Ev[] = [];
  const log: [string, string][] = [];
  const stops: [string, string, string | undefined][] = [];
  const chain = { registered: o.registered ?? true, nonce: 40n, usdc: o.usdc ?? 0n, token: o.token ?? HELD, lostfound: o.lostfound ?? 0n };
  // the note store: the sale's notes by k; a note lands with its amount
  // (a note given at the start whose call is written was sent before: W's USDC already left for it)
  const notes: (NearReturnNote & { k: number; sent: boolean })[] = [];
  if (o.note !== undefined && o.note !== "throw") notes.push({ id: "note-0", state: "PLANNED", amount: null, ...o.note, k: 0, sent: o.note.amount != null });
  let q = 0;
  let h = 0;
  let fails = o.swapFails ?? 0;
  // the last landing's block, and W's USDC a read below it still shows
  let landedAt = 0;
  let usdcBefore = 0n;
  const deps: NearSellDeps & WithQuote = {
    network: "mainnet",
    wallet: (token) => (ev.push(["wallet", token]), o.wallet === null ? null : { id: W, l: L, j: J, token: o.bound ?? token }),
    helper: async (body: HelperBindTradeRequest) => {
      ev.push(["helper", structuredClone(body)]);
      const round: Round = (JSON.parse(atob(body.signed_delegates[0]!)) as { method: string }).method === "storage_deposit" ? "register" : "swap";
      if (o.throws?.[round]) throw new Error("timed out");
      const code = o.refuse?.[round];
      if (code !== undefined) return { ok: false, code, ...(o.carried?.[round] ? { tx_hashes: [tx(77)] } : {}) };
      h++;
      if (round === "register") (chain.registered = true), (chain.nonce += 1n);
      if (round === "swap" && fails > 0) {
        // the swap's tx failed on chain: its input back in W, the nonce used
        fails--;
        chain.nonce += 1n;
        return { ok: false, code: "carry_failed" };
      }
      if (round === "swap") (chain.token -= BigInt(body.trade.amount_in)), (chain.usdc += o.pays ?? 3_000_000n), (chain.nonce += 1n);
      if (round === "swap" && body.signed_delegates.length === 2 && o.claimLands) (chain.usdc += chain.lostfound), (chain.lostfound = 0n), (chain.nonce += 1n);
      return { ok: true, tx_hashes: body.signed_delegates.map((_, i) => tx(20 + 10 * h + i)) };
    },
    readWallet: async (a) => {
      ev.push(["read", { ...a }]);
      const s: NearSwapWalletState = {
        account: a.wallet,
        height: 1_000 + ev.length,
        blockHash: "b",
        nonce: chain.nonce,
        held: a.side === "sell" ? chain.token : 1_000 + ev.length < landedAt ? usdcBefore : chain.usdc,
        registered: a.side === "sell" ? chain.registered : true,
        storageMin: STORAGE_MIN,
        lostfound: a.side === "sell" ? chain.lostfound : 0n,
      };
      return s;
    },
    quote: async (a) => {
      ev.push(["quote", { ...a }]);
      return quoteOf(o.quoteAmountOff ? a.amountIn! + 1n : a.amountIn!, o.venueOut ?? 3_000_000n, q++, o.fee);
    },
    pair: fakePair(() => deps),
    sign: (l, j, given, request, quote, state, bound) => {
      const read = { account: state.account, nonce: state.nonce, height: state.height };
      ev.push(["sign", l, j, structuredClone([...given]), { ...request }, { storageMin: state.storageMin, registered: state.registered, venueOut: quote.venueOut }, read, bound]);
      return given.map((call: NearSwapCall, k): SignedNearSwapDelegate => ({
        signed_delegate: btoa(JSON.stringify({ method: call.actions[0].FunctionCall.method_name, nonce: String(read.nonce + 1n + BigInt(k)) })),
        sender_id: call.sender_id,
        receiver_id: call.receiver_id,
        method_name: call.actions[0].FunctionCall.method_name,
        nonce: read.nonce + 1n + BigInt(k),
        max_block_height: BigInt(read.height) + 100n,
        public_key: "ed25519:x",
      }));
    },
    note: async (w, k, create) => {
      ev.push(["note", { ...w }, k, create]);
      if (o.note === "throw") throw new Error("the store is closed");
      let n = notes.find((x) => x.k === k);
      if (n === undefined && create) {
        // the store's rule: a note after the first only once the one before has landed
        if (k > 0 && notes.find((x) => x.k === k - 1)?.state !== "UNSPENT") throw new Error("waits until the note before it has landed");
        notes.push((n = { id: `note-${k}`, state: "PLANNED", amount: null, k, sent: false }));
      }
      return n === undefined ? null : { id: n.id, state: n.state, amount: n.amount };
    },
    move: async (w, noteId, amount) => {
      ev.push(["move", { ...w }, noteId, amount, chain.nonce]);
      const n = notes.find((x) => x.id === noteId)!;
      if (amount === 0n) {
        const found = o.look ?? { kind: "absent" };
        if (found.kind === "deposited" || found.kind === "front_run") n.state = "UNSPENT";
        return found;
      }
      const end = o.moveAt?.[n.k] ?? o.move ?? { kind: "deposited", txs: [tx(90 + n.k)], height: 1_000 + ev.length + (o.lag ? 2 : 0) };
      if (end === "throw") throw new Error("aborted");
      n.amount = amount; // the call written before it leaves
      if (end.kind === "front_run") n.state = "UNSPENT";
      if (end.kind === "deposited") {
        if (end.height !== undefined) (landedAt = end.height), (usdcBefore = chain.usdc);
        if (!n.sent) chain.usdc -= amount;
        n.sent = true;
        n.state = "UNSPENT";
      }
      return end;
    },
    wait: async (ms) => void ev.push(["wait", ms]),
    log: (step, outcome) => void log.push([step, outcome]),
    stop: (step, code, cause) => void stops.push([step, code, cause]),
    lastTrade: () => {
      if (o.trade === "throw") throw new Error("the store is closed");
      return kept;
    },
    traded: (t) => void ev.push(["traded", (kept = { ...t })]),
  };
  let kept: NearTradeSigned | null = o.trade === "throw" ? null : (o.trade ?? null);
  return { deps, ev, log, chain, notes, stops };
}

const run = async (deps: NearSellDeps, ask = { token: TOKEN, slippageBps: SLIPPAGE }): Promise<NearSellAnswer | null> => {
  const r = nearSellFlow(deps)(ask, ctx);
  assert.ok("running" in r, "a sell is answered by running");
  await r.after;
  return r.answer() as NearSellAnswer | null;
};
const sent = (...hs: string[]) => ({ result: { stage: "sent", txs: hs.map((hash) => ({ chain: "near", hash })) } });
const names = (ev: Ev[]) => ev.map((e) => e[0]);
const moves = (ev: Ev[]) => ev.filter((e) => e[0] === "move").map((e) => [e[2], e[3]]);
const helperBodies = (ev: Ev[]) => ev.filter((e) => e[0] === "helper").map((e) => e[1] as HelperBindTradeRequest);
const signs = (ev: Ev[]) => ev.filter((e) => e[0] === "sign");

test("the happy path: all W holds sold on the device's quote, signed by W bound to the token, the USDC received against the floor, the note written before the move, the move of what W received, W read empty", async () => {
  const { deps, ev, log, chain } = world();
  const answer = await run(deps);
  // each round's pair: W and the quote at one block (deps.pair; this world's fake reads them in turn), the swap's with
  // the baseline of USDC at the same block
  assert.deepEqual(names(ev), ["wallet", "read", "read", "quote", "read", "quote", "read", "sign", "traded", "helper", "read", "read", "note", "move", "read", "note", "read", "read"]);
  assert.deepEqual(ev[0], ["wallet", TOKEN]);
  // the swap's delegate kept on the sell's record before it is sent
  assert.deepEqual(ev[8], ["traded", { nonce: 41n, mbh: 1_105n }]);
  assert.deepEqual(ev[1]![1], { wallet: W, side: "sell", token: TOKEN });
  for (const e of ev.filter((x) => x[0] === "quote")) assert.deepEqual(e[1], { side: "sell", token: TOKEN, amountIn: HELD });
  const [sign] = signs(ev);
  assert.equal(sign![1], L);
  assert.equal(sign![2], J);
  const calls = sign![3] as NearSwapCall[];
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.receiver_id, TOKEN);
  assert.equal(calls[0]!.sender_id, W);
  assert.equal(calls[0]!.actions[0].FunctionCall.method_name, "ft_transfer_call");
  const args = calls[0]!.actions[0].FunctionCall.args as { receiver_id: string; amount: string; msg: string };
  assert.equal(args.receiver_id, EXCHANGE);
  assert.equal(args.amount, HELD.toString());
  // the floor is the device's: from its own quote and the user's slippage
  assert.equal(JSON.parse(args.msg).actions[0].min_amount_out, nearSwapFloor(3_000_000n, SLIPPAGE).toString());
  assert.deepEqual(sign![4], { network: "mainnet", side: "sell", token: TOKEN, amountIn: HELD, wallet: W, slippageBps: SLIPPAGE });
  assert.equal(sign![7], TOKEN, "the sell is signed for the token W's buy is bound to");
  const [swap] = helperBodies(ev);
  assert.deepEqual(swap!.trade, { network: "mainnet", side: "sell", token: TOKEN, wallet: W, amount_in: HELD.toString(), slippage_bps: SLIPPAGE, venue_out: "3000000", hops: [{ pool: 7, token_in: TOKEN, token_out: USDC }] });
  // the note before the move; the move is what W received, on that note
  assert.deepEqual(ev[12], ["note", { id: W, l: L, j: J, token: TOKEN }, 0, true]);
  assert.deepEqual(ev[13]!.slice(0, 4), ["move", { id: W, l: L, j: J, token: TOKEN }, "note-0", 3_000_000n]);
  // W read empty after the landing: no second note is written
  assert.deepEqual(ev[15], ["note", { id: W, l: L, j: J, token: TOKEN }, 1, false]);
  assert.equal(chain.token, 0n);
  assert.equal(chain.usdc, 0n);
  assert.deepEqual(log, [
    ["read", "token held"],
    ["quote", "quote"],
    ["register", "already registered"],
    ["quote", "quote"],
    ["swap", "swapped"],
    ["receive", "received"],
    ["note", "noted"],
    ["move", "in the vault"],
    ["done", "wallet empty"],
  ]);
  assert.deepEqual(answer, { result: { stage: "filled", txs: [tx(30), tx(90)].map((hash) => ({ chain: "near", hash })) } });
});

test("a quote refused for a lag between the two providers is read again, bounded, never the end of the sale", async () => {
  const { deps, log } = world();
  const quote = deps.quote;
  let n = 0;
  deps.quote = async (x) => {
    if (n++ === 0) throw new RheaQuoteRefused("lag", "the two providers' final heights are more than 3 blocks apart");
    return quote(x);
  };
  const a = await run(deps);
  assert.ok(a !== null && "result" in a && a.result.stage === "filled", `${JSON.stringify(a)} ${JSON.stringify(log)}`);
  // past the bound it ends before anything is signed or sent
  const b = world();
  b.deps.quote = async () => {
    throw new RheaQuoteRefused("lag", "the two providers' final heights are more than 3 blocks apart");
  };
  const ba = await run(b.deps);
  assert.ok(ba !== null && "error" in ba, JSON.stringify(ba));
  assert.equal(signs(b.ev).length, 0);
  assert.equal(helperBodies(b.ev).length, 0);
});

test("the swap is signed from W's read of the swap's own pair (the read right before its quote), never from an earlier read", async () => {
  const { deps, ev } = world({ registered: false });
  const answer = await run(deps);
  assert.ok(answer !== null && "result" in answer && answer.result.stage === "filled", JSON.stringify(answer, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  for (const at of ev.flatMap((e, i) => (e[0] === "sign" ? [i] : []))) {
    const q = ev.slice(0, at).map((e) => e[0]).lastIndexOf("quote");
    const r = ev.slice(0, q).map((e) => e[0]).lastIndexOf("read");
    // a read's height in this world is 1,000 + the length of ev once it is pushed
    assert.equal((ev[at]![6] as { height: number }).height, 1_000 + r + 1, `the sign at ${at} is from the read at ${r}`);
  }
});

test("P3-4 the signer's bound is the token W's buy record names, never the ask's own token", async () => {
  const { deps, ev } = world({ bound: "other.near" });
  await run(deps);
  const [sign] = signs(ev);
  assert.equal(sign![7], "other.near");
  assert.equal((sign![4] as { token: string }).token, TOKEN, "the request is the ask's: the signer compares the two");
});

test("W not registered on USDC: the registration round alone, read back, then the swap from the nonce after it", async () => {
  const { deps, ev } = world({ registered: false });
  const answer = await run(deps);
  assert.ok(answer !== null && "result" in answer);
  const [reg, swap] = signs(ev);
  assert.deepEqual(reg![3], [{ sender_id: W, receiver_id: USDC, actions: [{ FunctionCall: { method_name: "storage_deposit", args: { account_id: W, registration_only: true }, gas: 10_000_000_000_000, deposit: STORAGE_MIN.toString() } }] }]);
  assert.equal((reg![6] as { nonce: bigint }).nonce, 40n);
  assert.equal((swap![6] as { nonce: bigint }).nonce, 41n);
  assert.equal(helperBodies(ev).length, 2);
});

test("P1 below the floor: the swap was sent, so the answer is sent with its tx (never an error); received_below_floor goes to the stop; no note and no move", async () => {
  const floor = nearSwapFloor(3_000_000n, SLIPPAGE);
  const { deps, ev, log, stops } = world({ pays: floor - 1n });
  assert.deepEqual(await run(deps), sent(tx(30)));
  assert.ok(!names(ev).includes("note") && !names(ev).includes("move"));
  assert.deepEqual(log.at(-1), ["receive", "received_below_floor"]);
  assert.deepEqual(stops, [["receive", "received_below_floor", undefined]]);
});

test("a fee the seller pays on top: the amount sold leaves it room (nearSellAmount), quoted again at that amount and signed at it", async () => {
  const fee: NearTokenFee = { buyBps: 100, sellBps: 100, senderPays: true, scope: [EXCHANGE], exempt: [], unknown: false };
  const { deps, ev } = world({ fee });
  const answer = await run(deps);
  assert.ok(answer !== null && "result" in answer);
  const want = (HELD * 10_000n) / 10_100n;
  const quotes = ev.filter((e) => e[0] === "quote").map((e) => (e[1] as { amountIn: bigint }).amountIn);
  assert.deepEqual(quotes, [HELD, want, want]);
  assert.equal((signs(ev)[0]![4] as { amountIn: bigint }).amountIn, want);
});

test("resume: W holds no token but USDC (a run that stopped after the swap): no quote, no signature, no helper; the note, then the move of what W holds", async () => {
  const { deps, ev } = world({ token: 0n, usdc: 2_500_000n });
  const answer = await run(deps);
  assert.deepEqual(names(ev), ["wallet", "read", "read", "note", "move", "read", "note", "read", "read"]);
  assert.deepEqual(ev[4]!.slice(0, 4), ["move", { id: W, l: L, j: J, token: TOKEN }, "note-0", 2_500_000n]);
  assert.deepEqual(answer, { result: { stage: "filled", txs: [{ chain: "near", hash: tx(90) }] } });
});

test("resume: W empty with the note's call written (the move sent, not landed): that call is settled at its own amount", async () => {
  const { deps, ev } = world({ token: 0n, usdc: 0n, note: { state: "INCOMING", amount: 1_700_000n } });
  assert.ok("result" in (await run(deps))!);
  assert.deepEqual(moves(ev), [["note-0", 1_700_000n]]);
});

test("a written call's amount wins over what W holds (more arrived): the same note, the same amount; what W still holds goes on in the next note", async () => {
  const { deps, ev, chain } = world({ token: 0n, usdc: 9_000_000n, note: { state: "INCOMING", amount: 1_700_000n } });
  assert.ok("result" in (await run(deps))!);
  assert.deepEqual(moves(ev), [["note-0", 1_700_000n], ["note-1", 9_000_000n]]);
  assert.equal(chain.usdc, 0n);
});

test("W empty and no note: not_funded, nothing moved", async () => {
  const { deps, ev } = world({ token: 0n, usdc: 0n });
  assert.deepEqual(await run(deps), { error: "not_funded" });
  assert.ok(!names(ev).includes("move"));
});

test("P3-5 W empty and its note PLANNED with no call: the note looked up in the vault's pages (a move of 0); found there it is landed and the sale filled, absent it is not_funded", async () => {
  {
    const { deps, ev } = world({ token: 0n, usdc: 0n, note: {}, look: { kind: "deposited", txs: [], height: 1 } });
    assert.deepEqual(await run(deps), { result: { stage: "filled", txs: [] } });
    assert.deepEqual(moves(ev), [["note-0", 0n]]);
  }
  {
    const { deps, ev } = world({ token: 0n, usdc: 0n, note: {} });
    assert.deepEqual(await run(deps), { error: "not_funded" });
    assert.deepEqual(moves(ev), [["note-0", 0n]]);
  }
});

test("the sell done before (W empty, the note UNSPENT with no amount read): filled, nothing moved", async () => {
  const { deps, ev, log } = world({ token: 0n, usdc: 0n, note: { state: "UNSPENT" } });
  assert.deepEqual(await run(deps), { result: { stage: "filled", txs: [] } });
  assert.ok(!names(ev).includes("move"));
  assert.ok(log.some(([s, o]) => s === "move" && o === "in the vault already"));
});

test("no W bound to the token: not_allowed, nothing read", async () => {
  const { deps, ev } = world({ wallet: null });
  assert.deepEqual(await run(deps), { error: "not_allowed" });
  assert.deepEqual(names(ev), ["wallet"]);
});

test("a quote of another amount: quote_check_failed, nothing signed or sent", async () => {
  const { deps, ev } = world({ quoteAmountOff: true });
  assert.deepEqual(await run(deps), { error: "quote_check_failed" });
  assert.ok(!names(ev).includes("sign") && !names(ev).includes("helper"));
});

test("the helper's refusal passes through verbatim when it is a trade code; another code is not_known; the swap is never sent again", async () => {
  for (const [o, want] of [
    [{ refuse: { swap: "trade_used" } }, "trade_used"],
    [{ refuse: { swap: "swap_n4" } }, "swap_n4"],
    [{ refuse: { swap: "made_up" } }, "not_known"],
  ] as const) {
    const { deps, ev, stops } = world(o as World);
    assert.deepEqual(await run(deps), { error: want }, JSON.stringify(o));
    assert.equal(helperBodies(ev).length, 1);
    assert.ok(!names(ev).includes("note") && !names(ev).includes("move"));
    assert.deepEqual(stops, [["swap", want, undefined]]);
  }
});

test("P1 a swap that may have gone out (the send threw, or the refusal carried its tx): sent with what is known, never an error; never sent again", async () => {
  for (const [o, want, code] of [
    [{ throws: { swap: true } }, sent(), "not_known"],
    [{ refuse: { swap: "swap_n4" }, carried: { swap: true } }, sent(tx(77)), "swap_n4"],
  ] as const) {
    const { deps, ev, stops } = world(o as World);
    assert.deepEqual(await run(deps), want, JSON.stringify(o));
    assert.equal(helperBodies(ev).length, 1);
    assert.deepEqual(stops, [["swap", code, undefined]]);
  }
});

test("the registration round refused or thrown: an error (no token has left W), the swap never asked", async () => {
  for (const o of [{ registered: false, refuse: { register: "trade_used" } }, { registered: false, throws: { register: true } }] as World[]) {
    const { deps, ev } = world(o);
    const a = await run(deps);
    assert.ok(a !== null && "error" in a, JSON.stringify(o));
    assert.equal(helperBodies(ev).length, 1);
  }
});

test("P1 the move's end after the swap: sent with the swap's tx (never an error); a deposit code verbatim, struck as sender_struck, a throw or another code not_known, to the stop; never asked twice", async () => {
  for (const [move, want] of [
    [{ kind: "refused", code: "amount_above_cap" }, "amount_above_cap"],
    [{ kind: "refused", code: "made_up" }, "not_known"],
    [{ kind: "struck" }, "sender_struck"],
    ["throw", "not_known"],
    [{ kind: "deposited", txs: ["not a hash"], height: 1 }, "not_known"],
    [{ kind: "deposited", txs: [] }, "not_known"],
  ] as const) {
    const { deps, ev, stops } = world({ move: move as World["move"] });
    assert.deepEqual(await run(deps), sent(tx(30)), JSON.stringify(move));
    assert.equal(ev.filter((e) => e[0] === "move").length, 1);
    assert.deepEqual(stops, [["move", want, undefined]]);
  }
});

test("P2-2 a note whose P another deposit took (front_run): that note is done and W's USDC goes on the next note; past 3 in one run it stops as sent, nothing lost", async () => {
  {
    const { deps, ev, chain } = world({ moveAt: { 0: { kind: "front_run", height: 1 } } });
    assert.deepEqual(await run(deps), { result: { stage: "filled", txs: [tx(30), tx(91)].map((hash) => ({ chain: "near", hash })) } });
    assert.deepEqual(moves(ev), [["note-0", 3_000_000n], ["note-1", 3_000_000n]]);
    assert.equal(chain.usdc, 0n);
  }
  {
    const { deps, ev, stops, chain } = world({ move: { kind: "front_run", height: 1 } });
    assert.deepEqual(await run(deps), sent(tx(30)));
    assert.equal(moves(ev).length, 3);
    assert.deepEqual(stops, [["move", "p_used", undefined]]);
    assert.equal(chain.usdc, 3_000_000n);
  }
});

test("P1 a resumed sell (W holds no token, its USDC on the way home) whose move stops: sent, never an error", async () => {
  const { deps, stops } = world({ token: 0n, usdc: 2_500_000n, move: { kind: "struck" } });
  assert.deepEqual(await run(deps), sent());
  assert.deepEqual(stops, [["move", "sender_struck", undefined]]);
});

test("the note cannot be written after the swap: sent, not_known to the stop, and no move is asked", async () => {
  const { deps, ev, stops } = world({ note: "throw" });
  assert.deepEqual(await run(deps), sent(tx(30)));
  assert.ok(!names(ev).includes("move"));
  assert.deepEqual(stops, [["note", "not_known", undefined]]);
});

test("a throw that is no stop (a part out of its contract) after the swap: sent, its cause in legCause's shape (never its text) at the step last logged", async () => {
  const { deps, stops } = world();
  const read = deps.readWallet;
  let n = 0;
  deps.readWallet = async (a) => {
    const s = await read(a);
    // the receive read (the fifth: the first, the quote's pair, the swap's pair and its baseline before it) answers a
    // state with no held amount: the floor's arithmetic throws a TypeError
    if (++n === 5) return { ...s, held: undefined as unknown as bigint };
    return s;
  };
  const a = await run(deps);
  assert.deepEqual(a, sent(tx(30)));
  assert.equal(stops.length, 1);
  const [step, code, cause] = stops[0]!;
  assert.deepEqual([step, code], ["swap", "not_known"]);
  assert.match(cause!, /^TypeError\b/);
  assert.ok(!/BigInt|mix/i.test(cause!), "the throw's text never reaches the record");
});

test("P3-3 a quote whose floor is under the vault's 1 USDC minimum: amount_too_low before anything is signed; the token stays in W", async () => {
  const { deps, ev, chain } = world({ venueOut: 1_000_000n, pays: 1_000_000n });
  assert.deepEqual(await run(deps), { error: "amount_too_low" });
  assert.ok(!names(ev).includes("sign") && !names(ev).includes("helper") && !names(ev).includes("move"));
  assert.equal(chain.token, HELD);
});

test("USDC under the least deposit left in W after a sale whose notes landed (a fee's dust): filled; with none landed and the token gone: part_filled, never an answer read as nothing sold", async () => {
  {
    const { deps } = world({ token: 0n, usdc: 999_999n, note: { state: "UNSPENT", amount: 2_000_000n } });
    assert.deepEqual(await run(deps), { result: { stage: "filled", txs: [{ chain: "near", hash: tx(90) }] } });
  }
  {
    const { deps, ev } = world({ token: 0n, usdc: 999_999n });
    assert.deepEqual(await run(deps), { error: "not_funded" }, "no token sold this run or before and no note: nothing to say was sold");
    assert.ok(!names(ev).includes("move"));
  }
});

test("P2-1 the return note landed before and W holds the token again: the token sold, the landed note settled at its own amount, the new USDC on the next note (R n 0); filled only from an empty W", async () => {
  const { deps, ev, chain, notes } = world({ token: 5_000_000_000_000_000_000n, note: { state: "UNSPENT", amount: 2_000_000n } });
  const a = await run(deps);
  assert.deepEqual(moves(ev), [["note-0", 2_000_000n], ["note-1", 3_000_000n]]);
  assert.equal(chain.usdc, 0n);
  assert.deepEqual(notes.map((n) => n.state), ["UNSPENT", "UNSPENT"]);
  assert.deepEqual(a, { result: { stage: "filled", txs: [tx(30), tx(90), tx(91)].map((hash) => ({ chain: "near", hash })) } });
});

test("P2-1 W not empty at the done read (USDC still arriving, a token sent in): sent, never filled", async () => {
  const { deps, stops } = world();
  const read = deps.readWallet;
  deps.readWallet = async (a) => {
    const s = await read(a);
    // the token side, read for the done step after the move: a token sent in
    return a.side === "sell" && s.height > 1_012 ? { ...s, held: 7n } : s;
  };
  assert.deepEqual(await run(deps), sent(tx(30), tx(90)));
  assert.deepEqual(stops, [["done", "not_empty", undefined]]);
});

test("P3-2 a lost-found claim signed after the swap: no note is moved before W's nonce reached the claim's (or its window passed); the USDC the claim brings goes in too", async () => {
  {
    const { deps, ev, chain } = world({ lostfound: 10_000n, claimLands: true });
    assert.ok("result" in (await run(deps))!);
    const sign = signs(ev).at(-1)!;
    assert.deepEqual((sign[3] as NearSwapCall[]).map((c) => c.actions[0].FunctionCall.method_name), ["ft_transfer_call", "claim_lostfound"]);
    const move = ev.find((e) => e[0] === "move")!;
    assert.equal(move[4], 42n, "the deposit is asked with W's nonce past the claim's");
    assert.equal(move[3], 3_010_000n);
    assert.equal(chain.usdc, 0n);
  }
  {
    // the claim never lands: W's nonce stays short of it; the reads go on past its window (mbh = read height + 100)
    // (the reads here stay inside its window): no deposit is signed, the run stops as sent and the next goes on
    const { deps, ev, stops } = world({ lostfound: 10_000n, claimLands: false });
    assert.deepEqual(await run(deps), sent(tx(30), tx(31)));
    assert.ok(!names(ev).includes("move"));
    assert.deepEqual(stops, [["note", "read_failed", undefined]]);
  }
});

test("M3 USDC in W before the swap: what W received is counted from the read before it, never W's whole balance", async () => {
  const floor = nearSwapFloor(3_000_000n, SLIPPAGE);
  const { deps, stops } = world({ usdc: 5_000_000n, pays: floor - 1n });
  assert.deepEqual(await run(deps), sent(tx(30)));
  assert.deepEqual(stops, [["receive", "received_below_floor", undefined]]);
});

test("proceeds of 2,500 USDC: three notes, the return note and two R arrivals, at most the cap each, each written before its move and moved only once the one before landed; W ends empty", async () => {
  const pays = 2_500_000_000n;
  const { deps, ev, chain, notes } = world({ pays, venueOut: pays });
  const answer = await run(deps);
  assert.deepEqual(moves(ev), [["note-0", 1_000_000_000n], ["note-1", 1_000_000_000n], ["note-2", 500_000_000n]]);
  // each note asked for before its move, the next only after the one before it landed
  const order = ev.filter((e) => e[0] === "note" || e[0] === "move").map((e) => `${e[0]}:${String(e[2])}`);
  assert.deepEqual(order, ["note:0", "move:note-0", "note:1", "move:note-1", "note:2", "move:note-2", "note:3"]);
  assert.deepEqual(notes.map((n) => [n.id, n.state, n.amount]), [["note-0", "UNSPENT", 1_000_000_000n], ["note-1", "UNSPENT", 1_000_000_000n], ["note-2", "UNSPENT", 500_000_000n]]);
  assert.equal(chain.usdc, 0n);
  assert.deepEqual(answer, { result: { stage: "filled", txs: [tx(30), tx(90), tx(91), tx(92)].map((hash) => ({ chain: "near", hash })) } });
});

test("a read of W that lags the landing (below the block the vault's pages held the note at) is read again, never taken: no note for USDC that already left", async () => {
  const pays = 1_500_000_000n;
  const { deps, ev, chain } = world({ pays, venueOut: pays, lag: true });
  assert.ok("result" in (await run(deps))!);
  assert.deepEqual(moves(ev), [["note-0", 1_000_000_000n], ["note-1", 500_000_000n]]);
  assert.equal(chain.usdc, 0n);
  // after each landing: a lagging read, a wait, then the read the next note is planned from
  const at = names(ev).indexOf("move");
  assert.deepEqual(names(ev).slice(at, at + 5), ["move", "read", "wait", "read", "note"]);
});

test("a stop after the first of three notes landed: a new run resumes the other two from what the chain and the store say, nothing moved twice", async () => {
  const pays = 2_500_000_000n;
  const w = world({ pays, venueOut: pays, moveAt: { 1: "throw" } });
  assert.deepEqual(await run(w.deps), sent(tx(30), tx(90)));
  assert.equal(w.chain.usdc, 1_500_000_000n);
  assert.deepEqual(w.notes.map((n) => [n.id, n.state]), [["note-0", "UNSPENT"], ["note-1", "PLANNED"]]);
  // the page again: no token left, so no quote, no signature, no swap; note 0 settled at its own amount, then 1 and 2
  const again = world({ token: 0n, usdc: w.chain.usdc });
  again.notes.push(...w.notes.map((n) => ({ ...n })));
  const answer = await run(again.deps);
  assert.ok(!names(again.ev).includes("quote") && !names(again.ev).includes("sign") && !names(again.ev).includes("helper"));
  assert.deepEqual(moves(again.ev), [["note-0", 1_000_000_000n], ["note-1", 1_000_000_000n], ["note-2", 500_000_000n]]);
  assert.equal(again.chain.usdc, 0n);
  assert.deepEqual(answer, { result: { stage: "filled", txs: [tx(90), tx(91), tx(92)].map((hash) => ({ chain: "near", hash })) } });
});

test("noteAmount: all of it up to the cap; past the cap the cap, unless the rest would be under the least deposit, then all but that least", () => {
  const MIN = VAULT_CONSTANTS.MIN_DEPOSIT;
  const CAP = HELPER_BIND_DEPOSIT_CAP;
  assert.equal(noteAmount(MIN), MIN);
  assert.equal(noteAmount(CAP), CAP);
  assert.equal(noteAmount(CAP + MIN), CAP);
  assert.equal(noteAmount(CAP + 1n), CAP + 1n - MIN);
  assert.equal(noteAmount(CAP + MIN - 1n), CAP - 1n);
  for (let held = MIN; held < 3n * CAP; held += 333_333_337n) {
    let left = held;
    while (left > 0n) {
      const a = noteAmount(left);
      assert.ok(a >= MIN && a <= CAP && a <= left, `${held}: ${a} of ${left}`);
      left -= a;
    }
  }
});

test("a swap that failed on chain with the token back in W: asked again on a fresh quote, at most NEAR_SELL_SWAPS_MAX swaps; past them carry_failed ends it", async () => {
  {
    const { deps, ev, log } = world({ swapFails: NEAR_SELL_SWAPS_MAX - 1 });
    const answer = await run(deps);
    assert.ok(answer !== null && "result" in answer && answer.result.stage === "filled");
    const swaps = signs(ev);
    assert.equal(swaps.length, NEAR_SELL_SWAPS_MAX);
    // each swap signed at the nonce read after the one before failed
    assert.deepEqual(swaps.map((x) => (x[6] as { nonce: bigint }).nonce), [40n, 41n, 42n]);
    assert.equal(log.filter(([st, o]) => st === "swap" && o === "asked again").length, NEAR_SELL_SWAPS_MAX - 1);
  }
  {
    const { deps, ev } = world({ swapFails: NEAR_SELL_SWAPS_MAX });
    assert.deepEqual(await run(deps), { error: "carry_failed" });
    assert.equal(signs(ev).length, NEAR_SELL_SWAPS_MAX);
    assert.ok(!names(ev).includes("note") && !names(ev).includes("move"));
  }
});

test("a slippage of 0 or past the cap, or no token: not_allowed at once, nothing read", () => {
  const { deps, ev } = world();
  for (const ask of [
    { token: TOKEN, slippageBps: 0 },
    { token: TOKEN, slippageBps: 10_000 },
    { token: "", slippageBps: 100 },
  ])
    assert.deepEqual(nearSellFlow(deps)(ask, ctx), { error: "not_allowed" });
  assert.equal(ev.length, 0);
});

test("nearSellNote: W's return note on NEAR, then its R second arrivals, each written PLANNED with its ref's precommitment before anything moves, the next only once the one before landed; asked again the same note; absent and not to be written, none", async () => {
  const seed = wordsToSeed64(entropyToWords(new Uint8Array(16)));
  const ws = await openWalletStore({ indexedDB: new IDBFactory() });
  const store = await openNoteStore(ws);
  const ret = { kind: "return" as const, c: "near" as const, l: L, j: J };
  const r = (n: number) => ({ kind: "second" as const, id: { id: "R" as const, c: "near" as const, l: L, j: J }, n });
  try {
    assert.equal(await nearSellNote(store, seed, 42n, { l: L, j: J }, 0, false), null, "absent, not written");
    assert.equal((await store.list()).length, 0);
    const a = (await nearSellNote(store, seed, 42n, { l: L, j: J }, 0, true))!;
    assert.deepEqual({ state: a.state, amount: a.amount }, { state: "PLANNED", amount: null });
    const n = await store.get(a.id);
    assert.deepEqual(n!.ref, ret);
    assert.equal(n!.precommitment, noteSecrets(seed, ret).precommitment);
    assert.equal(n!.scope, 42n);
    assert.equal((await nearSellNote(store, seed, 42n, { l: L, j: J }, 0, true))!.id, a.id);
    assert.equal((await nearSellNote(store, seed, 42n, { l: L, j: J }, 0, false))!.id, a.id);
    assert.equal((await store.list()).length, 1);
    // the same ref under another scope is not this vault's note: refused, nothing written
    await assert.rejects(nearSellNote(store, seed, 43n, { l: L, j: J }, 0, true));
    // the second note waits until the first has landed (the store's rule): refused, nothing written
    await assert.rejects(nearSellNote(store, seed, 42n, { l: L, j: J }, 1, true), /waits until the note before it has landed/);
    assert.equal((await store.list()).length, 1);
    const leaf = (p: bigint, k: bigint) => ({ value: 1_000_000_000n, label: 7n, commitment: noteCommitment(1_000_000_000n, 7n, p), leafIndex: k });
    await store.move(a.id, "PLANNED", "INCOMING");
    await store.move(a.id, "INCOMING", "UNSPENT", { leaf: leaf(n!.precommitment, 0n) });
    const b = (await nearSellNote(store, seed, 42n, { l: L, j: J }, 1, true))!;
    const nb = await store.get(b.id);
    assert.deepEqual(nb!.ref, r(0));
    assert.equal(nb!.precommitment, noteSecrets(seed, r(0)).precommitment);
    await assert.rejects(nearSellNote(store, seed, 42n, { l: L, j: J }, 2, true), /waits until the note before it has landed/);
    await assert.rejects(nearSellNote(store, seed, 42n, { l: L, j: J }, -1, true), /k is a note's place/);
  } finally {
    store.close();
    ws.close();
  }
});

test("nearReturnMove: the bind's end as the flow reads it: deposited with the last call's txs and the vault cursor's height; a front-run stays front_run (never deposited); refused with its code; struck", async () => {
  const seed = wordsToSeed64(entropyToWords(new Uint8Array(16)));
  const ws = await openWalletStore({ indexedDB: new IDBFactory() });
  const store = await openNoteStore(ws);
  try {
    const n = (await nearSellNote(store, seed, 42n, { l: L, j: J }, 0, true))!;
    const note = (await store.get(n.id))!;
    const withCall = { ...note, calls: [{ tx_hashes: [tx(5)] }] } as never;
    const rpcs = [{ name: NEAR_NETWORKS.testnet.fastnear[0] }, { name: NEAR_NETWORKS.testnet.drpc }] as never;
    const height = (await store.syncCursor(NEAR_NETWORKS.testnet.vault!)).height;
    const asked: unknown[] = [];
    for (const [out, want] of [
      [{ kind: "deposited", note: withCall }, { kind: "deposited", txs: [tx(5)], height }],
      [{ kind: "front_run", note: withCall }, { kind: "front_run", height }],
      [{ kind: "refused", code: "amount_above_cap" }, { kind: "refused", code: "amount_above_cap" }],
      [{ kind: "struck", account: W }, { kind: "struck" }],
    ] as const) {
      const bind = (async (_s: Uint8Array, args: unknown) => (asked.push(args), out)) as never;
      assert.deepEqual(await nearReturnMove(seed, { l: L, j: J }, n.id, 3_000_000n, { network: "testnet", store, rpcs, bind }), want, out.kind);
    }
    assert.deepEqual(asked[0], { network: "testnet", w: { l: L, j: J }, noteId: n.id, amount: 3_000_000n });
  } finally {
    store.close();
    ws.close();
  }
});

test("a second registration refused already_registered while W still reads unregistered: the read decides, the run stops not_registered with nothing swapped", async () => {
  const { deps, ev, stops } = world({ registered: false, refuse: { register: "already_registered" } });
  const a = await run(deps);
  assert.deepEqual(a, { error: "not_registered" });
  assert.deepEqual(stops.map((x) => [x[0], x[1]]), [["register", "not_registered"]]);
  assert.equal(helperBodies(ev).length, 1, "no swap sent");
});

// review P3-5 of e6c66cce3: each guard on the pair a sell signs from, planted through the pair (fakePair)
/** The world's pair with `edit` applied to its reads from the first one `when` names, `times` of them. */
const plantPair = (deps: NearSellDeps, when: (a: Parameters<NearSellDeps["pair"]>[0]) => boolean, edit: (p: Awaited<ReturnType<NearSellDeps["pair"]>>) => Awaited<ReturnType<NearSellDeps["pair"]>>, times = Infinity) => {
  const pair = deps.pair;
  let left = times;
  deps.pair = async (a) => {
    const p = await pair(a);
    return when(a) && left-- > 0 ? edit(p) : p;
  };
};

test("P3-5 the swap's pair read a block before the registration landed (not registered, its nonce before it): read again, the swap signed at the nonce after the registration", async () => {
  const { deps, ev, chain } = world({ registered: false });
  plantPair(deps, () => chain.registered, (p) => ({ ...p, state: { ...p.state, registered: false, nonce: p.state.nonce - 1n } }), 1);
  const answer = await run(deps);
  assert.ok(answer !== null && "result" in answer, JSON.stringify(answer));
  const [, swap] = signs(ev);
  assert.equal((swap![6] as { nonce: bigint }).nonce, 41n, "never at the registration's own nonce");
});

test("P3-5 the swap's pair reading less of the token than the amount sold: not_funded, nothing signed for the swap", async () => {
  const { deps, ev, stops } = world();
  plantPair(deps, (a) => a.baseline !== undefined, (p) => ({ ...p, state: { ...p.state, held: p.state.held - 1n } }));
  await run(deps);
  assert.equal(signs(ev).length, 0);
  assert.deepEqual(stops.at(-1)?.slice(0, 2), ["swap", "not_funded"]);
});

for (const [what, edit, code] of [
  ["a read of another account", (p: Awaited<ReturnType<NearSellDeps["pair"]>>) => ({ ...p, state: { ...p.state, account: "cd".repeat(32) } }), "read_failed"],
  ["a quote on another network", (p: Awaited<ReturnType<NearSellDeps["pair"]>>) => ({ ...p, quote: { ...p.quote, network: "testnet" as const } }), "quote_check_failed"],
  ["a quote of the other side", (p: Awaited<ReturnType<NearSellDeps["pair"]>>) => ({ ...p, quote: { ...p.quote, side: "buy" as const } }), "quote_check_failed"],
  ["a quote of another token", (p: Awaited<ReturnType<NearSellDeps["pair"]>>) => ({ ...p, quote: { ...p.quote, token: "other.near" } }), "quote_check_failed"],
] as const) {
  test(`P3-5 the sell's pair with ${what}: ${code}, nothing signed or sent`, async () => {
    const { deps, ev, log } = world();
    plantPair(deps, () => true, edit);
    assert.deepEqual(await run(deps), { error: code });
    assert.ok(!names(ev).includes("sign") && !names(ev).includes("helper"));
    // refused on the pair as read, at the quote, never later by the calls' own check (nearSwapCalls)
    assert.equal(log.at(-1)?.[0], "quote", JSON.stringify(log));
  });
}

test("P3-5 the swap's pair asked for its baseline and answered without one: read_failed, nothing signed for the swap", async () => {
  const { deps, ev, stops } = world();
  plantPair(deps, (a) => a.baseline !== undefined, (p) => {
    const { baseline: _gone, ...rest } = p;
    return rest;
  });
  await run(deps);
  assert.equal(signs(ev).length, 0);
  assert.deepEqual(stops.at(-1)?.slice(0, 2), ["swap", "read_failed"]);
});
