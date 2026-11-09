CARD exit-ids-out / live: PASS
Money path: yes
Tx: near-testnet HTbnXmDWa5aC7xRWS6VKGMTaWmEHjFKXLYqw48SiYcFt holder.bf-usdc-20261101t022248.testnet
Tx: near-testnet BRSKJ2fjBuPwC4VNDrA1hGf43DGurf7vhns3BZeEA993 holder.bf-usdc-20261101t022248.testnet
Tx: near-testnet B6VYQAWnZcXtu6r8oCneCtiqBfMhgnUApzJUdtm55cBe holder.bf-usdc-20261101t022248.testnet
Tx: near-testnet 12FB5at3a7bGPSRHayeu9TWpzfoHMyjHtaLLrV27KX3a holder.bf-usdc-20261101t022248.testnet
Tx: near-testnet 6ynfpLNx4ZFqAN8yt5qqHYnHQ6oCWfcktpXmKx3cH2AY 3b4e148d0142e7332884857b78b2b811543bec69f7597fb5e811ed27ea98da6e
Tx: near-testnet 8pmGCjzH1xy4i6t7sDQUqucKjeiKzo6H4AR5nfomjBr7 6e3d2c3304f12de90a2e3a319dd820a282767b580442765bc0211517dfbf4a5c

The run: packages/exit/scripts/out-testnet.ts on NEAR testnet, the team's test USDC bf-usdc-20261101t022248.testnet; the reads are the exit tool's exitHoldings and the wallet's readMoveOutFor on the release's testnet pair https://test.rpc.fastnear.com and https://near-testnet.drpc.org, each move built by exitBuildMove (leg token) and self-submitted to both.
Accounts: H holder.bf-usdc-20261101t022248.testnet (the stand-in for the typed account's NEAR and for the money that reached U and A), U 3b4e148d0142e7332884857b78b2b811543bec69f7597fb5e811ed27ea98da6e (U_{1,0} of this run's seed), A 6e3d2c3304f12de90a2e3a319dd820a282767b580442765bc0211517dfbf4a5c (A_{1,0}), X a55ccf7dfb8cfd4fc80b3265ae711a424b6b24cd9b7d0be4b69887028c88a6fd (the typed account: an implicit id, never created, unregistered before the run).
Steps: H sends U and A 50000000000000000000000 yocto NEAR each (creates them), registers each on the token and sends U 2000000 and A 1500000; the tool reads U, A and X at one block on both RPCs, then U's own tx [storage_deposit(X, registration_only) 1250000000000000000000 yocto, ft_transfer(X, 1999999)] and A's own tx [ft_transfer(X, 1500000)], each FINAL on both RPCs, every receipt a success.
Balances (exitHoldings, both RPCs at one block): before at 276869507 U 2000000, A 1500000, X 0; after at 276869539 U 1, A 0, X 3499999.
Times: the two moves, read to FINAL on both, 18084 ms.
Every Tx above read back FINAL on both testnet RPCs (H's by send_tx wait_until FINAL); then node scripts/ci/money-gate.mjs on this file.
