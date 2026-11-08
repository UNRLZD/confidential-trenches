CARD sol-w-sweep / live: PASS
Money path: yes
Tx: solana-devnet 5oZpdzqxabe6PqCwmjiVnwguPtZTFaYwrQHJCbWJw5K3RnHBcmj4zbMEVytx1TZ5fLBu4V9VcckSfs5j4ERUit13
Tx: solana-devnet 5Qki82rZLMUWQXVmvCKfxnt21PPgVdntdazpzWMKTsvTGRMwz7VwBAZ5uPNDyNXqkrgX5Yd6LJx2zow5uy5vKGUf
Tx: solana-devnet Mccy8VbhWsrZKHbvt5dLkRMWv49suHSfBKkiMXhekizzEVWTxD94FY96me6XXQbQFRhppGUyAQYF1XsyHCnRSzh
Tx: solana-devnet 2QDLxRQqpo6ppoEooyYSum2rp3Yn2zo1EVEa75EN1TP7Gr61AcxsKh3iXrd83sKgeCz6j1NS9nWTKiZu51qxFXha
Tx: solana-devnet 2MaYtL9LPc7npeBcu7JjrZWqYin4JTm7XuXBvehiG5DN2UMV1VJ2syn9hcWetZKsDdsoWQTAuTRGj9qWmFCGeTUj
Tx: solana-devnet 5RiNsutM7A6ZnsrsgiBmEMGjUHStTunrHvcmRbnj6kB6QFHbYGsEw8ApDnhdq3k5Q3VbhuFQxFsCo62FbT6ws4fi
Tx: solana-devnet 36Q79n8vjSHNeZAqKa9f2FJJvtvNcLC5Adhm1Q1Pkj1eKHsUyapcUQ9k8HGe1V5yrrgFPkHkkBvE9Eo8atyet1eS

The run, on Solana devnet, 2026-11-08 07:48-07:53Z, from the sol-w-sweep worktree at 38faee89 (release-96): packages/signpage/scripts/pool-flow-devnet.mjs on table 6bbfV79efN889c4iRTSTf4htv6EnurCJuz5CjMftjsyZ, coin AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P (venue pump-curve, cashback false), pool 92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr, spend max. The Tx lines above, in order:
1. Our devnet wallet D funds the run's U (JBy5SFeTsCSHA5ZkxC5x767fp7vZA33YL8z2WPP15L41) with 11473120 lamports, the exact need the run printed: U 0 to 11473120.
2. The pool deposit of 0.01 SOL from U: U 11473120 to 0; the note UNSPENT at leaf 7.
3. The pool buy at the max spend, 4346520 lamports, through the helper's POST /v1/pool/solana/send: W (BwuzJHjTcfJSQMFg25afAuumCrAXwXPLJKhXsTNx7W3m) 0 to 1493440, the sell's need on any venue the coin sells on; the note SPENT, change 0 at leaf 8.
4. The sell of all W held (13374509.635839 of the coin), signed and paid by W alone: W 1493440 to 2716856; the return note UNSPENT at leaf 9, 1542659 lamports.
5. The teardown's first frame closes W's token account of the coin (CloseAccount): W 2716856 to 4225696.
6. Its second frame closes W's pump volume account (CloseUserVolumeAccumulator): W 4225696 to 5566896.
7. The sweep, a tag 1 deposit of everything W holds into the pool: W 5566896 to 0. 4093776 went to the pool, 365760, 365760 and 736600 to the new records' rent, and 5000 to the fee. Its note was INCOMING when the run ended (the "second" ref).

After the rent back, W, its token account and both of its volume accounts read null on both RPCs (getMultipleAccounts at finalized, 08:02Z; W and the token account under both token programs): nothing is left stranded. Run 7 (signpage-pool-flow.md, before this card) left its W holding 3627456 lamports after the same rent back.

Each Tx line reads back the same, finalized, err null, on https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public (the money gate's two devnet operators), with the lamport moves above.
The run keeps its seed (~/.ct-devnet-runs/run-2026-11-08T07-48-25-897Z.seed, 0600, outside the repo, never printed): its return note at leaf 9 stays spendable, and so does the sweep's note once the pool lists it.
