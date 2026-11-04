CARD signpage-pool-flow / live: PASS
Money path: yes
Tx: solana-devnet 54J7ikkgQGBQBkpAjgePfqrzCCQ9NDNy44f5n814TCGrCZcyyQqGQmYF9xy4y6ecnUFMQ3TuqAyYK7NFvJfRmN6D
Tx: solana-devnet 4K48NMp5awMjg1789a6uS6JE9Xr3JUwECC2bZnPCUQnfRAQGDYm252CDcAuPDHPJudUoBwqrj9juokXRC8TneWJ3
Tx: solana-devnet 3GF6DdXNJJ1sK9NkHoVAPVPbC8RDk4toQsqvwWUmsoEt95EYzkN5kgFnPrE34q81ZXtykBHAdj7PnEaYe1deP9cv
Tx: solana-devnet 645d1ZJc7FYb8dEx7UXzj6mbzu2oesKGZ8VP7XoZTe5MpZpiKEKrZ28rm9g3MsKbjgxWRUqwmVYheWrZiytmHitP
Tx: solana-devnet 3Dx1vbfMw1rqaz35dbtHBtMVHspmWVRA91pLmscaQNa3h7ULjoNdYVhWjp8xFciTspJ3xBD1xj4VVCHv5CCFMfYC
Tx: solana-devnet 4YkacU63Ko4MiUiRUxwaPcAEMeBUorfyUmkXExgxkkF49BGu3dzYzVnUcDD2xn7WJPGJ683748nZP3bn8b3a7E5F
Tx: solana-devnet 5GmNBPPpYhp5ggqJLek6qECLXWghVDiL1ms8ALE21TxDxoAekbA9Pvj2bRHUeZhWv4obzYSyvL6iarJifDX6wgzW
Tx: solana-devnet 216w8h4DLzkqYzgETWdzVNkhP3pR6XVHPMs8JF7JioL8QmvZQE7w5aWxEuDzoiqfj93ZooyDuSLnMT1tVqy3mFvJ
Tx: solana-devnet 5t1BQ6xviYUBudkfD9j9EGKGkbDXJ9RvGJrC8Ch88FU5Hdh2QhJn6terSStCsxZoYeGg3SqQBURYTYQ7G8sS4JhK
Tx: solana-devnet 3wm9mH2s36r9kJeV7GecUHEsUkNASM4DR6cdUiKhBf1uq7MkxGFhCMSa5tns9HTGqrwMpVpemU5mB37cpzFtzYqx
Tx: solana-devnet 4aDumNmw65YCWCpepMGp9NoNRWRZPUPCu21LSyJA3G4zShduyt9CzJ6s5iwtqHQ3Dg6XSQjruFMmQs1Q6nJenZyX
Tx: solana-devnet 63fqkqcKM2jQq7aPitYXUzeUWnm7FTyCMHMUhHVSrXbDQeZwHxkXBFUvkEzE5JVkAaspXqDUYc8hRBGh3R4Zkera
Tx: solana-devnet 2MbB4Fq7KU1TiSkYA1GpPYAUTTyt68Jz2quLfvsp5xP72yawSYG1E9D3bs9mBHirYar8UTLQm786CyfgUD5VPNua
Tx: solana-devnet 3ZMVTe6R7zXPpE76MC6oJCSXBUZT2XYH6kyrXhDGt4stS5U8WyPPKnzHWsXrrdD2RWSMW919DEhTqLptiX7myG3w
Tx: solana-devnet 5YyxmCGwww7uqXVeGL9WrhmDGg1shqhdHURsZrVQuim6DERjBHPfG88MzVE4QxczS4Lzx1FVyLpU89tyWfmxewpQ
Tx: solana-devnet 3p8pyECkxcGkZYM8tehKUHBbYZvLNT2NAHSuazkKKP6yTtKVzMWx5gKw4wWpeo7peA5BHMTVh3JX4xPznCANY1cJ
Tx: solana-devnet 3MhuhtsQ9twN36JgGeN2x6ojSfbHSgL3HHxGDodGy55LEkhon4vd7ExjBffSXMjamXR2nPrZCBtByg8W8PAS4KkR
Tx: solana-devnet yxY67LWAHQtdasuVwJSv47ed3QWKTPSg1Tfm8ptmZFS5ir8uvoYKYEZDAGAbgA5e65ENi38sAbq6NFxjUR5AEfq

The run, on Solana devnet, 2026-11-04 09:29-09:57Z, in the order of the Tx lines above. Every funding came from wallet D (the CO's), each the exact amount the step printed.
1. The lookup table (packages/signpage/scripts/pool-table-devnet.mjs): the first Tx line funds its authority with the rent and the fee, 5003720 lamports; the second creates and fills it with 25 addresses: the pool, both trees' pages to entry 2,047, the token programs, wSOL, the pump fee program and the pump curve venue's program-wide accounts. It is DEVNET_TABLE in the testnet build, read back the same on both devnet RPCs at finalized.
Table: 4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy, filled for devnet coin AoU3FWPvuFo7WLtP186k6U2hLZ3e44PGeJdFQHVJnw6P.
Its authority T: 8YuJPtppEh6qw4DCceF9dV6W28NiMYqMbeFb7e3onCSq, a devnet key kept only in the Mac's Keychain, 0 after.
2. Run 1 (packages/signpage/scripts/pool-flow-devnet.mjs, its first version): the deposit landed (finalized, err null), but the harness took the kind's first answer ("sent") as the run's end and exited while the note was INCOMING, so the run's seed went with it: that 0.01 SOL stays in the pool as a test deposit nobody can spend. Fixed: the harness waits for each run's end (the seed's exclusive Web Lock, which every run holds shared) before it reads the notes.
3. Run 2: the deposit (note UNSPENT, leaf 3), one proof, the pool buy of 0.004 SOL through the helper's send (filled: the note SPENT, change 0 at leaf 4). Its seed ended with the run, so its W keeps the bought coin; the sell leg is run 4's.
4. Lost devnet SOL: the eighth Tx line funded a U whose run had already died (a non-JSON answer in its balance poll, before the poll retried every failed read); its seed is gone, so that U's 11473120 lamports stay where they are.
5. Run 3: the deposit landed (note UNSPENT, leaf 5); the pool buy answered "failed" before anything was sent (no transaction from the fee payer after 09:34), and the harness exited, so that 0.01 SOL is a second test deposit nobody can spend. The likely cause: OnFinality's public devnet endpoint answers a throttle both as HTTP 429 and as HTTP 200 with JSON-RPC error -32029; run 3's harness retried only the first, so a -32029 reached a page read, which does not retry, and the buy answered failed.
6. Run 4, through the page's own pool kinds (poolKinds over testnetPool, as main.ts wires the testnet build), with every transport failure retried and logged:
   - pool.deposit of 0.01 SOL: its note UNSPENT, leaf 6;
   - the proof queue's pass: one proof (snarkjs fullProve in the process on the pinned withdraw files, 4.5 s);
   - pool.buy of 0.004 SOL of the coin, sent through the helper's POST /v1/pool/solana/send, paid by the helper's devnet fee payer, loading the table: filled, the note SPENT, change 0 at leaf 7;
   - pool.sell of all W held (12978802.596837 of the coin), signed and paid by W alone: the sale and the deposit of its proceeds back into the pool in one transaction, filled, the return note UNSPENT with 3500796 lamports at leaf 8.
Run 4's W: 3qQvaWZeSQPXXBpr3fjrTPnmRu5Ft5hFTLr55AooLjNN, holding 767277 lamports after the sell (an empty account's rent and what the sale gave over min out). The fee payer: 9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb.
7. Run 5, 10:40-10:42Z, the max-spend buy then sell (the review of signpage-pool-sell 4b6223a: a W left at 0 or short of its sell's fee could never sell): the last four Tx lines fund U from D, make the deposit (note UNSPENT, leaf 9), the pool buy at the most the proof could spend on the coin's own venue (5184720 lamports, the harness's spend "max": the kit's solanaPoolBuyMaxSpend at the helper's relay fee of 1300000, tip 0), filled with change 0 at leaf 10, and the sell of all W held, filled, the return note UNSPENT with 3436878 lamports at leaf 11.
Run 5's W: 6qV5goNN5mbRrVcLYuKjbsE9duNhxh9M4NWLsnGS7RWs, holding exactly 655240 lamports after the buy (the sell's fee and rent(0), the kit's solanaPoolSellNeed on pump's curve) and 801941 after the sell, the same on both devnet RPCs at finalized.
Each run's seed lived only in its run (16 random bytes, never printed or kept).
This live check reads, on https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public at finalized: the table (the ALT program's, the same bytes, active, holding the pool and both first pages); run 4's deposit, pool buy and sell succeeded (the buy paid by the pin's fee payer, loading the pin's table, calling pump.fun; the sell signed and paid by the buy's W alone, calling pump.fun and the pool); and the helper's GET /v1/pool/fee naming the pin's program and fee payer.
