# Research proofs and audits

Before writing the product, each open design question got a measured run: a contract call on chain, a proof timed on a phone, a vendor's API read twice, a chain watched for 24 hours. These are the write-ups of those runs, copied from the team's private research repository. Its code and raw data stay there, and its history predates the hackathon window (see Prior work in the README). Machine paths and server addresses are redacted.

## Proofs

| Proof | What it measured |
|---|---|
| [b1-base-simulate](proofs/b1-base-simulate/RESULT.md) | B1: `eth_simulateV1` on the Base RPCs paper 06c names |
| [b1-dao](proofs/b1-dao/RESULT.md) | B1: the 2-of-2 admin DAO paste |
| [b2-n14-shape](proofs/b2-n14-shape/RESULT.md) | B2: the NEAR replacement N-14 (06c §5.1, §7 item 6) |
| [b3-hood-addresses](proofs/b3-hood-addresses/RESULT.md) | B3: Robinhood Chain factory and pool-manager addresses (read from the chain and from the vendors) |
| [bnb-cutoff-input](proofs/bnb-cutoff-input/RESULT.md) | BNB cut-off rule: input (M12 for BNB Chain so far, and 1Click now) |
| [bnb-recheck](proofs/bnb-recheck/RESULT.md) | BNB daily re-check (1Click) |
| [en1-address-move](proofs/en1-address-move/RESULT.md) | EN1A: how a handover moves both hosts to the new CVM (paper 10 §7 row 61) |
| [evm-safe-lag](proofs/evm-safe-lag/RESULT.md) | EVM `safe` and `finalized` lag (Base, Robinhood) |
| [f3-archival](proofs/f3-archival/RESULT.md) | F3: old call arguments read back from archival RPCs |
| [fdp05-unshield](proofs/fdp05-unshield/RESULT.md) | FD-P-05: can the omnibus leave FAR without the operator? (unshield read) |
| [fds15-treasury](proofs/fds15-treasury/RESULT.md) | FD-S-15: treasury headroom on its shard (48 h read) |
| [fp4-size](proofs/fp4-size/RESULT.md) | FP-4 Phala size compare (FD-S-08): result |
| [fp6-ct](proofs/fp6-ct/RESULT.md) | FP-6 CT and DNS watch latency (the first DR20): result |
| [g1-arm-swap](proofs/g1-arm-swap/RESULT.md) | G1 extra: 1Click and a credit from a one-use account (RM-03) |
| [g1-money-loop](proofs/g1-money-loop/RESULT.md) | G1 proof 6: the Plan 1 money loop (real money) |
| [g1-phone-prover](proofs/g1-phone-prover/RESULT.md) | G1 proof 2: proofs on a phone (g1-phone-prover) |
| [g1-phone-trade](proofs/g1-phone-trade/RESULT.md) | G1 proof 5: phone-browser Solana trade, results |
| [g1-presigned-exits](proofs/g1-presigned-exits/RESULT.md) | G1 proof 4: exits signed in advance (DRAFT) |
| [g1-setup-files](proofs/g1-setup-files/RESULT.md) | g1-setup-files: the Privacy Pools v1.3.0 ceremony keys, checked |
| [g1-vault-gas](proofs/g1-vault-gas/RESULT.md) | G1 proof 1: a Privacy Pools withdrawal proof checked by a NEAR contract, gas measured |
| [gitleaks-history](proofs/gitleaks-history/RESULT.md) | gitleaks full-history scan |
| [m12-hood](proofs/m12-hood/RESULT.md) | M12 for Robinhood Chain, 24 h (paper 5 method) |
| [o35](proofs/o35/RESULT.md) | O35: the keyed 1Click run (FP-3 and MS-14) |
| [p1-private-balance](proofs/p1-private-balance/RESULT.md) | P1 Private balance: result |
| [p2-ckd](proofs/p2-ckd/RESULT.md) | P2 CKD: result |
| [p3-coverage/results](proofs/p3-coverage/results/oneclick-collector-public.md) | 1Click fee collectors on public NEAR (coordinator read, 2026-10-20 ~12:00Z) |
| [p3-enclave](proofs/p3-enclave/RESULT.md) | P3 Enclave: result |
| [p3g-pre](proofs/p3g-pre/RESULT.md) | P3g pre-proof: the GCP vTPM check on NEAR, before any cloud spend |
| [p3g](proofs/p3g/RESULT-F.md) | P3G-F: four follow-ups on the P3g dstack VM (update, maintenance, machine size, AK cert fields) |
| [p3g](proofs/p3g/RESULT.md) | P3g: our dstack v0.6.1 enclave on one Google Cloud C3 TDX VM |
| [p4-speed/base](proofs/p4-speed/base/RESULT.md) | P4 speed proof, Base |
| [p4-speed/hood](proofs/p4-speed/hood/RESULT.md) | P4 speed proof, Robinhood Chain (4663) |
| [p4-speed/near](proofs/p4-speed/near/RESULT.md) | P4 speed proof, NEAR |
| [p4-speed/solana](proofs/p4-speed/solana/RESULT.md) | P4 speed, Solana part: result |
| [p5-privacy](proofs/p5-privacy/MEASUREMENTS.md) | Paper 5 measurements M4, M5, M6, M7, M8, M9, M10, M11, M13 |
| [p6-data](proofs/p6-data/RESULT.md) | P6 Market data: RESULT |
| [p7-notes](proofs/p7-notes/RESULT.md) | P7 Notes: result (local part, no TDX) |
| [p8-alarm-model](proofs/p8-alarm-model/RESULT.md) | P8: model check of the waiting-withdrawal alarm and its legs (merge note M134 (6)) |
| [pool-scan-3](proofs/pool-scan-3/CHAIN-CHECKLIST.md) | Chain checklist (pool-scan-3) |
| [pool-scan-3](proofs/pool-scan-3/REPORT.md) | Pool scan 3 (card pool-review-3), 2026-11-05 20:58Z |
| [pool-scan-3](proofs/pool-scan-3/architecture.md) | Architecture (pool-scan-3) |
| [pr2-read-providers](proofs/pr2-read-providers/RESULT.md) | PR2: read providers (Solana holders; a second free NEAR reader) |
| [pr3-1click-status-echo](proofs/pr3-1click-status-echo/RESULT.md) | PR3: does 1Click's keyless `/v0/status` echo `recipient` and `refundTo` for confidential quotes? |
| [pr4-plach](proofs/pr4-plach/RESULT.md) | PR4: can v1 route Plach-only NEAR tokens without the Intear router? |
| [relay-fill](proofs/relay-fill/RESULT.md) | Relay fill times (25 Oct 2026, 18:30-19:00Z) |
| [test-money](proofs/test-money/RESULT.md) | Test money: the lanes' mainnet dev wallets (card test-wallets-funding) |
| [v2-note-gas](proofs/v2-note-gas/RESULT.md) | V2: verify a Cashu note on NEAR: gas |
| [v6-shield](proofs/v6-shield/RESULT.md) | V6: how a keyless vault pays R inside `intents.near` (pull method) |
| [vendor-facts-wx2](proofs/vendor-facts-wx2/RESULT.md) | Vendor facts for walkaway exit v2 (lane VF): result |
| [x1x2-prices](proofs/x1x2-prices/RESULT.md) | X1 and X2 from a free, read-only price sample (paper 10 G2 row 18) |

## Audits and reviews

| File | What it is |
|---|---|
| [vault-review-contract.md](audits/vault-review-contract.md) | Review of the vault contract by a separate AI reviewer that wrote none of it |
| [vault-review-async.md](audits/vault-review-async.md) | Review of the vault against NEAR's async rules (cross-contract calls and callbacks) |
| [scan-final-46b16ca4.md](audits/scan-final-46b16ca4.md) | Pre-audit security scan of the contracts at commit 46b16ca4 |
