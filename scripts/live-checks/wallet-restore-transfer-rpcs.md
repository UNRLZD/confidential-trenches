CARD wallet-restore-transfer-rpcs / live: PASS
Money path: yes
Tx: base-sepolia 0x85d7e539ba30819a5ce530072f697ac1dc5a60acf914e7505143d2d69b0d86ca
Tx: base-sepolia 0xae1dda6e81a2f36641e66aa1241666ea3c642a1ea45a815f3065335ccb30bd42
Tx: base-sepolia 0xe7ed8d2f56bd5dbf063ad327e9820f1002600381b93564de5b28b741ef299bce
Tx: base-sepolia 0xf39671f0b562b6331fb04bc0eda115ed491826ab1eb409b06b7d4c55804ab516
Tx: base-sepolia 0xd2ba43f0eedd3b306802c7c18d47e0b8b882f11b5d674432d3dfae8cf5a8078b
Tx: base-sepolia 0xf0322a7fef2aab5f5b9f6fc639a327f9a04e584c7452762bee95fcc92bd05e28
Tx: base-sepolia 0x98916a16509d60f7b7099082cb03d51d59f49b7206400cf674b22eaeeacc7361
Tx: base-sepolia 0x9c0f82ab59f192e99dd22ca0c32e63fbfe8dc111cf3218784773f3aa11b5e917

base-sepolia (chain id 84532), contracts/pool-evm/script/testnet-run.mjs --venues v3 at 2026-11-05T15:30:40Z, the pool 0xb239a38af69b68e6c5c305df64985f283b5d5fe5, the token 0x036cbd53842c5426634e7929541ec2318f3dcf7e. Its steps, in the order of its Tx lines above: deposit, buy through v3, sell through SellDelegate, withdraw, withdraw, sweep (a W's ETH back), sweep (a W's ETH back), sweep (the run key's rest back).
The run key 0x90683b8594fd9f1364e83a0e98b92e1b0dce2683 lived only in the run, was funded with 2065890000028016 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
The restore from the words (packages/wallet evmRestoreNotes, the Transfer reads on EVM_TRANSFER_RPCS base-sepolia) at block 54853361: 5 notes, 3 spends, every note of the run found, every W read: 0x8c02dc260d147ef2bd4c73e1ff99ec37791746e9 (0x036cbd53842c5426634e7929541ec2318f3dcf7e, 0x4200000000000000000000000000000000000006), 0xca52ca59afea267d26ec368e729054a496675446 (no token), 0x1191cf05171b5d5a5a70b871b21f2a45799207cd (no token).
Read back by scripts/live-checks/pool-evm-testnet-run.mjs on both RPCs at 2026-11-05T15:31Z: PASS, every transaction, the pool's views at block 54853997, the 3 nullifiers and 2 precommitments marked, the selling W delegated to the pinned SellDelegate, the run key's rest 204000000473 wei.
