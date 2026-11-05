CARD pool-ready-no-flicker / live: PASS
Money path: yes
Tx: solana-devnet 47RCctGzW8LGpFpZSmkaLxbW2DJA3rmw31T7qMXvCnLLZXhK8P9bu7JBEB8BVwiEQQ1Lj3CtoQbpDG2BAZmVxLqW
Tx: solana-devnet 39j97RAbtnbwD65X3zrccniYBeS8gPLxRwzbhiEFMQcxMeCFwPZZWUNfZYVXZLnBm7vobdqi7634ykXJJbhDiYLp

The run: packages/signpage/scripts/pool-ready-devnet.mjs on Solana devnet, 2026-11-05 18:12-18:17Z, on main's devnet pair (https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public). Its record is pool-ready-no-flicker.devnet.json.
1. The first Tx line funds the run's U (in the record) with the 21473120 lamports the run printed, from our devnet wallet D; finalized at slot 519024480 with no error.
2. The second is the page's pool.deposit of 0.02 SOL into the testnet build's pinned pool (SOL_POOLS.devnet), signed and paid by U, finalized at slot 519024568 with no error; U holds 0 after it. The note: UNSPENT, 20000000 lamports.
3. The proof queue proved the note (snarkjs fullProve in the process, about 4.8 s each), then the run read the page's state every 3 s, each read starting the queue's pass without waiting for it, as main.ts does, and taking the ready list with the notes through testnetPool's readyWith. From the first ready read at 18:13:19Z to 18:17:06Z: 74 reads over 5 epochs, the proof made again at 3 boundaries (18:14:18Z, 18:15:15Z, 18:16:15Z, each a new attempt), and every read gave ready "0.02" and tap_max "0.01038488". The note stayed HELD throughout.
4. For comparison the run also made the earlier read (the ready list copied before the notes are read) at each step: it gave "0.02" on all 74 reads this time, as the window it can fall into is short; the queue's tests (packages/wallet/test/pool-queue.test.ts) put a read into that window and show it reads "0" before the fix. The run's seed is kept at ~/.ct-devnet-runs/run-2026-11-05T18-12-05-555Z.seed (its path only); the note stays in the pool, spendable from it.
