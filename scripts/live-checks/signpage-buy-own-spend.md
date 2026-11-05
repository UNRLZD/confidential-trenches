CARD signpage-buy-own-spend / live: PASS
Money path: yes
Tx: solana-devnet 4FvHxn7UZBHg9g3ngurXiADquA3jfK1vqS7sP1xVZT6BZSviZDWwjTzMLB57uAFq7mrQseSS2W7ofzz3G9jndCP
Tx: solana-devnet 9gZ4Y5BEShJ6qwSVRQACKzhKWZAfz6SY8NYXM6svpvNi2ZXDY7P7K1v9SEtLBUNHgsH7QTYjQsZ3DamGKTVBpXH
Tx: solana-devnet 3bRnzYmmPnkoNjioyU7cW1WG9rVaZ3QbPdB4Hzd9hKRr7aSzfsUhvTXbWH65scPY9Kc8fg8TCWf1KeacQuDbEJRJ

The run, on Solana devnet, 2026-11-05 11:47-11:54Z, through packages/signpage/scripts/pool-buy-own-spend-devnet.mjs
(table 4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy, coin AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P, 0.004 SOL a buy),
in the order of the Tx lines above:
1. Our devnet wallet D funded U, the deposit's source device A's note store planned, with the exact 11473120 lamports
   the run printed.
2. Device A's pool.deposit of 0.01 SOL: filled, the note UNSPENT at leaf 18.
3. The first try stopped right after the deposit, on the harness's own check: A's proof queue had already moved the
   note to HELD, and the check took only UNSPENT. The check now takes UNSPENT or HELD; the run went on from its kept seed
   (FLOW_RESUME), with no other funding.
4. Two devices on that one seed, each with its own wallet store and note store: both restored the note at leaf 18 from
   the seed on both devnet RPCs, and each proof queue made its own proof of it (its own attempt and salt).
5. Device B's pool.buy: the helper's send was busy once (its 429), sent again the same bytes, then filled (the third Tx
   line, finalized with err null on both RPCs, the pool account among the 14 keys its lookups load). B's note SPENT,
   its change 0 at leaf 19.
   The one W of both devices: 6aGEe7qZn4a3aCyghuR8xFFNdy4y2QT6VTGXnxkzyje7.
6. Device A's pool.buy, its own proof of the same note, to the same W: the helper keeps one send per nullifier and
   answered with B's signature, sending nothing (W's finalized history holds B's buy only). Both RPCs read that
   signature as another's bytes; A's settle found the note's spent mark and wrote the change (A's note SPENT, its change
   0 at leaf 19, UNSPENT); spendOwner read the spend in W's history on both RPCs as another attempt's. A's only stage:
   not_landed, never filled. On main 8791c3d this path answered filled (src/pool-buy.ts:515, the settle's spent alone).
The run's seed is kept at ~/.ct-devnet-runs/run-2026-11-05T11-47-39-442Z.seed (0600, outside the repo): W keeps the coin
B bought.
