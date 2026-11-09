CARD vault-mainnet-money / live: PASS
Money path: yes
Tx: near 69oUWMcN329Su1LsMffc5yTqJgT4vAZJneUyu2GFJGiu confidential.unrlzd.near
Tx: near FtDfFRw8GAaHJiAN11ZY5K3f2xmoH2rnaFX3K9yAAJem confidential.unrlzd.near
Tx: near ATjxHXNpwbKLrR5PJP1uJCCKXpz7jsquR3X5PUFAbPAV cudam321.near
Tx: near 84x8XDXGUoLR3kgdYDiShekLqfzxetfQydQfigKEsA5R f874a24241077a92d78daebf0e20585b2b6c89f7da30b05a67fb1969f70388cc
Tx: near eP88kSmCM2bkRL3jPY3ehpKgAuHKd1yoP59oAmGMquA 4519129d35447942d92ef046ffa52af0430fb06b95b59936d7173290a6972756

The run: contracts/vault/scripts/mainnet-money.ts on NEAR mainnet, the keyless vault vault.confidential.unrlzd.near on USDC 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1, both legs carried by the deployed helper.
Every signature of the run was made from a fresh clone of the public repo at commit ca80421e4f8e3c504aa1d716e9cb0e54266508b8, every file read against that commit's tree right before each signature (contracts/vault/scripts/source-gate.mjs); each step file of the run names it.
Deposit: U 0d0214dc99bf284e465bb1c759c3bf9a55cfe779bad388332953a4832192d78a (U_{s,i} of the run's 12 words, i 5) signed its ft_transfer_call as a NEP-366 DelegateAction (packages/wallet/src/deposit/bind.ts bindDeposit), carried by f874a24241077a92d78daebf0e20585b2b6c89f7da30b05a67fb1969f70388cc; the deposits page holds P 14198723572156951681823342448844248402716801254690840367605001541242553995333 by U with 5000000, label 12358938501023889148324082393290806327154971530453644292811004297252817066193, leaf 0.
Withdrawal: the wallet's withdrawRequest to confidential.unrlzd.near (fund_recipient false, no change: withdrawn = the note), proved in this process by snarkjs fullProve on the kit's pinned setup files (the stand-in for the page's prover worker), carried by 4519129d35447942d92ef046ffa52af0430fb06b95b59936d7173290a6972756; spends row #0: 5000000 withdrawn to confidential.unrlzd.near, fee 181335 to fees.unrlzd.near, payer 4519129d35447942d92ef046ffa52af0430fb06b95b59936d7173290a6972756, paid.
Every Tx above read back FINAL, every receipt a success, as scripts/ci/money-gate.mjs reads it: on two operators, or, older than dRPC keeps, on FastNEAR's archival RPC and proven against a final block dRPC names.
Before the deposit (2026-11-09T04:08:08.263Z): U USDC 5000000, vault USDC 0, totals {"deposited":"0","spent":"0","returned":"0"}. After (2026-11-09T04:08:51.517Z): U USDC 0, vault USDC 5000000, totals {"deposited":"5000000","spent":"0","returned":"0"}.
Before the withdrawal (2026-11-09T04:13:20.151Z): confidential.unrlzd.near USDC 0, F USDC 0, vault USDC 5000000. After (2026-11-09T04:13:36.915Z): confidential.unrlzd.near USDC 4818665, F USDC 181335, vault USDC 0, totals {"deposited":"5000000","spent":"5000000","returned":"0"}.
