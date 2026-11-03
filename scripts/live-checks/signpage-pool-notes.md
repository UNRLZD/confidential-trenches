CARD signpage-pool-notes / live: PASS
Money path: yes
Tx: solana-devnet 26QENvER7RhnE39Kvoy6MRUuWwHR88GZF1JQ8GEkkrw8YpUSNi2xKN3RhrbNK4ZeijeHVR6oKYqsRVBDX2LLZdam

The run: packages/signpage/scripts/pool-deposit-devnet.mjs on Solana devnet, 2026-11-03T22:24:11Z. It put one pool.deposit of 0.01 SOL through runPoolDeposit (packages/signpage/src/pool-deposit.ts) into the pool of program 5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ, the testnet build's pin, read on https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public.
The one-time wallet U GLUzYu1rkJXbZa9gRSj85v8a6YUGpcsa1x1Jf9HnSTUN was funded with 11473120 lamports, the need it printed: the rung, the mark's rent, two page entries and the fee. The deposit spent all of it, so U holds 0 and no sweep was sent.
The note: nonce 2, precommitment 28fb4aaedb8bc5a86143b4404719b308e41c297bcccd058edd831d990c064b48, state leaf 1, stored UNSPENT only after its own send read back finalized with no error on both RPCs, the mark held its value and both trees held its leaves. Its seed lived only in the run, so the 0.01 SOL stays in the pool as a test deposit.
The live check scripts/live-checks/signpage-pool-notes.mjs reads the tx, the mark, both leaves and U's balance on both RPCs; it works the label out itself from the pool's scope and the mark's nonce, and holds the state leaf to the note's commitment 0446b3c85886af8a2b4ae432180fa6383587a2444f4df91581e2341426a1df3b.
