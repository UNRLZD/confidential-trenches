// The calls W signs for a Rhea classic buy or sell (src/trade/near/swap.ts) and the checks that hold them (N1-N4, N7).
// The quotes are real: rheaQuote replayed on recorded mainnet answers of both providers (fixtures/near-rhea-quotes.json).
// Each bad shape is a change to the good calls, refused with its code; test/near-swap-mutants.mjs removes each check
// and runs the test named for it, which must then fail.
//   node --test test/near-swap.test.ts      (from packages/kit)
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rheaQuote, type RheaQuote } from "../src/near/rhea.ts";
import { NEAR_SWAP_GAS, nearSwapCalls, nearSwapCheck, nearSwapFloor, nearSwapMsg, NearSwapRefused, type NearSwapCall, type NearSwapRefusalCode, type NearSwapRequest } from "../src/trade/near/swap.ts";

const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const EX = "v2.ref-finance.near";
const RHEA = "token.rhealab.near";
const W = "c0ffee".padEnd(64, "0");
const OTHER = "bad0".padEnd(64, "0");
const MIN = 1_250_000_000_000_000_000_000n;
const { runs } = JSON.parse(readFileSync(new URL("./fixtures/near-rhea-quotes.json", import.meta.url), "utf8"));

async function quoteOf(name: string): Promise<RheaQuote> {
  const r = runs.find((x: { name: string }) => x.name === name);
  const rpcs = [FAST, DRPC].map((url) => ({
    name: url,
    async query(params: Record<string, unknown>) {
      const hit = r.log.find((l: { url: string; params: unknown }) => l.url === url && JSON.stringify(l.params) === JSON.stringify(params));
      if (!hit) throw new Error("not recorded");
      return hit.answer;
    },
  })) as unknown as Parameters<typeof rheaQuote>[0]["rpcs"];
  return rheaQuote({ network: "mainnet", rpcs, side: r.side, token: r.token, amountIn: BigInt(r.amountIn), pools: r.pools });
}
const reqOf = (q: RheaQuote, slippageBps = 100): NearSwapRequest => ({ network: "mainnet", side: q.side, token: q.token, amountIn: q.amountIn, wallet: W, slippageBps });
const clone = (c: readonly NearSwapCall[]) => JSON.parse(JSON.stringify(c)) as NearSwapCall[];
function refused(f: () => unknown, code: NearSwapRefusalCode, re?: RegExp) {
  assert.throws(f, (e: unknown) => {
    assert.ok(e instanceof NearSwapRefused, String(e));
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test("S1 a buy through wNEAR in two rounds: W's registration on the token alone; once it reads back, the swap and the claim of W's lost-found", async () => {
  const q = await quoteOf("buy RHEA through wNEAR");
  const reg = nearSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: false, storageMin: MIN, lostfound: 5n }, reqOf(q));
  assert.deepEqual(reg, [
    { sender_id: W, receiver_id: RHEA, actions: [{ FunctionCall: { method_name: "storage_deposit", args: { account_id: W, registration_only: true }, gas: 10e12, deposit: String(MIN) } }] },
  ]);
  const calls = nearSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: true, storageMin: MIN, lostfound: 5n }, reqOf(q));
  const floor = (q.venueOut * 9_900n) / 10_000n;
  assert.deepEqual(calls, [
    {
      sender_id: W,
      receiver_id: USDC,
      actions: [{ FunctionCall: { method_name: "ft_transfer_call", args: { receiver_id: EX, amount: "5000000", msg: `{"force":0,"actions":[{"pool_id":4512,"token_in":"${USDC}","token_out":"wrap.near","min_amount_out":"0"},{"pool_id":6458,"token_in":"wrap.near","token_out":"${RHEA}","min_amount_out":"${floor}"}],"skip_degen_price_sync":true,"skip_unwrap_near":true}` }, gas: 150e12, deposit: "1" } }],
    },
    { sender_id: W, receiver_id: EX, actions: [{ FunctionCall: { method_name: "claim_lostfound", args: { token_id: RHEA }, gas: 100e12, deposit: "1" } }] },
  ]);
  assert.ok(Object.isFrozen(calls) && Object.isFrozen(calls[0]!.actions[0].FunctionCall.args));
  // registered and nothing lost: the swap alone
  assert.equal(nearSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: true, storageMin: MIN, lostfound: 0n }, reqOf(q)).length, 1);
});

test("S2 a sell: the token into the exchange, USDC back to W", async () => {
  const q = await quoteOf("sell RHEA through wNEAR");
  const [swap] = nearSwapCalls({ quote: q, wallet: W, slippageBps: 50, registered: true, storageMin: MIN, lostfound: 0n }, reqOf(q, 50));
  assert.equal(swap!.receiver_id, RHEA);
  const m = JSON.parse(swap!.actions[0].FunctionCall.args.msg as string);
  assert.deepEqual(m.actions.map((a: { token_out: string }) => a.token_out), ["wrap.near", USDC]);
  assert.equal(m.actions[1].min_amount_out, String((q.venueOut * 9_950n) / 10_000n));
});

test("S3 the floor: from the user's slippage on what the exchange pays, never 0, 1 to 9999 bps", () => {
  assert.equal(nearSwapFloor(10_000n, 100), 9_900n);
  assert.equal(nearSwapFloor(3n, 1), 2n);
  for (const s of [0, -1, 10_000, 1.5, Number.NaN]) refused(() => nearSwapFloor(10_000n, s), "input");
  refused(() => nearSwapFloor(1n, 1), "input", /0/);
});

async function good() {
  const q = await quoteOf("buy RHEA through wNEAR");
  // W registered: the swap, then the claim; W not: its registration alone
  const calls = nearSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: true, storageMin: MIN, lostfound: 5n }, reqOf(q));
  const reg = nearSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: false, storageMin: MIN, lostfound: 5n }, reqOf(q));
  const check = (c: NearSwapCall[], r: NearSwapRequest = reqOf(q), qq: RheaQuote = q) => nearSwapCheck(c, r, { quote: qq, storageMin: MIN, registered: true });
  const checkReg = (c: NearSwapCall[], storageMin = MIN) => nearSwapCheck(c, reqOf(q), { quote: q, storageMin, registered: false });
  const swapArgs = (c: NearSwapCall[]) => c[0]!.actions[0].FunctionCall.args;
  const msgOf = (c: NearSwapCall[]) => JSON.parse(swapArgs(c).msg as string);
  const withMsg = (m: unknown) => {
    const c = clone(calls);
    swapArgs(c).msg = JSON.stringify(m);
    return c;
  };
  return { q, calls, reg, check, checkReg, swapArgs, msgOf, withMsg };
}

test("N1 the request: another signer, another amount, a quote of another token or side refuses", async () => {
  const { q, calls, check, swapArgs } = await good();
  check(clone(calls));
  const signer = clone(calls);
  signer[0]!.sender_id = OTHER;
  const g = await good();
  refused(() => g.checkReg(g.reg.map((c) => ({ ...c, sender_id: OTHER }))), "N1", /another account/);
  refused(() => check(signer), "N1", /another account/);
  const amount = clone(calls);
  swapArgs(amount).amount = "5000001";
  refused(() => check(amount), "N1", /amount/);
  refused(() => check(clone(calls), { ...reqOf(q), amountIn: 4_000_000n }), "N1");
  refused(() => check(clone(calls), { ...reqOf(q), token: "other.near" }), "N1");
  refused(() => check(clone(calls), { ...reqOf(q), side: "sell" }), "N1");
  refused(() => check(clone(calls), { ...reqOf(q), wallet: "alice.near" }), "N1");
});

test("N2 the receivers: a call to any other contract, or the swap into another account than the exchange, refuses", async () => {
  const { calls, check, swapArgs } = await good();
  const other = clone(calls);
  other[0]!.receiver_id = "evil.near";
  refused(() => check(other), "N2", /evil\.near/);
  const into = clone(calls);
  swapArgs(into).receiver_id = "evil.near";
  refused(() => check(into), "N2", /exchange only/);
});

test("N3 methods and deposits: more than the minimum, another account's registration, 2 yocto, another method, two swaps, out of order", async () => {
  const { q, calls, reg, check, checkReg } = await good();
  checkReg(clone(reg));
  const big = clone(reg);
  big[0]!.actions[0].FunctionCall.deposit = String(MIN + 1n);
  refused(() => checkReg(big), "N3", /minimum/);
  // a token whose minimum reads over 0.0125 N: refused even at its own minimum, just over the cap and far over it
  for (const min of [12_500_000_000_000_000_000_001n, 12_600_000_000_000_000_000_000n, 990_000_000_000_000_000_000_000n, 10n ** 24n]) {
    const at = clone(reg);
    at[0]!.actions[0].FunctionCall.deposit = String(min);
    refused(() => checkReg(at, min), "N3", /minimum/);
  }
  const atCap = clone(reg);
  atCap[0]!.actions[0].FunctionCall.deposit = "12500000000000000000000";
  checkReg(atCap, 12_500_000_000_000_000_000_000n);
  const forOther = clone(reg);
  forOther[0]!.actions[0].FunctionCall.args = { account_id: OTHER, registration_only: true };
  refused(() => checkReg(forOther), "N3", /W's own/);
  const notOnly = clone(reg);
  notOnly[0]!.actions[0].FunctionCall.args = { account_id: W, registration_only: false };
  refused(() => checkReg(notOnly), "N3", /W's own/);
  const regIn = clone(reg);
  regIn[0]!.receiver_id = USDC;
  refused(() => checkReg(regIn), "N3", /another token/);
  const yocto = clone(calls);
  yocto[0]!.actions[0].FunctionCall.deposit = "2";
  refused(() => check(yocto), "N3", /1 yocto/);
  const claimYocto = clone(calls);
  claimYocto[1]!.actions[0].FunctionCall.deposit = "0";
  refused(() => check(claimYocto), "N3", /1 yocto/);
  const transfer = clone(calls);
  transfer[1] = { sender_id: W, receiver_id: USDC, actions: [{ FunctionCall: { method_name: "ft_transfer" as "claim_lostfound", args: { receiver_id: OTHER, amount: "1" }, gas: 100e12, deposit: "1" } }] };
  refused(() => check(transfer), "N3", /not allowed/);
  // two swaps in three calls
  const two = clone(calls);
  two.splice(1, 0, clone(calls)[0]!);
  assert.equal(two.length, 3);
  refused(() => check(two), "N3", /not allowed here/);
  const swapped = clone(calls);
  [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
  refused(() => check(swapped), "N3", /not allowed here/);
  const claimOther = clone(calls);
  claimOther[1]!.actions[0].FunctionCall.args = { token_id: USDC };
  refused(() => check(claimOther), "N3", /output token/);
  const twoActions = clone(calls);
  (twoActions[0]!.actions as unknown[]).push(twoActions[0]!.actions[0]);
  refused(() => check(twoActions), "N3", /one action/);
  const none = clone(calls).slice(1);
  refused(() => check(none), "N3", /exactly one swap/);
  // the registration's own round: no swap or claim beside it, whoever orders the landing; none once W is registered
  refused(() => checkReg([...clone(reg), ...clone(calls)]), "N3", /before W's registration/);
  refused(() => checkReg([...clone(reg), clone(calls)[0]!]), "N3", /a swap before W's registration/);
  refused(() => checkReg([clone(calls)[0]!]), "N3", /a swap before W's registration/);
  refused(() => checkReg([...clone(reg), clone(calls)[1]!]), "N3", /a claim before W's registration/);
  refused(() => checkReg(clone(calls).slice(1)), "N3", /a claim before W's registration/);
  refused(() => check([...clone(reg), ...clone(calls)]), "N3", /registered already/);
  refused(() => nearSwapCheck(clone(reg), reqOf(q), { quote: q, storageMin: MIN, registered: "no" as unknown as boolean }), "input");
});

test("N4 the msg read back: a recipient, a referrer, a floor of 0, an extra hop, an unlisted token, amount_in, other bytes", async () => {
  const { calls, check, msgOf, withMsg } = await good();
  const m = msgOf(calls);
  refused(() => check(withMsg({ ...m, swap_out_recipient: OTHER })), "N4", /keys/);
  refused(() => check(withMsg({ ...m, referral_id: "ref.near" })), "N4", /keys/);
  refused(() => check(withMsg({ ...m, client_echo: "x" })), "N4", /keys/);
  refused(() => check(withMsg({ ...m, skip_unwrap_near: false })), "N4");
  const zero = structuredClone(m);
  zero.actions[1].min_amount_out = "0";
  refused(() => check(withMsg(zero)), "N4", /minimum/);
  const lower = structuredClone(m);
  lower.actions[1].min_amount_out = String(BigInt(lower.actions[1].min_amount_out) - 1n);
  refused(() => check(withMsg(lower)), "N4", /minimum/);
  const mid = structuredClone(m);
  mid.actions[0].min_amount_out = "1";
  refused(() => check(withMsg(mid)), "N4", /minimum/);
  const extra = structuredClone(m);
  extra.actions.push({ pool_id: 79, token_in: RHEA, token_out: "wrap.near", min_amount_out: "0" });
  refused(() => check(withMsg(extra)), "N4", /hops/);
  const pool = structuredClone(m);
  pool.actions[1].pool_id = 6459;
  refused(() => check(withMsg(pool)), "N4", /hop/);
  const unlisted = structuredClone(m);
  unlisted.actions[0].token_out = "evil.near";
  refused(() => check(withMsg(unlisted)), "N4");
  const amountIn = structuredClone(m);
  amountIn.actions[0].amount_in = "5000000";
  refused(() => check(withMsg(amountIn)), "N4", /keys/);
  const amountOut = structuredClone(m);
  amountOut.actions[1].amount_out = "0";
  refused(() => check(withMsg(amountOut)), "N4", /keys/);
  // the same JSON in other bytes (spaces) is not what was built
  const spaced = clone(calls);
  spaced[0]!.actions[0].FunctionCall.args.msg = JSON.stringify(m, null, 1);
  refused(() => check(spaced), "N4", /bytes/);
  const notJson = clone(calls);
  notJson[0]!.actions[0].FunctionCall.args.msg = "{";
  refused(() => check(notJson), "N4", /JSON/);
});

test("N4 the msg in the order the exchange runs it: the hops reversed, or a hop that does not spend the one before it", async () => {
  const { calls, check, msgOf, withMsg } = await good();
  const m = msgOf(calls);
  const reversed = structuredClone(m);
  reversed.actions.reverse();
  refused(() => check(withMsg(reversed)), "N4");
  assert.equal(nearSwapMsg((await good()).q, 1n).includes('"min_amount_out":"1"'), true);
});

test("N7 the gas: each call's exactly", async () => {
  const { calls, reg, check, checkReg } = await good();
  for (const d of [1, -1, -1e12]) {
    for (const i of [0, 1]) {
      const c = clone(calls);
      c[i]!.actions[0].FunctionCall.gas += d;
      refused(() => check(c), "N7");
    }
    const r = clone(reg);
    r[0]!.actions[0].FunctionCall.gas += d;
    refused(() => checkReg(r), "N7");
  }
  assert.deepEqual(NEAR_SWAP_GAS, { storage_deposit: 10e12, ft_transfer_call: 150e12, claim_lostfound: 100e12 });
});

test("S4 the builder refuses W that is not a 64-hex implicit id, or reads that are not W's", async () => {
  const { q } = await good();
  refused(() => nearSwapCalls({ quote: q, wallet: "alice.near", slippageBps: 100, registered: true, storageMin: MIN, lostfound: 0n }, reqOf(q)), "input");
  refused(() => nearSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: true, storageMin: MIN, lostfound: -1n }, reqOf(q)), "input");
  // a request that is not the quote's refuses before anything is returned
  refused(() => nearSwapCalls({ quote: q, wallet: W, slippageBps: 100, registered: true, storageMin: MIN, lostfound: 0n }, { ...reqOf(q), amountIn: 1n }), "N1");
});

test("S5 a token whose own fee comes off what W receives: the floor is on what the exchange pays out (venueOut), never on what W gets", async () => {
  const q = await quoteOf("buy RHEA through wNEAR");
  const fee: RheaQuote = { ...q, amountOut: (q.venueOut * 9_500n) / 10_000n };
  const [swap] = nearSwapCalls({ quote: fee, wallet: W, slippageBps: 100, registered: true, storageMin: MIN, lostfound: 0n }, reqOf(fee));
  const m = JSON.parse(swap!.actions[0].FunctionCall.args.msg as string);
  assert.equal(m.actions[1].min_amount_out, String((q.venueOut * 9_900n) / 10_000n));
  assert.notEqual(m.actions[1].min_amount_out, String((fee.amountOut * 9_900n) / 10_000n));
  // a msg whose floor is taken on amountOut is not the one built: refused
  const low = JSON.parse(JSON.stringify([swap])) as NearSwapCall[];
  m.actions[1].min_amount_out = String((fee.amountOut * 9_900n) / 10_000n);
  low[0]!.actions[0].FunctionCall.args.msg = JSON.stringify(m);
  refused(() => nearSwapCheck(low, reqOf(fee), { quote: fee, storageMin: MIN, registered: true }), "N4", /minimum/);
});
