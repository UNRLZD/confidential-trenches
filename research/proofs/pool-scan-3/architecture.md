# Architecture (pool-scan-3)

Target: UNRLZD/confidential-trenches at a6ee435c (card/pool-review-3), detached copy. Scope: `contracts/pool-solana/src/`
(Rust, native solana-program 3.0.0) and `contracts/pool-evm/src/` with the vendored `lib/lean-imt` (Solidity 0.8.28,
Cancun). Tests, deploy scripts and docs are context only.

## Product, principals, resources
- Blindfill pools hold user money as private notes and pay it out only against a Groth16 withdraw proof (the Privacy
  Pools v1.3.0 circuit and ceremony key). No owner, admin, setter, pause or upgrade on either chain.
- Principals: depositors (anyone), W (a fresh wallet whose key lives on the user's device and signs every release),
  relayers or fee payers (the helper, untrusted: may lie, withhold, reorder), venue programs and DEX contracts (W picks
  them), sequencers and Solana leaders (see pending transactions), any third party.
- Protected resources: the pool's lamports or ETH, each note's single spend, W's tokens and ETH in a sell, user
  liveness (a signed release or sell landing).

## Comparable baseline
Privacy Pools v1.3.0 core (0xbow, audited by Oxorio and Auditware). It accepts the same precommitment-uniqueness rule
(its Entrypoint keeps `usedPrecommitments`), so a copied pending precommitment can block a deposit there too.

## Entry surfaces
- EVM pool (`PrivacyPoolSimple`): `deposit`, `withdraw` (relayed, W-signed EIP-712 Withdraw), `buy` (relayed, W-signed
  Buy into an adapter), views.
- EVM adapters: `UniswapV3Adapter.buy` (SwapRouter02 exactInput), `UniswapV4Adapter.buy` and `unlockCallback`.
- `SellDelegate` (EIP-7702 code for W): `sell` (anyone sends, W signs Sell), `unlockCallback`, `nonce`, `receive`.
- Groth16 `WithdrawalVerifier.verifyProof` (snarkJS template, code hash pinned by the pool).
- Solana program: tag 0 init, tag 1 deposit, tag 2 release, tag 3 release_and_buy (release, then up to 8 inner
  instructions W signed, run with `invoke` and W's signer privilege only).

## Trust boundaries and strongest control
1. Proof to payout: context hash binds pool, chain (EVM scope), recipient W, fee recipient or fee payer, caps,
   deadline, salt; verifier refuses signals >= p and bad points; nullifier mark or map once.
2. Relayer to W's intent: W's EIP-712 signature (EVM) or W's transaction signature (Solana); fee picked by the sender
   up to the bound cap, paid only to the bound payee.
3. Pool to venue: EVM nonReentrant plus W-balance minOut check; Solana pool-account and signer filters on inner
   instructions, runtime re-entry refusal.
4. W's account to callers (7702): EIP-712 Sell with W's domain and an ERC-7201 nonce, exact approval and debit,
   PoolManager-only one-shot callback.
5. Deploy: code-hash pins for verifier and Poseidon (EVM); a fresh program id per cluster (Solana, deploy rule).

## Offline build and test limits
forge 1.7.1 with solc 0.8.28 installed locally; forge-std copied into the scratch worktree (submodule not checked
out). Solana SVM tests need a cargo-build-sbf build and litesvm; not run in this pass (time).

## Prior coverage
No prior security-audit ledger. Earlier human reviews exist (pool-review-2.md, pool-review-3.md) and were read only
after this run's findings were written.

## Companion selection
Selected: RESOURCE-EXHAUSTION-AND-AVAILABILITY.md (griefing, compute and gas units) and the caller's chain checklist
(CHAIN-CHECKLIST.md in this folder). Every other companion excluded with its reason in each ledger unit.
