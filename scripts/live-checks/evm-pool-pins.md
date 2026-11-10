CARD evm-pool-pins / live: PASS
Money path: yes
Tx: base-sepolia 0xb3520709c14ccbe5fd26ad841717aaf2e8b57900da54d4c2d7b710f58655f1b4
Tx: base-sepolia 0xc833bf205e5ac2f125a6f1dcee248590cd05f81d2eb878f213a0856f2e169db8
Tx: robinhood-testnet 0x76a09050a5f9b8b6d4c7957f172fdbc4da386209e9760cf5407bb86dae66ae67
Tx: robinhood-testnet 0x3ea19ef953028034ff6c8b365a106e6d17c4b30dde52ca59a17bc04d71fe7339

One real pool deposit on each testnet through the signing page's own EVM deposit runner on the testnet build's own pins,
packages/signpage/scripts/pool-deposit-evm-testnet.mjs (src/pool-deposit-evm.ts runPoolDepositEvm with the wallet's
EVM_POOLS and src/pool-testnet.ts TESTNET_RPCS, the network set to testnet), 2026-11-09 21:53-21:54Z. Each run's seed was
made in the run (16 random bytes, never printed or kept), so each 0.001 ETH stays in its pool as a test deposit. Its
steps, in the order of its Tx lines above: the team's test wallet E (0x49f2425b7f33f3a10912de8add6839226ce663a2,
scripts/devwallet/devwallet-evm.mjs) funds the one-time deposit wallet U with the wei the runner's first answer named
short, then U's deposit of 0.001 ETH into the pinned pool.

base-sepolia: pool 0xeb967dfc1b4ffb22942f833c76866ea85fc42266 (deploy block 55524040, fee recipient
0x6c830ac1b22d96baf692af4dd17d822ba61c32ec), U 0x03192340908aDbeD4c6F30087A890c33b92feabA funded 1024612320003774 wei. The
deposit's receipt read back succeeded in block 56696984 on base-sepolia-rpc.publicnode.com and
base-testnet.api.pocket.network (the page's pair), with the pool's Deposited naming the note's precommitment
0x1c1217ea65e692f48768131a37a3babc769a743c8ee4818e2a32679841be2f2b.

robinhood-testnet: pool 0xed9fac860e6bc5e932455232eedca8b71c44da4d (deploy block 149841188, fee recipient
0xe40f67e8502a3e2ebf4caf7bdee8ac8758b472a7), U 0xE7b527Ecc66f1740e691f05436fECae1808003f7 funded 1034612320000000 wei. The
deposit's receipt read back succeeded in block 151047027 on rpc.testnet.chain.robinhood.com and
robinhood-sepolia-rpc.publicnode.com, with the pool's Deposited naming the note's precommitment
0x19b3cd01e6590d35d6bb44b08c6dd3194b026ca2faf1d4d79af0d17fbc6cf19a.

Each note is INCOMING at the run's end: a Deposited is final only ~1,000 s on, and the note's settle to UNSPENT is the
page's load pass (card signpage-evm-proof-queue's proof queue waits on it), not this card's.

node scripts/live-checks/evm-pool-pins.mjs passed on 2026-11-09: each pin's deploy receipt (block and contract) and the
pool's code the same on both RPCs of pool-evm-deploy.mjs CHAINS, and the deployed helper's GET /v1/pool/fee naming the
pin's fee recipient. The 3 Nov pools of pool-evm-deploy.md are older builds the helper answers 404 for: that record's pool
lines are stale for the pools the device uses.
