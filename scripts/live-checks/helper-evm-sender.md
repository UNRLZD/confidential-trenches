CARD helper-evm-sender / live: PASS
Money path: yes
Tx: base-sepolia 0x678bef1172a9d98e2b7850b24e75e2534a60b724dc4103423c1d89569fe542c9
Tx: base-sepolia 0x1ef944a7e04f736a8c0b7aefa3747937b92d024a98ec2b2ffb8a664c91a67268
Tx: base-sepolia 0x4251f1edd46ff3af33503d40c5b11dc6d578032faf2556a300fae27cb86c6a2b
Tx: base-sepolia 0xccd00495f23f1df385fec1dc4ba634147d69365fdf697adda3426e334caf1f44
Tx: base-sepolia 0xd9c753190542b04451b0d2158a87c882745c5a618b9dd2f2657469f305199a48
Tx: base-sepolia 0x07a8dd84c784b4bb825cf34db9f2d1a76d52a43d04fa8f2cda9b8c32aedc6f8a
Tx: base-sepolia 0x96bd73ea544c9bba3b03e39cb2b28bc9679eca2d62980efe1df9245a98acefaa
Tx: base-sepolia 0x51e13fc6b963d07379456f14c4d9470f21162790591eb08b7ffbc9b707efbf08
Tx: robinhood-testnet 0x44c3ec80c08e7f328b45b70924b02c31188df715ea77bdad3f7dc7b5a34cb8d4
Tx: robinhood-testnet 0x33fcc8bf75a8089c1a3552444f1ae2bbebc766d490154dcd4869567c84f82a3c
Tx: robinhood-testnet 0x3a17d035145a2bf2f597c4b638955e53b6509ade6a50b775c67c10371666ca01
Tx: robinhood-testnet 0xe2840a8a847c4f37818b83b9dc7caa781deae27c7c23be2ee480dfa301fb459b
Tx: robinhood-testnet 0xec8cbd0cc5d37d3ecc8a91c85b6185f3ccb213bc8bc8f720e9900aebf7375801
Tx: robinhood-testnet 0x414a242784b8d8a226b85a5306d936bf3be308b0aea8e26fdd563ac0b09f35c7
Tx: robinhood-testnet 0xe81cbd3b53237041cc05fc2a68ec9411203f471c252e56a1c2a746990a3b7d49
Tx: robinhood-testnet 0x8e92d619b3620e80c7962a83961a26e4676f7719044533475cdc98ea61603eaa

Each testnet has one run of contracts/pool-evm/script/testnet-run.mjs --sell-helper https://api.confidential.unrealized.trade, its record beside this file (helper-evm-sender.run.<chain>.json): a deposit, a buy, a sell the deployed helper sent (POST /v1/pool/evm/sell, its sell sender signing the type-4 transaction with W's authorization of the pinned SellDelegate), two withdraws and three sweeps back. Every transaction above landed and reads back as succeeded on both of its chain's RPCs.

base-sepolia (chain id 84532), testnet-run.mjs at 2026-11-05T06:49:39.572Z, the pool 0xb239a38af69b68e6c5c305df64985f283b5d5fe5, the token 0x036cbd53842c5426634e7929541ec2318f3dcf7e, venues v3. Its steps, in the order of its Tx lines above: deposit, buy through v3, sell through SellDelegate, sent by the helper, withdraw, withdraw, sweep (a W's ETH back), sweep (a W's ETH back), sweep (the run key's rest back).
The helper's sell sender 0xd378cda68babba6a9dc1d52335bb76ca9e6a7553 sent the sell; the run key 0x289690dab7420777f6b744689a298bccc98819e2 lived only in the run, sent every other transaction but the Ws' own sweeps, needed 2065890153784448 wei (the need it printed) and was swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
The restore from the words (packages/wallet evmRestoreNotes) at block 54693818: 5 notes, 3 spends, the Ws 0xde37bb207bc10943c16e3b01f176fa07109c3419 (0x036cbd53842c5426634e7929541ec2318f3dcf7e, 0x4200000000000000000000000000000000000006), 0x5c865ef44a038ef367f79ad1831bb743a2dfd5d0 (no token), 0x924f91e5551b2c3f878b06089c17e6f5b52c190f (no token).

robinhood-testnet (chain id 46630), testnet-run.mjs at 2026-11-05T04:43:47.512Z, the pool 0xe5e948414a89c23e73d76cd740dacdd9364c25d5, the token 0x10e626a1d0857174b9a5bdb7a1397068811fbbbc, venues v4. Its steps, in the order of its Tx lines above: deposit, buy through v4, sell through SellDelegate, sent by the helper, withdraw, withdraw, sweep (a W's ETH back), sweep (a W's ETH back), sweep (the run key's rest back).
The helper's sell sender 0xd12d83097671d731df2db731e973ad9a07673607 sent the sell; the run key 0xe20c310582ad89b6736f27ed542b6c642570ecee lived only in the run, sent every other transaction but the Ws' own sweeps, needed 2119800000000000 wei (the need it printed) and was swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
The restore from the words (packages/wallet evmRestoreNotes) at block 148783747: 5 notes, 3 spends, the Ws 0xf20dd7509d351822ad9eaa0d04f4e9761258069b (0x10e626a1d0857174b9a5bdb7a1397068811fbbbc), 0xc42dec3cdc1d8bd8e836739f64abc103cbac17f5 (no token), 0x8587f8b42eaf001b5f7b26a4f160efb1818f5165 (no token).

node scripts/live-checks/helper-evm-sender.mjs passed on both records: the fee answers name each sell sender, every plant is refused with its own code, each run reads back whole on both RPCs (pool-evm-testnet-run's check), and each sell the helper sent was sent by the fee answer's sell_sender at gas limit 1,000,000, with W's authorization on the chain's id and a fee at least its cost.
