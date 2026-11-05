CARD vault-mainnet-test / live: PASS
Money path: yes
Tx: near HtFfu1gbhPxKv1QyBFBbbRRAGenYgdSVzwagQB49iiiY unrlzd.near
Paste 1: unrlzd.near creates confidential.unrlzd.near with 0.1 NEAR and one full-access key, ed25519:WHHJ4Rmp2dzkkWtE5UuNkeEnw6JCnXLPrnXV6fiQhhh (KR10).
Tx: near ERpxJfsoLDhVccizgpzdaLS3mhmke3LrJhTjCjPGFhsF confidential.unrlzd.near
Paste 3: the keyless deploy batch, CreateAccount, Transfer 2.30964 NEAR, DeployContract (the pinned wasm 57535ae7) and FunctionCall config, with no AddKey.
Tx: near FGnMBPSgWBwYKia3cbAmcEHRjurZiBXhU6j7AT21s9r2 confidential.unrlzd.near
Paste 3, after the read-back: storage_deposit of 0.00125 NEAR on mainnet USDC, registering vault-test.confidential.unrlzd.near.
Tx: near 9sZPrcGpNau1fN25R9Xqdu9iKGMkRQvCSiHwFn4ZrNRt confidential.unrlzd.near
Paste 4: one storage_prepay of 0.00756 NEAR into the vault, read back by vault-mainnet-test.mjs on FastNEAR and dRPC.

    ok  vault-test.confidential.unrlzd.near key list is [] on FastNEAR and dRPC, code hash 6stBz3WromsLyyeD3FZD133ThTt9XvW6eqVHCA64c5Ff on both
    ok  config() on both: blindfill-vault 0.1.0 mainnet, mainnet USDC, scope 8086271268364488307551911707115823685859436809391798291511922449751894623475
    Recorded run: vault-mainnet-test.answers.json (5 Nov 13:32Z), replayed by vault-mainnet-test.test.mjs.
