CARD vault-readback / live: PASS
Money path: yes
Tx: near-testnet 4rtmvb73ajcjLyTVD2heiytSRM1u4wZ5gHKD17jRW26a testnet
Tx: near-testnet DCrm53kfRcZiMRBQPevDcftUTPSVT9L1kLtSsRpFzyc2 bf-rb-20261104t183046.testnet
Tx: near-testnet 9i99Dt4siBXHfpntHpN81R4wmBiTeRmBPMF4czjFhD7V bf-rb-20261104t183046.testnet
Tx: near-testnet BvNu4uMifEJGjRuniSB6yB3LiaN2XrRYBNXfJtHRsHRt bf-rb-20261104t183046.testnet
Expected refusal (bad-write, InsufficientStorageDeposit): near-testnet bbHFD9BhLGhwchkCAjAXeB217QCwxh8g6v167gkvkck bf-rb-20261104t183046.testnet

DCrm53kf... is the write exactly as the check printed it, run through near-cli 4.0.13 (the `near` on the team's Mac, npm near-cli) with the signer's testnet key in ~/.near-credentials/testnet/, then read back with --tx and the printed --precommitment; vault-mainnet.answers.json is that read-back. 9i99Dt4s... (18:47Z, contracts/vault/scripts/prepay.mjs at ca94443) and BvNu4uMi... (18:30Z, the first draft d321a55) are the same kind of write; both landed. The refused write attached 1 yocto, below the 756 B minimum, so the vault panicked and its receipt failed by design; the money gate does not read it, and vault-mainnet.bad-write.answers.json is its read-back on FastNEAR and dRPC: final, InsufficientStorageDeposit, no storage_prepaid event.

Signer: bf-rb-20261104t183046.testnet, a fresh named testnet account the testnet faucet made (tx 4rtmvb73..., signed by testnet) for a key made on this Mac and kept only in ~/.near-credentials/testnet/ (mode 600, the near CLI's key file), as contracts/vault/scripts/testnet-usdc.mjs makes its token account. No mainnet key and no owner key.
Vault: vault.bf-vt-20261102t071444.testnet (contracts/vault/deployments/testnet-v1.json). Write: storage_prepay(a fresh 31-byte precommitment) with exactly 7560000000000000000000 yocto (756 B x 1e19), 30 Tgas attached; the vault's receipt burnt 1.854 Tgas (DCrm53kf...), 1.850 (9i99Dt4s...), 1.847 (BvNu4uMi...).

1. The check, which signs nothing, prints the write and the command that reads it back (exit 3):

    node scripts/live-checks/vault-mainnet.mjs --network testnet --account vault.bf-vt-20261102t071444.testnet --signer bf-rb-20261104t183046.testnet
    near call vault.bf-vt-20261102t071444.testnet storage_prepay '{"precommitment":"170939303965139770475647005542589386951066595781384355983336340405127965496"}' --useAccount bf-rb-20261104t183046.testnet --depositYocto 7560000000000000000000 --gas 30000000000000 --networkId testnet
    near call vault.bf-vt-20261102t071444.testnet storage_prepay '{"precommitment":"170939303965139770475647005542589386951066595781384355983336340405127965496"}' --useAccount bf-rb-20261104t183046.testnet --depositYocto 7560000000000000000000 --gas 30000000000000 --networkId testnet --signWithLedger
    then: node scripts/live-checks/vault-mainnet.mjs --network testnet --account vault.bf-vt-20261102t071444.testnet --signer bf-rb-20261104t183046.testnet --precommitment 170939303965139770475647005542589386951066595781384355983336340405127965496 --tx <its Transaction Id>

2. The printed line, run as printed (no Ledger line):

    near call vault.bf-vt-20261102t071444.testnet storage_prepay '{"precommitment":"170939303965139770475647005542589386951066595781384355983336340405127965496"}' --useAccount bf-rb-20261104t183046.testnet --depositYocto 7560000000000000000000 --gas 30000000000000 --networkId testnet
    Transaction Id DCrm53kfRcZiMRBQPevDcftUTPSVT9L1kLtSsRpFzyc2

3. The printed read-back, with that Transaction Id:

    node scripts/live-checks/vault-mainnet.mjs --network testnet --account vault.bf-vt-20261102t071444.testnet --signer bf-rb-20261104t183046.testnet --precommitment 170939303965139770475647005542589386951066595781384355983336340405127965496 --tx DCrm53kfRcZiMRBQPevDcftUTPSVT9L1kLtSsRpFzyc2
    ok  the record is a testnet record: testnet
    ok  the record's builds agree on its wasm_sha256 ab4ac612ce0d3257ceafee26f7010c6d1b635e865ff545db3074ed5cc11944d7: [ab4ac612ce0d3257ceafee26f7010c6d1b635e865ff545db3074ed5cc11944d7, ab4ac612ce0d3257ceafee26f7010c6d1b635e865ff545db3074ed5cc11944d7]
    ok  the record's code_hash CXer6tYxd9w2Bgdcz1g2vGJTFoj927goSLscRCtgyEhc is the base58 of its wasm_sha256 ab4ac612ce0d3257ceafee26f7010c6d1b635e865ff545db3074ed5cc11944d7
    ok  the record is vault.bf-vt-20261102t071444.testnet's: vault.bf-vt-20261102t071444.testnet
    ok  the record's asset is the testnet token bf-usdc-20261101t022248.testnet: bf-usdc-20261101t022248.testnet
    ok  vault.bf-vt-20261102t071444.testnet key list is [] on https://test.rpc.fastnear.com: 0 key(s) at block 276237234
    ok  vault.bf-vt-20261102t071444.testnet code hash CXer6tYxd9w2Bgdcz1g2vGJTFoj927goSLscRCtgyEhc equals the record's CXer6tYxd9w2Bgdcz1g2vGJTFoj927goSLscRCtgyEhc on https://test.rpc.fastnear.com at block 276237234
    ok  code sha256 ab4ac612ce0d3257ceafee26f7010c6d1b635e865ff545db3074ed5cc11944d7 equals the record's ab4ac612ce0d3257ceafee26f7010c6d1b635e865ff545db3074ed5cc11944d7 on https://test.rpc.fastnear.com (229821 B)
    ok  no banned import on https://test.rpc.fastnear.com: none
    ok  promise imports are a subset of the seven on https://test.rpc.fastnear.com: [promise_results_count, promise_and, promise_batch_then, promise_batch_create, promise_result, promise_batch_action_transfer, promise_batch_action_function_call_weight]
    ok  function exports are inside vault.md 2.5.7's list on https://test.rpc.fastnear.com: [config, contract_source_metadata, deposits, ft_on_transfer, is_known_label_root, is_known_state_root, label_tree, labels, leaves, on_payout, ragequit, settle, spends, state_tree, storage_prepay, totals, withdraw]
    ok  withdraw is exported only with on_payout on https://test.rpc.fastnear.com: yes
    ok  not the out-of-gas test build on https://test.rpc.fastnear.com: no test mark
    ok  the code names the testnet token and no other on https://test.rpc.fastnear.com: yes
    ok  config() answers on https://test.rpc.fastnear.com: asset bf-usdc-20261101t022248.testnet, scope 1535477060801825460881825272651648228733961995907927460809153251087997597629, version blindfill-vault 0.1.0 testnet
    ok  vault.bf-vt-20261102t071444.testnet key list is [] on https://near-testnet.drpc.org: 0 key(s) at block 276237238
    ok  vault.bf-vt-20261102t071444.testnet code hash CXer6tYxd9w2Bgdcz1g2vGJTFoj927goSLscRCtgyEhc equals the record's CXer6tYxd9w2Bgdcz1g2vGJTFoj927goSLscRCtgyEhc on https://near-testnet.drpc.org at block 276237238
    ok  code sha256 ab4ac612ce0d3257ceafee26f7010c6d1b635e865ff545db3074ed5cc11944d7 equals the record's ab4ac612ce0d3257ceafee26f7010c6d1b635e865ff545db3074ed5cc11944d7 on https://near-testnet.drpc.org (229821 B)
    ok  no banned import on https://near-testnet.drpc.org: none
    ok  promise imports are a subset of the seven on https://near-testnet.drpc.org: [promise_results_count, promise_and, promise_batch_then, promise_batch_create, promise_result, promise_batch_action_transfer, promise_batch_action_function_call_weight]
    ok  function exports are inside vault.md 2.5.7's list on https://near-testnet.drpc.org: [config, contract_source_metadata, deposits, ft_on_transfer, is_known_label_root, is_known_state_root, label_tree, labels, leaves, on_payout, ragequit, settle, spends, state_tree, storage_prepay, totals, withdraw]
    ok  withdraw is exported only with on_payout on https://near-testnet.drpc.org: yes
    ok  not the out-of-gas test build on https://near-testnet.drpc.org: no test mark
    ok  the code names the testnet token and no other on https://near-testnet.drpc.org: yes
    ok  config() answers on https://near-testnet.drpc.org: asset bf-usdc-20261101t022248.testnet, scope 1535477060801825460881825272651648228733961995907927460809153251087997597629, version blindfill-vault 0.1.0 testnet
    ok  config() is the same on both RPCs: yes
    ok  config() names deposit_storage_bytes 756: 756
    ok  storage_prepay tx DCrm53kfRcZiMRBQPevDcftUTPSVT9L1kLtSsRpFzyc2 by bf-rb-20261104t183046.testnet is final on https://test.rpc.fastnear.com: FINAL
    ok  the tx is DCrm53kfRcZiMRBQPevDcftUTPSVT9L1kLtSsRpFzyc2 from bf-rb-20261104t183046.testnet to vault.bf-vt-20261102t071444.testnet on https://test.rpc.fastnear.com: DCrm53kfRcZiMRBQPevDcftUTPSVT9L1kLtSsRpFzyc2 from bf-rb-20261104t183046.testnet to vault.bf-vt-20261102t071444.testnet
    ok  the tx is one storage_prepay of precommitment 170939303965139770475647005542589386951066595781384355983336340405127965496 with exactly 7560000000000000000000 yocto on https://test.rpc.fastnear.com: 1 action(s), storage_prepay, precommitment 170939303965139770475647005542589386951066595781384355983336340405127965496, deposit 7560000000000000000000
    ok  the tx and every receipt succeeded on https://test.rpc.fastnear.com: SuccessValue, 3 of 3 succeeded
    ok  vault.bf-vt-20261102t071444.testnet logged one storage_prepaid {"precommitment":"170939303965139770475647005542589386951066595781384355983336340405127965496","payer":"bf-rb-20261104t183046.testnet","amount":"7560000000000000000000"} on https://test.rpc.fastnear.com: [{"precommitment":"170939303965139770475647005542589386951066595781384355983336340405127965496","payer":"bf-rb-20261104t183046.testnet","amount":"7560000000000000000000"}]
    ok  storage_prepay tx DCrm53kfRcZiMRBQPevDcftUTPSVT9L1kLtSsRpFzyc2 by bf-rb-20261104t183046.testnet is final on https://near-testnet.drpc.org: FINAL
    ok  the tx is DCrm53kfRcZiMRBQPevDcftUTPSVT9L1kLtSsRpFzyc2 from bf-rb-20261104t183046.testnet to vault.bf-vt-20261102t071444.testnet on https://near-testnet.drpc.org: DCrm53kfRcZiMRBQPevDcftUTPSVT9L1kLtSsRpFzyc2 from bf-rb-20261104t183046.testnet to vault.bf-vt-20261102t071444.testnet
    ok  the tx is one storage_prepay of precommitment 170939303965139770475647005542589386951066595781384355983336340405127965496 with exactly 7560000000000000000000 yocto on https://near-testnet.drpc.org: 1 action(s), storage_prepay, precommitment 170939303965139770475647005542589386951066595781384355983336340405127965496, deposit 7560000000000000000000
    ok  the tx and every receipt succeeded on https://near-testnet.drpc.org: SuccessValue, 3 of 3 succeeded
    ok  vault.bf-vt-20261102t071444.testnet logged one storage_prepaid {"precommitment":"170939303965139770475647005542589386951066595781384355983336340405127965496","payer":"bf-rb-20261104t183046.testnet","amount":"7560000000000000000000"} on https://near-testnet.drpc.org: [{"precommitment":"170939303965139770475647005542589386951066595781384355983336340405127965496","payer":"bf-rb-20261104t183046.testnet","amount":"7560000000000000000000"}]
    PASS
