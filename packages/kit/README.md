# @blindfill/kit

The one entry an app imports to reach Blindfill: `import { ... } from "@blindfill/kit"`, which resolves to `src/index.ts` and nothing deeper (`pnpm run check:imports` fails a deep import).

<!-- Draft for the owner's docs pass (audit V-02, I-1, I-8, S-01, I-3): the words are not final. -->
## What the contracts leave to you

The contracts enforce the money rules. Still, a few checks are left to whoever reads them. Our own code makes each of these, in the kit, the wallet or the helper as named below, so if you call the contracts yourself or read their events for your own books, they become yours. Each heading names its finding in the Pillow Auditors review of 7 November 2026.

### Refund notes on the NEAR vault (audit V-02)

`vaultSync` reads the vault's lists on two RPCs, and `vaultSettleOwn` writes a refund note. We take a refund note as the spend row's own leaf, at `refund_leaf_index`, and never look one up by its precommitment. The vault doesn't reserve that precommitment (`contracts/vault/src/withdraw.rs:256`; only a deposit writes one, `contracts/vault/src/deposit.rs:144`), so a stranger can put 1 USDC on it, and if that payout bounces there are two notes with one nullifier. Spend the stranger's first and the refund is frozen. We'd treat any note a client found by precommitment alone as a bug. `vaultSettleOwn` takes the leaf (`packages/kit/src/vault/settle.ts:17-21`), and the restore is held to the same rule by `packages/wallet/test/note-restore.test.ts:888`.

### Reading a payout (audit I-1)

A USDC `ft_transfer` event alone doesn't prove a payout arrived. A payout is one receipt holding the recipient's transfer and then the fee's, and NEAR keeps a failed receipt's logs. So the fee's transfer can fail, roll the whole receipt back, and still leave an event for money that never moved. Any contract can produce that batch, and an indexer that counts transfer events gets fooled by every one of them. Read the vault's `payout` event (`contracts/vault/src/payout.rs:150`, NEP-297, standard `blindfill-vault`), the spend's `status` from `vaultSync`, or the receipt's own status.

### The fee on an EVM sell (audit I-8)

A sell pays its fee to the chain's FeeCollector, whose `receive()` logs `Paid(from, value)` and forwards the ETH in the same call (`contracts/pool-evm/src/FeeCollector.sol:38-42`). Anyone can send it ETH, of any amount, zero included, which means anyone can make a `Paid` log. Credit a fee only when the log comes from the collector's own address, `from` is the wallet you expect, the value covers what's owed, and it sits in the receipt of the transaction you're crediting. Our helper checks all four before it counts a sale as paid (`apps/helper/src/pool/evm.ts:553-565`).

### The smallest Solana pool deposit (audit S-01)

`solanaPoolDepositIx` refuses a note too small to release, and its error names the floor it used (`packages/kit/src/trade/solana/pool-deposit.ts:157`). The program itself takes any note from 1,000,000 lamports, but a release has to leave the fresh wallet rent-exempt, and its fee can be at most half of what it takes out, so the kit sets the floor at twice the larger of two fees: a relayer's whole cost on a release whose change opens a new page, and the kit's own relay fee (`packages/kit/src/trade/solana/pool-deposit.ts:68`, `contracts/pool-solana/src/lib.rs:52-57`). At mainnet rent as read on 2 November 2026 that's 3,647,120 lamports (`contracts/pool-solana/src/release.rs:224-227`). The kit works the floor out from the rent you pass in, so read it on two RPCs (`readSolanaRent`), and a rent change moves the floor with it. Under that line a note would cost more to get out than it holds, and since the pool has no ragequit and no merge, it would be stuck at a loss. Our wallet's ladder starts at 10,000,000 (`packages/wallet/src/pool/solana.ts:51`), and every note it makes is a whole rung (`packages/wallet/src/pool/ladder.ts:9-10`).

### USDC (audit I-3)

"No owner" covers only the vault. USDC is Circle's token, and Circle can pause it or blocklist an account; a payout it stops comes back as a refund note, and nothing moves until Circle lifts it. The details are in [No way to change itself](../../docs/security.md#no-way-to-change-itself).
