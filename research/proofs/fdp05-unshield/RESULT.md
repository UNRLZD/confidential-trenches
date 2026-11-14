# FD-P-05: can the omnibus leave FAR without the operator? (unshield read)

Status 2026-10-20 16:08Z: **done, read-only.** One script run (`read.mjs`, record `results/read-2026-10-20T16-07-34-473Z.json`):
public docs, the 1Click OpenAPI and the example solver code fetched and every quote below checked verbatim in them; four
keyless probes; one chain read on two RPCs. No key, no signature, no non-dry quote.

**Pass line:** the exact call or form; the size limits, if any; a list of what is UNKNOWN.

## 1. Answer

- **Yes, a `CONFIDENTIAL_INTENTS → INTENTS` unshield is a public, documented call.** NEAR Intents documents it as
  "Unshield (withdraw to public)" on the market-makers page (docs L4332-4357), and the example solver it links runs it
  (solver example L53-56, L133, L142). It is a 1Click quote plus Signed Intent Execution, same asset on both sides.
- **It needs the operator at every step:** the 1Click API with a partner key, then the Private PoA Bridge that
  Intents Technology runs, which burns the IMT on FAR and releases the backing from the Treasury on `intents.near`.
  The docs say there is "no RPC path for confidential intents" (docs L2900).
- **Nothing says it keeps working after access is withdrawn.** The Terms say the opposite on termination: the
  developer "shall immediately cease use of the API and delete all API Keys" (§17.5, docs L9739), and the API is the
  only documented path. No line in the docs, the OpenAPI, the changelog or the Terms gives a wind-down or exit right.
- **Size limits: none stated.** The backing is large: the Treasury holds 1.59 M USDC on public `intents.near` (§4).
  A keyless probe cannot test size (401 before any size check).

So FD-P-05's wind-down step 1 (unshield the whole omnibus to its own public account, then `ft_withdraw`) is a real,
documented call today. It is not an exit that survives a revocation: it runs through the same key and the same bridge
that a revocation turns off.

## 2. The exact call

Base `https://1click.chaindefuser.com`. `PK` = the partner key (JWT). The omnibus account's own key signs step 3.

1. `POST /v0/quote` with header `X-API-Key: PK`:
   ```json
   {"dry": false, "swapType": "EXACT_INPUT", "slippageTolerance": 100,
    "originAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "destinationAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "amount": "<whole balance, base units>",
    "depositType": "CONFIDENTIAL_INTENTS", "recipient": "<omnibus account id>", "recipientType": "INTENTS",
    "refundTo": "<omnibus account id>", "refundType": "CONFIDENTIAL_INTENTS", "deadline": "<ISO>"}
   ```
   → `quote.depositAddress`. "Use the same asset for both `originAsset` and `destinationAsset` when shielding or
   unshielding" (docs L4356). The docs' own example uses `nep141:wrap.near`; any asset id works the same way.
2. `POST /v0/generate-intent` (`X-API-Key: PK`): `{"type": "swap_transfer", "standard": "<nep413 | erc191 |
   raw_ed25519 | webauthn | ton_connect | sep53 | tip191>", "signerId": "<omnibus account id>", "depositAddress": "…"}`
   → `{intent, correlationId}`. Partner auth only: "They do not use the end-user `User-Session` token" (docs L2903).
3. The omnibus key signs `intent.payload` unchanged.
4. `POST /v0/submit-intent` (`X-API-Key: PK`): `{"type": "swap_transfer", "signedData": {…intent, "signature": "…"}}`
   → `intentHash`.
5. Poll `GET /v0/status?depositAddress=…` until `SUCCESS`, `REFUNDED` or `FAILED`.
6. The tokens are then in the account's public `intents.near` balance. From there `ft_withdraw` works without 1Click
   (F15 in the permanence review).

What happens underneath (docs L4191, L4194): "IMT tokens are burned on FAR. The PoA Bridge processes the burn request and
releases the backing tokens from the Treasury on NEAR." The bridge "processes deposits and burns via RPC requests
rather than actively detecting on-chain events". FAR "is a permissioned instance of the NEAR protocol operated by a
small validator set with no public networking" (docs L4187).

## 3. What it needs, and the revocation question

| Needs | Source | After access is withdrawn |
|---|---|---|
| A partner key on quote, generate-intent and submit-intent | docs L2903; solver config L45 sends only `X-API-Key`; live: keyless unshield quote → 401 (§5) | §2.9 (docs L9496): Intents "may grant, condition, suspend, restrict, or withdraw access to Confidential Swaps … at any time in its sole discretion". §17.3 (L9728): API access can end "at any time, for any reason or no reason, with or without notice". §17.5 (L9739): on termination the developer "shall immediately cease use of the API and delete all API Keys" |
| Confidential enabled on that key ("invite-only") | changelog 2026-07-02 (intents-confidential.md C13) | Same §2.9 |
| The omnibus key's signature | docs L2884-2930 | Ours; a revocation does not touch it |
| The Private PoA Bridge and FAR, both run by the operator | docs L4187-4194 | §7.1 (L9596): the Private Shard is "not controlled by Intents Technology, which does not guarantee their availability, continuity, performance, or security". §20.11 (L9789): access may be suspended "during any security incident" |
| Recovery if a leg fails | §12.4 (L9683) | "no obligation to reverse, retry, refund, or recover"; requests under USD 300 from developer or user error are not considered; the rest are discretionary, aim 14 days |

- §17.6 (survival) keeps the disclaimers and fee terms alive after termination. It keeps no right to unshield.
- The docs describe no bridge call, contract method or public endpoint that a holder can use without 1Click.

## 4. Size

- **Docs:** no minimum or maximum for this call. The temporary minimums ($1,000 on nine chains, $100 on Tron) cover
  origin → origin swaps only: "Deposits to and withdrawals from Intents are not affected" (changelog, docs L501). Limit
  orders have an unstated USD minimum; that is a different call. No 1Click rate limit is published (C41).
- **Live:** not testable keyless. The 1 wNEAR and 2,000 wNEAR probes got the same 401 (§5), so the refusal comes before
  any size check.
- **Backing (chain read, `intents.near` `mt_batch_balance_of` for the Treasury `51e8f94d…`, block 220,824,662 on
  `rpc.mainnet.near.org` and 220,824,665 on `free.rpc.fastnear.com`, 16:08:20-22Z, equal on both):**
  USDC 1,594,592.28; wNEAR 12,849,804.9; SOL (`sol.omft.near`) 12,304.0; ETH on Base 89.70; ETH on Robinhood 51.70.
  An omnibus at the X5 cap ($10,000) is under 1% of the USDC backing alone (INFERENCE: backing does not limit an
  unshield of that size today).

## 5. Live probes (keyless, 2026-10-20)

| Time (UTC) | Call | Answer |
|---|---|---|
| 16:07:42Z | `POST /v0/quote`, unshield form, 1 wNEAR, `dry: true` | **401** "User authentication is required for confidential intent quotes" (387 ms) |
| 16:07:44Z | same, 2,000 wNEAR | **401**, same message |
| 16:07:46Z | `POST /v0/generate-intent`, made-up `depositAddress` | **500** after 25.4 s: "Failed to receive response within timeout of 25000ms … routing key \"limit-order.generate-intent\"" (not an auth refusal; observed only) |
| 16:08:13Z | `GET /v0/account/balances` | **401** "Authorization token required" |
| 16:08:15Z | Control: public `INTENTS → INTENTS` quote, 1 wNEAR → USDC | **201**, quoted (the keyless path itself works) |

## 6. UNKNOWN

1. Whether an unshield still works after Intents withdraws confidential access under §2.9. Docs, OpenAPI, changelog
   and Terms are silent.
2. Whether it works after §17.3 termination. §17.5 tells the developer to stop using the API, which is the only path.
3. Whether a revocation targets the partner key only or also the account. If only the key, could the same account
   unshield through another partner's front end, such as near.com's Confidential Mode, which uses its own key
   (intents-confidential.md C21)? Whether near.com lets an outside account sign in and unshield is not documented.
4. Any size limit on a confidential quote or an unshield: per request, per account or per day.
5. Whether `dry: true` works for a confidential quote with a key. That needs the owner's key.
6. The fee on an unshield (the Confidential Infrastructure Fee amount, C38) and how long one takes.
7. Whether the Private PoA Bridge has any path that does not go through 1Click. "Request-driven … via RPC requests"
   names no public endpoint.
8. Why a keyless `generate-intent` times out (500) instead of returning 401.

## 7. What this means for FD-P-05

- Step 1 of the wind-down path is a documented call. The drill (a small unshield and re-shield on a schedule) can
  use exactly §2. It needs the owner's key and real money, so it waits for the owner.
- The drill proves the rail works while access is on. It cannot prove the rail works after a revocation, and
  nothing public says it would. The X5 hold (OP-5, owner round 9 cap-1) still guards against the case this read
  cannot test.
- One way to lower the stake without the operator's help: keep the drill frequent and the time between a revocation
  signal and the unshield short. A revocation "with or without notice" can still land first.

## Sources (all fetched 2026-10-20 by `read.mjs`; sha256 in the record)

- `https://docs.near-intents.org/llms-full.txt`, 534,645 bytes, 16:07:34Z: market-makers/confidential-intents
  (L4171-4370), 1click-api quickstart signed-intent-execution (L2884-2960), confidential-swaps (L2526-2560), changelog
  (L480-640), terms-of-service, last updated October 7, 2026 (L9377 on).
- `https://1click.chaindefuser.com/docs/v0/openapi.yaml`, 1Click Swap API 0.1.10, 1,899,462 bytes, 16:07:35Z (L1561-1569:
  "Fund the swap from a Confidential Intents account by submitting a signed transfer intent … Direct token transfers are
  not supported").
- Example solver linked from the docs, commit `59d5753323ff8b4ebb1224d490a44d75bb60452a` (2026-09-25):
  `src/examples/one-click-confidential-liquidity.ts` (16:07:40Z) and `src/configs/one-click.config.ts` (16:07:41Z).
- Probes and chain reads: §4 and §5.
- Earlier reads this builds on: `docs/research/intents-confidential.md` (C13, C21, C26, C38, C41) and
  `docs/research/future-direction-permanence.md` (F14-F16).
