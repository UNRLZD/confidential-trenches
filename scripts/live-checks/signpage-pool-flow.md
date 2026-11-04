CARD signpage-pool-flow / live: PASS
Money path: yes
Tx: solana-devnet 4K48NMp5awMjg1789a6uS6JE9Xr3JUwECC2bZnPCUQnfRAQGDYm252CDcAuPDHPJudUoBwqrj9juokXRC8TneWJ3
Tx: solana-devnet 3GF6DdXNJJ1sK9NkHoVAPVPbC8RDk4toQsqvwWUmsoEt95EYzkN5kgFnPrE34q81ZXtykBHAdj7PnEaYe1deP9cv
Tx: solana-devnet 645d1ZJc7FYb8dEx7UXzj6mbzu2oesKGZ8VP7XoZTe5MpZpiKEKrZ28rm9g3MsKbjgxWRUqwmVYheWrZiytmHitP
Tx: solana-devnet 3Dx1vbfMw1rqaz35dbtHBtMVHspmWVRA91pLmscaQNa3h7ULjoNdYVhWjp8xFciTspJ3xBD1xj4VVCHv5CCFMfYC
Tx: solana-devnet 4YkacU63Ko4MiUiRUxwaPcAEMeBUorfyUmkXExgxkkF49BGu3dzYzVnUcDD2xn7WJPGJ683748nZP3bn8b3a7E5F
Tx: solana-devnet 5GmNBPPpYhp5ggqJLek6qECLXWghVDiL1ms8ALE21TxDxoAekbA9Pvj2bRHUeZhWv4obzYSyvL6iarJifDX6wgzW

The run, on Solana devnet, 2026-11-04 09:29-09:35Z, in the order of the Tx lines above:
1. The lookup table (packages/signpage/scripts/pool-table-devnet.mjs): one tx creates and fills 4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy with 25 addresses: the pool, both trees' pages to entry 2,047, the token programs, wSOL, the pump fee program and the pump curve venue's program-wide accounts, read for devnet coin AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P. Its authority T (8YuJPtppEh6qw4DCceF9dV6W28NiMYqMbeFb7e3onCSq, a devnet key kept only in the Mac's Keychain) was funded from wallet D with the exact rent and fee (5003720 lamports) and holds 0 after. The table was read back the same on both devnet RPCs at finalized. It is DEVNET_TABLE in the testnet build.
2. Run 1 (packages/signpage/scripts/pool-flow-devnet.mjs, its first version): U AM5RKoH6Xzzyg9ezs2Z1KaeNWVMDWzcnVJqHXziHPgVP funded from D (3GF6…), and its deposit 645d1ZJc… landed (finalized, err null). The harness took the kind's first answer ("sent") as the run's end and exited while the note was INCOMING, so the run's seed went with it. That 0.01 SOL stays in the pool as a test deposit nobody can spend. The harness now waits for each run's end (the seed's exclusive Web Lock, which every run holds shared) before it reads the notes.
3. Run 2: U 78oa4reT4HpdoN5vmF2qtt4RjgzcpqHntJLrpzJQwXzo funded from D with exactly 11473120 lamports (3Dx1…). Then, through the page's own pool kinds (poolKinds over testnetPool, as main.ts wires the testnet build):
   - pool.deposit of 0.01 SOL (4Ykac…): its note UNSPENT, leaf 3.
   - The proof queue's pass, which made one proof (snarkjs fullProve in the process on the pinned withdraw files, 4.6 s).
   - pool.buy of 0.004 SOL of AoU3FW… (5GmNB…): sent through the helper's POST /v1/pool/solana/send, paid by the helper's devnet fee payer 9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb, loading the table. The page read it back and answered filled: the note SPENT, its change note (0) UNSPENT, leaf 4. Fresh wallet W CEcAE5zHxiFfvLQdsfhmbt1vteqULcD1QKaE8jptDvWE holds 13312725091282 units of the coin and 1839960 lamports after it. The sell leg (card signpage-pool-sell) sells them back into the pool.
The run's seeds lived only in their runs (16 random bytes each, never printed or kept).
This live check reads, on https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public at finalized: the table (the ALT program's, the same bytes, active, holding the pool and both first pages); the deposit 4Ykac… and the buy 5GmNB… succeeded (the buy paid by the pin's fee payer, loading the pin's table, calling pump.fun); and the helper's GET /v1/pool/fee naming the pin's program and fee payer.
