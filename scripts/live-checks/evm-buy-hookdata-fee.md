CARD evm-buy-hookdata-fee / live: PASS
Money path: yes
Tx: base-sepolia 0xddee6b9863bfb3be7baf2a588da474aea06cd9cea7018f584b07fbf2a7172aff
Tx: base-sepolia 0x1f10b53469d16940971badf3afb13987f6dcae55e91b75f40a151446fdb4645a
Tx: base-sepolia 0xd12b6786d74fce32c33179e3e52f3f349956a1ca861c4cccb23e6416e1f97be3
Tx: base-sepolia 0x5e268c4d89becf3d17b0f7a22f7a3b28b9c85b1956e5cd3650c48eda39c78473
Tx: base-sepolia 0xca57052cba25f29c3b63f08737a37cb7f66f8038d3aa071a2545d99ba30ef976
Tx: base-sepolia 0x87284b49004ef9e50902ac8156c228a016bf691adccabc7691a1699df49d1e78
Tx: base-sepolia 0xdec46946f4cd431b178279df8e00183d25448f1cd171236b4e6074f3a25cc526
Tx: base-sepolia 0x384bed4d795ef28d60fb23348e7645bc088ac52705529e5f3ca32557b5862ee1
Tx: robinhood-testnet 0xf596b8ae9e0611808a3268985c14352a7bca09696eda705c4c5e05aa7ed3c382
Tx: robinhood-testnet 0x5a8ebd6aebf6e61ed5036e8af773b4cdd03118ec6980ff6623308de66b580fd8
Tx: robinhood-testnet 0x6e5bc31ff2539ae22f2187bd98678c593d9c29c8be860d67116bb65bc2604951
Tx: robinhood-testnet 0xd32e966cd0fa07a3c8399daa89527cc11c8e63bed98fc9019dc1ab7893c6e618
Tx: robinhood-testnet 0x66ded835ffc8b4a5ec9418e0ff1e2fd9776e46330a287285f29a45d68363a661
Tx: robinhood-testnet 0xda2cb6aef35a32dc1cd5f0cd94b6401a7f8711d0f3adabec347f88765c5d6d98
Tx: robinhood-testnet 0x10ce404b536336d72e733606badbf31efc7f23bd479b50163fa913fb727e0190
Tx: robinhood-testnet 0x3f383d75742dd1946f75529b81a75405731ee224937f2e35eca549e3ff0348ca

The base-sepolia Tx lines are a run on Uniswap v3 alone (testnet-run --venues v3, not the brief's v4,v3, approved 4 Nov): the first run on v4,v3 (22:21Z) stopped before its buy, the kit refusing it as partial_fill ("a hookless hop runs out of liquidity (NotEnoughLiquidity)") because Base Sepolia's v4 ETH/USDC pool (fee 100, tick spacing 1, no hook) no longer holds 0.001 ETH of liquidity, while v3 (fee 3000) quoted 0.001 ETH to 1868233 USDC units on both RPCs (22:24Z). That run's deposit was withdrawn and swept back and is not in this record. On the v3 run the device refused the run's own v3 route (below_reference) and bought on its own best v3 route; its restore from the words found every note, but read no token list for two of its three Ws: base-sepolia.drpc.org, one of the two Transfer RPCs, answered eth_getLogs over 1,000, 2,000 and 5,000 blocks with "ranges over 10000 blocks are not supported on free plan" (read 23:20Z), so testnet-run printed no done line; every step landed and pool-evm-testnet-run's live check passed on the record. The robinhood-testnet buy is the v4 one: its transaction 0x5a8ebd6aebf6e61ed5036e8af773b4cdd03118ec6980ff6623308de66b580fd8 carries the one PathKey (tSPILL, fee 10000, tick spacing 200, no hook) with hook data of length 0, the device's own empty hook data, read on both RPCs.

base-sepolia (chain id 84532), contracts/pool-evm/script/testnet-run.mjs at 2026-11-04T23:18:01.692Z, the pool 0xb239a38af69b68e6c5c305df64985f283b5d5fe5, the token 0x036cbd53842c5426634e7929541ec2318f3dcf7e, venues v3. Its steps, in the order of its Tx lines above: deposit, buy through v3, sell through SellDelegate, withdraw, withdraw, sweep (a W's ETH back), sweep (a W's ETH back), sweep (the run key's rest back).
The run key 0xa624d5ad2478a6a8e5055590089e4eef2e592f6b lived only in the run, sent every transaction but the Ws' own sweeps as the relayer, was funded with 2126769035081944 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
The restore from the words (packages/wallet evmRestoreNotes) at block 54561002: 5 notes, 3 spends, the Ws 0x809286a1bf1585b1eeeefcc7a7f3508158fd078e (unread), 0x40dc7c6201067dcefe39cee6bfe24c346e4893f6 (no token), 0x3d8f8be2e5c4f3061d0bccf45d7b04a7a81ca155 (unread).

robinhood-testnet (chain id 46630), contracts/pool-evm/script/testnet-run.mjs at 2026-11-04T22:03:58.956Z, the pool 0xe5e948414a89c23e73d76cd740dacdd9364c25d5, the token 0x10e626a1d0857174b9a5bdb7a1397068811fbbbc, venues v4. Its steps, in the order of its Tx lines above: deposit, buy through v4, sell through SellDelegate, withdraw, withdraw, sweep (a W's ETH back), sweep (a W's ETH back), sweep (the run key's rest back).
The run key 0x02eecfc29bb1d27fdbfa07b96cbbb979dc376b18 lived only in the run, sent every transaction but the Ws' own sweeps as the relayer, was funded with 2119800000000000 wei (the printed need) and swept back to 0x49f2425b7f33f3a10912de8add6839226ce663a2. The run's 12 words lived only in the run; every note came from them.
The restore from the words (packages/wallet evmRestoreNotes) at block 148612194: 5 notes, 3 spends, the Ws 0x764c5ac2e39fec9d25af6d3eaf9400f91d82a531 (0x10e626a1d0857174b9a5bdb7a1397068811fbbbc), 0x27b6df0477705be4d138f1dc29cd2a2c86a19755 (no token), 0x648865bbcafb8df0f92bac90826abf60b9aa7d98 (no token).

Each bind waited until the pool's time was at least 25 s into its epoch (testnet-run --bind-from-s 25), so the device read the epoch's fee at its first block 25 s or more back on the kit pin's providers, and the run's relayer fee (testnet-run's relayFee) matched it, since no helper ran in these runs:
base-sepolia: bind 58 s into epoch 2026-11-04T22:49:00.000Z; bind 25 s into epoch 2026-11-04T22:51:00.000Z; bind 28 s into epoch 2026-11-04T22:52:00.000Z.
robinhood-testnet: bind 29 s into epoch 2026-11-04T22:01:00.000Z; bind 59 s into epoch 2026-11-04T22:01:00.000Z; bind 25 s into epoch 2026-11-04T22:02:00.000Z.
node scripts/live-checks/pool-evm-testnet-run.mjs --record-file scripts/live-checks/evm-buy-hookdata-fee.<chain>.json passed on each record.
