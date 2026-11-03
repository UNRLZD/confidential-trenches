CARD pool-sol-deploy / live: PASS
Money path: yes
Tx: solana-devnet 4tQ6sQqHdjUY8zsKNYydUHBNuarLEb6Mg8jGQPQdr9ZFRCQEHzD27E3MjztwYvcqtmBK8wS1ya4X1UmAkZ3hyB3q
Tx: solana-devnet 3H2Vatu78qcxvPKzxpGDE7r2v3XdkPDM8AbgMqkLJBUFdqbiLoQNu4rnAtCv5TsbHDEuNdtccUbq2AR4qyXJsY1B
Tx: solana-devnet 2Wii4A6vyFxXsXEF8G58LNwfz4cfCHKJbwT5ixkAvj7suFhwVT89wQDyTGuCsFAxBXGR5AJgoabBXKPB6q2sPQEf
Tx: solana-devnet kawrTQi6tbDaNB6cdmLeBSN5G4hm5G64iAxu3D2E6ie6cuxKLAsJEFEWPZVz8FUKKn1DUs778MLJknweZpH7xRE
Tx: solana-devnet 4vHiNudSE6MDEw96oDXSVXMAh1JbxZQ1XSmAKcPHqaAq2XAKm8PSC3iJgFzQNVsA2gwaA9fCeX4GNkFKNWcQG1WE
Tx: solana-devnet 2Mmz9A6CbSSZ1NAsDM9jAgknh92aD1bMrq366ASeyyEuCYosT75FMwetuSoHn1WwVRRiDSFkg46dMZGYYPpMe6JQ
Tx: solana-devnet mCnbw8Fk8hvbQu7BGmv1wvUnuGC3gn4jHLUv8ibVEEsYRFHZ8VAPHcznMSCtK2grHR1d53CYStYVX2Lqbd7mpmy
Tx: solana-devnet 3sNYGu9HQUw1x65gMetLT9pZuatPHWKWLseYYvASmgMKERHJbUi5MRDnM19owmfPRDQAyXxyLA1kKfNQZDFeRw3i

The run: contracts/pool-solana/scripts/deploy.mjs on Solana devnet, 2026-11-03T00:12:51.969Z. Its steps, in the order of the Tx lines above: first run (--prior), first run: deploy with the upgradeable loader, --final, or an earlier step on the program, the upgradeable loader: SetAuthority (--final: to none), first run (--prior), funding (to the funder), init (tag 0), deposit 0.01 SOL (tag 1), sweep (the funder's rest back).
Program 2x25vNNnjrF2hkNG36jHyDV48fvQZ4rEC9dq8xfghVfZ, programdata 3JA66UkxGjw8qk19DFKJYbPmiqpMzQGZGWPVQYmcyZk6, pool H6wpDwjzWf4DJdDiRtbiB4RLHkvinDhrX5TQEjKrA4YD; code 77160 bytes, sha256 d936161e10db758b5a3bf8fbc05a81c9a4a85cd58bd3257fc8d7718311564c59 (cargo-build-sbf 4.4.0 (agave v4.4.0), --locked).
Upgrade authority: none. --final is two transactions, the deploy and then a SetAuthority to none, both in the Tx lines above; this live check reads the authority none on https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public.
Test deposit: 10000000 lamports (0.01 SOL), nonce 1, precommitment 0c5951cd38b8cf87b998e3c48d4d552e19b305127026fa46cbd4bd294762ad00. Its note's secrets lived only in the run, so the 0.01 SOL stays in the pool as a test deposit.
Funders: 2L2yVWb3TugFTB977NmcB4U4mFcdBNVSeBV6hZV44YbH, 9bEdyeRYmBhvS91wBKZmkk4FUeqVjZ4nEx3UDKDHyfcp, run keys, each swept to 3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx at its run's end; this live check reads each at 0 lamports on both RPCs. The last run was funded with 25820880 lamports (the printed need). Every key lived only in its run.
