CARD signpage-pool-withdraw-form / live: PASS
Money path: yes
Tx: solana-devnet PxtcgoCUumR3YoQAbA2RXe1MasuWiPxWAvfvNmPccmwSrB43oamuy2qkSPE8ABHPNwaEnEUEsxvYo3y9N9LpZ8e
Tx: solana-devnet 5p4dXVDiCJ7ntFTXXaZPvBZeYP5gpgeHCucRxe1dcPzjmRojSMiRdrPHNmMgXgn3NnuActEYszjest2ssrANLMmW

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

This live check reads, on https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public at finalized, each part's release (a tag 2 of the pinned program, paid by the fee payer, to W, with no lookup table) and its onward send (W's own transfer of the part to To, W at 0), and SIGN_HOST's index.html and the /app.js it pins. Recorded at 18:52Z: PASS.
