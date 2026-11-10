CARD signpage-evm-pool-buy / live: PASS
Money path: yes
Tx: base-sepolia 0x51d3660144eb0bbcd2032fbbc87586a7dc625bdcd34eb52e5d692b9f7b53fc6b
Tx: base-sepolia 0x374260bc1fe459743f0cc3c7ee2086c86cbd9cfe84fc4564122a23f5e269bbcc
Tx: base-sepolia 0xbfeed905872cabaebefa3c03aa327cfefa84256a021efacc5b8baa387a568064
Tx: base-sepolia 0x72c36797ea3644e342a5b40d0387e6d4013c96064326f6f16bcdfa45ccb1ed0e
Tx: robinhood-testnet 0xe5bcf64c21316fd48dc6b4a9e06878623216666f57edb9d66ea2f9f7195f5572
Tx: robinhood-testnet 0xbf8bbb2283a092e49944c0c45d197bc07a7ac0febe9c60cb77c20aaf4db6ceaa
Tx: robinhood-testnet 0x43543fc6b78cc9cf6fff800cd5338e7df1e8ef747c60e87174cbbca6205c05fb
Tx: robinhood-testnet 0xd0951815432c66af3d2ef4f4c5130fe44d660a361297beb95b9821df424ecb74
Buy: base-sepolia 0x72c36797ea3644e342a5b40d0387e6d4013c96064326f6f16bcdfa45ccb1ed0e
Buy: robinhood-testnet 0xd0951815432c66af3d2ef4f4c5130fe44d660a361297beb95b9821df424ecb74

One real private buy on each testnet through the signing page's own code path: the page's pool kinds
(src/pool-kinds.ts over src/pool-testnet.ts testnetPool, as main.ts wires them) on the testnet build's own pins, pool
RPCs and helper, driven by packages/signpage/scripts/pool-buy-evm-testnet.mjs on 2026-11-10. What differs from the page
in a browser, and only that: the prover is snarkjs's fullProve in the script's process, and the wallet store is
fake-indexeddb. The chain's proof queue made the proof (about 4.5 s each), and pool.buy quoted on the kit's pinned
providers, built with the kit's quoted build, passed checkEvmBuy, had W sign, took the note, sent through the helper's
POST /v1/pool/evm/send and read the transaction back on the chain's two pool RPCs (src/pool-buy-evm.ts). Each run's seed
was made by its deposit run (packages/signpage/scripts/pool-deposit-evm-testnet.mjs --settle --keep-seed: 16 random
bytes, kept 0600 in ~/.ct-devnet-runs, never printed), and the note came back
from the seed alone through the wallet's evmRestoreNotes. Every transaction above is a testnet one; nothing ran on a
mainnet.

The Tx lines, per chain in order: the team's test wallet E (0x49f2425b7f33f3a10912de8add6839226ce663a2) funds the
one-time deposit wallet U; U's deposit of 0.001 ETH into the pinned pool (src/pool-deposit-evm.ts, 01:25Z); E funds the
helper's testnet withdraw sender; the buy. The Buy lines name the buys, which the live check reads back.

base-sepolia: pool 0xeb967dfc1b4ffb22942f833c76866ea85fc42266. U 0xbe9086DfCF43BB13ae3CD85e2f545462588fdF07 was funded
1024612320002121 wei; its deposit read back succeeded in block 56760219 on base-sepolia-rpc.publicnode.com and
base-testnet.api.pocket.network, and the page's load pass settled the note UNSPENT at 01:50Z. The buy of Base Sepolia
USDC (0x036cbd53842c5426634e7929541ec2318f3dcf7e) at 03:12:27Z: the chunk 1000000000000000 wei, the proof's fee
20000000000000 wei, W 0xDf7Fe9f8a74A82F25917dF157F728F21a41BAeAe, route Uniswap v4 native to USDC (fee 500, tick
spacing 10, no hook) through the pinned v4 adapter 0x706b3f75e80be70494d1414b85788462bfeb7eb1. The helper named its
hash; both pool RPCs read it as this very buy and its receipt succeeded in block 56792394 with the pool's Bought for W,
3.297121 USDC; the page answered sent at the read-back, then filled, and wrote W's holding with that route.

robinhood-testnet: pool 0xed9fac860e6bc5e932455232eedca8b71c44da4d. U 0xc75410c3A0B45abD18f39e75BAC44B190f1dC437 was
funded 1035381040000000 wei; its deposit read back succeeded in block 151118532 on rpc.testnet.chain.robinhood.com and
robinhood-sepolia-rpc.publicnode.com. The buy of tSPILL (0x10e626a1d0857174b9a5bdb7a1397068811fbbbc) at 03:13:37Z: the
chunk 1000000000000000 wei, the proof's fee 30000000000000 wei, W 0x2679E9de42B50d97A5465D1ee83d2Cb79690A935, route
Uniswap v4 native to tSPILL (fee 10000, tick spacing 200, no hook) through the pinned v4 adapter
0x6c43a39fcb2ea65f47625ef5ce5fea98fc669797. Both pool RPCs read it as this very buy, succeeded in block 151156889 with
the pool's Bought for W, 0.000960299999985954 tSPILL; filled, W's holding written with that route.

The first tries (03:07Z to 03:10Z) were held by the helper, 429 rate_limited "the sender keeps 1056000000000000 wei for
withdraws: balance 1000000000000000": each testnet withdraw sender (Base Sepolia 0x6c830ac1b22d96baf692af4dd17d822ba61c32ec,
Robinhood testnet 0xe40f67e8502a3e2ebf4caf7bdee8ac8758b472a7) held 0.001 ETH, under the reserve it keeps for withdraws,
so it held every buy. Nothing of those tries reached a chain: the restore at the next run read each note UNSPENT, and the
buys above spent those same notes. E then funded the senders (0.002 ETH on Base Sepolia, 0.0012 ETH on Robinhood testnet).
The Robinhood deposit's note stayed INCOMING through 40 minutes of the deposit runner's load passes, each answering
failed, while the pool's sync read the deposit on both RPCs at 02:51Z; the buy run restored it from the seed.
