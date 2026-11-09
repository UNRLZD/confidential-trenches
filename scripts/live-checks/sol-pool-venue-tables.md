CARD sol-pool-venue-tables / live: PASS
Money path: yes
Tx: solana-devnet ZmCXpmTeBuGQ8L3KYvZMy74qGByzxPHarPqUZ3CkgvSqxW5Z9d66LHAPtKJsHwz8JGDF1AR97G58DEzhjTMRPhR
Tx: solana-devnet 4VJfUmhUK9W32atgBacsbAqrA71J3YqroLxTPjzisEDE8cA6Y5T8ik1f572joDCqVDE4Byop2CY2yBUTKQeFsU8R
Tx: solana-devnet 2XxftHmqJfVMzJFu86ddeiFiiooxrGap2QDj2Hdnr6PhPZTNCNDH475b7G4rJYxjWLNUjBNXGMGrDxb92oRFi2tJ
Tx: solana-devnet foTJGwAcYbBo3VwxJzVEoMKkzbq7vyuAKy3jUg3u1Fv36mH5kUUqKupFb3BWBAU4dZhbFE52DfAvcGVCg8D174V
Tx: solana-devnet 2N7buhaLg6ysxzxmhgMu6RFMczDQPUapmZSB1FSkdAqWVHoxDAnYfNFdohVvgX8tXftUPJMsYvcE5aK2C6PXuipd
Tx: solana-devnet 5TqCfuHtjzW9fsqEeXrMCMnn6sbmsxEjkAavm7MSNQMvfVM8EZ27HN1MwnVnHME6yUzwwgYA4Gh3Cz8zav65s81Z
Tx: solana-devnet 5L7X5euwLNDeVfqZHgFtm4nM6NuPFamWeJpNTNp6WZvAsifaxeefoD7QHkt9z4gihz7RRfDFoC5P7wM6dP29Jpmq
Tx: solana-devnet eeVkMeP7M4CheJfRsZa7PmtrnuXzLFXshGCKhoKY21quHif7PAfnuu8amBpchqetcfbsB2FCRLtfEEsjBweKXo6
Tx: solana-devnet 4acoYzgJbKN3BPvPEisgdCzf287MJzMcM7buXxPYCXm58uUWp1QMrdQDyZYptTJgaKsbvLGScmSPvahNSdjtxX2J
Tx: solana-devnet 2novwiQD14FGB2nyCmbWcuntepAyiJAi4i8Nn7FZA2aZ3esyGqaMAbK9ED5EyexRmWKzAtsgD3mMkvG9FwvgvhY4
Tx: solana-devnet 5xR5HMTbhpSjTHK4opy6hphARJT5LoHo8mCMekNUNPqULkDaN6ryDpgFKCjCmQ5XKbqYpfUMGy6nnjK9RBEyZEqm
Tx: solana-devnet 4cQZVRS8tGFH6BeoNj1vQfzRibKTK11Pq6sEtRHhjvvTe6CUPCm9ByjnEkCJ6DhT1wscXdNVVrohJH17FEWLeNy7
Tx: solana-devnet sZXeKTqn7bCaFSbUE6mtBekWEmJTLySoP7oj9pDvr6AAtw7HNHrGkxzMenPtaLihDYkHLzAXfZng2So7D4k4BMC
Tx: solana-devnet 2qohT64Uo6RLtqbr5xu6KAxdeGL1Aa6TTJos12PQBsFawBGE7Y8R3V45sEbgEwaafU84YxYNv4nFMAHg5Xvrtp8u

The devnet run of 9 Nov 2026, 23:12Z to 23:22Z. The Tx lines above are in order:

1. The PumpSwap venue table 4kG4g4fbSbwkxxdqT4G3cLeEbnvcbZTmBwJExK3ZGGAT, made by contracts/pool-solana/scripts/venue-table.mjs
   from the kit's list for the devnet pool (program 9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8, pool
   92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr), 34 addresses. Lines 1 to 4: create and extend with 30 addresses,
   extend with 4, freeze (authority none), and the funder's rest swept back to D.
   - The first run stopped after its create. Its second extend was refused "insufficient funds for rent": the need had
     no room for the funder's own rent floor. The resume extended the last 4 addresses and froze the table, after the
     fix and a 650,240-lamport top-up. The fix keeps rent(0) in the need, and a test holds it, red at a58107c8.
2. The pump curve venue table C2vLuah7VtGDTVnFkBpY7DkNf135Wwu6Uv57qCXPb9qJ, 25 addresses. Lines 5 to 7: create and
   extend, freeze, sweep.
   - The first curve run landed nothing. Its create was refused "invalid instruction data" because the slot was not
     recent on the node that sent it. The slot now comes from that node's SlotHashes, with a test that is red at
     a58107c8. Line 8 is that run's sweep of its 5,008,720 lamports back to D.
3. Both tables read back frozen on api.devnet.solana.com and solana-devnet.api.onfinality.io at finalized, holding
   exactly the record's list and the kit's list: `node scripts/live-checks/sol-pool-venue-tables.mjs` gave
   PASS (3 deployed, 1 not deployed yet). The one not deployed is mainnet PumpSwap, which is the owner's paste.
4. The PumpSwap pool buy through the signing page's own testnet flow: packages/signpage/scripts/pool-flow-devnet.mjs
   with the pinned tables, the graduated Token-2022 cashback coin EX84Kv1W7Qd8T3A7CAQV8aocxZuqnAzk7wtTZykupump (its
   reference's best venue is PumpSwap), and spend "max".
   - Line 9: U's funding from D, 11,473,120 lamports.
   - Line 10: the deposit, leaf 25.
   - Line 11: the release and buy in one transaction. It loads the PumpSwap table 4kG4g4fb. Its programs are the pool, PumpSwap
     (pAMMBay6), the fee program, Token, Token-2022 and the ATA program. It reads err null at finalized on
     api.devnet.solana.com and on the helper's devnet route.
   - Line 12: W's 100% sell on PumpSwap.
   - Lines 13 and 14: the rent back, the teardown frame and W's sweep into the pool as a return note.
   - A later load (FLOW_RESUME with FLOW_SWEEP_W) read the return note UNSPENT at leaf 27, 5,714,253 lamports. W, its
     token account and both volume accounts read null at finalized.
   - The first pass ended "filled": false only because it read the notes before the settle wrote the return note.
     Every stage told was filled.
