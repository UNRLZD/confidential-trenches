CARD vault-testnet-t04 / live: PASS
Money path: yes
Tx: near-testnet 4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL bf-vt-20261102t071444.testnet
Tx: near-testnet 8X7mYufNUzGwGixjiK1TQ2bRVYUkKuX8NMZLhv2o3Tds bf-vt-20261102t071444.testnet
Tx: near-testnet BibFo2mrsyrbx84v42Z1AXf6QkYR67xZvvXY2x4sWkJr bf-vt-20261102t071444.testnet
Tx: near-testnet 6DK99gJqH4zaBtgAv6iGcgS6q4arZZBWANrmqVv7K7WM holder.bf-usdc-20261101t022248.testnet
Tx: near-testnet 6yn16A9RuxH78HR7nY9nEM1n77j2XBezFAv4fLT2bWrS 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
Tx: near-testnet BmAiyRHQLw2uhsfj5zVeJM8AFHLobvWT7KnGPNErnU9Z 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
Tx: near-testnet GKdJjahvtXTtkitz9WoAtt2RTRwwhedtyY6D8FeHqeAX 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
Tx: near-testnet GfAPoxh5JqN9DfVypbYNz9iy9WwhjwJ6N1J3hhWFxzLQ 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
Tx: near-testnet Lq84Ea7At2k96WxKpzpMkyT41JqjuXjLX7TNfRjFWAQ 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
Tx: near-testnet 939ookUy9HQpbpwXZF1w6y8gwUGLizEoxhzcix3gthxi bf-vt-20261102t071444.testnet
Tx: near-testnet 2X3cJ3peZpbqXLoYH31knfxdLD6YAaLbi6JCVGRe25wt bf-vt-20261102t071444.testnet
Tx: near-testnet 8J5NgZKnFJMwRPrTaCERPBC3QK7oT5hWz7zW2kwRywDx s-03fc656a.bf-vt-20261102t071444.testnet
Tx: near-testnet CmnM5dZ1gERmaoDr2w9W4fF1zkLRtDNshtPFJLLHVdvq 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
Expected refusal (bounce, bounce): near-testnet DA8KWBXZgZpqpt3dyC2Y7c1qKoheMGq1vRVD2PBL8HQT 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
Expected refusal (settle, refused AlreadySettled): near-testnet 6E2GCWogFJGtpYyGLWW31u9FFZ1mgM1XmjLdtr3z2Zth s-03fc656a.bf-vt-20261102t071444.testnet

The two expected refusals fail one receipt by design, so the money gate does not read them; contracts/vault/scripts/testnet-t04.mjs read each on FastNEAR and dRPC: the bounce with exactly one failed receipt, the token refusing B as not registered, and the payout event returning 1900000; the second settle failed AlreadySettled with no receipt off the vault.

Accounts: P bf-vt-20261102t071444.testnet, D 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a (depositor, payer, fee recipient), B b-03fc656a.bf-vt-20261102t071444.testnet (no key, not registered on the token), S s-03fc656a.bf-vt-20261102t071444.testnet (the stranger).
Steps: P funds D 1 NEAR and registers it; the holder sends D 3000000; D deposits 1000000 and 2000000; D ragequits the first; D withdraws the second whole to B with fee 100000 to D, and the token refuses B, so 1900000 is refund_pending; S settles it into a refund note of 1900000 (leaf 3) and the reserve returns to D: 4870000000000000000000 - 4630000000000000000000 (463 B, the label tree grew a level) = 240000000000000000000 yocto, exactly; S settles again, refused; D withdraws the refund note whole to D.
Balances before (2026-11-02T08:13:50.930Z): D USDC 0, vault USDC 0, B USDC 0 (registration null), P NEAR 7679467251461928200000000, totals {"deposited":"0","spent":"0","returned":"0"}.
Balances after (2026-11-02T08:32:41.530Z): D USDC 3000000 (the 3000000 funded, all back: -1000000 -2000000 +1000000 ragequit +100000 fee +1900000 refund note), vault USDC 0, B USDC 0 (registration null), D NEAR 932448318861943499999994, P NEAR 6146631710750935500000000, totals {"deposited":"3000000","spent":"4900000","returned":"1900000"} (deposited - spent + returned = 0 = the vault USDC).
Prover (node, snarkjs 0.7.5, kit inputs): ragequit 456 ms, bounce 1472 ms, refund 1334 ms.
Vault gas burnt per receipt (Tgas): storage_prepay 1.82; ft_transfer_call (deposit) 6.67; storage_prepay 1.87; ft_transfer_call (deposit) 9.44; ragequit 35.76 + 1.84; withdraw (to B, bounces) 40.41 + 0.22 + 1.85; settle (S) 11.56; settle (S, again) 1.43; withdraw (refund note to D) 40.15 + 1.85.

    node scripts/live-checks/vault-testnet-t04.mjs
    ok  the run record names the testnet vault vault.bf-vt-20261102t071444.testnet on bf-usdc-20261101t022248.testnet: vault.bf-vt-20261102t071444.testnet on bf-usdc-20261101t022248.testnet
    ok  the record's depositor is NEAR-implicit and its refund is note 2 less the fee: 2000000 - 100000 = 1900000
    ok  one spend row for the ragequit's nullifier on https://test.rpc.fastnear.com: #0
    ok  ragequit row: recipient and payer are the depositor on https://test.rpc.fastnear.com: 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a, 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
    ok  ragequit row: context 0 on https://test.rpc.fastnear.com: 0
    ok  ragequit row: the whole note 1000000, fee 0, no change leaf on https://test.rpc.fastnear.com: withdrawn 1000000, fee 0, new_leaf_index 0
    ok  ragequit row: paid on https://test.rpc.fastnear.com: paid
    ok  the ragequit note's deposit names the depositor with 1000000 on https://test.rpc.fastnear.com: #0 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a 1000000
    ok  one spend row for the bounce's nullifier on https://test.rpc.fastnear.com: #1
    ok  bounce row: 2000000 to the bounce account, fee 100000, paid by the depositor on https://test.rpc.fastnear.com: 2000000 to b-03fc656a.bf-vt-20261102t071444.testnet, fee 100000, payer 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
    ok  bounce row: the refund note holds exactly the returned 1900000 on https://test.rpc.fastnear.com: 1900000
    ok  bounce row: settled, reserve 0 on https://test.rpc.fastnear.com: settled, 0
    ok  the leaf at refund_leaf_index 3 is Poseidon(refund_value, refund_label, refund_precommitment) and the record's on https://test.rpc.fastnear.com: 13094665642350563597862164787960002341551523224574415097453320422490938489601
    ok  settle wrote one note: the commitment once in 5 leaves, the label once in 3 labels on https://test.rpc.fastnear.com: 1, 1
    ok  bounce row: refund label and leaf are the record's on https://test.rpc.fastnear.com
    ok  the bounce account is not registered on the token on https://test.rpc.fastnear.com: null
    ok  one spend row for the refund note's nullifier on https://test.rpc.fastnear.com: #2
    ok  refund row: the whole refund note 1900000 withdrawn to the depositor, fee 0 on https://test.rpc.fastnear.com: 1900000 to 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a, fee 0, paid
    ok  one spend row for the ragequit's nullifier on https://near-testnet.drpc.org: #0
    ok  ragequit row: recipient and payer are the depositor on https://near-testnet.drpc.org: 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a, 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
    ok  ragequit row: context 0 on https://near-testnet.drpc.org: 0
    ok  ragequit row: the whole note 1000000, fee 0, no change leaf on https://near-testnet.drpc.org: withdrawn 1000000, fee 0, new_leaf_index 0
    ok  ragequit row: paid on https://near-testnet.drpc.org: paid
    ok  the ragequit note's deposit names the depositor with 1000000 on https://near-testnet.drpc.org: #0 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a 1000000
    ok  one spend row for the bounce's nullifier on https://near-testnet.drpc.org: #1
    ok  bounce row: 2000000 to the bounce account, fee 100000, paid by the depositor on https://near-testnet.drpc.org: 2000000 to b-03fc656a.bf-vt-20261102t071444.testnet, fee 100000, payer 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a
    ok  bounce row: the refund note holds exactly the returned 1900000 on https://near-testnet.drpc.org: 1900000
    ok  bounce row: settled, reserve 0 on https://near-testnet.drpc.org: settled, 0
    ok  the leaf at refund_leaf_index 3 is Poseidon(refund_value, refund_label, refund_precommitment) and the record's on https://near-testnet.drpc.org: 13094665642350563597862164787960002341551523224574415097453320422490938489601
    ok  settle wrote one note: the commitment once in 5 leaves, the label once in 3 labels on https://near-testnet.drpc.org: 1, 1
    ok  bounce row: refund label and leaf are the record's on https://near-testnet.drpc.org
    ok  the bounce account is not registered on the token on https://near-testnet.drpc.org: null
    ok  one spend row for the refund note's nullifier on https://near-testnet.drpc.org: #2
    ok  refund row: the whole refund note 1900000 withdrawn to the depositor, fee 0 on https://near-testnet.drpc.org: 1900000 to 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a, fee 0, paid
    PASS
