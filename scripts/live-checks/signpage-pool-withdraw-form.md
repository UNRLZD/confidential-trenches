CARD signpage-pool-withdraw-form / live: PASS
Money path: yes
Tx: solana-devnet PxtcgoCUumR3YoQAbA2RXe1MasuWiPxWAvfvNmPccmwSrB43oamuy2qkSPE8ABHPNwaEnEUEsxvYo3y9N9LpZ8e
Tx: solana-devnet 5p4dXVDiCJ7ntFTXXaZPvBZeYP5gpgeHCucRxe1dcPzjmRojSMiRdrPHNmMgXgn3NnuActEYszjest2ssrANLMmW
Tx: solana-devnet 53grhQn7ic5VJ9Z6bYu1rRutsY6LnxuP3QTTa4A5RstL4PzKerFeo9SfWH9XUMRcCacC6MnL5kasNuv9kxzAYE9Y
Tx: solana-devnet 625hqKpFwfVf6npcoqD1SfpCFS5CqMW5gho9y9537jCyap5h4wACq1X2DkxFMpF7mJi55qVK73Uajk71XS8QFnii

The run, on Solana devnet, 2026-11-04 18:49:47-18:50:39Z, at 4fb093a, in the order of the Tx lines above: one withdraw of one part, two transactions.

1. Through the page's own pool kinds (packages/signpage/scripts/pool-withdraw-devnet.mjs: poolKinds over testnetPool, as main.ts wires the testnet build), locally, on the deployed devnet helper.
2. The notes: FLOW_RESUME from runs 6c and 6d's kept seed (~/.ct-devnet-runs/run-2026-11-04T12-44-42-386Z.seed, signpage-pool-flow.md), never printed. Its return note at leaf 16, 3482099 lamports, UNSPENT, was the plan's one chunk.
3. The form: To 3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx, amount 0.002177099 SOL, 1 part, Max fee 1305000 lamports (the helper's relay fee 1300000 plus W's own send fee 5000), from GET /v1/pool/solana/fee (200).
4. The proof: one, snarkjs fullProve in the process on the pinned withdraw files, 4.8 s.
5. The first Tx line, the release: the tag 2 release alone, paid by the helper's devnet fee payer through POST /v1/pool/solana/send (200), at slot 518672460: W gets the part plus its own send fee, 2182099 lamports; the relay fee, 1300000, is the rest of the chunk.
6. The second Tx line, the onward send: W's own one-signer System transfer of 2177099 lamports to To, fee 5000, at slot 518672509.
7. The op ended stage sent, arrived 2177099 at To; the return note SPENT, and the change at leaf 17 UNSPENT with value 0.

This run's W: 787Mjqa9XNKa6GADWQFzLZEsRjSVghkHG9Dmf6mYGe1u, 2182099 lamports before its send and 0 after.
The fee payer: 9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb. The pool program: 5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ.

Funding: none from D. The release is paid by the helper's fee payer, and W's send fee comes out of the note.
The dry run before it (WITHDRAW_DRY=1, stopped before the press) hit OnFinality's -32029 throttle once ("not a JSON-RPC answer"); it ran again once three reads in a row answered.

Re-run on today's devnet pool (card pool-senders-next-page), 2026-11-08 04:49:39-04:50:01Z, the last two Tx lines: one withdraw of one part, two transactions, through the same script and the deployed helper (3a57948a, serving program 9Z6Yi2Vc beside the one before the re-pin).
1. The notes: FLOW_RESUME from devnet flow run 7's kept seed (~/.ct-devnet-runs/run-2026-11-08T04-39-02-905Z.seed, signpage-pool-flow.md), never printed. Its return note at leaf 5, 3482099 lamports, UNSPENT, was the plan's one chunk; a dry run (WITHDRAW_DRY=1) first showed the same plan.
2. The form: To 3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx, amount 0.002177099 SOL, 1 part, Max fee 1305000 lamports (the helper's relay fee 1300000 plus W's own send fee 5000), from GET /v1/pool/fee (200).
3. The proof: one, snarkjs fullProve in the process on the pinned withdraw files, 5.8 s.
4. The first of the two Tx lines, the release: the tag 2 release alone, paid by the helper's devnet fee payer through POST /v1/pool/solana/send (200), at slot 519906016: W gets the part plus its own send fee, 2182099 lamports; the relay fee, 1300000, is the rest of the chunk.
5. The second, the onward send: W's own one-signer System transfer of 2177099 lamports to To, fee 5000, at slot 519906035.
6. The op ended stage sent, arrived 2177099 at To; the return note SPENT, and the change at leaf 6 UNSPENT with value 0.
This run's W: 7hf6D7mipyuN4WRJRzLq1h5ps65UFhsMF6HHpHPuRL5D, 2182099 lamports before its send and 0 after. The pool program: 9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8. Funding: none from D.

This live check reads, on https://api.devnet.solana.com and the helper's devnet route (https://api.confidential.unrealized.trade/v1/rpc/solana-devnet, another operator) at finalized, each part's release (a tag 2 of the pinned program, paid by the fee payer, to W, with no lookup table) and its onward send (W's own transfer of the part to To, W at 0), and SIGN_HOST's index.html and the /app.js it pins. RUN is the re-run's part; recorded again 2026-11-08: PASS.
