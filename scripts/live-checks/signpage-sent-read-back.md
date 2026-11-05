CARD signpage-sent-read-back / live: PASS
Money path: yes
Tx: solana-devnet 5X1xdpyk6miQsvtZ2VLTtU9ERKinSLDBe4jm4zNDmJqryZhKTjpeXNdypE3FsNMfmxi3vKzdr195SkDQLrjCr1fP
Tx: solana-devnet 4tM5GRo1e78sKmLPikUYpEKknW1G7ntzYvmkhsKarDg6XAhEyTWVFMFbtunktZN2DSQgW9DkiBH3FDK5zpjabk5o
Tx: solana-devnet 48Xv1SNVzuNDAaB6FXW5MNUjCMW5LArZdeqJahVeQ3DrsXzBSPQQxiNjiV2wvuF5v58AXjSECU5LHuYfKb4nNBEv
Tx: solana-devnet 64ifXzuCveTwgHLLgSwEmK4Qf4pHNP6n48B4VCT4vHoWb9RYZP36PoTwLy5bn2KE47Vjc1zULH4LfbEeyMnow2wz
Live check, SIGN_HOST read 5 Nov 13:45Z: `NOTE the bundle sends no pool transaction (no pinned pool on this build)`, `PASS`.

The run, on Solana devnet, 2026-11-05 13:49:57-13:51:44Z, exit 0, through packages/signpage/scripts/pool-flow-devnet.mjs
on this card's review fold (28f7778: the pool.buy kind answers sent only once both RPCs read its signature back as
this very transaction, and its final stage always goes out as progress). In the order of the Tx lines above:
1. Our devnet wallet D funded U, the deposit's source the note store planned, with the exact 11473120 lamports the run
   printed (slot 518958700).
2. pool.deposit of 0.01 SOL: answered sent, then progress filled; the note UNSPENT at leaf 20 (slot 518958752).
3. pool.buy of 0.004346520 SOL (the most the ready proof spends on the coin's pump curve, relay fee 1300000): answered
   sent with its own signature, then progress filled; the note SPENT, its change 0 UNSPENT.
4. pool.sell of all W bought: answered sent, then progress filled; a return note of 3482099 UNSPENT at leaf 22.
Coin AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P, lookup table 4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy.

The buy's timing, from the run's own log (UTC, each line stamped as it printed):
- 13:50:55.641 the tap (pool.buy asked).
- 13:51:13.774 the helper's POST /v1/pool/solana/send answered HTTP 200: 18.13 s after the tap (the checks, the reads
  on both RPCs, the signing, and the helper's simulate and send).
- 13:51:15.524 the kind's answer, sent with its signature: 1.75 s after the helper's answer. That is the read-back on
  both RPCs this card adds before the app is told. Tap to answer: 19.88 s.
- 13:51:20.802 progress filled: 5.28 s after the answer, 25.16 s after the tap.
The tap-to-answer time is over the kit client's 10 s for pool.buy (packages/kit/src/signpage/client.ts
SIGNPAGE_TIMEOUT_MS) on devnet, and it was before this card too: the helper's answer alone came 18.13 s after the
tap. The app learns the end from progress (filled here), which the review fold now always posts, answered early or
late. A buy whose answer comes past the client's 10 s shows Filled with no signature: the kit's progress event carries
the stage only, and the kit interface is frozen.
The run's seed is kept at ~/.ct-devnet-runs/ (0600, outside the repo); its return note stays spendable from it.
