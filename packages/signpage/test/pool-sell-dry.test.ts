// Card app-sell-shows-what-you-receive: pool.sell.dry (src/pool-sell-dry.ts), the sell box's preview. Its out is the
// quote the sale signs on, on the same reads (pool-sell.ts poolSellReference, the one reference read in pool-sell.ts),
// less the most the sale's reserve can be (poolSellReserveBound), never under the reserve the sale's own rule takes
// (solanaSellReserve), so at the quote's price it is never above what the sale pays into the user's money; it reads the
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
import { solanaPoolBuySellNeed, solanaPoolSellNeed } from "../../kit/src/trade/solana/pool-buy.ts";
import { tokenDecimalsKept } from "../src/pool-kinds.ts";
import { liveBuys, POOL_SELL_DRY_WAIT_MS, poolSellDry, poolSellDryKind, poolSellReserveBound, type PoolSellDryDeps } from "../src/pool-sell-dry.ts";
import { POOL_SELL_LOCK, solanaSellReserve } from "../src/pool-sell.ts";
import type { Position } from "../src/positions.ts";
import { poolUnits, solanaDepositRents, solanaSellAfterFull, SOLANA_POOL_SELL_RESERVE_MAX } from "../src/rules/pool.ts";
import { solanaPoolNoteFloor } from "../../kit/src/trade/solana/pool-deposit.ts";

const MINT = fx.pump.mint as string;
const SWAP_MINT = fx.pumpswap.mint as string;
/** 4,000,000 tokens at 6 decimals over every W: the recorded curve gives about 0.11 SOL for them. */
const HELD = 4_000_000_000_000n;
/** W's lamports as both RPCs read them: pool-sell.test.ts's ENOUGH (a reserve of 0 on a partial sale). */
const ENOUGH = 1_000_000_000n;
const pos = (token = MINT, amount = "4000000", decimals: number | null = 6, wallets = ["W1"]): Position => ({ chain: "solana", token, amount, cost: "0", wallets, ...(decimals === null ? {} : { decimals }) });
const share = (token: string, share_bps: number) => ({ chain: "solana", token, share_bps, slippage_bps: 1000 });

/** The recorded pair, every call logged; the mint's getAccountInfo answered as both providers answered it, the Ws'
 *  lamports from `lamports` (an address not in it: no account). */
function pair(v: "pump" | "pumpswap" = "pump", log: string[] = [], lamports: Record<string, bigint> = { W1: ENOUGH, W2: ENOUGH }): readonly [SolanaRpc, SolanaRpc] {
  const mintRead = (Object.entries(fx[v].reads[0]).find(([k]) => JSON.parse(k)[0] === fx[v].mint)![1] as { context: unknown; value: unknown[] });
  return providers(v).map((rpc) => (async (method: string, params: readonly unknown[]) => {
    log.push(method);
    if (method === "getAccountInfo") return { context: mintRead.context, value: mintRead.value[0] };
    const list = params[0] as string[];
    if (list.every((a) => /^W\d$/.test(a))) return { context: { slot: 1 }, value: list.map((a) => (lamports[a] === undefined ? null : { lamports: Number(lamports[a]), owner: "11111111111111111111111111111111", data: ["", "base64"] })) };
    return rpc(method, params);
  }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
}
const deps = (o: Partial<PoolSellDryDeps> & { log?: string[]; v?: "pump" | "pumpswap" } = {}): PoolSellDryDeps => ({
  pinned: () => true,
  rpcs: () => pair(o.v, o.log),
  positions: async () => [pos(), pos(SWAP_MINT)],
  rent: () => RENT,
  decimals: tokenDecimalsKept(),
  locks: null,
  wait: async () => {},
  ...o,
});
/** What the sale's own read gives for `units`: the venue in the reference that gives the most (pool-sell.ts sellRun). */
const saleOut = async (v: "pump" | "pumpswap", token: string, units: bigint): Promise<bigint> => {
  const ref = (await readSolanaReference(providers(v), { side: "sell", token, amount: units }))!;
  return ref.pools.filter((p) => p.venue === "pump-curve" || p.venue === "pumpswap").sort((x, y) => (x.expectedOut > y.expectedOut ? -1 : 1))[0]!.expectedOut;
};

test("the preview's out is the sale's own quote for the units pool.sell would sell, on both recorded venues, for a share and a typed amount", async () => {
  for (const [v, token] of [["pump", MINT], ["pumpswap", SWAP_MINT]] as const) {
    for (const [params, units] of [[share(token, 10_000), HELD], [share(token, 5_000), HELD / 2n], [share(token, 2_500), HELD / 4n], [{ chain: "solana", token, amount: "1000000", slippage_bps: 300 }, 1_000_000_000_000n]] as const) {
      const a = await poolSellDry(deps({ v }), params);
      assert.ok("result" in a, `${v} ${JSON.stringify(params)}: ${JSON.stringify(a)}`);
      const e = await saleOut(v, token, units);
      const reserve = poolSellReserveBound(RENT, v === "pump" ? "pump-curve" : "pumpswap", [ENOUGH], units === HELD);
      // a partial sale from a W that holds ENOUGH keeps nothing out of the note; a full one puts W's surplus in it too
      assert.equal(units === HELD ? reserve < 0n : reserve === 0n, true, `${v} reserve ${reserve}`);
      assert.equal(a.result.out, poolUnits(e - reserve, 9), `${v} ${JSON.stringify(params)}`);
      assert.equal(a.result.min_out, poolUnits((e * BigInt(10_000 - params.slippage_bps)) / 10_000n - reserve, 9), "the floor the sale signs, less the same");
      assert.equal(a.result.network, "0.000005", "one signature, no priority fee");
      assert.equal(a.result.fee_bps, 0, "no platform fee on a Solana pool sale");
      assert.equal(SIGNPAGE_RESULT_SCHEMAS["pool.sell.dry"](a.result), true, "the kit's client takes it");
    }
  }
});

test("one code path: every sale reads its quote through poolSellReference, the one reference read in pool-sell.ts", () => {
  const src = readFileSync(new URL("../src/pool-sell.ts", import.meta.url), "utf8");
  assert.equal(src.match(/pageReference\(/g)?.length, 1, "pageReference is called once, inside poolSellReference");
  assert.match(src, /const quoted = await poolSellReference\(rpcs, token, amount\);/, "sellRun quotes through it");
  assert.match(src, /const units = poolSellUnits\(total, ask\);/, "planPoolSell's units are poolSellUnits");
  const dry = readFileSync(new URL("../src/pool-sell-dry.ts", import.meta.url), "utf8");
  for (const word of ["readSolanaReference(", "pageReference(", "expectedOut *", "solanaPoolSellMinOut", "seed64", "notes(", "ops(", "sendTransaction", "simulate"]) assert.equal(dry.includes(word), false, `the preview has no ${word}`);
});

test("a preview asks the providers three getMultipleAccounts each: the reference's two and the Ws' lamports; no send, no simulation, no blockhash, no fee", async () => {
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

// the reserve's inputs the sale's rule takes (pool-sell.ts sellRun: solanaSellReserve), each at every value the chain can
// give it: the deposit's rents from a page's one-entry growth to its opening, with or without the window; the cashback
// accounts made or there; W's keep for 0 to 2 volume accounts owed; W's lamports from nothing to plenty
test("never above: at the quote's price, the preview's reserve is at least the one the sale's own rule takes, partial and full, on every input the chain can give", () => {
  const none = [null, null] as const;
  const grown = (size: number) => [solanaDepositRents(RENT, { stateSize: size, labelSize: size }, { mark: none, state: none, label: none }, true)];
  let checked = 0;
  for (const venue of ["pump-curve", "pumpswap"] as const)
    for (const cashback of [false, true])
      for (const has of [{ ammVolume: false, ammVolumeAta: false }, { ammVolume: true, ammVolumeAta: true }])
        for (const owed of [0, 1, 2])
          for (const lamports of [0n, 1_000_000n, 3_000_000n, 5_000_000n, 10_000_000n, ENOUGH])
            for (const rents of [...grown(0), 731_520n, 365_760n + 214_320n])
              for (const full of [false, true]) {
                const v = { kind: venue, cashback };
                const made = solanaPoolSellNeed(v, RENT, has) - solanaPoolSellNeed(v, RENT, { ammVolume: true, ammVolumeAta: true });
                const after = full ? solanaSellAfterFull(RENT, owed) : solanaPoolBuySellNeed(v, RENT);
                const minOut = 200_000_000n;
                const real = solanaSellReserve({ fee: 5_000n, made, rents, after, lamports, minOut, keeps: !full, noteFloor: solanaPoolNoteFloor(RENT) });
                if ("refused" in real) continue; // refused: nothing is sold, nothing to preview against
                const bound = poolSellReserveBound(RENT, venue, [lamports], full);
                assert.ok(bound >= real.reserve, `${venue} cashback ${cashback} owed ${owed} lamports ${lamports} rents ${rents} full ${full}: bound ${bound} < ${real.reserve}`);
                checked++;
              }
  assert.ok(checked > 300, `checked ${checked}`);
});

test("the gap on a single-wallet sale: on the recorded sells (W holds ENOUGH) none; on a W that holds only its sale's need, at most both pages' opening over their growth, the cashback accounts and the owed keep", () => {
  // the recorded sells: a partial sale's reserve is 0 both ways
  assert.equal(poolSellReserveBound(RENT, "pump-curve", [ENOUGH], false), 0n);
  const real = solanaSellReserve({ fee: 5_000n, made: 0n, rents: 731_520n, after: solanaPoolBuySellNeed({ kind: "pump-curve", cashback: false }, RENT), lamports: solanaPoolSellNeed({ kind: "pump-curve", cashback: false }, RENT), minOut: 200_000_000n, keeps: true, noteFloor: solanaPoolNoteFloor(RENT) });
  assert.ok("reserve" in real);
  const bound = poolSellReserveBound(RENT, "pump-curve", [solanaPoolSellNeed({ kind: "pump-curve", cashback: false }, RENT)], false);
  const gap = bound - real.reserve;
  assert.ok(gap >= 0n && gap < SOLANA_POOL_SELL_RESERVE_MAX, `gap ${gap}`);
  console.log(`# single-wallet gap on a lean W: ${poolUnits(gap, 9)} SOL (bound ${poolUnits(bound, 9)}, rule ${poolUnits(real.reserve, 9)})`);
});

test("the decimals: the positions pass's, else the page's kept ones, else one read on both providers (then kept)", async () => {
  const kept = tokenDecimalsKept();
  let log: string[] = [];
  const noDec = async () => [pos(MINT, "4000000", null)];
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
    [{ positions: async () => [] }, share(MINT, 5_000), "not_funded"],
    [{ positions: async () => null }, share(MINT, 5_000), "not_funded"],
    [{}, { chain: "solana", token: MINT, amount: "4000000.000001", slippage_bps: 300 }, "not_funded"],
    [{}, { chain: "solana", token: MINT, amount: "1.0000001", slippage_bps: 300 }, "not_allowed"],
    [{ positions: async () => [pos(MINT, "0.000001")] }, share(MINT, 1), "not_funded"],
    [{}, share("not-a-mint", 5_000), "not_allowed"],
  ];
  for (const [o, params, code] of cases) assert.deepEqual(await poolSellDry(deps({ ...o, log }), params), { error: code }, JSON.stringify(params));
  assert.deepEqual(log, []);
});

test("a trade's reads first: it waits while the sell lock is held or the page runs a trade, reads once they end, and answers busy past its bound", async () => {
  let heldFor = 3;
  const locks = { query: async () => ({ held: heldFor-- > 0 ? [{ name: POOL_SELL_LOCK, mode: "exclusive" as const }] : [], pending: [] }) };
  const log: string[] = [];
  const waits: number[] = [];
  const a = await poolSellDry(deps({ log, locks, wait: async (ms) => void waits.push(ms) }), share(MINT, 5_000));
  assert.ok("result" in a);
  assert.equal(waits.length, 3, "looked again until the lock was let go");
  let n = 0;
  const b = await poolSellDry(deps({ log: [], busy: () => true, wait: async () => void n++ }), share(MINT, 5_000));
  assert.deepEqual(b, { error: "busy" });
  assert.equal(n, POOL_SELL_DRY_WAIT_MS / 250);
  const never: string[] = [];
  await poolSellDry(deps({ log: never, busy: () => true }), share(MINT, 5_000));
  assert.deepEqual(never, [], "no provider read while a trade runs");
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
  const bad = poolSellDryKind(deps({ positions: async () => { throw new Error("store gone"); } }))(share(MINT, 5_000));
  await bad.after;
  assert.deepEqual(bad.answer(), { error: "down" });
});

test("the page answers it (src/main.ts): the kind on the trades' paced pair and the positions pass, a pool buy counted from its tap", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /"pool\.sell\.dry": \(params\) => poolSellDry\(params\),/);
  assert.match(main, /rpcs: \(\) => \(poolDeps\.rpcs\("solana"\)/, "the pool kinds' own pair: pageSolanaRpcs, paced with the trades");
  assert.match(main, /positions: async \(\) => \(testnet \? testnet\.positions\(\) : null\),/);
  assert.match(main, /busy: \(\) => buys\.live\(\) > 0,/);
  assert.match(main, /rent: \(\) => \(hasSolana \? rent\.get\(\) : null\),/, "the page's own Rent sysvar read");
  assert.match(main, /const buys = liveBuys\(poolKindMap\["pool\.buy"\]\);\n  poolKindMap\["pool\.buy"\] = buys\.kind;/);
});

test("a pool buy is live from its tap to its run's final stage, through an early \"sent\" answer; a refusal ends it; the backstop ends one with no end", async () => {
  const ctx = (seen: string[]) => ({ id: "b1", sha: "s", progress: (s: string) => void seen.push(s) }) as unknown as Parameters<ReturnType<typeof liveBuys>["kind"]>[1];
  let post!: (s: string) => void;
  let answered!: () => void;
  const b = liveBuys((_p, c) => {
    post = (s) => c.progress(s as never);
    return { running: true, after: new Promise<void>((r) => (answered = r)), answer: () => ({ result: { stage: "sent", txs: [] } }) };
  });
  const seen: string[] = [];
  b.kind({}, ctx(seen));
  assert.equal(b.live(), 1);
  answered();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(b.live(), 1, "answered sent: its read-backs still run");
  post("filled");
  assert.equal(b.live(), 0, "its final stage");
  assert.deepEqual(seen, ["filled"], "progress passes through");
  const refused = liveBuys(() => ({ error: "not_allowed" }));
  refused.kind({}, ctx([]));
  assert.equal(refused.live(), 0);
  const late = liveBuys(() => ({ running: true, after: new Promise<void>(() => {}), answer: () => null }), 5);
  late.kind({}, ctx([]));
  assert.equal(late.live(), 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(late.live(), 0, "the backstop");
});
