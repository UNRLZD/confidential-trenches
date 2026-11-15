/// <reference types="node" />
// A coin whose SOL pool is a Raydium CPMM or AMM v4 pool gets a device reference (card
// solana-buy-reaches-raydium-and-meteora). Replays HIGH's CPMM pool CqvMZmWD… (test/vectors/high-cpmm.json) and
// CzLSuj…'s AMM v4 pool 9Tb2ohu5… (test/vectors/czlsuj-amm-v4.json) as two mainnet providers answered them on 15 Nov,
// and holds E to the program's own out for the same trade (simulateTransaction on mainnet of the kit's own buy and sell
// steps, sigVerify false, nothing sent: CPMM's SwapEvent, AMM v4's ray_log) to the unit, for a buy, a 1 SOL leg and a
// sell. The recorded simulations also hold the min out at E (passes) and E + 1 (ExceededSlippage: CPMM's custom 6005,
// AMM v4's 30). Recorded by a script that read the pool on both providers, priced it here, simulated, then read the pool
// again on provider A to find its bytes unchanged (poolUnchanged). Bad: reserves outside the band and static bytes
// that differ refuse the route; a disabled or not yet open pool, a coin with an extension not priced and a pool of
// another coin are no candidate. Only pool.ts is imported, so at b6657467d this fails for the reason the card names: a
// Raydium coin had no reference pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import { readSolanaReferenceWhy } from "../src/trade/solana/pool.ts";
import type { SolanaRpc } from "../src/trade/solana/send.ts";

type Acc = { owner: string; data: string } | null;
type Provider = { slot: number; accounts: Record<string, Acc> };
type Vector = {
  kind: "raydium-cpmm" | "raydium-amm-v4"; mint: string; pool: string; sellAmount: string; poolUnchanged: boolean;
  providers: Record<string, Provider>;
  programOut: Record<string, { E: string; atE: { err: unknown; program: { received: string } }; atE1: { err: unknown } }>;
};
const load = (f: string) => JSON.parse(readFileSync(new URL(`./vectors/${f}`, import.meta.url), "utf8")) as Vector;
const VECTORS = [load("high-cpmm.json"), load("czlsuj-amm-v4.json")];
const field = (v: Vector) => (v.kind === "raydium-cpmm" ? "cpmmPools" : "ammV4Pools");
const SLIPPAGE = { "raydium-cpmm": { Custom: 6005 }, "raydium-amm-v4": { Custom: 30 } } as const;

function replay(p: Provider, edit: (addr: string, data: Uint8Array) => Uint8Array = (_a, d) => d): SolanaRpc {
  return (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    return {
      context: { slot: p.slot },
      value: (params[0] as string[]).map((a) => {
        const x = p.accounts[a];
        return x ? { owner: x.owner, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(edit(a, base64.decode(x.data))), "base64"] } : null;
      }),
    };
  }) as SolanaRpc;
}
const pair = (v: Vector, ea?: (a: string, d: Uint8Array) => Uint8Array, eb = ea) => {
  const [a, b] = Object.values(v.providers) as [Provider, Provider];
  return [replay(a, ea), replay(b, eb)] as const;
};
const req = (v: Vector, side: "buy" | "sell", amount: bigint, extra: Record<string, unknown> = {}) => ({ side, token: v.mint, amount, [field(v)]: [v.pool], ...extra });
const edit = (addr: string, at: Record<number, number>) => (a: string, d: Uint8Array) => (a === addr ? Object.assign(d.slice(), at) : d);
// the pool's bytes: CPMM status at 329 (bit 2 disables swaps), open_time u64 at 373; AMM v4 status u64 at 0, pool_open_time u64 at 224
const STATUS = { "raydium-cpmm": { [329]: 4 }, "raydium-amm-v4": { [0]: 4 } } as const;
const LATE = { "raydium-cpmm": 373, "raydium-amm-v4": 224 } as const;

for (const v of VECTORS) {
  test(`${v.kind}: the buy and the sell get the device's reference, equal to the program's own out on mainnet to the unit`, async () => {
    assert.ok(v.poolUnchanged, "the pool's bytes changed between the read and the simulation");
    const buy = await readSolanaReferenceWhy(pair(v), req(v, "buy", 100_000_000n, { amounts: [1_000_000_000n] }));
    assert.ok("reference" in buy, `no reference: ${"refused" in buy ? buy.refused : ""}`);
    assert.equal(buy.reference.expectedOut, BigInt(v.programOut["buy 100000000"]!.atE.program.received));
    assert.deepEqual(buy.reference.expectedOuts, [BigInt(v.programOut["buy 1000000000"]!.atE.program.received)]);
    assert.deepEqual(buy.reference.pools.map((p) => [p.venue, p.address]), [[v.kind, v.pool]]);
    const [pa, pb] = Object.values(v.providers) as [Provider, Provider];
    assert.equal(buy.reference.slot, Math.min(pa.slot, pb.slot));
    const sell = await readSolanaReferenceWhy(pair(v), req(v, "sell", BigInt(v.sellAmount)));
    assert.ok("reference" in sell, `no reference: ${"refused" in sell ? sell.refused : ""}`);
    assert.equal(sell.reference.expectedOut, BigInt(v.programOut[`sell ${v.sellAmount}`]!.atE.program.received));
  });

  test(`${v.kind}: in the recorded simulations the min out holds at E and fails at E + 1 (ExceededSlippage)`, () => {
    for (const [name, o] of Object.entries(v.programOut)) {
      assert.equal(o.atE.err, null, name);
      assert.equal(o.atE.program.received, o.E, name);
      const e = o.atE1.err as { InstructionError: [number, unknown] };
      assert.deepEqual(e.InstructionError[1], SLIPPAGE[v.kind], name);
    }
  });

  test(`${v.kind}: without its pool the coin has no reference pool (what b6657467d answered for every Raydium coin)`, async () => {
    assert.deepEqual(await readSolanaReferenceWhy(pair(v), { side: "buy", token: v.mint, amount: 100_000_000n }), { refused: "no reference pool" });
  });

  test(`${v.kind}: a vault outside the band on one provider, or a static byte that differs, refuses the route after the re-read`, async () => {
    const pool = Object.values(v.providers)[0]!.accounts[v.pool]!;
    const d = base64.decode(pool.data);
    const vaultAt = v.kind === "raydium-cpmm" ? 72 : 368; // token_0_vault / pc_vault
    const vault = (await import("@scure/base")).base58.encode(d.subarray(vaultAt, vaultAt + 32));
    const fat = (a: string, x: Uint8Array) => {
      if (a !== vault) return x;
      const c = x.slice();
      const dv = new DataView(c.buffer);
      dv.setBigUint64(64, (dv.getBigUint64(64, true) * 105n) / 100n, true);
      return c;
    };
    const r = await readSolanaReferenceWhy(pair(v, undefined, fat), req(v, "buy", 100_000_000n));
    assert.ok("refused" in r && /reserves are outside the band, after a re-read/.test(r.refused), JSON.stringify(r));
    // a fee byte: CPMM's mint_0_decimals (331), AMM v4's swap_fee_numerator (176)
    const at = v.kind === "raydium-cpmm" ? 331 : 176;
    const flip = (a: string, x: Uint8Array) => (a === v.pool ? Object.assign(x.slice(), { [at]: x[at]! ^ 1 }) : x);
    const s = await readSolanaReferenceWhy(pair(v, undefined, flip), req(v, "buy", 100_000_000n));
    assert.ok("refused" in s && /static bytes differ/.test(s.refused), JSON.stringify(s));
  });

  test(`${v.kind}: a pool that does not swap, one not open yet, and another coin's pool are no candidate`, async () => {
    const off = edit(v.pool, STATUS[v.kind]);
    assert.deepEqual(await readSolanaReferenceWhy(pair(v, off), req(v, "buy", 1_000_000n)), { refused: "no reference pool" });
    // open time far ahead; on AMM v4 only a WaitingTrade pool (status 7) waits for it
    const late = (a: string, x: Uint8Array) => {
      if (a !== v.pool) return x;
      const c = x.slice();
      new DataView(c.buffer).setBigUint64(LATE[v.kind], 1n << 40n, true);
      if (v.kind === "raydium-amm-v4") new DataView(c.buffer).setBigUint64(0, 7n, true);
      return c;
    };
    assert.deepEqual(await readSolanaReferenceWhy(pair(v, late), req(v, "buy", 1_000_000n)), { refused: "no reference pool" });
    assert.deepEqual(await readSolanaReferenceWhy(pair(v), { ...req(v, "buy", 1_000_000n), token: base58.encode(new Uint8Array(32).fill(9)) }), { refused: "no reference pool" });
  });

  test(`${v.kind}: a pool list over the cap, or a pool that is not an address, is refused before any read`, async () => {
    const many = Array.from({ length: 9 }, (_, i) => v.pool.slice(0, 40) + String(i).padStart(4, "A"));
    await assert.rejects(readSolanaReferenceWhy(pair(v), req(v, "buy", 1n, { [field(v)]: many })), /at most 8 (CPMM|AMM v4) pools/);
    await assert.rejects(readSolanaReferenceWhy(pair(v), req(v, "buy", 1n, { [field(v)]: ["not-a-key"] })));
  });
}

// Only the scan's first read of a pool lies (the read that names the pool alone, which plans the second read's account
// list in pool.ts lookScanned); every later read on both providers is honest. Any token account of a mint can be made out
// to a venue's program-wide authority, so a list naming one passes the vault's mint and owner check: the list must be the
// one the agreed pool bytes name (review of 7637cce9f: E cut by 99.3% on CPMM, 85% on AMM v4 before).
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const AUTHORITY = { "raydium-cpmm": "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL", "raydium-amm-v4": "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1" } as const;
// the pool's bytes: CPMM amm_config 8, vault0 72, vault1 104, mint0 168, mint1 200, program0 232, program1 264; AMM v4
// coin_vault 336, pc_vault 368, coin mint 400, pc mint 432 (SPL Token only)
const LAYOUT = { "raydium-cpmm": { vaults: [72, 104], mints: [168, 200] }, "raydium-amm-v4": { vaults: [336, 368], mints: [400, 432] } } as const;
const madeUp = (k: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + k) & 0xff));
const tokenAccount = (mint: string, owner: string, amount: bigint): string => {
  const d = new Uint8Array(165);
  d.set(base58.decode(mint), 0);
  d.set(base58.decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  return base64.encode(d);
};
/** Provider p with `extra` accounts on the chain, the pool's bytes edited by `head` in the read that names the pool
 *  alone, and by `every` in every read. */
function lying(p: Provider, pool: string, extra: Record<string, Acc>, head: ((d: Uint8Array) => Uint8Array) | null, every: ((d: Uint8Array) => Uint8Array) | null = null): SolanaRpc {
  const q: Provider = { slot: p.slot, accounts: { ...p.accounts, ...extra } };
  return (async (method: string, params: readonly unknown[]) => {
    const list = params[0] as string[];
    const isHead = list.length === 1 && list[0] === pool;
    const edit = (a: string, d: Uint8Array) => (a !== pool ? d : isHead && head ? head(d) : every ? every(d) : d);
    return replay(q, edit)(method as never, params as never);
  }) as SolanaRpc;
}
const facts = (v: Vector) => {
  const [pa, pb] = Object.values(v.providers) as [Provider, Provider];
  const pool = base64.decode(pa.accounts[v.pool]!.data);
  const key = (o: number) => base58.encode(pool.subarray(o, o + 32));
  const L = LAYOUT[v.kind];
  const sol = key(L.mints[0]) === SOL_MINT ? 0 : 1;
  const coin = 1 - sol;
  const coinProgram = v.kind === "raydium-cpmm" ? key([232, 264][coin]!) : TOKEN_PROGRAM;
  const vaultOf = (i: number) => key(L.vaults[i]!);
  const amountOf = (addr: string) => new DataView(base64.decode(pa.accounts[addr]!.data).buffer).getBigUint64(64, true);
  const put = (at: number, addr: string) => (d: Uint8Array) => { const c = d.slice(); c.set(base58.decode(addr), at); return c; };
  return { pa, pb, pool, L, sol, coin, coinProgram, vaultOf, amountOf, put };
};

for (const v of VECTORS) {
  test(`${v.kind}: a first read of the pool alone on one provider that names another SOL vault (buy) or coin vault (sell) of the venue's authority refuses the route`, async () => {
    const f = facts(v);
    const FAKE_SOL = madeUp(3);
    const FAKE_COIN = madeUp(5);
    const extra: Record<string, Acc> = {
      [FAKE_SOL]: { owner: TOKEN_PROGRAM, data: tokenAccount(SOL_MINT, AUTHORITY[v.kind], f.amountOf(f.vaultOf(f.sol)) * 1_000n) },
      [FAKE_COIN]: { owner: f.coinProgram, data: tokenAccount(v.mint, AUTHORITY[v.kind], f.amountOf(f.vaultOf(f.coin)) * 1_000n) },
    };
    const honest = [lying(f.pa, v.pool, extra, null), lying(f.pb, v.pool, extra, null)] as const;
    for (const [side, amount, at, fake] of [["buy", 100_000_000n, f.L.vaults[f.sol]!, FAKE_SOL], ["sell", BigInt(v.sellAmount), f.L.vaults[f.coin]!, FAKE_COIN]] as const) {
      const h = await readSolanaReferenceWhy(honest, req(v, side, amount));
      assert.ok("reference" in h, `${side}: honest reads give no reference: ${"refused" in h ? h.refused : ""}`);
      // provider A's first read plans the list: its lie refuses the route
      const r = await readSolanaReferenceWhy([lying(f.pa, v.pool, extra, f.put(at, fake)), lying(f.pb, v.pool, extra, null)], req(v, side, amount));
      assert.ok("refused" in r && /accounts that are not the pool's own, after a re-read/.test(r.refused), `${side}: ${"reference" in r ? `E ${r.reference.expectedOut} (honest ${h.reference.expectedOut})` : r.refused}`);
      // provider B's first read plans nothing once A's does: its lie moves nothing
      const rb = await readSolanaReferenceWhy([lying(f.pa, v.pool, extra, null), lying(f.pb, v.pool, extra, f.put(at, fake))], req(v, side, amount));
      assert.ok("reference" in rb && rb.reference.expectedOut === h.reference.expectedOut, `${side}, B lies first: ${"refused" in rb ? rb.refused : rb.reference.expectedOut}`);
    }
  });

  test(`${v.kind}: a first read of the pool alone on one provider that swaps its two vaults, or names another coin's mint, never hides the pool`, async () => {
    const f = facts(v);
    const h = await readSolanaReferenceWhy([lying(f.pa, v.pool, {}, null), lying(f.pb, v.pool, {}, null)], req(v, "buy", 100_000_000n));
    assert.ok("reference" in h);
    // the vaults swapped in that first read: the list names them in the other order, refused
    const swap = (d: Uint8Array) => f.put(f.L.vaults[1]!, f.vaultOf(0))(f.put(f.L.vaults[0]!, f.vaultOf(1))(d));
    const s = await readSolanaReferenceWhy([lying(f.pa, v.pool, {}, swap), lying(f.pb, v.pool, {}, null)], req(v, "buy", 100_000_000n));
    assert.ok("refused" in s && /not the pool's own|another mint or owner/.test(s.refused), "refused" in s ? s.refused : "a reference");
    // another coin's mint in provider A's first read only: provider B's first read plans the read, both agree, the same E
    const other = (d: Uint8Array) => Object.assign(d.slice(), Object.fromEntries(Array.from({ length: 32 }, (_, i) => [f.L.mints[f.coin]! + i, 9])));
    const once = await readSolanaReferenceWhy([lying(f.pa, v.pool, {}, other), lying(f.pb, v.pool, {}, null)], req(v, "buy", 100_000_000n));
    assert.ok("reference" in once, `hidden by one first read: ${"refused" in once ? once.refused : ""}`);
    assert.equal(once.reference.expectedOut, h.reference.expectedOut);
    // in every read of provider A: the providers disagree on the pool, refused (never "no reference pool")
    const always = await readSolanaReferenceWhy([lying(f.pa, v.pool, {}, other, other), lying(f.pb, v.pool, {}, null)], req(v, "buy", 100_000_000n));
    assert.ok("refused" in always && /static bytes differ, after a re-read/.test(always.refused), "refused" in always ? always.refused : "a reference");
  });
}

test("raydium-cpmm: a first read of the pool alone on one provider that names another AmmConfig (a higher fee tier) refuses the route", async () => {
  const v = VECTORS[0]!;
  const f = facts(v);
  const cfgAddr = base58.encode(f.pool.subarray(8, 40));
  const real = f.pa.accounts[cfgAddr]!;
  const d = base64.decode(real.data).slice();
  new DataView(d.buffer).setBigUint64(12, 100_000n, true); // trade_fee_rate 10%
  const FAKE_CFG = madeUp(11);
  const extra = { [FAKE_CFG]: { owner: real.owner, data: base64.encode(d) } };
  for (const side of ["buy", "sell"] as const) {
    const amount = side === "buy" ? 100_000_000n : BigInt(v.sellAmount);
    const r = await readSolanaReferenceWhy([lying(f.pa, v.pool, extra, f.put(8, FAKE_CFG)), lying(f.pb, v.pool, extra, null)], req(v, side, amount));
    assert.ok("refused" in r && /accounts that are not the pool's own, after a re-read/.test(r.refused), `${side}: ${"reference" in r ? `E ${r.reference.expectedOut}` : r.refused}`);
  }
});

test("raydium-cpmm: a Token-2022 coin with an extension the reference does not price is no candidate; its transfer fee is priced", async () => {
  const { solanaCpmmTradeOut } = await import("../src/trade/solana/cpmm.ts");
  const pool = { ammConfig: "", vault0: "", vault1: "", mint0: "", mint1: "", program0: "", program1: "", observation: "", status: 0, fees0: 0n, fees1: 0n, openTime: 0n, creatorFeeOn: 0, creatorFeeEnabled: false };
  const cfg = { tradeFeeRate: 2_500n, protocolFeeRate: 0n, fundFeeRate: 0n, creatorFeeRate: 0n };
  // a buy of 1,000,000 lamports into 1e12 / 1e12: fee ceil(2,500) = 2,500, out floor(997,500 × 1e12 / (1e12 + 997,500)) = 997,499
  assert.equal(solanaCpmmTradeOut(pool, cfg, "buy", 1_000_000n, true, 10n ** 12n, 10n ** 12n, null), 997_499n);
  // the coin's 3% transfer fee comes off what W receives (ceil(997,499 × 3%) = 29,925) and off what a sell sends in
  assert.equal(solanaCpmmTradeOut(pool, cfg, "buy", 1_000_000n, true, 10n ** 12n, 10n ** 12n, { bps: 300n, max: 10n ** 18n }), 997_499n - 29_925n);
  assert.equal(solanaCpmmTradeOut(pool, cfg, "sell", 1_000_000n, true, 10n ** 12n, 10n ** 12n, { bps: 300n, max: 10n ** 18n }), solanaCpmmTradeOut(pool, cfg, "sell", 970_000n, true, 10n ** 12n, 10n ** 12n, null));
  // the creator fee on the input (creator_fee_on 0): ceil(1e6 × 3,000 / 1e6) taken from the input; on the output (mode 2, a
  // token-0 input): ceil(out × 500 / 1e6) off the swapped out
  const c = { ...cfg, creatorFeeRate: 500n };
  const onIn = { ...pool, creatorFeeEnabled: true, creatorFeeOn: 0 };
  assert.equal(solanaCpmmTradeOut(onIn, c, "buy", 1_000_000n, true, 10n ** 12n, 10n ** 12n, null), (997_000n * 10n ** 12n) / (10n ** 12n + 997_000n));
  const onOut = { ...pool, creatorFeeEnabled: true, creatorFeeOn: 2 };
  assert.equal(solanaCpmmTradeOut(onOut, c, "buy", 1_000_000n, true, 10n ** 12n, 10n ** 12n, null), 997_499n - 499n);
  // a creator fee the pool has not enabled is 0, and a mode the program refuses is no out
  assert.equal(solanaCpmmTradeOut({ ...onOut, creatorFeeEnabled: false }, c, "buy", 1_000_000n, true, 10n ** 12n, 10n ** 12n, null), 997_499n);
  assert.equal(solanaCpmmTradeOut({ ...pool, creatorFeeOn: 3 }, c, "buy", 1_000_000n, true, 10n ** 12n, 10n ** 12n, null), null);
  // fees counted in the pool come off its vaults before the price
  assert.equal(solanaCpmmTradeOut({ ...pool, fees0: 10n ** 11n }, cfg, "buy", 1_000_000n, true, 10n ** 12n + 10n ** 11n, 10n ** 12n, null), 997_499n);
});

test("raydium-cpmm: the HIGH pool with a transfer-hook Token-2022 coin in place of its mint is no candidate", async () => {
  const v = VECTORS[0]!;
  // the mint as a Token-2022 mint with a TransferHook (14) extension, on both providers, and the pool naming Token-2022
  const { SOLANA_TOKEN_2022_PROGRAM: t22 } = await import("../src/checks/solana/checks.ts");
  const { base58 } = await import("@scure/base");
  const prov = (p: Provider): Provider => {
    const accounts = { ...p.accounts };
    const m = base64.decode(accounts[v.mint]!.data);
    const d = new Uint8Array(170 + 64);
    d.set(m.subarray(0, 82));
    d[165] = 1;
    new DataView(d.buffer).setUint16(166, 14, true);
    new DataView(d.buffer).setUint16(168, 64, true);
    accounts[v.mint] = { owner: t22, data: base64.encode(d) };
    const pool = base64.decode(accounts[v.pool]!.data).slice();
    pool.set(base58.decode(t22), 264); // token_1_program: HIGH is token 1
    accounts[v.pool] = { owner: accounts[v.pool]!.owner, data: base64.encode(pool) };
    return { slot: p.slot, accounts };
  };
  const [a, b] = Object.values(v.providers) as [Provider, Provider];
  assert.deepEqual(await readSolanaReferenceWhy([replay(prov(a)), replay(prov(b))], req(v, "buy", 1_000_000n)), { refused: "no reference pool" });
});

test("raydium-amm-v4: the swap fee is ceil(in × 25 / 10,000) and the out the floor of the constant product net of each side's pnl", async () => {
  const { solanaAmmV4TradeOut } = await import("../src/trade/solana/amm-v4.ts");
  const p = { status: 6n, swapFeeNumerator: 25n, swapFeeDenominator: 10_000n, needTakePnlCoin: 5n, needTakePnlPc: 7n, openTime: 0n, coinVault: "", pcVault: "", coinMint: "", pcMint: "" };
  // a buy of 1,000,001 lamports, SOL the pc: fee ceil(2,500.0025) = 2,501; out floor(997,500 × 1e12 / (1e12 + 997,500))
  assert.equal(solanaAmmV4TradeOut(p, "buy", 1_000_001n, true, 10n ** 12n + 5n, 10n ** 12n + 7n), (997_500n * 10n ** 12n) / (10n ** 12n + 997_500n));
  assert.equal(solanaAmmV4TradeOut(p, "buy", 1n, true, 10n ** 12n, 10n ** 12n), null); // out 0: InvalidInput
  assert.equal(solanaAmmV4TradeOut({ ...p, swapFeeDenominator: 0n }, "buy", 1_000n, true, 10n ** 12n, 10n ** 12n), null);
  assert.equal(solanaAmmV4TradeOut(p, "buy", 1_000n, true, 4n, 10n ** 12n), null); // a vault under its pnl
});
