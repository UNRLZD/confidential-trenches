CARD vault-mainnet-money-testnet / live: PASS
Money path: yes
Tx: near-testnet 9ogyXiM7VWYUR34XzeZL6jRs2cFXcpNwKLwTncYdKmYd bf-vt-20261102t071444.testnet
Tx: near-testnet HQ4RrWMLjY2PDDC1sZrwRUrziCAnra8hsff72XH56jPh bf-vt-20261102t071444.testnet
Tx: near-testnet 9vuPCWEodZcx15sjFZvVDXjA9zHWNwvCduKkCc5j2XGG bf-vt-20261102t071444.testnet
Tx: near-testnet FHCGBq9LKhFq5oBBWGEd3JtST6RFAiz8ui29qh2GEujr holder.bf-usdc-20261101t022248.testnet
Tx: near-testnet HjEsHvqoHPVgycUGjQ4ARmvJkLYH6HNGbTH6vQ7czcvD g-2b700409.bf-vt-20261102t071444.testnet
Tx: near-testnet Fdi9xojwuSSwx452RCw3bQz6RKkwYvKJcNiEPP1GVHtu r-2b700409.bf-vt-20261102t071444.testnet

The run: contracts/vault/scripts/mainnet-money.ts on NEAR testnet, the keyless vault vault.bf-vt-20261102t071444.testnet on USDC bf-usdc-20261101t022248.testnet, both legs carried by the deployed helper.
Every signature of the run was made from a fresh clone of a commit not yet on main (the testnet rehearsal) at commit 7cac75ab2dca20a859c59580d9101426c0237ce8, every file read against that commit's tree right before each signature (contracts/vault/scripts/source-gate.mjs); each step file of the run names it.
Deposit: U 5db156315ef637d67978f00ffc55e9f1a44cde99df30a7b6052a24bf06868fbe (U_{s,i} of the run's 12 words, i 3) signed its ft_transfer_call as a NEP-366 DelegateAction (packages/wallet/src/deposit/bind.ts bindDeposit), carried by g-2b700409.bf-vt-20261102t071444.testnet; the deposits page holds P 4431934907343414024279762844103242627681968311225815598123756878276805036648 by U with 3000000, label 1889258107544349984632107188070621822146057463647494919293467308972009938779, leaf 13.
Withdrawal: the wallet's withdrawRequest to bf-vt-20261102t071444.testnet (fund_recipient false, no change: withdrawn = the note), proved in this process by snarkjs fullProve on the kit's pinned setup files (the stand-in for the page's prover worker), carried by r-2b700409.bf-vt-20261102t071444.testnet; spends row #7: 3000000 withdrawn to bf-vt-20261102t071444.testnet, fee 184338 to f-2b700409.bf-vt-20261102t071444.testnet, payer r-2b700409.bf-vt-20261102t071444.testnet, paid.
Every Tx above read back FINAL, every receipt a success, as scripts/ci/money-gate.mjs reads it: on two operators, or, older than dRPC keeps, on FastNEAR's archival RPC and proven against a final block dRPC names.
Before the deposit (2026-11-08T05:16:26.753Z): U USDC 3000000, vault USDC 500000, totals {"deposited":"8000000","spent":"9400000","returned":"1900000"}. After (2026-11-08T05:16:44.299Z): U USDC 0, vault USDC 3500000, totals {"deposited":"11000000","spent":"9400000","returned":"1900000"}.
Before the withdrawal (2026-11-08T05:16:49.426Z): bf-vt-20261102t071444.testnet USDC 0, F USDC 204633, vault USDC 3500000. After (2026-11-08T05:17:06.299Z): bf-vt-20261102t071444.testnet USDC 2815662, F USDC 388971, vault USDC 500000, totals {"deposited":"11000000","spent":"12400000","returned":"1900000"}.
