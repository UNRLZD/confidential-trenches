# Tag 3: release and buy

The Solana pool's third instruction, for card pool-sol-buy-sell. One top-level instruction into the pool releases a
ready proof's chunk to the fresh wallet W and then runs the instructions W signed for, such as a venue's buy. W's
signer privilege is the only one carried into them. The pool never signs with `invoke_signed`. Any venue W signed for
works, and the venue's program id is an account of this instruction, so it loads from our lookup table.

Written by card sol-pool-buy-tx. The kit builds this layout today, for its size only, in
`packages/kit/src/trade/solana/pool-buy.ts` (`solanaEncodePoolTag3`, `buildSolanaPoolBuyTag3`). Until the program has
tag 3, the kit sends shape A: tag 2, then the venue's buy as its own top-level instruction.

## Why

Shape A (tag 2 plus a top-level buy) works and has landed in LiteSVM on a copy of mainnet's pump program. Every
program it invokes at the top level must be a static key, because a v0 message cannot invoke a program it loads from
a lookup table. On PumpSwap, the venue, the token program for the wrap, the ATA program and the system program are
all static keys, and the transaction is 1,346 B without a tip and 1,364 B with one, over 1,232. Tag 3 invokes only
the pool at the top level (besides the compute budget), so every venue account and program loads from the table.

## Data

Integers are little-endian. Field elements are 32 bytes, big-endian, below p, as in tag 2.

| Offset (raw / compressed proof) | Bytes | Field |
|---|---|---|
| 0 | 1 | tag = 3 |
| 1 | 1 | flags: bit 0 set = compressed proof; every other bit must be 0 |
| 2 | 256 / 128 | proof: A, B (Fq2 imaginary part first), C. Compressed: the alt_bn128 compressed forms of A (32), B (64), C (32) |
| 258 / 130 | 32 | newCommitmentHash |
| 290 / 162 | 32 | existingNullifierHash |
| 322 / 194 | 8 | withdrawnValue u64 |
| 330 / 202 | 4 | stateRootIndex u32 |
| 334 / 206 | 1 | stateTreeDepth u8 |
| 335 / 207 | 4 | labelRootIndex u32 |
| 339 / 211 | 1 | labelTreeDepth u8 |
| 340 / 212 | 8 | relay_fee u64 |
| 348 / 220 | 8 | relay_fee_cap u64 |
| 356 / 228 | 8 | tip_cap u64 |
| 364 / 236 | 8 | deadline_ms u64 |
| 372 / 244 | 16 | salt |
| 388 / 260 | 8 | tip u64 (lamports) |
| 396 / 268 | 1 | inner count, 1 to 8 |
| 397 / 269 | ... | each inner instruction, in order: program u8 (an index into this instruction's accounts) ‖ n u8 ‖ n account indexes u8 ‖ data length u16 ‖ data |

Bytes 2 to 387 (raw) are tag 2's data after its tag byte, unchanged. The data must end exactly after the last inner
instruction.

## Accounts

| Index | Account | Flags |
|---|---|---|
| 0 to 7 | tag 2's: pool (w); W (w, signer); fee payer (w, signer); spent mark `["spent", nullifier]` (w); state root page; label root page; current state page (w); system program | as tag 2 |
| 8 | the tip account, present only when tip > 0 | w |
| 8 or 9 onward | every account the inner instructions name, each once, including each inner instruction's program | the union of what the inner instructions ask |

An inner instruction's account is given to the callee with this instruction's flags for it: signer only if it is W,
and writable as the outer account is.

## What the program does

1. Rows 1 to 13 of tag 2 (`src/release.rs`), unchanged, on bytes 2 onward. The context is computed as for tag 2, so
   `tip_cap` is already bound in the proof. With bit 0 set, the proof is decompressed with
   `alt_bn128_g1_decompress` and `alt_bn128_g2_decompress` before the same Groth16 check. The research measured
   +14,923 CU for this (`docs/research/arch-v2/solana-pool.md` S3).
2. New refusals, all before the first write:
   - `tip > tip_cap` refuses with `TipOverCap`.
   - `relay_fee + tip > withdrawnValue` refuses with `InvalidWithdrawalAmount`. The backstop already keeps `relay_fee`
     at most half of `withdrawnValue`.
   - Flags with any bit other than bit 0 set, an inner count of 0 or more than 8, or an index past the accounts refuse
     with `InvalidInstructionData`.
   - An inner program that is this program refuses with `InnerInvokesPool`, so the pool never re-enters itself.
   - An inner instruction that names account 0, 3, 4, 5 or 6 (the pool and its marks and pages) refuses with
     `InnerNamesPoolAccount`.
   - An inner account that is a signer and is not W refuses with `InnerSignerNotW`. The fee payer's signature never
     reaches a venue, so a venue cannot debit the relayer.
3. Pay, from the pool's own lamports: `withdrawnValue - relay_fee - tip` to W, `relay_fee` to the fee payer and `tip`
   to account 8. `spent += withdrawnValue`.
4. Each inner instruction runs in order with `invoke`, never `invoke_signed`. A failing inner instruction fails the
   whole transaction, which undoes the release and its spent mark with it.

The device checks everything else before W signs. It rebuilds every inner instruction from the user's own request and
the venue's accounts read on two RPCs, and checks the buy's minimum out against the reserves (`checkSolanaPoolBuy`).
W's signature covers every byte and every account, so a relayer cannot change an inner instruction, add one or point
the tip elsewhere.

## Limits it stays under

- CPI depth: pool, then the venue, then the venue's own event self-CPI or a token CPI, is depth 3, under the limit of
  4. The ATA program's create reaches the token and system programs at depth 3.
- Compute: 300,000 CU on pump and 400,000 on PumpSwap, the kit's `SOLANA_POOL_BUY_CU`. Measured in LiteSVM for shape
  A on pump: 216,440 CU in all, with the release at 125,373 and pump at 72,018 plus 2,170 in the fee program.

## Sizes

These are bytes of the signed v0 transaction: 2 signatures, our lookup table holding the pool, its pages and every
program-wide venue account. They come from `packages/kit/test/solana-pool-buy.test.ts` on the venues read from
mainnet on 2026-11-02.

| Shape | Venue | Proof | No tip | With Jito tip | Fits 1,232 |
|---|---|---|---|---|---|
| A (tag 2 + top-level buy) | pump | raw | 1,138 | 1,187 | yes / yes |
| A | PumpSwap | raw | 1,346 | 1,364 | no / no |
| B (tag 3) | pump | raw | 1,105 | 1,107 | yes / yes |
| B | pump | compressed | 977 | 979 | yes / yes |
| B | PumpSwap | raw | 1,262 | 1,264 | no / no |
| B | PumpSwap | compressed | 1,134 | 1,136 | yes / yes |

So PumpSwap needs tag 3 with the compressed proof. Its inner instructions are: create W's wSOL account, move the
spend into it, SyncNative, create W's token account, `buy_exact_quote_in`, then close the wSOL account. The venue's
remaining accounts are the `pool-v2` PDA and a buyback recipient with its wSOL account, plus a cashback account on a
cashback coin. A cashback coin adds one static key, 33 B more, and stays under 1,232.
