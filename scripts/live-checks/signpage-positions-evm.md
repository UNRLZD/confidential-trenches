CARD signpage-positions-evm / live: PASS
Money path: yes
Tx: base-sepolia 0xc1a5551d21fd4f839de0dcd75c99956c3dce2bef75d4f8b7e3592ab8f38ea980
Tx: base-sepolia 0xd9fed47d3475cde10d5c962422ed8d79c16662b18ce0c0b35986a1e9789f827b
Tx: base-sepolia 0xfc9484d857edaeb6f219b146dece41f39bfe969e0477e3e1bfe521b4ec34cd00
Tx: base-sepolia 0xbbeb5afcb05cf366d9981f7c30ccf1a241883cba11e53428ba9e34ee550d11c1
Tx: base-sepolia 0xc87c038591e98879507c4a7f81770a9d89aaaaf5b7c0fa8e3862f014d82234b8
W: 0x9923aee93d4e09fa8b281304dbf11efcc401fbd5
Asset: 0x036cbd53842c5426634e7929541ec2318f3dcf7e
Buy: base-sepolia 0xbbeb5afcb05cf366d9981f7c30ccf1a241883cba11e53428ba9e34ee550d11c1
Sell: base-sepolia 0xc87c038591e98879507c4a7f81770a9d89aaaaf5b7c0fa8e3862f014d82234b8

One real Base Sepolia pool buy, its position in the signing page's state, its sell and the position gone, through the
page's own code path: the page's pool kinds over src/pool-testnet.ts testnetPool on the testnet build's own pins, pool
RPCs and helper, driven by packages/signpage/scripts/pool-positions-evm-testnet.mjs on 2026-11-11. What differs from
the page in a browser, and only that: the prover is snarkjs's fullProve in the script's process, and the wallet store is
fake-indexeddb. The run's seed is its own (16 random bytes, kept 0600 in ~/.ct-devnet-runs by its deposit run, never
printed), so no W of another run is sold. Every transaction above is a testnet one; nothing ran on a mainnet.

The Tx lines, in order: the team's test wallet E (0x49f2425b7f33f3a10912de8add6839226ce663a2) funds a one-time deposit
wallet U1 (0x6DbCdBA257864bE3441FB48Bf2C470f54dc31b57, 0.001025637280002043 ETH), whose deposit run ended before the
funding read back and left it unspent; E funds the resumed run's U2 (0xf6b2a53323c7E715dc22CD621EEf5714854eafc0, 0.00113
ETH); U2's deposit of 0.001 ETH into the pinned pool 0xeb967dfc1b4ffb22942f833c76866ea85fc42266 (block 57240783 on both
pool RPCs, settled UNSPENT at 04:30Z); the buy; the sell.

The buy (04:53:56Z to 04:54:10Z): W 0x9923AeE93D4e09Fa8B281304DBF11EFCC401FBd5, Base Sepolia USDC, filled in block
57254892 on base-sepolia-rpc.publicnode.com and base-testnet.api.pocket.network. The page's state positions then read
[{ chain: "base", token: 0x036cbd53…, amount: "2.01769", cost: "0", wallets: [W], decimals: 6 }]: W's balanceOf on both
pool RPCs at the lower newest block, decimals on both. The sell (04:54:13Z to 04:54:25Z): pool.sell of the whole holding
(share_bps 10000, as the terminal's Sell asks it), sent through the helper's POST /v1/pool/evm/sell, filled in block
57254959 with the pool's Deposited from W on both RPCs; the page's positions then read [].

An earlier try at 04:34Z answered failed before any send (no helper POST); the note stayed UNSPENT and the run above
spent it.
