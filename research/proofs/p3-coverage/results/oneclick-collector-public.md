# 1Click fee collectors on public NEAR (coordinator read, 2026-10-20 ~12:00Z)

Question (paper 5 ND-5; review 2 item 8): does 1Click's confidential fee collector `2238fd08…07805` show on public NEAR
for our legs, which would let an observer tag them?

Read: every NEAR tx of P1's live run (runs/2026-10-19T22-53-44-913Z-live.json, 12 txs across 6 confidential legs:
deposit, out-sol, out-sol-own, out-base, in-sol, out-near), `EXPERIMENTAL_tx_status` on rpc.mainnet.near.org (near.drpc.org
as fallback), every NEP-297 `transfer` / `mt_transfer` event checked for a receiver starting `2238fd08`, `5880ad2b` or
`7066024d` (the fee_collector named in docs.near-intents.org resources/fees.md).

Result:
- `2238fd08…` appears in none of the 12 txs. The confidential legs' 1Click fee (charged from the input token, fee-config.md)
  leaves no public transfer to it.
- One public collector transfer: out-base's `EtAWUauy…` moves 560000000000 `nep141:base.omft.near` (≈ 0.00000056 ETH,
  ≈ $0.0013) from `13ce500d…` to `5880ad2b…`, 1Click's generic collector, the same recipient every keyless and every
  public-form quote names (oneclick-appfee-echo-2.json A-B; keyless reads 11:15Z). It marks a 1Click flow, not our app.
- `intents.near` `mt_tokens_for_owner(2238fd08…)`: 0 tokens on both RPCs (block 220795264).

So: on the legs measured, nothing public names the confidential collector. Not excluded: a per-partner confidential
collector (one key only); the hardening observer test keeps the check on our real legs.
