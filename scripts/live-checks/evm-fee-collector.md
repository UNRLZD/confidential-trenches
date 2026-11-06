CARD evm-fee-collector / live: PASS
Money path: yes
Tx: base-sepolia 0xdb1410a4cdcb78051e5b2ffbce2e25ed68800147d007b904f0385746d9019fe3
Tx: base-sepolia 0x39894a739039fdf103c36176ccfee7c293d2f0e5dff76f02a2d38cba5d76480a
Tx: robinhood-testnet 0x810cc53624006d64c210a2a8a546e039e53990105be4e69f804509afd36f5df7
Tx: robinhood-testnet 0xdc30f6589fa6a8469bd7768780bdbd8e18ec1009ee091f252f4ccde14e3429ce

base-sepolia (chain id 84532), contracts/pool-evm/script/deploy.mjs --only FeeCollector at 2026-11-06T12:49:11.851Z. Its steps, in the order of its Tx lines above: deploy FeeCollector, sweep (the run key's rest back).
FeeCollector 0x9cc4788af51677aaa7770d78277c41fb864b35e1, its sink 0xd378cda68babba6a9dc1d52335bb76ca9e6a7553 (the sell sender the kit pins); its code is the build's and its immutable the sink, read by node scripts/live-checks/evm-fee-collector.mjs on https://sepolia.base.org and https://base-sepolia-rpc.publicnode.com. No owner, no admin, no function but receive().
Deployer 0xa143f5664d6a270eca4bcc6cc0872e602c9a32a8, a run key that lived only in the run, funded with 1725636000899 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2.

robinhood-testnet (chain id 46630), contracts/pool-evm/script/deploy.mjs --only FeeCollector at 2026-11-06T12:49:39.944Z. Its steps, in the order of its Tx lines above: deploy FeeCollector, sweep (the run key's rest back).
FeeCollector 0xb174f0e859f00a7b593baca38394327e3d6bf638, its sink 0xd12d83097671d731df2db731e973ad9a07673607 (the sell sender the kit pins); its code is the build's and its immutable the sink, read by node scripts/live-checks/evm-fee-collector.mjs on https://rpc.testnet.chain.robinhood.com and https://robinhood-sepolia-rpc.publicnode.com. No owner, no admin, no function but receive().
Deployer 0x5a9ce486f0a33063c0835ec4ca5c5113b6c7894c, a run key that lived only in the run, funded with 3137520000000 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2.

No sell has paid a collector yet: the first real sells come with card evm-testnet-delegate-review3 (evm-fee-collector.sells.json).
