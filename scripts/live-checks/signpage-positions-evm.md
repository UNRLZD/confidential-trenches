CARD signpage-positions-evm / live: PASS
Money path: yes
Tx: base-sepolia 0x1289ec19fe85d0ccea38d5ac062a97ea336a3e601e7c559d479e1c11c2f998cd
Tx: base-sepolia 0x1e38da0723986f9ea77f44dafdaf29ee6b0dda6b91b18d33c583659f137a228b
Tx: base-sepolia 0x78388cc827b5a3b33855d68acfab39558b1bc62ea562328f7f660005d5569a2b
Tx: base-sepolia 0x7f974022b84278573300a3042272d6c7ec547f9e18b71680cd26699fc1206726
W: 0x28208127bbb14d55c2710acf0cacffebe2e2cdc9
Asset: 0x036cbd53842c5426634e7929541ec2318f3dcf7e
Buy: base-sepolia 0x78388cc827b5a3b33855d68acfab39558b1bc62ea562328f7f660005d5569a2b
Sell: base-sepolia 0x7f974022b84278573300a3042272d6c7ec547f9e18b71680cd26699fc1206726

One real Base Sepolia pool buy, its position in the signing page's state, its sell and the position gone, through the
page's own code path: the page's pool kinds over src/pool-testnet.ts testnetPool on the testnet build's own pins, pool
RPCs and helper, driven by packages/signpage/scripts/pool-positions-evm-testnet.mjs on 2026-11-11 from the card's final
head (its merge of the EVM sell's head). What differs from the page in a browser, and only that: the prover is
snarkjs's fullProve in the script's process, and the wallet store is fake-indexeddb. The run's seed is its own (16
random bytes, kept 0600 in ~/.ct-devnet-runs by its deposit run, never printed), so no W of another run is sold. Every
transaction above is a testnet one; nothing ran on a mainnet.

The Tx lines, in order: the team's test wallet E (0x49f2425b7f33f3a10912de8add6839226ce663a2) funds a one-time deposit
wallet U (0x397a22237668D5DC5D04160D811d599874f6eBf9, 0.00113 ETH); U's deposit of 0.001 ETH into the pinned pool
0xeb967dfc1b4ffb22942f833c76866ea85fc42266 (block 57282830 on both pool RPCs, settled UNSPENT at 06:51Z); the buy; the
sell.

The buy (06:53:40Z to 06:53:50Z): W 0x28208127bbb14d55c2710acf0cacffebe2e2cdc9, Base Sepolia USDC, filled in block
57290790 on base-sepolia-rpc.publicnode.com and base-testnet.api.pocket.network. The page's state positions read 2 s
later [{ chain: "base", token: 0x036cbd53…, amount: "2.003956", cost: "0", wallets: [W], decimals: 6 }]: W's balanceOf
on both pool RPCs at the lower newest block, no lower than the buy's own block, decimals on both. The sell (06:53:52Z
to 06:54:06Z): pool.sell of the whole holding (share_bps 10000, as the terminal's Sell asks it), sent through the
helper's POST /v1/pool/evm/sell, filled in block 57290846 with the pool's Deposited from W on both RPCs; the page's
positions then read [] (the sale's block the floor of the pass after it).

A rehearsal on the head before the merge (06:28Z, its own deposit and seed: buy
0x9f6cfd4ea6f3062b676837e27366d5b96d9d304c13c4e3733889720eedff747e, sell
0xe54e5ff6596c5eb1c86590dd388b41c22bec930667f98c57ec4d964d2d0f853e) read the same; the record is the run above.
