CARD pool-sol-deploy-mainnet / live: PASS
Money path: yes
Tx: solana 5wGExGuraxHFnnnobPR85vr3fBu7mW6BEgrpZWotwMZupKtdRSUj1jBExFbm7wiFeeHR8tqUUbZMAfnH8EM7uQPM
Tx: solana 4J83SCt18CSJW4bVGKYsESAXmhqmCmsomnDnTaQrJpuv6H2sFBgHpkEzXxgvUr6LYycwhQG6cLuD8k17XWQb1vkU
Tx: solana 5EtRdefacXzZDpWqqaj1TQPpehoBZocvgcq7oKxn3bFvjtRvKkar9mfYH1XKbLkjfcroxGVeCWGsntuD4ZuqpZvg
Tx: solana 2MDSvHYtWpu3ZFguZV4ySxWXHcZWjo6Jc2EYUoV8nWhtN8NQAYc8sdpo6nAuJkEdfphjDCXFivzAN9p5bVVHXtHG
Tx: solana 23QX9RfcjLb271ZPWCStKA6mWoQA86o9HDSoKq727q8qRPpoKYnPiUotGJVQm4azQpBGqTayLB1UjhQpGREVzTEb
Tx: solana 2gwDsZqzGQnUsY5fDVujjcmgfdPzyaPKJRtVUSePTkJBkVHYNwQxau9c4vgvu8zwvL6SaXhwxFKFEacnBD1Qemp1
Tx: solana 2XdxFtwv6hvgGreUGVKfwN5AdvCsvsHkErThG1pg86G732DqRgMLmHNi2mjMU6PUzanU4SZvsxsEhZvpQDu6S8kU
Tx: solana 3CUZ2CpNwk8DabVSSD5T62AFJ2JWy8rdU1E8A2ZWMZsYW6RLbRgNXzpQPGHsiWd6s2beD7NRt8hsJUp2KCDJHTRb

The run: the owner's paste contracts/pool-solana/scripts/mainnet-deploy.sh (deploy.mjs --mainnet) on Solana mainnet, 2026-11-06T07:58:41.582Z. Its steps, in the order of the Tx lines above: funding (to the funder), deploy with the upgradeable loader, the upgradeable loader: SetAuthority (to none), init (tag 0), lookup table: create and extend with 25 addresses, lookup table: freeze (authority none), sweep (the funder's rest back), sweep (kept keys, to the run's return address 9bUzp4G6dFrT1YZuuNAE6p4pZKvai726nAb6XpiMmbzJ).
Program EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF, programdata EuoumSLYMugNL6TsEKRby4bYXH4EcEgwASFdWhWNBQxM, pool 7ijWvp3xEk5yUfGYQJfgoabReCTpSyZhiWjmCt3TQDz8; code 79088 bytes, sha256 c86fc7fc1b442851c660c5ec0c4f3c4ad8648a5965b5a0da59189fbf0fdb5162 (cargo-build-sbf 4.5.0; Default platform-tools: v1.57; Default Rust: 1.95.0; solana-cli 4.4.0 (src:9ef63128; feat:dddabd53, client:Agave); cargo-build-sbf --sbf-out-dir out -- --locked; CI run 42012187381, pool-solana job 127193696070, commit c3fbad7147e6c049adaa1ed91cc6efda31f0ec6c).
Upgrade authority: none, read on https://api.mainnet-beta.solana.com and https://solana-rpc.publicnode.com. No test deposit on mainnet.
The pool buy's lookup table BShWZ8FbDPYGpoc1ebj4TiELvVFmBQwW4XMYuLtQoHYZ: 25 addresses, authority none (frozen), read the same bytes on both RPCs.
Funders: 7Y7omJGVsxTm797X6ytUuskfeQ2kjVs4UK4Hip2hKkvB, run keys, swept to 9bUzp4G6dFrT1YZuuNAE6p4pZKvai726nAb6XpiMmbzJ at the run's end; this live check reads each at 0 lamports on both RPCs. The run was funded with 449137520 lamports (the printed need). Every key lived only in its run.
Paste 1 (2026-11-05T18:16:25.178Z) stopped mid-upload and is kept as contracts/pool-solana/deployments/mainnet.attempt-1.journal.json: 42 transactions, its keys removed with every lamport read back at 0 on both RPCs; this record is paste 2's.
