CARD sol-buy-rent-back / live: PASS
Money path: yes
Tx: solana-devnet 2CpJgUJB4mjQ4FjXNvRTzgh8d7PHQyAgeBDZ4yAhBRpegrCeMyRLUSbR3ZDrcbyvk1XNndaSojfjhvwixPy8nn6W
Tx: solana-devnet f4PjQeqnMrWbjdd8C2gFdRABGDsQNCMJwRZoLqMNMssRKxGrs2Ytv4UWxikvp6j9bCgvGz5VSgfsD9AGnhcfiLV
Tx: solana-devnet 3z4ZXmKCrkR61vYrvjDrUmKgQQDVCe23AnZR2jLtnHFBM9tGSqC7H1qMDBA65j6negcfL2eHEP6KjEcWpnvb6KMv
Tx: solana-devnet 5No8hmNR3kbVZ8U9bEKEF9NnawLPUK3up6Lxbg4Hozr7RJHW64ggHSAzfS5E46fnJMjg9pqMeqjKxqhtqSguLZfS
Tx: solana-devnet 5GjxaQmuYmo5SDXSpVSZJ4oq7q56Q7i1AQuzNvwreHdUnopGCXydnPUATr3iQnbc4WjWaBDY8VnUqE9ybts5LzN4
Tx: solana-devnet 2S9LJg4MxaRAxcqiwJXwTBiJF6WyiRBHgzevoqyBTNLJ5TwWJkhP1P4mMvNwdK1FieTrc1H9FWF5C5TSAPqTJV92

One run of packages/signpage/scripts/pool-flow-devnet.mjs at main 7936e80d, on Solana devnet, 2026-11-06 02:16Z to
02:18Z, with the lookup table DEVNET_TABLE pins (4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy), the devnet pump curve
coin AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P and spend "max". The page read on its own devnet pair only:
api.devnet.solana.com and the helper's /v1/rpc/solana-devnet. Neither answered HTTP 429 in the run, and no kind was
tapped twice. The Tx lines above are in order:
1. The funding of U from our devnet wallet D, exactly the 11473120 lamports the run printed. U read 0, with no
   history, before it.
2. pool.deposit of 0.01 SOL. Its note is UNSPENT at leaf 41, and U is at 0.
3. pool.buy of 0.004346520 SOL, the max spend at relay fee 1300000, sent through the helper's send. The deposit note
   is SPENT, its change of 0 is at leaf 42, and W keeps 1493440 lamports, the sell's need.
4. pool.sell of all W holds (13374509.718502 of the coin). Its return note of 3482099 lamports is UNSPENT at leaf 43.
5. The rent back's first teardown frame: W's token account closed, its 1513840 lamports back to W.
6. The rent back's second teardown frame: W's pump volume account closed, its 1346200 lamports back to W.

The sweep was skipped at the floor: W's 3627456 lamports would make a note of 2154336, under the 2600000 the smallest
withdraw spends, so W keeps them (the run's line: "rent_back floor: W's 3627456 would make a note of 2154336, under
2600000: kept on W"). The run's seed is kept outside the repo, so W stays spendable.

The end state at finalized, read on both devnet RPCs (api.devnet.solana.com at slot 519146573, the helper's
/v1/rpc/solana-devnet at slot 519146591), the same on both:
- W HUup7gCcSuuM2Q19cw3fmpYFaBxewBQZRRJb2FnVYCCs: 3627456 lamports, owned by the system program.
- W's token account 2v3MwCivEUiJALwmaBJ1cUDKkudhNxLkHJxU8eBJp9E2: null.
- W's pump volume account FGRLwxG61FvxiQ49n15L4gSuDxjrQtjLDvcbvfEpeQH5: null.
- W's pump AMM volume account BWYBZVJ79csRmhzGFBrhUcWRwoYpA7ya7P5MwXQCeJ7L: null.
- U 9tvSFwwtj2e9FyEca6UGxDba9N9J6WQdcdh1odSWvgou: null.
Each of the six read back on both RPCs at finalized with err null, at slots 519146144, 519146209, 519146317,
519146352, 519146369 and 519146370.
