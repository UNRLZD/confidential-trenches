CARD sol-buy-rent-back / live: FAIL
Money path: yes
Tx: solana-devnet 3LJ39AL36WHtZXqhRxAxHerD6Xk477C7SD17vGi84NUH9xzPufurw2BUUUofqYcdahbhUck39iJkoKcczVLbP7dS
Tx: solana-devnet 5ZiL5DkUmWTm9rwMoWc2x2kzQ6zXa2pGDRZGMtQJNRk4ZxJkaZGSMqg316MxD4mHv3Gv9LjHhNgMXddPFbK4Dsmw
Tx: solana-devnet 2HovnAW2dy39SWJ9MdoWTCs1vZ2jh2SQnPbVHrdiSpTsTenFavNccRP43qscgZEULrrVD2Q4rruHh1qe8xQDnQZe

One run of packages/signpage/scripts/pool-flow-devnet.mjs at main 967c52d6 (the merged rent back), on Solana devnet,
2026-11-05 23:59Z to 2026-11-06 00:05Z, with the lookup table DEVNET_TABLE pins and the devnet pump curve coin
AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P, spend "max". The run failed at its sell, so the rent back never ran.
The Tx lines above are in order:
1. The funding of U from our devnet wallet D, the exact 11473120 lamports the run printed.
2. pool.deposit of 0.01 SOL: its note UNSPENT at leaf 32.
3. pool.buy of 0.004346520 SOL (the max spend at relay fee 1300000), sent through the helper's send: the deposit note
   SPENT, change 0 at leaf 33. W is B4TR4XV99YPfmqs4XjXJrv2MLs1TBnHCRQGtFyqMPdPf.
4. pool.sell of all W holds answered not_allowed at 00:03:38Z and sent nothing. Before a sell runs, the page reads the
   coin's mint on both devnet providers for its decimals (packages/signpage/src/pool-kinds.ts readTokenDecimals). That
   read on OnFinality's public devnet endpoint still answered HTTP 429 after the page's four tries, and any failed
   decimals read is answered not_allowed (pool-kinds.ts, the read's rejection handler), the code the app takes as a
   refusal no retry changes. OnFinality answered HTTP 429 256 times in the run; the cluster's own RPC answered none.
5. Not tapped again: a kind that does not land on its tap is a failed run.

W's accounts at finalized after the run, read on both devnet RPCs (api.devnet.solana.com at slot 519113115,
OnFinality at slots 519113253 to 519114323), the same on both:
- W: 1493440 lamports, owned by the system program.
- W's token account 8N1t4Fjix378yRAa98xwssHgib86ubq9Qxe6kp8trP5F: 1513840 lamports, owned by Token-2022.
- W's pump volume account G8EPuohwiAXLW55gu7tbSopEzK8nAPRDx728Nr1noBUd: 1346200 lamports.
- W's pump AMM volume account 9xyfzngxcjEhW2Z7GtWJ22cP1QdDWoXJsr1hnV5LUL5X: null.
The rent back's end state (each null, W at 0) is not shown by this run. The run's seed is kept in its file outside the
repo, so W's coin and rents stay recoverable.
