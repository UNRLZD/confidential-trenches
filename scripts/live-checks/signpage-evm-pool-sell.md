CARD signpage-evm-pool-sell / live: PASS
Money path: yes
Tx: base-sepolia 0x22f072c6fff3ffb7de07f3bda5d8852ed1d35cc623c352b0483ade2fbe6d2606
Tx: robinhood-testnet 0x16c3cecd9ec2c2b667b9f95f02f4aa4edf946fd37e0d9f59c2e8604f071c1165
Sell: base-sepolia 0x22f072c6fff3ffb7de07f3bda5d8852ed1d35cc623c352b0483ade2fbe6d2606
Sell: robinhood-testnet 0x16c3cecd9ec2c2b667b9f95f02f4aa4edf946fd37e0d9f59c2e8604f071c1165

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

The return note turns UNSPENT once the pool's round holds its deposit at a finalized block (the deposit path's rule):
Base Sepolia's finalized block ran about 27 minutes behind its head at 04:00Z, so neither run's process stayed for it.
Each sale's tx hash above was read from the pool's Deposited logs on both pool RPCs after the run (Base: the log for
the return note's precommitment; Robinhood: the pool's one Deposited in its last 40000 blocks, from W).
