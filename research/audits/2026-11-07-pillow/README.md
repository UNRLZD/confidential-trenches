# Pillow Auditors review, 7 November 2026

Pillow Auditors reviewed the NEAR vault, the EVM pool and the Solana pool at commit `46b16ca48be23c19dace0cddfe4c75a3bab0f0d9`, looking for any way to lose, freeze or misdirect user funds. Version 1.0 of the report found **0 Critical, 0 High, 0 Medium, 5 Low and 8 Info**, and no way for a third party to steal, permanently freeze or misdirect user funds.

| File | What it is |
|---|---|
| [Pillow-Auditors-Confidential-Trenches.pdf](Pillow-Auditors-Confidential-Trenches.pdf) | The full report, as delivered |
| [VERDICT.md](VERDICT.md) | The auditor's one-page verdict, as delivered |
| [poc/](poc/) | The auditor's proofs of concept for V-01, V-02 and E-01, as delivered |

## What happened to each Low

Every Low has a fix on main. The contracts have no upgrade path, so each fix sits in the device, the kit or the helper, and where the contract leaves a rule to clients, the docs say so.

| ID | Finding | Fix on main |
|---|---|---|
| V-01 | `storage_prepay` publishes a precommitment before its deposit | The wallet's NEAR deposit lands by itself when a stranger prepaid its one-time account: 0beea09b0 (8 Nov 2026) |
| E-01 | A sell's `minOut` counts any ETH that reaches the wallet | The kit builds no EVM sell for a wallet with a release to it still in flight: 7d70c9fd2 (8 Nov 2026) |
| V-02 | A refund note's precommitment is not reserved | The wallet finds a refund note through its spend, pinned by a test; the rule for other clients is in [docs/security.md](../../../docs/security.md) and the kit's README: c7778df0e (8 Nov 2026) |
| V-03 | A hostile user can make the relayer pay for bounced withdrawals | The withdrawal relayer pays a register deposit only at USDC's pinned storage minimum and re-reads the recipient's registration before sending: c6180177c (8 Nov 2026) |
| S-01 | Solana notes under about 0.0022 SOL cost more to release than they hold | The kit never builds a Solana pool note under the pool's floor: 6d91e8511 (9 Nov 2026) |

The Info findings I-1, I-3 and I-8, which describe what integrators must know, are written up in [docs/security.md](../../../docs/security.md) and the kit's README in the same change as V-02.

## What the review did not cover

In the auditor's words, the review did not cover the cross-chain product and device checks, privacy, a full circuit and ceremony audit, the deployed exchange adapters and sell delegate, or a live mainnet money run. Section 7 of the report lists the limits in full.
