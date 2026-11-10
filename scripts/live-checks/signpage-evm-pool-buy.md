CARD signpage-evm-pool-buy / live: PASS
Money path: yes
Tx: base-sepolia 0x51d3660144eb0bbcd2032fbbc87586a7dc625bdcd34eb52e5d692b9f7b53fc6b
Tx: base-sepolia 0x374260bc1fe459743f0cc3c7ee2086c86cbd9cfe84fc4564122a23f5e269bbcc
Tx: base-sepolia 0xbfeed905872cabaebefa3c03aa327cfefa84256a021efacc5b8baa387a568064
Tx: base-sepolia 0x72c36797ea3644e342a5b40d0387e6d4013c96064326f6f16bcdfa45ccb1ed0e
Tx: base-sepolia 0xf745626323ba2a560b144b8b2dbf112b88e9d56f32c6e6830d014ecb20c93519
Tx: base-sepolia 0xd79d7ff9535883b129b2f7bb5145f66e157ff688c683758e5474e078d4f9fe14
Tx: base-sepolia 0x41ddc17fc2ca900a6c50541125e326f7871407e8645bcc916a6ff729191aaa0c
Tx: base-sepolia 0xfb54d7cdeaf75c7aaf9790139bcf019d7588be96d9714c076505a7448809ae98
Tx: base-sepolia 0xd69bad77d3454db55e78bcc24d4d5a143de40273fa9905d47733dccf89fcc3df
Tx: base-sepolia 0xd5b86cb358f400ae60ae0316810fb956cf9d4a1da9bcfe57bb933723e03adce4
Tx: robinhood-testnet 0xe5bcf64c21316fd48dc6b4a9e06878623216666f57edb9d66ea2f9f7195f5572
Tx: robinhood-testnet 0xbf8bbb2283a092e49944c0c45d197bc07a7ac0febe9c60cb77c20aaf4db6ceaa
Tx: robinhood-testnet 0x43543fc6b78cc9cf6fff800cd5338e7df1e8ef747c60e87174cbbca6205c05fb
Tx: robinhood-testnet 0xd0951815432c66af3d2ef4f4c5130fe44d660a361297beb95b9821df424ecb74
Tx: robinhood-testnet 0x102b23d3dca9e168eac747afe92dee1fe49d29b1f36401b9edba4a93d911438f
Tx: robinhood-testnet 0xc983514b18f8134dd64e586e6ee7803ac9d227d15f3c904ee32e7c47459caecb
Tx: robinhood-testnet 0xf190dfafacf70bf629155a1cc8eb12ef428657bd7f23380d9f62e8d707d33d84
Buy: base-sepolia 0x41ddc17fc2ca900a6c50541125e326f7871407e8645bcc916a6ff729191aaa0c
Buy: robinhood-testnet 0xf190dfafacf70bf629155a1cc8eb12ef428657bd7f23380d9f62e8d707d33d84
Buy: base-sepolia 0xd5b86cb358f400ae60ae0316810fb956cf9d4a1da9bcfe57bb933723e03adce4

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

The second run (04:32Z to 04:37Z), on the rebuilt read-back: the buy answers "sent" once the helper has the bytes, then
reads its end only from the pool's own Bought and Withdrawn events (eth_getLogs by the pool's address and the two event
topics, from the newest block read before the send), matches the proof's nullifier on the device, and ends filled when
both pool RPCs show the same Bought paying W the token at least the min out W signed. Per chain, its three Tx lines (the
last three) are: E funds a new U, U's deposit of 0.001 ETH into the pinned pool, the buy; the Buy lines name these buys,
which the live check reads back.

base-sepolia: U 0x9e7A3c932cF9aa86f5A7e15DEc7589f446C302BA, funded 1024612320002043 wei; its deposit read back in block
56816773 on both pool RPCs, and the buy run restored the note UNSPENT from the seed. The buy of Base Sepolia USDC at
04:35:54Z: the chunk 1000000000000000 wei, the fee 20000000000000 wei, W 0xF39fA9D6Efd0C441a623e0ba41f6d870A6116679,
route Uniswap v4 native to USDC (fee 500, tick spacing 10, no hook) through the pinned v4 adapter. The page answered
sent 11.4 s after the tap, then filled 2.8 s later from both RPCs' Bought in block 56817486 for 2.529634 USDC; W's
holding, written pending before the send, was completed with that amount, the transaction and the block.

robinhood-testnet: U 0xcB80853b53097154CC30FeD246d49842C95703d9, funded 1035381040000000 wei; its deposit read back in
block 151182480 on both pool RPCs. The buy of tSPILL at 04:36:33Z: the chunk 1000000000000000 wei, the fee
30000000000000 wei, W 0x94FE4C14e7012e00A21752AC052094B4c21980BB, route Uniswap v4 native to tSPILL (fee 10000, tick
spacing 200, no hook) through the pinned v4 adapter. Sent 5.4 s after the tap, filled 2.8 s later from both RPCs'
Bought in block 151183344 for 0.000960299999983784 tSPILL.

Who learned what, from each run's request log (every request from the tap to the end): the helper's POST
/v1/pool/evm/send carried the calldata, so it learned W, the proof's nullifier and the route; every other request went to
the chain's two pool RPCs (eth_call for the quote and the token's decimals, eth_blockNumber, eth_getBlockByNumber,
eth_getLogs, eth_chainId) and named none of W, the nullifier or the transaction hash.

The third run (06:26Z to 06:33Z), on the read-back of the second review's fixes (not_landed judged on each RPC's safe
block on two rounds 10 s apart, block hashes compared, the log range stopped at the deadline's safe block, the holding
written only to the open store): Base Sepolia only. Its three Tx lines (after the second run's Base buy) are E funding U
0x131E1D3c5f7cfe41404083A8Cf17d53307AE64ec with 0.0010257 ETH, U's deposit of 0.001 ETH (block 56850956 on both pool
RPCs), and the buy, the last Buy line. The buy of Base Sepolia USDC at 06:32:32Z: the chunk 1000000000000000 wei, the fee
20000000000000 wei, W 0x24818f99F03808a2A8BeAB6978149a44D43e788d, route Uniswap v3 WETH to USDC (fee 100) through the
pinned v3 adapter 0xee89916bc4bdeee46dbcaf8fad2b7604724b5645. Sent 10.2 s after the tap, filled 3.3 s later from both
RPCs' Bought in block 56852469 for 2.069392 USDC; W's holding was completed with that amount, the transaction and the
block. Only the helper's POST /v1/pool/evm/send named W and the nullifier; every pool RPC request named none of W, the
nullifier or the transaction. A try at 06:30Z answered failed before the take: the run script's page gave no open store
(main.ts gives held: opened()), so the pending write failed and nothing was signed into a send or left the device; the
script now gives it. Robinhood testnet was not run: E holds 0.00017 ETH there, under the 0.001 ETH a deposit needs.
