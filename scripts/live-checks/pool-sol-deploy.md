CARD pool-sol-deploy / live: PASS
Money path: yes
Tx: solana-devnet 5ky8dDdioLKTPSoYLWZreY9XynYiBTa6s1eQQoufve2cw9yPaNnrjTgUUdueJnSHnUrfFLKFL38TxVEKPrTBb4vp
Tx: solana-devnet 2RbctyMfs8YRDUVkrDHFcnW5zTboVMZJAhd7HhgEnbWEbdT9gmsthKZZrzUm36RqyWM8fd46RuFzF3UXRnB7siex
Tx: solana-devnet 4kdXUFWQ6xwUXLeirWR6Vu3hbFg7EoCrU2UWZgoHnxPW47iGNagYKa366yXxyHHoQm7SttAga44UMxLqac5xFY2E
Tx: solana-devnet Ey5Rgkq4bDnrQMZrJDWJ3csBa64c2itKkDyV1zWziFyzEwLV7FqnqFiWHVPMSbj2V3NEzCJiTAz9TaujTcfFy1u
Tx: solana-devnet 2sWubsaEgBHKdUQUmX3mzoiz4s8BbWFSZQYfW6pdj9hG7Kf3SfXwsGppxHsEhiSJECDfaJwJPbN44vTe4MEYKzGw
Tx: solana-devnet 3HWqdh7rUAixvXvtwYfhWSdHBZTDU46k3WKmtvTNwdu4orfbFmf2Z4hE2e9gupp2Rwz2ZW2n1rHLMg6hTgTELkmu
Tx: solana-devnet 3VdcE5dS8zBBopEkKWkbZg4yHXUvE1m6aNqbsEXWGWMmouJKfrRMiVChCGcNatExwAMTssfQmEkmbSBgkoSL4eeh

The run: contracts/pool-solana/scripts/deploy.mjs on Solana devnet, 2026-11-03T10:28:13.576Z. Its steps, in the order of the Tx lines above: funding (to the funder), deploy with the upgradeable loader, --final, the upgradeable loader: SetAuthority (--final: to none), init (tag 0), deposit 0.01 SOL (tag 1), sweep (the funder's rest back), sweep (the funder's rest back).
Program HAQSdJEJb1bomc3Cdam9VJ25RV6zTs75vqiPh6FZ78L7, programdata 6s22EU9yyHRMYpx3XF32U9AtL1NvtDkeE2NunKo3JbEP, pool D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef; code 77344 bytes, sha256 c518a66e2544dcdabf8d11c6e9803bf553a1fe7c3884eedcdb228e7a615eaf0b (cargo-build-sbf 4.4.0 (agave v4.4.0), --locked).
Upgrade authority: none. --final is two transactions, the deploy and then a SetAuthority to none, both in the Tx lines above; this live check reads the authority none on https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public.
Test deposit: 10000000 lamports (0.01 SOL), nonce 1, precommitment 008d7e63e72059817d7d5a7af921559bc22eb2b68510a82b8f5e365df877e96c. Its note's secrets lived only in the run, so the 0.01 SOL stays in the pool as a test deposit.
Funders: 4t4t3NA4iCZU67SeSUUZHZsiQi7gPfaEAHrRNjaSziK2, run keys, each swept to 3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx at its run's end; this live check reads each at 0 lamports on both RPCs. The last run was funded with 420890360 lamports (the printed need). Every key lived only in its run.
