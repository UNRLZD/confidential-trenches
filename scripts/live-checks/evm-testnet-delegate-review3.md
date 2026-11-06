CARD evm-testnet-delegate-review3 / live: PASS
Money path: yes
Tx: base-sepolia 0x326bc8a4f4200b0cdf230a8398ed7127c9d6137ed0bc1fd6deef391e3d178b71
Tx: base-sepolia 0x5347300971bf42307733d5bc563e436b256ce71de0cb5af047c5b1199e84877f
Tx: robinhood-testnet 0xe15dad948f744299e9d76c42a82534ce8b6a04d844bb014ebd23cd1d90003e2b
Tx: robinhood-testnet 0x01aef8ef00ffb1626a160666e01c20b06e63a993de2f98f2df67a98b9234340e
Tx: base-sepolia 0xe8d66aff401710d088505b78efdaae4fc9c485f26b901cd08d0fa678e545c54c
Tx: robinhood-testnet 0x372530f30ff7b2f84c7d368e24b1c991e9f05389ade7ec7b8e2145b1517052fa

base-sepolia: contracts/pool-evm/script/deploy.mjs --only SellDelegate at 2026-11-06T17:04:52.235Z; steps: deploy SellDelegate, sweep (the run key's rest back). SellDelegate 0x7a034461193cc6b1a7d5d0f5fe4a36b34e7ebc12, its code the build's, POOL_MANAGER() 0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408 and WETH() 0x4200000000000000000000000000000000000006, read by this live check on https://sepolia.base.org and https://base-sepolia-rpc.publicnode.com. Deployer 0xbd209a18f9358acbe90ea3571ab7b94eb896886d, a run key that lived only in the run, swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2.

robinhood-testnet: contracts/pool-evm/script/deploy.mjs --only SellDelegate at 2026-11-06T17:04:59.907Z; steps: deploy SellDelegate, sweep (the run key's rest back). SellDelegate 0xcec6c1b18be682cfa1679568eab309db79fe3cce, its code the build's, POOL_MANAGER() 0x8366a39cc670b4001a1121b8f6a443a643e40951 and WETH() 0x7943e237c7f95da44e0301572d358911207852fa, read by this live check on https://rpc.testnet.chain.robinhood.com and https://robinhood-sepolia-rpc.publicnode.com. Deployer 0xad9b666437dead4b827e9cd1a236483016d56e90, a run key that lived only in the run, swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2.

base-sepolia: the run key 0xbd209a18f9358acbe90ea3571ab7b94eb896886d was funded from the team's testnet wallet E (0x49f2425b7f33f3a10912de8add6839226ce663a2) by 0xe8d66aff401710d088505b78efdaae4fc9c485f26b901cd08d0fa678e545c54c, read back as succeeded on both RPCs.
robinhood-testnet: the run key 0xad9b666437dead4b827e9cd1a236483016d56e90 was funded from the team's testnet wallet E (0x49f2425b7f33f3a10912de8add6839226ce663a2) by 0x372530f30ff7b2f84c7d368e24b1c991e9f05389ade7ec7b8e2145b1517052fa, read back as succeeded on both RPCs.
