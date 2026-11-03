CARD pool-evm-deploy / live: PASS
Money path: yes
Tx: base-sepolia 0x81afdd86bf9414e88e41994a9a7bbb34edf3027cf355a803c9d65662a8d0595a
Tx: base-sepolia 0x388b62ddca5ba87084edb814e5290f097be2ff9b4ecb1dec69b5f2c567cb163a
Tx: base-sepolia 0x7d41a32a29ab0d83f5c1925d921ef4bdfa085fa0e21a99dc5a8aa9d88e7b4b3d
Tx: base-sepolia 0x15fb103bd8b7e7b50ddb094cfe723fde897a819590460a78071259d45fe7cab3
Tx: base-sepolia 0x61695b636dc7377c00c1a60bfd179f745df593f3d6b68ed46744ccc284a4f2c7
Tx: base-sepolia 0x68517c1364e8bc5e6362fa722056d85eccbbfe9769c63b5f9181d17cc1fde3fe
Tx: robinhood-testnet 0x00baca733e1232a031cd0f2d62b0c6cceb70e5676be8d055d75d30115b7b8a56
Tx: robinhood-testnet 0x32169e3cd8f365ae90a10f43eca8f1cc32953ee9bc60e3d6cd2f3253ae3cba23
Tx: robinhood-testnet 0xfa9dee2d45f9754b926d5ab09458621bfd8cd66133a381254b9ab36ca208fb85
Tx: robinhood-testnet 0x329af87381617d36dda098b6195cf419480ceca3fdb873334f1b86c2ab6b58ac
Tx: robinhood-testnet 0x81585a01cd96a49040cf4afa1f3061d50ad415871363c4d9fb46ede5f4417089

base-sepolia (chain id 84532), contracts/pool-evm/script/deploy.mjs at 2026-11-03T05:02:50.570Z. Its steps, in the order of its Tx lines above: deploy WithdrawalVerifier, deploy PrivacyPoolSimple, deploy UniswapV4Adapter, deploy UniswapV3Adapter, deploy SellDelegate, sweep (the run key's rest back).
WithdrawalVerifier 0x8ff8fe1bd39d95faccada211acd8b3ea15bef730, PrivacyPoolSimple 0xb239a38af69b68e6c5c305df64985f283b5d5fe5, UniswapV4Adapter 0x706b3f75e80be70494d1414b85788462bfeb7eb1, UniswapV3Adapter 0xee89916bc4bdeee46dbcaf8fad2b7604724b5645, SellDelegate 0x23ad5aabcc139650597f8dc79e9def8bd817ef88; each one's code is the build's (solc 0.8.28 (contracts/pool-evm/foundry.toml), forge Version: 1.7.1-Homebrew), read by this live check on https://sepolia.base.org and https://base-sepolia-rpc.publicnode.com. No contract has an owner, an admin or an upgrade path.
Deployer 0x3ea67bf9899305cc02f36c8b68c805dcc6319e94, a run key that lived only in the run, funded with 66861841654853 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2 at the run's end.

robinhood-testnet (chain id 46630), contracts/pool-evm/script/deploy.mjs at 2026-11-03T05:04:19.470Z. Its steps, in the order of its Tx lines above: deploy WithdrawalVerifier, deploy PrivacyPoolSimple, deploy UniswapV4Adapter, deploy SellDelegate, sweep (the run key's rest back).
WithdrawalVerifier 0x4bc4718854f43d2b10335ae5ac9fe2a8c7d72016, PrivacyPoolSimple 0xe5e948414a89c23e73d76cd740dacdd9364c25d5, UniswapV4Adapter 0x6c43a39fcb2ea65f47625ef5ce5fea98fc669797, SellDelegate 0x0ec8c6627939624aeaac3b2f0276136e6e289e23; each one's code is the build's (solc 0.8.28 (contracts/pool-evm/foundry.toml), forge Version: 1.7.1-Homebrew), read by this live check on https://rpc.testnet.chain.robinhood.com and https://robinhood-sepolia-rpc.publicnode.com. No contract has an owner, an admin or an upgrade path.
Deployer 0x096d73f23063dd9d3af3eb441f1da525cb0685a2, a run key that lived only in the run, funded with 109320100000000 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2 at the run's end.

The testnet addresses the contracts call are read on chain, not taken from a published page, for Robinhood testnet (no Uniswap page lists it): its PoolManager has the code hash of the Robinhood mainnet PoolManager, and WETH answers symbol and name "WETH" behind an upgradeable proxy whose implementation this check pins (M365).
