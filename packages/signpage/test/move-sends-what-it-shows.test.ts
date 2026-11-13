// Card move-sends-what-it-shows: pool.move.dry answers what the move can send. Its Max is what the plan the page runs
// sends (each note's largest part after its fees), an amount the plan cannot send gets the nearest amounts it can, and
// an amount whose move would not clear the destination pool's deposit floor gets the least that does, before anything
// moves; a move out of a pool is held to that dry, so none ends with its money parked in Cash. Red at 83af19e2d: the dry
// refused not_funded at the pool's balance and not_allowed at an amount its plan cannot send, with no number; a pool to
// Base dry read today's Cash (refused with none); and nothing held a pool to Base move to the Base pool's floor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { cashMover, poolMoveKinds, type CashMoverDeps } from "../src/cash-to-pool.ts";
import { poolToCash, type PoolToCashDeps } from "../src/pool-to-cash.ts";
import { checkPoolAmount, poolSendable, type PoolFunds } from "../src/withdraw/pool-form.ts";
import { kitLevel, resultFor } from "../src/kit-version.ts";

// two Solana notes, 0.03 and 0.01 SOL; the epoch fee and W's fee as pool-to-cash.test.ts has them
const FUNDS: PoolFunds = { notes: [{ id: "a", value: 30_000_000n }, { id: "b", value: 10_000_000n }], fee: 1_300_000n, wFee: 5_000n, minPart: 1_890_880n };
const SOL = { price: "8000000000", expo: -8 }; // 80 USD
const ETH = { price: "100000000000", expo: -8 }; // 1,000 USD
const ADDRESS = "a".repeat(64);
const DEPOSIT = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
const ctx = { id: "m", sha: "00", progress: () => {} };
const TO_CASH = [{ step: "pool_out", chain: "solana" }, { step: "intents", chain: "near" }, { step: "vault_in", chain: "near" }];
const TO_BASE = [...TO_CASH, { step: "vault_out", chain: "near" }, { step: "intents", chain: "base" }, { step: "pool_in", chain: "base" }];

function world(o: { cash?: bigint; floor?: bigint | null } = {}) {
  const runs: string[] = [];
  const quoted: string[] = [];
  const md: CashMoverDeps = {
    price: (c) => (c === "solana" ? SOL : ETH),
    rails: ["1click"],
    quote: async (_c, usdc, id) => (quoted.push(id), { address: ADDRESS, amountIn: usdc, minOut: 1n }),
    fee: async () => 50_000n, // 0.05 USDC, the vault withdraw's fee
    cash: async () => o.cash ?? 0n, // no Cash: a move out of a pool brings its own
    handoff: async () => ({ kind: "landed", tx: "NearTx" }),
    floor: async () => (o.floor === undefined ? 1_000_000_000_000_000n + 30_000_000_000_000n : o.floor), // 0.001 ETH and a deposit's gas
    landed: async () => false,
    now: () => 1_000,
  };
  const td: PoolToCashDeps = {
    price: () => SOL,
    funds: async () => FUNDS,
    quote: async (_c, _a, id) => (quoted.push(id), { address: DEPOSIT, minOut: 1_000_000n }),
    onChain: (_c, a) => a === DEPOSIT,
    withdraw: () => (_r, id) => void runs.push(id),
    op: async () => undefined,
    put: async () => {},
    now: () => 1_000,
    wait: () => new Promise((r) => setTimeout(r, 0)), // a turn of the loop, so a move that runs on cannot hold the test
    onward: { move: async () => ({ op: "on" }), fee: async () => 50_000n },
  };
  const mover = cashMover(md);
  const toCash = poolToCash(td);
  return { k: poolMoveKinds(() => mover, () => toCash), runs, quoted };
}

async function dry(k: ReturnType<typeof world>["k"], params: Record<string, string>): Promise<unknown> {
  const r = k["pool.move.dry"](params, ctx);
  if (!("running" in r)) return r;
  await r.after;
  return r.answer();
}

const SENDABLE = poolSendable(FUNDS);
const sol = (x: bigint) => {
  const t = x.toString().padStart(10, "0");
  const f = t.slice(-9).replace(/0+$/, "");
  return f ? `${t.slice(0, -9)}.${f}` : t.slice(0, -9);
};

test("Max: at the pool's balance the dry answers what the plan sends (each note's largest part after its fees), and that amount moves", async () => {
  const w = world();
  assert.ok(SENDABLE > 0n && SENDABLE < 40_000_000n, `the plan sends less than the notes hold: ${SENDABLE}`);
  const at = (await dry(w.k, { from: "solana", to: "near", amount: "0.04" })) as { result?: { max?: string; out?: string } };
  assert.deepEqual(at, { result: { max: sol(SENDABLE), steps: TO_CASH } }, "no out: nothing would move, and the most that can");
  const max = (await dry(w.k, { from: "solana", to: "near", amount: sol(SENDABLE) })) as { result: { out?: string; max?: string } };
  assert.equal(typeof max.result.out, "string", JSON.stringify(max));
  assert.equal(max.result.max, sol(SENDABLE), "a priced answer names the same Max");
  assert.ok(SIGNPAGE_RESULT_SCHEMAS["pool.move.dry"](at.result) && SIGNPAGE_RESULT_SCHEMAS["pool.move.dry"](max.result), "the kit reads both");
});

test("Try: an amount the plan cannot send exactly answers the nearest amounts it can, each one the plan sends", async () => {
  const w = world();
  // an amount the plan cannot send: between one note's largest part and the next amount a plan makes
  let x = 0n;
  for (let a = 1_000_000n; a < SENDABLE && x === 0n; a += 250_000n) {
    const c = checkPoolAmount("solana", sol(a), FUNDS);
    if (!c.ok && c.code === "unplannable") x = a;
  }
  assert.ok(x > 0n, "the notes leave an amount no plan sends");
  const a = (await dry(w.k, { from: "solana", to: "near", amount: sol(x) })) as { result: { max: string; below?: string; above?: string; out?: string } };
  assert.equal(a.result.out, undefined);
  assert.equal(a.result.max, sol(SENDABLE));
  const near = [a.result.below, a.result.above].filter((v): v is string => v !== undefined);
  assert.ok(near.length > 0, JSON.stringify(a));
  for (const v of near) assert.equal(checkPoolAmount("solana", v, FUNDS).ok, true, `${v} is sent exactly`);
});

test("Base: a pool to Base dry needs no Cash today, and an amount whose move would not bring the Base pool's floor answers the least that does", async () => {
  const w = world({ cash: 0n });
  // 0.03 SOL at 80 USD is 2.4 USDC less 3%, less the 0.05 withdraw fee and 3% again: about 0.0022 ETH at 1,000 USD, which
  // less the 0.001 ETH rung the quote keeps back clears the 0.00103 ETH floor
  const big = (await dry(w.k, { from: "solana", to: "base", amount: "0.03" })) as { result: { out?: string; max?: string; steps: unknown } };
  assert.equal(typeof big.result.out, "string", JSON.stringify(big));
  assert.deepEqual(big.result.steps, TO_BASE);
  // 0.01 SOL brings far less than 0.001 ETH: refused in the dry with the least amount that clears it
  const small = (await dry(w.k, { from: "solana", to: "base", amount: "0.008695" })) as { result: { out?: string; min?: string; max: string } };
  assert.equal(small.result.out, undefined, JSON.stringify(small));
  assert.ok(small.result.min !== undefined && checkPoolAmount("solana", small.result.min, FUNDS).ok, JSON.stringify(small));
  const atMin = (await dry(w.k, { from: "solana", to: "base", amount: small.result.min! })) as { result: { out?: string } };
  assert.equal(typeof atMin.result.out, "string", "the least amount named moves");
  const under = BigInt(Math.round(Number(small.result.min) * 1e9)) - 1n;
  const below = (await dry(w.k, { from: "solana", to: "base", amount: sol(under) })) as { result: { out?: string } };
  assert.equal(below.result.out, undefined, "one lamport under it does not");
});

test("Base: a move under the floor is refused before anything moves, so no money is left in Cash", async () => {
  const w = world({ cash: 0n });
  const r = w.k["pool.move"]({ from: "solana", to: "base", amount: "0.008695" }, ctx);
  assert.ok("running" in r);
  await Promise.race([r.after, new Promise((res) => setTimeout(res, 500))]);
  assert.deepEqual(w.runs, [], "no pool withdraw run");
  assert.deepEqual(w.quoted, [], "no quote asked");
  assert.deepEqual(r.answer(), { error: "below_min" });
});

test("Base: a floor that cannot be read now answers down, never a move it cannot check", async () => {
  const w = world({ floor: null });
  assert.deepEqual(await dry(w.k, { from: "solana", to: "base", amount: "0.03" }), { error: "down" });
});

test("Cash to Base: Max is the largest withdrawal less its fee, and an amount under the Base pool's floor answers the least that clears it", async () => {
  const w = world({ cash: 10_000_000n }); // a 10 USDC note
  const over = (await dry(w.k, { from: "near", to: "base", amount: "20" })) as { result: { max: string; out?: string } };
  assert.deepEqual(over, { result: { max: "9.95", steps: [{ step: "vault_out", chain: "near" }, { step: "intents", chain: "base" }, { step: "pool_in", chain: "base" }] } });
  const small = (await dry(w.k, { from: "near", to: "base", amount: "1" })) as { result: { min?: string; out?: string } };
  assert.equal(small.result.out, undefined);
  const min = small.result.min!;
  const ok = (await dry(w.k, { from: "near", to: "base", amount: min })) as { result: { out?: string } };
  assert.equal(typeof ok.result.out, "string", `${min} moves`);
});

test("kit-v1.15 apps: the priced answer with no max, so their schema still reads it", () => {
  const priced = { out: "1.5", fee: "0.001305", steps: TO_CASH, max: "0.03739" };
  assert.equal(kitLevel("1.15"), "1.15");
  assert.deepEqual(resultFor("1.15", "pool.move.dry", priced), { out: "1.5", fee: "0.001305", steps: TO_CASH });
  assert.deepEqual(resultFor("current", "pool.move.dry", priced), priced);
});
