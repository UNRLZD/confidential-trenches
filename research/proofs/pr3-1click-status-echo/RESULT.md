**Verdict: does not echo.**

# PR3: does 1Click's keyless `/v0/status` echo `recipient` and `refundTo` for confidential quotes?

Keyless `GET /v0/status` answered **HTTP 404 "Deposit address … not found"** for all 7
confidential-quote addresses read (6 P1 legs that moved money on 2026-10-19, plus V6's unfunded shield probe). The body
held only `error, message, path, statusCode, timestamp`: no status, no quote, no `recipient`, no `refundTo`, no
amounts, no tx hashes. The public control answered **HTTP 200** with the whole quote request, `recipient` and
`refundTo` included. Three limits are listed in §3.

Status 2026-10-22 23:25Z. Read-only: 8 keyless status calls (cap 10), no key, no quote, no money moved. Run 2026-10-22
23:21:46-23:21:50Z, `node proofs/pr3-1click-status-echo/status-echo.mjs --stamp …`. Record:
`results/status-2026-10-22T23-21-45Z.jsonl`. Every address in it and in this file is cut to 6 characters. Base URL
`https://1click.chaindefuser.com` (06a §4.15, P1 `run.mjs:53`).

## 1. Per leg (keyless, one call each)

| Leg | Shape (06a §4.15 form) | HTTP | `recipient` echoed | `refundTo` echoed |
|---|---|---|---|---|
| control: UNRLZD canary ETH withdraw, `224f5b…` (NEAR tx `AAZG8m5V…`, 2026-10-03) | public `INTENTS → DESTINATION_CHAIN`, `confidentiality: "public"` | 200 `SUCCESS` | **yes**, `0x9251…`, user (EVM address) | **yes**, `60be9f…`, user (UNRLZD trading account) |
| P1 `deposit` `9ddc51…` | D: `ORIGIN_CHAIN` NEAR → `CONFIDENTIAL_INTENTS` | 404 | no (sent: P1 user's FAR account, which form D replaces with the omnibus) | no (sent: funder, the deposit wallet) |
| P1 `in-sol` `BuYVGN…` | D/R: `ORIGIN_CHAIN` Solana → `CONFIDENTIAL_INTENTS` | 404 | no (sent: P1 user's FAR account) | no (sent: user's Solana wallet) |
| P1 `out-sol` `8e02f3…` | F: `CONFIDENTIAL_INTENTS → DESTINATION_CHAIN`, app → P4 float | 404 | no (sent: P4 float, an app wallet as a ghost) | no (sent: P1 app account, the omnibus role) |
| P1 `out-base` `13ce50…` | W: `CONFIDENTIAL_INTENTS → DESTINATION_CHAIN`, user → Base | 404 | no (sent: user's Base address) | no (sent: P1 user's FAR account) |
| P1 `swap` `4c34a5…` | K: `CONFIDENTIAL_INTENTS → CONFIDENTIAL_INTENTS` | 404 | no | no |
| P1 `settle-1` `7a81e2…` | conf → conf transfer, user → app | 404 | no (sent: P1 app account) | no |
| V6 `probe` `a620e5…` | S_R: `INTENTS → CONFIDENTIAL_INTENTS`, unfunded, unsigned | 404 | no (sent: V6 float, the omnibus role) | no (sent: V6 R) |

"Sent" is what the quote request held (P1 `run.mjs:201-229`, V6 `run.mjs:296`), so it shows what a 200 would have named.
The 404 message repeats only the address the caller passed. The control's 200 also gave `quote` (amounts,
deadline, `depositAddress`) and `swapDetails` (amounts, 2 NEAR tx hashes, 1 destination tx hash, 1 intent hash).
Its `quoteRequest` keys: `amount, appFees, confidentiality, deadline, depositMode, depositType, destinationAsset, dry,
originAsset, recipient, recipientType, referral, refundTo, refundType, slippageTolerance, swapType,
virtualChainRecipient, virtualChainRefundRecipient`. These are the same 18 keys read on this address at 10:32:53Z
(vault-custody.md 3.5).

## 2. What 1Click's docs say

- Status: https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status.md (OpenAPI 0.1.10, fetched
  2026-10-22 23:19:52Z). `security: X-API-Key or JWT-auth`, `404: Deposit address not found`. The response echoes
  `quoteResponse.quoteRequest` with `recipient`, `refundTo` and `confidentiality` (`public | basic | advanced`, "BASIC
  or ADVANCED request Confidential Intents handling"). **Nothing says that confidential quotes hide fields, or that status
  is limited to the caller who made the quote.**
- Confidential swaps: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps.md
  (fetched 23:19:59Z) says nothing about status.
- So the 404 is measured behaviour, not a documented promise. 1Click can change it without notice.

## 3. Limits

1. **Hidden or gone?** O35 read `9ddc51…` (P1 `deposit`) **with** the partner key 2,280 times, all HTTP 200, on
   2026-10-21 21:25-21:36Z (`proofs/o35/RESULT.md` MS-14). The control, 19 days old, still answers. So the most likely
   reading is that the record is hidden from keyless callers. A purge in the 26 h between those reads is not ruled out.
   One keyed read of `9ddc51…` now would settle it. This lane did not make it: it ran keyless by brief, and the
   session's permission guard refused loading the key.
2. **Confidential or keyed?** Every confidential quote needs auth: a keyless `CONFIDENTIAL_INTENTS` quote answers 401
   "User authentication is required for confidential intent quotes" (O35 FP-3, `results/2026-10-21-fp3-nokey.json`).
   So all our D, W, F, R and K legs are in the hidden set whichever rule hides them. Still open: whether a **keyed
   public** quote is hidden too, which covers the wind-down forms R', K' and W' (all `INTENTS`-side, public). The control
   came from the UNRLZD engine, and whether that engine sent a partner key on 2026-10-03 is not recorded here.
3. **S_R (04 VLT-06) is only half answered.** The V6 probe has the S_R shape, but it was never funded. A funded S_R
   leg read keyless is what answers VLT-06. That read comes from V6's live leg or the VAULT drill on Nov 7 (07 LC-15,
   VLT-06 column O). The read needs no new quote.

## 4. What it means for the papers

- **05 L1-PUB, L2-PUB, L17-PUB.** A keyless status read does not group deposit wallets or withdrawal addresses under
  the omnibus, for every confidential leg read (D, R, W and F shapes): the read returns 404. The cells' other paths
  (amount and time matching on chain, the NEAR events) are unchanged.
- **vault-custody.md:82 (3.5).** "For any deposit address seen on chain, keyless `GET /v0/status` echoes the whole quote
  request" holds for the **public** quote read (the control). It did not hold for any confidential quote read.
- **06a §4.15 D, W, F, R.** Each shape read keyless gives 404 (D and R: `deposit`, `in-sol`; W: `out-base`; F:
  `out-sol`). The enclave reads status with its key, so its own polling is unaffected (as O35 MS-14 shows).
- **04:720 VLT-06.** It stays UNVERIFIED for a funded S_R leg (§3 item 3). The unfunded probe of the same shape gave 404.

## 5. Re-running

`node proofs/pr3-1click-status-echo/status-echo.mjs --stamp "$(date -u +%Y-%m-%dT%H-%M-%SZ)"` makes 8 keyless
status calls and 1 FastNEAR tx-index read (to recover the control address from its public tx). It reads deposit
addresses from the P1 and V6 records. No retries. Its scrub cuts any full id and any 64-hex string before a line is
written.
