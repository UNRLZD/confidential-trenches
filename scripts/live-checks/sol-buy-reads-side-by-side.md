CARD sol-buy-reads-side-by-side / live: PASS
Money path: yes
Tx: solana-devnet 24W6xqY3j9qgtWkM2MWezWUFTpMe6AY2MPzLmeQ7Wjq5L5RqsWWvf9w1Pwm1tmpVV1ke11Em976br4f1pPdJBBLn
Tx: solana-devnet LtPuPJiVrmSk9Wb6Y2jZFxhvuue6p1qPceeHkCpdCBL5XpDNpYyCmp7duoBJJHT9HrBA2bKCYgKPUN6n1dtj7if
Tx: solana-devnet 5J9CbrvBMtwZ9nphJHGVLSomvap3jaue3wDVjDt7CpQ2tfBzf1j4MRzyBSnz7mbKKBCJ4qBStUGWBEK2uwrcTn2K
Tx: solana-devnet 668q9Q9LiRGs6xpTrb4N7eYD9cvTyQDdaUNdNNznRwrgWkKowSSRWnQ6jqQPCiQF9VMERdR2uPiWSw3r5Vn7r5FZ
Tx: solana-devnet VAuLD4QgZYtsv8DNmCNcocJCwTjDuwHr6PuYrgdk8kKz45JPNFEapeDcCdjdjXk3TWfKQF8NU9oZyEpHjy6vE5x
Tx: solana-devnet 5T8ZrfD1ZwgLrohiXCmKeo69FBBBHcPk91WYWcKrUTxVK7LC3QsnuY5zQY4wKf4Cbu89yh5ReC1YxVwwKp7it2NZ
Tx: solana-devnet 5xxTPdcicgztWrxkMqzpWw5mYHxWjh6S2Z1csTbeYWhzrcbVAsdtCW6fwozBf4bXdqhFyzL16vyaXqnW9DRGRyf
Tx: solana-devnet eoUKcgfRAojrhHjcn9AALxDYk2pA5NMvW954UtMTxfAFncJJKGPqiAazNdzRHmuNb6o8Bdy9GvK2mZ1keJ5mEpE
Tx: solana-devnet 4TRmTaTVifVey42W5BbbA9r8foWMq5QfzJE16a2Rodfuf5LYDQZJAr1e2mn9PgGr27f52dD1dBS4e2iSz5n23vjL
Tx: solana-devnet 35Fdpaax6sqWVzxzDfWonwWAKuwhen8HRari6EuMNJKwyW8ZFVw9XwYTNQ4ViBhiX1XGpmJBHPBHEW6JDQKfzqJm
Tx: solana-devnet 55Qjk1qrDCiAuMCPdwWMbFUypSYyXHMTu7LegVPRrtNuCeHzcPj2UTFvkPSbQTxREHU4Vd7vg2LU6NyNkepezuiN
Tx: solana-devnet zKpwbNoeETPaTjy6wrr49psTz8FhXbyQn9GgpLEGXzNeXw3ej9NNJ5GbdqqagKt1771W62NC6pfnSEwUF3g4VNj
Tx: solana-devnet 7SWgm4vMhxxd96DzSv1fitnVm2NNSY2eSRXNp3t7hVgfTbp9KbGRkrt2SPj6Ewxfeg2BcZs18XeQNDa3JNT4Xi8
Tx: solana-devnet 375UCaEHuQfisQUtSWNySdERsHr4JUe2hx2KzMaTAspjUoGvTdcZSt2osg1UCL37BFow3SRWQ1swANK5yixmUTu6
Tx: solana-devnet 2FFVZPsNoy2vHmicphg1Q8FWxiAuhbVyTdXVRvRU2NnXyoPtfiDhn5HTvLM7AkMzfQ84rKcfWLbnehcdsE1bLMgA

The live check reads PASS on this card's testnet build and on its mainnet build (packages/signpage/scripts/build-app.mjs
--out, both). On SIGN_HOST, read 11 Nov 00:35Z before this card's deploy, it reads FAIL with five lines, from
`BAD the bundle's read of the pool's time for the take does not stamp the monotonic and the wall clock before it asks
the pool` to `BAD the page's buy host does not pass the early read to the queue ...`: the served bundle has no early
read, so that is the before. After the sign deploy it must read PASS there too.

Every number below is Solana devnet's, through the deployed helper. Mainnet is not measured.

Run 1: packages/signpage/scripts/pool-flow-devnet.mjs on head 6b3bd660, over one HTTP/2 connection per origin
(scripts/h2-fetch.mjs), on 11 Nov 2026 between 00:18:28Z and 00:20:47Z. Its two devnet RPCs were api.devnet.solana.com
and the helper's /v1/rpc/solana-devnet. The command:
`node packages/signpage/scripts/pool-flow-devnet.mjs pinned AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P max <out>`.
Its Tx lines, in order:
1. Our devnet wallet D funded U (CTatuuM9QNgcq4C4EZdZZ69reLGkZKGi89TJ9Yy7yr9L) with the exact 11473120 lamports the
   run printed.
2. pool.deposit of 0.01 SOL: answered sent, then progress filled.
3. pool.buy of 0.004346520 SOL of the devnet coin: answered sent at 3464 ms, progress filled at 5718 ms.
After the buy the script's own read of W (getTokenAccountsByOwner on api.devnet.solana.com) was answered 429 with a
Retry-After of 10 s, past its transport's deadline, and the script ended there, before the sell (exit 1). W keeps the
coin on devnet. The script's own reads now wait out a throttle and ask again (96e8a549); the page's reads are unchanged.

Run 2: apps/terminal/test/e2e/buy/run.mjs (the app in the installed Chrome, the real kit and signing page, testnet
build) on head 96e8a549, whose src is 6b3bd660's, on 11 Nov 2026 between 00:26:51Z and 00:33:48Z (the buy's tap at
00:32:14Z). BUY: PASS, the box read "Filled 2.9s". Its three lines at the top, in order: D funded U
(5enGFb3RvN1Wm8R3MhpmqPP345U1BavFpW6zFu6LRkd2) with 11473120 lamports; pool.deposit of 0.01 SOL; pool.buy (W
3CnqZjGQYgpHbejpVzotcyT5a1yezQyn36y6iyyjpGkD then held 948902563378 of the coin on both RPCs). The sell was refused
(Retry, nothing sent), as in the app's run 4 on 10 Nov: the sell in the app is its own card (app-sell-e2e-in-the-app),
not this one.

Run 3: the same app run on head af3543d6 (src d6d1127b's), on 11 Nov 2026 between 01:05:14Z and 01:09Z (the buy's tap at
01:07:53Z), beside a run of the repository's unit tests on the same Mac. The box read "Filled 3.5s". Its three lines
after run 2's, in order: D funded U (CLu52cr8Qyqep3N7aHLHLb7ZX9r2B1Wv3FsGgutSXNz9) with 11473120 lamports; pool.deposit of
0.01 SOL; pool.buy. The run's verdict was BUY: FAIL on its own reads, not the page's: its getTransaction after the buy was
answered 429 by api.devnet, so it named no W and read no holding. All three read back finalized on both RPCs.

Run 4: pool-flow-devnet.mjs on head 66869118 (the script's own reads retried, the helper's Server-Timing logged), on 11
Nov 2026 between 01:09:25Z and 01:12:18Z, exit 0: the deposit, the buy, the full sell and the rent back. Its seven
lines at the top after run 3's, in order: D funded U (27V8T6xD8PoDED1SkY1rKmQNXX8fT2NjbHGG9qEzmrbM) with 11473120
lamports; pool.deposit; pool.buy (W Dwoz3p6BTaH1jWZd8TxGDzqmfQXZt4jVvTTdq1VzjbsF); pool.sell of all of it; the two sends
of the sell's run after it (the page's own sentTxs). After the rent back W's token account and both volume accounts are
closed (null at finalized).

The buy's split, in ms from the tap (run 1 and 2 of card pool-buy-filled-2s beside them, both on Node's HTTP/1.1):

| step | run 1 (a7109a84) | run 2 (418af7d5) | run 1 (script) | run 2 (app) | run 3 (app) | run 4 (script) |
|---|---|---|---|---|---|---|
| tap to send | 2404 | 2100 | 1420 | 1484 | 1421 | 1425 |
| send to sent | 1499 | 2051 | 2044 | 1469 | 2096 | 1364 |
| sent to Filled | 0 | 0 | 0 | 0 | 0 | 0 |
| Filled to Final | 2265 | 2227 | 2254 | 10077 | 2334 | 2510 |
| tap to Filled | 3903 | 4151 | 3464 | 2953 | 3517 | 2789 |
| tap to Final | 6168 | 6378 | 5718 | 13030 | 5851 | 5299 |

Over this card's four runs, tap to Filled is 2789 to 3517 ms (median 3209) and tap to send 1420 to 1484 ms, against
3903 and 4151 and tap to send 2100 to 2404 before it.

Run 1's tap to send:
- 0 to 742: round 1, with the take's time read beside it (getSlot and getBlockTime on both RPCs). api.devnet answered
  every read in 69 to 132 ms; the helper's route in 300 to 737 ms, which ends the round.
- 742 to 829: round 2; getLatestBlockhash on api.devnet 85 ms.
- 829 to 1408: round 3, isBlockhashValid and getBlockHeight on the helper's route, 579 ms each, side by side.
- The take made no read of its own (before this card it read getSlot and getBlockTime on both RPCs there).
- 1420 to 1783: the send, 363 ms. Read-back at 1784 and 2478 (not yet), at 3170 confirmed on both: Filled at 3464.

Run 2's tap to send, in the browser (its network log):
- 0 to 509: round 1 with the time read; api.devnet 72 to 103 ms, the helper's route 295 to 509 ms.
- 514 to 1394: round 2; the helper's route answered its getAccountInfo and getMultipleAccounts in 381 to 894 ms.
- 610 to 1473: round 3 (it starts once getLatestBlockhash answers, beside round 2), on the helper's route: 862 and 786.
- 1484 to 1842: the send. Read-back at 1843 (not yet), at 2660 confirmed on both: Filled at 2953.
- Final at 13030: from 4242 to 12615 api.devnet answered 429 to nearly every getSlot and getTransaction of the
  finality gate. In the 2 s before, the page's next proof pass had sent it about 40 getProgramAccounts and
  getMultipleAccounts reads. Final waits for that throttle; Filled does not.

Run 4's helper Server-Timing, per read on its devnet route (rpc-wait: the read's wait inside the helper before it goes
upstream; rpc: the upstream's answer to the helper):
- Round 1, eight reads sent together: rpc-wait 0 on each; rpc 83 ms for the first (getSlot), then 253 to 287 ms for the
  seven after it. The box's warm upstream answers in 82 to 104 ms (every read after the send), and a new TLS connection
  from the box costs 251 to 279 ms (measured 10 Nov), so the seven look like new upstream connections opened when reads
  arrive together. The header does not say new or reused; that is read from the times, not proven.
- Rounds 2 and 3: rpc-wait 47 to 404 ms (getMultipleAccounts 404, getAccountInfo 105 and 403, isBlockhashValid 332,
  getBlockHeight 335), then rpc 82 to 98 ms: the reads queue inside the helper for an upstream turn.
That time is the helper's, which a kept-alive upstream sized for a buy's reads would remove; it is its own card.

What is left to 2 s for Filled, all on devnet: devnet's own landing (about 1.4 to 2 s from send to confirmed in every
run), the helper's time above (per read, 250 to 400 ms over a warm upstream's 82 to 98), this Mac's round trip to the
box (about 230 ms a read), and the read-back's pace. Final in run 2 waited for api.devnet's 429s after the page's next
proof pass, which is its own card (signpage-passes-yield-to-a-trade).
