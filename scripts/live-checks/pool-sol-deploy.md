CARD pool-sol-deploy / live: PASS
Money path: yes
Tx: solana-devnet 5vCG9BtNfmyzpQt1yhWFBTEFoK952vWvye6LtwtmrAM8AXFn7aWfQpCUJooFC6mhfBnsthL2LedCa9TMiJHKAWMZ
Tx: solana-devnet 4cbim2bS6hvAK6xhnC8pxrUCD8jbtUjLy9k7XXjqEKzk9ZBK2xS9LxGo5pzf9xURxxwYgCy2sUYPiVuSLUj19hjZ
Tx: solana-devnet MGh5wwg2kbMYHRRmsYXcCNd4GUnLLVRMEXZo8CirEpB5z3Tj4g1ELK6FKaGj7mpJu9R2YcsF8dJ6VxEKdnMpw44
Tx: solana-devnet 55L7bTRDsxRPmuk78H5imdDhPHiCxn3PirneAVdCu4Uda7DmQtRrQ1thcNVjKmMxH2R2LKTyuoQ4sPw5Y71SEwg3
Tx: solana-devnet 3PM5GF9NHxSGqWnBy3QE5VpzmxbTsVE9zWaYFDRDhcSR2kWGATB8bn57g8s9CfREPedx1VbAQxgjRUK6wsJZovUa
Tx: solana-devnet ZnWQESKi9MUwZZJG6L95sdSVgKWmTJZYxUnHvLTcSrAijysRcrWpKT7otTeH8HFA1ewb2Hx7sP75AKSkrm2xR8p
Tx: solana-devnet 5aqY8EGFrkUY4TnZcob7ZyTNnCH3wWrhUoFga7dExFCDAooeP5wZJQFc58876Yne7Qbah6UuZWdhgt1ab96XQ4mH

The run: contracts/pool-solana/scripts/deploy.mjs on Solana devnet, 2026-11-07T23:13:52.110Z. Its steps, in the order of the Tx lines above: funding (to the funder), deploy with the upgradeable loader, the upgradeable loader: SetAuthority (to none), init (tag 0), deposit 0.01 SOL (tag 1), sweep (the funder's rest back), sweep (the funder's rest back).
Program 9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8, programdata AVGA2PJ9cQGGtvDbHupfxoMBz2fqRKZToB61egkAT3Xt, pool 92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr; code 79088 bytes, sha256 c86fc7fc1b442851c660c5ec0c4f3c4ad8648a5965b5a0da59189fbf0fdb5162 (cargo-build-sbf 4.5.0; Default platform-tools: v1.57; Default Rust: 1.95.0; solana-cli 4.4.0 (src:9ef63128; feat:dddabd53, client:Agave); cargo-build-sbf --sbf-out-dir out -- --locked; CI run 42012187381, pool-solana job 127193696070, commit c3fbad7147e6c049adaa1ed91cc6efda31f0ec6c).
Upgrade authority: none. --final is two transactions, the deploy and then a SetAuthority to none, both in the Tx lines above; this live check reads the authority none on https://api.devnet.solana.com and https://api.confidential.unrealized.trade/v1/rpc/solana-devnet.
Test deposit: 10000000 lamports (0.01 SOL), nonce 1, precommitment 1b1df828c58ccb3e50bd61969d9aa9b4a7204074616fa0ddd3dc82696b1a5fa9. Its note's secrets lived only in the run, so the 0.01 SOL stays in the pool as a test deposit.
Funders: 7PnRw6daz6XePFQUjqRYJoRH33GJPXjaMh2FyjXPGFR3, run keys, each swept to 3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx at its run's end; this live check reads each at 0 lamports on both RPCs. The last run was funded with 429764960 lamports (the printed need). Every key lived only in its run.
