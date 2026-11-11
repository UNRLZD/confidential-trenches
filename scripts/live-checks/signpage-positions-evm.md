CARD signpage-positions-evm / live: PASS
Money path: yes
Tx: base-sepolia 0x7d8e82a307eace2c599e381dad63342bed25f11ae7549db2141984aabd95e4a5
Tx: base-sepolia 0x96314fb4ac3cfd7afde672fcdcac79687ae617b673a2623355c477abf42756b8
Tx: base-sepolia 0x3fae172987c80eed4ad88fbe2b92e376a7aac2617ca8c98f017683bd8bd04b74
Tx: base-sepolia 0xe6e88ec6a960f2fd4233c97a7c90b5390a66f6a38c25ed48d3a62344ceccdfeb
W: 0x9f3c53d44960c79fb8ef7621b15e09f9da2552d2
Asset: 0x036cbd53842c5426634e7929541ec2318f3dcf7e
Buy: base-sepolia 0x3fae172987c80eed4ad88fbe2b92e376a7aac2617ca8c98f017683bd8bd04b74
Sell: base-sepolia 0xe6e88ec6a960f2fd4233c97a7c90b5390a66f6a38c25ed48d3a62344ceccdfeb

One real Base Sepolia pool buy, its position in the signing page's state, its sell and the position gone, through the
page's own code path: the page's pool kinds over src/pool-testnet.ts testnetPool on the testnet build's own pins, pool
RPCs and helper, driven by packages/signpage/scripts/pool-positions-evm-testnet.mjs on 2026-11-11 from the card's head
443f9274 (the sale's floor from its own Deposited). What differs from the page in a browser, and only that: the prover
is snarkjs's fullProve in the script's process, and the wallet store is fake-indexeddb. The run's seed is its own (16
random bytes, kept 0600 in ~/.ct-devnet-runs by its deposit run, never printed), so no W of another run is sold. Every
transaction above is a testnet one; nothing ran on a mainnet.

The Tx lines, in order: the team's test wallet E (0x49f2425b7f33f3a10912de8add6839226ce663a2) funds a one-time deposit
wallet U (0xBb2ab5ccFa3eecd4368AE8fb58Fc6369eEA468ec, 0.00113 ETH, block 57308346); U's deposit of 0.001 ETH into the
pinned pool 0xeb967dfc1b4ffb22942f833c76866ea85fc42266 (block 57308409 on both pool RPCs, settled UNSPENT at 08:14Z);
the buy; the sell.

The buy (08:17:05Z to 08:17:16Z): W 0x9f3c53d44960c79fb8ef7621b15e09f9da2552d2, Base Sepolia USDC, filled in block
57315816 on base-sepolia-rpc.publicnode.com and base-testnet.api.pocket.network. The page's state positions read 2 s
later [{ chain: "base", token: 0x036cbd53…, amount: "2.012476", cost: "0", wallets: [W], decimals: 6 }]: W's balanceOf
on both pool RPCs at the lower newest block, no lower than the buy's own block, decimals on both. The sell (08:17:18Z
to 08:17:31Z): pool.sell of the whole holding (share_bps 10000, as the terminal's Sell asks it), sent through the
helper's POST /v1/pool/evm/sell, filled in block 57315880 with the pool's Deposited from W on both RPCs; the page's
positions then read []: the token held from the sale's record, read at no block under the Deposited's block the
read-back's verdict named on both RPCs.
