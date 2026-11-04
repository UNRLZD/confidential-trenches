CARD pool-sol-deploy / live: PASS
Money path: yes
Tx: solana-devnet 3Pk3GhfX9nZ8NnLA69rah6afoCBDMJJbqRtkWLHhm533XYr4ZGJ339sQGyJ7GWwt3pVbhT6xYiQqL6V5Kk3jLbMc
Tx: solana-devnet 5uAzzsgscZsdPHDLqBy9DZKRLxDYCBaEc2iU4JBgPonNAxJJzn76evSNKML3B8GETpcp5iuMkd3qBwP9tZyhiVMg
Tx: solana-devnet 66BcwYwsdXDmMmbgWg9yfcTuUCR97Y8Ahk6V1vu8pRHG5dqomp8qydc8sCCUAqqxBbLgmFULHVS8e6WgofBuaNf
Tx: solana-devnet 3A1jysvq6P2CJMTxZD2oardRS5BEtKSuUakHaSFUGUzc4Zs8ahWYurrNhivJWX6vFbZxdtXG95x92bUfshd5gshW
Tx: solana-devnet D2xcLtj9sBWpwT2HoNMt8kromhZKDmnvSVjn78CvHbAGLW8h66tCt8APP11wCWgo94iJwUD69o6ZUCKs8Rd3uwj
Tx: solana-devnet 25QsubihKQh3rebfAd9Nbsd8t6dt63KdSWAbNhJTbfZai9JdGYERxc2W5xmccHiy41Kz2mmRpKH2rb5KsJ9dMJJj
Tx: solana-devnet 2g8ypRJJNggQCusW9EuJWrwnTkcjq5fU7wyTWdjfme45rfUcWF8ntu1VZTba88dd57qeD5HX3Ud7fjfQ2Db7eVhf

The run: contracts/pool-solana/scripts/deploy.mjs on Solana devnet, 2026-11-03T19:30:39.249Z. Its steps, in the order of the Tx lines above: funding (to the funder), deploy with the upgradeable loader, --final, the upgradeable loader: SetAuthority (--final: to none), init (tag 0), deposit 0.01 SOL (tag 1), sweep (the funder's rest back), sweep (the funder's rest back).
Program 5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ, programdata 2z2CxFYEeik3PQsui67mxUFFjAVZcmb1z61GJiPdyDrv, pool 2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr; code 77472 bytes, sha256 9539c9d105fc8960d864e4c59ff47fd44258324627a67b01e1d71d40c3a5ba01 (cargo-build-sbf 4.5.0; Default platform-tools: v1.57; Default Rust: 1.95.0; solana-cli 4.4.0 (src:9ef63128; feat:dddabd53, client:Agave); cargo-build-sbf --sbf-out-dir out -- --locked; CI run 41700702945, pool-solana job 126144439173, commit 10e685dd2294a32ebf4d9852efaf32e54b929359).
Upgrade authority: none. --final is two transactions, the deploy and then a SetAuthority to none, both in the Tx lines above; this live check reads the authority none on https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public.
Test deposit: 10000000 lamports (0.01 SOL), nonce 1, precommitment 13d795c96f00c2a5ea68c15e29ba995b6914a00da16e14d9ce596fd57921bc6a. Its note's secrets lived only in the run, so the 0.01 SOL stays in the pool as a test deposit.
Funders: Aj9L7RTqRPma4pBbEVswfSYoY8y753aMnqHc3Rhbf1bn, run keys, each swept to 3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx at its run's end; this live check reads each at 0 lamports on both RPCs. The last run was funded with 421550680 lamports (the printed need). Every key lived only in its run.
