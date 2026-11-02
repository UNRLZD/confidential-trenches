CARD vault-testnet-t02 / live: PASS
Money path: yes
Tx: near-testnet 2KGtyzS49WrU2EAnuThNYXgUCwufUFnRrPKityy4eMue bf-vt-20261102t071444.testnet
Tx: near-testnet 4yZYxFLifysHmh3BMCxCYkYYCSCm64fQjyg3pvb4yDfw bf-vt-20261102t071444.testnet
Tx: near-testnet 2nWuzFmnd2mN6Em5gCv7hZe3jNwvNXEQyQYv4zsrHBeT bf-vt-20261102t071444.testnet
Tx: near-testnet 22gWpKrfXSmR7eGNq8rRXZuwFzbUSTSSCQ9z7ckcu5ue bf-vt-20261102t071444.testnet
Tx: near-testnet 7HgkB1J2xNYsRYW7QtT4sDChbLX7ZwppXaNE7gqd4Fxi bf-vt-20261102t071444.testnet
Tx: near-testnet Eew2KBC4h4o6zBq4dw3kUaVt6ouavTxfiTBJsrio7Wvy bf-vt-20261102t071444.testnet
Tx: near-testnet 9GdNSUPLNb4bp3xUHV3wMxYdaZp7co4shkV7hJewC4qY bf-vt-20261102t071444.testnet
Tx: near-testnet DQWBRw2NfrphRgwfpyDBhFZAdzHYswrBFe1HHBBLdbwm bf-vt-20261102t071444.testnet
Tx: near-testnet 6qnKPv2WNxrP4ymTJFtctHmwAWKdoAmJjbhXKPC6g8Ny 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
Tx: near-testnet FbGSZHWugKTptv94DuCiBfaJqURuHt24eUfKoZuJYKU3 g-2b700409.bf-vt-20261102t071444.testnet
Tx: near-testnet 4UDybSLU77smBXfe4DfmL4Evb1tevNiMaNPdp49eYbtx g-2b700409.bf-vt-20261102t071444.testnet
Tx: near-testnet DFFUVXsCGfsZ8jCiesFpnhsc2M5HDcSWZHD3Nm1bMczF r-2b700409.bf-vt-20261102t071444.testnet
Tx: near-testnet 3hPJW2nerFCJk9fxXaRNbJ7fufEdHNcDwPmSGJRstZkX r-2b700409.bf-vt-20261102t071444.testnet

The run: contracts/vault/scripts/testnet-t02.ts on NEAR testnet, the keyless vault vault.bf-vt-20261102t071444.testnet on the team's test USDC bf-usdc-20261101t022248.testnet.
Deposit leg (by script, the wallet's own modules): the note store's planDeposit (fake-indexeddb), U = U_{s,i} (s the vault's scope, i 3) from this run's 12 words, U's ft_transfer_call signed as a NEP-366 DelegateAction (deposit/delegate.ts) and followed by bindDeposit (deposit/bind.ts) to the deposits pages on FastNEAR and dRPC; /v1/bind served by the helper's own carryDeposit (apps/helper/src/bind/send.ts) in the run's process with G as the gas account, because the deployed helper mounts no /v1/bind. The token watch was a stand-in answering a caught-up, open token. bindDeposit answered deposited in 19438 ms; the device's 10 s send timeout (SEND_TIMEOUT_MS) ran out before the carry answered, and bind confirmed the note from the pages.
Withdraw leg: the proof made in Chrome desktop (Google Chrome 156, macOS, 12 threads reported) by the kit's prover (packages/kit/src/prover/client.ts startProver, the worker SIGN_HOST serves, packages/signpage/public/prover-worker.js, and the pinned setup files) on a page served from 127.0.0.1 (contracts/vault/scripts/t02-page/); the input by the kit's vaultWithdrawRequest and vaultWithdrawInput on trees read by vaultSync on two operators, the change and refund secrets the wallet's (noteSecrets change and refund, j 0); the proof checked against withdraw.vkey, then carried by the helper's own carryWithdraw and outcomeRound (apps/helper/src/withdraw/send.ts) in the run's process with R's key, because the deployed helper answers every testnet withdrawal token_halted (no testnet token watch). SIGN_HOST's withdraw form has no hand-off yet, so the page stands in for it.
Accounts: P bf-vt-20261102t071444.testnet (pays NEAR for setup), D 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a (T04's depositor, sends U the USDC), U c6402698d49b19a00789fb241eb2ddb255f482bcee381d5b4a2076ce7eea947f, G g-2b700409.bf-vt-20261102t071444.testnet (bind gas account), R r-2b700409.bf-vt-20261102t071444.testnet (withdrawal relayer), F f-2b700409.bf-vt-20261102t071444.testnet (fee recipient, no key), W w-2b700409.bf-vt-20261102t071444.testnet (recipient, no key).
Every Tx above read back FINAL on https://test.rpc.fastnear.com and https://near-testnet.drpc.org, every receipt a success.
Deposit: the deposits page holds P 9775808869911771665370841875994888418084894598613505923326993934364451469563 by U with 2000000, label 12354063450875291147508737659428171804728314293405627380521006968164537183946, leaf 9.
Withdrawal: 1500000 withdrawn to W, relay_fee 204633 to F (the testnet quote, valid to block 275910481), deadline_ms 1793629802505; spends row #5: settled, payer R; the change note of 500000 at leaf 10 is this seed's.
Balances before the deposit (2026-11-02T14:15:46.048Z): U USDC 2000000, vault USDC 0, U NEAR 10000000000000000000000, G NEAR 500000000000000000000000, totals {"deposited":"5000000","spent":"6900000","returned":"1900000"}.
After the deposit (2026-11-02T14:16:08.331Z): U USDC 0, vault USDC 2000000, U NEAR 10000000000000000000000, G NEAR 490396714606024099999999, totals {"deposited":"7000000","spent":"6900000","returned":"1900000"}.
Before the withdrawal (2026-11-02T14:19:36.957Z): W USDC 0, F USDC 0, vault USDC 2000000, R NEAR 800000000000000000000000, totals {"deposited":"7000000","spent":"6900000","returned":"1900000"}.
After the withdrawal (2026-11-02T14:20:53.039Z): W USDC 1295367 (= 1500000 - 204633), F USDC 204633, vault USDC 500000 (= the change note), R NEAR 788298272773689399999998, totals {"deposited":"7000000","spent":"8400000","returned":"1900000"} (deposited - spent + returned = 500000 = the vault USDC).
Prover, Chrome desktop: setup files loaded 62 ms, fullProve in the worker 5026 ms (5028 ms seen by the page); request body 1493 bytes. iPhone Safari and Android Chrome: not run (they wait for the phones).
Times (the run's clock): carryWithdraw 3494 ms to its 200; from the 200 to the send record reading succeeded 19302 ms, to the settle done 33713 ms (outcomeRound every 10 s).
