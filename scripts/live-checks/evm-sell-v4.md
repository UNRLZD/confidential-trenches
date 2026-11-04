CARD evm-sell-v4 / live: PASS
Money path: yes
Tx: base-sepolia 0x795b888806de773381fd8659cfea6faa7614bc3ddbf225f3d273ea66c1c1a505
Tx: base-sepolia 0x45f5ec5d3d41b22df79253ea2dd7debdb41d7d46d3668e8e0e153f7bac60cca9
Tx: robinhood-testnet 0x8b9e35f0ae4bbf7b749ac95285e91c294d15fda299a947e7495a7066d3fbb2fd
Tx: robinhood-testnet 0x290964714c8081f16f264cf94aa1292b4ffd034d800159947b555e343faa3d86

base-sepolia: contracts/pool-evm/script/deploy.mjs --only SellDelegate at 2026-11-04T07:06:29.884Z; steps: deploy SellDelegate, sweep (the run key's rest back). SellDelegate 0xfa1442419b6984b8e3aa8933c690f80f063b6adf, its code the build's, POOL_MANAGER() 0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408 and WETH() 0x4200000000000000000000000000000000000006, read by this live check on https://sepolia.base.org and https://base-sepolia-rpc.publicnode.com. Deployer 0xd34b17fa446277b9a54f691c1b0594cb24178c1f, a run key that lived only in the run, swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2.

robinhood-testnet: contracts/pool-evm/script/deploy.mjs --only SellDelegate at 2026-11-04T07:07:09.136Z; steps: deploy SellDelegate, sweep (the run key's rest back). SellDelegate 0xaafb86fed9b651933773a0750d5dba22ca8b8a02, its code the build's, POOL_MANAGER() 0x8366a39cc670b4001a1121b8f6a443a643e40951 and WETH() 0x7943e237c7f95da44e0301572d358911207852fa, read by this live check on https://rpc.testnet.chain.robinhood.com and https://robinhood-sepolia-rpc.publicnode.com. Deployer 0xd621d2dd12f97d42160779c357bc0ec6339a2cb4, a run key that lived only in the run, swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2.
