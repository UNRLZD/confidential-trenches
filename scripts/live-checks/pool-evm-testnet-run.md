CARD pool-evm-testnet-run / live: PASS
Money path: yes
Tx: base-sepolia 0x3e12217aad7c077bae57972f13f002a57c34a0eb46e6ec51bc52cf917bd7bb60
Tx: base-sepolia 0xc84f16b51525885cd7594a6e9e6cc64112e0c08cd3b0181663640ae43d8d1d68
Tx: base-sepolia 0x6b3a19a32f78a663b18a1014b83608b418cff8b001cad683482568ad62f7bf8a
Tx: base-sepolia 0x32bb0d251ad796d93ee782f8ef22402ed9c0348bd39e4a492d192a55ae3ed23e
Tx: base-sepolia 0xfaf98b94c823c387355a5beeb72e7122d950a1538c831480d26d92c3ac7274bf
Tx: base-sepolia 0x43cadfcefe8e8fb7f2e72bf6842d3b2cd30b65b9a3370eb441b5a3a00b16a9bb
Tx: base-sepolia 0xe56c20c1db0a1e9e9b649d86d4a1af49a9cf101d69fc950d63844a8945566f7d
Tx: base-sepolia 0x7203e4d4170bab9013580b545bf3ff1a3f06c7a499d6c77fcb56cbc9b8d656cb
Tx: base-sepolia 0x8f128f8de99d2a7097a20d9d06bdc7a38d3b35fabc379547760f2fe537ecc6ca
Tx: base-sepolia 0x48002009eff684639b1b3515d1a34a05785b6a4a8631cf222bf15892d74f5726
Tx: base-sepolia 0xd2900ccc430136aed22af848222e2b690c9ef40534ff415d156836d7a272131a
Tx: base-sepolia 0x8f977ffa0908667c5b91a71b0673466ddd56d3a8c76b321942764bad0452b6d4
Tx: robinhood-testnet 0x73b236c25e74be1ffc8f2a6495548a56e19141e5b1b735ec14568eb274022652
Tx: robinhood-testnet 0x2cf7a41b6a0419c48382a869a032bb6bef24697841d058fb0460c519e2d161e5
Tx: robinhood-testnet 0xb3a89ec0d88a0d37940a72ed42a70b3204324579c83a97f50d84cc0a12f987f3
Tx: robinhood-testnet 0xb7878b796b704d752aef335bb50df8710f6767110ae6ee9627a0d60eb0dcf9fd
Tx: robinhood-testnet 0x5bd293c2d7a25278215df02b7e8def3a8abfe9c483bbd32ce64937d2604ab5bb
Tx: robinhood-testnet 0x5621358b696e7b10cd5b273bcf51026cbfabd93c572e163ca42158901c14d78e
Tx: robinhood-testnet 0x6010be7aa036351194ff998fc33d8c5ca1fee59e8e511e8451ef435751d3af72
Tx: robinhood-testnet 0xac667e52401086c8a35fd5fd985e57516bfaa97000201085271f9388bb7a1184
Tx: robinhood-testnet 0x6f809459ffe06ba471405339c32f18928fd02421de388970846cd106ba7f633a
Tx: robinhood-testnet 0xd1c8a15985c29e25e01b0f8fbe4f87cc7b6ee2e81ea093d0e5abea38fd0ec685
Tx: robinhood-testnet 0x5dc6c576562b94a5acb1db70f94b2784bcad285bb447f63c29cfb0cc57740b93
Tx: robinhood-testnet 0xd10e4b31af1839ccd71ca53df2eadbd6091e3ebc5dcdeaad7b8ebc5aed9a2adb

base-sepolia (chain id 84532), contracts/pool-evm/script/testnet-run.mjs at 2026-11-04T11:02:01.735Z, the pool 0xb239a38af69b68e6c5c305df64985f283b5d5fe5, the token 0x036cbd53842c5426634e7929541ec2318f3dcf7e, venues v4. Its steps, in the order of its Tx lines above: deposit, buy through v4, buy through v4, sell through SellDelegate, sell through SellDelegate, withdraw, withdraw, withdraw, sweep (a W's ETH back), sweep (a W's ETH back), sweep (a W's ETH back), sweep (the run key's rest back).
The run key 0x4ba77bc5173c4a5dd16a9261be12bb94e83425aa lived only in the run, sent every transaction but the Ws' own sweeps as the relayer, was funded with 3111320000042948 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
The restore from the words (packages/wallet evmRestoreNotes) at block 54339728: 8 notes, 5 spends, the Ws 0xefffcd6c47bfef950c2a4ab1a3912fef59e35c2e (0x036cbd53842c5426634e7929541ec2318f3dcf7e), 0x8ebb17e22bedffbe52137bce7329bf2af4b56ecc (0x036cbd53842c5426634e7929541ec2318f3dcf7e, 0x4200000000000000000000000000000000000006), 0x940997146309e51f868e73fca6cecf7fc4c1e767 (no token), 0xd852e19c406ccf844ba9f0f4205cfb2ae1c0a7d5 (unread), 0x2bd7f35daa524701f8344017732038d9b5f137ab (no token).

robinhood-testnet (chain id 46630), contracts/pool-evm/script/testnet-run.mjs at 2026-11-04T10:14:27.336Z, the pool 0xe5e948414a89c23e73d76cd740dacdd9364c25d5, the token 0x10e626a1d0857174b9a5bdb7a1397068811fbbbc, venues v4. Its steps, in the order of its Tx lines above: deposit, buy through v4, sell through SellDelegate, withdraw, withdraw, sweep (a W's ETH back), sweep (a W's ETH back), sweep (the run key's rest back).
The run key 0x02f2ce5b91050c5ee5c0869def6bc76b93f30854 lived only in the run, sent every transaction but the Ws' own sweeps as the relayer, was funded with 2119800000000000 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
The restore from the words (packages/wallet evmRestoreNotes) at block 148285915: 5 notes, 3 spends, the Ws 0x358e8ff7d847335d5533e6da08e1d153c8c12919 (0x10e626a1d0857174b9a5bdb7a1397068811fbbbc), 0x0ab043f3feba4b515c0eb218c787fb57e9af68a2 (no token), 0x0801d42d508dc3d7f59151ecd57d2b83bd482cc9 (no token).

robinhood-testnet (chain id 46630), contracts/pool-evm/script/testnet-run.mjs at 2026-11-04T08:45:58.000Z, the pool 0xe5e948414a89c23e73d76cd740dacdd9364c25d5, the token 0x10e626a1d0857174b9a5bdb7a1397068811fbbbc, venues v4. Its steps, in the order of its Tx lines above: deposit, withdraw, sweep (a W's ETH back), sweep (the run key's rest back).
The run key 0x1a57afd7865bb438bebf93e4c3ec856c7cc7a7a2 lived only in the run, sent every transaction but the Ws' own sweeps as the relayer, was funded with 2119800000000000 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
Stopped after its deposit: Robinhood testnet's own RPC answered null for block 148245096, which the other held, and the run read the pool's time once (since then through the wallet's evmRetryLag); its finally withdrew the deposit note to its W and swept that W and the run key back. Its record is rebuilt from the chain (each receipt on both RPCs), the run's own file having been overwritten by the next run's.
No restore was run.
