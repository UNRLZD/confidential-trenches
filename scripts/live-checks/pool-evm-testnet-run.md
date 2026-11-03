CARD pool-evm-testnet-run / live: PASS
Money path: yes
Tx: base-sepolia 0xe508953aecafddc7acf61bac5efbd4e7b90592c37a25f609dce8653c387f29b2
Tx: base-sepolia 0x9add06d5660fb4c3cb47154f8ee9841cb097654d5489c28193750200661e686b
Tx: base-sepolia 0x6a656e20e759d182980ecff2f33b81937f6d272ee14b014b5383c0c28d5b420f
Tx: base-sepolia 0x98eb9258ddf3a1a8b047206882cd819c02519278b451d61f569b40440763daa9
Tx: base-sepolia 0x80017b25b56b05a52d796f071a7aaf0f58a3960f295d057c85010a658c8ca51a
Tx: base-sepolia 0x44d9f5be87cb50c1a01544df4691c76790b102babb795386d8c33062143ad3cb
Tx: base-sepolia 0x2a835567fb66da6c0d75ee3c5192bed9fe522d613f87ea6ec7c0e728f9985bcb
Tx: base-sepolia 0xc92e83ca8b1d38fe10e883cee4257dbccd6bc3ff2c2b624efbd6240bf1756ed7
Tx: base-sepolia 0x0a5dc3f9801ac0599b4ab0be914458fa98274e0e8e84b66c3c9506d5cd4abcf4
Tx: base-sepolia 0xc1c75791ac6e3c2f629516e989daacc7283298a69e0795e7d1617ca51b75ebf4
Tx: base-sepolia 0x20424440a88b6d26f66921fa8d0c85bcc69bfe8f07801555e62e8ec2bf055c9f
Tx: base-sepolia 0x2b0205efbedd8fbab0631e617a69c053009e00b8e17b0d03e0b2f2a8560806c2
Tx: robinhood-testnet 0x67ff3932492cb9e206bebc882820690d40f14a6a0b494919c26c7695fe51c3e3
Tx: robinhood-testnet 0xce75b8f040a93b06cf884600610a54cbbd8ed29830dc46331625ac40426d3372
Tx: robinhood-testnet 0x9acd5e99d181fbcbd70ae5d4cc7686b0941958b6b0ca43590cd45b4e3787216c
Tx: robinhood-testnet 0x757d465a580e0e375bab7c9c7a6c44d852d2c7478897acaa4e6eb38eb091d189
Tx: robinhood-testnet 0xbf497f9e1c7ecaa19281934959112fd4e298078907e4843e4f323c3372b9df84

base-sepolia (chain id 84532), contracts/pool-evm/script/testnet-run.mjs at 2026-11-03T22:33:14.234Z, the pool 0xb239a38af69b68e6c5c305df64985f283b5d5fe5, the token 0x036cbd53842c5426634e7929541ec2318f3dcf7e, venues v4 and v3. Its steps, in the order of its Tx lines above: deposit, buy through v4, buy through v3, sell through SellDelegate, sell through SellDelegate, withdraw, withdraw, withdraw, sweep (a W's ETH back), sweep (a W's ETH back), sweep (a W's ETH back), sweep (the run key's rest back).
The run key 0x6c9d284413f374820052fe483a9db2f66658cf69 lived only in the run, sent every transaction but the Ws' own sweeps as the relayer, was funded with 3111339019604300 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
The restore from the words (packages/wallet evmRestoreNotes) at block 54114702: 8 notes, 5 spends, the Ws 0x6f76af4b9684a3d7f2d7af595b81ad384fc5b256 (0x036cbd53842c5426634e7929541ec2318f3dcf7e, 0x4200000000000000000000000000000000000006), 0x263e17a9877167f94176265eee794eeab9ce811b (0x036cbd53842c5426634e7929541ec2318f3dcf7e, 0x4200000000000000000000000000000000000006), 0x4359cd376e9a05aeb5adff2a997f4c98aa52e423 (no token), 0xdfd75b35ec78d0509d8ac3dab48eabfe118c713e (no token), 0x84715693c61fa41e7b56347a54c98dd1de9391b0 (no token).

robinhood-testnet (chain id 46630), contracts/pool-evm/script/testnet-run.mjs at 2026-11-03T22:49:26.757Z, the pool 0xe5e948414a89c23e73d76cd740dacdd9364c25d5, the token 0x10e626a1d0857174b9a5bdb7a1397068811fbbbc, venues v4. Its steps, in the order of its Tx lines above: deposit, buy through v4, withdraw, sweep (a W's ETH back), sweep (the run key's rest back).
The run key 0x6849c404f12bd209cc3e0b73dbc4fe14f905f8c2 lived only in the run, sent every transaction but the Ws' own sweeps as the relayer, was funded with 2119800000000000 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
The restore from the words (packages/wallet evmRestoreNotes) at block 147976705: 3 notes, 2 spends, the Ws 0xe9b02e9d809175e163dc6a060062180dfa2e1f58 (unread), 0x66264c957ea6934195f75788981097339b0b9802 (unread).
No sell on robinhood-testnet: the chain has no Uniswap v3 SwapRouter02 (no code at mainnet's 0xCaf681a66D020601342297493863E78C959E5cb2 on either RPC, 4 Nov) and SellDelegate sells only through a router that pulls the token with transferFrom, so the W that bought keeps its token. The Robinhood sell is proven on a Robinhood mainnet fork (contracts/pool-evm/test/SellFork.t.sol, SellForkRobinhoodTest, through that router) and lands for real in card pool-evm-mainnet-run.
