CARD evm-withdraw-mainnet / live: PASS
Money path: yes
Tx: robinhood-testnet 0xf8068ce8b26eaa1b041ad78ae92524c291bf5a288c19a7c3bd3065aec7a5e362
Tx: robinhood-testnet 0x13feefcca5b6bdc699c70a55c1ff4ec4978d0c7b76756327cfb0290e74cfa385
Tx: robinhood-testnet 0x42d39f9af8273329f7b2132ea1685fa9ed34f8c9ea210d206f50311380d0a4f4
Tx: robinhood-testnet 0x787ccef93bb94d6184bc03ae04bcf5ffd5c25bd58e442a1be3b5f617d4d95bff
Tx: robinhood-testnet 0x66df1a58d2f3b6afefe3dffbdc339be449b8e06ee46a1bc5e00c8023ddc3536f
Tx: robinhood-testnet 0x2f0d5e6398188559fcda95db16809422f57fb3f5533ca7b5f0b891df7615d467
Tx: robinhood-testnet 0xb2bc296e2c81f0a82deb5dd116844485009083114b66f9f4c332fb4c1b2c57b2
Tx: robinhood-testnet 0xc9590e101de1f6933066486c562503db1a7cb263b9d9e11e124596676c697994
Tx: base-sepolia 0xbf443e896b369bcfc544674c837c77df6f95b2fded64a502d660204184d618e9
Tx: base-sepolia 0xa4b50bb10000327f795b6ee9b8ce6c9dd87ed36b30539a30333e4d6e496b5116
Tx: base-sepolia 0xda8015584a2275aa65be588c7c3d2631c41d8a297b2c5cdfb96c23d0dc996cf8
Tx: base-sepolia 0xb7ecd3df8aabb8989e773a307058cd307bf6f75027fb5623b0e1b990d7aac298
Tx: base-sepolia 0x176aa849ff6e3f7a896a8cebaf841d34122681835aa42a53837df29004321332
Tx: base-sepolia 0xc4b2544b7e7c471686a8f6c2071cdf1b57dc2cdbcc5d62d5308bbf86cbb0a3aa
Tx: base-sepolia 0xc2c16e3ea07897b6fedca8734f0ea233acd19746b76c267f873bc4fd45c56491
Tx: base-sepolia 0x053dde6c340f1b171780a52c75fb36df160088dadca6c6edb44a54a6a381db09
Withdraw: robinhood-testnet 0x42d39f9af8273329f7b2132ea1685fa9ed34f8c9ea210d206f50311380d0a4f4 0x787ccef93bb94d6184bc03ae04bcf5ffd5c25bd58e442a1be3b5f617d4d95bff 0xee61bd78c7193a892b1207008bf1981e6a56f2d2 500000000000000
Withdraw: robinhood-testnet 0xb2bc296e2c81f0a82deb5dd116844485009083114b66f9f4c332fb4c1b2c57b2 0xc9590e101de1f6933066486c562503db1a7cb263b9d9e11e124596676c697994 0xabc87b184df1117a6e6e566a9845112695c22a2f 800000000000000
Withdraw: base-sepolia 0xda8015584a2275aa65be588c7c3d2631c41d8a297b2c5cdfb96c23d0dc996cf8 0xb7ecd3df8aabb8989e773a307058cd307bf6f75027fb5623b0e1b990d7aac298 0x8f6690321e0349538002863a5825535ea69d2eae 400000000000000
Withdraw: base-sepolia 0xc2c16e3ea07897b6fedca8734f0ea233acd19746b76c267f873bc4fd45c56491 0x053dde6c340f1b171780a52c75fb36df160088dadca6c6edb44a54a6a381db09 0xcf134049d8dc188a352a6f17ca3cfd449b438f32 500000000000000

Real withdraws from the Robinhood testnet and Base Sepolia pools through the signing page's own code path: the page's
pool.withdraw screen deps and run (src/pool-testnet.ts testnetPool withdrawDeps and withdraw over
src/pool-withdraw-evm.ts), on the testnet build's own pin, pool RPCs and helper, driven by
packages/signpage/scripts/pool-withdraw-evm-testnet.mjs on 2026-11-11 (Robinhood) and 2026-11-12 (Base Sepolia). What differs from the page in a browser, and only that: the prover is snarkjs's fullProve in the script's
process, and the wallet store is fake-indexeddb. Each run's seed was 16 random bytes made for it (kept 0600 in the
run's own folder, never printed); its note came back from the seed alone (the wallet's evmRestoreNotes). To is an
address derived for the run from its seed, holding nothing before. Every transaction above is a testnet one; nothing
ran on a mainnet.

The Tx lines, per run in order: the team's test wallet E (0x49f2425b7f33f3a10912de8add6839226ce663a2) funds the
one-time deposit wallet U; U's deposit of 0.001 ETH into the pinned pool (pool-deposit-evm-testnet.mjs, settled UNSPENT
by the page's load pass); the release to W (PrivacyPool.withdraw through the helper's POST /v1/pool/evm/send); W's one
send to To. The Withdraw lines name each release, W's send, To and the part, which the live check reads back.

robinhood-testnet, pool 0xed9fac860e6bc5e932455232eedca8b71c44da4d, read on rpc.testnet.chain.robinhood.com and
robinhood-sepolia-rpc.publicnode.com:
- Run 1 (18:05Z): 0.0005 ETH to To 0xEE61BD78c7193A892B1207008BF1981e6A56F2d2. The screen read the epoch fee
  40000000000000 wei, W's fee 210000000000 wei (21,000 gas at the base fee, 10,000,000 wei, as the max fee), the
  smallest part 39790000000000 wei, and drew the Max fee 40210000000000 wei. The chunk 540210000000000 left the pool to
  W 0xd591e04e171d6485eEA3bEb7Dd6f67755dCC1b8D in block 151930596 (status 1 on both, 491,175 gas); W's send of
  exactly 500000000000000 wei landed in block 151930631 (status 1 on both, 21,000 gas at 10,000,000 wei). To read
  500000000000000 wei on both RPCs after, W 0 on both. The op answered sent 61 s after the tap.
- Run 2 (18:24Z, W's send lost): 0.0008 ETH to To 0xABc87b184df1117A6E6E566a9845112695C22A2F. The release reached W
  0xdd00ad5eAA863D704FE29Bd78556E1b99073F998 in block 151937859; the script dropped every raw send it made (24, the
  page's only raw send being W's), so the run ended in_transit with its owed send kept in meta/owed/<op>. Then two page
  loads on the same store (a reload and another tab) ran their state reads side by side: W's send of exactly
  800000000000000 wei left once and landed in block 151938676 (status 1 on both), the op ended sent with it, the owed
  record cleared. To read 800000000000000 wei on both RPCs, W 0 on both.

base-sepolia, pool 0xeb967dfc1b4ffb22942f833c76866ea85fc42266, read on base-sepolia-rpc.publicnode.com and
base-testnet.api.pocket.network, on 2026-11-12 from commit 8fa3cb80. Two deposits of 0.001 ETH first, each under its
own seed (pool-deposit-evm-testnet.mjs base --settle --keep-seed): U 0xA3b043B6975F1acC833aA61AE3b5bbB680604e54 and
U 0xE369DB528B5C2994918679c7eb4671ee95d2cFB9, each funded with 0.0011 ETH by E (blocks 57950619 and 57950643), each
deposit in blocks 57950690 and 57950704 (status 1 on both), settled UNSPENT by the page's load pass at 19:55:26Z and
19:54:36Z. The screen read the epoch fee 20000000000000 wei, W's fee 420000000391 wei, the smallest part
19579999999609 wei, and drew the Max fee 20420000000391 wei.
- Run 1 (20:07Z): 0.0004 ETH to To 0x8f6690321e0349538002863A5825535ea69D2eae. The release left the pool to W
  0x62B3CbCd260Cb2e0f65F4C15241f4300Cc334Df1 in block 57961812 (status 1 on both, 496,361 gas); W's send of exactly
  400000000000000 wei landed in block 57961841 (status 1 on both, 21,000 gas). To read 400000000000000 wei on both RPCs
  after, W 105000000101 wei (its fee's unspent rest). The op answered sent 292 s after the tap.
- Run 2 (20:07Z, W's send lost): 0.0005 ETH to To 0xcF134049D8dC188A352A6F17ca3Cfd449b438F32. The release reached W
  0x122aAd9484C0AfB0A2289cfa7554724dE9C221F7 in block 57961832 (status 1 on both); the script dropped every raw send it
  made (24), so the run ended in_transit with its owed send kept. A restore from the words at 20:13:04Z read the note
  and no spend yet (the release was not under the finalized block). Then two page loads on the same store ran their
  state reads side by side: W's send of exactly 500000000000000 wei left once and landed in block 57962608 (status 1 on
  both), the op ended sent, the owed record cleared. To read 500000000000000 wei on both RPCs, W 105000000165 wei.

A first try of both runs at 19:56Z and 19:57Z stopped before anything was signed: the restore from each seed, 100 s after
the settle, read 0 notes. The restore counts a leaf only at or under the finalized block both RPCs agree on, and
finalized trails latest by 1,275 s on Base Sepolia (read 20:05Z; 1,108 s on Base, 1,131 s on Robinhood, 956 s on
Robinhood testnet), and the two providers' finalized answers differ, one by 218,765 blocks once in 12 reads. The same
restores at 20:02Z and 20:03Z each read the note UNSPENT. The fix is card evm-money-shows-and-spends-at-once.

Mainnet: the real Base and Robinhood mainnet withdraws come from the owner's own withdraw taps on the signing page after
its deploy, and only from them; none is in this record yet. Once the record names one mainnet withdraw, the check asks
one on Base mainnet and one on Robinhood mainnet, each read back on both of its chain's pool RPCs.
