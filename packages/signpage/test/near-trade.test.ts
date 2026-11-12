// The device's NEAR private buy (card near-private-trading, src/near-trade.ts nearBuyFlow): the buy's record first, the
// vault's payout to W, W's creation, its registration round, a fresh pair (W read, then the quote) and the swap round,
// then what W received against the floor; once the payout landed, never an error. Every dep is a fake here: no network,
// no key, no seed (the signer is a stand-in that records what it was asked).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA, type RheaQuote } from "../../kit/src/near/rhea.ts";
import { NEAR_TOKEN_NO_FEE, type NearTokenFee } from "../../kit/src/near/token-fee.ts";
import { nearSwapFloor, type NearSwapCall } from "../../kit/src/trade/near/swap.ts";
import type { NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import type { HelperBindTradeRequest } from "../../kit/src/helper/v1.ts";
import type { SignedNearSwapDelegate } from "../../wallet/src/near/swap-delegate.ts";
import type { KindContext } from "../src/api.ts";
import { fakePair } from "./near-pair-fake.ts";
import { checkNearBuyRequest, NearTradeRefused } from "../src/rules/near-trade.ts";
import { NEAR_BUY_READ_TRIES, NEAR_BUY_SENDS, nearBuyFlow, type NearBuyAnswer, type NearBuyBegun, type NearBuyDeps, type NearBuyProgress } from "../src/near-trade.ts";

const USDC = NEAR_NETWORKS.mainnet.usdc;
const EXCHANGE = NEAR_RHEA.mainnet.exchange;
const TOKEN = "token.rhealab.near";
const W = "ab".repeat(32);
const L = 5n;
const J = 2;
const AMOUNT = 1_000_000n;
const SLIPPAGE = 100;
const STORAGE_MIN = 1_250_000_000_000_000_000_000n;
// a base58 tx hash, 44 characters
const tx = (n: number) => `${"4".repeat(40)}${String(n).padStart(4, "0").replace(/\d/g, (d) => "ABCDEFGHJK"[Number(d)]!)}`;
const near = (...hashes: string[]) => hashes.map((hash) => ({ chain: "near" as const, hash }));
const ctx: KindContext = { id: "00000000-0000-4000-8000-000000000000", sha: "0".repeat(64), progress: () => {} };
const ASK = { token: TOKEN, amount: AMOUNT, slippageBps: SLIPPAGE };

type Ev = [string, ...unknown[]];
type Round = "create" | "register" | "swap";
type World = {
  /** what the chain holds at the start (a resume's) */
  start?: Partial<{ exists: boolean; registered: boolean; usdc: bigint; token: bigint; nonce: bigint }>;
  begun?: Partial<NearBuyBegun>;
  /** what the swap pays W */
  pays?: bigint;
  /** helper answers per round, one per send, in order; past the list: ok */
  answers?: Partial<Record<Round, (string | "throw")[]>>;
  payout?: Awaited<ReturnType<NearBuyDeps["payout"]>> | "throw";
  /** the registration never reads back */
  neverRegisters?: boolean;
  /** the swap fails on chain: the USDC stays on W */
  swapFails?: boolean;
  /** quotes: venueOut per quote read, in order (the last repeats) */
  outs?: bigint[];
  fee?: NearTokenFee;
  /** the helper adopts W as it is: the creation answers 200 with no tx */
  adopted?: boolean;
  /** a refused registration lands all the same (W reads registered after it) */
  registersAnyway?: boolean;
  /** a refused swap round landed its swap all the same (its claim failed after it): the token on W */
  swapLandsAnyway?: boolean;
};

/** Fake deps over one W: the chain as the fakes keep it, and every call in order. */
function world(o: World = {}) {
  const ev: Ev[] = [];
  const log: [string, string][] = [];
  const records: NearBuyProgress[] = [];
  const chain = { exists: false, registered: false, nonce: 40n, usdc: 0n, token: 0n, height: 1_000, ...o.start };
  const outs = o.outs ?? [5_000_000n, 5_100_000n, 4_900_000n];
  const quotes: RheaQuote[] = [];
  const sends: Record<Round, number> = { create: 0, register: 0, swap: 0 };
  const deps: NearBuyDeps = {
    network: "mainnet",
    begin: async (ask) => (ev.push(["begin", { ...ask }]), { ask, w: { id: W, l: L, j: J }, txs: [], ...o.begun }),
    progress: async (p) => void records.push(structuredClone(p)),
    payout: async () => {
      ev.push(["payout"]);
      if (o.payout === "throw") throw new Error("timed out");
      const end = o.payout ?? { kind: "landed", tx: tx(1) };
      if (end.kind === "landed" && !o.begun) chain.usdc += AMOUNT;
      return end;
    },
    helper: async (body: HelperBindTradeRequest) => {
      ev.push(["helper", structuredClone(body)]);
      const round: Round = body.signed_delegates.length === 0 ? "create" : (JSON.parse(atob(body.signed_delegates[0]!)) as { method: string }).method === "storage_deposit" ? "register" : "swap";
      const a = o.answers?.[round]?.[sends[round]++];
      if (a === "throw") throw new Error("timed out");
      if (a !== undefined) {
        if (round === "register" && o.registersAnyway) (chain.registered = true), (chain.nonce += 1n);
        if (round === "swap" && o.swapLandsAnyway) (chain.nonce += 1n), (chain.usdc -= AMOUNT), (chain.token += o.pays ?? 5_000_000n);
        return { ok: false, code: a };
      }
      if (round === "create") chain.exists = true;
      if (round === "create" && o.adopted) return { ok: true, tx_hashes: [] };
      if (round === "register") (chain.registered = !o.neverRegisters), (chain.nonce += 1n);
      if (round === "swap") {
        chain.nonce += BigInt(body.signed_delegates.length);
        if (!o.swapFails) (chain.usdc -= AMOUNT), (chain.token += o.pays ?? 5_000_000n);
      }
      const n = ev.length;
      return { ok: true, tx_hashes: body.signed_delegates.length === 0 ? [tx(100 + n)] : body.signed_delegates.map((_, i) => tx(200 + 10 * n + i)) };
    },
    readWallet: async (a) => {
      ev.push(["read", { ...a }]);
      if (!chain.exists) throw new Error("Rhea quote refused (rpc): W's keys: not a key list");
      const s: NearSwapWalletState = {
        account: a.wallet,
        height: ++chain.height,
        blockHash: "b",
        nonce: chain.nonce,
        held: a.side === "buy" ? chain.usdc : chain.token,
        registered: a.side === "buy" ? chain.registered : true,
        storageMin: STORAGE_MIN,
        lostfound: 0n,
      };
      return s;
    },
    quote: async (a) => {
      ev.push(["quote", { ...a }]);
      const venueOut = outs[Math.min(quotes.length, outs.length - 1)]!;
      const q: RheaQuote = {
        network: "mainnet",
        exchange: EXCHANGE,
        height: ++chain.height,
        blockHash: `block${quotes.length}`,
        side: "buy",
        token: TOKEN,
        tokenIn: USDC,
        tokenOut: TOKEN,
        amountIn: AMOUNT,
        venueIn: AMOUNT,
        hops: [{ pool: 7, tokenIn: USDC, tokenOut: TOKEN, amountIn: AMOUNT, amountOut: venueOut, feeBps: 30 }],
        venueOut,
        amountOut: venueOut,
        fee: o.fee ?? NEAR_TOKEN_NO_FEE,
      };
      quotes.push(q);
      return q;
    },
    sign: (given, request, q, s, bound) => {
      ev.push(["sign", structuredClone([...given]), { ...request }, { venueOut: q.venueOut, height: q.height }, { ...s }, bound]);
      return given.map((call: NearSwapCall, k): SignedNearSwapDelegate => ({
        signed_delegate: btoa(JSON.stringify({ method: call.actions[0].FunctionCall.method_name, nonce: String(s.nonce + 1n + BigInt(k)) })),
        sender_id: call.sender_id,
        receiver_id: call.receiver_id,
        method_name: call.actions[0].FunctionCall.method_name,
        nonce: s.nonce + 1n + BigInt(k),
        max_block_height: BigInt(s.height) + 100n,
        public_key: "ed25519:x",
      }));
    },
    wait: async (ms) => void ev.push(["wait", ms]),
    log: (step, outcome) => void log.push([step, outcome]),
    pair: fakePair(() => deps),
  };
  return { deps, ev, log, chain, quotes, records };
}

const run = async (deps: NearBuyDeps, ask = ASK): Promise<NearBuyAnswer | null> => {
  const r = nearBuyFlow(deps)(ask, ctx);
  assert.ok("running" in r, "a buy is answered by running");
  await r.after;
  return r.answer() as NearBuyAnswer | null;
};
const names = (ev: Ev[]) => ev.map((e) => e[0]);
const helperBodies = (ev: Ev[]) => ev.filter((e) => e[0] === "helper").map((e) => e[1] as HelperBindTradeRequest);
const signs = (ev: Ev[]) => ev.filter((e) => e[0] === "sign");
const methodOf = (b: HelperBindTradeRequest) => (b.signed_delegates.length === 0 ? "create" : (JSON.parse(atob(b.signed_delegates[0]!)) as { method: string }).method);
const tradeOf = (q: RheaQuote) => ({
  network: "mainnet",
  side: "buy",
  token: TOKEN,
  wallet: W,
  amount_in: AMOUNT.toString(),
  slippage_bps: SLIPPAGE,
  venue_out: q.venueOut.toString(),
  hops: q.hops.map((x) => ({ pool: x.pool, token_in: x.tokenIn, token_out: x.tokenOut })),
});
const sent = (a: NearBuyAnswer | null) => {
  assert.ok(a !== null && "result" in a && a.result.stage === "sent", JSON.stringify(a, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  return a.result.txs;
};

test("the route for the app: W at once, then Rhea and the pool the swap signs against, then what W received at the token's decimals; the fill on the record", async () => {
  const { deps, quotes, records } = world();
  const told: unknown[] = [];
  deps.route = (r) => void told.push(r);
  deps.decimals = async () => 6;
  const answer = await run(deps);
  assert.ok(answer !== null && "result" in answer && answer.result.stage === "filled");
  const out = records.at(-1)!.fill!;
  assert.equal(out.decimals, 6);
  assert.ok(BigInt(out.out) > 0n);
  const units = (BigInt(out.out) / 1_000_000n).toString() + (BigInt(out.out) % 1_000_000n === 0n ? "" : `.${(BigInt(out.out) % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")}`);
  assert.deepEqual(told, [{ wallet: W }, { venue: "Rhea", pool: String(quotes[2]!.hops[0]!.pool) }, { out: units }]);
});

test("the decimals not read: the buy is still filled, no amount told and no fill on the record; a route that throws stops nothing", async () => {
  const { deps, records } = world();
  deps.route = () => {
    throw new Error("the app's display");
  };
  deps.decimals = async () => {
    throw new Error("rpc down");
  };
  const answer = await run(deps);
  assert.ok(answer !== null && "result" in answer && answer.result.stage === "filled");
  assert.equal(records.at(-1)!.fill, undefined);
});

// the relayer at bcb795f2's own answers (apps/helper/src/bind/trade.test.ts:588 an adopted W, 200 { tx_hashes: [] };
// :483 and :490 a second registration, already_registered; :496 token_mismatch; :607 token_untrusted)
test("relayer bcb795f2: an adopted W (200, no tx) is W there as it is; the reads go on and the buy fills", async () => {
  const { deps, log } = world({ adopted: true });
  const a = await run(deps);
  assert.ok(a !== null && "result" in a && a.result.stage === "filled", JSON.stringify(a));
  assert.ok(log.some(([s]) => s === "create"));
});

test("relayer bcb795f2: a second registration answers already_registered: the device's read decides, and the swap goes on", async () => {
  const { deps } = world({ answers: { register: ["already_registered"] }, registersAnyway: true });
  const a = await run(deps);
  assert.ok(a !== null && "result" in a && a.result.stage === "filled", JSON.stringify(a));
});

test("relayer bcb795f2: token_mismatch and token_untrusted at the swap end the buy with their own code, sent after the payout (never not_known), never sent again", async () => {
  for (const code of ["token_mismatch", "token_untrusted"]) {
    const { deps, records, ev } = world({ answers: { swap: [code] } });
    const a = await run(deps);
    assert.ok(a !== null && "result" in a && a.result.stage === "sent", code);
    assert.equal(records.at(-1)!.code, code);
    assert.equal(helperBodies(ev).length, 3, `${code}: the swap once`);
  }
});

test("the happy path: the record first, the payout, create, the registration alone, a fresh pair, the swap, what W received; each step on the record", async () => {
  const { deps, ev, log, quotes, records } = world();
  const answer = await run(deps);
  // the swap's pair: W, the quote, and the baseline of the token at the same block (deps.pair; this world's fake reads
  // them in that order)
  assert.deepEqual(names(ev), ["begin", "payout", "read", "quote", "helper", "read", "read", "quote", "sign", "helper", "read", "read", "quote", "read", "sign", "helper", "read"]);
  for (const e of ev.filter((x) => x[0] === "quote")) assert.deepEqual(e[1], { side: "buy", token: TOKEN, amountIn: AMOUNT });
  const [create, register, swap] = helperBodies(ev);
  assert.deepEqual(create, { trade: tradeOf(quotes[0]!), signed_delegates: [] });
  const [regSign, swapSign] = signs(ev);
  // the registration: exactly one storage_deposit, W's own, the token's minimum, from the state read just before the quote
  assert.deepEqual(regSign![1], [{ sender_id: W, receiver_id: TOKEN, actions: [{ FunctionCall: { method_name: "storage_deposit", args: { account_id: W, registration_only: true }, gas: 10_000_000_000_000, deposit: STORAGE_MIN.toString() } }] }]);
  assert.deepEqual(regSign![2], { network: "mainnet", side: "buy", token: TOKEN, amountIn: AMOUNT, wallet: W, slippageBps: SLIPPAGE });
  assert.equal((regSign![4] as NearSwapWalletState).registered, false);
  assert.equal((regSign![4] as NearSwapWalletState).nonce, 40n);
  // P3-1: the one-token rule is on: the record's token is the bound
  assert.equal(regSign![5], TOKEN);
  assert.equal(register!.signed_delegates.length, 1);
  assert.deepEqual(register!.trade, tradeOf(quotes[1]!));
  // the swap: the fresh quote's swap alone, signed from the nonce read after the registration, bound to the token
  const call = (swapSign![1] as NearSwapCall[])[0]!;
  assert.equal(call.receiver_id, USDC);
  assert.equal(call.actions[0].FunctionCall.method_name, "ft_transfer_call");
  assert.equal((call.actions[0].FunctionCall.args as { amount: string }).amount, AMOUNT.toString());
  assert.equal((swapSign![4] as NearSwapWalletState).nonce, 41n);
  assert.equal((swapSign![4] as NearSwapWalletState).registered, true);
  assert.equal(swapSign![5], TOKEN);
  assert.deepEqual(swap!.trade, tradeOf(quotes[2]!));
  // each signature's state was read before its quote, within the signer's window
  for (const s of signs(ev)) assert.ok((s[3] as { height: number }).height > (s[4] as NearSwapWalletState).height);
  assert.deepEqual(log, [
    ["payout", "payout landed"],
    ["quote", "quote"],
    ["create", "wallet created"],
    ["quote", "quote"],
    ["register", "registered"],
    ["quote", "quote"],
    ["swap", "swapped"],
    ["receive", "received"],
  ]);
  assert.ok(answer !== null && "result" in answer && answer.result.stage === "filled");
  assert.equal(answer.result.txs.length, 4);
  assert.deepEqual(answer.result.txs[0], { chain: "near", hash: tx(1) });
  // the record: sent once the payout landed, the floor and baseline before the swap left, filled at the end
  assert.deepEqual(records.map((r) => [r.step, r.stage]), [["payout", "sent"], ["create", "sent"], ["register", "sent"], ["swap", "sent"], ["swap", "sent"], ["receive", "filled"]]);
  assert.deepEqual(records[3]!.swap, { floor: nearSwapFloor(4_900_000n, SLIPPAGE).toString(), before: "0" });
  assert.deepEqual(records.at(-1)!.txs, answer.result.txs);
});

test("an already registered W skips the registration round: no storage_deposit is signed or sent", async () => {
  const { deps, ev, log } = world({ start: { registered: true }, pays: 5_100_000n });
  const answer = await run(deps);
  assert.equal(signs(ev).length, 1);
  assert.equal((signs(ev)[0]![1] as NearSwapCall[])[0]!.actions[0].FunctionCall.method_name, "ft_transfer_call");
  assert.ok(log.some((l) => l[1] === "already registered"));
  assert.ok(answer !== null && "result" in answer && answer.result.stage === "filled");
});

test("P1-1 once the payout landed no answer is an error: every later stop answers sent with the payout and every tx so far; the code and its cause go to the log and the record", async () => {
  const cases: [World, string, number][] = [
    [{ answers: { register: ["storage_above_cap"] } }, "storage_above_cap", 2],
    [{ answers: { swap: ["trade_used"] } }, "trade_used", 3],
    [{ answers: { swap: ["relayer_low"] } }, "relayer_low", 3],
    [{ answers: { swap: ["in_flight", "in_flight", "in_flight", "in_flight"] } }, "in_flight", 3],
    [{ answers: { swap: ["throw", "throw", "throw", "throw"] } }, "not_known", 3],
    [{ neverRegisters: true }, "not_registered", 3],
    [{ pays: nearSwapFloor(4_900_000n, SLIPPAGE) - 1n }, "received_below_floor", 4],
  ];
  for (const [w, code, n] of cases) {
    const { deps, log, records } = world(w);
    const txs = sent(await run(deps));
    assert.equal(txs[0]!.hash, tx(1), code);
    assert.equal(txs.length, n, code);
    assert.equal(log.at(-1)![1], code, code);
    assert.equal(records.at(-1)!.stage, "sent", code);
    assert.equal(records.at(-1)!.code, code, code);
    assert.deepEqual(records.at(-1)!.txs, txs, code);
  }
});

test("P1-1 a thrown error's cause is on the record in legCause's shape (name, code, frames), never its text", async () => {
  const { deps, records } = world({ answers: { swap: ["throw", "throw", "throw", "throw"] } });
  const help = deps.helper;
  deps.helper = async (b) => {
    if (methodOf(b) !== "create" && methodOf(b) !== "storage_deposit") throw Object.assign(new Error("https://secret.example/key=abc"), { name: "TypeError" });
    return help(b);
  };
  sent(await run(deps));
  const cause = records.at(-1)!.cause!;
  assert.match(cause, /^TypeError/);
  assert.ok(!cause.includes("secret") && !cause.includes("key="), cause);
});

test("a payout that did not land ends before any helper call with its code, the money in the vault; one that threw is answered sent with no tx, never paid again", async () => {
  for (const [payout, code] of [
    [{ kind: "expired" }, "payout_expired"],
    [{ kind: "elsewhere" }, "payout_elsewhere"],
    [{ kind: "Not A Kind" }, "payout_failed"],
  ] as const) {
    const { deps, ev, log, records } = world({ payout });
    assert.deepEqual(await run(deps), { error: code });
    assert.deepEqual(names(ev), ["begin", "payout"]);
    assert.deepEqual(log, [["payout", code]]);
    assert.deepEqual(records.map((r) => [r.stage, r.code]), [["refused", code]]);
  }
  const { deps, ev, records } = world({ payout: "throw" });
  assert.deepEqual(sent(await run(deps)), []);
  assert.deepEqual(names(ev), ["begin", "payout"]);
  assert.deepEqual(records.map((r) => [r.stage, r.code]), [["sent", "not_known"]]);
});

test("NT05 NT06 a payout that is not landed never counts; a landed one's tx is kept only in the form of a hash", async () => {
  const { deps, ev } = world({ payout: { kind: "landing", tx: undefined } });
  assert.deepEqual(await run(deps), { error: "payout_landing" });
  assert.deepEqual(names(ev), ["begin", "payout"]);
  const b = world({ payout: { kind: "landed", tx: "not a hash" } });
  const a = await run(b.deps);
  assert.ok(a !== null && "result" in a && a.result.stage === "filled");
  assert.ok(!a.result.txs.some((t) => t.hash === "not a hash"));
  // landed with no hash the relayer named: still landed (the helper reads the vault's row itself)
  const c = world({ payout: { kind: "landed", tx: null } });
  const ca = await run(c.deps);
  assert.ok(ca !== null && "result" in ca && ca.result.stage === "filled" && ca.result.txs.length === 3);
});

test("NT04 W's id must be a 64-hex implicit id before the payout is asked: anything else is refused, nothing paid", async () => {
  for (const id of ["ab".repeat(31), "AB".repeat(32), "alice.near", `${"ab".repeat(32)}0`]) {
    const { deps, ev } = world({ begun: { w: { id, l: L, j: J } } });
    assert.deepEqual(await run(deps), { error: "not_allowed" }, id);
    assert.deepEqual(names(ev), ["begin"], id);
  }
  // no note covers the ask: begin answers null, refused, nothing paid
  const { deps, ev } = world();
  deps.begin = async () => null;
  assert.deepEqual(await run(deps), { error: "not_allowed" });
  assert.equal(ev.length, 0);
});

test("P2-3 a W someone else created (or the helper created before) goes on to the reads: wallet_exists and wallet_created are not stops", async () => {
  for (const code of ["wallet_exists", "wallet_created"]) {
    const { deps, chain } = world({ answers: { create: [code] } });
    // the helper refused, but W exists (anyone's transfer): the reads find it
    const help = deps.helper;
    deps.helper = async (b) => {
      if (methodOf(b) === "create") chain.exists = true;
      return help(b);
    };
    const a = await run(deps);
    assert.ok(a !== null && "result" in a && a.result.stage === "filled", code);
  }
  // a W that reads existing already is never sent a creation
  const { deps, ev } = world({ start: { exists: true } });
  await run(deps);
  assert.ok(!helperBodies(ev).some((b) => b.signed_delegates.length === 0));
});

test("P2-4 a passing fault does not end the run: a quote or a read that throws is asked again, bounded; the helper's not-yet answers get the same body again", async () => {
  // a quote that throws once (a provider's 429)
  const a = world({ start: { registered: true }, pays: 5_100_000n });
  const quote = a.deps.quote;
  let n = 0;
  a.deps.quote = async (x) => {
    if (n++ === 1) throw new Error("Rhea quote refused (rpc): 429");
    return quote(x);
  };
  const aa = await run(a.deps);
  assert.ok(aa !== null && "result" in aa && aa.result.stage === "filled");
  // NT21 a read of W that throws is asked again
  const b = world();
  const read = b.deps.readWallet;
  let reads = 0;
  b.deps.readWallet = async (x) => {
    if (b.chain.exists && reads++ === 0) throw new Error("HTTP 503");
    return read(x);
  };
  const ba = await run(b.deps);
  assert.ok(ba !== null && "result" in ba && ba.result.stage === "filled");
  // in_flight, no_payout, upstream and no answer: the same body again, then on
  for (const code of ["in_flight", "no_payout", "upstream", "throw"]) {
    const c = world({ answers: { create: [code], swap: [code] } });
    const ca = await run(c.deps);
    assert.ok(ca !== null && "result" in ca && ca.result.stage === "filled", `${code}: ${JSON.stringify(ca)} ${JSON.stringify(c.log)}`);
    const bodies = helperBodies(c.ev);
    const swaps = bodies.filter((x) => methodOf(x) === "ft_transfer_call");
    assert.equal(swaps.length, 2, code);
    assert.deepEqual(swaps[0], swaps[1], `${code}: the same body`);
    assert.equal(c.ev.filter((e) => e[0] === "sign" && (e[1] as NearSwapCall[])[0]!.actions[0].FunctionCall.method_name === "ft_transfer_call").length, 1, `${code}: signed once`);
  }
  // relayer_low is not asked again
  const d = world({ answers: { swap: ["relayer_low"] } });
  sent(await run(d.deps));
  assert.equal(helperBodies(d.ev).filter((x) => methodOf(x) === "ft_transfer_call").length, 1);
  // bounded: NEAR_BUY_SENDS sends at most
  const e = world({ answers: { swap: Array(10).fill("in_flight") } });
  sent(await run(e.deps));
  assert.equal(helperBodies(e.ev).filter((x) => methodOf(x) === "ft_transfer_call").length, NEAR_BUY_SENDS);
});

test("P3-2 a quote read before W's state, or past the signer's window, is never signed: the pair is read again", async () => {
  const { deps, ev } = world({ start: { registered: true } });
  const quote = deps.quote;
  let n = 0;
  deps.quote = async (x) => {
    const q = await quote(x);
    // the swap's first pair: a quote from a block before W's read
    return n++ === 1 ? { ...q, height: 1 } : q;
  };
  const a = await run(deps);
  assert.ok(a !== null && "result" in a && a.result.stage === "filled");
  for (const s of signs(ev)) assert.ok((s[3] as { height: number }).height >= (s[4] as NearSwapWalletState).height);
  assert.equal(signs(ev).length, 1);
});

test("the swap's pair is of one moment at the first try: W's read and its quote 26 blocks apart when each is read on its own (the keyless pace's 12 Nov skew) never cost the buy one more read", async () => {
  const { deps, ev, log } = world({ start: { registered: true }, pays: 5_100_000n });
  const read = deps.readWallet;
  const quote = deps.quote;
  // read on their own, one after the other: the quote 26 blocks past W's read, past the signer's 10
  deps.quote = async (x) => {
    const q = await quote(x);
    return { ...q, height: q.height + 25 };
  };
  // the pair: W, the quote and the baseline at one final height (the kit's readNearSwapPair)
  let pairs = 0;
  deps.pair = async (a) => {
    pairs++;
    const state = await read({ wallet: a.wallet, side: a.side, token: a.token });
    const q = await quote({ side: a.side, token: a.token, amountIn: a.amountIn });
    const pair = { state, quote: { ...q, height: state.height } };
    return a.baseline === undefined ? pair : { ...pair, baseline: (await read({ wallet: a.wallet, side: "sell", token: a.token })).held };
  };
  const a = await run(deps);
  assert.ok(a !== null && "result" in a && a.result.stage === "filled", JSON.stringify([a, log], (_, v) => (typeof v === "bigint" ? String(v) : v)));
  assert.equal(pairs, 1, "the swap's round reads one pair");
  const [s] = signs(ev);
  assert.equal((s![3] as { height: number }).height, (s![4] as NearSwapWalletState).height, "signed from one block");
});

test("NT07 NT08 a quote of another amount or token is refused, nothing signed", async () => {
  for (const bad of [{ amountIn: AMOUNT + 1n }, { token: "other.near" }, { side: "sell" as const }, { network: "testnet" as const }]) {
    const { deps, ev } = world({ start: { exists: true, registered: true } });
    const quote = deps.quote;
    deps.quote = async (x) => ({ ...(await quote(x)), ...bad });
    sent(await run(deps));
    assert.equal(signs(ev).length, 0, JSON.stringify(Object.keys(bad)));
  }
});

test("NT10 a helper's ok answer with the wrong number of transactions is not_known, never a fill", async () => {
  const { deps } = world();
  const help = deps.helper;
  deps.helper = async (b) => {
    const a = await help(b);
    return methodOf(b) === "ft_transfer_call" && a.ok ? { ok: true, tx_hashes: [...a.tx_hashes, tx(999)] } : a;
  };
  sent(await run(deps));
});

test("NT23 a token with a buy fee: the floor is what reaches W after the token's own cut", async () => {
  const fee: NearTokenFee = { buyBps: 500, sellBps: 0, senderPays: false, scope: "all", exempt: [], unknown: false };
  const floor = nearSwapFloor(4_900_000n, SLIPPAGE);
  const cut = (floor * 9_500n) / 10_000n;
  // W receives the floor less 5%: filled
  const a = world({ fee, pays: cut });
  const aa = await run(a.deps);
  assert.ok(aa !== null && "result" in aa && aa.result.stage === "filled");
  // one unit below: not filled
  const b = world({ fee, pays: cut - 1n });
  sent(await run(b.deps));
});

test("the record's resume: each crash point goes on from where the chain is, never paying again", async () => {
  // payout landed, W not created: creates, registers, swaps
  const a = world({ begun: { txs: near(tx(1)) }, start: { usdc: AMOUNT } });
  const aa = await run(a.deps);
  assert.ok(aa !== null && "result" in aa && aa.result.stage === "filled");
  assert.deepEqual(helperBodies(a.ev).map(methodOf), ["create", "storage_deposit", "ft_transfer_call"]);
  // W created, not registered: no creation
  const b = world({ begun: { txs: near(tx(1)) }, start: { exists: true, usdc: AMOUNT } });
  await run(b.deps);
  assert.deepEqual(helperBodies(b.ev).map(methodOf), ["storage_deposit", "ft_transfer_call"]);
  // registered, not swapped
  const c = world({ begun: { txs: near(tx(1)) }, start: { exists: true, registered: true, usdc: AMOUNT } });
  await run(c.deps);
  assert.deepEqual(helperBodies(c.ev).map(methodOf), ["ft_transfer_call"]);
  // the swap left, not read: no signature, read until W holds the floor
  const floor = nearSwapFloor(4_900_000n, SLIPPAGE);
  const d = world({ begun: { txs: near(tx(1), tx(2)), swap: { floor, before: 0n } }, start: { exists: true, registered: true, usdc: 0n, token: floor } });
  const da = await run(d.deps);
  assert.ok(da !== null && "result" in da && da.result.stage === "filled");
  assert.equal(signs(d.ev).length, 0);
  assert.deepEqual(da.result.txs, near(tx(1), tx(2)));
  // the swap failed on chain, the USDC back on W: swapped again from a fresh pair
  const e = world({ begun: { txs: near(tx(1), tx(2)), swap: { floor, before: 0n } }, start: { exists: true, registered: true, usdc: AMOUNT } });
  const ea = await run(e.deps);
  assert.ok(ea !== null && "result" in ea && ea.result.stage === "filled");
  assert.deepEqual(helperBodies(e.ev).map(methodOf), ["ft_transfer_call"]);
  // in every case the payout was asked once, of the record's own note (the binding follows it)
  for (const w of [a, b, c, d, e]) assert.equal(names(w.ev).filter((x) => x === "payout").length, 1);
});

test("a swap that failed on chain leaves the USDC on W: answered sent, the record names it, never filled", async () => {
  const { deps, records } = world({ swapFails: true });
  sent(await run(deps));
  assert.equal(records.at(-1)!.code, "received_below_floor");
});

test("a registration that never reads back stops after the bounded reads: not_registered, no swap signed", async () => {
  const { deps, ev, log } = world({ neverRegisters: true });
  sent(await run(deps));
  const after = names(ev).slice(names(ev).lastIndexOf("helper") + 1);
  assert.equal(after.filter((x) => x === "read").length, NEAR_BUY_READ_TRIES);
  assert.equal(signs(ev).length, 1);
  assert.deepEqual(log.at(-1), ["register", "not_registered"]);
});

test("W holding less USDC than the buy's amount is not swapped: not_funded, nothing signed for the swap", async () => {
  const { deps, ev, log } = world({ begun: { txs: near(tx(1)) }, start: { exists: true, registered: true, usdc: AMOUNT - 1n } });
  sent(await run(deps));
  assert.equal(signs(ev).length, 0);
  assert.deepEqual(log.at(-1), ["swap", "not_funded"]);
});

test("a read that names another account ends the run read_failed at once, never read again", async () => {
  const { deps, ev, log } = world({ start: { exists: true } });
  deps.readWallet = async (a) => (ev.push(["read", { ...a }]), { account: "cd".repeat(32), height: 1, blockHash: "b", nonce: 1n, held: 0n, registered: false, storageMin: STORAGE_MIN, lostfound: 0n });
  sent(await run(deps));
  assert.equal(log.at(-1)![1], "read_failed");
  assert.equal(signs(ev).length, 0);
});

test("an ask outside the rules is refused before anything runs", () => {
  const { deps, ev } = world();
  const flow = nearBuyFlow(deps);
  for (const ask of [
    { token: TOKEN, amount: 0n, slippageBps: SLIPPAGE },
    { token: TOKEN, amount: AMOUNT, slippageBps: 0 },
    { token: TOKEN, amount: AMOUNT, slippageBps: 10_000 },
    { token: USDC, amount: AMOUNT, slippageBps: SLIPPAGE },
    { token: "", amount: AMOUNT, slippageBps: SLIPPAGE },
  ])
    assert.deepEqual(flow(ask, ctx), { error: "not_allowed" });
  assert.equal(ev.length, 0);
});

test("RN09 the rule refuses a slippage that is not a whole number of bps (RN06: an amount of 30 digits and 6 decimals is below 2^128, so that bound cannot be met)", () => {
  const base = { kind: "pool.buy", chain: "near", token: TOKEN, amount: "1.5" };
  assert.throws(() => checkNearBuyRequest({ ...base, slippage_bps: 1.5 }), NearTradeRefused);
  assert.deepEqual(checkNearBuyRequest({ ...base, slippage_bps: 2 }), { token: TOKEN, amount: 1_500_000n, slippageBps: 2 });
  // the largest amount the form takes, 10^30 - 1 and 6 decimals, is well below 2^128
  assert.ok(BigInt("9".repeat(36)) < 1n << 128n);
});

test("F4 a buy that ends below the floor with the token on W writes what W received (fill) to the record before it ends, its code kept", async () => {
  const pays = nearSwapFloor(4_900_000n, SLIPPAGE) - 1n;
  const { deps, records } = world({ pays });
  deps.decimals = async () => 18;
  sent(await run(deps));
  const filled = records.filter((r) => r.fill !== undefined);
  assert.deepEqual(filled.map((r) => [r.step, r.stage, r.fill]), [["receive", "sent", { out: pays.toString(), decimals: 18 }]]);
  assert.equal(records.at(-1)!.code, "received_below_floor");
  // nothing on W: no fill written
  const none = world({ swapFails: true });
  none.deps.decimals = async () => 18;
  sent(await run(none.deps));
  assert.ok(none.records.every((r) => r.fill === undefined));
});

test("F6 carry_failed for a round whose swap landed (its claim failed): never signed again, W read once a side, what W received decides", async () => {
  const { deps, ev, log } = world({ answers: { swap: ["carry_failed"] }, swapLandsAnyway: true });
  const a = await run(deps);
  assert.ok(a !== null && "result" in a && a.result.stage === "filled", JSON.stringify(a));
  assert.equal(helperBodies(ev).filter((b) => methodOf(b) === "ft_transfer_call").length, 1);
  assert.ok(log.some((l) => l[0] === "swap" && l[1] === "carry_failed, the token on W"));
  // after the answer, the first reads are W's two sides, with no wait between
  const afterSwap = names(ev).slice(names(ev).lastIndexOf("helper") + 1);
  assert.deepEqual(afterSwap.slice(0, 3), ["read", "read", "read"]);
  assert.ok(!afterSwap.slice(0, 2).includes("wait"));
});
