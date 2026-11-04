CARD pool-evm-testnet-run / live: PASS
Money path: yes
Tx: base-sepolia 0x4bd338da09f8d1ada89a69e23189ad05acfa09122dbb1008d567a0410e71d947
Tx: base-sepolia 0x0afa87a2ccc2d41279460ac6a4626d5e810e521562e3f61b7bbe6e0a10cb4832
Tx: base-sepolia 0xc75588c8309f7445381f1454eef5ec1acc8cf79f0c5794096258d8875fb5a9e4
Tx: base-sepolia 0x59c4ed53e212bd9f38c3ac047aef876852420423bc8c7deba329cb44f6f2c60c
Tx: base-sepolia 0xc6823a7e0da6988a611ade7b36007b493c8f19828cfbffcea5f5092a99a61531
Tx: base-sepolia 0x190920c59e64468d0686fb609280c7fc31b05ce7f759ae0c4a39c201b1dd2053
Tx: base-sepolia 0xf950d7fc2f88b0cf28f44bcbc7f0fae004d2204d1afe8163d2e2223e576d9272
Tx: base-sepolia 0x74daf39e95fdd173785438d697272bc8b73ef0bfbaaccf107dbf1b126f024882
Tx: base-sepolia 0xf3594c57d335d36f865b3d15b653a49b05b001d3e271afba3c8263b3a3c2183a
Tx: base-sepolia 0x1553bbe37f263645187f340f24f4daeba81824323a63c3148c01c3024143908b
Tx: base-sepolia 0xb773ca690ec85c3f27fd1a6217b005657a97104dcc60fa21ff1d862dcebde9c4
Tx: base-sepolia 0xdf8e2e50518e106a4c121772011b6a37a425c2156eec85ecc85eea00eede2a44
Tx: robinhood-testnet 0x491fe9488cd8904144f68e2468fb011a74685b3f501be052668c2b95433c1112
Tx: robinhood-testnet 0xef59fa5e8865acf25779cfa970c285569cc7a528364ffab179358e7b6c93d9b7
Tx: robinhood-testnet 0x6fa4315f5884f7943065b06600e7204167ecec54d1643fe68430b7ebb0be0396
Tx: robinhood-testnet 0x57406a2fd059fec934a160f5b161343d1ac1e5bc67ec3d01c1b1a359802a8512
Tx: robinhood-testnet 0xd91efa1df3254781e57676c018c1f4aeb34078b141fa77e9663c7040a85848f8
Tx: robinhood-testnet 0x721bcbefe08239d094b543cebbd5f39012ea304bfd96227f0aaf7e3011333f24
Tx: robinhood-testnet 0x4a8b7700322870526bf413d4123b6b1c92085b0582234c47eebcc6ad226d1271
Tx: robinhood-testnet 0xef54c2d01b1e27f12d6793e5206cc9a796558ec4910c39856eb0e17c3839575b
Tx: robinhood-testnet 0x6f809459ffe06ba471405339c32f18928fd02421de388970846cd106ba7f633a
Tx: robinhood-testnet 0xd1c8a15985c29e25e01b0f8fbe4f87cc7b6ee2e81ea093d0e5abea38fd0ec685
Tx: robinhood-testnet 0x5dc6c576562b94a5acb1db70f94b2784bcad285bb447f63c29cfb0cc57740b93
Tx: robinhood-testnet 0xd10e4b31af1839ccd71ca53df2eadbd6091e3ebc5dcdeaad7b8ebc5aed9a2adb

base-sepolia (chain id 84532), contracts/pool-evm/script/testnet-run.mjs at 2026-11-04T09:28:36.551Z, the pool 0xb239a38af69b68e6c5c305df64985f283b5d5fe5, the token 0x036cbd53842c5426634e7929541ec2318f3dcf7e, venues v4 and v3. Its steps, in the order of its Tx lines above: deposit, buy through v4, buy through v3, sell through SellDelegate, sell through SellDelegate, withdraw, withdraw, withdraw, sweep (a W's ETH back), sweep (a W's ETH back), sweep (a W's ETH back), sweep (the run key's rest back).
The run key 0x58adb3bc3e7621ff037f0dfa4b9dc6943fac73e5 lived only in the run, sent every transaction but the Ws' own sweeps as the relayer, was funded with 3111320000025908 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
The restore from the words (packages/wallet evmRestoreNotes) at block 54311753: 8 notes, 5 spends, the Ws 0x9883b7052bda98c1a31065d03aa55e6077e32a2e (unread), 0xe728455c3564adc029324042df0ec9a13084f4f2 (0x036cbd53842c5426634e7929541ec2318f3dcf7e, 0x4200000000000000000000000000000000000006), 0x3dc9b919eb3965c0f2bcf12182262bf744a5bc75 (no token), 0x006ee12b44757ed0b2824719628b8a85c0aff7f5 (no token), 0xf04daf34b703eb73432f350f3d3848cc2bee4e16 (no token).

robinhood-testnet (chain id 46630), contracts/pool-evm/script/testnet-run.mjs at 2026-11-04T08:51:10.820Z, the pool 0xe5e948414a89c23e73d76cd740dacdd9364c25d5, the token 0x10e626a1d0857174b9a5bdb7a1397068811fbbbc, venues v4. Its steps, in the order of its Tx lines above: deposit, buy through v4, sell through SellDelegate, withdraw, withdraw, sweep (a W's ETH back), sweep (a W's ETH back), sweep (the run key's rest back).
The run key 0x6818f62584c571c0a3996ff6e307865348a528b0 lived only in the run, sent every transaction but the Ws' own sweeps as the relayer, was funded with 2119800000000000 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
The restore from the words (packages/wallet evmRestoreNotes) at block 148247453: 5 notes, 3 spends, the Ws 0x746e4f14876edbc394ddae6db6a617fec89d6557 (0x10e626a1d0857174b9a5bdb7a1397068811fbbbc), 0xf9af6d54a3ce9f246d813657dc9fd4e7c664a787 (no token), 0x163fb36634322c7fc43bb3399a5e9a2e89702e49 (no token).

robinhood-testnet (chain id 46630), contracts/pool-evm/script/testnet-run.mjs at 2026-11-04T08:45:58.000Z, the pool 0xe5e948414a89c23e73d76cd740dacdd9364c25d5, the token 0x10e626a1d0857174b9a5bdb7a1397068811fbbbc, venues v4. Its steps, in the order of its Tx lines above: deposit, withdraw, sweep (a W's ETH back), sweep (the run key's rest back).
The run key 0x1a57afd7865bb438bebf93e4c3ec856c7cc7a7a2 lived only in the run, sent every transaction but the Ws' own sweeps as the relayer, was funded with 2119800000000000 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
Stopped after its deposit: Robinhood testnet's own RPC answered null for block 148245096, which the other held, and the run read the pool's time once (since then through the wallet's evmRetryLag); its finally withdrew the deposit note to its W and swept that W and the run key back. Its record is rebuilt from the chain (each receipt on both RPCs), the run's own file having been overwritten by the next run's.
No restore was run.
