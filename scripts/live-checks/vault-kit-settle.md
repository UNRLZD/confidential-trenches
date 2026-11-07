CARD vault-kit-settle / live: PASS
Money path: yes
Tx: near-testnet FiP8gzcSbMyLXsTE3J4QVefXPBUWomCLomTay6feW3z bf-vt-20261106t125654.testnet
Tx: near-testnet ANwAEejcnbd7pSCFcGrYdvqBDxPUz7VzpfVj8yCN8Wwo bf-vt-20261106t125654.testnet
Tx: near-testnet BFsRiTjNuMboLf4GoPXGPg9B8qwULdQTgxKFEcLwq49p bf-vt-20261106t125654.testnet
Tx: near-testnet 7uQdkb6Cm4azSJniYoT47bhdKUaPdaa1KRUHVYyVW855 holder.bf-usdc-20261101t022248.testnet
Tx: near-testnet 7VmaiEWVeegfKkxjeiivGaxakBsMaKrsKC4p5ySnVGjQ b6da3205c5a6d6115a2dc9da6cd60f5d3ace5a8f5185eecb934a2bb10252d967
Tx: near-testnet 8vJYpDNjGYx1YvQS2hTkDgKvjYbH6WrenNhW9aCHZQNK b6da3205c5a6d6115a2dc9da6cd60f5d3ace5a8f5185eecb934a2bb10252d967
Tx: near-testnet Bdi9MHvRqEYyimXLHSpzwU5X3yJeg69x2ZAdyF5mA98x b6da3205c5a6d6115a2dc9da6cd60f5d3ace5a8f5185eecb934a2bb10252d967
Expected refusal (bounce, bounce): near-testnet 4b8GQVJpkU11Mzj9vGccrzJKCHLEsVR95PUCmHsHveWs b6da3205c5a6d6115a2dc9da6cd60f5d3ace5a8f5185eecb934a2bb10252d967
Expected refusal (again, refused AlreadySettled): near-testnet CuLykJH4ePG5WF8cBwLR5mffSkhQegB2YvSaSucQwjxS b6da3205c5a6d6115a2dc9da6cd60f5d3ace5a8f5185eecb934a2bb10252d967

The two expected refusals fail one receipt by design, so the money gate does not read them; packages/kit/test/vault-settle-testnet.mjs read each on FastNEAR and dRPC: the withdrawal with exactly one failed receipt (the token refusing the fee recipient B as not registered, which fails the one payout receipt whole, vault review A-01) and the payout event returning 1000000; the second settle failed AlreadySettled with no receipt off the vault. The live check reads both again.

Vault: v4.bf-vt-20261106t125654.testnet (contracts/vault/deployments/testnet-v4.json: keyless, the final source e0623bf3, code hash AgJrTpwh), on the team's testnet USDC bf-usdc-20261101t022248.testnet.
Accounts: P bf-vt-20261106t125654.testnet (the vault's parent, NEAR only), D b6da3205c5a6d6115a2dc9da6cd60f5d3ace5a8f5185eecb934a2bb10252d967 (the device: depositor, payer, recipient and the settle's signer), B b-b455a54c.bf-vt-20261106t125654.testnet (the fee recipient: no key, not registered on the token).
Steps: P funds D 1 NEAR and registers it on the token and makes B; the holder sends D 3000000; D prepays and deposits 1000000; D withdraws it whole to D with fee 100000 to B, the token refuses B, so all 1000000 is refund_pending; the kit's vaultSettleOwn reads D's spend refund_pending on both operators at one block, hands D's sender settle (150 Tgas, 148 B x 1e19), reads it settled and writes the refund note (value 1000000, the row's refund label, leaf 2, Poseidon(1000000, label, R) at leaf 2 on both operators) through the note store, UNSPENT, its parent the deposit note; the kit's second call sends nothing and writes nothing; D's settle sent by hand is refused AlreadySettled.
Balances before (2026-11-07T21:14:46.498Z): D USDC 0, vault USDC 0, totals {"deposited":"0","spent":"0","returned":"0"}.
Balances after (2026-11-07T21:16:10.798Z): D USDC 2000000 (3000000 funded, 1000000 deposited), vault USDC 1000000 (the refund note), totals {"deposited":"1000000","spent":"1000000","returned":"1000000"} (deposited - spent + returned = 1000000 = the vault USDC).
Vault gas burnt per receipt (Tgas): storage_prepay 1.80; ft_transfer_call (deposit) 6.57; withdraw (fee to B, bounces) 40.00 + 0.22 + 1.82; settle (D, the kit's call, a refund note at leaf 2) 10.07; settle (D, again) 1.43.

    node scripts/live-checks/vault-kit-settle.mjs
    live-check vault-kit-settle: PASS (26 ok lines, both operators)
