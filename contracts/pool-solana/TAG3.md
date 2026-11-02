# Tag 3: release and buy

The Solana pool's third instruction, for card pool-sol-buy-sell. One top-level instruction into the pool releases a
ready proof's chunk to the fresh wallet W and then runs the instructions W signed for, such as a venue's buy. W's
signer privilege is the only one carried into them. The pool never signs with `invoke_signed`. Any venue W signed for
works, and the venue's program id is an account of this instruction, so it loads from our lookup table.

Written by card sol-pool-buy-tx; the program has it since card pool-sol-buy-sell (`src/buy.rs`). Every Solana buy is
tag 3 with the compressed proof: the kit builds and checks only this (`packages/kit/src/trade/solana/pool-buy.ts`,
`buildSolanaPoolBuy`, `checkSolanaPoolBuy`), and the helper carries only compute budget plus one pool tag 2 or tag 3
instruction (card helper-pool-senders).

## Why

Tag 2 plus the buy as its own top-level instruction (shape A, no longer built) landed on pump, but every program it
invokes at the top level must be a static key, because a v0 message cannot invoke a program it loads from
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
   - An inner account, or the tip account, that is the pool, its spent mark or a page this release reads or writes
     (by key: the keys of accounts 0, 3, 4, 5 and 6, at whatever index they appear again), or any account this
     program owns (by owner), refuses with `InnerNamesPoolAccount`.
   - An inner account that signed this instruction and is not W (by key) refuses with `InnerSignerNotW`. The fee
     payer's signature never reaches a venue, so a venue cannot debit the relayer.
3. Pay, from the pool's own lamports: `withdrawnValue - relay_fee - tip` to W, `relay_fee` to the fee payer and `tip`
   to account 8. `spent += withdrawnValue`. Then a 0-lamport system transfer from W to the pool, naming the fee payer
   and the tip account, so the runtime sees those balances before any venue runs.
4. Each inner instruction runs in order with `invoke`, never `invoke_signed`. A failing inner instruction fails the
   whole transaction, which undoes the release and its spent mark with it.

The device checks everything else before W signs (`checkSolanaPoolBuy`): the message carries the device's own
blockhash; it is exactly CU limit, CU price and this instruction; every inner instruction is rebuilt from the user's
own request and the venue's accounts read on two RPCs and compared as the pool will run it (program, data, keys,
signer only on W, writable as the message gives it); the tip goes to a Jito tip account; the chunk
(`withdrawnValue - relay_fee - tip`) covers the spend, W's token account (its Token-2022 size read from the mint), the
venue's volume account and, on PumpSwap, the wrapped-SOL account at its peak, leaving W 0 or at least rent(0), on the
Rent sysvar read on two RPCs; and the buy's minimum out holds against the reserves read at most 25 slots before. W's
signature covers every byte and every account, so a relayer cannot change an inner instruction, add one or point the
tip elsewhere.

## Limits it stays under

- CPI depth: pool, then the venue, then the venue's own event self-CPI or a token CPI, is depth 3, under the limit of
  4. The ATA program's create reaches the token and system programs at depth 3.
- Compute: 300,000 CU on pump and 400,000 on PumpSwap, the kit's `SOLANA_POOL_BUY_CU`. Measured in LiteSVM on copies
  of mainnet's programs and accounts with the compressed proof (`packages/kit/test/svm/pool-buy.svm.mjs`,
  2026-11-02 22:50Z): pump 244,485 CU in all with a tip (pump 68,203, its fee program 2,170); PumpSwap 293,144
  (PumpSwap 89,050, fee program 2,116).

## Sizes

Bytes of the signed v0 transaction: 2 signatures, our lookup table holding the pool, its pages and every program-wide
venue account. From `packages/kit/test/solana-pool-buy.test.ts` on the venues read from mainnet on 2026-11-02, and the
same in the LiteSVM run that landed each one.

| Venue | Proof | No tip | With Jito tip | Fits 1,232 |
|---|---|---|---|---|
| pump | compressed | 977 | 979 | yes / yes |
| PumpSwap | compressed | 1,134 | 1,136 | yes / yes |

The raw proof adds 128 B: pump 1,105 / 1,107 and PumpSwap 1,262 / 1,264, over 1,232, so the kit sends only the
compressed proof. PumpSwap's inner instructions are: create W's wSOL account, move the spend into it, SyncNative,
create W's token account, `buy_exact_quote_in`, then close the wSOL account. The venue's remaining accounts are the
`pool-v2` PDA and a buyback recipient with its wSOL account, plus a cashback account on a cashback coin. A cashback
coin adds one static key, 33 B more, and stays under 1,232.
