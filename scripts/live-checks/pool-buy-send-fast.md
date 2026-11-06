CARD pool-buy-send-fast / devnet after-run: PASS
Money path: yes
Tx: solana-devnet 2riHYB15aZBJfY7hA9NDPKPjQNwzZgRSjXvjNmWk3R4yVACfyMidz9rMfTnXN3EQUpjjC3k88EeXhnRgKyd3K2VW
Tx: solana-devnet 5kxqLebHVzimZaaLGXoTBFCbFsq8QGh46h3TnvwhxQSY2cV4RoqS2HwKeTkoBTBWvBRgZCrnzPG9mCcveAdAcybj
Tx: solana-devnet 21gB23hVW7YbCFJRNLJ5HWkhAtH5qR7FtvoqZuqiouNmorsWt8vHtwbRTQgSyXG6NMPupAWzNnZwaL11zpEmjfm9
Tx: solana-devnet 5wx8gEBh21CjpjKDm2KWdeqMTmwanZYTye7AQxoBQZEz9WaqZtX4T72b4Zm1ptv2SsGh27dHHSPhTFzYRKSLMCTb
Tx: solana-devnet 2krnbQqKdGjZ5Eto1gUHTsp9VBjNYtTUxitLHujMvK4E6XGorfay5SSgLdmMeNmHZSJ3f5fEme4VB7w8k7JPAstJ
Tx: solana-devnet 4WULVWEZdALXrfPMbCCSyzd5myGFaNVJiwoPGrpY2z2xWkqBS41QN8avkQ3gAzgoGHneEPkwbHQzGsPBVVtEQrDY

The run took place on Solana devnet on 6 Nov 2026, 01:46:33-01:47:51Z, and exited 0. It used
packages/signpage/scripts/pool-flow-devnet.mjs on main 40342057, the merge of this card's fold that SIGN_HOST serves as
release-51. The page's own pool kinds ran against the deployed helper (api.confidential.unrealized.trade). Its two
devnet RPCs were api.devnet.solana.com and the helper's /v1/rpc/solana-devnet. The command:
`node packages/signpage/scripts/pool-flow-devnet.mjs 4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P max <out>`.
The Tx lines above, in order:
1. Our devnet wallet D funded U (6s9QewZ5JctFnHehVjE1vLHdgttSyovMdkFHtkDs42Tv), the deposit's source, with the exact
   11473120 lamports the run printed. It was sent once, after a read of U as empty.
2. pool.deposit of 0.01 SOL: answered sent, then progress filled. Its note is UNSPENT at leaf 38.
3. pool.buy at "max" on the coin's pump curve, sent through the helper's POST /v1/pool/solana/send: answered sent with
   its own signature, then progress filled. The deposit note is SPENT and its change 0 is UNSPENT at leaf 39.
4. pool.sell of all W bought (13374509.759834 of the coin): answered sent, then progress filled. Its return note of
   3482099 is UNSPENT at leaf 40.
5. and 6. The rent back's teardown (card sol-buy-rent-back). Afterwards W's token account and both volume accounts read
   null. W keeps 3627456 lamports, because a sweep would make a note of 2154336, which is under the 2600000 floor.
Each of the six read back finalized on both api.devnet.solana.com and the helper's /v1/rpc/solana-devnet, at slots
519138524, 519138556, 519138620, 519138649, 519138663 and 519138664. Coin AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P,
pool 2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr, lookup table 4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy.

The buy's timing, in ms from the tap (the run's buyTimeline, performance.now() in the process):
- 0 to 3245: the checks' reads on both RPCs, in seven rounds. Each round waits for the slower of the two: the helper's
  route at about 260 ms (the before run's onfinality held 11.2 s here), devnet's own at about 50 ms.
- 3245: the helper's POST /v1/pool/solana/send (its simulate and its send, which this log does not split), HTTP 200 at
  3578 (333 ms).
- 3578: read-back round 1 on both RPCs (260 and 268 ms), which did not yet read the transaction. Round 2 at 4846 (55 and
  261 ms) read it on both.
- 5108: the kind's answer, sent with its signature. Tap to sent is 5108 ms, under the kit client's 10 s.
- 5111: the restore's getProgramAccounts on both RPCs, the helper's in the exact shape it now forwards (301 ms).
- 6231: progress filled. Tap to filled is 6231 ms.
Before this card (signpage-sent-read-back.md, 5 Nov 13:50:55Z), tap to sent was 19.88 s (the helper's answer alone at
18.13 s), past the client's 10 s, and tap to filled was 25.16 s.
The run's seed is kept at ~/.ct-devnet-runs/run-2026-11-06T01-46-33-530Z.seed (0600, outside the repo). The return
note stays spendable from it.
