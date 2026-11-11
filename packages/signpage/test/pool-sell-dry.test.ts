// Card app-sell-shows-what-you-receive: pool.sell.dry (src/pool-sell-dry.ts), the sell box's preview. Its out is the
// quote the sale signs on, on the same reads (pool-sell.ts poolSellReference, the one reference read in pool-sell.ts),
// priced as the sale's own rule prices it (poolSellPays: solanaSellReserve, and a full sale's sweep), so at the quote's
// price it is never above what the sale pays into the user's notes; it reads the
// holding from the positions pass, asks the providers the reference's reads and the Ws' lamports only (never a send, a
// simulation, a blockhash or a fee), writes nothing (its deps hold no store), and waits while a trade's reads hold the
// providers. The venue's answers are the kit's recorded reads (packages/kit/test/fixtures/solana-pool-buy.json).
//   node --test test/pool-sell-dry.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readSolanaReference } from "../../kit/src/trade/solana/pool.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { fx, providers, rent as RENT } from "../../kit/test/solana-pool-buy-fx.ts";
import { solanaPoolBuySellNeed, solanaPoolSellNeed, solanaRentMin, solanaSellFloor, SOLANA_POOL_PAGE_ENTRIES } from "../../kit/src/trade/solana/pool-buy.ts";
import { SOLANA_POOL_PAGE_ENTRY, SOLANA_POOL_PAGE_HEADER } from "../../kit/src/trade/solana/pool-deposit.ts";
import { solanaPacedRpc, solanaTimedRpc } from "../../kit/src/trade/solana/send.ts";
import { SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM, solanaVolumeAccumulator } from "../../kit/src/checks/solana/checks.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { tokenDecimalsKept } from "../src/pool-kinds.ts";
import { liveRuns, POOL_SELL_DRY_ANSWER_MS, POOL_SELL_DRY_CALLS, POOL_SELL_DRY_KEEP_MS, POOL_SELL_DRY_WINDOW_MS, poolSellDry, poolSellDryKind, poolSellPays, type DryWallet, type PoolSellDryDeps } from "../src/pool-sell-dry.ts";
import { solanaSellReserve } from "../src/pool-sell.ts";
import type { Position } from "../src/positions.ts";
import { poolUnits, SOLANA_POOL_MIN_DEPOSIT, solanaDepositRents, solanaSellAfterFull, solanaSweepFloor, solanaSweepKeep } from "../src/rules/pool.ts";
import { solanaPoolNoteFloor } from "../../kit/src/trade/solana/pool-deposit.ts";
import { enableTimers, resetTimers } from "./mock-timers.ts";

const MINT = fx.pump.mint as string;
const SWAP_MINT = fx.pumpswap.mint as string;
/** 4,000,000 tokens at 6 decimals over every W: the recorded curve gives about 0.11 SOL for them. */
const HELD = 4_000_000_000_000n;
/** W's lamports as both RPCs read them: pool-sell.test.ts's ENOUGH (a reserve of 0 on a partial sale). */
const ENOUGH = 1_000_000_000n;
/** Two sale wallets (any valid addresses: their volume accounts are derived from them). */
const W1 = "So11111111111111111111111111111111111111112";
const W2 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** The page's pool program, and its pool account at `sizes` (the layout pool-sell.ts sizesOf reads). */
const PROGRAM = "BPFLoaderUpgradeab1e11111111111111111111111";
const POOL = solanaPoolOf(PROGRAM).pool;
const poolBytes = (state: number, label: number): string => {
  const d = new Uint8Array(2179);
  d.set(new TextEncoder().encode("bfpool01"), 0);
  const v = new DataView(d.buffer);
  v.setBigUint64(49, BigInt(state), true);
  v.setBigUint64(49 + 1065, BigInt(label), true);
  return Buffer.from(d).toString("base64");
};
/** The recorded pool's trees, mid-page: one entry's growth each. */
const SIZES = [100, 100] as const;
const pos = (token = MINT, amount = "4000000", decimals: number | null = 6, wallets = [W1]): Position => ({ chain: "solana", token, amount, cost: "0", wallets, ...(decimals === null ? {} : { decimals }) });
const share = (token: string, share_bps: number) => ({ chain: "solana", token, share_bps, slippage_bps: 1000 });

/** The recorded pair, every call logged; the mint's getAccountInfo answered as both providers answered it; the Ws'
 *  call: their lamports from `lamports` (an address not in it: no account), no volume accounts, the pool at `sizes`. */
function pair(v: "pump" | "pumpswap" = "pump", log: string[] = [], lamports: Record<string, bigint> = { [W1]: ENOUGH, [W2]: ENOUGH }, sizes: readonly [number, number] | null = SIZES): readonly [SolanaRpc, SolanaRpc] {
  const mintRead = (Object.entries(fx[v].reads[0]).find(([k]) => JSON.parse(k)[0] === fx[v].mint)![1] as { context: unknown; value: unknown[] });
  return providers(v).map((rpc) => (async (method: string, params: readonly unknown[]) => {
    log.push(method);
    if (method === "getAccountInfo") return { context: mintRead.context, value: mintRead.value[0] };
    const list = params[0] as string[];
    if (list.includes(W1) || list.includes(W2)) return { context: { slot: 1 }, value: list.map((a) => (a === POOL ? (sizes === null ? null : { lamports: 1, owner: PROGRAM, data: [poolBytes(...sizes), "base64"] }) : lamports[a] === undefined || ![W1, W2].includes(a) ? null : { lamports: Number(lamports[a]), owner: "11111111111111111111111111111111", data: ["", "base64"] })) };
    return rpc(method, params);
  }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
}
const deps = (o: Partial<PoolSellDryDeps> & { log?: string[]; v?: "pump" | "pumpswap" } = {}): PoolSellDryDeps => ({
  pinned: () => true,
  rpcs: () => pair(o.v, o.log),
  positions: () => [pos(), pos(SWAP_MINT)],
  pin: () => ({ program: PROGRAM }),
  rent: () => RENT,
  decimals: tokenDecimalsKept(),
  trading: () => false,
  ...o,
});
/** What the sale's own read gives for `units`: the venue in the reference that gives the most (pool-sell.ts sellRun). */
const saleOut = async (v: "pump" | "pumpswap", token: string, units: bigint): Promise<{ e: bigint; cashback: boolean | undefined }> => {
  const ref = (await readSolanaReference(providers(v), { side: "sell", token, amount: units }))!;
  const best = ref.pools.filter((p) => p.venue === "pump-curve" || p.venue === "pumpswap").sort((x, y) => (x.expectedOut > y.expectedOut ? -1 : 1))[0]!;
  return { e: best.expectedOut, cashback: best.cashback };
};

test("the preview's out is the sale's own quote for the units pool.sell would sell, on both recorded venues, for a share and a typed amount", async () => {
  for (const [v, token] of [["pump", MINT], ["pumpswap", SWAP_MINT]] as const) {
    for (const [params, units] of [[share(token, 10_000), HELD], [share(token, 5_000), HELD / 2n], [share(token, 2_500), HELD / 4n], [{ chain: "solana", token, amount: "1000000", slippage_bps: 300 }, 1_000_000_000_000n]] as const) {
      const a = await poolSellDry(deps({ v }), params);
      assert.ok("result" in a, `${v} ${JSON.stringify(params)}: ${JSON.stringify(a)}`);
      const { e, cashback } = await saleOut(v, token, units);
      assert.equal(cashback, false, "the recorded coins are plain: the reference read the flag");
      const pays = poolSellPays(RENT, v === "pump" ? "pump-curve" : "pumpswap", [{ lamports: ENOUGH, claim: [false, false] }], units === HELD, e, solanaSellFloor(e, params.slippage_bps), cashback, { stateSize: SIZES[0], labelSize: SIZES[1] });
      assert.ok(!("refused" in pays));
      // a partial sale from a W that holds ENOUGH keeps nothing out of the note; a full one puts W's surplus in it too
      if (units === HELD) assert.ok(pays.out > e, `${v} full: W's surplus and its sweep go in`);
      else assert.equal(pays.out, e, `${v} partial: the expected out`);
      assert.equal(a.result.out, poolUnits(pays.out, 9), `${v} ${JSON.stringify(params)}`);
      assert.equal(a.result.min_out, poolUnits(pays.minOut, 9), "the same at the floor the sale signs");
      assert.equal(a.result.network, "0.000005", "one signature, no priority fee");
      assert.equal(a.result.fee_bps, 0, "no platform fee on a Solana pool sale");
      assert.equal(SIGNPAGE_RESULT_SCHEMAS["pool.sell.dry"](a.result), true, "the kit's client takes it");
    }
  }
});

test("one code path: every sale reads its quote through poolSellReference, the one reference read in pool-sell.ts", () => {
  const src = readFileSync(new URL("../src/pool-sell.ts", import.meta.url), "utf8");
  assert.equal(src.match(/pageReference\(/g)?.length, 1, "pageReference is called once, inside poolSellReference");
  // sellRun asks it beside its other first-round reads (card pool-sell-legs-side-by-side)
  assert.match(src, /: poolSellReference\(rpcs, token, amount\),\n/, "sellRun quotes through it");
  assert.match(src, /const units = poolSellUnits\(total, ask\);/, "planPoolSell's units are poolSellUnits");
  const dry = readFileSync(new URL("../src/pool-sell-dry.ts", import.meta.url), "utf8");
  for (const word of ["readSolanaReference(", "pageReference(", "expectedOut *", "solanaPoolSellMinOut", "seed64", "notes(", "ops(", "sendTransaction", "simulate"]) assert.equal(dry.includes(word), false, `the preview has no ${word}`);
});

test("a preview asks the providers three getMultipleAccounts each: the reference's two and the Ws' (lamports, volume accounts, the pool's sizes); no send, no simulation, no blockhash, no fee", async () => {
  const log: string[] = [];
  const a = await poolSellDry(deps({ log }), share(MINT, 5_000));
  assert.ok("result" in a);
  assert.deepEqual([...new Set(log)], ["getMultipleAccounts"]);
  assert.equal(log.length, 6);
  // the page holds no Rent sysvar yet: one more read on each, the Rent sysvar's
  const cold: string[] = [];
  const rentAnswer = fx.rent.answers as { owner: string; data: string }[];
  const withRent = pair("pump", cold).map((rpc, i) => (async (m: string, p: readonly unknown[]) =>
    m === "getAccountInfo" && (p[0] as string).startsWith("SysvarRent") ? (cold.push("rent"), { context: { slot: 1 }, value: { owner: rentAnswer[i]!.owner, data: [rentAnswer[i]!.data, "base64"], lamports: 1, executable: false, rentEpoch: 0 } }) : rpc(m, p)) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
  const b = await poolSellDry(deps({ rpcs: () => withRent, rent: () => null }), share(MINT, 5_000));
  assert.ok("result" in b, JSON.stringify(b));
  assert.equal(cold.filter((m) => m === "rent").length, 2);
});

// What a sale pays into the user's notes, by the sale's own rule (pool-sell.ts sellRun: solanaSellReserve, and on a full
// sale the sweep after it, rules/pool.ts solanaSellAfterFull), at every value the chain can give the inputs the preview
// does not read: the cashback accounts made or there, the pages topped up past their rent, the coin's flag known or not.
const none = [null, null] as const;
const SIG = 5_000n;
const heldAt = (size: number, topUp: bigint): readonly [bigint | null, bigint | null] => {
  const k = size % SOLANA_POOL_PAGE_ENTRIES;
  if (k === 0) return none;
  const h = solanaRentMin(RENT, SOLANA_POOL_PAGE_HEADER + k * SOLANA_POOL_PAGE_ENTRY) + topUp;
  return [h, h];
};
const rentsAt = (st: number, lb: number, topUp: bigint) => solanaDepositRents(RENT, { stateSize: st, labelSize: lb }, { mark: none, state: heldAt(st, topUp), label: heldAt(lb, topUp) }, true);
/** A full sale's pay-in at the quote's price `e`: its note, and on the sweep's path the sweep's note (W's keep, the token
 *  account's rent back, less the teardown's and the sweep's fees, the sweep's deposit rents and the owed claims' keep). */
function fullLands(o: { made: bigint; owed: number; lamports: bigint; st: number; lb: number; topUp: bigint; e: bigint; minOut: bigint }): bigint | null {
  const r0 = solanaRentMin(RENT, 0);
  const floor = solanaSweepFloor(RENT) > SOLANA_POOL_MIN_DEPOSIT ? solanaSweepFloor(RENT) : SOLANA_POOL_MIN_DEPOSIT;
  const after = solanaSellAfterFull(RENT, o.owed);
  const p = { fee: SIG, made: o.made, rents: rentsAt(o.st, o.lb, o.topUp), after, lamports: o.lamports, minOut: o.minOut, keeps: false, noteFloor: solanaPoolNoteFloor(RENT) };
  const r = solanaSellReserve({ ...p, swept: after - r0, base: r0, floor });
  if ("refused" in r) return null;
  const own = solanaSellReserve(p);
  if ("refused" in own || own.value < floor) return r.value;
  const sweep = after + solanaRentMin(RENT, 165) - 2n * SIG - rentsAt(o.st + 1, o.lb + 1, o.topUp) - solanaSweepKeep(RENT, o.owed);
  return o.e - r.reserve + (sweep > 0n ? sweep : 0n);
}
const CLAIMS: readonly (readonly [boolean, boolean])[] = [[false, false], [true, false], [false, true], [true, true]];
const TREES: readonly (readonly [number, number])[] = [[0, 0], [100, 100], [1_023, 1_023], [1_000, 5], [2_051, 77]];

test("never above, full sales: at the quote's price the preview's out is at most what the sale and its sweep pay into the notes, on every input the chain can give", () => {
  let checked = 0;
  for (const venue of ["pump-curve", "pumpswap"] as const)
    for (const cashback of [false, true])
      for (const has of [{ ammVolume: false, ammVolumeAta: false }, { ammVolume: true, ammVolumeAta: true }])
        for (const claim of CLAIMS)
          for (const lamports of [0n, 1_000_000n, 5_000_000n, ENOUGH])
            for (const [st, lb] of TREES)
              for (const topUp of [0n, 500_000n])
                for (const e of [2_800_000n, 6_000_000n, 200_000_000n]) {
                  const v = { kind: venue, cashback };
                  const made = solanaPoolSellNeed(v, RENT, has) - solanaPoolSellNeed(v, RENT, { ammVolume: true, ammVolumeAta: true });
                  const owed = claim.filter((c, i) => c || (cashback && i === (venue === "pumpswap" ? 1 : 0))).length;
                  const minOut = solanaSellFloor(e, 1_000);
                  const lands = fullLands({ made, owed, lamports, st, lb, topUp, e, minOut });
                  for (const flag of [cashback, undefined]) {
                    const w: DryWallet = { lamports, claim };
                    const pays = poolSellPays(RENT, venue, [w], true, e, minOut, flag, { stateSize: st, labelSize: lb });
                    if ("refused" in pays) continue; // refused: no number shown
                    assert.ok(lands !== null, `${venue} ${cashback} ${claim} ${lamports} ${st}/${lb} ${e}: the preview answers a sale the rule refuses`);
                    assert.ok(pays.out <= lands, `${venue} cashback ${cashback} flag ${flag} claim ${claim} lamports ${lamports} trees ${st}/${lb} top ${topUp} e ${e}: out ${pays.out} > ${lands}`);
                    // the trees and the claims unread (a page's opening, both claims owed): never above either
                    const cold = poolSellPays(RENT, venue, [{ lamports }], true, e, minOut, flag, null);
                    if (!("refused" in cold)) assert.ok(cold.out <= lands, `unread ${venue} cb ${cashback} flag ${flag} has ${has.ammVolume} claim ${claim} l ${lamports} trees ${st}/${lb} top ${topUp} e ${e}: out ${cold.out} > ${lands} (read ${pays.out})`);
                    checked++;
                  }
                }
  assert.ok(checked > 1_000, `checked ${checked}`);
});

test("the gap on recorded full sales is about nothing: a plain coin, no claims, the trees mid-page, the pages at their rent", () => {
  for (const [e, lamports] of [[200_000_000n, ENOUGH], [2_800_000n, 5_000_000n], [6_000_000n, 0n]] as const) {
    const minOut = solanaSellFloor(e, 1_000);
    const lands = fullLands({ made: 0n, owed: 0, lamports, st: SIZES[0], lb: SIZES[1], topUp: 0n, e, minOut })!;
    const pays = poolSellPays(RENT, "pump-curve", [{ lamports, claim: [false, false] }], true, e, minOut, false, { stateSize: SIZES[0], labelSize: SIZES[1] });
    assert.ok(!("refused" in pays));
    const gap = lands - pays.out;
    assert.ok(gap >= 0n && gap <= SIG, `e ${e} lamports ${lamports}: gap ${gap}`);
    console.log(`# full sale of ${poolUnits(e, 9)} SOL, W ${poolUnits(lamports, 9)}: out ${poolUnits(pays.out, 9)}, into the notes ${poolUnits(lands, 9)}, gap ${poolUnits(gap, 9)} SOL`);
  }
});

test("partial sales: out is at most the expected out less the reserve the sale's rule takes, on every input", () => {
  let checked = 0;
  for (const venue of ["pump-curve", "pumpswap"] as const)
    for (const cashback of [false, true])
      for (const has of [{ ammVolume: false, ammVolumeAta: false }, { ammVolume: true, ammVolumeAta: true }])
        for (const lamports of [0n, 1_000_000n, 3_000_000n, 5_000_000n, 10_000_000n, ENOUGH])
          for (const [st, lb] of TREES)
            for (const topUp of [0n, 500_000n]) {
              const v = { kind: venue, cashback };
              const made = solanaPoolSellNeed(v, RENT, has) - solanaPoolSellNeed(v, RENT, { ammVolume: true, ammVolumeAta: true });
              const e = 200_000_000n;
              const minOut = solanaSellFloor(e, 1_000);
              const real = solanaSellReserve({ fee: SIG, made, rents: rentsAt(st, lb, topUp), after: solanaPoolBuySellNeed(v, RENT), lamports, minOut, keeps: true, noteFloor: solanaPoolNoteFloor(RENT) });
              if ("refused" in real) continue;
              for (const flag of [cashback, undefined]) {
                const pays = poolSellPays(RENT, venue, [{ lamports }], false, e, minOut, flag, { stateSize: st, labelSize: lb });
                assert.ok(!("refused" in pays) && pays.out <= e - real.reserve && pays.minOut <= minOut - real.reserve, `${venue} ${cashback} ${lamports} ${st}/${lb}`);
                checked++;
              }
            }
  assert.ok(checked > 300, `checked ${checked}`);
});

// Today a partial sale's note gets the floor less the reserve and the rest waits on W for its last sale's sweep, so
// `out` (the expected amount) is above that note by the slippage share; card partial-sell-pays-all-into-cash makes the
// sale pay it all in, and this turns on there.
test("partial sales: out is at most what reaches the notes at the sale", { todo: "card partial-sell-pays-all-into-cash" }, () => {
  const e = 200_000_000n;
  const minOut = solanaSellFloor(e, 300);
  const real = solanaSellReserve({ fee: SIG, made: 0n, rents: rentsAt(100, 100, 0n), after: solanaPoolBuySellNeed({ kind: "pump-curve", cashback: false }, RENT), lamports: ENOUGH, minOut, keeps: true, noteFloor: solanaPoolNoteFloor(RENT) });
  assert.ok(!("refused" in real));
  const pays = poolSellPays(RENT, "pump-curve", [{ lamports: ENOUGH }], false, e, minOut, false, { stateSize: 100, labelSize: 100 });
  assert.ok(!("refused" in pays));
  assert.ok(pays.out <= real.value, `out ${pays.out} > note ${real.value}`);
});

test("the decimals: the positions pass's, else the page's kept ones, else one read on both providers (then kept)", async () => {
  const kept = tokenDecimalsKept();
  let log: string[] = [];
  const noDec = () => [pos(MINT, "4000000", null)];
  let a = await poolSellDry(deps({ log, decimals: kept, positions: noDec }), share(MINT, 5_000));
  assert.ok("result" in a);
  assert.equal(log.filter((m) => m === "getAccountInfo").length, 2, "one read on each provider");
  assert.equal(kept.get("solana", MINT), 6, "kept");
  log = [];
  a = await poolSellDry(deps({ log, decimals: kept, positions: noDec }), share(MINT, 5_000));
  assert.ok("result" in a);
  assert.equal(log.includes("getAccountInfo"), false, "kept: not read again");
});

test("refusals before any provider read: another chain, no pin, no position, more than is held, a bad request", async () => {
  const log: string[] = [];
  const cases: [Partial<PoolSellDryDeps>, Record<string, unknown>, string][] = [
    [{}, { ...share("0xF111111111111111111111111111111111111111", 5_000), chain: "base" }, "not_allowed"],
    [{ pinned: () => false }, share(MINT, 5_000), "not_allowed"],
    [{ rpcs: () => null }, share(MINT, 5_000), "not_allowed"],
    [{ positions: () => [] }, share(MINT, 5_000), "not_funded"],
    [{ positions: () => null }, share(MINT, 5_000), "not_funded"],
    [{}, { chain: "solana", token: MINT, amount: "4000000.000001", slippage_bps: 300 }, "not_funded"],
    [{}, { chain: "solana", token: MINT, amount: "1.0000001", slippage_bps: 300 }, "not_allowed"],
    [{ positions: () => [pos(MINT, "0.000001")] }, share(MINT, 1), "not_funded"],
    [{}, share("not-a-mint", 5_000), "not_allowed"],
  ];
  for (const [o, params, code] of cases) assert.deepEqual(await poolSellDry(deps({ ...o, log }), params), { error: code }, JSON.stringify(params));
  assert.deepEqual(log, []);
});

/** A page clock. */
const clock = () => {
  let t = 0;
  return { now: () => t, at: () => t, add: (ms: number) => void (t += ms) };
};

test("decided before any read: while a trade runs or holds a host, busy at once with no read; a sign out before its turn: not_funded, no read", async () => {
  const never: string[] = [];
  assert.deepEqual(await poolSellDry(deps({ log: never, trading: () => true }), share(MINT, 5_000)), { error: "busy" });
  assert.deepEqual(never, [], "no provider read while a trade runs");
  const log: string[] = [];
  assert.ok("result" in (await poolSellDry(deps({ log }), share(MINT, 5_000))));
  assert.equal(log.length, 6, "read once no trade runs");
  let looks = 0;
  const out: string[] = [];
  assert.deepEqual(await poolSellDry(deps({ log: out, positions: () => (looks++ === 0 ? [pos()] : null) }), share(MINT, 5_000)), { error: "not_funded" });
  assert.deepEqual(out, []);
});

test("the budget: at most POOL_SELL_DRY_CALLS calls per host in any window; past it busy at once, no read and no wait", async () => {
  const c = clock();
  const log: string[] = [];
  const k = poolSellDryKind(deps({ log, now: c.now }));
  const answers: unknown[] = [];
  for (const bps of [1_000, 2_000, 3_000]) {
    const r = k(share(MINT, bps));
    await r.after;
    answers.push(r.answer());
    c.add(POOL_SELL_DRY_KEEP_MS); // past the kept answers' age: each would read
  }
  assert.ok("result" in (answers[0] as object) && "result" in (answers[1] as object), JSON.stringify(answers));
  assert.deepEqual(answers[2], { error: "busy" }, "the third in 10 s");
  assert.equal(log.length, 2 * POOL_SELL_DRY_CALLS, "six calls per host, no more");
  c.add(POOL_SELL_DRY_WINDOW_MS);
  const r = k(share(MINT, 3_000));
  await r.after;
  assert.ok("result" in r.answer()!, "the next window");
});

test("answered inside the client's 10 s: a read its host holds answers by POOL_SELL_DRY_ANSWER_MS, never later", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  try {
    const held = [async () => new Promise(() => {}), async () => new Promise(() => {})] as unknown as readonly [SolanaRpc, SolanaRpc];
    let answer: unknown = null;
    void poolSellDry(deps({ rpcs: () => held }), share(MINT, 5_000)).then((a) => (answer = a));
    for (let i = 0; i < 5; i++) await null;
    t.mock.timers.tick(POOL_SELL_DRY_ANSWER_MS - 1);
    for (let i = 0; i < 5; i++) await null;
    assert.equal(answer, null);
    t.mock.timers.tick(1);
    for (let i = 0; i < 20; i++) await null;
    assert.ok(answer !== null && "error" in (answer as object), JSON.stringify(answer));
  } finally {
    resetTimers(t.mock.timers);
  }
});

test("a stopped preview books nothing: N asks with changing shares, then a trade's getMultipleAccounts on the same providers goes out within their answer time (N = 12, 30)", async () => {
  for (const n of [12, 30]) {
    const rec = pair("pump", []);
    const out: { trade: number[] } = { trade: [] };
    const ANSWER = 20;
    // two providers by URL, answering in ANSWER ms; the page's pass pair and a trade's pair share their queues
    const bare = rec.map((rpc, i) => Object.assign(async (m: string, p: readonly unknown[]) => {
      if ((p[0] as string[])[0] === "TRADE") return (out.trade.push(performance.now()), { context: { slot: 1 }, value: [null] });
      await new Promise((r) => setTimeout(r, ANSWER));
      return rpc(m, p);
    }, { url: `https://load-${n}-${i}.example/` })) as unknown as SolanaRpc[];
    const pass = bare.map((r) => solanaPacedRpc(r)) as unknown as readonly [SolanaRpc, SolanaRpc];
    const trade = bare.map((r) => solanaPacedRpc(r));
    const k = poolSellDryKind(deps({ rpcs: () => pass }));
    const asks = [];
    for (let i = 0; i < n; i++) {
      asks.push(k(share(MINT, 100 + i)));
      await new Promise((r) => setTimeout(r, 1));
    }
    const t0 = performance.now();
    await Promise.all(trade.map((r) => solanaTimedRpc(r, 5_000)("getMultipleAccounts", [["TRADE"], { encoding: "base64" }])));
    const waited = Math.max(...out.trade) - t0;
    assert.ok(waited < ANSWER + 30, `N ${n}: the trade's call went out ${waited.toFixed(0)} ms after it was asked`);
    await Promise.all(asks.map((r) => r.after));
  }
});

test("one preview at a time: a newer ask stops an older one before it reads; asks for what the running one reads share its answer", async () => {
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const k = poolSellDryKind(deps({ log, trading: () => false, rpcs: () => pair("pump", log).map((rpc) => (async (m: string, p: readonly unknown[]) => (await gate, rpc(m, p))) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc] }));
  // a hundred asks for one share: one run
  const same = Array.from({ length: 100 }, () => k(share(MINT, 5_000)));
  release();
  await Promise.all(same.map((r) => r.after));
  assert.equal(log.length, 6, `${log.length} calls for 100 asks of one share`);
  assert.ok(same.every((r) => JSON.stringify(r.answer()) === JSON.stringify(same[0]!.answer()) && "result" in r.answer()!));
  // thirty asks of other shares in one turn: only the newest reads
  const log2: string[] = [];
  const k2 = poolSellDryKind(deps({ log: log2 }));
  const many = Array.from({ length: 30 }, (_, i) => k2(share(MINT, 100 + i)));
  await Promise.all(many.map((r) => r.after));
  assert.ok("result" in many[29]!.answer()!, JSON.stringify(many[29]!.answer()));
  assert.equal(many.slice(0, 29).filter((r) => JSON.stringify(r.answer()) === '{"error":"busy"}').length, 29);
  assert.equal(log2.length, 6, "the older asks stop before any read");
  // thirty asks a turn apart on providers that answer late: never more than the budget on a host
  const log3: string[] = [];
  let open!: () => void;
  const late = new Promise<void>((r) => (open = r));
  const k3 = poolSellDryKind(deps({ log: log3, rpcs: () => pair("pump", log3).map((rpc) => (async (m: string, p: readonly unknown[]) => (await late, rpc(m, p))) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc] }));
  const spread = [];
  for (let i = 0; i < 30; i++) {
    spread.push(k3(share(MINT, 100 + i)));
    await new Promise((r) => setTimeout(r, 0));
  }
  open();
  await Promise.all(spread.map((r) => r.after));
  assert.ok(log3.length <= 2 * POOL_SELL_DRY_CALLS, `${log3.length} calls for 30 asks`);
  assert.ok(spread.every((r) => "result" in r.answer()! || JSON.stringify(r.answer()) === '{"error":"busy"}'));
});

test("a provider that fails is not asked again: down; a reference the two do not agree on: quote_check_failed", async () => {
  const failing = [async () => { throw new SolanaRpcTransportError("http_429", "HTTP 429", 1, "rpc0.example"); }, providers("pump")[1]] as unknown as readonly [SolanaRpc, SolanaRpc];
  assert.deepEqual(await poolSellDry(deps({ rpcs: () => failing }), share(MINT, 5_000)), { error: "down" });
  const empty = [async () => ({ context: { slot: 1 }, value: [] }), async () => ({ context: { slot: 1 }, value: [] })] as unknown as readonly [SolanaRpc, SolanaRpc];
  const c = await poolSellDry(deps({ rpcs: () => empty }), share(MINT, 5_000));
  assert.ok("error" in c && (c.error === "quote_check_failed" || c.error === "down"), JSON.stringify(c));
});

test("the kind: a read that runs, its answer once its wait settles; a throw is down", async () => {
  const k = poolSellDryKind(deps());
  const r = k(share(MINT, 5_000));
  assert.equal(r.running, true);
  await r.after;
  assert.ok("result" in r.answer()!);
  const bad = poolSellDryKind(deps({ positions: () => { throw new Error("store gone"); } }))(share(MINT, 5_000));
  await bad.after;
  assert.deepEqual(bad.answer(), { error: "down" });
});

test("the page answers it (src/main.ts): the kind on the trades' paced pair as background reads, the held positions, every pool trade counted from its tap to its run's end, the lanes", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /"pool\.sell\.dry": \(params\) => poolSellDry\(params\),/);
  assert.match(main, /PAGE_SOL_PIN === undefined \? null : pageSolanaRpcs\("pass"\)/, "the trades' own paced pair, each read a background one on its host's lane");
  assert.match(main, /positions: \(\) => testnet\?\.positionsNow\(\) \?\? null, pin: \(\) => PAGE_SOL_PIN \?\? null,/, "the held positions: no pass, no seed read, no write; the page's pool");
  assert.match(main, /bought: \(token\) => testnet\?\.boughtSince\(token\) \?\? Promise\.resolve\(\[\]\),/, "the Ws bought since the pass, as the sale finds them");
  assert.match(main, /rent: \(\) => \(hasSolana \? rent\.get\(\) : null\),/, "the page's own Rent sysvar read");
  assert.match(main, /const buys = liveRuns\(poolKindMap\["pool\.buy"\]\);\n  poolKindMap\["pool\.buy"\] = buys\.kind;/, "a buy counted to its first answer, its early sent (devnet run 11: to Final it kept the preview busy 33.8 s)");
  assert.match(main, /const sells = liveRuns\(poolKindMap\["pool\.sell"\]\);\n  poolKindMap\["pool\.sell"\] = sells\.kind;/);
  assert.doesNotMatch(main, /liveRuns\([^)]*"final"/, "no trade counted to its final progress post");
  assert.match(main, /trading: \(\) => buys\.live\(\) \+ sells\.live\(\) > 0 \|\| \(dryPair\(\) \?\? \[\]\)\.some\(\(r\) => r\.url !== undefined && hostLane\(r\.url\)\.trading\(\)\),/);
  const tp = readFileSync(new URL("../src/pool-testnet.ts", import.meta.url), "utf8");
  assert.match(tp, /positionsNow: \(\) => positions\.get\(\),/);
  assert.match(tp, /boughtSince: async \(token: string\) => \{\n      const st = await \(page\.held \? page\.held\(\) : page\.store\(\)\);/, "the store as held, never opened again for it (review of b7212a9e, P3-1)");
  assert.match(tp, /return boughtSincePass\(token, mints, kept, costs, sold\);/, "from the store's buy mints, kept pass, buy records and full sells: no read");
});

// devnet run 11 (11 Nov): a buy's hold on the pair's hosts lasted to its Final, so every preview asked after its Filled
// answered busy. With main's rule over the page's real lanes: busy while a trade holds a host of the pair, a number the
// moment the hold is given back (a buy gives it back at its early "sent": pool-buy.test.ts)
test("main's trading rule on the page's lanes: a preview is busy while a trade holds a host of the pair and answers a number once the hold is given back", async () => {
  const { holdHosts, hostLane, resetHostLanes } = await import("../../wallet/src/throttle.ts");
  resetHostLanes();
  try {
    const urls = ["https://dry-0.example/", "https://dry-1.example/"] as const;
    const rpcs = pair().map((r, i) => Object.assign(r, { url: urls[i] })) as unknown as readonly [SolanaRpc, SolanaRpc];
    const live = { buys: 0, sells: 0 };
    const d = deps({ rpcs: () => rpcs, trading: () => live.buys + live.sells > 0 || rpcs.some((r) => r.url !== undefined && hostLane(r.url).trading()) });
    const give = holdHosts([urls[1]]);
    assert.deepEqual(await poolSellDry(d, share(MINT, 5_000)), { error: "busy" }, "one host of the pair held");
    give();
    const a = await poolSellDry(d, share(MINT, 5_000));
    assert.ok("result" in a, JSON.stringify(a));
  } finally {
    resetHostLanes();
  }
});

test("a pool buy runs from its tap to its first answer, its early \"sent\", while its read-backs go on to Final; a sell to its run's end; a refusal ends either; the backstop ends one with no end", async () => {
  type Ctx = Parameters<ReturnType<typeof liveRuns>["kind"]>[1];
  const ctx = (seen: string[]) => ({ id: "b1", sha: "s", progress: (s: string) => void seen.push(s) }) as unknown as Ctx;
  let post!: (s: string) => void;
  let answered!: () => void;
  const b = liveRuns((_p, c) => {
    post = (s) => c.progress(s as never);
    return { running: true, after: new Promise<void>((r) => (answered = r)), answer: () => ({ result: { stage: "sent", txs: [] } }) };
  });
  const seen: string[] = [];
  b.kind({}, ctx(seen));
  assert.equal(b.live(), 1);
  answered();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(b.live(), 0, "answered sent: no longer running, though its read-backs go on");
  post("filled");
  assert.equal(b.live(), 0);
  assert.deepEqual(seen, ["filled"], "progress passes through");
  let ran!: () => void;
  const s = liveRuns(() => ({ running: true, after: new Promise<void>((r) => (ran = r)), answer: () => ({ result: { stage: "sent", txs: [] } }) }));
  s.kind({}, ctx([]));
  assert.equal(s.live(), 1, "a sell from its tap");
  ran();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.live(), 0, "to its run's end");
  const refused = liveRuns(() => ({ error: "not_allowed" }));
  refused.kind({}, ctx([]));
  assert.equal(refused.live(), 0);
  const rejects = liveRuns(() => ({ running: true, after: Promise.reject(new Error("x")), answer: () => null }));
  rejects.kind({}, ctx([]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rejects.live(), 0, "a run whose after rejects ends, nothing unhandled");
  const late = liveRuns(() => ({ running: true, after: new Promise<void>(() => {}), answer: () => null }), 5);
  late.kind({}, ctx([]));
  assert.equal(late.live(), 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(late.live(), 0, "the backstop");
});

test("the kept answers: four shares inside 2 s make three calls per provider in all and four answers; a trade meanwhile costs nothing; past the age one read again; a sign out drops them", async () => {
  const c = clock();
  const log: string[] = [];
  let trading = false;
  let signedIn = true;
  const k = poolSellDryKind(deps({ log, now: c.now, trading: () => trading, positions: () => (signedIn ? [pos(), pos(SWAP_MINT)] : null) }));
  const ask = async (bps: number) => {
    const r = k(share(MINT, bps));
    await r.after;
    return r.answer() as { result?: { out: string }; error?: string };
  };
  const shares = [2_500, 5_000, 7_500, 10_000];
  const outs: string[] = [];
  for (const bps of shares) {
    outs.push((await ask(bps)).result!.out);
    c.add(400);
  }
  assert.equal(log.length, 6, "three calls per provider for the four");
  assert.equal(new Set(outs).size, 4, `four answers ${outs}`);
  for (const [i, bps] of shares.entries()) assert.equal(((await poolSellDry(deps(), share(MINT, bps))) as { result: { out: string } }).result.out, outs[i], "each share's own answer, as a preview of it alone");
  // a trade tapped meanwhile (1.6 s in): the ask reads nothing, so the trade's reads wait on nothing of it
  trading = true;
  assert.ok((await ask(3_000)).result);
  assert.equal(log.length, 6, "no call while the trade runs");
  trading = false;
  // past the age: one read again
  c.add(POOL_SELL_DRY_KEEP_MS);
  assert.ok((await ask(2_000)).result);
  assert.equal(log.length, 12);
  // a sign out drops them: on a page with its budget free, signed in again inside the age, the next ask reads
  const c2 = clock();
  const log2: string[] = [];
  const k2 = poolSellDryKind(deps({ log: log2, now: c2.now, positions: () => (signedIn ? [pos()] : null) }));
  const ask2 = async (bps: number) => {
    const r = k2(share(MINT, bps));
    await r.after;
    return r.answer() as { result?: unknown; error?: string };
  };
  assert.ok((await ask2(2_500)).result);
  signedIn = false;
  assert.equal((await ask2(5_000)).error, "not_funded");
  signedIn = true;
  c2.add(100);
  assert.ok((await ask2(7_500)).result);
  assert.equal(log2.length, 12, "read again after the sign out");
});

test("the kept answers are the preview's only: a sale's reference after a preview reads the providers itself", async () => {
  const log: string[] = [];
  const shared = pair("pump", log);
  const k = poolSellDryKind(deps({ rpcs: () => shared }));
  const r = k(share(MINT, 5_000));
  await r.after;
  const n = log.length;
  assert.ok(n > 0);
  // as sellRun reads its quote: poolSellReference on the page's pair
  const { poolSellReference } = await import("../src/pool-sell.ts");
  assert.ok(await poolSellReference(shared, MINT, HELD / 2n));
  assert.ok(log.length >= n + 4, `the sale's own reads: ${log.length - n}`);
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /const dryPair = \(\): readonly \[SolanaRpc, SolanaRpc\] \| null => \(PAGE_SOL_PIN === undefined \? null : pageSolanaRpcs\("pass"\)\);/, "the preview's pair is its own, made per ask");
});

// Card app-sell-shows-what-you-receive, devnet run 116 (11 Nov): right after a buy's Filled the preview answered
// not_funded for 7.6 s, waiting for the positions pass's finder read of the new W, while a sale tapped then planned W from
// its buy mint and W's own read. The preview takes a W bought since the last whole pass as the sale's plan does: its buy
// mint names the token (boughtSincePass), and W's own read (pool-sell.ts wHeldNow, the sale's wHeld) says what it holds.
const { solanaAta } = await import("../../kit/src/checks/solana/message.ts");
const { base58 } = await import("@scure/base");
const { boughtSincePass } = await import("../src/pool-sell-dry.ts");
const MINT_PROGRAM = (Object.entries(fx.pump.reads[0]).find(([k]) => JSON.parse(k)[0] === MINT)![1] as { value: { owner: string }[] }).value[0]!.owner;
const tokenBytes = (amount: bigint, owner: string, state = 1): string => {
  const d = new Uint8Array(165);
  d.set(base58.decode(MINT), 0);
  d.set(base58.decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = state;
  return Buffer.from(d).toString("base64");
};
/** The recorded pair, with W2's own read (its token account, W2, its two volume accounts) answered: W2 holding `held`
 *  on each provider (null: no token account there), its lamports ENOUGH. Each call's address list logged. */
function boughtPair(held: readonly [bigint | null, bigint | null], log: string[], lists: string[][], o: { frozen?: true; during?: () => void } = {}): readonly [SolanaRpc, SolanaRpc] {
  const ata = solanaAta(W2, MINT, MINT_PROGRAM);
  return pair("pump", log).map((rpc, i) => (async (method: string, params: readonly unknown[]) => {
    const list = params[0];
    if (method === "getMultipleAccounts" && Array.isArray(list)) lists.push(list as string[]);
    o.during?.();
    if (method === "getMultipleAccounts" && Array.isArray(list) && list[0] === ata) {
      log.push(method);
      const h = held[i]!;
      return { context: { slot: 1 }, value: [h === null ? null : { lamports: 2_039_280, owner: MINT_PROGRAM, data: [tokenBytes(h, W2, o.frozen ? 2 : 1), "base64"] }, { lamports: Number(ENOUGH), owner: "11111111111111111111111111111111", data: ["", "base64"] }, null, null] };
    }
    // no W of the pass's: the Ws' call reads the pool account alone
    if (method === "getMultipleAccounts" && Array.isArray(list) && list.length === 1 && list[0] === POOL) {
      log.push(method);
      return { context: { slot: 1 }, value: [{ lamports: 1, owner: PROGRAM, data: [poolBytes(...SIZES), "base64"] }] };
    }
    return rpc(method, params);
  }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
}
const FINDER = /^(getTokenAccountsByOwner|getBalance|getProgramAccounts|getSignaturesForAddress)$/;

test("a preview asked right after a buy's read-back, before the pass lists its W: the buy's amount from W's own read, the same number as the pass's, and no finder read", async () => {
  const log: string[] = [];
  const lists: string[][] = [];
  const since = { address: W2, program: MINT_PROGRAM, decimals: 6 };
  const got = await poolSellDry(deps({ positions: () => [pos(SWAP_MINT)], rpcs: () => boughtPair([HELD, HELD], log, lists), bought: async (t: string) => (t === MINT ? [since] : []) }), share(MINT, 10_000));
  assert.ok("result" in got, `a number on the first ask: ${JSON.stringify(got)}`);
  // the same W as the pass would hold it, the same holding: the same answer
  const passed = await poolSellDry(deps({ positions: () => [pos(MINT, "4000000", 6, [W2])] }), share(MINT, 10_000));
  assert.deepEqual(got, passed, "the buy's amount, priced as the pass's holding of it");
  assert.equal(log.filter((m) => FINDER.test(m)).length, 0, `no finder read: ${log.join(",")}`);
  // a partial share of it as well
  const half = await poolSellDry(deps({ positions: () => [], rpcs: () => boughtPair([HELD, HELD], [], []), bought: async () => [since] }), share(MINT, 5_000));
  const halfPassed = await poolSellDry(deps({ positions: () => [pos(MINT, "4000000", 6, [W2])] }), share(MINT, 5_000));
  assert.deepEqual(half, halfPassed);
});

test("a W bought since the pass as the sale finds it: empty on both (the buy did not land) adds nothing; apart on the two (its account on one only): not now; beside the pass's W, each W in its own call", async () => {
  const since = [{ address: W2, program: MINT_PROGRAM, decimals: 6 }];
  // not landed: no token account on either provider, so the sale would plan nothing of W
  assert.deepEqual(await poolSellDry(deps({ positions: () => [], rpcs: () => boughtPair([null, null], [], []), bought: async () => since }), share(MINT, 10_000)), { error: "not_funded" });
  // one provider shows it, the other not yet: neither's word alone, busy (the app asks again)
  assert.deepEqual(await poolSellDry(deps({ positions: () => [], rpcs: () => boughtPair([HELD, null], [], []), bought: async () => since }), share(MINT, 10_000)), { error: "busy" });
  // signed out: nothing, no read of W
  const lists: string[][] = [];
  assert.deepEqual(await poolSellDry(deps({ positions: () => null, rpcs: () => boughtPair([HELD, HELD], [], lists), bought: async () => since }), share(MINT, 10_000)), { error: "not_funded" });
  assert.equal(lists.length, 0);
  // the pass holds W1, W2 was bought since: both counted, W2's read names W2 alone
  const both = await poolSellDry(deps({ positions: () => [pos(MINT, "4000000", 6, [W1])], rpcs: () => boughtPair([HELD, HELD], [], lists), bought: async () => since }), share(MINT, 10_000));
  const passedBoth = await poolSellDry(deps({ positions: () => [pos(MINT, "8000000", 6, [W1, W2])] }), share(MINT, 10_000));
  assert.ok("result" in both && "result" in passedBoth, JSON.stringify([both, passedBoth]));
  assert.equal(both.result.out, passedBoth.result.out, "the two Ws' holding, as the pass would hold it");
  for (const l of lists.filter((x) => x.includes(W2))) assert.ok(!l.includes(W1), `a call naming W2 names no other W: ${l.join(",")}`);
  // a W the pass already holds is not read again
  const again: string[][] = [];
  await poolSellDry(deps({ positions: () => [pos(MINT, "4000000", 6, [W2])], rpcs: () => boughtPair([HELD, HELD], [], again), bought: async () => since }), share(MINT, 10_000));
  assert.equal(again.filter((l) => l[0] === solanaAta(W2, MINT, MINT_PROGRAM)).length, 0, "the pass's W: no own read");
});

// The review of b7212a9e (P2): buy mints are never deleted, so a W whose buy never landed, or one sold in full before the
// finder listed it, stayed one of these for good, a call per host on every cold preview (four of them: busy for good).
// The pass's own rule now: W's buy record names the token with what W received (a not_landed end takes it back,
// positions.ts recordPoolBuy), and no full sell of it from W is noted (POSITIONS_SOLD_KEY).
test("boughtSincePass: the Ws whose buy mint and buy record (with what W received) name the token, the kept pass never listed it in and no full sell of it is noted; the program and the record's decimals", () => {
  const W3 = PROGRAM;
  const mints = { [W1]: { mint: MINT, program: MINT_PROGRAM }, [W2]: { mint: MINT, program: MINT_PROGRAM }, [W3]: { mint: MINT, program: MINT_PROGRAM }, [POOL]: { mint: SWAP_MINT, program: MINT_PROGRAM } };
  const costs = { [W1]: { mint: MINT, received: "1000000", decimals: 6 }, [W2]: { mint: MINT, received: "4000000", decimals: 6 }, [POOL]: { mint: SWAP_MINT, received: "5" } };
  // no whole pass kept yet: every recorded W of the token; W3 (its buy mint alone: never landed, its record taken back)
  // is none
  assert.deepEqual(boughtSincePass(MINT, mints, undefined, costs, undefined), [{ address: W1, program: MINT_PROGRAM, decimals: 6 }, { address: W2, program: MINT_PROGRAM, decimals: 6 }]);
  // W1 listed the token once (held or sold since): the pass's, never read here
  assert.deepEqual(boughtSincePass(MINT, mints, { positions: [], held: {}, listed: [`${W1} ${MINT}`] }, costs, undefined), [{ address: W2, program: MINT_PROGRAM, decimals: 6 }]);
  // W2 sold in full from this device (before the finder listed it): none
  assert.deepEqual(boughtSincePass(MINT, mints, undefined, costs, { [W2]: [MINT] }), [{ address: W1, program: MINT_PROGRAM, decimals: 6 }]);
  // a record with no amount received, or of another mint: none
  assert.deepEqual(boughtSincePass(MINT, mints, undefined, { [W1]: { mint: MINT }, [W2]: { mint: SWAP_MINT, received: "4" } }, undefined), []);
  assert.deepEqual(boughtSincePass(MINT, undefined, undefined, costs, undefined), []);
  assert.deepEqual(boughtSincePass(MINT, { [W2]: { mint: MINT } }, undefined, costs, undefined), [], "no program: not the sale's read");
});

// The review of b7212a9e (P1): the Ws' call put every W the pass lists for the token, with their volume accounts, in one
// getMultipleAccounts on both providers: one request named two of the user's wallets. Each W in a call of its own.
const wNamed = (a: string): string | undefined =>
  [W1, W2].find((w) => a === w || a === solanaVolumeAccumulator(w, SOLANA_PUMP_PROGRAM) || a === solanaVolumeAccumulator(w, SOLANA_PUMP_AMM_PROGRAM) || a === solanaAta(w, MINT, MINT_PROGRAM));
const twoNamed = (lists: readonly string[][]): string[][] => lists.filter((l) => new Set(l.map(wNamed).filter((w) => w !== undefined)).size > 1);

test("one W per request: a holding over two Ws reads each W (its lamports and volume accounts) in a call of its own on each provider, none naming the other", async () => {
  const lists: string[][] = [];
  const got = await poolSellDry(deps({ positions: () => [pos(MINT, "8000000", 6, [W1, W2])], rpcs: () => boughtPair([HELD, HELD], [], lists) }), share(MINT, 10_000));
  assert.ok("result" in got, JSON.stringify(got));
  assert.deepEqual(twoNamed(lists), [], "no request names two Ws");
  assert.equal(lists.filter((l) => l.includes(W1)).length, 2, "W1's call, once on each provider");
  assert.equal(lists.filter((l) => l.includes(W2)).length, 2, "W2's call, once on each provider");
  // with a W bought since the pass beside the pass's W
  const more: string[][] = [];
  await poolSellDry(deps({ positions: () => [pos(MINT, "4000000", 6, [W1])], rpcs: () => boughtPair([HELD, HELD], [], more), bought: async () => [{ address: W2, program: MINT_PROGRAM, decimals: 6 }] }), share(MINT, 10_000));
  assert.deepEqual(twoNamed(more), [], "no request names two Ws");
});

/** A preview's turn with `n` calls already made on each host in the window, its kept answers none. */
const turnWith = (n: number) => ({ newest: () => true, calls: [Array(n).fill(0), Array(n).fill(0)] as [number[], number[]], kept: { get: () => null, put: () => {}, drop: () => {} } });

test("the budget counts each W's call: two calls for the reference and one per W (the pass's and each bought since), past POOL_SELL_DRY_CALLS busy at once with no read", async () => {
  const since = [{ address: W2, program: MINT_PROGRAM, decimals: 6 }];
  for (const [name, o] of [["two Ws of the pass", { positions: () => [pos(MINT, "8000000", 6, [W1, W2])] }], ["the pass's W and one bought since", { positions: () => [pos(MINT, "4000000", 6, [W1])], bought: async () => since }]] as const) {
    const lists: string[][] = [];
    // 2 + 2 calls this preview's: past 6 with 3 made, at 6 with 2
    assert.deepEqual(await poolSellDry(deps({ ...o, now: () => 0, rpcs: () => boughtPair([HELD, HELD], [], lists) }), share(MINT, 10_000), turnWith(3) as never), { error: "busy" }, name);
    assert.equal(lists.length, 0, `${name}: no read`);
    assert.ok("result" in (await poolSellDry(deps({ ...o, now: () => 0, rpcs: () => boughtPair([HELD, HELD], [], []) }), share(MINT, 10_000), turnWith(2) as never)), `${name}: within the budget`);
  }
});

test("a W bought since the pass that holds nothing, or is frozen on both, adds nothing: the answer is the pass's W's alone", async () => {
  const alone = await poolSellDry(deps({ positions: () => [pos(MINT, "4000000", 6, [W1])] }), share(MINT, 10_000));
  assert.ok("result" in alone, JSON.stringify(alone));
  const since = async () => [{ address: W2, program: MINT_PROGRAM, decimals: 6 }];
  assert.deepEqual(await poolSellDry(deps({ positions: () => [pos(MINT, "4000000", 6, [W1])], rpcs: () => boughtPair([null, null], [], []), bought: since }), share(MINT, 10_000)), alone, "empty on both");
  assert.deepEqual(await poolSellDry(deps({ positions: () => [pos(MINT, "4000000", 6, [W1])], rpcs: () => boughtPair([HELD, HELD], [], [], { frozen: true }), bought: since }), share(MINT, 10_000)), alone, "frozen on both");
  assert.deepEqual(await poolSellDry(deps({ positions: () => [], rpcs: () => boughtPair([HELD, HELD], [], [], { frozen: true }), bought: since }), share(MINT, 10_000)), { error: "not_funded" }, "frozen on both, nothing else: as the sale, nothing to sell");
});

test("a sign out at each step ends the preview not_funded, each check its own: before the store is read (nothing read), before the providers are asked (none asked), while they answer (no number)", async () => {
  const since = [{ address: W2, program: MINT_PROGRAM, decimals: 6 }];
  // signed out at the ask: the store is not read for the Ws bought since
  let asked = 0;
  assert.deepEqual(await poolSellDry(deps({ positions: () => null, bought: async () => (asked++, since) }), share(MINT, 10_000)), { error: "not_funded" });
  assert.equal(asked, 0, "no store read when signed out");
  // signed out while the store is read: no provider asked
  let out = false;
  const lists: string[][] = [];
  assert.deepEqual(await poolSellDry(deps({ positions: () => (out ? null : []), rpcs: () => boughtPair([HELD, HELD], [], lists), bought: async () => ((out = true), since) }), share(MINT, 10_000)), { error: "not_funded" });
  assert.equal(lists.length, 0, "no provider asked after a sign out");
  // signed out while the providers answer: no number
  let gone = false;
  assert.deepEqual(await poolSellDry(deps({ positions: () => (gone ? null : []), rpcs: () => boughtPair([HELD, HELD], [], [], { during: () => void (gone = true) }), bought: async () => since }), share(MINT, 10_000)), { error: "not_funded" });
});

// The review of b7212a9e (P3-2): with a W bought since the pass, the "holding gone" check was skipped: the pass's W sold
// out meanwhile was still priced.
test("the pass's holding gone while the preview reads (sold out), a W bought since beside it: not_funded, never the old holding", async () => {
  let sold = false;
  const got = await poolSellDry(deps({ positions: () => (sold ? [] : [pos(MINT, "4000000", 6, [W1])]), rpcs: () => boughtPair([HELD, HELD], [], [], { during: () => void (sold = true) }), bought: async () => [{ address: W2, program: MINT_PROGRAM, decimals: 6 }] }), share(MINT, 10_000));
  assert.deepEqual(got, { error: "not_funded" });
  // gone while the store is read, before any provider is asked: not_funded, none asked
  let early = false;
  const lists: string[][] = [];
  const first = await poolSellDry(deps({ positions: () => (early ? [] : [pos(MINT, "4000000", 6, [W1])]), rpcs: () => boughtPair([HELD, HELD], [], lists), bought: async () => ((early = true), [{ address: W2, program: MINT_PROGRAM, decimals: 6 }]) }), share(MINT, 10_000));
  assert.deepEqual(first, { error: "not_funded" });
  assert.equal(lists.length, 0, "no provider asked");
});
