// node --test packages/kit/test/pool-max-spend.test.ts: the most one ready proof can spend at the tap, one rule for the
// tap and the signing page's state.pools tap_max (card kit-pool-tap-inputs). Solana: solanaPoolBuyMaxSpend, the
// largest spend solanaPoolBuyFunds passes on the worst venue the device buys on; EVM: evmPoolBuyMaxSpend, the chunk less
// the most the relayer may take. Planted chunks, fees and rents only; no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVM_POOL_MAX_RELAY_FEE_BPS,
  evmPoolBuyMaxSpend,
  SOLANA_JITO_TIP_MIN,
  SOLANA_POOL_WORST_BUY_VENUE,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_ACCOUNT_MAX_SIZE,
  solanaPoolBuyFunds,
  solanaPoolBuyMaxSpend,
  solanaPoolFee,
  solanaRentMin,
  solanaTokenAccountSize,
  type SolanaPoolBuyVenue,
  type SolanaPoolRelease,
  type SolanaRent,
} from "../src/index.ts";

const RENTS: SolanaRent[] = [{ lamportsPerByte: 5_080n, factor: 1n }, { lamportsPerByte: 3_480n, factor: 2n }, { lamportsPerByte: 6_960n, factor: 1n }];
const SOL = 1_000_000_000n;
const CHUNKS = [10_000_000n, 20_000_000n, 50_000_000n, SOL / 10n, SOL, 7n * SOL + 123n, 1_000n * SOL];
const release = (withdrawnValue: bigint, relayFee: bigint) => ({ withdrawnValue, relayFee }) as SolanaPoolRelease;
/** A venue for solanaPoolBuyFunds, which reads its kind, token account size and cashback flag. */
const venue = (v: { kind: "pump-curve" | "pumpswap"; tokenAccountSize: number; cashback: boolean }) => v as unknown as SolanaPoolBuyVenue;
/** Every venue shape the kit's venue reader admits: both kinds, cashback or not, each token account size it computes. */
// Token: 165; Token-2022: 170 (type byte, ImmutableOwner) and 4 + each extra the mint's extensions ask (8, 0, 1, 0)
const SIZES = [165, ...new Set(Array.from({ length: 16 }, (_, m) => 170 + [12, 4, 5, 4].reduce((s, x, i) => s + (m & (1 << i) ? x : 0), 0)))];
const VENUES = (["pump-curve", "pumpswap"] as const).flatMap((kind) => [false, true].flatMap((cashback) => SIZES.map((tokenAccountSize) => ({ kind, tokenAccountSize, cashback }))));

test("the worst venue: PumpSwap with cashback and the largest token account the venue reader admits (195 bytes)", () => {
  assert.deepEqual({ ...SOLANA_POOL_WORST_BUY_VENUE }, { kind: "pumpswap", tokenAccountSize: 195, cashback: true });
  assert.equal(SOLANA_TOKEN_ACCOUNT_MAX_SIZE, 195);
  // a Token-2022 mint with each of the four extensions that add to a new account: TransferFeeConfig, NonTransferable,
  // TransferHook, Pausable (each once: Token-2022 holds one of each type)
  const d = new Uint8Array(166 + 4 * 4);
  d[165] = 1;
  [1, 9, 14, 26].forEach((type, i) => (d[166 + 4 * i] = type));
  assert.equal(solanaTokenAccountSize({ owner: SOLANA_TOKEN_2022_PROGRAM, data: d }), SOLANA_TOKEN_ACCOUNT_MAX_SIZE);
  for (const v of VENUES) assert.ok(v.tokenAccountSize <= SOLANA_TOKEN_ACCOUNT_MAX_SIZE);
});

test("Solana: the max spend passes solanaPoolBuyFunds on the worst venue, and one lamport more fails it", () => {
  for (const rent of RENTS) {
    const fee = solanaPoolFee(rent);
    for (const chunk of CHUNKS) {
      for (const tip of [0n, SOLANA_JITO_TIP_MIN]) {
        const max = solanaPoolBuyMaxSpend(release(chunk, fee), SOLANA_POOL_WORST_BUY_VENUE, tip, rent);
        const at = `rent ${rent.lamportsPerByte}x${rent.factor} chunk ${chunk} tip ${tip}`;
        if (max === 0n) {
          assert.notEqual(solanaPoolBuyFunds(release(chunk, fee), venue(SOLANA_POOL_WORST_BUY_VENUE), { spend: 1n, tip }, rent).problem, null, at);
          continue;
        }
        assert.equal(solanaPoolBuyFunds(release(chunk, fee), venue(SOLANA_POOL_WORST_BUY_VENUE), { spend: max, tip }, rent).problem, null, at);
        assert.notEqual(solanaPoolBuyFunds(release(chunk, fee), venue(SOLANA_POOL_WORST_BUY_VENUE), { spend: max + 1n, tip }, rent).problem, null, `${at}: max + 1`);
      }
    }
  }
});

test("Solana: the worst venue's max spend passes on every venue the reader admits, and each venue's own max is at least it", () => {
  for (const rent of RENTS) {
    const fee = solanaPoolFee(rent);
    for (const chunk of CHUNKS) {
      const max = solanaPoolBuyMaxSpend(release(chunk, fee), SOLANA_POOL_WORST_BUY_VENUE, SOLANA_JITO_TIP_MIN, rent);
      if (max === 0n) continue;
      for (const v of VENUES) {
        const at = `${JSON.stringify(v)} chunk ${chunk}`;
        assert.equal(solanaPoolBuyFunds(release(chunk, fee), venue(v), { spend: max, tip: SOLANA_JITO_TIP_MIN }, rent).problem, null, at);
        const own = solanaPoolBuyMaxSpend(release(chunk, fee), v, SOLANA_JITO_TIP_MIN, rent);
        assert.ok(own >= max, at);
        assert.equal(solanaPoolBuyFunds(release(chunk, fee), venue(v), { spend: own, tip: SOLANA_JITO_TIP_MIN }, rent).problem, null, `${at}: own max`);
        assert.notEqual(solanaPoolBuyFunds(release(chunk, fee), venue(v), { spend: own + 1n, tip: SOLANA_JITO_TIP_MIN }, rent).problem, null, `${at}: own max + 1`);
      }
    }
  }
});

test("Solana: the max spend is the chunk less the fee, the tip and W's new accounts (at 5,080 a byte, 0.1 SOL)", () => {
  const rent = RENTS[0]!;
  const fee = solanaPoolFee(rent); // 1,300,000
  const r = (n: number) => solanaRentMin(rent, n);
  // W's token account (195), the volume accumulator (137), the cashback account (165), the wrapped-SOL account (165)
  assert.equal(solanaPoolBuyMaxSpend(release(SOL / 10n, fee), SOLANA_POOL_WORST_BUY_VENUE, SOLANA_JITO_TIP_MIN, rent), SOL / 10n - fee - SOLANA_JITO_TIP_MIN - r(195) - r(137) - r(165) - r(165));
});

test("Solana: never below 0: a chunk the fee, the tip and the accounts eat is 0", () => {
  const rent = RENTS[0]!;
  for (const chunk of [0n, 1n, 1_300_000n, 5_000_000n]) assert.equal(solanaPoolBuyMaxSpend(release(chunk, solanaPoolFee(rent)), SOLANA_POOL_WORST_BUY_VENUE, SOLANA_JITO_TIP_MIN, rent), 0n, String(chunk));
});

test("EVM: the max spend is the chunk less the most the relayer may take: the fee cap, or the pool's 50% backstop", () => {
  assert.equal(EVM_POOL_MAX_RELAY_FEE_BPS, 5_000n);
  const one = 10n ** 18n;
  assert.equal(evmPoolBuyMaxSpend(one, 10n ** 13n), one - 10n ** 13n);
  assert.equal(evmPoolBuyMaxSpend(one, 0n), one);
  assert.equal(evmPoolBuyMaxSpend(1_000n, 900n), 500n); // the backstop caps the fee at 500
  assert.equal(evmPoolBuyMaxSpend(1_001n, 900n), 501n); // 1,001 x 5,000 / 10,000 = 500, rounded down as the pool does
  assert.equal(evmPoolBuyMaxSpend(0n, 0n), 0n);
  for (const [c, f] of [[-1n, 0n], [1n, -1n], [1 as never, 0n], [1n, 0 as never]] as [bigint, bigint][]) assert.throws(() => evmPoolBuyMaxSpend(c, f), /chunk|fee cap/);
});
