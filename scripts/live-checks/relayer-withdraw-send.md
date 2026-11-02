CARD relayer-withdraw-send / live: PASS
Money path: yes
Tx: near-testnet 2ZFNn8PeHoHnGcJLfXRegsC4TwavBdcVr7LcoC6ir1Jc bf-vt-20261102t071444.testnet
Tx: near-testnet 24w4VEJj2J6vhMLSi5W1evSwVkG7xHZNUZSxF9Pvr7X4 bf-vt-20261102t071444.testnet
Tx: near-testnet C7mpSDHBmC3xKP1PSS71MbPbK9Q9fsfqZJNXRDftwSPS 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
Tx: near-testnet 2Q4pYKQ9RRwHWofzuKmwvJBn3dxfVMxsH6Dx32pWneMV 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
Tx: near-testnet 2iaurqMavRbLgphSZy1iAd8MABD9fJ2rNdf1SuHShmxP relay-2a33a311.bf-vt-20261102t071444.testnet
Tx: near-testnet VoLkPKhv6NWByVzEaP1rVLj5yryBDEdcaMMqhYGf8jU relay-2a33a311.bf-vt-20261102t071444.testnet

The run: contracts/vault/scripts/testnet-withdraw-send.ts on NEAR testnet, the keyless vault vault.bf-vt-20261102t071444.testnet on the team's test USDC bf-usdc-20261101t022248.testnet; the withdraw and the settle signed and sent by apps/helper/src/withdraw/send.ts (carryWithdraw, then outcomeRound every 10 s) in process, with the release's two testnet RPCs (FastNEAR, dRPC) and the fee quoter's mainnet price pair. Check 10's token watch was a stand-in answering a caught-up, open token: the event watch is not built.
Accounts: P bf-vt-20261102t071444.testnet (makes R), D 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a (T04's depositor, the recipient, registered: register_deposit 0), R relay-2a33a311.bf-vt-20261102t071444.testnet (the relayer and, for this testnet run, the fee recipient too; the plan's fee recipient is an account of its own apart from the relayer).
Steps: P makes R with 2 NEAR and a full-access key and registers it on the token; D prepays and deposits one 1000000 note; the request spends the whole note (no change value) to D, relay_fee 206282 (the helper's testnet quote, valid to block 275892114) to R, deadline_ms 1793619295851 (the newer final header's timestamp_nanosec / 1e6 + 600000), fund_recipient true; carryWithdraw answered 200 submitted; the outcome rounds read the withdraw succeeded from blocks and R settled the spend.
Every Tx above read back FINAL on https://test.rpc.fastnear.com and https://near-testnet.drpc.org, every receipt a success.
Spends row #4: status settled, recipient 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a, fee 206282, payer relay-2a33a311.bf-vt-20261102t071444.testnet, withdrawn 1000000.
R's NEAR: 2000000000000000000000000 before the withdraw; 1982821404685125199999998 at block 275892034 (the withdraw's last receipt); 1987398767116257299999998 at block 275892062 (the settle's last receipt).
Balances after setup, before the deposit (2026-11-02T11:24:41.504Z): D USDC 2793647, R USDC 0, vault USDC 0, D NEAR 921464779662833899999993, R NEAR 2000000000000000000000000, P NEAR 2129469622574384500000000, totals {"deposited":"4000000","spent":"5900000","returned":"1900000"}.
Balances after (2026-11-02T11:25:43.872Z): D USDC 2587365, R USDC 206282, vault USDC 0, D NEAR 910469095344649899999992, R NEAR 1987398767116257299999998, P NEAR 2129469622574384500000000, totals {"deposited":"5000000","spent":"6900000","returned":"1900000"}.
Prover (node, snarkjs, kit inputs): withdraw 1320 ms; request body 1546 bytes.
Times (this process's clock): carryWithdraw 2535 ms from the request to the 200; from the 200 to the send record reading succeeded 17610 ms, to the settle done 31671 ms (outcomeRound runs every 10 s, so both are read at round ends).
