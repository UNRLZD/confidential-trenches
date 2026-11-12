CARD evm-deposit-route-mainnet / live: PASS
Money path: yes
Tx: base-sepolia 0x50450dce96ca2bc3ba4afddc247e18027253929c489d80b58fce301f6452699a
Tx: base-sepolia 0x0f5423269ff343b687f17ccdd3d6425eb4440c1b5c0cbe3db4edfbfa81bd5fd5
Tx: robinhood-testnet 0x1dbb964541e90fec43e0c3895f078289f3faf29054ca0847e9044c5cc71c386b
Tx: robinhood-testnet 0x3fdd709bc661b53ea8d5a6a7d0dbfa1eda9f8fad0974c727f6d94bde8884600c

The follow's own deposit from U_X at the floor of a quote into U_X, on both test networks:
packages/signpage/scripts/pool-deposit-evm-testnet.mjs <base|robinhood> --fixed on commit 86c6be84, 2026-11-11 15:50-15:52Z,
on the testnet build's pin of each pool and its two RPCs (pool-testnet.ts TESTNET_RPCS). Each run, in the order of
its chain's lines above:
- the first ask named U and what U is short; readEvmPoolFloor (pool-deposit-address.ts) read the floor on both RPCs,
  equal to that short to the wei (base-sepolia 1026662240003696 wei, robinhood-testnet 1038455920000000 wei);
- U funded with exactly that floor from the team's test wallet E 0x49F2425b7F33f3a10912DE8add6839226cE663a2
  (scripts/devwallet/devwallet-evm.mjs send), read back succeeded on both RPCs (blocks 57452304, 151882287);
- the ask again with U as its fixed source ({s, i, u}, as depositFrom passes it): U's deposit of 0.001 ETH into the
  pinned pool (0xeb967dfc1b4ffb22942f833c76866ea85fc42266, 0xed9fac860e6bc5e932455232eedca8b71c44da4d), answered
  "sent", read back succeeded on both RPCs (blocks 57452344, 151882342) with the pool's Deposited naming the note's
  precommitment; the note INCOMING. U keeps 21449965003529 wei and 35084190000000 wei, the floor's gas headroom unspent.
The seeds lived only in the runs, so each 0.001 ETH stays in its pool as a test deposit. The bundle check
(evm-deposit-route-mainnet.mjs) reads SIGN_HOST after this card's sign deploy.

CARD evm-deposit-route-mainnet / live: PASS
Money path: yes
Tx: base-sepolia 0x0d659f958c32134d4fefae10fa937308b6832dd97ed88bdc76291f1a847caa9b
Tx: base-sepolia 0xe8eea93dcac86fae9e7ae10408657132cf27edf184d0061819e58d8ab5e75a38
Tx: base-sepolia 0x42e29db5cc73e1c96545cbea508f586b4c015b26cdef833ea11ee1c9c0b6c3e3
Tx: robinhood-testnet 0x01add8113cb2b452aef82feda5cc9e08a0d57525bdb2203ae8c62de0d7f2f0cc
Tx: robinhood-testnet 0xd55f87f57700c68403999fb317c3d780b41a56d0cbcb24cfc23c9da8d0d9841b
Tx: robinhood-testnet 0xf4295d191bed4113f2a264472cb54540305cce882dda8b4ab38215e56b871fd1

The review's run (card evm-deposit-route-mainnet review FIX): the page's own follow end to end, two rungs from one
payment, a reload while the first rung lands. packages/signpage/scripts/pool-deposit-evm-testnet.mjs <chain> --follow
3000000000000000 on commit f92f2b25, 2026-11-11 17:13-17:39Z. The driver is that script: followPoolQuote over
evmPoolFollowDeps on the testnet build's pin and pair (no wallet reader on testnet: U's balance on each of the pool's two
RPCs), uxNoteLanded on the store every round, and the deposit the fixed-source run from U ({s, i, u}, as depositFrom
runs it). NEAR Intents has no testnet, so 1Click's status was SUCCESS with nothing named delivered, and U was funded
from wallet E 0x49F2425b7F33f3a10912DE8add6839226cE663a2 in one payment instead. Each chain, in its lines' order above:
- one payment from E of 0.002 + 0.001 ETH and 2 x the floor's per-rung cost (base-sepolia 3053324480042250 wei,
  robinhood-testnet 3076911840000000 wei; floors 1026662240021125 and 1038455920000000 wei);
- the follow's deposit sent rung 1 (0.002 ETH, the deposit note, leaf 37 on base-sepolia, leaf 21 on robinhood-testnet);
  the follow was then stopped and a new one started on the same store (the reload); it asked the rest each round and the
  run answered not_landed (base-sepolia 28 rounds, robinhood-testnet 42), sending nothing twice;
- once rung 1 was final the same follow sent rung 2 (0.001 ETH, second arrival n = 0 of the same U) and ended in_pool, U
  under the floor (U keeps 42423695039880 and 69758510000000 wei: the unspent part of each rung's gas bound).
Read back (record-follow, both RPCs of each chain, the two alike): every tx succeeded. At 17:39Z the payment and rung 1
read at or under both RPCs' finalized block; rung 2 read succeeded and not final yet. Two rungs, not three: three rungs
take at least 0.008 ETH, and E held 0.0037 on base-sepolia and 0.0060 on robinhood-testnet.
Two rungs per chain stands as the run (decided 2026-11-11 17:52Z: wallet E is not funded further; a browser faucet
needs a person). Rung 2's finality re-read at 18:31Z 2026-11-11 (record-follow, both RPCs of each chain): every tx
above succeeded at or under both RPCs' finalized block, rung 2 included (base-sepolia
0x42e29db5cc73e1c96545cbea508f586b4c015b26cdef833ea11ee1c9c0b6c3e3 block 57482773, robinhood-testnet
0xf4295d191bed4113f2a264472cb54540305cce882dda8b4ab38215e56b871fd1 block 151921027).
What the run showed and the re-read fixed: the reloaded follow ended in_pool as rung 2 was sent, with rung 2's note
still INCOMING in the run's store (the follow's end came before the page's pass would land it). Since e01d7b6b no
in_pool and no end while a note of U_X's is INCOMING, and the EVM follow's txs reach the op through its landed read;
since d8994c39 a landed note counts for a quote only after that quote's own SUCCESS. The run was made on f92f2b25 with
evmPoolFollowDeps driven directly; the script drives main.ts's own route (evmQuoteRoute, with noted and open) since
d14f2636. It was not run again (no more testnet ETH for wallet E tonight).
