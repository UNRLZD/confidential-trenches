CARD evm-deposit-note-stays-incoming / live: PASS
Money path: yes
Tx: base-sepolia 0x562c88473b847c52a868044f08da72c60b2ecdf39a70d07589e6eec000991494
Tx: base-sepolia 0xe0154593805c6d719b5ba362b8d905263b97dd5174c8f44dfa571cc6936e6757

base-sepolia (chain id 84532), packages/signpage/scripts/pool-deposit-evm-testnet.mjs base --settle at 2026-11-10T06:21:53Z,
on the testnet build's pin of the pool 0xeb967dfc1b4ffb22942f833c76866ea85fc42266 and its two RPCs
(base-sepolia-rpc.publicnode.com, base-testnet.api.pocket.network), with this card's verdict
(packages/signpage/src/pool-deposit-evm.ts spentFinal). Its steps, in the order of the Tx lines above:
- the one-time deposit account U 0x5422E34AF888C61Df0f002Ea7c2776c7ECcCC7DC funded with 0.00103 ETH from the test
  wallet 0x49F2425b7F33f3a10912DE8add6839226cE663a2 (the run named 1025124800002121 wei short);
- U's deposit of 0.001 ETH (nonce 0), answered "sent" at 06:23:12Z and read back succeeded on both RPCs in block
  56849606, its Deposited naming the note's precommitment.
The page load's pass then ran every 60 s: 25 passes answered not_landed while the Deposited was not final on both RPCs
(never failed), and the pass at 06:51:28Z settled the note UNSPENT at 0.001 ETH, leaf index 17 ("filled"). The run's
seed lived only in the run, so the 0.001 ETH stays in the pool as a test deposit.

robinhood-testnet (chain id 46630), the same script with robinhood --settle at 2026-11-10T07:42:25Z on commit
04446874, on the testnet build's pin of the pool 0xed9fac860e6bc5e932455232eedca8b71c44da4d and its two RPCs
(rpc.testnet.chain.robinhood.com, robinhood-sepolia-rpc.publicnode.com), both of which refuse a state read at
"finalized" (-32000 historical state not available). Its steps, in the order of the Tx lines below:
- U 0x5567d827304ca24bf9C817cEBb8eea6aBA85C745 funded with 0.00104 ETH from the same test wallet (the run named
  1036918480000000 wei short), read back succeeded on both RPCs in block 151248172;
- U's deposit of 0.001 ETH (nonce 0), answered "sent" at 07:43:01Z and read back succeeded on both RPCs in block
  151248226, its Deposited naming the note's precommitment.
The pass ran every 60 s: 18 passes answered not_landed while the Deposited was not final on both RPCs (never failed;
two passes met a pruned-state refusal on one RPC's pool view and read again), and the pass at 08:09:15Z settled the
note UNSPENT at 0.001 ETH, leaf index 10 ("filled"). The seed lived only in the run, so the 0.001 ETH stays in the
pool as a test deposit.
Tx: robinhood-testnet 0x8d7e34350896e967d7dde1b73a4988b9558c3b8279bf1bbbd09d6cf91924ff6c
Tx: robinhood-testnet 0x161c85b6577eb089e49237e0ee25e3936e30a8495c44b10ac11a6b59e5ca5d4f

Both chains again on commit f4ede686, whose pass (runPoolDepositEvm, the path the script drives) is the shipped one:
the later commits change only the end's reads after an ask (noteEndEvm) and tests. The same script, the same pins and RPCs.
- base-sepolia at 08:25Z: U 0x7e2C2eA6f7B2E659b847ba175198fFBd1490DeC0 funded with 0.00103 ETH (read back succeeded on
  both RPCs in block 56887198); U's deposit of 0.001 ETH (nonce 0) answered "sent" at 08:28:43Z, read back succeeded on
  both RPCs in block 56887257; 22 passes answered not_landed while it was not final, and the pass at 08:53:27Z settled
  the note UNSPENT at 0.001 ETH, leaf index 20 ("filled").
- robinhood-testnet at 08:28Z: U 0xA8d6413A86C594daAD3496643AFe847BEfde6832 funded with 0.00104 ETH (read back
  succeeded on both RPCs in block 151264337); U's deposit of 0.001 ETH (nonce 0) answered "sent" at 08:29:06Z, read back
  succeeded on both RPCs in block 151264380; 22 passes answered not_landed while it was not final (never failed), and the
  pass at 08:54:07Z settled the note UNSPENT at 0.001 ETH, leaf index 13 ("filled"). A first start of this run at 08:24Z
  answered failed before planning any note, with nothing signed or sent: one RPC refused a pool read at a recent block
  (-32000 historical state not available) before the ask.
Tx: base-sepolia 0x02e7c91d820b4848eb07c053c8465d9da528f8accfce2ff494e77b72f62ee6c3
Tx: base-sepolia 0xf9e418a43b19cef4a3426a6304cfaf2b4d3f8077ce7f8e91f8e2e7267902422d
Tx: robinhood-testnet 0xfe73579b72c200884f3fb8966e83d7640af0f43cc56de28c8efffc4bf165e240
Tx: robinhood-testnet 0x4adf0a1fd619bc69c31479bcc6f12d43bc02bf1bfdfbeb067c41e20a177e3066
