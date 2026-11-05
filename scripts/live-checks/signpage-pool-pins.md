CARD signpage-pool-pins / devnet run: PASS
Money path: yes
Tx: solana-devnet 2J3ShzTeDiuKrQKzyKQ2piF6iUVFF8fw12uwSBJqNNtVE7FuhkTncXqUuQVpMTdLXTJ3FMnWK4nwjMFUZ5vGkPYZ
Tx: solana-devnet b72jFbgKkivW1GbNcHSPi51mdgrtR9JniCT6VYhJZEJqtfCysJWQ5aiUT5fgWTZ3qjywUGX955cJYSApdP6cpnv

The run: packages/signpage/scripts/pool-pins-devnet.mjs on Solana devnet, 2026-11-05 16:43-16:49Z, on main's devnet pair (https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public). Its record is signpage-pool-pins.devnet.json.
1. The first Tx line funds U FwoQnrT7EDG8Njnv9ifeyYmBRhBU5Aoebhk8zaJ9dNcY with the 21473120 lamports the run printed (the 0.02 SOL rung, the mark's rent, two page entries and the fee at the devnet Rent of 5080 per byte, factor 1), from our devnet wallet D.
2. The second is the page's pool.deposit of 0.02 SOL into the testnet build's pinned pool (program 5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ, pool 2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr), signed and paid by U, finalized at slot 519002956 with no error on both RPCs; U holds 0 after it. The note: UNSPENT, 20000000 lamports.
3. The proof queue's pass proved the note (snarkjs fullProve in the process on the pinned withdraw files, 26 to 38 s single-threaded), then main.ts's state read (src/pools.ts withPools over PAGE_POOLS, the queue's ready proofs, src/pool-price.ts and the Rent read) gave, at 16:49:26Z:
   state.pools [{"chain":"solana","asset":"SOL","balance":"0.02","ready":"0.02","tap_max":"0.01038488","price":{"price":"9052223918","expo":-8,"published_s":1793897342,"read_ms":1793897352282}}]
   ready above 0, the page's own Pyth SOL/USD read on the devnet pair, and tap_max above 0: the trade box's Buy turns on for it.
4. Seen on the way: one state read at 16:48:56Z gave ready "0" while the queue remade the proof for the new epoch (the note's HELD attempt written before the new proof entered the ready list); the next read gave "0.02" again. The run's seed is kept at ~/.ct-devnet-runs/run-2026-11-05T16-43-35-208Z.seed (its path only); the note stays in the pool, spendable from it.
