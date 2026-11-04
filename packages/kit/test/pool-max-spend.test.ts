// node --test packages/kit/test/pool-max-spend.test.ts: the most one ready proof can spend at the tap, one rule for the
// tap and the signing page's state.pools tap_max (card kit-pool-tap-inputs). Solana: solanaPoolBuyMaxSpend, the
// largest spend solanaPoolBuyFunds passes on the worst venue the device buys on (an EVM tap asks for a whole chunk, so
// its tap_max is the chunk: packages/wallet/src/pool/balances.ts evmTapSpendOf). Planted chunks, fees and rents only; no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
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

test("Solana: the max spend is the chunk less the fee, the tip, W's new accounts and the sell's up-front need (at 5,080 a byte, 0.1 SOL)", () => {
  const rent = RENTS[0]!;
  const fee = solanaPoolFee(rent); // 1,300,000
  const r = (n: number) => solanaRentMin(rent, n);
  // W's token account (195), the volume accumulator (137), the cashback account (165), then what the sell needs up
  // front on PumpSwap: its fee (5,000) and the wrapped-SOL account (165) it makes before any proceeds arrive
  assert.equal(solanaPoolBuyMaxSpend(release(SOL / 10n, fee), SOLANA_POOL_WORST_BUY_VENUE, SOLANA_JITO_TIP_MIN, rent), SOL / 10n - fee - SOLANA_JITO_TIP_MIN - r(195) - r(137) - r(165) - 5_000n - r(165));
});

// The review of signpage-pool-sell 4b6223a (critical): W pays its sell's fee before anything runs, and the runtime
// refuses a fee payer with no account, short of the fee, or left between 0 and rent(0) after it; PumpSwap's sell makes
// W's wrapped-SOL account (165 bytes) before any proceeds arrive. A max-spend buy left W at 0 (pump's curve) or at the
// wrapped-SOL rent (PumpSwap), so its sell could never pass simulation. The need is written out here, not read from the
// kit, so the test says what the runtime asks.
test("Solana: a max-spend buy leaves W what its sell needs up front, on both venues", () => {
  for (const rent of RENTS) {
    const fee = solanaPoolFee(rent);
    const need = { "pump-curve": 5_000n + solanaRentMin(rent, 0), pumpswap: 5_000n + solanaRentMin(rent, 165) };
    for (const chunk of CHUNKS) {
      for (const v of VENUES) {
        const max = solanaPoolBuyMaxSpend(release(chunk, fee), v, SOLANA_JITO_TIP_MIN, rent);
        if (max === 0n) continue;
        const { left } = solanaPoolBuyFunds(release(chunk, fee), venue(v), { spend: max, tip: SOLANA_JITO_TIP_MIN }, rent);
        const at = `rent ${rent.lamportsPerByte}x${rent.factor} ${JSON.stringify(v)} chunk ${chunk}`;
        assert.ok(left >= need[v.kind], `${at}: W keeps ${left}, its sell needs ${need[v.kind]}`);
        // after the fee W holds at least rent(0), never between 0 and it
        assert.ok(left - 5_000n >= solanaRentMin(rent, 0), at);
      }
    }
  }
});

test("Solana: a buy that would leave W short of its sell's up-front need is refused", () => {
  const rent = RENTS[0]!;
  const fee = solanaPoolFee(rent);
  for (const v of VENUES) {
    const max = solanaPoolBuyMaxSpend(release(SOL / 10n, fee), v, 0n, rent);
    const need = 5_000n + solanaRentMin(rent, v.kind === "pumpswap" ? 165 : 0);
    assert.equal(solanaPoolBuyFunds(release(SOL / 10n, fee), venue(v), { spend: max, tip: 0n }, rent).left, need, JSON.stringify(v));
    // a spend that leaves W 1 lamport short, the fee short, or at the old max (W at 0 on the curve, the wrapped-SOL rent
    // on PumpSwap) is refused
    const oldMax = max + (v.kind === "pumpswap" ? 5_000n : need);
    for (const spend of [max + 1n, max + 5_000n, oldMax])
      assert.match(String(solanaPoolBuyFunds(release(SOL / 10n, fee), venue(v), { spend, tip: 0n }, rent).problem), /its sell needs up front/, `${JSON.stringify(v)} spend ${spend}`);
  }
});

test("Solana: never below 0: a chunk the fee, the tip and the accounts eat is 0", () => {
  const rent = RENTS[0]!;
  for (const chunk of [0n, 1n, 1_300_000n, 5_000_000n]) assert.equal(solanaPoolBuyMaxSpend(release(chunk, solanaPoolFee(rent)), SOLANA_POOL_WORST_BUY_VENUE, SOLANA_JITO_TIP_MIN, rent), 0n, String(chunk));
});
