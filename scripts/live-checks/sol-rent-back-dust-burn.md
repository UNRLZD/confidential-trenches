CARD sol-rent-back-dust-burn / live: PASS
Money path: yes
Tx: solana-devnet 5ox5mRCZ1TSXTxJvRimEAFLPNSVENNuCtD9aHmTvj9Pv84P849dz3ecDf734Vkx767GtxAi9vxmUBbiuUgPhbDob
Tx: solana-devnet 4PP83peu4RzYZtL3xhZeuVgXsF3qVxUatX1exobZakF1BksuQNRTdYrNZMHtwtzEwVQxaz1eVdfptoWomCwe3sT4
Tx: solana-devnet 4gnZPTZmc9LsSvB3QdPi43iiWu6vLMdAG2bu42waoWDnBopqrXes2QuZsnd9KC23ViBEHECvaWGMUUZFwKYE1ay5
Tx: solana-devnet 5uTHs78NKGso8RStk9H5DnqwixGPAbPnEbnAS3PW2Pv6aggWB4E6jpAgqStmsp1NeRrV5WEFe7y25ySEKGmJicsP
Tx: solana-devnet 5wC6BaB8xKyriKnoqDq3FbN1rK6bkiHwUxBoHy2yRagKaDGRP4jFHqgGVAX7wFAnvZKfqqEtyyi7M2r2otNibRgD
Tx: solana-devnet 4v32pJJxKUZ721wBU9smDoJC4V8nNLXGj1P812QP4oakodciHNgN3qtdC3ojw5Zfo5f5yxSMhHQcvPTK1hP2JWC4
Tx: solana-devnet 29mWLStqr4wgcZvFPMvcCq3vUKfN97NGxbDL3NaZeyzYbheJFjJ6bSefdQKXDP7wTbtFKq71UDxvG3DH3PsXsNxo
Tx: solana-devnet 2BDZJHumPj8pwvBev38aGZjGWadgc6tDRxt9kpnjAJLoU6XbG1m5c7mnsWumvGypz7o52L13TDkbcrTGtpemiEMa
Tx: solana-devnet 5Wh4uUmvSMxH8iKCDZkgCPp4NSMAawBab4FfsAgMFMX6Z1VRghUf2qyLEtdi8B2Ph7BmebQ7Y5Jhc8mGCzSS4bXC
Tx: solana-devnet 55vVXiqDGtERuhvJXdp9SJKGZUiwhA439Q3dCYQqp15NzvvJN1sxYPwn999ccX9e6qhJLmL8FFqLNWg8jUYs8wzt
Tx: solana-devnet 43JXAJ1TEJWCNf2TTiw3TgqLAyP3558vvfHP9xnznUCqRU4JuA2oHoP35Frj5AyxTho1ZT6ktBqvqgHdZqGi2JC9
Tx: solana-devnet 2Bgb4J2Bjm1X9KyhThG5QiKQcgMBURavYd1nKvqYRCaJYFSmZ8wvhpBspn593QqBKn3Eaqhwrr4CV2MXUxZwPsB
Tx: solana-devnet 2KG5eFNpt7jKPyaT9GdTgNAMS4PBgAg6WHr818ALfA95PzxJHuGPtntiaQff5f4F8qX8rpVWVuLpsjHF3CPkhRAv

This is the devnet run's record, as sol-w-sweep.md is; the card's live check (sol-rent-back-dust-burn.mjs) runs after the sign deploy.
The run, on Solana devnet, 2026-11-08 12:30-12:58Z, from the sol-rent-back-dust-burn worktree: packages/signpage/scripts/pool-flow-devnet.mjs with FLOW_DUST=1 on table 6bbfV79efN889c4iRTSTf4htv6EnurCJuz5CjMftjsyZ, coin AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P (venue pump-curve, SPL Token, cashback false), pool 92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr, spend max. The deposit and the buy ran at 122ca63f (12:30Z); that run stopped at its dust step (a holdings restore did not find W), and the rest ran resumed from the run's kept seed after its buy (FLOW_RESUME with FLOW_BUY_SIG, FLOW_STRANGER) at 11be498c (12:48Z); the last load (FLOW_RESUME with FLOW_SWEEP_W) at af3b1bd4 (12:57Z). The device code (src/pool-sell.ts, the kit) is f6243055's in both.
In the order of the lines above:
1. Our devnet wallet D (3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx) funds the run's U (7mXZuTQBpaJwm2rbSGEBS9g4a8yuBS4aY5uND2aZS1A2) with exactly 11473120 lamports, the need the run printed.
2. D funds the stranger S (7TzHyr4mUKpXjK1X7e22DAPtvXfKX7GbiwAEPsuXA7KS) with 1700000 lamports.
3. D sends S 630000 more (the run's first S need left out S's own rent-exempt minimum; its setup failed simulation, nothing sent).
4. The pool deposit of 0.01 SOL from U: U 11473120 to 0; the note UNSPENT at leaf 11.
5. The pool buy at the max spend through the helper's POST /v1/pool/solana/send: W (5NWvHD8cfFJTfaxjQiZaxE6B3MRUD84nhmztK219Ghwt) 0 to 1493440; the note SPENT, change 0 at leaf 12.
6. The dust setup: S takes 1 unit of the coin from W (createIdempotent of S's token account, then transferChecked of 1), S paying the fee and the rent: W's lamports stay 1493440.
7. The sell of all W then held (13374509.594506 of the coin), signed and paid by W alone: W 1493440 to 777416; the return note UNSPENT at leaf 13, 3482099 lamports; its meta reads W's token account at 0 after it on both RPCs.
8. The dust: once the sell read confirmed on both RPCs, and before the rent back's first read of W's accounts, S sends that 1 unit back to W's token account (transferChecked).
9. The rent back's first teardown frame burns exactly 1 from W's token account (Burn, signed by W), then closes it (CloseAccount): W 777416 to 2286256.
10. Its second frame closes W's pump volume account: W 2286256 to 3627456.
   The rent back then ended "floor": "W's 3627456 would make a note of 2154336, under 2600000: kept on W". That is
   card sol-w-sweep's rule, not this card's: the sell's min out at this coin's devnet price could not also fund the keep
   that lifts the sweep to the floor, so the sell kept rent(0), and W's lamports waited on W, its owed record kept.
11. S's leftovers go back to D: S's token account (balance 0) closed and every lamport S held, 2310000, sent to D; S at 0.
12. D tops W up with 500000 lamports so a note of W's lamports clears the floor: W 3627456 to 4127456.
13. The next load runs the rent back once: the sweep, a tag 1 deposit of everything W holds into the pool: W 4127456 to
    0. That load (pool-flow-devnet.mjs, FLOW_SWEEP_W) writes W a fresh owed record, its mint alone, with no `sell` and
    `passes: 0`, then the page's state read; W's token account had closed at line 9, so the record's missing sell
    changes nothing here.

Before this card, run 7 (signpage-pool-flow.md) and every W holding a stranger's unit ended "holds" with the token account open; here the unit is burned and the account closed, and W ends at 0. After the last load, W, its token account and both volume accounts read null at finalized on api.devnet.solana.com. U ended at 0 at its deposit and S at 0 at line 11.

Each Tx line reads back finalized, err null, on https://api.devnet.solana.com (read 12:56Z and 12:58Z, getTransaction jsonParsed) with the moves above; the money gate reads each on that RPC and https://solana-devnet.api.onfinality.io/public.
The run keeps its seed (~/.ct-devnet-runs/run-2026-11-08T12-30-42-621Z.seed) and S's key (~/.ct-devnet-runs/run-2026-11-08T12-30-44-611Z.stranger), both 0600, outside the repo, never printed: the return note at leaf 13 stays spendable, and so does the sweep's note once the pool lists it.
