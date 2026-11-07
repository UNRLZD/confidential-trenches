CARD vault-final-sha / live: PASS
Money path: yes
Tx: near-testnet CXG7u7DYpXKnPmUurUT8LQw2UMka6mzCuaVVReF2robo bf-vt-20261106t125654.testnet
Tx: near-testnet HF2aTk1JqseYTFsZewAyo35azA7t3bNaNi1nJfPPpzqJ bf-vt-20261106t125654.testnet

The vault's final commit F = e0623bf3244dee5115a8b18cbdb54ca355fd3c25 (every fix and every planned test in). The
wasm's NEP-330 metadata names its own commit, so this record sits in the commit after F, which changes no vault source.
- testnet-v4 (contracts/vault/deployments/testnet-v4.json): v4.bf-vt-20261106t125654.testnet, F's testnet build, two
  clean reproducible builds on the deploy's machine, sha256 8fcb0526...aeae9, 230,111 B, code hash AgJrTpwh...; keys []
  and the code hash read back on two RPCs at final.
- F's mainnet build: vault-build run 42355216946 (workflow_dispatch on card/vault-final-sha), two clean builds sha256
  a4a2af6960d93e5187271cf401ffe0e1a6f1ae5da0af1d82b1250eee313e87fc, 230,130 B. Against main 48570db0's (run
  42355219636, 0a0e1add...) it differs in 78 bytes, all inside the two 40-hex commit strings (offsets 189351 and
  189803); main's wasm with F's commit put in at both is F's byte for byte.
- The suite at F's vault source: VT-U01 to U06, P01, P02 and S01 to S20 green in PR #411's ci.yml (test-vault and the
  four vault-sandbox shards); U05's snarkjs zkey verify ran apart (both final zkeys VERIFIED against the r1cs and
  ppot_0080_16, their sha256 the kit's pins). Not run in CI: the VT_S12_PLANT, VT_S13_PLANT and VT_S19_PLANT plants.

    ok  the record is e0623bf3244d's reproducible build
    ok  the record's code_hash AgJrTpwhGRhVM2SGutL3EMYGZ1K4TMBMXnN6c9GaENEC is the base58 of its wasm_sha256 8fcb052683269c6a4a37ef8ae7830d1c5773a7d4f3582e8c8ed3d9ab880aeae9
    ok  the record's asset bf-usdc-20261101t022248.testnet is the testnet token bf-usdc-20261101t022248.testnet
    ok  v4.bf-vt-20261106t125654.testnet key list is [] on https://test.rpc.fastnear.com: 0 key(s) at block 276609971
    ok  v4.bf-vt-20261106t125654.testnet code hash AgJrTpwhGRhVM2SGutL3EMYGZ1K4TMBMXnN6c9GaENEC equals the record's AgJrTpwhGRhVM2SGutL3EMYGZ1K4TMBMXnN6c9GaENEC on https://test.rpc.fastnear.com at block 276609972
    ok  code sha256 8fcb052683269c6a4a37ef8ae7830d1c5773a7d4f3582e8c8ed3d9ab880aeae9 equals the record's 8fcb052683269c6a4a37ef8ae7830d1c5773a7d4f3582e8c8ed3d9ab880aeae9 on https://test.rpc.fastnear.com (230111 B)
    ok  no banned import on https://test.rpc.fastnear.com: none
    ok  promise imports are a subset of the allowed on https://test.rpc.fastnear.com: [promise_results_count, promise_batch_then, promise_batch_create, promise_result, promise_batch_action_transfer, promise_batch_action_function_call_weight]
    ok  function exports are inside vault.md 2.5.7's list on https://test.rpc.fastnear.com: [config, contract_source_metadata, deposits, ft_on_transfer, is_known_label_root, is_known_state_root, label_tree, labels, leaves, on_payout, ragequit, settle, spends, state_tree, storage_prepay, totals, withdraw]
    ok  withdraw is exported only with on_payout on https://test.rpc.fastnear.com: yes
    ok  not the out-of-gas test build on https://test.rpc.fastnear.com: no test mark
    ok  the code names the testnet token and no other on https://test.rpc.fastnear.com: yes
    ok  config() answers on https://test.rpc.fastnear.com: asset bf-usdc-20261101t022248.testnet, scope 20643007839017430765836732312011750509480589884054526939135550666496789917179, version blindfill-vault 0.1.0 testnet
    ok  v4.bf-vt-20261106t125654.testnet is registered on the testnet token on https://test.rpc.fastnear.com: total 1250000000000000000000 at block 276609978
    ok  v4.bf-vt-20261106t125654.testnet key list is [] on https://near-testnet.drpc.org: 0 key(s) at block 276609978
    ok  v4.bf-vt-20261106t125654.testnet code hash AgJrTpwhGRhVM2SGutL3EMYGZ1K4TMBMXnN6c9GaENEC equals the record's AgJrTpwhGRhVM2SGutL3EMYGZ1K4TMBMXnN6c9GaENEC on https://near-testnet.drpc.org at block 276609980
    ok  code sha256 8fcb052683269c6a4a37ef8ae7830d1c5773a7d4f3582e8c8ed3d9ab880aeae9 equals the record's 8fcb052683269c6a4a37ef8ae7830d1c5773a7d4f3582e8c8ed3d9ab880aeae9 on https://near-testnet.drpc.org (230111 B)
    ok  no banned import on https://near-testnet.drpc.org: none
    ok  promise imports are a subset of the allowed on https://near-testnet.drpc.org: [promise_results_count, promise_batch_then, promise_batch_create, promise_result, promise_batch_action_transfer, promise_batch_action_function_call_weight]
    ok  function exports are inside vault.md 2.5.7's list on https://near-testnet.drpc.org: [config, contract_source_metadata, deposits, ft_on_transfer, is_known_label_root, is_known_state_root, label_tree, labels, leaves, on_payout, ragequit, settle, spends, state_tree, storage_prepay, totals, withdraw]
    ok  withdraw is exported only with on_payout on https://near-testnet.drpc.org: yes
    ok  not the out-of-gas test build on https://near-testnet.drpc.org: no test mark
    ok  the code names the testnet token and no other on https://near-testnet.drpc.org: yes
    ok  config() answers on https://near-testnet.drpc.org: asset bf-usdc-20261101t022248.testnet, scope 20643007839017430765836732312011750509480589884054526939135550666496789917179, version blindfill-vault 0.1.0 testnet
    ok  v4.bf-vt-20261106t125654.testnet is registered on the testnet token on https://near-testnet.drpc.org: total 1250000000000000000000 at block 276609984
    PASS
