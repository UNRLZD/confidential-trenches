CARD pool-deposits / live: PASS
Money path: yes
Tx: solana-devnet TTZGXUZCyXeDHBsBbfP5HTLzKCkRbbLXsRqg5MSVKtCWBofmprgKpT4vQEjgfkpcyVPfZubKAvLpsHRAL9qt2fK
Tx: solana-devnet 4CGASPeY2rNou4xhwjSu1PRUQdom7pgAJeBkb1FQ958znkh9zgzbLyFjSgvS1anr54vYHghW1jtuoX4jfMY6EnzQ

The run (slice 2): packages/signpage/scripts/pool-deposit-devnet.mjs on Solana devnet, 2026-11-07T03:21Z to 03:23Z, at commit 61fe4cd0. It put one pool.deposit of 0.01 SOL through runPoolDeposit (packages/signpage/src/pool-deposit.ts), whose deposit the kit now builds, prices and reads back (packages/kit/src/trade/solana/pool-deposit.ts: solanaPoolDepositTx, solanaPoolDepositCost, solanaPoolTreeSizes, solanaPoolPreMarkOf), into the devnet pool the testnet build pins, read on api.devnet.solana.com and OnFinality's devnet RPC. The addresses are in pool-deposits.run.json.
The funding (the first Tx): devnet wallet D sent the run's one-time wallet U 11473120 lamports, the need the run printed (the rung, the mark's rent, two page entries and the fee), at slot 519523163, err null on both RPCs; U 0 -> 11473120.
The deposit (the second Tx): at slot 519523241, paid and signed by U, err null on both RPCs; U 11473120 -> 0, so the kit's cost was exactly what the program took and no rent is stranded on U. No sweep was sent.
The note: nonce 33, value 10000000, its mark the program's with that value and nonce on both RPCs at finalized, label page 0 entry 32 and state page 0 entry 44 its leaves, stored UNSPENT only after both RPCs showed it. Its seed lived only in the run, so the 0.01 SOL stays in the pool as a test deposit.
The live check scripts/live-checks/pool-deposits.mjs reads the tx, the mark, both leaves and U's balance on two devnet operators (signpage-pool-notes's reads on this run); recorded in pool-deposits.answers.json, good PASS and bad (another precommitment) FAIL.

Slice 3 (the EVM same-chain deposit, release-77): no money moved; the Base Sepolia run is slice 4's. The live check adds SIGN_HOST's EVM facts: index.html pins the /app.js it serves, and that bundle carries U^evm's HKDF label, checkEvmDeposit's refusal, the note store's EVM send record and the rebuild gate's sentBlock. Recorded in pool-deposits.answers.json: good.evm, the release-77 build (PASS); bad.evm, SIGN_HOST's release-72 page read 2026-11-07T05:27Z (FAIL).
