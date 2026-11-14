# Chain checklist (pool-scan-3)

The security-audit skill (cloudflare/security-audit-skill c1c8a8c1) has no blockchain content. This file is the chain
checklist the caller gave for this run, one heading per class. Ledger units name these headings as
`CHAIN-CHECKLIST.md#<heading>`.

## EVM reentrancy
Cross-function, read-only, and through transient-storage guards.

## EVM signature replay and malleability
Replay across chains, contracts, forks and delegates; the EIP-712 domain; malleability; ecrecover returning 0.

## EIP-7702 delegation
Storage collisions with whatever W ran before, initialization, delegation front-running, nonce handling.

## EVM token and value handling
Approvals left behind; unchecked return values; fee-on-transfer and rebasing tokens; forced ETH.

## EVM slippage and price manipulation
minOut, sandwiching, price manipulation.

## Griefing and front-running
Griefing and DoS; front-running of deposits and releases.

## EVM arithmetic and low-level calls
Rounding and unsafe casts; abi.encodePacked collisions; delegatecall and selfdestruct.

## EVM deployment
Constructor arguments that differ in a front-run deploy; code the pool trusts at fixed addresses.

## Uniswap callbacks
Uniswap v3/v4 callback authentication, hook data and unlock flows.

## Solana account checks
Owner, signer and writable checks; PDA seeds and the canonical bump; seed collisions.

## Solana account confusion
Account substitution and type confusion (discriminators); duplicate mutable accounts.

## Solana CPI
CPI to arbitrary programs; invoke_signed misuse.

## Solana account lifecycle
Close and revival of accounts; reinitialization; realloc; rent.

## Solana lamports and sysvars
Lamport accounting and overflow; sysvar spoofing; remaining accounts; compute-budget DoS.

## ZK verifier inputs
Point and subgroup validation; public-input range and aliasing (each value below the field).

## ZK nullifiers and roots
Nullifier uniqueness; root history.

## ZK proof binding
Binding of the recipient, relayer, fee, chain and pool into the proof, so a seen proof cannot be redirected.
