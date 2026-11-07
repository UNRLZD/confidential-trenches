CARD pool-evm-deploy-mainnet / live: PASS
Money path: yes
Tx: base 0x35e8186a5ecb572c4fd92fa6cc400aa285764e43da46603888d460aa506febb0
Tx: base 0x2e0cba4bfa2c24ae138ade564a027c5d83943340153dec0ad2e278c8c89b23c7
Tx: base 0xc22297be884ee296ac260de7e88df8ff17ecc479417cd9b65ced0e10a50aa6f6
Tx: base 0x5d52f7359745f87a2e8b288162d21728fea5a2b60a4065c3d09ba579dba57b5f
Tx: base 0xa3e8cc986d5b3f04e5fad91f8cbac395b74e97bf4f644840e451a30e21f6689d
Tx: base 0x300a42cfe561ee67c0ebbc0cd6eccbe1dbc33686b0e99ec7bfdc22e8127d86dc
Tx: base 0x1efa0eb8f8c804d271a37ac41733fdc16a4ed71a4b0cefef78f5ad2721474f73
Tx: robinhood 0x431985c4749f85782a3c2623d1909ec86c1cf3bf3af838da5740ccbd6d14ef6d
Tx: robinhood 0xb5b5c6c0403e94daf9cf37e5b61f8d6dc9af41d929a3ecf732898e0d9fa88176
Tx: robinhood 0x3e187ea0166d2be18b88912235e2322ed93a90876421df654d79e300aad36efb
Tx: robinhood 0xe938fdadaaa43b57ab155ea27fe99ae94d6e498acd308f28868c1f684ba30277
Tx: robinhood 0x13be5d3cde084626d25587072e8fd7a47dd532f374385f35af92a1b80c92bfbf
Tx: robinhood 0x5fc1bf0d738c144809c639ceb2b4a0e08be310a4e9905366f5d2798ee9a92a5a
Tx: robinhood 0x978226e35764b437cd542af8de4903e25604db20a8be33af5f004204e120bac5

base (chain id 8453), contracts/pool-evm/script/deploy.mjs at 2026-11-07T12:46:56.950Z. Its steps, in the order of its Tx lines above: deploy WithdrawalVerifier, deploy PrivacyPoolSimple, deploy UniswapV4Adapter, deploy UniswapV3Adapter, deploy SellDelegate, deploy FeeCollector, sweep (the run key's rest back).
WithdrawalVerifier 0xfa1ff42246124a5c67c9e2a29ccea684528d6d5d, PrivacyPoolSimple 0xaa080e74ec99cf5c684548c77ca145edfcf899cf, UniswapV4Adapter 0x9d040a025689a10872f0f2f8b581135dde52ca6f, UniswapV3Adapter 0x1e62242773f696271b0cc3029b8672c385b7ce45, SellDelegate 0xe3223113781f527188f634615ad9a3ca0aa20a4d, FeeCollector 0xad33ac6fb59b0b06ca6bbf9d56d51990dc06a047; each one's code is the build's (solc 0.8.28 (contracts/pool-evm/foundry.toml), forge Version: 1.7.1-Homebrew), read by this live check on https://mainnet.base.org and https://base-rpc.publicnode.com. No contract has an owner, an admin or an upgrade path.
Deployer 0xde0ed84472ad53e81ca43aa23734f206498a807c, a run key that lived only in the run, funded with 85281923267456 wei (the printed need) and swept back to 0x9b0de76cb0a21cad9fd37675731f65773508af9e at the run's end.

robinhood (chain id 4663), contracts/pool-evm/script/deploy.mjs at 2026-11-07T13:05:40.460Z. Its steps, in the order of its Tx lines above: deploy WithdrawalVerifier, deploy PrivacyPoolSimple, deploy UniswapV4Adapter, deploy UniswapV3Adapter, deploy SellDelegate, deploy FeeCollector, sweep (the run key's rest back).
WithdrawalVerifier 0x705e34583052b78dd6e22c27f8ae564b9a823d23, PrivacyPoolSimple 0x9306359433127c4f3be426f6faeb00a3c41f66db, UniswapV4Adapter 0x2e31a90e0df8aa634604abbe87cb61ca6aa8d702, UniswapV3Adapter 0xb29746cb12c8466089b8355ec88cab31bd04c089, SellDelegate 0xf79962b094991354270fe7866f0f590ef0c9b0cf, FeeCollector 0xdc41efe2174d6ba6db3f6f96672672bafc1b88e7; each one's code is the build's (solc 0.8.28 (contracts/pool-evm/foundry.toml), forge Version: 1.7.1-Homebrew), read by this live check on https://rpc.mainnet.chain.robinhood.com and https://robinhood-rpc.publicnode.com. No contract has an owner, an admin or an upgrade path.
Deployer 0xf87d78b0bc437d27ae4e694e204a77ab1f2ca54a, a run key that lived only in the run, funded with 309705440000000 wei (the printed need) and swept back to 0x9b0de76cb0a21cad9fd37675731f65773508af9e at the run's end.

The addresses the contracts call (the v4 PoolManager, SwapRouter02 and WETH) are the kit's venue list's, each code hash read on both RPCs and pinned in pool-evm-deploy.mjs MAINNETS; Robinhood's WETH is an upgradeable proxy whose implementation is pinned too.
