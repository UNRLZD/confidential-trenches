CARD held-deposit-way-out / live: PASS
Money path: yes
Tx: near-testnet 9EhDqfwUH1ZmDmrSS2d2d7sHtoefquSaBBVaGmGJj4Rv holder.bf-usdc-20261101t022248.testnet
Tx: near-testnet 6fb2C7emjPC3zruNHm3maqTifGjQYwFWaazHKz9N6J5w holder.bf-usdc-20261101t022248.testnet
Tx: near-testnet Fs4sfMVW6pZ58DTsWtxeyPzuLWRVbzwqyi1uPMp4m5Ww holder.bf-usdc-20261101t022248.testnet
Tx: near-testnet KUuoGWjyNMQuUve1VdAUEcCgQwJVNZdsvjpFFQ2EaMv 0fddd0bfdaa562c5cc85461d6d8f33b344d054d48490c5dac1ffe17ad178dd22

The run: packages/wallet/scripts/held-way-out-testnet.ts on NEAR testnet, the team's test USDC bf-usdc-20261101t022248.testnet; the move is the wallet's own moveOutHeld (src/deposit/moveout.ts) on the release's testnet pair https://test.rpc.fastnear.com and https://near-testnet.drpc.org, from a held deposit op (why sender_struck) in a fake-indexeddb wallet store.
Accounts: H holder.bf-usdc-20261101t022248.testnet (funds U: the stand-in for the NEAR the user sends U from the typed account), U 0fddd0bfdaa562c5cc85461d6d8f33b344d054d48490c5dac1ffe17ad178dd22 (U_{1,0} of this run's seed), X 5f31d9bf4fd28aaea008ad8b93b1d81ab9499200bec6c4e4ae5a63d826faf56d (the typed account: an implicit id, never created, registration null before the move).
Runs: the drive ran twice on one state. Run 1 (01:52Z) made the first two Tx above (H creates U, then registers it and sends it the USDC) and was stopped in the move: its 2x gas margin let U's transaction be refused by both RPCs (InvalidTxError NotEnoughBalance, cost 27970497453181500000001 against U's 20000000000000000000000), nothing landed and U's key nonce did not move; moveout.ts now counts the pessimistic gas price (GAS_PRICE_MARGIN 12) and answers gas on that refusal. Run 2 (02:00Z) found U funded, skipped those steps and made the last two Tx.
Steps: H sends U 20000000000000000000000 yocto NEAR (creates U); H registers U on the token and sends it 2000000; the device reads U and X at one block on both RPCs, signs U's transaction [storage_deposit(X, registration_only) 1250000000000000000000 yocto, ft_transfer(X, 1999999) 1 yocto] at U's key nonce + 1, records it in the op, sends it to both RPCs and reads it FINAL on both, every receipt a success; the op ends held with why moved_out.
The device's answers in order: gas, moved; on gas it asked for 19070000000000000000001 yocto more NEAR in U, which H sent (the stand-in for the user's send from the typed account).
Resume: a second call (as a reload makes, with another account typed) answered moved, opened no seed and sent nothing (send_tx calls 2 before, 2 after).
Balances before: U 2000000, X 0. After, on both RPCs: [{"u":"1","x":"1999999"},{"u":"1","x":"1999999"}].
Times: first call to moved 25020 ms.
Every Tx above read back FINAL on both testnet RPCs by the wallet (U's) or by send_tx wait_until FINAL (H's); then node scripts/ci/money-gate.mjs on this file.
