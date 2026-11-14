// A deposit's leftover at U_X is counted from the moment it is left (card one-balance-buys-on-every-chain; the owner's
// Robinhood deposit read 13 Nov 20:52Z on two RPCs: 0.003 ETH sent to U_X, one 0.002 rung went into the pool, U_X still
// holds 0.0009941 ETH, under one deposit's floor). Before: what U_X held was written as the op's `left` only at the
// follow's end, past the quote's deadline, so until then state.deposit_wallets named nothing and the balance read the
// 0.002 note alone ("Balance 0.002 / Deposited 0.003"). Now the follow writes what U_X holds each round once it shows
// in_pool (holds), 0 before any carry from U_X (so the money a carry turns into a note never counts twice), and
// depositWalletsOf counts an in_pool op's left whether or not it has ended.
import assert from "node:assert/strict";
import { test } from "node:test";
import { depositWalletsOf, followPoolQuote } from "../src/pool-deposit-follow.ts";
import { POOL_DEPOSIT_DESTINATION } from "../../wallet/src/deposit/quote.ts";
import { EVM_LADDER } from "../../wallet/src/pool/evm.ts";
import { ladderSplit } from "../../wallet/src/pool/ladder.ts";

// one deposit's gas on Robinhood as the owner's run spent it: 0.003 − 0.002 − 0.0009941 ETH
const GAS = 5_900_000_000_000n;
const FLOOR = EVM_LADDER.min + GAS;
const SENT = 3_000_000_000_000_000n;
const U = "0x314152946062315ad2fad8a54e28d74f15646268";
const PLAIN = { chain: "robinhood" as const, s: "7", i: 0, u: U, refund_id: "ab".repeat(32), address: U, deadline_ms: 1, origin: POOL_DEPOSIT_DESTINATION.robinhood, min_out: FLOOR.toString() };

function ux(start: bigint, pastAfter: number) {
  let bal = start;
  let rounds = 0;
  const deposits: bigint[] = [];
  const holds: bigint[] = [];
  const ac = new AbortController();
  const deps: Parameters<typeof followPoolQuote>[1] = {
    balances: async () => [bal, bal] as const,
    costs: async () => ({ floor: FLOOR, perRung: GAS, keep: 0n }),
    status: async () => {
      throw new Error("1Click asked");
    },
    ladder: EVM_LADDER,
    deposit: async (_f, amount) => {
      bal -= amount + BigInt(ladderSplit(EVM_LADDER, amount).notes.length) * GAS;
      deposits.push(amount);
      return { end: "filled", txs: [] };
    },
    open: async () => false,
    noted: async () => deposits.length > 0,
    past: async () => rounds >= pastAfter,
    stage: async () => {},
    holds: async (low) => void holds.push(low),
    sleep: async () => {
      if (++rounds > 6) ac.abort();
    },
    signal: ac.signal,
  };
  return { deps, deposits, holds, send: (v: bigint) => void (bal += v), bal: () => bal };
}

test("the owner's 0.003 ETH Robinhood deposit: one 0.002 note lands, and the 0.0009941 ETH left at U_X is written while the follow still reads on to the deadline", async () => {
  const x = ux(SENT, 1_000);
  await followPoolQuote(PLAIN, x.deps);
  assert.deepEqual(x.deposits, [2_000_000_000_000_000n]);
  assert.equal(x.bal(), 994_100_000_000_000n);
  assert.equal(x.holds[0], 0n, "0 written before the carry: the note it makes is the pool's");
  assert.equal(x.holds.at(-1), 994_100_000_000_000n, "what U_X holds after the carry, before the deadline");
});

test("depositWalletsOf counts an in_pool op's left before its end too; a carry's 0 counts nothing; an op not yet in_pool counts nothing", () => {
  const op = (stage: string, left: string | undefined, final?: true) => ({ kind: "pool_deposit", stage, txs: [], created_ms: 1, ...(final ? { final } : {}), follow: { ...PLAIN, ...(left === undefined ? {} : { left }) } });
  const list = (v: unknown) => depositWalletsOf([v], () => 18, () => "ETH");
  assert.deepEqual(list(op("in_pool", "994100000000000")), [{ chain: "robinhood", address: U, asset: "ETH", amount: "0.0009941" }]);
  assert.deepEqual(list(op("in_pool", "994100000000000", true)), [{ chain: "robinhood", address: U, asset: "ETH", amount: "0.0009941" }]);
  assert.deepEqual(list(op("in_pool", "0")), []);
  assert.deepEqual(list(op("in_transit", "994100000000000")), []);
});

test("a W's tail (meta w-tail/sol/<address>, the vault lead's record) is counted as a deposit wallet: only a whole record above 0", async () => {
  const { wTailWallets } = await import("../src/w-tails.ts");
  const rows = [
    { chain: "sol", address: "W1", l: "12", j: 0, amount: "4000000" },
    { chain: "sol", address: "W2", l: "12", j: 1, amount: "0" },
    { chain: "solana", address: "W5", l: "12", j: 0, amount: "5" },
    { chain: "near", address: "x", l: "1", j: 0, amount: "5" },
    { chain: "sol", address: "W3", l: "x", j: 0, amount: "5" },
    { chain: "sol", address: "W4", l: "1", j: -1, amount: "5" },
    { chain: "sol", address: "W6", l: "1", j: 0, amount: "0.5" },
    null,
  ];
  assert.deepEqual(wTailWallets(rows, () => 9, () => "SOL"), [{ chain: "solana", address: "W1", asset: "SOL", amount: "0.004" }]);
});

test("the page reads each W tail the rent back wrote from its own wallet store, and nothing else in meta, as a deposit wallet; main.ts adds them to state.deposit_wallets beside each U_X's", async () => {
  const { IDBFactory } = await import("fake-indexeddb");
  const { openWalletStore } = await import("@blindfill/wallet/store");
  const { owedRentBacks } = await import("../src/pool-sell.ts");
  const { storedTails, wTailWallets } = await import("../src/w-tails.ts");
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  try {
    const W = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    await owedRentBacks(async () => s).tail!({ chain: "sol", address: W, l: "3", j: 1, amount: "2345678" });
    await owedRentBacks(async () => s).put({ address: "other", l: "3", j: 2, mints: [], passes: 0 });
    assert.deepEqual(wTailWallets(await storedTails(s), () => 9, () => "SOL"), [{ chain: "solana", address: W, asset: "SOL", amount: "0.002345678" }]);
  } finally {
    s.close();
  }
  const main = (await import("node:fs")).readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /withDepositWallets\(p, \[\s*\.\.\.depositWalletsOf\(await pageOps\(\)[^\n]*\n(?:\s*\/\/[^\n]*\n)?\s*\.\.\.wTailWallets\(await pageTails\(\)/);
  assert.match(main, /async function pageTails\(\): Promise<unknown\[\]> \{\s*return storedTails\(await open\(\)\);/);
});

test("a short plain send (Base's \"Short deposit\": money at U_X under one deposit's floor, nothing landing) writes what U_X holds each round it shows short, so the balance counts it and the carry to Cash takes it (card leftovers-carry-to-cash)", async () => {
  const x = ux(400_000_000_000_000n, 1_000);
  const stages: string[] = [];
  await followPoolQuote(PLAIN, { ...x.deps, stage: async (s) => void stages.push(s) });
  assert.deepEqual(x.deposits, [], "no rung: under the floor");
  assert.ok(stages.includes("short"));
  assert.ok(x.holds.length > 0 && x.holds.every((h) => h === 400_000_000_000_000n), `holds ${x.holds}`);
});
