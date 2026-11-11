CARD evm-withdraw-mainnet / live: PARTIAL (Robinhood testnet run; Base Sepolia waits for test ETH)
Money path: yes
Tx: robinhood-testnet 0xf8068ce8b26eaa1b041ad78ae92524c291bf5a288c19a7c3bd3065aec7a5e362
Tx: robinhood-testnet 0x13feefcca5b6bdc699c70a55c1ff4ec4978d0c7b76756327cfb0290e74cfa385
Tx: robinhood-testnet 0x42d39f9af8273329f7b2132ea1685fa9ed34f8c9ea210d206f50311380d0a4f4
Tx: robinhood-testnet 0x787ccef93bb94d6184bc03ae04bcf5ffd5c25bd58e442a1be3b5f617d4d95bff
Tx: robinhood-testnet 0x66df1a58d2f3b6afefe3dffbdc339be449b8e06ee46a1bc5e00c8023ddc3536f
Tx: robinhood-testnet 0x2f0d5e6398188559fcda95db16809422f57fb3f5533ca7b5f0b891df7615d467
Tx: robinhood-testnet 0xb2bc296e2c81f0a82deb5dd116844485009083114b66f9f4c332fb4c1b2c57b2
Tx: robinhood-testnet 0xc9590e101de1f6933066486c562503db1a7cb263b9d9e11e124596676c697994
Withdraw: robinhood-testnet 0x42d39f9af8273329f7b2132ea1685fa9ed34f8c9ea210d206f50311380d0a4f4 0x787ccef93bb94d6184bc03ae04bcf5ffd5c25bd58e442a1be3b5f617d4d95bff 0xee61bd78c7193a892b1207008bf1981e6a56f2d2 500000000000000
Withdraw: robinhood-testnet 0xb2bc296e2c81f0a82deb5dd116844485009083114b66f9f4c332fb4c1b2c57b2 0xc9590e101de1f6933066486c562503db1a7cb263b9d9e11e124596676c697994 0xabc87b184df1117a6e6e566a9845112695c22a2f 800000000000000

Real withdraws from the Robinhood testnet pool through the signing page's own code path: the page's pool.withdraw
screen deps and run (src/pool-testnet.ts testnetPool withdrawDeps and withdraw over src/pool-withdraw-evm.ts), on the
testnet build's own pin, pool RPCs and helper, driven by packages/signpage/scripts/pool-withdraw-evm-testnet.mjs on
2026-11-11. What differs from the page in a browser, and only that: the prover is snarkjs's fullProve in the script's
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

Base Sepolia: not run yet. E holds 0.000677898867880239 ETH there (devwallet balance, 18:28Z), and one deposit of the
pool's smallest rung needs about 0.00104 ETH.
