CARD vault-mainnet-deploy / live: PASS
Money path: yes
Tx: near FkNJCwdRTTPps7QEyuN9aQgHL9tmQzABiru77RWdexMw unrlzd.near
Paste 1 (14:36:19Z): unrlzd.near sends 2 NEAR to the parent confidential.unrlzd.near, the deploy's signer (found on nearblocks' public API, the one Transfer between them before the deploy).
Tx: near jZhfysps9zTyVUjoBKJmKJ2VKG3g6fnF8ooYrBQm6RG confidential.unrlzd.near
Paste 2 (14:36:40Z): the keyless deploy batch, CreateAccount, Transfer, DeployContract, FunctionCall(config), with no AddKey: vault.confidential.unrlzd.near with the pinned wasm a4a2af69; mainnet-v1.json tx_hash.
Tx: near Gu7ptqE43xpwYDrstuHu2UrinHah9rjVuD6EjP27h1Gk confidential.unrlzd.near
Paste 2, after the deploy (14:36:46Z): storage_deposit of 0.00125 NEAR on mainnet USDC, registering vault.confidential.unrlzd.near; mainnet-v1.json registration_tx.
Tx: near 4rYpSgDpG163YCCxAFdb7NazwNxNrACmFH5ezDAVuW2u confidential.unrlzd.near
Paste 3 (14:37:00Z): one storage_prepay of 0.00756 NEAR into the vault (precommitment 343956469738139399150638971303622014548357682639799632250445894797972969203), read back on FastNEAR and dRPC by vault-mainnet-deploy.mjs; vault-mainnet-deploy.answers.json.
Tx: near FmKGVwzqq4BJakXd4ifKHZ8A1h7HK4ETiP3dB4feR733 confidential.unrlzd.near
Paste 4 (14:37:19Z): storage_deposit of 0.00125 NEAR on mainnet USDC, registering the withdrawal fee recipient fees.unrlzd.near (found on nearblocks' public API, the parent's one other USDC registration after the deploy).

    ok  vault.confidential.unrlzd.near key list is [] on FastNEAR and dRPC, code hash C5fk3Fr9XZwSeDbu9Nc6pTMpYrWiKgBXVzJaK2mAzG3u on both
    ok  config() on both: blindfill-vault 0.1.0 mainnet, mainnet USDC, scope 2696045386038969515385069783440640732471742599039067451316404212202914210601
    Recorded run: vault-mainnet-deploy.answers.json (7 Nov), replayed by vault-mainnet-deploy.test.mjs.

Helper redeploy: after this card merges, helper-usdc-event-watch FAILs on the deployed helper until the mainnet env cutover (its recorded bad_mainnet_not_carried run), so the helper redeploy for this card goes together with the cutover (apps/helper/deploy/vault-lines.sh, card helper-bind-relayer-mainnet), never before it.
