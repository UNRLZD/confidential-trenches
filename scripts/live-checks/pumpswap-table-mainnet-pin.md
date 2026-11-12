CARD pumpswap-table-mainnet-pin / live: PASS
Money path: yes
Tx: solana 58Z69tiMh8sNoExBX1ih8wDRYnEYE7mazSr5ntH3z7krXdrpjTj4brwmf6vwkzQi7W4cE5ZfEbKtbMnyu6oCgUR7
Tx: solana 2GRmRhU6MkDUQ4ndChjun27d7GEjRLEkpAyKCJZW9FuxUA65zDwHjddHasiCdr7aYJUL2BLtcBAwK5ppzRyWnsWS
Tx: solana 4NQadC4hFeGY14DXKrDHw3QY5GKQL7xRp4SGwCmSTw4zRBFkAXLsAbw9CJQozpjNFafwP8SzbFY48V7pAFj5S1xr
Tx: solana 5xBH4zpo24UwRgjY13Zs5cH8Bn4AwKqst4rrfa2JjCMucTBZdEVJrQr3SFbd5BsZWoJUdaS7VNst77D8JvSgLbBm
Tx: solana 4UWVrgfm9kgEBxLcE9Vn4NA9gbAdqqCF5VWQLSbDj4eWZFuxnP321myARtXCPSBYkGpgFbaRzz8hebTTNHk9UfRo
Tx: solana 4VpWWMPccrREqnANHJy4GVBe4ydhon1NTeD3Xv67ojdBAvSfZjcadespQvUKKXQ35XAQJ73VAdkDEyM3gf2ZQiER
Tx: solana 2DDSKPpTRkLLfB5zReYcPYLTRxzy5WcdmFYffcg5CBfswuc1EMuWGZs7wNe9aXdAezSB3TWNEL3HY4YggK8VCH57
Tx: solana BdPRSKQmqjYf3gyqREvS7FwVGvKDQsrNtzFCZX7AzE42rMVZ64WCK2HWnP2QMbnfBzcx6stbj7pw3oBJ1EwGpzm
Tx: solana 3EtCjX987N8rWcB4zpZEFedTuCBa5zb6Um8hfGU9x4XRitaoPnJF4xru7ZinmJ69cLgYiBDEWnq4B4FhoueAThf7
Tx: solana 2y62aNsQH2UvWw8pBoZZ9bkXacmKGqutrJPJ1SscNuLkjFsZgDJS6kd7oeWVmGQBtkaV5wBEUxPgDkUrNBfLRddV

On 12 Nov the owner ran contracts/pool-solana/scripts/venue-table.mjs --cluster mainnet --venue pumpswap, which made PumpSwap's first lookup table on Solana mainnet, 4PyMCJPKZQvrLsj8DKCG2Yddh3vDmTf1EWnjCL1Bk3Pc, filled it with the kit's 256 addresses for the pool's state pages 0 to 134 and label pages 0 to 88 (trees of 7 and 5 entries then), froze it with authority none, and wrote generation 1 of tables.pumpswap in contracts/pool-solana/deployments/mainnet.json once both RPCs read it frozen.
The Tx lines above are that row's ten, in its order: create and extend with 28 addresses, seven extends of 29, an extend of 25, the freeze.
packages/wallet/src/pool/solana.ts pins the table as SOL_POOL_TABLES.mainnet.pumpswap, so the mainnet build loads a graduated coin's PumpSwap accounts from it and builds that buy instead of refusing it.
The live check is scripts/live-checks/sol-pool-venue-tables.mjs, run after every deploy: on two RPCs of two operators it reads the table at finalized, frozen and holding exactly the record's 256 addresses and the kit's own list, and reads each Tx of the row back succeeded on the money gate's two Solana readers. Its run of 12 Nov 07:37Z: PASS (4 deployed, 0 not deployed yet, 0 not pinned yet).
