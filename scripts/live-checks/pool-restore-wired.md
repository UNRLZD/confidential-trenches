CARD pool-restore-wired / live: PASS
Money path: yes
Tx: solana-devnet 2riHYB15aZBJfY7hA9NDPKPjQNwzZgRSjXvjNmWk3R4yVACfyMidz9rMfTnXN3EQUpjjC3k88EeXhnRgKyd3K2VW
Tx: solana-devnet 5kxqLebHVzimZaaLGXoTBFCbFsq8QGh46h3TnvwhxQSY2cV4RoqS2HwKeTkoBTBWvBRgZCrnzPG9mCcveAdAcybj
Tx: solana-devnet 21gB23hVW7YbCFJRNLJ5HWkhAtH5qR7FtvoqZuqiouNmorsWt8vHtwbRTQgSyXG6NMPupAWzNnZwaL11zpEmjfm9
Tx: solana-devnet 5wx8gEBh21CjpjKDm2KWdeqMTmwanZYTye7AQxoBQZEz9WaqZtX4T72b4Zm1ptv2SsGh27dHHSPhTFzYRKSLMCTb
Tx: solana-devnet 2krnbQqKdGjZ5Eto1gUHTsp9VBjNYtTUxitLHujMvK4E6XGorfay5SSgLdmMeNmHZSJ3f5fEme4VB7w8k7JPAstJ
Tx: solana-devnet 4WULVWEZdALXrfPMbCCSyzd5myGFaNVJiwoPGrpY2z2xWkqBS41QN8avkQ3gAzgoGHneEPkwbHQzGsPBVVtEQrDY

Two browsers, one set of 12 words, on Solana devnet.

Browser A is the run of packages/signpage/scripts/pool-flow-devnet.mjs on 6 Nov 2026, 01:46:33-01:47:51Z
(pool-buy-send-fast.md): the page's own pool kinds deposited 0.01 SOL, bought at "max" and sold all W held, then the
rent back tore W's token account down. The Tx lines above are its six transactions, in that order, each finalized on
api.devnet.solana.com and the helper's /v1/rpc/solana-devnet. Its store ended with the deposit note SPENT at leaf 38,
change 0 UNSPENT at leaf 39 (value 0: the buy spent the whole chunk), the return note of 3482099 UNSPENT at leaf 40,
and W holding 3627456 lamports and no token account. The run kept its seed outside the repo
(~/.ct-devnet-runs/run-2026-11-06T01-46-33-530Z.seed, 0600).

Browser B is packages/signpage/scripts/pool-restore-devnet.mjs at 6 Nov 04:08:59-04:09:41Z, on this card's code at 01a067ee (the review fold): a
new wallet store (fake-indexeddb, empty), the same words signed in, and the page's restore run as main.ts runs it after
a words sign-in (src/pool-restore.ts auto() on pagePools() of the testnet build: the devnet pool
5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ on the page's two devnet RPCs; no EVM pool is pinned). The store held 0
notes; the restore ended done in 39989 ms (83538 ms on the first run at 03:57Z, before the fold, with the same result), its op record "done". It wrote the same three notes, states, values and leaf
indices as A's store: deposit SPENT 10000000 at 38, change UNSPENT 0 at 39, return UNSPENT 3482099 at 40. The SPENT
note's W, derived from the words, is co4Njaq8gY25mqFMtGfGFkRVToSzAncpMEavxJfQAfc, which is the second key of A's buy
transaction (21gB23h..., getTransaction at finalized on both RPCs: slot 519138620, err null). W reads 3627456 lamports
and 0 token accounts at finalized on both api.devnet.solana.com (slot 519174244) and the helper's /v1/rpc/solana-devnet
(slot 519174247): A's balance. The record is pool-restore-wired.run.json (addresses, values and leaf indices only).

Not run: Base Sepolia. EVM_POOLS pins no EVM pool on any network (packages/wallet/src/pool/evm.ts), so the page
answers no EVM pool kind and its restore reads no EVM pool; the EVM restore code it calls is evmRestoreNotes, run live
on Base Sepolia and Robinhood testnet in pool-evm-testnet-run.md.
