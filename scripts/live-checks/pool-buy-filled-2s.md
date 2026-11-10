CARD pool-buy-filled-2s / live: PASS
Money path: yes
Tx: solana-devnet 5wf2qVKuxLyZAv28fnrkCdjs1dC2qPCB5b8ugLNANBkPCxaMVC7UXAfckn5wvMPZnU96vFepfbLhaYt44tKHYck3
Tx: solana-devnet 3W1bFWespoHEm1x417eHKxqq5Af4tW3iAFRAqhRh9iNLXT5SeFYRjgHVymtHnzNGiX1zwnmKwHFbZEVYm5NnScUi
Tx: solana-devnet 2xmpn3GnBLT44Pr2UVwyf4KpjEjWMz4uSTuPu3dqmNViQ5hFvC1KJuSq7VjkZfy4GK4ybWVUAScgY38pVwnN9oBM
Tx: solana-devnet 5E4yJ2TFLZpNCkgD1iVqcpjhAz1XMwznvyYzz2mypSpNHrQaWePBchD6snHxYAgpHvpHT2nFLVb5LbRVTBqvc6PL
Tx: solana-devnet 4hFd2F1rzUkNNGnANC84JFC3kwHv1R4UaDRgujdSATBw5sBSmekyHb33jPDMgXx3ir5xdmZzvPSxwrVyKhJCVhMo
Tx: solana-devnet rvcg1Q336xDzYM126dhpSwqg2jbFVUZVLHmK4YgbyR6d2T8A8BJaq11ki9HjfYi6qHpwMF25AZJRR8t3gyAP4yj
Tx: solana-devnet 1vvYe2ZsKzNKczLunWaUFjbchptNk3HXbuajejXZ819WMiVytgbpxkyqzhfMUtVP14MxeiakwAThhV4DMMdZv8w
Tx: solana-devnet 61px3LbZ8pXT42u4oTdDD3hqKK6yydCcMjg8fos74P9Ehygs1sEmta1MaF5bd9LftooJKY7y71ir7sr8ZrF7q4k3
Tx: solana-devnet 2mpTCNtoX6Z2zHGqTn4Ubm7qqpPTURx8TrWPYX2moymxJBCiofyEsaE9my8wfuhKe79z89aE5HTaKmJGS6PUyZMM
Tx: solana-devnet 4VKVKE1CkqULAxMgofMPigFK6vJ4vbjT3TXzitXX4VzSbGZgSQA6zkdB9j8mtS1nC1aJqkmgaG543enPC2ahZuyi
Tx: solana-devnet 42qiFDxqgEBzku1HfcVA2MNWMPHGZaH8ZHooAPMaSjZhNf6DeE6JvmPJiLH9MzovRhmRdzWz4pStXGX6rZX4q57p
Tx: solana-devnet 3eEdH7Wevzydqj4cgKajR5pwUsCJK4YY9tWkSQYBRzdymdSJi1jxfbjTeckokEu2TSsqK2Jt3j7PxY8MijhvU73v

The live check reads PASS on this card's own testnet build (scripts/ci/bundle-checks.mjs runs it on the PR's build).
On SIGN_HOST, read 10 Nov 22:34Z before this card's deploy, it reads FAIL:
`BAD the bundle's read-back has no pace of a slot (400 ms) that only a throttle or a thrown settle doubles, by a
back-off capped at its own most and the Retry-After's, and finite`. The served
bundle is main 2736dbef's, so that is the before. After the sign deploy it must read PASS there too.

The run took place on Solana devnet on 10 Nov 2026, 22:30:19-22:31:58Z, and exited 0. It used
packages/signpage/scripts/pool-flow-devnet.mjs on this card's head a7109a84, with the script's route facts timed. The
page's own pool kinds ran against the deployed helper. Its two devnet RPCs were api.devnet.solana.com and the helper's
/v1/rpc/solana-devnet. The command:
`node packages/signpage/scripts/pool-flow-devnet.mjs pinned AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P max <out>`.
The Tx lines above, in order:
1. Our devnet wallet D funded U (2BiGBrB8jJpz3jtSQhMbvtqQbFDJhMGVvcCqSmsY3PZx), the deposit's source, with the exact
   11473120 lamports the run printed.
2. pool.deposit of 0.01 SOL: answered sent, then progress filled. Its note is UNSPENT at leaf 88.
3. pool.buy of 0.004346520 SOL (the most the ready proof spends on the coin's pump curve, relay fee 1300000), sent
   through the helper's POST /v1/pool/solana/send: answered sent with its own signature, then its route's amount out,
   then progress filled. The deposit note is SPENT and its change 0 is UNSPENT at leaf 89.
4. pool.sell of all W bought (11609263.306432 of the coin): answered sent, then progress filled. Its return note of
   3482099 is UNSPENT at leaf 90.
5. and 6. The rent back's teardown. Afterwards W's token account and both volume accounts read null. W keeps 3627456
   lamports, because a sweep would make a note of 2154336, which is under the 2600000 floor.
Each of the twelve Tx lines reads back as succeeded on api.devnet.solana.com and on solana-devnet.api.onfinality.io/public
(scripts/ci/money-gate.mjs 2736dbef HEAD: PASS, 24 reads).
Coin AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P, pool 92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr, pump-curve table
C2vLuah7VtGDTVnFkBpY7DkNf135Wwu6Uv57qCXPb9qJ (the testnet build's pin).

The buy's split, in ms from the tap. This run's numbers are the run's buyTimeline (performance.now() in the process).
Runs 2 and 4 are tonight's three-buy app runs on main (card app-a2-e2e), where Filled and Final were one event.

| step | run 2 (main) | run 4 (main) | this run |
|---|---|---|---|
| tap to send | 3490 | 3630 | 2404 |
| send to sent | 2100 | 2120 | 1499 |
| sent to Filled | 9330 | 2100 | 0 (Filled is the route's out, in the same read as sent) |
| Filled to Final | 0 | 0 | 2265 |
| tap to Filled | 14920 | 7850 | 3903 |
| tap to Final | 14920 | 7850 | 6168 |

This run's tap to send, in detail:
- 0 to 1070: round 1 (the rent, the pinned table, the pool account, the reference). api.devnet answered all of its
  reads by 199. The helper's route answered its seven reads one after another, at 358, 514, 782, 849, 869, 1055 and
  1065.
- 1071 to 1430: round 2 (both root pages, the venue, getLatestBlockhash).
- 1136 to 1710: round 3 (isBlockhashValid 383, getBlockHeight 574 on the helper's route).
- 1721 to 2404: the queue's take reads chain time (getSlot, then getBlockTime, on each RPC; the wallet's
  ../../wallet/src/pool/solana.ts). This is outside pool-buy.ts.
- 2404 to 2815: the helper's POST (411).
- 2815: read-back round 1 (not at confirmed yet). After the 400 ms pace, round 2 at 3560 read it on both, at 3902.
- 3903: route tx, route out (the app's Filled) and the answer sent.
- 3903 to 5819: the settle's gate. getSlot at finalized on both reached the transaction's slot on its first read. The
  settle then made 2 getProgramAccounts, 12 getMultipleAccounts on api.devnet and 3 on the helper's route. The pages
  followed, then whose spend it is.
- 6168: progress filled (the app's Final).

Every RPC call the page made for the buy, tap to Final (method: api.devnet.solana.com / the helper's route):
getAccountInfo 7 / 7, getMultipleAccounts 14 / 6, getLatestBlockhash 1 / 0, isBlockhashValid 0 / 1,
getBlockHeight 0 / 1, getSlot 3 / 3, getBlockTime 1 / 1, getTransaction 3 / 3, getProgramAccounts 2 / 0.
The buy's reads met no 429. Three reads of the sell step after it did, at 22:31:28.72Z (getTokenAccountsByOwner twice and
getBalance, on api.devnet), which is the page-wide polling another card owns.
The run's seed is kept at ~/.ct-devnet-runs/run-2026-11-10T22-30-19-370Z.seed (0600, outside the repo).

Run 2 took place on Solana devnet on 10 Nov 2026, 23:24-23:26:06Z, and exited 0. It ran the same command on this card's
head 418af7d5 (the review's fixes in), on the same two RPCs. The second six Tx lines above, in order:
1. The same funder as run 1 (3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx) funded U
   (Be2c8yCt3TzpvHxSS9xXSpx7AUDS9bCKLZkG442hJUTs) with 11473120 lamports.
2. pool.deposit of 0.01 SOL. Its note is SPENT by the buy (leaf 91).
3. pool.buy of 0.004346520 SOL on the pump curve: answered sent, then its route's amount out, then progress filled.
4. pool.sell of all W (FS8NetwLLWcBniMXdFMb3WmyyYwGsUoCVezqz36wtEZB) bought: answered sent, then filled. Its return
   note of 3482099 is UNSPENT at leaf 93.
5. and 6. The rent back's teardown. Afterwards W's token account and both volume accounts read null, and W keeps
   3627456 (under the floor, as in run 1).

The buy's split on run 2, in ms from the tap (the run's buyTimeline):

| step | run 2 (main) | run 4 (main) | run 1 (a7109a84) | run 2 (418af7d5) |
|---|---|---|---|---|
| tap to send | 3490 | 3630 | 2404 | 2100 |
| send to sent | 2100 | 2120 | 1499 | 2051 |
| sent to Filled | 9330 | 2100 | 0 | 0 |
| Filled to Final | 0 | 0 | 2265 | 2227 |
| tap to Filled | 14920 | 7850 | 3903 | 4151 |
| tap to Final | 14920 | 7850 | 6168 | 6378 |

Run 2's steps:
- Round 1 (rent, table, pool account, reference) ended at 917. The helper's route answered its reads one after
  another again, at 313, 483, 701, 719, 882, 889 and 909.
- Round 2 had the slot read answered at 995. Its last read, a page on the helper's route, ended at 1225, 230 ms after
  the slot. That is under POOL_BUY_SLOT_STALE_MS, so the slot was read once (one getLatestBlockhash).
- Round 3 (isBlockhashValid and getBlockHeight on the helper's route) ended at 1476.
- The take's chain-time read ran from 1488 to 2098.
- Send at 2100: the helper's POST took 363.
- The read-back read at 2463 and at 3162 (the transaction not at confirmed on both yet), then at 3858. It was read on
  both by 4150.
- Filled (the route's out) at 4151.
- The finality gate made 1 getSlot a provider: both RPCs' finalized slot had reached the transaction's slot. Then the
  settle made 2 getProgramAccounts, 12 getMultipleAccounts on api.devnet and 3 on the helper's route, then whose
  spend it is.
- Final at 6378.
Send to sent is 552 ms longer than run 1's: one more read-back round at the 400 ms pace (devnet confirmed later).

Every RPC call the page made for run 2's buy, tap to Final (method: api.devnet.solana.com / the helper's route):
getAccountInfo 7 / 7, getMultipleAccounts 14 / 6, getLatestBlockhash 1 / 0, isBlockhashValid 0 / 1,
getBlockHeight 0 / 1, getSlot 3 / 3, getBlockTime 1 / 1, getTransaction 4 / 4, getProgramAccounts 2 / 0. getSlot is
the take's chain-time read, the finality gate's one read and whose-spend's read, once each. The buy's reads met no 429.
The run's seed is kept at ~/.ct-devnet-runs/run-2026-11-10T23-23-36-048Z.seed (0600, outside the repo).

