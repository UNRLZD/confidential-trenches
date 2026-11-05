# Pool review, round 3

A fresh review of both Blindfill pools, written without reading any earlier pool review or the board's notes on
earlier pool cards. Card pool-review-3, at `origin/main` 66d7b607.

## Scope

Every line of:

- `contracts/pool-solana/src/`: `lib.rs`, `deposit.rs`, `release.rs`, `buy.rs`, `state.rs`, `tree.rs`, `context.rs`,
  `verifier.rs`, `field.rs`, `vk.rs`, `error.rs` (1,861 lines), and `TAG3.md`.
- `contracts/pool-evm/src/`: `State.sol`, `PrivacyPool.sol`, `PrivacyPoolSimple.sol`, `SellDelegate.sol`,
  `adapters/UniswapV3Adapter.sol`, `adapters/UniswapV4Adapter.sol`, `lib/`, `interfaces/`, `poseidon/`,
  `verifiers/WithdrawalVerifier.sol` (2,168 lines), with the vendored `lib/lean-imt/InternalLeanIMT.sol` it calls.
- Read for context only: each pool's tests, the deploy scripts (how a pool is created and pinned), the CI job that
  builds them, `docs/architecture.md` and `docs/security.md`. The `solana-bn254` 3.2.1 source was read to confirm how
  the pairing checks its points.

Threat model: anyone may call anything with any accounts or arguments, in any order, and the helper server may lie,
withhold or reorder. W (the fresh wallet) and its signature belong to the user's device.

## Result

| Severity | Count |
|---|---|
| High | 0 |
| Medium | 0 |
| Low | 2 |
| Info | 7 |

No finding loses or freezes a user's money, spends a note twice, or lets anyone but W choose how a proof is used.
Neither pool has an admin, owner, setter, pause or upgrade path. No code was changed by this review, so no deploy pin
moves.

## Findings

### L-1. A sell's fee goes to whoever sends it, so anyone who sees a signed sell can take the fee

- **Where:** `contracts/pool-evm/src/SellDelegate.sol:143` (the fee is the sender's pick, at most `feeCap`) and
  `:187-190` (the fee is paid to `msg.sender`).
- **Trigger:** the helper sends `W.sell(sell, fee, sig)`. Anyone who sees that transaction before it lands (a
  sequencer, or anyone on a chain with a public mempool) sends the same `sell` and `sig` with `fee = sell.feeCap`
  from their own address. Their copy lands first. They are paid `feeCap`, the helper's transaction reverts with
  `InvalidNonce` and the helper pays its gas, and W's deposit is `gained - feeCap` instead of `gained - fee`.
- **Impact:** W never pays more than the `feeCap` it signed, so no user money is lost beyond what W agreed to. The
  helper loses its fee and the gas of the reverted send. Base and Robinhood Chain have no public mempool, so only
  the sequencer can see a pending send.
- **Fix (not made):** bind the payee. Add `address sender` (or a `feeRecipient`) to `Sell` and its typehash, and pay
  that address, as the pool's own release binds `feeRecipient` through the context
  (`contracts/pool-evm/src/PrivacyPool.sol:128`). This changes the signed type, so the kit's
  `packages/kit/src/trade/evm/sell-unpinned.ts` and its vectors change with it. The delegate holds no money and W
  can point its EIP-7702 delegation at a new delegate at any time, so this can ship later without a pool redeploy.

### L-2. A deposit's precommitment can be taken first, which blocks that deposit (and so a signed sell)

- **Where:** `contracts/pool-evm/src/PrivacyPool.sol:92-93`, `contracts/pool-solana/src/deposit.rs:93`, and
  `contracts/pool-evm/src/SellDelegate.sol:191` (a sell ends in a deposit with the precommitment W signed).
- **Trigger:** an attacker who sees a pending deposit (or a pending `W.sell`) sends their own deposit of
  `MIN_DEPOSIT` with the same precommitment first. The victim's deposit reverts with `PrecommitmentAlreadyUsed`. A
  sell reverts with it, so a sell W signed ahead of time (a stop order) does not run.
- **Impact:** no money is lost. The attacker pays `MIN_DEPOSIT` (0.0001 ETH, or 0.001 SOL) each time, and that
  deposit is a note W can spend, because W knows the precommitment's nullifier and secret. The device has to sign
  again with a new precommitment, which a sell signed ahead of time cannot do while the device is offline. Like
  L-1, the attacker has to see the pending transaction first, which on Base and Robinhood Chain only the sequencer
  can, and on Solana only the RPC nodes and leaders that carry it.
- **Fix (not made):** the refusal itself stays: two notes with one precommitment would share one nullifier
  (Privacy Pools' `Entrypoint.sol` `usedPrecommitments`). The fix sits in the kit: on a `PrecommitmentAlreadyUsed`
  revert the device restores the stolen deposit as its own note (the restore finds it by the precommitment) and
  signs the next deposit or sell with the next precommitment.

### I-1. A release's fee is the sender's pick up to the cap, not an exact amount (EVM)

`contracts/pool-evm/src/PrivacyPool.sol:115` and `:179`. W's EIP-712 signature covers the nullifier, the context
and the value (`:119-123`); the context binds `feeRecipient` and `feeCap` but not the fee. Any sender may use any
fee up to `feeCap`, and it is always paid to `feeRecipient`. This matches Privacy Pools' relayer model and costs W
nothing beyond the cap it signed. On Solana W signs the whole transaction, so the fee there is exact. The device
should set `feeCap` to the fee it means to pay.

### I-2. A Sell signed for one delegate stays valid under a later delegate at the same W

`contracts/pool-evm/src/SellDelegate.sol:266-284`. The domain's `verifyingContract` is W itself, and the nonce
lives at W's ERC-7201 slot (`:67`), so after W re-delegates to a new SellDelegate build, an unused Sell signed for
the old one still verifies under the new one. That is the intended behaviour for orders signed in advance, and the
nonce keeps each one single-use. A later delegate that changes what a Sell means should change `VERSION_HASH`.

### I-3. SellDelegate cannot sell WETH itself

`contracts/pool-evm/src/SellDelegate.sol:152-154` and `:180-181`. With `token == WETH` on a route that counts WETH,
`_weth` holds W's balance before the sale, the sale lowers it, and `WETH.balanceOf(W) - _weth` underflows, so the
sell reverts. Nothing is lost, since W can unwrap and deposit directly. The kit never builds such a sell.

### I-4. Value sent to a pool outside a deposit stays in the pool

On EVM, the pool has no `receive` or `fallback` (`contracts/pool-evm/src/PrivacyPoolSimple.sol`), but ETH forced in
(a `SELFDESTRUCT` beneficiary or a block reward) is held with no note. On Solana, anyone can credit the pool
account, and only `deposited - spent` is ever paid out (`contracts/pool-solana/src/release.rs:242-245`, `:276`).
Neither changes what any note can withdraw, and both are standard for a pool with no admin.

### I-5. UniswapV3Adapter reverts with a panic, not a named error, on a path under 20 bytes

`contracts/pool-evm/src/adapters/UniswapV3Adapter.sol:42`: `data.length - 20` underflows (Panic 0x11). The buy
reverts either way and W signed the path. A path whose length is not `20 + 23n` is passed to the router as W signed
it, and the middle-token check reads the tokens at `23 * i`.

### I-6. UniswapV4Adapter ignores WETH's `transfer` return value

`contracts/pool-evm/src/adapters/UniswapV4Adapter.sol:133`. WETH9 returns true or reverts, and the PoolManager's
`settle` that follows credits only what arrived, so a false return would end in `CurrencyNotSettled` and revert the
unlock. No change needed.

### I-7. The two pools' deadlines are in different units

The pool's release deadline is in milliseconds (`RelayData.deadlineMs`, `contracts/pool-evm/src/PrivacyPool.sol:241`;
`deadline_ms`, `contracts/pool-solana/src/release.rs:184-186`). SellDelegate's is in seconds
(`contracts/pool-evm/src/SellDelegate.sol:142`). The kit uses seconds for a sell
(`packages/kit/src/trade/evm/sell-unpinned.ts:25`). A device that put milliseconds in a Sell would sign an order
valid 1,000 times longer than meant. The Sell's NatSpec should say "unix seconds".

## Checked, with no finding

### Solana pool

- **Funds out are bounded.** Every lamport leaves only in `settle` (`release.rs:276-281`): the pool pays exactly
  `withdrawnValue`, split into `withdrawnValue - relay_fee - tip` to W, `relay_fee` to the fee payer and `tip` to the
  tip account (`:240`, checked subtraction). Row 9 (`:242-245`) caps every release at `deposited - spent`, so the
  pool's own rent is never paid out, even if a proof were wrong.
- **No double spend.** The spent mark is the PDA `["spent", nullifierHash]` at the canonical bump
  (`state.rs:234`), created in the release (`release.rs:263`). An existing mark is refused because the program owns
  it (`state.rs:191`), and nothing ever closes or reassigns a program account. `nullifierHash` must be below p
  (`release.rs:177`), so it has one encoding.
- **Proof binding.** The context is computed on chain from the program id, the pool, W, the fee payer, the fee cap,
  the tip cap, the deadline and the salt (`release.rs:198-210`); nothing in the instruction can stand in for it. The
  8 signals are assembled by the program (`:247-256`); the two roots are read from the pool's own pages by index
  (`:216-219`, `state.rs:283-300`), so a root the pool never had cannot be named. W and the fee payer must both sign
  (`:191-196`), and W's signature covers the exact `relay_fee`, the tip and every inner instruction.
- **The verifier.** Coordinates below q and signals below p are refused before any curve call (`verifier.rs:28-38`);
  `-A` is computed correctly, including the point at infinity (`:40-45`); the pairing output must be exactly 1
  (`:70`). The runtime's pairing deserialises G1 and G2 with arkworks' `Validate::Yes` (`solana-bn254` 3.2.1
  `src/lib.rs:290-330`), which checks the curve and the G2 subgroup; compressed proofs are decompressed and then go
  through the same pairing (`buy.rs:65-75`). The key matches `withdraw.vkey` (`verifier.rs:162-187`).
- **Account checks.** The pool is loaded only if this program owns it, its size and discriminator are the pool's,
  and its stored bump derives its address (`state.rs:119-141`). `init` takes only the canonical PDA
  (`deposit.rs:43-47`) and refuses a second time; a pre-funded pool, page or mark address is topped up, allocated
  and assigned instead of blocking (`state.rs:206-216`). Pages are checked by owner, discriminator, tree, page number
  and entry count (`state.rs:242-255`), or by address at a page's first entry (`:319-325`). A stranger can make a
  zero-filled account this program owns, but never at a PDA, and never with a page's discriminator or a mark's tag.
- **Tag 3 (release and buy).** No inner instruction may call this program (`buy.rs:168-170`); a venue that calls
  back is stopped by the runtime's re-entrancy rule. No inner account or tip account may be the pool, its spent mark,
  any page this release names, the next page, or any account this program owns (`:110-112`, `:162-179`). No signer
  other than W reaches a venue (`:176-178`), so the fee payer cannot be debited. Inner instructions run with `invoke`
  only, never `invoke_signed` (`:189-202`). Duplicate keys share their signer flag in a Solana message, so the fee
  payer cannot be passed at a second index.
- **Rent and growth.** Every mark and page entry is paid by the transaction's payer; pages grow 72 bytes per insert,
  under the 10 KiB per-instruction growth limit; marks are 13 and 17 bytes and are never closed.
- **The trees.** `tree.rs:37-69` is LeanIMT's `_insert` with the depth bound checked before any write; it matches
  the zk-kit boundary vectors to depth 32 (`tree.rs:103-127`). No leaf map is kept, which is safe: a repeated leaf
  would share its nullifier, so it could be spent once only.
- **No admin path.** No instruction takes a privileged signer, every constant is compiled in, and the deploy sets no
  upgrade authority.

### EVM pool

- **Funds out are bounded.** ETH leaves the pool only through `_push` (`PrivacyPoolSimple.sol:119-123`) for W and
  the fee recipient in `withdraw` (`PrivacyPool.sol:127-128`), and for the fee recipient and the adapter in `buy`
  (`PrivacyPoolSimple.sol:60-64`), always after the nullifier is marked and the whole spend is checked.
- **No double spend.** `nullifierHashes` is checked and set before any external call (`State.sol:152-158`), and
  every pool method holds a transient re-entrancy guard (`State.sol:83-88`). The verifier refuses signals at or over
  r (`WithdrawalVerifier.sol` `checkField`), so a nullifier has one encoding.
- **Proof binding.** The context is `keccak256(abi.encode(withdrawal, SCOPE)) mod p` (`PrivacyPool.sol:236`), with
  `processooor` this pool (`:233`) and `SCOPE` binding the pool's address, the chain id and the asset
  (`State.sol:105`). The request must be exactly 192 bytes (`PrivacyPool.sol:150-153`), and Solidity's decoder
  refuses dirty high bits, so a request has one encoding. W's EIP-712 signature (s in the lower half, 65 bytes,
  ecrecover's 0 never matching a non-zero W) picks Withdraw or Buy (`:58-65`, `:181`, `:205-217`;
  `PrivacyPoolSimple.sol:39-41`, `:86-101`), so a relayer cannot turn one into the other or change the adapter, the
  route, the token or `minOut`.
- **Roots and depths.** Every root either tree has had is kept with its block time (`State.sol:172`, `:188`); root 0
  is never known (`:198-209`); both depths are bounded at 32 (`PrivacyPool.sol:244`, `State.sol:169`, `:185`).
- **Deposits.** The value is at least `MIN_DEPOSIT`, below 2^128 and equal to `msg.value` (`PrivacyPool.sol:86-87`,
  `PrivacyPoolSimple.sol:110`); the precommitment is below p and unused (`PrivacyPool.sol:90-93`). The label tree
  holds only the pool's own labels.
- **Buy.** `minOut` must be non-zero and W's balance of the signed token must rise by at least `minOut`
  (`PrivacyPoolSimple.sol:57`, `:63-66`), which measures what arrived, so a fee-on-transfer or rebasing token cannot
  fake it. The pool holds only native ETH, so no fee-on-transfer, rebasing or approval risk applies to its own funds.
  It never approves anything.
- **The adapters.** Each has no owner and no storage. UniswapV3Adapter refuses a fill that left any ETH or any
  middle token in SwapRouter02 (`UniswapV3Adapter.sol:40-55`). UniswapV4Adapter's `unlockCallback` is reachable only
  from the PoolManager, which calls back only the contract that called `unlock`; each hop must take its whole input
  (`UniswapV4Adapter.sol:121`), and the output is checked against `minOut` (`:126`) before it is taken to W.
- **SellDelegate under EIP-7702.** No initializer, owner or setter; WETH and the PoolManager are immutables in its
  code; its one stored value is W's nonce at an ERC-7201 slot (`SellDelegate.sol:61-67`). W's signature is checked
  against W itself under a domain naming W and the chain (`:145`, `:266-284`), the nonce makes each Sell single-use
  (`:146-148`), the approval is exactly the amount and must end at 0 (`:165`, `:172`), W's token balance must fall
  by exactly the amount (`:178`), ETH out must reach `minOut` (`:185`), and the guard and the v4 one-shot flag are
  transient slots of W (`:68-74`, `:328-362`). The v4 callback runs only from the PoolManager with the exact payload
  the sell passed (`:205-207`).
- **Gas and rounding.** The relay-fee backstop rounds down (`PrivacyPool.sol:186`), in the pool's favour; amounts
  are bounded under 2^128 by the circuit, so `_withdrawn * MAX_RELAY_FEE_BPS` cannot overflow.
- **No admin path.** No owner, setter, pause, `windDown` or upgrade proxy. The constructor checks the code hashes
  of the verifier and both Poseidon contracts it calls (`State.sol:98-100`), and takes no address that could differ
  in a front-run deploy except the verifier, whose code hash is pinned.

## Builds at the review's sha

Both suites and both builds were run at the sha this file is committed at; the card's report gives the commands,
their output and the hashes.
