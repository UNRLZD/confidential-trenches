# Pool scan 3 (card pool-review-3), 2026-11-05 20:58Z

Method: cloudflare/security-audit-skill (pinned c1c8a8c1) with the team's chain checklist (CHAIN-CHECKLIST.md) as the
ledger's attack classes, on the pool code at a6ee435c (EVM pool, SellDelegate, adapters, Solana pool).
Result: 0 High, 0 Medium, 1 Low (reproduced in forge), 6 candidates rejected from source. validate-findings.cjs PASS
(7 findings), validate-coverage-ledger.cjs PASS (28 units: 19 covered, 9 candidate).

Departures from the skill: one agent ran every phase (no independent verifier agents); forge ran through heavy.sh on
the Mac queue (`--offline`, the published Hardhat mnemonic as dummy keys), not the skill's empty sandbox; the Solana
SVM tests did not run (no cargo-build-sbf build in time).

## L-1 (Low): a copied pending precommitment blocks a deposit or a whole signed sell

Fingerprint `precommitment-copy-grief:deposit-and-sell`. Likelihood medium, impact low, confidence high.
Same finding as pool-review-3.md L-2.

- contracts/pool-evm/src/PrivacyPool.sol:90-93: the first deposit by any sender marks the precommitment.
- contracts/pool-evm/src/SellDelegate.sol:196: the sell's last step deposits with the signed precommitment; a failure
  reverts the whole sell, and the nonce bump at :153 rolls back with it.
- contracts/pool-solana/src/deposit.rs:93: the same first-come `["pre", precommitment]` mark.
- Trigger: anyone who sees a pending deposit or `W.sell` (a sequencer, a Solana leader or RPC node, a public mempool)
  deposits MIN_DEPOSIT with the same precommitment and lands first.
- Impact: availability only, no money lost. The victim's deposit or sell reverts with PrecommitmentAlreadyUsed; a Sell
  signed in advance never runs and W signs again. Each try costs the attacker 0.0001 ETH plus gas (or 0.001 SOL plus
  rent), and that deposit becomes a note only the precommitment's owner can spend.
- Fix: keep the contract rule (it stops two notes sharing one nullifier; Privacy Pools v1.3.0 keeps it the same way).
  In the kit, on PrecommitmentAlreadyUsed: restore the stranger's deposit as the device's own note (found by the
  precommitment), then sign again with the next precommitment. Not recommended: keying the mark on sender and
  precommitment together (two notes with one nullifier).
- Reproduction: agents/solo-hunter/artifacts/Scan3.t.sol, `forge test --offline --match-contract
  Scan3PrecommitmentFrontRun -vv`: test_scan3_aCopiedPrecommitmentRevertsAPendingDeposit PASS (victim deposit reverted
  PrecommitmentAlreadyUsed), test_scan3_aCopiedPrecommitmentRevertsAWholeSignedSell PASS (sell reverted; W keeps its
  tokens, nonce 0; griefer spent 100000000000000 wei). Suite 35 passed, 0 failed (33 inherited SellTest cases at
  a6ee435c). Log: agents/solo-hunter/artifacts/forge-scan3.txt.

## Rejected candidates (records in findings.json)

| Fingerprint | Why it is not a finding |
|---|---|
| evm-sender-picks-fee-up-to-cap | the fee goes only to the bound feeRecipient (PrivacyPool.sol:128, :179, :186); pool-review-3 I-1 |
| sol-duplicate-change-leaf | copying a leaf needs that note's preimage, so it only hurts its own prover (tree.rs:37) |
| sol-page-address-not-rederived | only this program writes PAGE_DISC, and only at a verified PDA (state.rs:247, :319-329) |
| sol-scope-without-cluster | every release also needs W's and the fee payer's signatures on one cluster's blockhash; a reused program id is forbidden by the deploy rule (lib.rs:47-50) |
| sol-tag3-no-onchain-minout | the bound is the venue's own field inside an instruction W signed (buy.rs:197-201) |
| v4-adapter-weth-transfer-unchecked | a short transfer leaves the delta unsettled and the PoolManager reverts the unlock (UniswapV4Adapter.sol:133); pool-review-3 I-6 |

## Checked, no finding

EVM pool: one transient reentrancy guard over deposit/withdraw/buy (State.sol:83-88), spend and insert before any call
out; EIP-712 domain with the live chain id and pool address (PrivacyPool.sol:194-197), distinct typehashes, low s,
65-byte length, ecrecover 0 never a recipient; context binds processooor, the 192-byte RelayData and SCOPE (:233-236,
State.sol:105); checkField on all 8 signals, precompile 8 G2 subgroup check, gamma the G2 generator and delta not;
verifier and both Poseidon code hashes pinned in the constructor (State.sol:98-100); nullifier checked then set, every
root kept, 0 never a root, leaves below p, nonzero, unique (InternalLeanIMT.sol:40-46); checked arithmetic,
withdrawnValue under 2^128, fixed-size encodePacked only, no delegatecall/selfdestruct/create; buy needs minOut != 0
and W's balance rising by at least minOut.

SellDelegate (EIP-7702): no initializer, owner or setter; nonce at an ERC-7201 slot, guard and v4 flag in namespaced
transient slots; the a6ee435c fee fix is sound (feeRecipient in struct, typehash and digest :59, :87, :284; paid only
there :193; zero or W recipient refused :149); exact approval ending at 0; W's debit equals the signed amount; ETH
counted as a delta; the v4 callback runs only from the PoolManager with the one-shot payload hash.

Adapters: UniswapV3Adapter keeps the router's ETH and middle-token balances unchanged; UniswapV4Adapter's callback runs
only from the PoolManager for its own unlock.

Solana: W and the fee payer sign and are bound in the context; pool checked by owner, discriminator and bump-derived
address; system program id checked; canonical bumps, fixed-length seeds; owned targets refused, pre-funded addresses
topped up; pages checked by header; duplicate W/fee payer/tip accounts cannot double a credit; tag 3 refuses calling
this program, filters pool and owned accounts, passes no signer but W, no invoke_signed; nothing closes, init once,
pages grow 72 bytes per insert; withdrawn at most deposited - spent; Clock and Rent from syscalls; coordinates below q,
signals below p, solana-bn254 3.2.1 converts pairing inputs with Validate::Yes, IC has 9 points.

## The scan's two questions outside its scope, answered by the CO from the code (20:59Z)

1. The kit signs W's EIP-7702 authorization with the chain's own id, never 0:
   packages/kit/src/trade/evm/sell-unpinned.ts:441-446 (`chainId = venueOf(chain).chainId`, M363 (4)).
2. The delegate W authorizes is the signing page's pinned SellDelegate (packages/signpage/src/rules/pool.ts,
   `delegate: pins.sellDelegate`). No mainnet SellDelegate is deployed yet, so no mainnet W is delegated to the
   pre-fix code; the deploy card pins the new address.

## Not covered

The Solana SVM run; the circuit itself (taken as Privacy Pools v1.3.0's, audited); the kit's transaction builders
beyond the two answers above, the helper, the deploy scripts beyond a skim; Robinhood's upgradeable WETH proxy and the
chains' Uniswap deployments; independent verification of this scan (a second reader should re-run Scan3.t.sol and
spot-check the ledger). Still due: the delta scan at the final sha.

## Delta at the final sha (CO, 2026-11-05T21:25Z)

pool-review-3 final sha 35428427 (code last changed 1c481616). `git diff --name-only a6ee435c 35428427 -- contracts/pool-evm/src contracts/pool-solana/src` lists 0 files; Cargo.toml and Cargo.lock unchanged; contracts/pool-evm/foundry.toml adds only an [invariant] section (runs 256, depth 64) for test/Invariant.t.sol, no compiler setting. The scanned source is byte for byte the final source, so this scan stands for 35428427. Changed since a6ee435c, all test or tooling: Invariant.t.sol (new), Sell.t.sol (L-2 standing tests from Scan3.t.sol), kit-sells.json and testnet-run fixtures, mutants.mjs, the Slither job (slither/requirements.txt, triage.json).
