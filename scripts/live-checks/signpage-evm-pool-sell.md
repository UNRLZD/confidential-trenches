CARD signpage-evm-pool-sell / live: PASS
Money path: yes
Tx: base-sepolia 0x22f072c6fff3ffb7de07f3bda5d8852ed1d35cc623c352b0483ade2fbe6d2606
Tx: robinhood-testnet 0x16c3cecd9ec2c2b667b9f95f02f4aa4edf946fd37e0d9f59c2e8604f071c1165
Tx: base-sepolia 0xe60d057e8376824c906ed9e700c945b45e76ebd92ef82d30ff80278786056fba
Tx: base-sepolia 0x3156a396dac0cf4b5787e18f8722763f7c3e14f26ff3bf5be87c593832783051
Tx: robinhood-testnet 0x8dbda560e64ac3233cc3e97eed1f0d7d22226f5a50310352d677445176b5ee57
Tx: robinhood-testnet 0xfe2af037db99203218eb014ca6398b8f34beeef710c56f36f25250fe30723d4b
Tx: robinhood-testnet 0x72d40732d83882255f9110e700f36121e8d82038754a704029a95935523bf8f9
Tx: robinhood-testnet 0xbcc4f9e799d8d93bb156fbe9b1e5c9723ef5a7b839476c01aa318b6a6711d9fe
Tx: robinhood-testnet 0xe98e4e1f02ce6a7381ae407583ef1f5c20c6e9237be0348a1a34137120522486
Sell: base-sepolia 0x22f072c6fff3ffb7de07f3bda5d8852ed1d35cc623c352b0483ade2fbe6d2606
Sell: robinhood-testnet 0x16c3cecd9ec2c2b667b9f95f02f4aa4edf946fd37e0d9f59c2e8604f071c1165
Sell: base-sepolia 0xe60d057e8376824c906ed9e700c945b45e76ebd92ef82d30ff80278786056fba
Sell: base-sepolia 0x3156a396dac0cf4b5787e18f8722763f7c3e14f26ff3bf5be87c593832783051
Sell: robinhood-testnet 0x8dbda560e64ac3233cc3e97eed1f0d7d22226f5a50310352d677445176b5ee57
Sell: robinhood-testnet 0xfe2af037db99203218eb014ca6398b8f34beeef710c56f36f25250fe30723d4b
Sell: robinhood-testnet 0x72d40732d83882255f9110e700f36121e8d82038754a704029a95935523bf8f9
Sell: robinhood-testnet 0xbcc4f9e799d8d93bb156fbe9b1e5c9723ef5a7b839476c01aa318b6a6711d9fe
Sell: robinhood-testnet 0xe98e4e1f02ce6a7381ae407583ef1f5c20c6e9237be0348a1a34137120522486

One real private sale on each testnet through the signing page's own code path, from a wiped browser: a wallet store
that held only the seed. The page's restore steps for an EVM pool (src/pool-restore.ts: the wallet's evmRestoreNotes,
notes only, then restoreEvmHoldings) wrote the notes and W's buy record, its route read back from the buy's own
transaction on the chain's two pool RPCs; then the page's pool kinds (src/pool-kinds.ts over src/pool-testnet.ts
testnetPool, as main.ts wires them) sold W's whole holding: pool.sell quoted on the route the buy took (the kit's
evmPoolSellQuote), built with the kit's evmPoolBuildSell, passed checkEvmSell and checkEvmAuthorization, had W sign its
Sell and its EIP-7702 authorization of the pinned sell delegate, wrote the open sale and the return note INCOMING, sent
through the helper's POST /v1/pool/evm/sell and read the sale's end on the pool's Deposited logs on the chain's two pool
RPCs (src/pool-sell-evm.ts). Driven by packages/signpage/scripts/pool-sell-evm-testnet.mjs on 2026-11-11. What differs
from the page in a browser, and only that: the wallet store is fake-indexeddb, and the script reads W's balance once
to size the ask. Each seed is a buy run's own (pool-buy-evm-testnet.mjs, kept 0600 in ~/.ct-devnet-runs, never
printed); the buys are signpage-evm-pool-buy.md's. The helper's testnet sell sender sent each one type 4 transaction to
W; W holds no ETH. Every transaction above is a testnet one; nothing ran on a mainnet.

base-sepolia: pool 0xeb967dfc1b4ffb22942f833c76866ea85fc42266, W 0x24818f99f03808a2a8beab6978149a44d43e788d. The
restore read the buy 0xd5b86cb358f400ae60ae0316810fb956cf9d4a1da9bcfe57bb933723e03adce4 back as uniswap-v3 WETH to USDC
fee 100 (adapter 0xee89916bc4bdeee46dbcaf8fad2b7604724b5645), USDC 0x036cbd53842c5426634e7929541ec2318f3dcf7e, 6
decimals. The sale of 2069392 units (2.069392 USDC): tap 03:40:09Z, helper 200 and the answer "sent" at 03:40:57Z
(48.6 s: the wiped store's first pool round, read from the pool's first block), "filled" at 03:41:03Z. Read back on
base-sepolia-rpc.publicnode.com and base-testnet.api.pocket.network: status 0x1 in block 57232946 (0x3694e32) on both,
from the pinned sell sender 0xd378cda68babba6a9dc1d52335bb76ca9e6a7553 under the delegate
0x7a034461193cc6b1a7d5d0f5fe4a36b34e7ebc12's authorization, with the pool's Deposited of 1372048083169249 wei from W
for the return note's precommitment (the signed floor was 1330286640674171).

robinhood-testnet: pool 0xed9fac860e6bc5e932455232eedca8b71c44da4d, W 0x32e484e88ee8c17b2e8fdd7b22cd1eeeae91d47d,
tSPILL 0x10e626a1d0857174b9a5bdb7a1397068811fbbbc (18 decimals) on uniswap-v4, read back from its buy the same way. The
sale of 960299999981614 units: tap 03:42:49Z, helper 200 and "sent" at 03:43:01Z (11.6 s), "filled" at 03:43:06Z. Read
back on rpc.testnet.chain.robinhood.com and robinhood-sepolia-rpc.publicnode.com: status 0x1 in block 151623971
(0x9099923) on both, from the pinned sell sender 0xd12d83097671d731df2db731e973ad9a07673607 under the delegate
0xcec6c1b18be682cfa1679568eab309db79fe3cce's authorization, with the pool's Deposited of 930697000000009 wei from W.

Partial sales, then the rest, from wiped browsers (the script's SELL_PARTS=2: half the holding, then the rest at once,
while the first sale's deposit is not final yet; each run restores from the seed alone first):

base-sepolia, W 0xdf7fe9f8a74a82f25917df157f728f21a41baeae (USDC 0x036cbd53842c5426634e7929541ec2318f3dcf7e on
uniswap-v4), on 549da11b: 1648560 units at 04:53:27Z, filled 04:53:33Z, 0xe60d057e…6fba in block 57254696, the return
note's deposit of 1068156340895538 wei; then 1648561 units at 04:53:40Z, filled 04:53:46Z, 0x3156a396…3051 in block
57254758, on R's first second arrival at W's next Sell nonce, 1067879597746887 wei. A first try of this W at 04:43Z
was refused bad_shape on both taps (the authorization's r and s sent as quantities; fixed in 549da11b), its second tap
signing the refused sale again on the same nonce and note, so nothing landed.

robinhood-testnet, W 0x94fe4c14e7012e00a21752ac052094b4c21980bb (tSPILL on uniswap-v4): half at 04:37:34Z on
2eb8df85, 0x8dbda560…ee57 in block 151640492 (455348500000281 wei); that run was stopped, and a
wiped browser on 8f68c63c sold a quarter at 04:46:48Z while that deposit was not final, 0xfe2af037…3d4b in block
151643415 on R's first (217674249999940 wei), the earlier sale's note written INCOMING from the round first; its
second tap was refused bad_shape (r and s, before 549da11b). A wiped browser on 549da11b sold the rest at 04:54:58Z,
0x72d40732…f8f9 in block 151646039 on R's second (217674249999808 wei).

robinhood-testnet, W 0x2679e9de42b50d97a5465d1ee83d2cb79690a935, on the final head e0fe4964: half at 05:34:50Z, filled
05:34:56Z, 0xbcc4f9e7…d9fe in block 151661054; the rest at 05:35:02Z, filled 05:35:07Z, 0xe98e4e1f…2486 in block
151661123, each read back with status 0x1 in one block on both RPCs.

A wiped restore from the seed alone, after both chains' finalized blocks passed the sales (Base finalized 57258266 at
05:31Z, Robinhood 151650247), reads every return note in order, UNSPENT, at its deposit's value: Base return
1068156340895538 and R0 1067879597746887; Robinhood (W 0x94fe…80bb) return 455348500000281, R0 217674249999940 and R1
217674249999808. The runs' own processes left the records open: the page drops a landed sale's record at a state
read's follow (followEvmSells), which the script does not make.
